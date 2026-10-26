# Ranked replay strategy research

Status on 2026-10-26: **no new strategy qualified; rollback repair published; single-fight augment selector closed; distinct fixed-policy screen collecting**. The shared synergy-list repair passed 7,206 common tests, 284 exact replay checks and isolated ranked-server compatibility and is now published in common `331c53ba`. The interrupted support-R8 bank remains invalid and closed. A subsequent 3,240-fight augment diagnostic found +1.2346 pp under independent combat randomness, with a 95% whole-board interval of −2.1605 to +4.7840 pp; it failed its fixed gate. The unchanged incumbent changed outcomes across combat seeds in 36.42% of cases. A [separate loss-mechanism follow-up](a19_augment_loss_mechanisms_research.md) replays every regression and improvement, then tests a fixed Armor-preserving Movement purchase on untouched seven-point drafts. See the [repair report](a19_synergy_rollback_research.md) and [augment-transfer results](a19_augment_transfer_research.md). Historical experiments retain their original source identities; no strategy profile or serving default was changed by this research iteration.

**Baseline clarification:** preceding studies use their documented common-package or native-controller settings. References below to current R2 mean the sealed common R2 default, not the exact ranked-server configuration. Reading the server sources for experiment 12 exposed additional material-tie arbitration, certified/tight selection bounds, zero replay tie epsilon and disabled flyer-backline priorities. The new diagnostic installs and verifies those settings on every real A19 call. Keep earlier findings scoped to their recorded baselines; do not pool them with this server-profile study.

This work follows the latest ten test-server games between player and dNJk, finished October 20–22, 2026. The observed result was 6–4 to dNJk; excluding the round-1 quit leaves 6–3. Four games ended by elimination and six through an exit button. Treat the games as diagnostic examples, not causal win-rate evidence.

## Investigations

| Priority | Investigation                | Concrete examples                                                                                                                                                                                               | Deliverable                                                                                                                                                                                             |
| -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Formation and first contact  | 74a1646a: Fairy wiped in the opening, Medusa reached immediately. 5feb005b and fb170123: protected Lava shooters versus poorly coordinated assaults. 472d4ced: unsupported forward units and idle melee stacks. | Reproduce the own-army formation path; measure exposed carries, blocked approaches, time to useful attacks, synchronized arrival, and actual fight outcomes. Try one isolated free-formation candidate. |
| 2        | Artifact and purchase fit    | Quiver of Echoes selected without native shooters in 5feb005b and fb170123. Identical Sniper spending supported different numbers of shooters in 472d4ced.                                                      | Audit the active decision path, beneficiary counts, ammunition, and expected useful attacks. Add regressions before proposing a scoring change.                                                         |
| 3        | Spell trade evaluation       | da9c7a16: Fireball dealt 261 enemy HP damage and 295 friendly HP damage.                                                                                                                                        | Inspect legal candidate generation, shortlist retention, and final evaluation, including retaliation and future actions lost.                                                                           |
| 4        | Durable carries with support | Boar won four appearances; Berserker and Crown won the same three armies. In d38febe4, Boar was available while Thunderbird died in round 1 with no damage.                                                     | Matched draft/substitution experiments that preserve faction, setup, opponent, map, and combat seeds where possible.                                                                                    |
| 5        | Outcome labels               | 791ea660: almost immediate quit. 5fd0a85d: concession while the losing side retained major threats and had dealt more damage.                                                                                   | Separate elimination, concession, early quit, and board position at exit in research and learning data.                                                                                                 |

## Investigation 1: formation and first contact

### Scope

Start with current production A19, not an assumption that a human formation is the AI's formation. Reuse the common battle engine and existing cohort/army builders. Diagnose the replay armies on current rules and test a research-only formation adjustment against the same combat controller.

The first candidate must preserve roster, stack amounts, splits, artifacts, doctrine, augments, synergy choices, and deployment area. It may consume only own formation state, the public enemy roster, and the map. It must not inspect hidden enemy positions, augments, artifacts, or future actions.

Candidate work stays outside the production strategy factory and public game exports. A useful geometric change is not evidence of a stronger AI until full fights demonstrate it.

### Evidence to collect

- Exact current formation and proposed formation; complete legal footprints and no overlaps.
- Grounded shooter/damage-caster depth relative to own melee guards.
- First enemy contact with a carry, carry attacks/casts before contact, and early carry losses.
- Units with no useful attack/cast in the first two rounds, and movement/obstacle costs before contact.
- Group arrival timing, multiple stacks exposed to the same attack shape, and aura coverage.
- Final draw-aware score, rejected actions, termination reason, and cohort/side/map breakdowns.
- Whether any promising alternative was absent, removed during selection, or rejected by the scoring rule.

### Preregistered evaluation sequence

1. **Structural audit and smoke:** freeze source and seed allocation; confirm the candidate is legal and actually changes applicable formations. No outcome tuning.
2. **Primary comparison:** at least 6,000 fights, paired by army, map, side, opponent deployment, artifacts, augments, and combat seed. Use up to 12 workers on this machine. Count independent army pairs, not repeated seeds or mirrored seats, as the confidence unit.
3. **Coverage:** ranked-draft, uniform mixed, ranged-heavy, ground melee, flyer-heavy, caster/support, and cross-archetype cohorts; Normal, Lava, and Cemetery/Block; both physical sides; 5/6/7-point budgets; varied artifacts, synergies, and compact/spread/current opponent formations.
4. **Decision:** require a positive paired confidence interval on the prespecified applicable population and inspect cohort regressions. One candidate means no post-hoc selection among many variants. A changed candidate requires a fresh registration.
5. **Confirmation:** only a qualifying candidate proceeds to a separately seeded, fresh-army held-out comparison and authoritative server-path checks.
6. **Shipping:** no promotion from these ten replays, favorable examples, extra early attacks, or a positive subgroup alone.

Water is outside ranked; add it if a later change affects general non-ranked behavior. Full-search production qualification must be distinguished from cheaper heuristic diagnostic fights.

### Placement spending

This first investigation does not buy extra Placement. Earlier paid-placement and screen-repair experiments did not qualify for shipping. Preserve the existing [placement promotion gate](./placement_research_promotion.md). Any future paid plan must beat both current behavior and an equally optimized free formation, with lost combat stats and independent split spellbooks included.

## Current evidence and output

The initial read-only report is under the ignored game/core/tmp/analysis/player-dnjk-20261024 directory. It includes all ten match IDs, final draft choices and offers, complete replay provenance, and 56 checked formation snapshots. Generated replay exports, screenshots, simulation results, and reports remain outside tracked files.

The first candidate is not qualified for promotion. Its results and limitations are recorded below.

## First registered candidate: grounded carry depth swap v1

Research implementation: [first_contact_placement_research.ts](../src/simulation/first_contact_placement_research.ts). It is imported only by the research runner and its tests.

- Activate only when the public enemy roster contains a fast grounded melee threat.
- Consider grounded ranged units, damage casters, and non-melee mages with more than one creature; never treat an AI Driven unit as a controllable screen.
- Swap at most one carry/guard pair of identical footprint dimensions, in nearby lanes, if the carry is ahead of the guard.
- Keep exactly the same occupied cells and preserve existing own buff aura recipients, including own aura-range modifiers.
- Choose the largest retreat, then the least travel, using deterministic identity ties. No outcome-based tuning.

Frozen common baseline: 5edefcfbfcbeb44ed2e06ad9afb75f1befc7d856.

The geometry-only audit used seed 102520261 and 256 independent pairs in each of seven cohorts: 1,792 pairs and 32,256 formations across three maps, both sides, and three opponent deployments. It proposed 714 swaps (2.21% of formations). No combat outcomes were used for this audit.

### Registered screening run

- Seed 102520262, disjoint from the audit and held-out seed 102520263.
- 32 independent pairs per cohort: 224 army pairs.
- Each pair crosses three maps, both physical sides, three opponent deployments, and control/candidate: **8,064 complete fights**.
- Own and opponent budgets rotate through 5/6/7 points. Mixed ranged/caster/melee builds, fast melee opponent builds, contextual artifact stress, synergies, and tactical splits are held fixed between arms.
- First run uses A19's native heuristic controller with rollout search explicitly disabled. This is a broad diagnostic screen, **not production A19 qualification**.
- The primary diagnostic is the paired final draw-aware score, clustered by independent army pair and equally weighted across the seven cohorts. Applicable-position results and early-action measures are secondary. Seven cohort intervals use a conservative multiplicity adjustment.
- Reject or keep the candidate inconclusive if it fails to demonstrate a benefit. A favorable heuristic screen is insufficient to ship; it must proceed to full production-search comparisons, fresh-army confirmation, and server-path verification.
- Smoke runs use a separate seed and verify deterministic control/candidate parity when no geometry changes, legality, side symmetry, and valid completed actions.

This screening design intentionally buys no Placement and changes no other setup decision.

## Experiment 1 results

**Decision: inconclusive; keep the candidate outside the shipped AI.** No strategy factory, production profile, server pin, or deployment was changed.

### Geometry audit

The frozen audit found 714 proposed swaps in 32,256 formations (2.21%), spanning 1,792 army-seed clusters. The simple front/back inversion is uncommon in current A19 formations. This does not establish that the other formations are tactically safe: flyers, blocked approaches, and poor engagement timing require separate diagnostics.

### Broad paired screen

The 8,064-fight screen compared the native A19 heuristic controller with rollout search disabled. Each control/candidate pair shared its roster, map, combat seed, physical side, opponent deployment, artifacts, augments, synergies, and split plan.

- 224 independent army-seed clusters; 4,032 matched control/candidate conditions.
- Control score: **51.36%**. Candidate score: **51.23%**.
- Paired difference: **−0.14 percentage points**; approximate cluster-based 95% interval **−0.40 to +0.12 pp**.
- The rule changed 102 of the 4,032 conditions, covering only ten army-seed clusters. That applicable sample is small.
- Zero rejected actions. All 3,930 conditions with unchanged geometry reproduced the same result and lap count.
- On changed conditions, the candidate reduced mean net carry HP loss by round 2 by about 132 HP and added about 0.55 carry attack/cast actions before the first accepted melee attack targeting a carry. Those geometric/tactical measures did not establish a final score gain.

| Cohort          | Army-seed clusters | Fights | Changed conditions | Paired score difference |
| --------------- | -----------------: | -----: | -----------------: | ----------------------: |
| Ranked draft    |                 32 |  1,152 |                  6 |                +0.09 pp |
| Uniform mixed   |                 32 |  1,152 |                  9 |                 0.00 pp |
| Ranged-heavy    |                 32 |  1,152 |                  9 |                 0.00 pp |
| Ground melee    |                 32 |  1,152 |                 36 |                +0.17 pp |
| Flyer-heavy     |                 32 |  1,152 |                 12 |                −0.17 pp |
| Caster/support  |                 32 |  1,152 |                 30 |                −1.04 pp |
| Cross-archetype |                 32 |  1,152 |                  0 |                 0.00 pp |

These are descriptive subgroup estimates, not qualified dispatch rules. No subgroup's adjusted interval established a positive benefit. A zero observed difference in a sparse or inactive subgroup is not proof of equivalence.

One diagnostic case illustrates the objective mismatch. In caster/support pair 2 on Normal, red side against the current formation, the swap moved Wandering Mage behind Blacksmith. The first accepted melee attack targeting a carry moved from round 1 to round 4, and early net carry HP loss fell from 930 to zero. The heuristic-controlled army nevertheless changed from a win to a loss. Protecting an individual stack is not a sufficient placement objective.

### Full A19 search diagnostics

A separate **90-fight diagnostic check** used full A19 rollout search with deterministic offline work. It covered 45 matched conditions: 24 geometry-changing conditions and 21 unchanged parity conditions, including all seven cohorts, all three ranked maps, both sides, rotated opponent deployments, and the three budget levels.

Among the 24 changed conditions, six outcomes improved, two worsened, and sixteen stayed the same. There were zero rejected actions and zero unchanged-case parity mismatches. Only nine army-seed clusters contained a swap. The uncertainty still spans no benefit.

This is a small, geometry-selected diagnostic reuse of the screening armies, **not a fresh confirmation set, population win-rate estimate, or production qualification**. Its more favorable direction than the heuristic screen is a reason to separate the controllers in future research, not to promote this candidate.

### Measurement correction and reproducibility

The first contact timer incorrectly relied on visual attack events omitted in headless mode. It was corrected to read accepted melee actions, with both a focused regression and a real headless-fight regression.

All 8,064 screening fights were then rerun. Every outcome, placement, lap count, and rejection count reproduced exactly. The rerun is a reproducibility check, not 8,064 additional independent fights. Full-search diagnostics use the corrected instrumentation.

The contact metric means an accepted melee action targeting a carry; it does not measure every adjacent enemy, pin, retaliation, or blocked shot. The HP metric is net HP lost by the end of round 2, including healing effects.

Frozen source:

- Common baseline: 5edefcfbfcbeb44ed2e06ad9afb75f1befc7d856.
- Original source SHA-256: 216ff77b972481cf8bddeaa74f2ba4a02432496dc6ac8f7682195a89ce5bad04.
- Corrected instrumentation source SHA-256: 9a67f476c064bbb484734652e32f0bfda1d838edb8ff0b5a485e352a6f3335bd.
- The candidate implementation's bytes were identical across the correction.
- Final screening data SHA-256: b76c2b57f30214142621e3fe0c562cae484a3f3354679d876d8d46530ee38dfe.

Raw results, the frozen exports, independent recomputation, source receipts, and build logs remain under the ignored game/core/tmp/analysis/first-contact-20261025 directory. The live game API and default battle engine are guarded against importing either research module by placement_research_isolation.test.ts.

Reproduce the screen from the client repository root, using the recorded source for exact historical reproduction:

```bash
bun --cwd game/heroes-of-crypto-common src/simulation/measure_first_contact_placement.ts \
  --mode heuristic --pairs 32 --seed 102520262 --workers 12 \
  --output ../core/tmp/analysis/first-contact-20261025/reproduced-screen.json
```

### What to try next within investigation 1

Do not enable the simple depth-swap rule. A further experiment should evaluate coordinated engagement and useful attacks, including the cost of advancing the guard and changing support-spell reach. Diagnose the unchanged formations for blocked paths, pins without direct attacks, and units reaching the fight at different times.

If this exact candidate is revisited because of the full-search diagnostic signal, preregister a much larger **fresh-army full-search** comparison on its legally selectable population. Do not qualify it using the reused diagnostic cases or the favorable Lava/ground-melee slices.

The present study does not exhaust all artifact combinations, all nine own/opponent budget pairings, other opponent AI versions, or authoritative server runtime behavior. Those remain required before a behavioral promotion.

### Verification

The final common build passed all 7,174 tests and TypeScript compilation. The common lint gate passed. Coverage includes headless contact instrumentation, deterministic changed-case execution, both side orientations, rectangular footprints, aura retention, deployment legality, full budget accounting, and isolation from the public game API and production strategy.

## Second registered candidate: blocked melee lateral egress v1

Hypothesis: friendly congestion at deployment delays useful melee attacks and spreads the army's arrival. Opening a route with one small sideways move may improve engagement without advancing an isolated unit or buying more Placement.

Research implementation: [blocked_approach_placement_research.ts](../src/simulation/blocked_approach_placement_research.ts), selected explicitly through the existing first-contact runner. The first candidate and its default invocation remain available separately; they are never combined.

### Rule registered before combat outcomes

- Require at least two controllable native grounded walking melee stacks with more than one creature. Exclude flyers, teleporters, AI Driven units, native shooters, and spellbook/mage carries from the moved role.
- Reconstruct terrain from the map's center geometry and own deployment barrels. Do not read enemy positions, aggression, hidden barrels, or the occupancy-derived matrix. In particular, a unit standing on Lava must not erase that terrain from the probe.
- Use the engine's footprint-aware pathfinder with own movement budget, ordinary diagonal costs, no enemy aggression, and all other own bodies held stationary. Measure maximum forward progress in one opening move, compared with the same terrain without friendly bodies.
- A stack is congested if friendly bodies remove at least one cell of forward progress. Consider moving only that stack sideways by one or two cells, at exactly the same depth, within the existing legal deployment area.
- Preserve every current own buff aura recipient. Require at least one cell of forward-reach improvement for the moved stack and no decrease for any other eligible walking melee stack. Preserve roster, amounts, splits, artifacts, doctrines, augments, and synergies.
- Choose the largest reach gain, then shortest sideways displacement, then creature-name/native-order ties and fixed negative/positive lateral order. Make at most one move. Do not tune using fight outcomes.

Static opening congestion is a diagnostic approximation: allies may move before the congested stack, and a longer reachable route need not improve the chosen combat action. The combat comparison, rather than this proxy, decides whether the rule helps.

### Registered evaluation

- Common baseline: 5edefcfbfcbeb44ed2e06ad9afb75f1befc7d856; freeze all source before measurement.
- Smoke seed 102520270, geometry audit seed 102520271, primary screen seed 102520272, fresh-army full-search diagnostic seed 102520273, reserved confirmation seed 102520274. These are separate from experiment 1.
- Geometry audit: 64 independent pairs per cohort, all seven cohorts, three maps, both sides, and current/compact/spread opponents: 8,064 formations, zero combat outcomes. Geometry may be inspected to verify applicability; no candidate tuning after this audit.
- Primary screen: 64 independent pairs per cohort (448 army-seed clusters), crossing three maps, both sides, three opponent formations, and both arms: **16,128 fights**. Native A19 heuristic combat with rollout search disabled is a diagnostic screen, not production qualification.
- This experiment rotates through **all nine own/opponent 5/6/7 budget combinations** across pair indices. Both arms share each setup and combat seed, including the same contextual-artifact stress sampler, synergies, and independent tactical split spellbooks. Buy no Placement.
- Primary estimand: paired final draw-aware score averaged within each army-seed cluster on the prespecified applicable population (clusters with at least one geometry change). Report its approximate 95% cluster interval, the overall population estimate, and seven conservatively adjusted cohort intervals. Require at least 30 applicable clusters before interpreting an interval as qualification evidence.
- Secondary engagement measures: accepted own melee attacks by round 2, eligible melee stacks without such an attack by round 2, and summed first-melee-attack delay capped at round 3. Retain carry protection, early movement/obstacle actions, rejections, terminations, and unchanged-case parity diagnostics. Accepted spell/attack actions do not necessarily deal damage; these measures cannot substitute for final score.
- Full A19 diagnostics use fresh seed 102520273. Audit 64 pairs per cohort without combat, then deterministically choose at most one changed condition per cohort/map/side (opponent formation rotated by a fixed index), plus one unchanged condition per cohort/map (side alternating). This is at most 126 fights. Select using geometry only, before reading any outcomes. This sparse selection is diagnostic and cannot qualify a dispatch rule.
- A promising candidate still requires a much larger fresh-army full-search comparison, a separate held-out confirmation, cohort/side/map checks, and authoritative server-path verification before promotion. Negative or inconclusive evidence leaves the candidate isolated. Do not select a favorable cohort or map after seeing results.

The old depth-swap result remains inconclusive. Experiment 2 tests a separate mechanism and does not count experiment 1's repeated outcomes as new evidence.

### Implementation validation correction: v1 is excluded

An independent check of all actual final formations caught a placement-order interaction after the first v1 screen. The engine applies its ordinary tactical split-placement pass after the strategy's formation. In 90 of 1,356 proposed changes, that pass also moved one or two single-creature companions. The v1 probe had measured the pre-split formation rather than the final current formation. It therefore did not enforce the registered one-unit and aura/route conditions on the actual final board.

The completed 16,128-fight v1 attempt and its 504 smoke fights are retained for debugging, **excluded from valid hypothesis evidence**, and not pooled with the corrected experiment. The v1 full-search diagnostic attempt was stopped before collecting a completed result. The negative/no-clear-gain aggregate seen before the validation failure is not used to tune a favorable subgroup.

### Corrected registration: blocked melee lateral egress v2

The mechanism, displacement limits, aura/route requirements, cohorts, budgets, estimands, and sample sizes above remain fixed. The correction uses only own tactical split roles:

1. Compute the current **final** formation with exactly the same single tactical split-placement pass as the engine.
2. Diagnose congestion and evaluate sideways proposals on that final board, including every support and bait footprint.
3. Translate the main-stack move back to the strategy's raw formation. Simulate the engine's normal split pass and decline any proposal unless its final result equals the proposed one-unit change exactly. Do not apply the split pass twice or alter the normal control path.
4. Assert the expected complete final board against the actual engine board before starting every audit or fight. A mismatch fails the run immediately.

Regression coverage includes the discovered Goblin Knight / single-Blacksmith companion case (ranked-draft pair 21, first v1 screen seed, Normal, green), alongside unchanged original-control behavior.

Version 2 uses entirely fresh army seeds, registered before reading its outcomes: smoke **102520280**, geometry audit **102520281**, primary screen **102520282**, fresh full-search diagnostics **102520283**, reserved held-out confirmation **102520284**. Audit and primary still use 64 pairs per cohort: 8,064 zero-combat audit formations and **16,128 paired-arm fights**, respectively. The primary includes all nine budget pairings.

Select fresh full-search diagnostic conditions using geometry alone. In fixed cohort/map/side order choose one changed condition, rotate formation by `(cohortIndex + 2 * mapIndex + sideIndex) % 3`, prefer unused army clusters, and wrap pair order from `(7 * cohortIndex + 2 * mapIndex + sideIndex) % 64`. Add one unchanged condition per cohort/map, alternating sides and similarly preferring unused clusters. This remains at most 126 diagnostic fights and cannot establish production qualification. No favorable outcome selection, maps, or cohort exceptions are permitted.

## Experiment 2 results

**Decision: inconclusive; do not promote the lateral-egress candidate.** A slightly clearer opening route did not establish a reliable final-score gain. The corrected v2 experiment is separate from the invalid v1 attempt and from experiment 1.

### Corrected geometry audit

The geometry-only audit examined 8,064 formations across 448 independent army-seed clusters. It proposed 1,401 valid single-unit changes (17.37%). The probe measured the final normal formation, including tactical split companions, and verified that the engine's post-placement pass would retain every other anchor.

This is an opening-route proxy with friendly bodies held stationary. It cannot tell whether an ally will move first, which enemy lane matters, or whether advancing farther is tactically useful.

### Corrected broad paired screen

The registered v2 screen completed **16,128 fights**: 448 independent army-seed clusters and 8,064 matched conditions. Every cohort crossed all three ranked maps, both physical sides, three opponent formations, and all nine own/opponent 5/6/7-point budget combinations.

- Control draw-aware score: **50.58%**. Candidate score: **50.75%**.
- Overall paired difference: **+0.17 percentage points**, approximate cluster-based 95% interval **−0.18 to +0.51 pp**.
- The rule changed 1,572 conditions (19.49%), spanning 149 independent applicable clusters.
- Prespecified applicable-cluster difference: **+0.50 pp**, approximate 95% interval **−1.59 to +2.59 pp**. An independent 10,000-resample cluster bootstrap also spans zero: **−1.59 to +2.56 pp**.
- Of the changed conditions, 117 improved, 102 worsened, and 1,353 kept the same draw-aware outcome.
- All 6,492 unchanged conditions reproduced outcome, lap count, rejections, and recorded engagement measures exactly.
- Zero rejected actions; every fight ended through elimination.

| Cohort          | Army-seed clusters | Fights | Changed conditions | Score difference | Adjusted 95% interval |
| --------------- | -----------------: | -----: | -----------------: | ---------------: | --------------------: |
| Ranked draft    |                 64 |  2,304 |                399 |         −0.04 pp |     −1.33 to +1.24 pp |
| Uniform mixed   |                 64 |  2,304 |                135 |         +0.13 pp |     −1.02 to +1.28 pp |
| Ranged-heavy    |                 64 |  2,304 |                 78 |         +0.09 pp |     −0.88 to +1.06 pp |
| Ground melee    |                 64 |  2,304 |                351 |         +0.39 pp |     −1.36 to +2.14 pp |
| Flyer-heavy     |                 64 |  2,304 |                 84 |         −0.39 pp |     −1.49 to +0.71 pp |
| Caster/support  |                 64 |  2,304 |                369 |         +1.17 pp |     −0.37 to +2.71 pp |
| Cross-archetype |                 64 |  2,304 |                156 |         −0.17 pp |     −0.77 to +0.42 pp |

Intervals adjust conservatively across the seven cohort comparisons. No cohort demonstrated a supported improvement. Map, side, and opponent-formation intervals also span zero; the descriptive slices do not qualify dispatch rules.

### Engagement diagnosis

On changed heuristic-controlled conditions, early accepted ground-melee attacks increased by about **0.08 per fight**, and the summed first-melee-attack delay, capped at round 3, fell by **0.09 rounds per fight**. For the moved stack itself, the capped timing improved in 195 conditions, worsened in 99, and stayed the same in 1,278. Thus better static forward reach rarely changed its early attack timing.

More early attacks still did not reliably imply a better result: 18 changed conditions had more ground-melee attacks by round 2 and a worse final score. For example, ranked-draft pair 25 on Block, green side against spread opponents, moved Pikeman sideways from (1,6) to (1,7). Pikeman's first accepted melee attack moved from round 3 to round 1, while Hydra went from a round-2 melee attack to no accepted melee attack during the fight. The army changed from a win to a loss. This is a diagnostic example, not proof that the Pikeman move caused a particular downstream death or support failure.

### Fresh full A19 search diagnostics

The geometry-selected check completed **126 fights** on fresh seed 102520283: 63 matched conditions across 60 army-seed clusters. It covered all seven cohorts, all ranked maps, both sides, all three opponent formations, and all nine budget pairings.

- 42 changed conditions across 39 applicable clusters; 21 unchanged parity conditions.
- Nine changed outcomes improved, nine worsened, and 24 stayed the same.
- The approximate applicable-cluster interval is **−17.76 to +16.48 pp**; it does not establish a gain.
- All unchanged cases reproduced. Zero rejected actions, complete legal final footprints, and elimination in every fight.
- The small heuristic engagement improvement did not consistently carry over: changed conditions averaged 0.14 fewer early ground-melee attacks and 0.24 more capped delay rounds under full search.

These are sparse, geometry-selected diagnostics, not a population estimate or held-out production qualification. They neither establish a beneficial subgroup nor justify changing the shipped strategy. Full A19 uses deterministic offline search work here; authoritative server timing remains outside this experiment.

### Reproducibility and verification

Independent validation reconstructed every paired outcome, cluster interval, engagement counter, final one-unit change, unchanged-case comparison, and budget/cohort cell. A separate footprint validator expanded all 103,068 stack records in the primary screen and all 810 in the full-search diagnostics using the native catalog dimensions and actual legal deployment zones. Every complete footprint was legal and non-overlapping.

Frozen v2 source:

- Common baseline: 5edefcfbfcbeb44ed2e06ad9afb75f1befc7d856.
- Source SHA-256: 041d4d63626301d74238536be4c868325db5bce64b387491209feca565549874.
- Primary records SHA-256: ba5521cc13071e953b5716e0d652e0fcbd507492649f8d9c6bd0185f6db4f3f4.
- Full-search diagnostic records SHA-256: d23ea87f027570fda7ad0b367dc2c4fabe02f5c724d5c7be724c54455723ed33.
- The v2 smoke run completed another 504 fights with no rejected actions or placement/parity mismatches. Smoke results are not included in the primary estimate.
- Reserved confirmation seed 102520284 was not used, because no candidate qualified for confirmation.

Raw records, immutable source exports, registration snapshots, geometry-only diagnostic selection, independent validation, and logs remain untracked under game/core/tmp/analysis/blocked-approach-20261025. The invalid v1 attempt is explicitly labeled and excluded. The isolation regression also guards the new helper against imports through the public game API or default battle engine.

The final common build passed **7,199 tests**, with zero failures, and completed TypeScript compilation. The full common lint gate passed. Focused regressions cover split-pass side effects, deterministic changed-case execution, hidden-deployment invariance, actual rectangular footprints, both placement axes and physical sides, aura retention, route congestion versus terrain obstruction, complete budget accounting, and research isolation. The measured research source bytes and immutable export hash were rechecked after the build.

To reproduce the primary run from the client repository root using its saved source export:

```bash
bun --cwd game/core/tmp/analysis/blocked-approach-20261025/frozen-common-v2 \
  src/simulation/measure_first_contact_placement.ts \
  --candidate blocked-melee-lateral-egress-v2 --mode heuristic \
  --pairs 64 --seed 102520282 --workers 12 --output ../reproduced-v2.json
```

### Next queued hypothesis

Proceed to **investigation 2: artifact and purchase fit**. Audit the currently selected setup path and count actual beneficiaries, remaining ammunition, and expected useful attacks/casts before changing scores. Revisit the replay's Quiver-without-native-shooters choices and Sniper spending first. Compare any resulting candidate on fresh armies against the complete existing setup plan, with full opportunity costs, tactical split spellbooks, and all nine budget pairings. Do not convert either inconclusive placement result into a shipped exception.

## Failure investigation and third registered candidate

The user requested deeper investigation, revisions, and fresh reruns after experiment 2. Treat its aggregate as inconclusive, not evidence that the general idea is good or bad. Revisions must address a measured mechanism and succeed on new armies; removing historical losing cases is not confirmation.

### Historical diagnosis

The diagnosis replayed **66 fights**: both arms of all 18 outcome-changing full-A19 conditions, both directions of heuristic flips in every cohort, and the Pikeman/Hydra failure example. It captured committed decisions, the native incumbent, the final search choice, spell usage, positions, buffs, and net health changes. Every historical outcome, placement, lap count, rejection count, and existing engagement counter reproduced exactly. These outcome-selected cases are learning data, not new win-rate evidence.

A separate zero-combat audit recovered opening-route information for 2,688 unique cohort/pair/map/side conditions from the old primary study. All corresponding geometry and setups reproduced. The remaining opponent-formation variants share that own-army/public-map geometry.

The clearest finding is **not a missing Mass Riot candidate**. In all four Ogre Mage full-search regressions, the native strategy already proposed Mass Riot on round 1. Under the changed formation, search replaced it with a single-target Riot, then cast Mass Riot in round 2. Under the normal formation, it kept Mass Riot in round 1. This locates the observed decision change in search arbitration rather than native candidate generation. It does not yet prove that the override was wrong on the changed board: position and spell choice changed together. A fixed-board, first-action counterfactual is required. The traces do not yet distinguish horizon bias, leaf-value error, and sampling variance, so no live search fix is claimed.

Other examples show why maximum initial forward reach is weak: a moved Mermaid spent round 1 attacking a mountain instead of the control's melee attack; Troll switched from Wild Regeneration to movement or obstacle attack; White Tiger's move changed its engagement lane. All nine full-search regressions already had at least one cell of theoretical forward progress before the intervention.

The larger heuristic data is mixed and prevents an identity-based shortcut: Ogre Mage moves had both wins and losses. Losing a simple geometric carry-screen relationship did not predict losses in that sample either. Do not exempt particular creatures or select a favorable cohort from these observations.

### Third candidate: trapped melee rescue v1

Candidate ID: **trapped-melee-rescue-v1**. It reuses the split-aware implementation and runner, keeping broad v2 available as an explicit reference arm.

- Keep all v2 legality, aura-recipient, unchanged-depth, single-unit, two-cell lateral limit, other-melee-route, and final split-pass checks.
- Intervene only if friendly congestion leaves the moved stack with **zero forward progress** in its current movement budget, while the same public terrain without allies permits forward movement.
- Preserve native spellbook units' positions. Determine this from the own creature's native catalog metadata, rather than a name list or hidden enemy state.
- Keep at least two eligible walking melee stacks and the existing deterministic gain/travel/tie order. Change no roster, split, spellbook, artifact, doctrine, augment, or synergy decision.

This deliberately tests a more specific mechanism, rather than choosing the best historical score slice. The old heuristic zero-progress slice itself was not positive: 186 changed conditions in 22 army-seed clusters had 15 improvements and 19 regressions, with a −2.15 pp applicable-cluster estimate. Fresh testing is necessary. Native spellbook exclusion and a narrower trigger do not make the policy safe or stronger by themselves.

### Registration before new outcomes

- Freeze committed common baseline **3806a0d60a512dfc981c9bec65f36b17d87ba0cd** plus only the research files. Other agents' in-progress work is excluded from the source export.
- Seeds: smoke **102520290**, zero-combat audit **102520291**, primary **102520292**, fresh full-search diagnostics **102520293**, reserved confirmation **102520294**. All are disjoint from the earlier studies and historical diagnosis.
- **Three matched arms:** current A19 formation, broad lateral-egress v2, and trapped rescue v1. Combat controller, armies, split spellbooks, public-roster information, artifacts, synergies, and all spending stay matched.
- Primary uses **128 independent pairs per cohort**, seven cohorts, three ranked maps, both sides, three opponent formations, and three arms: **48,384 actual fights**, representing 896 army-seed clusters and 16,128 matched conditions. The shared current-A19 control runs once per condition, not twice.
- Native A19 heuristic combat with rollout search disabled is the broad diagnostic screen. Current A19 versus trapped rescue is the primary comparison, including the prespecified applicable-cluster interval and the overall population interval. Require at least 30 applicable clusters before treating the estimate as a useful qualification screen. Broad v2 versus rescue is a secondary comparison of the cost of suppressing or changing the older proposals; report it without using it to select another rule.
- Reuse all nine own/opponent budget pairings and the seven earlier cohort families. Report maps, sides, enemy formations, changes, action validity, terminations, and actual independent counts. Inactive fights cannot substitute for applicable independent armies.
- Fresh full-search diagnostics audit both policies without combat, then select by geometry only: at most one rescue-changing condition per cohort/map/side; one suppressed-broad condition per cohort/map, alternating sides; and one condition unchanged under both per cohort/map. Rotate opponent formation using fixed indices, prefer unused army clusters, and wrap pair order from fixed offsets. Up to **84 conditions / 252 fights** across all three arms. Report unavailable cells rather than filling them using favorable outcomes.
- Keep the intervention isolated unless a larger full-A19 comparison against current behavior and the matched free formation, separately seeded held-out confirmation, and authoritative server-path checks all qualify. The sparse full-search diagnostics and historical Mass Riot examples cannot promote it.

Evidence, frozen sources, source receipts, trace text/JSON, and comparison outputs remain untracked under game/core/tmp/analysis/blocked-approach-followup-20261025. The Mass Riot arbitration finding is a separate next research lead; it must not be hidden by calling the placement tweak a search fix.

Before new combat outcomes, the expanded audit found a malformed normal formation: uniform-mixed pair 61, audit seed, Normal, green omitted Behemoth. The engine's ordinary placement recovery places it and relocates a single Troglodyte companion. Both research policies already decline incomplete proposals; their expected-board assertion incorrectly assumed that no normal recovery would run. The harness now explicitly records an incumbent-fallback case, returns the original raw formation unchanged, and permits the standard recovery. Valid proposed boards still receive the exact final-board assertion. A real-case regression verifies identical complete repaired boards under current, broad, and rescue arms. The interrupted geometry audits produced no new fight evidence. The policy, sample plan, and seeds are unchanged; a new source receipt records this pre-combat instrumentation correction.

### Registered historical first-action counterfactual

Before inspecting counterfactual outcomes, compare both arms of the six historical full-search flip cases that moved Ogre Mage: the four regressions and two improvements. Keep the changed v2 formation, setup, combat seed, full search controller, and every later decision unchanged except for natural consequences of the first action.

Run the normal search arbitration, preserving its decision ordinal, private rollout work, and RNG restoration. In the treatment only, return the already-generated Mass Riot incumbent for the first own Ogre Mage decision in round 1. Do not skip search or use a second driver: that would change subsequent search-seed ordinals. A local, untracked wrapper of SearchDriver.chooseDecision performs this diagnostic intervention; it is never imported by the game API.

The **12 replay fights** must reproduce all stored fields in the unforced arms, retain identical initial boards in the forced arms, and execute the intended first spell. Where search already chooses Mass Riot, forcing the same action must reproduce the whole result. These are outcome-selected training counterfactuals on old armies, not fresh win-rate evidence or a rule eligible for promotion.

The counterfactual completed as specified. Three of the four old losses became wins when the first single-target Riot was replaced with the native Mass Riot on the identical changed board. The fourth remained a loss. Both already-Mass-Riot improvement cases reproduced unchanged, as did all six unforced replays. Every initial board was identical and no action was rejected. This establishes a costly choice in those three particular seeded positions; it does not establish a general rule's win-rate gain.

### Registered fresh opening-spell pilot

Candidate ID: **opening-mass-riot-incumbent-v1**. Use normal current A19 placements, not either experimental placement policy. Run the same full A19 search and preserve its ordinal, rollout work, and restoration. In round 1, once per own team, retain the single-action native Mass Riot incumbent only when search selects a single-action, single-target Riot. Keep every other search choice, including attacks, waits, and other spells. No named-creature dispatch rule or hidden setup input is added.

This is an untracked post-arbitration research wrapper around the exact frozen driver, not a live engine change. Its source and inputs must be saved before the pilot starts.

- Fresh pilot seed **102520302**; reserved confirmation seed **102520303**. Neither is used in the previous placement studies or the historical counterfactual.
- Select armies by roster and budget only, without combat outcomes. In each of seven cohorts, seek one own-Ogre-Mage army for each of the nine budget pairings, scanning at most 1,024 independent pair indices. Rotate map, physical side, and opponent formation by fixed cohort/budget indices. This is up to **63 independent book armies / 126 complete fights**. Report missing cells rather than substitute an outcome-selected case.
- Add one own-roster-without-Ogre parity case per cohort, from separate pair indices, for up to **14 additional fights**. Report these separately from the book-army pilot.
- Both arms share current formation, setup, splits, RNG seed, and full A19 combat. Current and treatment must match exactly where the arbitration rule does not activate.
- Primary pilot estimate: paired draw-aware score over the independently selected book armies; report activation count and the applicable-army estimate. Fewer than 30 active independent armies is insufficient for a qualification claim. Report cohort, map, side, formation, budget, action validity, and all unchanged-case parity checks.
- The map/budget/formation factors are rotated across cohorts rather than fully crossed within every individual army. This is a transfer pilot, not a replacement for the full cohort/formation promotion gate.
- A promising result requires a larger, fully funded full-A19 study, fresh held-out confirmation, and server-path verification before a production change. The three recovered historical losses and this small pilot alone cannot ship a new search policy.

## Experiment 3 results: trapped melee rescue

**Decision: retain as research only.** The narrower trigger produced a weak positive heuristic signal that was not confirmed by full A19 search. It also did not demonstrate superiority over broad v2.

### Three-arm primary screen

The completed run contains **48,384 actual fights**: current A19, broad v2, and trapped rescue on each of 16,128 matched conditions. There are **896 independent army-seed clusters**, not one independent observation per fight. Every cohort has 128 clusters and crosses all maps, physical sides, opponent formations, and all nine budget pairings. Shared current-A19 controls are counted once.

The rescue changed **255 conditions in 31 independent clusters** (1.58% of conditions). Control score was 52.66%; rescue score was 52.73%.

| Comparison / scope                    | Independent clusters | Paired score difference | Approximate 95% interval |
| ------------------------------------- | -------------------: | ----------------------: | -----------------------: |
| Rescue vs current, whole population   |                  896 |                +0.07 pp |        −0.02 to +0.15 pp |
| Rescue vs current, applicable armies  |                   31 |                +6.68 pp |       +0.13 to +13.22 pp |
| Rescue vs broad v2, whole population  |                  896 |                −0.14 pp |        −0.38 to +0.09 pp |
| Rescue vs broad v2, either applicable |                  272 |                −0.66 pp |        −2.13 to +0.81 pp |

The registered normal interval barely excludes zero on the 31-cluster applicable sample. The cluster bootstrap is +0.54 to +13.44 pp, but a small-sample Student-t sensitivity is **−0.14 to +13.49 pp**. This is a fragile signal, not a robust release conclusion. The secondary broad-v2 comparison does not establish that suppressing the older proposals is better.

Among the rescue-changing conditions, **27 outcomes improved, 16 worsened, and 212 stayed the same**. All 15,873 rescue-unchanged conditions reproduced exactly. Every fight ended through elimination, with zero rejected actions.

| Cohort          | Fights across three arms | Rescue-changing conditions | Rescue vs current |
| --------------- | -----------------------: | -------------------------: | ----------------: |
| Ranked draft    |                    6,912 |                         87 |          +0.09 pp |
| Uniform mixed   |                    6,912 |                          9 |          +0.04 pp |
| Ranged-heavy    |                    6,912 |                         30 |          +0.04 pp |
| Ground melee    |                    6,912 |                         81 |          +0.24 pp |
| Flyer-heavy     |                    6,912 |                          0 |        no changes |
| Caster/support  |                    6,912 |                         45 |           0.00 pp |
| Cross-archetype |                    6,912 |                          3 |          +0.04 pp |

All active cohort intervals adjusted across seven comparisons include zero. An inactive cohort is not evidence of equivalent performance under changed geometry.

### Fresh full A19 check

The geometry-only selection yielded **75 conditions / 225 full-search fights**, across 63 independent army-seed clusters. These include 33 rescue-changing conditions in 21 clusters, 21 cases where the broad proposal is suppressed, and 21 cases unchanged under both policies. All nine budget pairings, all seven cohorts, all maps, both sides, and all opponent formations are represented.

Nine rescue-changing cells were unavailable in the prespecified fresh audit: all six ranged-heavy map/side cells and the three red flyer-heavy cells. They were reported, not replaced using outcomes. Those cohorts still participate in the suppressed-proposal and unchanged checks.

On the 33 changed conditions, eight outcomes improved, seven worsened, and 18 stayed the same. The applicable-cluster estimate is **−7.54 pp**, with a wide approximate 95% interval **−33.58 to +18.50 pp**. The weighting unit is the independent army, so this estimate need not have the same sign as an unweighted count of repeated conditions. The check is sparse and geometry-selected; it is not a population win-rate estimate.

The full-search engagement measures also fail to confirm the heuristic signal: changed cases averaged 0.12 fewer early ground-melee attacks and 0.33 more capped delay rounds. Zero actions were rejected; all unchanged and equal-geometry arms reproduced; all fights ended by elimination.

### Why the narrower proxy still fails

Even among the 255 rescue-changing primary conditions, **166 control formations already made the moved stack's first melee attack by round 2**, despite its zero static forward progress at deployment. Friendly blockers can vacate and enemies can approach. Static opening reach is not the same as a lost combat turn.

For example, a green Hyena on Lava in ranked-draft pair 25 moved from (2,11) to (2,9). Its first melee attack worsened from round 2 to round 3-or-later, and a win became a loss. The rule cleared a static route without ensuring that the actual chosen engagement improved.

The next formation attempt needs evidence about durable congestion and the actual engagement plan. Simply narrowing the old proxy or removing historical losers does not solve that problem.

## Experiment 4 results: opening Mass Riot pilot

**Decision: promising diagnostic lead, insufficient evidence to promote.** The historical counterfactual recovered three of four selected losses, but the fresh pilot demonstrates that a blanket first-round override also causes losses.

All planned cells were selected by roster and budget without outcomes: **63 independent Ogre Mage armies**, nine per cohort and one per budget pairing, plus seven separate parity armies without Ogre Mage. Both arms used current formations and full A19 search. The run completed **140 fights**.

- On the 63 book armies, current score was **50.79%** and candidate score **55.56%**: **+4.76 pp**, approximate paired 95% interval **−5.81 to +15.33 pp**.
- The rule activated in only **18 independent armies**, below the registered 30-army minimum. Eight outcomes improved, five worsened, and five stayed the same when active.
- On the active sample the estimate is +16.67 pp, but its interval is **−20.49 to +53.83 pp**. The direction remains uncertain; a paired sign check is also inconclusive.
- All 45 inactive book-army pairs and seven without-Ogre parity pairs reproduced exactly. Initial boards matched in every pair.
- Zero rejected actions; elimination in all 140 fights. All nine budgets, maps, sides, opponent formations, and seven cohorts are covered, with the registered rotation rather than a full per-army factorial.

The fresh regressions include ranked-draft pair 176 on Block/red, uniform-mixed pairs 68 and 107 on Normal, flyer-heavy pair 166 on Block/green, and caster/support pair 18 on Block/red. These are evidence against hard-coding Mass Riot as universally better.

The two spells have different configured powers (30 for single-target Riot and 25 for Mass Riot), both last three laps, and they conflict rather than stack. Who can use the buff, when their turns occur, and the later buff schedule can matter. Those are hypotheses to measure in the five new failures, not established explanations for each loss.

The useful confirmed finding is narrower: in three particular fixed-board seeded positions, search's Riot override lost a game that the generated Mass Riot action won. The stronger general fix still needs to distinguish those choices from the five newly observed cases where the override was helpful.

### Source, checks, and reproduction

The third/fourth experiments use committed common baseline **3806a0d60a512dfc981c9bec65f36b17d87ba0cd** and research source SHA-256 **df6886cb9f5f602933c8213e2554a5df9ec1460bc66663fa43afe58dfcd008d1**. The historical diagnosis remains on its original frozen source and reproduced all stored results.

Result fingerprints:

- Three-arm primary records: 413e391cd76e04dee47c37433438df9f95db1631efe0f88fed8f5204e1105f20.
- Fresh full-A19 placement diagnostics: 5378fb5b7a48e9a23ce5c125224b8fc53ee0314372c503ce1b506f1ec915d62e.
- Fresh opening-spell pilot: ea52d0528d98b61f07e0f952bf38a90b7956b6162ad71e6a071437a7242e0ce1.

Independent checks reconstructed the three-arm comparisons and clusters, inspected all actual lateral changes and native-book exclusions, verified exact no-change parity, and expanded **311,688 primary stack records** plus **1,449 full-search diagnostic records** into complete legal, non-overlapping footprints. The separate spell-pilot validator checked activation correspondence, identical boards, every inactive result field, budget/cohort coverage, script hashes, and action validity.

The common build completed **7,216 tests with zero failures** and TypeScript compilation; the full common lint gate passed. Coverage includes the newly discovered incomplete-normal-formation repair, trapped rescue, passive-observer outcome parity, native spellbook metadata, split post-processing, mirrored and rectangular placement, and research isolation. No live strategy profile, battle-engine arbitration, server pin, or deployment changed.

The outputs and local research wrappers are under the ignored game/core/tmp/analysis/blocked-approach-followup-20261025 directory. From that directory, the recorded-source recipes are:

```bash
bun compare-three-placements-v2.ts --mode heuristic --pairs 128 --seed 102520292 --output reproduced-primary.json
bun compare-three-placements-v2.ts --mode production --jobs ./production-diagnostic-jobs-v2.json --output reproduced-full-search.json
bun mass-riot-counterfactual.ts
bun mass-riot-fresh-pilot.ts
```

Confirmation seeds 102520294 and 102520303 remain unused. The next step is to inspect the five fresh spell-pilot regressions and evaluate buff beneficiaries, remaining turns, duration, and future spell scheduling inside the existing scorer. Measure a conditional revision on fresh cases before promoting it; neither replay recovery nor a positive pilot point estimate is sufficient.

## Experiment 5: diagnose the buff evaluation and recheck it

All 18 active experiment-4 cases were replayed in both arms with initiative, completed turns, hourglass waits, remaining buffs, and accepted actions recorded. **All 36 full replays reproduced every previous record field except elapsed time.** A separate 18-prefix observational search audit also reproduced the exact action prefix and root choices without introducing the scored-decision observer's catalog changes.

Mass Riot was generated, retained, and evaluated at the full production horizon in every conflict. These examples therefore identify an **evaluation problem**, rather than missing actions or discarded shortlists. Riot's rollout advantage ranged from about 2.45 to 50 percentage points; a large predicted advantage did not reliably identify the better real continuation. These are selected conflicting positions, not a population calibration study.

The traces also reject an easy explanation based only on counting buffed attacks. In flyer-heavy pair 166, immediate Mass Riot produced 11 buffed physical attacks in the first four laps versus three with stock Riot, but lost the game that stock won. Stock delayed Mass Riot until lap 3. Similar losses involved different attack concentrations and later spell schedules. Waiting allies, target concentration, and duration remain useful diagnostics, but none is being installed as an outcome-fitted creature or cohort exception.

### Registered bounded recheck

Candidate opening-buff-recheck-h128-r8-v1 retains stock A19 arbitration on every turn. Once per own army in lap 1, only when the native Mass Riot action is replaced by single-target Riot, it compares those exact two actions again using **eight paired rollouts at horizon 128**, on an independently seeded bank. Preserve Mass Riot unless Riot leads by at least 0.01, the existing scored-arbitration gain. No other actions, placement, split, setup, or future turn decisions change.

The second comparison owns a detached driver's counters and caches and restores battle, auxiliary state, damage statistics, active unit, RNG source, and deterministic UUID sequence. It never advances the live driver's decision ordinal. **Eighteen full historical shadow runs passed exact result parity** before fresh research began. Extra computation is reported separately; local offline time does not establish ranked-server deadline feasibility.

Primary seed **102520312** selects **378 independent Ogre Mage army matchups**, six per cohort/budget cell across all seven native cohorts and nine five/six/seven-point own/opponent budget pairings. Each cell covers all three maps crossed with both seats across six different armies, with each opponent formation twice. A stock first-lap prefix audit selects qualifying conflicts before their actions execute, without using fight outcomes. Every conflict gets three complete full-A19 fights: stock, unconditional Mass Riot, and the registered recheck. One without-Ogre army and the first no-conflict book army per cohort provide three-arm parity controls.

The primary endpoints are paired draw-aware final score against both controls on the fresh conflict population, with two-comparison Bonferroni intervals and independent armies as the sampling unit. Also report a roster-conditioned effect across all 378 prefixes, assigning exact zero policy differences to non-conflicts without pretending those are completed fight pairs or estimating their unobserved baseline win rates. Require 30 actual independent recheck interventions, identical initial boards/root-state hashes, complete no-change parity, and no unresolved invalid actions. Cohort/map/seat/formation/budget slices remain descriptive.

Held-out seed **102520313**, three new armies per cohort/budget cell, is reserved only if the primary clears both adjusted lower confidence bounds and the intervention minimum. A positive primary still requires held-out confirmation and a separate authoritative-server cost/behavior check before promotion. Otherwise reject or retain uncertainty without shipping.

Source remains the immutable experiment-4 export at 3806a0d60a512dfc981c9bec65f36b17d87ba0cd. The local source receipt additionally hashes all 586 source files and the separately frozen recheck scripts; the source-file-map fingerprint is 7355c29d058420c33314403b1d9c146ad00bacfe4179edc8185200fc685f10e2. Registration, source receipts, shadow results, prefix audits, and complete fights remain under the existing ignored follow-up directory. No live profile changed.

### Registered continuation calibration diagnostic

Before inspecting experiment-5 results, a separate mechanism diagnostic was registered for all 18 previous pilot conflicts. It compares the stored native horizon-128 forecasts with actual engine continuations from the same root position and future RNG seed. Use the first four worlds from each already frozen eight-world shadow bank, both root spells, and two future controllers: native decisions and full A19. This is **288 complete continuations over 18 historical root armies**, not 288 independent armies or fresh qualification evidence. Half deliberately use native future decisions.

Fourteen no-fork shadow fights, one conflict per cohort in both spell arms, must first reproduce every previous record field except elapsed time. Each real diagnostic continuation asserts its complete pre-fork state hash, switches future luck only immediately before the root spell executes, and keeps the ordinary seeded search prefix. Native engine continuations must be checked against terminal model forecasts before attributing differences to the modeled controller; any plumbing/model discrepancy is retained and reported. Nonterminal probabilities are not terminal labels. This diagnostic does not alter the registered candidate or substitute for its fresh primary and held-out gate.

## Experiment 5 results: more search is not yet a qualified improvement

**Decision: do not promote. The fresh primary did not meet either adjusted confidence gate, so held-out seed 102520313 remains unused.** The intervention minimum was met; inadequate activation is no longer the reason to withhold a conclusion.

All 378 planned first-lap audits completed before lap 2 without terminal outcomes. They found **87 conflicts**, spanning every cohort, map, seat, formation, and all nine budget pairings. The complete comparison ran **303 full-A19 fights**: 87 conflict armies in three arms, plus 14 distinct parity conditions in three arms. The recheck preserved Mass Riot in **57 independent conflict armies** and retained stock Riot in the other 30.

| Comparison on 87 fresh conflict armies            | Score difference | Two-comparison adjusted 95% interval | Improved / worsened / same |
| ------------------------------------------------- | ---------------: | -----------------------------------: | -------------------------: |
| Recheck versus stock A19                          |         +3.45 pp |                   −7.51 to +14.41 pp |                12 / 9 / 66 |
| Recheck versus unconditional Mass Riot            |         +2.87 pp |                   −5.39 to +11.14 pp |                 7 / 4 / 76 |
| Unconditional Mass Riot versus stock, descriptive |         +0.57 pp |                  −13.20 to +14.35 pp |               16 / 16 / 55 |

Stock score on the conflict population was 48.28%, unconditional Mass Riot 48.85%, and recheck 51.72%. The recheck-versus-stock paired sign check was inconclusive (p = 0.664). Across the 378 roster-selected prefixes, including the 291 exact no-intervention zeros, the estimated effect was +0.79 pp with an adjusted interval of −1.72 to +3.31 pp. Those 291 zeros are policy-equivalence deductions, not additional completed fight pairs or observed baseline win rates.

The result also varies in direction: ranked-draft and cross-archetype cohorts were negative, as were the red seat and current opponent formation; compact opponents were favorable. These small, overlapping slices are descriptive and do not qualify a formation-specific exception after the primary failed. Every cohort interval included zero.

The longer comparison added a median **519 ms** of local wall time per conflict (p90 973 ms, maximum 1,416 ms), measured with 12 offline workers. Stock root search in that arm had a median of 656 ms. This is a computation cost, not a production-server latency estimate or deadline qualification. The longer trajectories reached terminal results in **1,383 of 1,392 samples**; extending the same independent bank from horizon 64 to 128 changed the preferred spell in 20 of 87 positions. Reaching a terminal result under a native continuation does not establish the better result under subsequent A19 play.

All nine recheck-versus-stock regressions had terminal results in every one of their 16 longer samples. Examples include uniform-mixed pair 310 on Lava/red (modeled Mass/Riot means 1.00/0.75, but actual Mass lost and Riot won), ground-melee pair 158 on Lava/green (0.625/0.25, same real reversal), and caster/support pair 196 on Block/green (0.75/0.375, same reversal). These single real-world outcomes still include combat variance; the separately registered seed-matched continuation diagnostic checks whether future-policy differences also contribute.

Independent validation checked all 586 frozen source hashes and both script hashes; all planned factor cells; initial rosters, boards, and budgets; prefix-to-combat root-state equality; accepted actions; and every complete record field when recheck selected an equivalent policy. Every recheck-retains-Riot record matched stock, and every recheck-preserves-Mass record matched unconditional Mass Riot, excluding elapsed time. All parity controls reproduced. **Zero rejected actions; all 303 fights ended by elimination.**

Primary records SHA-256: d9ba9b55c396bf0b366166071bfa30abf6af3967defead615cda728cf06efe04. Files are opening-buff-primary.records.jsonl, opening-buff-primary-validation.json, the first-lap audit/selection files, and opening-buff-recheck-source-receipt.json in the ignored follow-up directory. This candidate remains a diagnostic wrapper; no production search, default strategy, server dependency, or deployment changed.

## Continuation calibration results: the modeled future policy matters

The registered diagnostic completed **288 fights** from all 18 historical conflict positions: four paired future worlds per position, both opening spells, and native/full-A19 future controllers. These are 18 independent historical root armies with repeated worlds, not 288 independent samples or a fresh policy qualification study. The 14 preceding no-fork shadow fights reproduced every stored record field except elapsed time.

All pre-fork state hashes, boards, and future seed assignments matched. All **144 native engine continuations reproduced their stored terminal forecast exactly, including the finishing lap**. This validates the engine continuation and seed coupling for these tests. With the same starting positions and initial future random streams, later full A19 decisions changed **75 of those 144 action/world outcomes**.

- The two controllers preferred opposite opening spells in six of 72 paired position/world comparisons.
- Averaging the four worlds within each historical root, the preferred spell reversed in **five of 18 positions**.
- Across this selected historical set, Mass Riot minus Riot averaged +8.33 pp under native continuation and 0.00 pp under full A19 continuation. These descriptive means do not estimate a general AI upgrade or replace the fresh primary.
- Zero rejected actions; elimination in all 288 continuations. Half of these continuations deliberately use native future decisions, so they must not be described as 288 full-A19 fights.

This separates the mechanism from a broken terminal label: the native rollout correctly predicts native play in the checked worlds. The actions chosen on later real A19 turns change the tradeoff, even when the native forecast reached an actual winner. More depth and samples alone continue to evaluate that native future policy.

### Concrete ranged-reply example

The first recorded position/world with opposite controller preferences was uniform-mixed pair 3, Lava/green, spread, world 0. Four additional observational trace replays reproduced the entire corresponding diagnostic records, excluding elapsed time:

| Future controller | Opening Riot | Opening Mass Riot |
| ----------------- | ------------ | ----------------- |
| Native            | Win          | Loss              |
| Full A19          | Draw         | Win               |

The first post-spell divergence is the enemy Tsar Cannon's immediate reply. Native play shoots Scavenger after either spell. A19 instead shoots Mermaid after Riot and Ogre Mage after Mass Riot. The allied Gargantuan also changes targets: native play shoots Peasant; with Mass Riot, A19 shoots Tsar Cannon. Later movement, attacks, and casting differ as well. This example identifies an immediate reply-modeling target; it does not establish that replacing one shot alone recovers the complete result.

### Next hypothesis

Test a cheap approximation of **later searched replies**, especially ranged target selection, caster timing, and wait-versus-attack decisions, within a fixed compute budget. Reuse the existing src/simulation/measure_search_continuation.ts and measure_search_future_policy.ts collection/diagnostic tools rather than creating another general corpus pipeline. Collect both armies' searched choices; separate army seeds across training, evaluation, and final confirmation. A candidate must improve complete fights against stock and an equal-compute native-rollout control across all cohorts, maps, seats, budgets, and deployments. Check the authoritative server's actual decision deadline before promotion. A creature-name, formation, or cohort exemption fitted to these failed runs is not the next candidate.

No continuation predictor is enabled by this diagnostic. Its result narrows the engineering target; the deeper recheck remains unqualified. Held-out seeds 102520294, 102520303, and 102520313 remain unused.

Continuation records SHA-256: 5b29c0ecdb986437e2c39d990689f836e9d4f0aacdb89cc9731ddbfeebdd63f2. Reproduction artifacts are opening-buff-continuation-run.records.jsonl, opening-buff-continuation-validation.json, the separately hashed calibration script/registration, and the four opening-buff-trace files in the ignored follow-up directory. Source and production policy remain unchanged.

From that directory, the new recorded-source recipes are:

```bash
bun run-opening-buff-recheck.ts --stage shadow --prefix opening-buff-shadow
bun run-opening-buff-recheck.ts --stage select --seed 102520312 --repeats 6 --prefix opening-buff-primary
bun run-opening-buff-recheck.ts --stage audit --prefix opening-buff-primary
bun run-opening-buff-recheck.ts --stage combat --prefix opening-buff-primary
python3 validate-opening-buff-recheck.py
bun calibrate-opening-buff-continuations.ts --stage shadow
bun calibrate-opening-buff-continuations.ts --stage run
python3 validate-opening-buff-continuations.py
```

Final repository verification for this research turn: **55 focused tests passed, zero failed**, including research isolation, production A19 profile/source-ledger integrity, the placement wrappers, and the shared cohort runner. The updated notes passed targeted formatting. Engine changes were confined to ignored standalone research processes; the shared production source files were not edited.

## Experiment 6: bounded ranged/caster replies from both armies

The existing research archive already contains unsuccessful general continuation imitation and reply-residual models. The October 16 imitation model improved held-out final-action agreement by only 0.54 pp, with an interval crossing zero; its strength test was not run. An October 17 four-game H0/R1 first-enemy-reply pilot changed four of 52 nested decisions and no root choices. Those experiments stay unqualified. This revision tests a different coverage rule: spend the bounded reply choices on ranged/caster turns from both armies, rather than an arbitrary early melee wait.

Candidate opening-two-sided-ranged-caster-reply-h0-v1 changes only the own army's first native single-action Mass Riot opening in lap 1. It retains the ordinary root catalog, shortlist, H64 and four outer rollouts. In each full rollout, the first eligible future unit from each army within 16 future unit-turns gets one immediate child A19 choice: H0, one rollout, shortlist two, ordinary candidate caps, no recursive future turn. A unit qualifies through RANGE/MAGIC/MELEE_MAGIC attack type or any remaining spell; AI-Driven units retain their own controller. All later real turns use ordinary A19. This population includes openings where stock keeps Mass Riot, so it is broader than experiment 5's Mass-to-Riot conflicts.

The child query restores the speculative battle, auxiliary state, active unit, damage statistics and RNG/UUID state; a changed proposal commits the target-memory update used by the existing continuation diagnostic. The complete root restores the real battle and randomness. Shadow mode computes the proposed replies and ignores them, requiring complete historical result parity before fresh outcomes. Validation additionally checks the two-team/16-turn cap and zero child future unit-turns.

The three arms are stock R4, the reply candidate at the same outer budget, and native-continuation R5 at that opening. R5 completes five native rollouts on the same shortlist and disables tail pruning for that comparison. It is an additional-compute reference; identical runtime is not assumed. Local timing includes the research validation overhead, and no candidate may qualify without a later same-state timing study demonstrating an upper 95% ratio of at most 1.10 against stock.

Primary seed **102520322** selects 378 Ogre Mage army matchups, six in every seven-cohort/nine-budget cell. Per cell the six different armies cover Normal/Lava/Block crossed with both seats and each enemy formation twice. A stock first-lap prefix audit selects native Mass Riot openings before they execute, using no terminal outcomes. Every eligible opening receives all three full-fight arms. Without-Ogre parity and the first no-opening book army per cohort are included when available; missing no-opening parity cells are reported.

The primary endpoints are paired draw-aware score against both stock and R5, with independent army matchups and two-comparison adjusted intervals. Require positive lower bounds against both controls, at least 30 actual root-choice changes, source/board/root-state/shortlist/paired-seed equality, equivalent-policy record parity, and zero unresolved validity failures. Subgroups remain descriptive. No placement, artifacts, splits, setup, or hidden-information access changes.

Only a primary pass permits the 32-root same-state, order-alternated timing gate. If it also passes, held-out seed **102520323**, three new armies per cohort/budget cell, may run unchanged. Promotion still requires separately registered 6,000+ game strength confirmation and authoritative server deadline/behavior checks. A failed gate stops this candidate without changing production.

The immutable engine export remains commit 3806a0d60a512dfc981c9bec65f36b17d87ba0cd. Research scripts, complete source receipts, registration, prefix audits and fight records are under the ignored game/core/tmp/analysis/ranged-caster-replies-20261025 directory. The module adapts the bounded child chooser and target-memory/state-restoration approach from the existing future-policy diagnostic; it does not introduce another game engine or meta-cohort generator.

### Experiment 6 preflight and selection

The first 18 historical shadow battles passed complete result parity while computing and ignoring 802 reply proposals. Work-cap telemetry was then added without changing the policy, and all 18 were repeated on the final frozen source. The final replay set again reproduced exactly: 802 child queries, 270 different proposed replies, at most two different-team queries per parent rollout, and **zero child future unit-turns**. These are passivity checks on reused historical armies, not independent strength evidence.

A separate 21-fight smoke test covered stock, R5 and reply arms on one historical army per cohort. All pre-root state hashes, shortlists and root seed banks matched; all 13 equal-root-choice arm pairs reproduced their complete records except elapsed time. All actions were accepted. Four of the seven reply-arm root choices differed from stock, demonstrating intervention without qualifying a gain.

The registered fresh audit completed all **378 prefixes** without observing terminal outcomes, finding **355 native Mass Riot openings**: ranked-draft 49, uniform-mixed 52, ranged-heavy 52, ground-melee 51, flyer-heavy 52, caster/support 49, cross-archetype 50. They include 173 green and 182 red matchups; Normal/Lava/Block have 113/123/119. The planned full batch is **1,107 games**: 355 eligible armies in three arms and 14 parity conditions in three arms.

Final reply-policy source SHA-256: 5924994474bbd138d70b9aedbe8f19c1b03d12c7bfde3957b726f65365eb9fc9. The source receipt hashes the runner and preregistration plus all 586 inherited engine source files. Primary results are evaluated only after the complete registered batch; seed 102520323 remains reserved.

## Experiment 6 results: directional gain, insufficient evidence and excessive cost

**Decision: do not promote.** The complete primary failed both adjusted confidence gates. Its 71 actual root-choice interventions exceeded the registered minimum, so insufficient activation is not the explanation. The serial timing gate and held-out seed **102520323** were not run, following the registered stop rule.

All **1,107 full-A19 games** completed: 355 independent eligible-opening armies in three arms, plus 14 three-arm parity conditions. Every game ended by elimination, with **zero rejected actions**.

| Comparison on 355 fresh eligible openings | Score difference | Two-comparison adjusted 95% interval | Improved / worsened / same |
| ----------------------------------------- | ---------------: | -----------------------------------: | -------------------------: |
| Bounded reply model versus stock R4       |         +1.83 pp |                    −0.82 to +4.49 pp |               13 / 7 / 335 |
| Bounded reply model versus native R5      |         +2.39 pp |                    −0.77 to +5.56 pp |              19 / 10 / 326 |
| Native R5 versus stock, descriptive       |         −0.56 pp |                    −2.56 to +1.43 pp |                5 / 8 / 342 |

Draw-aware scores were stock 41.13%, reply model 42.96%, and R5 40.56% on these roster-conditioned matchups. The reply-versus-stock paired sign check was inconclusive (p = 0.263). The result is a positive point estimate, not established strength improvement. Across all 378 roster-selected prefixes, including the 23 exact no-opening zeros, the estimate was +1.72 pp with an adjusted interval of −0.77 to +4.21 pp. Those zeros are not additional observed fight pairs or baseline win rates.

The reply model changed **71 of 355 opening choices**. It changed Riot to Mass Riot in 26 cases (three improved, two worsened), and Mass Riot to Riot in 23 cases (five improved, five worsened). Other changes included Riot target selection and movement/attack choices. These transitions reinforce that a universal preference for either buff is not supported.

Directional gains appeared in ranked-draft and ground-melee; uniform-mixed and caster/support were negative, while ranged-heavy and flyer-heavy had no net score change. No cohort established a reliable gain. In particular, zero observed outcome variation in a slice is not a population equivalence result. Lava was favorable and Block unfavorable in point estimates; no map or cohort exception is qualified by these overlapping descriptive slices.

### Work and validity

The model computed **14,992 immediate reply queries**, with 4,119 different proposals. That is 42.23 queries per eligible opening on average: the per-rollout cap of two still repeats across root candidates and chance samples. All caps passed, including zero child future unit-turns.

Local opening search time, measured with 12 offline workers and research validation overhead:

| Arm       | Median |      p90 |
| --------- | -----: | -------: |
| Stock R4  | 564 ms | 1,157 ms |
| Native R5 | 789 ms | 1,534 ms |
| Reply R4  | 899 ms | 1,934 ms |

Pooled reply-root time was **1.56× stock** and **1.15× R5**. Child-query work accounted for about a third of aggregate reply-root time. These are descriptive local costs, not the registered serial same-state timing gate or authoritative-server latency qualification. Keeping the outer R4/H64 caps did not keep total computation close to stock.

Independent validation checked every frozen source hash; every planned factor cell; initial rosters, budgets and boards; prefix-to-combat root-state equality; identical root shortlists and seed banks; R5/R4 allocation; work caps; actions and termination; and complete outcome-record equality whenever final root actions matched. All equivalent-policy and parity records reproduced exactly, excluding elapsed time. No validity failure explains the uncertain gain.

Primary records SHA-256: **9485d890f235d8d64652be4fe50e41ab1113421461089d17788656916a935fd8**. Records, independent validation, root-choice transitions and source receipts are in the ignored ranged-caster-replies-20261025 research directory.

### What the cheap predictor still misses

A separate historical diagnostic replayed all 18 original conflict armies in shadow mode. It sampled the first eligible reply from each army on the native Mass Riot branch's first private rollout, yielding **36 native-rollout-state reply positions**. For each, the native and H0 choices were compared with an ordinary full A19 H64/R4 choice on that exact hypothetical state. These are historical mechanism checks, not fresh fidelity or strength qualification and not 36 additional complete games.

All 18 complete shadow match records reproduced, and every reference query restored its speculative state. The full A19 reply matched native in **15 of 36** positions and matched the cheap predictor in **12 of 36**. The predictor rescued one native miss and spoiled four native matches. This selected small sample does not establish general policy accuracy, but it supplies concrete failure cases.

The full-A19 choice was available in the cheap predictor's input catalog in every position. Among the 24 cheap misses:

- **16 were discarded by the cheap two-action shortlist.**
- **Eight remained available in that shortlist but were ranked differently.**
- None was missing from the input catalog.

This is the **predictor's internal shortlist**, not the production root shortlist, which was held identical across the primary arms. For example, on uniform-mixed pair 3 after hypothetical Mass Riot, Tsar Cannon's H0 choice still targets Scavenger while full A19 targets Ogre Mage; the latter was retained but ranked below it. On uniform-mixed pair 52, the Orc's full-A19 Hydra shot was present in the catalog but discarded from the cheap shortlist. Earlier friendly/enemy actions also change the correct response, so labels on native-rollout states should not be conflated with labels on a complete searched trajectory.

Two initial reference-instrumentation attempts incorrectly nested rollback checkpoints and produced no usable diagnostic rows. The reference diagnostic was corrected to snapshot rollback, as in the existing future-policy tool, then all 18 full-record parity checks passed. The frozen candidate, fresh primary source and its validated outcomes were not modified. Failed logs remain with the artifacts; only the successful diagnostic contributes the counts above.

Diagnostic records SHA-256: **8821271fbe1f66eb1493056bc6c6a6fca7bb43fa694c1ed1b641df8a9aed16c8**. The inspector and analysis files record raw catalogs, shortlists, native/cheap/reference choices and readable target names.

### Next research target

Before funding another large reply-policy trial, improve the cheap predictor's ranking/retention on independently sampled full-A19 reply labels and measure its total per-opening work. A larger shortlist by itself does not resolve the retained-but-misranked cases. Profile exact repeated states and safe reuse opportunities, and cap work across root candidates/chance samples as well as within each rollout. A changed ranking or allocation rule is a new candidate with fresh seeds; this primary's favorable subgroups do not qualify an exception.

Use the existing continuation collection/feature tools for a learned ranker if pursued. Earlier rejected imitation and residual models remain development evidence; better fidelity or lower value MSE alone cannot replace full-match, compute-matched and held-out strength checks. No production profile, engine entry point, server dependency or deployment changed. **55 repository safeguard tests passed, zero failed.**

## Experiment 7: conditional replies for armies without native shooters

The user requested continued research toward measurable gains, including unit, opponent, map and artifact conditions. An exploratory context audit of experiment 6 found eight improved and no worsened outcomes among 150 eligible armies without native physical shooters. All seven regressions occurred in shooter armies. This was discovered after inspecting outcomes and **does not qualify a subgroup**. Individual creature and artifact correlations overlap heavily; the native sampler also concentrates artifacts on Cursed Ward, Titan Plate and Lava Striders. No artifact exception follows from those counts.

During this follow-up, shared mainline adopted complementary actor/lap R2 by the user's separate instruction. The new experiment therefore uses committed engine **14797055f380c811765db71ad534791051b22dd7**, with its actual exported R2 profile asserted before testing. The preceding R4 study supplies development evidence only; its outcomes will not be pooled with new R2 results. An initial export caught the preceding R4 commit during the concurrent handoff; that failed preflight/export is preserved separately and does not contribute R2 evidence.

Candidate **opening-no-native-shooters-memoized-reply-r2-v2** retains ordinary R2/H64 root search and models the same bounded first ranged/caster reply from each army, only when the initial own roster has no native RANGE unit. It adds exact-state reply memoization within one opening, keyed by complete battle epoch, target memory, damage statistics, actor, incumbent and finish overlays. A development audit recomputed every cache hit across all 150 original no-shooter openings: **6,277 proposed queries, 2,743 reusable hits, all opening choices and values unchanged**. This checks computation reuse on old R4 states, not strength on R2.

Before any fresh fight outcomes, register primary seed **102520332**: six different Ogre Mage/no-native-shooter armies per six-cohort/nine-budget cell, or **324 prefixes**. They cover all three maps crossed with both seats and three opponent deployments. Ranged-heavy own armies are structurally excluded; three separate shooter conditions test exact baseline dispatch parity. A stock first-lap audit includes every native Mass Riot opening without observing terminal results. Compare the candidate with current native R2 and native R3 at that opening, keeping the first complementary pair, root shortlist and every other real decision matched. Require at least 30 root changes and positive two-comparison adjusted paired score intervals against both controls. All moderator slices remain descriptive.

Only a primary pass permits the registered serial 32-root timing gate (upper 95% ratio at most 1.10 against stock), followed by unchanged held-out seed **102520333**. If both pass, seed **102520334** supplies a separate uniform-artifact robustness challenge on new armies. It is not pooled with the ordinary-artifact confirmation and cannot qualify a fitted artifact exception. Broad promotion still requires a separately registered 6,000+ game confirmation and authoritative server checks. Older held-out seeds remain unused. Scripts, immutable source exports, registration, audits and records stay ignored under game/core/tmp/analysis/conditional-reply-followup-20261025.

### Experiment 7 preflight and fresh audit

On the asserted current R2 export, the final 84-fight preflight covered 21 development conditions. Complete stock-versus-shadow records matched; cache hits recomputed with redundant rollback guards and the measured fast path produced identical complete games and opening values; the native-shooter guard preserved stock results exactly. There were zero rejected actions. Successful child queries rely on the canonical chooser's existing snapshot/auxiliary/random cleanup; extra successful rollback verification remains available in audit mode, and error cleanup plus live-root state/random checks remain active.

The source receipt was frozen before fresh outcomes. All **324 new primary prefixes** stopped without terminal outcomes, finding **308 eligible openings**: ranked-draft 52, uniform-mixed 52, ground-melee 52, flyer-heavy 50, caster/support 51 and cross-archetype 51. Map counts are Normal 103, Lava 102, Block 103; seats are green 151, red 157. Every planned roster/budget cell is filled. The complete three-arm batch includes separate no-Ogre, no-opening and shooter-guard parity conditions. No outcome or timing gate is inferred from these structural checks.

### Experiment 7 result: the no-shooter signal did not replicate on current R2

**Do not promote.** All **969 registered full fights** completed and independently validated: 308 eligible independent armies in three arms, plus 15 three-arm parity conditions. All ended by elimination, with zero rejected actions. The candidate changed 60 opening choices, exceeding the minimum intervention count.

| Comparison                                    | Draw-aware score difference | Adjusted 95% interval | Improved / worsened / same |
| --------------------------------------------- | --------------------------: | --------------------: | -------------------------: |
| Conditional reply versus current stock R2     |                    −1.62 pp |     −4.62 to +1.37 pp |               6 / 11 / 291 |
| Conditional reply versus native R3 at opening |                    −3.08 pp |     −7.39 to +1.23 pp |              13 / 23 / 272 |
| Native R3 versus stock, descriptive           |                    +1.46 pp |     −1.89 to +4.82 pp |               13 / 9 / 286 |

Neither primary interval met the strength gate. This does not establish harm with confidence, but it supplies no replicated gain from the no-native-shooter condition. Both source and seed population differ from the R4 discovery data; do not pool them to rescue the conditional rule. Ground-melee was +3.85 pp versus R2 but −1.92 pp versus the extra-compute R3 control, with both intervals crossing zero. Opponent native-shooter counts 0/1/2+ all had negative point estimates versus R2. Normal and Lava were negative; Block's small positive estimate crossed zero. No map, opponent or cohort exception is qualified.

All frozen source hashes, factor cells, rosters, budgets, boards, opening epochs, root shortlists, paired seed banks, reply work caps and equivalent-choice records passed independent validation. Shooter-guard results exactly matched stock. The cache reused 1,678 of 6,742 proposed queries; 5,064 child choices were actually computed, with zero child future unit-turns. Pooled local root cost remained 1.42× stock and 0.93× R3. These 12-worker costs do not constitute the serial timing gate or server latency evidence.

Following the registered stop rule, **no serial timing or held-out confirmation was run**. Seeds **102520333 and 102520334** remain unused, as do the older reserved seeds. Primary records SHA-256: a210b7cee244f91bcd22d9e4dcdcf0444b91cfb7c4f5217975abc57f2c69b8bc. **56 focused safeguard tests passed, zero failed.** No experimental profile was enabled.

### Follow-up mechanism diagnostic

The completed primary armies may now serve as development examples for a different candidate. A separate passive inspector compares native replies, H0/R1/shortlist-2 replies, H4/R1/shortlist-4 replies and H8/R1/shortlist-4 replies with the ordinary full H64/R2 A19 choice on the exact same hypothetical Mass Riot branch state. It samples the first eligible actor from each army in the first private rollout, and requires all native root actions and values to reproduce. These are reply-fidelity diagnostics, not new independent strength games. No higher-horizon predictor is enabled by merely agreeing more often with A19.

An isolated exact H0 leaf-score reuse implementation was also prepared before primary outcomes. H0 leaf and zero-turn modes apply the same action, close the same turn and use the same private R1 seed; material evidence must be retained for tie arbitration. It remains separate and unvalidated. It cannot rescue the failed strength result, and it is not part of the frozen primary source.

## Experiment 8: reply prediction development screens

The passive inspector completed all 308 primary army prefixes and sampled **593 reply positions**. Every original native root action and root value reproduced. The reference was the final ordinary H64/R2 A19 choice on the same hypothetical state, not an optimal-action label or a complete searched trajectory. Results were:

| Reply policy      | Matches reference | Agreement |
| ----------------- | ----------------: | --------: |
| Native            |         361 / 593 |    60.88% |
| H0/R1/shortlist 2 |         326 / 593 |    54.97% |
| H4/R1/shortlist 4 |         296 / 593 |    49.92% |
| H8/R1/shortlist 4 |         277 / 593 |    46.71% |

More short-horizon search was not a fidelity improvement. Relative to native, H4's army-clustered agreement difference was −10.75 pp (unadjusted 95% interval −14.50 to −7.00), and H8's was −14.01 pp (−17.90 to −10.12). H0 rescued 32 native misses while spoiling 67 native matches. Twenty-four H0 calls returned before normal shortlisting; all matched the reference, but only one changed the native action. Those forced/fallback decisions do not supply enough activation for a broad new reply controller. The H4/H8 branches were not advanced to another strength trial.

A separate development scorer reused the existing NumPy conditional-logit/32-hidden-unit fitter, with 611 pre-decision features: the canonical continuation basis plus actor/action-family, map/action-family and coarse artifact/action-family interactions. Its 308 armies were split by a fixed condition hash into 216 training roots (412 positions) and 92 validation roots (181 positions). Two fixed architectures, 60 epochs and three native-fallback thresholds were compared; no new strength outcomes entered features or targets. The best setting correctly predicted **110/181** validation choices versus native's **114/181** (−2.21 pp), with zero rescues and four spoils. A stable non-BLAS numerical refit reproduced that result. The model stays unqualified; fresh fidelity seed 102520342 and any further strength test were not used. Earlier general imitation failures remain development evidence, not a reason to claim a universal impossibility result.

An additional read-only audit found no current-R2 opening where native Mass Riot was replaced by Riot at an exactly tied recorded primary score. Those replacements had a strict primary advantage under the existing forecast. A proposed opening-only exact-tie patch would therefore have no observed activation on this sample. The diagnostic narrowed the failure; it did not establish a new spell exception.

## Experiment 9: Medusa singleton gaze-aware unresolved ties

### Mechanism and scope

Physical shot scoring does not include Petrifying Gaze's separate front-creature kill opportunity. A passive census on **162 Medusa army prefixes** across six relevant cohorts, nine budget cells, three maps, both seats and three deployments observed **472 Medusa turns**, 471 searched. Its supported first-hit opportunity proposal was absent from the native catalog in five turns and absent from the final shortlist in six turns. **Five of those six were one-creature Medusa cover stacks**; 16 census armies already contained such a native split. Every census calculation preserved authoritative battle state and RNG/UUID.

This supplies a concrete unit-specific mechanism: a singleton's physical damage is tiny, but the gaze retains the target-level contribution to petrification chance. Targets in the omitted set included Angel, Arachna Queen, Thunderbird and Black Dragon. It is not proof that those shots win more fights. Another roster-only audit found seven of the 162 armies where a different cover source could have been replaced by Medusa; that split-priority idea was not implemented or tested. The current trial changes only shot evaluation for an **existing** Medusa cover army.

The proposal uses the shared engine's gaze chance, target level, range divisor, mind resistance, miss chance and integer base-damage/coefficient ranges. It adds the expected first-hit gaze component to the existing physical shot value. Water Shield, Ember Covenant and Flesh Shield interactions receive no gaze bonus from this limited estimator; later volleys and other riders remain the full engine's responsibility. The estimator proposes a target or secondary ordering rather than changing ability rules.

### Development revisions before fresh qualification

Reserve-only v1 appended at most one missing gaze target and reproduced every stock/shadow record in 64 full development fights on 16 reused census armies. It changed no actual game trajectory: in four of the five relevant extra-shot decisions, full A19 gave the added shot the same primary score as its final selection, preserving its incumbent; the remaining shot scored lower. An available target alone did not fix this tie behavior.

V2 added a gaze-value tiebreak between ordinary stationary ranged attacks with identical primary scores. On the same development armies it changed eight trajectories and split **two improved/two worsened outcomes**. Both regressions arose when the primary score was already 1. This motivated a final, fixed v3 hypothesis: retain the incumbent on completed predicted-win ties, and use the gaze secondary only for **unresolved exact ties below 1**. Require both compared actions to have actually completed private samples 0 and 1; a bounded partial mean cannot qualify. No move/cast-to-shot conversion or primary-score loss is permitted.

Candidate **singleton-medusa-gaze-unresolved-tie-v3** uses committed R2 engine **e55cf7883f26172c15fc74f3e03ac075f327425c**, frozen before fresh outcomes. It appends at most one missing stationary gaze target, retains ordinary H64/R2 evaluation, and applies the secondary rule above. A physical-only extra-target/tie control has the same slot limit, completed-sample requirement and unresolved-score gate. The stock arm performs no gaze proposal computation. All arms retain their existing rosters, splits, setup, artifacts and deployment.

Final development preflight: 64 full games, all stock/shadow records and observed driver trajectories identical, zero rejected actions. V3 changed four of the 16 development games, improving two and worsening none. **These reused pilot outcomes do not qualify a gain.** A further final-source check matched 18 same-state prefixes and six full shadow games across all six cohorts.

### Registered fresh test

Primary seed **102520412** selects **324 different armies** that already receive a Medusa cover stack from the canonical own-army split planner: six per six-cohort/nine-budget cell. The six repeats cover Normal/Lava/Block crossed with both seats and each enemy formation twice. The relevant cohorts are ranked-draft, uniform-mixed, ranged-heavy, flyer-heavy, caster/support and cross-archetype. Ground-melee cannot contain native Medusa. Twelve no-Medusa/no-cover conditions provide exact outside-scope parity. Total planned batch: **1,008 full fights** in stock, gaze and physical-control arms.

Require positive two-comparison adjusted paired-score lower bounds against both controls, at least 20 changed army trajectories versus stock and 10 versus physical, plus all source, factor, roster, board, root, sample, action and parity checks. Only a pass permits the registered serial 32-root timing gate (upper 95% ratio at most 1.10), followed by unchanged held-out seed **102520413**. Uniform-artifact challenge **102520414** remains separate. A subgroup cannot replace either primary endpoint. Production promotion additionally requires 6,000+ confirmation games, measured live incidence and authoritative server legality/deadline checks.

The existing artifact-fit-v6 scorer remains the reference. Its zero-beneficiary Quiver score is already zero; the separately recorded 1,800-fight fitted-table calibration failed to establish an improvement. The new trial records item context for robustness checks and does not fit an artifact exception. Source receipts, complete registration and generated output remain ignored under game/core/tmp/analysis/medusa-gaze-coverage-20261025. No experimental profile is enabled.

### Experiment 9 result: target estimate works, strength is inconclusive

All **1,008 full fights** completed and independently validated. The 324 independent native-cover armies produced 61 changed trajectories versus stock and 64 versus the physical control. Every fight ended by elimination, with zero rejected actions. All frozen source hashes, factor cells, initial states, boards, sample caps, completed-sample requirements, exact tie interventions, equivalent-trajectory records and outside-scope parity checks passed. The validator initially checked split multiplicity in the original six-creature roster; this was corrected to inspect the actual post-split placement before reading any outcome statistics. No policy, selection or gate changed.

| Comparison                            | Draw-aware score difference | Adjusted 95% interval | Improved / worsened / same |
| ------------------------------------- | --------------------------: | --------------------: | -------------------------: |
| Gaze tie rule versus current R2       |                    +0.93 pp |     −1.32 to +3.17 pp |                7 / 5 / 312 |
| Gaze tie rule versus physical control |                    +0.77 pp |     −1.55 to +3.09 pp |                7 / 5 / 312 |

**Do not promote.** Both uncertainty intervals cross zero, so the registered timing and held-out tests were not run. Seeds **102520413 and 102520414** remain unused. Normal, red-seat and own-Titan-Plate slices had positive point estimates; Lava and green-seat slices did not. These overlapping post-outcome observations do not qualify an exception. The enemy-mind-immune slice happened to improve three games without worsening any, but immunity does not supply a causal reason to prefer a gaze change and is not used as a selection rule.

A separate ability-component calibration replayed five previously omitted singleton shots through the actual action engine, **4,096 independent attack probes per state, 20,480 total**. All five expected gaze contributions agreed with the empirical means within the registered four-standard-error plus half-HP tolerance. They also restored state and RNG/UUID exactly. An initial diagnostic read visible damage events from a headless engine, which intentionally omits those events; its five zero readings were invalid telemetry. The corrected diagnostic temporarily enabled full attack events inside each restored probe and required exactly 4,096 attack payloads per state. The failed attempt remains in the artifacts. These are mechanical checks, not additional full games or strength evidence.

Primary records SHA-256: **1d24431502e840e24944253ef31741bcde29347e54328cfba810ebd757cd5458**. The failed strength gate remains closed. The next distinct hypothesis changes an existing cover slot's source, preserving capacity, spending, other utility splits and matched positions; it does not reuse this primary as fresh evidence for a new rule.

## Experiment 10: assign an existing cover slot to Medusa

The native split planner reserves one cover source, then resolves equal ranged-cover counts in favor of lower creature levels and HP. That makes a conventional physical shooter singleton compete on equal terms with Medusa's stack-independent target-level gaze contribution. This experiment changes the source of an already funded cover slot; it does not combine the preceding unqualified targeting rule with a setup change.

Candidate **medusa-cover-over-physical-fixed-cells-v1** replaces at most one existing cover source with Medusa. Require a unique, small, non-summoned Medusa stack above one creature, not already a planned split source; the old source must be a different native RANGE creature. Require a printed level-4 opponent creature without native mind immunity, read from public creature identity. Preserve aura/support/shield/bait plans, order, slot count, purchased stats, artifacts, synergies, doctrine, combat seeds and ordinary R2/H64 combat decisions. Canonical split materialization handles source amounts and resources.

Both arms use the native army's final occupied cells, measured by an audit that stops before combat outcomes. Every original stack keeps its cell, and the new Medusa singleton occupies the old cover cell. The native split allocation on those same cells is the matched free control. No formation optimization or extra Placement is purchased. This isolates which creature receives the existing slot.

The first six-cohort registration, seed 102520422, **failed outcome-free selection**. Ranked-draft filled only 0/0/0/0/1/0/0/1/1 of the requested six armies in nine budget cells after the full 262,144-pair cap. It stopped before fresh outcomes. This is evidence of narrow applicability in that sampler, not a strength result. The failed design and logs remain archived.

A revised population was registered before fresh combat: **216 independent matchups**, six per four-cohort/nine-budget cell, seed **102520432**. Uniform-mixed, ranged-heavy, flyer-heavy and cross-archetype were the four cohorts with replacement examples in the earlier census. Each cell covers all three maps crossed with both seats and each enemy deployment twice. Twelve no-Medusa/ineligible-Medusa parity conditions additionally cover all six Medusa-capable cohorts, including ranked-draft and caster/support. Total: **456 full fights**. Neither this conditional population nor quota-scanning counts estimate live ranked incidence.

The primary endpoint is the paired draw-aware score versus matched stock, with a two-sided 95% interval by independent army. Require a positive lower bound, at least 30 changed trajectories, all factor cells and no unresolved validity failures. Only a pass permits unchanged fresh seed **102520433**; only both passes permit separate uniform-artifact challenge **102520434**. Broad promotion still requires separately registered 6,000+ games, unbiased incidence measurement, runtime/deadline and authoritative server split-action checks. Cohort/map/artifact slices cannot rescue failure.

Before the primary, **52 full preflight games** matched native unframed, matched-cell stock and proposal-computing shadow records, initial epochs and observed driver trajectories exactly. All fixed placements matched and actions were accepted. A first framing attempt applied the split-placement overlay twice; this is not idempotent and moved an aura singleton by one cell. The corrected harness feeds already-final cells to both arms and skips their second own overlay. Native replay parity then passed. Failed instrumentation logs are retained; no production source was changed.

Committed source e55cf7883f26172c15fc74f3e03ac075f327425c was exported again. Two optional research hooks in the isolated simulation copy expose split plans and pre-match configuration; all 587 source files, the exact instrumentation diff, policy, runner and registration were hashed before outcomes. Output lives under ignored game/core/tmp/analysis/medusa-cover-priority-20261025.

### Experiment 10 result: no observed net gain

All **456 full fights** completed, all by elimination and with zero rejected actions. Every registered factor cell, fixed board cell, conserved creature total, other utility split, setup field, opponent state and outside-scope parity check passed. All 216 cover allocations changed, with **35 improved, 35 worsened and 146 unchanged outcomes**. Their raw driver-trajectory digests also differed, but changed unit IDs mean those digests cannot establish 216 different semantic action sequences. Draw-aware scores were 55.56% in both arms: **0.00 pp difference, 95% interval −7.19 to +7.19 pp**. This is not equivalence; it is a noisy null estimate and a failed improvement gate. Held-out seeds **102520433 and 102520434** were not used.

The old cover source had large descriptive differences: replacing Arbalester was −10.71 pp on 84 armies, Elf +7.94 pp on 63, Orc +5.80 pp on 69. Lava and spread opponents had positive point estimates; Normal and current formation did not. No such exception is qualified. A lower-HP physical singleton is not automatically a worse allocation after accounting for source damage, turn ordering, opponent targeting and forecast variance.

An independent outcome-free incidence audit used every one of **4,032 consecutive pairs in each of seven cohorts**, exactly 448 in every budget cell, seed **102520441**. It observed:

| Synthetic cohort | Applicable armies / 4,032 | Frequency |
| ---------------- | ------------------------: | --------: |
| Ranked-draft     |                         0 |     0.00% |
| Uniform mixed    |                        18 |     0.45% |
| Ranged-heavy     |                        45 |     1.12% |
| Ground melee     |                         0 |     0.00% |
| Flyer-heavy      |                        15 |     0.37% |
| Caster/support   |                         8 |     0.20% |
| Cross-archetype  |                        25 |     0.62% |

These **28,224 unfiltered synthetic army pairs** contain no fight outcomes and estimate sampler incidence only. Zero observed ranked-draft cases has a Wilson upper 95% frequency of about 0.095%, not proof of impossibility. Caster/support had eight cases despite none in the earlier 27-army Medusa census; it is rare rather than structurally excluded. Even a future conditional gain must be discounted by actual live incidence before claiming a broad improvement.

Primary records SHA-256: **bfd6b400bd51c247473b71c4cca607d18f221b9e2e7f7becc9b0d78eb5f0a8e7**. Complete validation, source receipts, failed broad selection, preflight corrections and incidence counts are retained. No experimental profile was enabled.

### Split-comparison variance diagnostic

The simulator derives original unit IDs from combat seed, team, roster index, creature identity and **amount**. A source amount change therefore changes that main stack's ID, and hence its actor-scoped private search seed. Exactly three initial own IDs change in this comparison; every other own unit and the complete opponent remain identical. The recorded primary compares the two canonical simulation configurations, including that ID-dependent forecast variation. It does not isolate split value from this nuisance. The authoritative action engine instead mutates the existing source amount while retaining its ID, then adds the child. The validator was corrected to allow ID differences only in the three intentionally changed units, before reading primary outcome statistics. All positions and other initial fields remained constrained.

A new frozen diagnostic on the same **216 reused armies** crosses the original physical and Medusa armies with both recorded ID assignments. Original arms A/B are retained. New arm C keeps the physical army but assigns the Medusa arm's IDs; new arm D uses Medusa with the physical army's IDs. Twelve unchanged native replays check every original cohort/map cell. Total planned new complete replays: **444**. Optional creation-ID instrumentation changes no default engine path, IDs must be unique and exact, and both within-ID comparisons must share every initial ID and cell. This directly measures ID-only outcome movement and the per-army average strategy effect across both assignments. It supplies development diagnostics, not fresh strength evidence or additional independent armies. No unit/map/artifact exception is fitted.

The **444 full diagnostic replays** completed and passed source, native replay, ID assignment/uniqueness, initial-field, fixed-cell and within-assignment matching checks, with zero rejected actions. Changing IDs alone in the physical army changed outcomes in **53/216** cases: 27 improved and 26 worsened, +1.16 pp with a descriptive 95% interval of −5.22 to +7.54 pp. The two ID assignments changed Medusa-arm outcomes in 64 cases. This is substantial decision noise, not evidence that one assignment is better.

With the IDs matched, Medusa was **−4.17 pp** on the original physical IDs and **−1.16 pp** on the original Medusa IDs. The per-independent-army average across both assignments was **−2.66 pp**, descriptive 95% interval **−7.92 to +2.59 pp**, with 42 positive, 50 negative and 124 zero per-army averages. It did not rescue the split strategy. Ranged-heavy's small positive average also crossed zero. Do not fit an ID, source-creature or map exception from these reused armies.

Diagnostic records SHA-256: **2faeddc70bd1093e389d83304510110d300da389f63bc7c9534b57398b0c55fa**. Registration, immutable source hashes and output are under ignored game/core/tmp/analysis/medusa-cover-id-check-20261025. No further split qualification is funded from this result. The next distinct hypothesis concerns allocating search work to more chance samples for an actual gaze target choice, without changing roster, IDs, setup, shortlists or targeting preferences.

## Experiment 11: redistribute Medusa forecast work toward chance samples

Candidate **medusa-elite-choice-h32-complementary-r4-v1** changes only root forecast allocation when our Medusa has active Petrifying Gaze and the unchanged canonical input catalog offers ordinary stationary shots at two different enemy stacks, including a level-4 stack without mind immunity. It keeps the native catalog, shortlist, action rules, tiebreaks, continuation policy, roster, IDs, split plan, artifacts, positions and spending. Every ineligible decision and every other unit remains native.

Compare three registered arms: stock **H64/complementary R2**, conditional **H32/complementary R4**, and a cheaper conditional **H32/complementary R2** control. R4 uses the existing second actor/lap antithetic pair at indices 2/3, in addition to 0/1. No partial H64 samples are reused. The nominal per-candidate future-turn cap remains 128 for H32/R4, with two extra root plies, but early termination and tail pruning can change actual cost. Equal runtime is not assumed. Short H32/R2 is prospectively registered as a separate candidate, rather than selected after seeing outcomes.

Committed engine **80180ef46464daf3b580e98a2e7f1ebad92a3d87**, including the new passive-barrel fix, was exported unchanged; all 587 source files were hashed. Do not pool this source's strength outcomes with preceding exports. The wrapper changes score-call allocation and records actual samples/future turns; it does not patch the shared source. A proposal-computing shadow returns stock values and restores native material evidence, counters, finished simulation state and RNG/UUID.

The final-source preflight completed **66 full games** over 18 development cohort/map conditions and actual-arm smoke cases. Bare native, instrumented stock and shadow matched complete records, initial epochs and observed driver trajectories. All 2,311 observed root rollout calls had valid complementary mode, sample indices and horizon caps; all real state/random restoration checks passed, with zero rejected actions. No preflight outcome statistics were used for policy tuning.

Primary seed **102520452** selects **324 independent Medusa army matchups**, six per six-cohort/nine-budget cell. The condition for selecting an army is initial Medusa presence only; all chosen armies count even if no eligible target choice arises. Relevant cohorts are ranked-draft, uniform-mixed, ranged-heavy, flyer-heavy, caster/support and cross-archetype. Each cell covers Normal/Lava/Block crossed with both seats and each opponent formation twice. Twelve no-Medusa parity conditions give **1,008 full fights** across the three arms.

The three paired score contrasts are chance-versus-stock, chance-versus-short and short-versus-stock. Use independent army matchups and family-adjusted two-sided 95% intervals for all three (critical z 2.39398). Chance allocation requires positive lower bounds against both controls and at least 20 changed trajectories versus stock/10 versus short. The separately registered short policy requires a positive adjusted lower bound against stock and at least 20 changed trajectories. Cohort/map/artifact slices cannot replace those gates.

Only a qualifying arm may proceed to serial same-state timing on 32 outcome-independently selected eligible roots, requiring an upper 95% time ratio at most 1.10 versus stock. Only strength plus timing permits unchanged held-out seed **102520453**. Uniform-artifact challenge **102520454** stays separate. Broad promotion still requires separately registered 6,000+ games and authoritative server legality/deadline checks. If both arms qualify, prefer the chance arm only if its runtime also qualifies; otherwise consider the qualifying cheaper policy. No unqualified arm is enabled.

Source receipts, registration, final preflight, outcome-free selection and generated records live under ignored game/core/tmp/analysis/medusa-chance-allocation-20261025.

### Experiment 11 result: neither allocation qualified

All **1,008 full fights** completed by elimination with zero rejected actions. Every source hash, factor cell, complete initial epoch/ID/placement match, catalog, shortlist, shared root seed, sample mode/index and future-turn cap passed independent validation. Across matching epochs, **4,146 H32 first-pair samples** reproduced exactly between R2 and R4. Equivalent-trajectory and no-Medusa results matched. **224 of 324** selected Medusa armies encountered the target-choice condition; the other **100** reproduced stock trajectories and complete records in all three arms. All selected armies remain in the primary denominator.

| Registered comparison                        | Draw-aware score difference | Three-comparison adjusted 95% interval | Improved / worsened / same |
| -------------------------------------------- | --------------------------: | -------------------------------------: | -------------------------: |
| H32/R4 chance allocation versus stock H64/R2 |                    −1.54 pp |                      −5.49 to +2.40 pp |              15 / 18 / 291 |
| H32/R4 versus short H32/R2                   |                    −1.39 pp |                      −4.75 to +1.98 pp |              10 / 13 / 301 |
| Short H32/R2 versus stock H64/R2             |                    −0.15 pp |                      −3.80 to +3.49 pp |              14 / 14 / 296 |

The chance policy changed 118 trajectories versus stock and 78 versus short; short changed 110 versus stock. Insufficient activation is not the explanation. Neither prospectively registered policy passed its strength gate. **No serial timing, held-out or artifact challenge was run.** Seeds **102520453 and 102520454** remain unused. This does not establish harm with confidence; it supplies no demonstrated win from these allocations.

More samples did not preserve actual work automatically. Recorded own-Medusa root rollouts totaled 499,504 future unit-turns for stock, 572,574 for chance allocation and 438,395 for short. These totals include diverging real game trajectories and are descriptive, not paired serial timing or authoritative server latency. An equal maximum per-candidate future-turn cap is insufficient to claim equal runtime.

Chance allocation had negative point estimates on all three maps and five of six cohorts; cross-archetype was slightly positive. Both variants were negative against compact opponents and positive against spread opponents, with uncertainty too large to qualify an exception. Ranked-draft was negative in both. Artifact and map slices remain descriptive; no fitted guard or subgroup is enabled.

Primary records SHA-256: **c6266721577fa118d153f5bb126107878b78d20a2f7b1e2da0d9cce7f92ea557**. Source, validation, complete records, closed timing plan and completion receipt are retained. No production source, server dependency or deployment changed.

## What experiments 7–11 established

- **Fresh strength evidence:** 969 conditional-reply fights, 1,008 gaze-tie fights, 456 cover-allocation fights and 1,008 forecast-allocation fights: **3,441 full fights**, separately analyzed by source and population. None qualified. The 444 ID replays reuse 216 armies and do not increase the independent fresh sample count.
- **Correct ability mechanics are insufficient:** the gaze estimate passed 20,480 actual-engine attack probes, yet its simple target ordering and cover allocation did not establish more wins. Expected immediate HP is an imperfect proxy for army-level outcome.
- **Measure activation and incidence separately:** a niche can change many selected fights and still occur rarely in unfiltered armies. Quota-selection scans cannot estimate frequency, and synthetic cohort incidence is not live ranked incidence.
- **Control simulation identity in setup research:** amount-derived IDs can change private search worlds and results without changing the army. Future split/substitution experiments should preserve pre-split parent IDs through the authoritative action path or prospectively cross ID assignments, and normalize action identity before counting semantic interventions.
- **Do not substitute fidelity for strength:** cheap reply search and the specialized ranker failed agreement screens; extra chance samples and shorter forecasts also failed direct fights. The next useful labels should compare retained alternatives through matched continuations of actual A19 play, with real outcomes and declared combat-seed replication, rather than merely imitate another noisy A19 choice. Reuse the existing decision-audit and continuation tooling; freeze the position-selection and sample budget before any new outcome labels.

The research notes passed targeted formatting and whitespace checks. The prior **56 focused safeguard tests** remain the last repository test gate for this continuation; subsequent edits were confined to these notes and ignored standalone research artifacts. No unqualified runtime change was made.

## Experiment 12: retained-action regret under actual A19 continuation

The next diagnostic asks whether a confident search override improves the completed fight when both armies keep using full A19. The existing long-horizon decision audit continues with the cheaper rollout controller; it is useful reference evidence but does not supply this counterfactual. Reuse its source-profile parser, action categories, stable signatures, paired evidence and multiplicity helpers, together with the canonical cohort generator, battle engine and worker pool.

Frozen engine **80180ef46464daf3b580e98a2e7f1ebad92a3d87** uses the checked-out ranked-server profile **a19-material-r2-v1**, parsed from its search, draft and setup sources without importing server runtime or credentials. The receipt records those files and the complete environment. Both teams receive its explicit baseline overrides through the existing `researchA19BaseSearchEnvironment` seam. A plain process override is deliberately withheld from the ordinary stock driver, so an isolated optional pre-match configuration callback is needed in the exported job helper. Failed guard logs are retained. Every real controllable call must verify H64/complementary R2, material-tie arbitration and certified/tight bounds. No shipping engine source is modified.

Outcome-blind seed **102520462** fixes **126 independent army pairs**: 18 in each of seven cohorts, two in each 5/6/7-point budget cell, with balanced maps, physical sides and opponent deployments. Keep only the first own decision in laps 1–3 where the final choice differs from the native incumbent, both remain in the ordinary shortlist, both finish complementary samples 0/1, and the advertised mean advantage is at least **0.05**. No creature filtering, opportunity replacement or terminal label enters selection. The prefix stops before lap 4 when no eligible decision appears; all prefix output omits terminal results.

The frozen rule selected **97 positions**, one per different army: ranked-draft 12, uniform mixed 13, ranged-heavy 14, ground melee 14, flyer-heavy 15, caster/support 16 and cross-archetype 13. The other 29 armies are retained as missing opportunities. Forty selected choices replace a native wait with movement or a move-and-melee action; this is a descriptive action count, not an outcome finding.

For every selected position, rerun the exact original prefix and compare the stock chosen action with the retained native action, executed once through the authoritative battle loop. Preserve the native action-array identity and the loop's normal target-memory semantics. Change only actual combat randomness after the full stock root query, using eight declared matched worlds, indices 0–7; planning seeds and UUID sequence remain unchanged. Every subsequent real controllable turn on both teams runs ordinary full A19. The discovery budget is **1,552 complete continuations**, representing **97 independent positions**, not 1,552 independent armies.

Before fresh selection, **30 full old-army preflight replays** plus seven prefixes verified bare/observational parity, natural chosen-action replay parity, deterministic duplicate private-world parity, exactly accepted root actions, correct server-profile calls and zero rejected actions. All 587 exported source files, instrumentation, policy, runner, profile receipt and registration were hashed before fresh outcomes. Independent selection validation checked all 126 factor assignments, the complete-score eligibility rule and absence of terminal labels.

Only a native alternative that improves at least three discovery worlds and averages at least **+0.25** score receives diagnostic confirmation on **16 new paired worlds**, indices 8–23. Confirmation uses those new worlds alone and the canonical paired sign-flip test, with Holm correction over **all 97 original positions**, including untested positions at p=1. This can establish a concrete forecast error at an old frozen position; it cannot qualify a new policy. No negative row is dropped and any unresolved root, profile, seed, action or termination mismatch stops the result.

Any guard or ranker learned from these development labels needs a new frozen rule and fresh-army strength seed **102520472**, then separate held-out seed **102520473** and uniform-artifact challenge **102520474** if it passes. Earlier failed candidate gates remain closed. Registration, profile correction logs, source receipts, preflight and selection output live under ignored game/core/tmp/analysis/actual-continuation-regret-20261025.

### Experiment 12 result: search helps overall; no individual error passes confirmation

All **1,552 discovery continuations** completed by elimination with zero rejected actions. Full source, initial-state/ID, prefix/root, profile, sample, combat-world and exact action checks passed. The continuations made **89,378 subsequent real A19 decisions**, including 49,455 final search overrides; these are actual battle-loop calls rather than native rollout turns. The chosen search action beat the retained native action by **+4.83 pp**, descriptive independent-position 95% interval **+0.34 to +9.32 pp**. Native was better on 27 position averages, worse on 43 and tied on 27. These results concern the registered early confident-override population, not full-match AI-version strength or all live decisions.

Six positions triggered the unchanged confirmation rule, adding **192 complete continuations** on 16 new paired combat worlds each. All validity checks passed again. No position passed Holm correction over the original 97-position family. Wolf Rider and Wolf reversed their discovery benefit. Two exploratory cases retained larger differences: Fairy wait versus isolated advance was **+46.875 pp** for native, nine improved worlds/one worsened/six tied, raw p=0.02148 and adjusted p=1; Manticore's cohesive move versus a deeper advance was also **+46.875 pp**, eight improved/zero worsened/eight tied, raw p=0.0078125 and adjusted p=0.7578125. Neither is a confirmed error under the registered gate.

Twelve additional old-world observational replays, covering all six cases, reproduced complete records and action trajectories exactly. The canonical committed-health ledger explains selected examples without confusing headless display events with damage: one isolated Fairy lost 973 HP to Troll and Black Dragon before attacking, while the matched waiting branch attacked later in lap 1 at full HP; one forward Manticore fell from 560 HP to 10 before its next attack, while its cohesive-move branch entered its next attack at 560 HP. These worlds were selected after outcomes to illustrate a mechanism and do not establish its frequency or causal average on new armies.

The existing opening-cohesion guard covers tier-4 fast flyers only. Applying its unchanged geometry to lower tiers identifies six exploratory wait-to-move positions; extending the same comparison to a native cohesive pure move adds the second Manticore case. This motivates a new frozen lower-tier formation-preservation hypothesis, not a unit/map/artifact exception qualified from these labels. A broad veto of early search overrides is contradicted by the overall diagnostic.

Discovery records SHA-256: **71f2a840787730e6e7530835c9d8ade8c483804a9335f00b4adbb859a6c240b6**. Confirmation records SHA-256: **d1942ba8363000f2e845c0b3f872a2cc56c911da65af18ea5d9c54e796a69f69**. A separate Python validator independently recomputed private world seeds, complete pairing, eligibility, draw-aware scores, sign-flip evidence, clustered summaries and the 97-position Holm correction. The nine existing profile/audit/isolation safeguards passed with 1,695 assertions. No production policy changed.

## Experiment 13: preserve lower-tier flyer cohesion on opening moves

Candidate **lower-tier-flyer-cohesion-v1** is a fresh hypothesis motivated by the previous development labels. It retains the committed engine and verified ranked-server profile from experiment 12. It changes only a tier-1/2/3 flyer with live steps at least 7 and amount greater than 1, in lap 1, when the native action is exactly a wait or consists only of movement, and the final search choice is a different pure move. Singletons, tier-4 flyers, attacks/casts and subsequent laps retain stock behavior.

Use the existing `isEarlyIsolatingFastFlyerWaitMove` geometry through a readonly view that widens only tier eligibility: current nearest-ally footprint distance at most 2, destination distance at least 4 and increase at least 2. Veto the search move only when it meets that isolation test, the native action does not, and the search endpoint is strictly nearer a living enemy footprint than the native endpoint. This preserves native cohesive movement as well as native waiting, without vetoing an escape. Return the original native array so the battle loop owns its normal target-memory semantics. No unit-name, map, artifact, opponent, catalog, score or setup exception is added.

Before fresh recruitment, **55 full old-army preflight games** across 17 conditions verified complete bare-versus-proposal-computing stock parity, all initial states/IDs/placements, exact nonintervention parity, matching first-intervention states and prefixes, and four deterministic full candidate duplicates. All eight actual vetoes were accepted exactly; 16 readonly geometry observations preserved epoch, random source/UUID, memory and damage stats. Every actual A19 call verified the frozen server profile. No preflight outcome statistic tuned the rule.

Primary seed **102520472** recruits **756 independent army pairs**, 108 per seven cohorts, with 12 in each nine-budget cell. Selection checks initial presence of an eligible flyer only; it runs no turn and reads no terminal label. All 756 armies count whether or not a veto occurs. The 1,153 initial-only scans are quota recruitment, not a live-incidence estimate. All factor assignments passed independent validation: each cohort contains exactly six armies in every Normal/Lava/Block × physical-side × current/compact/spread-opponent cell. Initial eligible stacks cover ten flyer types. Roster, splits, IDs, artifacts, augments, synergies, positions and combat seed match across the two arms.

The fixed primary budget is **1,512 complete full-A19 fights**, stock versus candidate. Require a positive lower bound for the paired independent-army normal-approximation 95% score interval, canonical paired sign-flip p<0.05, at least 30 changed actual driver trajectories, all factor cells and exact accepted interventions, zero rejected actions and completed elimination. No cohort may have a negative seven-cohort Bonferroni-adjusted interval wholly below zero. All negative results, zero-veto armies and descriptive slices stay in the report; a subgroup cannot rescue failure.

Only a passing unchanged candidate may enter serial same-state timing with an upper 95% runtime ratio at most 1.10, then **756 fresh held-out army pairs** at seed **102520473**. Uniform-artifact challenge **102520474** remains separate. Broad promotion still requires a separately registered 6,000+ game qualification and authoritative server action/deadline checks. No profile is enabled by this primary alone.

Policy, runner, primary analysis, registration, baseline profile and all 587 exported source files were hashed before fresh selection or outcomes. Artifacts and the frozen registration live under ignored game/core/tmp/analysis/low-tier-flyer-cohesion-20261025; production source and server pins are unchanged.

### Experiment 13 result: promising, but the exact paired gate failed

All **1,512 full fights** completed by elimination with zero rejected actions. Both validators verified all initial states, IDs, setup, positions, actual seeds, budgets, factor cells, first-intervention states/prefixes and exactly accepted vetoes. The run made 92,961 real server-profile A19 decisions and 437 readonly geometry checks. Candidate changed **86 of 756 army trajectories**, executing 97 vetoes. Every other army reproduced the complete stock result and trajectory.

Stock draw-aware score was **47.3545%**; candidate **48.8095%**. The paired difference was **+1.4550 pp**, normal-approximation 95% interval **+0.0618 to +2.8482 pp**, with **21 improved, 11 worsened and 724 tied** army outcomes. The independently recomputed exact paired sign-flip p-value was **0.0503321937**. The normal interval cleared zero, but the prespecified exact p<0.05 requirement did not. Do not round this into qualification. **The original timing and held-out pipeline stays closed; seeds 102520473/102520474 were not used.**

Six cohort point estimates were positive; ranged-heavy was −0.46 pp, with no seven-cohort-adjusted regression established. Normal was +3.17 pp and Lava +1.19 pp. Block had zero interventions and exact stock parity in all 252 selected armies, which is not a claim of general map equivalence. Green was +2.65 pp and red +0.26 pp. These are descriptive signals to check in an unchanged independent replication, not grounds for a map, side, creature or artifact exception.

Records SHA-256: **08f4ac7e3518d59e86e40906ca0e19e28ed1cc1b1b645db1ab4db8ef52a708f1**. The separate Python validator reproduced exact paired probabilities, all confidence intervals and the failed gate. No runtime timing, original held-out study, artifact challenge or production change followed this result.

## Experiment 14: one larger independent replication, without changing the rule

The small broadly positive effect and disagreement between normal and exact inference near the boundary justify one new, prospectively funded replication. The original failed result stays closed. Do not pool it into a success, tune a favorable subgroup, or keep adding batches until a threshold is crossed.

The complete policy source before initial-only recruitment is **byte-identical** to experiment 13, including all thresholds, scope, native-array identity, readonly checks and execution verification. A saved derivation changes only the recruitment quota from 12 to 24 per cohort/budget cell, seed/prefix and the stronger analysis gate. Reuse the same frozen 587-file engine export, ranked-server profile and validated 55-game preflight. No combat-policy code changed.

New seed **102520482** funds **1,512 independent army pairs**, 216 per seven cohorts, with 24 initial-presence-eligible armies in every budget cell and 12 in every map × seat × opponent-formation cell per cohort. Same initial filter, sequential modulo-9 scan cap, fixed setups and all zero-intervention armies. Stock and candidate require **3,024 complete fights**. No opportunity or outcome may enter recruitment.

Treat the original primary and this single replication as a two-test family. The new result alone must clear a **97.5% paired normal interval** and exact paired **p<0.025**, retain at least 30 changed trajectories and pass all original validity and cohort-regression checks. The original result fails these corrected criteria too. No pooling, subgroup rescue or optional extension is funded if the replication remains inconclusive.

Only a pass opens the separately frozen serial runtime gate, then new equally funded independent confirmation seed **102520483**, which must pass the same strict strength/validity gate. Artifact challenge **102520484** stays separate; original reserved seeds 473/474 stay unused. Broad production promotion still needs the separately registered 6,000+ game and authoritative-server gates. New source, derivation, inherited preflight receipts, protocol, analysis, validator and baseline hashes were frozen before recruitment. Artifacts live under ignored game/core/tmp/analysis/low-tier-flyer-cohesion-replication-20261025.

### Experiment 14 result: the gain did not replicate

All **3,024 full fights**, on **1,512 new independent armies**, completed by elimination with zero rejected actions. Source, complete initial state/IDs/setup/placements, actual seeds, budget/factor cells, readonly observations, exact first-intervention prefixes and every actual veto passed both validators. The run made **186,774 real server-profile A19 calls**, 699 readonly geometry checks and **178 exactly accepted vetoes**, changing 163 army trajectories. Initial-only recruitment required 2,282 scans; all 1,512 selected armies count. All setup and actual-combat seeds were distinct across these and the original 756 armies.

Stock scored **47.8505%**; candidate **47.8836%**. Difference **+0.0331 pp**, prespecified **97.5% interval −1.0490 to +1.1152 pp**, exact paired **p=1**, with **29 improved, 28 worsened and 1,455 tied** outcomes. The larger independent run supplies no demonstrated strength gain. The original borderline point estimate was not sufficient evidence to promote the rule.

The earlier Normal-map and green-side gains did not persist: Normal was −0.79 pp and green +0.33 pp, both uncertain. Flyer-heavy retained a +2.78 pp point estimate, but its seven-cohort-adjusted interval was **−1.14 to +6.69 pp**. Ranged-heavy was −2.55 pp and uniform mixed −2.08 pp, also uncertain. No cohort exception is qualified. Block again had no interventions and exact stock parity in all 504 armies. No broad veto, map/side guard, flyer-only exception or additional batch rescues this result.

**This candidate's protocol is complete and closed.** Its prepared runtime benchmark was never run; confirmation seed **102520483** and artifact seed **102520484** remain unused. Original seeds **102520473/102520474** remain unused too. Records SHA-256: **301852f86fee0de787f80c2838159e21ba3ce88c58fdfe082a1fe7700faacf4c**. All output, unchanged-policy derivation and independent exact-inference checks are retained; no production profile changed.

### Separate structural follow-up: distinguish a missing move from a bad score

Source inspection found the ordinary move cap selects nearest-enemy destinations using Manhattan distance between anchors; ranked A19 sets `SEARCH_MAX_MOVES=1`. Stronger-ranged posture can additionally retain a non-closing alternative, so this is not always a single-move catalog. That cap does not explicitly reserve a cohesive intermediate advance. The existing `retainMoveCandidateBeforeCap` seam already supports role-preserving geometry before capping; no new enumerator is needed to audit this.

Among the seven old development roots matching the new cohesion geometry, six ordinary catalogs contained no additional non-native cohesive closing move. The seventh, ranged-heavy Fairy, already retained such an alternative, so its question is evaluation rather than catalog omission. Manticore's native cohesive move was also retained as the incumbent. This initial structural observation alone did not establish legality or strength.

## Experiment 15: uncapped movement legality audit

Replay the same seven old roots, preserving the complete original initial state, IDs, real prefix, stock choices, root catalogs/shortlists and private samples. Use the existing canonical uncapped move/path enumerator, exact live footprints and canonical private leaf probes for action acceptance. Restore the caller-owned active unit, actual RNG/UUID, target memory and private finished-state fields around the scoring helper, and verify the complete epoch, memory and stats afterward. No future-policy or terminal-result label selects an alternative.

All seven root replays and restoration checks passed. Uncapped enumeration exposed **591 pure move actions**. Of these, **208 additional non-native moves** advanced closer to an enemy while keeping nearest-ally footprint distance below four; all passed actual engine leaf action probes. **207 were absent from the ordinary catalog**, one ranged-heavy Fairy move was already retained, and none was merely discarded during shortlisting. Missing legal choices per root were Mantis 28, Fairy 17, Pegasus 20, Fairy 25, Manticore 50, Mantis 31 and Manticore 36. Native cohesive incumbents remain separate from these additional choices.

This establishes an action-coverage limitation, not a strength gain. It also explains why a binary charge-versus-wait veto is incomplete: the catalog often omits intermediate advances. A stronger omitted action must still beat both existing choices through actual full-A19 continuations. The failed broad guard stays closed. Source/derivation hashes, complete alternative actions and root/legality results live under ignored game/core/tmp/analysis/flyer-move-catalog-audit-20261025.

## Experiment 16: value of one fixed missing cohesive move

At each of those seven old positions choose one engine-accepted missing action by fixed geometry: nearest enemy footprint, then nearest ally, shorter route, canonical signature. Do not use a leaf value or terminal result to choose among the 207 actions. Freeze all seven choices, source and analysis before new outcomes.

Compare stock choice, raw native incumbent and the new move once, followed by ordinary full A19 on both armies. Use **16 matched new actual-combat worlds** per old position under separate namespace `flyer-catalog-counterfactual-v1`, diagnostic seed **102520492**, for **336 complete continuations**. Original root planning seeds and UUID sequence remain fixed. Require exact initial/root/prefix/profile/action checks, completed elimination and zero rejections. No optional extension or pooling with previous worlds is permitted.

Before these fights, seven separate root-only probes query the canonical H64/complementary-R2 evaluator for the already fixed new move, with the original private seed. Every reference and state restoration passed. These probes stop at the root and cannot contaminate the actual-continuation driver or determine the selected action.

Two primary paired contrasts per position compare the missing move with stock and with native. Apply canonical exact sign-flip evidence and Holm correction to **all 14 comparisons**, retaining every sign and all 16 worlds. A locally supported missing action must beat both controls after correction. This is an old-position diagnostic, never new-army policy qualification. The reference mean helps distinguish generation from valuation: a better actual action that the current evaluator also strictly prefers implicates coverage; one it still undervalues requires evaluation/continuation work too. A scalar tie does not settle outer arbitration or guarantee a changed catalog would select it. Registration and the running bounded study live under ignored game/core/tmp/analysis/flyer-catalog-counterfactual-20261025.

### Experiment 16 result: one costly stock choice exposed; no action passes both controls

All **336 complete continuations** passed source, original initial/root/prefix, exact planning and actual-world seeds, profile and action-execution checks. All ended by elimination with zero rejected actions. The branches made **20,692 subsequent real full-A19 calls**. A separate Python validator recomputed the complete 14-comparison sign-flip/Holm family and all pairing/geometry-selection checks. Seven root-only reference probes restored their complete real state. No result is pooled with older worlds or counted as a new independent army.

| Old position            | Missing move minus stock | Missing move minus native | Holm p versus stock | Holm p versus native | Reference missing / stock |
| ----------------------- | -----------------------: | ------------------------: | ------------------: | -------------------: | ------------------------: |
| Uniform mixed, Mantis   |                +37.50 pp |                  +6.25 pp |              0.7031 |                    1 |           0.5104 / 0.5215 |
| Ranged-heavy, Fairy     |               −34.375 pp |                 −31.25 pp |              0.4063 |               0.4063 |           0.9996 / 0.9966 |
| Ranged-heavy, Pegasus   |                 −6.25 pp |                   0.00 pp |                   1 |                    1 |           0.2590 / 0.5937 |
| Ground melee, Fairy     |            **+62.50 pp** |                 +43.75 pp |         **0.02734** |               0.4297 |       **0.4799 / 0.7312** |
| Ground melee, Manticore |                −9.375 pp |                −15.625 pp |                   1 |                    1 |           1.0000 / 0.9982 |
| Ground melee, Mantis    |                +18.75 pp |                 +12.50 pp |                   1 |                    1 |           0.0270 / 0.3268 |
| Flyer-heavy, Manticore  |                +12.50 pp |                  −6.25 pp |                   1 |                    1 |           0.9961 / 0.9988 |

The ground-melee Fairy advance is a **supported improvement over stock at this frozen old position**: ten improved worlds, zero worsened and six tied, adjusted p=0.02734375. Stock won 4/16 worlds, native waiting 7/16, and the fixed missing advance 14/16. The advance versus native had eight improved, one worsened and seven tied worlds; adjusted p=0.4296875. Therefore **zero actions passed the full requirement to beat both controls**. The Fairy result establishes a costly stock choice, not a generally stronger controller or superiority to native waiting.

This position contains both a coverage and a valuation problem. The useful advance was absent before shortlisting, yet when separately scored under the original private H64/R2 seed it received **0.4799**, below the stock dive's **0.7312**. Merely adding candidates cannot be assumed to correct that ranking. In the two positions where the reference did favor the new move over stock, actual point estimates instead worsened; those negative differences are not individually significant after correction. Keep them in the evidence rather than promoting all cohesive advances.

Three extra observational replays of the first world where the Fairy advance beat both controls reproduced the complete outcomes, initial states and action trajectories exactly. They add no sample size. The stock move reached (9,7), lost 617 HP to Troll and the remaining 356 to Black Dragon before attacking. Native waited at (3,13), attacked at full HP later in lap 1 and again in lap 2, but that army still lost. The missing move reached (6,10), stayed three cells from an ally rather than six, and attacked in lap 2 at full HP without taking damage in the first 24 observed turns; its army won. Earlier first contact or an extra early attack alone would not rank these outcomes correctly.

The bounded diagnostic is complete; no extra worlds or new-army qualification followed it. Records SHA-256: **e31ff2e9773c3dc843a052a3903569e065f08eb2df64791e6c852c738f85d187**. The next useful investigation is to locate the first incorrect opponent movement/target prediction inside the cheap rollout continuation, using matched actual-A19 replies and the existing action catalog. A new policy must improve fresh full fights; neither the failed broad veto nor an untested catalog expansion is enabled.

Across experiments 12–16, **6,616 registered complete fights/continuations** were separately analyzed: 1,744 retained-action continuations, 1,512 primary guard fights, 3,024 unchanged replication fights and 336 missing-action continuations. Independent army samples and repeated old-position worlds are kept distinct. Preflight, legality probes and illustrative replays are separate. No production source, AI profile, server dependency, pin or deployment changed.

## Experiment 17: matched chance and identity trace of future replies

Replay the same seven old roots and three fixed actions under the original two complementary actor/lap chance samples. Record the canonical H64 private trajectory, then complete actual matches with either native future decisions or full A19. Match the private sample's initial UUID counter as well as its chance stream: speculative effects can advance that counter between private samples. The original prefixes, root choices, catalogs, private means and profile must still reproduce before this diagnostic continuation begins. The first unmatched-counter attempt remains archived and excluded from diagnostic comparisons.

The corrected run completed **84 continuations** plus **12 one-root repeat checks**. Every full A19 path first changes a decision within zero to seven future turns while the complete pre-decision state and native proposal still match. The Fairy stock branch's first difference is an enemy Leprechaun advancing instead of waiting. Thus the first error in that branch is policy prediction rather than unmatched damage randomness. These 42 branch/sample comparisons reuse seven old armies; they are not 42 fresh samples or strength qualification.

Independent first-divergence validation passed for all 42 comparisons: 34 first differences were enemy decisions, 30 changed native waiting to a pure advance, including 24 enemy advances. Across **2,637 native-control future turns**, actions, health, positions, target memory, damage statistics, UUID counters and chance draws matched. The original private means, roots, profiles and all 587 frozen engine sources reproduced. This validates the early policy comparison while retaining the later whole-epoch discrepancy described below. Corrected continuation records SHA-256: **7d77f3f756368a8e53218c9acc98bd425d95b84db281cb48168846a3cc264ec8**.

Do not claim complete 64-turn mechanical parity for every control. Forty native-control trajectories matched throughout their captured horizon, but two ranged-heavy Fairy trajectories developed later state differences at future turns 32 and 48, after the early full-A19 decision differences. A further exact-record replay localized the latter to one stored aura-power field changing at lap 4; its combat relevance requires separate investigation. The first decision differences precede both discrepancies. Complete raw state/chance/action traces and failed strict-validation logs are retained under ignored game/core/tmp/analysis/a19-rollout-reply-trace-20261025. No later divergent state is used as an exact matched-policy label.

## Experiment 18: model one early enemy melee advance

The distinct candidate **first-enemy-melee-wait-advance-v1** changes future-policy prediction, not the final-action rule. On our first-lap level 1–3 flying stacks with seven or more live steps, amount above one and a native wait or pure move, keep the ordinary catalog, shortlist, H64/complementary-R2 work allocation, evaluator and arbitration. In each private continuation, inspect at most the first enemy native pure wait from a non-mindless MELEE/MELEE_MAGIC stack during lap 1. If the canonical recovery move strictly closes nearest-enemy Manhattan anchor distance, model that one advance and then resume native future decisions. No recursion, named-unit, map, seat or artifact exception; no extra root candidates. The failed cohesion veto remains closed.

A proposal-computing control performs the same bounded move calculation but retains native future decisions. Across **55 development preflight fights** on 17 old conditions, bare stock and this control reproduced complete records and trajectories exactly. Candidate duplicate replays, all initial states, full root restoration and exact private/live action acceptance passed. Twelve unchanged actual trajectories reproduced stock; the five changed trajectories shared their first changed root's state, prefix, catalog and shortlist. All 60 modeled moves were accepted. These development outcomes do not qualify or tune the rule.

Before new outcomes, freeze primary seed **102520512** and **756 independent armies**, recruited only on initial eligible-flyer presence. Twelve armies per seven-cohort/nine-budget cell cover Normal/Lava/Block, both seats and current/compact/spread enemy formations, six armies per joint factor cell within each cohort. All canonical setup, rosters, IDs, splits, spending, artifacts, positions and seeds remain matched. Complete exactly **1,512 full fights** and retain every recruited army, including those without a modeled or actual action change.

Require a positive paired-score 95% lower bound, exact paired sign-flip p below .05, at least 30 changed actual trajectories, no seven-cohort adjusted supported regression and all source/pair/factor/root/action checks. A positive subgroup cannot rescue failure. Only a pass permits serial same-state timing with an upper 95% ratio at most 1.10, then unchanged held-out seed **102520513**. Uniform-artifact challenge **102520514** remains separate and closed. Broad promotion still requires 6,000+ confirmation games, measured live incidence and authoritative server legality/deadline checks. The registered primary runs under ignored game/core/tmp/analysis/a19-first-enemy-wait-20261025; no experimental profile is enabled.

### Experiment 18 result: a real prediction error, an inconclusive correction

**Do not promote.** All **1,512 full fights** completed and independently validated. They represent **756 independent army matchups**, recruited from 1,127 initial-only scans. The 1,512 new setup/combat seeds are individually distinct and share none of the 9,234 seeds found in 4,617 prior selected job tuples. All registered budget and joint map/seat/formation cells, frozen sources, complete initial states, IDs, placements, combat seeds, first changed decision states/prefixes/catalogs/shortlists, sample caps and action checks passed. Every fight ended by elimination with zero rejected actions. All 551 unchanged actual trajectories reproduced complete control records, excluding elapsed time.

| Primary comparison                      | Paired score difference | 95% interval       | Better / worse / same |
| --------------------------------------- | ----------------------: | ------------------ | --------------------: |
| One modeled enemy advance minus control |            **+0.93 pp** | **−1.14 to +2.99** |     **39 / 29 / 688** |

Control draw-aware score was **48.54%**, candidate **49.47%**. The canonical exact paired sign-flip p was **0.4158**. The 39 improvements include six half-point changes, so subtracting improved and worsened game counts is not the score estimate. **205 actual trajectories changed**, exceeding the activation floor, but the interval crosses zero. Neither strength gate passes. The serial timing gate was prepared but never run; held-out **102520513** and uniform-artifact challenge **102520514** remain unused and closed. No extra primary batch, subgroup rescue or runtime claim follows.

| Cohort          | Score difference | Seven-cohort adjusted 95% interval |
| --------------- | ---------------: | ---------------------------------- |
| Ranked draft    |         +1.85 pp | −6.80 to +10.51 pp                 |
| Uniform mixed   |         +0.93 pp | −6.37 to +8.22 pp                  |
| Ranged-heavy    |         +0.93 pp | −5.69 to +7.54 pp                  |
| Ground melee    |         +3.70 pp | −4.15 to +11.56 pp                 |
| Flyer-heavy     |         +1.85 pp | −6.62 to +10.32 pp                 |
| Caster/support  |         −4.63 pp | −11.83 to +2.57 pp                 |
| Cross-archetype |         +1.85 pp | −4.26 to +7.96 pp                  |

No cohort establishes benefit or harm after correction. Normal and Lava point estimates are +1.98 and +0.79 pp, with intervals crossing zero; Block has zero modeled/actual changes and all 252 pairs reproduce stock exactly. Both seats have positive inconclusive point estimates. Initial Manticore presence is +4.00 pp with a descriptive interval of −0.54 to +8.54; Fairy presence is 0.00 pp and Valkyrie −2.86 pp. Opponents with no native mages are +1.73 pp, interval −0.59 to +4.04. Those overlapping unit/opponent slices do not qualify a filter. The five-versus-six budget cell improved six games without worsening any, but its raw paired p=.03125 does not pass correction across the nine budget cells. Complete all-sign unit, opponent, artifact, budget and action-transition slices remain exploratory in the generated report.

The branches made **92,258 real full-A19 calls**, with **1,296 root restoration checks**, 6,531 bounded model queries across both arms and **3,083 exactly accepted private modeled moves** in the candidate. Allocation remained ordinary H64/complementary R2. Branch lengths and proposal costs can differ; equal runtime is not inferred from the nominal allocation or these 12-worker times.

The old Fairy mechanism is reproducible: the greedy proposal exactly matches full A19's first Leprechaun advance in both retained root branches and both chance samples. The corrected forecaster changes that old root from the stock dive to native waiting, keeping its original catalog and shortlist. This verifies a specific prediction/ranking correction, not general strength or superiority to the still-missing cohesive advance.

Four additional observational replays covered the first improved and first worsened primary army in canonical cohort/pair order, both arms. Complete outcomes, initial states and trajectories reproduced exactly; these add no samples. In ranked-draft pair 49, delaying Wyvern changed its lap-2 target from Wandering Mage to Crusader after Angel had engaged Crusader; its first attack retained 640 HP instead of ending at 492, and the army changed from loss to win. In pair 107, stock Valkyrie attacked Abomination immediately, later received Angel's Resurrection and won. The modeled policy instead chose a non-attacking move; Angel resurrected Battle Mage and that army lost. These are coupled support/target/timing illustrations, not proof that one heal or target alone caused the result. Preserving early HP or discouraging charges universally would misread the second case.

This candidate is closed without production changes. The next useful diagnostic is whether native continuations mispredict allied support actions and resurrection targets at those same hypothetical states, alongside enemy replies. Collect matched full-A19 labels before proposing another broad movement rule; a local repair, favorable unit slice or conservative move is insufficient. Primary records SHA-256: **7656f578947c6289809fa43edd2fa45a0c28bdc88f5801b54de8b0c169029667**. Nine existing audit/isolation tests passed with 1,695 assertions. No profile, server dependency, pin or deployment changed.

## Experiment 19: qualify a support predictor before another strength trial

The observed regression does not support a universal resurrection-target repair. In the stock Valkyrie branch, native and searched Angel both resurrect Valkyrie. In the changed branch, native proposes movement while searched Angel resurrects Battle Mage. The improved Wyvern branch also contains an allied Angel attack replacing native waiting. Inspect prediction of the complete support decision before changing another broad movement preference.

Four fixed predictors are compared with ordinary full A19 on identical **actual decision states**: canonical `reswait` routing with full passive reserve, canonical `reswiden` with its existing half-reserve rule, H0/R1 search with shortlist three, and H4/R1 with the same shortlist. Routing variants cannot pre-empt committed attacks/casts. The two old reference games reproduce their complete initial states, records and trajectories; eight separate prefix probes reproduce their original first legal support root and restore state/randomness. No development outcome selects a variant.

Register fresh seed **102520522**, **378 independent initial-own-Resurrection armies**, six per seven-cohort/nine-budget cell. Each budget cell covers all maps crossed with both seats; each cohort has three armies per joint map/seat/formation cell. Recruitment stops before combat. Ordinary full-A19 reference games supply at most the first own support decision in laps 1–5 whose normal catalog contains a legal Resurrection target with dead creatures. No opportunity is reported and not replaced; no chosen action or outcome selects a state.

Each predictor reconstructs that root independently, verifies the complete initial state, actor/ordinal, prefix, root/memory/stats/UUID, ordinary catalog and shortlist, queries once and stops. The teacher is the actual A19 choice at that same state. No query influences another predictor or later real turns. Require at least 80 eligible independent states, a positive four-comparison adjusted agreement interval, Holm p below .05 and ten net additional correct decisions over native. All four model signs and coverage/shortlist misses remain reported. Greatest net correctness chooses among qualifiers, with fixed reswait/reswiden/H0/H4 tie order.

This is a prediction gate, not strength evidence. Only a qualifying predictor may receive a separately registered fresh full-fight trial, measured overhead and held-out confirmation; no model is enabled from agreement alone. If none passes, close the gate without another broad trial or optional audit extension. Concurrent uncommitted snapshot/learning work remains outside the frozen 80180ef4 comparison. Registration, exact source hashes and generated data stay ignored under game/core/tmp/analysis/a19-support-predictor-audit-20261025.

### Experiment 19 result: no predictor qualifies; a shortlist bottleneck is measurable

All **378 fresh reference fights** completed by elimination with zero rejected actions. They yielded **278 independent eligible support states**; 100 armies had no qualifying opportunity and were not replaced. All selected support actors happened to be Angel. The four models completed **1,112 separate matched prefix probes**, with exact initial/root/prefix/catalog/shortlist/identity checks and restored state, active unit and RNG/UUID. All 587 frozen source hashes and all cohort, budget and joint factor cells passed. A separate Python validator recomputed every paired comparison and the complete Holm family.

Preflight work accounting caught that the constructor interprets a zero horizon as its default: the first smoke H0 attempt used 24/36 unintended future turns. Before any fresh predictor queries, set the constructed H0 horizon explicitly to zero, repeat the eight smoke queries and require actual horizon/future-turn count both zero. Failed attempts and the earlier source receipt remain archived. The teacher games, state selection, model intent and statistical gates did not change, and no fresh agreement result guided the correction.

| Predictor | Exact agreement | Rescued / spoiled native decisions | Adjusted agreement gain interval | Holm p |
| --------- | --------------: | ---------------------------------: | -------------------------------- | -----: |
| Native    |  68/278, 24.46% |                                  — | —                                |      — |
| reswait   |  79/278, 28.42% |                             18 / 7 | −0.50 to +8.42 pp                | 0.1731 |
| reswiden  |  74/278, 26.62% |                            24 / 18 | −3.67 to +7.98 pp                | 0.5672 |
| H0/R1/K3  |  79/278, 28.42% |                            49 / 38 | −4.42 to +12.33 pp               | 0.5672 |
| H4/R1/K3  |  83/278, 29.86% |                            48 / 33 | −2.66 to +13.46 pp               | 0.3578 |

**No model qualifies.** The raw reswait p=.0433 does not survive the four-comparison family, and every adjusted interval crosses zero. Do not fund a broad strength trial, enable a support rule, add optional audit samples or treat this as a win-rate gain. Native and model agreement are exact-action predictions on actual support states, not optimal-action or terminal-strength labels.

For both searched predictors, every teacher action was in the input catalog, but **90 of 278 were discarded by the three-action shortlist**: 30 Resurrection casts, 50 move-and-melee actions, eight pure moves and two stationary melee attacks. Among the remaining 188 states, H4 still misranked 105 teacher actions. Thus extra horizon alone cannot repair the omitted alternatives. Its total measured future work was 3,224 unit turns; H0 and both routers used zero.

An all-state structural census found two non-native melee stand choices aimed at the same target in 54 cheap shortlists. Twenty-two lost teacher choices occurred there, but only 12 had a different semantic goal; six teacher choices were themselves the second stand that a naive diversity rule would remove. Do not assume same-target stand cells are interchangeable. A cleaner next allocation hypothesis preserves the ordinary six-action shortlist and halves H4 to H2, retaining the same nominal maximum of 12 child future turns. That is a new candidate needing separate development and fresh qualification, not an extension of these failed four models.

Reference records SHA-256: **1b1d410b459f97d543d21067a925cc1e336c36c4724fb4beb8f668110a9eca32**. Predictor records: **ea2207d38420a960a342a0047274455e13876607cd0c5d844e06b1bcc11b2714**. All 756 new setup/combat seeds are distinct and share none of the 10,746 seeds found in prior selected job tuples. No production source, profile, pin or deployment changed.

## Experiment 20: support prediction work allocation, development only

Reuse the 278 support roots from experiment 19 as development inputs; do not acquire or count new independent labels. H2/R1 with the ordinary six-action shortlist keeps the same nominal twelve-future-turn ceiling as H4/R1 with three candidates. Each root is independently reconstructed and queried once after the real teacher has restored the decision state, then the replay stops.

All 278 prefix/root/restoration checks passed. The wider search retained every teacher action, eliminating the earlier 90 shortlist omissions. Exact agreement nevertheless changed only from **83/278 to 84/278**: ten old errors were repaired and nine correct choices were spoiled. Total child future work fell from 3,224 to 2,758 turns. Fixing coverage alone is insufficient; the new search still misranks 194 available teacher actions. This tiny reused-root gain does not fund fresh qualification or establish game strength.

A separate bounded development diagnostic freezes five allocations before their queries: H2/R1 using the first actor-antithetic sample, H1/complementary-R2, H4/complementary-R2, H16/complementary-R2 and H64/complementary-R2 as a full reconstruction control. All use the ordinary six-action shortlist. The first two retain a twelve-future-turn ceiling, but R2 also pays for a second root action sample. Larger horizons deliberately spend more to distinguish sampling from depth; they are not claimed to be equally fast.

Every model replays the same old actual prefix independently and then stops, retaining all 278 states and every sign. Passive score and rollout capture must leave catalog flags and production bounds untouched. Full H64 reconstruction must reproduce the original teacher action, input catalog and shortlist at every root before interpreting smaller allocations. Exact and semantic agreement, chance mode, work and all cohorts remain descriptive. Any promising allocation would still need separately registered fresh prediction, complete-fight, timing and held-out gates; this diagnostic cannot reopen the four failed experiment-19 predictors. Frozen source remains 80180ef4, while mainline snapshot/learning work proceeds separately. Artifacts live under ignored game/core/tmp/analysis/support-reply-breadth-20261025 and support-reply-allocation-20261025.

### Experiment 20 result: cheap sampling changes do not solve support prediction

The first 1,390-query run exposed a confound: configuring H below 18 also bypasses the existing fast-flyer opening-move guard. Three roots per low-horizon model therefore had a different input catalog. The original attempt, source, raw records and failed catalog validator remain archived. Before a second run, keep configured H64 and change only `turnHorizonForVersion`; this preserves all root decision rules and changes only private continuation depth. No label, model, eligibility, chance seed or threshold is tuned by the correction. Neither attempt adds independent samples.

All **1,390 corrected prefix probes** passed source, exact original initial/root/prefix, catalog, six-action shortlist, identity, state/memory/stats/RNG/UUID and work checks. H64 reconstructed the original teacher action in **278/278** states. Every smaller model kept every teacher action in its shortlist. The source remains the isolated 80180ef4 export.

| Six-action allocation                       | Exact teacher agreement | Same action family and target | Measured future turns |
| ------------------------------------------- | ----------------------: | ----------------------------: | --------------------: |
| H2/R1, first actor-antithetic sample        |          83/278, 29.86% |                       110/278 |                 2,754 |
| H1/complementary-R2                         |          87/278, 31.29% |                       107/278 |                 2,754 |
| H4/complementary-R2                         |          86/278, 30.94% |                       115/278 |                11,016 |
| H16/complementary-R2                        |         115/278, 41.37% |                       145/278 |                44,058 |
| H64/complementary-R2 reconstruction control |                 278/278 |                       278/278 |               148,101 |

R2 additionally pays for a second root action sample, even when future-turn ceilings match. H16 improves agreement descriptively but spends four times H4/R2's future work and still mispredicts 163 actions. Full-depth reconstruction is a validity check, not evidence that the teacher is optimal. Neither a cheap sampling change nor a substantially more expensive inaccurate predictor qualifies another strength trial. **Close this development diagnostic without fresh qualification or production changes.**

The existing short H2 probe casts Resurrection 177 times where full A19 casts it 116 times. Static inspection identifies an unrepresented resource: the leaf's 60 features contain restored HP and remaining shots, but no remaining shared Resurrection charge. This is a plausible valuation limitation, not proof of cause or a fitted value repair. A separate inspection below found concrete mechanical estimate mismatches in the existing native router.

## Experiment 21: mechanically match the existing Resurrection estimates

The router's stated recovery projection omits the attack handler's **1.5 cast-power multiplier**. Its passive reserve uses `floor(total/2)`, giving a singleton zero reserve, while the actual death cleanup revives at least one creature. These are two explicit projection mismatches; correcting them does not enable `reswait`, `reswiden` or any new trigger. Keep the existing commitment rules, reserve weights, spell scope and tie order.

Candidate **mechanically-matched-resurrection-estimates-v1** changes only those two estimates for the controlled physical team, in real native decisions and private native continuations. The opponent keeps stock estimates. Both sides retain the complete H64/complementary-R2 ranked-server search, ordinary catalog, evaluator, arbitration and bounds. The correction switch is installed only after canonical setup; no spending, picks, artifact, split or formation change is permitted. The computing control calculates the exact estimates but returns the original ones. All code remains in an ignored frozen research export, with only caster_router differing from the original 587 source files.

Before fresh recruitment, **96 actual-handler cast cases** and **24 actual-death reserve cases** verified exact recovered HP across both teams, stack sizes, morale factors, Holy Cross, capped restoration and wounded stacks, including singletons. Forty-six complete old-army preflight replays on 14 conditions verified original full-record parity, computing-control complete root/action-array-identity/record parity, matched setup, four exact candidate duplicates, 3,275 root restoration checks, zero rejected actions and elimination. Every first changed decision has an exact shared pre-native state/prefix witness; unchanged trajectories reproduce their full records. These are validation cases, not fresh strength samples or variant selection.

Register primary seed **102520542**, **378 independent initial-own-shared-charge armies** and **756 paired full fights**. Six armies in every seven-cohort/nine-budget cell cover all maps crossed with both seats; three armies occupy every joint map/seat/formation cell per cohort. Recruitment runs no combat and observes no spell opportunity, estimate change or outcome. Retain all selected armies, including zero-intervention cases. All 756 new setup/combat seeds are distinct and share none of 11,502 seeds in prior selections. Source, protocol, analysis and independent validator are sealed before outcomes.

One draw-aware paired-score comparison must have positive normal 95% lower bound, exact sign-flip p below .05, at least twenty changed actual choice/target-memory-ownership trajectories, no supported seven-cohort-adjusted regression and every source/pair/factor/initial/pre-native/root/action/termination check. No optional extension or subgroup rescue. Only a pass permits separately frozen 32-state serial timing, upper 95% ratio at most 1.10; only both passes open unchanged held-out **102520543**. Uniform-artifact challenge **102520544** stays separate and closed. Broad promotion still requires 6,000+ games, current published-source confirmation and authoritative-server integration/deadline checks. Correct mechanics alone does not establish stronger play.

The fixed screen is running under ignored game/core/tmp/analysis/resurrection-estimate-correction-20261025. No production source, profile, pin or deployment changed.

### Experiment 21 result: correct projections, no established strength gain

All **756 full fights on 378 independent armies** completed by elimination with zero rejected actions. TypeScript analysis and independent Python validation passed all sealed sources, initial states, factor cells, matched setup/seeds, pre-native state/prefix witnesses, exact first changed roots, action-array ownership, accepted actions and unchanged full-record checks. The run verified **48,142 real searched roots and restorations**; 1,576 mindless/unsearched turns remained in the actual trajectory ledger. The earlier preflight observer wrongly required every mindless turn to have an A19 call; its failure is retained, and the corrected observer records those turns without changing their policy.

Control scored **46.4286%**, candidate **46.8254%**. Paired difference **+0.3968 pp**, normal 95% interval **−1.0939 to +1.8876 pp**, exact paired sign-flip **p=.7265625**. Five armies improved, four worsened and 369 tied; one regression was a half-point change, so the net terminal-score gain was 1.5 points. **Sixty actual driver trajectories changed.** This clears activation but fails both strength gates. No cohort establishes a gain or regression after the seven-cohort correction. Uniform mixed is descriptively +3.70 pp, adjusted interval −3.27 to +10.68; cross-archetype is −1.85 pp, interval −10.53 to +6.83. Neither supports a conditional exception.

The complete first-change census finds **58 forecast-only final-action changes**, one changed native proposal plus final action, and one action-array-identity change. All nine nonzero terminal differences first changed through the forecast, rather than a different actual native proposal at that root. Correcting the future native estimate can therefore affect melee, ranged and mage choices across both sides; it does not imply that a direct Angel cast caused a result. All changed actors, action-family transitions, opponent types, budget cells, unit presence and artifact IDs remain reported with all signs. These are descriptive, overlapping slices and do not rescue the failed screen.

**Coverage limit:** all 378 initial shared-charge stacks contained exactly two Angels. The singleton reserve correction never activated in these fresh fights or private estimates. This bank evaluates the cast-capacity correction on the stated canonical population; it supplies no singleton-strength evidence. Twelve additional deterministic routing cases verify singleton reserve preservation, useful casts, corrected target ordering, non-burning spell sources, committed attacks, spent charges and opposing-seat scope. They add no independent strength samples. The existing 29 caster/self-resurrection tests and official source-build typecheck pass; nine current audit/isolation safeguards also passed. A generic test-inclusive TypeScript attempt exposed existing fixture errors, while the package's actual build configuration is clean; no unrelated fixture was edited.

**The candidate is closed and remains isolated.** Timing was not started; held-out **102520543** and artifact challenge **102520544** remain unused. Records SHA-256: **c30873fbcc061a938ebb4aa2ecff397f1c8d773879dad98036a04521ecf314a1**. Mechanical correctness is established for the verified projections, but a net strength improvement is not. No production policy, source, dependency pin or deployment changed.

## Experiment 22: price Resurrection recovery and reserve in the same strength units

The previous screen's projection correction changes forecasts but does not establish better play. The native router still maximizes recovered HP minus its own passive HP, without accounting for the value of the restored creature. A19's existing material tie-break instead measures living strength as `exp * HP / maxHP`. This motivates one fixed value rule, not a named-unit or favorable-subgroup filter.

Candidate **strength-weighted-resurrection-surplus-v1** uses mechanically correct recovery multiplied by `target.exp / target.maxHP`, minus the existing passive reserve multiplied by `caster.exp / caster.maxHP`. Require strictly positive surplus and retain the original enumeration-order tie. Non-burning sources keep zero shared-charge cost. Preserve every spell scope, committed-action rule, preemption setting and timing trigger; do not enable reswait/reswiden. The change applies to the controlled team's existing native policy in real decisions and private futures, with full ordinary H64/complementary-R2 search and canonical setup. There are no learned coefficients, extra simulation, new root actions, movement guards or unit/map/seat/artifact exceptions.

Use **two matched controls**: original stock behavior and the unchanged mechanics-only HP router from the closed experiment 21. A candidate must beat both; correcting physical estimates alone cannot be mistaken for an added target-value benefit. Sixty old-army preflight replays on fourteen conditions verify original stock full-record parity, computing-control exact roots/actions/ownership, complete mechanical-control parity with experiment 21, four exact candidate duplicates, matched setup, 4,246 root checks and accepted elimination outcomes. Fourteen additional material-routing fixtures cover high-value lower-HP targets, dimensional reserve cost, non-burning sources, canonical ties, useful small heals, commitment, spent charges and opposing-seat scope. The earlier 120 mechanical and twelve routing cases still pass, as does the source build typecheck. No development outcome tunes the fixed metric.

Before fresh outcomes, seal primary seed **102620552**, **378 independent initial-own-shared-charge armies**, six in every seven-cohort/nine-budget cell and three in each joint map/seat/formation cell per cohort. Recruitment stops before combat and retains all zero-change armies. All 756 new setup/combat seeds are distinct and share none of the 12,258 prior selected seeds. Exactly **1,134 complete fights** fund the three arms. These are 378 independent armies and two correlated contrasts, not 756 independent samples.

Both candidate-minus-control comparisons require positive two-comparison-adjusted 95% lower bounds, Holm p below .05 and twenty changed actual trajectories each. Guard all fourteen cohort/contrast intervals against supported regressions. Require exact source, setup, identity, pre-native input/prefix, first change, restoration, pairing, accepted-action and terminal checks, with a separate Python reconstruction of the complete family. No optional batch, pooled estimate, refit or subgroup can rescue failure. Only both passes open separately sealed serial timing, then equally funded unchanged held-out **102620553**; uniform-artifact challenge **102620554** stays closed and separate. General promotion also requires prospectively funded legal singleton/split coverage, 6,000+ games, current published-engine confirmation and authoritative-server legality/deadline checks. The initial canonical population still contains two-Angel stacks and cannot establish singleton strength.

The bounded primary is running under ignored game/core/tmp/analysis/resurrection-material-value-20261026. Only the isolated caster_router export differs from the 587-file baseline; no production source, profile, pin or deployment changed.

### Experiment 22 result: strength weighting does not qualify

All **1,134 full fights** completed on **378 new independent armies**, with zero rejected actions and elimination throughout. TypeScript and independent Python implementations verified sealed sources, all initial/factor/seed/setup pairs, pre-native state/prefix witnesses, first changed root inputs, action-array ownership, accepted actions and every unchanged full record. The run checked **72,944 real A19 roots and restorations** and retained 1,964 unsearched turns in the actual trajectory ledger. Both primary paired contrasts and the complete Holm family were independently recomputed.

| Candidate minus control  | Paired score difference | Two-comparison adjusted 95% interval | Better / worse / same | Holm p |
| ------------------------ | ----------------------: | ------------------------------------ | --------------------: | -----: |
| Original stock           |              −1.3228 pp | −4.3171 to +1.6716 pp                |         11 / 16 / 351 |  .7513 |
| Mechanics-only HP router |              −0.1323 pp | −3.0561 to +2.7916 pp                |         12 / 13 / 353 |      1 |

Stock scored **48.1481%**, the mechanics-only control **46.9577%**, and the strength-valued candidate **46.8254%**. Neither contrast establishes a gain. Actual trajectories changed in 102 stock comparisons and 97 mechanical comparisons, so failure is not explained by an inactive candidate. No cohort establishes benefit or harm after correcting fourteen cohort/contrast intervals. Ranged-heavy's descriptive +5.56 pp against mechanics-only has interval −6.42 to +17.53 and is only +0.93 pp against stock, interval −12.69 to +14.54. Flyer-heavy is −5.56 pp against both, also inconclusive. A ranged-only exception is not qualified.

The all-case first-change census finds **101 forecast-only final-action changes and one action-array-identity change** against stock; versus mechanics-only it finds 96 forecast-only changes and one identity change. No first change includes a different actual native proposal at that same root. This implicates the effect of the altered native future model on search decisions; it does not prove which future spell caused the outcome or that creature strength is intrinsically the wrong healing metric. Most real full-A19 spell choices are still being predicted with a cheaper policy. A reasonable heuristic target score is insufficient evidence that those replies are modeled correctly.

**Close the candidate without promotion or another batch.** Timing, unchanged held-out **102620553** and artifact challenge **102620554** were never started. Keep this distinct from experiment 21 rather than pooling either sign into qualification. Records SHA-256: **ae692b846db393bc962022478811e50a84f7e1b79d632bfddbac52a6670ca821**. All routing fixtures and source typecheck passed; no production source, profile, dependency pin or deployment changed.

## Experiment 23: validate the support forecast instead of another full-game heuristic

Reuse all 278 actual support roots from experiment 19 as development data, adding **no new independent labels**. The failed value rule's first changes overwhelmingly came from forecasts while the real native proposal stayed unchanged. Before funding another strength trial, test whether the proposed support reply matches actual full A19 at the same state.

Compare exactly three zero-search predictors over the original native proposal and ordinary catalog: legacy HP `reswait` as reconstruction control, mechanically corrected HP `reswait`, and mechanically corrected strength-valued `reswait`. Preserve committed attacks, casts and defend; only wait/movement may be replaced by a positive-surplus Resurrection. No new action, fit, coefficient, filter or additional horizon. Every actual teacher/prefix runs with research projection modes disabled; enable a mode only for its final detached prediction, verify root/memory/stats/active-unit/RNG/UUID restoration and stop. Reconstruct each model independently. The legacy control must exactly reproduce the old predictor on all 278 states.

Freeze a development floor before queries: a new variant must add **twenty net exact correct decisions over both native and legacy reswait** to justify a separately registered fresh prediction audit. Greatest exact correctness selects among qualifiers, with material-before-mechanical tie. Report every sign, false cast, action family and cohort; this reused bank supplies no promotional p-value. A fresh prediction pass would still need a new forecast-use full-fight study, timing and held-out strength gates. If neither meets the fixed floor, close without fresh audit queries or another strength extension. Artifacts remain under ignored game/core/tmp/analysis/support-material-reply-development-20261026; experiment 22 stays closed.

### Experiment 23 result: weighting is insufficient, and the router has a hard action-space limit

All **834 detached queries** reproduced their exact original initial states, prefixes, roots, teacher choices, catalogs and shortlists and restored memory, stats, active unit and RNG/UUID. Legacy reswait reproduced all 278 original predictions exactly. Mechanically corrected HP and strength-valued variants each matched only **75/278** teacher actions, versus legacy **79/278** and native **68/278**. Neither adds the required twenty correct replies over either baseline. The HP variant rescued one legacy error and spoiled five; the strength variant rescued ten and spoiled fourteen. Both remain closed, with no fresh prediction bank or additional strength games.

The strength variant reduced casts made when the teacher did something other than casting from 41 to 31, but correct Resurrection predictions also fell from 32 to 27. Better-looking cast restraint alone does not improve exact reply prediction. Neither formula settles attack/movement choices. Source and raw records remain preserved; query records SHA-256 **f65a8d4834e792c106788f56d43fec33c7a97e9fcbc0c1ece60a8fd889e4e6b7**. No new independent labels or production changes were acquired.

An all-state action-space census supplies a stronger diagnosis than another weight change. These routers can emit only the unchanged native action or, on a noncommitted turn, a Resurrection. Of 278 full-A19 replies, 68 already match native, and only 39 additional teacher Resurrections are reachable under that commitment rule. **Their maximum possible exact agreement is 107/278**, even with perfect scoring. There are 131 mismatched committed proposals they are forbidden to change and forty other searched moves/attacks outside their outputs. In particular, full A19 chooses Resurrection over 27 native move-and-melee proposals, 24 defends and one stationary melee attack. The real searched controller does not treat those native proposals as commitments.

## Experiment 24: represent searched support replies by allowing forecast preemption

This is a new detached forecast model, not a release of the historical rejected actual-native preemption rule. Keep every actual baseline/prefix/teacher call and the shipped commitment setting unchanged. Only the final probe permits the existing canonical router to replace a native attack, defend or cast with a legal, positive-surplus Resurrection. Compare exactly two fixed variants: mechanically corrected HP surplus and mechanically corrected strength surplus. Use the same ordinary catalog and original native proposal, zero child search, no new action, unit/map/artifact rule, coefficient or threshold. Preemption expands the loose representable ceiling from 107 to **170/278**; that is an output-space bound, not measured accuracy or strength.

Freeze **556 independent prefix reconstructions** of the same 278 development roots. Query one model, require all original state/prefix/teacher/catalog/shortlist/identity/restoration checks, reset the research mode and stop. Inherit the already verified 278 legacy reswait predictions by exact raw hash rather than counting another sample. The funding floor remains twenty net exact correct decisions over both native and legacy reswait, with highest correctness selecting a qualifier and strength-before-HP tie. Every model/sign/family/cohort remains reported. Only a pass permits a separately registered fresh prediction audit; strength, timing and held-out gates remain separate. A failed variant cannot get more old-state samples or another full-fight extension.

The bounded diagnostic is running under ignored game/core/tmp/analysis/support-preemptive-reply-development-20261026. No production commitment, profile, source, dependency pin or deployment changed.

### Experiment 24 result: coverage expands, but the forecast casts too often

All **556 separate prefix reconstructions** reproduced the original initial state, IDs, actual prefix, root, teacher, catalog and shortlist; every detached query restored state, memory, stats, active unit and RNG/UUID. The inherited legacy predictions were rechecked by raw hash. No new independent labels were collected.

| Detached predictor        | Exact agreement | Legacy rescued / spoiled | Predicted Resurrection / teacher casts | Casts when teacher did something else |
| ------------------------- | --------------: | -----------------------: | -------------------------------------: | ------------------------------------: |
| Preemptive corrected HP   |          74/278 |                  30 / 35 |                              242 / 116 |                                   133 |
| Preemptive strength value |          83/278 |                  34 / 30 |                              161 / 116 |                                    74 |

Neither adds twenty exact correct replies over native **68/278** and legacy **79/278**. The stronger variant improves only four net legacy predictions. **Close both without a fresh prediction audit or new strength games.** Changing the output-space ceiling from 107 to 170 does not make the score select the right action. The preemptive HP rule heavily overcasts; creature strength reduces that error but does not resolve the tradeoff with attacking, waiting or preserving the charge. These remain detached forecast probes; actual-native preemption was never enabled.

The strength variant's 195 errors separate into **74 false casts**, **38 wrong Resurrection targets**, **29 missed teacher Resurrections** and **54 other wrong native actions**. It correctly predicts 49 Resurrections and 34 other actions. Even an oracle choosing between this prediction and native would match only 105 states; an oracle fixing targets when this model already casts would match 121; both oracle changes together reach 141. These use teacher labels to diagnose limitations and are not implementable policies or fresh strength evidence. Simply reducing casting cannot repair wrong targets and other missing actions.

Records SHA-256: **0b6ea460b28cf2ad26822fcef51a5fa74825db733ec14c9900d06815dea5c8c7**. All raw signs, cohorts, wrong targets, false casts and action-family transitions are retained in the ignored study directory. No production source, profile, pin or deployment changed.

### Source checkpoint for subsequent work

Shared common now includes the separate [rollback graph repair](a19_rollback_alias_research.md) in **6cb91b96**. That repair preserves shared aura references instead of restoring only equal serialized values. Its own registered validation is separate from these strategy trials and makes no win-rate claim. Experiments 12–24 retain their frozen **80180ef4** identity; do not relabel, pool or reuse their old outcomes as fresh confirmation on the repaired engine.

A next reply model needs a complete legal action comparison, including the value of the current attack, cast target, remaining shared charge and turn timing. More reserve-weight changes or a broad commitment veto are not justified by this campaign. Freeze a graph-preserving current baseline and acquire fresh representative labels, including legal singleton/split coverage, before funding another qualification. The completed negative and inconclusive candidates stay outside production.

## Experiment 25: compare complete support actions at the next activation

Freeze published **6cb91b96**, including the shared-reference rollback repair, and recapture the ranked-server source profile. This is a new prediction audit on the repaired engine; experiments 12–24 supply motivation, not fresh confirmation. The actual controller, ordinary catalog, shortlist, H64/complementary R2, material ties, certified tight bounds and canonical setup remain unchanged. A passive shortlist wrapper observes existing enumeration without installing the observer that changes search coverage.

Two fixed detached predictors compare **every ordinary catalog action**, including attacks, moves, spells, waiting and defending, through the actual engine and the root's paired actor/lap R2 chance streams. **Immediate-resource R2** evaluates after closing that action with zero future turns. **Activation-resource R2** lets both sides use their unchanged native future policies until immediately before this caster can act again, including a delayed hourglass activation; a missing actor has a fixed 64-turn cap. Both use living strength `exp*HP/maxHP` plus the exact remaining passive Resurrection payout in creature-strength units for each army. Exact terminal results override the material estimate, and native wins exact ties. Full passive payout is a fixed conservative resource estimate, not a calibrated death probability. No fitted weight, extra root action or unit/map exception is added.

Recruit **378 fresh initial-own-Resurrection armies**, six in each seven-cohort/nine-budget cell, balanced over Normal/Lava/Block, both controlled seats and current/compact/spread opponents, using primary **102620682**. Keep every later no-opportunity army. Take the first own support decision in laps 1–5 containing a legal Resurrection target with dead creatures. Acquire actual full-A19 choices before querying the predictors. Controls are unchanged native, legacy nonpreemptive reswait, and the prior mechanically corrected preemptive strength-surplus model. These are labels for current A19 behavior, not optimal-action or terminal-strength labels. The canonical initial population may still omit true singleton/split Angels; it cannot establish their strength coverage.

Require at least 250 independent eligible armies and, for either new predictor against **both native and preemptive-strength controls**, twenty net additional exact replies, positive four-contrast-adjusted 95% paired lower bounds and Holm exact paired p below .05. A model also fails its scope gate if more than 5% of samples hit the fixed cap. Independently reconstruct all comparisons, signs, cast errors, target errors, cohorts and factor cells. Preserve initial/identity, prefix, actual teacher, complete catalog/features, shortlist, value **and reference-graph** restoration, target memory, damage statistics, active unit and RNG/UUID; reject illegal probes, rejected actual actions and censored teachers. Reverse model order in preflight to exclude query contamination.

Fourteen plain and fourteen observed complete preflight games matched every initial, actual-action/array-ownership, accepted-turn and final-record witness. Detached preflight queries are checked in both orders. The full registration, frozen archive and raw records are under ignored game/core/tmp/analysis/support-opportunity-cycle-20261026. A failed predictor closes without extra batches or subgroup rescue. Only a pass opens untouched prediction confirmation **102620683**. Forecast-use strength, legitimate paid-capacity singleton/split coverage, broad qualification and timing require their own prospective design. No production source, profile, pin or deployment changed.

### Experiment 25 result: timing helps reply prediction, but neither model qualifies

All **378 new complete teacher fights** ended by elimination with zero rejected actions. There were **276 independent eligible support states** and 102 fights without an opportunity; none were replaced. The 276 separate prefix reconstructions supplied **1,380 detached predictions**. TypeScript analysis and independent Python validation passed all frozen sources, factors, initial identities, prefixes, teachers, catalogs/features, shortlist, graph/value restoration, action legality and work checks. There were 2,546 root-restoration checks. Twenty-five current audit/isolation/rollback/Resurrection tests and the frozen source-build typecheck passed.

| Predictor                   | Exact replies | Correct Resurrection / other | False casts / wrong targets / missed casts | Future simulated turns |
| --------------------------- | ------------: | ---------------------------- | ------------------------------------------ | ---------------------: |
| Native                      |        64/276 | 7 / 57                       | 4 / 7 / 96                                 |                      0 |
| Legacy reswait              |        68/276 | 21 / 47                      | 31 / 10 / 79                               |                      0 |
| Preemptive strength control |        80/276 | 47 / 33                      | 82 / 21 / 42                               |                      0 |
| Immediate-resource R2       |        79/276 | 39 / 40                      | 46 / 18 / 53                               |                      0 |
| Activation-resource R2      |       100/276 | 43 / 57                      | 38 / 13 / 54                               |                 90,703 |

Immediate action valuation does not beat the stronger zero-search control: **−0.36 pp**, four-contrast-adjusted 95% interval **−5.88 to +5.15**, Holm p=1. Against native it adds fifteen exact replies, below the twenty-reply floor, with adjusted interval **−2.98 to +13.85 pp** and Holm p=.2658. It is closed.

Activation timing adds **36 net correct replies over native**, **+13.04 pp**, adjusted interval **+4.01 to +22.08**, Holm p=.00214. That is a supported improvement in matching current A19 on this population, not a win-rate improvement. Against the stronger preemptive control, its twenty-reply gain is **+7.25 pp**, adjusted interval **−0.48 to +14.97**, Holm p=.07955: the required second contrast fails. In addition, **263/4,770 samples (5.51%)** hit the registered 64-turn cap, exceeding the 5% scope gate and affecting 48 states. Do not move the cutoff or select only uncapped states. **Close this predictor too; confirmation 102620683 stays unopened.**

The complete error census makes the remaining problem concrete. Activation rescues 43 immediate-model errors and spoils 22 correct replies. Its gain over the stronger control comes from 24 more correct noncasts while losing four correct Resurrection replies. Of the control's 82 false casts, 73 states contain a current attack and 34 price an attack above that cast under the immediate model; nevertheless immediate valuation repairs only ten exactly, activation fifteen. Foregone attacks explain part of overcasting, while target choice and future timing remain unresolved. The activation model still makes 54 missed casts, 38 false casts, thirteen wrong targets and 71 other wrong actions.

All 276 actual teacher actions were present in **both** the ordinary catalog and shortlist. In this bank the remaining errors are evaluation/arbitration errors, rather than missing support actions or shortlisting. The naive native-or-any-Resurrection output ceiling is only 167/276; expanding to the complete catalog removes that representational limit but does not make the resource score choose correctly. All initial shared-charge stacks again contain two Angels, so there is no new true-singleton/split strength evidence.

Reference records SHA-256 **f02ff98dfbb890774afc264a3b1e8056e488778635323926ba5360986cbbb723**; query records **0684ac0f42edc379c88f6b7ea366c6d725c33e1c087e774eef76669da0d632fe**. Both candidates remain outside production. No fresh strength game, timing qualification, dependency pin or deployment followed this failed prediction screen.

## Experiment 26: price the timing model against ordinary search work

This diagnostic reuses **all 276 experiment-25 roots**, adding no independent labels, promotional p-values or strength games. Experiment 25 remains closed. Compare ordinary **H16/R2/K6** search with its unchanged learned leaf and policy arbitration against a full **H64/R2/K6** reconstruction control. Keep the configured horizon at 64 to preserve the flyer guard; change only future-turn depth. Disable certified bounds in these two references to obtain complete deterministic work counts. Both must exactly retain each original ordinary catalog and shortlist; H64 must reproduce every actual teacher action and native-array ownership.

Separately observe every unchanged activation-resource sample after execution, before restoration. Match all 4,770 original samples, candidate order, chance index, values, cap/activation/terminal stops, means and chosen actions. Record whether a capped branch still contains a living caster, its charge and HP, current lap, active unit and remaining stacks. This distinguishes the intended fixed cap after the caster disappears from a queue/activation defect. The observer cannot change the policy or cap and must pass the original graph/value/identity/auxiliary-state restoration checks.

Three functional roots passed both exact controls before the full measurement. Freeze source/tool receipts and the reused-bank hash under ignored game/core/tmp/analysis/support-resource-cost-reference-20261026. Report all exact-reply and deterministic future-turn counts without treating elapsed time as latency evidence on the shared host. Any teacher-parity, original-cycle or source mismatch invalidates the diagnostic. There is no post-result horizon sweep, cap retuning or confirmation-bank opening; no production source, profile, pin or deployment changes.

### Experiment 26 result: ordinary shallow search buys more accuracy per future turn

All **276 complete prefix reconstructions** passed the inherited frozen-source, initial/root/reference-graph, original-cycle-sample and ordinary-catalog/shortlist checks. Full H64 reproduced **276/276 actual teacher actions and native-array ownership**. No new independent labels or strength samples were acquired.

Ordinary **H16/R2/K6 matched 117/276** teacher replies using **44,768 simulated future turns**, versus the closed activation-resource model's **100/276** and **90,703 turns**. It rescues 65 cycle errors while spoiling 48 correct replies, a descriptive net seventeen. Full H64 uses 147,670 future turns. These are deterministic simulation-work comparisons on the identical roots; they do not establish elapsed/CPU speed or stronger actual play. The resource cycle model is therefore inferior to this ordinary shallow reference on both recorded exact accuracy and future-turn work. Do not fund another resource-weight or actor-cap variant from this bank.

Every one of the **263 capped samples** has the caster **absent from the holder** and no active unit. They arise after 204 move-and-melee actions, seventeen melee attacks, 32 Resurrections, nine moves and one obstacle attack. This is the registered cap continuing after the actor has died, rather than a living caster lost in the turn queue. It explains the model's variable time horizon without excusing its failed gate or authorizing a higher cap.

Records SHA-256 **59c54dce5c7f58d6dd5caf737b6d6782f42365d13f8373c13ade895071cb9b90**. The repaired engine and exact probe controls hold; the remaining gap is strategic prediction. The next useful strength test should preserve the existing valuation and spend search precision on the difficult legal support choice, rather than invent another static healing surplus.

## Experiment 27: independent precision on an existing legal Resurrection choice

Keep the published repaired engine, captured ranked-server profile, ordinary native policy, learned leaf, catalog, six-action shortlist, root guards, H64 depth, future model and setup. After the ordinary complementary R2 scoring pass, refine **only the controlled team's actual caster turn** when that actor still holds a Resurrection charge and the retained shortlist contains a legal Resurrection on an ally with dead creatures. Recompute the **whole retained shortlist with eight independent samples** from the existing reference seed bank; do not reuse the complementary prefix. The ordinary policy gates and material-tie arbitration consume the R8 evidence. Every other scoring pass returns its original array by reference.

This is one fixed mechanic-based trigger, independent of the scores. It is not a rescue of the separately failed midpoint-refinement rule, either closed resource leaf, or native-cast preemption. It uses no creature name, opponent, artifact, map, seat, value weight or handpicked score threshold. It does not change the native future policy. The implementation exists only in ignored game/core/tmp/analysis/support-precision-strength-20261026; there is no production import, registration or environment switch.

**Fifty-eight complete functional games passed** before fresh labels: fourteen stock conditions exactly reproduce the repaired engine, fourteen discarded-computation controls reproduce every stock root/action/ownership/final record, fourteen candidate games preserve setup and legal execution, four candidate duplicates match, and six forced-refinement games exactly match independent full-R8 reference games across all three maps and both seats. There were 3,722 checked real roots, zero rejected actions and elimination throughout. Discarding R8 explicitly restores the R2 material evidence and private driver/counter fields. Every real root verifies board values, shared references, target memory, damage statistics, active unit, unit identities/order and RNG/UUID restoration.

Before combat, seal primary **102620692**, **756 independent initial-own-remaining-Resurrection armies**, twelve per seven-cohort/nine-budget cell and six per joint map/seat/current-compact-spread cell per cohort. All 1,512 selected setup/combat seeds are distinct and share none of the 13,770 inspected prior selected seeds. Keep every no-trigger and zero-change army, canonical paid capacities, splits, stack amounts, artifacts, augments, doctrines and synergies. This conditional population does not establish coverage for manually split single Angels or non-native stolen-charge setups.

Fund exactly **1,512 complete fights**, stock and candidate per army. The one primary paired comparison requires **at least +2 pp**, positive normal 95% lower bound, exact paired sign-flip p below .05, forty changed actual trajectories, no seven-cohort-adjusted supported harm, and every source/manifest/factor/initial/pre-native/first-change/restoration/action/terminal gate. Every unchanged action/ownership trajectory must reproduce its full ranked record except elapsed time. Stream raw completions; inspect strength only after the complete fixed bank. Independent Python reconstruction covers the complete evidence family and all first changes.

Failure closes the candidate without a larger batch, sample/horizon sweep or subgroup rescue. Only a pass funds separately sealed two-bank uncontended elapsed/CPU cost, ratios at most 1.25 in both reversed orders, followed by equally funded unchanged confirmation **102620693**. Uniform-artifact challenge **102620694** stays separate. General release still needs 6,000+ qualification games, legal singleton/split and stolen-charge coverage, current-source confirmation and authoritative-server legality/deadline checks. No production source, profile, dependency pin, push or deployment changed.

### Experiment 27 interruption: an incomplete correctness failure, not a strength result

The fixed screen stopped after **293 completed full records**, with both stock and candidate requests for one army failing the mandatory root-graph check. The retained request is uniform mixed, pair 453, seed 102620692, Normal, controlled green, compact opponent. Reproduction in **stock, candidate and discarded-computation control** fails identically on the opposing **Arachna Queen, searched ordinal 26, lap three**, with **no R8 refinement on that root**. Serialized board values match; the differing edges are shared `unitProperties.synergies` arrays linking units to each other and to `FightProperties.synergiesPerTeam`.

**The incomplete bank supplies no admitted strength estimate.** Preserve the full 293 records, manifest, failure and all three graph-edge censuses. Close this source/seed attempt as invalid rather than dropping the case or weakening the graph gate. Confirmation 102620693, artifact challenge 102620694 and the prospectively written first-changed-choice outcome diagnostic remain unopened. A new source and fresh registration are required before retrying a strength screen; the selective precision rule itself has no valid strength verdict from this attempt.

The existing 6cb91b96 repair correctly preserves shared aura owners. A separate first-touch gap remains for synergy string lists: replacing a touched unit/fight field bag clones its list while untouched owners retain the original. The local repair journals these small lists in place, preserving their contents and original relationships without copying untouched unit bags. Independent equal lists stay independent; empty and sparse lists and unchanged frozen arrays are covered. Seven direct regressions fail against the old checkpoint implementation; the existing full-snapshot control passes. All eight new tests and the full **7,206-test common build** pass with the repair. The actual strategy and creature rules are unchanged.

Final validation is separately sealed under ignored game/core/tmp/analysis/synergy-checkpoint-repair-20261026, using published **9dde84d1** plus the snapshot fix, one archive-only server-profile instrumentation seam and the new tests. It requires four exact original-case replays, 252 fresh checkpoint/full-snapshot replays across every seven-cohort/map/seat/opponent-formation cell, 28 additional reused support-R8 replays, independent hash/manifest/root/trajectory reconstruction and isolated ranked-server TypeScript/API compatibility. These are rollback-correctness checks, not a new AI win-rate comparison. This task has not published the repair, moved dependency pins or deployed it.

### Rollback repair result: all registered correctness checks pass

All **284 complete replays** passed: 142 exact checkpoint/full-snapshot pairs, including the four original-case runs, 252 runs on 126 fresh balanced armies and 28 reused support-R8 runs. The 252 fresh setup/combat seeds are distinct and reuse none of the 15,282 inspected previous selected seeds. Every game ended by elimination with zero rejected actions. Both modes match complete root inputs/reference graphs, native proposals, final chosen actions/native-array ownership, speculative precision evidence/work and full ranked records except elapsed time. The run verified **17,256 real searched roots and restorations**. Independent Python reconstruction passed all source/tool hashes, manifests, factor cells, pairings and complete records.

The isolated full common build passes **7,206 tests**, TypeScript and generated/JSON copies. Targeted lint and formatting pass. The isolated server export uses the exact fixed source and compiled snapshot module with one shared dependency tree: server TypeScript and **890 ranked API tests pass**, with 45 skipped tests. No credentials, actual server dependency installation, manifest or lockfile were changed. A first validation setup omitted the archived profile seam and was rejected before any complete game; its receipt and log are preserved, and the final sealed build and replay bank include the seam explicitly.

The fix preserves original synergy-list objects and restores changed contents in place without capturing untouched unit bags. It does not establish a stronger strategic policy or a production latency improvement. The incomplete R8 strength bank, its reserved confirmation/artifact channels and the unused first-choice outcome diagnostic stay closed. Existing experiments retain their recorded source identities; none is relabeled as post-repair strength evidence. Review the [repair report](a19_synergy_rollback_research.md) and the source/tests before publishing a new common commit and registering fresh strategy outcomes.

## Experiment 28: one-point augment choices under independent combat randomness

The [coverage census](a19_frontier_priorities.md) identified an action-space gap: the captured setup
offers two spending templates per budget and never buys Empower. Freeze 9dde84d1 plus the validated
synergy-list repair, the exact captured server profile and legal v4-w16-r4 ranked drafts. Twenty-seven
offer boards supply both draft seats and battle mirrors across own budgets 5/6/7, rotating opponent
budgets so every map/budget joint cell has twelve cases. This is a balanced diagnostic; the source-default
v0.8 doctrine itself uses seven points.

Keep each original split roster, free formation, artifacts, synergies and opponent plan. Evaluate the
incumbent and every legal one-point Armor/Might/Sniper/Empower/Movement transfer: **2,592 discovery
fights over 324 cases**. Lock the highest terminal discovery result, retaining the incumbent on ties.
Then run **648 fresh-actual-RNG validation fights**, including duplicate controls when unchanged.
No unit, map, item or outcome filter and no changing choices during validation.

Discovery's apparent gain of **+33.1790 pp** fell to **+1.2346 pp**, whole-board 95% interval
**−2.1605 to +4.7840 pp**, exact paired p **.62890625**. It fails the +2 pp, positive lower-bound and
p-value gates. All 27 boards activated; 110 plans changed, giving 24 better and twenty worse validation
outcomes. All 214 unchanged choices reproduced full validation traces and root inputs exactly.
The seven-point slice was −0.4630 pp; exploratory Block and Armor-to-Movement signals cannot rescue
the failed primary or authorize a conditional policy.

All **3,330 admitted full fights**, including ninety control replays, ended by elimination with no
rejected or censored game. They supplied **172,275 actual searched-root restoration checks**.
Independent source/seed/neighbor/factor/choice/pairing verification and all 43,800 opening-unit checks
passed. JavaScript and Python reproduce the complete sorted bootstrap distribution and exact p-value.
For every fixed plan, complete initial state/graph/geometry matches across phases, yet the unchanged
incumbent changes terminal outcome in **118/324 cases (36.42%)** when actual combat RNG changes.

Close this fixed single-fight selection procedure without fitting a selector, opening another bank,
promoting a favorable slice, or running qualification/confirmation. It is not a mathematical upper
bound on optimal expected-value setup, and its failure does not prove that every one-point change is
bad. No new policy qualified. Detailed gates, preserved admission attempts and all-sign slices are in
the [experiment report](a19_augment_transfer_research.md); raw output stays ignored under
game/core/tmp/analysis/augment-transfer-headroom-20261026. The snapshot repair was separately
published as 331c53ba during collection; the sealed study's engine bytes remained unchanged.

## Experiment 29: all-loss diagnosis and an Armor-preserving Movement hypothesis

After the request to examine losses and continue, preserve experiment 28's negative verdict. Replay
all twenty worsened and 24 improved validation cases, both plans, under the original exact seeds.
Two admitted instrumentation modes and their controls reproduce all actual choices and states:
200 diagnostic replays and 11,789 root restoration checks. Six of eleven Empower regressions never
realize offensive damage; three Empower improvements also have no output. Two of four Movement
regressions gain early physical attacks. These are failed proxies for a winning setup selector.

A new fixed rule exchanges the single Might point in P0 A3 M1 S3 V0 E0 for Movement, preserving
both Armor and Sniper. Other own templates remain unchanged. It uses no hidden opponents, map,
identity or combat outcome. Normal full setup/placement runs with the plan chosen before combat.
The separate untouched primary has 48 offer boards, crossed maps/seats/sides and two actual combat
streams: 1,152 paired cases / 2,304 fights. A further 576 fights test opponent budgets five and six.
Seventy-two opening checks and 84 full preflight fights pass, including independent seed/funding/
buff/supply/occupancy reconstruction. Fresh strength collection is in progress; partial outcomes
cannot qualify the rule. See the [full design and loss cases](a19_augment_loss_mechanisms_research.md).
