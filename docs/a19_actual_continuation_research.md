# Actual A19 continuation labels

Registered on 2026-10-25. Status: **complete, independently verified; no promotion warranted**.

The objective is to measure the terminal value of alternative actions when every later eligible turn is played by the real, searched R2 policy. Each branch runs the canonical `runMatch` engine from a reproduced ranked-match prefix. Both armies retain H64/complementary R2 search throughout the continuation. Existing private rollout scores are recorded separately from these completed-match outcome labels.

This work is separate from the wider R4 teacher/model pilot. It contributes actual-policy conditional action-return data. A future learned policy still needs independent position families, full-match strength comparisons and live timing qualification.

## Source and implementation

The engine is frozen at `80180ef46464daf3b580e98a2e7f1ebad92a3d87`, including isolated R2 reference sampling and the passive-barrel/classic-mountain fix. The source capsule adds the isolated `a19_actual_continuation.ts` observer and its tests. The observer is not registered in the game API, simulation index or production strategy. Importing it does not install hooks; one synchronous diagnostic call owns and restores its temporary hooks and deterministic RNG scope.

Server search, draft and setup sources are copied independently and parsed without executing server configuration. The current material/tight-bound R2 settings, `ranked-unit-strength-a19-side-v4-w16-r4` draft, `artifact-fit-v6:conditional-v1:sniper+t2a19` setup, Battle Trance budget, live native supply, side board, rolled synergies and tactical splits are retained. The M4 uses twelve workers with offline deterministic work. Runtime source hashes are checked before and after every stage.

Early engine tests detected a cold-catalog UUID difference: the first match allocated temporary configuration IDs inside seeded combat, while later matches used the cached catalog. The observer initializes that catalog outside combat and restores the caller's RNG/UUID scope. Replayed units, resources, effects, geometry, target memory, UUID counter and action prefix must then match exactly before an intervention. No UUID assignment is normalized or changed to improve an outcome.

## Fixed sampling and labels

The primary sample contains 24 independent ranked offer boards, base seed `2720270000`. One game is taken from each board: game index `4 * board + floor(board / 3) % 4`. Each live map has eight boards, including two of each draft-seat/battle-mirror assignment. Three separate smoke boards use base seed `2720260000`.

Exactly one decision is selected per primary board. It must have at least two distinct retained candidates with finite returned native scores. The selected baseline action is always retained. The other candidates are capped at six and ordered by returned R2 score and stable action signature. Unenumerated and discarded actions are outside this study. A returned score can include certified pruning bounds; it is not relabeled as a complete rollout mean or calibrated probability.

Selection prefers the board-parity actor team and a rotating opening/middle/late phase. Opening means laps one or two, middle laps three through five, and late lap six onward. If that cell is absent, selection falls back to the same actor team in any phase, then all eligible decisions. A stable hash chooses the position within that set. Final outcomes and score magnitudes do not select positions. Missing positions are reported without replacements.

The fresh sample contains all 24 positions and fifteen unit types, with eight positions per map and twelve acting positions per side. It contains twelve opening, ten middle and two late decisions; the fallback rule is material to interpreting its coverage. Candidate counts are fifteen positions with six actions, three with five, one with four, three with three and two with two. The excluded batch is not pooled into this sample.

Discovery evaluates every retained action on four independent post-root combat seeds shared by all actions at that position. The realized 122-action catalog yields 488 complete-match branch tasks; the registered cap allowed at most 672. Exactly one non-baseline challenger is selected per position by its discovery mean, breaking ties by the original candidate index. A negative discovery gain does not remove that position.

Validation tests that fixed challenger and the baseline on sixteen fresh paired combat seeds: 768 branch tasks. Discovery and validation use separate seed domains, and all 480 post-root seeds are checked for global uniqueness before collection. Search-policy seed and the complete pre-action prefix remain fixed. Reseeding occurs only after the original root search and before the chosen action executes. The global UUID counter is preserved.

Only terminal elimination results receive win/draw/loss labels, scored 1/0.5/0 for the root actor's team. Turn-cap and stuck results are censored, not manufactured draws. An incomplete registered position or validation pair prevents a primary gain claim. Any rejected action or prefix/state drift invalidates its stage.

## Statistical scope

The primary comparison first averages the sixteen paired challenger-minus-baseline outcomes within each position, then weights all 24 independent boards equally. The registered 95% percentile interval uses 20,000 whole-board bootstrap samples, seed `2720289000`. The repeated combat seeds provide within-position precision; they do not become additional independent army families.

Per-position paired sign-flip evidence uses the existing `pairedAuditEvidence` implementation. Holm adjustment includes all registered positions, including negative, null and incomplete comparisons. These identify conditional examples under the frozen continuation policy. They do not establish a global all-turn policy gain or a deployable action selector.

The discovery-selected challenger is tested only on its separate validation seeds. All inspected families become development data for a future model; those same families cannot qualify that model as held out. A useful counterfactual return label is also not proof that a cheap learner can predict it accurately enough to improve completed matches.

## Data and validation

The capsule contains complete source and tool identities, the sampling plan, present-state snapshots, exact action sequences and signatures, the native returned scores, candidate feature arrays, independent seed lists and per-branch terminal outcomes and trajectory hashes. Existing feature extraction is reused. Its additional first-action flag has the legacy name `isNativeIncumbent`; in this audit it denotes `isR2Selected`. A dedicated semantic mapping accompanies the data. Whole-match outcomes and validation returns are labels, never inference inputs.

All six new engine tests passed: full-match recording parity, unchanged-action full-match parity, exact seeded post-action state/target-memory/RNG parity, repeatable seeded continuations with real later R2 searches, prefix/catalog rejection with hook restoration, and outcome-blind sampling/runtime guards. The frozen complete common build passed 7,179 tests and TypeScript, followed by the standard data/generated-output copy steps.

All three fresh smoke boards passed native/recording parity, unchanged-action parity, duplicated combat-seed parity and a terminal alternative-action check. Every primary position reproduced the complete native match through recording and unchanged-action replay.

The first batch completed 1,314 full-match replays but was excluded in full after an additional identity witness failed. Its outcome estimates were not inspected. The engine distinguishes an unchanged native action array from an equal copy when committing AI target memory; the copied baseline changed remembered targets in the immediate post-action state. Damage and subsequent RNG draws matched in the inspected failing case, so full-match trajectory parity alone was insufficient. The observer now preserves the original action reference for unchanged interventions. A small Orc/Wolf regression fails on the old behavior and passes with this correction. The excluded records and invalidation receipt remain intact and may not supply training labels or strength claims.

Before collecting fresh discovery or validation labels, the campaign compared the native return against the actual corrected baseline intervention for all 24 primary positions and all twenty planned combat seeds per position. All 480 paired checks passed. Each stopped immediately after the root action and matched full battle state, target memory, damage statistics, UUID counter and the next eight combat RNG draws. The rule excluded the complete fresh corpus on any mismatch, without exceptions. These 960 stopped prefixes do not add fresh strength fights or independent families.

## Verified result

The discovery-selected alternatives did not improve the baseline on the separate validation domain. The mean conditional terminal-score difference was **−2.34375 percentage points**, with the registered whole-board 95% bootstrap interval **[−5.98958, +0.52083] points**. This interval does not establish either a positive gain or a definite regression. No per-position improvement survived Holm correction across all 24 positions.

| Validation result          | Independent positions |
| -------------------------- | --------------------: |
| Positive mean difference   |                     2 |
| Negative mean difference   |                     4 |
| Tied mean difference       |                    18 |
| Holm-supported improvement |                     0 |

The two positive means were a Wandering Mage moving without its melee follow-up (+6.25 points, one improved paired outcome and fifteen ties) and a Cyclops switching from a shot to melee (+9.375 points, six improved, four worsened and six tied outcomes). Their adjusted p-values were both 1. These are development examples, not justified unit heuristics. The negative examples include Hyena and Peasant movement alternatives, an Elf shooting instead of repositioning, and a Fairy choosing a different melee target. All remain in the primary estimate.

The valid campaign completed **1,346 full-match replays**: 18 smoke/control matches, 72 primary recording/identity controls, 488 discovery branches and 768 validation branches. The 1,256 label branches performed **26,699 actual searched turns after intervention**. Every label was terminal elimination; there were zero rejected actions and zero censored outcomes.

An independently implemented Python verifier checked every raw branch's action signature, root/prefix identity, seed pairing, terminal score and discovery selection. It reproduced the exact paired sign-flip p-values, all Holm adjustments, the primary mean and both registered bootstrap endpoints. Its independent RNG implementation first matched 1,000 canonical draws before outcome inspection. All source/tool seals and the 480 post-action state witnesses also passed. Current server search/draft/setup source hashes still match the captured copies, and its package manifest pins the same frozen engine commit.

The self-contained `report.html` shows every action pair, held-out score and paired evidence, with map/result filters. `development-corpus.jsonl` contains 122 candidate-action records, each with separate present-state inputs and discovery/validation label domains. All 24 families are explicitly marked development-only for future model fitting. The complete source capsule, generation scripts, input provenance, independent verifier, raw checksums and excluded-batch receipt are retained alongside them.

## Consequence for further research

Keep the serving R2 profile unchanged. A model fitted to these labels has no demonstrated all-turn strength advantage, and these families cannot be reused to qualify it. The result covers retained alternatives under one intervention, not missing candidates, cumulative decisions or a wider teacher's complete policy.

Nineteen baseline positions produced only wins or only losses across sixteen validation seeds. That observed saturation limits the information this small sample supplies about action quality. A follow-up development collector can preregister present-state uncertainty or candidate disagreement as a sampling rule on fresh families, then measure whether that yields more useful paired labels. Such an enriched sample must be reported as conditional data; full-match strength qualification still needs a separately funded, representative comparison and fresh held-out confirmation.

Generated recipes, records and reports remain outside Git under the client repository's `game/core/tmp/premium-r2-continuations-v2-20261025`; the excluded first batch is preserved under `game/core/tmp/premium-r2-continuations-20261025`. Failed development tests and the initial build type error are preserved separately. No serving snapshot, production default, client or server deployment is changed by this audit.
