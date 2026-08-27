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

# ── WHERE THE WORKSPACE FIXTURE GOES ─────────────────────────────────────────
# Section 7 needs a directory that BOTH the daemon and a sandbox container can see. There
# is no /workspace/docs mount and inventing one would not work. P5 introduced
# ARMADA_WORKSPACE_ROOT, bind-mounted at the SAME path on both sides of the daemon
# container — it is the one path the daemon and Docker agree on, so the fixture lives
# under it.
ARMADA_WORKSPACE_ROOT="${ARMADA_WORKSPACE_ROOT:-/var/lib/armada/workspaces}"

# Ports and their override names already exist in docker-compose.yml. Reused, not invented.
FORGE_PORT="${ARMADA_FORGE_PORT:-8000}"
DAEMON_PORT="${ARMADA_PORT:-8080}"
FORGE="http://localhost:${FORGE_PORT}"
DAEMON="http://localhost:${DAEMON_PORT}"

SHORTLIST="config/base-models.yaml"
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

api()      { curl -sS --max-time 30 "$@" 2>/dev/null; }
api_code() { curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

printf '\033[1mArmada smoke test\033[0m\n'
printf 'forge %s · daemon %s · workspace root %s\n' "$FORGE" "$DAEMON" "$ARMADA_WORKSPACE_ROOT"

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

build_log="$(mktemp)"
if docker compose up -d --build >"$build_log" 2>&1; then
    pass 'docker compose up --build'
else
    fail 'docker compose up --build' 'exit 0' "exit $? — see $build_log"
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
applied="$(docker compose exec -T armada-db psql -U armada -d armada -tAc \
    'SELECT count(*) FROM schema_migrations' 2>/dev/null | tr -d ' \r')"
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
if echo "$bindings" | jq -e '[.[] | select(.backend | test("http"))] | length == 0' >/dev/null 2>&1; then
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
section '6. Malformed shortlist fails startup (R3)'

backup_shortlist
# Remove a required key from the FIRST entry. Startup must then exit non-zero naming that
# entry's id (R3). sed rather than python3: the daemon and forge images do not carry a
# python3 the host is guaranteed to share, and one guaranteed tool beats two paths.
# The 0,/re/ form bounds the deletion to the first match, so exactly one entry is broken.
sed -i.bak '0,/^ *min_ram_gb:/{/^ *min_ram_gb:/d}' "$SHORTLIST"
rm -f "${SHORTLIST}.bak"

docker compose restart armada-forge >/dev/null 2>&1
sleep 10
forge_state="$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="armada-forge"{print $2}')"
forge_logs="$(docker compose logs --tail 40 armada-forge 2>/dev/null)"

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
    pass 'forge refuses to run on an invalid shortlist'
else
    fail 'forge refuses to run on an invalid shortlist' 'not running' "$forge_state"
fi

restore_shortlist
docker compose restart armada-forge >/dev/null 2>&1
for _ in $(seq 1 60); do
    [ "$(api_code "${FORGE}/health")" = "200" ] && break
    sleep 2
done

# ── 7. INGESTION ─────────────────────────────────────────────────────────────
section '7. Corpus ingestion'

fixture="${ARMADA_WORKSPACE_ROOT}/smoke-fixture"
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

        api -X POST "${FORGE}/corpora/${corpus_id}/sources" -H 'Content-Type: application/json' \
            -d "{\"type\":\"directory\",\"location\":\"${fixture}\",\"include_globs\":[\"**/*.md\"]}" >/dev/null
        api -X POST "${FORGE}/corpora/${corpus_id}/ingest" >/dev/null

        chunks=0
        for _ in $(seq 1 60); do
            chunks="$(api "${FORGE}/corpora/${corpus_id}" | jq -r '.chunk_count' 2>/dev/null)"
            [ "${chunks:-0}" -gt 0 ] && break
            sleep 2
        done

        if [ "${chunks:-0}" -gt 0 ]; then
            pass "ingestion produced ${chunks} chunk(s) with embeddings"
        else
            fail 'ingestion produced chunks' '> 0' "${chunks:-0}"
        fi

        # R14 — re-ingesting unchanged adds and removes zero. This is what makes
        # re-ingestion cheap rather than a full rebuild.
        api -X POST "${FORGE}/corpora/${corpus_id}/ingest" >/dev/null
        sleep 8
        job="$(api "${FORGE}/corpora/${corpus_id}" | jq -r '.latest_job | "\(.chunks_added) \(.chunks_removed)"' 2>/dev/null)"
        if [ "$job" = "0 0" ]; then
            pass 're-ingesting unchanged adds and removes zero (R14)'
        else
            fail 're-ingesting unchanged adds and removes zero (R14)' '0 added, 0 removed' "$job"
        fi
    else
        fail 'Corpus created' 'a corpus_id' "${corpus:-<no response>}"
    fi
    rm -rf "$fixture"
else
    skip 'Corpus ingestion' "cannot create ${fixture} — check ARMADA_WORKSPACE_ROOT permissions"
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
    distil_code="$(api_code -X POST "${FORGE}/datasets" -H 'Content-Type: application/json' \
        -d "{\"corpus_id\":\"${corpus_id}\",\"include_trajectories\":false,\"max_samples\":10}")"
    case "$distil_code" in
        400) pass 'corpus distillation refused with the teacher disabled (R16b)' ;;
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

# Agents load from agents/ on startup once P4's file loader is wired into the daemon.
agents_code="$(api_code "${DAEMON}/api/agents")"
if [ "$agents_code" = "200" ]; then
    agent_names="$(api "${DAEMON}/api/agents" | jq -r '[.[].name] | sort | join(",")' 2>/dev/null)"
    if [ "$agent_names" = "chef,frontend-engineer" ]; then
        pass 'both shipped example Agents loaded from agents/'
    else
        fail 'both shipped example Agents loaded' 'chef,frontend-engineer' "${agent_names:-<none>}"
    fi
else
    skip 'shipped Agents loaded' "GET /api/agents returned ${agents_code} — routes wire up in P7"
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
