# Preserving useful clears inside barrel forecasts

`barrel-forecast-friendly-shot-clear-v1` is a distinct offline regression repair. The
[original intent rule](barrel_forecast_intent_research.md) remains closed and inactive with its failed
strength gates and every losing case preserved. The new helper is
`src/simulation/barrel_forecast_useful_clear_research.ts`; importing it installs no hook.

The original first-divergence audit found 982 suppressed future clears that intercepted an available
friendly shot, spread across both improved and worsened outcomes. A cheap forecast that always keeps
the previous move/wait intention can miss that concrete reason to clear. This is a mechanism to test,
not a predictor of wins. It does not explain every regression or measure movement bottlenecks.

The fixed revision uses the combat engine's actual ranged-attack ray to preserve native cleanup when
its barrel blocks an available shot by the future actor's army. It accounts for current ammunition,
melee pins, forced targets, Hidden, through shots and Area Throw through the existing engine helper.
Both barrel owners and both projected armies use the same rule. Otherwise the exact original intent
helper and action-array identity apply. Live root construction, H64/R2, search caps, value/material
selection, neural/support corrections, draft, Setup, models and placement stay unchanged.

There are no map, unit-name, opponent-style, outcome or fitted threshold exceptions. No additional
rollout or model inference is added. The new ray work still needs complete-fight and complete-decision
cost qualification within the user's +10% allowance. Fewer barrel hits or more open rays cannot replace
match-score evidence.

## Frozen regression admission

The [registration](evidence/barrel_forecast_useful_clear_registration_20261117.json) freezes one rule
before its first candidate game. It reuses **all 864 original cases**, including the cases whose
outcomes did not change under the failed rule. All 68 regressions and 74 gains also replay both original
arms with exact input, full action/event trace and score checks: **1,148 total executions**. All six
workers run at nice 19 and keep the original absolute deadline. Packet/import preflight corrections
before this admitted execution completed zero games and changed no policy, cases, gate or deadline.

Admission requires valid engine/model/callback checks, at least one mechanically preserved useful
clear, fewer regressed outcomes versus stock, and a higher total score than naive v1 across the full
864-case set. These reused diagnostic gates cannot establish independent strength. The rule will not
be tuned on a favorable subset or relabeled a fresh win.

Separately, 36 existing functional cases compare the new adopted **v10** default, an observer that
computes/discards the guard, the guard and original naive v1: **144 executions**. All setups must match
the original public native inputs; stock/observer full traces and all twelve no-barrel stock/guard
pairs must match. Source identity and package/relative RNG/FightStateManager identity checks are fixed.
The 164 focused tests cover both owners/sides and all four engine maps, depleted/pinned/hidden shooting,
an enemy-only screen, retained movement/hold array identity, state/matrix/RNG purity and serving isolation.

Only passing opens a separately registered fresh study against the subsequently adopted v10 default,
with the failed naive rule for attribution and the accepted neural reference retained. Qualification,
fresh confirmation and serial serving-cost measurement are not allocated by this admission. The
confirmed barrel deliberation and current default remain intact. The completed result below closes this rule.

## Closed regression result

All **1,148 executions** completed in 836.166 seconds. All 284 original control traces, inputs and
scores matched exactly; no authoritative actions, model starts or callbacks failed. Independent Bun
integer reconstruction agrees with the Python analysis. The whole 864-case reused bank, including
previously unchanged outcomes, is preserved in the [result fixture](evidence/barrel_forecast_useful_clear_results_20261117.json).

| Outcome against original stock | Naive intent | Useful-clear guard |
| ------------------------------ | -----------: | -----------------: |
| Improved                       |           74 |                 54 |
| Worsened                       |           68 |                 56 |
| Unchanged                      |          722 |                754 |
| Match score                    |   53.645833% |         53.182870% |

The guard recovered 23 old regressions fully and one partially, but removed 30 old gains. Among the
722 previously unchanged cases it introduced ten losses and ten gains. It retained 21,553 projected
clears and changed 99,551 other future intentions. Fewer regressions did not produce a net gain:
**−0.462963 points versus naive v1, −0.115741 versus stock**. These are reused diagnostics, not a fresh
population estimate. The higher-total-score admission gate failed; no fresh strength bank, cost
qualification or confirmation opened. The source is closed and inactive, without a subgroup rescue.

V10 functional controls passed all 144 games: 36 exact observer pairs and twelve exact no-barrel pairs.
They establish isolation, not v10 strength. All 8,199 common tests, lint, TypeScript, compiled copies
and the implementation's hosted CI pass. The engine-ray tag is an approximation of useful clearing,
not a proof of best-shot improvement or route value. Do not infer that preserving every tagged clear
is the remedy for forecast-model disagreement. Further uncertain-model work requires a distinct source
and fresh evidence while leaving both closed helpers and their full negative results immutable.
