# Zig bridge

The bridge lets TypeScript hand a live battle to the Zig engine and get results back: play it out, compare it, or run
search rollouts on it. It is one-way: Zig never writes a battle back into TypeScript objects.

| Piece | File |
| --- | --- |
| Export a live battle as JSON | `parity/state_export.ts` (`exportBattleState(ctx, harness?)`) |
| Load it into a `State` | `src/snapshot.zig` (`snapshot.load`, `snapshot.unitIds`) |
| Rollouts and play-out | `src/rollout.zig` (`rollout.run`, `rollout.play`, the policy registry) |
| State digest as JSON | `src/digest.zig` (the columns of `parity/digest.ts`) |
| C ABI and shared library | `src/ffi.zig`, `zig build lib` |
| bun:ffi binding | `ffi/bridge.ts` (`HocEngine`, `HocState`) |
| Smoke test (export, load, play, compare, overheads) | `ffi/smoke.ts` |
| Oracle: resume mid-battle in both modes | `hoc-sim resume` on a `RECORD_RESUME` recording |
| Debugging a rollout step by step | `hoc-sim rollout-trace <state.json> <request.json> [--pair K] [--digests]` |

```bash
cd zig && zig build -Drelease=true && zig build lib -Drelease=true && cd ..   # hoc-sim and libhocsim
bun zig/ffi/smoke.ts 24 9000                         # batches 1 and 2 kept; SMOKE_KEEP=none for ability-free
RECORD_RESUME=random:2 bun zig/parity/record.ts 300 8100000 /tmp/r.jsonl && zig/zig-out/bin/hoc-sim resume /tmp/r.jsonl
```

The library is `zig/zig-out/lib/libhocsim.dylib` on macOS and `libhocsim.so` on Linux (`HOC_SIM_LIB` overrides the
path in `bridge.ts`). For the 9800X3D, add `-Dtarget=x86_64-linux-gnu -Dcpu=znver5` (a shared library for glibc).

Every artifact links the C library: the learned leaves' sigmoid calls libc's `exp`, because Bun's `Math.exp` is the
platform libm's and exact ties decide choices. On Linux build against the system glibc (`x86_64-linux-gnu`, dynamic),
never static musl, whose `exp` can differ in the last bit. Checked on the 9800X3D (glibc 2.39, Bun 1.4.5) on
2026-11-25: Bun's `Math.exp` equals glibc's `exp` (through bun:ffi) on 4,000,010 inputs, and the cross-built `.so`
returned 2,560 of 2,560 rollout values (v1 and v2 leaves) and 160 of 160 turn counts bit-identical to the macOS
library on the same requests. The production host was not checked; repeat the check there before relying on it.

## The state format (export version 2)

`exportBattleState(ctx, harness?)` with `ctx = { unitsHolder, grid, fightProperties, attackHandler }` (runMatch's
`beforeFightStart` context, or the server's engine objects). The raw fields use the field lists of
`src/simulation/battle_snapshot.ts`, with its fail-closed coverage check (a new TypeScript field that no list classifies
throws at export). Tags: `{$map: [[k, v]...]}`, `{$set: [...]}`, `{$denque: [...]}`, `{$num: "-0" | "NaN" |
"Infinity"}`, `{$undefined: true}`, `$class` on class instances; functions are dropped.

| Key | Content |
| --- | --- |
| `version` | 2 (the loader refuses anything else) |
| `units[]` | `{id, name, creatureId, team, unitType, summoned, fields}` in the holder's insertion order (summoned units included); `fields` = the unit's own fields (`unitProperties`, `initialUnitProperties`, `buffs`, `debuffs`, `effects`, `abilities` (the ACTIVE list), `auraEffects`, `position`, `possibleAttackTypes`, turn flags, `adjustedBaseStatsLaps`, `luckPerTurn`, ...) |
| `grid` | `boardCoord`, `cellsByUnitId`, `boardAggrPerTeam`, `gridType`, the terrain fields, artifact barrels |
| `fight` | FightProperties' fields: lap, flags, queues, sets, setup maps, hit counters, smoke, vines, fire walls |
| `holder` | UnitsHolder's: distances, Ember Covenant, the aura refresh caches |
| `aiTargetMemory` | `[[attackerId, targetId]...]` (ai.ts previousTargetsByBattle) |
| `damageStatLaps` | the laps of the damage-statistic entries (runMatch's `damageDealtThisLap` reads them) |
| `configs` | `{abilityConfigs, effectConfigs, auraEffectConfigs, spellConfigs, summonTemplates?}`: the configs of every ability and aura on the board, Poison, Break and the Ember Covenant spell, in the shape of a recording's start state; with an Infest unit on the board, the summon templates (createUnitFromSpec's props of "Arachna Spider" and "Arachna Queen") and their abilities' and auras' configs |
| `setup` | `{lapsTillNarrowing, perTeam: {"2": {...}, "1": {...}}}`: getAdditionalAbilityPower / MovementSteps / FlyArmor / Morale / Luck / Supply / AuraRange PerTeam and getBreakChancePerTeam |
| `harness` | optional `{rng, activeUnitId, uuidSequence, seed?, summonSequence?, armyProfile?}`: the mulberry32 state, runMatch's currentActiveUnitId ("" = none), lib.ts deterministicUuidSequence, the parts of a summon's id (the battle seed and runMatch's createSummonedUnit counter; without them a summon cannot be named, and the play-out reports the overflow), and v0.7's army profile per team (below) |

`configs`, `setup`, `name` and `creatureId` are there so the loader never recomputes TypeScript logic it does not port.

`harness.armyProfile` is `{"1": {meleeMagic, auraSaturated} | null, "2": ...}`: the immutable profile
StrategyV0_7.primeArmyProfile computes at placement (the team's MELEE_MAGIC stack count and whether every stack emits
an aura), which the v0.8 policy reads. It lives on the strategy instance that placed the army, not on the engine
objects, so the caller passes it: `armyProfileAtStart(unitsHolder)` (state_export.ts) computes it at start_fight for a
runMatch harness. `null` (or absent) means the rollout strategy of that team holds no profile, as when a strategy never
placed the army (a late takeover, or the server's `createAIStrategy("v0.8")` model of a human seat); TypeScript then
keeps v0.6's decision, which the port reproduces.
A typical export is 54 to 62 KB (up to about 140 KB with several aura emitters: `holder.teamsAuraEffects` is a third of
it) and takes about 1 ms to build and stringify.

### Who owns which field

Read into the Zig `State` (`snapshot.zig`):

| Zig | From |
| --- | --- |
| unit stats, `init` (BaseStats), team, faction, level, size, footprint, attack and movement types | `unitProperties`, `initialUnitProperties` (`footprint_width/height` must be 1 or 2) |
| `attack_type_selected`, `possible` | `selectedAttackType` (must equal `attack_type_selected`), `possibleAttackTypes` |
| `pos_x/pos_y`, `responded`, `on_hourglass`, `moved_this_turn`, `moved_route_cells`, `luck_per_turn`, `adjusted_laps` | `position`, the flags, `movedRouteCellsThisTurn`, `luckPerTurn`, `adjustedBaseStatsLaps` |
| `buffs`, `debuffs`, `effects` (name, laps, power, order) | the props' `applied_*` arrays, cross-checked against the AppliedSpell / Effect objects |
| buff and debuff `src_x/src_y` | `firstSpellProperty` / `secondSpellProperty` of aura rows (the Web Aura debuff row too) and augments |
| `abilities` (the active list, in order), `ability_mask`, `Ability.aura`, `auras`, `State.aura_defs` | the Ability objects' names and `aura_effects` with `configs` (engine.loadUnitAbilities / loadAuras), checked against the AuraEffect objects |
| `luck_dependent`, `stolen` | `props.abilities` (the card list: the early luck pass reads card names), `props.stolen_abilities` |
| `web_locked`, `rallying_volley_granted` | `props.web_movement_locked`, `props.rallying_volley_granted` |
| `uid`, `uuid` | the unit's index in the id list, its id parsed as a canonical UUID |
| `State.summons`, `summon_seq`, `uuid_seq`, `seed`, `next_uid` | `configs.summonTemplates` (interned), `harness.summonSequence`, `harness.uuidSequence`, `harness.seed`; the caller's next uid (default: the id list's length) |
| the handle's creature names (by `name_id`) and army profiles | `units[].name` and the summon templates' names; `harness.armyProfile` |
| `target` | `props.target` |
| `name_id`, `creature_id` | `name`, `creatureId` |
| `reg`, `grid.board`, `grid.aggr` | `cellsByUnitId`, `boardCoord` ("" / id / "H" / "B" / "L"), `boardAggrPerTeam` |
| `grid.terrain`, `fight.hits_*` | `scatteredMountainLayout`, `scatteredMountainsStanding` (packed `(x << 8) \| y`), the cleared sides, `cleanedUpCenter`, `obstacleHitsLeft*`; every "B" and "L" must be where the terrain says |
| `fight` laps, flags, queues, `made` / `hourglass_set` / `replied` (and `removed_*` for the removed ids they name), `damage_laps`, `team_units_alive` | the FightProperties fields (`alreadyMadeTurnByTeam` must agree with `alreadyMadeTurn`) |
| `fight.laps_till_narrowing`, `State.setup`, `Unit.syn_power` | `setup` |
| `dist_known/dist_closest_enemy`, `ember_seeded`, `ember_teams` | `holder` |
| `ai_prev_target`, `damage_lap` | `aiTargetMemory`, max of `damageStatLaps` |
| `rng`, `active` | `harness` (or the caller: `hoc-sim resume` passes the recorded values) |
| `blessings`, `auras`, `stat_hooks`, `augments`, Poison / Break / Ember Covenant config | derived as at a battle start (engine.loadScopeFlags) |

Unit ids and slots: a unit's uid is its index in the id list: with a recording, the recording's ids (start units, then
`summonIds`; `hoc-sim resume` passes the next uid from the point's `summonsCreated`); without one (the C ABI), the
holder's units in order, then the ids of removed units that the turn sets, the AI target memory or the distances still
name (at most 255). The holder's units take slots 0.. in holder order; removed units named by the turn sets are kept by
uid (`Fight.removed_*`); AI memory and distance entries of removed units are dropped (a removed id matches no living
unit again). The handle keeps the id strings: requests and digests speak ids, and `hoc_play_v01` appends the ids of
the units it summons (`rollout.SummonIds`).

Ignored (read by nothing in scope, or a cache the port recomputes): `renderPosition`, `maxRangeShots` (Limited Supply),
`unitIdToTeam`, `availableCenterStart/End`, `placementType`, the turn timers, the per-team augment, doctrine and synergy
maps (their effect arrives through the buffs and `setup`), `teamsAuraEffects`, `auraRefreshFingerprint`,
`auraRefreshKnownEmpty` (the port runs the full aura refresh every time), descriptions and textures,
`bitter_experience_stacks` (a counter nothing reads), Poison's stack count (it only feeds the description), `fight.id`,
`harness.uuidSequence` for naming (a summon takes the createSummonedUnit id unless a rollout request asks for
`summonIds: "uuidSequence"`; the counter itself is loaded and counts every summon).

Refused as an unsupported state (the loader names what it found): summoned units other than the creatures Infest raises
and non-creature units; spells other than the spell entries of inert castable abilities (Vine Throw, on a Trent or a
thief); artifact-granted abilities; a forbidden target; Helping Hand; ranked `*_authoritative` stats; a spent Water
Shield; Last Fuse; Warlord's Edge or a War Anger attack increase; an unported ability, aura, buff, debuff or effect;
effect stacks other than Poison's; more buffs, debuffs, effects, active or stolen abilities than the lists hold
(14/5/7/10/6); WATER_CENTER or a water cell; artifact barrels; artifacts; legacy-axis seats; smoke clouds, vines or fire
walls; a unit on lava or terrain the board lost; more than 32 units in the holder or 255 ids; units out of holder
order. Malformed input (a missing field, a wrong type, an id no list knows) is
reported as a malformed state.

## The C ABI (`src/ffi.zig`, ABI version 2)

```c
uint32_t hoc_abi_version(void);
uint64_t hoc_now_ns(void);                                  // CLOCK_MONOTONIC ns, the deadline clock
Engine*  hoc_engine_new(void);                              // one per worker thread
void     hoc_engine_free(Engine*);
const char* hoc_last_error(const Engine*);                  // "" after a successful call
Handle*  hoc_state_load(Engine*, const uint8_t* json, size_t len);   // null: unsupported or malformed (see error)
Handle*  hoc_state_clone(Engine*, const Handle*);
void     hoc_state_free(Engine*, Handle*);
int64_t  hoc_state_digest_json(Engine*, const Handle*, uint8_t* out, size_t cap);  // needed length; writes if it fits
int32_t  hoc_state_check_digest(Engine*, const Handle*, const uint8_t* json, size_t len); // 1 same, 0 differs, -1
int32_t  hoc_play_v01(Engine*, Handle*, int32_t max_laps, PlayResult* out);          // plays IN PLACE; 0 or -1
int32_t  hoc_rollouts(Engine*, const Handle*, const uint8_t* req, size_t req_len,
                      double* out_values, size_t out_cap, uint64_t deadline_ns);     // values written, or -1
int32_t  hoc_rollout_stats(const Engine*, RolloutStats* out);                       // of the last hoc_rollouts

struct PlayResult   { int32_t end, winner, lap; uint32_t steps, decisions, rng; };  // 24 bytes
struct RolloutStats { uint64_t turns; uint32_t written; int32_t stop;
                      uint64_t summon_sequence, uuid_sequence; };                   // 32 bytes
```

- `end`: 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (the recovery net). `winner`: the
  fight_finished team (2 LEFT / green, 1 RIGHT / red, 0 none), -1 when unfinished. `stop`: 0 done, 1 deadline, 2 turn
  budget, 3 output full. `summon_sequence` / `uuid_sequence`: runMatch's createSummonedUnit counter and lib.ts
  deterministicUuidSequence after the call (aborted rollouts included), for the next request's start values.
- ABI 2 (2026-11-25): RolloutStats grew the two counters; requests take the v0.8 policy, the antithetic chance, the v1
  and v2 leaves, the sole-Abomination rule, the army profile and the summon counters and id scheme.
- Ownership: an engine owns its error text, its request arena and its rollout scratch state; use one per thread. A
  handle (a state copy plus its id strings) is freed with `hoc_state_free`; any engine may read a handle (rollouts and
  digests copy or read it), but only one call may mutate it at a time (`hoc_play_v01` plays in place: clone first).
- Errors: every call returns -1 or null on failure and sets `hoc_last_error`; nothing prints, nothing panics on bad
  input (integers out of range are refused, not truncated). One caveat for threads: the name in an "unsupported
  ability" message comes from a diagnostic global of engine.zig, so two engines refusing states at the same moment can
  swap names. A refused state reads "unsupported state: ...", a refused request "unsupported request: ...", a rollout that
  reached unported code "unsupported rollout: ..."; the caller falls back to TypeScript for that decision.
- `hoc_state_digest_json` writes `{units, fight, active, rng}` with the record.ts digest columns (setup, terrain and
  batch-3 columns always on; `buffs_sources` and `debuffs_sources` name aura and augment rows only). `hoc_state_check_digest` takes a
  `parity/digest.ts` `battleDigest` and runs `compare.state`.

### `hoc_rollouts`: SearchDriver.rollout and leafValue

Request JSON:

```json
{
  "actor": "<unit id>", "actingTeam": 2, "seedBase": 123456789,
  "chance": "antithetic",
  "horizon": { "mode": "turns", "turns": 64 },
  "leaf": { "kind": "v2", "exactTerminal": true },
  "policies": { "1": { "version": "v0.8", "switches": {} }, "2": { "version": "v0.8" } },
  "candidates": [ { "kind": "incumbent", "actions": [ /* GameAction */ ] }, { "kind": "defend", "actions": [...] } ],
  "pairs": [[0, 0], [0, 1], [1, 0], [1, 1]],
  "turnBudget": 4000,
  "soleAbominationDefend": true,
  "armyProfile": { "1": { "meleeMagic": 0, "auraSaturated": false }, "2": null },
  "summonSequence": 3, "uuidSequence": 17, "summonIds": "match"
}
```

Each pair `[c, r]` runs one rollout on a fresh copy of the handle's state, exactly as `SearchDriver.rollout`
(`src/simulation/search_driver.ts`) does: install the chance stream, make the actor active, apply the candidate's
actions (a rejected action of kind `"incumbent"` is skipped as the real loop does, and an incumbent that landed nothing
is -Infinity; any other kind's rejection is -Infinity), defend when nothing landed, end the turn, then let every unit
play its policy (`turns`: N unit turns; `lap`: until the lap flips, at most 64; `reply`: until the opponent has played
one turn, at most 12; `leaf`: none), and score `leafValue` for the actor's team. The values come back in pair order as
exact doubles.

- `chance`: `plain` is `makeRng((seedBase + r * 0x9e3779b1) >>> 0)` (the deep search's and the leaf probes' stream);
  `antithetic` is the stock search's complementary R2 stream, `makeSearchChanceStream(seedBase, r, "actor-antithetic")`
  (`search_chance_sampling.ts`, `rollout(..., complementaryR2 = true)`): every raw draw reads the lap and the active
  unit (the harness's currentActiveUnitId: `""` between turns, so lap-transition draws key on `"<lap>:"`), draws from
  that key's own mulberry32 generator, seeded `(base ^ hashSimulationParts("a19-actor-chance-v1", lap, id)) >>> 0`
  with `base = (seedBase + floor(r / 2) * 0x9e3779b1) >>> 0` and created on first use inside the rollout, and on odd r
  returns the exact complement `1 - v - 2^-32` (the uint32's bitwise NOT). The id is the unit's real id string (a
  summon made inside the rollout is named by its UUID). `seedBase` must be a uint32 and r 0 to 3, as TypeScript
  requires (`rng.Keyed` in `rng.zig` switches the source; `rollout.ActorChance`).
- `policies`: `v0.1` (StrategyV0_1) or `v0.8` (the A19 composite's combat decideTurn: native StrategyV0_8 through
  src/v08's `decideV08`, production switches only; non-empty `switches` are refused). The policy is chosen per unit: a
  mindless ("AI Driven") unit plays v0.1 whatever its seat (aiVersionForUnit; `rollout.isMindless`); no such unit is
  in scope, since the loader refuses the unported "AI Driven" ability.
- `leaf.kind`: `material` (no learned leaf), `v1` (the 20-feature DEFAULT_V07_VALUE_WEIGHTS logistic leaf) or `v2`
  (V08_A13_VALUE_LEAF over the 60 V2 features, what the A19 profile loads; src/v08's `util.leafV2`); `exactTerminal`
  (SEARCH_A19_EXACT_TERMINAL_RESULTS, on in production) scores a finished fight 1, 0 or 0.5 first. The research logit
  adjustments (late-ranged finish, pure-ranged terminal) are zero in production and not modelled.
- `soleAbominationDefend` (SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY=1 in the A19 profile): the acting
  team's last stack, an Abomination facing a lone enemy Abomination that some upcoming Armageddon wave kills first,
  defends instead of asking its policy (`isV08SoleAbominationArmageddonDefendOpportunity`; off by default, as for a
  SearchDriver built outside the profile).
- `armyProfile` overrides the export's `harness.armyProfile` per team.
- Summons: the counters carry over from one rollout to the next and come back in `hoc_rollout_stats`, because
  TypeScript restores neither runMatch's createSummonedUnit counter nor lib.ts deterministicUuidSequence per rollout
  (later rollouts' summons get later ids, and the ids key the antithetic stream). `summonSequence` / `uuidSequence`
  give the first rollout's values (default: the export's harness values). `summonIds`: `match` names a summon as
  runMatch's createSummonedUnit does (`deterministicSimulationId("summon", seed, ..., sequence)`); `uuidSequence` keeps
  the id createSecureUuid gives under a seeded source, the "sim" UUID of deterministicUuidSequence, as the server's
  createSummonedUnit does inside its search. Every summon takes one value of each counter (UnitProperties' id is
  allocated in both cases).

The v0.8 policy reads a per-battle table besides the State (`v08/util.zig` `battle`: each slot's creature, its id rank
for the TypeScript id tie-breaks, and the army profile). It is a thread-local, so `hoc_rollouts` builds it on the
calling thread at every call (`rollout.battleTable` over the root's slots, names by Unit.name_id from the handle,
`Battle.fromUnits`), restores it at each rollout's start and rebuilds it after a summon (a new uid, possibly in a reused
slot). A team without a profile is passed as melee_magic 255 (v0.7's finalizeDecision then keeps v0.6's decision, the
port's anchor-army path; nothing else reads the count).

Scope of the v0.8 policy (`rollout.v08Scope`, checked on the root; no ability can appear inside a rollout from a root
without one): src/v08 is checked on ability-free battles and treats every ability, aura and ability-born buff as
absent, so a request with a v0.8 seat is refused when any holder unit carries an ability, a stolen ability, an aura,
ability state (a Web lock, Rallying Volley arrows, a forced target) or a buff, debuff or effect other than morale,
dismorale, Break and the augments, or when an Ember Covenant ring stands. Two further refusals cover gaps of src/v08 at
common `58d5ae7c`, until its owner applies the patches below: a removed unit still in alreadyMadeTurn, and an Angel or
Arachna Queen on a team with a synergy aura range.

The call stops early, keeping the prefix, when `deadline_ns` passes (checked where `assertBeforeDecisionDeadline` is:
before each pair, action and turn, and before the leaf), when the rollout turns played exceed `turnBudget`
(TypeScript's `rolloutTurnLimit - rolloutTurnsTotal`; the turn that exceeds it drops its rollout, as the assertion
does), or when `out_cap` is full. `hoc_rollout_stats` gives the turns played (aborted rollouts included, as
`counters.rolloutTurnsTotal` counts them), the stop reason and the counters.

Refused (the call fails, never guesses): the cases above, an action type outside the engine port, a rollout whose
policy turn lands nothing (the recovery net, `advanceTowardEnemyAction`, is not ported), a v0.8 decision that needs a
pass src/v08 lacks (`decideV08` returns false), a stalled queue with living units (`forceStalledLap`), and a capacity
of the port (unit slots, ids, lists, 1,024 antithetic keys per rollout). Not modelled: an opponent model
(`SEARCH_OPP_MODEL`, empty in production) and the material sample of `scoreCandidates`.

### Traps for a caller

- The rollout policy object must be the one the search uses: `getAIStrategy("v0.8")` / `createV08A19Strategy()`,
  version string `"v0.8"`. v0.8's ranged positioning runs only for versions in `V08_RANGED_POSITION_VERSIONS` (default
  `"v0.8"`), and the port always runs it (production): a TypeScript reference built on the `v0.8s` alias (StrategyV0_8
  itself, version "v0.8s") skips it and differs.
- The army profile is per strategy instance: runMatch builds one A19 composite per team, each primed only for its own
  team at placement, and the registry singleton `getAIStrategy("v0.8")` has none for a runMatch battle. A reference
  whose rollout strategy differs from the one that placed the army differs from the request unless `armyProfile` says
  so.
- Rollouts run the policy in the scoped A19 environment (`withScopedAIEnvironment(buildV08A19SearchEnvironment())`);
  src/v08 bakes that environment's values. In scope the plain process environment gives the same decisions.

## How it is checked

- `hoc-sim resume <recording>`: a `RECORD_RESUME` recording embeds exports at decision boundaries (an advance has just
  selected the unit; its decideTurn has not run). For each one the loader's state must equal the recorded digest of the
  step before, and then both the replay of every remaining engine step and native play from there (`ai.continueMatchWith`)
  must match every remaining step exactly (action, random stream, accept/reject, events, digest). A negative check:
  dropping the AI target memory from the exports breaks 65 of 300 native resumes, the distances 19 of 300, the damage
  laps 48 of 300.
- `ffi/smoke.ts`: exports live battles mid-fight, loads each through the library, plays a clone out, and requires the
  same final random state, lap, winner, end reason and final digest as the TypeScript continuation, the same result
  from `hoc-sim play-state` (a separate process), deterministic rollouts with values in [0, 1] or -Infinity, a past
  deadline that stops the call and a turn budget that keeps a prefix, and an unchanged handle afterwards.
- Rollouts against TypeScript (a scratch harness, `SearchDriver` built over the match's own objects with
  `snapshotBattle` / `restoreBattle` around each private `rollout` call): every value bit for bit and the same rollout
  turn counts.
- v0.8 rollouts against TypeScript (a scratch harness): native v0.8 battles (`V08_A19_SEARCH=0`, one
  `createV08A19Strategy()` per team passed as runMatch's strategy overrides) at the README's production-like setup; at
  about three random decisions per battle (index 1 on) it exports the state with `armyProfileAtStart`, takes the
  production incumbent, and runs `SearchDriver.rollout` of `createV08A19Strategy`'s driver
  (`createV08A19SearchDriver(deps, {seed, offlineDeterministicWork: true}, undefined, {neuralCorrection: false})`, the
  rollout policy each team's composite) inside `withSearchEnvironment` / `withScopedAIEnvironment` of
  `buildV08A19SearchEnvironment()`, against `hoc_rollouts` with v0.8 on both seats: candidates incumbent, defend, wait
  and end turn, r = 0..3, chance plain and antithetic, horizons turns 12, turns 64, lap, reply and leaf. One
  TypeScript rollout feeds every leaf: a tap on `leafValue` evaluates material, v1 and v2 with exact terminals on and
  off on the same final state. Each root also runs a turn-budget bank (half the turns of its antithetic H64 bank; the
  prefix, stop reason and turns must match), the summon counters must match after every bank, and on odd seeds RED's
  rollout model is a fresh composite that never placed the army (no army profile, the server's model of a human seat).
  With `POLICY=v0.1` the same roots run v0.1 rollouts (the kept batches, summons and antithetic keys on summon ids);
  `SUMMON_IDS=uuid` names summons as the server does (createSecureUuid under the seeded source) in both engines.
- `hoc-sim rollout-trace <state.json> <request.json> [--pair K] [--digests]` prints every step of one rollout (engine
  calls with a unit digest, each v0.8 layer's output, the wait scorer's features, each decision; with `--digests` the
  digest.zig state at each decision), the format the scratch harness writes for the TypeScript side, so the first
  differing step shows where a rollout leaves TypeScript's.

Results with v0.8 rollouts on 2026-11-25 (common `58d5ae7c` plus this change; production-like setup, side boards, maps
mixed by seed):

- v0.8 on both seats, ability-free production-like battles (every ability stripped: src/v08's scope), 150 battles
  (seeds 11000000-11000149), 348 roots at decisions spread through the battles: 230 roots compared and 220,800 of
  220,800 values bit-identical to `SearchDriver.rollout` (plain and antithetic 110,400 each; turns 12, turns 64, lap,
  reply and leaf 44,160 each; material, v1 and v2, with and without exact terminals, 36,800 each; 13,680 -Infinity),
  the same 2,273,304 rollout turns in all 13,800 banks, the turn-budget bank identical at all 230 roots (prefix, stop
  reason, turns), the summon counters identical after every bank, and 165 sole-Abomination defends taken on both
  sides. Half the battles model RED with a composite that never placed it (no army profile). 118 roots refused by the
  two src/v08 gap checks (102 a removed unit in alreadyMadeTurn, 16 an Angel with a synergy aura range).
- The same battles with both src/v08 patches applied (a scratch build without the two checks): all 348 roots, 334,080 of
  334,080 values and 3,183,738 rollout turns identical. An earlier run (seeds 10400000-10400149): 249,600 of 249,600
  on 260 roots, and 339,840 of 339,840 on all 354 roots patched.
- The TypeScript rollouts in the plain process environment instead of the A19 profile: 9,600 of 9,600 (seeds
  11500000-11500005, 10 roots compared).
- v0.1 rollouts on such roots with batches 1 to 3 kept: 48,000 of 48,000 (seeds 11300000-11300019, 50 roots, 2,572
  summons inside rollouts, antithetic keys on summon ids) and, with the server's summon ids (`summonIds:
  "uuidSequence"`), 49,920 of 49,920 (11400000-11400019, 52 roots, 3,358 summons); 3 roots refused at load (a Vine
  Throw cast state). Before the holder-ordered leaf copy, 16 of 48,000 v2 values differed in the last bit (gap 3).
- v0.8 with batches 1 to 3 kept: every root refused at the default keep rate (40 battles from 11100000, 102 roots), 145
  of 146 at keep rate 0.15 (60 battles from 11200000; 4 at load for Vine Throw, the compared root 960 of 960).
- Unchanged: the v0.1 rollout comparison 15,520 of 15,520 with batches 1 and 2 kept (seeds 7800-7899) and 15,520 of
  15,520 ability-free (7900-7999), the same turn counts; `check.sh 300 8400000` classic and production-like batches 1
  to 3 kept `check.sh 300 9800000`, both modes, with 600 resume points each identical; `ffi/smoke.ts` 30 battles with
  batches 1 and 2 kept (9100) and 30 with batches 1 to 3 (9400); the default recorder output byte-identical to the
  previous recorder's (classic 1001-1020, production-like kept with resume points 3001-3015); `zig build test`.

Speed (M4 Max at load average 150 to 170 from other jobs; per root the stock bank (antithetic H64, r 0..1) and a deep
bank (plain H64, r 0..7) over four candidates, TypeScript and Zig interleaved three times and the median taken, then
the median over roots; three passes: 19 roots from 11600000, 37 and 32 roots from 11700000 and 11700010). TypeScript
is `SearchDriver.rollout` alone (snapshot and restore outside the timer); Zig is the whole `hoc_rollouts` call through
bun:ffi (request parse, a state copy per pair), v0.8 on both seats with the v2 leaf and exact terminals:

| | stock bank (antithetic, R2) | deep bank (plain, R8) |
| --- | --- | --- |
| TypeScript, per rollout turn | 325 to 364 us | 320 to 360 us |
| Zig, per rollout turn | 9.3 to 10.2 us | 8.3 to 13.5 us |
| TypeScript, per rollout | 7.6 to 13.1 ms | 10.8 to 13.4 ms |
| Zig, per rollout | 0.27 to 0.41 ms | 0.29 to 0.48 ms |
| per rollout, TypeScript / Zig (median of the roots' ratios) | 31 to 36 | 28 to 40 |
| turns per rollout (median) | 28 to 35 | 27 to 35 |

At the probe's 1,200 rollout turns per searched decision that is about 0.4 s of TypeScript against 12 ms natively.

Results with batch 3 on 2026-11-25 (common `ec55af8b`):

- `hoc-sim resume`, every point identical in both modes and every loaded state equal to its recorded digest: 8,000
  points from production-like recordings (2,500 battles with batch 3 kept, 5,000 points, 459,998 remaining steps; 1,500
  battles with batches 1 to 3 kept, 3,000 points, 266,545 steps; seeds in README.md), with summoned units, stolen
  abilities, Web locks, Stuns, Rallying Volley arrows and removed ids in the turn sets at the points; production-like
  batches 1 and 2 kept, 300 battles, 600 points (8500000); 0 refused.
- `ffi/smoke.ts`: 12 battles with batches 1 and 2 kept (seeds 9100-9111), and 30 each with batch 3 (9300-9329) and with
  batches 1 to 3 kept (9400-9429) through `SMOKE_KEEP`, every check passing (play-outs that summon included).
- Rollouts: 6,240 and 4,640 values identical to `SearchDriver.rollout` (seeds 7800-7839 batches 1+2, 7900-7929
  ability-free), and 6,240 and 6,400 with batches 1 to 3 (7800-7839) and batch 3 (8800-8839) kept, the same rollout turn
  counts.
- A rollout whose state exceeds a capacity of the port (`State.overflow`: unit slots, ids, lists, a summon without its
  id parts) fails with "unsupported rollout"; the caller falls back to TypeScript.

Results on 2026-11-25 (common `50ae51c2` plus this change):

- `hoc-sim resume`, every point identical in both modes and every loaded state equal to its recorded digest: classic
  NORMAL ability-free 300 battles, 600 points, 51,645 remaining steps (seeds 8100000-8100299); production-like setup
  ability-free 300 battles, 600 points, 45,963 steps (8200000-8200299); production-like with batches 1 and 2 kept 500
  battles, 1,250 points, 106,531 steps (8300000-8300249 at the default keep rate, 8310000-8310249 at keep rate 1);
  points spread early / mid / late (thirds of the battle's steps) 779 / 836 / 835; 0 refused.
- `ffi/smoke.ts`: 30 battles with batches 1 and 2 kept (seeds 9100-9129) and 30 ability-free (9200-9229), side
  NORMAL / LAVA / BLOCK in turn, every check passing.
- Rollouts: 34,240 of 34,240 values identical to `SearchDriver.rollout` (214 battles, seeds 7800-7899 and 8800-8819 kept,
  7900-7999 ability-free; incumbent, defend, wait and end-turn candidates; r = 0..3; horizons turns 12, turns 64, lap,
  reply and leaf; exact terminal on and off; 2,200 -Infinity), and the same 316,892 rollout turns.

Overheads (M4 Max, busy host, load average 30 to 45; the rollout turn ratio is from the comparison harness, where
both sides ran the same rollouts):

| | |
| --- | --- |
| export (exportBattleState + JSON.stringify), TypeScript | 0.9 to 1.25 ms, 54 to 62 KB |
| `hoc_state_load` through FFI (JSON parse + load) | 276 to 450 us (load from a parsed tree alone: 40 to 110 us) |
| an FFI call | 4 to 8 ns (`hoc_abi_version`), 27 to 53 ns (`hoc_now_ns`) |
| rollout turn, v0.1 seats | Zig 5.5 to 6.3 us; TypeScript `SearchDriver.rollout` 138 to 213 us (23 to 37 times) |
| rollout turn, v0.8 seats, v2 leaf | Zig 8.3 to 13.5 us; TypeScript 320 to 364 us (the speed table below the v0.8 results) |
| rollout (12-turn, lap and reply horizons) | Zig 52 to 69 us |

The load is paid once per root decision: under 0.01% of a 4 s think. If it ever matters, the export's caches
(`teamsAuraEffects`, `auraRefreshFingerprint`, descriptions) can be left out of a bridge export, or the format replaced
by a flat binary one.

## Extending it when new state is ported

1. Port the rule and its state into `State` as usual (the README's porting notes), and extend `compare.state` and the
   recorder's digest when the state is observable.
2. In `snapshot.zig`, read the new field from the export (the raw TypeScript field, or a value added to the export's
   `configs` / `setup` when it needs unported TypeScript to compute), and remove its refusal (`checkUnitScope`,
   `requireEmpty` in `loadGrid` / `loadFight`, `INERT_ABILITY_SPELLS`). Keep every other refusal: the loader must refuse
   what the port cannot play.
3. When TypeScript gains a field, the export's coverage check throws until `state_export.ts` classifies it; then decide
   here: read it, ignore it (say why in the list above), or refuse non-empty values.
4. Record with `RECORD_RESUME` in the new scope and run `hoc-sim resume`; it checks the loaded state against the
   recorded digest and every step after it. Then `ffi/smoke.ts` and the rollout comparison.
5. Bump `ABI_VERSION` (ffi.zig and bridge.ts) on any change to a signature, a struct layout or the request format, and
   the export `version` (state_export.ts, `snapshot.FORMAT_VERSION`) on a format change.

## Known gaps of src/v08 (owner: the v0.8 port)

Found by the v0.8 rollout comparison on ability-free production-like battles. Each is gated in `rollout.v08Scope`
(the request is refused) until the patch lands; with both patches applied every root compared identical (below).

1. `util.waitFeatures` (the wait scorer's `getAlreadyMadeTurnSize()` term, wait feature 25) counts
   `@popCount(s.fight.made)`; TypeScript's alreadyMadeTurn also holds removed units, which a loaded state (and a slot
   a summon reused) keeps in `Fight.removed_made`. Patch: `const made: f64 = @floatFromInt(s.fight.madeCount());`.
   Seen as a wait the port missed (seed 10100078).
2. `lv8.coverageRange` returns 2 for an Angel and 1 otherwise; `v08BacklineProtectorCoverageRange` adds the team's
   synergy aura range (Might, PLUS_AURAS_RANGE) and floors: patch `coverageRange(s, pi)` to
   `@intFromFloat(@max(0, @floor(base + s.setup[s.units[pi].team].aura_range)))` with `base` 2 for an Angel and 1
   otherwise, and pass `s` at its four call sites. Seen as an Angel's backline-protector wait where TypeScript keeps
   the melee attack (seed 10100086, aura range 1).
3. Iteration order: `util.valueFeatures`, `valueFeaturesV2` and `waitFeatures` walk `s.units[0..s.n_units]`, while
   TypeScript walks `unitsHolder.getAllUnits()` (insertion order). They part once a summon takes a reused slot, and the
   float sums (attack, wounded shares, initiative) then differ in the last bit: 16 of 48,000 v2-leaf values with v0.1
   rollouts and batch 3 kept, before `rollout.learnedLeaf` scored such states on a holder-ordered copy. Walking
   `s.holderOrder()` in util (and in the other v0.8 loops, before summons enter its scope) removes the copy.
4. Scope: every level treats abilities, auras and ability-born buffs as absent. With batches 1 to 3 kept the first
   divergences sit in v0.2 (a Peasant with Absorb Penalties Aura waits in TypeScript), v0.4 (Nomad's Rapid Charge; a
   White Tiger beside kept enemies), v0.5 (Crusader's Double Punch, Hydra's Lightning Spin, a Wyvern with Venom Cloud
   Aura: auraFlyerSupport), and `decideV08` returns false on 192 of 1,620 batches; the recovery net fails 48 more where
   a port decision landed nothing (12 battles from seed 9970000, before the scope check existed). Until the levels port the kept abilities, the bridge refuses such roots.

## Growing into the search

`hoc_rollouts` is the per-rollout seam the TypeScript SearchDriver can call (phase 1 of the A19 port plan): the driver
keeps enumeration, shortlists, pruning and arbitration, and swaps its `rollout` for a native call per `scoreCandidates`
bank. Placeholders, not implemented: `hoc_score_candidates` (the per-candidate loop, certified tail bounds and the
material sample in Zig, returning means, materials and completed counts) and `hoc_decide` (a whole decision).

Done for the A19 rollouts: the v0.8 policy (production switches) with its per-thread battle table and the army
profile, the per-unit mindless pin, the actor-antithetic stream, the v1 and v2 leaves with libc's `exp` (glibc checked
on the 9800X3D), the sole-Abomination rule, and summon counters that carry across rollouts with either id scheme.

What remains before the server's bot seat can call it:

- src/v08 coverage: the patches above, then the kept abilities (item 4), spells and artifacts; today a production
  board almost always carries abilities and is refused;
- the recovery net and `forceStalledLap`, when a policy can land nothing;
- research switches as request fields (per seat, with the scoped environment as a hashed config);
- server-path parity, the final target: production rollouts run with the server's engine context, which re-checks
  move reachability with known paths after a stat refresh (`play_session.ts` `getCurrentActiveKnownPaths`, around line
  3729: `refreshAuthoritativeStats()` and `refreshAggrBoards()` before the path search) and routes `canLandRangeAttack`
  through the enemy aggression matrix; common's `runMatch` passes no known-paths provider, so the reference here is
  runMatch's SearchDriver. The server also names summons with createSecureUuid (`summonIds: "uuidSequence"`, checked
  against a runMatch harness that does the same), restarts deterministicUuidSequence at 0 at each search (the caller
  passes `uuidSequence`), models a bot seat with its own primed composite and a human seat with an unprimed
  `createAIStrategy("v0.8")` (`armyProfile` null for that team), and cuts searches by wall clock (`deadline_ns`). A
  server-built oracle (rollouts through `createBotSearchDeps`) has to confirm the known-paths re-check moves no random
  draw and refuses no route the port accepts.
