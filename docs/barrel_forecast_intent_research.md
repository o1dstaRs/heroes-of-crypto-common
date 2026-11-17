# Native barrel intentions inside forecasts

`barrel-forecast-native-intent-v1` is a separate offline experiment against the adopted A19 profile v9.
The [confirmed melee barrel correction](melee_barrel_deliberation.md) stays enabled for both armies.
The previous [shortlist experiment](melee_barrel_choice_diversity_research.md) remains closed at zero
measured gain. No serving profile, model weights, draft, spending or placement changes here.

## Hypothesis and fixed policy

Live A19 now compares a melee barrel hit with walk, wait and defend. Its internal native v0.8 future
turns still replace many such intentions with cemetery cleanup. This difference can change the value
assigned to a root action. Retaining native intentions might improve those values; that is an unproven
approximation, not an assertion that the original native intention equals what searched A19 would do.

Only forecasts made by the experimental entrant's search driver use the candidate. Within those
forecasts, both projected armies retain their exact pre-cleanup native move, wait or defend when
cleanup newly proposes a melee deployment-barrel strike by that actor. Both barrel owners are covered.
Explicit combat, casts, earlier deliberate clears, ranged cleanup and neutral stones stay unchanged.
Original native action-array references are returned; no copy changes target-memory ownership.

Actual root-incumbent construction and the ordinary root controller are unchanged. Search may select
a different real action because its forecasts differ. H64, complementary R2, candidate caps, role
guards, value/material selection and final neural/support corrections remain fixed. No searched child
reply, extra rollout, learned trigger or independent RNG draw is added by this helper. Its realized
complete-decision and full-fight cost still require a separate +10% qualification.

The old own-barrel guard modified both live roots and rollouts under an earlier policy. It remains
failed and inactive. The failed searched-reply study also remains closed. This new candidate is a
symmetric forecast-only approximation on the adopted baseline, not a reactivation or relaxed gate.

## Source and functional controls

The source is common `96e5499b` and server `ae63b150`, retaining locked V3/contextual draft, actual
paid public Setup, native support splits and formation. The canonical helper is
`src/simulation/barrel_forecast_intent_research.ts`; importing it installs no hook. The shared native
strategy, search driver and A19 profile do not import it. Only the ignored frozen copy of the native
cleanup boundary has an explicit callback adapter. Six unit tests cover root isolation, both owners,
array identity, legal movement/hold classes, protected actions and ordinary cleanup.

The client capsule is `game/core/tmp/barrel-forecast-intent-20261117`. Functional seal:
`af3962458dc9d5b405136c4143e246cb39f7312c519f005f1132fb141ef96173`.
Fresh development seal:
`b9f7c9300dab52009a9d2164954a26f549edc355d82e63d2c43a187302a61e02`.

The 36 reused functional cases were chosen only by opening barrel presence and map: 24 with barrels
and 12 without. All 108 stock/observer/candidate fights completed. Every stock/observer trace matched;
all 12 no-barrel stock/candidate controls matched. The candidate changed 4,177 projected intentions
across all three maps: 2,491 own future turns and 1,686 enemy future turns. Retained intentions were
3,061 moves, 1,115 waits and one defend. Eighteen complete game trajectories changed. These observations
establish functional coverage, not a strength gain.

Six cold cases supplied another 18 exact local replays. The same 18 fights on the 9800X3D reproduced
every consumed input, complete action/event trace, forecast count and saved witness exactly. Runtime
was Bun 1.4.4 on both macOS ARM64 and Linux x64. Package identity checks require setup and combat to
share the same RNG function and FightStateManager constructor. No live service or existing job changed.

## Fixed fresh screen and gates

The full screen has 216 new legal draft families, each with both draft orders and both physical seats.
Three arms compare the adopted default, the one fixed forecast candidate, and the accepted 50.36%
neural pair with otherwise unchanged v9 code: **2,592 full fights**. The accepted pair is a descriptive
reference, not another model selected for promotion.

Eligibility is the first completed legal draft pair containing a naturally selected Barrel Barricade
in either order. No offer, pick, roster, upgrade budget, split or deployment is forced. Four fixed
opponent draft styles have 54 families each; every block balances all 27 map/own-doctrine/opponent-
doctrine cells. Each family stays on one host for all four cases and all three arms. Even families run
on six local workers, odd families on four 9800X3D workers, all at nice 19. Each host is independently
balanced across every style/map/doctrine cell. The common hard cutoff is **November 17, 18:25:26 UTC**;
there is no automatic retry, extension or family reassignment after combat begins.

The [registration fixture](evidence/barrel_forecast_intent_registration_20261117.json) preserves all
28,966 scanned preimages, including rejected and unused candidates. Future studies must exclude every
preimage's eight raw and eight native-permuted channels. Allocation excluded 20,061,548 prior channels;
independent Bun reconstruction verified all new channels and the first-eligible draft selections.
The sealed registration predates the first fresh combat. The later public fixture adds no outcomes.

All fights finish before aggregate score inspection. Terminal win/draw/loss scores are 1/0.5/0;
rejected actions, model errors, missing starts, swallowed callback faults or incomplete cases invalidate
the phase. The confidence unit is the entire four-case family. The registered 20,000-resample uint32
bootstrap uses seed 1746179401 and an independent Bun integer half-point reconstruction.

Funding requires at least +0.5 score points versus default, a positive 95% lower confidence endpoint,
at least 24 changed families, and no map, own-doctrine or opponent-style mean below −1 point. A failed
gate closes the rule unchanged, without a subgroup rescue or extra batch. Only passing opens separately
registered quiet-host serial full-fight/complete-decision timing within +10% and at least 756 fresh
paired families. No qualification or confirmation bank is allocated; development cannot promote it.

## Completed screen and regression audit

All **2,592 fresh fights** completed, with no rejected actions, callback/model errors or missing starts.
The adopted v9 scored **53.298611%** and the forecast rule **53.645833%**: **+0.347222 points**, whole-
family 95% **−2.141204 to +2.893519**. The accepted neural reference scored 53.009259%; its contrast is
only descriptive. Independent Bun integer reconstruction matched every outcome and all 20,000 resamples.
See the [closed result fixture](evidence/barrel_forecast_intent_results_20261117.json).

Coverage passed: 131,005 projected intentions changed, affecting 540 full traces on 206 families.
Strength did not pass: the estimate missed +0.5 points, its interval crossed zero, and map, own-doctrine
and opponent-style safety gates failed. Blocked regressed **−3.298611 points**, five-point doctrine
**−1.388889**, pressure opponents **−1.157407** and shooter opponents **−1.851852**. All original gates
and unfavorable slices remain unchanged. The rule is closed and inactive; qualification, independent
confirmation and quiet-host serial cost qualification remain unopened.

The Mac shard took 896.044 seconds and the 9800X3D shard 1,425.117 seconds. Both finished before the
registered cutoff and all workers exited. Concurrent CPU totals are descriptive and cannot replace
serial serving qualification or rescue failed strength. Source CI passed and the pre-screen common
suite passed all 8,165 tests. No GPU was used in these CPU combat simulations.

All 68 worsened and 74 improved outcome pairs were then replayed: **284 diagnostic fights**. Every
original input, full action/event trace and score matched. At all 142 first divergences, the actor and
raw native incumbent were identical while the final selected action differed. Thus changed forecasts
can alter ordinary root target selection despite unchanged root-incumbent construction. The first raw
incumbent was a ranged attack in 29 regressions and 33 gains; disabling ranged roots would remove both.
For example, a Blocked-map Cyclops retargeted from Elf to Zena, and a Normal-map Arbalester retargeted
from Monk to Wolf Rider. These are localized regression examples, not isolated causal proofs or
qualified exclusion rules. Returned search values can contain pruning bounds and are not calibrated
win probabilities.

Further useful-clear diagnostics preserve this failed policy and all its results. Any constrained
revision needs a distinct identity, unchanged original evidence, fresh channels and comparison against
the subsequently adopted v10 default. No map, unit-name or favorable outcome subset is promoted.

A subsequent read-only ray audit replayed all 142 changed-outcome pairs again. Its 284 full traces and
all first-root returned banks/choices matched the original JSON observations exactly. Of 3,247
suppressed future clears at those roots, 982 intercepted an available friendly shot: 483 among
regressions and 499 among gains. This motivates preserving mechanically useful clears, but does not
make the tag a predictor of outcome. The Cyclops example had no such friendly blocker at its first
changed root; this single guard cannot explain all regressions or certify a universal fix.
The first diagnostic assertion mishandled optional `undefined` spell fields omitted by the original
JSON. That stopped run is preserved; a separate execution corrected serialization only, without a
numeric tolerance or policy change. See the result fixture for both identities and raw hashes.
