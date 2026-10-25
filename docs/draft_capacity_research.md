# Visible shooter capacity research

Candidate `visible-ranged-capacity-v1`, frozen before deciding fights on 2026-10-24.
The shipped `ranked-unit-strength-a19-side-v4-w16-r4` treats every remaining pick as a
possible shooter. This candidate computes the maximum attainable native shooter count
from the acting seat's revealed bans, known enemy picks and actual remaining levels.
It retains the incumbent choice whenever that choice can reach the target. Otherwise it
uses the unchanged ranked scorer among choices that can reach four shooters, or the
best attainable count if four is impossible. The existing backline protector gate stays.
Bundles, artifacts, doctrine choice, setup, placement and combat remain unchanged.
No historical map residual or new scoring weight is used. Production profiles do not
import this experiment.

The pilot uses 120 games per doctrine, both seats using the same doctrine, on fresh
seeds 260414001 (Battle Trance), 260514001 (Scout) and 260614001 (Spymaster).
Each uses all three maps, both draft seats and both battle mirrors, A19 deterministic
combat, the side board, rolled synergies, tactical splits and
`artifact-fit-v6:conditional-v1:sniper+t2a19` setup. Every candidate game also has an
unchanged-policy counterfactual on the same offer board and seeds. Report candidate
results and the paired draw-aware score difference, clustered by offer board. This
comparison reduces offer strength noise; it does not replace independent held-out
confirmation. Failed or inconclusive pilots are not tuned on these seeds.

The pilot cannot promote a strategy. Promotion still requires at least 6,000 games,
a clustered 95% lower bound above zero for paired improvement and above 50% for the
candidate's decisive score, zero rejected actions, worst map at least 49%, reference
opponent checks and fresh held-out confirmation. Doctrine changes require a separate
comparison including their different augment budgets. Raw outputs remain outside Git;
execution reuses `playRankedDraftGame` and the canonical result validation.

## Pilot result

The frozen candidate at `b24f3f12` completed 360 candidate games and 360 matched unchanged-policy counterfactuals (90 independent offer boards). Both seats used the same doctrine within each group; these results do not compare the doctrines against each other.

| Doctrine      | Candidate W / L / D | Draw-aware score | Paired change (pp), 95% interval |
| ------------- | ------------------: | ---------------: | -------------------------------: |
| Battle Trance |         59 / 59 / 2 |           50.00% |             +0.00 [+0.00, +0.00] |
| Scout         |         54 / 62 / 4 |           46.67% |             -3.33 [-6.56, -0.11] |
| Spymaster     |         62 / 58 / 0 |           51.67% |             +1.67 [-3.78, +7.11] |

The pooled paired change was -0.56 percentage points [-2.63, +1.52]. Intervals use offer-board clustered Student-t estimates on draw-aware score differences. Battle Trance made no changed decisions and reproduced every control trace; its zero sample interval is not a claim of general statistical equivalence.

All 720 records passed canonical seed/mirror validation, distinct-identity and 2/2/1/1 roster checks, balanced-map checks and zero-rejection checks. All 336 unchanged candidate setups reproduced their control behavior hashes and outcomes exactly. Scout and Spymaster each changed 12 draft decisions and 12 game setups; the remaining defaults, setup and combat stayed frozen.

**Rejected for promotion.** The early shooter restriction did not establish an overall gain and hurt the Scout sample. The production draft scorer and default Battle Trance doctrine remain unchanged. Do not retune this candidate on these seeds or treat the positive Spymaster point estimate as qualification. Raw records, source hashes and review artifacts remain outside Git.
