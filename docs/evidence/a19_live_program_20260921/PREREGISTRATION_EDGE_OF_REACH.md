# Preregistration — a19 edge-of-reach advance candidate (SEARCH_A19_EDGE_OF_REACH_MOVE)

Written 2026-09-21 before any deciding game was played. Common base d83dc34 (production a19 = f892870 flat profile,
deep budget r4/s6/m10). Measured from a private clone of common at d83dc34 with the seam applied (fight_seams_not_applied.patch), on
the hft node, against a pristine d83dc34 checkout for the identity check.

## Live evidence (test.heroesofcrypto.io, 125 terminal match reports, 27 decisive human-vs-AI fights)
- AI won 11/27 (39%); 0/3 in September. Composition confound: AI fielded 0 shooters in 22/27; humans 2-5.
- Behaviour that is NOT composition: humans strike in place on 84% (vs AI) / 90% (human-vs-human) of melee attacks,
  a19 charges (moves then strikes) on 63% in both AI-vs-human and AI-vs-AI fights. Winning humans hold, let the AI
  arrive one stack at a time, and kill it with several defenders before it acts again.
- Mechanism: a19 inherits a13 `maxMoves: 1` and drops wait/defend challengers, so its search only ever scores the
  nearest-to-enemy advance and melee charges. It cannot compare "advance to the edge of the enemy's reach".

## Change
`IEnumerateOptions.retainEdgeOfReachMove`: keep, beside the capped nearest move, the nearest ADVANCING destination
whose body no enemy melee stack can move to and strike next turn (path-helper reach + attack range), marked
`edgeOfReachReserved`; `reserveEdgeOfReachShortlist` keeps it in the rollout shortlist. Driver env
`SEARCH_A19_EDGE_OF_REACH_MOVE=1` (a19 search only). Rollouts arbitrate; no forced choice. Seam off = byte-identical
(verified by digest before the battery).

## Design (paired, seat-swapped, deterministic a19 both seats, side board, live maps NORMAL/LAVA/BLOCK)
Harness `edge_child.ts`/`edge_launch.ts`: board b drafts under live draft rules; mirror 0 = treated army LEFT,
mirror 1 = treated army RIGHT; arms baseline (stock) / treatment (treated seat gets the env override through
`searchEnvOverrideTeams`). Metric: treated-army decisive win rate, treatment minus baseline, board-bootstrap 95% CI
(`paired_release_aggregate.py`, 2000 resamples). Rows appended per game; exact resume.

Cohorts (450 boards each = 900 game pairs):
- A `mirror`   — both armies drafted by the staging default draft v1-w4 (the live bot's own armies). PRIMARY.
- B `vsranged` — treated v1-w4 army vs the untrained-heuristic ranged stack (the human exploit seen live).
- C `vsmelee`  — treated v1-w4 army vs the league round-3 exploiter (melee tanks).
- D/E/F — side_board_ab_battery random / ROSTER_RANGED_MIN=0,MAX=1 melee-heavy / MIN=2,MAX=3 range-heavy,
  400 pairs each, `--search-overrides '{"SEARCH_A19_EDGE_OF_REACH_MOVE":"1"}' --deterministic-search
  --no-legacy-control`.

Seeds: A 99010001 (confirm 99020001), B 99030001, C 99040001, D 99050001, E 99060001, F 99070001. None used before.

## Gates (decided now)
1. A: 95% CI low bound > 0 AND point >= +1.0pp.
2. B, C, D, E, F: point delta > -1.0pp each (no cohort regression), 0 treated-seat engine rejections in every cohort.
3. CPU per game (treatment / baseline) <= 1.40.
4. Confirmation of A on 99020001: point > 0; pooled A over both seeds CI low > 0.
PASS on all four -> ship as a default a19 rule (V08_A19_SEARCH_RULES, re-pin ledger, tests). Any FAIL -> report as a
fail, keep the seam default-off, move to the next proposal. No seed is re-rolled.

## Identity check (before the battery, hft, seed 99000001 board 0, both mirrors)
Pristine d83dc34: baseline == treatment digests (7f69ac8e…, 157d0b2c…; the unknown env is ignored).
Seam tree, seam OFF: identical to pristine (7f69ac8e…, 157d0b2c…). Seam ON: mirror 0 changed (5137921c…), mirror 1
unchanged. Single-process cost 9–18 CPU s per game on hft. Queue launched 2026-09-21 ~04:20Z (`run_all_hft.sh`).

## RESULT — cohort A (seed 99010001, 450 boards, 900 pairs, 0 rejections either arm): GATE 1 FAIL
Treated-army decisive win rate 55.02% -> 54.34%, delta **-0.68pp [-3.19, +1.69]** (board bootstrap), 143/900 pair
outcomes changed, CPU ratio 1.027, mean laps 6.59 -> 6.74.
Per map: NORMAL -5.60pp [-10.10, -0.96] (64 changed) — the open map is where "step to the edge of reach" isolates a
unit; LAVA +2.38pp [-3.17, +7.75]; BLOCK +1.17pp [-0.67, +3.07] (10 changed — the seam rarely triggers among stones).
Debug board: the edge candidate was retained on ~20% of searched decisions and chosen on ~5% of those; a single chosen
move (lone Goblin Knight five cells up the flank in lap 1) flipped a game. Verdict: the search does not turn the
retained edge-of-reach move into a win in self-play; the seam stays default-off. Cohort B (vs ranged stack) was
already running and is reported for information; C–F and the confirmation were not run (compute goes to P2).

## RESULT — cohort B (vs untrained-heuristic ranged stack, seed 99030001, 736 pairs at read time): no help
Treated v1-w4 army decisive win rate 30.12% -> 28.90%, delta -1.22pp [-3.25, +0.99]; NORMAL +1.4, LAVA -5.5 [-10.5, -0.7],
BLOCK +0.4. Side finding: a19 with the staging draft loses ~70% to the ranged stack — the live human exploit measured.

Final cohort B (1800 rows):
```
rows 1800, game pairs 900, boards 450
ALL                          pairs  900 | baseline 30.79% (n=890) -> treatment 30.04% (n=892) | delta -0.74pp [-2.55, +1.18] | outcome changed 77
treated-army engine rejections: baseline 0, treatment 0
  map NORMAL                 pairs  300 | baseline 30.41% (n=296) -> treatment 31.86% (n=295) | delta +1.46pp [-1.61, +4.71] | outcome changed 24
  map LAVA                   pairs  300 | baseline 37.29% (n=295) -> treatment 33.56% (n=298) | delta -3.73pp [-7.92, +0.54] | outcome changed 47
  map BLOCK                  pairs  300 | baseline 24.75% (n=299) -> treatment 24.75% (n=299) | delta +0.00pp [-1.67, +2.01] | outcome changed 6
```
