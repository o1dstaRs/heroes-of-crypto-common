# Revealed ranged army: draft and funded delivery screen

Status, November 17, 2026: **closed, failed exploratory screen; no default change.** The combined
candidate scored 40.740741% against the current default's 42.592593% on this deliberately enriched
population. Its −1.851852 percentage-point difference is inconclusive, not a demonstrated general
regression, and does not qualify an activation or confirmation. Preserve the positive component
estimates and the failed combination together.

## What the AI actually knows

The authoritative draft already passes `getKnownOpponentCreatures` through `rankedDraftContextForTeam`
in the server's `pick_decider.ts`. `pick_sim_adapter.ts` projects the acting seat's view, including
collision reveals. Scout (doctrine 1, six points) receives limited slot reveals; Spymaster (doctrine 2,
five points) receives all picks and the early map. Battle Trance (doctrine 3, seven points) can learn
units through collisions. Unrevealed identities are not evidence that an opponent lacks shooters,
casters, or anti-flight abilities.

Ranked currently sets `hideOpponentRosterDuringSetup: false`. At the upgrade stage the whole opposing
roster is therefore public, even when it was concealed during drafting. The existing ranged setup
head primarily protects an army with at least three own shooters; it is not a general offensive
delivery selector. Contextual drafting already contains movement, flyer and synergy interactions.
This investigation found a policy opportunity, not a missing reveal wire. Closing with a melee unit
can deny physical shots; it does not disable a mage's damage spells.

## Frozen candidate and controls

The baseline is common `b082155437c5030423feca8d06b4db40dd369221` with server
`93f456f060beb06c7929ef27bfd5f603893b8f5c`: adopted v11 terrain placement, locked V3/contextual draft,
and full A19 H64/R2/K6 with the accepted neural correction. Both physical seats use that baseline.
No locked model weights, serving helpers, or profile switches were edited.

The draft candidate permits one durable override, including collision retries, after three own picks.
It needs two revealed shooters/damage casters, or one revealed level-three/four threat. It can replace
only a grounded pure melee pick, preserving native ranged/spell carries and protection roles. A legal
alternative must either fly, with no known No Fly enemy, or actually increase the Chaos Movement
threshold. Intrinsic quality may fall by at most 5% of the native score scale; coherence by at most 0.1.
The ordinary contextual picker selects within the admissible pool. Its override budget is separate
from the existing V3 and contextual budgets.

At public Setup, the delivery selector requires at least two offensive melee types and no native
Placement or Movement purchase. It compares native placement, free forward placement, and funded
P0/M1, P0/M2, P1/M0, P1/M1. Armor, Might and relevant Empower are retained. Funding can reduce Sniper,
but retains at least level one when the army has shooters. It uses actual native splits and complete
caster spellbooks for each purchase, including the extra slots supplied by Placement.

Reach is projected through the real engine's fight-start updates, using only the accepted own setup,
public terrain and a fixed inert opponent. It includes fractional steps, Chaos/artifact bonuses,
rectangular bodies, flying, lava and vine traversal. The score counts reachable melee contact against
twelve fixed hypothetical backline cells, weighted by own stack experience. It never uses concealed
enemy deployment, augments, artifacts or future combat randomness. Whole one-creature carries such as
Black Dragon count; tiny utility children of larger stacks do not. A paid plan must improve this score
by at least 0.25 over the best cheaper plan. This is a reach proxy, not a survival or outcome model.

Five fixed arms separate native behavior, draft alone, setup alone, their combination, and the
combination's matched free-Placement control. That control retains Movement, refunds the Placement
point into the actual funded stats, and recomputes the native split/formation pipeline. Enemy setup
is fixed within a given draft, but can legally react when the draft changes.

## Selection, outcomes and decision

A purely unscored audit found 84 eligible drafts among 2,592 fresh native families. The original
432-family pool was extended using unused, already reserved preimages before registration or any
battle outcome. The screen selected the first three eligible families in each of nine map/own-doctrine
cells: 27 independent families, both seats, 270 logical comparisons and 167 distinct complete battle
inputs. This is a conditional opportunity screen, not an estimate of global strength or prevalence.

| Arm                    | Wins / losses |      Score | Difference versus native |
| ---------------------- | ------------: | ---------: | -----------------------: |
| Native default         |       23 / 31 | 42.592593% |                        — |
| Draft only             |       27 / 27 | 50.000000% |             +7.407407 pp |
| Setup only             |       28 / 26 | 51.851852% |             +9.259259 pp |
| Combined               |       22 / 32 | 40.740741% |             −1.851852 pp |
| Matched free Placement |       22 / 32 | 40.740741% |             −1.851852 pp |

There were no draws. Twenty thousand paired whole-family bootstrap resamples retain the nine strata
and average both physical seats. Bonferroni percentile intervals account for all five comparisons.

| Registered contrast     |   Difference |   Simultaneous 95% interval |
| ----------------------- | -----------: | --------------------------: |
| Combined − native       | −1.851852 pp | −16.666667 to +12.962963 pp |
| Combined − draft only   | −9.259259 pp |  −24.074074 to +3.703704 pp |
| Combined − matched free |  0.000000 pp |     0.000000 to 0.000000 pp |
| Draft only − native     | +7.407407 pp |  −9.259259 to +24.074074 pp |
| Setup only − native     | +9.259259 pp |  −5.555556 to +25.925926 pp |

The combined rule fails every strength gate. Its five-point-doctrine mean is −22.222222 pp;
six- and seven-point means are +5.555556 and +11.111111 pp. Each slice contains only nine families.
Neither positive component estimate has a positive adjusted lower bound. Do not select a subgroup,
extend this bank until significant, or promote either component from this exploratory result.

The setup selector changed 33 of 54 new-draft seats: Movement 2 in 29, Movement 1 in three, and
Placement 1 / Movement 1 in one. The other 21 retained native behavior. Seven seats had paid Placement
in total, but six were unchanged incumbent purchases; only one new purchase differed from the matched
free control. Equal outcomes provide almost no evidence about Placement's general value.

Nineteen families replaced Frenzied Boar with Black Dragon, three with Abomination, and five replaced
Trent with Troll. Nine replacements raised the actual Chaos Movement threshold; the nineteen Dragon
picks supplied flight (these counts can overlap). All nine seven-point families acted on collision
reveals. Compared with draft alone, adding the delivery setup lost ten seats and recovered five.
All ten regressions spent one or two Sniper levels on Movement while improving the geometric reach
proxy. This identifies an interaction worth investigating; it does not isolate the causal cost of
Sniper from formation, target selection, or melee exposure. Faster contact alone still fails to predict
the final result. A future distinct candidate should value damage and safe arrival jointly and must
use fresh reservations.

## Reproduction and handoff

The registration/result fixtures are `docs/evidence/revealed_ranged_delivery_registration_20261117.json`
and `docs/evidence/revealed_ranged_delivery_result_20261117.json`. They retain the exact original
registration text, all frozen runtime overlays, source seals, selected tasks, public proposals, seed
reservation recipe/preimages, individual outcome identities, all losing arms, and analysis scripts.
Raw openings, full events/turns/health ledgers and cold repeats remain outside Git in the client
repository's `game/core/tmp/revealed-ranged-delivery-20261117`.

The namespace `revealed-ranged-delivery-20261117-fresh-v1`, counters 1 through 20,480, reserves every
SHA-256 preimage (first four bytes, little endian), plus offsets 0..31 both raw and through
`permuteRankedDraftSeed`. Include unused/rejected scans: 1,310,511 unique channels. The allocator
consulted 215 prior ledgers. The second allocated evaluation future for each family remains reserved
and unscored. The 27-family bank is closed; no confirmation was opened.

All 167 distinct executions and fifteen cold fresh-process repeats passed. Independent verification
checked 5,587 source-file seals, all 270 scores/input keys, complete event/health/turn records,
both-team A19 activity, zero rejected actions or neural failures, native budgets/Armor/Might, and
exact cold replay equality. NumPy analysis and a separate Bun integer/bootstrap calculation agree.
Six before-outcome noninterference probes changed concealed opponent fields and future randomness
without changing own projected stats or reach. Execution used four local nice-10 workers and finished
well inside the fixed 25-minute cutoff. No cross-host strength confirmation or live deployment ran.
