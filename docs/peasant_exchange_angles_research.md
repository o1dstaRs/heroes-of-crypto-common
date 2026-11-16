# Peasant retaliation: movement, late stacks and separate bonus effects

The broader investigation confirms that Bitter Experience armor can change a battle result. It has
**not established a stronger attack-selection policy**. Across 30 fixed one-turn alternatives, forcing
the proposed attack changed 29 complete trajectories but no final win/draw/loss. Removing just the
earned armor changed one of those wins into a loss and another into a draw. Removing just the earned
movement changed no final result in this sample.

This is `peasant-exchange-angles-20261116`, a distinct diagnostic study. The closed
`bitter-experience-cheap-response-v1` helper, its failed gates and its evidence remain unchanged.
No Peasant policy, neural weights, serving default or Premium routing changed. The compact record is
[`evidence/peasant_exchange_angles_20261116.json`](evidence/peasant_exchange_angles_20261116.json).

## Fresh sample and execution

Before opening any battle outcomes, the study selected the first two own-Peasant native drafts per
pick order in each map / own-doctrine / opponent-doctrine stratum. This yielded **108 families**,
covering all three maps and every 5/6/7-point doctrine pairing, after examining 417 drafts from a
prospective 2,592-family pool. Both physical seats and two combat futures produced 432 battle cases.
Each ran with observation off and on: 864 battles, plus 36 complete cold replays.

Observation added no rollouts or random draws. It captured the existing leaf exchanges, full-search
membership and the final per-instance A19 neural choice. Every off/on trace matched, and all **1,933
observed Peasant choices** matched the actual committed turns. The earlier prototype-selector mistake
was not repeated. Source identities, raw/compressed hashes, openings, health ledgers and zero rejected
actions/model errors were independently checked.

The 32 prospective continuation buckets crossed moving/stationary, lap below/at least five, stack
above/at most 20 creatures, and four net-HP cost bands: at most 5%, 5–15%, 15–30%, and above 30%.
Thirty buckets occurred. Each selected the first alternative different from the final native action,
or a chosen-action control if there was no alternative, using fixed family/seat/future/root/catalog
ordering. Selection did not read terminal outcomes or full-horizon scores. A nominated leaf had to
survive and earn a bonus from its actual target's available melee response; Hidden targets and actions
other than move/select-attack/melee were excluded.

Each selected root ran five continuations: native, force the nominated attack once, force it with only
the earned armor removed, with only the earned movement removed, and with both removed. Ordinary AI
resumed afterward. All five were cold-replayed: **300 continuation executions**. Together with the
audit, this gives **1,200 verified executions**. Twelve earlier technical admission executions are
separate; nine interrupted first-pass cold rows are preserved but excluded from that count.

The ablations are synthetic mechanism controls, not legal strategy variants. They remove only the
bonuses earned during the nominated target's actual response, from both current and initial stats.
They retain HP, casualties, proc counter and all other effects. The 120 non-native initial continuations
had identical first responses before removal, all earned the expected single bonus, and all executed
the nominated action. All 150 turn prefixes matched native before the intervention. The one nomination
identical to native reproduced the complete native trace.

## What the AI already does

These are descriptive counts of actual native choices, not independent statistical samples:

| Observed native behavior                  | All Peasant roots | Late, at most 20 creatures |
| ----------------------------------------- | ----------------: | -------------------------: |
| Decision roots                            |             1,933 |                         96 |
| Melee choices                             |             1,181 |                         96 |
| Received positive target-response damage  |               754 |                         64 |
| Earned Bitter Experience from response    |               667 |                         39 |
| Earned it for at most 5% response HP cost |               140 |                          2 |

All 96 small late-game roots already had at least one Bitter Experience stack. This does not prove
that every target choice is optimal, but it rules out describing retaliation farming as wholly absent.

The leaf catalog contained 9,375 distinct root/action observations and 5,325 eligible bonus-earning
exchanges. Of those, 1,987 were outside native full search. This is coverage of alternatives, not proof
that the excluded alternatives are better. Of the 30 nominated continuations, 11 were outside full
search, 29 differed from the final native action, and 22 changed its melee target.

## Continuation results and causal detail

| Continuation             | Better than native | Worse than native | Same result |
| ------------------------ | -----------------: | ----------------: | ----------: |
| Force attack, full bonus |                  0 |                 0 |          30 |
| Remove earned armor      |                  0 |                 2 |          28 |
| Remove earned movement   |                  0 |                 0 |          30 |
| Remove both              |                  0 |                 2 |          28 |

Native and full-bonus forced continuations each had 21 wins and nine losses. These selected roots
share only 21 battle cases and 14 draft families; do not report a population win rate, an independent
30-game confidence interval or a +5-point policy gain from the ablation contrast.

- **b03, lap three, 67 Peasants, Valkyrie response:** the forced trade cost 190 of 534 HP and earned one
  bonus. Native instead attacked Zena and also won. With armor retained, forcing Valkyrie still won;
  removing the earned armor lost. The first later trace difference was Orc choosing Peasant instead
  of Beholder as its ranged target. The effect includes the opponent's changed decisions, not solely
  a fixed sequence of smaller damage numbers. This expensive trade did not improve on native play.
- **b08, lap five, 58 Peasants, Cyclops response:** the forced trade cost 47 of 459 HP and earned one
  bonus. Native won without taking damage on that turn. The forced full-bonus continuation also won;
  without the earned armor it drew after Armageddon. The first later difference was the same Cyclops
  melee doing 46 rather than 45 damage. This establishes sensitivity to that armor point in this
  continuation, not that provoking Cyclops was the better decision.

## Mechanical edge cases covered

Eleven new focused tests supplement the nine existing Peasant tests. All **20 tests / 116 assertions**
pass, as do targeted formatting, ESLint and a TypeScript check of source plus the new tests.

- A one-HP hit can kill an already wounded top Peasant and grant the bonus to the surviving small stack.
- Harmless and fatal hits grant no bonus to remove. Existing tests cover Break and the canonical
  response gate, including response damage calculated from the defender before primary damage.
- Each isolated armor/steps/both control preserves casualties and counter through battle rollback.
- At tested base armor values 7, 14 and 21, retaining the bonus reduces ordinary melee and arrow damage
  after normal stat refresh; it does not reduce Fireball or Lightning Strike direct spell damage.
- Gaining the fourth movement point unlocks a legal move-and-strike that three points cannot reach;
  removing only that movement closes it with identical HP.
- At the one-damage floor, another armor point can make no difference to that incoming physical hit.

The movement mechanism is therefore real even though removing one earned step did not change a final
result in these 30 continuations. That result must not be generalized to movement being worthless.

## Coverage limits and the next hypothesis

The two missing buckets were small, early stacks with at most 5% cost, both moving and stationary.
All maps occur in the audit, but the fixed first-per-bucket rule selected 26 continuations on map 1,
four on map 3 and none on Block/map 4. There were 15 moving and 15 stationary continuations, including
16 late roots and 14 small stacks. This is broad mechanism coverage, not exhaustive matchup coverage.
The spellbook-presence diagnostic is not a classifier for active direct-damage casters.

Four of the 30 actual exchanges fell into a different HP-cost band than the screening leaf. Every
actual exchange still earned its predicted bonus, but one existing private-RNG leaf is not an expected
cost or worst-case safety bound. More expensive retaliation can consume useful attackers or postpone
an urgent kill. Armor also has less value against direct spells and damage already at the minimum;
extra steps help only when they change useful future reach. No blanket farming preference is justified.

A plausible next candidate would value **future physical damage avoided and newly reachable useful
attacks against the casualties and opportunity cost paid now**, while retaining native alternatives.
That is an untested hypothesis. It needs a separate identity, bounded legal/public inputs, complete
policy comparisons on fresh channels and serving timing. Do not retune the closed cheap-response
helper, promote either favorable ablation case, or claim the immediate feature omission itself is a win.

## Frozen provenance and reproduction

The private runtime matched all 769 tracked common source files at
`4c1390032a7a71df89620fe7598630e52f46ebb1` and all 509 tracked server source files at
`82336c6981c7679febb1793043fd3671c90cb898`. There were no engine overlays. A peer commit arrived during
preparation; the runtime was refreshed and compared before any battle. Later working-tree edits were
excluded. In particular, this study does not measure the concurrent melee-barrel default adoption.
Future strength comparisons must use that adopted default after freezing it; these diagnostic results
must not be described as qualification against every later source revision.

Original registration SHA-256:
`b2c5617d2ef1e54631120890b3dfe3d9e1f5bdc4f329ea138e64fc8f4bc7de55`.
After all 864 audit battles, the first cold checker distinguished an in-memory `targetId: undefined`
from the absent JSON property on pure moves. All nine emitted serialized cold rows exactly matched
the audit. The separate finalizer normalizes only that comparison, preserves every original artifact
and repeats all 36 cold checks. Its registration SHA is
`656bbb5b15396233e5064d4b8e39ef456bd1105e9cc74e1af035162040c1edf8`.
No source, sample, selection, threshold or hard cutoff changed. Finalization completed at
2026-11-16 17:05:21 UTC, before the original 19:47:59 UTC cutoff, using six nice-19 local workers and no GPU.

The ignored client capsule is `game/core/tmp/peasant-exchange-angles-20261116`. Read
`finalizer-terminal.json`, `analysis.json`, `structural-verification.json` and
`supplemental-analysis.json`; the original controller correctly remains failed. The capsule preserves
the registrations, frozen runtime, scripts, all raw gzip/receipt pairs and correction incident. All
outcomes, including both ablation regressions, remain available. Do not restart the completed pipeline.

Reserve every scanned seed, including rejected allocations and unused draft-pool entries. The compact
evidence records all **29,237 scanned preimages** from namespace
`peasant-exchange-angles-20261116-fresh-v1`. For every preimage, reserve 32 consecutive unsigned raw
channels and their canonical `permuteRankedDraftSeed` values: **1,870,695 distinct channels** in total.
The canonical Bun verifier independently reconstructed the allocation against 23,112,506 earlier
excluded channels from 162 ledgers. Accepted execution-channel assignments are disjoint; the larger
conservative scanned reservation includes rejected overlaps and must remain excluded in future work.
No policy qualification or confirmation bank was allocated.

## Subsequent post-movement coverage study

The separate [post-movement response study](peasant_postmove_research.md) reuses these 108 opened
families against a frozen baseline that includes the user-adopted melee-barrel correction. Its 1,359
verified executions added 51 comparisons but changed no decision or outcome. A separate 112-execution
forced-action audit found one improvement and two regressions; all three earned the same armor bonus
under both choices. The missed win changed the attack square against the same Squire, not the bonus.
The new helper remains inactive, its fixed gates failed, and no fresh channels or default were changed.
Preserve both studies and the full scanned reservation above.
