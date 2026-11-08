# Native v0.9 combat research — November 8, 2026 UTC

This continuation trains **native v0.9 combat**, using `StrategyV0_9` and its 166-feature fixed-point
candidate ranker. A19 supplies offline teacher decisions and remains the opponent. The evaluated native
seat must execute **zero A19 search calls**. This distinction matters: the previously accepted 50.36%
checkpoint improves the A19 neural pair, and is not a trained native v0.9 combat model.

The accepted `a19-full-policy-5036-20261108` checkpoint remains immutable. The default still uses locked
V3 draft with v0.8/A19 combat; the embedded native artifact remains untrained and unpromoted.

## Frozen engine and native observations

The acquisition source is `8a8d731b9ed7920013d8f364e183b724e4d4df2e`, including the shared native
candidate enumerator and `captureV09NativeTeacherFrame()`. Capture records candidates, features and hard
guards **before** the A19 teacher decision. An absent or guarded teacher action is missing training evidence;
it is never relabeled as the anchor. Capture retains every root from both teacher seats.

The feature contract is `hoc.ai.v0_9_features.il_v4.v1`, SHA-256
`01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e`.
Both seats retain locked V3 draft and the frozen nonfight setup. Four physical/draft mirrors stay in the
same board family and split. No match outcome selects training decisions or determines their labels.

On the 9800X3D/RDNA research host, acquisition is preserved under
`/root/hoc-research/v09-native-acquisition-20261108T052947Z`:

- Registration SHA: `5f63851e67535eab37eb137ec1aa694528f7750fa8da64bdf890b651a369779a`.
- Source capsule SHA: `914b13e9ceedf529847b06b0ad78caaa5507bb90c51f2bb7d4a9df16d4529599`.
- Final collection budget: 162 training boards and 54 validation boards, four games each.
- Development reference: 108 boards / 432 native-anchor-versus-A19 games.
- Controls: twelve capture/uncaptured teacher pairs with identical trajectories, plus four native-anchor
  games checked through the authoritative native preflight.

The complete development reference scored **19.4444%**: 82 wins, 4 draws, 346 losses. It executed zero
native-seat search calls. This is a development baseline under this source/setup, not fresh confirmation or
an update to the historical 7,056-game comparison.

Final admission retained 27,210 training and 9,429 validation decisions from 41,256 observations. Native
guards excluded 4,497 teacher choices (10.90%); another 120 choices (0.29%) were absent from the catalog.
On validation, excluded choices included 570 obstacle attacks, 250 ranged attacks and 245 waits. These
are action-family counts, not exact rejection causes or evidence that a particular guard harms strength.
Only two accepted validation labels shared identical features with an earlier eligible candidate. Thus
exact feature aliasing is uncommon in this corpus; guard exclusions deserve a separate controlled audit.

## Learner and numerical checks

The optional Python backend is `src/simulation/v0_9/python/native_fixed_point_tinygrad.py`. It trains all
layers of a native dense ranker, rather than loading or fine-tuning an A19 proposal pair. Imports start no
job. CPU tests cover masked gradients, signed rounding, accumulator limits, quantized forward/export,
template preservation and complete parameter restoration.
`NativeMarginCalibration` additionally provides streaming validation-only margin selection, using the
native tie, unsafe-anchor and all-guarded fallback rules. The portable module's eleven CPU tests passed,
including differential checks against the existing scalar integer reference and selector/calibration cases.

The research environment pins Tinygrad 0.14.0 and NumPy 2.4.4, using gfx1201/KFD with FP32 and tensor
cores/TF32 disabled. Training uses masked teacher cross-entropy plus a teacher-versus-anchor term, then
quantization-aware fitting with frozen power-of-two layer shifts. Normalization uses training observations
only. Admitted board shards are streamed into memory-mapped arrays; resident GPU banks avoid repeated
feature extraction and host-to-device transfer. Independent integer validation overlaps the next GPU fit.

Exports retain `hoc.ai.v0_9_model.v1`, `promoted=false`, and `qualification=null`. The canonical TypeScript
sealer supplies the model identity; it does not install the artifact. Before playing, each model must match
the native integer scorer and served selector on at least 96 complete validation decisions, including every
candidate score. Numerical comparison treats JavaScript negative zero as integer zero; all nonzero integer
scores must match exactly. Actual games also check the trained artifact SHA, authoritative native preflight,
zero model errors and zero native-seat A19 search calls.

## Initial pilot and separately registered continuation

The initial learner, `v09-native-learning-20261108T063133Z`, is preserved unchanged. Its registration SHA is
`e995a7598c78c3af75ad3d90dae5e46a458176e3987c91af821347206e7aa2bf`. Four fits on the cumulative g002
corpus reduced validation loss but failed its exact-teacher-agreement gate: served agreement was
46.26–47.01%, versus the anchor's 50.54%. An assertion distinguishing JavaScript `-0` from JSON `0` also
stopped its numerical preflight. No learned-model development or fresh games were opened. These fits
remain failures under that protocol.

The follow-up, `v09-native-learning-20261108T063741Z`, is a separate experiment, registered before fitting
or opening strength results:

- Registration SHA: `2be73ed41b1b020a527b9d657768a0e7fdfa45abb423b570d7a273f3432f45d7`.
- Source capsule SHA: `2ea981835f157245b4c42d2d76c95426e4018af42f0de80df471bd2d6be53794`.
- Uses the complete final g003 corpus and four fixed recipes: 64/32, 96/48 with two seeds, and 128/64/32.
- Calibrates the override margin on validation only, over fixed integer margins
  `1, 16, 64, 128, 256, 512, 1024, 2048, 4096`; ties prefer fewer overrides and then a larger margin.
- Exact teacher agreement is diagnostic. Model admission requires a finite valid artifact, exact native
  integer parity, nonzero overrides and masked loss at least 0.01 below uniform.
- Every admitted recipe plays the entire 432-game development bank. No subgroup or partial score selects
  a model. One finalist is fixed by highest whole-bank score among models whose paired gain over native
  anchor has a positive whole-board 95% lower bound. Ties prefer lower recipe ordinal.
- The initial pilot's reserved fresh bank remains excluded. The continuation registers a different fresh
  bank, excluding previous banks and their derived setup/combat channels.
- Fresh confirmation runs 1,512 board families: 6,048 learned-native-versus-A19 games and 6,048 matched
  native-anchor-versus-A19 games. A failed finalist has no fallback replacement.

All four final-corpus models completed GPU fitting in 162 seconds. Canonical runtime parity passed on
128 complete validation decisions per model: 512 decisions and 7,544 integer candidate scores in total.
Every model selected margin 512 from its declared validation grid. Served teacher agreement was
53.04–53.46%, versus the native anchor's 49.88%; this is validation agreement, **not a win rate**. The GPU
process's observed peak VRAM was approximately 2.68 GiB. Four complete development evaluations follow;
their policies are fixed and their results do not trigger further fitting in this campaign.

Fresh native improvement requires a positive paired whole-board 95% lower bound. The separate A19 target
requires at least 52% score and a whole-board 95% lower bound above 50%. These are separate outcomes;
improving native v0.9 from its anchor does not establish that it beats A19.

No result bypasses the existing native qualification gates. Production timing, the original qualification
budget and comparison with the accepted hybrid reference remain required before a production claim.
Loaded-node timing is descriptive and cannot establish the user's same-compute/+10% requirement.

## Completed fresh result

Recipe 2 (96/48 hidden units, seed 117, margin 512) was fixed before fresh confirmation. Its native model
SHA is `4e1d8992717784995447f28ccdf577692e8fb670f6915add313ff11425f77ce3`; the exact sealed artifact
file SHA is `9408f462fc2a39f31e2a25eae48bad5956257800bb20df1bb5295cae818f3c0d`.

Across 1,512 fresh board families and 12,096 matched battles:

| Native policy                    |  Wins | Draws | Losses | Score against stock A19 |
| -------------------------------- | ----: | ----: | -----: | ----------------------: |
| Original untrained native anchor | 1,126 |    38 |  4,884 |                18.9319% |
| Trained native recipe 2          | 1,520 |    61 |  4,467 |                25.6366% |

The native gain is **+6.7047 percentage points**, with a prospectively specified whole-board 95% interval
of **+5.6713 to +7.7546 points**. Independent reconstruction of every raw board record, with 20,000
separate NumPy bootstrap resamples, gave **+5.6630 to +7.7546 points**. The absolute score's original 95%
interval is 24.5866–26.6782%. Native improvement passed; the 52%-against-A19 target failed.

All 132,275 native decisions had matching authoritative preflights, zero native-seat A19 search calls and
zero model errors. Loaded-node native decision timing was 0.790 ms median and 5.611 ms p99; its maximum
was 37.399 ms. This is not production timing qualification or a completed compute-allowance comparison.

The read-only research reference is preserved at
`/root/hoc-research/checkpoints/native-v09-2564-20261108-4e1d89927177`, including the exact model,
registrations, all 1,512 paired board records and independent verification. Archive SHA:
`13dacc6a152476f972bf29d8825c578ae5a010c68f5486c6a5d4400cbf72557f`; manifest SHA:
`8abaa6702c70512a891d12670d0d9f67cd65cf6c3ad919226ebe2b5ab84df2b0`; independent verification SHA:
`edfc720d3bb96ca7cc5afd6016e86cd1e56f8a0b1424cfddfa0a91cafc23631b`. A hash-verified copy also exists in
the ignored local research workspace. The model remains unpromoted, and the production default is unchanged.

## Next scale campaign

The next independently registered collection is `v09-native-scale-acquisition-20261108T170905Z`, with
registration SHA `75b5546aefda689ab30d4e702b2311fa51c8d78d8aab3d6fba45204f888dd63b` and capsule SHA
`286c87cea2d729b2b237d2b0fd9be0ebe74e9c447bfe7868116fa1c552dea9dc`. It budgets 648 training and
216 validation boards: **3,456 teacher games**, four times the first corpus. The engine, teacher, draft and
nonfight profile stay frozen; new seeds and broader observations supply the additional evidence.

Its learner is `v09-native-scale-learning-20261108T170905Z`, registration SHA
`004215d76608afbedca60ed13cf6b791922fc9a1a1be0f97613d2d107e7293c7`, capsule SHA
`09434a80d108c443caa2af8202f3b6f136f9a27b81171cf9f7ff1f90ce0082cc`. Fixed recipes test 96/48 with
two seeds, 192/96, and 192/96/48. Complete cumulative data banks may coalesce according to readiness;
GPU fitting, CPU integer validation and development evaluation use separate pipeline stages.

Both development and fresh confirmation compare candidates with the **confirmed trained native model**
`4e1d89927177`, each facing the same stock A19 and matched openings. The untrained 18.93% policy is no
longer the improvement reference. Complete development results select one finalist before another 1,512
fresh board families / 12,096 matched battles. All previous banks, including unopened reserved banks, are
excluded. The native side still executes zero A19 search, and nothing is promoted automatically.

The initial scale fitter stopped before model construction or SGD: KFD returned `EAGAIN` while mapping
a 1.20 GB host feature allocation. Collection and its confirmed-reference baseline continued. This is
preserved as a failed execution of learner registration `004215d76608afbedca60ed13cf6b791922fc9a1a1be0f97613d2d107e7293c7`.

The separately registered recovery is `v09-native-scale-recovery-20261108T180216Z`, registration SHA
`7df627b451c042e379442f496f9d993dfafbf159d50b6c06bc2d7ef42bb25970`, capsule SHA
`e870e42f420d1335b588e0ae7b8dda57ecd6cd0bf4d78d1ad686e7705d40c545`. It retains the source, recipes,
loss, data admission and confirmed native reference, and reserves another unused fresh bank. It changes
input transport: normalize 128-row FP32 chunks, fill resident GPU storage, and verify every chunk by exact
readback before training. Each host chunk is at most 8,159,232 bytes. No observations are dropped and
precision is unchanged. The full previously failed training/validation banks (24,879 decisions) passed
exact GPU readback in 9.34 seconds. The portable backend's expanded thirteen CPU tests also passed.

The recovery completed recipe 1 on g002, including float fitting, QAT, independent integer validation and
export. The AMD kernel subsequently reported a GPU virtual-memory fault and reset the device while the
process was moving to another recipe. Preserve this as a failed, incomplete four-recipe run; no candidate
strength games had opened. The chunked-upload fidelity result remains valid, and a GPU runtime reset is
not evidence of improved strength or a diagnosis of defective hardware. No manual driver reset or live
service restart was performed.

Collection nevertheless completed all 3,456 teacher games, admitting 113,986 training and 37,464
validation decisions. Keep this full corpus for a separately validated training backend.

## CPU-only evaluation of the completed scale candidate

The sole completely exported pre-reset model is separately evaluated under
`v09-native-single-evaluation-20261108T182917Z`, registration SHA
`32e17ddce23e39b742e66aecbaff92d811a06a64b42d407f26824ff3259073ad`, capsule SHA
`394ad0787c107a21482a539ac7da725c596d6a4cf78de2b08db22a9a35ebea85`.

This freezes g002 recipe 1 before any battle-strength result. It is the only completed candidate, rather
than a model chosen by observed wins. Its model SHA is
`4749da06ec07bfd08db7ec6c2bbe03ba6dc4e73847e67585804dbccc253e7bb9`; sealed file SHA:
`327aff190b7bfa7f74ecb41a2a8dc9fc4afc31d0b8fe48d2329fb4893dfe3a5e`. Canonical integer parity passed
on 128 decisions / 2,053 candidate scores, followed by twelve complete native smoke games. Its 54.11%
validation teacher agreement is not a battle win rate.

The CPU-only study runs the complete 432-game development bank for diagnostics and operational checks.
If these software checks pass, it always runs its new reserved 1,512-board / 12,096-battle fresh bank,
regardless of development score. The confirmed native reference remains `4e1d89927177`, facing the same
stock A19 with matched openings. The new candidate has no strength-dependent replacement or stopping
rule. Fresh paired confidence determines whether native strength improved; promotion remains disabled.

## Second independently confirmed native gain

The single fixed larger-data candidate completed its full fresh comparison. On this bank, the prior native
reference scored **24.6610%** against stock A19 (1,461 wins / 61 draws / 4,526 losses); the new model scored
**25.8598%** (1,532 wins / 64 draws / 4,452 losses). Both policies played 6,048 games on the same 1,512
board families. Compare these matched scores; the earlier reference's 25.6366% came from a different bank.

The gain is **+1.1987 percentage points**, with the registered whole-board 95% interval **+0.1819 to
+2.2321 points**. Independent reconstruction of all 12,096 battles and 20,000 separate NumPy resamples
confirmed **+0.1653 to +2.2073 points**. Independent verification SHA:
`2b78b931aa76a4a85ec5c16ae303ece2e3d1f6cfc666dca637e6f0684ffe00e5`.

The architecture is unchanged at 96/48 hidden units and **20,592 multiply-accumulates per candidate**.
Observed mean decision time was 1.0269 ms versus 1.0256 ms (+0.13%); total native decision time increased
0.91%, including its additional decisions. Loaded-node p99 was 6.390 ms versus 6.326 ms. This meets the
requested compute allowance on these research observations; production timing remains unqualified.
All 135,172 candidate decisions and 134,122 reference decisions had matching authoritative preflights,
zero native-seat A19 search calls and zero model errors. The 52% target remains unmet.

The model is preserved read-only at `native-v09-2586-20261108-4749da06ec07` on the node. Its full archive
SHA is `75e79f639610a118a86adbe43bc3c234a828c332c0d7395ae9db5af77e42e273`. The committed research
checkpoint is `src/simulation/v0_9/checkpoints/native_scale_20261108/`, loaded explicitly with
`loadNativeV09ScaleResearchModel()` from `native_scale_checkpoint.ts`. Its small compressed bundle
restores the exact original 70,719-byte unpromoted artifact; no source metadata is rewritten. The compact
evidence fixture in `docs/evidence/v0_9_native_scale_20261108.json` reconstructs every score and includes
10,479 additional consumed/reserved native base seeds. Merge these with the other project ledgers.
Numerical fixtures, independent-copy tests and default-policy checks keep loading separate from activation.

## GPU-free native expert committee

The next fixed experiment composes native experts `4e1d89927177` and `f907fc07a28a` with
`fuseV09NativeResearchModels()` from `native_fusion.ts` (utility commit `4cfdafa8`). It requires identical
feature, normalization, engine and quantization contracts. The hidden paths are copied exactly into a
192/96 network with zero cross-expert weights. One final rescale averages the unrounded output heads;
the result can differ from the mean of already-rounded parent scores by at most one integer output unit.
There is no retraining, requantization, search, or activation of a production model.

The source is registered as `v09-native-fusion-study-20261108T220850Z`, registration SHA
`6d508b22963f75937304cda352a8fa400406b84b0a8cf86635bbfccf25d3b1f5`, capsule SHA
`cd8d81c76a0216e41923c847dabf59e71257e04928fa1b55a1acf75c5c47560a`. Both parents and the single
committee were fixed before its strength results. Margin 512 was selected on the old validation split only.
No alternative parent pair or replacement candidate is allowed in this study.

Validation now groups rows by their exact candidate count: 145,174 real candidates instead of 905,184
padded slots, **6.24 times less scoring work**. Every one of the 9,429 decisions, guards and labels remains.
Exact compact-versus-padded integer checks, real-reference mean checks and duplicated-expert controls
passed. Validation completed in 3.41 seconds. Its 53.42% teacher agreement is not a win rate.

On fixed closed vectors, scoring a full 96-candidate decision took 3.77 ms p99 for the committee versus
1.75 ms for one expert, excluding feature extraction. Thus this wider model costs more than a single native
expert; the study measures full native decision costs against the A19 opponent and enforces a 20 ms native
research p99 ceiling and a 1.10 mean-cost ratio. These remain research measurements, not production
qualification. Timing instrumentation and duplicated-expert policies must reproduce original gameplay
traces exactly before strength evaluation.

The full development bank has 108 new families. Fresh comparison uses 1,512 new families / **18,144
battles**: committee, prior native reference and larger-data native reference each face matched stock A19.
The newly confirmed `4749da06ec07` model was already included as the second comparison before its result
was read; the original role name `larger_data` remains in this fixed protocol. An advancement must beat the
current reference, and a strongest-native claim requires positive paired intervals against both references.
Development strength does not select or cancel the single candidate; numerical, operational and timing
checks gate fresh. All previous banks, including reserved unopened banks, remain excluded.

The complete 1,296-battle development bank passed these checks: zero native search calls and model
errors, committee mean decision time 1.701 ms and p99 9.868 ms. Its +0.81-point score difference against
each native reference is inconclusive (both paired intervals cross zero). Fresh opened with the original
fixed candidate and comparisons; the development result does not establish another gain.

## Validation and ownership

The engine capture change passed 7,600 common tests, TypeScript compilation and the common build with
`HOC_TEST_WORKERS=2`. The seven backend numerical/gradient tests passed on the node's CPU before GPU
fitting. The research services use fresh directories, a shared GPU lease and memory/temperature limits.
Only the earlier owned hybrid research service was stopped to prioritize native combat. Existing game,
database and site services were left running.

The committee/checkpoint continuation passed 30 focused tests (17,167 assertions), ESLint, TypeScript
typecheck, compilation, JSON/generated-file copying and a cold compiled checkpoint load. The broad common
suite passed 7,659 tests with one sandbox process-inspection failure; that complete 18-test process-guard
file passed when rerun with process access. No unrelated test or live default was changed.

Run outputs, datasets, packed arrays, model candidates and HTML reports remain outside Git. Preserve the
registrations, failed runs, frozen source and complete raw board results when continuing this work. Never
change an existing campaign's selection rule or substitute a new model after its fresh bank opens.
