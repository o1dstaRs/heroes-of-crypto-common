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
