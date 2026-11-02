# v0.9 training against current A19 R2

## Completed 5090 sweep and iteration speedups — November 2, 2026 UTC

The registered 192-teacher sweep, four student development evaluations and both
queued GPU experiment jobs completed. **The best new student won 53.52% of its
768 development games against the frozen A19 R2 baseline. The previous reference
won 54.04%; this sweep did not establish a stronger replacement or reach the 75%
win-rate target.** No model was promoted and the untouched student banks remain
sealed. These results use the frozen research engine, not subsequent mainline
changes.

All GPU work used one RTX 5090. Workers pin the approved device UUID and require
exactly one visible CUDA device before allocation; sequential GPU jobs hold the
same exclusive lock. Development evaluation is CPU-only. The authorization cutoff
is November 2, 08:00 UTC; this report does not extend that authorization.

### Game counts and strength

Each new student completed the same 192 development boards with four games per
board: **768 games per candidate, 3,072 candidate-game evaluations across four
candidates**. These are paired comparisons on a shared bank, not 3,072 independent
board setups. Smoke tests and performance replays are separate from this count.
The 192 teacher fits are training experiments, not 192 additional game banks.

| Student recipe / reference | Wins | Losses | Draws | Raw win rate | Draw-aware score |
| -------------------------- | ---: | -----: | ----: | -----------: | ---------------: |
| `cf85d3b9dc37`             | 406  | 352    | 10    | 52.86%       | 53.52%           |
| `7e9b9ed69458`             | 411  | 351    | 6     | 53.52%       | 53.91%           |
| `ba817b8a5134`             | 401  | 358    | 9     | 52.21%       | 52.80%           |
| `8539c26d7c62`             | 404  | 354    | 10    | 52.60%       | 53.26%           |
| Prior lower-LR reference   | 415  | 345    | 8     | 54.04%       | 54.56%           |

Raw win rate is wins / 768; draw-aware score is (wins + half the draws) / 768.
The best new student's board-bootstrap 95% score interval is 51.95–55.92%.
The reference interval is 52.73–56.45%. These are score intervals, not raw-win
intervals or a paired significance test. The numerical difference between the
two point estimates does not establish which model is stronger. The separate
6,000-game primary and 3,000-game R4 student confirmation banks were not opened.

### Validated CPU evaluation layout

Six counterbalanced arms replayed the same 64 games: one pool of four, one pool
of eight, two pools of four, then the reverse order. All 384 replayed game records
and trajectories matched after excluding timing fields. Mean wall times were
321.326 seconds, 204.130 seconds and 192.886 seconds respectively. Two four-worker
pools used **39.97% less wall time than one four-worker pool** and 5.51% less than
one eight-worker pool. The former comparison uses twice as many simulation
workers; the latter keeps the same eight-worker total.

A separate complete 192-board / 768-game run with two four-worker pools took
1,710.010 seconds (28.50 minutes), with all records and trajectories matching the
reference. There is no fresh full-bank four-worker timing to pair with that
absolute duration. A subsequent new student's development shards took 28.22
minutes before the summary merge. Timing replays add no independent strength
evidence.

The reusable `python/a19_development_controller.py` now defaults to two processes
with four workers each and caps development at eight workers. The smoke stage
uses one pool with at most three workers, preserving all three boards. The native
evaluator still validates the original manifest, owns disjoint board ranges and
merges the complete bank. Export, simulation and summary subprocesses have empty
CUDA visibility; simulation children use one Bun GC marker. Existing resource
admission, yielding, accepted-board recovery and confirmation isolation remain.
This default is justified for the measured Puffalo development workload, not as a
general claim that two pools are fastest on every host.

### Shorter stopping and GPU backend experiments

The fixed candidate rule uses at least 16 epochs, patience 12 and minimum
validation improvement 0.0001. It retained the selected checkpoint on all 64
previously untouched recipe histories. Their observed prefixes estimate 37.42%
less active fitting time. This is a counterfactual estimate, not measured whole-job
speed. A more aggressive 12-epoch / patience-eight rule changed two selections in
the 96-fit exploratory bank and was rejected.

Three actual shortened reruns, one each at 6.1M, 32.8M and 94.4M parameters,
reproduced every selected weight tensor bit-for-bit and validation exactly. They
used 415.036 seconds of active fitting in total versus 762.075 seconds in their
historical originals: **45.54% less active fitting time**. Batch sizes were reused
from the matching originals and the original learning-rate horizon was preserved.
This is not a fresh paired end-to-end benchmark. Do not change stopping defaults
for a different corpus or architecture based on this result.

The portable `python/a19_early_stop_replay.py` reproduces the read-only history
analysis without importing Torch, fitting a model or changing any checkpoint. It
rejects inconsistent histories, recipe/checkpoint mismatches and nonfinite
metrics. Rejected histories prevent an all-checkpoints-preserved result. Supply
an exported evidence object containing `registration` and completed `teachers`
with their epoch histories, and a rule registration bound to the original sweep:

```bash
python3 src/simulation/v0_9/python/a19_early_stop_replay.py \
    --evidence "$HOC_V09_EVIDENCE" \
    --registration "$HOC_V09_STOP_RULE" \
    --out "$HOC_V09_REPLAY_RESULT"
python3 -m unittest discover -s src/simulation/v0_9/python -p 'test_a19_early_stop_replay.py'
python3 -m unittest discover -s src/simulation/v0_9/python -p 'test_a19_development_controller.py'
```

The short backend probe used eight reversed-order arms, batch 2,048 and a 32.8M
teacher, with two warmup and 12 measured steps per arm. BF16 math and BF16 fused
attention achieved 1.411× and 1.567× the native training-step throughput. Weights
and optimizer state remained FP32. These are short-probe results; BF16 still needs
complete-fit and game-quality validation and is not enabled by this change.
Both compiled arms failed because the host lacked Python 3.12 `Python.h`; the six
other arms completed. A completed experiment job does not mean every backend
passed.

Source-bound evidence identities:

- Original sweep: `d14553089ce0b36300c159025b189eb3c7ae8c4c97746f210610830bfb638c1a`.
- Frozen evaluation source: `71c2547c12b797e9d88cd319a7cefb2a8a5ea8a9690b1fa883f594c0c5388470`.
- Prospective stopping admission: `d443d2c0bb7455ba2b82064e590ca91885e9721a36e4c5a5ab35147866325ef2`.
- Shortened-fit registration: `1332b8b80dd00e6b3caa3144c38b9c0e55c6ef09ba6b0bbac3e0d3736ee61d3f`.
- Backend-probe registration: `7120cd30bbfe9b408c0609c5a3dbdc0fa61ee3b803a56101e664ee9b9062795a`.
- Completion evidence file: `d840118ea5c5bbe426924801b4342060a8a8085faf7ea34ac99f793e5af28852`.

The campaign-relative evidence directories are `overnight-12h-20261101`,
`next-iteration-performance-20261101`, and `speedup-trial-20261101`. Generated
models, raw games, histories and result JSON stay outside Git. Local research
receipts remain under `game/core/tmp/v09-independent-20261027` in the client
checkout. The sections below preserve the earlier campaign history and original
qualification requirements; they are not a claim that the newly tested models
passed production qualification.

## Earlier campaign history — October 27–28, 2026 UTC

Research plan updated on 2026-10-27 UTC. Target: train on Puffalo's approved RTX 5090 and beat the current complementary-R2 A19 controller. **Two repaired-source 5090 fits completed. The fixed all-family correction scores 53.58% on 768 development games (95% board interval 51.69–55.53%); untouched confirmation and production timing remain unqualified. Independent research and further bounded training are authorized through Sunday, November 1 at 11:59 p.m. Pacific.** No research artifact is promoted automatically.

The first budget is a 48-hour proof of progress. Report CPU actor time, learner time and time waiting for GPU access separately. GPU visibility and SSH access have returned. The approved UUID-pinned CUDA device identifies as RTX 5090. Earlier OS-blocked visibility and subsequent SSH timeouts are historical observations.

## What changed from the earlier v0.9 plan

The previous a13 campaign scored 40.89% over its 48,000 recorded outcomes. It does not qualify a challenger against current A19. Its plain v0.8 fallback, historical rules and 25 ms neural-only qualification route also do not describe the present target.

The primary opponent is the complete current A19 composite: H64, complementary R2, shortlist six, current candidate limits, material tie arbitration, certified/tight bounds, ranked draft/setup, supply, synergies, splits and terrain. Preserve the exact engine/profile throughout a registered trial. Production changes require an explicitly admitted baseline and fresh confirmation.

The first campaign used commit `80180ef46464daf3b580e98a2e7f1ebad92a3d87`. The CPU readiness audit reproduced an aura rollback bug: restoring shared objects separately broke reference relationships between an ability, its source unit and projected cells. A first patch fixed four regressions but still failed when only the unit or only the aura cache was touched. That campaign's research admission was revoked and its CPU/GPU continuations stopped before any GPU use. Its accepted artifacts are preserved as historical evidence.

The previous replacement source `9fdcdc59854acbab6b91b1d7e97517607608e6dee37148cd36200f66fff0638f` subsequently failed seven of eight new shared-synergy restoration regressions. Its admission was revoked and its accepted historical files preserved. Its 1,264 completed confirmation boards do not qualify the newly repaired source. No GPU fit ran on that source.

The current isolated producer is based on `92611ff274793f5924399515833a070ac350fcaa`, including the synergy repair from `331c53ba`, plus a producer-only restoration observer. Source SHA: `9ea602286ae3600ae8cf3ce4dd531084df3c9b729647d40d79d01fa1c69583f6`. Snapshot SHA: `853c22db253a8093637b38cc608363e046f9ff58e2d2e2be765795fed531fbb8`. Campaign/student roots are `2026102691` / `2026102693`, excluding 43,869 known prior/reserved channels.

Every actual teacher and baseline search root must restore battle values, reference sharing, live unit instances/order and RNG/UUID. A mismatch rejects the board before labels are accepted. Per-game counts are recorded as `rootRestorationChecks`. Evaluation timing does not install this producer observer. Four focused tests and four real smoke games passed, covering 217 searched roots. The exact actor passed all 7,200 tests across 557 files, source typechecking and targeted ESLint. The first full run hit an existing process-startup test's five-second runner timeout; the unchanged source passed the complete retry with a fifteen-second test-runner timeout. GPU fit limits remain unchanged.

The current workflow runs Linux snapshot-reference checks, fresh software rehearsal, teacher qualification, corpus generation and complete CPU preparation. It waits for shared CPU resources before each stage. Only a complete accepted CPU receipt releases one approved 5090 fit. That is followed by CPU export parity, smoke and development evaluation. Finalist locking, untouched confirmation and production promotion remain separate.

On the current source, the 768-game R8 screen scored **55.21%**, with a board-bootstrap interval of **52.93–57.49%**. Its independent 6,000-game confirmation finished on 2026-10-27 at 12:37 UTC with **55.47%**, interval **54.57–56.37%**, and zero rejected actions. An independent Python audit checked all 3,288 wins, 2,632 losses and 80 draws, seat pairings and 298,912 restoration checks, then reproduced both endpoints of the registered 10,000-sample, map-stratified whole-board bootstrap exactly. This qualifies the offline teacher for fresh corpus generation; it is not a trained-student result. The Linux snapshot reference also passed all 96 games and 2,270 root witnesses without record, state/alias or trajectory mismatches. Exact CPU learner recovery, export parity, neural-engine smoke and diagnostic live-path checks passed on this source.

The current host orchestration uses eight simulation workers at nice 19. Memory admission checks the host and every ancestor cgroup, preserving a 16 GiB reserve against the tighter soft/hard limit. Its estimate credits at most half of clean, unmapped file cache; shared memory, mapped files, dirty/writeback pages and unevictable pages are excluded. This is an orchestration estimate based on the [Linux memory counters](https://docs.kernel.org/admin-guide/cgroup-v2.html), not a change to cgroup limits or a cache-purge operation. The previous raw `memory.max - memory.current` check stalled on filesystem cache.

The scratch filesystem subsequently fell below the learner's existing 100 GiB free-space requirement. Only this campaign's output directory was copied onto Puffalo's larger system filesystem, with all 1,740 file SHA-256 values verified before switching the original access path to a link. The original directory was retained. Source, manifest, seed registration and accepted matches did not change. The resumed pipeline reuses those verified stages and retains the original wall deadline and the 120/1,200-second GPU limits.

The fresh 510-board training corpus and 96-board validation corpus are complete. The full CPU scan passed: 23.87 seconds to load/collate the data, 34.60 seconds overall, including a finite backward pass at the largest actual batch shape (32 rows, 17 entities, 28 candidates). Resource-admission logging had overwritten the CPU-complete status marker; the handoff was corrected only after independently revalidating the complete source-bound report and every corpus file. The host recipe now restores that marker explicitly before launching the GPU continuation.

The first approved 5090 fit finished all 20 epochs at 19:20 UTC on October 27, about five minutes after launch. Summed epoch wall time was 266.49 seconds. The selected export has SHA `f4bed851811f3e41590db2924ef3fcbb1c3aa90fb93a1120ea30a5766c08483a`. Its best validation policy loss was 1.54548 at epoch index 4; the final epoch's policy loss was 2.11966. The best validation checkpoint was selected, and late overfitting remains a research diagnostic. Model, checkpoint and epoch history were copied locally and hashed. These are successful fitting/software results, not a claim of increased full-game strength.

The first same-family challenger completed its 192-board / 768-game development bank with 386 wins, 377 losses and five draws: **50.59%**, with a clustered 95% interval of **49.02–52.21%**. It corrected 1,003 of 19,299 decisions and rejected no actions. This is inconclusive. Fitted CPU/PyTorch/Bun parity passed with maximum absolute error 0.00000194 and zero ranking mismatches. Loaded-host offline inference timing does not qualify production latency.

A separately registered fit with seed `2026102694` completed 20 epochs, selecting epoch index 5 with validation policy loss 1.54753. Its export SHA is `608631a62742f9eae3d079292be4218887a8296e2f312b82ad55ca0e96a08eb7`. Both seeds show late overfitting, so additional identical seed fits are held. Development compares a lower confidence margin, the second model, and an isolated policy allowing different action families only among fully scored exact primary ties. The latter changes one extra evaluation helper and preserves all 599 actor-era inputs. Eight focused engine tests, five capsule-admission tests and source typechecking passed. Source inspection found no rollout/primary scores in neural inputs; training and inference both encode the full pre-shortlist catalog. A validation-only label/ranking diagnostic guides the next learner/data change. These experiments leave the primary and R4 student banks unopened.

The pre-registered confidence-margin 0.25 comparison also completed 768 games: 370 wins, 384 losses and 14 draws, **49.09%** (95% board interval **46.88–51.24%**), with 4,050 corrections across 19,578 decisions. Independent Python reconstruction reproduced both trials’ game/seat totals, correction counts, timing quantiles and registered bootstrap endpoints. The paired margin-0.25 minus margin-1 difference is −1.50 percentage points, interval −3.78 to +0.78; neither this comparison nor the original establishes a positive strength gain.

A controlled regularization recipe kept the original seed, exact corpus and architecture, adding 0.1 legal-action label smoothing and weight decay 0.01. Its source-bound CPU admission passed, including the actual frozen GPU-preflight executable, maximum-batch backward and exact optimizer/checkpoint recovery. The third 5090 fit completed all 20 epochs at 22:21 UTC on October 27, with 293.50 seconds of summed epoch time and a 14.48-second first epoch. Its export SHA is `b9a50c0b1fa1ce256ce4f440f1a7e7b07cf2d608d7e4cfe8efe7d930e3c645f9`, selected at epoch index 4 with validation policy loss 1.54643. Late validation loss fell from the original fit's 2.12 to 1.85, but the best loss did not improve. Its same-family development completed 768 games: 380 wins, 385 losses and three draws, **49.67%**, interval **48.18–51.17%**, with 765 corrections and zero rejected actions. Independent raw-game and bootstrap reconstruction passed. Against the original same-family model, the paired difference is −0.91 percentage points, interval −1.95 to +0.20; no gain is established. The fixed all-family comparison remains required. Unexecuted preparation errors were preserved and corrected before any GPU attempt.

The separately owned [serving-frontier study](a19_frontier_priorities.md) uses the first fitted model to acquire a complete independent R8 decision on margin-one neural disagreement. Its 768-game development comparison scores **54.36% against R2**, interval **52.47–56.32%**, and a separate 768 games score **52.28% against R4**, interval **49.48–55.08%**. This training study independently reproduced its integer totals and both 20,000-sample board-bootstrap intervals. Those are promising development results for a different complete policy. Original quiet-host cost banks, live implementation and independent qualification remain with that study; do not duplicate its jobs or reinterpret this as a qualified direct-correction student.

The fixed all-family, gain-one correction completed its 192-board / 768-game development comparison with 407 wins, 352 losses and nine draws: **53.58%**, interval **51.69–55.53%**, and zero rejected actions. It corrected 2,352 of 19,371 decisions without requesting additional R8 search during play. Independent Python reconstruction reproduced raw outcomes, correction counts, timing quantiles and the registered bootstrap endpoints. Against the same-family rule on identical setup fingerprints, combat seeds and physical seats, the paired improvement is **3.00 percentage points**, interval **1.30–4.82 points**. Map point estimates are 53.13%, 52.73% and 54.88%. These are development findings, not untouched qualification or production latency evidence.

The independent fitted seed completed its same-family comparison at 50.65%, interval 49.28–52.08%, with zero rejected actions. Under the fixed all-family, gain-one rule, it completed 768 games with 400 wins, 357 losses and 11 draws: **52.80%**, interval **51.04–54.69%**, with 2,292 corrections across 18,977 decisions and zero rejected actions. Independent raw-game reconstruction and matched setup/seed/seat checks passed. Its paired all-family improvement is **2.15 points**, interval **0.52–3.78 points**. The all-family scores differ between seeds by −0.78 points, interval −2.86 to +1.24, so neither model is established as stronger. The regularized all-family model completed 768 games with 405 wins, 357 losses and six draws: **53.13%**, interval **51.50–54.82%**, with 1,779 corrections across 19,153 decisions and zero rejected actions. Its paired all-family improvement is **3.45 points**, interval **1.76–5.14 points**; against the original all-family model it differs by −0.46 points, interval −1.89 to +0.98. Independent reconstruction verified all seven completed arms and all cross-arm game inputs. The three fitted models support broader eligibility on the same development bank; additional regularization has no established benefit. Actual fitted-model abstention controls passed all 12 complete stock/candidate trajectory pairs, with 284 inferences and zero corrections or rejected actions. A duplicate summary-finalization error was recovered by verifying the accepted files, without replaying any games; the original failed wrapper receipt remains preserved.

CPU tensor packing also passed: 11,704 training and 2,142 validation decisions prepared in 18.10 seconds, exact original-collator tensors after trimming, zero prediction discrepancy and maximum gradient discrepancy below 0.000000045. The measured 149-times improvement applies only to CPU collation versus gather. A separate batch reader restores the original local shapes and exact strides, including single-row batches. Eleven focused batch/control tests pass locally and on Puffalo, covering bit-exact optimizer trajectories, checkpoint/RNG recovery and all six validation metrics. Full-corpus shuffled-batch CPU admission passed at 00:03 UTC on October 28: 29.08 seconds preparation, all 13,846 rows, exact original shuffled tensors/strides, finite maximum-batch backward, exact optimizer/checkpoint recovery and all six validation metrics. The bounded GPU throughput test is queued. It uses four original/staged/staged/original full train-plus-validation epochs, resets the same model and optimizer each time, requires exact parameter/metric agreement, and counts setup and transfer time in both reversed-order pairs. It exports no candidate and cannot qualify a larger-corpus fit. No full-fit speedup is claimed. A portable frozen-source/model package passed 128-state fitted numerical checks on Mac and Linux. Read-only inspection confirmed that the deployed server uses Bun 1.4.4 and the captured common pin on two Skylake virtual CPUs; production turn timing remains unqualified.

A separate, pre-registered learner test adds conditional policy distillation on fully scored teacher-primary ties. Eligible rows use half global legal-action cross-entropy and half cross-entropy restricted to exact teacher-primary maxima; other rows retain the global objective. The auxiliary targets, original seed, weight decay, architecture, observations and corpus stay unchanged. Tie sets are training targets only. Fourteen focused tests cover exact retained-number comparisons, missing evidence, finite gradients and accepted checkpoint provenance. Full CPU admission passed at 23:30 UTC on October 27: 6.89 seconds to load the exact corpus, finite maximum-batch backward and exact optimizer/checkpoint recovery. The fourth 5090 fit completed all 20 epochs at 00:09 UTC on October 28, with 306.28 seconds of summed epoch time and a 15.67-second first epoch. Its export SHA is `f1adad8f8dbe199fd1e5cadca52b5329dc8cbf9c45e2234a1bf40e138cbc6231`, selected at epoch index 4 with global validation policy loss 1.55152. That is slightly worse than the original model's 1.54548. The checkpoint rule remains minimum global validation policy loss; its fixed all-family, gain-one development evaluation is running. Untouched banks remain sealed.

A larger corpus is separately registered under bundle SHA `bdf0684bedd9edf714d0070b3d995d0ac8f84328537d68211a23dae4340d161d`. Three fresh child campaigns reserve 1,530 additional training and 288 validation boards, retaining the qualified actor, teacher, sampling and observation contract. Each child keeps its own real manifest identity; its qualification points explicitly to the unchanged parent's original confirmation. No old proof is copied or relabeled as a child confirmation. Thirteen focused scheduler/admission tests pass locally and on Puffalo. Independent Python reconstruction reproduced all exclusion metadata, the three complete seed schedules and all 14 rejected root proposals: 41,634 fresh preimage/actual channels are disjoint from 833,660 protected values. Exact replay passed all three consumed parent software boards: 12 games and 737 audited searched roots, with identical trajectories, records and targets. A separately registered watcher releases this unchanged CPU acquisition only after the current fit, development comparison and matched GPU benchmark have complete source-bound receipts and numerical equality. Six release-control tests pass locally and on Puffalo. No larger-corpus GPU fit is admitted by this registration.

The prospective expanded-data loader and cache passed 12 focused tests locally and on Puffalo. They cover actual child identities and phase ownership, rejection of incomplete collection, immutable raw-file order, path-independent content identity, memory limits before allocation, exact merged batches/loss gradients, and retained-double teacher-tie targets kept outside neural inputs. The merged cache preserves each source campaign's metadata and records a new composite corpus and training-data manifest. These are software checks only: collection, actual cache construction and a separate expanded-data learner admission must finish before another GPU fit.

An ongoing research goal and a dedicated Puffalo user service supervise the extended run. The confirmed hard cutoff is November 2 at 08:00 UTC, accounting for the Pacific daylight-saving transition. The supervisor checks source hashes and CPU readiness, prevents duplicate launches, restricts work to the approved GPU, and stops only registered processes identified by owner, PID, start tick and boot ID. Its 20 control tests passed locally and on Puffalo. New experiments use validation/development data for selection and leave untouched student banks sealed until one complete finalist is locked. Plan the final confirmation early enough to finish before the cutoff. Avoid the scheduled Sunday backup: pause our work from 07:55 through 09:05 UTC on November 1. Failed or interrupted GPU attempts require inspection before any recorded recovery.

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

`python/a19_development_controller.py` can then run export parity, smoke and the 768-game development bank. It cannot lock a finalist or start either untouched bank. All continuations have a wall limit, preserve accepted output, and yield their own simulation children when other jobs need the shared account. The old GPU/development watchers were stopped during the audit. The preparation stages run with the real process CUDA mask empty, including the exact-learner rehearsal. It stops if the engine, software, teacher or data gates fail. Any later GPU continuation still requires complete CPU readiness and a released hold.

## CPU readiness evidence and remaining gates

The earlier source completed exact CPU learner/resume checks, model-bound numerical parity and complete neural/disabled/live-path games. Those are software evidence; the current source repeats admission using its own hashes and fresh smoke boards. Earlier weights and engine results do not qualify the current learned policy.

| Gate                                                       | Current status                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Exact repaired actor regression suite                      | 7,200 passed; zero failures in the full retry                                    |
| Producer restoration guard                                 | Four focused tests and four games / 217 roots passed                             |
| Source typechecking, targeted lint and formatting          | Passed                                                                           |
| Linux snapshot-reference and software rehearsals           | Passed; 96 reference games, 2,270 roots, zero mismatches                         |
| Teacher qualification                                      | Passed; 6,000-game score 55.47%, clustered interval 54.57–56.37%                 |
| Corpus                                                     | Complete: 510 train and 96 validation boards                                     |
| Complete CPU preparation and maximum actual batch backward | Passed; 23.87 seconds data preparation, finite maximum-batch backward            |
| CUDA hardware and throughput                               | Passed on approved 5090; first 20-epoch fit completed in about five minutes      |
| Trained-student full-game strength                         | All-family development 53.58%, CI 51.69–55.53%; held-out and runtime unqualified |

The current workflow has `--allow-guarded-gpu`. A verified CPU report can release the fit automatically. The first completed epoch must arrive within 120 seconds; active fitting is capped at 1,200 seconds without automatic retries. The CUDA learner exits before CPU development evaluation. Production timing remains a separate model-bound gate after fitting.

`a19_student_eval.ts` exposes `init`, `run`, `verify`, `qualify`, `lock` and `finalize`. `qualify` requires model-bound CPU parity, disabled parity and production timing receipts. `lock` requires completed smoke/development plus verified readiness. Confirmation requires that exact exclusive lock. Immutable raw boards, source/model hashes and independently reconstructed summaries make resumed and completed results reviewable.

Keep generated data, model weights and reports outside Git, normally under `game/core/tmp` or the admitted Puffalo workspace. Preserve historical campaigns and failed experiments with their original identities. Never overwrite or relabel them as current qualification.
