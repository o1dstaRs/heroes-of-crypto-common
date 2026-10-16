#!/usr/bin/env python3
"""P15 stage 1: score each arm game by game against BASE (same seed, boards, armies and battle seeds).
usage: p15_arms.py <dir with p15_<ARM>_s<k>.jsonl shards>"""
import json, sys, glob, math, collections, re
d = sys.argv[1]
prefixes = sys.argv[2].split(",") if len(sys.argv) > 2 else ["p15_"]
arms = collections.defaultdict(dict)
paths = [p for prefix in prefixes for p in glob.glob(f"{d}/{prefix}*_s*.jsonl")]
for path in paths:
    arm = re.match(r".*/p\d+_(.+)_s\d+\.jsonl$", path).group(1)
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            arms[arm][r["game"]] = r
score = lambda r: 1.0 if r["candidateResult"] == "win" else 0.5 if r["candidateResult"] == "draw" else 0.0
base = arms.get("BASE", {})
# Same policy on both seats: games 4b+2 / 4b+3 replay 4b / 4b+1 with the candidate label moved (see the prereg).
FLIP = {"win": "loss", "loss": "win", "draw": "draw"}
for g, r in list(base.items()):
    if g % 4 in (0, 1) and g + 2 not in base:
        m = dict(r)
        m["game"] = g + 2
        m["pickSeat"] = "candidate-upper"
        m["candidateSide"] = "red" if r["candidateSide"] == "green" else "green"
        m["candidateResult"] = FLIP[r["candidateResult"]]
        m["rejectedCandidate"], m["rejectedOpponent"] = r["rejectedOpponent"], r["rejectedCandidate"]
        if "armies" in r:
            m["armies"] = {"candidate": r["armies"]["opponent"], "opponent": r["armies"]["candidate"]}
        if "splitStacks" in r:
            m["splitStacks"] = {"candidate": r["splitStacks"]["opponent"], "opponent": r["splitStacks"]["candidate"]}
        m["mirroredFrom"] = g
        base[g + 2] = m
def summary(name, recs):
    n = len(recs); w = sum(r["candidateResult"] == "win" for r in recs); l = sum(r["candidateResult"] == "loss" for r in recs)
    rej = sum(r["rejectedCandidate"] + r["rejectedOpponent"] for r in recs)
    return f"{name}: {n} games {w}W {l}L {n-w-l}D decisive {100*w/max(1,w+l):.2f}% draw-aware {100*sum(map(score,recs))/max(1,n):.2f}% rejections {rej}"
for arm in sorted(arms):
    recs = list(arms[arm].values())
    print(summary(arm, recs))
    if arm == "BASE" or not base:
        continue
    games = sorted(g for g in arms[arm] if g in base)
    for g in games:
        a, b = arms[arm][g], base[g]
        assert a["pickSeed"] == b["pickSeed"] and a["battleSeed"] == b["battleSeed"], f"unpaired game {g}"
    boards = collections.defaultdict(list)
    for g in games:
        boards[g // 4].append(score(arms[arm][g]) - score(base[g]))
    diffs = [sum(v) / len(v) for v in boards.values()]
    m = sum(diffs) / len(diffs)
    sd = math.sqrt(sum((x - m) ** 2 for x in diffs) / (len(diffs) - 1)) if len(diffs) > 1 else 0
    se = sd / math.sqrt(len(diffs))
    changed = sum(1 for g in games if arms[arm][g]["candidateResult"] != base[g]["candidateResult"])
    print(f"   paired vs BASE over {len(games)} games ({len(diffs)} boards): {100*m:+.2f}pp  95% [{100*(m-1.96*se):+.2f}, {100*(m+1.96*se):+.2f}]  results changed in {changed} games")
