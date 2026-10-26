# A19: the next measurable improvements

Reviewed October 26, 2026. Prioritize a better strength/cost tradeoff, with complete games as the
endpoint. The latest support research qualified no strategy; its synergy rollback repair remains local.
Keep historical results attached to their original engine and profile.

## What the evidence supports

| Direction                                        | Measured evidence                                                                                                                                               | Next useful measurement                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent R8                                   | 547 wins, 450 losses and 11 draws in 1,008 games: 54.81%, whole-board 95% interval 52.78–56.89%. The completed cost bank used 3.00× elapsed time and 2.83× CPU. | Exact R8 selection bounds, then strength and production latency on an admitted corrected source.                                              |
| Augment selection                                | The captured ranked policy has two spending branches per budget. It omits Empower and Movement, independent of the enemy roster or artifacts.                   | Measure whether affordable alternative plans have reproducible full-game value, then learn or specify one deployable selector.                |
| Learned decisions                                | A peer already owns the R8 teacher/student pipeline; its corrected teacher and data admission are prerequisites.                                                | Use the qualified teacher and actual trained export, with complete-game and production-CPU tests. Avoid a second competing training pipeline. |
| Support resource weights and midpoint refinement | Neither established a strength improvement. The activation-resource predictor was also worse than ordinary H16 search on both agreement and simulated turns.    | Close these routes. Do not fund another coefficient, horizon or threshold sweep from their failed banks.                                      |

R8 is the strongest observed strategic signal, not a released improvement. Its reference used the aura
repair and predates admission of the local synergy-list repair. See the
[R8 reference](a19_r8_reference_research.md), [student work](v0_9_a19_5090_research.md),
[closed midpoint rule](a19_selective_precision_research.md) and
[support results](ranked_replay_strategy_research.md).

## New measurement: augment coverage

A read-only census reuses the initial states of the 126 balanced cohort armies from the
[synergy repair validation](a19_synergy_rollback_research.md). It calls the captured server setup
`artifact-fit-v6:conditional-v1:sniper+t2a19` on the frozen corrected source, with public placement
context and own artifacts. It does not select armies using fight outcomes, evaluate alternative plans
or acquire new strength labels.

| Own budget | Reused armies | Plans actually chosen | All legal full-spend plans | Legal plans with Placement 0 | Placement-0 plans containing Empower |
| ---------- | ------------: | --------------------: | -------------------------: | ---------------------------: | -----------------------------------: |
| 5          |            42 |                     2 |                        186 |                           91 |                                   57 |
| 6          |            42 |                     2 |                        267 |                          115 |                                   81 |
| 7          |            42 |                     2 |                        330 |                          124 |                                   96 |

Every chosen plan has zero Empower, Movement and paid Placement. Forty-one armies contain at least
one creature whose configured kit has a ranged direct-damage spell; none receives Empower. This is a
conservative capability count, not an estimate of realized magic damage or Empower's marginal value.
Healing and control casters are not automatically damage beneficiaries.

The pre-existing `ranked-a19-caster-empower-v1` is a different experiment: it requires budget seven and
a direct magic carry plus a magic amplifier, buys Placement, and uses a different base setup. Five
census armies satisfy its roster predicate, but none has budget seven; it would not activate here.
Do not present this census as a retest or rejection of that policy.

The seven synthetic cohorts contribute eighteen armies each, across maps, seats and opponent
formations. They are not a sample of live ranked pick frequency. In particular, this census cannot
estimate an unconditional ranked win-rate uplift or the prevalence of missing Empower purchases.
More available plans do not imply better plans.

The ignored `game/core/tmp/analysis/frontier-opportunities-20261026` package contains the census,
source/input hashes and an independent Python reconstruction of legal plan counts, policy branches,
roster predicates and all 126 outputs. No fight outcome enters the census. The source byte check covers
every frozen engine input, including binary generated files.

## First new experiment to fund: setup value without a combat-search increase

This is a design for a separately registered study, not an opened strength bank or a locked candidate.

1. Use fresh legal ranked offer boards and the actual captured draft policy through the existing ranked
   simulator. Keep the fight controller at current H64/R2. Retain both draft seats and battle mirrors,
   all three ranked maps, doctrine budgets 5/6/7, rolled synergies, artifacts and native stack/split rules.
   Add the seven broad cohort populations as separate stress tests. Do not substitute synthetic
   `ranked-draft` cohort rosters for the legal ranked-offer primary population.
2. Start with Placement fixed at zero. Compare the incumbent with every legal one-point transfer among
   Armor, Might, Sniper, Empower and Movement; enumerate neighbors before combat without selecting a
   creature, map, artifact or favorable result. Account for the stat surrendered to fund every purchase.
   Use the incumbent's legal split plan and formation for this diagnostic. Keep all no-change and
   inapplicable armies. The historical paid-placement failures remain closed.
3. Separate discovery from validation combat seeds and retain the incumbent in every comparison. An
   apparent best plan chosen on discovery outcomes is an offline oracle, not a usable strategy. Test its
   direction on independent combat seeds and cluster uncertainty by offer board; retain negative results
   and correct for the declared comparison family. This diagnostic asks whether reproducible headroom
   exists, not whether a particular hand-written Empower rule wins.
4. Only reproducible headroom justifies fitting or specifying a selector. Give it only own setup and
   phase-public opponent information. Split development and validation by whole offer board. Lock one
   complete policy before fresh strength outcomes; do not dispatch hundreds of full plans during live play.
   Final strength trials must run the complete setup/split/placement pipeline, including any downstream
   changes induced by the selector.
5. Require at least 6,000 fresh complete qualification games, a draw-aware gain of at least two percentage
   points over 50%, a whole-board lower 95% bound above 50%, zero rejected actions, balanced map/seat
   and budget coverage, and no supported cohort regression after the declared correction. A pass needs
   unchanged fresh 6,000-game confirmation, reference-opponent checks and production setup latency.
   A failed primary cannot be rescued by a caster subgroup or a larger same-bank sweep.

Register the exact source, candidate family, diagnostic funding, seed exclusions and stopping rule
before executing this design. Previously closed or unopened reserved channels remain excluded. No
such trial ran as part of the coverage census.

## Parallel research priorities

Finish the exact R8 bounds cost experiment when resources allow: preserve complete action/event/result
parity and count simulated turns as well as reversed-order elapsed/CPU cost. Its interrupted runs have
no speed verdict. Saved deterministic work alone is not production latency qualification.

For every proposed improvement, report draw-aware strength, its whole-board interval, total CPU and
production p95/p99/maximum decision latency. Compare with both stock R2 and an appropriate work-matched
search reference. This distinguishes a stronger algorithm from spending more computation.

Use a fixed opponent panel for robustness after a primary pass: current R2, admitted R8 and contrasting
existing controllers, each on the same source and with fully specified profiles. Report the matrix and
worst supported regression, rather than treating a better result against one controller as universal
strength. This panel does not replace the untouched primary confirmation.

The most useful new branch is therefore an outcome-validated setup selector. The best existing positive
branch is R8 made affordable. Neither requires reopening the failed support-value heuristics.
