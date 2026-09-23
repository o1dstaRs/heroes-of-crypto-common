# a19 improvement program from live test-server games (2026-09-21 → 2026-09-22)

Owner request: analyse past games on test.heroesofcrypto.io and make a19 v0.8 measurably better than what we have —
make a proposal, evaluate it, make the change, measure it on multiple cohorts, set it in stone, continue.

Every proposal was preregistered (files in this folder) before its deciding games, measured with paired seat-swapped
games on the live side board with deterministic a19 on both seats, and judged only by its preregistered gates.

## What the live games showed ([LIVE_ANALYSIS.md](LIVE_ANALYSIS.md))

26 decisive human-vs-AI fights: the AI won 11 (42%). It fielded no natively ranged creature in 23 of them, while 16
of the 26 human armies had at least one. Humans struck from where they stood on 85% of their melee attacks; a19
charged on 63%, and its search structurally cannot score "hold and receive the charge". (The first pass of these
counts was wrong in three places; the correction is at the top of LIVE_ANALYSIS.md.)

## Results

| # | proposal | deciding measurement | outcome |
|---|---|---|---|
| 1 | edge-of-reach advance candidate for the search | 900 pairs: −0.68pp [−3.19, +1.69]; NORMAL −5.6 | fail, not applied |
| 2 | wait challenger when the policy's action moves the unit | 900 pairs: −0.16pp [−1.72, +1.33] | fail, not applied |
| 3 | draft shooter floor 3 (`…-v1-w4-r3`) | vs v1-w4, 8,000 games: 67.60% [65.52, 69.62], 8/8 gates | shipped, then superseded |
| 4 | draft shooter floor 4 (`…-v1-w4-r4`) | vs r3, 8,000 games: 57.09% [54.91, 59.24], 8/8 gates | **shipped, current default** |
| 5 | draft shooter floor 5 | vs r4, 8,000 games: 52.05% [49.86, 54.23], gate 2 fails | fail, lever closed |
| – | a19 Pareto No-Melee focus (`any_board`) | withdrawn before any deciding game: its trigger co-occurs on 6.4% of boards | not run |

Also measured: r4 against the validated but unshipped v1-w12, 10,000 games: 51.63% [49.43, 53.81] —
indistinguishable, so preferring the floor gives nothing up. The informational r3 vs v1-w12 run (2,000 games) had
r3 at 41.51%, which is what prompted P4.

## What shipped

- common 832f8fc: policy ids `ranked-unit-strength-a19-side-v1-w4-r2` / `-r3`, `RANKED_DRAFT_RANGED_FLOOR`, and
  `applyRankedDraftRangedFloor` inside `pickRankedLiveDraftCreature`; server 6e00ef0 made r3 the default.
- common c3bdc78: `…-v1-w4-r4`; server a6614c6 made r4 the default and pins c3bdc78.
- The floor is soft: it narrows an offer only when the remaining picks could no longer reach it, so an r4 army holds
  2.88 shooters on average, not four. Rollback without code: `HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v1-w4-r3`,
  or `…-v1-w4` for the pre-program default.
- Calibration: r4 beat the untrained ranged stack 52.77% on seed 99330001 and 50.43% on 99430001. The honest claim is
  that r4 closed the exploit that beat v1-w4 two to one (33.87%) to about even, not that it dominates it.

## The draft optimum is bracketed

r3 (2.12 shooters) is proven worse than r4, r5 (3.14) is not proven better, and the untrained heuristic stack (4.21) is
proven worse. Floors 5 and 6 draft identically (3.14 vs 3.15) because the offers stop containing shooters, so no
higher floor can differ. Going past ~2.9 shooters needs a re-fit of the unit-strength prior, not another floor. The
r5 and r6 ids were registered only in the measurement tree and are deliberately not on main.

## Why the fight-side proposals measured nothing

Both tactical seams changed about one decision per game and the rollouts did not turn the human posture into a
self-play win. The per-unit census in LIVE_ANALYSIS.md then showed a19 already plays the added shooters well (84–90%
attack share), agreeing with a peer's census that the passive-turn problem is gone. The live losses were a
composition problem.

`fight_seams_not_applied.patch` holds both seams exactly as measured (`SEARCH_A19_EDGE_OF_REACH_MOVE`,
`SEARCH_A19_WAIT_CHALLENGER`, their counters and unit test). It applies to c3bdc78 but is kept out of
`search_driver.ts`, a sealed source in the a19 ledger, because both measured null. Do not re-run either.

## Reproducing

| step | command (`bun` commands run from the common root; `scripts/` is this folder's `scripts/`) |
|---|---|
| export live games | on the test host: `pm2 jlist \| python3 export_testserver.py reports ts_reports.jsonl`, then `actors ts_actors.jsonl` |
| live report | `python3 scripts/live_report.py <dir holding both files>` |
| draft comparison | `bun src/simulation/ranked_draft_eval.ts --candidate <policy> --pool policy:<incumbent> --games N --seed S --fight-profile a19 --candidate-setup v07-nonfight-4eda84635fe7 --opponent-setup v07-nonfight-4eda84635fe7 --live-draft-rules true --side-board true --deterministic-search true --record-armies true --records X.jsonl --output X.json` |
| draft verdict | `VERDICT_OUT=<dir> python3 scripts/verdict.py <confirm> <robust_candidate> <robust_incumbent> incumbent:<policy>` |
| paired search-seam A/B | `COMMON_ROOT=<common> EDGE_OVERRIDE_JSON='{…}' EDGE_LABEL=<l> [EDGE_DRAFT_POLICY=<policy>] bun scripts/edge_launch.ts <shards> <seed> <boards> <mirror\|vsranged\|vsmelee> <outdir>`, then `python3 scripts/paired_release_aggregate.py '<outdir>/*.jsonl'` |
| side-board cohorts | `COMMON_ROOT=<common> OVERRIDE_JSON='{…}' scripts/side_battery.sh <random\|melee\|ranged> <seed> <pairs> <conc> <outdir>` |

Seeds used, all first-use and never re-rolled: 99010001, 99030001 (P1); 99110001 (P2); 99210001, 99220001, 99230001,
99240001 (P3); 99260001 (r3 vs w12); 99310001, 99320001, 99330001, 99340001, 99350001 (P4); 99410001, 99420001,
99430001 (P5). Burned by smoke runs: 99000001, 99500001.

## Open for the owner

Neither host is deployed. The test server still runs a common from before the deep-budget a19 and before both draft
changes, so none of this is live where the analysed games are played. Re-running `live_report.py` on a fresh export
after a deploy is the direct check of whether the AI's 42% against humans moves.
