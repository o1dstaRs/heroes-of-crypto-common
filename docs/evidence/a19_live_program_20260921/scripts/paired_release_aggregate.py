#!/usr/bin/env python3
"""Paired release A/B verdict: treated army decisive win rate, treatment minus baseline, board-bootstrap CI.

usage: paired_release_aggregate.py <shard glob> [group field]
Rows: {board, mirror, arm: baseline|treatment, gridType, result: win|loss|draw, rejections, ...}.
"""
import collections
import glob
import json
import random
import sys

pattern = sys.argv[1]
group_field = sys.argv[2] if len(sys.argv) > 2 else None
def read_rows(pattern):
    """Complete JSON rows only: an interrupted worker can leave a half-written last line."""
    rows = []
    for path in sorted(glob.glob(pattern)):
        for line in open(path):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


rows = read_rows(pattern)
MAPS = {1: "NORMAL", 3: "LAVA", 4: "BLOCK"}

pairs = collections.defaultdict(dict)
for row in rows:
    pairs[(row["board"], row["mirror"])][row["arm"]] = row
complete = {key: value for key, value in pairs.items() if "baseline" in value and "treatment" in value}
print(f"rows {len(rows)}, game pairs {len(complete)}, boards {len({key[0] for key in complete})}")


def decisive(subset, arm):
    games = [pair[arm] for pair in subset if pair[arm]["result"] != "draw"]
    return sum(game["result"] == "win" for game in games) / max(1, len(games)), len(games)


def paired_delta(subset):
    return decisive(subset, "treatment")[0] - decisive(subset, "baseline")[0]


def report(label, keys, resamples=2000):
    subset = [complete[key] for key in keys]
    if not subset:
        return
    base, base_n = decisive(subset, "baseline")
    treat, treat_n = decisive(subset, "treatment")
    by_board = collections.defaultdict(list)
    for key in keys:
        by_board[key[0]].append(complete[key])
    boards = list(by_board)
    rng = random.Random(20260913)
    deltas = []
    for _ in range(resamples):
        sample = [pair for board in (rng.choice(boards) for _ in boards) for pair in by_board[board]]
        deltas.append(paired_delta(sample))
    deltas.sort()
    low, high = deltas[int(0.025 * resamples)], deltas[int(0.975 * resamples) - 1]
    changed = sum(pair["baseline"]["result"] != pair["treatment"]["result"] for pair in subset)
    print(
        f"{label:28s} pairs {len(subset):4d} | baseline {base * 100:5.2f}% (n={base_n}) -> treatment "
        f"{treat * 100:5.2f}% (n={treat_n}) | delta {(treat - base) * 100:+5.2f}pp "
        f"[{low * 100:+5.2f}, {high * 100:+5.2f}] | outcome changed {changed}"
    )


report("ALL", list(complete))
rejections = {
    arm: sum(pair[arm].get("rejections", 0) or 0 for pair in complete.values()) for arm in ("baseline", "treatment")
}
print(f"treated-army engine rejections: baseline {rejections['baseline']}, treatment {rejections['treatment']}")
for grid, name in MAPS.items():
    report(f"  map {name}", [key for key, pair in complete.items() if pair["baseline"]["gridType"] == grid])
if group_field:
    groups = collections.defaultdict(list)
    for key, pair in complete.items():
        value = pair["baseline"].get(group_field)
        groups[",".join(value) if isinstance(value, list) else str(value)].append(key)
    for value, keys in sorted(groups.items()):
        report(f"  {group_field}={value}", keys)
