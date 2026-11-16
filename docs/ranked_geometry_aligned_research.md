# Action-aligned fast geometry selector

The original planner's independently confirmed **+2.083333 percentage-point gain remains locked**
in `cb5ee84a` and `lockedRankedGeometryCheckpoint()`. This continuation completed the missing
training comparisons and tested a new fast approximation. The approximation **failed fresh
qualification**, losing **1.195988 points** against current A19, with a whole-family 95% interval
of **−2.353395 to −0.115741**. It is not adopted. The original planner remains a separate preserved
research win, with live serving qualification still outstanding.

The user explicitly authorized this continuation on November 16, 2026 UTC. Campaign
`ranked-geometry-aligned-20261116` has registration
`89250a8a697feb0f117a90a4b535606fd418578b6204402bcb82fabb0ad00838` and fresh-stage registration
`2f7aee9900ac111074a95d4f69324c96a9e3965b819b20af3a9c68e443b3b3d8`.
It ran locally with 12 low-priority CPU workers and no GPU, under a separate bounded authorization.
The original geometry and Puffalo teacher-repeat jobs, their registrations and cutoffs were not changed.

## Completed training correction

The original full-plan scores are not scores for the final current-spending action. The fixed
completion ran all **1,824 distinct missing historical battles**, supplying **2,148 logical labels**.
Together with 13,404 exact-input labels already recovered, the dataset contains 15,552 labels across
216 historical families, 432 physical-seat contexts and six plans. No incomplete context was dropped.
All 202 contexts where every plan applies the same state remain represented.

Training used the original common `024cc59c7cb133856b2f594d8c211b2e69ac6cef` and server
`8cc87b86b95546bfd3ad551b8ac74fd66710adba` to preserve label provenance. Both cold replay controls,
all complete input/seed hashes, aliases, raw scores and independently rebuilt paired targets passed.
Training data SHA is `088db76ff661e684a7a7b560be4ee555cc24bf52df70fcd85984e93e4bd40941`.

Three recipes were frozen before collection: linear ridge penalties 10 and 100, and a fixed
256-feature random-Fourier ridge with penalty 10. All use 1,296 public/own-state features and predict
the paired mean gain and minimum of the two hypothetical-future block gains. True action equivalences
are collapsed; the 390 unique noncurrent action samples receive equal weight. Inference requires
predicted mean at least 0.03 and positive predicted minimum block gain, with earliest-index ties and
current fallback. The old failed pilot's development and reserved test files were not opened.

Only own roster, budget, artifacts, doctrine and proposed geometry/kits/barrels, public enemy
identities, map and public synergy variants enter inference. Actual enemy doctrine, upgrades,
artifacts, splits, positions and combat seeds do not. Independent planning nonces construct fictional
enemy scenarios and are not numeric classifier features. Python and Bun agreed on all 432 training
choices per recipe; maximum prediction differences were below 2.2e-15.

## Fresh current-source results

Fresh evaluation froze common `c0bad9439b408fa2d36756933c1442279ff73c04` and server
`82336c6981c7679febb1793043fd3671c90cb898`, including the ranged-aim fix. The comparator retained
locked V3/contextual draft, the adopted ranged setup and full A19 combat on both teams. Native v0.9
combat was not substituted. All 57 creature feature records matched the current engine exactly.

The fixed 54-family development bank completed all 1,296 logical outcomes: 380 simulated fights
and 916 exact duplicates. Each model's comparison uses 216 outcomes per arm.

| Recipe                 | Gain vs current (pp) |  Whole-family 95% (pp) | Actual changes / 108 | Development gate |
| ---------------------- | -------------------: | ---------------------: | -------------------: | ---------------- |
| Linear ridge 10        |            +1.157407 | −0.925926 to +3.703704 |                   15 | Passed           |
| Linear ridge 100       |            +1.388889 |  0.000000 to +3.703704 |                    4 | Selected         |
| Random Fourier 256, 10 |             0.000000 |   0.000000 to 0.000000 |                    0 | Failed           |

Development selected the highest mean among recipes meeting the prospective +0.5-point and
nonnegative-own-doctrine gates. Its intervals are descriptive selection statistics, not confirmation.
Selected model SHA is `889f3d9a66cf00f058f99a63da25d06c5b770600d9e2d5f27cbdc5c93b52b2d9`.
It was neither refit nor replaced after the independent bank opened.

Qualification completed **324 new families**, two physical seats and two actual combat futures,
giving **2,592 logical comparative outcomes**. It executed 1,432 fights; the other 1,160 candidate
outcomes reuse their locked current-plan baseline directly. The raw analyzer's zero
`exactReusedBattles` here counts only explicitly materialized duplicate records; the evidence fixture
also records these implicit current-fallback reuses.

| Arm                 | Wins | Draws | Losses | Draw-aware score |
| ------------------- | ---: | ----: | -----: | ---------------: |
| Current A19         |  616 |    22 |    658 |       48.379630% |
| Selected fast model |  601 |    21 |    674 |       47.183642% |

The paired loss was **−1.195988 points**, 95% **−2.353395 to −0.115741**. All own-doctrine means
were negative: five points −1.967593, six points −0.231481, seven points −1.388889. Actual setups
changed in 68 of 648 contexts. There were ten positive, twenty negative and 294 unchanged families.
This fails the registered +2-point, positive-lower-bound and nonnegative-doctrine gates. The 648-family
confirmation bank stayed unopened and reserved. Do not substitute ridge 10, lower the margin,
select a favorable map or reopen confirmation to rescue this closed candidate.

## Verification and preservation

Six cold native-control pairs passed on all three maps and own doctrines. Admission sampling was
corrected before any fits or fresh outcomes: the initial three indexes covered all maps but only one
own doctrine. The original scripts and preparation records were retained; separate v2 control and
verification scripts supplied the required complete coverage. No model, bank, policy or gate changed.

Independent verification rebuilt every score and interval, all 972 fresh model decisions, complete
consumed battle inputs, trace and health hashes, native health ledgers and unchanged opponents.
Current funded upgrades, legal native splits, spellbooks, positions and barrels were retained, with
zero rejected actions and both-team A19 throughout. No default, deployment or Premium snapshot changed.

Inference alone is fast, but does not establish total serving cost. Parallel qualification measured
roughly 1,598 ms p95 for full proposal preparation and 4.73 ms for features/inference, versus 74.78 ms
for current native setup preparation. These loaded-worker timings are not serial serving qualification.
Neither deadline/state/Undo safety nor the registered complete-setup compute bound was qualified.

The corrected dataset, all three models, sealed code and raw outcomes remain in the client's ignored
`game/core/tmp/ranked-geometry-aligned-20261116` capsule. `HANDOFF.md`, `terminal.json`,
`pipeline-status.json` and the independent verification receipts identify the completed work.
The compact versioned evidence is `docs/evidence/ranked_geometry_aligned_20261116.json`.

Exclude all channels in that fixture, including rejected scans and the unopened confirmation bank.
It supplies `reservedScannedPreimages` for counters 1 through 11,333 in namespace
`ranked-geometry-aligned-20261116-fresh-v1`; conservatively expand every preimage through raw offsets
0–7 and all eight canonical `permuteRankedDraftSeed` values. The original kind-specific ledger contains
26,676 accepted channels, disjoint from 11,115,540 prior exclusions. It also preserves all 27,098
scanned channels, including the rejected scans.
Further models need a distinct registration and fresh independent banks. Corrected labels and a
positive development score do not transfer the original planner's confirmed win to this approximation.
