"""Training backends and run orchestration — Training R21-R28.

The backend interface (R21) hides WHERE training physically runs. Two implementations:

  LocalTrainingBackend   in-process LoRA SFT. On the CPU-only target host it selects
                         SMOKE MODE, which trains only the `smoke_test` model under four
                         hard caps and produces an Adapter that is never promotable (R37).
                         Costs nothing, needs no account, and is the default path.
  RemoteTrainingBackend  submits to the provider in config/training-remote.yaml. Reads its
                         credential from the environment variable NAMED there, never from
                         a file in this repository (R25, invariant 8).

MODE IS NEVER OPERATOR-SELECTABLE (R24c). It comes from CUDA detection at startup, so a
run can never be mistaken for a quality run it was not.
"""
