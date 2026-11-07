# v0.9 training against current A19 R2

## Fresh overall-strength test — November 7, 2026 UTC

The user considers a repeatable two-point advantage valuable. The completed
52.08% development score is therefore a reason to test this fixed checkpoint
more precisely, while retaining the original failed 55% study and its unopened
3,132-game confirmation bank unchanged. This is a separately registered overall
test on the current engine, which includes the ranged echo/Quiver fixes in
`f0394f73` made after the training source `005805a5`.

Study `v09-current-overall-test-20261107T211035Z` was registered before play and
launched at **21:19:14 UTC** on the shared 9800X3D host. It freezes common
`77af0770c79d5d1e5f8ea9c62bd648f1dc9743b1` and the unchanged full-policy pair
`675b438406b6ee3aa313feb1e382843a0442bc9970bc28810abc19d30d26aa68`.
Registration SHA:
`ae470d04bc5978626ea901c512a273d3f17c49d0c6f60949673d41bd71c0143e`;
uploaded source/model archive SHA:
`8045cbb006eac12c488859d9773c0a630c704def5c37fff731fa77fc955c26bf`.

The fixed bank contains **1,512 new boards / 6,048 games**, with four physical
and draft-seat mirrors per board. Each of the three maps and nine doctrine
matchups has 56 boards. Both seats use their own locked-V3 draft policy,
authoritative sequential bundle visibility and the complete deterministic
A19 H64/R2 search. Only the candidate's existing neural correction weights
change. Previously registered seed channels, including unopened banks, are
excluded. There is one candidate, no refitting, no subgroup selection and no
optional stopping.

The question is whether this fixed pair has an overall advantage on the
current engine: its 10,000-sample, map-stratified whole-board bootstrap must
have a **95% lower bound above 50%**. The result will be reported regardless of
its sign. The four games within a board remain one bootstrap cluster. This
does not retrospectively pass the old 55% gate or qualify native v0.9 combat.

Before fresh games, repeat the 128-reference numerical check, observation and
continuation parity, 48 exact warm A/A replay pairs and 12 closed-fixture
candidate smoke games on the frozen current source. Local numerical parity
passed with maximum error `3.143e-6`. The current-source engine suite passed
7,543 tests in the sandbox; its sole process-identity failure passed with all
18 tests in that file when rerun outside the sandbox. Linux replay admission
still runs separately before the fresh bank.

The CPU-only test uses eight workers at nice 10, a 24 GiB process-group memory
limit and a six-hour registered window. Existing host services and other
research jobs remain running. Architecture and search work are unchanged;
quiet production whole-turn timing within 1.10 times the reference is still
required separately. A positive result does not automatically activate or
deploy this research pair. The GPU fit is already complete; this stage needs
battles rather than extra VRAM allocation.

## GPU utilization and completed full-policy fit — November 7, 2026 UTC

The user emphasized using the RDNA card's capacity. The experiment
spent most of its time producing full-game continuation labels on the CPU;
the GPU was idle during that stage. Its 130-parameter head-only fits also leave
most GPU compute unused. Filling VRAM is not required for high compute usage:
the measured full-policy update windows below used under 600 MiB of VRAM.

### Verified throughput changes

`clipped_parameter_gradients()` requests derivatives only for selected FP32
parameters and computes global clipping on their device. Tinygrad 0.14's
ordinary `backward()` requests gradients for every live floating tensor,
including board inputs; the full-policy probe originally failed while attempting
to differentiate a boolean army mask. Explicit parameter targets remove that
invalid path and unused input gradients. They also remove per-update gradient
copies to NumPy and back. The original registered head experiment is unchanged.

A separate, source-sealed probe compared the host-clipped loop, explicit GPU
gradients/clipping, and the same GPU optimizer captured with `TinyJit`. Three
counterbalanced rounds each used two warmup updates and 64 timed updates, with
device synchronization on both sides of the timed window.

| Head-update loop                    | Median seconds for 64 updates |
| ----------------------------------- | ----------------------------: |
| Existing host clipping/backward     |                       13.3501 |
| Explicit gradients and GPU clipping |                        3.8614 |
| GPU loop with compiled replay       |                       0.03995 |

The **334.2 times** ratio applies only to this small, steady-state update loop.
It excludes data acquisition, feature preparation, compilation, validation and
exports, and is not a whole-campaign speedup. GPU and compiled replay produced
bit-identical parameters in every round. Against the host-clipped reference,
non-bias weights differed by at most `4.459e-5`, normalized policies by
`8.584e-6`, and all 114 applicable serving-choice comparisons agreed. Two scalar
policy biases drifted by up to 0.03995 under rounded near-zero Adam gradients;
each cancels from its member's softmax. These are numerically close fits rather
than byte-identical exports. The original failed strict parameter comparison
and its diagnostic receipt remain preserved.

`FullA19Pair` trains **500,418 existing policy-path parameters**, including both
original encoders. Auxiliary-head weights remain frozen. Inputs and hidden
activations are recomputed with the current weights; there is no frozen-feature
cache. The serving architecture, native observation contract and search budget
are unchanged. Both complete models are snapshotted and restored together, with
shape, finite-value and frozen-weight checks before restoration.

The actual full-policy gradients matched CPU PyTorch within `1.431e-6`;
the first clipped SGD update matched within `7.451e-9`. The exact registered
backend also passed full checkpoint restoration and eight eager/compiled
updates with **zero parameter and policy differences**.

| Short full-policy update window | Batch 64 | Batch 512 |
| ------------------------------- | -------: | --------: |
| Timed updates                   |      256 |       256 |
| Updates/second                  |   109.65 |     61.87 |
| Sampled average GPU busy time   |    93.9% |     88.7% |
| Sampled average package power   |  179.5 W |   184.0 W |
| Peak available temperature      |     34 C |      36 C |

The probe peaked at 198 W and 558.1 MiB sampled VRAM. These short windows
repeated the 19 exposed historical inputs for throughput; they are not new
independent training data or evidence of stronger play. All arithmetic remained
Float32 with `TC=0` and TF32 disabled. This is measured FP32 workload utilization,
not qualification of peak matrix-accelerator throughput. The full 166-second
probe includes CPU-heavy preparation and host-reference loops, so its overall
GPU utilization is much lower than the two update windows.

Evidence is preserved under local study
`v09-rdna-utilization-20261107/benchmark-20261107T073439Z` and node study
`v09-rdna-utilization-20261107T073439Z`. Registration SHA:
`db0e1b5f3b888200af2da9aaae90f5ccb55dc680c4d19db489357d51954c2acd`.

### Completed real-data full-policy experiment

The separate source-sealed campaign `v09-rdna-full-policy-20261107T075127Z`
passed its exact GPU/software preflight, waited for the parent's complete
admitted dataset and GPU fit, and finished its own development test. It never
edited, paused or replaced that experiment. Its registered 12-hour cutoff was
**19:51:28 UTC on November 7**. Registration SHA:
`f86e35cddbf9cf93db0206a14ca3bd001311708a61b2bcd065c87ff535859d2c`;
archive SHA:
`36f1f6a41a98dd7fdea197f496b19ff2e966a551cea5f09864a4fd232312466a`.

One fixed full-policy recipe uses AdamW learning rate 0.00001, weight decay
0.001, FP32 GPU clipping at one and compiled updates. Every update uses the
complete training-root and warm-training banks. Score scale 0.1, root KL 0.2,
warm KL one, teacher CE weight 0.05, validation improvement 0.005, teacher CE
tolerance 0.03 and margin one remain fixed. Checkpoints require observed labels
for every served validation choice, nonnegative label gain and changed decisions.
Whole-model snapshots preserve the selected epoch's encoders as well as heads.

Only one eligible finalist can run, with at least 96 Bun numerical/decision
references, 48 warm A/A replay pairs and 12 closed-fixture candidate smoke games.
Its separate **864-game development** and **3,132-game confirmation** banks
exclude the parent's banks and earlier studies. The existing 55% development /
52% confirmation score thresholds and positive whole-board lower bounds apply.
CPU evaluation waits until the parent's evaluation finishes, preserving its
worker budget. Production timing and activation remain separate. No throughput
probe has opened a strength bank or established a new win-rate gain.

The parent completed all 972 scenarios and **18,224 paired continuations**.
It admitted 541 training / 259 validation roots, of which 118 / 69 had marginal
score contrast, and 2,591 / 1,296 authentic warm rows. Four head-only fits
completed in 282.94 seconds; none produced a validation-eligible finalist.

The full-policy child completed 340 updates in 58.69 fit-loop seconds and
70.02 seconds including loading/preparation/export. Peak sampled VRAM was
2,149,126,144 bytes, and peak available temperature was 53 C. Epoch 39 satisfied
the fixed constraints: validation loss 6.79534 → 6.66998, teacher CE 1.20424 →
1.21842, one changed validation choice, zero unknown choices and zero mean
recorded-label gain. Its complete pair SHA is
`675b438406b6ee3aa313feb1e382843a0442bc9970bc28810abc19d30d26aa68`.

CPU export verification passed 128 references with maximum error `3.143e-6`.
All 48 warm replay pairs and 12 candidate smoke games passed. The independent
development bank then completed:

| Games | Wins | Draws | Losses | Draw-aware score | Whole-board 95% interval |
| ----: | ---: | ----: | -----: | ---------------: | ------------------------ |
|   864 |  445 |    10 |    409 |           52.08% | 49.59–54.63%             |

The point estimate is above the reference, but the interval includes 50% and
the preregistered 55% development threshold failed. This is not an established
strength gain. The separate 3,132-game confirmation remains unopened; no model
is promoted. Both study jobs are complete. An independent local reconstruction
of all 216 raw boards reproduced the outcome counts and both bootstrap endpoints
exactly.

### Real-recipe GPU telemetry replay

After completion, one measurement-only replay ran the same complete 340-update
recipe with every export marked functional and no finalist or strength games.
Both selected models' weight dictionaries exactly match the originals, and the
same epoch 39 was selected. One-second read-only telemetry attributed every
sample to the replay's KFD process.

| Actual real-data replay window | Whole replay | Updates after first checkpoint |
| ------------------------------ | -----------: | -----------------------------: |
| Wall seconds                   |        65.01 |                          38.57 |
| Available GPU busy samples     |           64 |                             38 |
| Average GPU busy time          |       59.64% |                     **94.16%** |
| Peak GPU busy time             |         100% |                           100% |
| Average package power          |      167.1 W |                    **257.8 W** |
| Peak package power             |        299 W |                          299 W |
| Peak available temperature     |         51 C |                           51 C |

The full fitter reported 64.94 total seconds and 54.46 fit-loop seconds in the
replay. The whole window includes preparation and compilation; the later update
window includes normal checkpoint/validation work. This verifies high GPU usage
while the richer learner updates, not continuous GPU usage during CPU battle
generation. The source-sealed replay is `v09-full-policy-timing-replay-20261107T170758Z`;
its `hardware-replay-summary.json` records the weight equality and exact windows.
Raw device counters, process identities and campaign phases are retained by the
read-only `v09-rdna-monitor-20261107` service, stopped after the completed replay.
Missing counters remain missing.

The completed dataset, admission proof, all five fit receipts, selected complete
pair, all raw development boards and telemetry were copied locally under
`game/core/tmp/v09-rdna-completed-readout-20261107`. Archive SHA
`507bb6f48bd45ba99505ef37a4b1649da4465b0e4926e10b8d77ec0ff380e87a`
and admitted training-data SHA
`fd797a1493468a23ef0b5d64b10e26d49e55012dd19fec1c8e552c413bcc9126`
were independently verified after copying. Normal generated evidence remains
outside Git.

## Broader joint-head campaign — November 7, 2026 UTC

The user requested a review from all angles and continued training for measured
combat gains. A new bounded campaign is registered on the 9800X3D/RDNA host as
`v09-joint-training-20261107T065723Z`, using source **`005805a5`**. The 12-hour
window ends at **18:57:25 UTC on November 7**. Its registration SHA is
`4e72480f0f8ce771430e197950b66022a827d89a4d87f5503dd543b8730747cc`;
the uploaded archive SHA is
`674cf1b195ed490539017dffdc0de0d49c83ce2b4e1c9e89b4bc59f633d3d991`.
The acquisition and four head fits are complete; no head-only candidate passed
validation admission. The full-policy child result is reported above.

### Questions the experiment separates

| Angle               | Finding and registered response                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model capacity      | A frozen ensemble member can make a correction unattainable. Compare joint heads with matched single-head controls, preserving both original backbones.                                                               |
| Objective alignment | Fit marginal terminal-score differences with equal informative-root weights. Retain the real margin-one selector and original arithmetic ensemble.                                                                    |
| Data coverage       | The old Radeon pilot had 19/14 roots from six targeted creatures. Collect fresh, untargeted ranked drafts across all nine doctrine matchups, three maps, three requested battle phases and both physical/draft seats. |
| Labels and noise    | Keep eight shared futures for every retained action, including draws. Record missing roots without refills. Report both reused-label oracle gain and four-by-four cross-world diagnostic gain.                        |
| Preservation        | Sample actual full-catalog A19 choices before outcomes. Fit with warm KL and teacher CE; require complete warm-validation CE to remain within 0.03 of its original value.                                             |
| Selection           | Use separate family-level training, validation, development and confirmation banks. Four fixed fits may produce only one validation-locked complete pair. No subgroup rescue or fallback finalist.                    |
| Opponent and draft  | Both combat seats use independent locked-V3 draft policies with authoritative sequential bundle visibility. This removes the older screen's fixed-previous-draft limitation.                                          |
| Serving cost        | Train existing weights only: 65 or 130 parameters. No layers or search work are added. Quiet production whole-turn timing within 1.10 times the reference remains a separate gate.                                    |

The research harness now accepts `researchOpponentDraftChoices` alongside the
candidate hook. Each seat receives its own public context and retains its own
state through collision retries. Tests exercise both physical mirrors and both
draft seats, prove exact no-op setup/record parity, and reject an illegal
opponent-only choice. Existing callers retain their original behavior.

### Fixed acquisition and fit design

The bank contains **648 training scenarios and 324 validation scenarios**. Its
81 map/doctrine/phase strata each have eight training and four validation
scenarios, balancing the four physical/draft assignments. One eligible root is
selected by an outcome-blind hash within the requested phase; no focal creature
is forced into the draft. Retain at most three eligible actions, including the
actual baseline decision, native searched choice when different and a distinct
action family when available. Every retained action receives all eight complete
continuations. Unobserved alternatives receive no invented outcome.

GPU training requires at least 300/128 usable training/validation roots, 96/32
marginal-score-informative roots and 512/256 authentic warm rows. These counts
are gates, not claims about data already collected. The immutable historical
functional fixture separately runs the exact four-fit trainer before the label
budget is spent. Its proxy warm argmax targets are diagnostic, all its exports
remain marked functional, and it cannot lock a strength finalist.

The four real-data recipes cross learning rates 0.003/0.01 with student/joint
heads. They share initialization, AdamW weight decay 0.001, score scale 0.1,
root KL weight 0.2, warm KL weight one, teacher CE weight 0.05 and clipping at
one. Frozen encodings are reusable only because both original backbones remain
frozen. The cap is 600 updates per fit, with checks every ten updates, at least
40 updates and patience 60. Checkpoint eligibility requires validation loss to
improve by at least 0.005, the warm CE bound, zero unlabeled served validation
choices, nonnegative recorded-label gain and at least one changed decision.
Validation may select the checkpoint; it cannot open multiple strength trials.

The one selected pair must pass at least 96 Bun numerical/decision references
and 48 complete warm-start A/A replay pairs. Its development bank has **864
games**. Confirmation's separate **3,132 games** stay closed unless development
scores at least 55% with a whole-board 95% lower bound above 50%. Confirmation
requires at least 52% and a lower bound above 50%. Both banks balance maps,
doctrines, physical sides and draft seats. The registered map-stratified
bootstrap resamples complete four-game boards, never individual battles.

This route learns corrections on top of full A19 search. It does not train or
activate the native v0.9 anchor artifact. A positive baseline comparison would
still leave general opponent-pool robustness and production timing to verify.
Later changes to balance or combat code require explicit transfer evaluation;
the shared working tree's uncommitted gameplay edits are outside this capsule.
The current default remains locked v0.9 draft plus qualified A19 combat.

Repository verification for the harness change passed lint, TypeScript checking
and **7,500 common tests**. Ordinary run data and models remain outside Git.

The campaign passed its Linux controls and trainer preflight before starting
fresh acquisition. Mac and Linux control receipts are identical: 12 cases each
reproduce stock, observed capture and same-future continuation games, including
788 restoration checks. The exact four-fit trainer completed 160 functional
updates in **38.25 seconds**, using a sampled peak of **162.1 MiB VRAM**. None of
those diagnostic fits satisfied checkpoint eligibility, and none can consume
strength games. These results verified the trainer before real-data execution.
The completed acquisition, head-fit rejection and separate full-policy match
results are reported above.

## Joint-head training on the 9800X3D RDNA GPU — November 7, 2026 UTC

The user requested a Tinygrad training path on the 9800X3D node. A source-pinned
functional fit now runs on its discrete **RDNA4 `gfx1201` GPU**, PCI `1002:7551`,
with 32 GB class VRAM. The host was running another CPU experiment, so the GPU
canary used one compiler/BLAS thread and a separate limited research process.
Tinygrad was installed into a fresh research environment; live Heroes services,
system packages and driver bindings were not changed. The ordinary KFD interface
used the existing amdgpu driver. [Tinygrad documents this interface separately
from its PCI driver](https://docs.tinygrad.org/runtime/#amd-interfaces).

The pinned backend is Tinygrad **0.14.0**, commit
`e4131331cf172545f91f91797edfad61e94e25ea`, with NumPy 2.4.4 and LLVM through
`DEV=KFD:0+AMD:LLVM`. Tensor cores and TF32 were disabled for this Float32 check.
Puffalo's authenticated SSH check still timed out. The Mac's Tailscale client was
running under the expected account and contained the exact shared peer; no
remote outage or new 5090 job status is inferred from that observation.

### What the joint backend changes

`A19PolicyHeadPair` and `TinyA19HeadPair` can train the original two policy heads
together: **130 parameters**, with both original backbones frozen. A matched
student-only mode retains 65 trainable parameters and checks the entire partner
for changes. The Tinygrad backend computes frozen candidate encodings once and
fits the heads from that cache. It does not reuse a frozen cache for a feature
adapter, add layers, lower margin one, or change the arithmetic ensemble rule.
Both exported members use the ordinary original-width A19 CPU architecture.

The Torch implementation snapshots and restores both complete members together,
validates frozen parameters before restoration, and preserves CPU and CUDA RNG
state during CPU construction. A deterministic capability test trains actual
A19 policy heads on a two-action fixture: the student-only control remains
below the serving threshold imposed by its frozen partner; the joint model
crosses that same threshold. This is a capability example, not a gameplay result.

The backend-independent `a19_feature_pair_format.py` binds both complete files,
their policy-head fingerprints, input/source hashes, recipe and checkpoint epoch.
The Bun loader verifies those identities and keeps pair construction outside
per-decision prediction. The new finalist format omits the legacy `modelSha256`
key, so a single-model evaluator fails rather than silently substituting the old
partner. Functional fixtures and unchanged pairs are rejected by the strength
loading path. None of these research modules is installed by the shipped factory.

### Completed real-input canary

The data are the **already exposed historical pilot**: 19 training roots, 14
diagnostic validation roots, eight futures per labeled action, and 128 separately
sampled warm A19 observations. Only seven roots in each pilot split have marginal
score contrast. Historical requested-phase fallback cases remain visible. This
does not meet the larger training-data readiness gate and cannot select a
strength finalist. No validation result selected a checkpoint; all 64 updates
were fixed before the run.

The recipe used AdamW learning rate 0.003, weight decay 0.001, global gradient
clipping at one, score scale 0.1, root KL weight 0.2 and warm KL weight one.
Warm KL is a functional preservation check; it does not replace the full
qualified teacher-CE preservation bank. The ordinary research data, matched-fit,
fresh-match and production-timing gates still apply to any later candidate.

| Check                                                                               | Result                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| Maximum Tinygrad/PyTorch forward difference                                         | `4.054e-6`                                       |
| Initial real serving decisions checked                                              | 33, all equal                                    |
| Maximum head-gradient difference                                                    | `3.726e-7`                                       |
| First clipped SGD update difference                                                 | Exactly zero                                     |
| Actual joint AdamW updates                                                          | 64                                               |
| Fit-loop wall time                                                                  | 7.09 seconds                                     |
| Reported canary execution, including GPU setup/parity/export after source admission | 18.44 seconds                                    |
| Peak sampled device VRAM                                                            | 147.5 MiB, including the pre-existing allocation |
| Peak available temperature reading                                                  | 29 C                                             |

An initial attempt stopped before GPU allocation because the idle driver's
temperature read returned `EBUSY`. Its receipt remains preserved. The successful
attempt records unavailable samples explicitly and enforces the bound whenever
the counter is available; it recorded one unavailable idle sample. The recipe
and training inputs were unchanged.

| Pilot diagnostic                            |  Before |   After |
| ------------------------------------------- | ------: | ------: |
| Training score-difference loss              | 9.24773 | 6.29894 |
| Diagnostic validation score-difference loss | 7.96637 | 6.42133 |

The trained pair changes two training and four validation gate decisions, with
zero unlabeled choices. Average recorded-label gain is +2.63 points on training
and **zero on validation**. These are reused-label diagnostics. Lower loss and
an exposed pilot do not demonstrate a stronger combat AI; no strength bank was
opened and no model was promoted.

### Export and inference checks

The actual Radeon-trained checkpoint passed **65 Bun numerical cases** with a
maximum discrepancy of `1.916e-6`; all 33 applicable margin-one decisions matched.
Twelve warm-start A/A pairs (24 complete game replays) reproduced every record,
event and turn digest. There were 226 exact warm neural-prediction checks and
542 restoration checks. Attempting to load the functional checkpoint for strength
games was explicitly rejected.

Four counterbalanced local M4 timing rounds replayed 1,990 real decision inputs
per arm after preloading models. Original mean inference time was 2,664.88 ms,
warm pair 2,660.57 ms and trained pair 2,656.73 ms: ratio **0.997**, effectively
unchanged. All 1,990 warm predictions were bit-exact. This is a model-only local
diagnostic, not production whole-turn timing. The pair adds no serving operators;
any later integration must preload both members before the turn budget starts.
The Radeon makes these head fits practical; battle search and continuation-label
generation still require separately budgeted CPU work.

The successful registration is
`cc888fa1fbc83d0a5a9c339e1fa1584ba05eef246218b4f4a5633d17ae808d7d`;
the complete trained pair is
`5430dcafd000b86d250a51cc24370bb77365afe883a47d8e14a9d105474a6132`.
Generated evidence stays outside Git under client `game/core/tmp`, with local
study `v09-rdna-canary-20261107T060856Z` and node research study
`v09-rdna-tinygrad-20261107T0545Z-1wRmfX`. The failed initial attempt is separate.
The current default remains locked v0.9 draft plus qualified A19 combat.

Repository verification passed lint, TypeScript checking, all **7,498 common
tests** and **52 Python research tests**. The Python checks include the joint-head
capability, frozen-member controls, atomic checkpoint restoration and pair export.

## Frozen-member ceiling and marginal-score objective — November 7, 2026 UTC

Local research found two constraints in the training problem. Neither is a new
strength result. No model was trained or promoted in this cycle; the locked
v0.9 draft plus A19 combat remains the default.

### An unchanged ensemble member can make a correction impossible

Let `f` be the frozen member's complete-catalog probability distribution, `s`
an arbitrarily capable replacement student's distribution, and `q = (f + s)/2`
the served ensemble. For a nonnative action `a` and native action `n`,

```text
q(a) / q(n) <= (1 + f(a)) / f(n)
maximum log gain = log(1 + f(a)) - log(f(n))
```

This is a supremum over every possible student distribution, attained in the
one-hot limit on `a`. A frozen architecture and trust constraints can reduce its
achievable set further. If the bound is below margin one, improving that action's
training loss cannot make the deployed selector choose it. Native remains a
possible fallback. Normalizing only the eligible subset changes `f` and gives
the wrong ceiling for the shipped arithmetic ensemble.

`fixed_partner_gate_ceiling()` measures this bound with Float64 arithmetic and
a conservative 0.000001 numerical buffer before declaring an action blocked.
The trainer now records the fixed partner's capacity once per split, including
blocked eligible actions, blocked label improvements and reused-label oracle
ceilings. This diagnostic never filters training roots or substitutes for action
quality. The recorded baseline must remain possible under the bound.

The admitted historical 84-scenario pilot reproduced all 33 retained baseline
predictions exactly with the promoted weights. Using batch256 as the frozen
partner, as in the existing feature fits:

| Split      | Usable roots | Eligible nonnative actions | Blocked actions | Actions improving over recorded baseline in labels | Blocked improvements |
| ---------- | -----------: | -------------------------: | --------------: | -------------------------------------------------: | -------------------: |
| Train      |           19 |                         78 |              28 |                                                  6 |                    2 |
| Validation |           14 |                         57 |              10 |                                                  4 |                    0 |

This constrains the training signal in this small selected pilot. It does not
explain the failed held-out result: none of its four better validation labels
was structurally blocked. Reversing which member is frozen blocks one of six
training improvements and none of four validation improvements. Jointly fitting
both existing policy heads can remove this particular fixed-member obstruction
without adding a serving operator, but no such trained model is claimed here.

### World-pair preference is different from a mean-score target

Even draw-magnitude preference weighting still depends on how futures are paired.
Consider the same action A with scores `11111000` and action B with three wins:

| B's paired order | Mean A | Mean B | Favorable / unfavorable comparisons | Pair-loss optimal logit gap |
| ---------------- | -----: | -----: | ----------------------------------: | --------------------------- |
| `11100000`       |  0.625 |  0.375 |                               2 / 0 | Positive infinity           |
| `00000111`       |  0.625 |  0.375 |                               5 / 3 | `log(5/3) = 0.510826`       |

At the serving threshold of one, the first arrangement's preference gradient
raises A and the second lowers it. The marginal score gain is 0.25 in both.
These permutations demonstrate a property of the objective; they are not new
valid common-RNG worlds or evidence that the original paired collector is wrong.
Pairing remains valuable for estimating uncertainty in score differences.

Exhaustively rearranging the archived pilot's native labels finds threshold
sensitivity in one of five positive training comparisons and two of three
positive validation comparisons, spanning one family in each split. Those
conditional counts are not population estimates or gameplay gains.

The opt-in `pairLossObjective: "score-difference"` instead fits squared error
between served logit differences and scaled marginal terminal-score differences,
averaged equally over informative roots. All recorded labeled actions remain;
unknown actions receive no target, and roots with equal marginal means contribute
zero gradient. The original `"paired-preference"` objective remains the default.
The new registration must explicitly choose `pairLossWeighting: "roots"` and a
finite positive `pairScoreScale`; a preference-weight modifier is rejected.
For example, scale 0.1 makes an exactly fitted logit gap of one represent ten
match-score points. This is an illustrative scale, not a selected fit recipe.
Loss values from this objective are not directly comparable with preference CE.
Existing matched-recipe, teacher-preservation, observed-choice, fresh-game and
production-timing gates still apply. The frozen-member ceiling also still applies.

CPU functional tests cover the impossible-choice example, attainable bound,
complete-catalog normalization, padding, permutations, equal-root weighting,
explicit scale, unchanged marginal scores and invalid recipe admission. An actual
row probe compared 66 Python ceilings against independent Bun references with a
maximum discrepancy of `8.89e-16`. Loss and gradient were exactly unchanged after
independently permuting each action's futures on all 33 real rows. These checks
establish implementation properties, not learned-model strength.

### Fixed consensus ablation: failed development gate

A separate prospectively registered ablation retained an existing A19 neural
correction only when both original model members supported that same action at
individual logit margin one. Otherwise it returned the native searched decision.
It proposed no new corrections, changed no weights and added no rollouts.

The immutable engine was `babdd2ab`, with the same combat decision rule as
`9ccf9207`, using registered draft `ranked-unit-strength-a19-side-v4-w16-r4` and
setup `artifact-fit-v6:conditional-v1:sniper+t2a19`. This combat screen holds its
draft policy fixed; it is not a qualification of the separately bound locked-V3
production draft. Three maps, all nine doctrine pairs, physical sides and draft
seats were balanced. Admission completed 36 games, with 12 stock/reference pairs,
12 candidate control games, five exercised vetoes and 906 restoration checks.

| Games | Boards | Wins | Draws | Losses | Draw-aware score | Whole-board 95% interval |
| ----: | -----: | ---: | ----: | -----: | ---------------: | ------------------------ |
|   864 |    216 |  412 |     9 |    443 |           48.21% | 45.83–50.64%             |

The candidate made 16,361 neural calls and vetoed 529 of 2,839 original proposals
along its own trajectories. There were zero rejected actions. It failed the
registered 55% score / positive lower-bound gate. The separate 6,048-game bank
remains unopened, and timing is unqualified. Do not rescue the rule with a
posthoc subgroup or weaker margin.

Generated evidence stays ignored under the client's `game/core/tmp`, in
`v09-local-consensus-20261107T002732Z` and
`v09-combat-current-a19-20261106`. Consensus registration identity:
`e0c2bb4f5bd609ddbb3b262f86e2f515e2e83ca0506b816c025abc18b91ca5f1`.
The 33-row archived-input identity is
`7132fd2ed1f3788e24857b61fad0453e66a8732efe2cccfe2356ca9bb29da88a`.

## Local pooling, exact reuse and objective audit — November 6, 2026 UTC

This cycle runs locally against the immutable `9ccf9207` engine, with its complete
shipped A19 combat, two neural members, live ranked draft/setup, sideboard,
doctrines, splits and synergies. Subsequent shared-working-tree balance edits are
outside this experiment. The user-selected locked v0.9 draft plus A19 combat
remains the default. None of the changes below promotes a combat checkpoint.
These local combat screens hold the registered draft policy fixed; they do not
qualify the separately bound locked-V3 production draft.

### Eligible mean-logit pool: failed strength gate

The research helper `a19_eligible_logit_pool.ts` averages the two members' raw
logits and evaluates only candidates in the exact, completely scored primary
tie. It retains margin one and the original model weights. Mean-logit differences
equal differences from a geometric probability pool, so unevaluated candidate
partition functions cancel. **This changes the decision policy:** A19's shipped
arithmetic probability pool cannot in general discard those partition functions.
Do not present this as equivalent pruning of the shipped ensemble.

Admission passed 48 complete games: 12 stock/reference pairs and 12
full-catalog/subset pairs, with 1,126 exact candidate-logit checks and 1,776
restoration checks. Development then completed 864 games on 216 boards, balanced
over three maps and all nine own/opponent doctrine combinations. Physical side
and draft seat remain paired within each board.

| Candidate                | Wins | Draws | Losses | Draw-aware score | Whole-board 95% interval |
| ------------------------ | ---: | ----: | -----: | ---------------: | ------------------------ |
| Eligible mean-logit pool |  414 |    18 |    432 |           48.96% | 47.05–50.93%             |

There were no rejected actions. Candidate scoring work fell from 220,888 to
156,196 model-row evaluations, a 29.29% reduction. That structural saving is not
a measured end-to-end runtime improvement. The registered 55% development gate
failed; the separate 6,048-game confirmation bank remains unopened. The research
helper is opt-in and is not imported by a shipped AI factory.

### Exact entity-encoding reuse: opt-in performance research

`V09A19CpuModel` accepts `entityCacheRows`, default zero. A nonzero research
capacity caches only the two entity-encoding layers, using every input's complete
Float32 bit string, including signed zero. It never keys by creature ID or guesses
which units changed. Each model owns a separate bounded LRU; team pooling, actor
selection, globals, terrain and target selection are recomputed. Capacity is
limited to 1,024 rows. `unpackA19Model()` forwards the optional setting; the
promoted factory supplies none, preserving the uncached path.

At capacity 512, 108 A/A complete-match pairs (216 games) across three maps and
all nine doctrine combinations reproduced every match record and event/turn
digest. All 1,990 instrumented neural predictions matched both frozen original
and cache-disabled outputs exactly; 4,963 engine-restoration checks passed.
Unit regressions additionally cover input changes, entity permutations,
independent models, eviction, signed zero and invalid inputs.

Four counterbalanced model-only timing rounds replayed all 1,990 actual decision
observations chronologically, with fresh model instances per pass and no
manufactured adjacent duplicates. Original mean wall time was 2,612.43 ms,
cache-disabled 2,585.69 ms and cached 2,263.10 ms. Cached inference used **13.37%
less wall time and 13.04% less CPU time**. Real-game cache hit rate was 39.86%.
Every timed pass had the same output checksum. These local M4 measurements do not
establish a production whole-turn speedup or a strength gain; default capacity
remains zero pending the relevant timing gate.

A supplemental complete-game replay used 12 already-controlled games in each
arm, twice in counterbalanced order (48 replays). Every trajectory still matched.
Original mean wall time was 23.604 seconds versus 22.454 seconds cached, an
observed 4.87% reduction on this small replay. Neural prediction occupied only
2.69% of original wall time: its measured 168 ms saving accounts directly for
about 0.71% of original total time. Do not attribute the larger whole-game wall
difference entirely to saved matrix work, or generalize two passes into a
production performance guarantee. This cache alone does not fund materially
deeper whole-turn search.

### Draw-aware training payoff and limited archived-label audit

`paired_root_loss()` now supports `payoff_weighting="magnitude"`, registered by
the trainer as `pairPayoffWeighting: "magnitude"`. The historical `"sign"` mode
remains the default. A win/loss difference receives twice the weight of a
draw/loss difference. In a closed eight-world example, action A wins four
comparisons by 0.5, loses three by 1 and ties once: counting favorable worlds
prefers A although its expected score is 0.125 lower. Magnitude weighting corrects
that gradient. Both weighting modes are exactly identical on binary terminal
data. Fractional normalization preserves a full informative-root contribution
when only one draw/loss contrast exists. Receipts distinguish integer non-tied
comparison counts from effective payoff weight. No new fit is claimed here.

A separate functional counterexample demonstrates that arithmetic ensemble
pair-loss can improve by raising an unlabeled student's logit: changing its
softmax normalizer changes the members' relative influence without changing either
compared student logit. Mean-logit differences remove this particular gradient
shortcut. This is a property of the objective, not evidence that it caused a
previous candidate's regression, and it does not rescue the failed pooling trial.

The available archived 84-scenario coverage pilot contains 768 paired
continuation games, 19 usable training roots and 14 validation roots. All input
hashes were verified. Only eight training and seven validation roots had terminal
contrast. Selecting and evaluating on the same eight futures optimistically
estimated +8.22 and +4.91 score points. Averaging all 70 four/four world splits
reduced these estimates to +4.92 and +2.50 points; the conditional root-bootstrap
validation interval is -1.63 to +8.11. These are local oracle diagnostics on a
small, selected pilot, not a learned policy or gameplay win-rate improvement.
Seven usable roots in each split had the historical requested-phase fallback,
already excluded by the later strict collector. No sign/payoff preference
reversal occurred in this tiny pilot; it cannot establish how common the
counterexample is in the larger remote training corpus.

Generated observations, full manifests and results remain ignored under the
client's `game/core/tmp`. The local study suffixes are
`v09-local-eligible-pool-20261106T191707Z` and
`v09-local-entity-cache-20261106T193749Z`. Pooling registration identity:
`fbf8d4224e44a665349983a86c7afcec3d89c0a30b984d3b7f6501f3840b1f51`.
The original frozen source archive identity is
`d8954461a5c648e2efd1425361188c19ca35cf8dfdae790c70fb6fcea234115a`.

## Current-A19 transfer and independent-root objective — November 6, 2026 UTC

The user authorized continued combat research on the RTX 5090. The target is a
measured improvement over the complete A19 controller, including its shipped
two-model neural correction and placement, within the original decision compute
budget or at most 10% more. Research results retain their actual engine identity.

| Completed candidate                              | Opponent engine       | Games | Draw-aware score | Whole-board 95% interval |
| ------------------------------------------------ | --------------------- | ----: | ---------------: | ------------------------ |
| Previously locked next-fit checkpoint `e03eda8d` | Current `d62f5ae` A19 |   864 |           50.17% | 47.86–52.55%             |
| Strict feature-adapter finalist `99a5a03d`       | Frozen `d0fb4437` A19 |   768 |           47.79% | 46.09–49.48%             |

Neither candidate passed its development gate. Their confirmation banks remain
unopened, and neither artifact is promoted. The current-engine transfer passed
128 CPU prediction references, candidate/entity permutation checks, 12 complete
warm-start control games and 1,208 restoration checks before strength evaluation;
its maximum prediction discrepancy was below 0.000002. The older checkpoint has
no named Luck Blessing feature columns. Its trained column meanings are preserved
explicitly; current public status information still reaches the unchanged base
observation. This compatibility projection is part of that transfer experiment.

The strict acquisition completed all 1,536 registered scenarios and 13,464 paired
continuation battles, preserving missing roots without refills or outcome
filtering. Its 593 usable roots produced 383 training and 210 validation rows,
with all eight futures retained for each labeled action. Four matched rank-zero
and rank-four fits completed on the approved 5090 in 96.88 seconds of fit-stage
wall time. The validation-selected rank-four model reduced comparison-weighted
loss from 0.64222 to 0.62610, while average informative-root loss worsened from
0.63249 to 0.63391. Only 58 validation roots had non-tied terminal comparisons.
This disagreement motivates a new objective experiment; it does not establish
the cause of the full-game regression.

The research trainer now supports an explicit `pairLossWeighting: "roots"`
registration. It gives each informative decision one unit of loss weight while
retaining its paired worlds and action comparisons inside that decision. The
original comparison-weighted mode remains the default. Both losses are recorded
in receipts. Root-weighted checkpoint selection additionally requires observed
labels for every served gate choice and nonnegative average paired terminal gain
against the recorded baseline choice. Unknown catalog choices receive no invented
outcome. Confidence margin one, warm-teacher CE tolerance 0.03, minimum validation
improvement 0.005 and the four matched recipes remain fixed.

The new cycle reuses the sealed completed labels and qualified initialization;
its 34 CPU functional tests and fresh gradient/fold/inference admission passed.
One validation-locked finalist may enter a new balanced-doctrine current-engine
comparison: 864 development games, then 3,132 untouched games only after at least
55% score with the lower whole-board 95% bound above 50%. Previous development
banks are excluded. Production timing remains a separate model-bound gate on a
quiet production CPU. This research patch changes no shipped combat profile.

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
| `cf85d3b9dc37`             |  406 |    352 |    10 |       52.86% |           53.52% |
| `7e9b9ed69458`             |  411 |    351 |     6 |       53.52% |           53.91% |
| `ba817b8a5134`             |  401 |    358 |     9 |       52.21% |           52.80% |
| `8539c26d7c62`             |  404 |    354 |    10 |       52.60% |           53.26% |
| Prior lower-LR reference   |  415 |    345 |     8 |       54.04% |           54.56% |

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
