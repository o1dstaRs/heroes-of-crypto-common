# Battle Mage target coverage

`battle-mage-impact-coverage-v1` repairs a target omission in the shared A19 combat path. Previously,
Meteorite offered only the area with the largest non-overkill HP damage. Search could not select an
isolated valuable target or exclude a neighboring reflector if that meant dealing less total HP damage.

Battle Mage now offers each distinct visible Meteorite impact to the existing engine-backed search.
The historical greatest-damage choice remains first. Equivalent anchors are deduplicated by ordered
victim IDs, preserving reflection order and counting multi-cell bodies once. Water Shield breaks remain
available even when they initially deal zero HP damage. Entirely immune groups are omitted. Hidden
enemies do not supply anchors or ranking information. Other casters retain their historical catalogs.

The normal A19 factory and native v0.8 fallback/continuation policy share this coverage. Search keeps
the existing six-candidate shortlist, complementary R2, horizon 64 and one-second live allowance.
`V08_BATTLE_MAGE_TARGETS=off` restores the previous target coverage; `green` and `red` enable it on
one physical seat for matched comparisons. This is a combat targeting change, not a trained model,
placement change or modification to the locked V3 draft.

Exact-engine regressions cover both physical seats, a lethal fire-immune shooter versus a larger decoy
cluster, an unnecessary adjacent Magic Mirror, overkill, multi-cell targets, magic resistance, shield
breaks, earth immunity, hidden information, spent charges, stack-power eligibility and snapshot/RNG
rollback. Existing Fire Strike obstruction and charge-conservation regressions remain required.
These constructed tactical cases demonstrate the repaired decisions; they are not an overall ranked
win-rate estimate. Source publication and production deployment must be reported separately.

## User-accepted default and fixed comparison

The user explicitly requested “lock it into strat and continue further making it better” after the
independent 250-game comparison. Keep `battle-mage-impact-coverage-v1` enabled in the shared default
and retain common commit `1111040539bb0a35fbbfd1639d418ddac0c65e33` as the fixed research comparator.
Client and server pins already include this implementation. This acceptance does not establish a strength
gain or mean that a production deployment occurred.

The complete new bank scored 126 wins, 2 draws and 122 losses: 50.8% draw-aware score over 125
independent board families, whole-board 95% interval 47.2–54.4%. All 250 fights completed with zero
rejected actions. The earlier 96-game pilot remains separate. Both use prescribed armies containing
Battle Mage and headless formations; they do not exercise ranked drafting. Compact identities and
reserved seeds are retained in `evidence/battle_mage_targeting_20261109.json`.

Further experiments must preserve this accepted baseline, use separate policy IDs, and exclude these
boards from fresh confirmation. The continuation-policy experiment in
`battle_mage_target_research.ts` is explicitly scoped research and does not activate on import.

## Continuation-policy follow-up

Correction to the initial posthoc audit: its compact action records omit spell names and targets, so
the claim that all nine negative pairs first diverged on another unit's turn was not established.
Neither was the analogous claim for ten of eleven positive pairs. A spell can change before the first
visible difference in that compact format. Use full `turnExecutionObserver` applied actions, including
spell identity and target, for action chronology; use committed-health observations for actual HP effects.
The numerical game results below are unaffected. Continuation coverage can influence other units'
plans, but these incomplete logs do not demonstrate that mechanism in the original cases.
Enriching the original Mage casts from their full execution records exposes an earlier Mage spell
change in four of the nine negative pairs. Other casters' complete actions were not retained in that
bank, so the remaining first-actor classifications still need full replays.

The separately registered `battle-mage-root-coverage-legacy-rollouts-v1` candidate kept accepted
coverage on actual turns, but restored the former native Mage choice inside its team's continuations.
On 250 new fights using all 125 reused development boards, it scored 121 wins, 3 draws and 126 losses
against the accepted policy: 49.0% score. The descriptive whole-board bootstrap interval was
45.6–52.2%; these reused boards are not fresh strength evidence. Its fixed 51% progression threshold
failed, so the reserved 250-game fresh bank remained unopened. The accepted default is unchanged.

All 250 games had zero rejected actions and restored the research scope. Independent verification
checked every raw receipt, paired opening and frozen source, plus two exact candidate replays. The
696 original source files were unchanged; only the import-inert research module was added. No GPU,
model fitting or optimizer steps were used. Registration SHA256:
`cf749c7245926470ae8afb8012c32d0ad95b06bf344a37a3fad0c325ed5e4a68`.

This experiment does not support reverting the accepted continuation coverage. Further targeting
work should retain it as the comparator and examine the actual rejected or selected targets, spell
charges and post-cast exposure in matched traces. Do not select a map-specific rule from this bank
or reopen its failed fresh gate.

## Puffalo shortlist follow-up

The separately registered `battle-mage-root-shortlist8-v1` widened only the candidate Mage's ordinary
root shortlist from six to eight. It kept accepted continuation coverage, neural weights, horizon,
incumbent gate and every other actor's budget unchanged. On 250 fights from 125 new board families,
it scored 124 wins, 2 draws and 124 losses: 50.0%, whole-board 95% interval 48.4–51.6%. Its 51%
development gate failed; the reserved 1,008-game confirmation stayed closed. No policy was promoted.
Registration SHA256: `c5c98eaab67c16f5f5a52c21db413fa3955934672b7b23bc9247e32f3d43612b`.

All raw receipts, paired openings and 702 frozen source files were verified. An analysis-only correction
fixed a reversed numeric-team assertion; the simulator had used the correct exported team constants,
and no game, scoring rule or gate changed. Eight exact replays cover both seats of all four families
whose winner changed. Full result, Mage execution and search records match, and committed HP ledgers
reconcile. These are posthoc diagnostics on four existing families, not additional strength evidence.

The first actual difference was a Mage cast in each pair. In one winning pair, Fire Strike on a nearby
Harpy replaced a larger hit on a Leprechaun; later source-attributed Harpy damage was 221 versus 736 HP.
In another, concentrating damage on Hydra removed it before its later healing and damage in the other
branch. One losing pair spent Meteorite for 174 HP on an enemy Mage while an included Black Dragon
took zero damage. The other gave up a lethal Mage hit plus Healer damage to wound a Griffin; the spared
Mage subsequently dealt 163 HP. Further actions diverged too, so these totals describe the branches
without isolating one cast as the sole cause of victory.

The separate research-only candidate is `battle-mage-contact-shortlist6-v1`: reserve at most one omitted
legal Fire Strike against an enemy already touching a friendly footprint, replacing only the last
nonlethal Meteorite finalist. Preserve the incumbent, lethal finalists and the six-slot cap. A simple
contact-pressure proxy selects the reserved option; normal engine-backed arbitration still chooses the
actual action. This is an unqualified hypothesis, not a rule to force Fire Strike or target a named unit.
The separate campaign excludes all prior consumed and unopened seed channels. Its confirmation must
remain closed unless the fixed development gate passes, and live budget/runtime qualification remains
separate from research strength.

Its completed independent development bank also scored 50.0%: 125 wins and 125 losses on 125 new
board families. All 125 paired family scores were neutral, with zero rejected actions. Twenty-two
reservations occurred across 21 families; two reserved choices were actually selected, and three
families had changed action traces. Six exact replays of those three families passed original-result,
Mage-turn, search-choice and committed-health verification. They add no independent games. The
candidate reduced some threats in those traces, but no winner changed. Its fixed 51% gate failed and
the 1,008-game confirmation stayed unopened. Registration SHA256:
`a67c9b839e848444be01206ef22e27251ce26d9b95800f429982f3506ee7f716`.

The empirical paired bootstrap is degenerate at 50% because every observed family is neutral; this
does not prove zero effect on unseen boards. A separate diagnostic no-flip bound permits up to 1.184
score points of absolute population departure at 95% for the same independent sampling mixture:
the upper nonneutral-family probability is `1 - 0.05^(1/125)`, and a family can differ from 0.5 by at
most 0.5. This does not replace either registered gate. Neither shortlist candidate is activated.
The next evidence need is matched alternative-action outcomes for the final spell/target evaluator,
including lethal threats, charge value and subsequent healing, rather than another blanket budget increase.

## Matched final-action audit

`battle-mage-action-audit-puffalo-20261109` examined all 22 contact reservations from 21 existing
families, selected by the reservation firing rather than its outcome. At each exact original position,
compare the final AI choice, the contact proposal and the search choice before neural correction.
Four new matched futures per root produce 180 distinct continuations and 264 logical arm outcomes;
84 identical-action outcomes are reused exactly. These are conditional diagnostics on previously used
boards, not a full-policy strength bank or additional independent boards.

The final choice scored 62 wins, 1 draw and 25 losses across 88 logical outcomes; contact scored
57/1/30 and pre-neural search scored 63/0/25. Root-weighted scores were 71.0227%, 65.3409% and
71.5909%. Equal weighting of the 21 families gives contact-minus-final **−5.9524 points**, whole-family
95% interval **−15.4762 to +2.9762**. The secondary pre-neural contrast is +0.5952 points
[0, +1.7857], entirely from one draw becoming a win. It does not justify disabling neural correction.
Contact has four positive, five negative and thirteen neutral root means. Across matched root futures,
it helps four, harms nine and leaves seventy-five unchanged. These futures are clustered, not independent
games for uncertainty calculations.

All 21 original captures, 22 original-stream controls and 180 continuations passed source, prefix,
root-state, applied-action and committed-health verification. Six correctness replays per host match
between macOS and Puffalo. An admission-only amendment warms configuration outside seeded games and
excludes elapsed preflight time from fingerprints; the initial check had caught one-time configuration
UUID allocations and timing fields. No registered action, seed, hypothesis or completed outcome changed.

The losing traces expose several distinct costs of forcing contact:

- On board 40, the contact cast spends 53 HP of damage on Trent. In all four controls a Wolf kills
  Trent before Trent acts anyway. Ignoring Zena instead raises its later source-attributed damage
  from 212.25 to 893.25 HP on average and converts two wins to losses.
- On board 34, targeting Champion gives up a Meteorite hit on both Ogre Mage and Battle Mage.
  The candidate caster never spends Meteorite in any of the four continuations and dies earlier in
  three; the opposing casters deal more damage. This converts two wins to losses.
- On board 53, the final choice kills Magic Dragon despite taking reflected damage. The contact
  alternative leaves Dragon alive for 721.5 later source-attributed damage on average. On board 64,
  sparing Cyclops raises its later damage from 195 to 1,242.75 HP. Each loses one matched win.
- On board 59, damaging Angel spends its self-resurrection charge. The contact alternative targets
  Unicorn and permits an allied Resurrection cast in all four futures, targeting Battle Mage in
  three. This converts two wins to losses. Self-revival HP outside the ordinary health-change
  funnels is recorded separately from attributed damage and spell resurrection.

There are also useful switches: finishing Nomad or Pegasus, pressuring Unicorn, and hitting Berserker
instead of the final Mage target improve their respective root means. They do not establish a general
unit rule. In particular, a lethal cast can be redundant, as the Trent case demonstrates.

A further 21 exact replays inspected the search leaves without changing any battle. Nine roots give all
six finalists the same primary score. Of 245 recorded R2 samples, 212 reach actual simulated terminals
and 33 remain nonterminal; none of the latter rounds to exactly zero or one. This rules out floating-point
saturation as the cause of these ties. Two antithetic samples and native-policy continuation differ from
full-A19 future play; this audit alone cannot separate sampling uncertainty from continuation-policy error.
The next evaluation needs action-denial, support/charge value and continuation fidelity, with disjoint new
training and validation families. The saved 45 action-label groups are discovery-only, with zero held-out
families and no fitted model. Both failed policy confirmations remain closed.

Primary registration SHA256:
`7884cac35c98be0d21735142ef9f1d979e3a2098d9b92cab02b1f9f20bd8728f`.
Verified raw archive SHA256:
`331b3af47f324a2821cce44f7828db587b9ca5fa7a353876ccb9cb279f53ba05`.

The separate fixed `battle-mage-matched-native-tail-20261109` diagnostic adds 180 continuations using
the same roots, actions and future seeds. Only subsequent search and neural correction are disabled
for both teams. Every original prefix, root cast and committed-health prefix matches; all post-root
scoring, rollout and neural-inference counts are zero. Thirty-two outcomes differ from the full-A19
continuations. The sets of best observed actions are disjoint on three roots. These are outcome-selected
diagnostics over four futures, not a deployable policy or new validation families.

With native later turns, contact-minus-final is −23.8095 points [−41.6667, −7.7381]. The difference
between full-A19 and native contact contrasts is +17.8571 points [0, +36.9048]; its interval does not
establish a positive population interaction. Both armies change their later controller, so these scores
do not compare native AI strength against A19. Equal seeds couple the counterfactuals, but actions can
consume randomness differently; actual native turns also differ from the R2 antithetic streams and
fixed horizon. Keep these diagnostic labels separate from full-A19 training targets. No models were
fitted, defaults changed or failed confirmation banks reopened.

Native-tail registration SHA256:
`596f3b5accbf26539cb0b9923a8e2bec7bfb5f5801e1f63e45bcfc55d999197e`.
Verified native-tail archive SHA256:
`dede204ecbe7d7b62c05a78e5787ff071d22e4048d84c387d91ecad26a3b9b4d`.

## Preserved monotone ranker and finish guard (November 14)

`src/simulation/battle_mage_finish_guard_research.ts` preserves the exact
`monotone-action-value-030` bytes and the separate `battle-mage-finish-guard-v1` research rule.
Neither is imported by a live/default AI factory. The adopted `battle-mage-impact-coverage-v1`
coverage remains unchanged. Loading this checkpoint does not make it a qualified serving policy.

The original fixed independent comparison used 864 new offer-board families, two physical seats and
three arms: 5,184 fights. Both armies used locked V3 draft plus full v0.8/A19, conditional on the
designated army drafting Battle Mage, on common `64acda5b` / server `aa0ce524`. The candidate scored
967 W / 28 D / 733 L (56.770833%), versus current A19 962 W / 26 D / 740 L (56.423611%) and the
locked 5036 reference 962 W / 27 D / 739 L (56.452546%). Its paired gains were +0.347222 points
[-0.405093, +1.099537] and +0.318287 [-0.694444, +1.302083], respectively, with whole-family 95%
intervals. Both failed the user's 0.5-point useful-gain threshold and positive-lower-bound gate.
Battle Trance also regressed against the locked reference. The older positive 108-family pilot is
separate and must not be pooled into this primary result.

All 5,184 saved raw fights were reverified before the new diagnostic. Among 238 changed casts, 26
improved the terminal result and 21 regressed; the rest kept the same outcome. Fire Strike to
Meteorite accounted for 12 of the 21 regressions. More immediate HP was dealt in 19 of the 21
regressions, so maximizing immediate damage is not sufficient. These are posthoc mechanisms,
not newly qualified unit-specific rules.

The new guard first computes the unchanged learned choice. It keeps that choice only if the
public pre-cast projections for `stacksFinished`, `unactedFinished`,
`resurrectionChargesFinished` and `shieldBreaks` each preserve or increase the baseline count.
Otherwise it keeps the original final A19 action. The first eligible attempt is consumed even on
rejection: there is no alternative reranking or later-root retry. All four counts must be finite,
nonnegative integers; malformed inputs retain A19. Model weights, normalization and the 0.03 margin
are unchanged. This is a count constraint, not target-identity preservation or guaranteed action denial.

On the already inspected historical bank, selecting the corresponding stored branch prevents nine
regressions but discards five improvements. It retains 160 interventions: 21 improved outcomes,
12 regressions and 127 unchanged outcomes. Its retrospective score is 971 W / 27 D / 730 L
(56.973380%), +0.549769 points versus current A19 and +0.520833 versus locked. Descriptive whole-family
intervals remain [-0.086806, +1.215278] and [-0.405093, +1.446759]. These reused outcomes are discovery
only; no fresh guard gate has been evaluated. Battle Trance versus locked remains -0.434028 points.
There are zero new independent games, fits or optimizer steps. Python and Bun agree on all 1,479
eligible stored choices. Six fixed numerical regressions preserve representative accepted/rejected choices.

The five discarded improvements expose the limitation of unconditional finishing. In one, spending
Meteorite on a lone 9-HP Dryad loses while damaging Goblin Knight, Wandering Mage and Elf wins. In
another, finishing one 8-HP Peasant loses while reducing Zena from five bodies to three draws. Two
stacks of the same creature must be distinguished by unit ID: finishing a one-body Wandering Mage
loses where weakening its 45-body counterpart wins.

The retained losses expose partial-stack threat and subsequent allied decisions. One comparison
weakens Cyclops from four bodies to one; the alternative damages Cannon/Beholder, leaving Cyclops
to deal 102 HP rather than seven on its next turn and survive the next retaliation. Another leaves
Zena at seven bodies instead of three; its next activation shoots Fairy for 471 HP, while the weakened
Zena moves without attacking in the control. Killing a
small Centaur or Elf can still be inferior to weakening a dangerous Gargantuan or the larger Elf.
These exact branch observations motivate future action-denial and allied-follow-up features; they do
not establish that every terminal loss was caused by that single event.

One original public feature approximation remains recorded: killing Satyr removes Helping Hand
mid-Meteorite. The subsequent Arbalester hit kills more bodies than an independent per-target estimate
using its previous max HP. The 510-HP capacity reduction is not direct spell damage. Both arms win;
the mismatch was retained, with no outcome exclusion or gate change. Any future exact-effect feature
must use legal visible inputs and declared modelled randomness, not the actual hidden future RNG.

Fresh testing must freeze the current engine and server together, exclude all previous and reserved
channels (including the complete old confirmation ledger and newer peer ledgers), and retain current
A19 plus the locked 5036 reference. The proposed new banks are 432 families / 2,592 fights for
qualification, then only after a pass 864 new families / 5,184 fights for independent confirmation.
Both contrasts must gain at least 0.5 points with positive whole-family 95% lower bounds, every own
doctrine nonnegative and exact legal application. No refilling, model change or subgroup dispatch
after opening a bank. Runtime/Undo/live-budget qualification remains required before any adoption.
The old compute cutoff expired; this checkpoint does not authorize a new simulation campaign.
