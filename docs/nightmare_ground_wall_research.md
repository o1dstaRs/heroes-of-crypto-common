# Nightmare Fire Wall: ground-approach coverage

This is an offline experiment, `nightmare-ground-wall-20261117`, requested after closing the Peasant
follow-through study. Candidate `nightmare-ground-wall-coverage-v1` is not imported by serving code.
No strength gain or default change is established by the mechanism tests below.

## Mechanics and the observed planning gap

The authoritative engine places up to four free cells in one of four orientations, anywhere on the
field. Occupied, mountain, narrowed and off-board cells are skipped. The wall lasts three laps. Each
burning cell entered costs a ground creature an additional step and burns a base 25% of its current
stack maximum HP, with the stack recalculated between cells. Magic resistance, elemental affinity,
damage-taken modifiers and shields still apply. The caster's magic bonus is stored when the wall is
cast. Allies burn too. Flyers avoid crossing penalties and burn only on landing; remaining stationary
on fire does not repeatedly burn a creature. Nightmare's Time Denial disables Hourglass globally.

These are existing rules in `src/spells/fire_walls.ts`, `src/engine/action_engine.ts`,
`src/engine/post_move_actor_availability.ts` and `src/grid/path_helper.ts`; this study changes none of them.
The existing spell and movement tests cover engine/projection parity, diagonal sweeps and large flyers.
An independent fixture also preserves a legal stationary ranged attack at 100 expected damage before
and after a wall is placed across its shot line: Fire Wall does not provide Smoke's shot protection.

The ordinary wall planner in `src/ai/candidates.ts` considers every visible enemy. It samples 25%, 35%
and 50% along the line from each enemy to the allied centroid, tries perpendicular orientations first,
and ranks by stack maximum attack damage divided by the sample fraction. It neither checks an actual
approach route nor excludes flyers, ready shooters or usable damage-spell casters. It emits one wall.
The native Nightmare role proposes that wall over a passive/advance decision, preserving immediate
attacks and spells; A19 then evaluates its bounded catalog.

The controlled test has a high-damage flyer on one flank and a ground attacker on the other. The ordinary
wall misses the specified ground crossing. The proposed wall is accepted by the real cast engine, and
the authoritative movement projection prices that crossing at 250 HP on a 1,000-HP test stack instead
of zero. Equivalent targeting tests cover a ready shooter and damage caster. This demonstrates a
candidate-coverage gap, not that the enemy will take that route or that spending the turn wins the game.

The preceding Peasant bank had no Nightmare turns in its 432 baseline battles. It was inspected only
for possible reusable diagnostic coverage and supplies no Nightmare outcome evidence.

The practical hypothesis is to tax an approach the opponent needs to make while preserving useful
allied routes. A wall may deny contact through its extra movement cost without dealing damage, or burn
a stack that crosses. A stationary shooter/caster need not cross it; a flyer can cross without paying
the ground penalty. The wall cannot ignite an occupied cell for an immediate hit, and neither repeated
stationary damage nor blocked shots should be counted as a benefit. Allies, including the walking
2-by-1 Nightmare itself, also need a safe route. Fire immunity can remove the burn without removing
the ground movement toll. These mechanics motivate route, timing and opportunity-cost evaluation;
they are not additional policies qualified by this experiment.

## Separate neural observation diagnostic

The adopted A19 observation in `src/simulation/v0_9/a19_observation.ts` includes the spell name and aimed
cell, but not `targetOrientation`. Its terrain input includes the built-in terrain categories, not
existing Fire Wall cells, remaining laps or burn percentages. This is a trained input contract; adding
columns requires a new contract and newly fitted/qualified models, not modifying inputs underneath the
accepted weights.

The separate `neural-wall-observation.ts` fixture in the capsule proves the consequence with the exact
frozen encoder and adopted two-model ensemble. A horizontal and vertical wall at `(7, 8)` have distinct
action signatures and different four-cell footprints, but identical candidate tensors and predictions.
A ground move from `(7, 11)` through `(7, 10)` to `(7, 9)` suffers respectively 0 or 250 HP of projected
damage on a 1,000-HP stack. The action signatures are metadata, not neural inputs.

Keeping actors and candidate metadata fixed, adding the vertical wall for three laps at 25% burn leaves
the entire observation and prediction unchanged. Changing it to one lap at 30% burn also leaves them
unchanged, while the same projected crossing rises to 300 HP. This isolates missing state channels;
other inputs can change indirectly after fire changes HP or available actions.

This is a reproducible representation gap, not a measured strength gain or a claim that the complete
agent cannot see fire. Full engine search models the movement and damage. No encoder, model or policy
was modified for this diagnostic, and it neither changes the registered wall pilot nor supplies an
alternative promotion gate. The compact evidence includes its inputs, outputs and source hash.

## Fixed candidate

`src/simulation/nightmare_ground_wall_research.ts` offers at most one additional Fire Wall at an own
Nightmare's root decision. An existing legal Fire Wall in the ordinary catalog gates availability.
The planner retains the current geometry and threat calculation, but restricts its approach targets to
visible living ground units with no remaining ranged or usable damaging-spell output. It requires both
an eligible ground target and an excluded enemy. It uses the same three sample fractions and four
rotations, rejects gaps through creature bodies, and declines if those samples have no legal wall.
It does not use the ordinary planner's full-grid fallback.

A wall with the same lit-cell set already in the ordinary catalog is not added. The proposal carries
zero immediate damage/kill features. It is appended after ordinary shortlisting, preserving every
native alternative and its order/object identity. Existing H64/complementary-R2 search, arbitration
and final neural correction decide whether to cast it. Native continuation policy, learned weights,
neural margins, draft/setup choices and the existing wall remain unchanged within each paired battle.
The extra comparison can increase search cost; no serving-cost claim follows from parallel batch timings.

The helper reads only current public combat facts. It performs no path search, rollout, RNG draw or
state mutation. The old inactive backline-approach module supplies only its pure remaining-output
classifier; its failed policy is not reactivated. Ground classification is a movement hypothesis, not
proof of a route, valuable contact delay or favorable friendly-fire exposure.

## Registered complete-game comparison

Registration SHA-256: `bc6bb9ca33124c11133c24a87f0a4c0a1950a89e7ef464e9e8392e2be19da03d`.
The ignored capsule is `game/core/tmp/nightmare-ground-wall-20261117` relative to the client repository.
Its common and server source directories are exact committed archives of `9e7305f7` and `82336c69`,
plus the separately hashed inactive helper. It includes the adopted melee-barrel correction. Native
ranked runtime infrastructure was copied from the prior verified capsule; package identity is asserted
against this capsule's own common source. Peer working-tree edits are excluded and remain untouched.

The population uses legal drafts with an explicit candidate preference for Nightmare whenever it is
visible in a creature-pick offer. Otherwise both sides use the adopted V3/contextual draft. A forced
preference does not consume the ordinary policy's override state. Bans and collisions still resolve
normally; a draft without candidate Nightmare is not selected. This is a targeted unit-use population,
not a test of the default's Nightmare pick frequency or an unconditional global strength estimate.

Before any battles, the fixed pool contains 96 drafts per map/own-doctrine/opponent-doctrine stratum,
alternating pick order. Select the first two successful Nightmare rosters per pick order and stratum.
All **108 families** were found after **148** roster-only draft examinations. No outcomes were used.
Real ranked stack amounts, funded upgrades, artifacts, native support/splits and placement are retained.

Both physical seats, two combat futures and off/observer/on modes produce **1,296 main executions**.
Eighteen fixed map/own-doctrine/seat cases repeat all three modes in cold processes, adding **54**.
The total is **1,350 executions**, of which 864 off/on outcomes form **432 paired comparisons**. Observer
and cold repetitions are quality checks, not extra independent strength samples.

Keep every native result: win 1, draw 0.5, loss 0. Average four paired differences within each family,
then weight the 108 families equally. The fixed 20,000-draw whole-family percentile bootstrap uses
Python Random 73117719. Report all own-doctrine, opponent-doctrine and map means. Every development
gate must pass:

- Complete source, input, health, model, observer, cold-replay and actual-choice quality checks.
- At least ten changed trajectories across at least two maps.
- At least three actually selected new walls across at least two maps.
- At least +0.5 match-score percentage points and a positive 95% lower bound.
- Nonnegative means for each own doctrine.

Only a pass permits separately registered independent qualification/confirmation and serial serving
timing within the user's +10% compute limit. There is no automatic promotion, and no subgroup can
replace a failed overall gate.

All 20,480 scanned preimages in namespace `nightmare-ground-wall-20261117-fresh-v1` remain reserved,
including rejected and unused scans. Derive each from the first four SHA-256 bytes of
`namespace:counter`, little-endian uint32, counters 1–20,480. Reserve every `(n+i) >>> 0` and
`permuteRankedDraftSeed(n+i)` for i = 0–31: **1,310,532 distinct channels**. The Python allocation and
independent Bun reconstruction agree; 161 prior exclusion sources were checked. See the
[evidence fixture](evidence/nightmare_ground_wall_20261117.json) for the full reservation ledger.

Four nice-19 CPU workers run locally, with no GPU. The hard cutoff is **2026-11-17 06:46:23 UTC**,
with a 1 GiB free-disk floor, no automatic retry and no extension. The policy and primary analysis
were sealed before the first outcome. Eight new selector/isolation tests plus existing wall tests
passed: **517 tests / 3,890 assertions**. Targeted TypeScript and ESLint checks passed.

## Completed result: closed, failed development

All **1,350 executions** completed at **2026-11-17 05:39:23 UTC**, within the original limit. Input,
source, health, model, actual-choice, observer and cold-replay checks passed. The independent integer
score reconstruction and exact empirical whole-family bootstrap agree with the registered analysis.
No game was dropped, retried or replaced. No qualification/confirmation bank was opened.

Across **108 families / 432 paired comparisons**, the candidate changed 65 trajectories. It turned
four losses into wins and three wins into losses; the other 425 match scores were unchanged. Match
score rose from **21.643519% to 21.875000%**, a **+0.231481 percentage-point** difference. The whole-family
95% interval is **−0.925926 to +1.388889 points**. This does not establish a strength gain. The low
absolute score is conditional on the deliberately Nightmare-preferring draft population; it is not
an isolated Nightmare balance measurement or the ordinary default's win rate.

| Fixed group          | Families | Match-score difference, points |
| -------------------- | -------: | -----------------------------: |
| Normal map           |       36 |                      +0.694444 |
| Lava-center map      |       36 |                       0.000000 |
| Mountain-center map  |       36 |                       0.000000 |
| Own 6-point doctrine |       36 |                      +1.388889 |
| Own 5-point doctrine |       36 |                      +0.694444 |
| Own 7-point doctrine |       36 |                      −1.388889 |

Coverage gates passed, but the minimum gain, positive confidence lower bound and nonnegative own-doctrine
gates failed. The candidate remains offline and must not be promoted or narrowed to a favorable slice
of this opened bank. No default, model weights, encoder or Premium routing changed.

## Complete wall-use and outcome audit

The independent Python geometry reconstruction checked all 1,685 baseline-observer and 1,690 treatment
shortlist calls against captured public inputs. It reproduced every proposal and abstention. Treatment
added **275 comparisons / 528 full rollouts**, and **64 new walls were actually chosen**. At the first
divergence, 41 replaced an ordinary wall, ten replaced Empower, ten replaced movement and three replaced
a move-and-attack. One further trajectory changed between ordinary melee alternatives after the catalog
addition and kept the same result. Every original alternative remained available.

Actual Fire Wall casts increased from **287 to 301**. Across complete games, enemy burn damage increased
from **27,764 to 32,416 HP**, while allied burn damage increased from **5,342 to 6,917 HP**. No opponent
wall was cast in this population, so those burns came from the candidate team's walls. These totals
include later policy/chance effects and unlike unit HP; they do not replace the match-score result or
isolate a particular wall's causal value.

Every outcome-changing pair first diverged on a new wall in lap one. The descriptive trace audit includes
all seven, not just wins:

| Case                   | Result change | Observed difference                                                                                                                      |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh-s05-f005-s0-f1` | Loss → win    | Replaced self-Empower; enemy White Tiger burned for 71 HP. The baseline's later wall burned allied Trent for 190 HP.                     |
| `fresh-s09-f002-s1-f1` | Loss → win    | Repositioned the wall; enemy Trent and Pikeman burned for 221 HP instead of no burns.                                                    |
| `fresh-s13-f006-s0-f0` | Loss → win    | Repositioned the wall; baseline burned allied Trent for 152 HP, treatment had no burns.                                                  |
| `fresh-s16-f003-s0-f0` | Win → loss    | Repositioned toward Nomad; neither arm had a burn event. Routes and later decisions still differed.                                      |
| `fresh-s17-f002-s1-f1` | Win → loss    | Replaced Empower on Orc; enemy Pikeman burned for 74 HP, but the game was lost.                                                          |
| `fresh-s19-f003-s0-f0` | Loss → win    | Repositioned toward the Satyr side; subsequently summoned enemy Wolves burned for 130 HP.                                                |
| `fresh-s22-f001-s0-f0` | Win → loss    | Replaced an attack on Wyvern with a wall aimed at Troglodyte. It burned allied Peasant/Trent for 203 HP and enemy Troglodyte for 126 HP. |

The first two regressions tied the discarded action's mean in the two sampled full continuations; the
third had a higher sampled mean than the discarded attack despite losing the actual game. This supports
examining route value, opportunity cost and continuation uncertainty. It does not justify a new rule
fitted to these seven examples, or attributing the entire difference to one damage event or the neural
selector.

Existing fire was present at **537 of 1,837 baseline Nightmare turns** and **562 of 1,840 treatment turns**.
However, no proposed wall shared an ordinary wall's anchor with a different orientation in this pilot.
The separately proven orientation/state input omission is therefore a distinct representation finding,
not an isolated explanation for this experiment's seven outcome flips.

## Next research boundary

A stronger distinct hypothesis should estimate enemy contact delayed and crossing damage against allied
contact delayed, allied burns, and the attack or Empower turn sacrificed. It needs actual routes and
footprints, not only a line toward the army centroid. Protecting a useful ranged formation from incoming
ground units is different from preventing Nightmare from reaching an enemy ranged formation.

The separate learning direction is an explicit input contract for existing burning cells, remaining
life/power and candidate wall footprints/orientation, followed by newly trained models. Preserve the
accepted A19 pair while testing it. Either direction requires a new registration, fresh outcomes,
independent qualification/confirmation and serial serving-cost checks. Preserve this closed candidate,
all scanned reservations and the full capsule; do not relabel its development bank as a fresh holdout.
