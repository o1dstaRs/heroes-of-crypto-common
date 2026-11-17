# Historical Premium evidence and matched final picks

Historical wins can guide a hypothesis, but they do not establish that replacing a particular pick will
improve an army. A final roster's score also reflects earlier picks, its opponent, setup and combat.
The inactive historical matchup model and its training-only snapshot readers are described in
`premium_draft_matchup_value.md`. Do not route a prediction improvement as a policy win.

The contextual follow-up added own artifact interactions and public rolled synergy effects. It used only
the original training families, with five family folds. On the older snapshot, ranked prediction MSE
changed from 0.14989775 to 0.14761534; the improvement interval crossed zero. On the newer exploratory
snapshot, it worsened from 0.15442370 to 0.16429506. Training error decreased on both sources while
held-out accuracy failed to improve reliably. This is consistent with overfitting sparse combinations;
it does not prove an individual artifact or synergy is harmful. Both contextual screens failed and the
models remain inactive. Only 224 newer ranked training families supported that primary evaluation.

The separate `premium-matched-picks12h-20261117` campaign tests a fixed historical prior calibrated with
matched alternatives. Its prior is the preserved older interactions model, file SHA-256
`47f5a8829f42a9dff4f56b97a6d459f900dcc1297778d098f52da51cc15a501d`.
The failed contextual model is not substituted or rescued.

The collector records the exact native public draft projection. Its first supported decision is the
Spymaster's last level-four pick, with five own units and all six enemy units actually visible. It logs
current choice, the historical model's best other legal choice, and one uniform remaining alternative.
Earlier picks and enemy draft remain identical. Both armies then run actual public ranked setup, so an
opponent's purchases and formation may react to the changed final roster. No concealed enemy doctrine,
artifacts, purchases or positions enter the pick features.

The fixed data bank has 216 training and 108 validation families. Three arms, two physical seats and two
matched futures produce 3,888 conditional outcomes. The SQLite builder requires every registered
branch, original source/profile identity, exact applied unit, complete native openings and zero rejects.
Its `training_comparison` view excludes validation families. Slate inclusion probabilities describe
sampling three alternatives; they are not behavior probabilities that sum to one.

One fixed ridge-100 residual recipe learns paired score gain minus the frozen historical prior's gain.
Training-only scales and weights lock before validation outcomes. The calibrated policy may only accept
or reject that same historical challenger, with a 0.03 predicted-gain margin. Unsupported doctrine,
phase, visibility or input falls back to current behavior. This remains a research module; no default
profile imports it.

Validation must gain at least 0.5 score points against current, have a positive whole-family 95% lower
bound, nonnegative means for each opponent doctrine and nonnegative mean versus the raw historical
prior. Its reserved conditional outcomes are not ranked strength. Separate fresh banks reserve 432 and
864 families, respectively 2,592 and 5,184 fights. All own/enemy doctrine combinations, maps and pick
orders are balanced. Both candidate-current and candidate-locked-V3 contrasts must gain at least
0.5 points, have positive whole-family 95% lower bounds and nonnegative means in every own doctrine.
The latter comparator uses the same current setup and combat, with only the contextual draft head off.
No pooling, refill, changed challenger, model reselection or automatic promotion is allowed.

The registered CPU window ends November 17, 2026 at 18:52:41 UTC, with at most 12 nice-19 Puffalo CPU
workers and no GPU. Previous campaign cutoffs and failed banks are unchanged. The generated matched-pick
SQLite is a developmental learning artifact, not a published replacement for Premium's production
snapshot. Even passing strength banks requires authoritative runtime, deadline, privacy and state
restoration qualification before default routing. Preserve all raw games, failures and source receipts.

## Completed result

All 3,888 registered fights completed and were independently verified, including every off-node raw hash,
all 1,944 native openings, model-lock chronology and all SQLite rows. There were zero rejected actions
and zero duplicate reuses. One registered CPU model was fitted; verification added no new fit or game.

On 108 held-out conditional-validation boards, each selected policy has 432 outcomes. Current behavior
scored 39.236111% (167 wins, 5 draws, 260 losses); the calibrated policy scored 37.962963%
(161 wins, 6 draws, 265 losses). Its paired change was −1.273148 points, whole-board 95% interval
[−4.861111, +2.314815]. Versus the raw historical prior, the change was −0.231481 points
[−4.861111, +4.166667]. Validation failed. Both fresh strength banks remained unopened; no policy,
default or production Premium snapshot was changed.

All own armies in this data bank were Spymaster. Candidate-current diagnostic means against Scout,
Spymaster and Battle Trance were −4.166667, +3.819444 and −3.472222 points. Normal, Lava and Block map
means were +1.736111, −4.861111 and −0.694444. These small subgroup estimates do not rescue the model;
opponent doctrine is an analysis field, never an available hidden input to the pick policy.

The posthoc audit found 33 changed picks: ten positive, thirteen negative and ten unchanged board means.
Seven Angel-to-Hydra switches contributed −1.851852 points to the overall result, while all other
switches together contributed +0.578704. Across those 28 existing fights per arm, Angel won thirteen
and Hydra five. Twenty Angel resurrection casts restored 157 creatures and 4,345 actual HP. Hydra's
source-attributed damage was higher, but its outcomes were worse. All paired formations and twenty
pairs of active synergy choices changed, despite identical own purchases. This identifies support and
formation interactions to investigate; it does not establish a universal unit rule or a promoted subgroup.
Resurrection attribution matches committed caster/target spell events when the health ledger lacks a
source ID; requested HP is not credited as actual restoration.

A separate posthoc diagnostic selected a branch on the first future and measured it on the second.
Transfer was +0.810185 points [−3.009259, +4.629630] on the 216 training boards and +1.157407
[−3.472222, +6.018519] on 108 validation boards. These outcome-selected teachers are not deployable
policies and add no independent games. Improve label repeatability and explicit support opportunity
features before expanding the model; keep this opened validation bank out of future primary inference.

The audited developmental SQLite hash is
`a54de6afe56a1d639d8c143272ee1a991ff08eb53f7325c849b2f93a2bc977a7`.
The fitted, inactive residual model hash is
`c7f1f97a0056ce2e8fc2fcaf85aab19c1c939124f94da582bcc994060be23636`.
All raw files and complete verification receipts remain in the untracked
`game/core/tmp/premium-matched-picks12h-20261117` client capsule. Preserve its reserved channels,
including unopened fresh banks, in future experiments.
