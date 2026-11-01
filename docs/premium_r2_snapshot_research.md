# Premium evidence to R2 draft research

Registered on 2026-10-25 before fitting or evaluating either candidate. Status: **pilot complete; neither candidate qualified for a larger campaign or production**.

The objective is a completed-match improvement over the current complementary-R2 A19, using the Premium snapshot as offline training evidence. Snapshot queries alone do not change the bot's policy. This experiment exports fitted per-creature draft effects; combat, setup, placement, artifact selection and all other draft rules retain the control's implementation.

## Frozen control and routing

Common source is frozen at `14797055f380c811765db71ad534791051b22dd7`: horizon 64, complementary actor/lap-aligned R2, shortlist 6 and max melee 10. The server search, draft and setup sources are captured separately. The parser reads their literal defaults without importing server configuration or credentials. Both seats use the captured material arbitration, certified selection bounds and uniform allocation. Offline deterministic work prevents host load from shortening decisions.

The draft is `ranked-unit-strength-a19-side-v4-w16-r4`, setup is `artifact-fit-v6:conditional-v1:sniper+t2a19`, and both seats take Battle Trance. The live draft reducer, side-oriented board, rolled synergy variants, tactical splits, funded augments, native stack quantities and both physical battle mirrors remain enabled. Maps are Normal, Lava and Block. This evaluates the captured source configuration; it does not establish which commit a deployed service currently runs.

The M4 Max runs 12 workers. The common source archive and every runtime source file are fingerprinted. Each stage checks the 586 frozen source files before and after execution, excluding only the explicitly declared research-prior overlay. The shipped V4 prior is separately checked for byte identity.

During the pilot, main advanced to `e55cf7883f26172c15fc74f3e03ac075f327425c`, which isolates higher-budget reference queries from the complementary R2 sample prefix. The running arms retain their original frozen source. Their results must not be relabeled as measurements of that later revision. A promising candidate needs separately frozen current-engine qualification with unchanged fitted coefficients before any promotion.

## Training and candidates

The input is the reviewed historical snapshot `1ed2eddf4bc1d3c5c23b8e64`, source fingerprint `5d46fb2f9e728b3c1dcb7d27f045c865bb4046d337aaa413d0b5bff01ec76f8e`. Only its ranked-draft training partition enters the fit:

- 1,205 independent families, retaining both mirrored games together.
- 2,379 decisive games; 31 training draws are excluded to match the existing strength fitter.
- All 145 validation and 150 test families are excluded.
- Public-roster setup and retained draft artifacts are required; rejected-action records are refused.

The existing `fitUnitStrength` fitter uses ridge lambda 4 and 200 whole-family bootstrap samples, seed `2710200000`. A creature needs 50 independent training families for its new effect to be eligible. The two prespecified candidates are:

| Candidate  | Effective conservative creature effect                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Full refit | New fitted effect for supported creatures; otherwise retain the incumbent effect                                  |
| Half blend | Half the incumbent effect plus half the new effect for supported creatures; otherwise retain the incumbent effect |

Both retain weight 16 and shooter floor 4. The isolated source capsule uses the existing V6 policy parser as an execution alias, without the synergy or ranged-count suffixes. The overlay is explicitly identified in every stage manifest. This is not an evaluation of the historical V6 prior. Only `conservativeLiftPp` is replaced; copied historical metadata in the alias is not a fresh fit statistic. `fit.json` contains the actual new fit statistics.

This training evidence is observational, comes from an older engine and includes varied doctrines and setup plans. Its coefficients are neither isolated creature effects nor live win probabilities. Fresh R2 battles decide whether the resulting draft policy improves play.

## Fixed stages and decision rules

| Stage                        |  Base seed | Allocation                                          |
| ---------------------------- | ---------: | --------------------------------------------------- |
| Functional smoke             | 2710240000 | 12 games per arm; excluded from strength estimates  |
| Alias A/A                    | 2710250000 | 96 alias games and 96 paired unchanged games        |
| Pilot                        | 2710260000 | 240 games per arm: unchanged control, full and half |
| Reserved qualification       | 2710300000 | 6,000 games for one finalist                        |
| Reserved confirmation        | 2710400000 | 8,000 fresh games for that finalist                 |
| Reserved reference opponents | 2710500000 | 2,000 games per reference opponent                  |

The pilot contains 60 independent offer boards, each with both draft seats and both battle mirrors. Every arm uses the same offer and combat seeds. All three maps have 20 boards and 80 games per arm. Analysis waits for every registered pilot game, without choosing a candidate from intermediate outcomes.

The primary outcome is draw-aware score: win 1, draw 0.5, loss 0. Paired differences are averaged within complete four-game offer boards. The interval uses 20,000 whole-board bootstrap resamples, with seeds `2710260060` and `2710260061` for full and half respectively. Each comparison receives a 97.5% interval, adjusting the two prespecified comparisons to a nominal 95% family confidence level.

A candidate proceeds only if its score is at least 52%, its adjusted paired-improvement interval is above zero, at least ten offer boards change, every allocated seat/map is present, and no action is rejected. Otherwise that candidate stops. If both qualify, the larger adjusted lower bound selects the sole finalist; an exact tie favors full. **The pilot cannot promote a policy.**

The reserved promotion target is a head-to-head point score of at least 55% in both fresh qualification and confirmation, with the adjusted interval excluding 50%, worst-map score at least 49%, no rejected actions, a reference-opponent paired regression lower bound no worse than -2 percentage points, and no more than 20% decision-latency regression under equal live budgets. Live latency needs a separate measurement; elapsed time from these loaded-host offline games cannot establish that gate. Any change to the candidate or decision rule requires a separately registered experiment and fresh deciding seeds.

## Pilot results

All 720 pilot games completed: three arms on the same 60 fresh offer boards, with 240 games per arm. The unchanged control scored exactly 50% in every four-game board cluster.

| Candidate  | Wins / losses / draws | Draw-aware score | Paired change | Adjusted interval for change |
| ---------- | --------------------- | ---------------: | ------------: | ---------------------------: |
| Full refit | 114 / 120 / 6         |           48.75% |      -1.25 pp |            -8.13 to +5.42 pp |
| Half blend | 126 / 108 / 6         |           53.75% |      +3.75 pp |            -1.04 to +8.33 pp |

Intervals are the registered 97.5% whole-board bootstrap intervals for the two prespecified comparisons. Both span zero. The half blend has a positive point estimate, but its lower bound fails the go/no-go rule. The full refit also fails the point-score requirement. **Both candidates stop.** No qualification, confirmation or reference-opponent games are launched. Neither result proves a strength improvement, and the full refit's interval does not establish harm either.

| Candidate  |  Normal |    Lava |   Block |
| ---------- | ------: | ------: | ------: |
| Full refit | 56.875% | 43.750% | 45.625% |
| Half blend | 55.625% | 53.125% | 52.500% |

Each map contains 80 games per arm. These descriptive map scores do not qualify a subgroup rule or override the failed primary gate. Do not retune these candidates on the pilot boards or relabel the unused validation/test families as fresh deciding data.

Full refit changed setups on all 60 offer boards. Half blend changed 48 boards; all 92 individual half-blend games retaining the control setup reproduced its complete battle trace and outcome exactly. The registered canonical validation passed the balanced seats, mirrors, maps and seed identities. All pilot arms had zero rejected actions. A separate recount reconstructed each per-game score and paired difference and matched both reported results.

There were 960 new battles in total: 720 pilot, 192 paired A/A and 48 functional-only smoke battles. Smoke and A/A games are excluded from the strength intervals. The three pilot arms took 242.32, 253.99 and 278.22 seconds on the loaded M4 host. These are diagnostic collection times, not a live decision-latency comparison.

## Completed validation

All 24 focused R2 profile, complementary sampling and server-profile parsing tests passed. The alias A/A completed all 192 battles in 106 seconds. Every corresponding setup fingerprint, full battle behavior hash, outcome and seed matched the unchanged policy exactly. Both arms had zero rejected actions. These results validate the harness, not strength.

After the pilot, the same focused suites on the updated `e55cf788` checkout passed 25 tests and 263 assertions. This checks the updated R2 integration; it does not turn the frozen pilot into a strength measurement of that newer revision.

One preflight initially checked a nonexistent internal `chanceSampling` field. It was corrected to the existing `complementaryR2` boolean before any battle ran in that attempt. Its failure log is retained. An initial 12-game functional smoke omitted the canonical `LIVETWIN=1` environment flag; it is excluded from strength analysis, and all later stages set the flag explicitly. The exact A/A runner is preserved under its original manifest hash. A later allocation guard permits confirmation's registered 8,000 games, which are divisible by four; it does not change worker simulation code or the current balanced allocations.

Generated inputs, source capsules, recipes, source hashes, logs, manifests and records remain outside Git under the client repository's `game/core/tmp/premium-r2-draft-20261025`. Never relaunch a completed stage into the same directory or pool failed/partial stages into a deciding sample. No serving snapshot or shipped default is changed by this experiment.
