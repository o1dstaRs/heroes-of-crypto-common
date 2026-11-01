# A19: twenty losses examined game by game

October 26, 2026. This follows the request to look inside the games, rather than stop at first-divergence statistics. It covers every one of the original augment selector’s twenty validation regressions. The original selector and both later spending rules remain failed; none is promoted by this diagnosis.

## What the interventions establish

All twenty original losses were reproduced. Exhaustively changing one retained own action in the first two laps finds a realized winning continuation in **19 of twenty games**, across **885 alternatives at 233 own positions**. These are hindsight recoveries on the original damage stream, not a rule that wins nineteen extra games. The scan retains every failed branch and supplies 146 wins, 18 draws and 721 losses.

The repeated tests prevent attractive stories from becoming bad patches. Gargantuan’s Centaur-removing area throw is stronger at its frozen position; forcing Pikeman’s missing nearer stop is substantially worse. The Monk-to-Elf shot recovers its original loss but does not improve its 32 fresh continuations. A visible casualty can be causally involved in one loss without making its avoidance a stronger general policy.

Nine first divergences belong to the opponent. Forcing a weaker opposing action is useful diagnosis, but cannot be counted as a correction our controller can execute.

## Exact method and checks

- Forty unchanged replays reproduce both original plans in all twenty games, including initial state/reference witnesses, root inputs, native-array ownership, complete action/result digests and outcomes.
- Forty natural-stream interventions exchange only the first disputed action in both directions. Later controllable turns on both armies use full ordinary A19; AI-Driven units retain their normal controller.
- Every disputed selected-plan position receives 32 matched independent future combat streams for its actual and old actions: 1,280 completed fights. Each branch reconstructs the historical prefix, installs actual RNG after the root query and before its committed action, and preserves UUID sequence.
- Twenty additional observational replays expose every own first-two-lap scoring path without extra rollout calls. Twenty exact controls then admit all 885 single-action alternatives. Every retained candidate with a finite returned score is tested; certified partial scores are explicitly identified.
- Four separately fixed tactical alternatives receive 32 new future streams each, for 256 additional fights. Their results appear below regardless of sign.
- Native-controller ablations reuse the same 32 streams and both actions at Gargantuan and Monk, for 128 complete fights. Actual searched calls are counted separately from no-search native calls.
- Every admitted branch executes its requested legal action, ends by elimination, and has zero rejected actions. Every actual A19 root retains full battle/reference/memory/RNG restoration checks. Independent Python validation checks all rows and catalogue coverage; independent TypeScript reproduces all twenty first-position point estimates and exact paired tests.

The engine is the frozen corrected source used by the original selector, with the captured `a19-material-r2-v1` server profile: H64/R2/K6, complementary sampling, material arbitration on exact primary ties, and certified/tight bounds. This is deterministic offline research, not a serving-latency qualification. No production source, profile default, pin or deployment changes in this work.

The complete work receipt contains **2,698 admitted full-match runs**, including 109 exact replay runs,
and **142,958 actual searched-root restoration checks**. The 5,859 later native calls in the controller
ablation receive separate restoration checks and are not counted as searched roots. There are no new
independent armies and no qualified strategy gain.

## First disputed action: all twenty repeated comparisons

Scores are points out of 32, with a draw worth half, always from our army’s perspective. “Old action” means the original incumbent’s counterpart under the selected augments. For opposing actors, it is an opponent-action ablation. Holm p-values cover all twenty frozen positions. These are conditional action comparisons, not new-army strategy win rates.

| Game      | First actor   | Controller | Chosen / 32 | Old action / 32 |     Holm p |
| --------- | ------------- | ---------- | ----------: | --------------: | ---------: |
| b0-w2-a1  | Pikeman       | Own        |          15 |               0 |  0.0011597 |
| b0-w2-a2  | Gargantuan    | Own        |        11.5 |              24 |   0.029938 |
| b3-w2-a1  | Fairy         | Opponent   |         8.5 |               4 |          1 |
| b3-w3-a2  | Wyvern        | Own        |           9 |               8 |          1 |
| b4-w3-a2  | Goblin Knight | Own        |           5 |             8.5 |          1 |
| b6-w1-a0  | Fairy         | Opponent   |          29 |              21 |    0.21582 |
| b7-w1-a0  | Cyclops       | Own        |         9.5 |               6 |          1 |
| b7-w2-a0  | Angel         | Opponent   |           9 |            30.5 | 9.5367e-06 |
| b9-w1-a0  | Healer        | Own        |           2 |               2 |          1 |
| b14-w0-a1 | Gargantuan    | Opponent   |           7 |               4 |          1 |
| b15-w1-a2 | Fairy         | Opponent   |          13 |             9.5 |          1 |
| b15-w3-a2 | Valkyrie      | Opponent   |           3 |               4 |          1 |
| b18-w1-a0 | Cyclops       | Own        |           7 |              10 |          1 |
| b19-w0-a1 | Elf           | Opponent   |          27 |              26 |          1 |
| b21-w0-a2 | Angel         | Own        |           0 |               0 |          1 |
| b21-w2-a0 | Cyclops       | Own        |         8.5 |              11 |          1 |
| b22-w1-a1 | Behemoth      | Opponent   |           3 |             6.5 |          1 |
| b22-w2-a0 | Harpy         | Own        |           9 |              13 |          1 |
| b22-w3-a2 | Monk          | Own        |        15.5 |              14 |          1 |
| b24-w2-a0 | Zena          | Opponent   |           7 |               6 |          1 |

Only three comparisons pass the twenty-position family correction: the Gargantuan alternative helps our army, the Pikeman alternative harms it, and the opposing Angel’s original Troll Resurrection would help us relative to its stronger Elf Resurrection. An all-zero set, such as Angel’s lap-two wait/move pair, does not establish equivalence or that the position is universally lost.

## Four concrete later-action hypotheses

These choices were fixed from the recorded tactical sequences and existing retained candidates before their new future outcomes. They test shooter preservation, Resurrection pressure, collateral exposure and support-target value. No favorable sign selects the reported set.

| Game / actor          | Fixed alternative                     | Chosen / 32 | Alternative / 32 |      Gain | Holm p, four probes |
| --------------------- | ------------------------------------- | ----------: | ---------------: | --------: | ------------------: |
| b7-w2-a0 / Gargantuan | shoot Elf                             |        20.5 |               21 |  +1.56 pp |                   1 |
| b22-w2-a0 / Monk      | shoot Troglodyte                      |         9.5 |                8 |  -4.69 pp |                   1 |
| b15-w1-a2 / Cyclops   | shoot Elf                             |          17 |               20 |  +9.38 pp |                   1 |
| b4-w3-a2 / Beholder   | shoot Wandering Mage (one-unit split) |         2.5 |                7 | +14.06 pp |             0.71875 |

None of these four probes establishes an improvement after the registered family correction. Their candidate-level stories remain hypotheses. Scores at different roots are not directly comparable: each fixes a different historical prefix and starts the new actual-combat stream at its own root. Gargantuan’s Elf shot and Monk’s Troglodyte shot were already shortlisted but stopped after one complementary sample because they could not beat the current winner under the fixed two-sample bound. Their returned numbers are partial bound placeholders, not complete rollout means. This is not evidence that the bound implementation is wrong; it distinguishes a correct work-saving bound from a forecast that may rank real continuations poorly.

## What the future-controller comparison explains

| Position and action        | Native continuation / 32 | Full A19 continuation / 32 |
| -------------------------- | -----------------------: | -------------------------: |
| b0-w2-a2: chosen action    |                        2 |                       11.5 |
| b0-w2-a2: old counterpart  |                       26 |                         24 |
| b22-w3-a2: chosen action   |                       32 |                       15.5 |
| b22-w3-a2: old counterpart |                       32 |                         14 |

For Monk, both native continuations win all 32 streams, while full A19 continuations score around half and neither target clearly improves the other. This supports future-policy sensitivity behind its optimistic forecast. For Gargantuan, the area throw is also better under native full-match continuations, so adding a stronger opponent model alone is not a complete explanation of its ranking error. The private forecast used one winning and one losing complementary sample for each of its two actions, then chose by material.

The endpoint audit confirms that all eight relevant private samples reached actual terminal results before H64: Gargantuan at 34–44 future turns, Monk at 47–63. Increasing the horizon or changing the learned leaf alone therefore does not resolve these final comparisons. Gargantuan’s ranking exposes sparse chance evidence and the material tie-break; Monk exposes sensitivity to future controllers without proving a better target. Native full matches use live/root decision context; the private forecast uses rollout context and actor-antithetic chance streams. The ablation does not isolate all of these remaining factors individually.

| Frozen root / action             | Sample | Returned score | Terminal reached | Simulated future turns |
| -------------------------------- | -----: | -------------: | ---------------- | ---------------------: |
| b0-w2-a2: ground throw at (4, 5) |      0 |              1 | Yes              |                     34 |
| b0-w2-a2: ground throw at (4, 5) |      1 |              0 | Yes              |                     44 |
| b0-w2-a2: shoot Scavenger        |      0 |              0 | Yes              |                     41 |
| b0-w2-a2: shoot Scavenger        |      1 |              1 | Yes              |                     34 |
| b22-w3-a2: shoot Elf             |      0 |              1 | Yes              |                     63 |
| b22-w3-a2: shoot Elf             |      1 |              1 | Yes              |                     55 |
| b22-w3-a2: shoot Cyclops         |      0 |              1 | Yes              |                     47 |
| b22-w3-a2: shoot Cyclops         |      1 |              1 | Yes              |                     51 |

## Individual game notes

Engine turn/root ordinals are zero-based. The “first recovery” is the earliest winning retained alternative found by the exhaustive scan, with candidate order breaking equal root ordinals. It is selected with hindsight and must not be deployed by case, unit name or root index. The interactive viewer includes an exact replay of each available recovery.

### b0-w2-a1 — Pikeman: a missing move is not automatically a useful move

Normal · own 6 points vs opponent 6 · transfer Armor>Movement.

**Own army:** Dryad ×90, Wandering Mage ×154, Pikeman ×23, Medusa ×24, Monk ×8, Gargantuan ×2, Dryad ×1, Wandering Mage ×1.
**Opponent:** Scavenger ×164, Centaur ×73, Nomad ×26, Trent ×24, Cyclops ×8, Tsar Cannon ×2.
**Artifacts:** own Dual Strike Charm / Giants Maul; opponent Tome Of Amplification / Farsight Quiver.

The Movement purchase removes the old (10, 2) stop from the sparse pool. Pikeman waits, then takes a different route; the winning incumbent eventually reaches and attacks Tsar Cannon on lap three. However, forcing the legal old stop under the purchased stats still loses the original fight. The completed 32-world comparison also favors the actual wait. This case rejects treating the catalogue omission itself as the cause of the loss.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 15, the old counterpart 0; counterpart gain -46.88 pp, Holm p 0.0011597.

**Own-decision scan:** 62 alternatives across 15 roots; 39 winning, 2 drawing and 21 losing branches on the original stream.
Earliest realized recovery: lap 1, root 5, Monk — shoot Nomad. Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b0-w2-a2 — Gargantuan: damage denial beats an attractive surviving target

Normal · own 7 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Dryad ×90, Wandering Mage ×154, Pikeman ×23, Medusa ×24, Monk ×8, Gargantuan ×2, Dryad ×1, Wandering Mage ×1.
**Opponent:** Scavenger ×164, Centaur ×73, Nomad ×26, Trent ×24, Cyclops ×8, Tsar Cannon ×2.
**Artifacts:** own Dual Strike Charm / Giants Maul; opponent Tome Of Amplification / Farsight Quiver.

The opening choice changes from a ground throw at (4, 5), killing all 73 Centaurs before their first turn, to a direct shot at the already damaged Scavenger. Scavenger has Dodge; both throws miss on the original stream. Centaur survives to deal 346 damage to Monk on lap one and another 248 on lap two. Both options have primary value 0.5 in the recorded two-sample forecast. The material tie-break prefers the Scavenger shot (0.54585 versus 0.53372). The natural one-shot correction still loses, but the independent future streams strongly favor the ground throw. The lesson concerns removing an enemy activation, rather than maximizing immediate damage into whichever stack remains valuable. The endpoint audit confirms that all four relevant private forecasts reached actual terminal outcomes within 34–44 future turns, so the final tie here is not a truncated H64 leaf-value error.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is ours. In 32 fresh continuations the chosen action scores 11.5, the old counterpart 24; counterpart gain +39.06 pp, Holm p 0.029938.

**Own-decision scan:** 59 alternatives across 13 roots; 6 winning, 0 drawing and 53 losing branches on the original stream.
Earliest realized recovery: lap 1, root 0, Pikeman — move to (14, 2). Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b3-w2-a1 — A physical army pays Armor for unused Empower

Normal · own 6 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Berserker ×109, Orc ×100, Wyvern ×31, Beholder ×22, Cyclops ×8, Tsar Cannon ×2.
**Opponent:** Fairy ×139, Squire ×132, Elf ×26, Valkyrie ×29, Zena ×8, Magic Dragon ×2.
**Artifacts:** own Swift Boots / Farsight Quiver; opponent Mages Ring / Crown Of Command.

The own army is Berserker, Orc, Wyvern, Beholder, Cyclops and Tsar Cannon; the purchased Empower supplies no actual offensive output. The first different action belongs to the enemy Fairy, which advances rather than waits. Our Berserker commits to Fairy, Wyvern is eliminated before attacking, and the enemy receives a different engagement. Forcing the opponent back to its old wait does not recover the selected game. Changing an enemy action is a diagnostic ablation, not an action available to our policy.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is the opponent. In 32 fresh continuations the chosen action scores 8.5, the old counterpart 4; counterpart gain -14.06 pp, Holm p 1.

**Own-decision scan:** 40 alternatives across 9 roots; 5 winning, 1 drawing and 34 losing branches on the original stream.
Earliest realized recovery: lap 1, root 2, Wyvern — move to (5, 1), (4, 1); melee Zena. Its original returned score was 0.5 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b3-w3-a2 — Wyvern moves; the enemy deletes Tsar Cannon before its turn

Normal · own 7 points vs opponent 5 · transfer Armor>Movement.

**Own army:** Berserker ×109, Orc ×100, Wyvern ×31, Beholder ×22, Cyclops ×8, Tsar Cannon ×2.
**Opponent:** Fairy ×139, Squire ×132, Elf ×26, Valkyrie ×29, Zena ×8, Magic Dragon ×2.
**Artifacts:** own Swift Boots / Farsight Quiver; opponent Mages Ring / Crown Of Command.

Wyvern makes a small opening move instead of waiting. Zena then aims at Tsar Cannon and removes 223 of its 400 HP; Magic Dragon removes the remaining 177 before Cannon can fire. Wyvern also dies before making an attack. In the incumbent, Cannon attacks on lap one and Wyvern eventually attacks on lap two. Nevertheless, forcing the old wait under the Movement plan does not recover the original fight, and the 32 future streams do not establish a benefit for it. The visible sequence is real, but it does not justify a blanket keep-Wyvern-still rule.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is ours. In 32 fresh continuations the chosen action scores 9, the old counterpart 8; counterpart gain -3.12 pp, Holm p 1.

**Own-decision scan:** 37 alternatives across 8 roots; 10 winning, 0 drawing and 27 losing branches on the original stream.
Earliest realized recovery: lap 1, root 2, Wyvern — move to (7, 3), (6, 3). Its original returned score was 1 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b4-w3-a2 — Goblin Knight waits inside a punishable caster cluster

Lava · own 7 points vs opponent 5 · transfer Armor>Might.

**Own army:** Fairy ×139, Peasant ×200, Beholder ×22, Battle Mage ×50, Goblin Knight ×9, Tsar Cannon ×2.
**Opponent:** Dryad ×90, Wandering Mage ×154, Trent ×24, Valkyrie ×29, Zena ×8, Angel ×2, Dryad ×1, Wandering Mage ×1.
**Artifacts:** own Cursed Ward / Titan Plate; opponent Veteran Helm / Quiver Of Echoes.

Goblin Knight waits at the opening instead of advancing to (6, 1). It remains beside Battle Mage and Beholder. A return shot during Beholder's attack removes 149 HP from Knight; later one Fireball removes 388 from Knight and 267 each from Battle Mage and Beholder. Knight finally leaves after those attacks, with greatly reduced combat power. Advancing it once does not recover the original selected fight. This is a combined target/retaliation/spacing sequence, rather than evidence that extra Might itself is always bad.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 5, the old counterpart 8.5; counterpart gain +10.94 pp, Holm p 1.

**Own-decision scan:** 40 alternatives across 12 roots; 2 winning, 0 drawing and 38 losing branches on the original stream.
Earliest realized recovery: lap 1, root 1, Fairy — wait. Its original returned score was 0.0454973 (complete complementary samples). This is one realized recovery, not a proven stronger action.
The separately fixed tactical probe scores 2.5 vs 7 / 32 for shoot Wandering Mage (one-unit split); Holm p over four probes 0.71875.

### b6-w1-a0 — Empower cannot pay back if Magic Dragon dies before casting

Normal · own 5 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Dryad ×91, Wandering Mage ×155, Valkyrie ×29, Troll ×25, Zena ×8, Magic Dragon ×2.
**Opponent:** Orc ×100, Fairy ×139, Battle Mage ×50, Beholder ×22, Cyclops ×8, Tsar Cannon ×2.
**Artifacts:** own Mages Ring / Quiver Of Echoes; opponent Keen Blade / Quiver Of Echoes.

The first changed action is the enemy Fairy moving without its old melee attack. The enemy Cyclops then kills Magic Dragon on lap one before Dragon's first spell. The incumbent Dragon casts Ring of Fire before dying on lap two. The purchased magic resource therefore loses its main early carrier in the selected path. Restoring the enemy Fairy attack does not recover the original loss; the relevant controllable decisions include the earlier shot and the surviving army's later responses.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is the opponent. In 32 fresh continuations the chosen action scores 29, the old counterpart 21; counterpart gain -25.00 pp, Holm p 0.21582.

**Own-decision scan:** 45 alternatives across 11 roots; 10 winning, 3 drawing and 32 losing branches on the original stream.
Earliest realized recovery: lap 1, root 0, Valkyrie — Wind Flow. Its original returned score was 0.471 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b7-w1-a0 — Cyclops changes lanes while the enemy erases the frontline

Lava · own 5 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Peasant ×200, Wandering Mage ×155, Elf ×26, Troll ×25, Cyclops ×8, Angel ×2.
**Opponent:** Orc ×100, Dryad ×91, Nomad ×26, Battle Mage ×50, Monk ×8, Gargantuan ×2.
**Artifacts:** own Amulet Of Resolve / Crown Of Command; opponent Winged Boots / Crown Of Command.

Cyclops changes its declared opening target from Orc to Battle Mage. The old shot actually splashes Dryad for 439 damage; the selected shot hits Battle Mage for 370. The enemy subsequently focuses Peasant: its 1,696 opening HP falls to 165 by lap two, and Nomad kills Wandering Mage before the next useful spell. The first shot's named target alone is a poor explanation of its actual impact. Forcing the old shot under the new augments does not rescue the natural-stream game.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 9.5, the old counterpart 6; counterpart gain -10.94 pp, Holm p 1.

**Own-decision scan:** 28 alternatives across 11 roots; 2 winning, 1 drawing and 25 losing branches on the original stream.
Earliest realized recovery: lap 1, root 5, Elf — shoot Battle Mage. Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b7-w2-a0 — The opponent resurrects a shooter and removes our caster immediately

Lava · own 5 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Orc ×100, Dryad ×91, Nomad ×26, Battle Mage ×50, Monk ×8, Gargantuan ×2.
**Opponent:** Peasant ×200, Wandering Mage ×155, Elf ×26, Troll ×25, Cyclops ×8, Angel ×2.
**Artifacts:** own Winged Boots / Crown Of Command; opponent Amulet Of Resolve / Crown Of Command.

The first difference belongs to the enemy Angel: Resurrection restores Elf instead of Troll. That Elf then kills our full Battle Mage on lap one, before it casts. In the incumbent, Battle Mage gets a Fire Strike before dying on lap two. Merely measuring Empower potential from the drafted caster misses whether it survives to spend a spell. Forcing the old opposing Resurrection target does not recover the selected natural-stream game.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is the opponent. In 32 fresh continuations the chosen action scores 9, the old counterpart 30.5; counterpart gain +67.19 pp, Holm p 9.5367e-06.

**Own-decision scan:** 51 alternatives across 11 roots; 14 winning, 1 drawing and 36 losing branches on the original stream.
Earliest realized recovery: lap 1, root 2, Nomad — move to (8, 2), (7, 2). Its original returned score was 0.999912 (complete complementary samples). This is one realized recovery, not a proven stronger action.
The separately fixed tactical probe scores 20.5 vs 21 / 32 for shoot Elf; Holm p over four probes 1.

### b9-w1-a0 — A support-target change reorganizes both armies' replies

Normal · own 5 points vs opponent 5 · transfer Armor>Might.

**Own army:** Dryad ×91, Wandering Mage ×155, Healer ×40, Elf ×26, Zena ×8, Magic Dragon ×2.
**Opponent:** Fairy ×139, Peasant ×200, Beholder ×22, Medusa ×24, Cyclops ×8, Tsar Cannon ×2.
**Artifacts:** own Iron Plate / Farsight Quiver; opponent Amulet Of Resolve / Giants Maul.

Healer applies Spiritual Armor to Dryad rather than Wandering Mage. Subsequent Fairy, Cyclops and Beholder decisions change. Our Magic Dragon is reduced from 300 to 100 HP and then killed by Medusa before casting, while the opposing Tsar Cannon also dies without a shot. That favorable enemy casualty does not prevent our later loss. Restoring the first buff target still loses under the purchased stats. The narrative is an interaction of protection, target choice and follow-up, not a sufficient one-buff fix.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 2, the old counterpart 2; counterpart gain +0.00 pp, Holm p 1.

**Own-decision scan:** 50 alternatives across 10 roots; 2 winning, 0 drawing and 48 losing branches on the original stream.
Earliest realized recovery: lap 1, root 4, Elf — shoot Medusa. Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b14-w0-a1 — More early attacks conceal a much worse enemy area throw

Block · own 6 points vs opponent 7 · transfer Armor>Movement.

**Own army:** Arbalester ×124, Dryad ×91, Nomad ×26, Valkyrie ×29, Zena ×8, Tsar Cannon ×2.
**Opponent:** Leprechaun ×148, Centaur ×73, White Tiger ×25, Battle Mage ×50, Cyclops ×8, Gargantuan ×2.
**Artifacts:** own Winged Boots / Crown Of Command; opponent Iron Plate / Quiver Of Echoes.

The first difference is an enemy Gargantuan ground aim: (3, 3) instead of (3, 5). It damages Dryad and removes 213 of Tsar Cannon's 400 HP, leaving only 187 before Cannon acts. Cannon shoots earlier under Movement, but with less surviving force; the incumbent Cannon does not fire until lap two and then removes 713 HP from Centaur plus 466 from Battle Mage in one action. Returning the enemy to its old aim recovers the natural-stream game. That proves an opposing response matters here; it does not give our controller permission to choose the enemy's aim.

**One-action checks:** selected plan + old first action: win; incumbent plan + selected first action: loss. The first actor is the opponent. In 32 fresh continuations the chosen action scores 7, the old counterpart 4; counterpart gain -9.38 pp, Holm p 1.

**Own-decision scan:** 29 alternatives across 10 roots; 1 winning, 1 drawing and 27 losing branches on the original stream.
Earliest realized recovery: lap 2, root 14, Valkyrie — move to (7, 2). Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b15-w1-a2 — Moving shooters together creates a lethal area target

Normal · own 7 points vs opponent 6 · transfer Armor>Might.

**Own army:** Dryad ×91, Peasant ×200, Valkyrie ×29, Medusa ×24, Cyclops ×8, Frenzied Boar ×2.
**Opponent:** Fairy ×138, Squire ×132, Elf ×25, Beholder ×22, Monk ×8, Gargantuan ×2, Elf ×1, Fairy ×1.
**Artifacts:** own Wounding Charm / Titan Plate; opponent Dual Strike Charm / Giants Maul.

The first change is the enemy Fairy's melee approach cell. Later our Cyclops advances to (9, 11) and Medusa to (9, 12). Gargantuan's throw at (8, 12) removes 247 HP from Cyclops and 356 from Medusa. Monk finishes Cyclops on lap one, and Fairy finishes Medusa before either main stack makes a useful attack. More melee attack power cannot compensate for shooters that move into a shared lethal splash. Forcing the enemy's first approach cell alone does not recover the original loss.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is the opponent. In 32 fresh continuations the chosen action scores 13, the old counterpart 9.5; counterpart gain -10.94 pp, Holm p 1.

**Own-decision scan:** 25 alternatives across 7 roots; 0 winning, 0 drawing and 25 losing branches on the original stream.
No single tested retained own alternative in the first two laps recovers this game. This does not test coordinated two-decision changes, missing candidates, different opening setups or later laps.
The separately fixed tactical probe scores 17 vs 20 / 32 for shoot Elf; Holm p over four probes 1.

### b15-w3-a2 — Sniper is surrendered for magic that never deals damage

Normal · own 7 points vs opponent 6 · transfer Sniper>Empower.

**Own army:** Fairy ×138, Squire ×132, Elf ×25, Beholder ×22, Monk ×8, Gargantuan ×2, Elf ×1, Fairy ×1.
**Opponent:** Dryad ×91, Peasant ×200, Valkyrie ×29, Medusa ×24, Cyclops ×8, Frenzied Boar ×2.
**Artifacts:** own Dual Strike Charm / Giants Maul; opponent Wounding Charm / Titan Plate.

The own army contains Fairy, Squire, Elf, Beholder, Monk and Gargantuan, with split Elf/Fairy stacks. Empower supplies no actual offensive damage. Reducing Sniper from three to two loses both attack-stat bonus and shot-distance bonus. The first different action is the enemy Valkyrie's Wind Flow rather than an advance; several own shooters then move or wait. The selected game eventually reaches Armageddon. Restoring that enemy opening does not recover the original selected fight.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is the opponent. In 32 fresh continuations the chosen action scores 3, the old counterpart 4; counterpart gain +3.12 pp, Holm p 1.

**Own-decision scan:** 64 alternatives across 18 roots; 10 winning, 1 drawing and 53 losing branches on the original stream.
Earliest realized recovery: lap 1, root 6, Monk — shoot Valkyrie. Its original returned score was 1 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b18-w1-a0 — Killing a shooter leaves the approaching melee army intact

Normal · own 5 points vs opponent 5 · transfer Armor>Empower.

**Own army:** Dryad ×91, Wandering Mage ×155, Valkyrie ×29, Beholder ×22, Cyclops ×8, Magic Dragon ×2.
**Opponent:** Orc ×100, Berserker ×109, Pikeman ×23, Elf ×26, Monk ×8, Tsar Cannon ×2.
**Artifacts:** own Wounding Charm / Last Fuse; opponent Barrel Barricade / Crown Of Command.

Our Cyclops changes its opening aim from Berserker to Orc; the selected projectile damages Elf. The following Beholder and Dryad attacks finish Orc on lap one, but Berserker arrives on lap two with its full 1,610 HP, accompanied by Pikeman, and they kill Magic Dragon. In the incumbent, Cyclops first removes 394 HP from Berserker. This is a threat-priority and activation problem: an early enemy kill can still leave the decisive threat untouched. Forcing that first old shot does not by itself recover the original loss.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 7, the old counterpart 10; counterpart gain +9.38 pp, Holm p 1.

**Own-decision scan:** 51 alternatives across 11 roots; 3 winning, 0 drawing and 48 losing branches on the original stream.
Earliest realized recovery: lap 1, root 2, Cyclops — switch attack mode; move to (9, 13); melee Berserker. Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b19-w0-a1 — An opposing target switch changes an entire damage lane

Lava · own 6 points vs opponent 6 · transfer Armor>Might.

**Own army:** Peasant ×200, Arbalester ×124, Trent ×24, Battle Mage ×50, Zena ×8, Angel ×2.
**Opponent:** Dryad ×90, Berserker ×109, Valkyrie ×29, Elf ×25, Cyclops ×8, Tsar Cannon ×2, Dryad ×1, Elf ×1.
**Artifacts:** own Hunters Longbow / Quiver Of Echoes; opponent Barrel Barricade / Quiver Of Echoes.

The first different actor is the enemy Elf, aiming at Arbalester rather than Trent. The same action also damages the enemy's own Berserker through the response sequence, so its immediate net material is not an adequate explanation. The enemy later kills our Battle Mage on lap one; it survives into lap two in the incumbent. Returning the opponent to its old Elf shot recovers the selected natural-stream fight. That intervention diagnoses sensitivity to the opponent, not a deployable own-action correction.

**One-action checks:** selected plan + old first action: win; incumbent plan + selected first action: loss. The first actor is the opponent. In 32 fresh continuations the chosen action scores 27, the old counterpart 26; counterpart gain -3.12 pp, Holm p 1.

**Own-decision scan:** 38 alternatives across 12 roots; 10 winning, 4 drawing and 24 losing branches on the original stream.
Earliest realized recovery: lap 1, root 3, Zena — shoot Dryad (one-unit split). Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b21-w0-a2 — Angel spends time waiting instead of creating pressure

Normal · own 7 points vs opponent 5 · transfer Might>Empower.

**Own army:** Wandering Mage ×155, Orc ×100, Healer ×40, Trent ×24, Zena ×8, Angel ×2.
**Opponent:** Peasant ×200, Fairy ×139, Harpy ×30, Battle Mage ×50, Cyclops ×8, Tsar Cannon ×2.
**Artifacts:** own Veteran Helm / Last Fuse; opponent Rime Charm / Archmages Ring.

On lap two Angel waits instead of moving to the old (0/1, 12/13) footprint. Its first attack slips from lap three to lap five. The purchased Empower contributes no offensive output in this actual game. The old move is necessary for the incumbent's realized win when tested in reverse, but forcing it under the altered augments still loses. The visible delay is not enough to establish that this one wait is the full cause.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 0, the old counterpart 0; counterpart gain +0.00 pp, Holm p 1.

**Own-decision scan:** 55 alternatives across 14 roots; 2 winning, 1 drawing and 52 losing branches on the original stream.
Earliest realized recovery: lap 1, root 3, Healer — Blessing on Orc. Its original returned score was 0 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b21-w2-a0 — Cyclops spends its first shot on a low-impact lane

Normal · own 5 points vs opponent 6 · transfer Armor>Empower.

**Own army:** Peasant ×200, Fairy ×139, Harpy ×30, Battle Mage ×50, Cyclops ×8, Tsar Cannon ×2.
**Opponent:** Wandering Mage ×155, Orc ×100, Healer ×40, Trent ×24, Zena ×8, Angel ×2.
**Artifacts:** own Rime Charm / Archmages Ring; opponent Veteran Helm / Last Fuse.

Cyclops aims at Trent for 72 damage instead of the old Orc lane, which removed 170 HP from Orc and 207 from Wandering Mage. Our Battle Mage is then reduced to 4 HP before its first Fire Strike, deals only 5 damage, and dies on lap one. The incumbent Mage deals 170 before dying on lap two. The original incumbent reaches an Armageddon draw. Forcing only the first old shot under the selected stats still loses; swapping the selected shot into the incumbent actually produces a win on this stream. This explicitly rejects a universal old-target-is-better interpretation.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is ours. In 32 fresh continuations the chosen action scores 8.5, the old counterpart 11; counterpart gain +7.81 pp, Holm p 1.

**Own-decision scan:** 34 alternatives across 12 roots; 5 winning, 2 drawing and 27 losing branches on the original stream.
Earliest realized recovery: lap 1, root 0, Harpy — move to (6, 3). Its original returned score was 1 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b22-w1-a1 — The opposing Behemoth advances instead of using Battle Roar

Lava · own 6 points vs opponent 7 · transfer Armor>Empower.

**Own army:** Troglodyte ×125, Dryad ×91, Trent ×24, Elf ×26, Cyclops ×8, Angel ×2.
**Opponent:** Arbalester ×124, Peasant ×200, Harpy ×30, Medusa ×24, Monk ×8, Behemoth ×2.
**Artifacts:** own Veteran Helm / Pendant Of Vitality; opponent Tome Of Amplification / Quiver Of Echoes.

The first changed action belongs to the enemy Behemoth, which advances instead of roaring. Our Troglodyte moves without its old attack on Harpy. Enemy Monk then repeatedly damages Troglodyte while Behemoth joins the engagement; a later enemy hit removes 410 HP from the resurrected Troglodyte. The bought Empower has no actual offensive output. Restoring the opponent's old roar does not recover the selected game.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: win. The first actor is the opponent. In 32 fresh continuations the chosen action scores 3, the old counterpart 6.5; counterpart gain +10.94 pp, Holm p 1.

**Own-decision scan:** 41 alternatives across 14 roots; 7 winning, 0 drawing and 34 losing branches on the original stream.
Earliest realized recovery: lap 1, root 0, Cyclops — shoot Arbalester. Its original returned score was 0.000152274 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b22-w2-a0 — Harpy's missing stop is followed by an expensive Monk counter-shot

Lava · own 5 points vs opponent 6 · transfer Armor>Movement.

**Own army:** Arbalester ×124, Peasant ×200, Harpy ×30, Medusa ×24, Monk ×8, Behemoth ×2.
**Opponent:** Troglodyte ×125, Dryad ×91, Trent ×24, Elf ×26, Cyclops ×8, Angel ×2.
**Artifacts:** own Tome Of Amplification / Quiver Of Echoes; opponent Veteran Helm / Pendant Of Vitality.

Harpy advances one cell farther, to (4, 12) rather than (5, 12); the nearer stop is legal but absent from its candidate pool. Forcing that nearer stop still loses naturally. A later, more concrete cost is Monk shooting Dryad: the return shot drops Monk from 488 to 118 HP. The enemy Troglodyte remains unpressured while Angel restores Dryad. Monk later dies to Trent. The nearer-stop omission and the retaliation-sensitive target choice must be investigated separately.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 9, the old counterpart 13; counterpart gain +12.50 pp, Holm p 1.

**Own-decision scan:** 47 alternatives across 12 roots; 2 winning, 0 drawing and 45 losing branches on the original stream.
Earliest realized recovery: lap 2, root 20, Medusa — shoot Dryad. Its original returned score was 0.0123873 (complete complementary samples). This is one realized recovery, not a proven stronger action.
The separately fixed tactical probe scores 9.5 vs 8 / 32 for shoot Troglodyte; Holm p over four probes 1.

### b22-w3-a2 — Monk's target choice exposes Harpy to the return shot

Lava · own 7 points vs opponent 5 · transfer Armor>Empower.

**Own army:** Arbalester ×124, Peasant ×200, Harpy ×30, Medusa ×24, Monk ×8, Behemoth ×2.
**Opponent:** Troglodyte ×125, Dryad ×91, Trent ×24, Elf ×26, Cyclops ×8, Angel ×2.
**Artifacts:** own Tome Of Amplification / Quiver Of Echoes; opponent Veteran Helm / Pendant Of Vitality.

Monk aims at Cyclops instead of Elf. Cyclops's return trajectory strikes Harpy rather than reaching Monk, removing 203 HP; Harpy then takes 90 from Cyclops in melee and dies to Elf before its first attack. The initial outgoing/return exchange also removes 243 HP from the enemy Troglodyte, so the local material trade looks attractive. Elf and Cyclops both receive primary score 1 in the two-sample search; the material values favor Cyclops, 0.83803 versus 0.82775. Forcing the Elf shot under exactly the selected augments recovers the original game; forcing the Cyclops shot into the incumbent turns its win into a loss. This is a two-direction single-action sensitivity on the original stream. It does not replicate as a stronger choice: across the 32 independent future streams, the chosen Cyclops shot scores 15.5/32 and the Elf alternative 14/32. The Harpy casualty is real; turning it into an always-target-Elf guard would overfit this one loss. All four relevant private forecasts also terminate before H64. Both targets win all 32 native-controller ablations, while full-A19 futures score around half: future-controller sensitivity explains the optimistic forecast better than a blanket retaliation veto.

**One-action checks:** selected plan + old first action: win; incumbent plan + selected first action: loss. The first actor is ours. In 32 fresh continuations the chosen action scores 15.5, the old counterpart 14; counterpart gain -4.69 pp, Holm p 1.

**Own-decision scan:** 42 alternatives across 12 roots; 12 winning, 1 drawing and 29 losing branches on the original stream.
Earliest realized recovery: lap 1, root 2, Behemoth — move to (1, 7), (2, 7), (1, 6), (2, 6). Its original returned score was 1 (complete complementary samples). This is one realized recovery, not a proven stronger action.

### b24-w2-a0 — A drawn attrition ending becomes a lost one

Normal · own 5 points vs opponent 7 · transfer Armor>Might.

**Own army:** Dryad ×91, Berserker ×109, Pikeman ×23, Elf ×26, Monk ×8, Gargantuan ×2.
**Opponent:** Orc ×100, Fairy ×139, Beholder ×22, Battle Mage ×50, Zena ×8, Tsar Cannon ×2.
**Artifacts:** own Cursed Ward / Crown Of Command; opponent Keen Blade / Pendant Of Vitality.

The first different action belongs to the enemy Zena, aiming at Dryad rather than Pikeman. The original incumbent eventually reaches an Armageddon draw: its remaining Berserker and the enemy Cannon both die. Under the selected plan, the last pre-wave state instead contains enemy Tsar Cannon at 201 HP and own Dryad/Monk at 169/37. The wave decides that game for the enemy. Restoring Zena's first old aim does not recover the natural-stream game. This loss needs an endgame explanation as well as the opening target story.

**One-action checks:** selected plan + old first action: loss; incumbent plan + selected first action: loss. The first actor is the opponent. In 32 fresh continuations the chosen action scores 7, the old counterpart 6; counterpart gain -3.12 pp, Holm p 1.

**Own-decision scan:** 47 alternatives across 11 roots; 4 winning, 0 drawing and 43 losing branches on the original stream.
Earliest realized recovery: lap 1, root 3, Monk — shoot Battle Mage. Its original returned score was 0.48777 (complete complementary samples). This is one realized recovery, not a proven stronger action.

## Implications for the next algorithm change

1. Separate threat removal from raw HP/material gain. Gargantuan’s verified local error leaves a strong shooter alive by choosing a dodging target. A learned ranker or compute allocator should be tested on expected enemy activations denied, kill reliability, retaliation recipients and remaining spell/shot resources. This is a hypothesis for new armies, not a unit-specific guard.
2. Use actual-controller continuation labels when diagnosing forecast errors. The Monk example shows that winning against both native future policies can become an uncertain fight when both armies keep searching. The earlier failed bounded opponent-model and midpoint-refinement experiments remain failed; this finding does not retrospectively qualify them.
3. Keep counterfactual checks attached to visual stories. Missing legal movement options, a dead caster and an ugly return shot are concrete facts, but their avoidance can still worsen expected results. The nineteen hindsight recoveries cannot be pooled into a claimed strategy gain.
4. A resulting ranker, generator or augment rule must preserve the earlier improved games and pass newly registered full-game tests on unused armies, varied rosters/maps/artifacts/budgets, matched work and held-out confirmation. The old twenty-loss bank is now explanatory development data and must not become its strength test.

The original +1.2346 pp estimate and −2.1605 to +4.7840 pp uncertainty interval are unchanged. This study identifies decision-level mechanisms and rejects several tempting fixes; it does not turn that failed selector into a qualified policy.

## Review artifacts

The ignored client package `game/core/tmp/analysis/augment-game-by-game-20261026` retains all registrations/amendments, immutable receipts, raw requests/results, exact per-root witnesses, all-sign analyses and the standalone `loss-replays.html` viewer. Generated data, screenshots and HTML are not committed. The viewer uses recorded unit positions and HP, not rendered game animations; terrain/obstacles are omitted and final Armageddon effects can follow its last action snapshot.

The prior [loss-mechanism analysis](a19_augment_loss_mechanisms_research.md) and [frontier priorities](a19_frontier_priorities.md) provide the original study context.
