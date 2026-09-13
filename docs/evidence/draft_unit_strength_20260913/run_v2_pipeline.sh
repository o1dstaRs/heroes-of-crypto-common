#!/bin/bash
# v2 pipeline (PREREGISTRATION_V2.md). Waits for the v1 verdict, sets the v2 incumbent by the preregistered rule,
# then runs weight selection, confirmation, robustness and the verdict. Runs from a frozen v2 eval worktree.
set -u
OUT="$HOME/Workplace/hoc-draft-strength"
COMMON="${COMMON:-$HOME/Workplace/hoc-common-draft-eval-v2}"
LOG="$OUT/v2.log"
FLAGS=(--concurrency 14 --fight-profile a19 --candidate-setup v07-nonfight-4eda84635fe7
  --opponent-setup v07-nonfight-4eda84635fe7 --live-draft-rules true --side-board true
  --deterministic-search true --record-armies true)

until grep -q "VERDICT WRITTEN" "$OUT/confirmation.log" 2>/dev/null; do sleep 60; done
if grep -q "^VERDICT: PASS" "$OUT/verdict.txt"; then
  V1_WEIGHT=$(awk '/^chosen/ {print $2}' "$OUT/selection_choice.txt")
  INCUMBENT_SPEC="ranked-unit-strength-a19-side-v1-$V1_WEIGHT"
  INCUMBENT_POOL="policy:$INCUMBENT_SPEC"
  INCUMBENT_ID="incumbent:$INCUMBENT_SPEC"
else
  INCUMBENT_SPEC="ranked-versatile-a19-v3"
  INCUMBENT_POOL="live"
  INCUMBENT_ID="ranked-live-incumbent"
fi
echo "=== v2 incumbent $INCUMBENT_POOL ($(date +%T))" >> "$LOG"
cd "$COMMON" || exit 2

run() { # name, args...
  local name="$1"; shift
  echo "=== $name start $(date +%T)" >> "$LOG"
  bun src/simulation/ranked_draft_eval.ts "$@" "${FLAGS[@]}" \
    --records "$OUT/$name.jsonl" --output "$OUT/$name.json" > /dev/null 2>> "$LOG"
  echo "=== $name done $(date +%T) exit=$?" >> "$LOG"
}

for W in w1 w2 w4; do
  run "v2_selection_$W" --candidate "ranked-unit-synergy-a19-side-v2-$W" --pool "$INCUMBENT_POOL" --games 2000 --seed 97500001
done
POLICY=$(python3 - "$INCUMBENT_ID" <<'PY'
import json, os, sys
out = os.path.expanduser("~/Workplace/hoc-draft-strength")
incumbent = sys.argv[1]
scores = []
for weight in ("w1", "w2", "w4"):
    report = json.load(open(f"{out}/v2_selection_{weight}.json"))
    head = next(entry for entry in report["opponents"] if entry["opponentId"] == incumbent)
    scores.append((weight, (head["wins"] + 0.5 * head["draws"]) / head["games"]))
best = max(score for _, score in scores)
chosen = next(weight for weight, score in scores if best - score <= 0.005)
with open(f"{out}/v2_selection_choice.txt", "w") as handle:
    for weight, score in scores:
        handle.write(f"{weight} draw-aware {score:.5f}\n")
    handle.write(f"chosen {chosen}\n")
print(f"ranked-unit-synergy-a19-side-v2-{chosen}")
PY
)
echo "=== v2 chose $POLICY $(date +%T)" >> "$LOG"
run v2_confirm_vs_incumbent --candidate "$POLICY" --pool "$INCUMBENT_POOL" --games 8000 --seed 97600001
run v2_robust_candidate_vs_reference --candidate "$POLICY" --pool reference --games 2000 --seed 97700001
run v2_robust_incumbent_vs_reference --candidate "$INCUMBENT_SPEC" --pool reference --games 2000 --seed 97700001
python3 "$OUT/verdict.py" v2_confirm_vs_incumbent v2_robust_candidate_vs_reference v2_robust_incumbent_vs_reference \
  "$INCUMBENT_ID" > "$OUT/v2_verdict.txt" 2>&1
echo "=== V2 VERDICT WRITTEN $(date +%T)" >> "$LOG"
