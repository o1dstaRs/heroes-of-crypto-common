#!/usr/bin/env python3
"""Apply the preregistered gates to a confirmation + robustness run.

Usage: verdict.py [confirm_name robust_candidate_name robust_incumbent_name incumbent_id]
Defaults are the v1 run (PREREGISTRATION.md): confirm_vs_live, robust_candidate_vs_reference,
robust_incumbent_vs_reference, ranked-live-incumbent.
"""
import json
import os
import sys
from collections import Counter

OUT = os.path.expanduser("~/Workplace/hoc-draft-strength")
CONFIRM, ROBUST_CANDIDATE, ROBUST_INCUMBENT, INCUMBENT_ID = (
    sys.argv[1:5]
    if len(sys.argv) >= 5
    else ["confirm_vs_live", "robust_candidate_vs_reference", "robust_incumbent_vs_reference", "ranked-live-incumbent"]
)


def load(name):
    with open(f"{OUT}/{name}.json") as handle:
        return json.load(handle)


def opponent(report, opponent_id):
    return next(entry for entry in report["opponents"] if entry["opponentId"] == opponent_id)


confirm = load(CONFIRM)
head = opponent(confirm, INCUMBENT_ID)
draw_aware = (head["wins"] + 0.5 * head["draws"]) / head["games"]
gates = [
    ("1 draw-aware head-to-head > 0.50", draw_aware, draw_aware > 0.50),
    ("2 clustered 95% LCB > 0.50", head["clusteredLowerBound"], head["clusteredLowerBound"] > 0.50),
    ("3 candidate rejections == 0", confirm["aggregate"]["rejectedCandidate"], confirm["aggregate"]["rejectedCandidate"] == 0),
]
worst_map = min(confirm["maps"], key=lambda entry: entry["decisiveWinRate"])
gates.append((f"4 worst map (grid {worst_map['mapType']}) >= 0.49", worst_map["decisiveWinRate"], worst_map["decisiveWinRate"] >= 0.49))

candidate_ref = load(ROBUST_CANDIDATE)
incumbent_ref = load(ROBUST_INCUMBENT)
for reference in ("untrained-heuristic", "league-round3-exploiter"):
    delta = opponent(candidate_ref, reference)["decisiveWinRate"] - opponent(incumbent_ref, reference)["decisiveWinRate"]
    gates.append((f"5 vs {reference}: candidate - incumbent >= -0.02", delta, delta >= -0.02))

with open(f"{OUT}/prior_ranked_unit_strength_a19_side_v1.json") as handle:
    faction = {entry["creatureId"]: entry["faction"] for entry in json.load(handle)["creatures"]}


def reaches_tier2(creature_ids):
    counts = Counter(faction.get(creature, 0) for creature in set(creature_ids))
    counts.pop(0, None)
    return any(count >= 4 for count in counts.values())


drafts = {}
with open(f"{OUT}/{CONFIRM}.jsonl") as handle:
    for line in handle:
        record = json.loads(line)
        drafts[(record["pairSeed"], record["pickSeat"])] = record["armies"]
candidate_counts = Counter(creature for armies in drafts.values() for creature in set(armies["candidate"]["creatureIds"]))
incumbent_counts = Counter(creature for armies in drafts.values() for creature in set(armies["opponent"]["creatureIds"]))
ratio = len(candidate_counts) / max(1, len(incumbent_counts))
gates.append(("6a distinct creatures >= 80% of incumbent", ratio, ratio >= 0.80))
candidate_top = max(candidate_counts.values()) / len(drafts)
incumbent_top = max(incumbent_counts.values()) / len(drafts)
gates.append(("6b top creature share <= incumbent + 10pp", candidate_top - incumbent_top, candidate_top <= incumbent_top + 0.10))

print(f"run: {CONFIRM} vs {INCUMBENT_ID}")
print(f"head-to-head: {head['wins']}W {head['losses']}L {head['draws']}D over {head['games']} games; "
      f"decisive {head['decisiveWinRate'] * 100:.2f}% CI [{head['confidence95']['low'] * 100:.2f}, {head['confidence95']['high'] * 100:.2f}]")
for entry in confirm["maps"]:
    print(f"  grid {entry['mapType']}: {entry['decisiveWinRate'] * 100:.2f}% (LCB {entry['clusteredLowerBound'] * 100:.2f})")
print(f"diversity: candidate {len(candidate_counts)} distinct, incumbent {len(incumbent_counts)}; "
      f"top share {candidate_top * 100:.1f}% vs {incumbent_top * 100:.1f}% over {len(drafts)} drafts")
tier2_candidate = sum(reaches_tier2(armies["candidate"]["creatureIds"]) for armies in drafts.values()) / len(drafts)
tier2_incumbent = sum(reaches_tier2(armies["opponent"]["creatureIds"]) for armies in drafts.values()) / len(drafts)
print(f"informational: tier-2 synergy reach candidate {tier2_candidate * 100:.1f}% vs incumbent {tier2_incumbent * 100:.1f}%")
for name, value, passed in gates:
    shown = f"{value:.4f}" if isinstance(value, float) else str(value)
    print(f"{'PASS' if passed else 'FAIL'}  {name}: {shown}")
print("VERDICT:", "PASS" if all(passed for _, _, passed in gates) else "FAIL")
