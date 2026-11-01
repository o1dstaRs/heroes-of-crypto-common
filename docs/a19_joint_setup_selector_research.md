# A19: learning a joint setup from the public opponent kit

Completed October 26, 2026. **The first selector failed its promotion screen, and the four-way
development extension did not fund another primary. No policy is enabled.** The
[joint placement study](a19_joint_placement_research.md) rejected three fixed setups on fresh
armies. This follow-up tests whether an opponent-aware choice can recover their useful cases
without applying their losses everywhere. Paid Placement and free changes remain separate
economic comparisons under the [promotion gate](placement_research_promotion.md).

## From a strong replay to a repeatable choice

The previous 72-board primary is now development data. All four setups and all twelve combat
conditions per board remain, including losses. Choosing the best setup after seeing every outcome
would improve the observed mean by 10.30 percentage points. That hindsight maximum is not a
deployable gain: choosing on one combat stream improves the other stream by only 1.39 or 3.94
points; choosing on one enemy formation improves the others by 0.52 to 2.26 points. These are
within-army diagnostic transfers, not independent qualification results.

The new learner chooses a complete setup before the battle. Its four eligible choices are:

| Choice       | Placement | Armor | Might | Sniper | Splits  | Formation  |
| ------------ | --------: | ----: | ----: | -----: | ------- | ---------- |
| Current      |         0 |     3 |     1 |      3 | Utility | Current    |
| Free spaced  |         0 |     3 |     1 |      3 | None    | Low spaced |
| Paid level 1 |         1 |     3 |     0 |      3 | None    | Low spaced |
| Paid level 2 |         2 |     2 |     0 |      3 | Utility | Low spaced |

These are the old candidate procedures, now options inside a newly registered selector. Their
old results cannot qualify that selector. The free learner may use the first two; the joint
learner may use all four. Every choice preserves actual supply, complete independent split
spellbooks/quivers, real footprints and the authoritative funded stack capacity.

## Bounded learning and legal inputs

The frozen extractor supplies 31 aggregate features from our own drafted army, the map, our Nature
stack-capacity bonus and the opponent's public creature identities. It includes printed ranged,
caster, flying-melee, footprint and named attack-kit signals. It excludes species one-hots, enemy
positions, quantities, split count, artifacts, doctrine, augments, synergies and combat seeds.
Own artifacts are present in the legal input envelope but are not model features in this small
training sample. The runtime prediction function consumes only that detached envelope.

Six-fold development cross-validation keeps an independent offer board and all its repeats in
one fold. The registered family crosses depths 1/2/3, minimum leaves 9/12/18 and gain penalties
of 0/0.5/1 standard errors, plus always-current. Select by out-of-fold gain minus one board-level
standard error, then refit on all 72 boards. Hyperparameter selection uses those folds, so the
reported cross-validation estimate remains development evidence.

Both learners select the same one-split decision function:

```text
If the public opponent kit has Chakram: current setup.
Otherwise: no utility splits, low-spaced formation, unchanged A3/M1/S3.
```

It changes 22/72 development boards and gains 4.6875 percentage points out of fold, with a board-level
standard error of 1.5083 points. No paid plan is selected. The two models have identical stripped
prediction topology; different leaf-fitting metadata cannot affect their decisions.

This bit also tags a draft cohort. All 22 development opponents without Chakram have Cyclops, and
18/22 controlled armies have Monk. It is a predictive split in this draft distribution, not proof
that removing Chakram causes the full conditional gain. All 72 own identity sets and all 72 enemy
identity sets are distinct. Opponent controller coverage remains a separate question.

## Why exact geometry matters

Old primary board 1, physical mirror 2, combat stream 1, spread enemy deployment illustrates a
concrete failure. Current behavior wins; the fixed unsplit/spaced setup loses. Zena's first throw
in current behavior hits Wolf Rider for 195 HP, with no bounces. In the spaced setup it hits Monk,
Medusa, Trent, Centaur and Gargantuan for a reported total of 621 HP. The consecutive one-empty-cell
gaps allow all four secondary victims at full bounce factor.

The canonical `resolveChakramTrajectory` reproduces both actual secondary target lists and every
bridge cell exactly. For the same shooter and primary target, moving only Medusa from (14,8) to
(14,9) removes every secondary victim. Touching Monk blocks that particular relay; the next bodies
are too far from the primary. This is an exact geometric counterfactual, not a full-game strength
result. The full enemy controller may choose another primary, and another attack may exploit the
new adjacency. A separately registered 24-replay bank tests that one-cell edit across both physical
mirrors, both old combat streams and all three enemy formations.

## Untouched primary and controls

The fresh primary is sealed before combat: 108 independent legal offer boards, twelve per three-map
and three-opponent-budget cell. Unchanged drafting must naturally produce Gargantuan and the seven-point
A3/M1/S3 plan. Inspect both actual draft assignments; retain both physical mirrors of one accepted
assignment. The actual bank contains only upper-seat drafts. This conditional population is not
every ranked army or a measurement of live frequency.

Current, fixed-free and learned-free each play two combat streams on each physical mirror against
enemy current/reflected/spread formations: 3,888 actual full fights. Because the selected joint
model is exactly the free model, a precombat amendment aliases that policy rather than counting
duplicate executions as more fights. The original four-comparison correction stays: learned-free
against current and fixed-free, joint against current and learned-free. Joint-minus-free is exactly
zero. A free policy needs at least +3 points and positive adjusted intervals and Holm p<.05 against
both its controls before funding the untouched confirmation. No confirmation pooling rescues a failure.

The captured server profile remains full A19 H64/R2/K6 on every actual turn for both teams, with
complementary chance samples, material tie arbitration, certified tight bounds and native rollout
controllers. All 591 frozen source inputs retain their hashes. Of those inputs, 590 also match
the current common checkout; the remaining difference is the separate first-contact measurement
tool. This is not a live-server latency qualification.

Eighteen exact old-trajectory and rollback controls passed. All 1,944 actual fresh opening
constructions passed, including matched opponent boards and final proposed/actual footprints.
Another 2,880 input checks cover hidden-field perturbations, physical team swaps and detached
public inputs. Independent validators will compare full transcripts for identical selected
candidates and reproduce the entire statistical calculation from the raw fight bank.

A separate registered factorial fills the old bank's missing no-splits/current and utility/spaced
arms: 1,728 additional full fights on the same 72 old boards. It separates split removal, formation
and their interaction; it supplies no new independent qualification boards and cannot tune the
locked learner. The separate 36-board wall pilot is excluded from fitting and all new intervals.

## First selector: fresh result and decision

All 3,888 fights completed with no rejected actions. Current behavior scored 63.1944%, the fixed
free setup 56.8673%, and the learned selector 66.0880%. These are scores against matched opponents,
not direct head-to-head win rates among these setups.

| Comparison              | Difference | Adjusted 98.75% board interval | Holm exact p |
| ----------------------- | ---------: | -----------------------------: | -----------: |
| Learned free - current  | +2.8935 pp |          +0.1543 to +5.8642 pp |   0.09234113 |
| Learned free - fixed    | +9.2207 pp |         +4.6682 to +13.6574 pp |   0.00000619 |
| Joint - current (alias) | +2.8935 pp |          +0.1543 to +5.8642 pp |   0.09234113 |
| Joint - learned free    | +0.0000 pp |          +0.0000 to +0.0000 pp |   1.00000000 |

**No policy passed.** The gain against current is below the registered 3-point minimum and its
Holm-adjusted exact test is above .05, despite a positive adjusted percentile-bootstrap interval.
Both statistical requirements were registered and both remain. The prepared untouched confirmation
was not triggered: no confirmation boards or fights were generated. The candidate stays closed;
no narrower subgroup or relaxed multiplicity correction enables it.

Nineteen independent boards improve, seven regress and 82 tie. The selector changes 31/108 boards.
On that prespecified public-kit branch the descriptive gain is 10.08 points; the other 77 boards
retain current behavior exactly. Normal, Lava and Block have positive point estimates; the
five-point-opponent slice is negative. Opponent budget is not a legal selector input, so that slice
cannot become a dispatch exception. These descriptions cannot override the failed whole-population
screen.

Independent Python/TypeScript calculations match every sorted 20,000-resample bootstrap distribution,
exact sign-flip integer count and Holm correction. Raw reduction checks independently reconstruct all
108 board scores and all 1,296 matched conditions. For every condition the learner's full initial,
root-input, chosen-action, ownership and terminal transcript equals the corresponding fixed candidate.
All 183,024 searched roots pass restoration assertions. The current default-profile and placement
isolation suites also pass: 17 tests and 1,878 expectations. Full current-repository CI and live
latency have not been claimed.

## A local improvement still needs a responsive enemy

The registered Medusa edit improves the old unsplit/spaced army from 2/12 to 5/12, compared with
3/12 for the already-recorded current setup. It adds four wins and loses one old win. Zena changes
its first primary in 7/12 conditions. In the illustrated stream it selects Medusa instead of Monk
and hits two victims instead of five; other streams still allow three or four victims, and one
edited stream loses an old win. This is one old army, not twelve independent samples or a policy
qualification.

The 156 exact fresh-bank replays include both gains and regressions, plus examples where the selector
avoids or forgoes a fixed-formation result. They cover all seven negatively changed aggregate boards
and all nineteen positive ones. Each source request has headless and full-event parity controls.
The standalone viewer contains 51 conditions, 102 branches and 5,264 validated frames, including
the local Medusa replays. Both actual first-Zena shots and a fresh losing first-Gargantuan turn
were checked in the browser; there are no browser errors. These are explanatory replays, not
additional strength samples.

For every negatively changed board, inspect the first same-sign condition in the registered sort.
Each selected current branch wins and its learned branch loses. The board-level differences below
still average all twelve conditions, not just that selected explanation:

| Board | Average difference | Observed failure chain in the selected pair                                                                                                        |
| ----: | -----------------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
|    20 |           -8.33 pp | The first throw switches from Medusa/Cyclops to Leprechaun/Peasant. Both get three ranged actions; Magic Dragon kills the new carry a lap earlier. |
|    33 |          -41.67 pp | Gargantuan gets two ranged actions instead of eight and dies during Elf's lap-three attack.                                                        |
|    71 |           -8.33 pp | The first throw does more damage, but only two ranged actions follow instead of five; Tsar Cannon kills Gargantuan in lap three.                   |
|    91 |          -16.67 pp | Magic Dragon kills Gargantuan in lap one before it acts. Current behavior gets a ranged attack in lap two.                                         |
|    96 |           -8.33 pp | Opening damage increases, but Gargantuan dies after its own lap-four shot.                                                                         |
|   105 |          -41.67 pp | Opening damage and carry health are higher; Fairy reaches and kills Gargantuan in lap two. The current carry lasts until lap three.                |
|   168 |          -16.67 pp | The new carry has one creature and 159 HP at its first action, then dies to Magic Dragon in lap one. The current carry survives the fight.         |

These are complete observed action chains, not isolated causal proofs about a cell, RNG roll or
augment. They show why a larger opening hit, more initial HP or one public threat flag is an
incomplete setup objective. Positions affect what both controllers target and how long the rest
of the army can support the carry.

There is also a concrete coverage gap. The old no-Chakram leaf has 22/22 Cyclops opponents. The
fresh branch has 23 Cyclops opponents and eight Monk opponents; four of the seven negatively
changed boards face Monk. Other negative boards remain inside the familiar Cyclops cohort.
Falling back on public-kit combinations absent from a trained leaf is a useful future hypothesis.
No retrospective score for that new rule was computed, and it cannot rescue this failed selector.

## Factorial result: separate the two decisions

All 1,728 additional fights completed with no rejected actions. Relative to utility splits and
current formation, the old development bank shows:

| Old population           | Remove splits only | Space with utility splits | Remove splits and space |
| ------------------------ | -----------------: | ------------------------: | ----------------------: |
| All 72 boards            |           +2.03 pp |                  -6.48 pp |                -5.56 pp |
| No Chakram, 22 boards    |           +2.08 pp |                 +13.26 pp |               +15.34 pp |
| Enemy Chakram, 50 boards |           +2.00 pp |                 -15.17 pp |               -14.75 pp |

Formation supplies the large sign reversal. Split removal has a much smaller point estimate, and
the combined effect is not universally additive. These are mechanism estimates on reused old
boards; their descriptive intervals do not qualify a default. An independent TypeScript reduction
matches all 18 effect/interval calculations and their exact sign-flip counts.

## A distinct four-option development screen

Before reading the factorial outcomes, a further bounded development family was registered. It
can choose splitting and formation independently: utility/current, none/current, utility/spaced,
none/spaced. It uses the same 31 features, six board folds and regularized tree family. Only the
old 72 boards supply training labels; the new failed primary's 108 boards are excluded.

A new fresh primary is funded only if out-of-fold gain reaches four points, exceeds the first
learner's saved development gain by at least 1.5 points, and the final model materially uses one
of the newly completed options. Otherwise this family closes without new fight outcomes. This
is a new candidate and resource screen, not a reopened confirmation of the failed one. Paid
plans are excluded from this next development family.

The selected four-way tree uses no splits in both branches: current formation against Chakram,
spaced formation otherwise. Its out-of-fold gain is 6.0764 points, an improvement of 1.3889 over
the first learner. It materially uses the new no-splits/current option on thirteen old boards.
**The registered 1.5-point improvement requirement fails.** No new primary boards or fights were
generated for this family. The saved six-fold assignment is identical, the out-of-fold reduction
and runtime predictions independently agree, and no threshold or feature was changed after fitting.

This turn completed 5,616 research fights: 3,888 fresh primary and 1,728 reused-board factorial
fights. Exact controls and explanatory replays are additional correctness work. Current behavior
remains the default. Neither this positive fresh point estimate nor the stronger development-only
four-way score is a qualified production improvement.

Artifacts and complete source/configuration receipts remain untracked in the client repository's
`game/core/tmp/analysis/joint-setup-selector-20261026`. No production defaults, dependency pins,
balance, portraits or deployment changed.
