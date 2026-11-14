# AI research closeout, November 14, 2026

The requested research window ended Friday, November 13 at 10 PM Pacific. This report records the work that actually completed. The additional commitment-timing and coordinated-setup campaigns were **not launched** while an escalated Puffalo inventory request remained pending. The existing node controller continued independently and completed its registered comparison. The requested continuous follow-on iteration was not delivered; no further training is started after the cutoff.

## Completed result

`contextual-draft-20261110T034659Z` completed **44,928 study fights**: 17,280 training and 27,648 independent qualification fights. Forty reused cross-host smoke records and four zero-head checks add no independent evidence. The controller finished November 10 at 7:36 PM Pacific, about 23 hours 38 minutes after its initial cross-host check. Training used eight background actors under a shared four-core CPU quota on the 9800X3D. No GPU training was launched for this continuation.

| Qualification condition | Games | Draw-adjusted score |
| --- | ---: | ---: |
| Frozen baseline | 6,912 | 45.254630% |
| Saved setup selector with V3 draft | 6,912 | 46.932870% |
| New full draft head with saved setup | 6,912 | 48.683449% |
| Context-ablated draft head with saved setup | 6,912 | 48.647280% |

The full candidate's gain over baseline was **+3.428819 percentage points**, adjusted 95% interval **+2.018229 to +4.868345**. Its gain over the saved setup reference was **+1.750579 points**, interval **+0.687211 to +2.813947**. These scores use the registered ordinary/pressure opponent mixture and count draws as half a win.

The general-opponent safety interval against saved setup was **−1.012731 to +2.112269 points**, missing the fixed −1-point noninferiority boundary. Qualification therefore failed. The reserved fresh bank remained unopened, serial production timing did not run and the candidate was not deployed. Preserve the positive overall comparisons and this failed safety gate together.

The added explicit context features did not show a measurable benefit over the independently fitted ablated head: **+0.036169 points**, nominal 95% **−0.448495 to +0.535301**. The underlying V3 draft and setup selector already use some contextual information. This result does not establish that map or synergy knowledge is unimportant.

## Compute and verification

Compared with baseline, concurrent full-fight time increased **1.656630%** and total own combat-decision time increased **0.951554%**. The draft phase increased **10.431555%**. The registered full-fight and combat-decision compute gates passed; serial production latency remains unqualified.

Mean time per own combat decision was 308.84 ms versus 310.44 ms for baseline. The draft-phase increase was about 2.49 ms per game. These are concurrent shared-host measurements, not a serial production benchmark.

The audit verified all 44,968 manifest-listed node records, every frozen source file, all paired training labels, the six primary bootstrap intervals and the separate ablation interval. It also independently rechecked the 40 matching local/node transport cases. Independent CPU refits reproduced both selected models exactly, with zero maximum weight difference. The complete archive is retained read-only on the node and locally, SHA `6af9c6e5c88367ee652825458942eeb28884d051cd3b2793fbbd984a911b25cf`.

Both models are preserved under `src/simulation/checkpoints/contextual_draft_20261110`, with `lockedContextualDraftResearchModels()` validating weights, numerical references and helper source hashes. The full model SHA is `063a888e6e38fe4322e89385929ac8f21dcb7b7f0dd5db070cb46a44a95eeeba`; the ablated model SHA is `be2bf950866cbb139e8f7cd284302f41f4a3fc61361743310e0729202443072a`. Previous locked checkpoints remain intact.

Closeout validation passed common lint, typecheck, compilation and 19 focused regression tests. The full sandbox suite reported 7,838 passes and one OS process-identity lookup failure. The unchanged affected test file passed all 18 tests outside the sandbox. GitHub CI and a production deployment were not part of this closeout.

## What remains

The next finite experiment should retain the unchanged candidate and resolve the general-opponent safety result on a newly registered, adequately sized independent bank. The existing failed study's fresh bank must stay closed. Any test against the latest game must account for engine/balance changes after the frozen `2ab2617e` source.

For later policy development, commitment timing and coordinated upgrades/splits/placement remain untested hypotheses. In this run, 52.3% of six-point and 86.4% of seven-point extra overrides occurred before map reveal. The model slightly reduced shooter concentration but still averaged 3.5252 native shooters. Those diagnostics motivate new experiments; they are not measured gains from delaying a pick or buying a different upgrade.

Full source identities, paired scores, gates and diagnostics are in [the study record](contextual_draft_research.md) and [completed evidence](evidence/contextual_draft_results_20261110.json). No native v0.9 combat improvement or production rollout is claimed by this study.
