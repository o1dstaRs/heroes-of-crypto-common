# a19 improvement program from live test-server games (2026-09-21 → 2026-09-24)

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
| 4 | draft shooter floor 4 (`…-v1-w4-r4`) | vs r3, 8,000 games: 57.09% [54.91, 59.24], 8/8 gates | shipped, then superseded |
| 5 | draft shooter floor 5 | vs r4, 8,000 games: 52.05% [49.86, 54.23], gate 2 fails | fail, lever closed |
| – | a19 Pareto No-Melee focus (`any_board`) | withdrawn before any deciding game: its trigger co-occurs on 6.4% of boards | not run |
| 6 | `conditional-v1` setup for v0.8 seats (Sniper 3 > Armor 3 > Might) | vs the live setup, 8,000 games, both drafts r4: 55.58% [53.39, 57.74], 8/8 gates | **shipped, v0.8 only** |
| 7 | unit-strength prior re-fitted on r4 armies and current balance, weight 8 (`…-v4-w8-r4`) | vs r4, 8,000 games: 63.04% [60.90, 65.13], 8/8 gates; with both seats on `conditional-v1` 61.83% [57.50, 65.99] | shipped, then superseded by P11 |
| 8 | the v0.8 bot always takes SEE_NONE instead of a per-match doctrine | vs the variety, 8,000 games: 53.24% [51.04, 55.41], 8/8 gates; on v4 drafts 54.41% | **shipped, v0.8 only** |
| 9 | the Tier-2 artifact table re-measured for a19 on v4 armies (rule `t2a19`) | vs the old table, 8,000 games: 53.71% [51.52, 55.89], 8/8 gates; predicted +3.88pp cross-fitted | **shipped, v0.8 only** |
| 10 | synergy options re-measured for a19 on v4 armies | stage 1: only Chaos passed the flip bar (53.60%); 16,000-game confirmation 48.46% [46.92, 50.01], gates 1, 2, 4, 5 fail | fail — a stage-1 false positive; the table holds |
| 11 | the v4 prior at weight 16 (`…-v4-w16-r4`) | vs weight 8, 8,000 games: 54.60% [52.41, 56.77], 8/8 gates (selection: w12 51.38%, w16 55.80%) | **shipped, current default** |
| – | stack check: P9 + P11 together vs the stack before them | 4,000 games: 57.61% [54.52, 60.64] (rule: > 50% and within 3pp of 54.60%) | **pass — the gains add up** |
| 12 | the v4 prior above weight 16 (w24, w32) | selection w24 51.80%, w32 51.05%; confirmation w24 vs w16 51.24% [49.05, 53.43], gate 2 fails | fail — the weight curve is flat above 16 |
| 13 | a v5 prior re-fitted on the armies v4-w16 drafts under the live setup | selection vs v4-w16, 2,000 games: 49.05% [44.67, 53.41] (r = 0.931 with v4) | stop — the on-policy re-fit has converged |
| 14 | Empower augments for the caster-heavy armies (59% hold a magic-damage caster) | five paired plan arms: Empower 1 for Might 1 is a wash; paying for Empower with Armor or Sniper costs 6–18pp; cross-fitted +0.28pp | stop — the current plan holds |
| 15 | the live game's mechanics in the harness; the seventh augment point to Placement; skipping the split pass (P15) | paired with a 4000-game self-play BASE (exactly 50.00%): Placement 1 for Might 1 −2.07pp [−4.66, +0.53]; Placement 2 for an Armor point −9.75pp; a19 not splitting +1.12pp [−0.05, +2.30] | harness fixed (below); no arm reached the +1.5pp bar |
| 17 | a v6 prior fitted under the live synergy variants and splits, variant-aware (`-sv`), with a ranged-count step (`-rc`) | selection vs v4-w16, 2,000 games each: v6 48.65%, v6-sv 50.15%, v6-sv-rc 50.52% | stop — below the 52% bar; the variant and composition terms recover ~2pp over v6, not past v4 |
| 18 | the search leaf re-fitted on 416,017 turns of today's fights (log-loss 0.371 vs 0.464) | selection, 4,000 games: 50.92% [50.11, 51.74] | stop — real (+0.9pp) but under the 51.5% bar |
| 20 | a paired screen of cost-neutral fight settings | vs BASE, 2,000 games each: leaf λ30 +1.80pp [+0.62, +2.98], λ300 +1.77, λ0.3 +1.75; gate 0.02 +0.27, gate 0.05 −0.18; late-ranged-finish 4 −0.22 | λ30 promoted; its own confirmation is reported in VERDICTS.md |
| 21 | the stack: λ30 leaf + a19 seats not splitting | vs the live stack, 8,000 games: 51.41% draw-aware, clustered [49.23, 53.61], 0 rejections, every map ≥ 51.2; robustness within bounds | **fail — gate 2** (LCB 49.23); the overnight goal of +10pp is not met |

Also measured: r4 against the validated but unshipped v1-w12, 10,000 games: 51.63% [49.43, 53.81] —
indistinguishable, so preferring the floor gives nothing up. The informational r3 vs v1-w12 run (2,000 games) had
r3 at 41.51%, which is what prompted P4. On current balance (after the Goblin Knight, Wandering Mage and Fire Wall
changes) r4 still beats r3 60.04% [55.69, 64.24] over 2,000 games.

## What shipped

- common 832f8fc: policy ids `ranked-unit-strength-a19-side-v1-w4-r2` / `-r3`, `RANKED_DRAFT_RANGED_FLOOR`, and
  `applyRankedDraftRangedFloor` inside `pickRankedLiveDraftCreature`; server 6e00ef0 made r3 the default.
- common c3bdc78: `…-v1-w4-r4`; server a6614c6 made r4 the default and pins c3bdc78.
- The floor is soft: it narrows an offer only when the remaining picks could no longer reach it, so an r4 army holds
  2.88 shooters on average, not four. Rollback without code: `HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v1-w4-r3`,
  or `…-v1-w4` for the pre-program default.
- Calibration: r4 beat the untrained ranged stack 52.77% on seed 99330001 and 50.43% on 99430001. The honest claim is
  that r4 closed the exploit that beat v1-w4 two to one (33.87%) to about even, not that it dominates it.

- server 13bca49: v0.8 seats (the ranked bot and vs-AI brutal) set up with `conditional-v1` through the v0.8
  lifecycle profile. The global setup default, the easy/normal/hard tiers (v0.4/v0.6/v0.7) and absent-human
  auto-setup are unchanged: for v0.7, `conditional-v1`'s undefined placement override would turn reveal placement
  off, which was not measured. v0.8 deploys exactly as measured because its strategy fills an unset placement
  policy with `public-roster`. Rollback: `HOC_V08_SETUP_POLICY=v07-nonfight-4eda84635fe7`; `HOC_SETUP_POLICY` no
  longer governs v0.8 seats. The human-derived `ranked-replay-tactics-v1` setup (Placement 2 for Might 2) lost
  45.53% on every map, ending its experiment.

- common 993078e: the v4 prior (`draft_strength_priors/ranked_unit_strength_a19_side_v4.json`, fitted on 8,000
  games drafted by r4 with half its picks explored, at 6f67b22 balance) and the ids `…-v4-w4-r4` / `…-v4-w8-r4`;
  server 304b333 made `…-v4-w8-r4` the default. Rollback: `HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v1-w4-r4`.
  At r4's weight the new prior alone was worth 54.69% [50.31, 59.00] (selection); weight 8 took it to 63.51%, and the
  8,000-game confirmation measured 63.04%. P7 was preregistered before P6 changed the v0.8 setup, so a stack check with
  both seats on `conditional-v1` was added as a ship condition before any result was known; it measured 61.83%.

- server f6c9b42: v0.8 seats always take SEE_NONE (Battle Trance, 7 upgrade points) instead of drawing a doctrine per
  match, which every version had done since 2026-08-11. Every earlier measurement of the v0.8 draft, setup and fight
  used SEE_NONE; the variety put two thirds of live games on 5 or 6 points. Against the variety SEE_NONE won 53.24%,
  60.5% of the games where the variety drew SEE_ALL and 50.4% where it drew THREE_REVEALS: two points outweigh full
  sight of the opponent's draft, one point and three random reveals come out even. The easy/normal/hard tiers keep the
  variety. Rollback: `HOC_V08_DOCTRINE_POLICY=ranked-variety`.

- common 13a92e3, server 24a9a0e, client 5981464: v0.8 seats pick their Tier-2 artifact from a table re-measured on the
  armies they draft (rule `t2a19`, spec `conditional-v1:sniper+t2a19`). Twelve paired arms forced each artifact onto
  the same 2,000 games: Crown of Command 56.5 leads, Giant's Maul 54.3, Clover 53.6, Farsight 53.2; Tome of
  Amplification (42.3), which the old table put first or second and the bot took on a fifth of its armies, is second
  from last. Five of the twelve rows had moved since the old table was measured (Tome reworked, Crown and Giant's Maul
  buffed, Berserker's Bond changed, Archmage's Ring added). Rollback: `HOC_V08_SETUP_POLICY=conditional-v1`.

- common 1a6c5d58, server 2b169d5, client 1b1c64a: the ranked draft default is the v4 prior at weight 16. On the live
  v0.8 stack weight 16 beat weight 8 54.60% [52.41, 56.77]; weight 12 had been only 51.38% in selection. The weight
  axis kept paying (w4 < w8 < w16) while the draft stayed varied: 47 distinct creatures against 48, top share 41.2%
  against 38.0%. Rollback: `HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v4-w8-r4`.

## The harness did not play the live game's synergies or splits (found and fixed 2026-09-24)

Live ranked games draw ONE synergy variant per faction from the game id and apply it to whatever the army fields
(`synergyVariantsForSeed`, play_session), so the setup policy's synergy picks are vestigial live. `ranked_draft_eval`
never set variants: every measurement above played the DEFAULT variants plus the setup policy's picks — Might armies
played both Might synergies. The server also splits one-model stacks into the slots Placement and the Nature
board-units variant open (bots and a19 included), which the harness never did, and it deployed every army in the
3-deep zone whatever Placement bought; that is why P6's "Placement 2 costs 4.5pp" said nothing about Placement.
Opt-in flags now play both: `--live-synergy-variants`, `--tactical-splits` (common fb1d99d), plus research arms
`--candidate-skips-splits`, `--candidate-search-env[-file]` and `--value-data`. Everything from P15 on used them.
Two traps found on the way: with one policy on both seats, games 4b+2/4b+3 replay 4b/4b+1 exactly, so such runs play
only the first two games of each board; and `--candidate-search-env` changed nothing until b58791e routed the override
seat through the promoted A19 driver (the harness's explicit profile environment bypassed it).

What the live mechanics changed in the measurements: nothing the bot does lost its edge, Placement stays dead even with
splits and the widened zone, the split pass is about a point worse for a19 than leaving the slots empty, and the drawn
variants are worth drafting for only a little (Chaos movement at level 2 is the one large residual, +26pp, but the
offers rarely let an army reach it).

## Fight-side changes and gate 2

A candidate that differs only in the fight plays the same drafts on both seats, so a board's four games cancel the
armies: the board means give intervals of about ±0.7pp at 8,000 games (P21: [50.67, 52.14]). Gate 2 instead takes the
lower of a cluster-robust interval and a Wilson interval that counts each board as ONE observation, ±2.19pp at 8,000
games whatever the design. It was set for draft-sized effects (+3.6pp and up) and was kept as written, which is why
P21's +1.41pp fails it; passing it at that effect size would take about 49,000 games. Whether fight-side changes should
be judged on the paired board means is the owner's call.

## The draft optimum is bracketed

r3 (2.12 shooters) is proven worse than r4, r5 (3.14) is not proven better, and the untrained heuristic stack (4.21) is
proven worse. Floors 5 and 6 draft identically (3.14 vs 3.15) because the offers stop containing shooters, so no
higher floor can differ. The r5 and r6 ids were registered only in the measurement tree and are deliberately not on
main.

P7 then re-fitted the unit-strength prior instead. v4 drafts as many shooters as r4 (3.22 vs 3.17 per army by the
engine's ranged flag, a different count from the 2.88 above) and still wins 63%: the gain is which creatures, not how
many. The biggest moves, all in the direction r4's own results pointed: Wandering Mage −11.4 → +10.4 (it gained
Fireball after the v1 fit), Gargantuan +11.5 → +27.6, Medusa +9.6 → +16.4; Hydra +7.6 → −2.8, Nightmare −5.3 → −14.5,
Black Dragon −9.4 → −14.6. In the confirmation's drafts v4 took Wandering Mage in 37.3% of armies (r4: 2.7%), Magic
Dragon 25.5% (9.3%), Battle Mage 26.3% (11.0%) and Angel 10.0% (0.8%), and dropped Hydra (0.0% against 15.3%), Troll,
Tsar Cannon and Frenzied Boar. The prior is fitted to one balance: a Fireball or Wandering Mage rebalance is the kind
of change that calls for the next re-fit, with the same data recipe.

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
| sharded draft run | `bun scripts/ranked_draft_shard.ts --common <common> --shard k --shards K --records <dir>/X.shard<k>.jsonl <draft flags>`, then `bun scripts/ranked_draft_merge.ts --common <common> --out <dir>/X --shard-glob '<dir>/X.shard*.jsonl' <draft flags>`; byte-identical to one run |
| side-board cohorts | `COMMON_ROOT=<common> OVERRIDE_JSON='{…}' scripts/side_battery.sh <random\|melee\|ranged> <seed> <pairs> <conc> <outdir>` |
| strength data | `bun src/simulation/collect_ranked_draft_strength_data.ts --policy <policy> --exploration 0.5 --boards 500 --seed S --output X.jsonl` per shard (renumber each shard's offerBoard to keep bootstrap clusters distinct) |
| strength fit | `bun src/simulation/fit_ranked_draft_unit_strength.ts --id <prior id> --lambda 4 --bootstrap 200 --commit <sha>` |
| doctrine / Tier-2 / synergy arms | add `--candidate-doctrine` / `--opponent-doctrine <see-none\|see-all\|three-reveals\|ranked-variety>`, `--candidate-t2 <id>` or `--candidate-synergy FACTION:OPTION` to a draft comparison |
| P8 split, P9/P10 derivations | `bun scripts/p8_doctrine_split.ts …`, `bun scripts/p9_t2_table.ts --common <common> --dir <arms>`, `bun scripts/p10_synergy_table.ts --dir <arms>` |

Seeds used, all first-use and never re-rolled: 99010001, 99030001 (P1); 99110001 (P2); 99210001, 99220001, 99230001,
99240001 (P3); 99260001 (r3 vs w12); 99310001, 99320001, 99330001, 99340001, 99350001 (P4); 99410001, 99420001,
99430001 (P5); 99610001, 99620001, 99630001, 99640001 (P6); 99720001, 99730001, 99740001, 99750001, 99760001,
99770001 and the training data 99800001 + 5000·k for k = 0..7 (P7); 99910001, 99920001, 99940001, 99950001, 99960001
(P8); 99970001, 99980001, 99990001 (P9); 99870001, 99880001, 99895001 (P10); 99650001, 99660001, 99670001, 99680001
(P11); 99690001, 99700001, 99710001, 99780001 (P12); 99440001 + 5000·k for k = 0..7 and 99790001 (P13); 99520001
(P14); 99930001 (stack check). 99560001 (P15 arms and P20 screen, paired with BASE); 99450001 (P17 data), 99465001 (P17 selection); 99490001
(P18 selection); 99360001 (P21 confirmation), 99820001 (P20 confirmation), 99480001 (shared robustness cell, P15-P21).
Burned by smoke and identity runs: 99000001, 99500001, 12340001. A parallel session
measuring the cumulative effect (below) used 99860001 and re-used 99880001 and 99870001 for its own, different
comparisons; no result here depends on those boards being fresh.

## Where things stand (2026-09-24)

The ranked v0.8 stack in the repositories is: draft `ranked-unit-strength-a19-side-v4-w16-r4` (server 2b169d5), setup
`conditional-v1:sniper+t2a19` (server 24a9a0e), doctrine SEE_NONE (server f6c9b42). Against the stack as it stood at
P9's start it wins 57.61% (the stack check). A parallel session measured the cumulative effect against the
pre-program stack (v1-w4 draft, v07-nonfight setup, doctrine variety): the v4-w16 draft with conditional-v1 and
SEE_NONE won 84.77% [82.02, 87.16] over 3,000 games, before the Tier-2 table (P9) was added.

What the program closed, so the next round does not repeat it: the shooter floor (P5), the unit-strength re-fit on the
bot's own drafts (P13: v5 correlates 0.93 with v4 and gains nothing), the prior's weight above 16 (P12), the synergy
table (P10: a stage-1 false positive), Empower augments (P14), and the two tactical search seams (P1, P2). A caster
census with spells counted (common 97cb7a0, 1213b17) shows a19 already plays the v4 draft's casters well.

Overnight 2026-09-24/25 (owner goal: +10pp over the v0.8 a19 above): six proposals, all measured with the live game's
synergy variants and split pass. Draft and setup levers are closed (P15, P17); the only gains found are fight-side and
about a point each — the re-fitted leaf (+0.9 to +1.8pp) and a19 leaving its split slots empty (+1.1pp). Stacked they
measured 51.41% over 8,000 games (P21), short of gate 2 and far short of +10pp. Nothing was shipped overnight.

## Open for the owner

Nothing here is deployed. Prod still runs the 2026-09-13 versatile draft; the test server runs the r4 draft on common
afa19bc (redeployed 2026-09-22/23) without P6–P11. The self-play gains are large, but every one of them was measured
against the bot itself: the next evidence has to come from people. Deploy the current server main to the test server,
let humans play it, and re-run `live_report.py` on a fresh export — the AI won 11 of 26 decisive games against humans
before this program.
