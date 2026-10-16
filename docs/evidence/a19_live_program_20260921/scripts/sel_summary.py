#!/usr/bin/env python3
"""Summarize selection arms: draw-aware head-to-head with a board-clustered 95% interval, per map, rejections, and
the draft mix (ranged count, top creatures). usage: sel_summary.py <dir> <prefix> (files <prefix><arm>_s<k>.jsonl)"""
import collections, glob, json, math, re, sys

d, prefix = sys.argv[1], sys.argv[2]
arms = collections.defaultdict(dict)
for path in glob.glob(f"{d}/{prefix}*_s*.jsonl"):
    arm = re.match(rf".*/{re.escape(prefix)}(.+)_s\d+\.jsonl$", path).group(1)
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            arms[arm][r["game"]] = r
score = lambda r: 1.0 if r["candidateResult"] == "win" else 0.5 if r["candidateResult"] == "draw" else 0.0
creatures = {}
try:
    creatures = {int(k): v for k, v in json.load(open(sys.argv[3])).items()} if len(sys.argv) > 3 else {}
except FileNotFoundError:
    pass
for arm in sorted(arms):
    recs = list(arms[arm].values())
    n = len(recs); w = sum(r["candidateResult"] == "win" for r in recs); l = sum(r["candidateResult"] == "loss" for r in recs)
    boards = collections.defaultdict(list)
    for r in recs:
        boards[r["offerBoard"]].append(score(r))
    means = [sum(v) / len(v) for v in boards.values()]
    m = sum(means) / len(means)
    se = math.sqrt(sum((x - m) ** 2 for x in means) / (len(means) - 1) / len(means)) if len(means) > 1 else 0
    maps = collections.defaultdict(lambda: [0, 0])
    for r in recs:
        maps[r["gridType"]][0] += score(r); maps[r["gridType"]][1] += 1
    rej = sum(r["rejectedCandidate"] + r["rejectedOpponent"] for r in recs)
    print(f"{arm}: {n} games {w}W {l}L {n - w - l}D  draw-aware {100 * sum(map(score, recs)) / n:.2f}%  "
          f"board-clustered 95% [{100 * (m - 1.96 * se):.2f}, {100 * (m + 1.96 * se):.2f}]  rejections {rej}  "
          + "  ".join(f"map{k} {100 * v[0] / v[1]:.1f}" for k, v in sorted(maps.items())))
    if creatures and all("armies" in r for r in recs):
        rc = collections.Counter(sum(1 for c in set(r["armies"]["candidate"]["creatureIds"]) if creatures[c]["ranged"])
                                 for r in recs if r["game"] % 2 == 0)
        top = collections.Counter(c for r in recs if r["game"] % 2 == 0 for c in set(r["armies"]["candidate"]["creatureIds"]))
        k = sum(rc.values())
        print(f"   candidate ranged count: {dict(sorted(rc.items()))}; top: "
              + ", ".join(f"{creatures[c]['name']} {100 * v / k:.0f}%" for c, v in top.most_common(8)))
names = sorted(arms)
for i, a in enumerate(names):
    for b in names[i + 1:]:
        common = sorted(set(arms[a]) & set(arms[b]))
        if not common:
            continue
        diff = collections.defaultdict(list)
        for g in common:
            diff[arms[a][g]["offerBoard"]].append(score(arms[a][g]) - score(arms[b][g]))
        means = [sum(v) / len(v) for v in diff.values()]
        m = sum(means) / len(means)
        se = math.sqrt(sum((x - m) ** 2 for x in means) / (len(means) - 1) / len(means)) if len(means) > 1 else 0
        print(f"paired {a} - {b} over {len(common)} games: {100 * m:+.2f}pp [{100 * (m - 1.96 * se):+.2f}, {100 * (m + 1.96 * se):+.2f}]")
