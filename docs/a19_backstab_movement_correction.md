# Backstab movement correctness — November 19, 2026

`preferBackstabAttackCell` now uses the actual enemy threat matrix when it asks for a
Scavenger's finite movement routes. Enemy threat contributes to the engine's
movement cost. The old all-zero matrix made unaffordable backstabs look legal.
When no backstab cell is reachable, keep the original legal attack.

The [source-bound evidence](evidence/a19_backstab_authoritative_movement_correction_20261119.json)
preserves the original failure, read-only diagnoses, engineering registration,
full native outcome hashes and verified copies on both nodes. This is a
correctness fix, not a qualified win-rate gain. No search budget, model, draft,
placement policy, movement rule, validation rule or profile was changed.

## What failed

In one exposed native case, a team-1 Scavenger at `(8,6)` had 4.3 steps. Its
backstab planner proposed `(4,6)` along a four-cell route. That route's actual
weighted cost was 6. The engine's finite reachable set excluded `(4,6)` and
included `(5,6)` at cost 4; it correctly rejected the proposed move.

The original incumbent contained a later melee action from `(6,6)` with its own
approach path. That suffix still completed after the illegal first move was
rejected, so search could retain the compound incumbent. Rejected productive
prefixes remain invalid even when a later action completes.

The first two complete read-only diagnostic games reproduced the exact original
full native outcome on HFT and Puffalo. A separate one-game root-epoch diagnosis
also reproduced it exactly. Unit steps, occupancy and live threat boards did not
change across policy selection or search rollback. The decisive finite path
request instead supplied a separate zero-threat board: `(4,6)` then appeared to
cost 4. Subsequent real-board requests excluded it. This identifies the Backstab
override rather than stale stats or rollback as the cause in this case.

Preserve the earlier two setup-only observer failures and the root-epoch
standalone source-check process-guard failure. None executed combat. The separate
typed observer and operational correction continued only unexecuted diagnostic
tasks, retaining their original budgets and deadline; they did not retry an
invalid fight for training data.

## Verification and limits

Eight reduced-geometry tests failed before the fix and pass afterward: both teams,
classic and side-oriented boards, with and without the decision path catalog.
They compare the proposed destination and route with the native finite reachable
set. Positive tests fund a genuinely reachable backstab; low-budget adjacent
cases preserve an in-place attack. All fourteen Backstab tests pass. The common
build passed 8,261 tests in 708 files, followed by TypeScript compilation.

The separately sealed engineering source `f64b4c0f` ran the same exposed full
native case once on each node, with the correction on both AI seats. Both runs
completed 51 actual A19 decisions, had zero raw quality errors and produced the
same complete corrected native outcome `fec038bd`. The Scavenger's move to
`(5,6)` completed. The original invalid-move warning fell from one to zero per
replay. Every raw output and receipt has two verified copies.

The candidate-seat match score remained zero in this one case. These engineering
replays do not establish a strength gain or the overall compute limit. Future
qualification must retain independent fresh strength evidence and the user's
overall-average +10% bound on full-fight CPU and weighted CPU per actual search
decision, including both-AI use. Slower subgroups are descriptive.

The failed paired-label study remains closed incomplete at 768 logical / 711
unique physical fights. No partial fit, validation-effect aggregation, retry for
data, case exclusion or reclassification follows. Its full reservation and the
four older closed six-role banks remain excluded. No deployment follows this
research automatically.
