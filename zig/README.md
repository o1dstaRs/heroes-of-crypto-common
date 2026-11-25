# Zig engine spike

A native port of a slice of the common battle engine and the v0.1 AI, built to measure how much faster AI research
could run on a native simulator. It is not wired into the package build, lint, tests or any shipped code.

## Scope

Zig plays whole battles that match the TypeScript `runMatch` step for step, for battles with:

- every creature's stats, sizes (1x1, 2x1, 2x2), walking and flying, melee and ranged;
- the abilities of the creatures ported so far (batch 1, below); every other creature's abilities, and all spells,
  stripped; no artifacts, augments, synergies or doctrines;
- the NORMAL grid, including board narrowing (holes, shoves, crushes) and the Armageddon waves;
- the v0.1 AI on both sides.

Ported:

- **Engine** (`engine.zig`, `combat.zig`): turn order and lap transitions, the morale and luck rolls, stack power and
  the stat refresh, move validation, melee with response, ranged line of fire with edge aiming, distance penalty,
  counter-shots and target switching, death cleanup.
- **Random stream** (`rng.zig`): `mulberry32` plus `getRandomInt` rejection sampling, bit for bit.
- **Path search** (`path.zig`): `PathHelper.getMovePath` as v0.1 uses it (the first-come FIFO walk, threat costs,
  diagonal sneak rules, the closest-move pass).
- **AI and match loop** (`ai.zig`): `StrategyV0_1.decideTurn`, `findTarget`, `doFindTarget`'s two passes, the melee
  target layers, target memory, the safer-move search, shooter line checks, `preferBackstabAttackCell`, and the
  `runMatchInner` loop for v0.1 seats. The recovery net and `forceStalledLap` are not ported (never reached in the
  recordings or in a 2,000-battle probe of the TypeScript code); a battle that would need them stops with
  `unsupported` or `stuck`, which the parity check reports.

### Abilities

Batch 1, exact in both modes:

| Creature | Abilities |
| --- | --- |
| Leprechaun (L1) | Luck Blessing, Lucky Strike |
| Fairy (L1) | Shadow Touch, Small Specie |
| Scavenger (L1) | Backstab, Dodge |
| Nomad (L2) | Shatter Armor, Rapid Charge |
| Hyena (L2) | Penetrating Bite |
| Crusader (L3) | Double Punch, Sharpened Weapons Blessing |
| Goblin Knight (L3) | Heavy Armor, Dulling Defense |

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
  Charge's charged route (`movedRouteCellsThisTurn`).

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
- Keep the ability-free path cheap: probes go through the unit's ability mask, and the blessing census runs only when
  `State.blessings` is set.

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
(position, base morale, luck per turn, initial base attack, moved route cells); the field list is in each
recording's `.meta.json`.

`RECORD_KEEP_ABILITIES="Leprechaun,Nomad"` keeps those creatures' abilities (and spells) and swaps each roster slot
for a kept creature of the same level with probability `RECORD_KEEP_RATE` (default 0.6). Use it to check a batch:

```bash
# from the common package root
zig/parity/check.sh 200          # record 200 fresh battles (random seed), then run parity and native on them
RECORD_KEEP_ABILITIES="Leprechaun,Nomad,Crusader,Fairy,Goblin Knight,Hyena,Scavenger" zig/parity/check.sh 300
cd zig && zig build test         # unit tests (random stream, JS number rounding)
```

Run `check.sh` after changing any rules or v0.1 AI code the port covers, both with and without the batch kept.

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
runs of the old and new binaries stay within noise of each other.

A battle state is a flat value of about 40 KB (36 KB before abilities), so a search rollout's snapshot and restore
is one copy.

Where Zig spends battle time (sampled, before the layer bitmap): `getMovePath` 31%, `doFindTarget` 14%, the melee
target layers 22%, the engine 20%. None of it is tuned beyond one bitmap for the layers.

## Not covered yet

- the abilities of every creature outside batch 1, spells, auras, artifacts, augments, synergies, obstacles and other
  maps. The batch-1 code leaves out what no batch-1 battle can reach: Break, Made of Fire, Mechanism, Paralysis, the
  forced and forbidden targets, Water Shield and the Dual Strike Charm;
- move-then-strike melee (`melee_attack` with a path), wait and defend, which v0.1 never produces;
- the AI versions the research uses (v0.8 with the a19 search). The production rollout policy is the v0.8 chain, about
  67k lines of TypeScript.
