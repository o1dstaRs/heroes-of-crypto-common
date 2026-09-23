# Preregistration — shooter floor 5 (…-v1-w4-r5) vs the shipped r4: the last rung of the floor lever

Written 2026-09-22 ~09:45Z before any deciding game. Base: common c3bdc78 (r4 shipped) + the r5/r6 ids.

## Why, and why this is the last rung
Draft-only measurement on live rules (1500 boards): r3 2.12 shooters, r4 2.88, **r5 3.14, r6 3.15** — floors 5 and 6
are indistinguishable because the offers simply stop containing shooters, so the lever saturates here. The optimum is
bracketed: r4 (2.88) beats r3 (2.12) 57.1% AND beats the untrained heuristic stack (4.21) 52.8%, so the best
composition lies between, and r5 is the only untested point inside the bracket. r6 will not be run.

## Change (common)
`…-v1-w4-r5` (floor 5) and `…-v1-w4-r6` (floor 6) registered at weight 4. Only r5 is measured.

## Design (unchanged protocol; incumbent = policy:ranked-unit-strength-a19-side-v1-w4-r4)
- Selection r5 vs r4, 2000 games, seed 99410001. Continue only if draw-aware > 0.505.
- Confirmation r5 vs r4, 8000 games, seed 99420001; robustness r5 and r4 vs pool `reference`, seed 99430001.
Gates identical to the r3/r4 preregistrations (all eight). Seeds are never re-rolled.
A selection below the bar closes the composition lever: r4 stays the default and the program reports the draft
optimum as bracketed at ~2.9 shooters.

## RESULT — selection r5 vs r4 (seed 99410001, 2000 games): decisive 51.89% [47.51, 56.24], draw-aware 51.88%,
LCB 47.51, 0 rejections; maps 51.8 / 51.8 / 52.1. Above the 50.5% continue-bar but the interval spans 50, so this is
a weak signal consistent with the saturation the draft distributions predicted (2.88 -> 3.14 shooters). Confirmation
99420001 (8000 games) + both robustness cells 99430001 started 16:20:48Z; the confirmation decides it.

## RESULT — confirmation r5 vs r4 (seed 99420001, 8000 games): decisive 52.05% [49.86, 54.23], draw-aware 52.03%,
LCB 49.86, 0 rejections; maps NORMAL 51.67 (LCB 47.88) / LAVA 52.91 (49.11) / BLOCK 51.57 (47.78); diversity 51 vs 51
distinct, top share identical at 37.4%.
**Gate 1 PASS, gate 2 FAIL (LCB 49.86 not > 50), gate 4 PASS.** Floor 5 is NOT proven better than the shipped floor 4.

## FINAL DISPOSITION — the composition lever is CLOSED at r4 (2026-09-22)
r4 stays the ranked default. The optimum is bracketed and the bracket is now tight:
- r3 (2.12 shooters) loses to r4 57.1% [54.9, 59.2] — proven worse.
- r5 (3.14) does not beat r4: 52.05% [49.86, 54.23] — not proven better, and floors 5 and 6 draft identically
  (3.14 vs 3.15 shooters) because the offers stop containing shooters, so no higher floor can differ materially.
- the untrained heuristic stack (4.21) loses to r4 52.8% — proven worse.
So the draft optimum sits at ~2.9 natively ranged creatures and r4 realises it. r5/r6 remain registered but unshipped
and should NOT be re-measured; a future re-fit of the unit-strength prior, not a higher floor, is the way past this.

## Robustness (seed 99430001, 2000 games each, informational once gate 2 failed): vs untrained-heuristic r5 52.52%
vs r4 50.43%; vs round-3 exploiter r5 86.48% vs r4 86.07%; 0 rejections. Gate 5 passes, but the formal verdict is
FAIL on gate 2 (results/P5/VERDICT.txt): 7 of 8 gates pass and the head-to-head lower bound does not clear 50.
Note for the record: r4's cell here re-measures 50.43% against the ranged stack on a fresh seed, versus 52.77% on
seed 99330001 — so "r4 beats the exploit stack" is a ~50-53% claim across seeds, not a large margin.
