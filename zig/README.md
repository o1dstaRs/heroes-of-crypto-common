# Zig engine spike

A native port of a slice of the common battle engine and the v0.1 AI, built to measure how much faster AI research
could run on a native simulator. It is not wired into the package build, lint, tests or any shipped code.

A bridge (`BRIDGE.md`) hands a live TypeScript battle to the engine mid-fight: `parity/state_export.ts` exports it,
`src/snapshot.zig` loads it (refusing what the port does not model), and a C ABI (`zig build lib`, `ffi/bridge.ts`)
plays it out or runs A19 search rollouts on it, with v0.1 or the native v0.8 policy (`src/v08`) on each seat, the
plain or actor-antithetic chance stream and the material, v1 or v2 leaf.

## Scope

Zig plays whole battles that match the TypeScript `runMatch` step for step, for battles with:

- every creature's stats, sizes (1x1, 2x1, 2x2), walking and flying, melee and ranged;
- the abilities of the creatures ported so far (batches 1 to 5, below), including the units Infest and Summon Wolves
  summon and the abilities Predatory Assimilation and the Wild Regeneration gift move between units; every other
  creature's abilities stripped;
- the artifacts (below; `src/artifacts.zig`): all 28 in the live pools, played as runMatch applies them (once, at
  setup); a team holding the disabled Broken Aegis or Holy Cross is refused;
- the wave-1 spells (below): Heal, Blessing, Lightning Strike, Fire Strike, Meteor Shower, Meteorite, Ring of Fire, Summon
  Wolves and Vine Throw, with the casters' spellbooks (Healer, Battle Mage, Satyr, Magic Dragon, Trent, and a Queen that
  stole one), the MAGIC attack type, the vines and the Wolves they summon; of wave 2 so far, the Wandering Mage's
  Fireball (Fire Strike's gate and trajectory, then the blast: the unit it burst on, then the living units on the impact
  cell and its ring, allies too, the caster spared); a book holding any other spell is refused;
- the army setup `runMatch` applies before the fight: the augments (Armor, Might, Sniper, Movement, Placement; Empower
  is carried but read by nothing in scope), doctrines (their upgrade budget) and synergies (Life, Chaos, Might and
  Nature, both variants, levels 1 to 3), including the Chaos break-on-attack roll and the Break effect;
- the NORMAL, LAVA_CENTER and BLOCK_CENTER grids (production rolls a third each), on classic or side-oriented boards
  (production is side-oriented on every map, and its BLOCK_CENTER boards carry the seeded scattered stones; the classic
  2x2 mountains of non-side BLOCK_CENTER are ported too), including board narrowing (holes, shoves, crushes) and the
  Armageddon waves;
- the v0.1 AI on both sides, with its BLOCK_CENTER mountain strategy, and on mindless ("AI Driven") units whatever
  their seat.

The engine also replays (`hoc-sim parity`) the actions later AI versions emit on these boards: move-then-strike
(`melee_attack` with a `path`), `wait_turn`, `defend_turn`, aimed shots, refused `select_attack_type`, ranged
obstacle shots (`obstacle_attack` without `attackFrom`, which v0.8 sends), the wave-1 casts (`cast_spell`), batch 4's
casts (Battle Roar, the Wild Regeneration gift) and batch 5's two action shapes (`area_throw_attack`, and the free-aim
Through Shot: `range_attack` with `targetPosition` and no target id).

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

Batches 1 to 5, exact in both modes:

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
| Trent (L2) | Earth Element (Lightning Strike x1.5, meteors 0), Vine Throw (a castable ability: one charge), In Its Own World (the vine stride) |
| Pegasus (L3) | Pegasus Might Aura, Pegasus Light |
| Hydra (L4) | Lightning Spin, Devour Essence, Ember Covenant Blessing |
| Zena (L3) | Handyman, Chakram, Rallying Volley Blessing |
| Arachna Queen (L4) | Web Aura, Infest, Predatory Assimilation |
| Arachna Spider (summoned) | Infest |
| Squire (L1) | Stun, Arcane Ward Blessing |
| Troglodyte (L1) | Madness, Blind Fury, Miner |
| Monk (L3) | Magic Shield, Borrowed Grace (live since the cast Blessing: the only takeable buff), Absolving Arrow |
| Wolf (L1, also the Summon Wolves summon) | Double Punch, Deep Wounds Level 1 |
| Berserker (L1) | AI Driven, Double Punch |
| White Tiger (L2) | Disguise Aura (the Hidden / Visible markers), Deep Wounds Level 2 |
| Manticore (L2) | Warding Mane Blessing, Terrifying Gaze, Deep Wounds Level 2 |
| Troll (L2) | Wild Regeneration (the regeneration, and a giftable castable charge) |
| Griffin (L3) | Range Null Field Aura, Sky Runner, Deep Wounds Level 2 |
| Frenzied Boar (L4) | AI Driven, Magic Shield, Boar Saliva |
| Behemoth (L4) | Unyielding Power, Battle Roar (a castable mass buff), Deep Wounds Level 3 |
| Arbalester (L1) | Sniper, Limited Supply |
| Centaur (L1) | Handyman, Piercing Spear, Boost Health |
| Elf (L2) | Double Shot |
| Medusa (L2) | Endless Quiver, Petrifying Gaze |
| Beholder (L2) | Spit Ball (Curse, Sadness, Quagmire, Weakening Beam, Weakness, Rangebane, Cowardice) |
| Cyclops (L3) | Large Caliber |
| Tsar Cannon (L4) | Mechanism, No Melee, Through Shot |
| Gargantuan (L4) | Earth Element, Double Throw, Area Throw (and `area_throw_attack`) |

Wave-1 spells (`spells.zig`), exact in both modes:

| Creature | Abilities | Spells (charges) |
| --- | --- | --- |
| Healer (L2, MAGIC) | Book of Healing | Heal x4, Blessing x2 (Spiritual Armor and Mass Heal are wave 2: filter them with `RECORD_SPELLS`) |
| Battle Mage (L2, MELEE_MAGIC) | Basic Tome of Battle Magic | Fire Strike x3, Meteorite x1 |
| Satyr (L2, MAGIC) | Forest Spellbook, Sylvan Focus Blessing | Summon Wolves x2 (Courage and Helping Hand are wave 2) |
| Magic Dragon (L4, MELEE_MAGIC) | Tome of Elements, Magic Reflection | Lightning Strike x4, Ring of Fire x2, Meteor Shower x1 (Whirlpool is wave 2) |
| Trent (L2) | Vine Throw (castable) | Vine Throw x1 |
| Wolf (summoned) | its creature's cards when "Wolf" is kept (Double Punch, Deep Wounds Level 1; batch 4), else stripped | none |

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

Added by batch 3:

- **Unit slots and identities** (`state.zig`): `State.units` are slots. A unit's identity is `Unit.uid` (u8, never
  reused: start units take their start-state index, each summon the next one, `State.next_uid`); recordings and bridge
  handles name units by uid (`Game.ids` = the start ids, then the recording's `summonIds` in creation order), the
  engine works on slots (`engine.actionToSlots` / `actionToUids`, `State.slotOf(uid)`). The UnitsHolder's insertion
  order is explicit: `State.holder` / `n_holder`, read through `State.holderOrder()`; every order-sensitive loop
  (refresh, auras, census, turn-order inputs, AI target lists, morale decreases, the digest) walks it, and a summon
  is appended last. Without summons slot i is start unit i, so `s.units[0..s.n_units]` filtered by `in_holder` is
  still the holder in order. Engine events carry uids; `engine.apply` maps them to `State.active`.
- **Slot reuse** (`engine.allocSlot`): TypeScript keeps a removed unit's id in alreadyMadeTurn / alreadyHourglass /
  alreadyRepliedAttack until the lap flips (the digest lists them, getAlreadyMadeTurnSize counts them). A removed
  unit keeps its slot and its set bits until a summon needs a slot; then (a free slot first, else the lowest removed
  slot) its memberships move to `Fight.removed_made` / `removed_hourglass` / `removed_replied` (`st.UidSet`, by uid;
  cleared at the lap flip; `Fight.madeCount()` is the set size) and the slot is reset. The active unit's slot is
  never taken (its completeTurn still marks it). On reuse the AI target memory keyed by or pointing at the slot is
  cleared (TypeScript's memory names the dead id, which matches no living enemy again). Battles reached 181 summons
  and 72 removed ids in one lap's sets (production-like, default keep rate); the live holder never exceeded the start
  count. A capacity overflow (slots, uids, list lengths) sets `State.overflow`, which `compare.state` reports.
- **Unit ids** (`uuid.zig`): `Unit.uuid` holds a canonical lowercase UUID id as 16 bytes (`uuid_ok`); a summon's id is
  `deterministicSimulationId("summon", seed, team, 3, name, summonerId, "Infest", sequence)` (`hashSimulationParts`'
  FNV-1a over `len:part|`, the murmur finalizer, version 5 and variant nibbles), with the battle seed
  (`init.rosterSeed`, or the export's `harness.seed`) and runMatch's createSummonedUnit counter (`State.summon_seq`,
  counting failed placements too). Chakram breaks bearing ties by id order, which is byte order of the UUIDs.
- **Summons** (`engine.spawnInfested`, from `combat.cleanupDeadUnits`): the target of a melee strike killed by the
  attacker, or the attacker killed by the target (createDirectKillAttributions; obstacle strikes, narrowing,
  Armageddon and poison never infest), raises a Spider (level 1-3 corpse) or a Queen
  (level 4) of one creature when the killer has Infest at cleanup (a dead killer too, a Broken one not): on the corpse
  cells when they form its footprint, else on the corpse's anchor; corpses in `died` order. The newcomer comes from the
  recorded template (`init.summonTemplates`, `State.summons`, interned per template text by `engine.loadSummons`), gets
  no augments, Life supply or events, takes synergies, blessings and aura rows at its first refresh (the step's
  completeTurn, where its lap luck roll is the last draw), acts in the lap it appears and joins a covenant team's ring.
- **Ability lists that change at runtime** (`abilities.assimilate`): `Unit.abilities` is the ACTIVE list in order
  (config order, then steals), `Unit.stolen` props.stolen_abilities, `ability_mask` and `auras` follow every grant
  and loss, `Ability.aura` names the aura an ability emits (removeAbilityMechanics keeps it while another ability
  provides it), and `luck_dependent` follows the card list (a thief of Sharpened Weapons or Arcane Ward joins the early
  luck pass, the robbed unit stays in it). The steal: candidates are the target's active abilities (none while it is
  Broken) minus Predatory Assimilation and what the thief has; the chance roll only with a candidate, the index roll
  only with two or more; response steal before attack steal, after the morale settlement and before the second
  refresh. A stolen ability is a copy of the configured record, read with the holder's own stats and team, and every
  existing hook is holder-generic: Lightning Spin, Double Punch, Skewer Strike from a 2x2 (pierceSweepCells' closest
  body cell, `combat.closestBodyCell`), Backstab from a 2x2, the batch-2 riders and the stat hooks.
- **Riders**: Miner (initial base armor moves, toFixed(2), floored at 1, with a "Miner" debuff of the running total)
  and Stun (`clamp(luck + syn + 7 * stack power)`, laps 2 on the active unit, drawn on an already stunned target)
  lead the blow, response, second punch, spin and skewer riders; Predatory Assimilation's poison follows Venom
  Cloud's on the blow and the response (not the second punch). Aggr is rolled, then resisted by Madness.
- **Stun at activation and on replies** (`engine.activateNextUnit`): a stunned unit's activation is
  `next_unit_selected, unit_skipped, turn_completed` (completeTurn as a skip: morale -1, the lap ticks the Stun away);
  a stunned unit gives no melee response or counter-shot (nothing spent) and no second punch.
- **Web lock** (`Unit.web_locked`, `canMove`): refreshPreTurnState snapshots `canFly && "Web Aura" debuff` at
  activation; move_unit and a moving melee_attack are refused (an obstacle strike's walk-in is not gated, as in
  TypeScript); the v0.1 AI skips every movement branch (findTarget's two, the mountain strategy, fallbackTurn ->
  idleTurn, decideTurn's moving strike and move). The Web row is the port's first debuff aura (enemy flyers only, power
  0, the emitter's cell as stored property).
- **Morale lock** (Madness): getMorale returns 0 after the clamp (no lap roll is drawn, the first-turn averages count
  0, steps_mod loses its morale term), morale changes are refused, adjustBaseStats pins morale 0 before the
  Morale/Dismorale branch.
- **Stat hooks**: Blind Fury's attack_mod share of the INITIAL base attack; magic resist folds base, Magic Shield,
  Wardguard and the Arcane Ward row in that order (`1 - prod(1 - p)`, toFixed(2); no roll reads it in scope);
  Handyman lifts a RANGE creature's half-strength melee.
- **Census blessings**: Arcane Ward (`toFixed(10 + luck, 2)` of the strongest unbroken source, luck-dependent) after
  Luck Blessing, then Sharpened Weapons, then Rallying Volley last (any unbroken Zena; shooters only), whose applyBuff
  side effect adds 2 arrows once per unit (`Unit.rallying_volley_granted`).
- **Chakram** (`combat.planChakram`, `aoeTail`): the flight is planned from the primary (stack power caps the victims;
  one or two empty bridge cells inside both bodies' box; clockwise sweep, then separation, then id; a two-cell bounce
  halves and ends the flight), its bounce miss rolls stop at the first dodge, and the ranged AOE tail replaces the
  single damage roll before the counter-shot: per victim the damage roll with the primary's divisor, the break roll
  (never extended), Venom Cloud poison and Pegasus Light morale, then kills and riders, the thrower's morale at once and
  one arrow (a missed throw too); the primary is poisoned a second time from the throw's largest damage. A responding
  Zena counter-throws the same way. The sweep is compared exactly on the integer vectors (quadrant class and cross
  product), which reproduces Math.atan2's order and its parallel ties.
- **Absolving Arrow** (`combat.absolvingArrow`): before the shot's miss roll, and before the counter-shot's damage
  roll for a responding Monk, every live ally on the whole traced ray (past enemies, stones and lava) is rolled per
  liftable entry (effects, then non-aura, non-marker debuffs; `first / 2^i`), deleting a lifted name from both lists.
- **Lists**: buffs 14, debuffs 5, effects 7, abilities 10, stolen 6, auras 4 per unit, aura defs 6 per battle (wave 1:
  buffs 16, debuffs 6).

Added by batch 4 (references in the session's `scratchpad/ref/batch4/`):

- **The mindless pin** (`AbilityId.ai_driven`, no engine reader): `Unit.has(.ai_driven)` (Break-aware, stealable) is
  isMindlessAiUnit. v0.1 differs for such a unit in two branches: findTarget's `OBSTACLE_ATTACK` becomes `fallbackTurn`
  (its draws and memory writes stand), and `idleTurn` is `wait_turn` when `engine.canWaitOnHourglass` passes (the
  engine's own gate, now shared with `waitTurn`), else `defend_turn`, instead of `end_turn`. `ai.continueMatchWith` runs
  runMatch's mindless retry (decide again, apply what lands while still active, then end the turn) when a mindless
  turn landed nothing; never reached. In rollouts `rollout.isMindless` pins the unit to v0.1 whatever its seat.
- **Deep Wounds** (`abilities.deepWounds`, `activeDeepWounds`, `holdsDeepWounds`; `st.AbilityId.DEEP_WOUNDS` in level
  order): the rider sums the holder's active cards (`(power / 5) * stack power` per card, then luck and the team's
  ability power once, floored at 0, toFixed(1)) into the victim's "Deep Wounds" row (toFixed(1), delete + append, laps 3,
  4 on the active unit). The damage chain multiplies by `1 + p / 100` before Lucky Strike (`combat.attackDamage`) when the
  striker holds a card; Lightning Spin folds the factor into its ability multiplier too (squared). Never consumed; it
  ticks, and Absolving Arrow lifts it. No draw.
- **Boar Saliva** (`abilities.boarSaliva`): an un-Saliva'd victim gets the effect (`toFixed(((30 + luck + syn) / 100 / 5)
  * stack power * 100, 2)`, laps 3 or 4, Madness resists after the power is set); `abilities.missChance` reads the
  striker's own Saliva first, then the enemy's Dodge and Small Specie. No draw (the save needs an artifact).
- **Terrifying Gaze** (`abilities.terrifyingGaze`, `Unit.forbidden`, `State.forbids`): the roll `getRandomInt(0, 100) <
  applyChance` on the gazer's landed blow and second punch (the last draw of the blow, drawn on a frightened or Madness
  target and when the response just killed the gazer); a frightened target is re-pointed, Madness resists, else the
  effect (laps 1) and `forbidden` = the gazer's uid (an id, never a slot: TypeScript keeps it after the gazer dies). The
  lock bars the melee strike, the shot's first hit, the melee response, the counter-shot and the Lightning Spin ring;
  adjustBaseStats resets it once no Terrifying Gaze status is applied. v0.1 reads it in `isLegalMeleeTarget`,
  `rangeShotLandable` and `findLegalRangeAttack`, not in `canSelectMeleeTarget` (findTarget keeps the gazer).
- **Riders**, in handleMeleeAttack's order: Miner, Stun, Dulling Defense, Boar Saliva, Aggr, Terrifying Gaze (blow and
  second punch only), Deep Wounds, Pegasus Light, Shatter Armor; the response, the spin and the skewer take Boar Saliva
  before Aggr and Deep Wounds after it.
- **Range Null Field** (`PowerType.DISABLE_RANGE_ATTACK`, a zero-power debuff aura on enemy RANGE creatures):
  `engine.canLandRangeAttack` (and `nullFielded`) refuses a fielded shooter, so it has no RANGE type at activation, its
  shot is refused and its counter-shot (miss, damage and break rolls) never happens; v0.1's `findRangeAttackAction`
  returns nothing for it (no memory write).
- **Disguise** (`PowerType.UNTARGETABLE`, a zero-power buff aura on its own holders; `State.disguise`): after the stat
  pass, a unit carrying the "Disguise Aura" row gets Hidden (no enemy board occupant within the configured range plus the
  team's aura range of its body) or Visible, the other deleted, a carried marker kept in place (`engine.disguisePass`:
  the swap reads only that unit, so it runs after the whole pass). Hidden refuses a melee strike, a single-group shot
  (a ray holding two enemies still lands on the Hidden front unit) and an enemy cast; responses, spins, skewers, the
  chakram, area spells and poison still hit. v0.1 filters Hidden enemies in `canSelectMeleeTarget`, the range scan,
  `findLegalRangeAttack` and `rangeShotLandable`. Hidden, Visible and Warding Mane are marker names.
- **Stat hooks**: Unyielding Power (`engine.unyieldingPower`: max hp `initial + 5 * lap`, and at a lap's first refresh
  after the start +5 hp, +1 initial step, +2 initial base attack; Break loses that lap's gains), Sky Runner (the
  ADDITIONAL_STEPS count after the steps copy, before the Movement augment), Warding Mane in the magic-resist fold
  between Wardguard and Arcane Ward (toFixed(2) makes the order load-bearing), Battle Roar's power in `steps_mod` and its
  maximum damage rolls (as Blessing). `State.unit_hooks`, `gaze`, `null_field` and `disguise` keep the ability-free path
  free of them.
- **Warding Mane Blessing**: one more census source (`toFixed((25 / 5) * stack power * max(0, 1 + luck / 100), 2)`,
  luck-dependent card), re-granted after Arcane Ward.
- **Wild Regeneration**: at every activation, before the poison tick, a hurt holder's top creature refills (Break-aware).
  The gift (`spells.canCastSpell`'s giftable HEAL branch, `magicAttack`'s gift: `abilities.deleteAbility` on the
  caster, `abilities.addAbility` on an ally of at most `SpellConfig.max_gift_level` that does not hold it active nor lost
  the card to a steal; otherwise the gift leaves the battle). The castable card's ":Wild Regeneration" charge moves with
  steals and with the gift.
- **Battle Roar** (`spells.massCastSpell`, `canMassCastSpell`): castSpell's ALL_ALLIES non-HEAL mass cast. Every ally in
  holder order (the caster included) with magic resist other than 100 and no Battle Roar row gets the buff (power = the
  caster's creatures alive for `SpellMultiplier.UNIT_AMOUNT`, laps + 1 on the caster); then the charge and completeTurn.
  Borrowed Grace copies it. The other mass casts stay wave 2 (overflow).
- **State**: `Unit.forbidden`; buffs 20, debuffs 8, effects 10 per unit (worst cases 19, 7 and 9). A state is 60,784
  bytes (Unit 1,776).
- **Spells API for src/v08**: `spells.usable`, `canCastSpell`, `trajectory`, `lineOfSightClear`, `moraleScaled`,
  `moraleMultiplier`, `rawDamage`, `damageAgainst`, `resolveVictims`, `cellsAroundFootprint`, `seatFree`,
  `canMassCastSpell` and the types in their signatures (`CS`, `Trajectory`, `Victim`, `Victims`, `Cells`) are public with
  stable signatures: the v0.8 port calls them.

Added by batch 5 (the shooters and throwers; references in the session's `scratchpad/ref/batch5/`):

- **Ids and masks**: fourteen `AbilityId`s (Sniper, Limited Supply, Double Shot, Endless Quiver, Petrifying Gaze, Spit
  Ball, Large Caliber, Mechanism, No Melee, Through Shot, Double Throw, Area Throw, Piercing Spear, Boost Health;
  `AbilityId.BATCH5_MASK`), so `AbilityMask` is a `u128`; Spit Ball's seven debuffs as `SpellId`s
  (`SpellId.SPIT_BALL`, `isSpitBall`) with their configs in `State.spit_cfg` (`init.spellConfigs` / the export's
  `configs.spellConfigs`: laps, power, MIND).
- **Ray groups** (`combat.Groups`, `evaluateGroups`): getAffectedUnitsAndObstacles as the engine resolves it. A Through
  Shot's ray runs on to the field edge (`projectLineToFieldEdge`, Math.min/max with their signed zeros), a splash ray
  (an active Large Caliber or Area Throw, `isSplashShooter`) passes stones, and each enemy group of a splash shooter is
  the enemy plus every living unit of either team on the ring around the cell the ray entered it (getCellsAroundCell
  order, each body once), with the ring and entry cells as the blast whose stones fall after an accepted shot. The AI
  and the v0.8 port read the primaries only (`evaluateRangeFlags`; `evaluateRange` is its plain case). Aim edges take
  both flags (`sideObservableEx`: a splash shooter may aim at a side facing a stone, a Through Shot at any side not
  facing one; `aimEdge` reads them off the shooter).
- **The ranged action** (`combat.shoot` = GameActionEngine.rangeAttack, `resolveShot` = resolveRangeAttack): the free
  aim (Through Shot only; a line that meets no enemy takes a ranged obstacle shot at the stone it met, else one arrow
  into nothing), the Rangebane refusal, the Double Shot stone rule (scattered boards, not for a splash shooter: the
  first two stones on the segment take the projectiles; two stones end the action with one arrow, one stone suppresses
  the second shot), the counter-shot pre-check with the primary's own flags and blast, then resolveShot in TypeScript's
  order: the Hidden and forced-target gates (an AOE throw only has to catch the provoker), Through Shot (`throughShot`,
  before Absolving Arrow: no single miss roll and no counter-shot either way; a second piercing volley for a Double Shot
  holder), the Cowardice gate, the miss roll, the response gate (`canRespond(RANGE)`: no Through Shot; Cowardice against
  the victim), the AOE tail or the single roll, the counter-shot (a splash responder throws a whole tail over its return
  group), the primary's riders (Deep Wounds, Stun, Petrifying Gaze, Spit Ball, the poisons, Borrowed Grace; after a
  landed splash only the poisons), the counter-shot's riders and the death check after them, the switch over whole
  groups, the second shot (`doubleShot`: Double Shot's single shot, or Double Throw's second tail at Area Throw's
  multiplier) and finalizeRangeAttack (`Fin`: Predatory Assimilation's response steal, then the attacker's; also before
  every early return). Kill attributions (`Attribution`: the primary by the shooter, the counter-shot's victim by the
  primary, an area throw's enemies by the thrower) feed Infest at cleanup.
- **The AOE tail** (`aoeTail`, `Flight`): Area Throw, else Large Caliber, else Chakram; per victim (dead ones listed and
  skipped) a miss verdict rolled at its turn (`Pre.roll`) or pre-rolled (Chakram's flight, `chakramFlight`), the damage
  roll at the ability's multiplier (Large Caliber stack-powered), the bounce factor, the physical-AOE multiplier, the
  hit, poison, Pegasus Light and Petrifying Gaze; then kills (+4 each, allies too) and riders (Deep Wounds, Stun, Spit
  Ball, Borrowed Grace), the thrower's morale and one arrow.
- **`area_throw_attack`** (`combat.areaThrowAttack`, `areaStrikeAtCell`): the gates, the blast moved to the first enemy
  the splash ray meets (projectAreaThrowTargetCell), the 3x3 list (ring order, the centre last; either team, the
  thrower too), resolveShot as an AOE (no counter-shot, no primary block, no switch; Double Throw at the list's first
  living unit), the stones in the 3x3, one arrow for a throw that caught no unit but broke a stone. A splash shooter's
  ranged `obstacle_attack` on a stone is the same strike; a Double Shot holder's ranged obstacle shot breaks two
  stones.
- **Shot accounting**: `spendShotsAgainst` (an active Endless Quiver spends nothing) in the damage roll and the AOE
  tail; the direct decrements (Through Shot, the free aim, the two-stone rule, a stones-only throw, obstacle shots) stay
  unconditional. Limited Supply and Endless Quiver are `engine.shotHooks` (the SHOTS block: the cap off the hidden
  `Unit.max_range_shots`, the 99 mod and its clearing), and a melee thief of the quiver shoots from 6.5; Rallying Volley
  also reaches a holder of the quiver.
- **Sniper**: `rangeDivisor` returns 1, the AI skips the bands and the range, and `finishDirectedMove` rewrites the
  shot distance from the position the unit leaves (only a `move_unit` step shows it before the next refresh).
- **Boost Health** (`engine.hpHooks`, shared with Unyielding Power): refreshAndGetAdjustedMaxHp's boost with its free
  heal (a top creature at exactly the reset maximum is refilled), then the seam for max-hp artifacts, Unyielding
  Power's +5 and the refill. **Piercing Spear** scales the target's armor in `combat.damageBoundSyn` (unfloored), with
  an explicit synergy argument for AI estimates; `damageBound` passes the attacker's own.
- **Mechanism**: `engine.moraleLocked` (Madness or Mechanism: morale 0, no lap roll, no morale change), MIND
  resistance (`abilities.mindResistant`: Aggr, Boar Saliva, both Gazes, Spit Ball's MIND debuffs, MIND spells), no
  poison, no heal (Heal's target gate, Devour Essence), x1.5 from the physical AOE paths (`physicalAoeMultiplier`:
  Lightning Spin, Skewer Strike, Through Shot, the AOE tail) and on STATUS cards (Stun's chance, Shatter Armor's
  amount). **No Melee**: no MELEE type (an empty list is `[NO_ATTACK]`), no melee strike or response.
- **Petrifying Gaze** (`abilities.petrifyingGaze`): the coefficient and petrify rolls after every landed live hit (blow,
  response, second punch, spin, skewer, shot, counter-shot, second shot, tail, Through Shot), with the shot's divisor.
- **Spit Ball** (`abilities.spitBall(from, target, active)`): the Absorb Penalties redirect (now applied), then per
  candidate debuff the chance roll, the magic-resist save and the mirror roll (Magic Reflection's chance); the stat
  hooks (Curse pins the maximum to the minimum, Sadness morale -20 and no morale change, Quagmire's steps multiplier,
  Weakening Beam's base-armor multiplier before Heavy Armor, Weakness on attack_mod) behind `State.spit`; Rangebane in
  `canLandRangeAttack`; Cowardice (`engine.cowardBarred`, cumulative hp) in the melee strike, the melee response, the
  shot, the counter-shot, the switch and Lightning Spin. A mirror can duplicate a debuff on the shooter: every live
  object row of a name then ticks every display entry of it (`AppliedSpell.lag`, `engine.minusLapDuplicates`), the
  digest prints the display laps.
- **v0.1 AI**: `findRangeAttackAction` with the splash (`aoeSplashValue`), Through Shot (`enemiesBeyondInLine`), Sniper
  and Double Shot branches and the Rangebane bail; No Melee in findTarget (the pick is still drawn), doFindTarget,
  decideTurn and completeMoveWithAdjacentMelee; Cowardice in canSelectMeleeTarget (so findTarget's random pick) and
  isLegalMeleeTargetAtHp; `rangeShotLandable` with both ray flags and the Cowardice test.
- **State**: debuffs hold 20 (`AppliedSpell.lag` sits in the row's padding: still 24 bytes), `Unit.max_range_shots`. A
  state is 70,688 bytes (Unit 2,080; 60,784 and 1,776 before).

### Spells (wave 1)

The framework the spells added (all exact in both modes, coverage below; references in the session's
`scratchpad/ref/spells/`):

- **The spellbook** (`state.zig`): `Unit.book` holds the raw entries (`unitProperties.spells`, one per remaining
  charge, `st.BookEntry`: the spell and its faction prefix, `":"` for a castable ability) and `Unit.spells` the parsed
  book (`Unit.getSpells()`: one `st.BookSpell` per distinct normalized entry, `"System:X"` = `":X"`, first-occurrence
  order, with its charges). `useSpell` decrements every parsed Spell of the name and splices the LAST raw entry per
  match; a spent Spell stays at 0 (so a cast answers `spell_not_available`, not `spell_not_found`) until a re-parse
  (`engine.parseBook`), which only Predatory Assimilation triggers. `can_cast_spells` is `n_book > 0` (every mutator
  keeps it so). `st.CastSpell` names the nine ported spells; a book entry of any other spell is refused at load by
  name (`engine.parseBookEntry`), so a cast naming one is necessarily `spell_not_found`.
- **Configs** (`State.spell_cfg`, `st.SpellConfig`): every number a cast reads (power, laps, minimal stack power,
  target and power types, multiplier, element, buff and self-cast flags, a conflict in scope) comes from
  `init.spellConfigs` (record.ts, keyed by name) or, in an export, from the Spell objects' spellProperties (and
  `configs.spellConfigs["Vine Throw"]` while vines stand). A cast of a spell without a config sets `State.overflow`.
- **MAGIC** (`engine.refreshPossibleAttackTypes`, `selectAttackType`): a MAGIC creature (Healer, Satyr) with charges and
  not Broken (`getSpellsCount`) leads with MAGIC (`[MAGIC, MELEE]`, selected MAGIC: it must `select_attack_type`
  MELEE to strike, as v0.1's melee prefix does); every other caster gets MAGIC last (`[MELEE_MAGIC, MAGIC]`, Trent
  `[MELEE, MAGIC]`). `castSpell` does not read the selection; Might reads MAGIC as non-RANGE.
- **`cast_spell`** (`spells.castSpell`, `rec.Action.cast_spell`): the turn checks, moved-this-turn, the caster's first
  Spell of that name, `isSpellUsableByCaster` (not Broken, laps > 0, a charge, minimal stack power), the target id
  (`unit_not_found`) and its cell, then the generic unit-target gate (line of sight, `canCastSpell`: HEAL, ANY_ALLY
  with notAlreadyApplied and the Blessing/Curse conflict, ANY_ENEMY with the raw Aggr lock, magic resist 100, the
  element immunity) and the dispatch in action_engine.ts order: Summon Wolves, (mass and area spells: wave 2,
  overflow), Vine Throw, Fire Strike, Meteorite, Lightning Strike, Ring of Fire, Meteor Shower, else
  `handleMagicAttack` (Heal, Blessing; a debuff spell there is wave 2). The Castling hook's eager `getMovePath` draws
  nothing and feeds only Castling, so it is skipped.
- **The damage tail** (`spells.damageTail`): `floor(alive * power * (1 + bonus/100) * morale)` (bonus = Empower
  Augment + Sylvan Focus Blessing, now read; morale 1.25 / 0.8 for the morale-scaled spells), per victim Heavy Armor's
  magic multiplier (no synergy term), the element (AIR on an Earth Element x1.5, EARTH on it 0), the magic resist
  floor; Magic Reflection's rebound row right after its holder (`floor(15 * stack power + luck)`% of what landed,
  through the caster's own Heavy Armor, element and resist; no roll); `engine.applyDamageElement` (no break roll; a
  FIRE hit is blocked by an Ember Covenant ring that stays, any other element's block dissolves the team's rings, WATER
  is never blocked); the damage statistic on non-rebound rows even at 0; the kills' same-name morale losses, then one
  caster increase of 4 per enemy kill; the charge; `combat.cleanupSpellDeaths` (a killed enemy's corpse infests when
  the caster holds Infest); completeTurn.
- **Handlers**: Lightning Strike (any enemy), Fire Strike (the visible-edge gate and `interceptedThrowTrajectory` over
  the caster's body centre with its allies transparent: terrain refuses, a screening enemy takes the fireball), Ring
  of Fire (the creatures-and-terrain walk, then every living unit touching the target's body via
  `getCellsAroundFootprint`, allies too, never caster or target; an empty ring still spends the charge), Meteor
  Shower / Meteorite (the 3x3 centred / 2x2 cornered block, x-major, on the board, enemies only, first-touched order;
  a drop catching no enemy is refused), Heal (`floor(5 * alive * morale)`, capped), Blessing (appended, laps + 1 on a
  self-cast; adjustBaseStats then pins `attack_damage_min = max`, so a Blessed unit's damage roll draws nothing).
- **Vine Throw** (`spells.vineThrow`, `engine.addVine`, `Fight.vines`): the Bresenham lane (`vinePathCells`) blocked
  only by a third creature, rooted on every cell that is not "B" or "H" (Map.set: a re-thrown cell keeps its position,
  takes the new laps and team), then the snare save `getRandomInt(0, 100) < floor(magic resist)` (always drawn), the
  "Vine Throw" debuff (-1.5 base steps, floored at 1, in adjustBaseStats), the charge. Vines lose a lap at the lap flip
  (after flipLap) and go at 0; `engine.snareOnVineArrival` snares a mover ending on an ENEMY vine (move_unit, and a
  move-then-strike whose body changed; laps + 1, no save, never twice); `engine.maxCellsForStepBudget` lifts the cell
  bound for a vine strider. In the pather (`path.zig`): a walker pays +1 on a vined anchor (after the threat multiplier),
  a strider nothing; with vines the strider runs the relaxing second pass (only vined cells and first-pass
  destinations, vined cells free, the neighbour scan ignoring the visited table, a cell re-entered whenever a route
  leaves strictly more steps) and its vined destinations replace or follow the first pass's keys; the routes the merge
  orphans keep their ancestors past `MovePath.n` (`MovePath.overflow` past the capacity). `captureRoute`'s random
  insertion stays unreachable.
- **Summon Wolves** (`spells.summonSpell`): `floor(alive * 1.5)` Wolves merge into the first living summoned Wolf of the
  caster's team in holder order (`Unit.summoned`; no id, no counter, no draw), else a new 2x1 stack at the explicit
  targetCell (or the first free anchor of the caster's ring) through `engine.addSummon` (shared with Infest: both
  counters, the id with ability `"spell"`, `allocSlot`, the holder append, a covenant team's ring); its first refresh
  rolls its lap luck last. The Wolf template is `init.summonTemplates.Wolf` (`st.Summons.WOLF`).
- **Stack blessing and steals**: Sylvan Focus Blessing joins the census (after Luck Blessing, before Arcane Ward; a
  marker for Borrowed Grace and Absolving Arrow). Predatory Assimilation now moves a card's charges
  (`takeAbilitySpellEntries`: a spellbook's faction entries of its spells, a castable ability's `":X"`), re-parses the
  victim's book when charges left and, for a castable ability, again in removeAbilityMechanics, and appends the charges
  to the thief (which re-parses for a castable card). Borrowed Grace is live: a landed shot or counter-shot copies a
  takeable buff (the cast Blessing) with its chance and pick rolls.
- **Rollout decisions** (`ai.catalog_decisions`, `Ctx.elide_melee_layers`): SearchDriver gives every rollout turn a
  DecisionPathCatalog, under which findTarget's infinite-path pass builds only the first melee layer
  (`canElideUnconsumedMeleeLayers`); runMatch without search gives none. The two differ only when a first-layer route
  weighs 0 (a strider's free vine road), so `rollout.run` sets the flag and play-outs and native play do not.
- **Recording**: `RECORD_AMOUNTS=expBudget`, `RECORD_SPELLS`, the spellbook columns and `vines` (below).

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

### Artifacts

`src/artifacts.zig`, exact in both modes (`RECORD_ARTIFACTS`; `pool:<t1 ids>/<t2 ids>` draws each team's pair from the
given lists). runMatch's `applyArtifacts` puts one buff row per artifact on every beneficiary at setup (dual artifacts
also a power-0 marker debuff of the same name) and never again, so the recorded start state carries the rows and the
port only reads them; the live server re-applies on summons, which the port does not model. Each row is a `SpellId` in
one contiguous block (`isArtifact`), its power, laps 15, and the stored properties "first;second" in `src_x / src_y`
(loaded, digested and compared like the augments' rows; Keen Blade's 0.7 is only read as the power). Every artifact
row is a marker for Borrowed Grace and Absolving Arrow (`isMarkerSpell`). A battle without artifacts takes one branch
per hook (`State.artifacts`).

| Artifacts | What the port does |
| --- | --- |
| Veteran Helm, Keen Blade, Iron Plate, Swift Boots, Winged Boots, Cursed Ward, Hunter's Longbow, Warlord's Edge, Titan Plate, Clover of Fortune, Crown of Command, Pendant of Vitality, Berserker's Bond, Aegis of the Arcane | the `adjustBaseStats` terms at their TypeScript points (HP, luck, morale, armor flats and shares, the magic-resist fold, steps, attack); Warlord's Edge keeps `we_base / we_bonus` (exported) and re-prices the damage band when the strike type differs from the refresh's selection (`combat.damageBound`) |
| Amulet of Resolve | the status and mind resist (Stun, Aggr, Terrifying Gaze, and a Boar Saliva save drawn before the already-salivated check) and the physical-AOE multiplier of spin, skewer and the AOE tail |
| Giant's Maul | the striker's +40 % on every physical-AOE sub-hit, before the victim's status resist |
| Dual Strike Charm | the second punch's multiplier (the marker sits on Double Punch holders at setup) |
| Farsight Quiver | no range falloff (the engine's divisor and v0.1's target scan) |
| Mage's Ring, Archmage's Ring | the caster's magic damage bonus (additive with Empower and Sylvan Focus) |
| Tome of Amplification | a non-heal cast buff's power `Number((p * 1.35).toFixed(4))` on each ally (Battle Roar in scope) |
| Wounding Charm | the lent "Deep Wounds Level 1" card (batch 4's Deep Wounds) and the ranged Deep Wounds riders it makes live |
| Last Fuse | the killing hit's record (`Unit.fuse`: combat.hit, spell kills) and the corpse's blast in the death cleanup, before the Infest spawn, then the depth-first chain |
| Rime Charm | the striker's landed-hit rider (`getRandomInt(0, 100)` against `clamp(power + luck)`, a full-resist target skipped, an existing Quagmire kept after the draw): Spit Ball's Quagmire (laps from the second stored property, + 1 on the active unit) at every melee, shot, counter-shot, second-shot, Through Shot and splash site; its holder turns the Spit Ball hooks on |
| Gravechain | the army's -1 step, and the landed-hit rider: the chance once per call, the links (the target and its living teammates touching it, three hops, getCells order, each cell's ring), one attempted set per exchange (melee spin, skewer and blow share one; a splash or Through Shot volley one), Gravebound (steps x 0.75 after Quagmire, a flyer grounded in `canFly`) |
| Quiver of Echoes | the chance (a native shooter's row: `clamp(power + luck)`, read before the shot); after a completed shot by a living, unstunned shooter with arrows left, one `getRandomInt(0, 100)` when a target group survives, and under the chance one more ordinary volley (`resolveShot` on the surviving groups, their original divisors, no counter-shot, no Double Shot, one arrow; group 0 as a Chakram grew it, `Outcome.head`), its deaths after the shot's; on `range_attack` and `areaStrikeAtCell`; the obstacle shot's extra hit on the next standing stone (classic: the aimed mountain while its side has hits) |
| Barrel Barricade | two barrels per owning team at start_fight (LEFT first, before the fight starts): its Placement augment's zone sorted by (on a friendly shooter's file in front of it, screen rank, inward edge, x, y), the pair rule; each a standing scattered stone appended to the layout on any map, so the stone gates (`hasScatteredMountains`, `centerCells`, `groundRouteCrossesObstacle`, the loader's standing cells) open on NORMAL and LAVA_CENTER too; per-team records deleted with the stone |
| Lava Striders | walking and standing on the undried lava square (`canTraverseLava`: the pather's `made_of_fire`, occupancy, the restore of a vacated centre cell, v0.1's landing check) and Made of Fire after a lava route (laps 3) with its immediate boost, the `+init/power` refresh terms and the ability-formula terms |

Lessons (for the three left and for the server path):

- A death on lava leaves `""` in boardCoord (cleanupAll restores nothing), but `getOccupantNumeric` takes the centre
  obstacle from the map, so the matrix (and the AI) still reads lava there: `path.buildMatrix` does the same.
- A summon can be created and destroyed in one step (an Infest spawn a Last Fuse chain kills): the recorder takes
  summon ids as the holder receives them, not only from the after-step scan.
- Rime Charm's "Quagmire" is Spit Ball's debuff (batch 5); Gravechain's "Gravebound" grounds flyers (`canFly`) and joins
  the steps multiplier after Quagmire; both are riders with draws at every melee, ranged, sub-hit and tail site, in the
  references' orders (Rime and Gravechain before Aggr on a second punch, after it on the first blow).
- `rollout.v08Scope` refuses a v0.8 seat on a board with any artifact row until src/v08 is checked on artifacts (lv8's
  explicit-rate damage bound needs `artifacts.warlordsEdgeRate`).

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
    miss chance, Quiver of Echoes adds a roll to every completed shot and to the ranged obstacle shot (both ported,
    `combat.echo` and `combat.obstacleEcho`), Barrel Barricade places barrels inside `start_fight` (after the supply, before `fightProperties.startFight`),
    and Cursed Ward / Crown of Command move luck and morale in `adjustBaseStats`.
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
- Batch 3 lessons (for the spellcasters and artifacts next):
  - Slots are not identities. Name units by `uid` across steps (recordings, events, observers, memory, handles),
    iterate the holder through `holderOrder()`, and never keep a slot index past a cleanup: a corpse's slot can hold a
    summon before the step ends (cleanupDeadUnits captures the killers first). Spell summons (`createSummonedUnit` from
    castSpell) and a resurrection will reuse `engine.spawnInfested`'s pieces: the id hash with its own source ability
    ("spell" by default), a template per summoned creature, `allocSlot`, the holder append. Resurrection
    (`deleteUnitById(id, true)`) is not ported: the corpse leaves today.
  - TypeScript's lists are unbounded: size every list for the worst case in scope and let the overflow flag report the
    rest. Steals pile abilities on Queens (8 active seen); a lap of summons named 72 removed ids.
  - Card names are not active abilities: the export's `props.abilities` is the card list (stolen cards stay), the
    Ability objects are the active list; the early luck pass, descriptions and inert spell checks read cards, every
    mechanic reads the active list. Spells will add castable abilities whose charges move with a steal
    (`takeAbilitySpellEntries`): Vine Throw's charge moves today, unread, because nothing casts.
  - Magic resist is exact but unread: the resist rolls arrive with spells (`handleMagicAttack`, the mass debuffs, the
    Vine Throw snare) and artifacts (Aegis of the Arcane adds a term after Arcane Ward). Stun's chance already has the
    status-resist factor (Amulet of Resolve) and Aggr the mind-resist factor, both 1 today.
  - Borrowed Grace and Absolving Arrow skip "marker" names (`abilities.isMarkerSpell`): every artifact buffName joins
    that list, and Borrowed Grace becomes reachable once a cast buff or an artifact buff can be copied (its chance
    roll, pick roll and `takeBuffFrom`'s extra lap are in `ref/batch3/monk.md`).
  - The ranged AOE tail (`aoeTail`) is the place for Area Throw and Large Caliber, and Giant's Maul / Broken Aegis /
    Flesh Shield order victims and scale damage there; a missed AOE shot spends its arrow.
  - Summon templates and harness fields are recorded data, not recomputed: a new summoned creature needs its template
    in `init.summonTemplates` / `configs.summonTemplates` and the id parts in the harness.

- Batch-4 lessons (for batch 5, the shooters: Arbalester, Elf, Medusa, Beholder, Cyclops, Tsar Cannon, Gargantuan,
  Centaur):
  - The shooters already shoot in scope with their cards stripped; porting a card means the ranged riders. Deep Wounds,
    Boar Saliva and the gaze have no ranged call site today because no shooter holds a card: the Wounding Charm or a
    shooter card that applies an effect makes `attack_handler.ts:1966/2086/2336` live (`combat.rangeAttack` has the
    Stun / Absorb Penalties / Borrowed Grace rider block to extend), and the chain's ranged `priorHits` term stays a
    preview-only input (0 in the engine).
  - A shooting gazer would make the counter-shot's forbidden gate live (ported: `!s.forbids(tgt, att.uid)`); a frightened
    shooter's shot at its gazer as the first hit is refused (ported).
  - Every new receiver filter of an aura goes in `refreshAuras` beside DISABLE_FLY_MOVEMENT / DISABLE_RANGE_ATTACK /
    UNTARGETABLE, and every zero-power aura type needs the loader's `internAura` acceptance; a new debuff aura row needs
    the batch-3 columns (its source cell is only in `debuffs_sources`).
  - Range Null Field already gates every shot through `engine.canLandRangeAttack`; Rangebane (Dryad's Spit Ball) shares
    the gates (`hasStatusApplied`): add it beside `nullFielded`.
  - Hidden's single-group rule reads the ray's group count (`Hits.len`): Through Shot and the AOE shooters (Large
    Caliber, Area Throw) change the group shapes, and v0.1's range scan skips Hidden cells for every attack kind.
  - Tsar Cannon's No Melee and Gargantuan's / Cyclops's splashes touch stones (`areaStrikeAtCell`, `spendObstacleHit`);
    check `combat.obstacleAttackAt` and the AOE tail (`aoeTail`) for both.
  - Mind effects: every MIND card goes through `Ability.ty == st.AbilityKind.MIND` and Madness (`to.has(.madness)`)
    after the power is set; the mind-resist save (Amulet of Resolve) is the artifact batch's.
  - Perf: Zig's auto layout reshuffles `Unit` when it grows; keep new per-unit reads behind a `State` flag (`gaze`,
    `unit_hooks`, `null_field`, `disguise`) and rare work in `noinline` helpers. The first draft of batch 4 cost 2.8% of
    the engine replay with fewer retired instructions; gating and moving the hooks out of the loop recovered most of it.
- Notes for the v0.8 owner (batch 4 in src/v08):
  - `rollout.v08Scope` refused batch-4 cards and state until src/v08 ported them (`28e857dc`, `2346a159`); the refusal
    is gone. AI Driven holders are dispatched to v0.1 (`rollout.isMindless`), and v0.8 rollouts with Berserkers are
    identical to TypeScript.
  - v0.4's `trollWildRegen` tests `hasBuffActive("Wild Regeneration")` on allies (a name that is never a buff), so its
    "already gifted" check never fires; the a19 gift filter (`a19-wild-regen-gift-v1`) gives only to allies whose
    creatures have more max hp than the caster's. v0.2's `decideCreatureOpener` casts Battle Roar (lap-1 self-delay
    from v0.4); a Behemoth below stack power 3 cannot.
  - v0.8 reads Hidden in many places (`candidates.ts`, `v0_2.ts`, `v0_5.ts`, `v0_8_ranged_positioning.ts`, ...), the
    Range Null Field in `pinnedRetreat`, the gaze in `repairV07/V08ForbiddenTargetDecision`, Deep Wounds through the
    damage projection (`deepWoundsMultiplier`, ranged `priorHits`) and Boar Saliva through `calculateMissChance`
    (`abilities.missChance` has it).
  - In v0.8s recordings mindless decisions are decide steps marked `v: "v0.1"` (`rec.Step.mindless`): a v0.8 layer
    checker skips them or dispatches them to `ai.decideTurn`.
- Wave-1 lessons (for wave 2 and the artifacts):
  - A spell's two views must move together: the raw entries (the digest and `useSpell`'s last-entry splice) and the
    parsed book (a spent Spell lingers at 0 until a re-parse). Mass Heal, Courage, Spiritual Armor, Helping Hand,
    Fireball, Smoke, Craft and Wind Flow add only handlers and state on this machinery; their names join
    `st.CastSpell` (a book holding an unported one is refused, so `NO_SPELL` stays `spell_not_found`).
  - Wave 2 adds the rolls wave 1 lacks: `handleMagicAttack`'s magic-resist save for debuff spells and the mirror copy
    (`isMirrored`, drawn for every landed debuff), the Absorb Penalties redirect, MIND resistance (Madness), and the
    mass casts' own gates (`canMassCastSpell`, `hasAlreadyAppliedSpell` per ally). Smoke and Fire Wall bring their own
    stores and pather terms (the pather's `terrainAdjustedCost` already has the vine term, the Fire Wall toll sweeps
    the body); Resurrection needs `deleteUnitById(id, true)` (a corpse kept) and Wind Flow / Castling the Castling
    hook this port skips (`getEnemiesCellsWithinMovementRange`, the ENEMY_WITHIN_MOVEMENT_RANGE target type).
  - New cast buffs are takeable by Borrowed Grace unless they are markers (`abilities.isMarkerSpell`): every Courage,
    Spiritual Armor or Helping Hand row is a copy candidate with its chance and pick rolls, and Absolving Arrow lifts
    the new debuffs (the snare included).
  - Configs travel with the data: a new spell needs its `spellConfigs` entry (record.ts adds every book spell) and,
    for a summon, its template; the loader never reads spells.json.
  - The TypeScript rollouts decide under a DecisionPathCatalog (cached canonical path, first-layer elision), runMatch
    without search does not: anything that makes a route weigh 0 or makes two callers share a path object differs
    between the two, so check a new pather term with both `hoc-sim native` and the rollout oracle.
  - Artifacts: Tome of Amplification raises a cast buff's power (amplifyCastBuffForTarget), Holy Cross multiplies Heal
    by 1.5, Mage's Ring / Archmage's Ring add to the magic-damage bonus, Aegis of the Arcane adds a magic-resist term,
    and their buff names become markers.

- Batch-5 lessons (for batch 6: Dryad, Valkyrie, Angel, Champion, Wolf Rider, Unicorn, Mantis, Harpy, Mermaid, Efreet,
  Black Dragon, Abomination, Thunderbird; and the artifacts):
  - Every ranged hit is resolved by `combat.resolveShot` (the single shot and the counter-shot, the AOE tail, Through
    Shot's pierced units, the second shot), so a new ranged rider has five sites: the primary block, the counter-shot
    block, `doubleShot`, `throughShot` and the impact and rider loops of `aoeTail`. Each site rolls its riders in
    TypeScript's order, the ranged Deep Wounds right before Stun. A rider landing a negative status goes through
    `abilities.absorptionTarget` first (the Absorb Penalties redirect) and, for a MIND card, `abilities.mindResistant`
    (Madness or Mechanism). Hamstring (Dryad), Blindness (Unicorn) and Paralysis (Mantis) are such riders, and Paralysis
    also joins the response gate of `resolveShot` and `canRespondToMelee`.
  - Mechanism's x1.5 reaches every STATUS card (`abilities.abilityMultiplierSyn`): Paralysis and Blindness are STATUS
    cards, and Chain Lightning and Fire Breath are physical AOE paths (`combat.physicalAoeMultiplier`).
  - Debuff lists now hold 20 rows: Spit Ball lays up to seven, and Magic Reflection's mirror can duplicate a name on the
    shooter. A duplicate name ticks under `engine.minusLapDuplicates` with `AppliedSpell.lag` (the display list lags the
    object list), the digest prints the display laps and the loader reads the lag off a mid-battle export. Any debuff a
    mirror copies (the wave-2 debuff spells) can duplicate the same way.
  - `spendShotsAgainst` is where Dense Flesh (Abomination: projectShotCost) belongs; the AOE tail spends against its
    first victim. Flesh Shield orders and scales the AOE tail's victims.
  - Made of Fire's max hp (`ceil(init + init / power)`) comes first in refreshAndGetAdjustedMaxHp, before Unyielding
    Power's laps and Boost Health's boost: it belongs at the head of `engine.hpHooks`.
  - Water Shield and Water Element, Fire Shield and Enchanted Skin change the damage a hit takes; every batch-5 hit
    goes through `combat.hit` (the Gaze's petrify damage alone calls `engine.applyDamageBreak` with break chance 0, as
    TypeScript does).
  - Resurrection keeps the corpse (`deleteUnitById(id, true)`): `cleanupDeadUnits` runs delete, `unit_destroyed`, then
    the Infest spawn, with the kill attributions captured before the first removal (`Attribution`, its `area` set for
    an area throw's victims).
  - The AbilityMask is a `u128`: ids 64 and up sit in the high word, so a test of two ids in different words reads both
    (Madness 35 and Mechanism 68 in `engine.moraleLocked`). Batch 6 adds thirteen ids to the 75.
  - The bridge accepts candidate actions from `ffi.SUPPORTED_ACTIONS`: a new action kind joins that list (batch 5's
    `area_throw_attack` first went refused there, and the roots holding one were not compared).
  - Perf: never default-initialize or return by value a struct of a kilobyte or more on a hot path (`combat.Groups`,
    `combat.Ray`: fill them in place, `evaluateGroups(&g, ...)`, `traceRayInto`); a large default value is stored whole
    and a returned one copied, and they cost 5% of the engine replay. Gated hooks in `adjustBaseStats` cost 3% even with
    every flag false (register pressure, not the tests): the batch-5 hooks live in a comptime instance
    (`adjustBaseStatsWith(.., true)`) that only boards with a holder run. A hook called from every hit site stays an
    inline holder test with the work out of line (`abilities.petrifyingGaze`, `spitBall`, `engine.cowardBarred`): a
    fatter inline helper stopped LLVM inlining `ai.canSelectMeleeTarget` into the AI's layer loops (2% of whole
    battles).
- Notes for the artifact port:
  - Boost Health sits inside refreshAndGetAdjustedMaxHp (`engine.hpHooks`): the boost with its free heal, then a comment
    marks the seam for the max-hp artifacts (Pendant of Vitality) right after the max-hp assignment, before Unyielding
    Power's +5 and the refill.
  - The ranged Deep Wounds riders are ported at the five ranged sites (before each Stun roll): a Queen that stole Deep
    Wounds and Endless Quiver shoots with them, so the Wounding Charm only adds holders.
  - Stones are read through the board (`st.BLOCK` cells) and the terrain helpers (`terrain.hasScatteredMountains`,
    `clearScatteredMountainAt`), never the grid type: Barrel Barricade's barrels on NORMAL and LAVA take the Double Shot
    two-stone rule, the splash rays and the area throw's stone clearing unchanged.
- Notes for the v0.8 owner (batch 5 in src/v08):
  - `rollout.v08Scope` refuses a v0.8 seat while a holder unit holds a batch-5 card (a stolen one too) or carries a Spit
    Ball debuff, and every spell outside `rollout.V08_CASTABLE`.
  - v0.8 emits two action shapes the engine replays: `area_throw_attack` (Gargantuan: `v0_8.ts`, `candidates.ts`,
    `area_throw_router.ts`) and the free-aim Through Shot (`range_attack` with `targetPosition` and no target id);
    TypeScript reads the shooters' cards in `candidates.ts`, `v0_2.ts`, `v0_8_ranged_positioning.ts`,
    `v0_8_placement_lift.ts`, `v0_8_ranked_replay_tactics.ts`, No Melee and Cowardice in most layers (`v0_1.ts` to
    `v0_5.ts`, `coherent_melee_approach.ts`, `v0_8_screen_hold.ts`), Rangebane in `candidates.ts` and
    `v0_8_ranged_positioning.ts`, Endless Quiver in `predatory_assimilation_router.ts` and `v0_8_support_roles.ts`.
  - The engine pieces they need are public: `combat.evaluateGroups` / `evaluateRangeFlags` (the ray groups with the
    Through Shot and splash flags), `sideObservableEx`, `isSplashShooter`, `aoeAbility`, `doubleShotAbility`,
    `physicalAoeMultiplier`, `projectLineToFieldEdge`, `freeAimAttack`, `areaThrowAttack`; `engine.rangebaned`,
    `cowardly`, `cowardBarred`, `moraleLocked`, `cumulativeHp`; `abilities.mindResistant`, `absorptionTarget`.
  - A v0.4-layer divergence on batch-4 boards (with HEAD's core too): seed 45840007, roots 13 and 29 of the oracle with
    batches 1 to 4 minus Trent at 0.6; Zig's v0.4 replaces v0.1's melee strike on the adjacent Hydra with a strike on a
    White Tiger (Disguise, Visible) from a cell the Hydra does not stand on, the engine refuses it and the rollout stops
    ("a policy turn landed nothing"), while TypeScript's v0.4 keeps v0.1's strike.

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
- `hoc-sim resume` loads the mid-battle exports a `RECORD_RESUME` recording embeds (below; the loader is
  `src/snapshot.zig`), checks each loaded state against the recorded digest of the step before, then replays the
  remaining engine steps and plays natively from there (`ai.continueMatchWith`), comparing every remaining step as
  `parity` and `native` do. It is the oracle for the bridge (`BRIDGE.md`); `hoc-sim play-state <state.json>` plays one
  exported battle out and prints the result and the final digest.

Resume points and AI options (off by default; the recording is then byte-identical):

- `RECORD_RESUME=random|random:<n>|<k>[,<k>...]`: at a decision boundary (an advance has selected the unit, its
  decideTurn has not run) the recorder embeds `exportBattleState` and the harness state (`resume: [{step, decision,
  unitId, rng, state}]`). `random` keeps one decision per battle, uniformly (reservoir sampling on a private stream
  hashed from the seed), `random:<n>` n of them, `<k>` the k-th decision.
- `RECORD_VERSION=<version>` records that strategy version on both seats (the decision wrapper goes on
  `getAIStrategy(version)`'s class; `v0.8s` is StrategyV0_8's), `RECORD_ORIGIN=rollout` passes decisionOrigin
  "rollout", and `RECORD_LAYERS=1` (v0.8 only) adds the v0.8 layer log and the AI target memory to each decision
  (`parity/v08/layers.ts`); the `.meta.json` then gains `version`, `decisionOrigin` and `layers`. `RECORD_LEAF=1` adds
  `leaf` (layers.ts `leafOracle`: the production V2 leaf of each team at the decision's board, for `hoc-sim v08 leaf`). These fold in the v0.8
  port's recorder (`parity/v08/record.ts`), whose output they reproduce byte for byte.

```bash
RECORD_RESUME=random:2 bun zig/parity/record.ts 300 8100000 /tmp/r.jsonl && zig/zig-out/bin/hoc-sim resume /tmp/r.jsonl
```

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

Batch-3 options (off unless a batch-3 creature is kept; then the default output above is unchanged otherwise):

- Keeping any of Zena, Arachna Queen, Arachna Spider, Squire, Troglodyte or Monk adds five unit digest columns after
  the setup columns: `abilities` (the active list, steals included, Break ignored), `stolen_abilities`, `web_locked`,
  `debuffs_sources` (each debuff's stored properties: the Web row's source cell) and `rallying_volley_granted`; with
  setup the start state's units gain `debuffsSources`. `compare.state` tells the layouts apart by column 47 (a number:
  the setup columns) and the number of columns after the setup columns (5 batch 3, 6 batch 3 and 4, 7 spells, 8 spells
  and batch 4).
- A start state holding an Infest unit gains `init.summonTemplates` (createUnitFromSpec's props of "Arachna Spider" and
  "Arachna Queen", stripped as every creature is); the game line gains `summonIds` (the summoned ids in creation order)
  and each resume point `summonSequence` and `summonsCreated`, with the export's harness carrying `seed` and
  `summonSequence`. Keep "Arachna Spider" beside "Arachna Queen": the summon-only Spider is stripped otherwise.
- `RECORD_CANDIDATES=1` (with `RECORD_LAYERS=1`) adds v0.8's candidate lists to a decide step when there are any, as
  `parity/v08/record.ts` does.

```bash
# batch 3 kept, production-like setup, with resume points
RECORD_GRID=mix RECORD_SIDE=1 RECORD_AUGMENTS=production RECORD_DOCTRINE=random RECORD_SYNERGIES=1 \
  RECORD_SYNERGY_VARIANTS=seed RECORD_DISTINCT_RED=1 RECORD_PLACEMENT_TIMING=setup-before-placement RECORD_RESUME=random:2 \
  RECORD_KEEP_ABILITIES="Zena,Arachna Queen,Arachna Spider,Squire,Troglodyte,Monk" zig/parity/check.sh 300
```

Spell options (off unless a kept creature has a spellbook or `RECORD_SPELLS` is set; then the default output above is
unchanged otherwise):

- `RECORD_AMOUNTS=expBudget` sizes stacks as the live server does (`buildRoster`'s amountMode, ceil(1000 / exp), and a
  swapped-in kept creature its own amount); without it most casters miss the stack-power gates (Meteor Shower and
  Meteorite need 5, Blessing and Vine Throw 3). The `.meta.json` gains `amounts`.
- `RECORD_SPELLS="Heal,Blessing,..."` keeps only those entries of the kept creatures' books (a castable ability such as
  Trent's Vine Throw is not a book entry). The wave-1 list is `Heal,Blessing,Fire Strike,Meteorite,Lightning
  Strike,Meteor Shower,Summon Wolves,Ring of Fire,Vine Throw`; without it Healer, Satyr and Magic Dragon cast wave-2
  spells and the loader refuses their books. The `.meta.json` gains `spells`.
- With either, the unit digest gains the batch-3 columns and then `spell_entries` (the raw entries) and `spellbook`
  (`name:charges` of the parsed book; `compare.state` reads rows of 54 and 57 columns), the fight digest gains `vines`
  (`[x, y, laps, team]` in Map order), the start state gains `spellConfigs` for every spell a unit holds plus the System
  Vine Throw, and a start state holding a summon spell gains the `Wolf` summon template (summon tracking then covers
  spell summons). A Trent-only battle sets `RECORD_SPELLS` to get the columns.
- `RECORD_PATHS` lines gain `vines` (the store's cells) when the board has any; `hoc-sim paths` replays the vine toll,
  the strider's second pass and the merge, and reads a call without an aggression board (the Castling hook's) as an
  all-ones board.

```bash
# wave 1, v0.8s replays, production-like
RECORD_VERSION=v0.8s V08_RANGED_POSITION_VERSIONS=v0.8,v0.8s RECORD_ORIGIN=rollout RECORD_GRID=mix RECORD_SIDE=1 \
  RECORD_AUGMENTS=production RECORD_DOCTRINE=random RECORD_SYNERGIES=1 RECORD_SYNERGY_VARIANTS=seed RECORD_DISTINCT_RED=1 \
  RECORD_PLACEMENT_TIMING=setup-before-placement RECORD_KEEP_RATE=1 RECORD_AMOUNTS=expBudget \
  RECORD_KEEP_ABILITIES="Healer,Battle Mage,Satyr,Magic Dragon,Trent" \
  RECORD_SPELLS="Heal,Blessing,Fire Strike,Meteorite,Lightning Strike,Meteor Shower,Summon Wolves,Ring of Fire,Vine Throw" \
  bun zig/parity/record.ts 100 13000000 /tmp/w1.jsonl && zig/zig-out/bin/hoc-sim parity /tmp/w1.jsonl
```

Batch-4 options (off unless a batch-4 creature is kept or `RECORD_STRIP_ABILITIES` is set; then the default output above
is unchanged otherwise):

- Keeping any of Wolf, Berserker, Frenzied Boar, Griffin, White Tiger, Manticore, Behemoth or Troll turns on the batch-3
  columns (gifts and steals move the active list; `debuffs_sources` names the Range Null Field row's source) and adds
  `forbidden_target` (Terrifying Gaze's lock: the gazer's id, or "") as the last unit column. A kept Behemoth or Troll
  counts as a kept spellbook (its castable card holds a charge): the spellbook columns and `spellConfigs` follow.
- `RECORD_STRIP_ABILITIES="Deep Wounds Level 2,AI Driven"` strips those cards from the kept creatures (a stripped castable
  card takes its charge along), so each card can be checked alone. The `.meta.json` gains `strip`.
- A start state holding a Disguise Aura card gains the System `Hidden` and `Visible` configs in `spellConfigs` (the laps
  and powers of the markers the stat refresh writes); the `Disguise` aura config is in `auraEffectConfigs` as usual.
- Under a `RECORD_VERSION` other than v0.1 a mindless unit's decisions, which runMatch makes with StrategyV0_1 whatever
  the seat, are recorded too: decide steps marked `v: "v0.1"` (no resume point or layer log; `rec.Step.mindless`). A
  checker of another version dispatches those units to v0.1 (`rollout.isMindless`) and expects these steps.

```bash
# batch 4 kept at keep rate 1, production-like, with resume points; Manticore without its Deep Wounds card
RECORD_GRID=mix RECORD_SIDE=1 RECORD_AUGMENTS=production RECORD_DOCTRINE=random RECORD_SYNERGIES=1 \
  RECORD_SYNERGY_VARIANTS=seed RECORD_DISTINCT_RED=1 RECORD_PLACEMENT_TIMING=setup-before-placement RECORD_RESUME=random:2 \
  RECORD_AMOUNTS=expBudget RECORD_KEEP_RATE=1 \
  RECORD_KEEP_ABILITIES="Wolf,Berserker,Frenzied Boar,Griffin,White Tiger,Manticore,Behemoth,Troll" zig/parity/check.sh 150
RECORD_KEEP_RATE=1 RECORD_KEEP_ABILITIES=Manticore RECORD_STRIP_ABILITIES="Deep Wounds Level 2" zig/parity/check.sh 50
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

Batch 5, checked on 2026-11-25 against common `e786b46a` (every battle identical; every run on side-oriented
production-mix maps with the production-like setup, `RECORD_AMOUNTS=expBudget`, `RECORD_RESUME=random:2` and traced
draws; the wave-1 and batch-4 `RECORD_SPELLS` lists wherever casters are kept):

- native v0.1 and engine replay on the final code: 2,630 battles, 426,236 steps, and 5,260 resume points equal to their
  digests with 431,733 remaining steps identical in both modes: each creature alone at keep rate 1 (50 each, seeds
  42000000 + 100000 * k for Arbalester, Elf, Medusa, Beholder, Cyclops, Tsar Cannon, Gargantuan, Centaur), the cards
  isolated with `RECORD_STRIP_ABILITIES` (40 each, 42800000-42890000: Medusa without Gaze / without Quiver, Arbalester
  without Sniper / without Limited Supply, Tsar Cannon without Through Shot / with only Through Shot, Gargantuan without
  Area Throw / without Double Throw, Centaur without Boost Health / without Piercing Spear), the whole batch at keep
  rate 1 (150, 42900000), batch 5 with batches 1 to 4 and the wave-1 casters at the default rate (200, 43000000 and
  43100000), Queen steals and quiver thieves (780: 43200000, 43300000, 44900000, 45000000, 45400000, 46100000),
  range-heavy rosters (`ROSTER_RANGED_MIN=5` / `4`, 160, 43400000 and 43500000), the Beholder beside casters, auras and
  Absorb Penalties (180, 43600000 and 44000000), the Tsar Cannon beside Pegasus Light, Hydra spins and Skewers (80,
  43700000), stones (`RECORD_GRID=4`, 80, 43800000), synergy variants with Might and Chaos (120, 43900000 and
  44100000), and 80 battles with a Debug build (45500000, 45600000); plus about 2,500 battles of the same scopes during
  development (seeds 40000000-41999999);
- engine replay of v0.8s battles (the Gargantuan's `area_throw_attack`, the Tsar Cannon's free aim, Spit Ball, stolen
  quivers, stones): 500 battles, 77,177 steps, 1,000 resume replays identical (44300000-44800059 and a Debug build at
  45700000), with 675 area throws and 76 free-aim shots, every one accepted as recorded;
- reached in the v0.1 runs (digest and trace tallies): 36,099 shots, among them 6,731 by an active Sniper (1,805 shot
  distances rewritten by a move), 3,589 Large Caliber and 2,060 Area Throw splashes (47,240 AOE miss rolls, 6,498 splash
  hits), 1,833 Double Shot / Double Throw volleys (252 second hits), 1,839 Through Shots (802 pierced hits), 6,133
  Endless Quiver shots (5,902 free), 2,499 Spit Balls (30,482 debuff chance rolls, 10,400 saves, 7,284 mirror rolls;
  Curse 589, Sadness 558, Quagmire 550, Weakening Beam 581, Weakness 605, Rangebane 272, Cowardice 538 landed; 82 rows
  with a duplicated name; 434 decisions under Cowardice, 174 under Rangebane), 19,280 Petrifying Gaze rolls (1,611 after
  a melee strike), 2,668 Absorb Penalties redirects, 4,786 Limited Supply cuts, 4,683 Boost Health maximum changes (one
  free heal), 65,811 Mechanism-locked rows and 900 decisions with `[NO_ATTACK]`, 982 melee and 2,872 ranged Piercing
  Spear hits, 20 counter-shots by a Queen holding a stolen Endless Quiver, 19 ranged steal rolls (2 steals) and 6
  Spiders raised from a ranged kill; at most 7 debuffs on one unit;
- unchanged: the default recorder output byte-identical to HEAD's (the seven recipes of batch 4), classic `check.sh 300
  45100000`, production-like batches 1 to 4 kept (300, 45200000, with 600 resume points), the wave-1 replay recipe
  200/200 (45300000), `ffi/smoke.ts 12 45870000` and 30 battles each with batch 5 and batches 1-5 kept, `zig build
  test`;
- the rollout oracle (`BRIDGE.md`): v0.1 rollouts on batch-5 roots 274 roots, 263,040 values identical, 0 refused
  (area throws among the candidates, 6,659 summons inside rollouts, uuid-sequence ids too); v0.8 with origin's src/v08
  (`66e72e9e`) over this core: batches 1 to 3 minus Trent 75 roots, 72,000 values identical; batches 1 to 4 minus Trent
  48 roots, 45,312 values identical, 0 refused roots (48 refused calls at two roots, the v0.4 gap in the v0.8 notes
  above); the wave-1 casters with batches 1 to 4 and Trent 62 roots, 59,520 values identical, 0 refused; v0.8 on
  batch-5 boards refused.

Batch 4, checked on 2026-11-25 against common `6998c2dd` (every battle identical; every run on side-oriented
production-mix maps with the production-like setup, `RECORD_AMOUNTS=expBudget` and `RECORD_RESUME=random:2`; the
wave-1 `RECORD_SPELLS` list wherever casters are kept):

- native v0.1 and engine replay (`check.sh`'s two modes) on the final code: 1,210 battles, 218,970 steps, and 2,420
  resume points equal to their digests with 212,018 remaining steps identical in both modes: each creature alone at keep
  rate 1 (40 each, seeds 30000000 + 100000 * k for Wolf, Berserker, Frenzied Boar, Griffin, White Tiger, Manticore,
  Behemoth, Troll), the cards isolated with `RECORD_STRIP_ABILITIES` (no Deep Wounds on Griffin, Tiger, Manticore,
  Behemoth and Wolf, 31000000; no AI Driven on Boar and Berserker beside Monk, Troglodyte and Hydra, 31100000; 60 each),
  the whole batch at keep rate 1 (150, 31200000), batch 4 with batches 1 to 3 and the wave-1 casters at the default rate
  (200, 31300000 and 31400000), Queen steals (80, 31500000), Manticore with Troglodyte, Monk, Squire, Behemoth and Troll
  (60, 31600000), spins and Chaos break with Might ability power (variants `Life:2,Chaos:2,Might:2,Nature:2`, 60,
  31700000), range-heavy rosters against the Griffin, Tiger and Manticore (`ROSTER_RANGED_MIN=5` / `4`, 140, 34000000
  and 34100000), and 80 battles with a Debug build (34200000, 34300000); plus 1,880 battles of the same scopes during
  development (seeds 20000001-20000720, 21000000-21700049, 22000000-22700099, 26700000-27100099);
- engine replay of v0.8s battles (casts of Battle Roar and the Wild Regeneration gift, Borrowed Grace copies of Battle
  Roar, Hidden against wave-1 spells, summoned Wolves with their cards, mindless decisions marked `v0.1`): 320 battles,
  77,377 steps, 640 resume replays identical (32000000-32400079), and 580 during development;
- reached (digest and trace tallies of the final runs; the v0.1 runs first): 14,024 Deep Wounds applications; 4,754 gaze
  rolls (`terrifying_gaze_ability.ts:45`), 1,061 gazes landed or re-pointed and 803 frightened decisions; 1,017 Boar
  Saliva applications; 1,605 regenerations; 1,159 Unyielding Power lap gains; 5,472 mindless decisions (7 waits, 2
  defends); 7,094 decisions facing a Hidden enemy; 614 decisions of a shooter under a Range Null Field and 29 shots at
  one (its counter-shot suppressed); steals of every batch-4 card but Unyielding Power (stolen during development). In
  the v0.8s replays (360 battles with the Debug one): 321 Battle Roar casts (1,947 recipient rows), 153 gifts (about 4
  lost to a Broken or robbed recipient), 1,260 regenerations and 1,453 mindless decisions, all recorded as marked
  `v0.1` decide steps;
- unchanged: the default recorder output byte-identical to HEAD's (classic 1001-1020, batches 1+2 kept on the side mix
  2001-2020, production-like batches 1-3 kept with resume points 3001-3020, v0.8s layers and candidates 4001-4012, wave 1
  in v0.8s 5001-5010 and with resume points 6001-6010), and those recordings identical in every mode; classic
  `check.sh 300 32500000`; production-like batches 1-3 kept `check.sh 300 32600000` with 600 resume points; the wave-1
  replay recipe 200/200 (32700000); `ffi/smoke.ts 12 9100` and 30 battles each with batch 4 and batches 1-4 kept;
  `zig build test`;
- the rollout oracle (`BRIDGE.md`): v0.1 rollouts on batch-4 roots 725 roots, 696,000 values identical; v0.8 with
  Berserkers 209 roots identical; ability-free v0.8 604 roots identical; v0.8 on batch-4 boards refused.

Wave-1 spells, checked on 2026-11-25 against common `2f222cc0` (every battle identical; every run on side-oriented
production-mix maps with the production-like setup, `RECORD_AMOUNTS=expBudget` and the wave-1 `RECORD_SPELLS` list):

- engine replay (`hoc-sim parity`) of v0.8s battles (`RECORD_VERSION=v0.8s V08_RANGED_POSITION_VERSIONS=v0.8,v0.8s
  RECORD_ORIGIN=rollout`): 1,350 battles, 346,664 steps, 15,592 casts: Lightning Strike 4,590, Fire Strike 2,372, Heal
  1,923, Summon Wolves 1,833, Meteor Shower 1,315, Vine Throw 1,074, Blessing 1,070, Ring of Fire 834, Meteorite 581
  (0 rejected). The casters alone at keep rate 1 (seeds 13000000-13000399), with batches 1 to 3 kept at keep rate 1
  (13100000-13100299) and at the default rate (13200000-13200299), Magic Dragon and Trent (13300000-13300199), and
  Empower plans (`RECORD_AUGMENTS="Placement:1,Armor:3,Empower:3|Empower:2,Might:3"`, Magic Dragon, Battle Mage and
  Satyr, 13400000-13400149);
- a Queen battery (Queen and Spider with the casters, keep rate 1, 150 battles from 12160000): steals of all four
  spellbooks, Vine Throw, Magic Reflection, Sylvan Focus Blessing and In Its Own World, and casts of stolen Fire
  Strike, Heal, Lightning Strike and Summon Wolves;
- native v0.1 (`hoc-sim native`, the MAGIC attack type: a Healer or Satyr leads with MAGIC and re-selects MELEE to
  strike, 174 times in 50 battles): 600 battles, 118,807 steps, with the casters at keep rate 1 (13500000-13500299) and
  with batches 1 to 3 at the default rate (13600000-13600299); resume on those recordings (`RECORD_RESUME=random:2`):
  1,200 points loaded equal to their digests and 121,288 remaining steps identical in both modes; resume replays of
  v0.8s caster recordings (spell state at the points: vines, books, spent charges, Wolves): 300 of 300;
- `getMovePath` with vines (`hoc-sim paths`): 55,994 calls on v0.8s Trent battles (60 from 12120000, 80 from 12130000),
  22,415 of them with vines and 7,614 by a strider with vines (23 by a 2x2 Queen that stole In Its Own World), every
  route, weight and key order identical;
- the v0.8 rollout oracle (`BRIDGE.md`): all 348 roots, 334,080 values identical; v0.1 rollouts on spell roots 230,400
  values identical;
- a Debug build passes the replay, resume and path checks on 40-battle mixes;
- unchanged: the default recorder output byte-identical to HEAD's (classic 1001-1020, batches 1+2 kept on the side mix
  2001-2020, production-like batches 1-3 kept with resume points 3001-3020, v0.8s layers and candidates 4001-4012);
  classic `check.sh 300 8400000`; production-like batches 1-3 kept `check.sh 300 9800000` with 600 resume points;
  `hoc-sim parity` 100/100 on v0.8s and v0.8sr side-mix layers (regenerated from their meta: 25,206 and 22,816
  steps); `ffi/smoke.ts 12 9100`; `zig build test`.

Batch 3, checked on 2026-11-25 against common `ec55af8b` (both modes, every battle identical; every run on
side-oriented production-mix maps with the production-like setup above and `RECORD_RESUME=random:2`):

- batch 3 kept (`Zena,Arachna Queen,Arachna Spider,Squire,Troglodyte,Monk`): 2,500 battles, 468,970 steps: at the
  default keep rate seeds 9700000–9700399 and 9701000–9701599, at keep rate 1 the whole batch (9710000–9710399),
  Queen + Spider (9720000–9720299), Zena (9730000–9730299), Squire + Monk (9740000–9740299) and Troglodyte
  (9750000–9750199); plus 200 traced battles at keep rate 1 (9760000–9760199, `RECORD_TRACE_DRAWS=1`);
- batches 1, 2 and 3 kept together: 1,500 battles, 271,461 steps (9800000–9800999, and 9810000–9810499 at keep rate 1);
- replay of v0.8s battles with batches 1 to 3 kept (production-like, seeds 9900000–9900059): 56 of 60 identical, the
  other 4 refused as recordings outside the port (v0.8 casts Vine Throw: `cast_spell`);
- every check above also passes with a Debug build (Zig's safety checks on);
- resume: 8,000 points from these recordings, every loaded state equal to its recorded digest and every remaining
  step identical in both modes (5,000 points and 459,998 remaining steps with batch 3 kept, 3,000 points and 266,545
  steps with all three batches);
- reached (digest and event tallies of the batch-3 runs): 16,812 summons (181 in one battle; 72 removed ids in one
  lap's turn sets), 912 skips (Stun skips and web-locked end turns), 13,953 web-locked flyer rows, 5,337 Stun rows,
  48,126 Miner rows, Rallying Volley arrows on 279,989 rows; steals of every batch-3 ability but Web Aura, Infest and
  Predatory Assimilation, and with all three batches kept 34 abilities (Lightning Spin 85, Double Punch 18, Skewer
  Strike from a Queen 15, Backstab 4, the auras and blessings; up to 8 active abilities on one Queen); the traced draw
  sites: Chakram bounce rolls 1,088 (counter-throws 52), AOE-tail break rolls 584, Absolving Arrow rolls 122, Stun
  rolls 1,108, Predatory Assimilation chance rolls 1,044 and pick rolls 168;
- unchanged: the default recorder output byte-identical to HEAD's (classic seeds 1001–1020, batches 1+2 kept on the
  side mix 2001–2020, production-like kept with resume points 3001–3020), and `RECORD_CANDIDATES=1` byte-identical to
  `parity/v08/record.ts` (v0.8s, rollout origin, layers, side mix, seeds 4001–4012: 70 candidate lists); classic
  `check.sh 300 8400000` (50,956 steps); production-like batches 1+2 kept, 300 battles with 600 resume points
  (8500000); `hoc-sim parity` 100/100 on v0.8s and v0.8sr side-mix layers; `ffi/smoke.ts 12 9100`, and 30 battles each
  with batch 3 and with all three batches kept (`SMOKE_KEEP`); the rollout comparison 6,240 + 4,640 values identical,
  and 6,240 + 6,400 with batch 3 and all batches kept; `zig build test`.

Native v0.8 rollouts through the bridge, checked on 2026-11-25 against common `58d5ae7c` (details, refusals and the
speed table in `BRIDGE.md`):

- v0.8 on both seats, ability-free production-like battles (src/v08's scope; side boards, maps mixed by seed): 220,800 of
  220,800 rollout values bit-identical to `SearchDriver.rollout` on 230 roots of 150 battles (seeds
  11000000-11000149), plain and antithetic chance, horizons turns 12 / 64, lap, reply and leaf, leaves material, v1 and
  v2 with and without exact terminals, the same rollout turns, turn-budget stops and summon counters; 118 roots refused
  by two checks for src/v08 gaps, and with the two patches in `BRIDGE.md` applied all 348 roots identical (334,080
  values);
- v0.1 rollouts with batches 1 to 3 kept: 48,000 and 49,920 values identical (both summon id schemes, 5,930 summons
  inside rollouts); v0.8 with abilities on the board is refused (src/v08 covers ability-free boards);
- per rollout turn with v0.8 and the v2 leaf: TypeScript 320 to 364 us, Zig 8.3 to 13.5 us (28 to 40 times per
  rollout, load average 150 to 170).

Bridge (mid-battle export and load, resume, the C ABI and rollouts), checked on 2026-11-25 against common `50ae51c2`
(details and overheads in `BRIDGE.md`):

- `hoc-sim resume`, every point identical in both modes and every loaded state equal to its recorded digest: classic
  NORMAL ability-free 300 battles, 600 points (seeds 8100000-8100299); production-like ability-free 300, 600 points
  (8200000-8200299); production-like with batches 1 and 2 kept 500, 1,250 points (8300000-8300249, and 8310000-8310249
  at keep rate 1); 204,139 remaining steps; points spread early / mid / late 779 / 836 / 835;
- `ffi/smoke.ts` 60 battles (kept and ability-free) and 34,240 rollouts identical to `SearchDriver.rollout` with v0.1
  seats (every horizon, exact terminal on and off);
- unchanged: the default recorder output byte-identical to the previous recorder's (classic seeds 1001-1020, the kept
  side mix 2001-2020, production-like kept 3001-3020); `check.sh 300 8400000`; production-like kept `check.sh 300
  8500000`; the v0.8 replays (`hoc-sim parity` 100/100 on v0.8s and v0.8sr side-mix layers); `RECORD_VERSION` v0.7 and
  v0.8s with `RECORD_ORIGIN=rollout RECORD_LAYERS=1` byte-identical to `parity/v08/record.ts`; `zig build test`.

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

For the 9800X3D: `zig build -Drelease=true -Dtarget=x86_64-linux-gnu -Dcpu=znver5` (dynamic, against the system glibc).
Every artifact links libc: the learned leaves call libc's `exp`, as Bun's `Math.exp` does, and musl's `exp` can differ
from glibc's in the last bit (the check is in `BRIDGE.md`), so the static musl build is no longer used.

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

A battle state is a flat value of about 47 KB (48,320 bytes; 40,432 before batch 3; 36 KB before abilities), so a
search rollout's snapshot and restore is one copy. Batch 3 grew each unit from 1,184 to 1,424 bytes (spell lists
12/4/6 -> 14/5/7, ten abilities instead of four, the uid and UUID, the stolen list, the Web lock and the Rallying
Volley arrows) and added the holder order and the removed-unit sets; the summon templates live outside the State
(one interned copy per template, `State.summons` points at it).

Batch 3 kept the classic path within noise on a busy host: six alternated pairs of `native-bench --reps 3` (load 55 to
60) gave medians of 304.4 µs (old) and 299.2 µs (new) per battle, pairwise -1.7%, and six pairs of the engine-only
bench 576.0 and 561.5 ns per step, pairwise -2.9%, with the same run checksums (an earlier eight pairs at load 38 to 81:
+1.2% and -2.1%); retired instructions per pass (`/usr/bin/time -l`, the difference of two repetition counts) went
from 4.23 to 4.11 billion per 1,000 battles and from 938 to 944 million per engine pass.

The wave-1 spells kept the classic path within noise (load 40 to 70): eight alternated pairs of `native-bench --reps 3`
gave medians of 283.2 µs (old) and 281.8 µs (new) per battle, and five pairs of the engine-only bench 557 and 563 ns per
step, with the same run checksums. The spell stat hooks are gated by `State.spell_hooks`, a vine-free board walks the
pather's unchanged first pass (a refactor that shared its geometry with the strider's second pass had cost 8%), and
`MovePath` is reset field by field (a whole-struct reset copies the larger route array). A state is now 53,408 bytes
(Unit 1,552: the spellbook; Fight 928: the vines) and a decision context 42,816 (MovePath 21,000: room for the vine
merge's ancestors).

Batch 4 kept the classic path within noise for whole battles: ten alternated pairs of `native-bench --reps 5` (load 5
to 9) gave medians of 250.95 µs (old) and 252.05 µs (new) per battle, pairwise +0.6%, and eight pairs of the engine-only
bench 506.5 and 514.5 ns per step, pairwise +1.4%, with the same run checksums; retired instructions per pass went down
(883 to 838 million per engine pass, 4.10 to 4.05 billion per 1,000 battles). A first draft cost 2.8% of the engine
replay with fewer instructions: Zig's auto layout reshuffled `Unit`, and the new reads sat in `adjustBaseStats`' hot
loop; gating them behind `State` flags and moving Unyielding Power and the Disguise swaps into `noinline` helpers
recovered most of it. A state is now 60,784 bytes (Unit 1,776: buffs 20, debuffs 8, effects 10).

Batch 5 kept whole battles level: ten alternated pairs of `native-bench --reps 5` (load 6 to 10) gave medians of 264.6
µs (old) and 265.65 µs (new) per battle, pairwise -0.3%, and eight pairs of the engine-only bench 554 and 561.5 ns per
step, pairwise +2.6% (949.8 and 976.3 million instructions per engine pass), with the same run checksums. The first
draft cost the engine replay 5.7% and whole battles 2.2%: the ray groups (`combat.Groups`, 1.2 KB) and the ray
(`combat.Ray`, 1.5 KB) were default-initialized and returned by value on every shot, the batch-5 hooks in
`adjustBaseStats` cost 3% with every flag false, and a fatter Cowardice helper kept `ai.canSelectMeleeTarget` out of the
AI's layer loops. Filling the rays in place, a comptime instance of `adjustBaseStats` for boards without a holder, and
inline holder tests with out-of-line work recovered it (the batch-5 lessons above). A state is now 70,688 bytes (Unit
2,080: debuffs 20).

Where Zig spends battle time (sampled, before the layer bitmap): `getMovePath` 31%, `doFindTarget` 14%, the melee
target layers 22%, the engine 20%. None of it is tuned beyond one bitmap for the layers.

## Not covered yet

- the abilities of every creature outside batches 1 to 5 and the wave-1 casters, the spells outside wave 1 (Spiritual
  Armor, Mass Heal, Courage, Helping Hand, Whirlpool, Smoke, Craft, Wind Flow, Resurrection, Castling, the
  runes and the rest: a book holding one is refused by name), the disabled Broken Aegis
  (its +20 break chance and self-miss) and Holy Cross (resurrection, the magic-resist and mirror rolls of debuff
  spells), Crafted Double Shot; the revealed-ranged delivery layer of production's augment plan (it needs the live
  draft); WATER_CENTER (never played); on the maps, Fire Breath through stones,
  and `forceStalledLap` / the recovery net (never reached: 0 rejected engine calls in every map recording). The ported
  code leaves out what no battle in scope can reach: the Made of Fire ability (no creature in scope holds it; the
  Lava Striders buff is ported), Paralysis, Water Shield and Water Element, Flesh Shield, Dense Flesh
  (`spendShotsAgainst` spends one arrow), the aura power types outside the six in scope, the Wind Element (Thunderbird
  is not ported), the Castling hook's getMovePath (it draws nothing), runs of more stunned activations than the advance
  attempts allow (`forceStalledLap`, never seen), the mass casts other than Battle Roar's ALL_ALLIES buff (Mass Heal,
  the flyer and enemy casts), Holy Cross (a gift the caster keeps); the recovery net is ported only for mindless units
  (runMatch's retry, never reached). The ranged Deep Wounds riders are reached through Wounding Charm's granted card
  (and a Queen holding both a stolen Deep Wounds and a stolen Endless Quiver).
- the AI versions the research uses (v0.8 with the a19 search). The production rollout policy is the v0.8 chain, about
  67k lines of TypeScript; its port lives in `src/v08/` and builds on `ai.zig` (every declaration public,
  `playMatchWith` / `continueMatchWith` take the decide function, `initCtxInto` builds a decision context) and
  `compare.NativeCheck`. The bridge's rollouts take each unit's decide function from `rollout.policies` (v0.1 and
  v0.8; a mindless unit plays v0.1 whatever its seat); the v0.8 port covers batches 1 to 4 and the wave-1 casts, so a
  v0.8 request on a board with another spell or a batch-5 card or debuff is refused (the known gaps and what the
  search still needs are in `BRIDGE.md`).
