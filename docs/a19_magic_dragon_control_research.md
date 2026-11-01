# A19 Magic Dragon: testing discarded Whirlpool casts

Completed October 27, 2026. This follows the
[six-unit mastery census](a19_six_unit_mastery_research.md), where Whirlpool was available on 206
designated Magic Dragon activations but reached the shortlist on only 46. That is a coverage
question, not evidence that casting more Whirlpool improves play.

The separate action-family policy experiment is under another owner. This study
does not change that candidate, its data or the shipped controller. It asks whether a discarded
Whirlpool target improves a complete actual-controller continuation at a fixed historical root.

## Registered comparison

- Twelve positions from twelve distinct natural-draft armies in the completed census. Each live map
  contributes an opening and middle-phase position on each physical side. Own budgets 5/6/7 contribute
  four positions each; both draft assignments contribute six. Hash-based constrained matching uses
  no combat outcome or preferred spell target.
- Each root's original actual choice competes against **every** distinct Whirlpool action in its
  filtered production catalogue: four to seven targets per root, with no Whirlpool in the original
  shortlist. The historical prefix, full root/reference witnesses and original action ownership
  must match the unchanged census replay.
- Eight paired actual-combat future streams per action: 568 complete discovery fights. Choose one
  Whirlpool by terminal mean, ties by action signature. Keep negative and tied discovery selections.
  Lock all twelve targets before independent validation.
- Thirty-two new paired future streams per root for the original action and its locked Whirlpool:
  768 full validation fights. Both armies use actual H64/complementary-R2/K6 A19 on later searchable
  turns; AI Driven units retain their ordinary bypass. The historical internal controller seed stays
  fixed; the independent actual-combat stream starts at the committed root action and preserves UUID.
- Report all twelve comparisons. Use paired terminal win/draw/loss scores, exact sign-flip tests,
  Holm correction across twelve roots, and pointwise plus Bonferroni-family-adjusted bootstrap
  intervals. Independent Python and TypeScript checks must agree.

The twelve unchanged controls matched their original complete census games. Source, registrations,
seed exclusions, target lock and branch evidence stay outside Git under
`game/core/tmp/analysis/magic-dragon-control-20261027` in the client repository. The seed audit found
no collision among 492 planned channels against 707,572 known local/active-peer seed values.

These are conditional action comparisons on old diagnostic armies. They cannot establish a
new-army policy win rate, admit teacher labels or qualify a production change. Any general rule
still needs a separate registration, fresh complete-game cohorts and held-out confirmation under
the [promotion gate](placement_research_promotion.md).

## Completion

**No positive action comparison passed the registered twelve-root evidence gate.** The original
study completed 1,348 full fights: twelve exact unchanged controls, 568 discovery fights and 768
locked validation fights. Its mean conditional difference is −0.52 percentage points, which is
descriptive across these twelve positions and **not a policy win rate**. All twelve Holm-adjusted
p values are 1. There are two positive point estimates, two negative and eight zero.

The unchanged controls reproduce their original complete census games, not just their selected
root. All committed interventions are accepted; every discovery/validation battle ends by
elimination. There are 70,499 actual search-root restoration checks, 33,709 later searched roots
and 15,138 later A19 overrides of the native proposal. Independent Python and TypeScript agree
on the raw pairs, seed hashes, full bootstrap distributions, exact tests and corrections.

All values below are terminal score points out of 32 paired futures. Intervals are the registered
Bonferroni-family-adjusted empirical bootstrap intervals, in percentage points.

| Root | Map / physical side / lap | Locked Whirlpool target | Original → Whirlpool | Difference pp | Adjusted interval pp |
| ---- | ------------------------- | ----------------------- | -------------------- | ------------- | -------------------- |
| 01   | Normal / RED / 5          | Squire                  | 0 → 0                | 0             | [0, 0]               |
| 02   | Normal / RED / 1          | Manticore               | 32 → 32              | 0             | [0, 0]               |
| 03   | Normal / GREEN / 3        | Angel                   | 32 → 32              | 0             | [0, 0]               |
| 04   | Normal / GREEN / 2        | Cyclops                 | 9 → 4                | −15.625       | [−46.875, +15.625]   |
| 05   | Lava / RED / 3            | Zena                    | 32 → 30              | −6.25         | [−21.875, 0]         |
| 06   | Lava / RED / 2            | Tsar Cannon             | 0 → 0                | 0             | [0, 0]               |
| 07   | Lava / GREEN / 3          | Manticore               | 13 → 17.5            | +14.0625      | [−20.3125, +47.3991] |
| 08   | Lava / GREEN / 2          | Cyclops                 | 0 → 0                | 0             | [0, 0]               |
| 09   | Block / RED / 3           | Dryad                   | 0 → 0                | 0             | [0, 0]               |
| 10   | Block / RED / 2           | Tsar Cannon             | 29 → 29              | 0             | [−21.875, +21.875]   |
| 11   | Block / GREEN / 5         | Dryad                   | 0 → 0.5              | +1.5625       | [0, +7.8125]         |
| 12   | Block / GREEN / 1         | Trent                   | 0 → 0                | 0             | [0, 0]               |

Seven positions have saturated outcomes in both arms. Their degenerate empirical intervals do
not establish zero true uncertainty, universal wins/losses or action equivalence. Root 10 has
three improving and three regressing streams despite zero mean difference.

## A proven immediate-value representation gap

A separate observer replayed all twelve original controls and recorded the **existing** immediate
leaf evaluations. It added no action, score call or rollout. Every complete trajectory, root input,
native ownership, behavior digest and final state still matches the unchanged control.

The **59 distinct Whirlpool targets collapse into exactly one full 60-component feature vector
and one leaf value per position**, across all twelve positions. This checks the actual deployed V2
input and returned value; it is stronger than inferring a blind spot from feature names.

`src/simulation/value_features.ts` encodes army HP, attack, composition, positions and whether a
stack has already acted/hourglassed. It does not encode which stack has a pending skipped
activation. Its "yet to act" count does not account for Whirlpool. The immediate value model
therefore cannot distinguish disabling Squire, Cannon or another legal target when those casts
otherwise leave the represented state unchanged. All twelve roots had discarded the entire
Whirlpool family before the actual searched shortlist.

This is a **shortlisting/value representation limitation**, not a spell-engine failure. The rich
replays show actual Whirlpool skips, and the existing spell tests pass. The H64 search can observe
those skips if a cast reaches it. A feature change alone cannot recover a cast that is still
excluded, and admitting an arbitrary target alone does not establish stronger play.

## What the individual games explain

The explanation protocol was registered before validation outcomes: for every root, replay its
first improving and first regressing stream; if neither exists, replay stream zero. All thirty
branches exactly match their original complete games. These replays add no strength labels or
independent armies. Root HP accounting includes removed dead units as zero HP and requires their
destruction event; cleanup must not make a lethal spell look like zero damage.

- **01, Squire:** the 283-HP dragon is its army's only survivor against 2,130 enemy HP. Whirlpool
  really denies Squire's lap-five activation, but Squire later kills it at lap seven. This root
  samples the result of earlier army losses; an unused control option is not itself a rescue.
- **02, Manticore:** the reviewed Whirlpool does not apply to any unit. Original Lightning reduces
  Zena from 355 to 166 HP. Both arms still win all validation streams; a favorable army can conceal
  an ineffective activation.
- **03, Angel:** the reviewed Whirlpool does not apply to the 39-HP Angel. Lightning instead reduces
  Elf from 240 to 117 HP. Both arms again win every stream. Neither saturation establishes how to
  spend control against a healthy, consequential enemy.
- **04, Cyclops:** Lightning removes 231 HP from the 402-HP stack. In improved stream eight,
  Whirlpool lands and Cyclops skips lap three; Dryad targets Medusa instead of the dragon and the
  army wins. In regressing stream two, Whirlpool does not apply: Cyclops deals 198 to the dragon
  and Dryad removes its last nine HP. Baseline wins that stream. The target has 23% magic resistance.
  Other future choices and random draws also change; the replay does not isolate resistance as
  the entire causal contribution.
- **05, Zena:** in regressing stream six, Whirlpool successfully skips Zena at lap four but gives
  up Lightning that would reduce Medusa from 234 HP to twelve. The healthy Medusa immediately
  shoots Squire for 222. Allied Arbalester then spends its shot on Medusa instead of Abomination;
  Abomination and Wolf Rider pressure the dragon. Successfully denying one threat can preserve
  another threat and consume an ally's next attack.
- **06, Cannon:** the freeze succeeds at lap two. The stack-power-three, 109-HP dragon still dies
  to Medusa that lap; without the freeze, Cannon kills it. Ring of Fire and Meteor Shower are
  unavailable at this power. Protection must cover more than the named key enemy.
- **07, Manticore:** Lightning **kills** the 147-HP Manticore and removes its army blessing.
  Enemy Squire/Arbalester magic resistance falls from 37.78% to 30.48%, Troll from 41.72% to
  34.88%, and Frenzied Boar from 77.82% to 75.22%. Freezing preserves the passive. In improved
  stream zero it skips lap four, and allied Cyclops/dragon survive. In regressing stream two
  it does not apply; Manticore later hits Troglodyte for 104. Its own resistance is 41.72%.
  Discovery was −31.25 pp and validation +14.0625 pp: this apparent gain was unstable.
- **08, Cyclops:** the freeze succeeds, but the 88-HP dragon dies to Dryad in lap two before
  Cyclops skips lap three. Original Lightning kills the 52-HP Gargantuan and also removes 75
  Cyclops HP in the complete action. Freezing leaves that Gargantuan alive.
- **09, Dryad:** it skips lap four, while Zena retains the 234 HP Lightning would remove.
  The reviewed alternate dragon dies on its own melee turn against Pikeman at lap seven;
  baseline survives until Zena kills it at lap nine. Both armies lose all validation streams.
- **10, Cannon:** it really skips lap three in both changed replays. In improved stream three,
  the dragon dies at lap four instead of baseline lap six, yet its army wins: allied Dryad helps
  remove Monk and Zena survives. In regressing stream two, Zena moves instead of shooting Pikeman;
  Monk then kills Zena for 275. The army loses despite a successful freeze and longer dragon
  survival. Count the army's follow-through, not only caster survival or denied turns.
- **11, Dryad:** Lightning kills the 99-HP target. In improved stream 23, Whirlpool instead
  successfully skips its lap-five turn; later Gargantuan, Monk and Troll decisions change and
  the result becomes a simultaneous-elimination draw. This is one recovered draw, not a qualified
  gain from preserving a killable target.
- **12, Trent:** the freeze succeeds at lap one, but the denied baseline action only attacks an
  obstacle. It also gives up 246 damage to Medusa, while Cannon and other shooters stay active.
  A later Cannon shot aimed at Zena also kills the dragon. Stack size does not measure the
  importance of the denied activation.

## Fresh precision rejects the attractive noisy subgroup

After completing and verifying the original comparison, a separate registration fixed its
largest positive and negative point estimates: roots 07 and 04. It kept the original locked targets
and original actual actions, allocated **128 fresh paired combat streams per root** and completed
all **512 fights** without an interim decision or stopping extension. This is explicitly an
outcome-selected diagnostic follow-up, reported separately; it cannot rescue the twelve-root test.

The new 258 combat/statistics seed channels do not collide with 730,038 conservatively collected
integer values from known local and peer seed/job/registration metadata. No peer outcomes selected
or tuned this study. Full raw branches and a separate source receipt are retained.

| Fixed root    | Original → Whirlpool points / 128 | Difference pp | Two-root adjusted interval pp | Holm p       |
| ------------- | --------------------------------- | ------------- | ----------------------------- | ------------ |
| 04, Cyclops   | 41.5 → 17.5                       | **−18.75**    | **[−30.8594, −6.6357]**       | **0.001797** |
| 07, Manticore | 66 → 64                           | −1.5625       | [−14.8438, +11.7188]          | 0.843021     |

The Cyclops cast is measurably worse **at this fixed position under fresh combat futures**.
It has sixteen improving, forty worsening and seventy-two tied paired outcomes. The apparent
Manticore gain disappears; its thirty-seven improving and thirty-eight worsening streams do not
support a positive exception. Do not pool these data into the original registration or extrapolate
either result to a general unit/artifact rule.

Independent Python and TypeScript again agree on both raw paired reductions, complete bootstrap
distributions, exact tests and corrections. Every follow-up action is accepted; all 512 games end
by elimination. The follow-up adds 34,878 actual search-root checks, including 20,030 later searched
roots and 11,045 later A19 overrides of native.

## Next experiment and promotion decision

**Keep the shipped policy unchanged.** No positive policy improvement or teacher label is admitted.
Across the main study, precision follow-up, explanations and feature observations, there are
**1,902 verified full-game executions** and **107,673 actual search-root restoration checks**.
They still use only twelve historical independent source armies. The current spell, default-profile
and research-isolation suites pass: **60 tests, 2,055 assertions**.

A future fixed controller rule needs to combine:

1. **Admission:** retain useful control and defensive action families at matched shortlist/rollout
   cost. Coordinate with the separately owned generic family experiment rather than duplicate it.
2. **Activation value:** distinguish a damaging shot, useful move, obstacle attack and activation
   that occurs after another threat already kills the protected ally. Include resistance and
   reflection; a landed debuff and a pending useful skip are different observations.
3. **Opportunity cost:** include guaranteed damage, kills, reduced stack strength, removed passives
   and the next allied attack. Neither target HP nor one prevented enemy activation is sufficient.
4. **Complete-game qualification:** freeze the resulting rule before outcomes, use fresh mixed
   armies/cohorts and held-out confirmation, and check both with/against the six priority units.
   These roots can provide diagnostic exercises but cannot select and qualify a favorable subgroup.

The ignored `review.html` provides all twelve explanations, thirty complete branch timelines,
interactive unit-footprint boards, exported interval figures and links to the source/statistics
receipts. It is served through the existing consolidated preview; no extra preview process is
needed. Five owned idle preview servers were consolidated into one, preserving the older reviews.
No production code, dependency pin, model, training campaign, commit or deployment changed.
