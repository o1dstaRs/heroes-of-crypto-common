# Preregistration — a19 wait challenger (SEARCH_A19_WAIT_CHALLENGER=2)

Written 2026-09-21 ~04:50Z before any deciding game. Same base (common d83dc34 + the P1 seam code, both seams default
off), same harness, same live-fidelity design as PREREGISTRATION_EDGE_OF_REACH.md.

## Why (live evidence + P1 debug)
Humans strike in place on 84–90% of melee attacks and hold rather than walk into reach; a19 charges on 63%. a19's
search excludes every generated passive challenger (SEARCH_ACTIVE_CHALLENGERS=1, an a13-era choice made at 2 rollouts /
horizon 12), so once the policy proposes a move or charge the search can only pick a DIFFERENT productive action —
never "hold and receive". P1 offered a stepping-forward alternative and measured negative on the open map: a lone unit
stepping to the edge of reach gets isolated. The direct form of the human posture is the hourglass wait.

## Change
Driver env `SEARCH_A19_WAIT_CHALLENGER` (a19 search only): "2" keeps the enumerator's legal WAIT as a challenger when the
incumbent MOVES the unit (reposition or charge) and is not itself a wait/defend/idle; the wait is reserved into the
rollout shortlist (`reserveWaitChallengerShortlist`) so 4 full 64-turn rollouts, not the immediate leaf, judge it. The
ordinary override gate applies (wait must beat the incumbent by SEARCH_GATE 0.03 P(win)). "1" = whenever a wait is
legal (not tested first). Seam off = byte-identical (digest-verified before the battery). Counters
`WAIT_CHALLENGER_STATS` (offered/chosen) are recorded per game.

## Design, cohorts, seeds
Paired seat-swapped boards, deterministic a19 both seats, side board, live maps; treated seat gets
`V08_A19_SEARCH_ENV_OVERRIDES={"SEARCH_A19_WAIT_CHALLENGER":"2"}` via `searchEnvOverrideTeams`.
- A `mirror` v1-w4 vs v1-w4, 450 boards, seed 99110001 (confirm 99120001). PRIMARY.
- B `vsranged` v1-w4 vs untrained-heuristic ranged stack, 450 boards, seed 99130001.
- C `vsmelee` v1-w4 vs league round-3 exploiter, 450 boards, seed 99140001.
- D/E/F side_board_ab_battery random / melee-heavy / range-heavy, 400 pairs, seeds 99150001 / 99160001 / 99170001.
Gates identical to P1: (1) A CI low > 0 and point >= +1.0pp; (2) B–F each > −1.0pp and 0 treated rejections;
(3) CPU ratio <= 1.40; (4) confirm A on 99120001 point > 0 and pooled CI low > 0. PASS -> ship as a default rule.
Order: A first; B–F and the confirmation only if A passes gate 1 (compute is the constraint). No seed is re-rolled.

## RESULT — cohort A (seed 99110001, 450 boards, 900 pairs, 0 rejections either arm): GATE 1 FAIL
rows 1800, game pairs 900, boards 450
ALL                          pairs  900 | baseline 57.75% (n=890) -> treatment 57.59% (n=889) | delta -0.16pp [-1.72, +1.33] | outcome changed 57
treated-army engine rejections: baseline 0, treatment 0
  map NORMAL                 pairs  300 | baseline 53.51% (n=299) -> treatment 54.52% (n=299) | delta +1.00pp [-1.01, +3.31] | outcome changed 13
  map LAVA                   pairs  300 | baseline 60.74% (n=298) -> treatment 59.52% (n=294) | delta -1.21pp [-3.64, +1.14] | outcome changed 16
  map BLOCK                  pairs  300 | baseline 59.04% (n=293) -> treatment 58.78% (n=296) | delta -0.26pp [-3.45, +2.83] | outcome changed 28
Wait challenger offered on 8.25 of 52.6 searched decisions per game, chosen 0.30 per game (189 of 900 treatment games).
Pairs with a chosen wait: 180, outcomes changed 46, net wins -2; pairs without: 705, changed 2, net 0. CPU ratio 0.983.
The interim read at 252 pairs (+3.78pp [+1.03, +6.88]) was an optimistic draw. Verdict: a rollout-arbitrated act->wait
is noise-level in a19 self-play; seam stays default-off; B–F and the confirmation were not run.
