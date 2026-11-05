# v0.9 doctrine training

The user-locked improvement benchmark is **`doctrine-draft-v3-20261104`**. Its exact trained weights,
registration, independently verified results and decision regressions are versioned in
`src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/`. Subsequent draft candidates must be
compared against it as well as the original policy. It remains a development benchmark: locking it
preserves its overall gain without changing the outcome of its original scouting-specific gate.

From the common package, inspect it or export the exact model to a new file:

```bash
bun src/simulation/v0_9/doctrine_draft_checkpoint.ts
bun src/simulation/v0_9/doctrine_draft_checkpoint.ts --out /tmp/hoc-doctrine-v3-model.json
```

The loader verifies the canonical model hash and freezes the returned model. Export refuses to
overwrite an existing file. Use a new checkpoint identity for further improvements. Saved seed banks,
including unused confirmation seeds, are exclusions for future campaigns. Do not reopen V3's failed
campaign or describe the locked checkpoint as a replacement for the in-battle combat model.

To reuse its actual choices in `playRankedDraftGame`, pass
`createLockedDoctrineDraftResearchChoices({ doctrine, genome, synergyVariants })` as the
`researchCandidateDraftChoices` dependency. Import the factory from `doctrine_draft_checkpoint.ts`
and create a new instance for each draft seat/game. Keep that instance through collision retries:
choosing an alternative consumes the single override even if the pick collides. The optional
`maskAdvanceInformation` flag reproduces the information ablation; `onDecision` records the model's
evaluated decisions. Regression fixtures reproduce 49 historical drafts, including a collided override.

The measured target is `a19-neural-r2-placement-v2`, with draft policy
`ranked-unit-strength-a19-side-v4-w16-r4` and setup `artifact-fit-v6:conditional-v1:sniper+t2a19`.
Its battle controller is the current ranked A19 stack, routed through v0.8. The literal server v0.9
profile uses a different setup policy and native combat path. This draft research is part of v0.9
development, but its measured gain does not establish a gain for that different runtime profile.
Changing the target profile requires a separately registered evaluation before promotion.

The balanced population is an offline research option, `--doctrine-population balanced-doctrines-v1`.
It does not change old campaign identities or install trained weights in the game.

Every 27 independent boards cover three maps, three candidate doctrines, and three opponent doctrines.
Each board retains both draft seats and both battle seats. Spymaster has five points, immediate bans,
and the early map; Scout has six points and immediate bans; Battle Trance has seven points and ordinary
reveal timing. The existing player-specific visibility projection supplies draft inputs. Actual accepted
engine setups are checked for the scheduled doctrine and its full point budget. Combat observations
contain the public terrain and actual augmented stats; hidden draft state is not a tactical input.

The A/A control uses the same doctrine on both seats, equally across all doctrines and maps. Unequal
budgets would not be an exact null control. Training, validation, and evaluation use all nine matchups.
Whole-board confidence intervals and separate doctrine scores prevent four correlated seat permutations
from being counted as four independent samples.

| Stage                   | Boards | Games |
| ----------------------- | -----: | ----: |
| Smoke                   |     27 |   108 |
| A/A                     |     27 |   108 |
| Teacher screen          |    216 |   864 |
| Teacher confirmation    |  1,512 | 6,048 |
| Training corpus         |    513 | 2,052 |
| Validation corpus       |    108 |   432 |
| Student development     |    216 |   864 |
| Student confirmation R2 |  1,512 | 6,048 |
| Student comparison R4   |    756 | 3,024 |

The existing source, independent-seed, teacher, learner recovery, CPU export, and live latency gates still
apply. The precise R8 teacher must beat the frozen current R2 opponent before its corpus is funded. A
new correction replaces the current neural correction on its seat; it is never stacked on the shipped
correction. Its opponent retains the current shipped correction. Balanced trials use the production
all-action-family tie rule. Their fresh model is still a research artifact.

A positive training loss curve, legal play, or a change in a draft choice is not a measured tactical gain.
Report the opponent revision, model hash, actual optimizer steps, seed banks, per-doctrine score,
whole-board confidence intervals, rejections, and timing. Lock a finalist before opening independent
confirmation. Do not claim that a prior seven-point-only result transfers to this population.

Early scouting is also a separate draft hypothesis: the historical ranged-capacity experiment was
negative for Scout (`draft_capacity_research.md`). Balanced tactical training alone cannot establish
that a new draft heuristic exploits advance information better. That claim needs a matched draft
ablation with identical doctrine budgets and information removed only from the decision policy.

## November 4 information ablation

The first ablation used source `8ec9b29db454f16c424f529f2726ebbfda3d76db`, 270 independent boards,
and 2,160 games (four seat permutations per board for each of the two information conditions).
It kept actual point budgets, visible opponent picks, current neural combat, and setup rules identical.
The control delayed advance bans and the early map inside the draft decision policy only. Reconstructing
the full-information policy was required to reproduce every original draft choice. The seven-point
control was required to reproduce complete game records exactly.

| Candidate doctrine      | Score change, percentage points | Paired board 95% interval |
| ----------------------- | ------------------------------: | ------------------------: |
| Spymaster, 5 points     |                           +0.28 |            −2.22 to +2.78 |
| Scout, 6 points         |                           +0.42 |            −1.53 to +2.50 |
| Battle Trance, 7 points |                            0.00 |              0.00 to 0.00 |
| Equal mixture           |                           +0.23 |            −0.83 to +1.34 |

The information changed 106 draft decisions, with zero rejected actions. This is **inconclusive**:
it establishes that the inputs affect choices, but does not establish a win-rate gain. Its reserved
confirmation bank stays closed. Registration SHA-256:
`2252a49eb96dde4071aede3df63c9e7203ba0d2acff230ae23427e95c25dae9a`.

Learned-model comparisons also need a shipped-model control on each exact scenario. Raw five-point
win rates against a mix of opponent budgets are not five-point learning gains. Compare the learned
and shipped policies on identical draft/battle seeds and setup fingerprints; bootstrap the paired
differences as whole boards, stratified by map and both doctrines.

## Neural R8 teacher option

`precise-r8-neural` is an additional offline teacher, using the shipped frozen neural policy among
fully evaluated primary ties after eight rollouts. It retains the same R8 candidate catalog and
confidence margin. It has a distinct manifest identity and must pass fresh teacher qualification
before providing a training corpus. A/A still runs the identical current R2 controller on both seats.
Each game audits all teacher roots and records neural inference and correction counts.

The R8 correction is explicitly operation-bounded research. It is rejected in wall-clock mode, requires
eight completed samples for each eligible action, and leaves the production two-rollout contract intact.
Adding the option is not a strength result or permission to replace a production model.

Both November 4 R8 screens failed their registered raw-score gate. The native teacher scored 51.27%
(board interval 49.07–53.47%); the neural teacher scored 51.10% (48.50–53.70%), each over 216 boards
and 864 games. A post-screen, same-setup shipped-policy control for the neural teacher found a paired
gain of 1.04 percentage points (−1.45 to +3.53). That diagnostic is inconclusive and cannot qualify
training. Neither confirmation bank was opened, and neither campaign performed optimizer steps.

## Outcome-trained scouting draft head

`src/simulation/v0_9/doctrine_draft_training.ts` is a separate research path. Its labels come directly
from paired battle outcomes, without using either failed teacher. The frozen current policy and one
alternative draft choice play the same scenario and both battle seats. Each training board chooses
one of the opening bundle, level-1 pick or level-2 pick for intervention; all later decisions retain
the current policy. The full 27-cell population covers all maps and both players' doctrines.

The fourteen-feature linear model contains public unit/build fit, own doctrine, visible terrain fit,
and changes to faction paths, future artifact fit and ranged capacity under advance bans. It accepts
only the reducer's projected draft context. Unknown future offers and hidden opponent picks are not
inputs. Fixed full-batch Adam runs 2,000 updates, with squared paired-score loss, ridge 0.02, learning
rate 0.03, and training-only RMS feature scales. Inference changes at most one early pick per draft,
only when predicted score gain exceeds 0.02. Seven-point play retains the current policy.

The independently registered banks contain 27 smoke boards, 810 training boards, 270 development
boards, and 1,512 confirmation boards. The source, model, board records and seed channels are hashed.
There is one fit and one fixed threshold; development results do not tune either. Actual setup audits
check all 5/6/7 point budgets and reject incomplete or illegal fights.

Evaluation uses three conditions on identical scenario seeds: current policy, learned policy, and
the same learned policy with advance information removed from its features. The latter retains the
learned weights, doctrine indicators, public build features, current-policy candidate menu and full
actual setup budget. This tests the incremental contribution of scouting content rather than merely
disabling the learned policy. It is not an estimate of the total value of a doctrine.

Each gain is a paired difference, bootstrapped over whole independent boards within the 27 map/own/
opponent-doctrine cells. Development must have a positive lower 95% bound against both controls and
nonnegative point estimates for every doctrine before confirmation opens. Fresh confirmation repeats
both tests over 6,048 games per condition. The seven-point negative control must reproduce complete
game records exactly. Ordinary generated data and weights remain outside Git; the explicitly requested
locked checkpoint above is the versioned exception. No result auto-promotes a
model into the runtime; a failed or inconclusive evaluation preserves current behavior.

### First fitted model and late-ban follow-up

The first model used source `c4f7de5549d134387155b64837a913db64e7bedb`, 810 training boards and
1,080 paired-decision examples. Its 2,000 optimizer steps reduced training squared error from 0.15480
to 0.15122. On 270 fresh development boards (3,240 games across the three conditions), the learned
policy gained 1.57 percentage points over current behavior (paired 95% interval +0.28 to +2.87).
Spymaster gained 3.47 points and Scout 1.25; Battle Trance reproduced the negative control exactly.

The information-specific comparison was inconclusive: +0.37 points overall (−0.09 to +0.83), with
Spymaster at +1.39 and Scout at −0.28. This fails the registered gate despite the overall improvement.
Its confirmation bank remains closed, and the model is not promoted. An independent implementation
reproduced every paired mean and interval. The model SHA-256 is
`e0c8ed4ffd4e4d6faa05f185830b9c39543c2e510b51a18344287dd8e3cfb16b`; registration SHA-256 is
`5d730dc2cf4bcf48209e1c4a110a81f47d7d707c9571a5fb8d143ab9b9ff50ab`.

The separately registered v2 follow-up adds the level-3 decision, when Scout still sees level-4 bans
in advance. Those bans can eliminate a faction's remaining completion path. Its feature contract
appends a level-3 intercept; the existing fourteen features retain their meanings. Masking at level 3
keeps the already-public map and removes only unrevealed level-4 bans. The maximum of one override,
fixed optimizer, switch margin and two-control promotion gates are unchanged. The original v1 model
and registration schemas retain their exact behavior.

V2 uses 27 smoke boards focused on the new level-3 path, 1,080 training boards (ten per decision in
each of the 27 population cells), 540 development boards, and 1,512 sealed confirmation boards.
All seed channels are fresh, including exclusion of unused prior confirmation banks. It freezes the
current balance source and collects new outcomes; labels from the pre-Cyclops-buff model are not reused.
This is a follow-up hypothesis informed by development diagnostics, not a retrospective change to the
first model's test or evidence of a scouting gain.

V2 completed on source `1cdc43a751c213d976cbf97937191044fbc0d40c`. Its 1,080 training boards
provided 1,440 paired examples; 2,000 Adam steps reduced squared error from 0.16393 to 0.15993.
The 540-board development bank contained 6,480 games across the three conditions:

| Candidate doctrine      | Learned minus current, pp (95% interval) | Learned minus masked, pp (95% interval) |
| ----------------------- | ---------------------------------------: | --------------------------------------: |
| Spymaster, 5 points     |                   −0.90 (−3.75 to +1.94) |                  −0.56 (−2.78 to +1.67) |
| Scout, 6 points         |                   −0.42 (−2.08 to +1.25) |                  −0.07 (−0.56 to +0.49) |
| Battle Trance, 7 points |                      0.00 (0.00 to 0.00) |                     0.00 (0.00 to 0.00) |
| Equal mixture           |                   −0.44 (−1.57 to +0.65) |                  −0.21 (−1.00 to +0.56) |

It failed the gate; its 1,512 confirmation boards remain unused and the model is not promoted.
There were zero rejected actions. Independent Python code reproduced all training labels, every
trained weight, the final loss and every paired evaluation interval. Matching JavaScript's ordered
sums and bias-correction power arithmetic was necessary for an exact optimizer replay.
Model SHA-256: `0365ea067b5409a05fc26ae547ee71bbfbf11e7bdff7e3a6678fa0defd535550`.
Registration SHA-256: `c2ce6df77610f56048c78f689a40f026503b47f9fc5a7b634eb96c91e799d589`.

### V3 representation follow-up

The first two models capped their ranged-capacity feature at two, although the frozen ranked policy
targets four shooters. This can hide the loss of the final ranged continuation. They also represented
faction reachability and build affinity without distinguishing the strength of available faction
partners, and did not fit public unit-specific residuals against the historical strength prior.

V3 retains the first fifteen features and appends 56 public draft-unit identity differences, advance-ban
effects on a four-shooter capacity ceiling, and advance-ban effects on the strongest possible partner
for each odd faction count. Partner quality is the maximum of zero and `10 + v4Lift / 10` over that
faction's visible possible continuations; the offset makes a missing partner worse than a known unit.
Only projected bans, own picks and already-visible opponent picks filter this public creature pool.
The information mask retains all unit identity features and the ordinary map reveal. It removes the
advance-ban effects, including those of the new features. No hidden state or future offer is an input.

The separate v3 schema has 73 features. It keeps the fixed 2,000-step optimizer, ridge, learning rate,
switch margin, one-override limit and both paired evaluation gates. Its prospective banks contain
27 smoke boards, 3,240 training boards (30 per decision/population cell), 1,080 development boards,
and 1,512 sealed confirmation boards. New seeds exclude all earlier banks, including their unused
confirmation seeds. All training outcomes are collected afresh. Unit identity effects can improve
overall play, but only the matched information ablation can establish an additional scouting gain.

V3 completed on source `d4f095c499c5cd8068ffbc8a1632f23b87d13f70`. Its 3,240 training boards
contained 25,920 battles and supplied 4,320 paired examples. The 2,000 Adam steps reduced training
squared error from 0.16622 to 0.15615. Its fresh 1,080-board development bank contained 12,960
battles across the three conditions, with all 27 population cells balanced:

| Candidate doctrine      | Learned minus current, pp (95% interval) | Learned minus masked, pp (95% interval) |
| ----------------------- | ---------------------------------------: | --------------------------------------: |
| Spymaster, 5 points     |                   +5.21 (+2.74 to +7.64) |                  +0.31 (−0.73 to +1.42) |
| Scout, 6 points         |                   +1.63 (−0.56 to +3.85) |                  +0.94 (+0.28 to +1.70) |
| Battle Trance, 7 points |                      0.00 (0.00 to 0.00) |                     0.00 (0.00 to 0.00) |
| Equal mixture           |                   +2.28 (+1.20 to +3.38) |                   +0.42 (0.00 to +0.84) |

Scores count a win as one, a draw as one-half, and a loss as zero. These are paired match-score
percentage-point changes, not comparisons of the doctrines' raw win rates. The information-specific
pooled lower bound is exactly zero before rounding. This misses the registered requirement that it
be strictly positive, despite the improvement over current behavior and the positive Scout result.
The 1,512-board confirmation bank remains unopened; the model is not promoted.

Independent Python verification recomputed every paired training outcome and reproduced all 2,000
optimizer steps with zero weight error, the exact final loss, and every evaluation mean and interval.
All actual 5/6/7 point budgets passed the setup audit, there were zero rejected actions, and seven-point
games reproduced both controls exactly. This experiment trained the scouting draft head; it did not
replace the shipped combat correction. No failed teacher or evaluation example supplied training labels.

Model SHA-256: `2736ce8d7917e12c5078b8cae0b51f49c2e20496b2ce181bf9995e04ef65ec7a`.
Registration SHA-256: `5ca7c3e0ef303533e6d0d8e14797e3e2fc756f4ae6ea9312e8332f61d112cf7a`.

### V4 contextual-value continuation

V4 retains all 73 V3 features and appends 168 unit-by-visible-map interactions, twelve already-achieved
faction thresholds (2/4/6 units for each faction), and twelve changes in threshold reachability caused
by advance bans. It has 265 features. Early map interactions exist only for Spymaster; Scout receives
them at the ordinary map reveal. Masking removes early map interactions and advance-ban reachability
while keeping already-public terrain, faction bonuses and all other public features.

Training starts from the locked V3 predictions: its coefficients are converted to the new training-only
RMS scales, and new coefficients start at zero. Adam's moment estimates start at zero. The optimizer
still performs 2,000 full-batch steps with learning rate 0.03 and ridge 0.02. Its fresh 6,480 training
boards provide 8,640 paired examples from 51,840 battles, equally covering all four decision levels
and 27 population cells. No development or confirmation outcome becomes a training label.

The new registration pins the exact V3 checkpoint hash. Evaluation adds the locked V3 policy as a
fourth condition on every board, alongside original, learned and learned-with-masked-information.
Development contains 1,080 boards and 17,280 battles. Confirmation remains sealed at 1,512 boards
and 24,192 battles. Both stages require a strictly positive pooled lower 95% bound against **all three**
controls and nonnegative point estimates for every doctrine against every control. The original
one-override limit, 0.02 switch margin, legal-information projection and seven-point exact control
remain unchanged. Passing development permits independent confirmation, not automatic deployment.

### Independent overall confirmation of the locked V3 model

The saved model's overall improvement is also being confirmed under a separate, prospective protocol:
`docs/evidence/v0_9_locked_draft_overall_confirmation_20261105.json`. Its fixed V3 weights and the
original policy play the 1,080 fresh boards reserved for V4 development, giving 4,320 battles per
condition. Those boards are independent confirmation for the already-frozen V3 model; they remain
development data for V4. The registration was recorded before either evaluation condition was run.

This overall-strength check requires a strictly positive pooled lower 95% bound, nonnegative gains
for every doctrine, the exact seven-point control, all actual budgets and zero rejected actions.
It uses the same 10,000 whole-board bootstrap resamples across the 27 population cells. The old V3
scouting-specific gate remains failed and its reserved confirmation bank remains closed. An overall
pass would support integrating the saved draft improvement; it would not establish the separate
claim about the incremental benefit of early information. Independent verification precedes any
integration, and the test never automatically deploys a model.

Overall-confirmation registration SHA-256:
`f1d4be4b0ce87cf13724db8d60b866d1b35a194441b78b231398e2d7a27c931c`.
