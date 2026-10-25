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
