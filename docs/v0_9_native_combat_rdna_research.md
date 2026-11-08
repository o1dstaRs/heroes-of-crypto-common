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

## Validation and ownership

The engine capture change passed 7,600 common tests, TypeScript compilation and the common build with
`HOC_TEST_WORKERS=2`. The seven backend numerical/gradient tests passed on the node's CPU before GPU
fitting. The research services use fresh directories, a shared GPU lease and memory/temperature limits.
Only the earlier owned hybrid research service was stopped to prioritize native combat. Existing game,
database and site services were left running.

Run outputs, datasets, packed arrays, model candidates and HTML reports remain outside Git. Preserve the
registrations, failed runs, frozen source and complete raw board results when continuing this work. Never
change an existing campaign's selection rule or substitute a new model after its fresh bank opens.
