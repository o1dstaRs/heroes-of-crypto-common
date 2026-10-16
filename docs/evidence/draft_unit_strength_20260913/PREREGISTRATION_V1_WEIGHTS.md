# Unit-strength draft, higher weights — preregistration

Written 2026-09-14 ~06:40 UTC, before any game of these policies was played. Owner goal: "Continue driving it into
80%+ area overnight" — the shipped draft `ranked-unit-strength-a19-side-v1-w4` beat the previous live draft
`ranked-versatile-a19-v3` 78.47% [76.62, 80.22] on confirmation seed 97300001.

## Motivation

v1 weight selection (seed 97200001, 2000 games each vs the previous live draft) rose steeply with weight: w1 57.7%,
w2 63.2%, w4 80.2% draw-aware. Weights above 4 were never tried. Same prior (`ranked_unit_strength_a19_side_v1.json`),
same overlay: a pick's normalized draft score gains weight x conservative lift pp / 100.

## Candidates

`ranked-unit-strength-a19-side-v1-w6`, `-w8`, `-w12`; control `-w4` (the shipped default).

## Stage 1 — selection (seed 98700001)

w4, w6, w8 and w12 each vs the previous live draft (`--pool live`), 500 offer boards (2000 games) each, live-fidelity
conditions (live draft rules, live setup `v07-nonfight-4eda84635fe7` both seats, side board, deterministic a19, live
map rotation), exactly as the v1 selection.

Rule: take the weight with the highest draw-aware score; a tie within 0.5pp goes to the smaller weight. If the chosen
weight is w4, round 1 ends here with no confirmation (no higher weight beats the shipped one by 0.5pp).

## Stage 2 — confirmation of the chosen weight W (only if W > 4)

1. **Head-to-head vs the shipped draft:** W vs `policy:ranked-unit-strength-a19-side-v1-w4`, seed 98710001, 2000
   boards (8000 games).
2. **Headline vs the previous live draft:** W vs `--pool live`, seed 98720001, 2000 boards (8000 games).
3. **Robustness:** W and v1-w4 each vs `--pool reference` (untrained heuristic + League round-3 exploiter), seed
   98730001, 500 boards per reference (2000 games each).

## Gates (all on the shipped draft v1-w4 as incumbent)

1. Draw-aware head-to-head (stage 2.1) > 0.50.
2. Board-clustered 95% lower bound of the decisive win rate (stage 2.1) > 0.50.
3. Candidate engine rejections = 0 (stage 2.1).
4. No live map with decisive win rate below 0.49 (stage 2.1).
5. Robustness: against each reference, W's decisive win rate >= v1-w4's minus 2pp (stage 2.3).
6. Diversity (stage 2.1 drafts): distinct creatures >= 80% of v1-w4's; top creature share <= v1-w4's + 10pp.

Reported, not gated: stage 2.2 decisive win rate vs the previous live draft with its interval (the "80%+" question),
per map. PASS on all six gates makes W the proposed next default; the owner decides the ship. FAIL is reported as a
fail, no re-roll of any seed above.
