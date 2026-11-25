# Zig engine spike

A native port of a slice of the common battle engine and the v0.1 AI, built to measure how much faster AI research
could run on a native simulator. It is not wired into the package build, lint, tests or any shipped code.

## Scope

Zig plays whole battles that match the TypeScript `runMatch` step for step, for battles with:

- every creature's stats, sizes (1x1, 2x1, 2x2), walking and flying, melee and ranged;
- the abilities of the creatures ported so far (batches 1 and 2, below); every other creature's abilities, and all
  spells, stripped; no artifacts, augments, synergies or doctrines;
- the NORMAL grid, including board narrowing (holes, shoves, crushes) and the Armageddon waves;
- the v0.1 AI on both sides.

The engine also replays (`hoc-sim parity`) the actions later AI versions emit on that board: move-then-strike
(`melee_attack` with a `path`), `wait_turn`, `defend_turn`, aimed shots and refused `select_attack_type`.

Ported:

- **Engine** (`engine.zig`, `combat.zig`): turn order and lap transitions, the morale and luck rolls, stack power and
  the stat refresh, move validation, melee with response, move-then-strike (`resolveKnownPaths` trusting the client
  route, `applyMoveModifiers` with its anchor-cell morale target, `getPositionForFootprintAnchor`), ranged line of fire
  with edge aiming, distance penalty, counter-shots and target switching, wait and defend, death cleanup.
- **Random stream** (`rng.zig`): `mulberry32` plus `getRandomInt` rejection sampling, bit for bit.
- **Path search** (`path.zig`): `PathHelper.getMovePath` as v0.1 uses it (the first-come FIFO walk, threat costs,
  diagonal sneak rules, the closest-move pass).
- **AI and match loop** (`ai.zig`): `StrategyV0_1.decideTurn`, `findTarget`, `doFindTarget`'s two passes, the melee
  target layers, target memory, the safer-move search, shooter line checks, `preferBackstabAttackCell`, and the
  `runMatchInner` loop for v0.1 seats. The recovery net and `forceStalledLap` are not ported (never reached in the
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
- `hoc-sim paths` recomputes recorded `getMovePath` calls (record with `RECORD_PATHS=<file>`), comparing every route
  and weight.

The unit digest holds every compared stat, the buff/debuff/effect names, laps and powers, and some hidden state
(position, base morale, luck per turn, initial base attack, moved route cells, the Aggr forced target, magic resist and
each buff's source cell); the fight digest adds the Ember Covenant teams. The field list is in each recording's
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

A battle state is a flat value of about 41 KB (36 KB before abilities), so a search rollout's snapshot and restore
is one copy.

Where Zig spends battle time (sampled, before the layer bitmap): `getMovePath` 31%, `doFindTarget` 14%, the melee
target layers 22%, the engine 20%. None of it is tuned beyond one bitmap for the layers.

## Not covered yet

- the abilities of every creature outside batches 1 and 2, spells, artifacts, augments, synergies, obstacles and other
  maps. The ported code leaves out what no battle in scope can reach: Break, Made of Fire, Mechanism, Paralysis, the
  forbidden target (Terrifying Gaze), Water Shield and Water Element, Flesh Shield, the Dual Strike Charm, the aura
  power types outside the three in scope, Skewer Strike from a large attacker, the Vine Throw cast, vines and the
  Earth/Wind element pair (Thunderbird is not ported);
- the AI versions the research uses (v0.8 with the a19 search). The production rollout policy is the v0.8 chain, about
  67k lines of TypeScript; its port lives in `src/v08/` and builds on `ai.zig` (every declaration public,
  `playMatchWith` takes the decide function, `initCtxInto` builds a decision context) and `compare.NativeCheck`.
