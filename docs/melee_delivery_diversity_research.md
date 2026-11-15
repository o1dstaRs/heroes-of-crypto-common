# Melee delivery diversity research

The user requested measurable trials of the broader coordination priorities. This experiment tests a
cheap way to expose more distinct move-and-strike positions to the adopted A19 controller. It is
separate from the active joint artifact/final-pick planner and the closed stationary-hit metadata trial.
No serving policy imports the helper and no default has changed.

## Fixed candidate

`melee-delivery-diversity-v1` changes only extra, equally valued melee deliveries before the existing
search. The native cap, target allocation, first retained delivery to every target, and every retained
slot's target/damage/kill/stationary class remain exact. Within that class, greedy farthest-point sampling
selects the stand most separated from already retained stands for that target. Source order breaks ties.
The helper returns the original action-bearing objects and never changes battle state or consumes RNG.
Special Rapid Charge and Last Fuse reservations are added afterward exactly as before.

This is candidate coverage, not a new damage formula or a tactical veto. It adds no rollout, fit, weight,
or horizon. The ordinary engine search still resolves approach movement, retaliation, shields, auras,
friendly obstruction and later turns. Its private rollout controller remains unchanged. It does not
claim to search future allied turns with full nested A19 decisions.

The rationale is that equal metadata currently permits several neighboring stands to occupy the finite
catalog. More distinct approaches may let the existing whole-turn comparison find better coordination
without buying more search. Better geometry by itself is not a strength result; completed games decide.

## Frozen measurement

Current registration: `9e8f698bc871d12fefc27984681051dd8ccd34abf526b42bba8df5cd5d6298ab`.
The ignored capsule is `game/core/tmp/melee-delivery-diversity-20261115/v2` in the client repository.
It freezes common `ab30315c` and server `916e3ca3`, explicit offline-only hooks, dependencies, actor,
analyzer and inputs (2,543 sealed files). The source identifies a research checkout, not a deployed binary.
The reference is adopted contextual draft `063a888e`, native fully funded setup with ranged selector
`d786f4e9`, native formations/support splits, and complete A19 combat for both armies. Ranked Setup is
public; earlier draft decisions retain each doctrine's actual visibility. Only the controlled physical
team's root catalog is treated.

The functional bank reuses all 27 prior compatibility boards, first pick assignment and both physical
seats: 54 cases in off, observer and treatment modes, 162 executions. Every arm reconstructs its native opening independently; both controls must reproduce exact
actions/events from the same corrected source and opening. Every fight must end in elimination with zero rejected actions, missing neural
starts or model errors, and real A19 search on both teams. Slot/leader/cap identities are checked in every
record. The fixed coverage gate requires at least ten catalogs with newly retained deliveries, three unit
types, all three maps, and one changed complete trajectory. Failure closes the study before development.

If admission passes, development uses the first 162 whole already-opened families from allocation study
`72d5d0a369f569dac42cbbc0f2d783422086d5cd4b60564cadd2dcf1bdd6ff20`. Both pick assignments and physical
seats yield 648 cases per arm / 1,296 fights. Controls are rerun, arm order alternates, and all families
remain regardless of roster or outcome. Eight nice-19 local workers leave Puffalo's peer campaign alone.
No new independent channels have been allocated by this registration.

Score is win 1, draw 0.5, loss 0. Paired differences are averaged within whole offer boards; 20,000
whole-board bootstrap draws and an exact two-sided family sign-flip calculation are descriptive at this
stage. The development funding gate is at least +0.5 percentage points overall, nonnegative means in all
three own budgets, complete data and zero quality errors. No threshold changes, outcome masks, tuning,
extra batch or subgroup rescue are permitted.

A passing screen still needs a separate prospective seed-exclusion registration, 864 independent
qualification families, 1,512 independent confirmation families, a fixed contrasting-opponent panel,
and serial serving-path compatibility/timing. Both primary fresh banks must show at least +0.5 points,
a whole-family 95% lower bound above zero, and nonnegative own-budget means. Additional compute must
stay within 10%, including the existing controller. Development or partial results cannot activate it.

## Measurement admission correction

The original registration `85a3c390325bcec343c2842fecf1d3dca97e790cdbfa9a15c4b3a44220cfcb07`
failed historical-control replay before development. The entire partial batch is excluded, with raw
records, errors and invalidation retained. No partial strength aggregate or candidate selection was used.

Diagnosis found two common modules: direct combat imports used the new capsule, while server package
imports followed a shared dependency symlink into the older allocation capsule. Its separate RNG and
fight-state singleton were outside the runner's seeded scope. Repeating one native opening produced
multiple formations; changing server UUID allocation alone did not fix it. A runtime Bun alias plugin
was insufficient to establish package identity in this environment.

V2 gives the capsule its own dependency directory, with the server's actual common package symlink
pointing to its frozen common source. Startup asserts exact RNG-function and FightStateManager identities.
Copied server runtime identities use common's seeded UUID generator. Each arm reconstructs setup anew,
clones its battle input, and must match its counterpart's entire configuration, formation and draft
receipts. Twelve repeated reproductions of the original failing opening then produced one configuration
and one formation. The same 54 functional cases, 162 development families, candidate bytes, coverage
requirements and win-rate gates remain fixed. Historical traces from the mixed-module harness cannot
serve as current-source replay references; the corrected current-source off/observer pair supplies that
control. This correction changes the measurement capsule only, not any shipped policy.

The active joint artifact/final-pick planner has its own server-to-frozen-common package link; inspection
did not find this shared-dependency mistake there. Its running source was not modified. Earlier immutable
research records are preserved: any claim of latest-source native compatibility from the affected shared
capsules needs this module-identity qualification, even when two cached-opening combat replays matched.

## Completed correctness admission

All 162 corrected preflight executions passed. The 54 off/observer pairs reproduced exact action/event
traces after independently reconstructing their openings. Treatment retained 90 new delivery options in
67 capped catalogs, across 12 unit types and all three maps; 32 fights exercised changed catalogs and
three complete trajectories changed. There were zero rejected actions or neural-state errors. The
candidate therefore passed its fixed coverage gate and opened the 1,296-game development comparison.
These are correctness/coverage counts, not win-rate evidence.

## Result: closed without a measurable gain

All **1,296 development fights from 162 complete offer-board families** finished, with zero rejected
or censored games and zero missing neural starts/model errors. The ordinary controller scored
**51.003086%** (325 wins, 11 draws, 312 losses); the candidate scored **51.080247%**
(326 wins, 10 draws, 312 losses). The paired gain is **+0.077160 percentage points**, whole-family 95%
bootstrap interval **−0.462963 to +0.694444 points**, exact two-sided family sign-flip **p = 1**.

| Own upgrade budget | Paired cases | Score difference |
| ------------------ | -----------: | ---------------: |
| 5                  |          216 |     +0.231481 pp |
| 6                  |          216 |     +0.231481 pp |
| 7                  |          216 |     −0.231481 pp |

The candidate changed 655 capped catalogs, retaining 869 new delivery options across 31 unit types and
all three maps. It exercised changed catalogs in 299 fights and changed 53 complete trajectories.
Three paired outcomes improved and three worsened. Coverage is therefore present, but it does not
establish a useful complete-policy gain. The small map/budget differences cannot rescue the failed test.

Both development strength gates fail: the overall gain is below +0.5 points and the seven-point mean
is negative. **The candidate is closed.** No fresh qualification or confirmation opened, no additional
seed channels were allocated, no weights were fitted, and the default, production and Premium snapshot
remain unchanged. No selected subgroup, threshold change or extra batch is authorized by this result.

The candidate's observed aggregate fight time was 0.41% higher and simulated rollout turns were 0.11%
higher. These are parallel offline diagnostics, not serial production timing or a passed serving-cost gate.
A production timing experiment and opponent panel were not opened after the failed strength gate.

The sealed Python analyzer and an independently implemented TypeScript verifier agree on every paired
outcome, all 162 family deltas, both bootstrap endpoints, the exact sign-flip numerator/denominator and
the failed gate. All 2,543 source/dependency/input seals passed. Nine additional cold-process replay
checks matched the warmed controls. Compact evidence is preserved in
[evidence/melee_delivery_diversity_20261115.json](evidence/melee_delivery_diversity_20261115.json);
complete raw records and the excluded initial batch remain in the ignored capsule.

The other agent's original artifact/final-pick campaign stopped before fitting because it used private
Setup while actual ranked Setup is public. Its replacement, `ranked-army-plan-public-20261115`, has
registration `c9e37ee04066f25100373fe7f034cbf702d17bb86a6ccd6c50e8d3ad00e4b73d` and was collecting its
training bank during this closeout. It is a separate hypothesis and dataset; no partial result is pooled
with this failed melee experiment. Current coordination priorities continue through that properly routed
army-planning measurement rather than activating a failed tactical rule.
