#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

supervisor_heartbeat=""
deadline_epoch=""
watchdog_seconds=""
stop_grace_seconds=""
owner_token=""
while (($# > 0)); do
    case "$1" in
        --supervisor-heartbeat=*) supervisor_heartbeat="${1#--supervisor-heartbeat=}" ;;
        --deadline-epoch=*) deadline_epoch="${1#--deadline-epoch=}" ;;
        --watchdog-seconds=*) watchdog_seconds="${1#--watchdog-seconds=}" ;;
        --stop-grace-seconds=*) stop_grace_seconds="${1#--stop-grace-seconds=}" ;;
        --owner-token=*) owner_token="${1#--owner-token=}" ;;
        --) shift; break ;;
        *) printf 'v0_7_aligned_96h_v2_child_guard.sh: invalid guard argument: %s\n' "$1" >&2; exit 64 ;;
    esac
    shift
done
[[ "${supervisor_heartbeat}" == /* && -n "${deadline_epoch}" && -n "${watchdog_seconds}" && \
    -n "${stop_grace_seconds}" && -n "${owner_token}" ]] || {
    printf 'v0_7_aligned_96h_v2_child_guard.sh: heartbeat, deadline, watchdog, stop grace, and owner are required\n' >&2
    exit 64
}
[[ "${deadline_epoch}" =~ ^[0-9]+$ && "${watchdog_seconds}" =~ ^[0-9]+$ && \
    "${stop_grace_seconds}" =~ ^[0-9]+$ && \
    "${owner_token}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
    printf 'v0_7_aligned_96h_v2_child_guard.sh: lifecycle bounds or owner token are invalid\n' >&2
    exit 64
}
((deadline_epoch > 0 && watchdog_seconds > 0 && stop_grace_seconds > 0 && $# > 0)) || {
    printf 'v0_7_aligned_96h_v2_child_guard.sh: invalid lifecycle bounds or missing optimizer command\n' >&2
    exit 64
}
[[ -r /proc/self/stat ]] || {
    printf 'v0_7_aligned_96h_v2_child_guard.sh: Linux /proc process identity is required\n' >&2
    exit 64
}

optimizer_pid=""
pipe_watch_pid=""
activated=0

group_has_other_members() {
    local member
    local member_pid
    local member_pgid
    local member_state
    local process_stat
    for process_stat in /proc/[0-9]*/stat; do
        if ! IFS= read -r member 2>/dev/null < "${process_stat}"; then
            [[ -e "${process_stat}" ]] && return 0
            continue
        fi
        member="${member##*) }"
        [[ -n "${member}" ]] || return 0
        IFS=' ' read -r member_state _ member_pgid _ <<< "${member}"
        member_pid="${process_stat#/proc/}"
        member_pid="${member_pid%/stat}"
        [[ "${member_pgid}" != "$$" || "${member_pid}" == "$$" || "${member_state}" == Z* ]] || return 0
    done
    return 1
}

terminate_group() {
    trap '' TERM INT HUP
    kill -TERM -- "-$$" 2>/dev/null || true
    for ((elapsed = 0; elapsed < stop_grace_seconds; elapsed += 1)); do
        group_has_other_members || return 0
        sleep 1
    done
    if group_has_other_members; then
        kill -KILL -- "-$$" 2>/dev/null || true
        sleep 1
    fi
}

# shellcheck disable=SC2329 # Invoked indirectly by the traps below.
stop_group() {
    local status=$?
    trap - EXIT TERM INT HUP USR1
    if [[ -n "${pipe_watch_pid}" ]]; then
        kill -TERM "${pipe_watch_pid}" 2>/dev/null || true
        wait "${pipe_watch_pid}" 2>/dev/null || true
        pipe_watch_pid=""
    fi
    exec 3<&- || true
    if ((activated)); then
        terminate_group
        [[ -z "${optimizer_pid}" ]] || wait "${optimizer_pid}" 2>/dev/null || true
    fi
    exit "${status}"
}

# shellcheck disable=SC2329 # Invoked indirectly by the USR1 trap below.
pipe_closed() {
    trap - USR1
    printf 'v0_7_aligned_96h_v2_child_guard.sh: supervisor pipe closed; terminating optimizer\n' >&2
    exit 97
}

trap stop_group EXIT TERM INT HUP
trap pipe_closed USR1

heartbeat_epoch() {
    stat -c '%Y' -- "${supervisor_heartbeat}" 2>/dev/null || stat -f '%m' -- "${supervisor_heartbeat}" 2>/dev/null
}

job_is_running() {
    local running_pid
    while IFS= read -r running_pid; do
        [[ "${running_pid}" == "$1" ]] && return 0
    done < <(jobs -pr)
    return 1
}

activation=""
exec 3<&0
if ! IFS= read -r -t "${watchdog_seconds}" -u 3 activation || \
    [[ "${activation}" != "activate:${owner_token}" ]]; then
    printf 'v0_7_aligned_96h_v2_child_guard.sh: activation channel closed or mismatched\n' >&2
    exit 97
fi
activated=1
"$@" &
optimizer_pid=$!

# The supervisor intentionally keeps this pipe open without writing. EOF proves
# that it disappeared, including SIGKILL, and forces optimizer cleanup.
(
    while IFS= read -r -u 3 _; do :; done
    kill -USR1 "$$"
) &
pipe_watch_pid=$!

while job_is_running "${optimizer_pid}"; do
    now_epoch="$(date +%s)"
    if ((now_epoch >= deadline_epoch)); then
        printf 'v0_7_aligned_96h_v2_child_guard.sh: immutable deadline reached\n' >&2
        exit 120
    fi
    if ! last_heartbeat_epoch="$(heartbeat_epoch)" || [[ ! "${last_heartbeat_epoch}" =~ ^[0-9]+$ ]] || \
        ((now_epoch - last_heartbeat_epoch > watchdog_seconds)); then
        printf 'v0_7_aligned_96h_v2_child_guard.sh: supervisor heartbeat watchdog expired\n' >&2
        exit 121
    fi
    sleep 1
done

if wait "${optimizer_pid}"; then
    optimizer_status=0
else
    optimizer_status=$?
fi
kill -TERM "${pipe_watch_pid}" 2>/dev/null || true
wait "${pipe_watch_pid}" 2>/dev/null || true
pipe_watch_pid=""
exec 3<&-
terminate_group
optimizer_pid=""
trap - EXIT TERM INT HUP USR1
exit "${optimizer_status}"
