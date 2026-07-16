#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly RUNNER="${SCRIPT_DIR}/run_v0_7_aligned_96h_v2.sh"
readonly SUPERVISOR="${SCRIPT_DIR}/../src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor.ts"

fail() {
    printf 'v0_7_aligned_96h_v2_keepalive.sh: %s\n' "$*" >&2
    exit 64
}

(($# > 0)) || fail "pass the exact aligned-v2 supervisor arguments"

output=""
definition=""
for argument in "$@"; do
    case "${argument}" in
        --out=*)
            [[ -z "${output}" ]] || fail "--out may only be specified once"
            output="${argument#--out=}"
            ;;
        --definition=*)
            [[ -z "${definition}" ]] || fail "--definition may only be specified once"
            definition="${argument#--definition=}"
            ;;
        --) break ;;
    esac
done
[[ "${output}" == /* ]] || fail "--out must be an absolute path"
[[ -n "${definition}" ]] || fail "--definition=<prepared-definition> is required"

run_parent="$(dirname -- "${output}")"
run_name="$(basename -- "${output}")"
[[ -d "${run_parent}" && "${run_name}" != "." && "${run_name}" != ".." ]] || fail "output parent is invalid"
RUN_OUT="$(realpath -- "${run_parent}")/${run_name}"
if [[ -e "${RUN_OUT}" ]]; then
    RUN_OUT="$(realpath -- "${RUN_OUT}")"
fi
readonly RUN_OUT

if [[ ! -e "${RUN_OUT}/supervisor-run.json" ]]; then
    if bun "${SUPERVISOR}" --inspect-launch-window="${definition}"; then
        :
    else
        status=$?
        if ((status == 78)); then
            printf 'v0_7_aligned_96h_v2_keepalive.sh: immutable initial launch window is closed\n'
            exit 0
        fi
        exit "${status}"
    fi
fi

if "${RUNNER}" "$@"; then
    exit 0
else
    status=$?
fi

case "${status}" in
    75)
        printf 'v0_7_aligned_96h_v2_keepalive.sh: supervisor is active or stale ownership is still cleaning up\n'
        exit 0
        ;;
    78|80)
        printf 'v0_7_aligned_96h_v2_keepalive.sh: supervisor reached a validated permanent refusal state (status %s)\n' "${status}"
        exit 0
        ;;
    *) exit "${status}" ;;
esac
