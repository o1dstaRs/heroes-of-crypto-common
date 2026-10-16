#!/bin/bash
# Waits for weight selection, applies the preregistered selection rule (highest draw-aware score vs the live
# incumbent; a tie within 0.5pp goes to the smaller weight), then runs confirmation + robustness once.
set -u
OUT="$HOME/Workplace/hoc-draft-strength"
until grep -q "SELECTION DONE" "$OUT/selection.log" 2>/dev/null; do sleep 30; done
POLICY=$(python3 - <<'PY'
import json, os
out = os.path.expanduser("~/Workplace/hoc-draft-strength")
scores = []
for weight in ("w1", "w2", "w4"):
    report = json.load(open(f"{out}/selection_{weight}.json"))
    head = report["opponents"][0]
    scores.append((weight, (head["wins"] + 0.5 * head["draws"]) / head["games"]))
best = max(score for _, score in scores)
# Smallest weight within 0.5pp of the best.
chosen = next(weight for weight, score in scores if best - score <= 0.005)
with open(f"{out}/selection_choice.txt", "w") as handle:
    for weight, score in scores:
        handle.write(f"{weight} draw-aware {score:.5f}\n")
    handle.write(f"chosen {chosen}\n")
print(f"ranked-unit-strength-a19-side-v1-{chosen}")
PY
)
echo "=== auto-confirm chose $POLICY $(date +%T)" >> "$OUT/confirmation.log"
COMMON="$HOME/Workplace/hoc-common-draft-eval" "$OUT/run_confirmation.sh" "$POLICY"
python3 "$OUT/verdict.py" > "$OUT/verdict.txt" 2>&1
echo "=== VERDICT WRITTEN $(date +%T)" >> "$OUT/confirmation.log"
