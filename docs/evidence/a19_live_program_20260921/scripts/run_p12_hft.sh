#!/usr/bin/env bash
# P12 (PREREGISTRATION_T1_TABLE.md): Tier-1 artifact arms on the current default drafts.
# Good-citizen wait: only starts once NO ranked evaluator has run for three consecutive minutes, so it cannot
# interleave with the parallel agent's P9/P10/P11 stages.
set -uo pipefail
C=/root/hoc-common-p12
O=/root/hoc-a19-live/results/P12
mkdir -p "$O"
D=ranked-unit-strength-a19-side-v4-w8-r4
FLAGS=(--candidate "$D" --pool "policy:$D" --candidate-setup conditional-v1 --opponent-setup conditional-v1
  --fight-profile a19 --live-draft-rules true --side-board true --deterministic-search true --record-armies true
  --games 2000 --seed 99830001 --concurrency 12)
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$O/p12.log"; }
idle=0
while [ "$idle" -lt 3 ]; do
  if pgrep -f "[r]anked_draft_(eval|shard|merge)|[e]dge_child.ts" > /dev/null; then idle=0; else idle=$((idle+1)); fi
  sleep 60
done
log "node idle; starting Tier-1 arms"
arm() { local name=$1; shift
  log "START $name"
  (cd "$C" && nice -n 5 bun src/simulation/ranked_draft_eval.ts "${FLAGS[@]}" "$@" \
      --records "$O/$name.jsonl" --output "$O/$name.json" > /dev/null 2>> "$O/$name.err")
  log "DONE  $name exit=$?"
}
arm control_no_override
arm arm10_hunters_longbow --candidate-t1 10
arm arm09_cursed_ward     --candidate-t1 9
arm arm13_mages_ring      --candidate-t1 13
arm arm06_winged_boots    --candidate-t1 6
log "P12 STAGE1 COMPLETE"
python3 - "$O" <<'PY' >> "$O/p12.log"
import json, glob, os, sys
out = sys.argv[1]
for f in sorted(glob.glob(f"{out}/*.json")):
    r = json.load(open(f)); o = r["opponents"][0]
    da = (o["wins"] + 0.5 * o["draws"]) / max(1, o["games"])
    print("ARM %-26s draw-aware %6.2f%%  decisive %6.2f%% CI [%6.2f,%6.2f]  n=%d" % (
        os.path.basename(f)[:-5], da * 100, o["decisiveWinRate"] * 100,
        o["confidence95"]["low"] * 100, o["confidence95"]["high"] * 100, o["games"]))
PY
