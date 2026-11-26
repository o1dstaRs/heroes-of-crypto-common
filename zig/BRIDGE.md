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

```bash
cd zig && zig build -Drelease=true && zig build lib -Drelease=true && cd ..   # hoc-sim and libhocsim
bun zig/ffi/smoke.ts 24 9000                         # batches 1 and 2 kept; SMOKE_KEEP=none for ability-free
RECORD_RESUME=random:2 bun zig/parity/record.ts 300 8100000 /tmp/r.jsonl && zig/zig-out/bin/hoc-sim resume /tmp/r.jsonl
```

The library is `zig/zig-out/lib/libhocsim.dylib` on macOS and `libhocsim.so` on Linux (`HOC_SIM_LIB` overrides the
path in `bridge.ts`). For the 9800X3D, add `-Dtarget=x86_64-linux-gnu -Dcpu=znver5` (a shared library for glibc).

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
| `harness` | optional `{rng, activeUnitId, uuidSequence, seed?, summonSequence?}`: the mulberry32 state, runMatch's currentActiveUnitId ("" = none), lib.ts deterministicUuidSequence, and the parts of a summon's id: the battle seed and runMatch's createSummonedUnit counter (without them a summon cannot be named, and the play-out reports the overflow) |

`configs`, `setup`, `name` and `creatureId` are there so the loader never recomputes TypeScript logic it does not port.
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
| `State.summons`, `summon_seq`, `seed`, `next_uid` | `configs.summonTemplates` (interned), `harness.summonSequence`, `harness.seed`; the caller's next uid (default: the id list's length) |
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
`harness.uuidSequence` (carried by the handle; summons take the createSummonedUnit ids, not lib.ts UUIDs).

Refused as an unsupported state (the loader names what it found): summoned units other than the creatures Infest raises
and non-creature units; spells other than the spell entries of inert castable abilities (Vine Throw, on a Trent or a
thief); artifact-granted abilities; a forbidden target; Helping Hand; ranked `*_authoritative` stats; a spent Water
Shield; Last Fuse; Warlord's Edge or a War Anger attack increase; an unported ability, aura, buff, debuff or effect;
effect stacks other than Poison's; more buffs, debuffs, effects, active or stolen abilities than the lists hold
(14/5/7/10/6); WATER_CENTER or a water cell; artifact barrels; artifacts; legacy-axis seats; smoke clouds, vines or fire
walls; a unit on lava or terrain the board lost; more than 32 units in the holder or 255 ids; units out of holder
order. Malformed input (a missing field, a wrong type, an id no list knows) is
reported as a malformed state.

## The C ABI (`src/ffi.zig`, ABI version 1)

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
struct RolloutStats { uint64_t turns; uint32_t written; int32_t stop; };            // 16 bytes
```

- `end`: 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (the recovery net). `winner`: the
  fight_finished team (2 LEFT / green, 1 RIGHT / red, 0 none), -1 when unfinished. `stop`: 0 done, 1 deadline, 2 turn
  budget, 3 output full.
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
  "chance": "plain",
  "horizon": { "mode": "turns", "turns": 12 },
  "leaf": { "kind": "material", "exactTerminal": true },
  "policies": { "1": { "version": "v0.1", "switches": {} }, "2": { "version": "v0.1" } },
  "candidates": [ { "kind": "incumbent", "actions": [ /* GameAction */ ] }, { "kind": "defend", "actions": [...] } ],
  "pairs": [[0, 0], [0, 1], [1, 0], [1, 1]],
  "turnBudget": 4000
}
```

Each pair `[c, r]` runs one rollout on a fresh copy of the handle's state, exactly as `SearchDriver.rollout`
(`src/simulation/search_driver.ts`) does: install `makeRng((seedBase + r * 0x9e3779b1) >>> 0)`, make the actor active,
apply the candidate's actions (a rejected action of kind `"incumbent"` is skipped as the real loop does, and an
incumbent that landed nothing is -Infinity; any other kind's rejection is -Infinity), defend when nothing landed, end the
turn, then let each team's policy play (`turns`: N unit turns; `lap`: until the lap flips, at most 64; `reply`: until
the opponent has played one turn, at most 12; `leaf`: none), and score `leafValue` for the actor's team: with
`exactTerminal` a finished fight is 1, 0 or 0.5, else the material leaf `0.5 * (1 + (ours - enemy) / (ours + enemy +
1))` over the living units' cumulative HP. The values come back in pair order as exact doubles.

The call stops early, keeping the prefix, when `deadline_ns` passes (checked where `assertBeforeDecisionDeadline` is:
before each pair, action and turn, and before the leaf), when the rollout turns played exceed `turnBudget`
(TypeScript's `rolloutTurnLimit - rolloutTurnsTotal`; the turn that exceeds it drops its rollout, as the assertion
does), or when `out_cap` is full. `hoc_rollout_stats` gives the turns played (aborted rollouts included, as
`counters.rolloutTurnsTotal` counts them) and the stop reason.

Ported: chance `plain`; horizons turns, lap, reply, leaf; the material leaf with exact terminal results; policy `v0.1`
(`rollout.policies`). Refused (the call fails, never guesses): chance `antithetic`, leaves `v1` and `v2`, any other
policy, non-empty switches, an action type outside the engine port; a rollout fails when a policy turn lands nothing
(the recovery net, `advanceTowardEnemyAction`, is not ported) or the queue stalls with living units
(`forceStalledLap`). Not modelled: an opponent model (`SEARCH_OPP_MODEL`), the sole-Abomination defend rule, the
research logit adjustments (late-ranged finish, pure-ranged terminal), the material sample of `scoreCandidates`.

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

## Growing into the search

`hoc_rollouts` is the per-rollout seam the TypeScript SearchDriver can call (phase 1 of the A19 port plan): the driver
keeps enumeration, shortlists, pruning and arbitration, and swaps its `rollout` for a native call per `scoreCandidates`
bank. Placeholders, not implemented: `hoc_score_candidates` (the per-candidate loop, certified tail bounds and the
material sample in Zig, returning means, materials and completed counts) and `hoc_decide` (a whole decision).

What the A19 port will need from the bridge:

- the v0.8 policy registered in `rollout.policies` (src/v08's decide function, with its per-seat switches and the scoped
  environment as a hashed config in the request), and mindless units pinned to v0.1;
- the actor-antithetic chance stream: per-draw keys `"<lap>:<activeUnitId>"` (the real id strings and the active id,
  which the handle keeps), `hashSimulationParts` (FNV-1a over UTF-16 code units of `len:part|`, a murmur3 finalizer),
  and the per-draw complement `1 - v - 2^-32`; it needs the random source to switch generators by key at every draw;
- the V2 leaf (60 features, `src/simulation/value_features.ts`) and the v1 leaf, with the sigmoid's `Math.exp` taken
  from the C library (`exp`), not `std.math.exp`, since exact ties decide choices; check on Linux as well as macOS;
- the summon counter is in the State (`summon_seq`), so a rollout's summons take the ids the TypeScript rollout gives
  them as long as the root export carries `harness.seed` and `summonSequence`; splits and spell summons will need the
  same;
- the recovery net and `forceStalledLap`, when a policy can land nothing;
- the server's engine wiring as a later parity target: production rollouts run with the server's engine context, which
  re-checks move reachability with known paths after a stat refresh (the server's `play_session.ts`, around line 3729)
  and routes `canLandRangeAttack` through the enemy aggression matrix; common's `runMatch` passes no known-paths provider,
  so the TypeScript reference for `hoc_rollouts` stays runMatch's SearchDriver until that wiring is mirrored.
