# Heroes of Crypto — Common

<p align="center">
  <a href="https://github.com/o1dstaRs/heroes-of-crypto-common/actions/workflows/ci.yml">
    <img src="https://github.com/o1dstaRs/heroes-of-crypto-common/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://bun.sh/">
    <img src="https://img.shields.io/badge/Bun-1.4-fa9b3b.svg?logo=bun&logoColor=white" alt="Bun">
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

| Area                             | Key exports                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Engine**                       | `GameActionEngine`, `actions`, `events`, `TurnEngine`, runtime                                     |
| **Combat**                       | `AttackHandler`, `MoveHandler`                                                                     |
| **Units**                        | `Unit`, `UnitsHolder`, unit properties                                                             |
| **Abilities / Spells / Effects** | `AllAbilities`, `AbilityFactory`, `Spell` / `SpellHelper`, `EffectFactory` / `EffectHelper`, auras |
| **Synergies / Augments / Picks** | faction synergies, pre-fight augments, draft helpers                                               |
| **Grid & pathfinding**           | `GridSettings`, `GridMath`, `GridConstants`, `PathHelper`, square/rectangle placement              |
| **Fights**                       | `FightProperties`, `FightStateManager`                                                             |
| **AI**                           | `AI` (heuristic move/target selection)                                                             |
| **Config**                       | `HoCConfig` (creature/ability/spell configs), `creatures.json`                                     |
| **Utils & wire format**          | `HoCLib`, `HoCMath`, `HoCConstants`, generated protobuf messages                                   |

```ts
import { GameActionEngine, UnitsHolder, GridSettings, AttackHandler, HoCConfig, AI } from "@heroesofcrypto/common";
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

Runtime: [Bun](https://bun.sh/) 1.4 or newer.

```sh
bun install
bun test                 # unit tests (bun:test)
bun run lint             # eslint + sort-package-json + prettier --check
bun run lint:fix         # auto-fix the above
bun run build            # tests + tsc (tsconfig.build.json) -> dist, copy json/generated
```

> Prettier is pinned to an exact version so CI and local formatting always agree — run `bun install`
> after pulling so your local Prettier matches.

## Premium evidence collection

The opt-in `premium-ranked-v3` study reuses the seven-cohort runner. It requires
`a19-work` and enables evidence capture automatically. The default balance study
retains its existing policy and output format.

```sh
# Small structural check, with outputs on local storage outside Git.
AI_META_STUDY_PROFILE=premium-ranked-v3 bun src/simulation/measure_ai_meta_cohorts.ts \
  6 85000717 sim-out/premium-smoke 1 ranked-draft,uniform-mixed 1 a19-work

# Build an explicitly non-serving development snapshot from that smoke run.
bun src/simulation/build_premium_evidence_snapshot.ts \
  sim-out/premium-smoke/ai-meta.summary.json sim-out/premium-smoke/evidence.sqlite --development
```

For the baseline, use **10,000 fights per cohort** (70,000 total), all seven cohorts,
and a frozen clean source revision. Premium also accepts any positive even fight
count for exact-size pilots (for example 500); its summary records the small map
remainder explicitly. The legacy study still requires divisibility by six. Choose worker count after checking the host's
available capacity. Existing process sharding works unchanged; keep the study
profile environment on every shard. The summary includes the study profile in
its merge identity, so it cannot be mixed with legacy data.

Historical `premium-ranked-v1` / `v2` archives cover only the five-axis augment
catalog (273 allocations); they never sampled paid Empower. They remain readable,
but must not be relabeled as V3 or used to compare Empower builds. The new
`six-axis-empower-v1` capability identifies a full-domain snapshot. The audit reports
both the collected domain and all 783 live allocations, including structural gaps.
No suffix in an augment ID means Empower 0; `-E1`, `-E2`, `-E3` encode paid levels.

This profile:

- Uses the ranked live draft selector with the recorded `ranked-unit-strength-a19-side-v4-w16-r4`
  spec, revealed map, and seeded synergy variants; explores 20% of visible choices.
  It intentionally samples all three doctrines uniformly and skips optional bans.
- Preserves selected starting-bundle and Tier-2 artifacts. Synthetic cohorts have
  no draft history and keep their separately sampled setup artifacts.
- Uses the six-axis augment catalog including Empower: 186 five-point, 267 six-point,
  and 330 seven-point plans (783 total), with full-budget allocations only.
  Setup and board placement receive public enemy identities, matching current ranked
  defaults. Enemy positions, artifacts, augments and split amounts remain private.
- Uses side-oriented placement and archives seeded mountain cells, split ancestry,
  both seat formations, effective opening units and board objects, committed fight
  events, turn execution traces, terminal units and engine damage-display tallies,
  and sampling probabilities. Display tallies retain their original creature/team/lap
  scope; they are not a complete mitigation or causal damage ledger.
- Replays recorded drafts through the shared reducer during validation to check
  offers, private visibility, collisions, transcripts, and final rosters.

The study is a coverage policy, not an evaluation of the deployed server's exact
policy or a trained Premium advisor. Its setup scorer and split policy are still
heuristics. Full damage attribution, optional-ban coverage, focused interventions,
and held-out advisor evaluation remain separate work.

`build_premium_evidence_snapshot.ts` streams and validates the compressed archives
into an immutable, indexed SQLite file. Without `--development`, it requires a
six-axis `premium-ranked-v3` / V5 evidence, a clean source and at least 10,000 fights in every cohort, with complete committed
health capture. It refuses incomplete or
incompatible input, duplicate families, and overwrites. Archive hashes and exact
source-line references are retained. Add `--include-traces` to embed independently
compressed, checksummed family records for direct lookup; otherwise combat traces
remain in the archives. Both modes retain indexed draft observations and formations.

New V4 captures also retain `premium-combat-participation-v1` summaries derived
only from committed events. They track per-stack activation/action timing, spell
casts, received/resisted effects, spell healing and resurrection HP, summon
ancestry, and known terminal states. Split children retain their drafted identity;
merged summons retain every ancestor instead of inventing exclusive contribution.
Attack responses, passive healing and prevented damage are not complete in these
payloads and are explicitly excluded from the corresponding claims. Old captures
without committed batches remain unavailable, rather than receiving invented zeroes.
The builder can derive the same summaries from older V4 archives without rerunning
combat. `participation(familyId, partition)` retrieves at most two seat-swapped
summaries by index, defaults to the training partition, and requires the
`combat-participation-v1` capability. It does not require full trace storage.

The additive `premium-combat-metrics-v1` capture expands this with detailed reported
HP, explicit damage-source attribution where available, Devour Essence healing,
Water Shield absorption, Flesh Shield redirected HP, poison/fire-wall/Armageddon
damage, missed hits, control skips, morale, activation/first-offense timing, explicit
movement, opening footprint distances, spell outcomes, and ability transfers.
Duplicate hit/splash/flight representations are counted once. Legacy headline damage
is excluded because it need not equal actual HP lost. Attack responses and passive
regeneration remain incomplete; secondary/legacy-splash ownership stays unknown.
Absorption and healing never count as damage, and redirected HP is not labeled
counterfactual prevention. Creature losses are reported losses, not permanent kills.

`combatMetrics(familyId, partition)` retrieves both seats; `unitCombatMetrics({
cohort, creatureId, ...contextFilters })` returns 16 indexed descriptive metrics with
family support and observed min/max family means. It reuses the evidence reader's
map, enemy, artifact, doctrine, plan and synergy filters. Split children are summed
under their drafted identity, then seats and independent families are averaged;
summoned output is excluded from these unit aggregates. Unsupported contexts return
null means. These are policy-conditional observations, not causal pick effects or
confidence bounds. Both methods require `combat-metrics-v1` and default to training
data. Existing V4 archives can derive these metrics without replay or relabeling;
archives without committed events do not receive fabricated metrics.

New captures additionally record `premium-health-ledger-v1`: actual damage
(including retaliation), healing, resurrection and Wild Regeneration during
committed engine operations. Speculative search is excluded. Before/after HP,
creature counts and capacity reconcile across operations; direct stat/quantity
changes remain separate from healing or damage. Unknown source IDs stay unknown.

`healthSummary(familyId, partition)` returns the two compact seat summaries.
`unitHealthMetrics({ cohort, creatureId, ...contextFilters })` returns nine incoming
health metrics for `committed-health-v1`; the additional
`committed-health-unit-v2` capability adds actual attributed damage dealt and lethal
damage-call counts. Physical drafted stacks include their split children and any
merged reinforcements, but exclude standalone summons. Event HP and health-ledger
HP overlap and must never be added. Older snapshots without this capture fail
explicitly. Partial health coverage cannot publish biased averages.

All unit metric queries count distinct fights separately from
`armyFightObservations`; both armies in one fight do not create two fights.
Independent families remain the support denominator. Exact synergy-state filters
accept level 0 (rolled but inactive) as well as active levels 1–3; omitting the
level matches the rolled variant regardless of activation. This distinction
matters when comparing Supply, flying armor and other randomized strategies.

`PremiumEvidenceSnapshot` in `src/simulation/premium_evidence_snapshot.ts` opens the
file read-only and checks the expected simulation source fingerprint. Its bounded
query API combines own/opponent unit IDs, artifacts, doctrine, complete augment
plan, map, seeded variants, and active synergy levels. Every query explicitly
selects a cohort; the default partition is `train`. It returns seat-paired observed
scores, independent-family support, conservative uncertainty, and traceable
examples. These are **associations**, not causal counter-pick gains or calibrated
live win predictions. No model has been fitted by this builder.

The `draftSupport` API filters pre-action observations rather than completed armies.
Starting bundles use their actual L1/L2/artifact tuple, never an offer index. Hidden
maps and future picks therefore cannot supply evidence for earlier choices.
`examples` returns up to three historical draft/formation families; optional `trace`
lookup returns one archived family for internal analysis, not a prompt-sized tool
response. An application gateway must still enforce current-player visibility.

The reader also supports a CLI:

```sh
bun src/simulation/premium_evidence_snapshot.ts \
  sim-out/premium-smoke/evidence.sqlite "$HOC_EXPECTED_SIM_SOURCE_SHA256" \
  '{"cohort":"ranked-draft","map":1,"partition":"train"}' --development
```

The expected fingerprint comes from the compatible study/deployment configuration.
Development snapshots require explicit reader opt-in. Explicitly enabled test
guidance may use them with sparse-evidence labeling; production requires the
reviewed publication and evaluation gates.
Keep the SQLite file and raw archives server-local; expose evidence packets through
an authenticated entitlement and viewer-visibility gateway when integrating the UI.
This collector and reader do not enable account entitlements or apply game actions.

Validate coverage and retrieval after a run:

```sh
bun src/simulation/audit_premium_evidence.ts \
  sim-out/premium-smoke/ai-meta.summary.json sim-out/premium-smoke/readiness.json \
  sim-out/premium-smoke/evidence.sqlite
```

The audit checks source/archive identity, family uniqueness, map/window counts,
seat-aware deployment legality, captured fields, choice coverage, and training-set
support for held-out contexts. It measures query latency; it does not evaluate a
trained recommendation model. Historical `premium-ranked-v1` archives remain readable and retain their restrictive
private-setup label; that profile is not current ranked setup behavior. V3 pilot
archives also lack effective
board objects and committed events outside decided turns; V4 records both.

For an authorized development pilot from shared, uncommitted work, use
`ai_meta_frozen_source.ts <fresh-directory>` to copy the exact runtime source and
lockfile with a verified origin manifest. This preserves `commonDirty: true` and
never makes the data eligible for a serving candidate. Keep the copied source
unchanged for the entire run and retain it with the data. Ordinary source identity
checks still apply.

## Contributing

See the [client repo's README](https://github.com/o1dstaRs/heroes-of-crypto-client/blob/main/README.md)
for the contribution guide and overall project setup.

## License

[MIT](LICENSE)

---

<img src="https://cdn-images-1.medium.com/max/1600/1*C87EjxGeMPrkTuVRVWVg4w.png" width="225"></img>
