# Native-catalog teacher-choice ranker

The richer action representation improves prediction but does not qualify a forecast policy. The
[complete fit evidence](evidence/barrel_native_catalog_ranker_fit_results_20261118.json) preserves the
prospective registration, all six recipes and thirty recipe/temperature results, exact source bodies,
raw artifact hashes, original-family sufficient statistics and independent inference verification.
The fitted artifact remains inactive. No serving code or default changed.

The verified 8,732-record input retains its original whole-family split: 5,388 training decisions,
1,587 validation decisions and 1,757 unopened test decisions. Each candidate has 191 public/static
features, including an explicit outside option. A shared tanh scorer ranks variable-sized candidate
lists with partial legality masks. Missing catalogs, unavailable resurrection recipients and inputs
outside the fitted feature range require abstention. Later rollout scores, actual choices, seeds,
identities and battle outcomes are excluded from predictor inputs.

Before fitting, four NumPy tests check gradients, a synthetic learning signal, prior normalization
and family aggregation/bootstrap edge cases. Five Bun tests independently check masked inference,
unsupported-input abstention, forbidden metadata access and six NumPy synthetic posteriors. The
initial synthetic learning test needed the full prescribed 400 steps to reach its fixed threshold;
that development correction used no real game records and is preserved in the registration.

The frozen development fit uses 32/64 hidden units, three L2 values, 400 Adam steps and five fixed
temperatures. Selection minimizes validation logloss; it never selects by proposal count or precision.
The selected 64-unit, L2=0.001, temperature=1.5 model achieves validation logloss **1.27494** versus
**1.77396** for the training-only action-group prior: improvement **0.49902**, whole-family bootstrap
95% **[0.44806, 0.54794]**. Exact teacher-choice accuracy is **44.8645%**, not a game win rate.

Only **four decisions in four families** receive an admissible non-cleanup prediction above the
fixed 0.85001 confidence threshold. All four agree with the teacher, but the fixed minimums are
100 proposals and 60 families. Both support gates fail. The apparently perfect precision and its
bootstrap interval do not replace those failed gates. No threshold is lowered, no final refit is
performed and the test is not parsed. The older opened 805-label test remains closed too.

Post-fit diagnostics on the already-opened validation records find only **23 high-confidence**
predictions: nineteen barrel clears, three waits and one move. All four alternatives already pass
public completeness and distribution checks. Those guards therefore do not cause the coverage failure.
Of 1,587 decisions, 189 have some out-of-range feature and seventeen have incomplete public input;
none removes an otherwise high-confidence alternative. No recipe or threshold changes follow.

The fit finishes on Puffalo in **16.43 seconds wall / 30.91 seconds CPU**, using two low-priority BLAS
threads. These are training costs, not inference latency or measured gameplay speed. Independent
Bun verification reproduces all 1,587 validation posteriors within **8.89e-16**, exactly matches all
policy decisions, masks, baselines and original-family sufficient statistics, and verifies the test
access protocol. It does not independently reimplement NumPy's bootstrap random generator.

This is reused older-v11 teacher evidence. It establishes neither current-v12 authoritative-memory
parity nor combat strength. Preserve this failed support result and its frozen recipe. Any distinct
continuation still needs legal public inputs, the actual committed-turn/memory contract, independent
fresh whole-family strength and the user's **overall-average +10%** complete fight/decision compute
bound. There is no automatic activation or deployment.

## Feature identifiability audit

The separate [train/validation audit](evidence/barrel_catalog_identifiability_results_20261118.json)
checks whether distinct actions have identical allowed feature vectors. A shared scorer gives equal
probability to every valid option with the same vector; with two such options neither can exceed
one half. This could make a confidence gate unreachable even with perfect fitting.

Independent Python and Bun reconstruction agree on all **6,975 already-opened training/validation
records**. Five training targets have an identical valid feature rival; **zero of the 1,587 validation
targets do**. Before OOD abstention and assuming perfect learning, 1,126 validation records in 233
families could therefore supply a correct high-confidence alternative. This is a structural ceiling,
not achieved support or a claim of learnability. Duplicate vectors do not explain the four-proposal
validation result.

Complete ordered inputs repeat with contradictory selected labels in eight training groups and one
validation group. This audit does not identify whether those differences come from missing state,
private search chance or another source. It does not prove other labels are predictable. No feature,
threshold, model weight or failed gate changes; the new held-out test remains unopened. All model and
battle-strength claims retain their previous limits.

## Fixed normalization audit

The separate [normalization audit](evidence/barrel_catalog_normalization_results_20261118.json)
checks the actual selected model's normalized, clipped inputs, rather than only raw feature vectors.
Independent Python and Bun reconstruction agree on input-group counts, per-feature clipping counts
and OOD-row counts across all 6,975 opened records. Both reconstruct binary64 vectors under the
original normalization rule. No fitter is imported.

Clipping introduces **zero additional valid-option aliases or contradictory ordered-input groups**.
The five aliased training targets and zero aliased validation targets remain unchanged; the combined
nine contradictory input groups also remain unchanged. Validation has 412 clipped coordinates across
189 rows. Before OOD, 1,126 complete-input alternative targets have unique vectors; after the unchanged
OOD rule, 979 do. Those are necessary-condition ceilings under perfect learning, not achieved support
or evidence of learnability.

This rules out newly identical clipped vectors as an explanation of the four-proposal validation
result. It does not prove clipping preserves every useful distinction in feature distances or rule
out optimization effects. No feature, weight, temperature, threshold, mask or original gate changes;
the 1,757-decision test remains unopened. This diagnostic supplies no combat gain or compute claim.
