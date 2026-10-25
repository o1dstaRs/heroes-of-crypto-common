# Ranked replay strategy research

Status: three placement experiments remain unqualified. A larger fresh opening-spell comparison found no reliable benefit from unconditional Mass Riot or a deeper paired recheck. Controlled continuations confirmed that the native rollout policy can rank the spells differently from later A19 play. No experimental policy is promoted. The next target is modeling later ranged/caster decisions more accurately within a fixed search budget; artifact and purchase fit remains queued.

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
