# Heroes of Crypto — Common

<p align="center">
  <a href="https://github.com/o1dstaRs/heroes-of-crypto-common/actions/workflows/ci.yml">
    <img src="https://github.com/o1dstaRs/heroes-of-crypto-common/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://bun.sh/">
    <img src="https://img.shields.io/badge/Bun-1.3-fa9b3b.svg?logo=bun&logoColor=white" alt="Bun">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  </a>
</p>

The **deterministic, shared game logic** behind [Heroes of Crypto](https://heroes-of-crypto.gitbook.io/heroes-of-crypto-ai) —
a turn-based tactical battler. This package is the single source of truth for the entire battle
simulation and runs identically in two places:

- the [client](https://github.com/o1dstaRs/heroes-of-crypto-client) — for the local sandbox and for replaying matches, and
- the **server** — as the authoritative engine for ranked multiplayer.

Because both sides execute the same code, a given set of inputs always produces the same outcome —
the server stays authoritative while the client can predict, animate, and replay without drifting.

> 📖 For game mechanics, roadmap, and vision, see the [Whitepaper](https://heroes-of-crypto.gitbook.io/heroes-of-crypto-ai).

## How it works

The engine is **action-driven**. You feed it a `GameAction` (move, attack, cast spell, place unit,
end turn, …); it validates the action against the current battle state, mutates that state, and
returns a list of `GameEvent`s describing exactly what happened (units moved, damaged, killed,
resurrected, morale changed, lap flipped, fight finished, …). The renderer turns those events into
animations and combat-log lines; the server journals them and broadcasts state.

```
GameAction ──▶ GameActionEngine ──▶ { completed, events: GameEvent[] }
                      │
                      ├─ TurnEngine        (whose turn, lap flips, hourglass/wait queues)
                      ├─ AttackHandler     (melee/range/AOE damage, responses, abilities)
                      ├─ MoveHandler       (pathing + placement)
                      └─ UnitsHolder/Grid  (board & unit state)
```

## What's inside

Everything is re-exported from the package root (`@heroesofcrypto/common`):

| Area | Key exports |
| --- | --- |
| **Engine** | `GameActionEngine`, `actions`, `events`, `TurnEngine`, runtime |
| **Combat** | `AttackHandler`, `MoveHandler` |
| **Units** | `Unit`, `UnitsHolder`, unit properties |
| **Abilities / Spells / Effects** | `AllAbilities`, `AbilityFactory`, `Spell` / `SpellHelper`, `EffectFactory` / `EffectHelper`, auras |
| **Synergies / Augments / Picks** | faction synergies, pre-fight augments, draft helpers |
| **Grid & pathfinding** | `GridSettings`, `GridMath`, `GridConstants`, `PathHelper`, square/rectangle placement |
| **Fights** | `FightProperties`, `FightStateManager` |
| **AI** | `AI` (heuristic move/target selection) |
| **Config** | `HoCConfig` (creature/ability/spell configs), `creatures.json` |
| **Utils & wire format** | `HoCLib`, `HoCMath`, `HoCConstants`, generated protobuf messages |

```ts
import {
    GameActionEngine,
    UnitsHolder,
    GridSettings,
    AttackHandler,
    HoCConfig,
    AI,
} from "@heroesofcrypto/common";
```

> The package is published source-first (`main` / `types` point at `src/index.ts`) and is consumed as
> a workspace dependency / git submodule by the client and server, so they always build against the
> exact same code.

## Project structure

```
src/
├── engine/         action engine, actions, events, turn engine, runtime
├── handlers/       attack & move resolution
├── units/          Unit, UnitsHolder, unit properties
├── abilities/      ability factory + per-ability logic
├── spells/         spells, applied spells, spell helpers
├── effects/        buffs/debuffs, auras, effect factory
├── synergies/      faction synergy bonuses
├── augments/       pre-fight augments
├── picks/          draft / pick-ban helpers
├── grid/           grid, pathfinding, placement geometry
├── fights/         fight properties & global fight state
├── ai/             heuristic AI
├── obstacles/      board obstacles / terrain
├── factions/       faction types & mappings
├── configuration/  creature/ability/spell JSON + config provider
├── messaging/      event-source plumbing
├── scene/          render-facing interfaces (logs, stats, animations)
├── generated/      generated protobuf types
└── utils/          math, helpers, constants
```

## Develop

Runtime: [Bun](https://bun.sh/).

```sh
bun install
bun test                 # unit tests (bun:test)
bun run lint             # eslint + sort-package-json + prettier --check
bun run lint:fix         # auto-fix the above
bun run build            # tests + tsc (tsconfig.build.json) -> dist, copy json/generated
```

> Prettier is pinned to an exact version so CI and local formatting always agree — run `bun install`
> after pulling so your local Prettier matches.

## Contributing

See the [client repo's README](https://github.com/o1dstaRs/heroes-of-crypto-client/blob/main/README.md)
for the contribution guide and overall project setup.

## License

[MIT](LICENSE)

---

<img src="https://cdn-images-1.medium.com/max/1600/1*C87EjxGeMPrkTuVRVWVg4w.png" width="225"></img>
