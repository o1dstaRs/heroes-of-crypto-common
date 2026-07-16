#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly REPO_ROOT
readonly SUPERVISOR="${REPO_ROOT}/src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor.ts"

fail() {
    printf 'run_v0_7_aligned_96h_v2.sh: %s\n' "$*" >&2
    exit 64
}

for dependency in bun flock nice realpath setsid; do
    command -v "${dependency}" >/dev/null 2>&1 || fail "required command is unavailable: ${dependency}"
done

(($# > 0)) || fail "pass --out=<unique-output-directory> and the supervisor arguments"

output=""
for argument in "$@"; do
    case "${argument}" in
        --out=*) output="${argument#--out=}"; break ;;
        --) break ;;
    esac
done
[[ -n "${output}" ]] || fail "--out=<unique-output-directory> is required"

if [[ "${output}" != /* ]]; then
    output="${REPO_ROOT}/${output}"
fi
RUN_OUT="$(realpath -m -- "${output}")"
readonly RUN_OUT
[[ "${RUN_OUT}" != / && "${RUN_OUT}" != "${REPO_ROOT}" ]] || fail "refusing unsafe output path: ${RUN_OUT}"
mkdir -p -- "${RUN_OUT}"

readonly HOST_LOCK="${V07_ALIGNED_V2_HOST_LOCK:-${TMPDIR:-/tmp}/heroes-of-crypto-v0_7-aligned-v2-host.lock}"
[[ "${HOST_LOCK}" == /* ]] || fail "V07_ALIGNED_V2_HOST_LOCK must be absolute"
exec 8>"${HOST_LOCK}"
flock -n 8 || {
    printf 'run_v0_7_aligned_96h_v2.sh: another aligned-v2 host supervisor owns %s\n' "${HOST_LOCK}" >&2
    exit 75
}

exec 9>"${RUN_OUT}/supervisor.lock"
flock -n 9 || {
    printf 'run_v0_7_aligned_96h_v2.sh: output is already supervised: %s\n' "${RUN_OUT}" >&2
    exit 75
}

exec bun "${SUPERVISOR}" "$@"
