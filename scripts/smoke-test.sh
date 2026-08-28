#!/usr/bin/env bash
#
# Armada smoke test — end-to-end verification of a running stack.
#
# Run from the repository root, on a host with Docker:
#
#     ./scripts/smoke-test.sh
#
# This is the integration harness. The unit suites (`npm test` in services/daemon,
# `pytest` in services/forge) cover phase logic and deliberately need no Docker; this
# covers what they cannot reach — that the containers actually come up, the migrations
# actually apply, the registry actually refuses, and a first boot actually transfers no
# model bytes.
#
# ── WHY `set -uo pipefail` AND NOT `-e` ──────────────────────────────────────
# A failed assertion RECORDS and CONTINUES. With `-e` the first failure exits and every
# later section goes unreported, which turns one known failure into an unknown number of
# them — the opposite of what a smoke test is for. Unset variables and pipeline failures
# are still errors.
set -uo pipefail

# ── TWO ROOTS, AND THEY ARE NOT INTERCHANGEABLE ──────────────────────────────
# Both are bind-mounted at the SAME path on both sides of their container, so a path this
# script writes is the path the service opens. That is where the resemblance ends.
#
#   ARMADA_WORKSPACE_ROOT  the DAEMON's, and WRITABLE. It exists so the daemon can hand
#                          Docker a host path when provisioning a sandbox (R45c).
#   ARMADA_INGEST_ROOT     FORGE's, and READ-ONLY. Where a `directory` Source may read
#                          from (R8a).
#
# SECTION 7's CORPUS FIXTURE BELONGS UNDER THE INGEST ROOT. Forge is the process that
# reads it, and forge cannot see the workspace root at all — writing the fixture there was
# precisely the defect section 7 kept reporting: the glob matched nothing, and the ingest
# announced success over an empty tree. A `directory` Source outside the ingest root is now
# refused outright at registration (R8b), so putting it back would fail loudly rather than
# silently, but it would still be wrong.
#
# Do not merge these into one mount. Sharing would give sandboxes write access to corpus
# source material and couple sandbox provisioning to ingestion across cross-service
# boundary 1, where forge writes the index and the daemon only ever reads it.
ARMADA_WORKSPACE_ROOT="${ARMADA_WORKSPACE_ROOT:-/var/lib/armada/workspaces}"
ARMADA_INGEST_ROOT="${ARMADA_INGEST_ROOT:-/var/lib/armada/ingest}"

# Ports and their override names already exist in docker-compose.yml. Reused, not invented.
FORGE_PORT="${ARMADA_FORGE_PORT:-8000}"
DAEMON_PORT="${ARMADA_PORT:-8080}"
FORGE="http://localhost:${FORGE_PORT}"
DAEMON="http://localhost:${DAEMON_PORT}"

SHORTLIST="config/base-models.yaml"

# The compose defaults (docker-compose.yml). Hardcoding `-U armada` would break the
# moment anyone overrides them, and would do so with a confusing "role does not exist".
PG_USER="${POSTGRES_USER:-armada}"
PG_DB="${POSTGRES_DB:-armada}"
BOOT_TIMEOUT_SECONDS="${SMOKE_BOOT_TIMEOUT:-600}"

PASS=0; FAIL=0; SKIP=0
declare -a FAILURES=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
amber() { printf '\033[33m%s\033[0m' "$1"; }

section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

pass() { PASS=$((PASS + 1)); printf '  %s %s\n' "$(green PASS)" "$1"; }

# Every failure prints expected vs observed. "Section 5 failed" is not actionable.
fail() {
    FAIL=$((FAIL + 1))
    printf '  %s %s\n' "$(red FAIL)" "$1"
    printf '        expected: %s\n' "$2"
    printf '        observed: %s\n' "$3"
    FAILURES+=("$1")
}

# Unbuilt phases SKIP rather than FAIL, so this script stays green as P7-P14 land and a
# red run always means something is actually wrong.
skip() { SKIP=$((SKIP + 1)); printf '  %s %s (%s)\n' "$(amber SKIP)" "$1" "$2"; }

# ── CONFIG RESTORATION ───────────────────────────────────────────────────────
# Sections 5 and 6 mutate config/base-models.yaml. A smoke script that leaves the repo
# dirty after Ctrl-C is worse than no smoke script: the next thing anyone runs is testing
# a mutated config without knowing it. The trap covers EVERY exit path, including signals.
SHORTLIST_BACKUP=""

restore_shortlist() {
    if [ -n "$SHORTLIST_BACKUP" ] && [ -f "$SHORTLIST_BACKUP" ]; then
        cp "$SHORTLIST_BACKUP" "$SHORTLIST"
        rm -f "$SHORTLIST_BACKUP"
        SHORTLIST_BACKUP=""
    fi
}

on_exit() {
    local code=$?
    local had_backup="$SHORTLIST_BACKUP"
    restore_shortlist
    # Only signals count as interrupts. A preflight exit (2) is a normal, deliberate exit
    # and calling it "interrupted" would send an operator looking for a problem that is
    # not there.
    if [ -n "$had_backup" ] && { [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; }; then
        printf '\n%s interrupted — %s restored to git HEAD\n' "$(amber '⚠')" "$SHORTLIST"
    fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup_shortlist() {
    SHORTLIST_BACKUP="$(mktemp)"
    cp "$SHORTLIST" "$SHORTLIST_BACKUP"
}

# ── PREFLIGHT ────────────────────────────────────────────────────────────────
# Exits 2 NAMING what is missing. A script that fails later with "command not found" makes
# an operator diagnose a tooling gap as a platform failure.
missing=()
for tool in docker curl jq git; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s missing required tool(s): %s\n' "$(red 'PREFLIGHT')" "${missing[*]}" >&2
    printf 'This script needs docker, curl, jq and git on PATH.\n' >&2
    exit 2
fi
if [ ! -f docker-compose.yml ]; then
    printf '%s run this from the repository root (docker-compose.yml not found)\n' "$(red 'PREFLIGHT')" >&2
    exit 2
fi

# One place that knows how to reach Postgres, so a credential override lands everywhere.
psql_q() {
    docker compose exec -T armada-db psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null \
        | tr -d ' \r'
}

api()      { curl -sS --max-time 30 "$@" 2>/dev/null; }
api_code() { curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

printf '\033[1mArmada smoke test\033[0m\n'
printf 'forge %s · daemon %s · workspace %s · ingest %s\n' \
    "$FORGE" "$DAEMON" "$ARMADA_WORKSPACE_ROOT" "$ARMADA_INGEST_ROOT"

# ── 0. CLEAN SLATE ───────────────────────────────────────────────────────────
section '0. Clean slate'

docker compose down -v >/dev/null 2>&1
if docker compose ps -q 2>/dev/null | grep -q .; then
    fail 'stack torn down' 'no running containers' "$(docker compose ps --format '{{.Name}}' | tr '\n' ' ')"
else
    pass 'stack torn down, volumes removed'
fi

# Nothing labelled from a previous run should survive a `down -v`.
orphans="$(docker ps -aq --filter 'label=armada.run_id' | wc -l | tr -d ' ')"
if [ "$orphans" = "0" ]; then
    pass 'no sandbox containers left over'
else
    fail 'no sandbox containers left over' '0' "$orphans"
fi

# ── 1. BOOT ──────────────────────────────────────────────────────────────────
section '1. Boot'

# ── A FAILED BUILD MUST SAY WHY, AND MUST NOT BE FOLLOWED BY 25 MORE FAILURES ──
# This previously wrote the build output to a `mktemp` path and reported "see
# /tmp/tmp.XXXX" — a file on a runner that is destroyed before anyone can read it. When
# the build did fail, CI produced 26 FAILs, every one of them "<no response>" from a
# stack that was never created, and not one line about the cause. It is the same defect
# the `Collect logs` step in ci.yml already carries a comment about: evidence written to
# a path nobody reads is evidence that does not exist.
#
# So: print it, and stop. Boot is the one assertion whose failure makes every later
# assertion meaningless rather than merely unknown — the exception to the `-e` note at
# the top of this file, not a departure from it. Continuing past it trades one known
# cause for an unknown number of derived failures, which is the same bad trade the `-e`
# note refuses, pointed the other way.
build_log="$(mktemp)"
if docker compose up -d --build >"$build_log" 2>&1; then
    pass 'docker compose up --build'
else
    rc=$?
    fail 'docker compose up --build' "exit 0" "exit $rc"
    printf '\n── build output (last 120 lines) ──\n'
    tail -120 "$build_log"
    printf '── end build output ──\n'
    printf '\n  Boot failed. Every later assertion would report "<no response>" from a stack\n'
    printf '  that was never created, so the cause above is the finding. Stopping here.\n'
    printf '\n\033[1m── Summary\033[0m\n'
    printf '  %s %d   %s %d   %s %d\n' "$(green PASS)" "$PASS" "$(red FAIL)" "$FAIL" "$(amber SKIP)" "$SKIP"
    restore_shortlist
    exit 1
fi

printf '  waiting for services (up to %ss)…\n' "$BOOT_TIMEOUT_SECONDS"
deadline=$(( $(date +%s) + BOOT_TIMEOUT_SECONDS ))
forge_up=false; daemon_up=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(api_code "${FORGE}/health")" = "200" ] && forge_up=true
    [ "$(api_code "${DAEMON}/api/health")" = "200" ] && daemon_up=true
    $forge_up && $daemon_up && break
    sleep 2
done

$forge_up  && pass 'armada-forge healthy'  || fail 'armada-forge healthy'  '200 from /health'     "$(api_code "${FORGE}/health")"
$daemon_up && pass 'armada-daemon healthy' || fail 'armada-daemon healthy' '200 from /api/health' "$(api_code "${DAEMON}/api/health")"

# All six migrations applied, in order. The table is `schema_migrations` (001_init.sql).
applied="$(psql_q 'SELECT count(*) FROM schema_migrations')"
if [ "$applied" = "6" ]; then
    pass 'all six migrations applied'
else
    fail 'all six migrations applied' '6 rows in schema_migrations' "${applied:-<query failed>}"
fi

# F13 — the peer strip reports a degraded PEER but must never manufacture a degraded SELF.
health_body="$(api "${DAEMON}/api/health")"
if [ -n "$health_body" ] && echo "$health_body" | jq -e '.services.forge' >/dev/null 2>&1; then
    pass 'daemon health reports the peer service strip'
else
    fail 'daemon health reports the peer service strip' '.services.forge present' "${health_body:-<no response>}"
fi

# ── 2. REGISTRY ──────────────────────────────────────────────────────────────
section '2. Model registry'

bindings="$(api "${FORGE}/models/bindings")"
count="$(echo "$bindings" | jq 'length' 2>/dev/null)"
if [ "$count" = "5" ]; then
    pass 'one base binding per shortlist entry'
else
    fail 'one base binding per shortlist entry' '5' "${count:-<no response>}"
fi

promoted="$(echo "$bindings" | jq '[.[] | select(.status == "promoted")] | length' 2>/dev/null)"
if [ "$promoted" = "5" ]; then
    pass 'every base binding is promoted'
else
    fail 'every base binding is promoted' '5' "${promoted:-<none>}"
fi

# R4g — exactly one entry (the smoke model) ships inside the armada-models image.
smoke_mat="$(echo "$bindings" | jq -r '.[] | select(.tag == "armada/qwen3-0.6b-base") | .materialized' 2>/dev/null)"
if [ "$smoke_mat" = "true" ]; then
    pass 'qwen3-0.6b is materialized from first boot (R4g)'
else
    fail 'qwen3-0.6b is materialized from first boot (R4g)' 'true' "${smoke_mat:-<not found>}"
fi

unmat="$(echo "$bindings" | jq '[.[] | select(.materialized == false)] | length' 2>/dev/null)"
if [ "$unmat" = "4" ]; then
    pass 'the other four register UNMATERIALIZED (R4c)'
else
    fail 'the other four register UNMATERIALIZED (R4c)' '4' "${unmat:-<none>}"
fi

# R1b — `backend` is a LOGICAL name. No deployment URL is ever persisted.
#
# GATED ON THE BASELINE (cross-cutting rule 10). "No backend contains http" is an ABSENCE
# assertion, and absence is free over an empty set: if the registry returned nothing at
# all, this passes and reports that the discriminator holds. A total registration failure
# would then be announced as a PASS. The count check above establishes the baseline, so
# reuse it rather than re-deriving one.
if [ "${count:-0}" != "5" ]; then
    skip 'backend is a logical name, no URL persisted (R1b)' \
         'no bindings were registered — an absence assertion over an empty set proves nothing'
elif echo "$bindings" | jq -e '[.[] | select(.backend | test("http"))] | length == 0' >/dev/null 2>&1; then
    pass 'backend is a logical name, no URL persisted (R1b)'
else
    fail 'backend is a logical name, no URL persisted (R1b)' 'no backend containing "http"' \
         "$(echo "$bindings" | jq -c '[.[].backend]')"
fi

# ── 3. ZERO MODEL BYTES ──────────────────────────────────────────────────────
section '3. Zero model bytes on first boot'

# Invariant 7 in its testable form: after container images are pulled, a default install
# transfers ZERO bytes from any model provider until the operator materializes something.
# Only the baked smoke model may be present.
served="$(docker compose exec -T armada-models ollama list 2>/dev/null | tail -n +2 | grep -c . || true)"
if [ "${served:-0}" -le 1 ]; then
    pass 'no model weights pulled beyond the baked smoke model'
else
    fail 'no model weights pulled beyond the baked smoke model' 'at most 1 served model' \
         "$served served: $(docker compose exec -T armada-models ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | tr '\n' ' ')"
fi

# ── 4. REGISTRY IDEMPOTENCE ──────────────────────────────────────────────────
section '4. Registration idempotence (R4b)'

docker compose restart armada-forge >/dev/null 2>&1
for _ in $(seq 1 60); do
    [ "$(api_code "${FORGE}/health")" = "200" ] && break
    sleep 2
done

after="$(api "${FORGE}/models/bindings" | jq 'length' 2>/dev/null)"
if [ "$after" = "5" ]; then
    pass 'restarting forge creates no duplicate bindings'
else
    fail 'restarting forge creates no duplicate bindings' '5' "${after:-<no response>}"
fi

# R4h — a stale materialized:true is corrected back down. This is what stops P7's
# fail-fast trusting a claim the model server can no longer honour.
mat_after="$(api "${FORGE}/models/bindings" | jq -r '.[] | select(.tag == "armada/qwen3-0.6b-base") | .materialized' 2>/dev/null)"
if [ "$mat_after" = "true" ]; then
    pass 'materialization state survives a restart when the weights are still present (R4h)'
else
    fail 'materialization state survives a restart' 'true' "${mat_after:-<not found>}"
fi

# ── 5. CAPACITY REFUSAL ──────────────────────────────────────────────────────
section '5. Capacity refusal (R4f) — THE POINT OF THIS SCRIPT'

# This is the first real execution of the min_disk_gb guard: the exact check ISSUE #5
# found could not fire, because the key was unknown to the schema and the guard was
# skipped by a truthiness test. A refusal naming only one number is the defect R4f exists
# to end, so both values are asserted.
backup_shortlist

# 999999 GB is unsatisfiable on any host, so the refusal is deterministic.
sed -i.bak 's/^\( *min_disk_gb:\) .*/\1 999999/' "$SHORTLIST" && rm -f "${SHORTLIST}.bak"
docker compose restart armada-forge >/dev/null 2>&1
for _ in $(seq 1 60); do
    [ "$(api_code "${FORGE}/health")" = "200" ] && break
    sleep 2
done

refusal="$(api -X POST "${FORGE}/models/bindings/armada%2Fqwen3-1.7b-base/materialize")"
refusal_code="$(api_code -X POST "${FORGE}/models/bindings/armada%2Fqwen3-1.7b-base/materialize")"

if [ "$refusal_code" = "507" ]; then
    pass 'materialization refused with 507 Insufficient Storage'
else
    fail 'materialization refused' '507' "${refusal_code:-<no response>}"
fi

if echo "$refusal" | grep -q '999999'; then
    pass 'the refusal names the REQUIRED value (999999)'
else
    fail 'the refusal names the required value' 'body containing 999999' "${refusal:-<empty>}"
fi

# R4f: "names BOTH the required and the observed value". A GB figure with a decimal point
# is the observed free disk; without it an operator cannot tell how far short they are.
if echo "$refusal" | grep -Eq '[0-9]+\.[0-9]+ GB free'; then
    pass 'the refusal names the OBSERVED free disk (R4f)'
else
    fail 'the refusal names the observed free disk (R4f)' 'body containing "<n>.<n> GB free"' "${refusal:-<empty>}"
fi

restore_shortlist

# ── 6. BAD SHORTLIST ─────────────────────────────────────────────────────────
section '6. Malformed shortlist fails startup (R3, R1b)'

# Restart forge and report whether it refused to start, and what it said. Shared by both
# cases below; the EXISTING backup_shortlist/restore_shortlist machinery and its
# EXIT/INT/TERM trap are reused rather than duplicated.
restart_and_capture() {
    # A container that exits on bad config FLAPS: it dies, the restart policy brings it
    # back, it dies again. Sampling the state once after a fixed sleep is a coin toss —
    # it can land on an "up, about to crash" moment and report `running` for a service
    # that is refusing to run. That produced a false FAIL on a commit where the two
    # assertions above it — both reading the rejection out of the logs — passed.
    #
    # So OBSERVE OVER TIME rather than at an instant: poll, and treat the service as
    # refusing if it is ever seen not-running, or if Docker has restarted it. A service
    # that genuinely starts clean is never once caught down and never increments its
    # restart count, so this cannot pass a healthy forge by accident.
    docker compose restart armada-forge >/dev/null 2>&1

    local restarts_before
    restarts_before="$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q armada-forge 2>/dev/null)" 2>/dev/null || echo 0)"

    forge_state=running
    for _ in $(seq 1 15); do
        local st
        st="$(docker compose ps -a --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="armada-forge"{print $2}')"
        case "$st" in
            ''|running) ;;
            *) forge_state="$st"; break ;;
        esac
        local restarts_now
        restarts_now="$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q armada-forge 2>/dev/null)" 2>/dev/null || echo 0)"
        if [ "${restarts_now:-0}" -gt "${restarts_before:-0}" ]; then
            forge_state="restarting"; break
        fi
        sleep 1
    done

    # 200, not 40. A refusing container FLAPS under the restart policy, so what survives
    # in \`docker logs\` is a tail spanning several crash cycles rather than one clean
    # message. 40 lines was enough until a deeper call stack started emitting a traceback
    # alongside the fault list, at which point the assertion read the traceback and
    # reported \`observed: return await anext(self.gen)\` for a forge that had named the
    # fault correctly two lines earlier.
    #
    # The traceback itself is fixed at its source (config.py exits without unwinding), so
    # this is not what makes the assertion pass. It is headroom: a diagnostic capture
    # sized to exactly today\'s output is one noisy startup away from lying again.
    forge_logs="$(docker compose logs --tail 200 armada-forge 2>/dev/null)"
}

restore_and_wait_for_forge() {
    restore_shortlist
    docker compose restart armada-forge >/dev/null 2>&1
    for _ in $(seq 1 60); do
        [ "$(api_code "${FORGE}/health")" = "200" ] && break
        sleep 2
    done
}

# ── 6a. A missing required key ───────────────────────────────────────────────
backup_shortlist
# Remove a required key from the FIRST entry. Startup must then exit non-zero naming that
# entry's id (R3). sed rather than python3: the daemon and forge images do not carry a
# python3 the host is guaranteed to share, and one guaranteed tool beats two paths.
# The 0,/re/ form bounds the deletion to the first match, so exactly one entry is broken.
sed -i.bak '0,/^ *min_ram_gb:/{/^ *min_ram_gb:/d}' "$SHORTLIST"
rm -f "${SHORTLIST}.bak"

restart_and_capture

if echo "$forge_logs" | grep -q 'min_ram_gb'; then
    pass 'startup names the missing key'
else
    fail 'startup names the missing key' 'logs mentioning min_ram_gb' "${forge_logs:-<no logs>}"
fi

if echo "$forge_logs" | grep -Eq 'entry `[a-z0-9.-]+`'; then
    pass 'startup names the offending entry id (R3)'
else
    fail 'startup names the offending entry id (R3)' 'logs naming an entry id' "${forge_logs:-<no logs>}"
fi

if [ "$forge_state" != "running" ]; then
    pass 'forge refuses to run with a missing required key'
else
    fail 'forge refuses to run with a missing required key' 'not running' "$forge_state"
fi

restore_and_wait_for_forge

# ── 6b. An unrecognised backend (R1b) ────────────────────────────────────────
# P2's acceptance criterion is "a shortlist entry with backend: colibri is rejected at
# startup", and until now R1b had NO test anywhere. It guards the discriminator that
# landed early specifically so a second inference backend would never need a migration —
# a guard nothing exercised is a guard that has already stopped working.
backup_shortlist
sed -i.bak '0,/^ *backend: ollama/{s/^\( *backend:\) ollama/\1 colibri/}' "$SHORTLIST"
rm -f "${SHORTLIST}.bak"

restart_and_capture

if echo "$forge_logs" | grep -q 'colibri'; then
    pass 'startup names the unrecognised backend value (R1b)'
else
    fail 'startup names the unrecognised backend value (R1b)' 'logs mentioning colibri' \
         "${forge_logs:-<no logs>}"
fi

# R3 — the message must name the FIELD too, or an operator with a large shortlist knows
# only that something somewhere is wrong.
if echo "$forge_logs" | grep -q 'backend'; then
    pass 'the refusal names the offending field (R3)'
else
    fail 'the refusal names the offending field (R3)' 'logs mentioning backend' \
         "${forge_logs:-<no logs>}"
fi

if [ "$forge_state" != "running" ]; then
    pass 'forge refuses to run with backend: colibri (R1b)'
else
    fail 'forge refuses to run with backend: colibri (R1b)' 'not running' "$forge_state"
fi

restore_and_wait_for_forge

# ── 7. INGESTION ─────────────────────────────────────────────────────────────
section '7. Corpus ingestion'

# R8a — ARMADA_INGEST_ROOT, not ARMADA_WORKSPACE_ROOT. The workspace root is mounted into
# armada-daemon alone, for sandbox provisioning; FORGE does the ingesting and cannot see
# it. Writing the fixture there is precisely the bug section 7 kept reporting: the glob
# matched nothing and the ingest reported success over an empty tree.
fixture="${ARMADA_INGEST_ROOT}/smoke-fixture"
if mkdir -p "$fixture" 2>/dev/null; then
    cat > "${fixture}/guide.md" <<'MD'
# Deployment guide

Armada runs five services under one docker-compose.yml. The daemon serves HTTP and
WebSocket on a single port. Retrieval fuses a vector search and a full-text search with
Reciprocal Rank Fusion.
MD

    corpus="$(api -X POST "${FORGE}/corpora" -H 'Content-Type: application/json' \
        -d '{"name":"smoke-corpus","description":"smoke test fixture"}')"
    corpus_id="$(echo "$corpus" | jq -r '.corpus_id' 2>/dev/null)"

    if [ -n "$corpus_id" ] && [ "$corpus_id" != "null" ]; then
        pass 'Corpus created'

        # ASSERT THE SETUP, DO NOT ASSUME IT. Both calls discarded their responses, so a
        # rejected registration was invisible: the ingest then ran over a Corpus with no
        # Sources, produced zero chunks, and section 7 reported "ingestion produced
        # chunks: 0" — a true statement that names the wrong cause. Three runs were spent
        # reading that as an ingestion bug.
        #
        # R8b gave add_source the power to refuse, which is right, and that made a silent
        # setup step actively misleading rather than merely incomplete.
        src_out="$(mktemp)"
        src_code="$(curl -sS --max-time 30 -o "$src_out" -w '%{http_code}' \
            -X POST "${FORGE}/corpora/${corpus_id}/sources" \
            -H 'Content-Type: application/json' \
            -d "{\"type\":\"directory\",\"location\":\"${fixture}\",\"include_globs\":[\"**/*.md\"]}" 2>/dev/null)"
        if [ "$src_code" = "201" ]; then
            pass 'directory Source registered (R6, R8b)'
        else
            # The body is the whole point: R8b's refusal names the path, ARMADA_INGEST_ROOT
            # and the remedy, so printing it turns a dead end into an instruction.
            fail 'directory Source registered (R6, R8b)' '201' \
                 "$src_code — $(head -c 400 "$src_out" 2>/dev/null)"
        fi
        rm -f "$src_out"

        ingest_code="$(api_code -X POST "${FORGE}/corpora/${corpus_id}/ingest")"
        case "$ingest_code" in
            200|202) pass 'ingest accepted (R7)' ;;
            *)       fail 'ingest accepted (R7)' '200 or 202' "$ingest_code" ;;
        esac

        chunks=0
        for _ in $(seq 1 60); do
            chunks="$(api "${FORGE}/corpora/${corpus_id}" | jq -r '.chunk_count' 2>/dev/null)"
            [ "${chunks:-0}" -gt 0 ] && break
            sleep 2
        done

        if [ "${chunks:-0}" -gt 0 ]; then
            pass "ingestion produced ${chunks} chunk(s)"
        else
            fail 'ingestion produced chunks' '> 0' "${chunks:-0}"
        fi

        # The message above used to say "with embeddings" while checking only the row
        # count. NULL embeddings, or the wrong width, passed and told the operator they
        # were fine — a claim with nothing behind it, in the one place whose whole job is
        # to be the thing that fails.
        #
        # BOTH assertions are needed and neither is redundant: the dimension query returns
        # EMPTY when every embedding is NULL, so it passes vacuously on its own; and the
        # null count passes at the wrong dimension.
        # GATED ON A NON-ZERO BASELINE. "no NULL embeddings" is satisfied by the empty
        # set, so over zero chunks this reported PASS while proving nothing. Any assertion
        # whose predicate an empty set satisfies must SKIP, never pass, without a baseline.
        null_embeddings="$(psql_q 'SELECT count(*) FROM chunks WHERE embedding IS NULL')"
        if [ "${chunks:-0}" -eq 0 ]; then
            skip 'every chunk carries a non-NULL embedding (R11)' \
                 'no chunks were ingested — an absence assertion over an empty set proves nothing'
        elif [ "${null_embeddings:-}" = "0" ]; then
            pass 'every chunk carries a non-NULL embedding (R11)'
        else
            fail 'every chunk carries a non-NULL embedding (R11)' '0 NULL embeddings' \
                 "${null_embeddings:-<query failed>}"
        fi

        # R12 — chunks.embedding is vector(384) and bge-small-en-v1.5 emits 384. A width
        # mismatch would make query vectors and indexed vectors incomparable, which is the
        # silent-skew failure the /embed contract exists to prevent.
        dims="$(psql_q 'SELECT DISTINCT vector_dims(embedding) FROM chunks WHERE embedding IS NOT NULL')"
        if [ "${dims:-}" = "384" ]; then
            pass 'embeddings are 384-dimensional (R11, R12)'
        else
            fail 'embeddings are 384-dimensional (R11, R12)' '384' \
                 "${dims:-<no non-NULL embedding to measure>}"
        fi

        # R14 — re-ingesting unchanged adds and removes zero. This is what makes
        # re-ingestion cheap rather than a full rebuild.
        api -X POST "${FORGE}/corpora/${corpus_id}/ingest" >/dev/null
        sleep 8
        job="$(api "${FORGE}/corpora/${corpus_id}" | jq -r '.latest_job | "\(.chunks_added) \(.chunks_removed)"' 2>/dev/null)"
        # SAME GATE. "0 added, 0 removed" is trivially true when there was nothing to
        # re-ingest. This assertion covers the (content_sha256, source_path) pair keying
        # that edge 17 turns on — the subtlest invariant in the ingestion path — so a
        # vacuous pass here is the most expensive one in the script.
        if [ "${chunks:-0}" -eq 0 ]; then
            skip 're-ingesting unchanged adds and removes zero (R14)' \
                 'no chunks were ingested — 0 == 0 is trivially true and proves no idempotence'
        elif [ "$job" = "0 0" ]; then
            pass 're-ingesting unchanged adds and removes zero (R14)'
        else
            fail 're-ingesting unchanged adds and removes zero (R14)' '0 added, 0 removed' "$job"
        fi
    else
        fail 'Corpus created' 'a corpus_id' "${corpus:-<no response>}"
    fi
    rm -rf "$fixture"
else
    skip 'Corpus ingestion' "cannot create ${fixture} — check ARMADA_INGEST_ROOT permissions"
fi

# ── 8. ZERO SPEND ────────────────────────────────────────────────────────────
section '8. Zero external spend (invariant 7)'

caps="$(api "${FORGE}/config/capabilities")"
teacher="$(echo "$caps" | jq -r '.teacher_enabled' 2>/dev/null)"
mode="$(echo "$caps" | jq -r '.eval_mode' 2>/dev/null)"

[ "$teacher" = "false" ] && pass 'teacher disabled by default' \
    || fail 'teacher disabled by default' 'false' "${teacher:-<no response>}"
[ "$mode" = "mechanical" ] && pass 'evaluation gate is mechanical by default' \
    || fail 'evaluation gate is mechanical by default' 'mechanical' "${mode:-<no response>}"

# GET /config/capabilities returns exactly three fields and leaks nothing else.
keys="$(echo "$caps" | jq -r 'keys | join(",")' 2>/dev/null)"
if [ "$keys" = "eval_mode,local_backend_mode,teacher_enabled" ]; then
    pass '/config/capabilities leaks no credential, endpoint or env var name'
else
    fail '/config/capabilities leaks nothing' 'eval_mode,local_backend_mode,teacher_enabled' "${keys:-<no response>}"
fi

# Naming a corpus_id with the teacher disabled must be refused WITHOUT any outbound
# request (R16b). Reaching a paid endpoint on the default path is the one thing
# invariant 7 forbids outright.
if [ -n "${corpus_id:-}" ] && [ "${corpus_id:-null}" != "null" ]; then
    distil_payload="{\"corpus_id\":\"${corpus_id}\",\"include_trajectories\":false,\"max_samples\":10}"
    distil_code="$(api_code -X POST "${FORGE}/datasets" -H 'Content-Type: application/json' -d "$distil_payload")"
    distil_body="$(api -X POST "${FORGE}/datasets" -H 'Content-Type: application/json' -d "$distil_payload")"

    case "$distil_code" in
        400)
            pass 'corpus distillation refused with the teacher disabled (R16b)'
            # R16b requires the refusal to NAME the two teacher-free sources, so an
            # operator learns how to PROCEED rather than only that they cannot. A bare 400
            # satisfies the status code and fails the intent.
            if echo "$distil_body" | grep -q 'supplied_file' \
               && echo "$distil_body" | grep -q 'include_trajectories'; then
                pass 'the refusal names both teacher-free sources (R16b)'
            else
                fail 'the refusal names both teacher-free sources (R16b)' \
                     'body naming supplied_file AND include_trajectories' "${distil_body:-<empty>}"
            fi
            ;;
        404) skip 'corpus distillation refusal' 'POST /datasets lands in P11' ;;
        *)   fail 'corpus distillation refused' '400 (or 404 before P11)' "$distil_code" ;;
    esac
else
    skip 'corpus distillation refusal' 'no corpus was created in section 7'
fi

# ── 9. DAEMON ────────────────────────────────────────────────────────────────
section '9. Daemon'

health="$(api "${DAEMON}/api/health")"
plugins="$(echo "$health" | jq -r '.plugins | length' 2>/dev/null)"
if [ "$plugins" = "5" ]; then
    pass 'all five plugin interfaces registered (R14)'
else
    fail 'all five plugin interfaces registered (R14)' '5' "${plugins:-<no response>}"
fi

# R1 — ONE listener serving both /api/* and /ws. A 426 or 400 means the WebSocket route
# answered and declined a plain GET, which is the evidence we want.
ws_code="$(api_code "${DAEMON}/ws")"
case "$ws_code" in
    400|426|101) pass "the same port serves /ws (HTTP ${ws_code} to a non-upgrade GET)" ;;
    404)         fail 'the same port serves /ws' '400, 426 or 101' '404 — /ws not routed' ;;
    *)           fail 'the same port serves /ws' '400, 426 or 101' "${ws_code:-<no response>}" ;;
esac

# EVERY shipped Agent loads — expectation DERIVED FROM agents/, not hardcoded.
#
# This asserted the literal string `chef,frontend-engineer`. P8 added team-lead.yaml,
# because R45 needs a manager plus two workers and R7 forbids the manager being a worker,
# so the two existing Agents could not form a Team. The assertion then failed on a
# correctly-loaded third Agent — it was pinning a SNAPSHOT of the directory rather than
# the property that matters, which is that the loader loads everything in it.
#
# Deriving the list means adding an Agent cannot break this, while REMOVING one still
# does. That is the right asymmetry: a file that stops loading is a defect, a file that
# starts loading is the feature working.
expected_agents="$(basename -s .yaml -a agents/*.yaml 2>/dev/null | sort | paste -sd, -)"

agents_code="$(api_code "${DAEMON}/api/agents")"
if [ "$agents_code" != "200" ]; then
    skip 'shipped Agents loaded' "GET /api/agents returned ${agents_code}"
elif [ -z "$expected_agents" ]; then
    # NOT a pass. With no fixture the comparison below is '' = '', which the empty set
    # satisfies — the vacuous-pass shape this script has already been bitten by five times.
    fail 'shipped Agents loaded' 'at least one agents/*.yaml to load' '<agents/ is empty>'
else
    agent_names="$(api "${DAEMON}/api/agents" | jq -r '[.[].name] | sort | join(",")' 2>/dev/null)"
    if [ "$agent_names" = "$expected_agents" ]; then
        pass "every shipped Agent loaded from agents/ (${expected_agents})"
    else
        fail 'every shipped Agent loaded from agents/' "$expected_agents" "${agent_names:-<none>}"
    fi
fi

runs_code="$(api_code "${DAEMON}/api/runs")"
if [ "$runs_code" = "200" ]; then
    pass 'GET /api/runs served'
else
    skip 'GET /api/runs' "returned ${runs_code} — the agent loop lands in P7"
fi

# ── SUMMARY ──────────────────────────────────────────────────────────────────
printf '\n\033[1m── Summary\033[0m\n'
printf '  %s %d   %s %d   %s %d\n' "$(green PASS)" "$PASS" "$(red FAIL)" "$FAIL" "$(amber SKIP)" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
    printf '\n  failed:\n'
    for f in "${FAILURES[@]}"; do printf '    - %s\n' "$f"; done
fi

# Restored explicitly as well as by the trap, so the final state is visible in the output.
restore_shortlist
if git diff --quiet -- "$SHORTLIST" 2>/dev/null; then
    printf '\n  %s %s is byte-identical to git HEAD\n' "$(green '✓')" "$SHORTLIST"
else
    printf '\n  %s %s DIFFERS from git HEAD — restore it before committing\n' "$(red '✗')" "$SHORTLIST"
    FAIL=$((FAIL + 1))
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
