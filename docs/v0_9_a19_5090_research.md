# v0.9 training against current A19 R2

Research plan updated on 2026-10-26 UTC. Target: train on Puffalo's approved RTX 5090 and beat the current complementary-R2 A19 controller. **GPU launch is disabled while the corrected engine and its fresh data qualify.** No research artifact is promoted automatically.

The first budget is a 48-hour proof of progress. Report CPU actor time, learner time and time waiting for GPU access separately. GPU availability is currently an external dependency: authenticated SSH succeeds, but NVML reports OS-blocked access and the existing PyTorch environment sees zero CUDA devices.

## What changed from the earlier v0.9 plan

The previous a13 campaign scored 40.89% over its 48,000 recorded outcomes. It does not qualify a challenger against current A19. Its plain v0.8 fallback, historical rules and 25 ms neural-only qualification route also do not describe the present target.

The primary opponent is the complete current A19 composite: H64, complementary R2, shortlist six, current candidate limits, material tie arbitration, certified/tight bounds, ranked draft/setup, supply, synergies, splits and terrain. Preserve the exact engine/profile throughout a registered trial. Production changes require an explicitly admitted baseline and fresh confirmation.

The first campaign used commit `80180ef46464daf3b580e98a2e7f1ebad92a3d87`. The CPU readiness audit reproduced an aura rollback bug: restoring shared objects separately broke reference relationships between an ability, its source unit and projected cells. A first patch fixed four regressions but still failed when only the unit or only the aura cache was touched. That campaign's research admission was revoked and its CPU/GPU continuations stopped before any GPU use. Its accepted artifacts are preserved as historical evidence.

The replacement actor is based on `e1b56f87b9df56e8fa263405fec0d40c90058f0c` plus the completed snapshot fix. Its source SHA is `9fdcdc59854acbab6b91b1d7e97517607608e6dee37148cd36200f66fff0638f`; snapshot SHA is `784e95bf78a4c47350f530b81901e11b12199b3649f6638212e690c75abd4fa6`. Its root seed is `2026102681`, and the reserved student root is `2026102683`. All army/offer, setup and combat seed channels exclude older observed and reserved banks. The six aura regressions pass. The Linux comparison completed 96 games and 2,564 root witnesses, checking both actual R2/R8 configurations, with zero full-record, action-trajectory or state/reference-graph mismatches against full snapshots. The 48 shared Mac/Linux games also matched exactly, including 1,288 root witnesses. The exact frozen actor passed all 7,188 tests across 555 files, including the six aura regressions, with zero failures. Source typechecking, targeted lint/formatting and all 14 Python readiness tests pass. The snapshot fix is now published as `6cb91b96d9b1b87daf47b006fd3813abebfa5522`; every frozen actor input matches the current shared checkout. All three captured server profile files also remain unchanged.

The CPU-only workflow resumes accepted receipts on that source. It normalizes the WSL directory aliases before invoking the frozen tools. A registration checksum bookkeeping error was repaired before any student trial or GPU fit; only the checksum changed, all reserved seeds and the original registration time were preserved, and the game validator accepted the repair. The original registration and repair receipt are retained. Recovery keeps the original 24-hour wall budget and cannot enable GPU work. It does not enable the GPU continuation. Fresh teacher qualification, fresh corpora and every-row CPU preparation must follow admission; neither historical corpus admits the new source. This work does not publish a peer's changes, and production promotion remains separate.

A fresh AB/BA timing diagnostic covered 96 full games per arm. R4 took 161.090 seconds and R2 took 95.798 seconds: **40.53% less wall time**, 39.29% less CPU time and 1.682 times the throughput. This measures full fights on the frozen research integration. It does not establish a corresponding GPU-training speedup or production latency. Historical R2/R4 strength uncertainty remains documented in the A19 profile.

## Qualify the labels before funding the corpus

Two offline teachers were registered with separate board banks on the original engine:

| Teacher                                      | Screen games | W / L / D      | Draw-aware score | 95% board-bootstrap interval | Decision           |
| -------------------------------------------- | -----------: | -------------- | ---------------: | ---------------------------- | ------------------ |
| Independent R4, wider shortlist/catalog      |          768 | 368 / 381 / 19 |           49.15% | 46.42–51.89%                 | Stop               |
| Independent R8, production shortlist/catalog |          768 | 418 / 343 / 7  |           54.88% | 52.54–57.23%                 | Fresh confirmation |

Each independent offer/army board contributes four correlated games, including both physical seats. Resample entire boards. Do not count the four games or individual rollout samples as independent boards.

The original R8 teacher subsequently scored 3,284 wins, 2,629 losses and 87 draws over its complete 6,000-game confirmation: **55.46%**, with the independently reproduced board interval **54.58–56.34%** and zero rejected actions. Every raw board, seed/seat pairing, summary hash and bootstrap endpoint was verified independently. This result belongs to the original engine and does not qualify the corrected engine or a trained student.

The R8 teacher is an expensive offline label producer. On the corrected source it must first pass the new 768-game screen, then its untouched 1,500-board / 6,000-game confirmation must finish with a clustered lower 95% bound above 50% before generating training data. No intermediate score changes the stopping rule. A failed or inconclusive confirmation stops this teacher route.

After teacher confirmation, generate 2,040 training games and 384 validation games on additional disjoint boards, on Linux x64. Sample a deterministic quarter of the teacher's decisions without selecting by outcome. Retain all eight aligned rollout values, actual material tiebreak evidence, the selected action and terminal full-game outcome. Native rollout-policy labels are estimates under that rollout policy; they are not labels from later actual A19 searches.

The separate [actual-controller continuation work](a19_actual_continuation_research.md) did not establish a positive alternative-action signal in its first valid study. The [midpoint acquisition study](a19_midpoint_sampling_research.md) tests whether more informative states can be collected. Outcome diversity is an acquisition result and still needs an action-ranking or learned-policy test.

## Fit a compact model, then test complete games

Use the observation-v2 contract: shared stack encoding, canonical relative geometry and footprints, terrain beneath occupied cells, statuses/abilities, resources, initiative and explicit spell actions. Encode the shared board once, then score legal action candidates. IDs and creature names are not neural inputs.

The first model has 258,595 parameters and separate policy, primary-advantage and terminal-outcome heads. Keeping the policy separate lets it learn the teacher's material/tactical preferences when primary rollout scores tie. Mask missing targets; do not turn an unscored action into a fabricated loss. Choose the checkpoint using the separate validation corpus, then test full-game strength.

The learner runs only after the exact approved GPU UUID, CUDA kernel, source/data contracts and available resources pass preflight. Reuse the pinned working PyTorch environment. The bounded first fit is 20 epochs, batch 32. CPU tensor and export checks do not substitute for a 5090 fit.

The first challenger corrects the final R2 action only among fully evaluated, same-family primary ties, using a positive confidence margin. Missing evidence or abstention returns the original A19 action array, preserving engine target memory. Disabled models take the complete stock path. Offline research faults fail the run and restore hooks. The explicit wall-clock research path reserves 25 ms before inference, abstains near the original deadline, and returns the original action on a model fault or an overrun. Faults and overruns invalidate timing qualification. Neither path is registered as a shipped policy.

Reserve model evaluation before fitting:

| Bank              | Independent boards | Games | Use                                           |
| ----------------- | -----------------: | ----: | --------------------------------------------- |
| Development       |                192 |   768 | Choose the model and complete correction rule |
| Untouched primary |              1,500 | 6,000 | One locked challenger against frozen R2       |
| Secondary R4      |                750 | 3,000 | Separate rollback-reference comparison        |

The diagnostic smoke uses three development boards. An untrained fixture may run only this smoke and cannot consume a strength bank or become a finalist. Actor, corpus and student banks have disjoint army/offer, setup and combat seed channels.

Before locking a finalist, verify the actual fitted export against CPU PyTorch on at least 96 validation states, including entity and candidate permutations. Require disabled-model trajectory/reference parity and actual production-CPU wall-clock turn measurements under the same A19 profile. The collector includes the native incumbent, complete search, feature extraction and neural correction; action application and rendering are outside the AI decision measurement. Timings from a development Mac cannot satisfy production qualification. The readiness receipt binds all evidence to the exact model, source, runtime and confidence margin. Live p99 and maximum decision time must fit the current deadline/breaker envelope or the measured stock baseline when it already exceeds that envelope.

Lock one complete challenger before opening the primary bank. The research progress gate is **at least 55% draw-aware score with a board-clustered lower 95% bound above 50%**, zero rejected actions and qualified turn timing. A subgroup or the secondary R4 result cannot rescue a failed primary result. This research gate does not authorize deployment; the old production v0.9 qualification contract needs explicit revision for current A19 and this architecture.

## Execution and receipts

The implementation lives in `src/simulation/v0_9/a19_pilot*`, `a19_observation.ts`, `a19_inference*`, `a19_correction.ts`, `a19_model_smoke.ts`, `a19_live_readiness.ts`, `a19_student*` and `python/a19_*`. Freeze a source capsule; do not run a campaign from the shared editing tree. Keep evolving evaluation and orchestration helpers outside the immutable actor source. Student tooling may add those modules while preserving every actor-era source byte. Fixing an evaluation helper must not force relabeling an unchanged engine corpus.

`python/a19_pilot_controller.py` runs qualified CPU stages with at most 24 simulation workers on Puffalo. `python/a19_prepare_fit.py` reads and collates every fresh training/validation row on CPU, verifies source/file hashes and independent phases, checks feature shapes/ranges, and backpropagates through a worst-sized actual batch. It requires admitted research-engine evidence before reporting ready for GPU. Data preparation taking more than a minute stops admission for optimization before GPU use. The queued scan has an empty CUDA visibility mask, so it cannot use either GPU.

`python/a19_gpu_continuation.py` requires that complete CPU report, admitted and idle approved 5090 access, and a released hold. **The first completed epoch must arrive within 120 seconds; active fitting is capped at 1,200 seconds.** Measured epoch time that projects past the cap, invalid metrics or a failed prerequisite stops the job and retains accepted checkpoints. The initial epoch belongs to the same planned fit; a successful canary does not restart it. GPU waiting/generation is not a running CUDA learner. The worker exits after fitting, before CPU match evaluation.

`python/a19_development_controller.py` can then run export parity, smoke and the 768-game development bank. It cannot lock a finalist or start either untouched bank. All continuations have a wall limit, preserve accepted output, and yield their own simulation children when other jobs need the shared account. The old GPU/development watchers were stopped during the audit. The replacement workflow runs in CPU-only mode with the real process CUDA mask empty, including the exact-learner rehearsal. It stops if the engine, software, teacher or data gates fail. Any later GPU continuation still requires complete CPU readiness and a released hold.

## CPU readiness evidence and remaining gates

The completed-source Linux CPU rehearsal ran the exact frozen learner loop on 30 training and 20 validation smoke decisions for four epochs, with 18 checked finite-gradient steps. It verified identical uninterrupted/resumed weights, recovery from an orphan export and rejection of a different training schedule without changing the accepted checkpoint. The real CUDA mask remained empty and every optimizer parameter stayed on CPU. Hardware admission was explicitly marked unqualified; the weights cannot initialize a normal strength trial.

That diagnostic export matched independent Linux CPU PyTorch over all 50 smoke states, with maximum absolute error `1.54e-7`, zero resolved ranking mismatches and passing entity/candidate permutations. Pre-GPU software admission requires at least 32 such states; the later actual trained-export gate still requires at least 96 fresh validation states.

The same completed-source model passed the 36-game ranked pipeline smoke on both Mac and Puffalo. All complete records, action trajectories and correction counters matched across platforms. Each run included twelve active matches and twelve exact matched abstentions, with 183 inference calls, 109 accepted corrections and zero rejected actions.

The completed-source Puffalo live collector then passed 48 games: twelve exact native/disabled trajectory pairs with identical action references, plus matched wall-clock baseline/candidate cases. It made 178 live inference calls and 118 accepted corrections with zero model errors, inference overruns or rejected actions. The candidate p99 was 1,001.46 ms versus 876.90 ms for the baseline; the candidate maximum was 1,067.56 ms. These are diagnostic weights, a deliberately low confidence margin and a research Xeon, so this does not qualify production timing. The actual trained model must still pass the registered timing gate on the production CPU.

The 48-game A/A gate passed at exactly 50%. The fresh 768-game teacher screen is running with six processes and four workers each. A metadata-only audit found zero overlap between all 14,265 reserved campaign/student seed channels and the 1,071 channels in the two concurrent R8 reference/bounds studies. No outcomes were opened for that audit.

| Gate before spending on a full GPU fit                             | Status                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Correct rollback behavior and engine regression suite              | 7,188 tests and 96 Linux reference games passed                                      |
| Exact learner, checkpoint/resume and export rehearsal              | Passed on CPU                                                                        |
| Active neural game path and disabled-model identity                | Passed on both platforms; complete records and trajectories match                    |
| Wall-clock research collector, deadline reserve and fault fallback | Implemented and exercised; production-CPU qualification remains after the actual fit |
| Corrected teacher qualification                                    | Fresh 768-game screen running; independent confirmation follows if it passes         |
| Complete corrected corpus and every-row CPU scan                   | Runs only after teacher qualification                                                |
| Approved GPU/CUDA/backward kernels, memory and throughput          | Requires restored access and the bounded initial epoch                               |

Fresh GPU probes still fail from `agent-zinc`: both the normal and direct WSL NVIDIA tools report OS-blocked access; unmasked PyTorch sees zero CUDA devices, and direct WSL `cuInit` returns 100. Clearing device masks and selecting the WSL driver library explicitly did not restore access. GPU launch remains disabled. The current CPU-only workflow cannot release it even if its checks pass. A guarded fit remains limited to the approved device and the budgets above. Numerical readiness does not guarantee a winning learned policy; the registered development and untouched complete-game tests determine that result.

`a19_student_eval.ts` exposes `init`, `run`, `verify`, `qualify`, `lock` and `finalize`. `qualify` requires model-bound CPU parity, disabled parity and production timing receipts. `lock` requires completed smoke/development plus verified readiness. Confirmation requires that exact exclusive lock. Immutable raw boards, source/model hashes and independently reconstructed summaries make resumed and completed results reviewable.

Keep generated data, model weights and reports outside Git, normally under `game/core/tmp` or the admitted Puffalo workspace. Preserve historical campaigns and failed experiments with their original identities. Never overwrite or relabel them as current qualification.
