# Independent R8 reference on the repaired engine

Registered October 26, 2026, after the [selective midpoint refinement](a19_selective_precision_research.md)
failed its complete screen. This is a reference benchmark, not a new default or an algorithm promotion.

## Question and fixed comparison

Does full independent R8 retain a measurable complete-game advantage over current complementary R2
after the shared-aura rollback repair, and what does it cost when both armies use it? Earlier R8 results
used the old rollback implementation. They motivate this measurement but cannot answer it.

The frozen engine is the previously validated selective-precision export: common
`e1b56f87b9df56e8fa263405fec0d40c90058f0c` plus the exact rollback repair subsequently published as
`6cb91b96d9b1b87daf47b006fd3813abebfa5522`. Existing isolated research helpers remain inert. The
candidate uses eight independent H64 samples on every searched decision, with certified selection bounds
disabled. Control uses the captured server's H64/complementary R2 material-tie profile. Both retain the
same six-action shortlist, enumeration caps, native stack supply, draft/setup rules, synergies and splits.

This is one fixed reference, with no horizon, threshold or sampling-policy sweep. A control wrapper must
exactly reproduce native R2, and the candidate wrapper must exactly reproduce native R8. Cross-platform
preflight compares full turn/action, committed-event and final-result hashes. Rejected actions,
censoring or a source/tool fingerprint change invalidate the affected phase.

## Fixed banks and interpretation

The namespaces exclude prior, failed and reserved seed channels, including every unopened bank from the
selective-precision study. Each independent offer board supplies four canonical draft-seat/battle-mirror
games. Normal, Lava and Block receive equal board counts.

| Bank               | Boards |      Games | Purpose                                                    |
| ------------------ | -----: | ---------: | ---------------------------------------------------------- |
| Preflight          |      3 | 12 per arm | Exact controls and platform parity; excluded from strength |
| Smoke              |      3 |         12 | Complete legal games; excluded from strength               |
| Strength reference |    252 |      1,008 | One complete fresh R8-versus-R2 comparison                 |
| Cost A/B           |     24 | 96 per arm | Both-R2 jobs followed by both-R8 jobs                      |
| Cost B/A           |     24 | 96 per arm | Both-R8 jobs followed by both-R2 jobs on fresh boards      |

The reference strength screen requires a draw-aware score of at least 53%, a lower 95% whole-board
interval above 50%, and every map at least 48%. The 20,000-resample bootstrap is stratified by map and
uses seed 2730279001. A separate NumPy implementation must reproduce the complete sorted integer-score
bootstrap distribution and both interval endpoints. Win/draw/loss scores are 1/0.5/0.

Both cost banks run regardless of the strength result. They measure complete job elapsed time and
process CPU at the same six-process/four-worker configuration, including both armies' search work.
Per-turn observations are offline measurements, not live deadline qualification. Timing games are not
pooled into the strength estimate.

This reference does not reserve or run a qualification/confirmation campaign. A positive screen would
establish a useful teacher candidate for further research; a cheaper approximation would need a separate
registration and fresh full-game qualification. No outcome from this benchmark changes serving R2 or
authorizes deployment.

## Execution

CPU-only Puffalo execution uses Bun 1.4.4, two GC markers and at most 24 simulation workers.
The registered nice increment is 10. The controller and worker commands each add that increment,
giving effective Linux worker nice 19 in every compared arm; active jobs are not reprioritized.
The controller yields its own workers if another simulation appears and enforces a two-hour campaign
budget. Complete records, registrations, failed setup attempts and source/tool fingerprints remain in
the external `a19-r8-reference-20261026` research package.

The complete 1,008-game strength reference produced **547 wins, 450 losses and 11 draws**: **54.8115%**
draw-aware score, with a whole-board 95% interval of **52.7778–56.8948%**. Normal scored 57.5893%,
Lava 53.8690% and Block 52.9762%; each map contributed 84 independent boards and 336 games. Zero
actions were rejected and zero games were censored. The independent NumPy audit reproduced every
outcome and the complete sorted bootstrap distribution. The reference clears its fixed strength
screen; it remains a teacher candidate requiring fresh qualification and live latency measurements.
The strength bank took **26 minutes 3.42 seconds**, consuming **10.45 process CPU hours** on Puffalo.

The first whole-job cost bank completed: both-R2 took **135.37 seconds / 2,486.62 CPU seconds**;
both-R8 took **406.08 seconds / 7,042.80 CPU seconds**. That is **3.00 times the elapsed time** and
**2.83 times the CPU** for R8 on that matched 96-game bank. These are single-bank estimates.

The second bank was interrupted when another simulation appeared during its final R2 arm. The
controller stopped only its own workers. Its incomplete bank supplies no timing ratio and is not pooled
with the first. The completed strength screen remains valid. Serving R2 remains unchanged.

## Separate exact-selection cost experiment

While the Puffalo reference runs, a separately sealed `a19-r8-exact-bounds-20261026` capsule tests the
existing certified tight selection bounds at independent R8 on the M4 Max. Both armies use R8 in both
arms. No additional policy, model, horizon, shortlist or sampling change is proposed.

Three fresh preflight boards supply twelve paired games. Two further disjoint banks each contain
24 boards and 96 games per arm, with baseline/bounded order in the first bank and bounded/baseline
order in the second. Every board, seat and map must match; every full turn/action, committed-event,
result and ranked-record hash must be identical. A rejected action, censored outcome or mismatch
stops the study. These are exact-policy replay comparisons, not additional independent strength games.

The registered speed gate requires at least 10% less simulation elapsed time in each bank and a process
CPU ratio no greater than 1.05 in each bank. The measured Bun phase clock excludes the controller's
polling wait; both arms use one process with twelve persistent workers and two GC markers. Search-turn
counters provide a deterministic work comparison. Both banks run unless correctness fails; no timing
threshold tuning, output overwrite or extra rescue bank is allowed. This experiment has its own source,
tool and seed registration, excluding the Puffalo reference's reserved channels, and a 90-minute budget.

The twelve preflight pairs matched exactly. A read-only host inventory then found unrelated concurrent
CPU training work. Only this study's process group was stopped. The complete baseline bank and two
partial bounded-bank games are retained, along with the 24 preflight replays: 122 completed games in
total. No completed comparative timing bank existed when the stop was chosen. **All Mac timings are
excluded from speed qualification.** This is an incomplete, contended-host attempt, not a speed verdict.

## Fresh Puffalo validation of exact R8 bounds

A separately sealed `a19-r8-exact-bounds-linux-20261026` capsule keeps the identical bounds algorithm
and speed gate, but reserves new banks excluding every channel from the stopped Mac attempt and the
Puffalo reference. Its controller waits for the reference to finish, then rechecks the shared workload
before starting any simulation. It yields only its own workers if another simulation appears.

The parent's resource yield initially closed this pending controller before any Puffalo bounds game
ran. A recorded admission amendment preserves that attempt, accepts the verified completed parent
strength screen after this specific resource-only stop, and waits for an idle node. The algorithm,
source files, seeds, gates, arm order and execution layout are unchanged. No Linux bounds bank was
opened before that amendment.

Each fresh bank contains 24 boards and 96 games per arm. The first runs both-R2 control, unpruned
both-R8 and pruned both-R8; the second reverses that order. This third timing arm measures the optimized
R8 job's cost directly against R2 on the same boards. Three separate preflight boards provide twelve
games per arm. Canonical seats, maps and initial setups must match. Every R8 pair must have identical
complete action, committed-event, ranked-record and final-result traces, with zero rejection or
censoring. R2 timing games are not additional R8 strength evidence.

The speed gate remains at least 10% less R8 elapsed time in **each** bank and CPU ratio at most 1.05
in each. Execution is six processes with four workers, Bun 1.4.4, two GC markers and effective worker
nice 19, matching the reference's execution. Whole-phase elapsed time and total child-process CPU
include worker startup and shutdown. An independent verifier reconstructs source/tool hashes,
registered seeds, exact replay signatures, all CPU/time ratios and the final speed gate.

A speed result can qualify this offline R8 execution method only. It cannot provide R8's missing
held-out strength confirmation or live latency qualification, and it cannot change serving R2.

The other campaign subsequently occupied all 24 workers. This capsule was closed with **zero games
and zero opened banks**, stopping only its own idle controller. An independent audit reconstructed
all registered seed channels and source/tool hashes and confirmed the unopened disposition. There is
**no Puffalo R8-pruning speed verdict**. The external package preserves both administrative attempts,
the admission amendment and every original input; none supplies extra strength games or a speed claim.
