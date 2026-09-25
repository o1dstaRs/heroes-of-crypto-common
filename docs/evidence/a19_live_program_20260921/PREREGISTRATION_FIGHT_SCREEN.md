# Preregistration — a paired screen of cost-neutral a19 fight settings (P20)

Written 2026-09-24 ~21:50Z, before any P20 game and before P18's selection is complete (1500 of its 4000 games read:
48.70% draw-aware — partial, reported here because it motivates two arms below).

## Why
Tonight's draft and setup levers are closed (P15, P17), and the refit leaf — far better calibrated on today's fights
(log-loss 0.371 vs 0.464) — is not winning on its partial selection. A sharper, re-weighted leaf changes which
challengers clear the 0.03 P(win) override gate as much as it changes their order, so the gate and the leaf's
distance from the production weights are the natural next knobs. None of them costs search time.

## Arms (each: the live stack vs itself with the change on the candidate's search only, through
## `--candidate-search-env-file`; fidelity on; seed 99560001, games 0-1999, paired game by game with P15's BASE)
- G2: `SEARCH_GATE` 0.02.
- G5: `SEARCH_GATE` 0.05.
- L30: the P18 leaf refitted at ridge lambda 30 toward the production weights (CV log-loss 0.3748).
- L300: the same at lambda 300 (CV 0.3866) — closest to production.
- LRF4: `SEARCH_LATE_RANGED_FINISH_WEIGHT` 4 (the leaf rewards late damage in proportion to board rangedness; armies
  now field 3-4 shooters, the regime the knob was written for).
Leaves L30/L300 come from `fit_leaf.py` on the same P17 value rows with lambda fixed (no new data).

## Decision (fixed now)
An arm is promoted at a paired draw-aware difference of at least +1.5pp over BASE. The best promoted arm is confirmed
against the live stack: 8000 games, seed 99820001, plus its robustness cell on the shared seed 99480001; the eight
gates of verdict.py. Seeds are never re-rolled; every arm is reported.

Prediction, written down so it can be wrong: the gate arms move less than ±1.5pp; the gentler leaves land between
P18's refit and BASE; nothing clears +1.5pp.

## Amendment 2026-09-24 ~22:14Z, before any P20 result was read
Sixth arm LFULL: P18's own refit leaf (lambda 0.3), on the same seed and games, so all three leaf strengths are paired
with BASE and with each other. (P18's selection finished 50.92% [50.11, 51.74] on its own seed — below its 51.5% bar.)

## RESULT — screen (2026-09-25 00:41Z; seed 99560001 games 0-1999, each arm paired game by game with P15's BASE)
| arm | draw-aware | paired vs BASE [95%] | results changed |
|---|---|---|---|
| G2 gate 0.02 | 50.27% | +0.27pp [-0.07, +0.62] | 13 |
| G5 gate 0.05 | 49.83% | -0.18pp [-0.48, +0.13] | 12 |
| L30 leaf (lambda 30) | 51.80% | **+1.80pp [+0.62, +2.98]** | 218 |
| L300 leaf (lambda 300) | 51.77% | **+1.77pp [+0.66, +2.89]** | 191 |
| LFULL leaf (lambda 0.3, P18's) | 51.75% | **+1.75pp [+0.55, +2.95]** | 228 |
| LRF4 late ranged finish 4 | 49.77% | -0.22pp [-0.66, +0.21] | 24 |
0 rejections in every arm. Promoted (>= +1.5pp): L30, L300, LFULL; best L30 → confirmation 8000 games on seed 99820001
+ its robustness cell on 99480001. Reading: the override gate almost never binds (12-13 games of 2000 change), the
ranged-finish overlay does nothing measurable, and the refit leaf is worth about 1.8 points at any of the three
strengths on this seed (P18 read +0.9 on its own seed). The prediction ("nothing clears +1.5pp") was wrong.
