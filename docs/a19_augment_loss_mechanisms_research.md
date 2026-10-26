# Augment losses: mechanism diagnosis and Armor-preserving Movement

Started October 26, 2026 after the request to investigate the failed selector's losses and continue.
The [previous result](a19_augment_transfer_research.md) remains **+1.2346 percentage points, 95% interval
−2.1605 to +4.7840 pp**, with its primary gate failed. The endpoints describe uncertainty around one
result; they are not separately removable losing and winning strategies.

This follow-up preserves that verdict and its sealed validation bank. It first explains every
discordant validation case, then registers a different, fixed spending rule on untouched offer boards.
No production AI, setup policy, dependency pin or deployment has changed.

The selector lost 162 validation fights in total. In 142, the incumbent also lost; 96 retained the
incumbent spending plan exactly. The twenty new regressions are the paired cases examined here.
They are only part of the remaining strategic losses, which also involve picks and combat decisions.

## Exact replay admission

Replay **all twenty worsened and all 24 improved cases**, both incumbent and the locked alternative.
Do not select only the attractive Block or Movement cases. Keep the original corrected source,
captured server profile, configuration, actual combat seed, search identity and UUID stream.

Twelve balanced controls and all 88 headless replays reproduce the complete original initial state,
reference graph, root inputs, native/chosen-array ownership, behavior, result and score. A second
twelve-control gate and all 88 rich-event replays reproduce every root observation, actual action,
post-turn unit state and terminal outcome. Rich events intentionally add recorded-action and event
payloads. Their expanded logs and digests differ; the gate compares all equivalent state, choice and
terminal fields instead.
Every search still checks full restoration. The 200 admitted diagnostic replays supply **11,789
root restoration checks**, with no rejected action or censored fight. They are instrumentation and
development evidence, not 200 independent strength observations.

## What the losses actually show

| Observation                                                     | Worsened cases | Improved cases |
| --------------------------------------------------------------- | -------------: | -------------: |
| Cases examined                                                  |             20 |             24 |
| Alternative surrendered an Armor point                          |             18 |             20 |
| Alternative bought Empower                                      |             11 |              8 |
| Empower supplied no actual offensive damage                     |         6 / 11 |          3 / 8 |
| Native proposal identical at the first chosen-action difference |             19 |             20 |
| HP differs before any chosen-action difference                  |              6 |              3 |

Armor loss is common in both groups; rejecting every Armor transfer would also discard twenty of
the 24 improved examples. Merely finding a caster is equally insufficient: six Empower regressions
never realize any offensive benefit, but three Empower improvements also win with zero benefit.
The no-output check covers actual damaging casts, magic-ability carriers and relevant events;
healing, control and Fireforged Sword do not become Empower output.

Purchased movement is not a guarantee of useful tempo. Of the eleven improved Movement cases,
seven gain physical attacks in the first two laps, three have the same count and one has fewer.
Two of the four Movement regressions also gain early physical attacks. These counts include melee,
ranged and area attacks, not spells. Complete outcomes remain the strength endpoint.

Specific examples illustrate distinct failures:

- **b22-w3-a2, seven points, Armor to Empower:** the same opening enemy strike leaves Harpy at
  433 HP instead of 442 before either side changes its chosen action. The purchased Empower supplies
  zero damage. The alternative Harpy subsequently dies without attacking; the incumbent Harpy attacks
  on lap two. Later choices also differ, so this is a verified cost and timeline, not a complete causal
  decomposition of the loss.
- **b3-w3-a2, seven points, Armor to Movement:** Wyvern changes an opening wait to a short move.
  Wyvern and Tsar Cannon die without attacking under the alternative, whereas both attack under
  the incumbent. More reach did not produce a successful coordinated engagement in this replay.
- **b14-w0-a1, six points, Armor to Movement:** the alternative gains two early physical attacks
  and Tsar Cannon fires on lap one instead of lap two, yet loses the fight. This directly falsifies
  using first contact or early attack count alone as the promotion criterion.
- **b21-w0-a2, seven points, Might to Empower:** actual offensive magic output remains zero.
  Angel waits where the incumbent moves and its first attack slips from lap three to lap five.
  Buying an unrealized damage resource also changes search behavior, beyond its direct stat effect.

The native proposal remains identical at 39 of the 44 first action differences. This locates many
changes in A19's subsequent selection, but does not yet establish whether candidate generation,
shortlisting, rollout estimates or final arbitration is wrong. A read-only diagnostic records the
already executed candidate/shortlist/scoring path at those exact roots, preserving bounds and
return identities. Three first differences are AI Driven Berserker/Frenzied Boar turns with no A19
root; they must remain a separate native-controller branch rather than receive invented search scores.

The old selector also discarded information through its alphabetical tie rule. On seven-point
discovery cases, Might-to-Movement improved eighteen outcomes but was selected only three times.
In thirteen further cases it tied the selected alternative, and the fixed canonical order preferred
another transfer. Four of the seven subsequent seven-point regressions had such a discovery tie.
Their unselected Movement validation outcomes were never measured, so this is evidence of a weak
selection criterion, not proof that replacing the tie would have prevented those four losses.

## Value-representation check

A structural reuse of **all 2,592 original discovery openings** reproduces their complete state and
reference-graph witnesses, then reads both teams' sixty-dimensional deployed V2 feature vectors.
Every feature read passes a further state/reference/memory/RNG restoration check. Independent
verification matches the original witnesses and every case/plan pairing.

All **324 Armor-to-Empower pairs and 324 Armor-to-Movement pairs** have exactly identical full
feature vectors to their incumbent, for both teams. The encoder records HP, attack, composition,
turn queues and geometry, but no direct Armor, movement allowance or remaining damaging-spell
resource. Future attacks and movement can expose these differences during rollouts; the identical
initial features alone cannot price them.

This is a measured information gap, not a strength result for adding features or coefficients.
It motivates testing a richer learned representation against the existing R8 reference and actual
held-out full-game labels. Earlier failed hand-weighted support-resource rules remain closed.

## New fixed hypothesis: keep Armor and Sniper, fund Movement from Might

The actual seven-point ranged template is **P0 A3 M1 S3 V0 E0**. Test **P0 A3 M0 S3 V1 E0** instead:
retain maximum Armor and Sniper, exchange Might’s 8% non-ranged attack-stat bonus for one movement
point. This is a fully funded different trade, not a rule selecting old validation winners.

Reusing all 108 seven-point discovery cases, rather than only the selector's chosen examples, gives
the following development-only comparisons. Each uses one combat observation per plan and cannot
qualify a rule:

| Point used to buy Movement | Old discovery paired gain |
| -------------------------- | ------------------------: |
| Might                      |                +7.8704 pp |
| Armor                      |                −1.8519 pp |
| Sniper                     |               −14.8148 pp |

Sniper's third level raises both attack and shot distance; giving it up pays two costs. Might's
first level raises the attack stat on non-ranged attack modes, including shooters forced into melee.
Its loss is not universally an 8% damage loss. The new fixed rule can still regress, especially in
armies relying on melee damage, which is why fresh complete fights are required.

Activate only on that exact accepted own seven-point template; otherwise retain the incumbent.
The predicate uses own budget and own plan. It cannot inspect terrain, hidden opponents, identities,
combat results or the old discovery selector. Pick the plan before the normal setup/formation path;
execute the ordinary ranked split, placement and single augment application.

The new screen keeps the same frozen corrected engine and captured H64/R2/K6 server profile.
Its 72 opening checks and **84 full preflight fights** pass, including exact ordinary/incumbent and
checkpoint/full-snapshot controls. Independent Python reconstruction checks all 1,629 distinct fresh
seed channels, legal spending, actual buff powers, roster supply and nonoverlapping occupancy.
Reconstructing every one of the 900 configurations through the canonical helper's augment override
before tactical splitting produces the exact effective configuration used by this screen. Placement
and the Nature capacity bonus remain unchanged, so the split roster also matches exactly.

| Registered population                     | Offer boards | Paired cases | Full fights |
| ----------------------------------------- | -----------: | -----------: | ----------: |
| Primary: own seven points, opponent seven |           48 |        1,152 |       2,304 |
| Stress: own seven, opponent five and six  |      Same 12 |          288 |         576 |

Every offer board crosses all three maps, both actual draft seats and both physical sides.
The primary also uses two independent actual combat streams per case. Draft and artifact choices
are reconstructed for each map, rather than changing terrain after drafting. Whole-board uncertainty
therefore retains all map/seat/seed dependence. The 576 primary configurations contain 95 distinct
own name-rosters, 44 creature types and two to five native shooters. This is the canonical ranked
draft population, not proof about every synthetic cohort or opponent controller.

The fixed primary requires at least +2 pp paired gain, a positive whole-board 95% interval, exact
paired p below .05, activation on at least 24 boards and every correctness gate. Stress results and
favorable map/roster slices cannot rescue failure. Independent TypeScript and Python must reproduce
the complete 20,000-sample bootstrap distribution and exact sign-flip result. Passing would only
fund fresh 6,000-game qualification, unchanged confirmation, broader opponents/cohorts and live-path
checks. No policy qualifies from this screen alone.

**Collection in progress.** Do not interpret partial outcomes. One four-worker pool, fixed sample and
a 90-minute registered primary/stress budget; no speed claim on the shared contended host.

The ignored packages `game/core/tmp/analysis/augment-loss-mechanisms-20261026` and
`game/core/tmp/analysis/augment-preserve-armor-movement-20261026` retain registrations, immutable
source/tool/input hashes, every raw request, all-sign case diagnoses and independent verification.
Generated results remain outside Git.
