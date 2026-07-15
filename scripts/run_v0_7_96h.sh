#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly DEFAULT_OPTIMIZER="${REPO_ROOT}/src/simulation/optimizer/v0_7_96h.mjs"
readonly HOST_GUARD_HELPER="${SCRIPT_DIR}/v0_7_host_contention_guard.mjs"
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
readonly HOST_GUARD="${V07_96H_HOST_GUARD:-0}"
readonly HOST_GUARD_MIN_IDLE_CPUS="${V07_96H_HOST_GUARD_MIN_IDLE_CPUS:-}"
readonly HOST_GUARD_SAMPLE_MS="${V07_96H_HOST_GUARD_SAMPLE_MS:-1000}"
readonly HOST_GUARD_CHECK_SECONDS="${V07_96H_HOST_GUARD_CHECK_SECONDS:-5}"
readonly HOST_GUARD_TEST_MODE="${V07_96H_HOST_GUARD_TEST_MODE:-0}"
readonly HOST_GUARD_FIXTURE="${V07_96H_HOST_GUARD_FIXTURE:-}"
readonly HOST_GUARD_TEST_PRESPAWN_SECONDS="${V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS:-0}"
readonly HOST_GUARD_EXPECTED_CONFIG="schema=1 enabled=1 min_idle_cpus=${HOST_GUARD_MIN_IDLE_CPUS} sample_ms=${HOST_GUARD_SAMPLE_MS} check_seconds=${HOST_GUARD_CHECK_SECONDS} helper_protocol=1 test_mode=${HOST_GUARD_TEST_MODE} fixture=${HOST_GUARD_FIXTURE:-none}"
HOST_GUARD_CONFIG_PENDING=0

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

[[ "${HOST_GUARD}" == "0" || "${HOST_GUARD}" == "1" ]] || \
    fail "V07_96H_HOST_GUARD must be exactly 0 or 1"
[[ "${HOST_GUARD_TEST_MODE}" == "0" || "${HOST_GUARD_TEST_MODE}" == "1" ]] || \
    fail "V07_96H_HOST_GUARD_TEST_MODE must be exactly 0 or 1"
if [[ "${HOST_GUARD}" == "1" ]]; then
    [[ "${HOST_GUARD_MIN_IDLE_CPUS}" =~ ^[0-9]+$ ]] || \
        fail "V07_96H_HOST_GUARD_MIN_IDLE_CPUS must be provided as an integer when the host guard is enabled"
    ((HOST_GUARD_MIN_IDLE_CPUS > 0 && HOST_GUARD_MIN_IDLE_CPUS <= 1024)) || \
        fail "V07_96H_HOST_GUARD_MIN_IDLE_CPUS must be between 1 and 1024"
    [[ "${HOST_GUARD_SAMPLE_MS}" =~ ^[0-9]+$ ]] || fail "V07_96H_HOST_GUARD_SAMPLE_MS must be an integer"
    ((HOST_GUARD_SAMPLE_MS >= 10 && HOST_GUARD_SAMPLE_MS <= 60000)) || \
        fail "V07_96H_HOST_GUARD_SAMPLE_MS must be between 10 and 60000"
    [[ "${HOST_GUARD_CHECK_SECONDS}" =~ ^[0-9]+$ ]] || \
        fail "V07_96H_HOST_GUARD_CHECK_SECONDS must be an integer"
    ((HOST_GUARD_CHECK_SECONDS > 0 && HOST_GUARD_CHECK_SECONDS <= 3600)) || \
        fail "V07_96H_HOST_GUARD_CHECK_SECONDS must be between 1 and 3600"
    [[ -f "${HOST_GUARD_HELPER}" ]] || fail "host guard helper is missing: ${HOST_GUARD_HELPER}"
    if [[ -n "${HOST_GUARD_FIXTURE}" ]]; then
        [[ "${HOST_GUARD_TEST_MODE}" == "1" ]] || \
            fail "V07_96H_HOST_GUARD_FIXTURE requires V07_96H_HOST_GUARD_TEST_MODE=1"
        [[ "${HOST_GUARD_FIXTURE}" == /* && -f "${HOST_GUARD_FIXTURE}" ]] || \
            fail "V07_96H_HOST_GUARD_FIXTURE must be an absolute regular-file path"
        [[ "${HOST_GUARD_TEST_PRESPAWN_SECONDS}" =~ ^[0-9]+$ ]] || \
            fail "V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS must be an integer"
        ((HOST_GUARD_TEST_PRESPAWN_SECONDS >= 0 && HOST_GUARD_TEST_PRESPAWN_SECONDS <= 60)) || \
            fail "V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS must be between 0 and 60"
    else
        [[ -z "${V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS+x}" ]] || \
            fail "V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS requires a host guard test fixture"
        [[ "${HOST_GUARD_TEST_MODE}" == "0" ]] || \
            fail "V07_96H_HOST_GUARD_TEST_MODE=1 requires V07_96H_HOST_GUARD_FIXTURE"
    fi
else
    [[ -z "${V07_96H_HOST_GUARD_MIN_IDLE_CPUS+x}${V07_96H_HOST_GUARD_SAMPLE_MS+x}${V07_96H_HOST_GUARD_CHECK_SECONDS+x}${V07_96H_HOST_GUARD_FIXTURE+x}${V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS+x}" ]] || \
        fail "host guard tuning variables require V07_96H_HOST_GUARD=1"
    [[ "${HOST_GUARD_TEST_MODE}" == "0" ]] || fail "V07_96H_HOST_GUARD_TEST_MODE requires V07_96H_HOST_GUARD=1"
fi

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
readonly HOST_CONTENTION_MARKER="${RUN_OUT}/SUPERVISOR_HOST_CONTENTION_QUARANTINE"
readonly HOST_GUARD_ARMED_MARKER="${RUN_OUT}/SUPERVISOR_HOST_GUARD_ARMED"
readonly HOST_GUARD_CONFIG_FILE="${RUN_OUT}/supervisor.host_guard.config"
readonly HOST_GUARD_CPU_BASELINE="${RUN_OUT}/supervisor.host_guard.cpu_baseline.json"

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

path_exists() {
    [[ -e "$1" || -L "$1" ]]
}

host_guard_config_owned() {
    [[ -f "${HOST_GUARD_CONFIG_FILE}" && ! -L "${HOST_GUARD_CONFIG_FILE}" ]] || return 1
    local content
    content="$(<"${HOST_GUARD_CONFIG_FILE}")"
    [[ "${content}" == "${HOST_GUARD_EXPECTED_CONFIG}" ]]
}

early_refuse_quarantined_run() {
    if path_exists "${HOST_CONTENTION_MARKER}"; then
        atomic_write "${HEARTBEAT_FILE}" \
            "time=$(iso_now) epoch=$(date +%s) state=host-contention-quarantined supervisor=$$ child=none attempt=0 deadline=unknown host_guard=${HOST_GUARD} host_guard_last_epoch=0"
        log "refusing permanently quarantined output: ${RUN_OUT}"
        exit 80
    fi
    if path_exists "${HOST_GUARD_ARMED_MARKER}"; then
        mv -f -- "${HOST_GUARD_ARMED_MARKER}" "${HOST_CONTENTION_MARKER}"
        atomic_write "${HEARTBEAT_FILE}" \
            "time=$(iso_now) epoch=$(date +%s) state=host-contention-quarantined supervisor=$$ child=unknown attempt=0 deadline=unknown host_guard=${HOST_GUARD} host_guard_last_epoch=0"
        log "stale host guard sentinel proves monitoring continuity was lost; output is permanently quarantined: ${RUN_OUT}"
        exit 80
    fi
}

ensure_host_guard_config() {
    if path_exists "${HOST_GUARD_CONFIG_FILE}"; then
        [[ "${HOST_GUARD}" == "1" ]] || fail "this output requires its persisted host guard configuration"
        host_guard_config_owned || \
            fail "host guard settings conflict with the persisted output configuration"
        return 0
    fi
    [[ "${HOST_GUARD}" == "1" ]] || return 0
    local entry
    local name
    for entry in "${RUN_OUT}"/.[!.]* "${RUN_OUT}"/..?* "${RUN_OUT}"/*; do
        path_exists "${entry}" || continue
        name="${entry##*/}"
        case "${name}" in
            supervisor.lock | supervisor.log | supervisor.heartbeat) ;;
            *) fail "cannot enable the host guard on an output containing unguarded payload ${name}; use a fresh output" ;;
        esac
    done
    HOST_GUARD_CONFIG_PENDING=1
}

early_refuse_quarantined_run
ensure_host_guard_config

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
CURRENT_ATTEMPT=0
LAST_HOST_GUARD_EPOCH=0
HOST_GUARD_ARMED_BY_THIS_PROCESS=0
QUARANTINE_REQUIRED=0
CONTROLLED_DISARM=0
PROBE_IN_FLIGHT=0
PROBE_PID=""
PROBE_OUTPUT=""
DEFERRED_SIGNAL=""
STOP_IN_PROGRESS=0

install_signal_handlers() {
    trap 'handle_signal TERM 143' TERM
    trap 'handle_signal INT 130' INT
}

defer_signal() {
    DEFERRED_SIGNAL="$1"
}

stop_probe() {
    [[ -n "${PROBE_PID}" ]] || return 0
    kill -TERM -- "-${PROBE_PID}" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-${PROBE_PID}" 2>/dev/null || true
    wait "${PROBE_PID}" 2>/dev/null || true
    PROBE_PID=""
}

write_heartbeat() {
    local state="$1"
    local attempt="$2"
    local child="${CHILD_PID:-none}"
    local heartbeat="time=$(iso_now) epoch=$(date +%s) state=${state} supervisor=$$ child=${child} attempt=${attempt} deadline=${DEADLINE_EPOCH}"
    if [[ "${HOST_GUARD}" == "1" || "${state}" == host-contention-* ]]; then
        heartbeat+=" host_guard=${HOST_GUARD} host_guard_last_epoch=${LAST_HOST_GUARD_EPOCH}"
    fi
    atomic_write "${HEARTBEAT_FILE}" "${heartbeat}"
}

sanitize_marker_detail() {
    local detail="$1"
    detail="${detail//$'\n'/ }"
    detail="${detail//$'\r'/ }"
    printf '%s' "${detail:0:4000}"
}

write_armed_marker() {
    local attempt="$1"
    CONTROLLED_DISARM=0
    QUARANTINE_REQUIRED=0
    if ! atomic_write "${HOST_GUARD_ARMED_MARKER}" \
        "schema=1 time=$(iso_now) epoch=$(date +%s) state=armed supervisor=$$ attempt=${attempt} deadline=${DEADLINE_EPOCH}"; then
        promote_armed_to_quarantine "armed-marker-write-failed" "70" \
            "could not atomically create the required host guard sentinel"
        exit 80
    fi
    HOST_GUARD_ARMED_BY_THIS_PROCESS=1
    if ! armed_marker_owned; then
        promote_armed_to_quarantine "armed-marker-validation-failed" "70" \
            "new host guard sentinel was missing, linked, or did not match this supervisor"
        exit 80
    fi
    log "host guard armed attempt=${attempt}"
}

promote_armed_to_quarantine() {
    local phase="$1"
    local helper_status="$2"
    local detail
    detail="$(sanitize_marker_detail "$3")"
    local content="schema=1 time=$(iso_now) epoch=$(date +%s) state=host-contention-quarantined phase=${phase} helper_status=${helper_status} supervisor=$$ child=${CHILD_PID:-none} attempt=${CURRENT_ATTEMPT} deadline=${DEADLINE_EPOCH} assessment=${detail}"

    QUARANTINE_REQUIRED=1
    if path_exists "${HOST_GUARD_ARMED_MARKER}"; then
        mv -f -- "${HOST_GUARD_ARMED_MARKER}" "${HOST_CONTENTION_MARKER}"
    elif ! path_exists "${HOST_CONTENTION_MARKER}"; then
        atomic_write "${HOST_CONTENTION_MARKER}" "${content}"
    fi
    HOST_GUARD_ARMED_BY_THIS_PROCESS=0
    if ! atomic_write "${HOST_CONTENTION_MARKER}" "${content}"; then
        log "could not enrich the permanent host contention marker; its tombstone remains authoritative"
    fi
    STOP_REASON="host-contention-quarantine"
    write_heartbeat "host-contention-quarantined" "${CURRENT_ATTEMPT}"
    log "host contention quarantine phase=${phase} helper_status=${helper_status}: ${detail}"
}

armed_marker_owned() {
    [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] || return 1
    [[ -f "${HOST_GUARD_ARMED_MARKER}" && ! -L "${HOST_GUARD_ARMED_MARKER}" ]] || return 1
    local content
    content="$(<"${HOST_GUARD_ARMED_MARKER}")"
    [[ "${content}" == schema=1\ time=*\ state=armed\ supervisor=$$\ attempt=${CURRENT_ATTEMPT}\ deadline=${DEADLINE_EPOCH} ]]
}

assert_armed_marker() {
    local phase="$1"
    if armed_marker_owned; then
        return 0
    fi
    promote_armed_to_quarantine "missing-or-corrupt-armed-${phase}" "70" \
        "required host guard sentinel disappeared or no longer identifies this supervisor"
    return 80
}

disarm_after_verified_stop() {
    local child_pgid="$1"
    [[ "${HOST_GUARD}" == "1" ]] || return 0
    if [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] && ! assert_armed_marker "disarm"; then
        return 1
    fi
    [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] || return 0
    if [[ -n "${child_pgid}" ]] && kill -0 -- "-${child_pgid}" 2>/dev/null; then
        promote_armed_to_quarantine "optimizer-process-group-survived-stop" "70" \
            "optimizer process group ${child_pgid} remained alive after TERM/KILL grace"
        return 1
    fi
    if [[ "${QUARANTINE_REQUIRED}" == "1" || "${CONTROLLED_DISARM}" != "1" ]]; then
        promote_armed_to_quarantine "uncontrolled-supervisor-stop" "70" \
            "host guard sentinel could not be safely disarmed after supervisor control flow changed"
        return 1
    fi
    rm -f -- "${HOST_GUARD_ARMED_MARKER}"
    HOST_GUARD_ARMED_BY_THIS_PROCESS=0
    CONTROLLED_DISARM=0
    log "host guard disarmed after optimizer process group ${child_pgid:-none} disappeared"
}

refuse_if_quarantined() {
    if path_exists "${HOST_CONTENTION_MARKER}"; then
        STOP_REASON="host-contention-quarantine"
        write_heartbeat "host-contention-quarantined" "${CURRENT_ATTEMPT}"
        log "permanent host contention marker dominates all terminal and deadline state; refusing ${RUN_OUT}"
        exit 80
    fi
    if path_exists "${HOST_GUARD_ARMED_MARKER}" && [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" != "1" ]]; then
        promote_armed_to_quarantine "stale-armed-sentinel" "70" \
            "monitor continuity cannot be proved after a prior supervisor stopped while armed"
        exit 80
    fi
}

valid_healthy_assessment() {
    local assessment="$1"
    local pattern='^\{"schemaVersion":1,"ok":true,"reasons":\[\],"minimumIdleCpus":([0-9]+),"cpuCount":([0-9]+),"idleCpus":([0-9]+([.][0-9]+)?),"blockers":\[\]\}$'
    [[ "${assessment}" =~ ${pattern} ]] || return 1
    local minimum="${BASH_REMATCH[1]}"
    local cpu_count="${BASH_REMATCH[2]}"
    local idle_cpus="${BASH_REMATCH[3]}"
    local idle_whole="${idle_cpus%%.*}"
    ((minimum == HOST_GUARD_MIN_IDLE_CPUS && cpu_count >= minimum && idle_whole >= minimum))
}

valid_recoverable_config_error() {
    local assessment="$1"
    local pattern='^\{"schemaVersion":1,"ok":false,"kind":"configuration-error","error":"Error: minimumIdleCpus ([0-9]+) exceeds detected CPU count ([0-9]+)"\}$'
    [[ "${assessment}" =~ ${pattern} ]] || return 1
    local requested="${BASH_REMATCH[1]}"
    local detected="${BASH_REMATCH[2]}"
    ((requested == HOST_GUARD_MIN_IDLE_CPUS && detected > 0 && detected < requested))
}

host_guard_check() {
    local phase="$1"
    local reset_baseline="$2"
    [[ "${HOST_GUARD}" == "1" ]] || return 0
    if ! assert_armed_marker "${phase}"; then
        if [[ "${STOP_IN_PROGRESS}" == "1" ]]; then
            return 80
        fi
        if [[ -n "${CHILD_PID}" ]]; then
            stop_child "required host guard sentinel was lost"
        fi
        exit 80
    fi

    local args=(
        "${HOST_GUARD_HELPER}"
        "--min-idle-cpus=${HOST_GUARD_MIN_IDLE_CPUS}"
        "--sample-ms=${HOST_GUARD_SAMPLE_MS}"
        "--cpu-baseline=${HOST_GUARD_CPU_BASELINE}"
        "--reset-baseline=${reset_baseline}"
        "--exclude-pid=$$"
    )
    if [[ -n "${CHILD_PID}" ]] && kill -0 -- "-${CHILD_PID}" 2>/dev/null; then
        args+=("--exclude-pgid=${CHILD_PID}")
    fi
    if [[ -n "${HOST_GUARD_FIXTURE}" ]]; then
        args+=("--fixture=${HOST_GUARD_FIXTURE}")
    fi

    local assessment
    local helper_status
    PROBE_IN_FLIGHT=1
    PROBE_OUTPUT="${RUN_OUT}/.host_guard_probe.$$.log"
    rm -f -- "${PROBE_OUTPUT}"
    DEFERRED_SIGNAL=""
    trap 'defer_signal TERM' TERM
    trap 'defer_signal INT' INT
    setsid bun "${args[@]}" >"${PROBE_OUTPUT}" 2>&1 9>&- &
    PROBE_PID=$!
    install_signal_handlers
    if [[ -n "${DEFERRED_SIGNAL}" ]]; then
        if [[ "${DEFERRED_SIGNAL}" == "TERM" ]]; then
            handle_signal TERM 143
        else
            handle_signal INT 130
        fi
    fi

    local timeout_seconds=$(((HOST_GUARD_SAMPLE_MS + 999) / 1000 + 10))
    local timeout_ticks=$((timeout_seconds * 10))
    local waited_ticks=0
    while kill -0 "${PROBE_PID}" 2>/dev/null && ((waited_ticks < timeout_ticks)); do
        sleep 0.1
        waited_ticks=$((waited_ticks + 1))
    done
    if kill -0 "${PROBE_PID}" 2>/dev/null; then
        stop_probe
        helper_status=124
        assessment="host guard helper exceeded ${timeout_seconds}s watchdog"
    else
        if wait "${PROBE_PID}"; then
            helper_status=0
        else
            helper_status=$?
        fi
        PROBE_PID=""
        assessment="$(<"${PROBE_OUTPUT}")"
    fi
    rm -f -- "${PROBE_OUTPUT}"
    PROBE_OUTPUT=""
    LAST_HOST_GUARD_EPOCH="$(date +%s)"

    if ((helper_status == 0)) && ! valid_healthy_assessment "${assessment}"; then
        helper_status=70
        assessment="invalid success response from host guard helper: $(sanitize_marker_detail "${assessment}")"
    fi
    if ((helper_status == 0)) && ! assert_armed_marker "post-${phase}"; then
        if [[ "${STOP_IN_PROGRESS}" == "1" ]]; then
            return 80
        fi
        if [[ -n "${CHILD_PID}" ]]; then
            stop_child "required host guard sentinel was lost during assessment"
        fi
        exit 80
    fi

    if ((helper_status == 0)); then
        if [[ "${phase}" == "preflight" && "${HOST_GUARD_CONFIG_PENDING}" == "1" ]]; then
            if ! atomic_write "${HOST_GUARD_CONFIG_FILE}" "${HOST_GUARD_EXPECTED_CONFIG}" || \
                ! host_guard_config_owned; then
                promote_armed_to_quarantine "host-guard-config-persist-failed" "70" \
                    "immutable host guard configuration was not atomically persisted and verified"
                exit 80
            fi
            HOST_GUARD_CONFIG_PENDING=0
        fi
        PROBE_IN_FLIGHT=0
        log "host guard healthy phase=${phase}: $(sanitize_marker_detail "${assessment}")"
        return 0
    fi
    if [[ "${phase}" == "preflight" && "${helper_status}" == "64" && -z "${CHILD_PID}" ]] && \
        valid_recoverable_config_error "${assessment}"; then
        if ! assert_armed_marker "post-preflight-config-error"; then
            exit 80
        fi
        CONTROLLED_DISARM=1
        if ! disarm_after_verified_stop ""; then
            exit 80
        fi
        PROBE_IN_FLIGHT=0
        if [[ "${HOST_GUARD_CONFIG_PENDING}" == "1" ]]; then
            rm -f -- "${START_EPOCH_FILE}" "${DEADLINE_EPOCH_FILE}" "${HOST_GUARD_CPU_BASELINE}"
        fi
        write_heartbeat "host-guard-preflight-rejected" "${CURRENT_ATTEMPT}"
        log "host guard preflight configuration rejected: $(sanitize_marker_detail "${assessment}")"
        exit 64
    fi

    promote_armed_to_quarantine "${phase}" "${helper_status}" "${assessment}"
    PROBE_IN_FLIGHT=0
    if [[ "${STOP_IN_PROGRESS}" == "1" ]]; then
        return 80
    fi
    if [[ -n "${CHILD_PID}" ]]; then
        stop_child "permanent host contention quarantine"
    fi
    exit 80
}

host_guard_check_if_due() {
    local phase="$1"
    [[ "${HOST_GUARD}" == "1" ]] || return 0
    local now
    now="$(date +%s)"
    ((now - LAST_HOST_GUARD_EPOCH >= HOST_GUARD_CHECK_SECONDS)) || return 0
    host_guard_check "${phase}" "0"
}

stop_child() {
    local reason="$1"
    [[ -n "${CHILD_PID}" ]] || return 0
    local child_pgid="${CHILD_PID}"
    local guard_failed=0
    STOP_IN_PROGRESS=1
    if [[ "${HOST_GUARD}" == "1" && "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]]; then
        if ! host_guard_check "optimizer-pre-stop-assessment" "0"; then
            guard_failed=1
        fi
    fi
    if kill -0 -- "-${child_pgid}" 2>/dev/null; then
        log "stopping optimizer pid=${child_pgid}: ${reason}"
        kill -TERM -- "-${child_pgid}" 2>/dev/null || true
        local waited=0
        while kill -0 -- "-${child_pgid}" 2>/dev/null && ((waited < STOP_GRACE_SECONDS)); do
            sleep 1
            waited=$((waited + 1))
            if [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] && \
                ! host_guard_check_if_due "optimizer-stop"; then
                guard_failed=1
                break
            fi
        done
        if kill -0 -- "-${child_pgid}" 2>/dev/null; then
            log "optimizer ignored TERM for ${STOP_GRACE_SECONDS}s; sending KILL"
            kill -KILL -- "-${child_pgid}" 2>/dev/null || true
            waited=0
            while kill -0 -- "-${child_pgid}" 2>/dev/null && ((waited < STOP_GRACE_SECONDS)); do
                sleep 1
                waited=$((waited + 1))
                if [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] && \
                    ! host_guard_check_if_due "optimizer-kill-wait"; then
                    guard_failed=1
                fi
            done
        fi
    fi
    wait "${CHILD_PID}" 2>/dev/null || true
    CHILD_PID=""
    rm -f -- "${OPTIMIZER_PID_FILE}"
    if ((guard_failed == 0)) && [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]]; then
        if ! host_guard_check "optimizer-stop-final-assessment" "0"; then
            guard_failed=1
        fi
    fi
    if ! disarm_after_verified_stop "${child_pgid}"; then
        guard_failed=1
    fi
    STOP_IN_PROGRESS=0
    ((guard_failed == 0)) || return 80
}

cleanup() {
    local status=$?
    trap - EXIT TERM INT
    set +e
    if [[ "${CONTROLLED_DISARM}" != "1" ]] && \
        { [[ "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]] || path_exists "${HOST_GUARD_ARMED_MARKER}"; }; then
        promote_armed_to_quarantine "uncontrolled-supervisor-exit" "${status}" \
            "supervisor exited outside a verified terminal, deadline, signal, or child-exit path"
    fi
    stop_probe
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
    trap - TERM INT
    STOP_REASON="signal-${signal_name}"
    log "received ${signal_name}; stopping without creating an optimizer terminal marker"
    if [[ "${HOST_GUARD}" == "1" && "${HOST_GUARD_ARMED_BY_THIS_PROCESS}" == "1" ]]; then
        if [[ "${PROBE_IN_FLIGHT}" == "1" ]]; then
            promote_armed_to_quarantine "signal-during-host-probe" "70" \
                "received ${signal_name} while host assessment completion was unknown"
            stop_probe
        else
            host_guard_check "signal-final-assessment" "0"
            CONTROLLED_DISARM=1
        fi
    fi
    write_heartbeat "stopping-${signal_name}" "0"
    if [[ -n "${CHILD_PID}" ]]; then
        stop_child "supervisor received ${signal_name}"
    elif [[ "${CONTROLLED_DISARM}" == "1" ]]; then
        if ! disarm_after_verified_stop ""; then
            exit 80
        fi
    fi
    exit "${status}"
}

trap cleanup EXIT
install_signal_handlers

mark_deadline() {
    [[ -f "${DEADLINE_MARKER}" ]] || atomic_write "${DEADLINE_MARKER}" \
        "time=$(iso_now) deadline=${DEADLINE_EPOCH} reason=wall-clock-deadline"
    STOP_REASON="deadline"
    write_heartbeat "deadline" "0"
}

terminal_or_deadline() {
    refuse_if_quarantined
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
    local sleep_seconds
    CURRENT_ATTEMPT="${attempt}"
    if [[ "${HOST_GUARD}" == "1" ]]; then
        write_armed_marker "${attempt}"
        host_guard_check "preflight" "1"
        if terminal_or_deadline; then
            CONTROLLED_DISARM=1
            if ! disarm_after_verified_stop ""; then
                exit 80
            fi
            return 0
        fi
        if ((HOST_GUARD_TEST_PRESPAWN_SECONDS > 0)); then
            sleep "${HOST_GUARD_TEST_PRESPAWN_SECONDS}"
        fi
        if ! assert_armed_marker "optimizer-spawn"; then
            exit 80
        fi
        if ! host_guard_config_owned; then
            promote_armed_to_quarantine "host-guard-config-missing-before-spawn" "70" \
                "immutable host guard configuration disappeared or changed after preflight"
            exit 80
        fi
    fi
    printf '\n[%s] attempt=%s command=nice -n %s bun %s --out=%s\n' \
        "$(iso_now)" "${attempt}" "${NICE_LEVEL}" "${OPTIMIZER}" "${RUN_OUT}" >>"${OPTIMIZER_LOG}"
    DEFERRED_SIGNAL=""
    trap 'defer_signal TERM' TERM
    trap 'defer_signal INT' INT
    if ((${#optimizer_args[@]} > 0)); then
        setsid nice -n "${NICE_LEVEL}" bun "${OPTIMIZER}" "--out=${RUN_OUT}" \
            "${optimizer_args[@]}" >>"${OPTIMIZER_LOG}" 2>&1 9>&- &
    else
        setsid nice -n "${NICE_LEVEL}" bun "${OPTIMIZER}" "--out=${RUN_OUT}" \
            >>"${OPTIMIZER_LOG}" 2>&1 9>&- &
    fi
    CHILD_PID=$!
    install_signal_handlers
    if [[ -n "${DEFERRED_SIGNAL}" ]]; then
        if [[ "${DEFERRED_SIGNAL}" == "TERM" ]]; then
            handle_signal TERM 143
        else
            handle_signal INT 130
        fi
    fi
    atomic_write "${OPTIMIZER_PID_FILE}" "${CHILD_PID}"
    log "optimizer attempt=${attempt} pid=${CHILD_PID}"

    while kill -0 "${CHILD_PID}" 2>/dev/null; do
        host_guard_check_if_due "ongoing"
        if terminal_or_deadline; then
            CONTROLLED_DISARM=1
            stop_child "${STOP_REASON}"
            return 0
        fi
        write_heartbeat "running" "${attempt}"
        sleep_seconds="${HEARTBEAT_SECONDS}"
        if [[ "${HOST_GUARD}" == "1" ]] && ((HOST_GUARD_CHECK_SECONDS < sleep_seconds)); then
            sleep_seconds="${HOST_GUARD_CHECK_SECONDS}"
        fi
        sleep "${sleep_seconds}"
    done

    local status
    if wait "${CHILD_PID}"; then
        status=0
    else
        status=$?
    fi
    if [[ "${HOST_GUARD}" == "1" ]]; then
        host_guard_check "optimizer-exit-final-assessment" "0"
        CONTROLLED_DISARM=1
    fi
    stop_child "optimizer leader exited; verifying its complete process group"
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
