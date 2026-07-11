#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly DEFAULT_OPTIMIZER="${REPO_ROOT}/src/simulation/optimizer/v0_7_96h.mjs"
readonly NICE_LEVEL=10

usage() {
    cat >&2 <<'EOF'
Usage: scripts/run_v0_7_96h.sh [OUTPUT_DIR] [-- OPTIMIZER_ARGS...]

OUTPUT_DIR is required either positionally or through V07_96H_OUT. Relative
paths are resolved from the repository root. The same output directory may be
passed again to resume its persisted deadline; flock prevents concurrent use.
EOF
}

fail() {
    printf 'run_v0_7_96h.sh: %s\n' "$*" >&2
    exit 64
}

resolve_path() {
    local value="$1"
    if [[ "${value}" == /* ]]; then
        realpath -m -- "${value}"
    else
        realpath -m -- "${REPO_ROOT}/${value}"
    fi
}

for dependency in bun flock nice realpath setsid; do
    command -v "${dependency}" >/dev/null 2>&1 || fail "required command is unavailable: ${dependency}"
done

cli_out=""
if (($# > 0)) && [[ "$1" != "--" ]]; then
    cli_out="$1"
    shift
fi
if (($# > 0)); then
    [[ "$1" == "--" ]] || {
        usage
        fail "optimizer arguments must follow --"
    }
    shift
fi
optimizer_args=("$@")

env_out="${V07_96H_OUT:-}"
[[ -n "${cli_out}" || -n "${env_out}" ]] || {
    usage
    fail "provide one unique output directory via OUTPUT_DIR or V07_96H_OUT"
}

if [[ -n "${cli_out}" && -n "${env_out}" ]]; then
    [[ "$(resolve_path "${cli_out}")" == "$(resolve_path "${env_out}")" ]] || \
        fail "positional OUTPUT_DIR and V07_96H_OUT resolve to different paths"
fi

readonly RUN_OUT="$(resolve_path "${cli_out:-${env_out}}")"
[[ "${RUN_OUT}" != "${REPO_ROOT}" && "${RUN_OUT}" != "/" ]] || fail "refusing unsafe output path: ${RUN_OUT}"

readonly OPTIMIZER="$(resolve_path "${V07_96H_OPTIMIZER:-${DEFAULT_OPTIMIZER}}")"
readonly HOURS="${V07_96H_HOURS:-96}"
readonly HEARTBEAT_SECONDS="${V07_96H_HEARTBEAT_SECONDS:-30}"
readonly RESTART_BASE_SECONDS="${V07_96H_RESTART_BASE_SECONDS:-15}"
readonly RESTART_MAX_SECONDS="${V07_96H_RESTART_MAX_SECONDS:-900}"
readonly MAX_RESTARTS="${V07_96H_MAX_RESTARTS:-8}"
readonly STOP_GRACE_SECONDS="${V07_96H_STOP_GRACE_SECONDS:-30}"

for numeric_name in HOURS HEARTBEAT_SECONDS RESTART_BASE_SECONDS RESTART_MAX_SECONDS MAX_RESTARTS STOP_GRACE_SECONDS; do
    numeric_value="${!numeric_name}"
    [[ "${numeric_value}" =~ ^[0-9]+$ ]] || fail "${numeric_name} must be an integer"
done
((HOURS > 0)) || fail "V07_96H_HOURS must be positive"
((HEARTBEAT_SECONDS > 0)) || fail "V07_96H_HEARTBEAT_SECONDS must be positive"
((RESTART_BASE_SECONDS > 0)) || fail "V07_96H_RESTART_BASE_SECONDS must be positive"
((RESTART_MAX_SECONDS >= RESTART_BASE_SECONDS)) || \
    fail "V07_96H_RESTART_MAX_SECONDS must be >= V07_96H_RESTART_BASE_SECONDS"
((MAX_RESTARTS > 0)) || fail "V07_96H_MAX_RESTARTS must be positive"
((STOP_GRACE_SECONDS > 0)) || fail "V07_96H_STOP_GRACE_SECONDS must be positive"

mkdir -p -- "${RUN_OUT}"

readonly LOCK_FILE="${RUN_OUT}/supervisor.lock"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    printf 'run_v0_7_96h.sh: output directory is already supervised: %s\n' "${RUN_OUT}" >&2
    exit 75
fi

readonly SUPERVISOR_LOG="${RUN_OUT}/supervisor.log"
readonly OPTIMIZER_LOG="${RUN_OUT}/optimizer.log"
readonly SUPERVISOR_PID_FILE="${RUN_OUT}/supervisor.pid"
readonly OPTIMIZER_PID_FILE="${RUN_OUT}/optimizer.pid"
readonly HEARTBEAT_FILE="${RUN_OUT}/supervisor.heartbeat"
readonly START_EPOCH_FILE="${RUN_OUT}/supervisor.started_epoch"
readonly DEADLINE_EPOCH_FILE="${RUN_OUT}/supervisor.deadline_epoch"
readonly DEADLINE_MARKER="${RUN_OUT}/SUPERVISOR_DEADLINE"
readonly PROTOCOL_ERROR_MARKER="${RUN_OUT}/SUPERVISOR_PROTOCOL_ERROR"

terminal_marker_raw="${V07_96H_TERMINAL_MARKER:-TERMINAL.json}"
if [[ "${terminal_marker_raw}" == /* ]]; then
    readonly TERMINAL_MARKER="$(realpath -m -- "${terminal_marker_raw}")"
else
    readonly TERMINAL_MARKER="$(realpath -m -- "${RUN_OUT}/${terminal_marker_raw}")"
fi

exec >>"${SUPERVISOR_LOG}" 2>&1

iso_now() {
    date -u +'%Y-%m-%dT%H:%M:%SZ'
}

log() {
    printf '[%s] %s\n' "$(iso_now)" "$*"
}

atomic_write() {
    local destination="$1"
    local content="$2"
    local temporary="${destination}.tmp.$$"
    printf '%s\n' "${content}" >"${temporary}"
    mv -f -- "${temporary}" "${destination}"
}

terminal_marker_valid() {
    local run_file="${RUN_OUT}/run.json"
    [[ -f "${TERMINAL_MARKER}" && -f "${run_file}" ]] || return 1
    bun -e '
        import { createHash } from "node:crypto";
        import { readFileSync } from "node:fs";
        const canonical = (value) => Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === "object"
              ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
              : value;
        const terminal = JSON.parse(readFileSync(process.argv[1], "utf8"));
        const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
        const { terminalSha256, ...base } = terminal;
        const actual = createHash("sha256").update(JSON.stringify(canonical(base))).digest("hex");
        if (terminal.schemaVersion !== 1 || terminal.status !== "complete_research_only" ||
            terminal.runId !== run.runId || terminalSha256 !== actual) process.exit(1);
    ' "${TERMINAL_MARKER}" "${run_file}"
}

deadline_marker_valid() {
    local content
    (( $(date +%s) >= DEADLINE_EPOCH )) || return 1
    read -r content <"${DEADLINE_MARKER}" || return 1
    [[ "${content}" == time=*" deadline=${DEADLINE_EPOCH} reason=wall-clock-deadline" ]]
}

readonly NOW_AT_START="$(date +%s)"
if [[ -f "${START_EPOCH_FILE}" ]]; then
    read -r START_EPOCH <"${START_EPOCH_FILE}"
    [[ "${START_EPOCH}" =~ ^[0-9]+$ ]] || fail "invalid persisted start epoch"
else
    START_EPOCH="${NOW_AT_START}"
    atomic_write "${START_EPOCH_FILE}" "${START_EPOCH}"
fi
readonly START_EPOCH

requested_deadline="${V07_96H_DEADLINE_EPOCH:-}"
if [[ -n "${requested_deadline}" ]]; then
    [[ "${requested_deadline}" =~ ^[0-9]+$ ]] || fail "V07_96H_DEADLINE_EPOCH must be an epoch integer"
fi

if [[ -f "${DEADLINE_EPOCH_FILE}" ]]; then
    read -r DEADLINE_EPOCH <"${DEADLINE_EPOCH_FILE}"
    [[ "${DEADLINE_EPOCH}" =~ ^[0-9]+$ ]] || fail "invalid persisted deadline epoch"
    if [[ -n "${requested_deadline}" && "${requested_deadline}" != "${DEADLINE_EPOCH}" ]]; then
        fail "V07_96H_DEADLINE_EPOCH conflicts with the persisted run deadline"
    fi
    if [[ -n "${V07_96H_HOURS+x}" ]]; then
        requested_from_hours=$((START_EPOCH + HOURS * 3600))
        ((requested_from_hours == DEADLINE_EPOCH)) || \
            fail "V07_96H_HOURS conflicts with the persisted run deadline"
    fi
else
    DEADLINE_EPOCH="${requested_deadline:-$((START_EPOCH + HOURS * 3600))}"
    atomic_write "${DEADLINE_EPOCH_FILE}" "${DEADLINE_EPOCH}"
fi
readonly DEADLINE_EPOCH

atomic_write "${SUPERVISOR_PID_FILE}" "$$"

CHILD_PID=""
STOP_REASON=""

write_heartbeat() {
    local state="$1"
    local attempt="$2"
    local child="${CHILD_PID:-none}"
    atomic_write "${HEARTBEAT_FILE}" \
        "time=$(iso_now) epoch=$(date +%s) state=${state} supervisor=$$ child=${child} attempt=${attempt} deadline=${DEADLINE_EPOCH}"
}

stop_child() {
    local reason="$1"
    [[ -n "${CHILD_PID}" ]] || return 0
    if kill -0 -- "-${CHILD_PID}" 2>/dev/null; then
        log "stopping optimizer pid=${CHILD_PID}: ${reason}"
        kill -TERM -- "-${CHILD_PID}" 2>/dev/null || true
        local waited=0
        while kill -0 -- "-${CHILD_PID}" 2>/dev/null && ((waited < STOP_GRACE_SECONDS)); do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 -- "-${CHILD_PID}" 2>/dev/null; then
            log "optimizer ignored TERM for ${STOP_GRACE_SECONDS}s; sending KILL"
            kill -KILL -- "-${CHILD_PID}" 2>/dev/null || true
        fi
    fi
    wait "${CHILD_PID}" 2>/dev/null || true
    CHILD_PID=""
    rm -f -- "${OPTIMIZER_PID_FILE}"
}

cleanup() {
    local status=$?
    if [[ -n "${CHILD_PID}" ]]; then
        stop_child "supervisor exit status ${status}"
    fi
    if [[ -f "${SUPERVISOR_PID_FILE}" ]] && [[ "$(<"${SUPERVISOR_PID_FILE}")" == "$$" ]]; then
        rm -f -- "${SUPERVISOR_PID_FILE}"
    fi
}

handle_signal() {
    local signal_name="$1"
    local status="$2"
    STOP_REASON="signal-${signal_name}"
    log "received ${signal_name}; stopping without creating an optimizer terminal marker"
    write_heartbeat "stopping-${signal_name}" "0"
    stop_child "supervisor received ${signal_name}"
    exit "${status}"
}

trap cleanup EXIT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal INT 130' INT

mark_deadline() {
    [[ -f "${DEADLINE_MARKER}" ]] || atomic_write "${DEADLINE_MARKER}" \
        "time=$(iso_now) deadline=${DEADLINE_EPOCH} reason=wall-clock-deadline"
    STOP_REASON="deadline"
    write_heartbeat "deadline" "0"
}

terminal_or_deadline() {
    if [[ -f "${TERMINAL_MARKER}" ]]; then
        if ! terminal_marker_valid; then
            atomic_write "${PROTOCOL_ERROR_MARKER}" \
                "time=$(iso_now) reason=invalid-terminal-marker path=${TERMINAL_MARKER}"
            fail "terminal marker failed schema, run-id, or self-hash validation: ${TERMINAL_MARKER}"
        fi
        STOP_REASON="terminal-marker"
        return 0
    fi
    if [[ -f "${DEADLINE_MARKER}" ]]; then
        if ! deadline_marker_valid; then
            atomic_write "${PROTOCOL_ERROR_MARKER}" \
                "time=$(iso_now) reason=invalid-deadline-marker path=${DEADLINE_MARKER}"
            fail "deadline marker does not match the persisted elapsed deadline: ${DEADLINE_MARKER}"
        fi
        STOP_REASON="deadline-marker"
        return 0
    fi
    if (( $(date +%s) >= DEADLINE_EPOCH )); then
        mark_deadline
        return 0
    fi
    return 1
}

if terminal_or_deadline; then
    log "nothing to launch: ${STOP_REASON} already reached for ${RUN_OUT}"
    exit 0
fi

[[ -f "${OPTIMIZER}" ]] || fail "optimizer entry point does not exist: ${OPTIMIZER}"

export V07_96H_OUT="${RUN_OUT}"
export V07_96H_DEADLINE_EPOCH="${DEADLINE_EPOCH}"
export V07_96H_RESEARCH_ONLY=1

log "supervisor start pid=$$ out=${RUN_OUT} deadline=${DEADLINE_EPOCH} optimizer=${OPTIMIZER}"
log "safety mode: research-only; wrapper performs no git, push, bake, or deploy operation"

run_optimizer_once() {
    local attempt="$1"
    printf '\n[%s] attempt=%s command=nice -n %s bun %s --out=%s\n' \
        "$(iso_now)" "${attempt}" "${NICE_LEVEL}" "${OPTIMIZER}" "${RUN_OUT}" >>"${OPTIMIZER_LOG}"
    setsid nice -n "${NICE_LEVEL}" bun "${OPTIMIZER}" "--out=${RUN_OUT}" \
        "${optimizer_args[@]}" >>"${OPTIMIZER_LOG}" 2>&1 9>&- &
    CHILD_PID=$!
    atomic_write "${OPTIMIZER_PID_FILE}" "${CHILD_PID}"
    log "optimizer attempt=${attempt} pid=${CHILD_PID}"

    while kill -0 "${CHILD_PID}" 2>/dev/null; do
        if terminal_or_deadline; then
            stop_child "${STOP_REASON}"
            return 0
        fi
        write_heartbeat "running" "${attempt}"
        sleep "${HEARTBEAT_SECONDS}"
    done

    local status
    if wait "${CHILD_PID}"; then
        status=0
    else
        status=$?
    fi
    if kill -0 -- "-${CHILD_PID}" 2>/dev/null; then
        stop_child "optimizer leader exited but its process group remained"
    else
        CHILD_PID=""
        rm -f -- "${OPTIMIZER_PID_FILE}"
    fi
    return "${status}"
}

backoff_for_attempt() {
    local attempt="$1"
    local delay="${RESTART_BASE_SECONDS}"
    local index=1
    while ((index < attempt && delay < RESTART_MAX_SECONDS)); do
        if ((delay > RESTART_MAX_SECONDS / 2)); then
            delay="${RESTART_MAX_SECONDS}"
        else
            delay=$((delay * 2))
        fi
        index=$((index + 1))
    done
    ((delay > RESTART_MAX_SECONDS)) && delay="${RESTART_MAX_SECONDS}"
    printf '%s\n' "${delay}"
}

wait_before_restart() {
    local seconds="$1"
    local attempt="$2"
    local remaining="${seconds}"
    while ((remaining > 0)); do
        if terminal_or_deadline; then
            return 0
        fi
        write_heartbeat "restart-backoff" "${attempt}"
        local step="${HEARTBEAT_SECONDS}"
        ((step > remaining)) && step="${remaining}"
        local until_deadline=$((DEADLINE_EPOCH - $(date +%s)))
        ((until_deadline <= 0)) && continue
        ((step > until_deadline)) && step="${until_deadline}"
        sleep "${step}"
        remaining=$((remaining - step))
    done
}

attempt=0
while true; do
    if terminal_or_deadline; then
        log "supervisor complete: ${STOP_REASON}"
        exit 0
    fi

    attempt=$((attempt + 1))
    child_status=0
    if run_optimizer_once "${attempt}"; then
        child_status=0
    else
        child_status=$?
    fi

    if terminal_or_deadline; then
        log "supervisor complete after attempt=${attempt}: ${STOP_REASON}"
        exit 0
    fi

    if ((child_status == 0)); then
        atomic_write "${PROTOCOL_ERROR_MARKER}" \
            "time=$(iso_now) reason=optimizer-exited-zero-without-terminal-marker attempt=${attempt}"
        write_heartbeat "protocol-error" "${attempt}"
        log "optimizer exited 0 without ${TERMINAL_MARKER}; refusing an ambiguous restart"
        exit 78
    fi

    if ((attempt >= MAX_RESTARTS)); then
        atomic_write "${PROTOCOL_ERROR_MARKER}" \
            "time=$(iso_now) reason=max-restarts-exhausted attempts=${attempt} last_status=${child_status}"
        write_heartbeat "restart-limit" "${attempt}"
        log "optimizer failed ${attempt} consecutive times; refusing to burn the remaining deadline"
        exit 79
    fi

    delay="$(backoff_for_attempt "${attempt}")"
    log "optimizer exited status=${child_status}; restart in ${delay}s unless terminal/deadline appears"
    wait_before_restart "${delay}" "${attempt}"
done
