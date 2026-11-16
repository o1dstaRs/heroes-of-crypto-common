# Backliner approach: loss audit and preservation follow-up

This distinct inactive continuation follows the user's explicit request to investigate the original
+0.154321 percentage-point result, repair the failed cases and rerun. It does not retune or activate the
closed `backline-approach-move-20261115` candidate. Its original gates and uncertain result remain intact.
The serving reference remains locked V3/contextual v0.9 drafting, the adopted ranked setup and native
placement/support, with v0.8/A19 H64/R2/K6 combat. No weights, draft, augments, formation, Premium data or
serving default change in this experiment.

## Preserved research checkpoint

The user's follow-up asked what could be locked in from this run. Preserve the inactive helper, its
regression/isolation tests, and this complete result as a versioned research checkpoint. It retains a
usable implementation and prevents later agents from mistaking selected-case recovery for a qualified
strength gain. The default v0.9-draft/A19 strategy stays unchanged.

- Helper SHA-256: `27bf8168f64bf268f22a5014af1ae784f23534ee116dd6c1bfedcf97e18dabf8`.
- Test SHA-256: `9865364590bafa1d71bc5b48e06ec71ed030b76c051ea04cc3ce88e1d9c5d291`.
- Keep original choices intact when reproducing the Preserve experiment. This is an experimental
  construction, not evidence that every production search should have an unbounded shortlist.
- Keep the strict-margin arm and its lower observed fresh score in the record; it is not an adopted rule.
- Physical shooters and damage casters warrant separate future hypotheses. The positive shooter slice
  does not qualify a live shooter-only exception.

Future variants need a separate identity and fresh evaluation. Preserve these tested bytes, original
comparison arms, seed exclusions and failed gates. No weights, serving route or Premium snapshot changed.

## Complete changed-outcome audit

The read-only `backline-failure-audit-20261115` capsule revisited **all 18 regressions and all 17 improvements**
from the preceding 864 paired cases. These are outcome-selected diagnostic cases, not fresh strength
measurements. The unchanged-loss population is not represented by this selected case bank.
Across all styles, the original v1 lost 377 games: 361 were also current-policy losses and 16 regressed
from wins. Two additional regressions changed wins to draws. Of those 377 lost games, 179 had no new
proposal, ten had proposals rejected by native filters, 128 admitted a proposal without selecting it,
and 60 actually selected one. This repair targets a specific failure mechanism, not every loss.

Registration `6d26e090bbc7355e265c132d279a16cf571d11a1cf7fa52b8f91bca19a01e093` froze 70 root-state
replays. A separate read-only score observation, registration
`26c032341feaba87c023cb0da9a8d2a2afada84e36f7f933fa2cbe68e4635300`, repeated those 70 battles without
adding rollouts or changing the hypothetical futures. All **140 replays** preserved the original full
input/action/event traces. Every paired root state was identical before the first different action.
All 5,156 original sealed files and both score-observer files were rechecked independently.

| Diagnostic at first differing action                     | 18 regressions | 17 improvements |
| ------------------------------------------------------- | -------------: | --------------: |
| Original chosen action directly evicted by reserved slot |              4 |               2 |
| Original action no longer received full search evaluation|              7 |               2 |
| New proposed move actually chosen                       |             13 |              11 |
| Immediate melee attack given up                         |              9 |               6 |
| New choice's score gain below native 0.01 margin         |             13 |              12 |
| Acting stack never acts again                           |              4 |               3 |

The first two rows overlap: three additional regressions lost their ordinary action earlier in shortlist
competition. Score comparisons use the original action's recorded paired-rollout values, including its
off-arm values when v1 omitted it. Two audit cases have no full off search at that root; their ordinary
choice is scored in the v1 arm. A19's hypothetical values are not the actual future battle outcome.

Concrete regressions include Peasant 44/0: its ordinary action scored `[1, 1]`, was directly evicted,
and v1 selected another action scoring `[0, 1]`; a real win became a loss. Manticore 50/0 lost its ordinary
`[1, 0]` action in shortlist competition, selected a `[0, 0]` approach and also changed a win to a loss.
Several Fairy/Hyena/Wyvern advances tied the original choice at `[1, 1]`, yet lost the real battle.
Conversely, some tied advances and even sacrifices won. Banning every skipped attack, isolated stack or
low-count target would discard useful moves too. Two Magic Dragons or Tsar Cannons are not necessarily
decoys. Neither proximity nor survival alone establishes a better policy.

The debug observer records full engine state for verification. The HTML board view omits Hidden enemy
stacks. The actual candidate uses only visible enemies with remaining ranged or offensive-spell output;
no debug observation, actual future outcome or selected-case label is passed into its decision rule.

## Two fixed repairs

The inert helper is `src/simulation/backline_approach_preservation_research.ts`, ID
`backline-approach-preservation-v1`. Copied hooks exist only in the ignored research capsule.

1. **Preserve:** remove the tagged proposal while computing the complete ordinary native shortlist,
   including native protected reservations. Preserve its order and all alternatives, then append the
   one legal approach move. The final shortlist grows by one alternative. Total overhead still requires
   measurement: adding an alternative can also activate search where an ordinary fast path stopped early.
2. **Margin:** use the same preservation, but require the proposed move's already computed mean to exceed
   every ordinary alternative by at least the existing A19 `valueGain` of **0.01**. Otherwise mask it in
   both primary scores and material arbitration so the later tie breaker cannot revive it. The move is
   never forced. No fitted threshold or extra random future is introduced.

The proposal's public root eligibility and native action/role filters are unchanged from v1. Tests cover
prefix preservation, invalid scores, ordinary-score comparison, tie rejection, later arbitration and
serving import isolation. The complete common build passed **8,009 tests**, with targeted formatting,
lint and typecheck passing.

## Registered comparison and correctness admission

Capsule: client's ignored `game/core/tmp/backline-approach-preserve-20261115`. Registration
`4c4a4919cd0ee03df7b9eaaec3aa0cbdff64ea6e24d17995e9ca90b7567f1b3e` seals **5,169 files**, two relative
package symlinks and the protocol. Common source is `3f053c2e0b60f601792810db616aaf4dd3dc29c7`, server
`d98f259caf4e2a4b663fb67c94020c83b06a8b65`. Serving runtime is unchanged from common `dd8aff09`; intervening
commits contain documentation/inactive research. Dependencies are materialized, package/direct RNG and
FightStateManager identities are asserted, server IDs are seeded, and each arm independently rebuilds
its actual public-ranked draft and authoritative setup before deterministic offline A19 combat.

The initial eight off checks matched their complete input/action-event SHA and winner, then rejected
raw runtime objects because undefined optional keys are absent from stored JSON. The preserved original
registration is `e0030e84f731aefbd2f0eb738dbafeca5ef4dc3272a3bc9edae13a1bb95b1ecf`. Only serialization of
the comparison was corrected, before any new-policy result or fresh game. The separate admission verifier
also excludes observational `helperMs` wall time from cold-run equality. Its replacement is separately
hashed; every semantic observation, complete action/event trace, input and outcome must still match.
No policy, seed, sample size or substantive gate changed in these instrumentation corrections.

All **140 four-arm admission battles** and **12 independent-process cold replays** passed. The 70 off/v1
controls exactly reproduced the prior experiment. New arms preserved 207 complete ordinary shortlists,
rejected 90 insufficient-margin proposals without revival, and selected 42 proposals across all three
maps. No helper/model error, missing model start or illegal action occurred. Cold parity was local;
no cross-host execution is claimed.

On the selected old cases, Preserve returned **6/18** regressions to their original wins and retained
**16 wins and one draw** among the 17 prior improvements. Margin returned **13/18** regressions to wins,
but retained only **five wins and two draws** among the prior improvements. These are diagnostic recovery
counts, not independent strength estimates. Both policies were fixed before these repaired replays and
both remain in the fresh comparison regardless of their selected-case performance.

## Fresh development design

There are **216 fresh independent board families**, four draft-order/physical-seat cases per family and
four arms (current, original v1, Preserve, Margin): **3,456 actual battles**. Primary inference uses 162
families equally divided among current, shooter and damage-caster opponents. Another 54 fast-melee
families are a separate pressure control. Maps and own/enemy 5/6/7 doctrine pairs are balanced. No
eligibility filtering, outcome refill, partial-score stopping, subgroup rescue or tuning is allowed.

The four primary contrasts compare each new policy with current and original v1. Report draw-aware
percentage-point gains with 10,000 common whole-family bootstrap resamples, Python RNG seed 20261116.
Four-comparison intervals use Bonferroni 98.75% marginal percentile intervals (nominal joint 95%);
unadjusted 95% intervals and all doctrine/style/map slices are descriptive. Independent exact bootstrap
convolution checks Monte Carlo interval error separately. Do not pool old diagnostic cases or v1's
previous bank into this new result.

A new policy advances only with **strictly positive** primary means against both references, nonnegative
own-doctrine and primary-style means against current, pressure loss no worse than one point, and clean
integrity checks. This permits investigating small gains for these distinct new candidates; it does
not relax the original v1 gate or establish strength. If both advance, choose larger primary gain against
current, with Margin breaking a tie. Any finalist still needs separately registered **6,000-plus fresh
confirmation games**, a positive whole-family 95% lower bound, doctrine/style checks, current serial
serving overhead within 10%, and native state/Undo/deadline qualification. No confirmation seeds have
been allocated and no default change is authorized by development alone.

Execution uses **12 nice-19 local workers** on the M4 Max. Puffalo is saturated with independent peer CPU
studies; this experiment starts no remote workers and does not change peer jobs.

### Seed reservation

Namespace: `backline-approach-preserve-20261115-fresh-development-v1`. For counters **1 through 219
inclusive**, SHA-256 UTF-8 `namespace:counter`; take the first four bytes as little-endian uint32 and
reserve that preimage plus offsets 0–7 **and** all eight canonical `permuteRankedDraftSeed` values,
including the three rejected scans. This is **3,504 scanned channels**, with 3,456 accepted channels on
216 families, disjoint from 11,111,687 excluded historical channels. Independent TypeScript verification
reconstructed the allocation using the canonical permutation. Reserve the whole scanned namespace,
not only accepted families. Earlier failed banks and the separate peer geometry confirmation stay closed
or independent as previously registered.

## Completed development: no finalist

All **3,456 scheduled battles** finished in 2,103.7 seconds with zero rejected actions, model errors,
missing neural starts, deadline fallbacks or degraded decisions. Neither new policy beat the original
v1 on the primary population. The original v1 result on this bank is a separate repeat measurement,
not a replacement for its earlier +0.154321 pp estimate or a reason to reopen its failed gate.

| Policy                    | Wins | Draws | Losses | Primary score | Gain vs current, pp | Gain vs original v1, pp |
| ------------------------- | ---: | ----: | -----: | ------------: | ------------------: | ----------------------: |
| Current AI                |  388 |     9 |    251 |    60.570988% |                   — |                       — |
| Original v1               |  390 |    11 |    247 |    61.033951% |           +0.462963 |                       — |
| Preserve every choice     |  390 |    11 |    247 |    61.033951% |           +0.462963 |                0.000000 |
| Preserve plus score margin|  390 |     8 |    250 |    60.802469% |           +0.231481 |               −0.231481 |

The four registered primary comparison intervals, adjusted together, are:

| Contrast                | Gain, pp | Adjusted 95% interval, pp |
| ----------------------- | -------: | ------------------------ |
| Preserve vs current     | +0.462963 | −0.925926 to +1.929012 |
| Preserve vs original v1 |  0.000000 | −0.385802 to +0.540123 |
| Margin vs current       | +0.231481 | −0.617284 to +1.157407 |
| Margin vs original v1   | −0.231481 | −1.388889 to +0.925926 |

Every primary interval includes zero. Equal observed Preserve/v1 totals do not establish equivalence.
The old diagnostic recoveries did not become an overall improvement over the original policy on fresh
families. This demonstrates why checking only the selected regression cases would have been misleading.

| Primary subgroup      | Cases | Preserve vs current, pp | Margin vs current, pp |
| --------------------- | ----: | ----------------------: | --------------------: |
| Five-point doctrine   |   216 |               +0.694444 |             +0.462963 |
| Six-point doctrine    |   216 |               +0.694444 |             +0.694444 |
| Seven-point doctrine  |   216 |                0.000000 |             −0.462963 |
| Current opponent      |   216 |               +0.925926 |              0.000000 |
| Shooter opponent      |   216 |               +1.851852 |             +1.157407 |
| Damage-caster opponent|   216 |               −1.388889 |             −0.462963 |
| Normal map            |   216 |               −0.231481 |              0.000000 |
| Lava map              |   216 |               +0.925926 |             +1.157407 |
| Blocked map           |   216 |               +0.694444 |             −0.462963 |

The separate fast-melee control gained +0.694444 pp for Preserve and +0.231481 pp for Margin; both
passed the pressure limit. Preserve passed all own-doctrine means, but failed the strictly-positive
comparison against v1 and the damage-caster mean. Margin also failed the seven-point doctrine mean.
**Neither advances. No confirmation bank opened and no serving/Premium default changed.**
The favorable shooter slice is descriptive, not a qualified shooter-only dispatch rule. The repeated
caster weakness motivates a distinct future hypothesis; it does not authorize tuning this opened bank.

Preserve retained 1,055 ordinary shortlists and selected 148 distinct proposed moves. It changed 146
trajectories versus 193 for original v1. Margin rejected 1,057 distinct insufficient-margin decisions,
selected 30 proposed moves and changed 31 trajectories. Reducing interventions did not beat v1's score.
The independent raw verifier reconstructed every consumed-input hash and draw-aware score, checked all
four openings per case, verified all 5,169 sealed files, and reproduced the gates. An independent exact
bootstrap-distribution calculation agreed with the sampled primary conclusions; its Preserve/v1 lower
adjusted endpoint was −0.462963 pp rather than the registered Monte Carlo estimate −0.385802 pp.
The registered sampled interval remains the result. Raw hashes are recorded in the independent receipt.

Later server commit `d90e6bd5aa339be1ad73d1545076bba262f00ba0` changed only package/lock pins; its runtime
source matches the freeze. The serving helper remains unreachable. Parallel fight time and aggregate
work counters are descriptive because trajectories differ; no serial serving-cost qualification is claimed.

The complete local capsule retains `analysis.json`, `independent-verification.json`, source/seed receipts,
all raw battles, 35-case diagnostic atlas, 377-loss coverage analysis, correction records and the standalone
`backline-loss-audit.html`. Downloads contains `heroes-backline-loss-audit-20261115.html`. All 240 filter
combinations and 35 detail views passed UI checks. Preserve this result and the inactive helper rather
than importing either new policy into serving code.
