# One-point augment transfers: independent combat validation

Registered October 26, 2026, following the
[augment coverage census](a19_frontier_priorities.md). This is an isolated headroom diagnostic. There
is no new serving policy, setup default, package pin or deployment.

## Question

The captured ranked setup policy uses only two spending templates per budget and never buys Empower.
Does a fully funded one-point transfer have repeatable value on its actual ranked drafts, after
holding the existing formation and split plan fixed?

For each case, play the incumbent and every legal transfer among Armor, Might, Sniper, Empower and
Movement. Select the best terminal discovery result, with the incumbent winning ties. Test that
locked choice against the incumbent with independent actual combat randomness. This separates
repeatable value from selecting the luckiest counterfactual.

This selector sees discovery fight outcomes and therefore has information unavailable to a live AI.
Even a positive result establishes offline headroom only. A deployable selector needs its own fresh
strength and latency qualification. A negative result would cover these one-point neighbors, not
all multi-point, draft, artifact or formation combinations.

## Frozen engine and setup

Reuse the validated common `9dde84d148c494e6e6dbd9da06798f2a17bb0c1c` export plus the owned
synergy-array checkpoint repair. The production overlay remains only
`src/simulation/battle_snapshot.ts`; its complete source receipt is checked before and after each phase.
The engine has no new strategy instrumentation seam. Dedicated research workers temporarily wrap
the existing initial augment application and search entry point, then restore both methods.

All three captured server source files still match `a19-material-r2-v1`: H64, complementary R2,
shortlist six, the ordinary learned leaf, native continuation, material ties and certified tight
selection bounds. Ranked drafts use `ranked-unit-strength-a19-side-v4-w16-r4`; both setup policies
are `artifact-fit-v6:conditional-v1:sniper+t2a19`. These are captured source settings, not proof of
the currently deployed server binary.

Run the complete legal ranked pick sequence, rolled synergies and native tactical split planner.
Each worker independently reconstructs its draft configuration and checks it against the sealed
manifest before executing. Placement and split capacity stay at the incumbent's free setting.
After normal placement, change only differing fight-level augment entries immediately before the
ordinary single `applyAugments` call. Lower levels before raising them so every purchase fits its
doctrine budget. Keep artifacts, doctrine, supply, cells, synergies and the opposing plan unchanged.

Keep `config.seed` fixed across discovery and validation, preserving scattered Block stones, unit
identities, placement and search seeds. Replace only the actual combat RNG at `beforeFightStart`
with the separately registered phase seed; preserve its UUID counter. Plans within a phase share
the same actual combat stream. Actual outcomes can diverge naturally after different actions.

Search seeds and offer boards remain the same in validation: this tests repeatability under actual
combat luck, not new-army or new-search-seed generalization. Those belong to the later fresh selector
trials.

## Funding and gates

| Phase               | Independent offer boards |    Cases | Full fights |
| ------------------- | -----------------------: | -------: | ----------: |
| Functional controls |                        3 |       36 |          90 |
| Discovery           |                       27 |      324 |       2,592 |
| Validation          |                  Same 27 | Same 324 |         648 |

Each primary board contributes both draft seats, both physical battle sides and own budgets 5/6/7.
Opponent doctrines rotate so every map/own-budget/opponent-budget joint cell has twelve cases.
Normal, Lava and Block receive nine independent boards each. Doctrine visibility is implemented by
the ordinary ranked simulator. There are 54 distinct own drafted rosters; repeated budgets and seats
are not independent armies. The complete legal-draft audit finds native shooter counts from two to
five, with a configured direct-damage spell present in 210 of the 324 cases.

The sibling server's `ranked_ai_profile.ts` already defaults v0.8 to SEE_NONE, the seven-point
doctrine, following its earlier doctrine qualification. Five- and six-point own budgets here are
stress coverage, not the default v0.8 seat population. The pooled diagnostic cannot establish an
unconditional serving win-rate gain; a later live selector needs a fresh primary on the actual
seven-point population. A favorable seven-point slice cannot rescue a failed pooled diagnostic.

Discovery evaluates the incumbent and all neighbors once. The locked choice maximizes terminal
win/draw/loss score, then prefers incumbent, then canonical transfer order. No damage, material,
survival or lap tiebreak. Validation always runs both incumbent and selected plan, including exact
duplicate controls when selection retains the incumbent. No validation outcome can change selection.

The sole primary endpoint is mean validation paired score gain over the 27 offer boards, each with
twelve equally weighted cases. Require at least +2 percentage points, a positive lower 95% whole-board
bootstrap bound, exact board-level paired sign-flip p below .05, and non-incumbent selection on at
least twelve boards. Maps, budgets, teams and individual transfers are exploratory slices; none can
rescue a failed primary. JavaScript and independent standard-library Python implementations must
reproduce the entire sorted 20,000-resample stratified bootstrap distribution and both endpoints.

Any rejected/censored game, source drift, incomplete cell or restoration failure stops admission.
Every searched root checks complete battle values/reference graphs, unit identities/order, target
memory, statistics, active unit and RNG/UUID restoration. Run one four-worker pool with a 90-minute
primary budget. The contended Mac supplies no speed or production-latency qualification.

The external package at ignored `game/core/tmp/analysis/augment-transfer-headroom-20261026` retains
source/tool hashes, all jobs, per-request raw completions, draft metadata, controls and exact seed
allocation. Collision checks cover recorded local metadata, derived old cohort channels and named
reserved roots; they do not claim a complete inventory of other hosts' seed banks.

## Functional admission

All 288 preflight neighbor openings pass the setup checks. The 90 complete control games pass exact
plain/instrumented and checkpoint/full-snapshot comparisons, checking 4,276 real searched roots.
An independent verifier reconstructs seed allocation, legal neighbors, factor coverage, pairings and
all control hashes. A further check passes all 1,080 opening units' buff powers, stack amounts and
legal nonoverlapping cells. Zero actions were rejected and all control fights ended by elimination.

Retain three failed admission attempts. Two structural-only attempts failed before combat: an
overbroad clear/reapply step changed bookkeeping, and a checker incorrectly expected Sniper buffs on
non-ranged units. The initial 90-game control attempt then found one cold/warm worker UUID-sequence
mismatch, despite identical actions/results. Reconstructing the full draft outside the seeded fight
primes the lazy creature catalog and passes the repeated strict input gate. No primary outcome was
opened during these instrumentation corrections; the engine, candidate family, seeds and score gates
remained unchanged.

## Result

**Closed: the fixed single-discovery-fight selection procedure failed its validation gate.**

All **2,592 discovery fights and 648 validation fights** completed. Discovery appeared to improve
draw-aware score by **33.1790 percentage points**. Under independent actual combat randomness, the
locked choices improved only **1.2346 pp**, with a whole-board 95% interval of
**−2.1605 to +4.7840 pp** and exact paired sign-flip **p = .62890625**. Neither the +2 pp floor nor
the positive lower bound nor the p-value gate passes. Selection changed plans in 110 of 324 cases,
spanning all 27 boards, so lack of activation does not explain failure.

Validation score was 47.5309% for the incumbent and 48.7654% for the selected plans. There were
24 improved outcomes, twenty worsened outcomes and 280 unchanged outcomes. All 214 cases retaining
the incumbent reproduced its full validation behavior and root-input hashes exactly. Among the
110 changed plans, 66 retained the same outcome, 24 improved and twenty worsened.

| Exploratory map slice | Cases | Paired validation gain |
| --------------------- | ----: | ---------------------: |
| Normal                |   108 |             −4.6296 pp |
| Lava                  |   108 |             −1.3889 pp |
| Block                 |   108 |             +9.7222 pp |

The seven-point slice relevant to the source-default v0.8 doctrine was **−0.4630 pp** over 108
cases. Five points scored +5.5556 pp and six points −1.3889 pp. These are descriptive slices of a
failed primary. Neither Block nor a transfer family qualifies a conditional policy or another
validation bank. Each map also has its own nine offer boards; this is not a controlled estimate
of changing terrain on identical rosters.

The selected Armor-to-Movement slice improved ten cases and worsened four among thirty selected
cases. Armor-to-Empower improved seven and worsened nine among 38. They are outcome-selected,
overlapping exploratory populations, not evidence that a general Movement rule wins or Empower is
universally bad. No positive slice rescues the complete procedure.

## Why the discovery result was misleading

The complete opening values, reference graphs, identities, buffs and geometry match across phases
for every incumbent and selected plan. Nevertheless, the unchanged incumbent's terminal outcome
changes in **118/324 cases (36.42%)** when only actual combat randomness changes. This is a direct
measure of chance sensitivity on these fixed cases, not a new independent population estimate.
Choosing the best of seven to nine observed results per case strongly favors fortunate discoveries.
The apparent +33.18 pp did not survive the registered independent-seed check.

The discovery selector has one outcome per alternative, not knowledge of its expected win probability.
Its validation performance is therefore not a mathematical upper bound on the best possible setup
policy. Failure rejects this selection procedure; it does not prove that no one-point improvement
exists. A future selector needs expected-value evidence and fresh offer-board qualification, rather
than a rule copied from this bank's favorable results. The present procedure and its bank stay closed.

## Final verification and disposition

All **3,330 admitted full fights**, including ninety controls, ended by elimination with zero rejected
or censored games. They supplied **172,275 real searched-root restoration checks**. Independent
verification covered all 43,800 opening units in those fights. Source/tool hashes, factor cells,
legal funded neighbors, complete phase pairings, every discovery choice and all unchanged controls
passed. Independent JavaScript and Python calculations reproduce every integer in the sorted
20,000-resample bootstrap distribution, both interval endpoints and the exact p-value.

The snapshot repair was published as common `331c53ba43e0a23375d51198fd46de4b11ef923c` during collection;
the validated snapshot bytes are unchanged. This study retains its original sealed source identity
and does not absorb that commit's separate research modules or relabel older experiments.

No selector fit, seven-cohort strength extension, qualification, confirmation, timing qualification
or serving change follows this failed gate. No new strategy qualified. The positive R8 reference
and its cost/teacher work remain separate priorities. Generated evidence stays outside Git.

Following the subsequent request to analyze every regression and continue, the
[loss-mechanism follow-up](a19_augment_loss_mechanisms_research.md) preserves this closed verdict and
replays all twenty worsened and 24 improved cases. It separately registers a fixed seven-point
Might-to-Movement rule on untouched offer boards, keeping Armor and Sniper capped. That is a new
hypothesis and bank, not a second validation or subgroup rescue of this one-fight selection procedure.
