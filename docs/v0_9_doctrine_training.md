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
