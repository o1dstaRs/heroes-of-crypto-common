# Melee barrel decisions

The user reported that melee stacks clear barrels when they could advance or leave cover intact.
The native v0.8 cemetery cleanup can replace a move or hold with an obstacle strike. Deployment barrels
also activate scattered terrain, so A19’s cemetery fast return accepted that strike before enumerating
or forecasting alternatives. The root search therefore could not correct it.

A second boundary matters: the production active-only challenger filter drops generated wait and defend
actions. Merely removing the fast return would still omit the requested no-touch options.

## Confirmed default correction

`SEARCH_A19_MELEE_BARREL_DELIBERATION` puts a melee deployment-barrel incumbent through the existing
bounded search. It admits legal walk, wait and defend alternatives, retaining ordinary role and aura
guards, the same candidate caps, H64/R2 forecasts and neural/material arbitration. It also removes the
forced-productive preference from this comparison: an advance must earn its value. The barrel incumbent
remains available, including when it is genuinely useful or the deadline expires.

Ranged strikes, neutral cemetery objects, classical mountains, native rollout policies and games without
barrel incumbents retain their prior handling. This correction is distinct from the old research-only
own-barrel cemetery fallback guard; that helper, its failed gate and its unused confirmation stay intact.

The switch defaults on in A19 profile v9 after fresh confirmation and the user’s explicit lock request.
`V08_A19_SEARCH_ENV_OVERRIDES` can set it to `"0"` for rollback. The public AI wire version stays `v0.8`;
model weights and native v0.9 combat are unchanged. This is a code default; production deployment is separate.

## Evidence and controls

The frozen functional revision completed 54 off/observer/treatment fights and nine cold repeats.
Observers reproduced every complete control trace. Five eligible treatment roots across Lava and Blocked
compared actual alternatives: movement, defense and a spell were chosen; useful clears remained possible.
These reused cases establish functional coverage, not a win-rate gain. An earlier functional revision
omitted hold candidates and remains preserved separately without a fresh strength result.

Fresh development contains 216 independent barrel-conditioned ranked draft families, all three maps,
all nine doctrine pairings and four fixed legal opponent draft styles. Each family plays both draft
orders and both physical seats with identical consumed setup and combat inputs in all arms. Current
A19 is the causal comparator; the accepted 50.36% neural pair is a fixed secondary reference. Another
27 families without barrels must have identical off/on action and event traces.

Family selection examines completed legal drafts before any outcomes. It changes no offered artifact,
creature, upgrade budget, split, placement or combat seed. All 32 reserved candidate seeds per family,
including unused and rejected scans, are excluded from future studies. Development alone cannot promote
the rule: the registered follow-up requires at least 756 new families / 6,048 paired fights, a positive
whole-family 95% lower confidence bound, regression checks, and serial complete-decision timing within
the user’s additional-compute limit of 10%.

The ignored client capsule is `game/core/tmp/barrel-deliberation-hold-20261116`; the serving implementation
and serial/live checks are kept separately in `game/core/tmp/barrel-serving-20261116`. Source identities,
raw outcomes, every seed reservation and original gates remain preserved there.

## Complete result and lock

Development completed 2,808 fights: 216 primary families with current/treatment/accepted-neural-reference
arms, plus 108 exact no-barrel control pairs. The correction gained +0.868056 points against current A19
(95% −0.462963 to +2.256944); the accepted neural reference remained a separate unchanged comparator.
No model was fitted or selected from these outcomes.

The unchanged candidate then completed **1,512 fresh families / 12,096 paired fights** in 7,062.9 seconds
(1h 57m 42.9s). Mean terminal score rose from **55.224868% to 55.844907%**: **+0.620040 percentage points**,
whole-family 95% **+0.124008 to +1.132606 points**. All map, own-doctrine and fixed-opponent-style means
were positive; those individual slices are descriptive. The primary interval and all registered gates
passed. The score is conditional on legal drafts containing barrels, not an unconditional global win rate.

Search-layer arbitration at 3,580 eligible treatment roots proposed 1,138 moves, 303 waits, 487 defenses,
263 spells and 1,389 clears. These counts are captured before outer neural/support corrections; final-action tracking is audited
separately. They are not an authoritative executed-action census or a count of counterfactual turns saved. All consumed inputs matched across paired arms; zero actions were
rejected and no model errors occurred. Independent Bun integer half-point reconstruction reproduced
the exact gain; an independent whole-family bootstrap also had a positive lower bound.

Serial timing covered 72 fixed cases, 216 full fights and 12 excluded warmup fights. Total process CPU
changed −0.296149% with one corrected seat and +0.711645% with both seats corrected. Wall time and total
complete-decision time stayed within the 10% budget. All 144 comparable serving/control traces matched
the research implementation. A separate 36-fight bounded-live run had no deadline fallbacks, rejected
actions, missing starts or model errors. On the measured M4 Max, p95 complete decision time was
183.15ms for control, 192.08ms for one corrected seat and 196.83ms for both. These are host-specific results.

Both Linux nodes reproduced nine fixed off/observer/treatment fights exactly, including complete
action/event traces and semantic forecasts. The proposed node handoff was not executed: the original
local controller finished while its sandbox exception was awaiting approval. Every confirmation fight
therefore stayed local; none was reassigned, duplicated or removed.

Before confirmation combat, nine families exhausted their initial 32 legal-draft candidates without
choosing Barrel Barricade. A recorded input-eligibility amendment reserved 96 more disjoint candidates
for each; the first qualifying legal draft was selected by the original rule. Sample size, candidate
and score gates stayed fixed, and all old scans remain excluded.

The initial functional prose mistakenly called 0.01 the native value gate. The exact sealed code and
environment always used the existing 0.03 native gate plus 0.01 scored arbitration. The descriptive
correction changes no implementation, outcome or gate. The compact
[evidence fixture](evidence/melee_barrel_deliberation_20261116.json) preserves the original identities,
independent checks, exact results and every scanned seed preimage.

Further work compares against this default-on correction. The original native cleanup still runs
inside forecasts; any attempt to change it needs a distinct candidate and fresh evidence, retaining
this confirmed baseline and the earlier failed own-barrel guard unchanged.

## Final-action verification and continuation

A separate observation-only replay completed all 1,696 treatment games containing eligible roots. Every
original consumed input, full action/event trace and root count reproduced exactly. Across all 3,580
roots, the final post-neural/support actions were **1,204 moves, 753 waits, 219 defenses, 256 spells and
1,148 barrel clears**. All authoritative root actions completed successfully. Thus 2,432 contested turns
(67.93%) actually chose another action; useful clears remained possible. This census is distinct from
the earlier search-layer proposals: outer layers changed 694 roots. It does not claim 2,432 extra turns
or a separate strength gain.

The continuation audits final remaining clears against the existing forecast bank and original native
cleanup behavior. It uses the opened bank only for diagnosis. It changes no policy or model, and any
new candidate must retain this locked default, reserve fresh channels and independently meet strength
and compute gates.
