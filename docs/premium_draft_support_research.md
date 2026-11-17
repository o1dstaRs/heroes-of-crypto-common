# Support, timing and repeatability in historical draft learning

The historical Premium matchup model predicts whole-army outcomes. That does not establish the value
of replacing one current pick: earlier drafting, opponent composition, setup and combat all influence
the recorded outcome. The matched final-pick study in `premium_matched_draft_research.md` failed its
validation screen. Its qualification and confirmation banks remain unopened.

## Completed training audit

The separate `premium-draft-support-audit-20261117` capsule uses only the predecessor's 216 training
families and 2,592 existing fights. It never reads the predecessor's validation SQLite. Four fixed
ridge-100 recipes used six whole-family folds, with 180 training and 36 held-out families per fold.
All arms, physical seats and combat futures from a family stay in the same fold. Train-fold RMS scales,
family weights and a 0.03 predicted-gain margin are fixed. There were 24 closed-form CPU fits, no full-bank
refit, no iterative optimizer steps and no GPU work. Python/Bun independently verified all 6,912 held-out
predictions, choices, scales and normal equations.

The opened predecessor validation motivated this work, so it is exploratory. Each policy selects 864
existing conditional outcomes, not new ranked matches. All four screens failed:

| Recipe                                  | Gain against current, score points | Whole-family 95% interval |
| --------------------------------------- | ---------------------------------: | ------------------------: |
| Historical prior plus original residual |                          −0.405093 |    −3.009259 to +2.141204 |
| Antisymmetric residual                  |                          −0.347222 |    −2.893519 to +2.199074 |
| Antisymmetric direct gain               |                          −0.289352 |    −2.546296 to +1.909722 |
| Direct gain with support descriptors    |                          −0.405093 |    −2.893519 to +1.967593 |

The four-recipe adjusted intervals also cross zero. No recipe became a serving policy. Removing the
historical prior's offset or adding support descriptors alone did not establish an improvement.

The historical prior's replacements clearing its 3-point margin predicted an average +12.05 points on
137 changed training boards; their observed paired mean was −2.19 points. Including unchanged boards,
the raw-prior policy gained −1.388889 points [−4.803241, +2.141204]. This calibration failure is measured
on matched conditional outcomes; it is not an independent test of ranked strength.

## Legal support features and observed training targets

`src/simulation/premium_draft_support_features.ts` is research-only. Its 28 descriptors distinguish
printed resurrection capability, eligible recipients, healing of a front creature, buff/control/damage
spell charges, movement and public opponent roles. They require complete legally visible rosters.
They do not guess paid quantities, split plans, aura reach, future casualties or hidden setup. Differences
are antisymmetric under swapping the same alternatives and exactly zero for no change. No default
profile imports this helper.

The separate `pick-support-targets.sqlite` derives observations from the original training games:

- 216 training families, 2,592 existing fights and 1,728 paired score targets.
- 33,460 original-unit records and 3,797 support-delivery records.
- Zero new games, models, validation families or production snapshot changes.

Both the Bun builder and independent Python verifier check every raw hash, score and normalized row.
Damage uses actual committed HP loss, with explicit source attribution. Healing and resurrection use
actual HP gained, not requested HP. Missing resurrection/heal source IDs are resolved only by a unique
committed spell event with the exact target; ambiguous sources remain unattributed. Capacity changes,
regeneration and HP changes outside the canonical health operations remain separate. A zero-HP event
can be followed by resurrection and is not always a terminal death.

Across changed rosters, compare the remaining creatures by name and original team role, not unit UUID.
Native setup can change positions, synergy selections and split counts. These observed quantities are
auxiliary training targets, never legal draft inputs or direct evidence of a mediated causal effect.
Longer fights also change total damage and turn counts. The production Premium SQLite is preserved.

## Why a unit-only replacement rule is insufficient

Among the raw prior's training-only replacements, Tsar Cannon to Hydra was the largest negative
contribution: 20 boards, 80 existing outcomes per arm, a −18.75-point within-bucket mean. The replacing
stack dealt 420 fewer source-attributed HP of damage in the first two laps on average. Other allies
gained 115 early damage, insufficient to replace that loss in the observed games.
The exact 160 existing traces show first-lap enemy damage in 71 of 80 Cannon outcomes and 43 of 80
Hydra outcomes. The final-pick stack dealt no enemy damage during the first two laps in 4 Cannon
outcomes versus 16 Hydra outcomes. All twenty training families were retained, including wins.
The final-pick stack first reached zero HP by lap two in eight Cannon outcomes versus forty Hydra
outcomes; zero HP remains distinct from irreversible elimination. Nine Hydra outcomes included a
committed obstacle attack by lap two, versus none for Cannon.

An independent decomposition of the frozen predictor explains why it still favored this replacement:
its average unit, map, doctrine, ally and counter contributions were respectively +7.1104, +3.6449,
+0.9425, −4.0666 and +4.3996 predicted points. These add to +12.0308 points. The historical unit/map
terms outweighed the model's own ally-fit penalty. This is an exact attribution of a linear prediction,
not a causal estimate of each term's effect in battle. All 432 training action decompositions were
reconstructed independently in Python.

Magic Dragon to Hydra had the opposite descriptive mean on a different 20 training boards: +10.625
points. The replacing stack dealt less damage overall, while the other allies dealt 410 more damage
and had fewer early zero-HP events on average. Angel to Hydra was positive on twelve training boards
but negative in the previously opened validation bucket. These are small, posthoc groups with noisy
outcomes and naturally reacting setups. They justify measuring timing and team contribution; they do
not justify a universal unit preference or a default override.

## Separate fixed future-repeatability diagnostic

The original two-future action-effect correlation was 0.279554, whole-family 95% interval
[0.157424, 0.393149]. Projections from its variance decomposition are assumptions, not measured
policy gains. A separately registered diagnostic directly tests repeatability:

- 54 old training families, six per map/opponent-doctrine combination, chosen by hashes without
  outcome filtering. All acting armies are Spymaster.
- Eight new matched combat futures, two physical seats and all three original pick arms:
  2,592 new conditional continuations, zero new independent boards.
- Exact original public draft, native funding, splits, formations, barrels, spellbooks and full
  v0.8/A19 combat. Actual hidden opponent inputs never enter the models.
- Raw prior, original full-training fit and all four cross-fit references locked before new outcomes.
  The original full fit saw these families; the fold models excluded their respective whole families.
- Old-outcome teacher transfer and first-four-new-future teacher transfer to the last four are separate
  outcome-selected diagnostics. Neither teacher is a deployable policy.

Registration SHA-256 is
`c5d4d06c841df2c2bcece93b72bae42ade5ec70e9019875ce17d60bc0433287f`.
The independent choice audit reconstructed 432 feature rows and all 378 reference choices from public
inputs and frozen artifacts. It verified all 648 original games used for teacher choices and read no
new outcomes. The diagnostic adds no fits and cannot qualify a default. Its hard CPU deadline remains
November 17, 2026, 18:52:41 UTC, at most twelve nice-19 Puffalo workers and no GPU.

All 2,592 new continuations completed. Independent remote/off-node verification reconstructed 125,117
turns, 301,463 event/health operations, every normalized SQLite row and 66 whole-family contrasts and
diagnostic groups. Every source, locked choice and registered case was preserved. Original post-processing
failures remain archived: the analysis needed a closing brace in its final print statement, and the
SQLite insert needed seven placeholders for seven columns. Separate corrected copies finalized the
artifacts without repeating fights, fitting a model or changing statistical formulas.

Each fixed reference below selects 864 conditional outcomes on the same 54 old training boards:

| Fixed reference                      | W / D / L      | Draw-aware score | Gain, points | Whole-family 95% interval |
| ------------------------------------ | -------------- | ---------------: | -----------: | ------------------------: |
| Current                              | 323 / 14 / 527 |       38.194444% |     0.000000 |                         — |
| Historical prior                     | 323 / 5 / 536  |       37.673611% |    −0.520833 |    −5.381944 to +4.282407 |
| Original cross-fit residual          | 321 / 10 / 533 |       37.731481% |    −0.462963 |    −3.993056 to +2.893519 |
| Antisymmetric residual               | 317 / 11 / 536 |       37.326389% |    −0.868056 |    −4.340278 to +2.430556 |
| Antisymmetric direct gain            | 328 / 12 / 524 |       38.657407% |    +0.462963 |    −1.909722 to +2.951389 |
| Direct gain with support descriptors | 332 / 13 / 519 |       39.178241% |    +0.983796 |    −1.099537 to +3.298611 |
| Original full-training fit           | 332 / 13 / 519 |       39.178241% |    +0.983796 |    −2.025463 to +4.166667 |
| Old-outcome-selected teacher         | 356 / 12 / 496 |       41.898148% |    +3.703704 |    −0.347222 to +8.043981 |

The original full fit saw these boards during training. None of these known-board results qualifies a
policy, rescues an earlier failed screen or permits choosing the best reference retrospectively.

Choosing a branch using the first four new futures produced a +11.458333-point selection mean. The
same choices retained **+7.175926 points [ +2.199074, +12.962963 ]** on the last four futures: 192 wins,
3 draws and 237 losses, 44.791667% draw-aware score, 432 selected outcomes on 54 old boards. This teacher
uses outcomes and is not deployable. It demonstrates repeatable conditional opportunity, not a ranked
win-rate gain or proof that the opportunity is predictable from legal inputs. Opponent hidden setup
remains fixed across futures. Old-two/new-eight action-effect correlation was 0.484618
[0.329850, 0.620908]; new-four/new-four correlation was 0.611976 [0.435251, 0.745430].

## Candidate coverage and representation diagnosis

The existing learned references can retain the incumbent or select the historical prior's single
challenger. Their training data also contain a uniformly sampled third legal pick, but their fixed
policy cannot choose it. A separate posthoc diagnostic retains every one of the 54 boards and compares
two outcome-informed teachers, each choosing on the first four futures and transferring to the last four:

- Restricted incumbent/challenger teacher: +5.324074 points [ +0.810185, +10.648148 ].
- Three-arm teacher: +7.175926 points [ +2.199074, +12.962963 ].
- Paired three-arm minus restricted difference: +1.851852 points [ +0.231481, +4.629630 ].

The third branch was selected on seven boards. This is an exploratory coverage diagnosis on old boards,
not a new policy or independent qualification. Most of the teacher opportunity also exists inside the
original two-arm decision, so wider choices alone do not solve the learned-value problem.

The independent integer-score audit also decomposes every frozen model's last-four outcomes. The raw
prior switched on 18 boards where the first-four teacher retained current; these boards contributed
−4.166667 points to its overall last-four score. The support model was more conservative: it retained
current on 16 boards where the teacher switched, leaving a +5.787037-point teacher contribution unused.
These groups are outcome-selected diagnostics. Do not turn their membership into serving guards.

Across all 432 original training action contexts, 34 of the experimental head's 36 `enemy:` difference
features are identically zero: unchanged enemy-only context cancels when subtracting own-pick profiles.
The two enemy movement-against-role terms, historical counter prior and added support interactions still
carry opponent information. This is a limitation of that experimental representation, not a claim that
the full A19 AI ignores counterpicks. A next recipe should expose candidate-by-public-enemy and
candidate-by-ally interactions directly, with strong regularization and new independent training boards.
It must be registered separately; no new fit or default follows from this audit.

The unfitted `premium-public-draft-effect-features-v1` contract now implements that representation in
`src/simulation/premium_draft_effect_features.ts`. It retains antisymmetric base effects and support
descriptors, adds changed-own-capability × public-enemy-capability terms, differences of allied role
products, and map-specific effects. It has 329 descriptors. It preserves no-change zero and reverse-pick
antisymmetry, omits hidden setup and declines incomplete-information views. The historical gain is a
feature, not a mandatory prediction offset or candidate filter.

Readiness checked all 324 legal choices across the 54 existing public views without reading outcomes
or fitting weights. Only 162 of those inputs have recorded branches; unmeasured choices receive no
invented labels. All 784 original runtime source files remain byte-identical; the only changed original
source is the separate snapshot builder. This helper is outside serving/default imports. Its synthetic
counter-roster test verifies that an extra enemy caster changes the shooter-replacement interaction,
but it establishes no strategy gain. Feature source SHA-256 is
`1294da7d5c8842f8c116af39919c9c53f7961fad8ae204480bfa5752e72e868b`.

The fixed panel contains five of the old Cannon-to-Hydra bucket's boards. On their new futures the
paired mean is −11.25 points, with a very wide whole-family interval [−38.125, +17.5]. Two boards favor
Hydra. Independent trace extraction verified all 160 existing continuations and 1,760 metrics for these
five boards, including every positive and negative case. On one losing board Hydra lost 777 early
damage while other allies gained only 225; a Hydra stack reached zero HP by lap two in all sixteen
outcomes, versus none for Cannon. On a different favorable board Hydra lost 152 early damage while
the other allies gained 357 early damage and 878 total damage, with fewer allied stacks reaching zero
HP early. This is consistent with a context-dependent damage-versus-protection tradeoff, without
isolating its causal mechanism from naturally reacting setup and fight duration.

The eight sampled Magic-Dragon-to-Hydra boards were +25 points on their original two futures but only
+1.171875 [−10.15625, +14.84375] on eight new futures. The single Angel-to-Hydra board cannot estimate
between-board uncertainty. These checks reinforce the prohibition on universal unit rules. They are
slices of the same completed 2,592 continuations, not additional games or independent boards.

## Canonical repeated-future snapshot support

`premium_matched_draft_snapshot.ts` retains the v1 two-future contract. The separate
`premium-matched-pick-registration-v2` format accepts each family's prospectively declared list of two
or more combat futures. Every arm, seat and declared future is mandatory; missing/duplicate cases,
cross-family seed collisions, unregistered futures and altered native choices are rejected. This does
not authorize expanding an active experiment's registered cases.

The v2 SQLite adds `training_weighted_comparison`. Each paired row receives weight
`1 / (4 × number of futures)`, so all rows from a training family sum to one across two alternatives,
two seats and its futures. A board with eight futures therefore does not outweigh a board with two
futures merely because it has more rows. Both comparison views exclude validation families. The
unweighted view remains available for inspection; a downstream fit must deliberately use the declared
family weights. More futures do not create additional independent boards.

The fixed diagnostic's original panel and statistical analysis stay unchanged. A separate canonical
v2 export passed independent verification of all 2,592 outcomes and 1,728 paired rows. It uses the
same old-family locks, frozen public-feature code and raw hashes, with an explicit artifact-conversion
receipt. It adds no game or fit, does not combine old outcomes into the new-future comparison, and does
not replace the production Premium snapshot. Tests cover unequal future counts, validation isolation,
equal family weighting and strict preservation of the v1 contract.

`readPremiumMatchedDraftTraining` reads a hash-pinned artifact with an explicit training-only join.
It returns public feature inputs separately from observed targets and family weights. Hidden opponent
doctrine, actual setup, combat seeds and validation payloads are not returned. It supports both versions,
refuses incomplete comparisons, and does not trust a modified SQL view to enforce the split boundary.
This is a reusable fitting input path, not a fitted or activated policy.

The canonical repeated-future snapshot SHA-256 is
`cdb1f40fa3d3cd500fe2b010d627c9726404e25e0cecd4fe765f36cebebe4acd`.

Keep all prior failed screens and reserved fresh banks closed. The next candidate should be designed
only after this diagnostic is complete, with separate data and qualification. Demonstrated gains on
independent ranked boards, followed by current authoritative privacy, deadline, state restoration and
funding tests, remain required before default routing. More accurate prediction alone is insufficient.

Generated records and standalone reports stay in the untracked client `game/core/tmp` capsules.
The training support-target SQLite SHA-256 is
`509f57fc6e361985c716be86ca4ba80fa306815ecdda2b3de660be05702559f7`.
