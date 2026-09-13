#!/bin/bash
# Weight selection (PREREGISTRATION.md): each strength weight vs the live incumbent on seed 97200001,
# 500 offer boards (2000 games), same live-fidelity conditions as every other stage.
set -u
COMMON="${COMMON:-$HOME/Workplace/hoc-common-draft-eval}"
OUT="$HOME/Workplace/hoc-draft-strength"
cd "$COMMON" || exit 2
for W in w1 w2 w4; do
  POLICY="ranked-unit-strength-a19-side-v1-$W"
  echo "=== selection $POLICY start $(date +%T)" >> "$OUT/selection.log"
  bun src/simulation/ranked_draft_eval.ts \
    --candidate "$POLICY" --pool live --games 2000 --seed 97200001 --concurrency 14 \
    --fight-profile a19 --candidate-setup v07-nonfight-4eda84635fe7 --opponent-setup v07-nonfight-4eda84635fe7 \
    --live-draft-rules true --side-board true --deterministic-search true --record-armies true \
    --records "$OUT/selection_$W.jsonl" --output "$OUT/selection_$W.json" > /dev/null 2>> "$OUT/selection.log"
  echo "=== selection $POLICY done $(date +%T) exit=$?" >> "$OUT/selection.log"
done
echo "=== SELECTION DONE $(date +%T)" >> "$OUT/selection.log"
