# Deep search for melee-flyer decisions only — primary result (seed 98500001)

Preregistration: `PREREGISTRATION_FLYER_SEARCH.md` (with its pre-launch amendments). Frozen common eb62054, worktree
`hoc-common-flyer-search-eval`, all arms with `V08_A19_SEARCH=1`. 450 boards (first 450 of seed 98500001 whose
LEFT-drafted army fields a melee flyer), both battle mirrors, each game played in three arms: 2,700 games, 900 game
triples. Deep budget = SEARCH_ROLLOUTS 4, SEARCH_SHORTLIST 6, SEARCH_MAX_MELEE 10 (stock a19: 2 / 3 / 6).

Operational note: the run was stopped twice by host memory pressure (the harness stops background jobs on low
memory). The workers append each finished game and skip games already on disk; resuming a fresh process was verified
to reproduce the uninterrupted digests exactly on a throwaway seed. Final file: 2,700 unique rows, no duplicates.

| Slice  | Arm vs baseline | Pairs | Baseline | Arm    | Delta [95% board bootstrap] | Outcomes changed |
| ------ | --------------- | ----- | -------- | ------ | --------------------------- | ---------------- |
| All    | F (flyers only) | 900   | 54.36%   | 56.27% | +1.91pp [-0.67, +4.39]      | 150              |
| All    | A (every unit)  | 900   | 54.36%   | 60.00% | +5.64pp [+2.27, +8.84]      | 239              |
| NORMAL | F               | 306   | 57.95%   | 59.41% | +1.46pp [-3.43, +6.55]      | 65               |
| NORMAL | A               | 306   | 57.95%   | 63.91% | +5.96pp [+0.38, +12.04]     | 85               |
| LAVA   | F               | 294   | 46.69%   | 50.69% | +4.00pp [-0.72, +8.71]      | 57               |
| LAVA   | A               | 294   | 46.69%   | 56.99% | +10.30pp [+4.53, +16.29]    | 95               |
| BLOCK  | F               | 300   | 58.16%   | 58.56% | +0.40pp [-2.65, +3.46]      | 28               |
| BLOCK  | A               | 300   | 58.16%   | 58.90% | +0.74pp [-4.03, +5.27]      | 59               |

Metric: treated army decisive win rate. Engine rejections for the treated army: 0 in every arm.

Cost: melee-flyer decisions were 25.0% of the treated army's searched decisions (7,105 of 28,370) in arm F. Child
process CPU per game: baseline 3.00 s, F 3.94 s (+32%), A 5.53 s (+85%).

**Gate 1: FAIL** (lower bound of F minus B is -0.67pp, not > 0). No re-roll and no confirmation run, as preregistered.

Reading (reported, not gated): the deep budget on every decision reproduces the known gain (+5.64pp here, +5.1pp in
the earlier seat battery). Flyer-only deep search captures about a third of it (+1.91pp) for a quarter of the
decisions and about 38% of the extra CPU, i.e. roughly proportional: melee-flyer decisions do not gain more from
deeper search than other decisions. The case for selective deep search by unit class is not supported; the lever is
total budget.
