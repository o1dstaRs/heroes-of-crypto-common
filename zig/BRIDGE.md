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
| bun:ffi binding, fail-safe loading and self-test | `ffi/bridge.ts` (`HocEngine`, `HocState`, `loadHocEngine`, `runHocSelfTest`) |
| What the library accepts, as data | `src/scope.zig` (`hoc_scope_manifest`), the TypeScript pre-check `ffi/precheck.ts` |
| Self-test fixture (a root, two banks, TypeScript's records) | `src/selftest/` |
| Smoke test (export, load, play, compare, overheads) | `ffi/smoke.ts` |
| Oracle: resume mid-battle in both modes | `hoc-sim resume` on a `RECORD_RESUME` recording |
| Debugging a rollout step by step | `hoc-sim rollout-trace <state.json> <request.json> [--pair K] [--digests]` |

```bash
cd zig && zig build -Drelease=true && zig build lib -Drelease=true && cd ..   # hoc-sim and libhocsim
# a release library names its common commit: zig build lib -Drelease=true -Dcommon-sha=$(git rev-parse HEAD)
bun zig/ffi/smoke.ts 24 9000                         # batches 1 and 2 kept; SMOKE_KEEP=none for ability-free
RECORD_RESUME=random:2 bun zig/parity/record.ts 300 8100000 /tmp/r.jsonl && zig/zig-out/bin/hoc-sim resume /tmp/r.jsonl
```

The library is `zig/zig-out/lib/libhocsim.dylib` on macOS and `libhocsim.so` on Linux (`HOC_SIM_LIB` overrides the
path in `bridge.ts`). For the 9800X3D, add `-Dtarget=x86_64-linux-gnu -Dcpu=znver5` (a shared library for glibc). A
library for the production hosts (glibc 2.35, any x86-64-v3 CPU), cross-built from macOS:

```bash
cd zig && zig build lib -Drelease=true -Dtarget=x86_64-linux-gnu.2.35 -Dcpu=x86_64_v3 -Dcommon-sha=$(git rev-parse HEAD)
```

`hoc_build_info` then reports `"target":"x86_64-linux-gnu","cpu":"x86_64_v3","glibc":"2.35"` and the commit; run
`runHocSelfTest` on the host before using it (below).

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
| `configs` | `{abilityConfigs, effectConfigs, auraEffectConfigs, spellConfigs, summonTemplates?}`: the configs of every ability and aura on the board, Poison, Break and the Ember Covenant spell, in the shape of a recording's start state (`spellConfigs` gains the System "Vine Throw" while vines stand; a book spell's config travels in its Spell object); with an Infest unit on the board, the summon templates (createUnitFromSpec's props of "Arachna Spider" and "Arachna Queen") and their abilities' and auras' configs; with a summon spell entry or a summoned Wolf, the "Wolf" template; with a Disguise Aura card, the System "Hidden" and "Visible" configs (the markers the stat refresh writes); with a Spit Ball card, the seven debuffs it applies (Curse, Sadness, Quagmire, Weakening Beam, Weakness of Death; Rangebane, Cowardice of Order) |
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
| `buffs`, `debuffs`, `effects` (name, laps, power, order) | the props' `applied_*` arrays, cross-checked against the AppliedSpell / Effect objects; a debuff row whose object laps differ from its display laps (a duplicate a Magic Reflection mirror appended) takes the object's laps and keeps the difference as `AppliedSpell.lag` |
| `max_range_shots` | `maxRangeShots` (the constructor's range_shots: Limited Supply's base) |
| buff and debuff `src_x/src_y` | `firstSpellProperty` / `secondSpellProperty` of aura rows (the Web Aura debuff row too) and augments |
| `abilities` (the active list, in order), `ability_mask`, `Ability.aura`, `auras`, `State.aura_defs` | the Ability objects' names and `aura_effects` with `configs` (engine.loadUnitAbilities / loadAuras), checked against the AuraEffect objects |
| `luck_dependent`, `stolen` | `props.abilities` (the card list: the early luck pass reads card names), `props.stolen_abilities` |
| `web_locked`, `rallying_volley_granted` | `props.web_movement_locked`, `props.rallying_volley_granted` |
| `book` (raw entries), `spells` (the parsed book with charges, spent ones included), `State.spell_cfg` | `props.spells`, the `spells` Spell objects (`spellProperties.name`, `amountRemaining`; their spellProperties are the configs), `configs.spellConfigs` |
| `summoned` | the unit's `summoned` (a summoned "Wolf" is the Summon Wolves merge target) |
| `fight.vines` | `fight.vines.vines` (`$map` entries `[key, {cell, lapsRemaining, team}]` in insertion order) |
| `uid`, `uuid` | the unit's index in the id list, its id parsed as a canonical UUID |
| `State.summons`, `summon_seq`, `uuid_seq`, `seed`, `next_uid` | `configs.summonTemplates` (interned), `harness.summonSequence`, `harness.uuidSequence`, `harness.seed`; the caller's next uid (default: the id list's length) |
| the handle's creature names (by `name_id`) and army profiles | `units[].name` and the summon templates' names; `harness.armyProfile` |
| `target` | `props.target` |
| `forbidden` | `props.forbidden_target` (Terrifying Gaze's lock: the gazer's id as its uid, a removed gazer's too) |
| `hh_caster`, `hh_penalty` | `props.helping_hand_caster_id` / `helping_hand_penalty_id` (a Helping Hand target's link, as uids) |
| `hh_gift`, `hh_cost` | the Helping Hand buff's / debuff's `firstSpellProperty` and `secondSpellProperty` (one row of the name per list) |
| `State.disguise_range`, `hidden_*`, `visible_*` | `configs.auraEffectConfigs.Disguise`, `configs.spellConfigs.Hidden` / `.Visible` |
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
holder's units in order, then the ids of removed units that the turn sets, the AI target memory, the distances or a
unit's forbidden target still name (at most 255). The holder's units take slots 0.. in holder order; removed units named by the turn sets are kept by
uid (`Fight.removed_*`); AI memory and distance entries of removed units are dropped (a removed id matches no living
unit again). The handle keeps the id strings: requests and digests speak ids, and `hoc_play_v01` appends the ids of
the units it summons (`rollout.SummonIds`).

Ignored (read by nothing in scope, or a cache the port recomputes): `renderPosition`, `unitIdToTeam`,
`availableCenterStart/End`, `placementType`, the turn timers, the per-team augment, doctrine and synergy maps (their
effect arrives through the buffs and `setup`), `teamsAuraEffects`, `auraRefreshFingerprint`, `auraRefreshKnownEmpty`
(the port runs the full aura refresh every time), descriptions and textures, `bitter_experience_stacks` (a counter
nothing reads), Poison's stack count (it only feeds the description), `fight.id`, `harness.uuidSequence` for naming (a
summon takes the createSummonedUnit id unless a rollout request asks for `summonIds: "uuidSequence"`; the counter itself
is loaded and counts every summon).

Read for batch 6a: `currentAttackModIncrease` (War Anger's increase, undefined = 0), each War Anger emitter's power
from `auraEffects` (`Unit.war_anger_power`), a revived unit's leading augment display rows without objects
(`Unit.aug_orphans`: deleteAllBuffs keeps the rows and drops the objects; the stored properties are matched after
them), and the `Hamstrung` and System `Wind Flow` configs in `spellConfigs` (`state_export.ts` adds them when a unit
holds Hamstring or carries Wind Flow).

Refused as an unsupported state (the loader names what it found; the names and limits are `src/scope.zig`'s tables,
which `hoc_scope_manifest` exports): summoned units other than the creatures Infest and Summon Wolves raise, and
non-creature units; a spell outside `st.CastSpell` (by name, in the raw entries or the Spell objects), more spell
entries or spells than the book holds (16/6); an artifact-granted ability other than the Wounding Charm's card; Helping
Hand; ranked `*_authoritative` stats; a spent Water Shield; a pending Last Fuse record; an unported ability, aura,
buff, debuff or effect; effect stacks other than Poison's; more buffs, debuffs, effects, active or stolen abilities
than the lists hold (24/25/12/10/6); WATER_CENTER or a water cell; an artifact the port does not play
(artifacts.supportedT1/T2, or its buff name); legacy-axis seats; more than 96 smoked cells, 96 vines or 64 burning cells; a
unit on lava that cannot traverse it, or terrain the board lost; more than
32 units in the holder or 255 ids; units out of holder order. Malformed input (a missing field, a wrong type, an id no
list knows, vines without the Vine Throw config) is reported as a malformed state.

## The C ABI (`src/ffi.zig`, ABI version 3)

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
int32_t  hoc_rollout_pairs(const Engine*, PairRecord* out, size_t cap);             // records the last call has
const char* hoc_build_info(void);                           // JSON, static: abi, commonSha, coverage, zig, target, ...
const char* hoc_scope_manifest(const uint8_t* policy, size_t len);  // JSON, static; null for an unknown policy
double   hoc_exp(double x);                                 // libc exp, the learned leaves' sigmoid
int32_t  hoc_self_test(Engine*);                            // 1 pass, 0 fail (see error), -1 no engine

struct PlayResult   { int32_t end, winner, lap; uint32_t steps, decisions, rng; };  // 24 bytes
struct RolloutStats { uint64_t turns; uint32_t written; int32_t stop;
                      uint64_t summon_sequence, uuid_sequence; };                   // 32 bytes
struct PairRecord   { double value, material; uint32_t turns, flags, summon_sequence;
                      int32_t winner; uint64_t uuid_sequence; };                    // 40 bytes
```

- `end`: 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (kept for the ABI; no longer produced
  since the recovery net and forceStalledLap are ported). `winner`: the
  fight_finished team (2 LEFT / green, 1 RIGHT / red, 0 none), -1 when unfinished. `stop`: 0 done, 1 deadline, 2 turn
  budget, 3 output full. `summon_sequence` / `uuid_sequence`: runMatch's createSummonedUnit counter and lib.ts
  deterministicUuidSequence after the call (aborted rollouts included), for the next request's start values.
- ABI 2 (2026-11-25): RolloutStats grew the two counters; requests take the v0.8 policy, the antithetic chance, the v1
  and v2 leaves, the sole-Abomination rule, the army profile and the summon counters and id scheme.
- ABI 3 (2026-11-25): requests take `bank` (scoreCandidates' bank semantics, below); `hoc_rollout_pairs` returns every
  pair's record; `hoc_build_info`, `hoc_scope_manifest`, `hoc_exp` and `hoc_self_test`. Every ABI 2 signature, struct
  and request is unchanged: a request without `bank` runs exactly as under ABI 2, so an ABI 2 caller needs only the
  version constant bumped.
- `PairRecord` (one per request pair, in pair order): `value` the leaf (-Infinity for a rejected candidate, NaN when not
  played), `material` the A19 material sample (`bank.material` and a finite value, else NaN), `turns` the rollout
  turns the pair played (an aborted one included), `flags` 0 played / 1 skipped after an illegal rollout / 2 aborted by
  the deadline or turn budget / 3 not reached / 4 skipped by the tail bound, the summon counters as the rollout left them
  (before `bank.summonScope: "rollout"` restores the summon sequence; a skipped pair: the counters the next pair starts
  from), and `winner` the fight_finished team inside the rollout (0 none), -1 when the fight did not finish.
- Ownership: an engine owns its error text, its request arena and its rollout scratch state; use one per thread. A
  handle (a state copy plus its id strings) is freed with `hoc_state_free`; any engine may read a handle (rollouts and
  digests copy or read it), but only one call may mutate it at a time (`hoc_play_v01` plays in place: clone first).
- Errors: every call returns -1 or null on failure and sets `hoc_last_error`; nothing prints, nothing panics on bad
  input (integers out of range are refused, not truncated). One caveat for threads: the name in an "unsupported
  ability" message comes from a diagnostic global of engine.zig, so two engines refusing states at the same moment can
  swap names. A refused state reads "unsupported state: ...", a refused request "unsupported request: ...", a rollout that
  reached unported code "unsupported rollout: ..."; the caller falls back to TypeScript for that decision.
- `hoc_state_digest_json` writes `{units, fight, active, rng}` with the record.ts digest columns (setup, terrain,
  batch-3, spellbook, batch-4 `forbidden_target` and `helping_hand_link` columns and the fight's `vines` always on;
  `buffs_sources` and `debuffs_sources` name aura and augment rows and Helping Hand's stored properties only). `hoc_state_check_digest` takes a `parity/digest.ts` `battleDigest` and runs `compare.state`.

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
  mindless ("AI Driven") unit plays v0.1 whatever its seat (aiVersionForUnit; `rollout.isMindless`: Berserker, Frenzied
  Boar, a thief of the card; Break-aware, read at every turn), with the rollout's catalog like every rollout turn.
- `leaf.kind`: `material` (no learned leaf), `v1` (the 20-feature DEFAULT_V07_VALUE_WEIGHTS logistic leaf) or `v2`
  (V08_A13_VALUE_LEAF over the 60 V2 features, what the A19 profile loads; src/v08's `util.leafV2`); `exactTerminal`
  (SEARCH_A19_EXACT_TERMINAL_RESULTS, on in production) scores a finished fight 1, 0 or 0.5 first. The research logit
  adjustments (late-ranged finish, pure-ranged terminal) are zero in production and not modelled.
- `soleAbominationDefend` (SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY=1 in the A19 profile): the acting
  team's last stack, an Abomination facing a lone enemy Abomination that some upcoming Armageddon wave kills first,
  defends instead of asking its policy (`isV08SoleAbominationArmageddonDefendOpportunity`; off by default, as for a
  SearchDriver built outside the profile).
- `armyProfile` overrides the export's `harness.armyProfile` per team. An aura-saturated profile is passed to src/v08
  (`Request.aura_saturated`, `util.Battle.aura_saturated`): v0.7's v0.4 anchor is played where it equals the v0.4 level
  (common `6998c2dd`), not refused.
- Summons: the counters carry over from one rollout to the next and come back in `hoc_rollout_stats`, as for
  `SearchDriver.rollout` called directly (later rollouts' summons get later ids, and the ids key the antithetic
  stream); inside `scoreCandidates` runMatch's captureAuxiliaryState restores the createSummonedUnit counter after every
  rollout, which `bank.summonScope: "rollout"` reproduces (deterministicUuidSequence is never restored per rollout). `summonSequence` / `uuidSequence`
  give the first rollout's values (default: the export's harness values). `summonIds`: `match` names a summon as
  runMatch's createSummonedUnit does (`deterministicSimulationId("summon", seed, ..., sequence)`); `uuidSequence` keeps
  the id createSecureUuid gives under a seeded source, the "sim" UUID of deterministicUuidSequence, as the server's
  createSummonedUnit does inside its search. Every summon takes one value of each counter (UnitProperties' id is
  allocated in both cases).
- `engine`: `match` (default) reproduces runMatch's engine path; `server` the server's bot-seat deps
  (play_session.ts createBotSearchDeps: the known-paths provider, a full stat refresh and an aggression rebuild before
  every move and approach, the server's routes, damage laps marked by damage > 0 only). `server` needs
  `summonIds: "uuidSequence"` and a library whose `supportedEngines` (scope manifest and build info) lists it; another
  build refuses it as an unsupported request, so the caller keeps those rollouts in TypeScript. In server mode
  (`src/server.zig`, State.engine_mode) the provider (currentActiveKnownPaths) runs where TypeScript asks it: in
  `move_unit` after the footprint checks, in `melee_attack` before every check of the strike (stationary strikes too),
  and in `obstacle_attack` when it names an attack-from cell. For a unit that can move it is the full stat refresh
  (refreshStackPowerForAllUnits: a second one is not idempotent), the aggression boards rebuilt from the
  registrations, and getMovePath from the active unit with its refreshed getSteps. A move then takes the server's route
  to its destination (an unreachable one is refused) for its obstacle test, travelled path, Crusade, lava flag, route
  length and Fire Wall burn; an approach takes the route to its attack-from cell (a path-less one is accepted when the
  cell is reachable), and a strike with a map but no route charges Rapid Charge one cell. The server's damage holder
  marks a lap only for a statistic with damage > 0 (engine.markDamageLap). The export of a server root names those laps:
  `state_export.ts` reads the holder's `snapshot().damageDealtLaps` when it has one (runMatch's has none). Three
  server-only paths the server oracle has run without any case where they change a value are refused when a rollout
  reaches them (State.server_unverified, "unsupported rollout: server mode reached a path the server oracle has not
  verified", so that bank stays in TypeScript): a route other than the action's (a substitution, or a path-less
  approach the full map accepts), a lap whose only damage statistic had 0 damage reaching an advance, and an obstacle
  approach under the provider. A cohort that shows one of them changing a value (and Zig agreeing) lifts its flag.

The v0.8 policy reads a per-battle table besides the State (`v08/util.zig` `battle`: each slot's creature, its id rank
for the TypeScript id tie-breaks, and the army profile). It is a thread-local, so `hoc_rollouts` builds it on the
calling thread at every call (`rollout.battleTable` over the root's slots, names by Unit.name_id from the handle,
`Battle.fromUnits`), restores it at each rollout's start and rebuilds it after a summon (a new uid, possibly in a reused
slot). A team without a profile is passed as melee_magic 255 (v0.7's finalizeDecision then keeps v0.6's decision, the
port's anchor-army path; nothing else reads the count).

Scope of the v0.8 policy (`rollout.v08Scope`, checked on the root; no batch-6a card or row and no spell outside the
list can appear inside a rollout from a root without one): src/v08 covers the abilities of batches 1 to 5 (common
`4f5152ba`, `2346a159`, `0809cc1d`, `dbbcb452`, `d2c40d3f`, `6b661284`), the wave-1 casts with the vines (`bcf722a4`,
`66e72e9e`) and the batch-4 castables (Battle Roar, the Wild Regeneration gift), so a request with a v0.8 seat is
refused when any holder unit holds a book entry or parsed spell outside the whitelist `rollout.V08_CASTABLE` (Heal,
Blessing, Lightning Strike, Fire Strike, Meteor Shower, Meteorite, Summon Wolves, Vine Throw, Ring of Fire, Battle Roar,
Wild Regeneration: a spell added to `st.CastSpell` later, Wind Flow and Resurrection included, is refused until it
joins the list), when a unit holds a batch-6a card (a stolen one too), carries a batch-6a row (Hamstrung, War Anger's
aura row, Blindness, Paralysis, Wind Flow, the four blessings, the Guiding Winds row) or was revived (orphan augment
rows), when the board has smoke clouds, or when any artifact row exists. The v0.1 policy takes every board the engine
port loads, batches 5 and 6a included. Candidates may be any action the engine replays,
`area_throw_attack` and the free-aim `range_attack` included. The two refusals for
src/v08 gaps (a removed unit in alreadyMadeTurn, an Angel or Queen with a synergy aura range) are gone: its owner fixed
them (common `d5fddea9`, `6e6aff54`), and the holder-ordered copy the learned leaves were scored on went with them.

The call stops early, keeping the prefix, when `deadline_ns` passes (checked where `assertBeforeDecisionDeadline` is:
before each pair, action and turn, and before the leaf), when the rollout turns played exceed `turnBudget`
(TypeScript's `rolloutTurnLimit - rolloutTurnsTotal`; the turn that exceeds it drops its rollout, as the assertion
does), or when `out_cap` is full. `hoc_rollout_stats` gives the turns played (aborted rollouts included, as
`counters.rolloutTurnsTotal` counts them), the stop reason and the counters.

Refused (the call fails, never guesses): the cases above, an action type outside the engine port, a v0.8 decision
that needs a pass src/v08 lacks (`decideV08` returns false), and a capacity of the port (unit slots, ids, lists, 1,024
antithetic keys per rollout). A policy turn that lands nothing plays SearchDriver.recoverNoopTurn
(`rollout.recoverNoopTurn`: `ai.advanceTowardEnemy`, the port of advanceTowardEnemyAction, when it lands, else
`defend_turn`), and a queue with no unit to activate in a live fight runs forceStalledLap (`rollout.simAdvance`: every
living holder unit marked as having made its turn, then the advance again), as TypeScript does. A test hook, the
request field `testDropDecisions` (k), replaces the policy calls whose per-rollout index n has `Math.imul(n,
0x85ebca6b) >>> 0` divisible by k with nothing after computing them, so a TypeScript oracle that wraps its policy the
same way checks the net on thousands of turns. Not modelled: an opponent model (`SEARCH_OPP_MODEL`, empty in
production).

`bank` (ABI 3) makes one call one `SearchDriver.scoreCandidates` bank, or a candidate-major slice of one (every pair of
a candidate before the next candidate's; checked when the bank skips):

```json
"bank": { "skipAfterIllegal": true, "summonScope": "rollout", "material": true,
          "tailBound": { "reference": 0.42, "margin": 0.0, "rolloutCount": 8 } }
```

- `skipAfterIllegal`: the bank's `break` after a -Infinity rollout; the candidate's later pairs are not played (no turns,
  no summons, no uuid values) and read flag 1.
- `summonScope`: `"rollout"` restores the summon sequence after every rollout (runMatch's captureAuxiliaryState, restored
  in scoreCandidates' `finally`), `"call"` (default) carries it over (the server's bot seat, whose summons are named by
  uuid and which has no such counter).
- `material`: the A19 material sample after every finite rollout (`captureMaterial`: "turns" banks with
  captureA19Material): `0.5 * (1 + (ours - enemy) / (ours + enemy + 1000))` over the living units' `exp *
  cumulativeHp / max(1, maxHp)` in holder order.
- `tailBound`: the offline hopeless-tail bound, `remainingRolloutsCannotWin(sum, completed, rolloutCount, reference,
  margin)` after each finite rollout of a candidate, with one reference for the whole call (`null`: TypeScript's
  -Infinity, the bound never fires); off for the rest of the call once a leaf is outside [0, 1]. scoreCandidates'
  reference moves between candidates (`SearchSelectionBounds.referenceMean(c) ?? bestFinishedMean`), so a bounded bank
  is one call per candidate, the caller replaying the bookkeeping between calls (a later `hoc_score_candidates` can
  port `SearchSelectionBounds`).

The means, the material evidence and every counter a TypeScript bank leaves behind follow from the records: the
integration design's adapter replays scoreCandidates' bookkeeping on them in the same order.

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
- Every SearchDriver rollout turn decides with a DecisionPathCatalog (cached canonical path; findTarget builds only the
  first melee layer of its infinite-path pass), and runMatch's decisions without search do not. The port follows
  (`ai.catalog_decisions`, set by `rollout.run`); the two differ only for a vine strider (a route of weight 0). A harness
  that wraps `PathHelper.prototype.getMovePath` turns the catalog's cache and elision off (`cacheSafe` checks the
  method's identity) and then differs from production on such boards.

## Scope manifest and pre-check

`hoc_scope_manifest(policy)` returns what the library accepts as JSON, generated at first use from the tables the
loader and `rollout.v08Scope` refuse by (`src/scope.zig`, the AbilityId / SpellId / CastSpell enums, `V08_SCOPE`,
`ffi.SUPPORTED_ACTIONS`), so it cannot drift from them:

```json
{ "abi": 3, "commonSha": "<built-from commit>", "coverage": "<sha256 of the scope body>", "policy": "v0.8",
  "scope": { "loader": { "format": 2, "abilities": [...], "auraEffects": [...], "applied": [...], "spells": [...],
                         "spellEntryPrefixes": [...], "spellFactions": [4, 3, 1, 2], "summons": [...],
                         "unitTypes": [1], "teams": [1, 2], "footprint": [1, 2], "gridTypes": [1, 3, 4],
                         "boardCodes": ["", "B", "L", "H"], "stackingEffect": "Poison",
                         "storedPropertyBuffs": [...], "artifacts": { "tier1": [0, 1, ...], "tier2": [0, 1, ...] },
                         "artifactRows": { "buffs": [...], "debuffs": ["Gravebound"] },
                         "capacities": { "units": 32, "ids": 255, "abilities": 10, "barrels": 4, ... },
                         "refuse": { "unitFields": [...], "unitFieldParts": ["lastFuseFatalHit.source"],
                                     "unitProps": [...],
                                     "unitPropsLimited": { "artifact_granted_abilities": ["Deep Wounds Level 1"] },
                                     "unitPropSuffix": "_authoritative", "unitPropSuffixKept": [...], "grid": [],
                                     "fight": [...], "artifactsPerTeam": ["artifactTier1PerTeam", ...] } },
             "policies": { "v0.8": { "castable": [...], "refusedAbilities": [...], "refusedDebuffs": [...],
                                     "refusedEffects": [...], "refusedBuffs": [...], "refusedRevived": true,
                                     "refusedArtifactRows": true, "refusedSmoke": true, "refusedFireWalls": true } },
             "actions": [...] } }
```

`applied` lists every name a buff, debuff or effect row may carry; `castable: null` means every spell the loader
takes. `artifacts` lists the Tier-1 and Tier-2 ids the port plays (`artifacts.supportedT1/T2`; 0 is no artifact);
`storedPropertyBuffs` the buff rows whose stored properties are loaded besides the aura rows (the augments and every
artifact row but Keen Blade's), each an integer 0..`storedProperty` or undefined; `artifactRows` the rows that make a
board an artifact board (`State.artifacts`), which v0.8 refuses until src/v08 is checked on artifacts (and, with
`refusedSmoke` and `refusedFireWalls`, a board holding a smoke cloud or a burning cell, until src/v08 reads the stores).
A policy's `refused*` lists include its late rows (`V08_SCOPE.late`: the crafted cards, Time Denial and the wave-2 rows
that outlive their casters, which v08Scope checks
after the board-level refusals with their own messages). With no policy
name the manifest carries every policy; `coverage` hashes that full body and is the same in every manifest and in
`hoc_build_info`.

`ffi/precheck.ts` compiles a manifest into sets once (`compileHocPrecheck(engine.scopeManifest("v0.8"))`) and answers
`refusal({unitsHolder, grid, fightProperties})` from the live objects: the units' raw fields (the Ability objects, not
`getAbilities()`, which hides a Broken unit's), applied lists and their stored properties, spellbook entries and Spell
objects, effect stacks, the unported unit fields, the artifact-granted cards, `props.target`, the summon templates a
board can raise (computed once per process from the creature configs), the teams' artifact ids, Barrel Barricade's
barrels, the smoked cells, and the grid's and fight's refused stores; for a policy that refuses artifact rows, every
unit's applied names against `artifactRows`, for one that refuses revived units, more `applied_buffs` names than buff
objects, and for one that refuses smoke, any cloud. It skips the loader's consistency checks (a unit on lava without Lava Striders, a barrel off the
layout, ...), which hold on every state the TypeScript engine produces, and reads the known `*_authoritative` fields by
name (`AUTHORITATIVE_PROPS`; `strict` mode enumerates the keys as the loader does). A root it passes and the library
refuses costs an export and a load, never a wrong value.

### Accepting a newly ported feature

The loader's and v08Scope's refusals are tables in `src/scope.zig`; the manifest and the pre-check are generated from
them, so a porter changes the table and nothing else on the bridge side:

| The port now plays | Edit |
| --- | --- |
| an ability, aura, buff, debuff or effect | its `AbilityId` / `SpellId` (the loader interns by name; the manifest lists the enums) |
| a spell | its `st.CastSpell` entry; for v0.8 seats also `rollout.V08_CASTABLE` once src/v08 decides it |
| a unit field or prop that was refused | drop it from `REFUSED_UNIT_FIELDS` / `REFUSED_UNIT_PROPS` and read it in snapshot.zig |
| more names in a limited list (artifact-granted cards) | `LIMITED_UNIT_PROPS[..].accepted` |
| a grid or fight store | drop it from `REFUSED_GRID_FIELDS` / `REFUSED_FIGHT_FIELDS` and read it in snapshot.zig |
| an artifact | `artifacts.supportedT1/T2` (scope.artifactSupported); its row's name in `SpellId` |
| a wider list | the capacity in `state.zig` (`MAX_*`, the list types); the manifest's `capacities` follow |
| v0.8 on batch-6a cards or rows, revived units, artifact rows, smoke, fire walls, or the wave-2 rows | `rollout.V08_SCOPE` (`refused_abilities`, `refused_debuffs` / `refused_effects` / `refused_buffs`, `refuse_revived`, `refuse_artifact_rows`, `refuse_smoke`, `refuse_fire_walls`, `late`) |

A new kind of refusal (a check no table holds yet) gets a table and a manifest key in scope.zig and a line in
`ffi/precheck.ts`. Then rebuild, run `zig build test` (the manifest tests, the artifact-row cross-check against
`engine.loadScopeFlags`, the fixture replay) and the pre-check comparison: a root the pre-check passes and the library
refuses is a miss.

## Loading safely and the self-test

Importing `ffi/bridge.ts` loads nothing. `HocEngine.open()` loads the library on first use and throws `HocError` when
it is missing or has another ABI (smoke tests and oracles). Production uses `loadHocEngine({ commonSha })`, which never
throws: it returns null, logging once per process and reason, when the library is missing, does not load, has another
ABI, was built from another common commit (a development build says "unknown"), or fails `runHocSelfTest`:

- `Math.exp` against the library's `hoc_exp` (libc `exp`, the learned leaves' sigmoid) on a fixed table of 5,138
  inputs (`hocExpTable`: the leaf logit range, the whole finite range, the extremes and signed zeros), bit for bit;
- `hoc_self_test`: a compiled-in root and two banks on it (`src/selftest/`), the stock bank (antithetic R2) and the deep
  bank (plain R8), both H64 with the v2 leaf, exact terminals, v0.8 on both seats and `bank` semantics; every pair's
  value and material bit for bit, turns, flags, summon counters and winner, and each call's turns and stop, against the
  records TypeScript's scoreCandidates produced on that root.

`runHocSelfTest({ path, commonSha })` returns the report (`ok`, `reason`, `buildInfo`, the exp mismatches, the fixture
result): a deploy runs it on the host with `bun -e` before pointing `HOC_SIM_LIB` at a new library.

### Deploying the binding with the package

The server installs common from a git pin, and the package ships only what `package.json` `files` names: `dist`,
`src`, and of `zig/` exactly `zig/ffi/bridge.ts`, `zig/ffi/precheck.ts` and `zig/parity/state_export.ts` (the binding,
the pre-check, and the exporter they need; each imports only from `../../src`, which ships). They stay under `zig/`:
`bridge.ts` imports `bun:ffi`, which `tsc` and the client bundle must never see, so they are not moved into `src/`. The
library itself is not in the package: build it for the host (`-Dcommon-sha` of the pinned commit, above), copy it
beside the server, point `HOC_SIM_LIB` at it and run `runHocSelfTest` there. `npm pack --dry-run --ignore-scripts`
lists the three files and nothing else from `zig/`; a new file the binding imports from `zig/` must join `files`.

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

Re-checked on 2026-11-26 on common `2b0155c3` (the artifacts, the Book of Chaos, batch 6a with the recovery net, the
Blacksmith) plus this change, the scope tables folding in each of them, and again after the sync to `cab3decd`:

- `zig build test` (23 tests: the manifest, the artifact-row cross-check against `engine.loadScopeFlags`, the fixture
  replay bit for bit); the production-host cross build (`x86_64-linux-gnu.2.35`, `x86_64_v3`) compiles.
- `check.sh 40 27970000` 40 of 40 in both modes; production-like with batches 1 to 6a, the casters, the Wandering Mage
  and the Blacksmith (wave-1, Book of Chaos and Blacksmith spells), random artifacts and resume points (`27980000`):
  40 of 40 in both modes, 80 of 80 resume points loaded equal to their digests and replayed identical; `ffi/smoke.ts
  12 27990000`; the self-test and its negative controls (missing file, an ABI 2 library, a development build against
  a real commit, one flipped bit of the fixture, one perturbed `Math.exp` input, another commit) as expected.
- Pre-check against export + load + a v0.8 request at every decision of 72 battles (all creatures with full books or
  the ported spells and random artifacts; batches 1 to 6a with the casters, the Wandering Mage and the Blacksmith; seeds
  27930000-27960011): 4,099 roots, both policies, 0 false accepts, 0 false refusals (v0.8 refusals seen: batch-6a
  cards and rows, crafted cards, Misfortune, the Sword's burn, smoke, artifact rows, Book of Chaos and Craft spells).
- Identity, batches 1 to 4 (rate 0.4, 27900000-27900019): 20 of 20 battles and 836 of 836 decisions identical to pure
  TypeScript (actions and rollout turns), every bank native (2,155); shadow 50,205 rollouts compared one by one, 0
  mismatches (9,389 with summons).
- ABI 2 requests (the v0.8 rollout oracle, casters and batches 1 to 4 with wave-1 books, `expBudget`, rate 0.6, 12
  battles from 27990100 and 27990200): 33,600 of 33,600 values, the same 358,920 rollout turns, summon counters and
  turn-budget banks.
- After the sync to `cab3decd` (the Healer's and the Magic Dragon's whole books; Whirlpool joins the late debuffs):
  `zig build test`, `check.sh 40 27997000` and the production-like 40 (`27998000`, the new spells kept, 80 resume
  points) identical in both modes, `ffi/smoke.ts 12 27999000`, the pre-check on 24 more battles (1,407 roots, 0 false
  accepts or refusals; v0.8 refusals of Whirlpool and Spiritual Armor books seen) and the identity run (836 of 836
  decisions, every bank native).

Results with ABI 3 on 2026-11-25 (common `3538ee55` plus this change; production-like setup, side boards, maps mixed
by seed; a scratch scoreCandidates adapter over the bot seat's deep-fit driver, offline deterministic work, the
integration design's identity harness):

- Decisions: batches 1 to 4 kept (rate 0.4, seeds 24200000-24200029) 30 of 30 battles and 1,403 of 1,403 searched
  decisions identical to pure TypeScript (actions and rollout turns), every bank native (3,567; 27 turn-budget stops);
  with the wave-1 casters (Healer, Battle Mage, Satyr, Magic Dragon, wave-1 books; 24500000-24500019) 20 of 20 battles
  and 833 of 833 decisions, 2,171 of 2,174 banks native (3 recovery-net refusals ran in TypeScript).
- Per rollout, in shadow mode (TypeScript decides; every bank replayed natively and its records compared with
  TypeScript's rollouts one by one: value and material bit for bit, turns, uuid and summon counters, winner): 131,098
  rollouts and 5,741 banks, 0 mismatches, with 7,518 pairs skipped after an illegal rollout and 24,988 rollouts that
  summoned (Infest, Summon Wolves); the live code path (single-call banks) 5,961 rollouts, 0 mismatches.
- The pre-check against export + load + a v0.8 request at every decision of 95 battles (batches 1-5 with the casters,
  all creatures with full books, random artifacts; 5,736 roots, both policies): 0 false accepts, 0 false refusals;
  about 2 us per root warm (3 to 6 us on the first call of a decision, 15 to 20 us right after a search's rollouts).
- `ffi/smoke.ts` 12 (24600000), 30 with batches 1 to 4 (24610000) and 12 ability-free (24620000); `check.sh 100
  24400000` both modes 100 of 100; `zig build test`.

Results with batch 4 on 2026-11-25 (common `6998c2dd` plus this change; production-like setup, side boards, maps mixed
by seed; the oracle's battles play native v0.8, so the roots carry Battle Roar rows, gifts, Hidden markers, forbidden
targets, Deep Wounds and summoned Wolves with their cards):

- v0.1 rollouts on roots with batch 4 kept: 350 battles, 725 roots, 696,000 values identical to `SearchDriver.rollout`,
  the same 5,453,472 rollout turns, summon counters and turn-budget banks: batch 4 at keep rate 1 (seeds 24000000, 24800000, 33000000:
  100 battles, 181 roots), with the Arachna Queen and Spider (and Monk, Squire; 24100000, 25600000, 33100000), with
  batches 1 to 3 at the default rate (24200000, 24900000, 33200000), Griffin, White Tiger, Manticore, Troglodyte and
  Monk (24300000), and with the server's summon ids (`SUMMON_IDS=uuid`, 24400000, 33300000).
- v0.8 on both seats with Berserkers (AI Driven and Double Punch: the mindless pin live) and Arachna Queens that steal
  it: 90 battles, 209 roots, 200,640 values and 2,238,300 rollout turns identical (seeds 24700000, 25900000, 33600000).
- v0.8 ability-free (`KEEP=" "`): 260 battles, 604 roots, 579,840 values and 5,732,790 rollout turns identical, 0
  refused (seeds 24500000, 24600000, 26000000, 33400000, 33500000).
- v0.8 on batch-4 boards: refused at the request (60 battles, 110 roots; 3 roots compared and identical at keep rate
  0.3, where no batch-4 card stood).
- `ffi/smoke.ts`: 30 battles with batch 4 kept (26100000), 30 with batches 1 to 4 (26200000, 32800000), and the default
  12 (9100), every check passing.

Results with the wave-1 spells on 2026-11-25 (common `2f222cc0` plus this change; production-like setup, side boards,
maps mixed by seed):

- v0.8 on both seats, ability-free (`KEEP=" "`, seeds 11000000-11000149): all 348 roots compared with the src/v08 gap
  checks and the leaf copy removed, 334,080 of 334,080 values and 3,183,738 rollout turns identical, the turn-budget bank
  identical at every root, 0 refused (before: 230 roots compared, 118 refused).
- v0.1 rollouts on roots with spells (the wave-1 casters and batches 1 to 3 kept at keep rate 1, the live server's stack
  sizing, wave-1 books; v0.8 played the battles, so the roots carry vines, snares, Blessings, spent charges, summoned
  Wolves and stolen books): 230,400 of 230,400 values identical (seeds 12200000-12200029 and 12300000-12300059, 240
  roots, 8,415 summons inside rollouts, incumbent casts among the candidates), the same 2,470,284 rollout turns and
  summon counters. Before the catalog's first-layer elision was modelled, one battle's two roots (a vine strider)
  differed.
- v0.1 rollouts with batches 1 to 3 kept, without the holder-ordered leaf copy: 50,880 of 50,880 (seeds
  11300000-11300019, 53 roots, 2,572 summons).
- `ffi/smoke.ts 12 9100` passing; the bridge digest carries the spellbook columns and the vines.

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
   `configs` / `setup` when it needs unported TypeScript to compute), and remove its refusal from `scope.zig`'s tables
   ("Accepting a newly ported feature" above; a spell's name joins `st.CastSpell`). Keep every other refusal: the
   loader must refuse what the port cannot play.
3. When TypeScript gains a field, the export's coverage check throws until `state_export.ts` classifies it; then decide
   here: read it, ignore it (say why in the list above), or refuse non-empty values.
4. Record with `RECORD_RESUME` in the new scope and run `hoc-sim resume`; it checks the loaded state against the
   recorded digest and every step after it. Then `ffi/smoke.ts` and the rollout comparison.
5. Bump `ABI_VERSION` (ffi.zig and bridge.ts) on any change to a signature, a struct layout or the request format, and
   the export `version` (state_export.ts, `snapshot.FORMAT_VERSION`) on a format change.
6. A refusal belongs in `scope.zig`'s tables (or the enums and v08Scope's `V08_SCOPE` the manifest reads), so the scope
   manifest and the TypeScript pre-check follow it; a new kind of refusal also needs a line in `ffi/precheck.ts`, and
   the pre-check comparison (a passed root the library refuses is a miss) shows a missing one. A rule change that moves
   a rollout of the self-test fixture fails `zig build test`: regenerate `src/selftest/` from TypeScript's records of the
   same banks (the scoreCandidates shadow comparison writes them; there is no committed generator yet).

## Known gaps of src/v08 (owner: the v0.8 port)

Found by the v0.8 rollout comparison on ability-free production-like battles. Gaps 1 to 3 are fixed in src/v08
(`d5fddea9`: madeCount in waitFeatures; `6e6aff54`: coverageRange with the synergy aura range, every unit loop in holder
order), their refusals and the leaf copy are removed, and every root compares identical (below). Gap 4 stands.

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
bank. ABI 3's `bank` and pair records reproduce a bank exactly (one call per bank live, one per candidate while the
offline certified bounds are on). Placeholders, not implemented: `hoc_score_candidates` (SearchSelectionBounds and
bestFinishedMean in Zig: one call per offline bank, returning means, materials and completed counts) and `hoc_decide`
(a whole decision).

Done for the A19 rollouts: the v0.8 policy (production switches) with its per-thread battle table and the army
profile, the per-unit mindless pin, the actor-antithetic stream, the v1 and v2 leaves with libc's `exp` (glibc checked
on the 9800X3D), the sole-Abomination rule, and summon counters that carry across rollouts with either id scheme.

What remains before the server's bot seat can call it:

- src/v08 coverage: the patches above, then the kept abilities (item 4), spells and artifacts; today a production
  board almost always carries abilities and is refused;
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
