# Peasant post-movement response coverage

This separate inactive candidate, `peasant-postmove-response-coverage-v1`, **closed without a gain**
after 1,359 verified development executions and 112 separate diagnostic executions. It follows the
[exchange-angles audit](peasant_exchange_angles_research.md). It tests whether a cheap retaliation
opportunity is lost before full search when the attack requires movement. It does not alter the closed
`bitter-experience-cheap-response-v1` helper or its failed gates.

The immediate shortlist value lacks armor and movement inputs, while full engine search retains both
bonuses. The final A19 neural observation also includes each unit's **current** armor, range armor and
steps, plus retaliation state and ability features. That does not establish learned understanding of a
prospective bonus, but it means the entire AI cannot be described as blind to those stats.

## Candidate fixed before development

`src/simulation/peasant_postmove_research.ts` is not imported by serving AI. The private research hook
inspects an already existing leaf immediately before its melee strike, after an optional explicit
move and its stat/aura updates. It consumes no extra random samples or leaf simulations. Movement
must leave HP and creature count unchanged, and the ordinary sequence may contain only attack-mode
selection, at most one move and one melee strike. Terrain hazards, combined-path strikes, Hidden
targets, unsupported multi-hit/secondary replacements, shields, reflection and Break risks decline.

The canonical response gate must allow the defender to reply. The complete supported pre-primary-hit
damage distribution must have no fatal outcome, at least 50% chance of a casualty-triggered bonus,
and worst-case damage at most **5% of current stack HP**. Unlike the closed pilot, there is no absolute
two-casualty ceiling: three losses in a large stack can still be a cheap proportional trade. The hook
checks the projected upper bound against each observed leaf's actual response damage.

Every native shortlisted action stays in its original order. If native has not already exceeded its
ordinary shortlist cap with another special reservation, append at most one missing eligible trade.
Choose the highest existing immediate leaf value, breaking ties by lower expected HP cost and then
catalog order. Equivalent native actions are not added twice. Full scores, late urgency/intent guards,
native future-turn policy and final neural arbitration retain their original behavior. There is no
invented armor reward or forced farming preference.

Six new tests cover legal movement before inspection, response from a killed defender, projection
purity/no RNG, proportional cost, worst-case safety, unsupported exchanges, sequence restrictions and
preservation/deduplication of native comparisons. The 26 focused Peasant tests pass 150 assertions;
targeted ESLint and source/test typechecking pass. The adopted A19 profile's 16 tests also pass.

## Development registration and current baseline

The fixed development sample reuses all 108 families opened by the earlier exchange-angles study:
three maps, every 5/6/7-point doctrine pairing, both physical seats and two futures. This is **opened
development data**, not fresh qualification. Nine admission battles precede 432 cases × off/observe/on
= 1,296 main battles; 54 cold replays bring the registered total to 1,359 executions. Controls compare
complete inputs, turns, events, outcomes and health. Every observed final neural choice must match the
committed action. A first trajectory difference must be a changed Peasant decision, not altered
randomness or state while executing the same action.

Both sides include the user-adopted melee-barrel correction. The baseline is common
`72788e5810dc9723755ae5c47f35f89cf33fe6c8` plus the exact frozen peer adoption files, and server
`82336c6981c7679febb1793043fd3671c90cb898`. The peer's files were uncommitted at the freeze; they were
copied into the private runtime without editing or committing the shared working tree. The private
search driver SHA is `cc9493295f252866aab86113903b7832992319937f36b9efcd4382895a1e778e`, and the adopted
profile SHA is `5f3fa26205d5c0a640760dc0693eaf208eb20055f99c0b8e58c8ddd4754422e9`. The runtime asserts
the barrel default on, H64/R2, and common/server module identity. Later peer edits are excluded.

Registration SHA:
`3057c2757fd34cb945537ad94dcaa93869acbbf0b45b7e6a2a2adf1713631a36`.
The capsule is `game/core/tmp/peasant-postmove-coverage-20261116` in the client. It uses six nice-19 local
workers, no GPU, a 384 MiB disk floor and a hard cutoff of 2026-11-16 19:48:45 UTC. Stop on any error;
do not restart or extend automatically. The original source and full raw receipts are sealed there.

All progression requirements were fixed before the first battle: quality checks pass, at least ten
additional complete R2 comparisons across two maps, at least one changed actual decision, at least
+0.5 match-score percentage points over the adopted native baseline, and nonnegative means for every
own doctrine. Only then may a separate fresh qualification/confirmation and serial serving-cost study
be registered. Development cannot authorize promotion. No fresh channels were allocated; all prior
exchange-angles reservations, including its rejected and unused pool channels, remain excluded.

## Separate declined-trade continuation audit

While development was running, the first six added comparisons tied the chosen action's full score
and were all declined. A separate diagnostic was registered before any of its forced continuations:
`66dffdc7b19d07bf5489bd200ecd57f863a10fb4e64576b1ff645dea271e1cc4`.
It waits for the original pilot's independent verification and leaves that candidate and its gates
unchanged. It shares the original resource limit and cutoff.

Select the first eligible omitted proposal per native family in fixed seat/future/root order, then
the first two distinct families per map/own-doctrine/opponent-doctrine stratum, at most 54 roots. No
terminal outcome or full score determines selection. Replay native versus forcing that attack exactly
once and resuming native, then cold-replay both arms: at most 216 additional executions. This is an
offline decision diagnostic, not a legal selection policy or a population strength estimate.

Every native result must reproduce the original pilot; both arms must share the exact pre-root turn
prefix, and the forced action must actually execute with a valid worst-case cost bound. The observer
also records already-computed native terminal forecasts and existing neural predictions, adding no
model evaluations or random draws. Any favorable forced continuation remains diagnostic and cannot
rescue a failed shortlist candidate or justify a global armor-farming preference.

## Results

Development completed at **2026-11-16 18:09:50 UTC**. Every one of the 432 off/on battle traces was
identical: **0 improved, 0 regressed, 432 unchanged**, for **0.00 percentage points**. Both arms scored
61.1111% on this conditional Peasant sample; this is not a general AI win rate. All own-doctrine and
map deltas are zero. The degenerate descriptive bootstrap interval [0, 0] reflects identical observed
decisions, not proof of zero effect on every possible board.

The candidate added **51 move-and-strike comparisons**, of which **50 completed both full rollouts**.
It selected none. Of the added comparisons, 49 tied the native choice's full score, one scored worse,
and one was pruned after its first losing forecast. Thirty attacked the same enemy as native, 33
native choices already offered a qualifying cheap response, and 24 added trades exceeded the older
absolute two-casualty ceiling. No accepted addition changed armor merely by moving. Thus coverage
expanded, but it did not produce a better decision. Quality and coverage gates pass; the actual-choice
and +0.5-point gain gates fail. No qualification, confirmation or serving-cost bank opened.

The independent checks cover 432 exact off/observer pairs, 54 cold replays, 3,850 final-choice matches
and 946 projected-cost checks in the main/cold stages, plus all nine admission executions. A second
analyzer independently reconstructed all 432 candidate-owner/seed/winner score pairs and exact
off/on traces. The adopted source changed 39 historical traces relative to the earlier exchange-angles
baseline; those changes are not attributed to this candidate.

### What the forced continuations explain

The separate audit completed at **18:12:04 UTC**. Its fixed rule selected 28 roots from distinct families
across 17 strata, out of 31 eligible families. All 28 native controls and pre-root prefixes reproduced;
all 56 cold replays matched. Each nominated attack executed within its projected worst-case HP bound.
Twenty-seven earned Bitter Experience; the probability gate does not guarantee a proc on every hit.

Forcing the declined action once produced **1 improvement, 2 regressions and 25 unchanged results**.
The score differences sum to -1. This is a selected diagnostic sample, not a population win-rate estimate
or a selectable policy. All three outcome-changing cases earned the same +1 bonus under **both** choices:

| Case                       | Native choice and response cost | Forced choice and response cost    | Native → forced result | Added full forecasts           |
| -------------------------- | ------------------------------- | ---------------------------------- | ---------------------- | ------------------------------ |
| `f09`, lap 4, 102 Peasants | Arbalester from (2,5), 135 HP   | Wandering Mage from (3,13), 9 HP   | Win → draw             | 0; second forecast pruned      |
| `f19`, lap 3, 48 Peasants  | Squire from (9,5), 13 HP        | Same Squire from (10,4), 13 HP     | Draw → win             | 1, 1; tied native's 1, 1       |
| `f22`, lap 2, 46 Peasants  | Gargantuan from (12,4), 106 HP  | Wandering Mage from (10,11), 15 HP | Win → loss             | 1, 0; worse than native's 1, 1 |

In `f19`, both attacks killed the Squire, dealt the same actual damage, left 46 Peasants with 366 HP,
16.94 armor and 13.8 steps, and earned the same bonus. The changed attack square led to a different
continuation; this is not a missed armor-farming benefit. Native's two simulated wins did not predict
its actual draw, while the alternative won. This one case does not separate positioning from downstream
chance and subsequent decisions or establish a general positional rule.

In `f09`, native pressured the Arbalester and its next turn moved away. The cheaper mage kill instead
left it able to shoot the Peasant. In `f22`, engaging Gargantuan led to a melee reply on its next turn;
the cheaper mage kill left it taking an area throw instead. Native also applied Deep Wounds to
Gargantuan. The expanded full search already ranked both harmful alternatives below native. These
are concrete examples of the opportunity cost of seeking the cheapest response, not evidence to
override existing scores or guards.

Across all 28 diagnostic roots, 18 alternatives attacked the same target, native already earned a
response bonus in 26 cases, and both arms earned the same bonus in 27. All 334 recorded **existing**
native full forecasts reached a terminal result. The neural model preferred the proposal less in
20 cases and more in eight, but the largest positive logit difference was 0.576972, below the current
1.0 correction margin. The one improvement had a negative difference (-0.460306). Lowering that margin
alone would not select this observed improvement. No weights, margin or final-selection rule were changed.

### Preserved evidence and next boundary

Read the compact [evidence fixture](evidence/peasant_postmove_20261116.json), `analysis.json`,
`coverage-analysis.json`, `forced-analysis.json` and `forced-detail-analysis.json` in the capsule.
`battle-artifacts.json` seals all **1,471** verified execution files. Full raw actions, events, inputs,
source overlays, controls, forecasts, predictions and both outcomes of every forced comparison remain
in the ignored capsule. Ordinary full run output is not committed.

The supplemental coverage analyzer initially confused `MatchResult.seed` (configuration/setup seed)
with the separate combat RNG seed. Its corrected checks verify each against its own recorded source;
the frozen runtime installs the combat seed at `beforeFightStart`. The initial script and correction
receipt remain preserved. No simulation, original verifier, policy, gate or outcome changed, and no
battle was repeated for this analysis correction.

Keep this helper immutable at SHA-256
`968ff9cddca3fafa6b8057eca24557272c64e8da59481fd2b1c65b33c35bbe4e`
and its test at `e041e5f4b9b5fc3b71af5f5ed373206aee9f7e5c3174ded47b455500846018c7`.
The original cheap-response helper and its failed gates remain untouched. No serving, draft, model
weights or Premium behavior changed from this study.

The remaining lead is distinguishing **attack positions among fully scored ties while retaining pressure
on dangerous enemies**, rather than a generic preference for cheap retaliation. The earlier failed
[melee-delivery diversity](melee_delivery_diversity_research.md) and
[forecast audit](shooter_pin_and_forecast_audit.md) remain relevant counterevidence. A new hypothesis
needs a distinct registration, legal public inputs, representative independent strength evidence and
serving timing; this one selected draw-to-win cannot qualify it. Do not reopen this closed candidate,
weaken its gates, or promote a favorable slice.
