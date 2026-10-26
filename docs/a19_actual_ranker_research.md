# A19 actual-controller action ranker

Registered on 2026-10-25 against common `80180ef46464daf3b580e98a2e7f1ebad92a3d87` and the captured server `a19-material-r2-v1` profile. This is offline research. No serving policy, premium snapshot, engine routing or deployment changes automatically.

## Question and scope

Can a small, cheap rule improve the final R2 action using labels from continuations of the actual R2 controller? The parallel v0.9 campaign learns from eight private native-policy rollout samples. This experiment instead predicts matched terminal outcome differences after a root action, with complete H64/complementary R2 decisions on both armies thereafter.

The [first valid actual-continuation study](a19_actual_continuation_research.md) supplies 24 development army families. Only its four discovery worlds for every candidate are training labels. Its outcome-selected challenger validation labels are excluded. The earlier invalid observer corpus is excluded entirely. The [midpoint sampling study](a19_midpoint_sampling_research.md) did not qualify its acquisition rule; it supplies neither counterfactual labels nor training examples here.

Forty-eight fresh independent ranked offer/army boards add one root each. Root selection remains the existing outcome-blind team/phase/hash sampler; no entropy filter, creature exception, favorable-root replacement or outcome-based sampling is added. All finite actually-scored retained actions, up to seven including the incumbent, receive four paired post-root combat worlds.

Preserve the original match/search seed, unit IDs, UUID counter and complete action prefix. Reseed only combat randomness after the original root search. Before labels, compare native and unchanged-observer post-action battle state, target memory, damage statistics, UUID and next eight random draws for all planned root/world pairs. Capped or stuck results are invalid labels, never fabricated draws.

## Locked rule

`src/simulation/a19_continuation_ranker.ts` is an isolated research module. It has no production registration or environment hook.

The learner uses 38 fixed semantic action, damage, movement, target and exposure inputs. Features are alternative-minus-incumbent differences. It excludes names, IDs, spell-name one-hots, the legacy `isNativeIncumbent` indicator, absolute board coordinates, future actions and game results. Returned R2 values are allowed as a comparative feature; pruned returned values are not exact complete-sample means or calibrated probabilities.

Targets are mean terminal-score differences between each alternative and the original R2 choice, paired across four combat worlds. Win, draw and loss score 1, 0.5 and 0. Each independent army family has equal total training weight regardless of its retained-candidate count. Antisymmetric training rows force a zero intercept.

Use RMS scaling estimated from development families, clipping at four, fixed ridge L2 0.25 and 32 whole-family bootstrap fits with seed `2720370000`. No hyperparameter search. A candidate may replace R2 only if its ensemble mean advantage exceeds 0.05 and its lower ensemble decile exceeds 0.025. The highest eligible mean wins, with an action-signature tie break. Otherwise return the original exact action-array reference. The ensemble decile is an abstention heuristic, not a causal confidence bound.

Family-excluded development predictions diagnose generalization but cannot change the model, thresholds or gates. Fit once using all 72 families; lock the complete model, training data, source and settings hashes before opening the screen. Independently reconstruct all 32 coefficient vectors using Python dense Cholesky, separate from TypeScript's conjugate-gradient solver.

## Fresh complete-game gates

All phases use the current ranked draft/setup, live terrain, Battle Trance, native supply, rolled synergies, side-board placement and tactical splits. Four canonical draft-seat/battle-mirror games belong to one independent offer board. Resample entire boards, not individual fights or combat worlds.

| Bank               | Independent boards |                          Full games |         Seed |
| ------------------ | -----------------: | ----------------------------------: | -----------: |
| New training roots |                 48 | Outcome labels, not a strength bank | `2720350000` |
| Screen             |                192 |                                 768 | `2720360000` |
| Qualification      |              1,500 |                               6,000 | `2720380000` |
| Confirmation       |              1,500 |                               6,000 | `2720390000` |

The screen requires complete valid games, zero rejected actions, at least 20 boards with accepted changes, draw-aware challenger score at least 52%, and a 95% whole-board bootstrap lower bound above 50%. The 6,000-game qualification opens only after that passes; fresh 6,000-game confirmation opens only after qualification. Both use the unchanged model and the same score/interval rule. No subgroup rescue, extra batch, refit or pooling across failed gates.

Use 20,000 bootstrap draws with seeds `2720400000`, `2720410000` and `2720420000`. A separate Python audit reconstructs raw outcomes, integer board-score bootstraps and gate decisions. At most 12 simulation workers run on the M4 Max. Disabled-model full-match parity and exact retained-action legality are prerequisites.

Operation-bounded Mac research timing is not production timing. Even passing every strength gate would still require complete live-path production-CPU latency measurements including stock search and feature extraction before promotion.

## Execution record

Artifacts live under ignored `game/core/tmp/premium-r2-outcome-ranker-20261025`: source archive and overlays, registration, sealed tools, server profile, per-root state/selection receipts, exact-state guards, raw terminal branches, fitted model, independent model reconstruction and complete-game records. Generated results and weights remain outside Git.

The frozen build passed **7,188 tests with zero failures**, plus TypeScript and generated/JSON copy steps. The 15 focused tests cover actual-engine observation/intervention parity, unchanged action-array identity, RNG restoration, policy failures and invented actions, family weighting, deterministic fitting, irrelevant-feature exclusion, missing evidence and malformed data.

## Result: closed after the screen

The locked rule scored **46.03%** against stock R2 over all **768 fresh complete games from 192 independent offer boards**. The whole-board 95% bootstrap interval was **43.95–48.05%**. Outcomes were 348 wins, 409 losses and 11 draws. The rule changed 1,751 decisions in 642 games, spanning 191 boards. It failed the registered score and confidence-interval gates. This is evidence against this particular rule under the frozen profile.

The 6,000-game qualification and 6,000-game confirmation banks were never opened. No model refit, threshold change, extra replication batch, subgroup rescue or pooled estimate followed the failure. **The candidate is closed; serving R2 and the premium snapshot remain unchanged.**

All 48 new training roots completed: 22 unit types, 240 retained actions, 960 terminal labels and 22,413 actual R2 decisions after the training roots. The three excluded smoke families added 56 terminal branches. All 204 root/world state pairs matched before labels, corresponding to 408 stopped prefixes. Twelve disabled-model smoke games each reproduced a separate plain-controller replay.

Together with the earlier valid all-candidate discovery data, the fitted model used 72 development army families and 1,448 terminal labels. Independent Python Cholesky reconstruction of all 32 fitted coefficient vectors differed from TypeScript conjugate gradient by at most `1.3893e-9`. Separate Python predictions matched the exported model on all 72 development roots, including candidate-order reversal. The fitted model's SHA-256 is `4ce16103eb4161eb837a747f1f003aa008dc61ea265f3d84307131734649bf7c`.

Family-excluded development predictions changed eight of 72 sampled root decisions, with a descriptive mean observed gain of only +0.35 percentage points. Those development diagnostics supplied no strength qualification. The all-turn fresh-game result is the decision-making evidence; successful coefficient reconstruction or a small development gain cannot substitute for it. The outcome does not establish that actual-controller labels or another model architecture are ineffective.

The campaign completed **1,961 new full-match replays**, excluding the 408 stopped prefixes and the previously generated development corpus. No rejected actions or censored training/strength outcomes occurred. Python independently reconstructed terminal labels, source/seed guards, the exact integer board-score bootstrap, the closed gate, and every reused discovery label's original raw-result hash. A supplementary audit checked the ranked record's actual `rejectedCandidate` and `rejectedOpponent` counters. All frozen source/tool/model hashes remained intact.

Inference-only research timing averaged 0.147 ms over 19,042 calls, with a p99 of 0.237 ms and a maximum of 151.249 ms on the loaded Mac. These figures exclude feature extraction and stock search and do not qualify live production latency. No timing-based promotion was attempted after the strength failure.

The final freshness audit still matched common/client pin `80180ef4`, server commit `ba65c37c485f2c99f1a16abdaa33954c09ac39a4`, the server's common dependency pin, and all three captured search/draft/setup source files. No publication or deployment occurred.

The self-contained `report.html` includes every registered family and a terrain filter; it was visually inspected, all 192 rows were checked, and the lava filter reproduced the expected 64 families. Raw labels, model, independent receipts, full-match records and registration remain in the ignored artifact directory. All 72 training families remain development data for future learners; this failed screen cannot become fresh confirmation for a refitted challenger.
