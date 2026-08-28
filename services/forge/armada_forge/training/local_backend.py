"""LocalTrainingBackend — Training R24, R24a, R24b, R24c; edges 8, 26.

IN SMOKE MODE ALL FOUR CAPS ARE REQUIRED, and D6(d) is why. Capping only `max_steps` and
`max_samples` bounds nothing: step cost is roughly linear in `batch_size * max_seq_len`, so
a caller passing `batch_size: 8, max_seq_len: 4096` satisfies every stated cap and still
turns a fifteen-minute smoke run into many hours on the CPU-only host the cap exists to
protect. All four are clamped, and BOTH the requested and the clamped value are recorded
on the run so an operator can see what was changed and why.

THE SMOKE-MODEL CONSTRAINT IS A REFUSAL, NEVER A DOWNGRADE (R24c, edge 26). A request for
`qwen3-4b-instruct` on a CPU-only host is rejected naming both the model and the absent
GPU. Substituting the smoke model would leave a caller believing they had trained the model
they asked for, and the resulting Adapter would be labelled with a `base_model_id` it was
never trained against.

WHAT IS NOT UNIT-TESTED HERE, STATED PLAINLY: `_train` loads real weights through
transformers, PEFT, and TRL. It needs the model on disk and several GB of RAM, so it is
exercised by the stack smoke test rather than by `pytest -m "not integration"`. Everything
that DECIDES something — mode selection, the refusal, the caps, the handle state machine —
is deliberately outside `_train` and is unit-tested.
"""

from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from armada_forge.registry.models import TrainingEntry
from armada_forge.training import hardware
from armada_forge.training.backend import (
    JobStatus,
    TrainingBackend,
    TrainingConfig,
    TrainingConfigRejected,
)

# R24a — the four smoke caps. Named constants rather than literals in the clamp, so a test
# asserting the cap and the code applying it read the same value.
SMOKE_MAX_STEPS = 20
SMOKE_MAX_SAMPLES = 200
SMOKE_MAX_SEQ_LEN = 1024
SMOKE_BATCH_SIZE = 1


@dataclass
class _Job:
    """One submitted job's mutable state. Owned by the backend, read by `poll`."""

    config: TrainingConfig
    total_steps: int
    output_dir: Path
    state: str = "queued"
    progress_steps: int = 0
    message: str | None = None
    cancelled: bool = field(default=False)


def clamp_for_smoke(config: TrainingConfig, max_samples: int) -> dict[str, Any]:
    """R24a — clamp all four, and report requested vs clamped for each.

    Returns the record that `runs.py` persists into `training_runs.config`. Reporting the
    pair rather than only the effective value is what lets an operator see that their
    `batch_size: 8` became 1 — a run that silently ran different hyperparameters than were
    asked for is indistinguishable from one whose hyperparameters did nothing.
    """
    requested = {
        "max_steps": config.max_steps,
        "max_samples": max_samples,
        "max_seq_len": config.max_seq_len,
        "batch_size": config.batch_size,
    }
    clamped = {
        "max_steps": min(config.max_steps, SMOKE_MAX_STEPS),
        "max_samples": min(max_samples, SMOKE_MAX_SAMPLES) if max_samples > 0 else SMOKE_MAX_SAMPLES,
        "max_seq_len": min(config.max_seq_len, SMOKE_MAX_SEQ_LEN),
        "batch_size": min(config.batch_size, SMOKE_BATCH_SIZE),
    }
    return {
        "requested": requested,
        "clamped": clamped,
        "caps_applied": sorted(key for key in requested if requested[key] != clamped[key]),
    }


class LocalTrainingBackend(TrainingBackend):
    """R24 — LoRA SFT in-process, in one of two modes selected by CUDA detection."""

    def __init__(
        self,
        entries: dict[str, TrainingEntry],
        adapters_root: Path,
        mode: str | None = None,
        trainer: Callable[..., None] | None = None,
    ) -> None:
        self._entries = entries
        self._adapters_root = adapters_root
        # R24c — detected, never passed in by an operator. The parameter exists so a test
        # can construct a quality-mode backend on a CPU-only machine; nothing on the
        # request path supplies it.
        self.mode = mode or hardware.detect_mode()
        self._trainer = trainer or self._train
        self._jobs: dict[str, _Job] = {}
        self._listeners: dict[str, list[Callable[[JobStatus], None]]] = {}
        self._lock = threading.Lock()

    @property
    def run_kind(self) -> str:  # type: ignore[override]
        """R24a/R24b — smoke mode records `run_kind: smoke`, quality records `quality`."""
        return self.mode

    # ── Validation ───────────────────────────────────────────────────────────

    def validate(self, config: TrainingConfig) -> TrainingEntry:
        """Refuse before allocating anything (edges 7, 8, 26)."""
        entry = self._entries.get(config.base_model_id)
        if entry is None:
            raise TrainingConfigRejected(
                f"`{config.base_model_id}` is not in config/base-models.yaml"
            )

        # Edge 7 — a `trainable: false` entry is refused in BOTH modes. Build-plan Req 19.4
        # forces the flag false for any non-`ollama` backend, so this one guard also covers
        # every future inference backend without the promotion path changing.
        if not entry.trainable:
            raise TrainingConfigRejected(
                f"`{entry.id}` has `trainable: false` in config/base-models.yaml and "
                "cannot be used for a training run"
            )

        if self.mode == hardware.SMOKE and not entry.smoke_test:
            # Edges 8 AND 26 in one message: the `smoke_test` constraint AND the absent GPU.
            # Naming only the constraint would read as a config mistake; naming only the
            # GPU would read as a hardware limit that config could work around. It is both,
            # and the operator's two real options are in the last sentence.
            raise TrainingConfigRejected(
                f"LocalTrainingBackend is in smoke mode because no CUDA device was "
                f"detected, and smoke mode trains only the `smoke_test: true` model. "
                f"`{entry.id}` has `smoke_test: false`, so this run is refused rather than "
                f"downgraded — a downgraded run would report a base_model_id it was never "
                f"trained against. Use the smoke model explicitly, add a GPU to the host "
                f"(no configuration change is needed), or submit with `backend: remote`."
            )

        return entry

    # ── R21's four methods ───────────────────────────────────────────────────

    def submit(self, config: TrainingConfig) -> str:
        """Validate, clamp, and start. Returns a handle BEFORE training completes."""
        import uuid

        self.validate(config)

        effective = config
        if self.mode == hardware.SMOKE:
            record = clamp_for_smoke(config, max_samples=SMOKE_MAX_SAMPLES)
            effective = config.with_caps(
                max_steps=record["clamped"]["max_steps"],
                max_seq_len=record["clamped"]["max_seq_len"],
                batch_size=record["clamped"]["batch_size"],
            )

        handle = str(uuid.uuid4())
        job = _Job(
            config=effective,
            total_steps=effective.max_steps,
            output_dir=self._adapters_root / handle,
        )
        with self._lock:
            self._jobs[handle] = job

        threading.Thread(
            target=self._run,
            args=(handle,),
            name=f"train-{handle[:8]}",
            daemon=True,
        ).start()
        return handle

    def poll(self, handle: str) -> JobStatus:
        job = self._jobs.get(handle)
        if job is None:
            # Edge 11's shape for a local run: a handle this process does not know cannot be
            # re-attached, because the training lived in this process's memory.
            return JobStatus(
                state="failed",
                message=f"no local training job with handle `{handle}` (local runs cannot "
                        "survive a restart)",
            )
        return JobStatus(
            state=job.state,
            progress_steps=job.progress_steps,
            total_steps=job.total_steps,
            message=job.message,
        )

    def fetch_artifacts(self, handle: str, dest: Path) -> None:
        """Move the adapter produced in `output_dir` to `dest`.

        A local run has already written to the local filesystem, so this is a move rather
        than a transfer — but it is still expressed through the interface, because
        `runs.py` must not know which backend it is holding.
        """
        import shutil

        job = self._jobs.get(handle)
        if job is None:
            raise FileNotFoundError(f"no local training job with handle `{handle}`")
        if not job.output_dir.exists():
            raise FileNotFoundError(
                f"local training job `{handle}` produced no artifacts at {job.output_dir}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(job.output_dir), str(dest))

    def cancel(self, handle: str) -> None:
        job = self._jobs.get(handle)
        if job is None:
            return
        # Cooperative: the trainer callback checks this flag on every step and stops. There
        # is no kill, because the training runs in this process and tearing a thread down
        # mid-step would leave torch state the next run would inherit.
        job.cancelled = True
        if job.state in ("queued", "running"):
            job.state = "cancelled"
            job.message = "cancelled by request"

    # ── Progress reporting ───────────────────────────────────────────────────

    def on_progress(self, handle: str, callback: Callable[[JobStatus], None]) -> None:
        """Register a listener. R27 — progress is EVENT-DRIVEN through a trainer callback.

        There is no polling loop and no interval anywhere in this file: the trainer calls
        back on step end, and that call is the only thing that advances progress.
        """
        self._listeners.setdefault(handle, []).append(callback)

    def _emit(self, handle: str) -> None:
        status = self.poll(handle)
        for callback in self._listeners.get(handle, []):
            callback(status)

    # ── Execution ────────────────────────────────────────────────────────────

    def _run(self, handle: str) -> None:
        job = self._jobs[handle]
        job.state = "running"
        self._emit(handle)

        try:
            self._trainer(handle, job)
        except Exception as exc:  # noqa: BLE001 - any training failure is a failed job
            job.state = "failed"
            job.message = f"{type(exc).__name__}: {exc}"
            print(f"\n❌ armada-forge: training job {handle} raised:\n{traceback.format_exc()}\n")
            self._emit(handle)
            return

        if job.state != "cancelled":
            job.state = "succeeded"
        self._emit(handle)

    def _train(self, handle: str, job: _Job) -> None:
        """LoRA SFT with PEFT and TRL (R24).

        Every heavy import is LOCAL to this function. `armada_forge.main` imports this
        module at startup, and a top-level `import torch` would put a multi-second model
        framework import on the path of a health check.
        """
        from datasets import Dataset  # type: ignore[import-not-found]
        from peft import LoraConfig  # type: ignore[import-not-found]
        from transformers import AutoTokenizer, TrainerCallback  # type: ignore[import-not-found]
        from trl import SFTConfig, SFTTrainer  # type: ignore[import-not-found]

        entry = self._entries[job.config.base_model_id]
        rows = _read_training_rows(job.config.dataset_id)
        if not rows:
            raise RuntimeError(
                f"dataset {job.config.dataset_id} has no training samples; "
                "POST /datasets refuses to write an empty dataset, so this file was "
                "emptied after it was built"
            )
        if self.mode == hardware.SMOKE:
            # R24a's `max_samples` cap. Applied to the DATA rather than to the request,
            # which is the only place it can actually bound work.
            rows = rows[:SMOKE_MAX_SAMPLES]

        backend = self

        class ProgressCallback(TrainerCallback):  # type: ignore[misc]
            """R27 — the event-driven progress source. No polling, no interval."""

            def on_step_end(self, args, state, control, **kwargs):  # noqa: ANN001, ANN003
                job.progress_steps = int(state.global_step)
                backend._emit(handle)
                if job.cancelled:
                    control.should_training_stop = True
                return control

        tokenizer = AutoTokenizer.from_pretrained(entry.hf_id)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        job.output_dir.mkdir(parents=True, exist_ok=True)

        trainer = SFTTrainer(
            model=entry.hf_id,
            train_dataset=Dataset.from_list([{"text": row["text"]} for row in rows]),
            processing_class=tokenizer,
            peft_config=LoraConfig(
                r=job.config.lora_rank,
                lora_alpha=job.config.lora_alpha,
                target_modules=list(entry.lora_target_modules),
                task_type="CAUSAL_LM",
            ),
            args=SFTConfig(
                output_dir=str(job.output_dir),
                max_steps=job.config.max_steps,
                per_device_train_batch_size=job.config.batch_size,
                max_length=job.config.max_seq_len,
                learning_rate=job.config.learning_rate,
                logging_steps=1,
                save_strategy="no",
                report_to=[],
                # CPU-ONLY BY DEFAULT. bf16/fp16 are left off in smoke mode because the
                # target host has no device that accelerates them, and enabling them on CPU
                # is slower, not faster.
                bf16=self.mode == hardware.QUALITY,
            ),
            callbacks=[ProgressCallback()],
        )
        trainer.train()

        # The UNMERGED adapter. R31 merges it into the base weights only on promotion, and
        # R34/build-plan Req 31 scores base + unmerged adapter in-process — so this is the
        # artifact both the gate and the exporter consume.
        trainer.model.save_pretrained(str(job.output_dir))
        tokenizer.save_pretrained(str(job.output_dir))


def _read_training_rows(dataset_id: str) -> list[dict[str, Any]]:
    """The rendered training rows for a dataset.

    Imported lazily from `datasets.builder` to keep this module importable without the
    database driver present, which is what lets the unit tests exercise the caps and the
    refusal with no Postgres.
    """
    import json

    from armada_forge.datasets.builder import artifact_path

    path = artifact_path(dataset_id)
    if not path.exists():
        raise FileNotFoundError(f"dataset file `{path}` is missing")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
