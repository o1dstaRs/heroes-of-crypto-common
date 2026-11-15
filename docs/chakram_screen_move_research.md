# Chakram screen movement research

`chakram-screen-move-v1` is an offline combat candidate. The adopted contextual draft, funded ranged
setup, native formations/support and A19 combat remain its control. It does not reopen the failed
[opening formation study](a19_chakram_formation_research.md), melee delivery or retaliation trials.

## Fixed hypothesis

The ordinary A19 search retains very few pure moves. A useful alternative can disappear before the
engine evaluates whether moving a body opens or closes an enemy Chakram chain. This candidate proposes
one additional legal move when it reduces the maximum secondary exposure relative to every retained
ordinary move and the incumbent, if that incumbent is itself a pure move.

The helper uses the canonical Chakram resolver on a detached board, moving the actor out of its old cells
and into its new footprint. Deleting a blocker is not equivalent: the moved unit can become a new relay.
Canonical occupancy restores terrain under vacated cells. Rectangular bodies and Wingshield use the
normal engine geometry. Only current public units, abilities, ammunition and occupancy are consulted.
The helper consumes no RNG and does not modify the real board, units or fight state.

This is a geometric proposal score, not expected damage. It ranks the maximum secondary collateral over
enemy shooter/friendly primary pairs, then total collateral, then ordinary route order. Secondary units
are weighted by experience times alive count and the canonical damage factor. It does not predict which
primary the enemy chooses or whether that primary shot is legal. The normal engine continuation resolves
shot legality, misses, damage, initiative, terrain and competing threats.

Only the frozen offline copies of the candidate catalog and SearchDriver import this helper. Ordinary
moves and the incumbent remain present. One extra move can receive an immediate leaf and a reservation
within the existing K, preserving the leading challenger. Existing native movement guards and subsequent
specialized reservations remain intact. Dominant/urgent finish expansion is excluded. Rollout policy,
horizon/count, arbitration and fitted weights do not change. The proposal never forces a move.

## Prospective protocol

Study `chakram-screen-move-20261115`, registration SHA-256
`94405e2c05ef9853535a4c5dc4e1e69eae3ffcac0478c803a78122209d37d1d8`, sealed 2,562 files before execution.
Common source is `4af878d041196d9d09dc9e6b15f81c32e1a1a4da`; the corrected native server adapter freezes
`916e3ca3ccb14c093c7f550d880074640c5b9988`, with explicit seeded runtime identity and offline hooks.
The capsule owns its common dependency, asserts shared package RNG/fight singleton identity, and
independently rebuilds each arm's actual public ranked Setup and fully funded formation.

Admission uses the first 27 already-opened development families, all four draft/physical-seat variants:
108 cases and 324 off/observer/treatment games. There is no outcome or creature selection. It requires
exact off/observer complete traces and exact prior corrected controls, zero rejects/censoring/neural
errors, at least ten admitted extra moves across three unit types and two maps, at least one chosen
extra move and one changed trajectory. Native guard vetoes are reported separately and do not count
toward coverage. Original moves and the leading shortlist challenger must survive. Helper exceptions
cannot be hidden by a native fallback. Any failed gate closes this candidate without expanding the bank.

After admission, nine cold-process controls must replay exactly. Development then reruns all 162 reused
families, both draft assignments and both physical seats, with alternating arm order: 648 cases per arm,
1,296 complete games. This population is development, not independent strength evidence. The fixed gate
is at least +0.5 percentage points of draw-aware score, a nonnegative mean in each own 5/6/7-point budget,
and zero quality failures. Analysis uses a whole-family 20,000-resample xorshift32 bootstrap with fixed
seed 2026111593 and an exact two-sided family sign-flip test. No threshold retuning or outcome masks.

Further evaluation requires a new global seed exclusion audit and prospective registration: 864 independent
qualification families, then 1,512 independent confirmation families only after passing. Each stage needs
the fixed gain, a positive whole-family 95% lower bound and nonnegative doctrine means. Serial additional
compute must remain within 10%; a fixed contrasting opponent panel supplements the primary comparison.
No fresh channels are allocated here. No result automatically changes a serving default.

The ignored capsule under the client's `game/core/tmp/chakram-screen-move-20261115` preserves the original
registration, input cases, frozen sources, recipes, full traces and analyses. Focused tests compare the
projection with actual engine-executed moves for four footprint shapes, lava/cleared terrain and shielding,
and verify state/RNG preservation and bounded shortlist behavior. Correct geometry is not win-rate evidence.

## Status

Admission passed all 324 games. There were 284 admitted proposals across 28 unit types and all three
maps, 36 chosen extra moves and 28 changed trajectories. All 108 off/observer pairs and prior corrected
controls matched exactly, with zero action rejects, missing neural starts or model errors.

The original analyzer compared ordered footprint-cell arrays. One observer Tsar Cannon move was
correctly deduplicated against its identical incumbent, which listed the same cells in a different order.
The separate `analyze-normalized-footprints.py` sorts only `targetCells` for the ordinary-move preservation
assertion; paths, flags, identities and other fields still compare exactly. The original analyzer, failed
terminal receipt and registration are preserved. No outcome aggregates were read before this correction;
policy, cases, coverage/score gates and statistical analysis remain unchanged.

Nine additional cold-process controls also matched exactly. The complete development result follows.

## Completed development: no finalist

All 162 whole families / 1,296 games completed. The candidate scored **50.848765%** (324 wins, 11 draws,
313 losses), versus **51.003086%** (325 wins, 11 draws, 312 losses) for the adopted control. The paired
change was **−0.154321 percentage points**, with whole-family 95% interval **−1.466049 to +1.157407 pp**
and exact two-sided sign-flip p = 0.908355713. Both the +0.5 pp gain gate and the nonnegative-doctrine gate
failed. No fresh qualification or confirmation opened, and no model was fitted or default changed.

The five-, six- and seven-point changes were respectively +0.231481, −1.157407 and +0.462963 pp, with
216 cases per arm in each budget. The positive slices cannot qualify an exception. There were 1,418
admitted proposals across 37 creature types, 611 shortlist reservations and 141 chosen extra moves.
122 complete trajectories changed; 11 cases improved and 13 worsened. All fights reached elimination,
with zero action rejects or neural errors. All 648 independently rebuilt controls exactly reproduced
prior corrected traces. Separate TypeScript integer arithmetic verified every family delta, bootstrap
endpoint, sign-flip count and failed gate.

Parallel aggregate fight time increased 2.92% and rollout turns increased 1.43%. These are descriptive
work measurements, not serial production timing qualification. The geometric helper itself evaluated
478,756 canonical flights in about 3.79 seconds across the complete treatment arm.

## What the complete traces explain

Across every completed development game, enemy reported Chakram secondary damage declined from
47,708.06 to 39,685.96 (16.81%), while secondary targets reached declined from 403 to 363. Enemy throw
counts rose from 998 to 1,006. These totals depend on fight length, targets, deaths and later decisions;
they are not a causal decomposition or a substitute for match score. The candidate improved this
particular observed damage total without establishing a stronger complete policy.

Every first trace difference was an actual action-choice change, with the same raw incumbent on both
sides; no event-only divergence preceded it. Of the 122 first changes, 77 selected the extra move and
45 selected a different ordinary action after the catalog/shortlist changed. Thirty-two first changes
replaced a baseline ranged attack, melee attack or spell with a pure move. Across all 141 chosen extra
moves, only 32 had a pure-move raw incumbent. The raw incumbent is not necessarily the full baseline
search choice. These observations identify attack tempo and candidate displacement as distinct costs
to investigate; they do not prove which cost caused any loss.

Preserve the [compact evidence](evidence/chakram_screen_move_20261115.json), helper, original checker
failure and narrow correction. Do not enable this candidate or rescue it with an outcome-selected
creature, map or doctrine rule. Any continuation needs a distinct hypothesis and separate registration.
