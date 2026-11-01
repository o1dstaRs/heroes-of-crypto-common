# A19: paid Placement, split allocation and formation

Completed October 26, 2026. **The tested rules failed; no candidate is qualified or enabled.** This study tests the
user's hypothesis that a deployment upgrade must be evaluated together with how its space and
additional stack slots are used. Earlier negative paid-placement studies remain closed; they do not
prove that every joint setup is harmful.

The [preceding game-by-game study](a19_game_by_game_loss_analysis.md) diagnosed Gargantuan's target
selection at a fixed deployed position. It did not test whether a different purchased deployment and
split allocation avoids that position. In that original formation Gargantuan already occupies a rear
corner, while Pikeman is on the other flank and a one-creature Dryad is the closest screen. Better
protection is a separate hypothesis from choosing a better shot after deployment.

## Complete setups rather than a free protection bonus

The development family contains 180 complete setups: nine fully funded seven-point plans, four split
allocations and five formations. Placement has two paid upgrade levels, costing one or two points.
The family includes every way to pay those costs by reducing the incumbent Armor/Might/Sniper
levels. Movement and Empower remain zero. This is a declared bounded search, not every legal
six-axis plan or every arrangement of cells.

| Placement | Armor | Might | Sniper |
| --------: | ----: | ----: | -----: |
|         0 |     3 |     1 |      3 |
|         1 |     3 |     0 |      3 |
|         1 |     2 |     1 |      3 |
|         1 |     3 |     1 |      2 |
|         2 |     2 |     0 |      3 |
|         2 |     3 |     0 |      2 |
|         2 |     1 |     1 |      3 |
|         2 |     3 |     1 |      1 |
|         2 |     2 |     1 |      2 |

The split alternatives are no splits, the normal utility planner, a Gargantuan split allocated before
utility slots, and balanced ranged splits prioritized by creature level and starting stack HP. The
ordinary utility planner only splits small bodies; the authoritative engine also permits large
bodies to split. A split Gargantuan remains a full 2×2 body. Every new stack receives its own complete
spellbook and ammunition, while actual stack power continues to gate spells and abilities. Creature
supply is conserved, and each allocation uses only its purchased and synergy-provided stack slots.

The five formations are the current formation, either guarded corner, and either spaced corner.
Each plan starts from the original six drafted stacks, rebuilds its own splits, purchases before
deployment, and uses the actual legal zone. The normal tactical split-placement overlay runs once.
The board actually played must match the proposed complete formation. Guard adjacency is an opening
condition; the fight controller can move the guard later, so the analysis must inspect that behavior.

## Evidence and controls

The source is the admitted `9dde84d1` engine plus the synergy-list rollback repair, with all 591 source
input hashes frozen. Both armies use the captured `a19-material-r2-v1` H64/R2/K6 profile throughout
the full fight: complementary chance samples, material arbitration, certified bounds and the ordinary
native rollout controllers. These results retain that source/profile identity; this is not a new
production release or latency qualification.

Functional checks cover the original untouched/shadow trajectory, snapshot versus checkpoint
restoration, and all 180 setups on both physical mirrors of all 72 new matchups: **25,920 actual
engine openings**. A separate authoritative split check applies **465 successful split actions**
across the 180 setups and compares complete relevant unit stats, stack power, health, abilities,
spellbooks, quivers and real footprints against the materialized simulation. Capacity refusals are
intentional negative tests, separate from full-fight action rejection counts. These tests do not
qualify the server caller or runtime latency.

Development uses eight fresh actual-combat streams for all 180 setups on the known Gargantuan army:
1,440 full fights. This is one historical matchup, not 1,440 independent strength observations.
Select one setup per Placement level by its mean final score; ties prefer the incumbent, then the
frozen catalogue order. Lock those three complete policies before any new-army fight outcomes.

The independent primary used 72 independently indexed legal ranked offer boards, balanced across
the three ranked maps and opponent budgets 5/6/7. The unchanged draft policy must naturally produce
Gargantuan in the controlled seven-point army. Inspect both actual draft assignments before combat,
then retain one controlled army per board. Actual draft-seat coverage is reported, not inferred from
physical side: the upper draft seat picks level four first and can take Gargantuan before the lower
seat. Both physical battle mirrors remain mandatory.

Each board supplies two physical mirrors, two actual-combat seeds and three enemy formations
(current, its lateral reflection and spread). Four arms—current and the locked free/P1/P2
setups—produce **3,456 fresh full fights**. The opponent, artifacts, map, synergy rolls and actual
combat stream are matched within each comparison. All negative and unchanged cases remain.

The five planned comparisons test the free winner against current behavior, and each paid winner
against both current behavior and the optimized free winner. Confidence is clustered by independent
offer board; repeated seeds, mirrored sides and enemy formations are within-board conditions.
Report whole-board bootstrap intervals, five-comparison adjusted intervals and Holm-adjusted exact
sign-flip tests. A paid policy must gain at least five percentage points against both controls and
pass both adjusted statistical gates before funding fresh confirmation. Follow the existing
[placement promotion gate](placement_research_promotion.md); a primary pass alone never enables it.

Carry survival, early ranged attacks, realized damage, guard movement, lost combat stats and unused
split slots explain mechanisms. Final draw-aware full-game score decides whether the setup helps.
Map, threat, artifact or Nature-bonus slices remain descriptive; they cannot rescue a failed policy.

The ignored `game/core/tmp/analysis/gargantuan-placement-frontier-20261026` package retains the
registration, all 180 candidates, complete metadata scan, source/profile receipts, exact controls,
opening census, authoritative split verification, combat requests and raw results. Precombat
instrumentation corrections and an interrupted, unselected development attempt are preserved
separately; no partial attempt enters selection or the primary estimate.

## Completed generic-layout result

The incumbent scored **1/8** on the development combat streams; several alternative complete setups
scored **8/8**. Frozen selection picked unsplit/low-spaced at P0 and P1 (A3/M0/S3), and utility/low-spaced
at P2 (A2/M0/S3). Catalogue order settled small-sample ties. This does not prove that splitting is bad.

All 3,456 fresh fights completed. Current behavior scored 60.4167%, free 54.8611%, P1 55.1505% and
P2 49.2477%. These are scores against fixed paired opponents, not head-to-head rates among the four
variants. The five prespecified comparisons were:

| Comparison   |  Difference | Family-adjusted 99% whole-board interval | Holm exact p |
| ------------ | ----------: | ---------------------------------------: | -----------: |
| free-current |  -5.5556 pp |                   -11.3426 to +0.2894 pp |   0.13847443 |
| p1-current   |  -5.2662 pp |                   -11.3426 to +0.6944 pp |   0.13847443 |
| p1-free      |  +0.2894 pp |                    -3.7037 to +4.2824 pp |   0.88644088 |
| p2-current   | -11.1690 pp |                   -18.4028 to -4.1088 pp |   0.00354542 |
| p2-free      |  -5.6134 pp |                   -10.9375 to -0.2315 pp |   0.05262719 |

Neither paid policy qualifies against current behavior and the optimized free control. P2 has a
supported loss against current behavior. Every negative board, both RNG replicates and all enemy
formations remain. No descriptive subgroup rescues a rule. Independent Python/TypeScript checks
match all five complete sorted 20,000-resample bootstrap distributions, exact sign-flip counts and
Holm corrections.

## A genuinely closed wall: separate fresh pilot

This mechanism was registered before reading the generic primary outcomes. A free-zone rear corner
leaves an outer strip where small flyers can land. The new planner blocks actual neighboring landing
cells with friendly bodies, including ranged units and utility splits. It tries the rear anchor and
the next inward anchor, preserving the ordinary combat controller rather than forcing guards to stay.

The funded plans are P0/A3/M1/S3, P1/A3/M0/S3 and P2/A2/M0/S3, each with canonical utility splits under
its purchased capacity. The new bank has 36 independent legal offer boards, four per map/budget cell,
both physical mirrors, two combat streams per mirror/formation and three enemy formations: **1,728
full fights**. Another 864 opening checks, 18 full parity controls and 864 independent opponent-board
checks passed. Free walls leave 7 small-flyer landing cells; P1 averages 1.0556; P2 leaves **zero in
all 216 P2 opening conditions**. The actual board always matches its proposal.

The complete pilot rejected the implemented rules:

| Comparison   |  Difference | Family-adjusted 99% whole-board interval | Holm exact p |
| ------------ | ----------: | ---------------------------------------: | -----------: |
| free-current | -23.7269 pp |                  -32.5231 to -14.0046 pp | 0.0000238252 |
| p1-current   | -19.5602 pp |                  -26.5046 to -12.6157 pp | 0.0000213843 |
| p1-free      |  +4.1667 pp |                   -3.5885 to +12.3843 pp | 0.2316809222 |
| p2-current   | -31.2500 pp |                  -39.6991 to -22.4537 pp | 0.0000009846 |
| p2-free      |  -7.5231 pp |                   -16.6667 to +2.3154 pp | 0.1436513783 |

**Population correction:** the frozen filter excludes Area Throw, Large Caliber and canonical
ranged-damage spells. Calling it a no-splash or melee-only population was too broad: **35/36
matchups still contain Zena and 31/36 contain Tsar Cannon**. Chakram and Through Shot pass that
old two-ability filter. The results reject the actual tested predicate, not protection against a
properly isolated melee-only opponent. Keep the negative bank and its interpretation erratum; do
not rescue it with the one non-Zena board or fit a new exception on these outcomes.

An opening wall is not a lasting combat role. Gargantuan acts in 424 of P2's 432 fights; only
**123/424** still have a closed screen at its first actual turn. These repeated conditions are
not independent armies. Blockers can move or die, and piercing/bouncing attacks can hit important
units behind or beside them.

## Concrete replay findings

Historical stream 1 shows why the user's placement concern mattered. In the spaced low corner,
Gargantuan throws at (4,3), killing all 73 Centaurs **and both Tsar Cannons**. The old position's throw
at (4,5) kills only the Centaurs. The free setup wins. Another guarded formation gets the same early
double kill and still loses later, so the initial attack is not a complete formation objective.

Wall board 67, physical mirror 2, stream 1, reflected enemy formation gives a counterexample.
Current behavior wins in six laps; P2 wall loses in five. Gargantuan makes the same first ground throw,
with similar damage. The wall is still closed when it first acts. Tsar Cannon's first Through Shot
then hits **Trent, Elf, Cyclops, Gargantuan and two utility stacks**. Elf loses all 22 remaining
creatures and Cyclops falls from six to one. The current formation's shot instead hits lower-tier
Orc and Wandering Mage stacks. Keeping the carry alive does not compensate for losing the army's
other ranged output. This is an observed failure chain, not a causal decomposition of every setup
cost from one stream. An observer-only exact replay also rules out
first-throw range falloff as the cause in this case: both Gargantuans have attack 36.83, shot distance
8.5 and an actual divisor of two for that ground throw. Position alone is not a sufficient diagnosis.

Chakram needs a distinct geometric model. Touching footprints cannot be bounced to; one empty cell
permits full-damage relays; two empty cells halve the bounce and end the flight. An actual empty
bridge is required. Through Shot continues through enemy bodies on its ray. Generic spacing,
radial-splash classification and blocked melee landings therefore price different things. The
frozen, unqualified Chakram-dispersion helper still uses an older pair-distance objective; it must
not be reused as supervision for the current mechanic without a separate repair and validation.

## Decision

Keep current behavior. The main research banks completed **6,624 full fights**: 1,440 historical
training, 3,456 broad fresh comparisons and 1,728 separate wall-pilot comparisons. There are
**108 fresh independent offer boards**, not one army per seed, mirror or enemy formation. All
admitted fights have zero rejected actions. Functional controls and exact trajectory replays are
additional correctness work, excluded from strength intervals and candidate selection.

The joint-setup hypothesis remains useful; these fixed procedures failed. A future learner needs
multiple independent matchups and legally available opponent-kit features. Its objective must price
landing denial, Through Shot rays, exact Chakram bridges, splash, surviving ranged output, complete
split resources and actual guard movement. It needs untouched qualification against both current
behavior and an equally optimized free selector. A favorable old replay or post-hoc subgroup cannot
replace that comparison. No default strategy, balance, dependency pin or deployment changed.
