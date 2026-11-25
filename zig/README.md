# Zig engine spike

A native port of a slice of the common battle engine and the v0.1 AI, built to measure how much faster AI research
could run on a native simulator. It is not wired into the package build, lint, tests or any shipped code.

## Scope

Zig plays whole battles that match the TypeScript `runMatch` step for step, for battles with:

- every creature's stats, sizes (1x1, 2x1, 2x2), walking and flying, melee and ranged;
- the abilities of the creatures ported so far (batches 1 and 2, below); every other creature's abilities, and all
  spells, stripped; no artifacts;
- the army setup `runMatch` applies before the fight: the augments (Armor, Might, Sniper, Movement, Placement; Empower
  is carried but read by nothing in scope), doctrines (their upgrade budget) and synergies (Life, Chaos, Might and
  Nature, both variants, levels 1 to 3), including the Chaos break-on-attack roll and the Break effect;
- the NORMAL, LAVA_CENTER and BLOCK_CENTER grids (production rolls a third each), on classic or side-oriented boards
  (production is side-oriented on every map, and its BLOCK_CENTER boards carry the seeded scattered stones; the classic
  2x2 mountains of non-side BLOCK_CENTER are ported too), including board narrowing (holes, shoves, crushes) and the
  Armageddon waves;
- the v0.1 AI on both sides, with its BLOCK_CENTER mountain strategy.

The engine also replays (`hoc-sim parity`) the actions later AI versions emit on these boards: move-then-strike
(`melee_attack` with a `path`), `wait_turn`, `defend_turn`, aimed shots, refused `select_attack_type`, and ranged
obstacle shots (`obstacle_attack` without `attackFrom`, which v0.8 sends).

Ported:

- **Engine** (`engine.zig`, `combat.zig`): turn order and lap transitions, the morale and luck rolls, stack power and
  the stat refresh, move validation, melee with response, move-then-strike (`resolveKnownPaths` trusting the client
  route, `applyMoveModifiers` with its anchor-cell morale target, `getPositionForFootprintAnchor`), ranged line of fire
  with edge aiming, distance penalty, counter-shots and target switching, wait and defend, death cleanup.
- **Random stream** (`rng.zig`): `mulberry32` plus `getRandomInt` rejection sampling, bit for bit.
- **Path search** (`path.zig`): `PathHelper.getMovePath` as v0.1 uses it (the first-come FIFO walk, threat costs,
  diagonal sneak rules, the closest-move pass).
- **Terrain** (`terrain.zig`, below): lava, mountains, stones and `obstacle_attack`.
- **AI and match loop** (`ai.zig`): `StrategyV0_1.decideTurn`, `findTarget`, `doFindTarget`'s two passes, the melee
  target layers, target memory, the safer-move search, shooter line checks, `preferBackstabAttackCell`, the mountain
  strategy (`evaluateMountainStrategy`, `findMountainMeleeStrike`, `teamRangedFirepower`, `isLineBlockedByObstacle`),
  and the `runMatchInner` loop for v0.1 seats. The recovery net and `forceStalledLap` are not ported (never reached in the
  recordings or in a 2,000-battle probe of the TypeScript code); a battle that would need them stops with
  `unsupported` or `stuck`, which the parity check reports.

### Abilities

Batches 1 and 2, exact in both modes:

| Creature | Abilities |
| --- | --- |
| Leprechaun (L1) | Luck Blessing, Lucky Strike |
| Fairy (L1) | Shadow Touch, Small Specie |
| Scavenger (L1) | Backstab, Dodge |
| Nomad (L2) | Shatter Armor, Rapid Charge |
| Hyena (L2) | Penetrating Bite |
| Crusader (L3) | Double Punch, Sharpened Weapons Blessing |
| Goblin Knight (L3) | Heavy Armor, Dulling Defense |
| Peasant (L1) | Bitter Experience, Absorb Penalties Aura |
| Wyvern (L2) | Venom Cloud Aura, Wardguard |
| Pikeman (L2) | Aggr, Skewer Strike, Wardguard |
| Trent (L2) | Earth Element, Vine Throw, In Its Own World (inert under v0.1: it never casts, so no vines exist, and no Wind Element creature is ported; loaded as ability ids only) |
| Pegasus (L3) | Pegasus Might Aura, Pegasus Light |
| Hydra (L4) | Lightning Spin, Devour Essence, Ember Covenant Blessing |

The framework later batches build on:

- **Ability records** (`state.zig`): `AbilityId`, `Ability` (power, power type, ability type, `stack_powered`,
  `skip_response`, the default laps and power of the effect it applies), per unit in configuration order with a bit
  mask; `Unit.has` / `Unit.ability` mirror `hasAbilityActive` / `getAbility`. `engine.initState` loads them from
  `init.abilityConfigs` and `init.effectConfigs` and refuses a game with an unported ability or buff (reported per
  seed as `start state not supported`).
- **Ability formulas** (`abilities.zig`): `abilityMultiplier` (`calculateAbilityMultiplier`), `applyChance`
  (`calculateAbilityApplyChance`), `abilityCount` (`calculateAbilityCount`), `missChance` (`calculateMissChance` with
  `winningAtLeastOneEventProbability`), `skipsResponse` (`canSkipResponse`), and the processors that roll no damage:
  `rapidCharge`, `positionMultiplier` (Backstab), `penetratingBite`, `shatterArmor`, `dullingDefense`.
- **Buffs, debuffs and effects** (`state.zig` `SpellList`, `engine.minusLap`): name, laps and power in TypeScript's
  list order, `delete` by name, and the full `Unit.minusLap` (Dismorale holds effects and debuffs, Morale holds buffs,
  `Number.MAX_SAFE_INTEGER` and `NUMBER_OF_LAPS_TOTAL` never tick, deletion at 0).
- **Team blessings** (`abilities.refreshBlessings`, called from `engine.refreshStackPowerForAllUnits` when a source
  exists): `captureBlessingCensus`, `reapplyTeamBlessing` (carriers stripped, strongest source per team re-granted at
  the end of the list), the Luck Blessing early pass (luck-dependent sources re-derive their stats, and roll this lap's
  luck, before everyone else; then the census is taken again), and Sharpened Weapons with its non-positive power.
- **Stat refresh hooks** (`engine.adjustBaseStats`): Luck Blessing luck, Heavy Armor's base-armor multiplier,
  Shatter Armor's armor_mod, Sharpened Weapons' base-attack multiplier; Dulling Defense lowers the initial base attack.
- **Combat** (`combat.zig`): the ability multiplier applied after the damage roll, Lucky Strike's roll, every miss
  branch (melee, melee response, Double Punch, ranged shot and counter-shot: a missed shot rolls no damage and spends no
  arrow), the response gate (`canUnitRespondToMelee`), `meleeResponse` (captureResponse, run again after a second
  punch), `meleeRiders` (the on-hit riders of a landed blow, in handleMeleeAttack's order), `doublePunch`, and Rapid
  Charge's charged route (`movedRouteCellsThisTurn`, or a path-bearing strike's route length).

Added by batch 2:

- **Auras** (`state.AuraDef`, `State.aura_defs`, `Unit.auras`; `abilities.refreshAuras`, `auraPower`,
  `appliedAuraPower`): `refreshAuraEffectsForAllUnits` as a full refresh at every call site (TypeScript's fingerprint
  and known-empty fast paths never change the result). Pass 1 strips every MAX_SAFE_INTEGER row by name and computes
  each emitter's power once (`calculateAuraPower`: flat for Pegasus Might and Venom Cloud, `10 * stackPower + luck` for
  Absorb Penalties, read with the luck left by the previous refresh); pass 2 gives every holder unit, dead ones
  included, the strongest emission per name over its cells (per cell in holder order, per receiver in getCells order,
  a replacement only when strictly stronger, which keeps the first-seen position). Coverage is a Chebyshev ball of the
  range around any emitter cell. The aura row stores the emitter's base cell (`AppliedSpell.src_x/src_y`). The loader
  interns each aura effect from `init.auraEffectConfigs` and refuses an unported power type; the refresh runs only
  when `State.auras` is set, after the stack powers and before the blessings, and again after the Luck Blessing early
  pass, which now also covers aura emitters (so with a Leprechaun on the board, emitters roll lap luck first).
- **Effects with lifetimes** (`SpellList.replace` = delete + append): Poison (`abilities.poisonAura`, `applyPoison`:
  `floor(damage * max(0, 20 + attacker luck) / 100)`, stacking `max(p, prev + max(1, round(p / 2)))`, laps 15 = never
  ticks), Aggr (`abilities.aggr`: the roll is drawn even on an Aggr'd target; laps extended when the victim is the active
  unit), Pegasus Light (`abilities.pegasusLight`, `pegasusLightMorale`). The poison tick is in
  `engine.activateNextUnit` (no stat refresh, no morale; a death emits `unit_destroyed` after `next_unit_selected` and
  skips `refreshPossibleAttackTypes` and markFirstTurn).
- **Forced targets** (`Unit.target`, `combat.forcedTarget`): the melee and range gates (the ray's first hit must be the
  live forced unit), both response gates (raw target id, no liveness check), Double Punch's gate, `resetTarget` in
  `adjustBaseStats` and the release in `deleteUnit`; in the AI, `canSelectMeleeTarget` / `isLegalMeleeTarget`
  (selection, `selectableTargetAt`, `preferRespondedTarget`, `completeMoveWithMelee`, the melee branch),
  `findTarget`'s forced pick (no target memory, no draw) and `rangeShotLandable`.
- **Damage** (`engine.applyDamage(s, ui, dmg)`, every damage path including Armageddon and the poison tick): the Ember
  Covenant block (the hit deals 0 and the whole team's ring dissolves; `State.ember_teams`, `abilities.seedEmberCovenant`
  after start_fight's refresh, `breakEmberCovenant`, `absorbs`), the stack projection, then Bitter Experience (+1 armor
  and step, live and initial). Every caller computes its `*Absorbed` flag before the call and skips its riders.
- **Area strikes** (`combat.lightningSpin`, `skewerStrike`, `enemiesAround`): the spin's ring (allEnemiesAroundUnit at
  the strike cell, or the base cell when responding), a miss roll and, when not missed, a damage roll per victim, its
  riders, and its kill and Pegasus Light morale applied mid-strike; a spinner is never answered and its spin replaces the
  blow or the plain response (M2 and M3 are still drawn). The skewer hits the enemy behind a 1x1 target (no Lucky
  Strike, no response) and feeds the handler's kill and morale bookkeeping. `abilities.devourEssence` runs after the
  last refresh, attacker first.
- **Other hooks**: Pegasus Might (+power base armor before Heavy Armor's multiplier, +power base attack), Wardguard
  (magic resist; no reader in scope), the Absorb Penalties roll (`abilities.spitBall`: `processSpitBallAbility` draws
  `getAbsorptionTarget`'s roll on every landed shot and landed counter-shot whose victim carries the aura and whose
  source cell holds a unit; the result is unused).

### Maps and board orientation

The framework the maps added (all exact in both modes, see the coverage below):

- **Board** (`state.zig`): `Grid.board` holds `BLOCK` ("B", a classic mountain cell or a standing stone) and `LAVA`
  ("L") beside `EMPTY`, `HOLE` and unit codes; `st.isUnitCode` is the one test for "a unit stands here" (every
  `board - 1` read goes through it). `Grid.terrain` (`st.Terrain`) holds the scattered layout in roll order, a standing
  bit per layout cell, the cleared classic sides and `cleanedUpCenter`; `Fight` holds the classic hit counters
  (`hits_left`, `hits_right`: 3/3 on every BLOCK_CENTER board, scattered ones included, where they never move) and
  `side_oriented`. `path.buildMatrix` gives -1, -2, -3 as `getOccupantNumeric` does. The aggression boards ignore
  terrain, as in TypeScript.
- **Grid terrain** (`terrain.zig`): `load` (the recorded start state; then the loader cross-checks the rebuilt board
  against the recorded `grid.matrix`), `isScatteredMountainCell` (layout membership: true after the stone is gone),
  `clearScatteredMountainAt`, `clearMountainSide`, `encounterObstacleHit` (a classic hit sets the lap's damage fact; a
  stone hit sets none), `spendObstacleHit`, `obstacleStillStands`, `centerCells` (`getCenterCells` order: standing
  stones in layout order, then each uncleared classic side), `cleanupCenterObstacle` and `lapsNarrowed`.
- **Lap transition** (`engine.handleLapTransition`): the lava dries right after `flipLap` once `getLapsNarrowed()`
  reaches the laps till narrowing (lap 10 without additional narrowing; the additional laps are read before this
  transition's increment). Narrowing holes swallow stones (`occupyByHole`), a sweep cell holding a stone or lava moves
  nothing, and BLOCK_CENTER's 4 laps till narrowing (from the start state) put the narrowing laps at 5, 9 and 13.
- **Moves**: `groundRouteCrossesObstacle` (a walker's footprint on "B" at any route anchor) on `move_unit` and on a
  path-bearing `melee_attack`; every landing test already refuses terrain.
- **Path search** (`path.zig`): the predicates read literally. A walker is stopped by any non-zero cell (the diagonal
  sneak, 2x2 pairs and 2x1 shear included), a flyer by any non-zero cell except lava and water, and the closest-move
  pass is blocked by any non-zero cell for both. `Route.has_lava` is `hasLavaCell` (a flyer route over lava:
  `crossesLava` over the anchor, all four 2x2 cells, or a rectangle's cells up to the first blocking one).
  `knownPaths` keeps a flyer's lava destinations (only `cells` drops them, and nothing reads `cells`). `getMovePath` is
  specialised at compile time for walkers and flyers.
- **Line of fire** (`combat.evaluateRange`): the ray stops at the first "B" (nothing behind it is hit; a shot whose ray
  meets a stone first is refused, and a counter-shot whose return ray does is not fired, so its miss and damage rolls
  are not drawn); lava does not stop it. `sideObservable`: a side facing "B" is not an aim edge, one facing lava is.
- **Obstacle strikes** (`combat.obstacleAttack`, `handleObstacleAttack`): `rec.Action.obstacle_attack` (target
  position, `attackFrom`, the approach `path`, `hasLavaCell`); the gates, the walk in (the same route-trusting move
  modifiers as a path-bearing melee strike: distance morale to the anchor cell's centre, no `movedThisTurn`), the hit,
  Double Punch's second hit, the classic side clearing, then `completeTurn`. A rejection after the walk in keeps the
  move. With batch 2: a Pikeman's skewer breaks the stone behind the struck one or strikes the enemy standing there
  (`pierceScatteredObstacleBehind`, with its rolls and its morale settled at once), a Hydra's strike spins
  (`spinAroundObstacleStrike`: the full Lightning Spin on the enemies around, then every stone in the ring), and kills
  feed Devour Essence.
- **Stones off unit strikes** (`combat.meleeAttack`): a Hydra's attack spin knocks down every stone in its ring
  (`spinScatteredObstaclesAround`), a Pikeman's skewer breaks a stone behind a small target (`skewerStrikeObstacleCell`).
- **Side orientation**: Backstab measures "behind" along x with the target's width as the RIGHT margin
  (`abilities.positionMultiplierOn`, attack and response), and so does the AI (`isBackstabCellOn` in
  `preferBackstabAttackCell`). Nothing else v0.1 or the engine reads depends on orientation in scope (deployment zones
  are in the recorded start state).
- **AI**: the `OBSTACLE_ATTACK` kind (`Kind.obstacle`) from `evaluateMountainStrategy` ahead of the ranged-heavy hold
  and the regroup, its `decideTurn` branch (no attack-type prefix, no route legality check), `isLineBlockedByObstacle`
  in `findRangeAttackAction`, and `move_unit.has_lava` from the route.
- **Recording**: `Unit.creature_id` (`creatureId`, PBTypes.CreatureVals; 0 for older recordings).

### Augments, synergies and Break

The framework the army setup added (exact in both modes, coverage below):

- **Base stats** (`st.BaseStats`, the loader): runMatch's setup refresh folds augments and synergies into `props`
  before recording, so the loader reads `initialUnitProperties` from the recorded `initialProps` (and still from
  `props` in setup-free recordings). `BaseStats.amount_alive` is new (the Life supply).
- **Team setup** (`st.TeamSetup`, `State.setup[team]`, loaded from `init.setup.perTeam`): the constant
  `getAdditional*PerTeam` values and `getBreakChancePerTeam`. The ability power is also copied to every unit
  (`Unit.syn_power`): every ability formula in scope reads its owner's team (miss chance the dodger's, the response
  formulas the responder's), so `abilityMultiplier`, `applyChance`, `abilityCount`, Pegasus Light, the Sharpened
  Weapons census, Heavy Armor, Wardguard and the Absorb Penalties aura power keep their signatures.
- **Augments** (`SpellId.*_augment`, laps 15, before every later buff; `State.augments` gates the lookups):
  `engine.adjustBaseStats` adds Armor as a % of the running base armor (after Pegasus Might, before Heavy Armor's
  multiplier) and as flat magic armor (before the resist rolls), Movement as flat steps, and Might or Sniper off the
  attack type SELECTED at refresh time (Sniper also widens `shot_distance`). The Sniper buff's two stored properties
  (`27;70`) sit in `AppliedSpell.src_x/src_y` (the "first;second spell property" slot aura rows use for their source
  cell), loaded from `init.units[].buffsSources`. Placement only shapes the recorded start state.
- **Synergies** in `adjustBaseStats`: Life's luck into `luck_mod` and morale (when positive) onto the base morale,
  Chaos's steps into `steps_mod`, Nature's flyer armor as `armor_mod` (a flying creature, grounded or not; an active
  Shatter Armor is subtracted twice), Might's aura range in `abilities.refreshAuras` (per emission, `Emission.range`)
  and Might's ability power through `syn_power`. The Life supply grows every holder unit of the team in
  `start_fight` (`increaseUnitsSupplyIfNeededPerTeam`, LEFT then RIGHT, before the distances and the refresh).
  Morale changes never read the synergy (TypeScript ignores the argument).
- **Break** (`SpellId.break_`, an effect; laps and power from `init.effectConfigs.Break`): `Unit.has` / `ability`
  are Break-aware (absence is settled before the effects are scanned, so ability-free units pay nothing),
  `Unit.auraCount` gives no auras while Broken (the aura refresh and the Luck Blessing early pass read it),
  `abilities.skipsResponse` is off while Broken, and the lists tick and expire like any effect.
- **The break roll** (`engine.applyDamageBreak(s, victim, damage, chance, extend)`; `applyDamage` keeps its signature
  with chance 0 for Armageddon and the poison tick): after the Ember Covenant check and before the stack projection,
  drawn when the striker's team chance is positive and the victim is not already Broken, or always when `extend`; an
  extended Break lasts a lap longer. `combat.hit` threads the striker's team chance through every unit hit: the melee
  blow (`attack_handler.ts:3214`), the melee response (`:3072`, extended: the attacker is the active unit), the second
  punch (`:3400`), the ranged shot (`:1886`), the counter-shot (`:1763`, extended only when it hits the shooter whose
  turn it is, not a bystander on the return line), every Lightning Spin sub-hit (`lightning_spin_ability.ts:239`,
  attack, response and the obstacle strike's spin) and every Skewer Strike hit (`skewer_strike_ability.ts:210`, the
  unit strike, the response and the obstacle pierce), each right after that hit's damage roll.
- **Lists**: `st.SpellListN(cap)`; buffs hold 12 (Morale, three blessings, Ember Covenant, three aura rows, five
  augments), debuffs 4, effects 6. A push past the capacity is dropped (a digest mismatch, never memory corruption:
  with 8 slots a fully augmented, blessed and aura'd unit overflowed in release builds).
- **Obstacle shots** (`combat.obstacleAttackAt`, `rec.Action.obstacle_attack.has_from`): a shooter with RANGE
  selected that can land a shot fires instead of striking: on a scattered board it breaks the FIRST stone on its ray
  (`getObstacleIntersections`), on the classic board it spends the aimed mountain's hit; one arrow either way, no roll;
  refused after this turn's move; a shot that breaks nothing falls through to the melee branch when `attackFrom` is
  given.
- **AI** (`ai.Ctx.prefer_attack_over_mining`, false for v0.1): v0.6's `setPreferAttackOverMining`, for the v0.8 port.
  The v0.1 AI reads Break only through Backstab (`preferBackstabAttackCell`) and no synergy getter.

### Porting the next batch

- Add the ability to `AbilityId` (and any buff, debuff or effect it applies to `SpellId`), then port its branches from
  the real TypeScript; the reduced references mark the hook points but drop the ability code.
- Order is state. Every apply deletes the name and appends it, blessings are re-granted at the end of the buff list on
  every stat refresh, and the digest compares lists in order.
- Random draws follow the source line by line: a damage roll and a Lucky Strike roll happen even when the blow then
  misses; a missed ranged shot draws neither. An early stat pass (Luck Blessing) moves luck rolls ahead of other units.
- Which unit's luck and stack power a formula reads, and when: the census reads each source as left by the previous
  refresh, Heavy Armor reads the luck just derived in the same refresh.
- Abilities read by the v0.1 AI live in `src/ai/ai.ts` (`preferBackstabAttackCell`, `hasAbilityActive` checks) and
  `src/ai/versions/v0_1.ts`.
- Keep the ability-free path cheap: probes go through the unit's ability mask, the blessing census runs only when
  `State.blessings` is set, the aura refresh only when `State.auras` is, the batch-2 stat hooks only when
  `State.stat_hooks` is, and the Ember Covenant check only while a team holds one.
- Map lessons (for the next batches on these boards):
  - Terrain is state the digest must name: the stones in layout order, the counters, the cleared sides, the dried
    centre. `initState` used to ignore `grid.matrix`; it now rebuilds the board from `init.terrain` and checks it
    against the matrix, so a missing terrain field fails at load instead of drifting.
  - An ability with a sweep (spin, skewer, Fire Breath, splash) also touches stones: grep the handler for
    `spendObstacleHit` / `ObstacleCells` before porting it, and check the obstacle strike path, which runs the same
    abilities (the Hydra's spin off a stone strike draws as off a unit strike).
  - Rays and aim edges read "B"; adjacency, auras and the aggression boards do not.
  - A flyer route can carry `hasLavaCell: true`; every action built from a route must copy it (`move_unit`, and a
    path-bearing `melee_attack` or `obstacle_attack`), or the native check reports an action mismatch on LAVA.
  - Placement augments and the side zones are in the recorded start state, but anything that reads the axis of
    advance (`isSideOrientedPlacement`, `isSideAxisPolicyTeam`) must take `s.fight.side_oriented`.
- Setup lessons (for artifacts and the next creatures):
  - Every new unit hit goes through `combat.hit` (or `engine.applyDamageBreak`) with the STRIKER's team chance and the
    call site's `extendBreak`; grep the TypeScript handler for `getBreakChancePerTeam` next to each `applyDamage`.
    A hit's break roll comes right after its damage roll, and a killing blow still rolls.
  - Every new ability read must be Break-aware: use `Unit.has` / `ability` / `auraCount`, never `ability_mask` or
    `n_auras` (those are only load-time "can it ever happen" flags and cheap pre-filters). TypeScript reads
    `hasAbilityActive` / `getAbility` / `getAbilities()` / `getAuraEffects()`, which all respect Break, except where it
    reads `props.abilities` names (the luck-dependent blessings, the blessing census's stack blessings).
  - A Break taken mid-action switches the rest of the action off: a Crusader broken by the response gets no second
    punch, its blow lands without riders, a Hydra broken by the attacker's spin does not spin back, a Broken Fairy is
    answered. Read abilities at their TypeScript point in the action, never hoisted.
  - Every ability formula takes the owner's team ability power (`Unit.syn_power`); confirm the team at each new call
    site (miss chance: the dodger's; responses: the responder's).
  - Refresh-time values are stale until the next refresh: Might/Sniper follow the attack type selected at the last
    refresh (a shooter that drops to MELEE on activation keeps its sniped shot distance for that turn).
  - A setup refresh runs before recording, so the start state can carry blessings and aura rows (with their
    `buffsSources`), and Life morale can lift a unit off 0 so it draws lap morale rolls, or settle the first turn by
    morale so the coin flip is not drawn.
  - Artifacts: `RECORD_ARTIFACTS` already records them (`init.setup.perTeam.artifactT1/T2`; the loader refuses their
    buffs). Their stored properties may not fit `src_x/src_y` (i8, integers: Pendant of Vitality's 12.5 is
    `parseFloat`ed), the buff list may need more room, Broken Aegis adds +20 to the recorded break chance and a self
    miss chance, Quiver of Echoes adds a roll to every landed shot and to the ranged obstacle shot (the branch skips it
    now), Barrel Barricade places barrels inside `start_fight` (after the supply, before `fightProperties.startFight`),
    and Cursed Ward / Crown of Command move luck and morale in `adjustBaseStats`.
  - Next creatures: Squire's Arcane Ward Blessing is a luck-dependent census blessing (the early luck pass) and a
    magic-resist roll; Monk's Magic Shield is another resist roll; Troglodyte's Madness pins morale to 0 (a
    `hasAbilityActive` gate on morale changes too) and Blind Fury adds attack_mod; Zena's Chakram rolls its bounces in
    flight order and Rallying Volley is a census blessing; Arachna Queen's Web Aura locks flyers at activation
    (`refreshPreTurnState`). All of them are Break-aware in TypeScript.
- Batch 2 lessons:
  - Inert is not absent: Trent's abilities change nothing in scope, but the loader must still know their names.
  - A refresh-time value is stale until the next refresh: aura rows after `move_unit` (no refresh), Absorb power at a
    lap's first refresh (previous lap's luck), stack power after a poison tick. Mirror the call sites; never refresh
    eagerly.
  - Rows written after the last refresh of a step stay after the aura rows (Morale after `advance`, Ember Covenant
    after `start_fight`); the next refresh moves the aura rows behind them again.
  - Dead units still in the holder emit and receive auras and pay or block morale until `cleanupDeadUnits`.
  - Check the roster shape before chasing a zero coverage count: rosters are mirrored with one level-3 and one level-4
    slot, so two kept creatures of the same level never share a team (a Crusader never punches a target its own
    Pegasus lit).
  - A decision context (`ai.Ctx`) is about 18 KB: build it in place (`initCtxInto`), a by-value return cost about 7% of
    battle time.

## How parity is checked

`parity/record.ts` runs real headless battles through `runMatch` and records every top-level engine call
(`GameActionEngine.apply` and `TurnEngine.advanceAfterNoActiveUnit`) and every AI decision (`decideTurn`). For each
it stores the random state before and after, the headless events, the decided actions, and a digest of every unit and
of the turn queues.

- `hoc-sim parity` replays each recorded engine call from its random state (engine only).
- `hoc-sim native` plays each battle in Zig from its start state with the Zig AI and checks every decision and engine
  call against the recording: the action, the random stream, accept/reject, the events and the digest.
- `hoc-sim paths` recomputes recorded `getMovePath` calls (record with `RECORD_PATHS=<file>`), comparing every route,
  weight and lava flag.

Map options (the defaults reproduce the classic NORMAL recordings; the only new start-state field there is
`creatureId`):

- `RECORD_GRID=1|3|4|mix` (also `RECORD_GRID_TYPE`): NORMAL, LAVA_CENTER, BLOCK_CENTER, or a per-seed pick weighted by
  `RECORD_MAP_WEIGHTS=n,l,b` (default `1,1,1`, production's thirds). The pick hashes the seed into a private mulberry32
  stream, so it touches no battle stream and a seed always gets the same map and roster.
- `RECORD_SIDE=1` (also `RECORD_SIDE_ORIENTED`): production's side-oriented boards (side zones, the Backstab axis on x,
  and on BLOCK_CENTER the stones seeded `sim-${seed}`).
- On any non-classic-NORMAL recording the start state gains `init.terrain` (`layout` in roll order, `standing`, `hitsL`,
  `hitsR`, `leftCleared`, `rightCleared`, `cleanedUpCenter`, `sideOriented`) and the fight digest gains `terrain` (the
  same minus the layout and the orientation); the `.meta.json` gains `gridMode`, `mapWeights`, `sideOriented` and the
  battles per map (`gridTypes`). `RECORD_PATHS` lines gain each route's `hasLavaCell` (a fourth element; `hoc-sim
  paths` compares it when present, accepts and ignores `vine: true`, and counts a made-of-fire call as a mismatch).

```bash
RECORD_GRID=mix RECORD_SIDE=1 zig/parity/check.sh 500       # production maps and boards
RECORD_GRID=4 RECORD_SIDE=1 RECORD_PATHS=/tmp/p.jsonl bun zig/parity/record.ts 200 1 /tmp/b.jsonl
```

Setup options (all off by default, and then the recording is byte-identical to a setup-free one; the full list is in
the header of `record.ts`):

- `RECORD_AUGMENTS=random|production|"Armor:3,Sniper:3,Might:1"|"<green>|<red>"`: random plans inside the budget,
  production's plan (`resolveSetupPolicy` of the v0.8 setup spec, then the a19 striker-rush or shooterless rewrite;
  the revealed-ranged delivery layer needs the live draft and is left out), or explicit plans (Empower allowed).
- `RECORD_DOCTRINE=random|1|2|3` (the upgrade budget 6/5/7; unset is 7), `RECORD_PLACEMENT_TIMING=setup-before-placement`.
- `RECORD_SYNERGIES=1`: every faction with two distinct creatures fields the board variant; with
  `RECORD_SYNERGY_VARIANTS=default|seed|random|"Life:2,Chaos:2,Might:2,Nature:1"` (`seed` is production's
  `synergyVariantsForSeed`; `default` never fields Chaos break or Life morale/luck).
- `RECORD_DISTINCT_RED=1`: red drafts its own roster (asymmetric synergies and plans); `RECORD_FACTION="Chaos|"`
  drafts a team from one faction so its synergy reaches level 2 or 3.
- `RECORD_ARTIFACTS=random|"t1:t2"|...` (for the artifact batch) and `RECORD_TRACE_DRAWS=1` (each step's `ds`, the
  `getRandomInt` caller of every raw draw, the break roll naming its hit, and a `<out>.sites.json` tally).

With any setup option the start state gains `initialProps`, `buffsSources`, `setup` (variants and per-team values)
and `effectConfigs.Break`, each battle line gains `requested`, the unit digest gains `shot_distance`,
`base_armor_init` and `steps_init`, and the `.meta.json` gains `setup`. Production-like:

```bash
RECORD_GRID=mix RECORD_SIDE=1 RECORD_AUGMENTS=production RECORD_DOCTRINE=random RECORD_SYNERGIES=1 \
  RECORD_SYNERGY_VARIANTS=seed RECORD_DISTINCT_RED=1 RECORD_PLACEMENT_TIMING=setup-before-placement \
  zig/parity/check.sh 500
```

`hoc-sim parity` and `native` report a game they cannot parse (an action or event outside the port) as "recording not
supported" with its seed and step and go on, as they do for an unsupported start state.

The unit digest holds every compared stat, the buff/debuff/effect names, laps and powers, and some hidden state
(position, base morale, luck per turn, initial base attack, moved route cells, the Aggr forced target, magic resist,
each buff's stored properties and, with setup, the shot distance and the initial base armor and steps); the fight
digest adds the Ember Covenant teams and, on map recordings, the terrain. The field list is in each recording's
`.meta.json`; columns a recording lacks are skipped, so older recordings stay comparable. The start state carries the
configs the engine reads without an ability naming them: `auraEffectConfigs`, `effectConfigs.Poison` and
`spellConfigs["Ember Covenant Blessing"]`.

`RECORD_KEEP_ABILITIES="Leprechaun,Nomad"` keeps those creatures' abilities (and spells) and swaps each roster slot
for a kept creature of the same level with probability `RECORD_KEEP_RATE` (default 0.6). Use it to check a batch:

```bash
# from the common package root
zig/parity/check.sh 200          # record 200 fresh battles (random seed), then run parity and native on them
RECORD_KEEP_ABILITIES="Leprechaun,Nomad,Crusader,Fairy,Goblin Knight,Hyena,Scavenger" zig/parity/check.sh 300
cd zig && zig build test         # unit tests (random stream, JS number rounding)
```

Run `check.sh` after changing any rules or v0.1 AI code the port covers, both with and without the batch kept.

Setup (augments, synergies, Break), checked on 2026-11-25 against common `7babe862` (both modes, every battle
identical; all on side-oriented production-mix maps, `RECORD_GRID=mix RECORD_SIDE=1`):

- production-like setup (augments `production`, random doctrines, synergies at the seed's board variants, distinct
  red rosters, `setup-before-placement`): ability-free 1,000 battles, 158,723 steps (seeds 4000000–4000499 and
  4100000–4100499); batches 1 and 2 kept 1,500 battles, 253,519 steps (4200000–4200499 and 4210000–4210499 at the
  default keep rate, 4300000–4300499 at keep rate 1);
- forced augments, 1,700 battles, 289,148 steps: Armor 3 + Might 3 + Movement 1 ability-free and kept (seeds
  4500000, 4510000, 300 each), Sniper 3 + Placement 2 + Movement 2 with `setup-before-placement` (4520000, 4530000),
  Empower 3 + Armor 2 + Might 2 (4540000, 200) and random plans with random doctrines, kept (4550000);
- forced synergies (`RECORD_SYNERGIES=1 RECORD_DISTINCT_RED=1`), 4,500 battles, 796,216 steps: every variant at
  every level, with one-faction rosters (`RECORD_FACTION`) and the batch kept or only that faction's kept creatures:
  Chaos break 6/11/17% (4600000, 4610000, 4620000, 4710000, 4720000), Chaos movement +1/+2/+3 (4630000, 4780000),
  Life morale and luck up to +20/+9 (4640000, 4730000), Life supply 6/12/19% (4650000, 4770000), Nature flyer armor
  up to 35% (4660000, 4740000), Might ability power up to 12 (4670000, 4750000), Might aura range +1 to +3 (4680000,
  4760000) and random variants (4690000);
- branch counts (an instrumented copy, those 8,700 battles): Armor 3.4M refreshes, Might 2.5M, Sniper 264k (50k
  refreshes of a shooter with MELEE selected holding Sniper), Movement 2.1M, Empower carried 208k; Life morale/luck 1.3M,
  Chaos steps 1.3M, flyer armor 423k (8,421 under Shatter Armor), supply 13,320 stacks, aura range 150k emissions,
  ability power in 104k formula calls, 69,873 lap morale rolls on Life teams, 3,926 first turns settled by morale and
  2,221 coin flips; break rolls on the melee blow 41,616, the response 29,736, the second punch 861, Lightning Spin
  sub-hits 19,090, Skewer Strike hits 191, ranged shots 10,280, counter-shots 591 on the shooter (extended) and 45 on a
  bystander; 8,408 Breaks applied (2,590 extended), 12,509 rolls skipped on a Broken victim and 4,882 extended re-rolls
  on one; while Broken, 42,837 ability probes refused, 2,358 spins and 239 second punches suppressed, 1,709
  skip-response checks off (a Broken Fairy or Hydra is answered), 13,674 refreshes of a silent aura emitter, and 69
  Bitter Experience gains suppressed;
- the break-roll draw sites with abilities kept (`RECORD_TRACE_DRAWS=1`, 80 battles from seed 4700000): melee blow
  `attack_handler.ts:3214`, response `:3072`, second punch `:3400`, `lightning_spin_ability.ts:239` and
  `skewer_strike_ability.ts:210` (each right after its own damage roll; a response spin's rolls come before the
  attacker's blow);
- unchanged: the default recorder output is byte-identical to the previous recorder's (classic NORMAL seeds 1001–1020,
  and batches 1+2 kept on the side mix, 2001–2020); classic NORMAL ability-free `check.sh 500 2810000` (84,900 steps);
  the side mix without setup, ability-free 300 (2820000) and batches 1+2 kept 300 (2830000); the v0.8 replays
  (`hoc-sim parity` 100/100 on v0.8s and v0.8sr, and 100/100, 22,816 steps, on 100 v0.8 rollout-origin battles on
  side-oriented mixed maps, seeds 4001–4100, whose three ranged obstacle shots now replay); `zig build test`.

Maps, checked on 2026-11-25 against common `2061f9ce` (both modes, every battle identical):

- ability-free, side-oriented: NORMAL 1,000 battles, 182,867 steps (seeds 2000000–2000999); LAVA_CENTER 1,000,
  187,391 steps (2100000–2100999); BLOCK_CENTER 1,000, 197,951 steps (2200000–2200999); the production mix 1,000,
  189,766 steps (2300000–2300999: 356 NORMAL, 324 LAVA, 320 BLOCK);
- batches 1 and 2 kept, production mix: 1,800 battles, 344,461 steps (seeds 2400000–2401499 at the default keep rate,
  2402000–2402299 at keep rate 1);
- smaller dev runs: 100 each of ability-free classic BLOCK, LAVA side, BLOCK side and NORMAL side (seeds 1–100), and
  at keep rate 1 BLOCK side (5000–5099), classic BLOCK (6000–6099) and LAVA side (7000–7099);
- `getMovePath`: 17,136 calls on side BLOCK (seeds 2600000–2600199), 17,912 on side LAVA (2700000–2700199; 2,916 with
  lava routes), 9,367 with Trent, Hydra, Pegasus and Wyvern kept on the mix (2750000–2750099; 2,090 vine-strider
  calls), every route, weight and lava flag identical;
- unchanged: classic NORMAL ability-free (`check.sh 500 2800000` and the benchmark recording), batches 1 and 2 kept on
  classic NORMAL (`check.sh 500 2900000`), and the v0.8 replays (`hoc-sim parity`, 100/100 for v0.2, v0.8s and v0.8sr);
  the v0.8 port at `39705fcc` builds against the new API and its layer check stays 7,308/7,308;
- reached, in the side BLOCK_CENTER thousand: 7,560 obstacle strikes (6,895 walking in, 665 in place), 1,463 aimed
  shots, 802 stones swallowed by narrowing holes, additional narrowing laps; in the side LAVA_CENTER thousand: 365
  battles that dried the lava (all at lap 10) and 422 flyer moves with `hasLavaCell: true`; in the kept mix: 281 Hydra
  obstacle strikes (24 with a spin that rolled, 11 killing a stack) and 268 stones broken by Hydra unit strikes, 308
  Pikeman obstacle strikes (29 breaking the stone behind, 2 skewer rolls at the enemy behind it), 326 Crusader strikes; in
  the classic BLOCK dev run, 59 mountain sides cleared and Double Punch's second hit;
- a negative check: playing the kept mix with the orientation forced to classic diverges in 136 of 500 battles
  (Backstab).

Batch 2, checked on 2026-11-25 against common `7dedbbe3` (both modes, every battle identical):

- batch 2 kept (`Wyvern,Pikeman,Peasant,Pegasus,Hydra,Trent`): 2,600 battles, 362,343 steps (default keep rate:
  seeds 7000–7299, 100000–100499, 200000–200499, 4343000–4343299 and 5000000–5000499; keep rate 1: seeds
  300000–300499);
- smaller keep lists, 6,100 battles, 923,563 steps: at keep rate 1, Pikeman + Wyvern (seeds 400000–400299), Hydra
  (500000–500299), Peasant + Pegasus (600000–600299), Trent (700000–700199) and Pikeman + Hydra (3500000–3500999); at
  the default rate, Pikeman + Wyvern (3000000–3000999), Hydra + Pikeman + Peasant (3100000–3100999) and Pikeman
  (3700000–3701999);
- batches 1 and 2 kept together: 1,500 battles, 216,367 steps (seeds 800000–800499, and 900000–900499 and
  5100000–5100499 at keep rate 1),
  plus 3,000 battles of mixed lists: Crusader + Pegasus + Wyvern + Pikeman (3200000–3200999), Leprechaun + Wyvern +
  Pegasus + Peasant + Scavenger + Fairy (3300000–3300999) and, at keep rate 1, Pikeman + Scavenger (3400000–3400999);
- batch 1 alone: 800 battles (seeds 1000000–1000499 and 5200000–5200299) and an older 1,000-battle recording (seeds
  20000–20999); the
  ability-free baseline: 1,000 battles (seeds 1100000–1100499 and `check.sh 500 4242000`) and the 1,000-battle
  benchmark recording;
- branch counts (an instrumented copy, 11,000 of these battles): Lightning Spin 24,607 attacks and 9,389 responses
  (22 sub-hits missed against Dodge and Small Specie, 14,178 spin kills), Skewer Strike 6,934 hits (446 kills, 2,114
  from a response, one miss, one absorbed), Aggr 65,949 rolls (12,393 applied, 1,636 on an Aggr'd target, 3,870
  extended), 7,232 forced AI decisions (366 with another enemy adjacent, 270 refused shots, 42 forced shots), 2,382
  melee and 12 counter-shot responses blocked by Aggr, three Aggr effects held by Dismorale, poison 25,317 applications
  (from blows, responses, spins, skewers, shots, counter-shots and second punches) and 20,134 ticks (1,550 deaths),
  Ember Covenant 35,424 rings and 5,904 absorbs (melee, response, spin, shot, one skewer and one counter-shot), Bitter
  Experience 6,533 gains (158 from poison, 4 from Armageddon), Pegasus Light 12,120 applications and its morale on every
  path but the second punch, 763 Absorb Penalties rolls, 9,492 Devour Essence heals, 83,988 early luck passes of aura
  emitters beside a Leprechaun;
- never reached in scope: Ember Covenant against Armageddon or a poison tick (a poisoned team has always lost its ring
  to the hit that poisoned it), Pegasus Light morale on a second punch (see the roster note above), Double Punch
  blocked by Aggr (the strike itself is refused first).

The other AI versions' replays, ability-free NORMAL battles recorded by the v0.8 port: `hoc-sim parity` is 100/100 for
v0.1 to v0.7, v0.8s and v0.8sr (seeds 2001–2100 for v0.2, 3001–3100 for the others), with 39 to 91 move-then-strikes,
up to 1,990 waits and 56 defends per 100 battles.

Batch 1, checked on 2026-11-25 against common `a0ff5fe8` (both modes, every battle identical):

- default keep rate: 3,600 battles, 606,198 steps (seeds 100–399, 20000–20999, 731000–731999, 912000–912999 and
  300 from a random seed);
- keep rate 1: 600 battles with the whole batch (seeds 55000–55599), and 300 each of Leprechaun + Crusader, Scavenger
  + Fairy, and Goblin Knight + Nomad + Hyena (seeds 61000, 62000, 63000);
- every ported branch fired in these battles, including melee, Double Punch and ranged misses, Lucky Strike procs,
  Small Specie against level-4 attackers, Backstab hits and re-aimed Backstab approaches, and Dulling Defense at the
  base-attack floor;
- the ability-free baseline stayed identical: 500 battles (seeds 424242–424741), both modes.

Before abilities, checked on 2026-11-25 against common `19f3c39c` (300 battles, seeds 515000–515299, both modes),
`b60b2ab6` and `a526c404`:

- engine replay: 3,805 battles identical (seeds 1–300, 1001–2000, 424242–424541, 777000–777199, 910000–911999);
- native play: 3,005 battles identical (seeds 1–5, 1001–2000, 910000–911999), plus seeds 1001–2000 again on the
  9800X3D against the profile v35 tree;
- 27,089 `getMovePath` calls identical (seeds 6000–6399).

## Benchmark

```bash
bun zig/parity/record.ts 1000 1001 zig/parity/out/bench1000.jsonl   # prints TypeScript engine and AI timings
cd zig && zig build -Drelease=true                                   # plain `zig build` is a debug build, ~10x slower
./zig-out/bin/hoc-sim bench parity/out/bench1000.jsonl --reps 20 --threads 1          # engine steps only
./zig-out/bin/hoc-sim native-bench parity/out/bench1000.jsonl --reps 5 --threads 1    # whole battles, AI + engine
```

For the 9800X3D: `zig build -Drelease=true -Dtarget=x86_64-linux-musl -Dcpu=znver5` (a static binary).

Results on 2026-11-25 for the same 1,000 battles (123,692 engine steps, 49,285 AI decisions). TypeScript is timed inside
the recorder, warmed up, and counts only the engine and AI calls, not the rest of `runMatch`. Both hosts were shared
with other jobs (M4 load average 40 to 110; 9800X3D at nice 10 beside eight nice-19 jobs), so absolute numbers are
pessimistic; each comparison ran back to back under the same load.

| | M4 Max | 9800X3D |
| --- | --- | --- |
| TypeScript engine step | 19.8 to 23.3 µs | 22.8 to 23.7 µs |
| TypeScript v0.1 decision | 90.6 µs | 92 to 94 µs |
| TypeScript battle (engine + AI) | 6.92 ms | 7.39 ms |
| Zig engine step, 1 thread | 0.66 to 1.05 µs | 0.55 to 0.65 µs |
| Zig battle (engine + AI), 1 thread | 298 to 327 µs | 336 to 408 µs |
| Zig battles per second, all cores | 24.5k (12 threads, before the layer bitmap) | 16.9k (8 threads), 19.5k (16) |

Engine steps run 22 to 43 times faster per core; whole battles run about 21 to 23 times faster on the M4 and 18 to 22
times on the 9800X3D. Both hosts produce the same results (identical run checksums). In these
battles the AI costs more than the engine (0.4 decisions per engine step, each about 4.5 engine steps' cost).

Batch 1 left the ability-free path unchanged: the same 1,000 battles give the same run checksum, and interleaved
runs of the old and new binaries stay within noise of each other. Batch 2 and move-then-strike kept whole battles
within noise too: over ten alternated pairs at load 7 to 17 the medians were 262.0 µs (old) and 264.2 µs (new),
pairwise +0.6%, with 0.8% more retired instructions and the same run checksum. The engine-only replay is about 2%
slower (medians 603 and 614 ns per step at load 25; about 4% more instructions), from the area-strike, covenant and
forced-target checks on every strike and stat refresh. Building the 18 KB decision context by value had cost 7%;
`initCtxInto` builds it in place.

The maps kept the classic path within noise too, on a far busier host (load 82 to 113, so only the comparison
means anything): eight alternated pairs of `native-bench --reps 5` on the benchmark recording gave medians of 770.7 µs
(old) and 719.3 µs (new) per battle, pairwise -3%, and five pairs of the engine-only bench 1,501 and 1,386 ns per
step, with the same run checksums. `getMovePath` is now specialised at compile time for walkers and flyers. On that
host, one run each: side NORMAL battles cost about what classic ones do (538 against 528 µs), side BLOCK_CENTER about
1.15 times (618 µs) and side LAVA_CENTER about 1.25 times (683 µs).

The setup batch (augments, synergies, Break-aware ability probes, the break-roll check on every hit) kept the
classic path within noise, on a busy host (load 9 to 88): twelve alternated pairs of `native-bench --reps 5` gave
medians of 387.5 µs (old) and 383.5 µs (new) per battle, pairwise +0.6% (an earlier eight pairs: 387.7 and 401.3 µs,
pairwise 0%), and four pairs of the engine-only bench 609 and 601 ns per step, with the same run checksums. The
ability-free path pays a mask test per ability probe (as before), one `State.augments` test per refresh and a zero
break-chance test per hit.

A battle state is a flat value of about 40 KB (40,432 bytes; 36 KB before abilities, 41 KB with three 8-entry spell
lists per unit before the setup batch sized them 12/4/6), so a search rollout's snapshot and restore is one copy.

Where Zig spends battle time (sampled, before the layer bitmap): `getMovePath` 31%, `doFindTarget` 14%, the melee
target layers 22%, the engine 20%. None of it is tuned beyond one bitmap for the layers.

## Not covered yet

- the abilities of every creature outside batches 1 and 2, spells and artifacts (and so Broken Aegis's +20 break
  chance and self-miss); the revealed-ranged delivery layer of production's augment plan (it needs the live draft);
  WATER_CENTER (never played); on the maps, Area Throw / Large Caliber on stones (`areaStrikeAtCell`), Quiver of
  Echoes' extra obstacle shot, Fire Breath through stones, artifact barrels, and `forceStalledLap` / the recovery net
  (never reached: 0 rejected engine calls in every map recording). The ported code leaves out what no battle in scope
  can reach: Made of Fire, Mechanism, Paralysis, the
  forbidden target (Terrifying Gaze), Water Shield and Water Element, Flesh Shield, the Dual Strike Charm, the aura
  power types outside the three in scope, Skewer Strike from a large attacker, the Vine Throw cast, vines and the
  Earth/Wind element pair (Thunderbird is not ported);
- the AI versions the research uses (v0.8 with the a19 search). The production rollout policy is the v0.8 chain, about
  67k lines of TypeScript; its port lives in `src/v08/` and builds on `ai.zig` (every declaration public,
  `playMatchWith` takes the decide function, `initCtxInto` builds a decision context) and `compare.NativeCheck`.
