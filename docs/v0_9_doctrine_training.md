# v0.9 doctrine training

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

| Stage | Boards | Games |
| --- | ---: | ---: |
| Smoke | 27 | 108 |
| A/A | 27 | 108 |
| Teacher screen | 216 | 864 |
| Teacher confirmation | 1,512 | 6,048 |
| Training corpus | 513 | 2,052 |
| Validation corpus | 108 | 432 |
| Student development | 216 | 864 |
| Student confirmation R2 | 1,512 | 6,048 |
| Student comparison R4 | 756 | 3,024 |

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

| Candidate doctrine | Score change, percentage points | Paired board 95% interval |
| --- | ---: | ---: |
| Spymaster, 5 points | +0.28 | −2.22 to +2.78 |
| Scout, 6 points | +0.42 | −1.53 to +2.50 |
| Battle Trance, 7 points | 0.00 | 0.00 to 0.00 |
| Equal mixture | +0.23 | −0.83 to +1.34 |

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
game records exactly. All generated data and weights remain outside Git. No result auto-promotes a
model into the runtime; a failed or inconclusive evaluation preserves current behavior.
