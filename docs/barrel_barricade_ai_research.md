# Barrel Barricade AI research

Status: research only. The default AI has not changed.

Barrel Barricade gives the army two one-hit deployment obstacles. Production deployment already avoids
friendly shooters' forward files, and A19 can attack public barrels to clear a shot or route. A barrel
that blocks an enemy can also obstruct its owner, so neither more barrel attacks nor fewer blocked
opening shots establishes an improvement in battle results.

## Candidates

`productiveBarrelCoverAlternative` preserves an owned barrel and takes an existing legal ranged shot
when removing the barrel improves no ally's best available stationary shot. It uses the combat aim
enumerator and a read-only counterfactual. Movement plans, clearing a genuinely blocked ally, and enemy
barrels retain their original behavior. This candidate changed no decisions in a 56-fight structural
smoke and remains disabled.

`planBarrelCasterCover` uses only its own deployment area and deployed army. It puts both barrels in the
immediate forward contact ring of direct-damage spellcasters, preferring valuable stacks. Every chosen
cell must be useful, free, and legal. It excludes a friendly physical shooter's entire opening cone
toward the opposite half of the board, rather than checking hidden enemy positions. If no safe pair
exists, stock deployment remains. Unit formation, splits, artifacts, augments, and expenditure do not
change. The helper is not connected to a production strategy or the public game API.

## Qualification protocol

The caster candidate's 56-fight structural smoke contained only four caster-owned seats and changed
two deployments. Before comparing aggregate battle scores, the qualification sample was amended to
use fixed pre-combat roster quotas. The rule itself did not change. The original source and registration
remain preserved with their smoke output.

Each qualification stage contains 576 fights:

- 120 independent caster-army matchups: three live maps, two Barrel ownership conditions (candidate
  only or both armies), two opponent formations, and ten armies per condition.
- Twelve no-barrel and twelve owned-barrel/no-caster matchup controls. Their paired action traces must
  remain identical.
- Four fights per independent matchup: control and treatment in both physical seats, with identical
  rosters, combat seeds, artifacts, augments, splits, and funding.

Opponent formations are the ordinary deployment or a legal reflection across the cross axis. A
reflection never enters the placement policy's inputs. Illegal reflections keep the stock formation
and are recorded. Current behavior and the matched free-formation control coincide because the only
intervention is the two free barrel cells; count this control once.

The primary endpoint is the mean paired draw-aware score difference, averaging both seats within each
independent army matchup. Promotion requires a positive paired 95% lower confidence bound and a
two-sided exact sign-flip p-value below 0.05, independently in screening and fresh confirmation. There
is one candidate and one primary population. A favorable subgroup does not qualify a failed primary
comparison. Engine rejections, incomplete games, changed control traces, or source drift invalidate
the run. Authoritative placement routes and decision latency must also pass before enabling a rule.

The existing [placement promotion requirements](placement_research_promotion.md) continue to apply.
Neither a research helper nor passing structural tests grants permission to change a shipped profile.

## Source and reproducibility

The qualification source starts at common commit `2367685b388dab6cc1072cc30504296c84d6edba`, plus the
explicit Barrel research files. Unrelated in-flight draft/audit changes are excluded. The source
fingerprint is `42f09c0d46e45d4d4bd80fb7b76df4e54180c2a8b1e19d23e699aa4507454d8f`.
Screening uses seed `2026101824`; confirmation reserves `2026101825`. The canonical
`barrelComparisonPlan`, meta-army generator, persistent worker pool, and full A19 fixed-work profile
run the battles. Each shard checks the source, runtime, registration, driver, and request hashes.

Untracked registrations, frozen sources, and results live under the client repository's
`game/core/tmp/barrel-caster-qualification-20261018`. The 9800X3D campaign uses eight low-priority
research processes on Bun 1.3.14, separate from live services. Generated results are not game assets
and are not committed.

## Front-caster result: not qualified

All 576 screening fights completed by elimination without rejected actions. The sample contained 120
distinct primary armies and matchups, spanning all seven cohorts. All 48 negative-control seat pairs
had identical action traces, and all 288 requested opponent reflections were legal and applied.

The primary control scored 54.17%; front-caster cover scored 53.13%. The paired difference was
**−1.04 percentage points**, with a 95% interval of **−5.32 to +3.24 pp** and exact two-sided sign-flip
`p = 0.703669`. An independent Python calculation reproduced the clustered estimate, interval, and
exact test from the raw results. The candidate changed 79 deployments and reduced the recorded
blocked opening shots, but did not establish a battle-score gain. **Do not enable it or run its
reserved confirmation as if it had passed.**

## Landing-cover follow-up

`planBarrelLandingCover` is a separate, unqualified candidate. It requires an own direct-damage caster
and a large flying enemy in the public roster. It considers the whole contact ring and actual public
enemy footprint shapes, with no enemy positions, stack amounts, artifacts, or augments as inputs.
Each possible barrel pair scores the fraction of otherwise free melee landing anchors it blocks,
weighted by own stack XP and the enemy's printed XP (flying 1×, ground 0.25×). Squared coverage and a
complete-coverage bonus favor closing the remaining landing gaps. It changes stock barrels only for
strictly greater protection, preserves friendly physical opening cones, and cannot newly seal every
one-step movement exit of any ally.

The complete-coverage fixtures use the engine's legal anchor routes and whole-footprint occupancy,
including 1×2, 2×1, and 2×2 flyers on both teams and all maps. The planner precomputes footprint masks;
evaluating a pair allocates no footprint arrays or Sets. Its optimized result matched the original
geometric reference in 1,000 independently generated setup cases.

The first follow-up source and its 24-fight structural smoke are preserved separately under
`game/core/tmp/barrel-landing-qualification-20261018`. An additional engine regression found that its
exit check counted an empty diagonal destination even when the body's swept corners were blocked.
The screening run was stopped after 374 fights, before an aggregate outcome comparison. Its partial
results are excluded from qualification, regardless of their scores.

The corrected guard checks swept orthogonal footprints for multi-cell exits. Destination-only
baseline mobility remains an upper bound, so a phantom baseline exit cannot make the guard permit
immobilizing a previously mobile ally. Eight engine regressions cover mirrored and rotated rectangular
and square bodies at the blocked corner.

The corrected registration, frozen source, and output are separate under
`game/core/tmp/barrel-landing-v2-qualification-20261018`. Its source fingerprint is
`064fe3007f11814e18548ec278216dfedc39bd2b6ea80e0b441f62e9444ab2be`.
Screening uses fresh seed `2026101846`, with fresh confirmation reserved at `2026101847` only after
passing screening. The old partial data are never pooled with this run.

Each full stage has 120 primary independent armies across the same three-map, two-ownership,
two-opponent-formation matrix, plus twelve pairs each of no-barrel, no-caster, and caster armies without
a large flyer to face: **624 fights**. Opponent reflection alternates by the full canonical cohort cycle so
each cohort can exercise either formation. Selection is fixed from rosters before combat.

This is the task's second full placement comparison. It therefore requires a family-adjusted 97.5%
paired interval with a positive lower bound and exact two-sided `p < 0.025`, independently in screening
and fresh confirmation. The default AI remains unchanged unless all promotion requirements pass.

## Corrected landing-cover result: not qualified

All 624 fights completed by elimination, without rejected actions. There were 120 distinct primary
armies and matchups, all seven cohorts were represented, all 72 negative-control seat comparisons had
identical action traces, and all 312 requested opponent reflections were applied. Source, runtime,
driver, registration, and request identities passed validation. The candidate changed 194 deployments.

The control scored 54.79%; landing cover scored 50.21%. The paired difference was **−4.58 percentage
points**, with a family-adjusted 97.5% interval of **−11.66 to +2.50 pp** and exact two-sided
`p = 0.169139`. An independent Python calculation reproduced the per-army difference, adjusted
interval, exact test, and all negative-control trace checks from the raw results.

Recorded blocked opening shots fell from 169 to 47, yet battle score did not establish an improvement.
That proxy cannot justify enabling this rule. **Neither placement candidate qualifies for confirmation
or promotion.** Both remain outside the public game API and default battle engine, enforced by
`test/ai/placement_research_isolation.test.ts`.

The final common verification passed 6,940 tests across 530 files, plus typecheck, owned-source lint,
and the compiled common build. No production profile, server behavior, artifact draft score, or client
placement behavior was changed. Confirmation seeds remain unused.

## Combat follow-up: cemetery cleanup and friendly cover

An opt-in `auditOwnBarrelDecision` diagnostic records the raw incumbent, final decision, legal attack,
spell and movement alternatives, and exact stationary-shot counterfactuals. It runs after the timed
selector and never chooses or executes an action. A repeated full fight with the audit disabled had
the same action trace. Snapshot and detached-output tests also guard observation purity.

Fourteen exploratory control fights across all seven cohorts and both seats, using separate seed
`2026101850`, recorded 25 owned-barrel decisions. All retained the raw incumbent; 24 had no current
friendly stationary-shot gain. None passed up an enumerated positive-damage alternative. These traces
identify a policy boundary to investigate, rather than proving that every clear is wasteful.

`prioritizeV08CemeteryObstacleAttack` runs when deployment barrels activate scattered obstacles, even
on a non-cemetery map. After the ordinary native movement/hold policy, it can replace that decision
with a strike on an owned barrel. The research-only `preserveOwnBarrelCemeteryFallback` candidate keeps
the pre-cleanup decision in that case. Earlier deliberate obstacle plans, neutral cemetery stones,
enemy barrels, direct attacks and casts retain their original handling. Search still enumerates and
compares barrel-clearing challengers. The intervention applies consistently to the candidate team's
root and rollout decisions; placement, funding and engine rules stay fixed.

This candidate is not connected to the public API or default battle engine. Its qualification source
uses common `fad12ce022e13433fbdfd5c07d8245c4d90ccd14`, the guard and tests, and an archived research
adapter at the native cleanup boundary and worker team scope. Both control and treatment use that same
frozen source. The adapter is enabled only for the treatment team. The shared production strategy
source remains unchanged.

The initial registration and 36-fight smoke are under the ignored
`game/core/tmp/barrel-cemetery-qualification-20261018` directory. A four-worker partial screen was
superseded when the peer node job completed. A second partial screen in
`game/core/tmp/barrel-cemetery-qualification-8p-20261018` exposed that the worker enabled opponent
reflection only for the old placement policies. Neither partial run received aggregate outcome
review; their 37 and 61 completed fights are excluded. The corrected worker enables the callback for
any requested reflection. The candidate rule is unchanged.

The corrected registration and frozen source are under the ignored
`game/core/tmp/barrel-cemetery-v2-qualification-20261018` directory. Screening uses fresh seed
`2026101862`; confirmation reserves `2026101863`. Each stage contains 120 independent primary armies
across three live maps, two ownership conditions and two opponent formations, plus 24 independent
negative-control armies with no owned barrels. Control and treatment play each matchup in both seats:
**576 fights** per stage. Selection uses fixed canonical roster quotas before combat outcomes.

This is the third fully evaluated Barrel candidate in the task. Promotion requires a positive paired
family-adjusted 98.33% interval and exact two-sided sign-flip `p < 0.05 / 3`, independently in screening
and fresh confirmation. Armies, not mirrored fights, are the confidence unit. Rejected actions,
incomplete games, changed negative-control traces or source drift invalidate the run. A 72-fight smoke
checks both formations in every map and ownership category before screening, including that every
requested reflection was applied; its scores do not tune or qualify the rule. Eight low-priority
workers run on the 9800X3D, separate from live services.
The default AI remains unchanged unless the full qualification requirements pass.

The corrected source fingerprint is
`877cf718d5318f64fa743ceb2d1fbcfc2a0de91146d66654da5b55bc34c9c26b`. The complete 72-fight smoke
had zero rejected actions, identical traces in all 24 negative-control seat pairs, and all 36 requested
reflections applied. The guard changed 57 root and 18,181 rollout decisions, with no unclassified
decision origins. Source typecheck, owned-source lint, the compiled common build and 6,951 common tests
passed; focused tests also retain engine-legal barrel shot and movement coverage.

## Cemetery-guard result: not qualified

All 576 screening fights completed by elimination without rejected actions. The primary population
contained 120 distinct armies and matchups across all seven cohorts. All 48 negative-control seat
pairs had identical action traces, all 288 requested opponent reflections applied, and source,
runtime, driver, registration and request identities passed validation.

Control scored 50.625%; the guard scored 53.125%. The paired difference was **+2.50 percentage
points**, with a family-adjusted 98.33% interval of **−5.01 to +10.01 pp** and exact two-sided
sign-flip `p = 0.466694`. The ordinary 95% interval also crossed zero (−3.65 to +8.65 pp). An
independent Python calculation reproduced the per-army estimate, adjusted interval, exact test and
all control checks from the raw results. Fifty-five independent army pairs had nonzero differences.

The guard reduced actual owned-barrel strikes from 328 to 14, including clears with no recorded
current shot effect from 216 to 7. It changed 671 native root choices and 227,761 rollout choices;
these counts are not counts of final executed turns saved. Some deliberately planned barrel strikes
remained. Reducing own-cover destruction did **not** establish a reliable battle-score improvement.

**Do not enable this candidate or run its reserved confirmation as though screening passed.** The
positive point estimate is exploratory evidence for future separately registered research, not
permission to weaken the gate, expand this sample after inspecting results, or promote a favorable
subgroup. No production profile, artifact draft score, client behavior or server behavior changed.
The guard remains excluded from the public API and default engine by the isolation test. The fresh
confirmation seed is unused.
