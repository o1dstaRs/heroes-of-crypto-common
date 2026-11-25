#!/usr/bin/env bash
# Engine parity check: record fresh battles from the TypeScript engine, then
#   1. replay every recorded engine call in the Zig engine (engine only), and
#   2. play every battle natively in Zig (v0.1 AI + engine) from its start state,
# failing on the first step whose action, state, events, random stream or accept/reject result differs.
#
#   zig/parity/check.sh [games=200] [firstSeed=<random>]
#
# Run from the common package root. Needs bun and zig 0.15.
set -euo pipefail

cd "$(dirname "$0")/../.."
games="${1:-200}"
seed="${2:-$(( (RANDOM << 15 | RANDOM) + 1 ))}"
out="zig/parity/out/check-${seed}.jsonl"

(cd zig && zig build -Drelease=true)
echo "recording ${games} battles from seed ${seed}"
bun zig/parity/record.ts "${games}" "${seed}" "${out}" >/dev/null
zig/zig-out/bin/hoc-sim parity "${out}" --max-fail 5
zig/zig-out/bin/hoc-sim native "${out}" --max-fail 5
rm -f "${out}" "${out%.jsonl}.meta.json"
