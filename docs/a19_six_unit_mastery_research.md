# A19: mastering six key units

Research focus requested October 27, 2026: **Tsar Cannon, Gargantuan, Black Dragon, Zena,
Wandering Mage and the level-4 spellbook dragon**. The last is `Magic Dragon` (57) in the active
roster. `Faerie Dragon` is a separate old configuration row with no current creature enum ID;
it is not the spellbook creature being studied. Portraits, creature balance and the shipped AI
remain unchanged.

The objective is to improve complete armies **playing with and against** each unit. A unit's damage,
survival, number of casts or an attractive attack pattern is not itself a mastery label. In the last
Chakram study, a Gargantuan survived longer and fired more often while its army changed from a draw
to a loss. Keep the [placement promotion gate](placement_research_promotion.md).

## What each module must teach

| Unit                | Playing it                                                                                                                                                                                                                                                                     | Playing against it                                                                                                                                                                                                                         | Setup decisions that belong in the same lesson                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tsar Cannon (39)    | Evaluate the entire Through Shot ray, including free-point aims, per-victim range divisors, friendly losses and shields. Preserve useful firing lanes and scarce shots; compare firing, waiting and relocating before contact.                                                 | Break valuable pierce alignments as units move; compare closing/engaging the Cannon, suppressing its rays and killing it before its activation. A normal melee retaliation assumption is wrong for Through Shot.                           | Cannon has four base shots and **No Melee**. Mechanism cannot be healed or resurrected, is mind/poison immune and has status vulnerability. Price ammunition, support and screen placement accordingly; a Healer is not a Cannon sustain plan.                                                   |
| Gargantuan (29)     | Compare targeted ranged shots with **empty-cell Area Throw**, full friendly/enemy splash and Double Throw. Preserve productive attack positions together with actual guards; do not automatically advance or seek a corner.                                                    | Remove useful splash clusters, exploit relevant elemental interactions and compare denying its next attack with chasing a smaller casualty. Test partial screening and access around its actual 2×2 body.                                  | Evaluate concentrated firepower versus split-stack activation/coverage, the complete quiver and fully funded combat stats versus Placement. Previous generic corner, spacing and paid-placement candidates did not qualify.                                                                      |
| Black Dragon (9)    | Choose the **approach and melee stand**, not merely the primary victim: Fire Breath has a direction, magical tail, friendly fire and fire-immune blockers. Compare a supported strike with an isolated dive, a setup move and waiting for allied timing.                       | Change the primary/behind-unit alignment; use an actually fire-immune blocking body when appropriate; preserve landing denial and overlapping physical pressure. Avoid wasting ordinary buffs/debuffs on active Enchanted Skin.            | Flight, eight printed movement and high initiative make setup and subsequent approach inseparable. Enchanted Skin also rejects friendly magic and can be disabled by Break; it is not an unconditional permanent target property.                                                                |
| Zena (50)           | Optimize the **actual clockwise Chakram trajectory**, including blockers, footprints, stack-powered target count, misses, terminal half-damage hops and shields. A high-value primary can beat more low-value victims.                                                         | Test touching formations, disconnected groups, bridges and later moves. A one-body move can create a relay even when the deployment was safe. Include Cannon and spell threats in the same opponent army.                                  | Rallying Volley grants allied shooters **+2 shots once**, without stacking across Zenas; it is not a repeatable ammunition source. Splitting changes bodies and Chakram power as well as activation count.                                                                                       |
| Wandering Mage (49) | Compare net-positive **Smoke** with immediate Fireball, Misfortune and Fireforged Sword. Track crossed friendly and enemy rays, duration, unit movement clearing smoke, prospective ally attacks and damage-spell friendly fire.                                               | Move to clear relevant smoked cells, seek unsuppressed attack rays and compare removing the Mage with pressing its carry. Spread for Fireball without handing Zena bounce links or Cannon lines.                                           | Each split gets its own full book, but smaller stack power can lock Smoke or Fireball and lower damage. Avoid both automatic maximum splitting and automatic concentration. Price Empower from realized, survivable casts and allied follow-up.                                                  |
| Magic Dragon (57)   | Schedule **Whirlpool, Lightning Strike, Ring of Fire and Meteor Shower** against the next dangerous activation, damage, reach, elemental immunity and friendly fire. Re-evaluate the book after casualties and compare a cast with a safe reposition or physical melee finish. | Threaten its first useful activation and stack-power thresholds; choose physical pressure, resistant/immune recipients and spell targets with Magic Reflection in mind. Denying one critical control cast can matter more than raw damage. | Native book: one Whirlpool, four Lightning Strikes, two Rings of Fire, one Meteor Shower. Minimum stack powers are respectively **3, 1, 4, 5**. Splitting gives independent books but does not preserve those thresholds or damage. Magic Reflection scales with remaining stack power and luck. |

These are mechanics and test objectives, not measured pick rankings or rules to hard-code into combat.
Use the engine's current projections and legality checks, including buffs, Break, absorption, resistances,
redirected damage, responses, terrain, rectangular footprints and cast charges. Magic Reflection still
allows the spell to land; do not treat it as magic immunity.

## Start from demonstrated failures

1. **Gargantuan / Zena / Cannon / Mage formation interaction.** The
   [Chakram study](a19_chakram_formation_research.md) reviewed all 29 fresh regressing armies. In one
   exact probe, Medusa's move from `(13,1)` to `(12,0)` changed a fixed prospective Zena shot from one
   victim to four. Other losses exposed a Cannon line or Fireball cluster, or put the guard on the
   opposite wing from the carry. The next formation candidate must evaluate plausible later movement
   and guard assignment, rather than repair only initial Chakram geometry.
2. **Gargantuan action ranking.** The
   [game-by-game audit](a19_game_by_game_loss_analysis.md) retained a useful Area Throw but selected
   an ordinary shot. Independent actual-controller continuations favored that throw in one old
   position (24/32 versus 11.5/32, passing that study's twenty-position correction). The relevant
   forecasts reached terminal states before H64; widening the horizon does not address that example.
   It is a candidate-ranking and sampling lesson, not permission for an always-throw rule.
3. **Magic Dragon activation and support targeting.** The same audit contains several losses where
   the dragon dies before casting, and an apparent early kill leaves the decisive approaching threat
   untouched. Restoring a single old buff target or attack did not reliably recover those losses.
   Learn the coordinated continuation, rather than a blanket first-target or keep-still rule.
4. **Black Dragon shortlist geometry.** Current code already provides the research-only
   `SEARCH_RESEARCH_FIRE_BREATH_VALUE` switch. It values the complete primary-plus-breath impact
   when ranking melee stands; the ordinary melee feature uses primary damage. Actual rollouts do
   resolve breath. Measure a possible cap/shortlist loss separately from final rollout ranking;
   do not describe this as the combat engine forgetting Fire Breath.
5. **Wandering Mage already has a Smoke role.** Native A19 promotes an engine-legal net-positive
   Smoke proposal unless a guaranteed kill or the finish window takes priority. New work must
   diagnose its remaining errors and timing, not rediscover a missing spell router that is already
   present.

## The first coverage audit

The ignored study is `game/core/tmp/analysis/six-unit-mastery-20261027` in the client repository.
Registrations, frozen source receipts, natural draft configurations, seed audits, per-condition
evidence and the separate preferred-pick exercises remain there.

The first metadata-only selection scanned **8,192 independent offer boards**, each in both draft
assignments. It required natural picks under the captured ranked A19 draft/setup profile and inspected
no combat outcomes. Of 108 requested target/map/budget/draft-assignment slots, it filled 72:

| Requested unit | Selected natural independent boards | Missing draft coverage                         |
| -------------- | ----------------------------------: | ---------------------------------------------- |
| Tsar Cannon    |                                  18 | None in the requested grid                     |
| Gargantuan     |                                   9 | All nine first/lower draft-assignment slots    |
| Black Dragon   |                                   0 | Both assignments on every requested map/budget |
| Zena           |                                   9 | All nine second/upper draft-assignment slots   |
| Wandering Mage |                                  18 | None in the requested grid                     |
| Magic Dragon   |                                  18 | None in the requested grid                     |

No Black Dragon appeared in either candidate assignment in this self-play scan. A second metadata-only
audit returned every original draft choice unchanged and reproduced all 16,384 assignment rosters.
Black Dragon was visible in **4,786 boards per assignment**, yet the policy never attempted to pick
it. Neither opponent assignment acquired it either, so these are not hidden-opponent collisions.
This is a concrete coverage problem for ordinary self-play training, not proof that the unit is weak
or should always be drafted. The scan samples one current-policy opponent and offer mechanism, not
human draft preferences or every training distribution. Repeated assignments are not 16,384
independent boards.

A separately registered extension prefers a target only when it is visible in a legal ranked offer.
It keeps the ordinary opponent draft and all subsequent setup/combat decisions. This filled 18 Black
Dragon exercise boards; it still could not fill the other Gargantuan/Zena assignments. The offer
audit explains why: lower-assignment Gargantuan was attempted but not acquired on 2,388 boards;
upper-assignment Zena was attempted but not acquired on 2,028. Hidden earlier enemy picks remain
visible until the collision reveals them. An available-looking offer and an omitted draft choice
are different cases; the ordinary opponent has already taken these units. Preferred-pick exercises
are deliberately distinct from natural-pick incidence or draft strength evidence.

### Completed observational fights

The 72 natural boards supplied 288 conditions and the 18 Black Dragon exercise boards another 72.
Each condition played with and without the observer: **720 completed fights on 90 independent
armies**, with identical initial state, searched roots, action ownership, root inputs, full action
trajectory, terminal result and final state in every pair. Both physical sides, Normal/Lava/Block,
and own budgets 5/6/7 are represented. All use ordinary enemy formations; the audit is not a
completed test of all opponent formations or unit pairings.

The observer recorded **17,743 actual turns**, checked **34,646 search-root restorations** and
**4,129 diagnostic-enumeration restorations**. Engine-controlled Berserker/Frenzied Boar turns
retain their ordinary bypass path; they are explicitly marked and have no invented search catalogue.
The first instrument incorrectly required a search record for those turns and stopped. Its source,
seals, partial output and failures are preserved under `attempt-v1`; all accepted conditions were
rerun with the corrected observer. Selection, policy and seeds did not change.

The table uses only the unit's own designated target-board conditions, rather than padding coverage
with incidental appearances elsewhere. Conditions within one army remain correlated.

| Unit           | Target conditions | Focal activations | Verified diagnostic question                                                                                                                                                                                           |
| -------------- | ----------------: | ----------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tsar Cannon    |                72 |               313 | It chose 188 ranged attacks. Eighteen pure moves had an attack available. Compare useful future lanes, ammunition and exposure before calling those moves mistakes.                                                    |
| Gargantuan     |                36 |               134 | Area Throw was available and represented in the shortlist on 112 turns, chosen on 57. The class is already present; evaluate exact target cells, sampling and the alternatives it displaces.                           |
| Black Dragon   |      72 exercises |               261 | On 228 turns with a captured catalogue, the best full-impact immediate melee stand was absent from production on 39 and absent from the shortlist on 63. This is not a continuation-value oracle.                      |
| Zena           |                36 |                95 | A ranged shot was available and shortlisted on 89 turns, chosen on 64. Its counterplay lesson must include subsequent movement and simultaneous Cannon/spell threats.                                                  |
| Wandering Mage |                72 |               342 | Smoke was available on 88 turns, shortlisted on 87 and cast on 24. Fireball was available/shortlisted on 84 and cast on 59. Smoke's remaining question is value and timing, not a generally missing spell family.      |
| Magic Dragon   |                72 |               221 | Whirlpool was available on 206 turns, shortlisted on 46 and cast on nine. Ring of Fire was available on 99, shortlisted on 52 and cast on nine. Test the discarded control/AOE alternatives in complete continuations. |

Eight of 72 Magic Dragon conditions lost the entire designated dragon stack before any activation.
Of the 64 conditions where it acted, 16 began at stack power three: Ring of Fire and Meteor Shower
were already below their required stack powers. These are concrete protection/activation cases,
not evidence that buying more Armor, changing the split or casting Whirlpool will win.

The local `review.html` contains 18 observed decision examples per unit, before/after boards,
native/final actions and capability counts. The examples diagnose questions; they are not teacher
advantage labels. The natural and preferred-pick banks remain separately identified.

### First intervention: Black Dragon's whole-breath ranking

Before opening intervention outcomes, register the existing whole-breath option as a single
development candidate on **all 18 Black Dragon exercise boards**. Keep all four conditions per
board, the fully funded setup and exact H64/R2/K6 profile. Change only the controlled Black Dragon's
immediate melee-stand features; retain the original native rollout policies and search budgets.

The matched pilot completed **144 fights**. Every fresh baseline replay reproduced its census
control exactly; every candidate retained the same setup. Results:

| Arm                  | Wins / draws / losses | Draw-aware score |
| -------------------- | --------------------- | ---------------: |
| Current A19          | 32 / 0 / 40           |         44.4444% |
| Whole-breath ranking | 32 / 0 / 40           |         44.4444% |

Paired gain **0.00 pp**, 95% map-stratified whole-board bootstrap interval **−2.7778 to +2.7778 pp**,
exact paired sign-flip p = **1**. One condition improved and one worsened; one board improved, one
worsened, sixteen tied. Independent Python and TypeScript calculations agree on the entire 20,000
resample distribution and exact sign-flip counts. This development pilot is not a fresh primary;
it supplies no basis to enable the switch or fund an automatic qualification run.

Both changed conditions were then replayed exactly with full decision observation:

- **Regression, board 13 / mirror 1 / stream 0, Normal.** At lap four the Dragon has **one HP**.
  Current A19 moves its anchor to `(3,4)`. Whole-breath ranking instead moves to `(4,4)` and attacks
  Battle Mage: the complete turn removes 432 enemy Mage HP and 223 enemy Troll HP, but also the
  Dragon's final HP. The escape move exists in both production catalogues. The new damage ordering
  **drops it from the shortlist**; the old search actually preferred that escape when it was retained.
  This is an identified lost option, not a missing attack mechanic. The selected full game changes
  from a win to a loss; repeated independent continuations have not established its expected regret.
- **Improvement, board 19 / mirror 1 / stream 1, Lava.** At lap two the Dragon has 121 HP.
  Current A19 waits. Whole-breath ranking admits a move-and-attack on Battle Mage that is absent
  from the old production catalogue. The complete turn removes 367 Mage HP and 291 Wandering Mage
  HP, while the Dragon loses 29 and survives. The selected full game changes from loss to win.
  This is a useful new candidate in that trajectory, not proof that all comparable attacks should
  replace waiting.

The actionable next hypothesis is **preserving useful action families while improving attack-angle
coverage**, including a defensive move and a high-value control cast. The pilot shows why filling
the shortlist with larger immediate attacks can erase a move the existing rollout would select.
Any revised rule needs its own registration and fresh army bank; these two cases cannot select and
qualify a low-HP exception.

Across the accepted census, pilot and two explanatory replays there are **866 verified full-game
executions**, **41,601 actual search-root restoration checks** and **4,158 diagnostic restoration
checks**. Replays do not add independent armies. All 591 frozen kernel inputs still match their
receipt; 590 match the current common checkout and the sole difference is the unrelated
`measure_first_contact_placement.ts` measurement tool. Existing profile/isolation, breath,
Through Shot and support-role checks pass: **40 tests, 1,970 assertions**. No strategy, dependency
pin, training campaign or deployment changed.

## Diagnose decisions without inventing labels

For each six-unit module, retain the native proposal, final actual A19 action, production catalogue,
shortlist, scored passes and a wider uncapped public catalogue. Attribute a tested better action to
one of three separate stages:

- **Missing:** not in the filtered production catalogue. Separate geometric caps from policy filters;
  absence alone is not an error.
- **Discarded:** generated but excluded from the shortlist. Check same-target delivery angles,
  empty-cell aims and spell/move families, not just whether a family appears once.
- **Evaluated/arbitrated:** retained, then loses under the sampled values or tie arbitration. Certified
  pruned means are not exact full-sample estimates. Record terminal completeness and uncertainty.

The existing [decision audit](a19_decision_audit.md) and
[actual-controller continuation tools](a19_actual_continuation_research.md) already provide the relevant
building blocks. Native-policy continuations are not recursively searched A19 labels. Where a putative
improvement depends on later counterplay, evaluate complete actual-controller continuations with
independent paired discovery/validation seeds. A one-seed recovered win, more immediate damage or an
omitted legal action cannot supply a reliable advantage label.

Counterplay includes **all allied units responding to the enemy key unit**, not only a duel between
the named units. Preserve guard, support, movement and target-priority decisions. The first census
records every actual turn and health transition; its detailed production/shortlist instrumentation is
limited to the six named actors. Other actors need rehydrated decision audits before classifying
their candidate-stage errors.

## Curriculum and qualification

Use three layers, retaining the information available when each decision is made:

1. **Mechanics exercises.** Deliberately construct paired beneficial/harmful cases: pierce and breath
   angles; Chakram gaps and blockers; split spellbook thresholds; Smoke affecting both sides;
   useful/expired control; elemental immunities and friendly fire. Include reversed seats, actual
   body shapes, obstacles and reflected deployments. Unit IDs may tag coverage; they are not new
   neural features or a reason to bypass general legal-action generation.
2. **Mixed-army skill exercises.** Study the six both with and against different support, caster,
   ranged and mobile melee compositions. Include the 36 directed key-unit pairings, including
   mirrors, and armies with multiple simultaneous threats. Rotate live maps, funded budgets,
   artifacts, synergy choices, split patterns and opponent formations. Exercise concentrations
   describe intended practice; they are not natural encounter frequencies or balance rankings.
3. **Fresh complete ranked games.** Evaluate the entire picks → artifact/augment → split → placement
   → combat procedure, including counter-picks and the opportunity cost of committing to a unit.
   Compare a fixed challenger with current behavior at matched search cost. Paid setup policies
   additionally require a matched optimized free control. Neither deliberately preferred picks nor
   a combat-only gain establish improved draft quality.

Keep a twelve-cell scorecard: **with / against each of the six**, plus overall full-game score,
rejected actions, work and live turn latency. Preserve distinct natural, forced-exercise, teacher,
development, primary and untouched-confirmation banks. Bootstrap independent offer/army boards;
mirrors, repeated seeds, actions and counterfactual continuations are correlated observations.

Register population, fixed rule, budgets, seed allocation, comparison family and stopping thresholds
before viewing intervention outcomes. Use broad 6,000+ game qualification as appropriate to the
existing tournament guidance, adjusted evidence for unit-specific claims and fresh held-out
confirmation. Do not let an aggregate win conceal a supported regression in one of these priority
modules, or rescue a failed rule with an outcome-selected unit/artifact/map exception.

The separately owned R8 teacher/student campaign remains untouched. This work supplies its owner
with concrete coverage requirements and diagnostic cases; it does not admit new labels, train a
model, or change its frozen source and evaluation banks.

## Completed control-spell follow-up

The [discarded Whirlpool study](a19_magic_dragon_control_research.md) completes 1,902 verified
full-game executions, including exact controls, explanations and a separate fresh precision batch.
It proves that all 59 tested Whirlpool targets alias to one immediate feature vector per position,
but establishes no positive general spell rule. The apparent +14.06 pp Manticore subgroup disappears
on 128 fresh paired streams; a Cyclops cast is measurably worse at its fixed root (−18.75 pp,
two-root adjusted interval [−30.86, −6.64]). All twelve positions are explained, including successful
freezes that preserve another shooter, an army blessing or a killable stack. The shipped policy
stays unchanged; future admission work must price the complete army trade and qualify on fresh
armies.
