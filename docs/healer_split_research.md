# Healer splitting and protected support placement

Later routing decision: the user explicitly adopted a new situational dispatcher over these split
alternatives. See [unit-support adoption](a19_unit_support_adoption.md). The original gates and
evidence below remain unchanged; this study does not qualify the new dispatch rule.

This is Healer-only setup research. It does not activate a combat override, change the default profile,
or purchase Placement. The helper in `src/simulation/healer_split_research.ts` is intentionally outside
the public AI and serving imports.

The user requested half-sized healing stacks and one-creature buff stacks, particularly with Abomination,
Goblin Knight, Troll and Frenzied Boar. These roles have different timing needs; a single unconditional
split rule has not been qualified.

## Preserved situational research options

The user requested committing the gains while keeping different configurations available for different
settings. The compact [evidence checkpoint](evidence/healer_split_pilot_20261108.json) preserves the
three tested options, all 36 paired board results, the original uncertainty and failed gates, and all
80 consumed setup/combat seed channels, including the four smoke boards. The complete raw archive is
identified by SHA256 in that checkpoint. This is acceptance of a research reference; no conditional
selector has been fitted or enabled in the default profile.

Keep the tested helper unchanged at SHA256
`11cdb736b3d39500974bd752574e9bd9dcea2300e69549e9d574153e0e84ecdc`. Implement any new selector or
placement treatment separately so the three measured alternatives remain reproducible.

Situational selection is the next hypothesis. These are decision inputs to test, not qualified rules:

| Configuration         | Potential use                                                                                   | Cost or failure mode to evaluate                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One protected single  | An extra full-strength Spiritual Armor turn while retaining a large healing stack               | Consumes a slot; the small stack must survive and reach a useful unbuffed ally                         |
| Protected halves      | Two useful healing or Blessing turns when both halves retain power three                        | Casualties can remove higher-power spells; smaller casts and altered formation can hurt                |
| Two protected singles | Several valuable allies need separate armor buffs and safe support cells exist                  | Two slots can displace other useful children; extra fragile stacks and low-value heals can waste turns |
| Current setup         | No available slot, no useful additional support turn, or another utility split is more valuable | May leave a useful Healer split or safer position unexplored                                           |

Candidate scoring should use the actual own stack amounts, post-split spell power, repairable front-body
HP, buff coverage, activation timing, legal positions and the utility split displaced by a new child.
Troll's regeneration makes timing particularly relevant. Threats and opponent features must come only
from the serving observation allowed by the current doctrine; hidden research state is not an input.

The observed variation by ally, map and doctrine motivates testing these inputs. Nine boards per ally
cannot establish rules such as always halving with Goblin Knight or never halving with Troll. First
isolate protection of existing Healers from split priority and native formation changes. Then freeze a
conditional selector using training families only, validate on separate families, and qualify it on a
new fixed bank against current setup and the matched protected-single control. Preserve the failed
pilot gates and exclude this checkpoint's consumed channels. Purchases of Placement remain separate.

## Mechanics

- A split receives a complete independent spellbook. Healer starts with four Heals, two Spiritual Armors,
  two Blessings and three Mass Heals. Spending a child stack's charge does not consume its parent's charge.
- Heal and Spiritual Armor require stack power one. Blessing and Mass Heal require power three.
  Spiritual Armor's percentage does not shrink with the caster's creature count.
- Stack power uses living creature experience relative to the largest stack on either team. On a board
  whose largest stack is worth 1,000 experience, 20 Healers have power three; 17 retain it, but 16 fall to
  power two. Current standard unsplit roster sizes allow the initial 20/20 split to retain the larger spells.
  Casualties and nonstandard opponent sizes can change that result.
- Healing scales with living caster count and repairs only the surviving front creature. Splitting does
  not double the total raw healing budget. It changes activation timing, overhealing, buff charges,
  durability and spell eligibility.
- Troll restores its front creature's HP at activation through Wild Regeneration. A timely heal can save
  that creature before activation; a heal immediately before safe regeneration may have little value.

## Fixed pilot

The local `healer-split-pilot-20261108` study freezes common `b456ea729d01225262749be60daf322ab508fe2c`
plus this research helper and server `7504119f0b4a160be6ad752e4410179c2ec05745`.
The source comes from committed snapshots rather than parallel agents' unfinished working files.
Both teams retain the same ordinary A19 combat, including intrinsic unit overrides.

There are 36 new independent prescribed-army boards: one in every requested ally × own doctrine × live
map cell. Each army already has at least eight funded stack slots. The four arms are current native
setup, a protected one-body Healer child, a protected half-size child, and two protected one-body children.
Both physical seats give 288 fights, 72 per arm. All other augments, artifacts, synergies, opposing
formations and combat futures stay matched. Prioritizing Healer children can displace another utility
split; that trade belongs to the measured policy rather than being ignored.

The sampler prescribes the augments: 22 boards have no Placement purchase and 14 already have Placement
upgrades. This experiment does not test the live AI's willingness to buy those upgrades, and does not
establish that purchasing them is worthwhile. Every arm pays the same existing budget.

The primary comparison is halves versus current setup. A protected one-body split is a required
same-budget control. Five registered contrasts use whole-board bootstrap intervals, stratified by ally,
with a Bonferroni familywise adjustment. A candidate must gain at least one point against current setup,
have positive adjusted lower bounds against both controls, and have nonnegative means for all own
doctrines before progressing. A pilot pass would still require a separate fresh confirmation.

All splits and final positions are applied through the frozen server's real actions before deterministic
combat. The native opponent's formation and barrels must match across arms. Four separate smoke boards,
eight exact A/A combat replays, and admission debugging fights are excluded from strength evidence.

After the complete bank, every physical-seat context whose score changes in any research arm is selected
for an exact four-arm diagnostic replay. These provide committed health, buff and turn-order observations;
they add zero independent games and cannot qualify a tuned policy.

Raw data, registration, hashes, verification and the standalone report remain in the client workspace's
ignored `game/core/tmp/healer-split-pilot-20261108` directory. The existing paid-placement promotion
requirements in `placement_research_promotion.md` still apply to any future spending policy.

## Complete pilot result

All 288 fights completed and passed raw verification. The 36 independent boards, both physical seats,
956 accepted split actions and 576 team formations were checked against frozen inputs. The opponent,
funded augments, artifacts and synergies remained fixed. Source hashes, spellbooks and creature totals
matched. Independent integer score arithmetic reproduced every paired contrast and bootstrap interval.

| Setup                 | W / D / L   | Draw-aware score | Gain against current | Whole-board 95% | Adjusted 95%, five contrasts |
| --------------------- | ----------- | ---------------: | -------------------: | --------------- | ---------------------------- |
| Current native setup  | 22 / 1 / 49 |           31.25% |                    — | —               | —                            |
| Protected single      | 28 / 3 / 41 |           40.97% |             +9.72 pp | −1.39 to +21.53 | −4.86 to +25.00              |
| Protected halves      | 30 / 0 / 42 |           41.67% |            +10.42 pp | −1.39 to +22.22 | −4.17 to +26.39              |
| Two protected singles | 30 / 2 / 40 |           43.06% |            +11.81 pp | −1.39 to +25.00 | −5.56 to +28.47              |

Halves gained only +0.69 pp over the protected single control (adjusted interval −17.36 to +18.75).
Two singles gained +2.08 pp over that control (−15.97 to +19.45). **Both registered progression gates
failed. No fresh confirmation was opened, and no policy was promoted.** The shared Healer prioritization
and rear-placement treatment is promising, but the pilot does not isolate which component helps or
establish the best split size.

Whole-bank Healer casts changed as expected: halves cast Blessing 89 times versus 40 in current setup,
and Mass Heal 178 versus 103. Two-single setups made 151 Spiritual Armor casts from one-body children.
These are observed actions, not estimates of useful buff value or additional strength samples.

Small subgroup means also warn against a universal rule: halves were −5.56 pp in the nine Troll boards,
while two singles were −12.50 pp in the twelve Scout boards. These descriptive slices neither qualify
nor disqualify a unit-specific rule without new evidence.

## Exact diagnostic replays

All 176 registered replays completed: four arms for each of the 44 changed-result seat contexts, covering
29 existing boards. All turn, event and outcome hashes matched. The audit reconciled 12,805 turns and
33,328 committed health observations. These are zero new independent strength games.

Within this selected sample, current setup produced 44 physical attacks while Blessing was active,
the protected single 70, halves 118, and two singles 65. Actual HP restored during Healer casts was
8,345, 11,272, 10,347 and 10,636 respectively. This describes different fight trajectories, including
different survival times; neither metric identifies the cause of a win.

Halves also have a spell-access tradeoff. Of the stacks observed at power three or above on their first
activation, 43 of 82 half stacks later fell below three, compared with 20 of 43 current-setup stacks,
21 of 43 protected-single stacks, and 18 of 43 two-single main stacks. The doubled raw count for halves
must not be mistaken for a doubled per-stack failure rate. Casualties and the changing largest stack
on the board can both affect power.

Troll healing timing deserves a separate combat hypothesis. In the selected half-stack replays, three
single-target Heals restored 99 HP with no recorded incoming damage before the Troll's next activation.
Two occurred in board 15's green-seat loss, restoring 39 and 28 HP immediately before safe Troll turns.
Wild Regeneration could repair the front body at activation, so these are potential low-value casts,
not evidence that a different action would win. Four additional Mass Heal contributions in that arm
also preceded safe Troll activations; those casts may still have benefited other allies.

The next setup experiment should isolate protecting existing Healers from changing split priorities,
preserving incumbent child order wherever rosters match. Native formation recomputation and child-order
changes currently prevent attributing the result solely to rear placement. Split-size choice, buff-target
timing, Troll regeneration and spending on Placement remain separate hypotheses. This pilot and its
selected replays cannot promote or train a replacement default.
