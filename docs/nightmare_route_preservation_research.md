# Nightmare Fire Wall: preserving allied approaches

This is the distinct offline follow-up `nightmare-route-preserving-20261117`, with candidate
`nightmare-route-preserving-wall-v1`. It compares the unchanged default, the original
`nightmare-ground-wall-coverage-v1`, and a guarded version of that original proposal. Neither research
helper is imported by serving code. The accepted A19 models and default 0.9 profile remain unchanged.

The [original study](nightmare_ground_wall_research.md) estimated **+0.231481 percentage points** from
four improved and three regressed results in 432 comparisons. Its interval crossed zero and its
development gates failed. That experiment stays closed, with its source, gates and seed reservations
preserved. This study tests a distinct hypothesis on new families; it does not revise the old result.

## Hypothesis and fixed intervention

A useful wall should make an enemy approach more costly without obstructing equally useful allied
approaches or sacrificing an immediate attack or a better spell. The original proposal's geometry,
target classification and zero immediate-damage features are unchanged. The new helper only filters it:

- Decline when the ordinary catalog contains a melee, ranged or area attack with positive expected damage.
- Use each relevant creature's native current one-turn movement routes, including its real footprint,
  current fire, terrain, aggression and movement effects. Reprice those routes with the proposed wall's
  additional ground steps and the authoritative post-movement damage projection.
- Measure progress by minimum Chebyshev distance from the creature's footprint to visible opposing
  footprints. A surviving route is safe if it fits the new movement budget without additional burn HP.
- Require every considered ally to preserve an equally close safe approach. Require at least one
  eligible enemy ground creature to lose its equally close safe advancing approach.
- Consider all living own creatures without remaining ranged or damaging-spell output, including known
  hidden allies and flyers, plus the original proposal's eligible visible ground enemies. Decline above
  twenty route units or when the context does not match the native live fight state.
- After complete H64/R2 evaluation, require the new wall's full-rollout mean to beat the best ordinary
  attack or non-wall spell by **strictly more than 0.01**. Both must have two complete samples. If no
  productive alternative has a finite mean, a completely evaluated wall remains eligible.

The new proposal is appended after ordinary shortlisting. Every native alternative, its object identity,
order and forecast remain intact. The opportunity gate masks only the added wall's selection score when
it fails, before unchanged arbitration and final neural selection. The raw forecast is retained in the
audit. The original comparator receives neither the new route guard nor this selection mask.

Ground movement pays an additional step for each newly burning swept footprint cell. Flying crossings
do not pay that toll, but flying landings still use the real damage projection. Existing fire and shields,
resistance, elemental effects and the caster's magic bonus are retained. Enemy hidden units are excluded;
own hidden units are known and protected. The helper neither draws RNG nor mutates live state, and the
runtime asserts both at every observed root.

This is **coverage of the current native route bank**, not a hypothetical new path search or a prediction
of the opponent's eventual choice. It may miss newly useful detours; footprint distance is not an attack
value estimate. The guard does not know future unit movements, future summons or the future value of a
three-lap wall. A preserved present approach cannot guarantee no later friendly fire. These limits are
part of the frozen hypothesis rather than outcome-based exceptions.

## Registration and independent comparisons

Registration SHA-256: `3ed06ee12097d7e63ff7079e853f7b015f95017343144ffd5846b193c35b0887`.
The capsule is `game/core/tmp/nightmare-route-preserving-20261117` relative to the client repository.
Its common and server sources are exact committed archives of `bf38acba` and `82336c69`, plus the
separately hashed new inactive helper and test. The original helper SHA-256 remains
`83d590e8ad804382bf649891c8114a29e3ea5db2da937b8492f476ea5dffd85c`.
Peer working-tree changes are excluded. All 5,409 runtime files, inputs and old reference traces are
sealed; package identity is checked against this capsule's common source on both hosts.

Admission replays **all 65 previously changed trajectories**, including every gain, loss and same-result
change. Four arms (off, observer, original v1 and guarded v2) produce 260 executions, followed by 24
fixed cold repetitions. Same-host observer and cold traces must match exactly. Cross-host equality with
the original Mac traces is reported separately, not assumed or used as fresh strength evidence. At least
one actual additional v2 comparison must occur before the pipeline may open fresh battles. No policy
changes are permitted after admission outcomes.

The fresh population uses legal ranked drafts with a candidate preference for a visible Nightmare pick.
Other decisions use the frozen adopted V3/contextual draft, real ranked stack amounts, funded upgrades,
artifacts, support/splits and placement. The fixed pool has 96 roster-only attempts for each combination
of normal/lava/mountain map and both players' 5/6/7-point doctrine. Select the first four Nightmare
rosters for each pick order and stratum: **216 independent families**, found after 278 draft examinations.
No battle outcome participates in selection. This measures conditional Nightmare use, not default
Nightmare pick frequency or unconditional strength across the full roster.

Both seats and two combat futures yield **864 paired comparisons**. All four arms run independently,
rotating their order by case index. The main comparison requires 3,456 executions; 18 fixed cases repeat
all arms in cold processes, adding 72. Together with admission the registered total is **3,812**.
Two earlier off/observer mechanism preflights are separate from this total and contain no fresh outcomes.

Keep win 1, draw 0.5 and loss 0; average the four differences within each family and weight families
equally. The two primary contrasts are guarded v2 versus default and guarded v2 versus original v1.
A fixed 20,000-draw whole-family bootstrap (Python Random 73117720) uses Bonferroni percentile endpoints
1.25% and 98.75%, giving simultaneous 95% intervals over those two contrasts. Original v1 versus default
is a diagnostic contrast with ordinary 95% endpoints. An independent Bun verifier reconstructs raw
outcomes, integer family scores and gates, and checks bootstrap endpoints using exact empirical
convolution with explicit Monte Carlo quantile bands.

Every development gate must pass:

- Complete source/input, observer, cold, health, model, actual-choice and selection-mask checks.
- At least ten v2 trajectory changes against default across at least two maps.
- At least three actually selected v2 walls across at least two maps.
- Positive point estimates and positive simultaneous lower bounds for both primary contrasts.
- Nonnegative means for every own doctrine in both primary contrasts.

This distinct study has no additional half-point minimum: the user values improvements around 0.23
points. The independent evidence gates still apply, and the original study's thresholds are unchanged.
A development pass would permit separately registered independent confirmation and serial serving-cost
validation within +10%; it cannot automatically change any default or Premium policy.

All 20,480 scanned preimages in namespace `nightmare-route-preserving-20261117-fresh-v1` remain reserved,
including rejected and unused scans. Derive counters 1–20,480 from the first four SHA-256 bytes of
`namespace:counter`, little-endian uint32, then reserve `(n+i) >>> 0` and `permuteRankedDraftSeed(n+i)`
for i = 0–31. There are **1,310,432 distinct reserved channels**. Allocation and independent canonical
permutation reconstruction agree; 162 prior ledgers were checked. The
[evidence fixture](evidence/nightmare_route_preservation_20261117.json) preserves the full preimage ledger.

## Resources and validation

The frozen job runs on Puffalo with **six nice-19 CPU workers and no GPU**, alongside existing workloads.
Its output is on the separate `/var/tmp` filesystem, which had over 742 GiB free at launch. The original
hard cutoff is **2026-11-17 09:51:21 UTC**, with a 2 GiB free-space floor, no automatic retry and no
extension. Parallel job timings do not establish serial serving cost.

Nine new tests plus the original selector and existing wall tests passed: **526 tests / 4,051 assertions**.
Targeted TypeScript and ESLint checks passed. Mechanism fixtures cover ground movement tolls, immunity,
flying crossings and landings, rectangular sweeps, alternate routes, hidden allies, context rejection,
state/RNG purity, strict full-R2 opportunity margins and serving isolation. The original helper's bytes
are unchanged. The two preflight executions exactly replayed the old control and matched each other.

## Halted before fresh outcomes: selection integration failure

The run launched on Puffalo at **2026-11-17 07:23:04 UTC** and stopped at **07:39:31 UTC**, after all
260 admission executions and 24 cold repeats. The admission verifier correctly rejected **20 of 24**
new-wall selections: those walls had failed the intended opportunity gate. **Zero fresh executions**
opened, and the invalid arm supplies no strength estimate.

The hook returned a masked copy of the score array, while `SearchDriver` retained the original array
in its material evidence. Later A19 arbitration could therefore reselect the wall using unmasked means;
the final neural guard did not undo that already-selected action. The helper's pure gate was correct,
but the integration did not implement the registered policy. This is a research-harness failure, not
a change or newly introduced defect in the shipped default.

A separate diagnostic verifier preserves the failure while checking every execution. All 65 observer
pairs, 24 cold repeats and 130 original Mac versus Puffalo off/v1 comparisons match exactly. Source,
input, health, model and original-candidate invariants pass. There were 30 v2 additional comparisons and
25 opportunity masks; 20 masked walls were nevertheless selected. The failed capsule and original
registration remain intact. No automatic retry or extension was sent.

The correction uses the same selection array retained by material arbitration, preserving an independent
raw-forecast copy for audits. Its regression tests exercise both real material and neural selector
functions. A separately recorded corrected execution must pass full admission before opening the
previously reserved, still-unopened fresh bank. The route policy, margin, old comparator, strength gates
and original hard cutoff remain unchanged.

The [corrected execution](nightmare_route_selection_corrected_research.md) has its own registration and
capsule. It retains six Puffalo workers and adds four local workers with balanced, fixed host assignment;
every paired comparison remains on one host. Preserve both records rather than overwriting this failure.

The corrected execution subsequently completed all 3,812 registered executions with quality checks
passing. Its guarded policy scored −0.173611 points versus default and −0.925926 versus original v1 on
864 fresh paired comparisons, failing development. It remains inactive; the corrected document and
fixture contain the complete results. This failed first admission remains a separate preserved record.
