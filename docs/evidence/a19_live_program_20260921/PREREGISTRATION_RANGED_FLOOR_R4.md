# Preregistration — ranked draft shooter floor 4 (ranked-unit-strength-a19-side-v1-w4-r4) vs the new default r3

Written 2026-09-22 ~02:20Z before any deciding game. Base: common 832f8fc (r2/r3 shipped) + the r4 id.

## Why
r2 -> r3 gained +8.4pp against v1-w4 (58.9% -> 67.3% in selection); the untrained-heuristic ranged stack (mean 4.2
shooters) still beats r3 52.6-47.4; the 2026-07-15 setup evidence showed Sniper-pinned armies win 77% at 3 shooters and
97% at 4-5. The floor is soft (a shooter must be on offer), so r4's realised mean is expected around 2.6-2.8.

## Change (common)
`…-v1-w4-r4` registered at weight 4 with `RANKED_DRAFT_RANGED_FLOOR` 4. No other id changes.

## Design (same protocol; incumbent = policy:ranked-unit-strength-a19-side-v1-w4-r3)
- Selection r4 vs r3, 2000 games, seed 99310001; must exceed 50.5% draw-aware to continue.
- Confirmation r4 vs r3, 8000 games, seed 99320001.
- Robustness r4 and r3 vs pool `reference`, seed 99330001, 2000 games each.
Gates identical to PREREGISTRATION_RANGED_FLOOR.md (draw-aware > 0.50, clustered LCB > 0.50, 0 rejections, worst map
>= 0.49, robustness cells >= incumbent − 2pp, distinct >= 80% of incumbent, top share <= incumbent + 10pp). The
diversity gates are the expected failure mode (Zena share). Seeds are never re-rolled.

## RESULT — selection r4 vs r3 (seed 99310001, 2000 games): decisive 58.88% [54.52, 63.11], draw-aware 58.80%,
LCB 54.52, 0 rejections, maps 56.8 / 57.1 / 62.7; diversity r4 49 distinct (top Dryad 46.1%) vs r3 50 (top Peasant
40.7%). Above the 50.5% bar -> confirmation 99320001 (8000 games) + robustness 99330001 started 03:08:33Z.

## INFORMATIONAL (seed 99260001, 2000 games): r3 vs the validated-but-unshipped v1-w12 = 41.51% [37.27, 45.88].
So v1-w12 (mean 2.58 shooters, from the 2026-09-14 program) is STRONGER than the r3 default just shipped, and the
open question is r4 (mean 2.88) vs w12. Added as an AMENDMENT below, written before those games ran.

## AMENDMENT 1 (2026-09-22 04:55Z, before any of its games): decide the ship between r4 and v1-w12.
- P4b selection r4 vs `policy:ranked-unit-strength-a19-side-v1-w12`, 2000 games, seed 99340001.
- If r4's draw-aware > 0.505: confirmation r4 vs w12, 8000 games, seed 99350001, gates 1-4 as above.
- If r4 loses: v1-w12 becomes the ship proposal (it already passed its own 2026-09-14 gates vs w4) and the floor
  family is reported as superseded. Either way the shipped-r3 default is revisited in the same recommendation.

## RESULT — confirmation r4 vs r3 (seed 99320001, 8000 games): decisive 57.09% [54.91, 59.24], LCB 54.91, draw-aware
57.03% (W4526 L3402 D72), 0 rejections; maps NORMAL 54.88 (LCB 51.09) / LAVA 55.89 (52.10) / BLOCK 60.49 (56.73).
Diversity over 4000 drafts: 50 vs 50 distinct, top share Dryad 44.4% vs Peasant 43.7% (+0.7pp). Gates 1,2,3,4,6a,6b
PASS; gate 5 awaits both robustness cells.

## RESULT — robustness r4 vs reference (seed 99330001, 2000 games each): vs untrained-heuristic ranged stack 52.77%
[48.39, 57.11]; vs league round-3 exploiter 86.59% [83.32, 89.30]; 0 rejections. r4 is the first draft in this family
to BEAT the ranged stack (w4 33.87%, r3 47.36% on seed 99240001). r3's cell on this seed pending for gate 5.

## VERDICT for r4 vs r3 (results/P4/VERDICT.txt): PASS on all 8 gates.
Gate 5 on the shared seed 99330001: vs untrained-heuristic r4 52.77% vs r3 46.88% (+5.89pp); vs round-3 exploiter
86.59% vs 84.00% (+2.59pp). Diversity identical (50/50 distinct, +0.7pp top share). r4 is therefore strictly better
than the r3 default now on main — pending AMENDMENT 1 (r4 vs v1-w12), which decides what to actually ship.

## RESULT — AMENDMENT 1 selection r4 vs v1-w12 (seed 99340001, 2000 games): decisive 50.83% [46.46, 55.19],
draw-aware 50.82%, 0 rejections; maps NORMAL 46.6 / LAVA 50.5 / BLOCK 55.5. Essentially parity; just over the 0.505
bar, so confirmation 99350001 (8000 games) started 07:33Z. Drafts in that head-to-head: r4 49 distinct, top Elf 53.6%,
mean 3.40 shooters; w12 47 distinct, top Battle Mage 51.4%, mean 2.35. Tie-breakers if the confirmation is also parity:
r4 beats the untrained-heuristic ranged stack 52.77% where w12 measured 47.78-49.77% in the 2026-09-14 program, and r4
keeps the floor mechanism (soft, offer-conditioned) instead of a 3x strength weight.

## RESULT — AMENDMENT 1 confirmation r4 vs v1-w12 (seed 99350001, 8000 games): decisive 51.63% [49.43, 53.81],
draw-aware 51.61%, LCB 49.43, 0 rejections; maps NORMAL 48.54 / LAVA 52.78 / BLOCK 53.54; diversity r4 50 distinct
(top Elf 50.2%) vs w12 49 (top Battle Mage 51.5%).
**Gate 1 PASS, gate 2 FAIL (LCB 49.43 not > 50), gate 4 FAIL (NORMAL 48.54 < 49).** r4 is NOT proven stronger than
v1-w12; they are statistically indistinguishable with r4 slightly ahead on the point estimate.

## FINAL DISPOSITION (2026-09-22)
SHIP r4 as the ranked default, reported honestly:
- r4 > r3 (the default now live on main): all 8 gates, 57.09% [54.91, 59.24] over 8000 games.
- r4 ≈ v1-w12: 51.63% [49.43, 53.81] — nothing is given up by preferring r4.
- r4 handles the live human exploit best: vs the untrained-heuristic ranged stack r4 52.77%, r3 46.88%,
  w12 47.78-49.77% (2026-09-14 program), w4 33.87%.
- Variety is preserved: 50 distinct creatures, top share within 1pp of every comparator.
v1-w12 stays unshipped; its only remaining advantage would be a different Zena-heavy draft identity.
