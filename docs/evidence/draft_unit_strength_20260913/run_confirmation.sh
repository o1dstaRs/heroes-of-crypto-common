#!/bin/bash
# Confirmation + robustness (PREREGISTRATION.md). Usage: run_confirmation.sh <selected policy id>
# 1. selected candidate vs live incumbent, seed 97300001, 2000 boards (8000 games) — gates 1-4 and 6;
# 2. robustness: candidate and live incumbent each vs the reference pool on seed 97400001, 500 boards per
#    reference (2000 games each) — gate 5.
set -u
POLICY="${1:?usage: run_confirmation.sh <policy>}"
COMMON="${COMMON:-$HOME/Workplace/hoc-common-draft-eval}"
OUT="$HOME/Workplace/hoc-draft-strength"
COMMON_FLAGS=(--concurrency 14 --fight-profile a19 --candidate-setup v07-nonfight-4eda84635fe7
  --opponent-setup v07-nonfight-4eda84635fe7 --live-draft-rules true --side-board true
  --deterministic-search true --record-armies true)
cd "$COMMON" || exit 2
run() { # name, args...
  local name="$1"; shift
  echo "=== $name start $(date +%T)" >> "$OUT/confirmation.log"
  bun src/simulation/ranked_draft_eval.ts "$@" "${COMMON_FLAGS[@]}" \
    --records "$OUT/$name.jsonl" --output "$OUT/$name.json" > /dev/null 2>> "$OUT/confirmation.log"
  echo "=== $name done $(date +%T) exit=$?" >> "$OUT/confirmation.log"
}
run confirm_vs_live --candidate "$POLICY" --pool live --games 8000 --seed 97300001
run robust_candidate_vs_reference --candidate "$POLICY" --pool reference --games 2000 --seed 97400001
run robust_incumbent_vs_reference --candidate ranked-versatile-a19-v3 --pool reference --games 2000 --seed 97400001
echo "=== CONFIRMATION DONE $(date +%T)" >> "$OUT/confirmation.log"
