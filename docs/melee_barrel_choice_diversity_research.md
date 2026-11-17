# Walk and wait coverage in melee barrel search

The user-locked [barrel deliberation correction](melee_barrel_deliberation.md) remains the default.
This separate `melee-barrel-choice-diversity-v1` experiment asks whether repeated spell targets crowd
out useful movement or initiative choices in its existing shortlist. It is offline research, with no
serving import, model fit, upgrade change or automatic activation.

## Diagnosis and fixed candidate

The opened barrel-confirmation trajectories contain 3,580 eligible roots. Of the 1,148 actual final
barrel clears, 99 had a legal wait present in the leaf prepass but absent from the full shortlist;
45 similarly lost a pure move. These counts can overlap. The leaf prepass is skipped when every
candidate fits, so absence of a leaf record does not imply an illegal action. These selected diagnostics
are not a population strength estimate. Most remaining clears had tied full forecasts, as documented
in the original final-action audit.

Only at a native melee deployment-barrel incumbent on the experimental entrant does the candidate
retain the best finite missing pure move, then a missing legal wait. Each uses a slot occupied by the
worst leaf-scored duplicate spell target whose estimated net damage is nonpositive. At least one
target for each spell remains. Unique spells, positive-damage estimates, Vine Throw, Resurrection,
the native incumbent and all other reserved alternatives remain. The retained list never grows.
This heuristic does not prove that two targets of the same spell are strategically equivalent.

The selector accepts only already legal, role-filtered candidates. Existing search horizons, rollout
counts, value/material gates and final neural/support corrections remain unchanged. Both comparison
seats already use profile v9's adopted barrel correction; the old flag-off policy is not the primary
comparator. The accepted 50.36% neural pair is an unchanged third reference, not a newly trained model.

The canonical helper is `src/simulation/melee_barrel_choice_diversity_research.ts`. Type erasure
produces exactly the original frozen experiment function bytes, SHA
`109346c7b9440db8925e3faa8e4404b811bf1128e19a1aca4c2ed69992ab04c9`.
Import isolation and five selector tests cover conservation, legality, protected actions and evidence.

## Registration and functional admission

The source is common `9e7305f7` and server `ae63b150`, with locked V3/contextual draft, native paid
Setup, support splits, formation and complete legal placement. The ignored client capsule is
`game/core/tmp/barrel-choice-diversity-20261117`. Functional seal:
`4b0984ad87063f44c9cdcc96aa6fb4acb657ec204f034f84c5b0f00d2171f40b`.
Development seal:
`44a82736e7631a66c2d976911d05ac8bf993bb42f5b786ef16ea66cfcce812f1`.

All 48 functional fights passed, followed by nine exact cold-process replays. All 16 stock/observer
traces and four no-barrel stock/candidate traces matched. Thirteen shortlist changes across all three
maps restored four move comparisons and ten waits. Actual final choices at these roots included
three moves, two waits, one defend, five spells and two clears. This is correctness evidence only.

The first dependency-link attempt failed its package-identity assertion before any fight. A corrected
capsule-local common dependency retained the original source seal. A subsequent session transition
left zero rows and no live worker; that startup was preserved before the original smoke was executed.
Neither infrastructure event changed the candidate, sample, gates or any strength outcome.

## Fresh screen

The fixed screen reserves 108 independent legal draft families, with four draft-order/physical-seat
cases each and three arms: 1,296 full fights. Every 27-family style block balances three maps and all
nine own/opponent doctrine pairs. Four fixed opponent styles cover ordinary, shooter, caster and
pressure preferences. Eligibility depends only on a completed legal draft choosing Barrel Barricade
in either draft order, before combat. No offered artifact, roster, augment budget or placement is forced.

The [registration fixture](evidence/melee_barrel_choice_diversity_registration_20261117.json) preserves
all 14,432 scanned preimages, including rejected and unused candidates. Exclude each preimage's eight
raw and eight native-permuted channels in future work. Native Bun reconstruction verified the complete
ledger and first-eligible selection; allocation excluded 19,831,597 previously reserved channels.

The screen requires at least +0.5 score points versus the adopted default, a positive whole-family
95% bootstrap lower bound, at least 12 changed families, and no map, own-doctrine or opponent-style
mean below −1 point. The confidence unit is the four-case family, not an individual turn or fight.
The registered bootstrap uses 20,000 uint32 resamples with seed 1746179001. The accepted neural
comparison is descriptive. Every arm independently reconstructs its native opening; consumed hashes
must match, with zero rejected actions, model errors or missing starts.

Workers run locally at nice 19, at most 12 at once, with a two-hour controller ceiling. Strength gates
must pass before separate serial serving timing within +10% and a newly registered independent bank
of at least 756 families. No favorable subgroup, relaxed threshold or extra sampling can rescue a
failed screen. No qualification or confirmation bank has been allocated.

## Completed result: closed after development

All 1,296 fresh fights completed in **1,131.08 seconds (18m 51.08s)**. Control, candidate and the
accepted neural reference each scored **51.504630%** on this fixed opponent mixture. Candidate versus
control gained **0.000000 points**; every one of the 432 paired game outcomes was unchanged
(220 wins, 207 losses, five draws in each arm). The all-zero empirical whole-family bootstrap interval
is degenerate; it does not prove zero population effect or equivalence.

The candidate changed 25 shortlists on ten families and ten complete trajectories on seven families.
Its actual final actions at changed shortlists were 13 waits, six clears, four moves and two spells.
The +0.5-point gain, positive-confidence and 12-changed-family gates failed. All map and doctrine mean
contrasts were zero. This missing-action mechanism therefore did not establish an additional win.
The accepted neural comparison was also zero overall, with descriptive 95% −1.273148 to +1.273148 points.

Independent Bun integer half-point reconstruction verified every raw result and the complete bootstrap
resampling. All arm input hashes matched, with zero rejected actions, model errors or missing starts.
Every changed primary trace had an actual shortlist intervention. A peer's subsequently updated
reservation fixture was rechecked: all its scanned channels were already in the sealed exclusions,
with no overlap with this study. All 2,758 frozen files remained exact.

Including functional and cold checks, this study executed 1,353 complete fights. Qualification,
confirmation and serial serving timing remained unopened; none of their games was allocated.
The helper stays inactive. Do not relax the gate, increase sampling or promote a favorable slice to
rescue this closed candidate. The original confirmed barrel correction and both neural references
remain intact. Complete evidence is in the
[result fixture](evidence/melee_barrel_choice_diversity_results_20261117.json).

Common validation passed lint, typecheck and **8,157 tests across 694 files**. The canonical helper's
six tests cover its policy and serving isolation. Its executable function remains identical to the
sealed study helper after type erasure. These checks do not substitute for the failed strength gate.

The source audit also confirms that artifact barrels already appear as BLOCK cells in the neural
terrain encoder and are consumed by its terrain layer; missing barrel geometry is not an established
explanation for the original behavior. Native forecast cleanup still differs from the fully searched
continuation. Any work on that mismatch needs a distinct hypothesis and fresh evaluation, preserving
the earlier failed own-barrel guard and searched-reply studies. No further candidate is activated or
claimed to be stronger by this result.
