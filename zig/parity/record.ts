/*
 * Records headless battles from the TypeScript engine so the Zig engine can replay them step by step.
 *
 *   bun zig/parity/record.ts [games=50] [firstSeed=1] [out=zig/parity/out/battles.jsonl]
 *
 * Scope of the spike: every creature's abilities and spells are stripped (except the creatures named in
 * RECORD_KEEP_ABILITIES), v0.1 AI on both sides. No artifacts, augments, synergies or doctrines unless the setup options
 * say otherwise (RECORD_AUGMENTS, RECORD_SYNERGIES, ..., below). The map is NORMAL on a classic board unless
 * RECORD_GRID / RECORD_SIDE say otherwise (below). The AI only chooses actions; what is recorded is every
 * top-level call into the engine (GameActionEngine.apply and TurnEngine.advanceAfterNoActiveUnit) with
 *   - the seeded random state before and after the call (mulberry32 state, so Zig can resume the stream),
 *   - the events the call emitted (headless set),
 *   - a digest of every unit and of the turn queues after the call.
 * The time spent inside those calls is the TypeScript engine cost the Zig replay is benchmarked against.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import creaturesJson from "../../src/configuration/creatures.json";
import { GameActionEngine } from "../../src/engine/action_engine";
import { TurnEngine } from "../../src/engine/turn_engine";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { PathHelper } from "../../src/grid/path_helper";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { a19ShooterlessAugments } from "../../src/ai/setup/a19_shooterless_setup";
import {
    A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS,
    a19StrikerRushAugments,
    isA19StrikerRushSetup,
} from "../../src/ai/setup/a19_striker_rush";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../../src/artifacts/artifact_properties";
import { getUpgradePoints } from "../../src/doctrines/doctrine_properties";
import { ToFactionType } from "../../src/factions/faction_type";
import { buildRoster, creaturesByLevel, makeRng } from "../../src/simulation/army";
import {
    DEFAULT_SYNERGY_VARIANTS,
    FACTION_SYNERGY_PAIRS,
    synergyVariantsForSeed,
} from "../../src/synergies/synergy_properties";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getEffectConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";
import { runMatch } from "../../src/simulation/battle_engine";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../../src/utils/lib";

type Ctx = { grid: any; fightProperties: any; unitsHolder: any };

// ---- scope: strip abilities and spells from every creature (harness-local mutation of the shared config) ----
// RECORD_KEEP_ABILITIES="Leprechaun,Nomad" keeps those creatures' abilities and spells, so the ported abilities can be
// checked batch by batch. RECORD_KEEP_RATE (default 0.6) is the chance each roster slot is swapped for a kept creature
// of the same level.
const KEEP = new Set(
    (process.env.RECORD_KEEP_ABILITIES ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
);
const KEEP_RATE = Number(process.env.RECORD_KEEP_RATE ?? 0.6);
for (const [faction, creatures] of Object.entries(creaturesJson as Record<string, any>)) {
    if (faction === "version" || typeof creatures !== "object") continue;
    for (const [name, creature] of Object.entries(creatures as Record<string, any>)) {
        if (KEEP.has(name)) continue;
        creature.abilities = [];
        creature.spells = [];
    }
}
for (const name of KEEP) {
    const known = Object.entries(creaturesJson as Record<string, any>).some(
        ([faction, creatures]) => faction !== "version" && name in creatures,
    );
    if (!known) throw new Error(`RECORD_KEEP_ABILITIES: unknown creature ${name}`);
}

// RECORD_FACTION="Chaos" (or "Chaos|Life", green|red; an empty side keeps the full pool) drafts that team's roster
// from one faction (buildRoster's factionFilter), so its synergy reaches level 2 or 3 (Chaos break 11/17%, Life
// morale +13/+20, Nature flyer armor 24/35%). A setup option: it changes the rosters.
const FACTION_MODE = (process.env.RECORD_FACTION ?? "").trim();
const FACTIONS = FACTION_MODE.split("|").map((part) => part.trim());
for (const faction of FACTIONS) {
    if (faction && !["Life", "Chaos", "Might", "Nature"].includes(faction)) {
        throw new Error(`RECORD_FACTION: unknown faction ${faction}`);
    }
}
const factionFor = (teamIndex: number): string | undefined =>
    FACTION_MODE ? (teamIndex === 0 ? FACTIONS[0] : (FACTIONS[1] ?? FACTIONS[0])) || undefined : undefined;

/** buildRoster, then each slot swapped (deterministically per seed) for a kept creature of the same level. */
function rosterFor(seed: number, teamIndex = 0): ReturnType<typeof buildRoster> {
    const faction = factionFor(teamIndex);
    const base = faction ? buildRoster(makeRng(seed), undefined, undefined, faction) : buildRoster(makeRng(seed));
    if (!KEEP.size) return base;
    const rng = makeRng(Math.imul(seed, 7919) >>> 0);
    return base.map((spec) => {
        const pool = creaturesByLevel(spec.level).filter((entry) => KEEP.has(entry.creatureName));
        if (!pool.length || rng() >= KEEP_RATE) return spec;
        const pick = pool[Math.floor(rng() * pool.length)];
        return {
            faction: pick.faction,
            creatureName: pick.creatureName,
            level: pick.level,
            size: pick.size,
            ...(pick.footprintWidth === undefined || pick.footprintHeight === undefined
                ? {}
                : { footprintWidth: pick.footprintWidth, footprintHeight: pick.footprintHeight }),
            amount: spec.amount,
        };
    });
}

// ---- map and board orientation ----
// RECORD_GRID=1|3|4|mix picks NORMAL, LAVA_CENTER or BLOCK_CENTER for every battle, or a per-seed mix weighted by
// RECORD_MAP_WEIGHTS (NORMAL,LAVA,BLOCK; default 1,1,1 = production's thirds). The mix hashes the seed into a private
// mulberry32 stream, so it touches no battle stream and a seed always gets the same map and roster.
// RECORD_SIDE=1 plays the production side-oriented boards (side deployment zones, the Backstab axis on x, and on
// BLOCK_CENTER the scattered stones seeded `sim-${seed}`). The defaults (1, 0) reproduce the classic NORMAL recordings.
const GRID_MODE = process.env.RECORD_GRID ?? process.env.RECORD_GRID_TYPE ?? "1";
const MAP_WEIGHTS = (process.env.RECORD_MAP_WEIGHTS ?? "1,1,1").split(",").map(Number);
const SIDE_ORIENTED = (process.env.RECORD_SIDE ?? process.env.RECORD_SIDE_ORIENTED) === "1";
if (!["1", "3", "4", "mix"].includes(GRID_MODE))
    throw new Error(`RECORD_GRID: expected 1, 3, 4 or mix, got ${GRID_MODE}`);
if (
    MAP_WEIGHTS.length !== 3 ||
    MAP_WEIGHTS.some((w) => !(w >= 0)) ||
    MAP_WEIGHTS[0] + MAP_WEIGHTS[1] + MAP_WEIGHTS[2] <= 0
) {
    throw new Error("RECORD_MAP_WEIGHTS: expected three non-negative weights NORMAL,LAVA,BLOCK");
}
/** Terrain columns (start state and digest) are written whenever the board is not the classic NORMAL one. */
const TERRAIN = GRID_MODE !== "1" || SIDE_ORIENTED;

function gridTypeFor(seed: number): number {
    if (GRID_MODE !== "mix") return Number(GRID_MODE);
    const u = makeRng(Math.imul(seed ^ 0x51ed270b, 0x2c1b3c6d) >>> 0)();
    let r = u * (MAP_WEIGHTS[0] + MAP_WEIGHTS[1] + MAP_WEIGHTS[2]);
    if ((r -= MAP_WEIGHTS[0]) < 0) return 1;
    if ((r -= MAP_WEIGHTS[1]) < 0) return 3;
    return 4;
}

// ---- army setup (augments, doctrines, synergies, artifacts) ----
// All off by default; then the recording is exactly the setup-free one. Any setup option turns on the setup columns:
// each start-state unit gains `initialProps` (initialUnitProperties: runMatch's setup refresh folds augments and
// synergies into props before recording, so props are no longer the base the engine recomputes from) and
// `buffsSources` (each buff's first;second stored property, e.g. Sniper Augment "27;70"), the start state gains
// `setup` (the synergy variants and, per team, the doctrine, augment levels, artifacts, synergy list and the
// constant getAdditional*PerTeam / getBreakChancePerTeam values) and `effectConfigs.Break`, every battle line gains
// `requested` (the setup passed to runMatch), and the unit digest gains shot_distance, base_armor_init and steps_init.
//   RECORD_AUGMENTS=random            per team, kinds in random order, each a uniform level 0..min(cap, remaining)
//                                     inside the doctrine budget (caps Placement 2, Armor 3, Might 3, Sniper 3,
//                                     Movement 2)
//   RECORD_AUGMENTS=production        resolveSetupPolicy(v0.8 spec).pickAugments, then the a19 striker-rush or
//                                     shooterless rewrite the server applies (the revealed-ranged delivery layer is
//                                     left out: it needs the live draft state)
//   RECORD_AUGMENTS="Armor:3,Sniper:3,Might:1"             one plan for both teams (Empower allowed)
//   RECORD_AUGMENTS="Armor:3,Movement:2|Sniper:3,Might:2"  green|red
//   RECORD_DOCTRINE=random|1|2|3      per-team doctrine (upgrade budget 6/5/7); unset = NO_DOCTRINE (budget 7)
//   RECORD_SYNERGIES=1                every faction with >= 2 distinct creatures fields the board's variant
//                                     (liveRankedDraftSynergies); any listed synergy turns on every faction the army
//                                     qualifies for (setSynergyUnitsPerFactions)
//   RECORD_SYNERGY_VARIANTS=default|seed|random|"Life:2,Chaos:2,Might:2,Nature:1"
//                                     the board variants (seed = synergyVariantsForSeed(`rec-${seed}`), production's
//                                     function; default never fields Chaos break or Life morale/luck)
//   RECORD_DISTINCT_RED=1             red drafts its own roster (rosterFor(seed ^ 0x5bd1e995)): asymmetric synergies
//                                     and augment plans; not comparable with mirrored recordings
//   RECORD_PLACEMENT_TIMING=setup-before-placement   production's zone timing (Placement widens the zone first)
//   RECORD_FACTION="Chaos|"           one-faction rosters, so synergies reach level 2 or 3 (see rosterFor above)
//   RECORD_ARTIFACTS=random|"t1:t2"|"t1:t2|t1:t2"   Tier-1/Tier-2 ids (random = the live pools plus 0), for the
//                                     artifact batch (the Zig loader refuses artifact buffs)
//   RECORD_TRACE_DRAWS=1              every engine/decide step gets `ds`, the getRandomInt caller of each raw draw
//                                     (applyDamage's break roll also names the hit that called it), and
//                                     <out>.sites.json tallies them
// Production-like setup: RECORD_AUGMENTS=production RECORD_DOCTRINE=random RECORD_SYNERGIES=1
// RECORD_SYNERGY_VARIANTS=seed RECORD_DISTINCT_RED=1 RECORD_PLACEMENT_TIMING=setup-before-placement.
type AugKind = "Placement" | "Armor" | "Might" | "Sniper" | "Movement" | "Empower";
type Aug = { kind: AugKind; value: number };
const AUG_MODE = (process.env.RECORD_AUGMENTS ?? "").trim();
const DOCTRINE_MODE = (process.env.RECORD_DOCTRINE ?? "").trim();
const SYN_ON = ["1", "on", "true"].includes((process.env.RECORD_SYNERGIES ?? "").trim().toLowerCase());
const VARIANT_MODE = (process.env.RECORD_SYNERGY_VARIANTS ?? "default").trim();
const DISTINCT_RED = process.env.RECORD_DISTINCT_RED === "1";
const PLACEMENT_TIMING = (process.env.RECORD_PLACEMENT_TIMING ?? "").trim();
const ARTIFACT_MODE = (process.env.RECORD_ARTIFACTS ?? "").trim();
const TRACE = process.env.RECORD_TRACE_DRAWS === "1";
if (PLACEMENT_TIMING && PLACEMENT_TIMING !== "setup-before-placement") {
    throw new Error(`RECORD_PLACEMENT_TIMING: expected setup-before-placement, got ${PLACEMENT_TIMING}`);
}
/** Any setup option: the setup columns are written. */
const SETUP = !!(
    AUG_MODE ||
    DOCTRINE_MODE ||
    SYN_ON ||
    VARIANT_MODE !== "default" ||
    DISTINCT_RED ||
    PLACEMENT_TIMING ||
    ARTIFACT_MODE ||
    FACTION_MODE
);
/** RECORD_AUGMENTS=random levels; the explicit plans also accept Empower (read only by magic damage). */
const RANDOM_AUG_CAP: Record<string, number> = { Placement: 2, Armor: 3, Might: 3, Sniper: 3, Movement: 2 };
const AUG_KINDS = new Set<string>(["Placement", "Armor", "Might", "Sniper", "Movement", "Empower"]);
const V08_SETUP_SPEC = "artifact-fit-v8:conditional-v1:sniper+t2a19";
const v08SetupPolicy = AUG_MODE === "production" ? resolveSetupPolicy(V08_SETUP_SPEC) : undefined;

const parsePlan = (spec: string): Aug[] =>
    spec
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const [kind, value] = part.split(":");
            if (!AUG_KINDS.has(kind)) throw new Error(`RECORD_AUGMENTS: unknown kind ${kind}`);
            return { kind: kind as AugKind, value: Number(value) };
        });

const creatureIds = (roster: { creatureName: string }[]): number[] => [
    ...new Set(roster.map((spec) => creatureIdForName(spec.creatureName) ?? 0).filter((id) => id > 0)),
];

function augmentsFor(
    seed: number,
    teamIndex: number,
    budget: number,
    own: { creatureName: string }[],
    opp: { creatureName: string }[],
): Aug[] | undefined {
    if (!AUG_MODE) return undefined;
    if (AUG_MODE === "random") {
        const rng = makeRng((Math.imul(seed, 2654435761) ^ (teamIndex * 0x27d4eb2d)) >>> 0);
        const kinds = Object.keys(RANDOM_AUG_CAP)
            .map((kind) => ({ kind, r: rng() }))
            .sort((a, b) => a.r - b.r)
            .map((entry) => entry.kind);
        let remaining = budget;
        const out: Aug[] = [];
        for (const kind of kinds) {
            const level = Math.floor(rng() * (Math.min(RANDOM_AUG_CAP[kind], remaining) + 1));
            if (level > 0) {
                out.push({ kind: kind as AugKind, value: level });
                remaining -= level;
            }
        }
        return out;
    }
    if (AUG_MODE === "production") {
        const ownIds = creatureIds(own);
        const oppIds = creatureIds(opp);
        const base = v08SetupPolicy!.pickAugments(budget, ownIds) as any[];
        const plan = isA19StrikerRushSetup(ownIds, oppIds, true, A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS)
            ? a19StrikerRushAugments(base, budget, ownIds)
            : a19ShooterlessAugments(base, ownIds);
        return (plan as any[]).map((a) => ({ kind: a.kind, value: a.value }));
    }
    const [green, red] = AUG_MODE.split("|");
    return parsePlan(teamIndex === 0 ? green : (red ?? green));
}

function artifactsFor(seed: number, teamIndex: number): [number, number] | undefined {
    if (!ARTIFACT_MODE) return undefined;
    if (ARTIFACT_MODE === "random") {
        const rng = makeRng((Math.imul(seed, 0x2c1b3c6d) ^ (teamIndex * 0x297a2d39)) >>> 0);
        const t1 = [0, ...TIER1_ARTIFACT_LIST.map((a: any) => a.id)];
        const t2 = [0, ...TIER2_ARTIFACT_LIST.map((a: any) => a.id)];
        return [t1[Math.floor(rng() * t1.length)], t2[Math.floor(rng() * t2.length)]];
    }
    const [green, red] = ARTIFACT_MODE.split("|");
    const [t1, t2] = (teamIndex === 0 ? green : (red ?? green)).split(":").map(Number);
    return [t1 || 0, t2 || 0];
}

function doctrineFor(seed: number, teamIndex: number): number | undefined {
    if (!DOCTRINE_MODE) return undefined;
    if (DOCTRINE_MODE === "random") return 1 + (((Math.imul(seed ^ 0x9e37, 0x85ebca6b) >>> 0) + teamIndex * 7) % 3);
    return Number(DOCTRINE_MODE);
}

function variantsFor(seed: number): Record<string, number> | undefined {
    if (VARIANT_MODE === "default") return undefined;
    if (VARIANT_MODE === "seed") return synergyVariantsForSeed(`rec-${seed}`);
    if (VARIANT_MODE === "random") {
        const rng = makeRng((Math.imul(seed, 0x1b873593) ^ 0x77) >>> 0);
        return Object.fromEntries(
            Object.entries(FACTION_SYNERGY_PAIRS).map(([faction, pair]: [string, any]) => [
                faction,
                pair[rng() < 0.5 ? 0 : 1],
            ]),
        );
    }
    return Object.fromEntries(
        VARIANT_MODE.split(",").map((part) => {
            const [faction, variant] = part.split(":");
            return [faction.trim(), Number(variant)];
        }),
    );
}

/** Every faction with at least two DISTINCT creatures fields the board's variant (liveRankedDraftSynergies). */
function synergiesFor(
    roster: { faction: string; creatureName: string }[],
    variants: Record<string, number>,
): { faction: number; synergy: number }[] | undefined {
    if (!SYN_ON) return undefined;
    const distinct = new Map<string, Set<string>>();
    for (const spec of roster) {
        const names = distinct.get(spec.faction) ?? new Set<string>();
        names.add(spec.creatureName);
        distinct.set(spec.faction, names);
    }
    const out: { faction: number; synergy: number }[] = [];
    for (const faction of ["Life", "Nature", "Chaos", "Might"]) {
        if ((distinct.get(faction)?.size ?? 0) >= 2) {
            out.push({ faction: (ToFactionType as any)[faction], synergy: variants[faction] });
        }
    }
    return out;
}

/** Caller (basename:line) of the getRandomInt that drew the current raw value. */
function drawSite(): string {
    const lines = (new Error().stack ?? "").split("\n");
    const at = lines.findIndex((line) => line.includes("getRandomInt"));
    const name = (frame: string): string => {
        const match = frame.match(/at (\S+) .*\/([^/]+\.ts):(\d+)/) ?? frame.match(/\/([^/]+\.ts):(\d+)/);
        if (!match) return frame.trim();
        return match.length === 4 ? `${match[1]}@${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
    };
    const site = name(at >= 0 ? (lines[at + 1] ?? "") : (lines[3] ?? ""));
    // A break roll is drawn inside applyDamage: name the hit that called it too.
    return site.startsWith("applyDamage@") && at >= 0 ? `${site}<${name(lines[at + 2] ?? "")}` : site;
}

// ---- seeded stream with an observable state ----
class Mulberry {
    public state: number;
    public draws = 0;
    public constructor(seed: number) {
        this.state = seed >>> 0;
    }
    public next = (): number => {
        this.draws += 1;
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

function unitDigest(u: any): unknown[] {
    const p = u.getUnitProperties();
    const c = u.getBaseCell();
    return [
        u.getId(),
        p.amount_alive,
        p.amount_died,
        p.hp,
        p.max_hp,
        c.x,
        c.y,
        u.isDead() ? 1 : 0,
        u.getResponded() ? 1 : 0,
        u.isOnHourglass() ? 1 : 0,
        u.hasMovedThisTurn() ? 1 : 0,
        p.stack_power,
        p.morale,
        p.luck,
        p.luck_mod,
        p.attack_mod,
        p.armor_mod,
        p.base_armor,
        p.base_attack,
        p.steps,
        p.steps_mod,
        p.initiative,
        p.range_shots,
        p.range_shots_mod,
        p.range_armor,
        p.attack_multiplier,
        p.attack_damage_min,
        p.attack_damage_max,
        p.attack_type_selected,
        p.applied_buffs.join(","),
        p.applied_buffs_laps.join(","),
        p.applied_debuffs.join(","),
        p.applied_debuffs_laps.join(","),
        p.applied_effects.join(","),
        p.applied_effects_laps.join(","),
        u.getPosition().x,
        u.getPosition().y,
        u.initialUnitProperties.morale,
        u.luckPerTurn,
        p.applied_buffs_powers.join(","),
        p.applied_debuffs_powers.join(","),
        p.applied_effects_powers.join(","),
        u.initialUnitProperties.base_attack,
        u.getMovedRouteCellsThisTurn(),
        u.getTarget() ?? "",
        p.magic_resist,
        u
            .getBuffs()
            .map((b: any) => `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`)
            .join(","),
        // Setup columns: Sniper moves shot_distance on every refresh; Bitter Experience moves the two bases.
        ...(SETUP ? [p.shot_distance, u.initialUnitProperties.base_armor, u.initialUnitProperties.steps] : []),
    ];
}

const DIGEST_FIELDS = [
    "id",
    "amount_alive",
    "amount_died",
    "hp",
    "max_hp",
    "x",
    "y",
    "dead",
    "responded",
    "hourglass",
    "moved",
    "stack_power",
    "morale",
    "luck",
    "luck_mod",
    "attack_mod",
    "armor_mod",
    "base_armor",
    "base_attack",
    "steps",
    "steps_mod",
    "initiative",
    "range_shots",
    "range_shots_mod",
    "range_armor",
    "attack_multiplier",
    "attack_damage_min",
    "attack_damage_max",
    "attack_type_selected",
    "buffs",
    "buffs_laps",
    "debuffs",
    "debuffs_laps",
    "effects",
    "effects_laps",
    "px",
    "py",
    "base_morale",
    "luck_per_turn",
    "buffs_powers",
    "debuffs_powers",
    "effects_powers",
    "base_attack_init",
    "moved_route_cells",
    "target",
    "magic_resist",
    "buffs_sources",
    ...(SETUP ? ["shot_distance", "base_armor_init", "steps_init"] : []),
];

function fightDigest(fp: any): Record<string, unknown> {
    const sorted = (s: Set<string>): string[] => [...s].sort();
    return {
        lap: fp.currentLap,
        started: fp.fightStarted ? 1 : 0,
        finished: fp.fightFinished ? 1 : 0,
        firstTurnMade: fp.firstTurnMade ? 1 : 0,
        previousTurnTeam: fp.previousTurnTeam,
        highestInitiative: fp.highestInitiativeThisTurn,
        stepsMoraleMultiplier: fp.stepsMoraleMultiplier,
        additionalNarrowingLaps: fp.additionalNarrowingLaps,
        upNext: fp.upNextQueue.toArray(),
        hourglassQ: fp.hourglassQueue.toArray(),
        moralePlusQ: fp.moralePlusQueue.toArray(),
        moraleMinusQ: fp.moraleMinusQueue.toArray(),
        made: sorted(fp.alreadyMadeTurn),
        hourglassSet: sorted(fp.alreadyHourglass),
        replied: sorted(fp.alreadyRepliedAttack),
        damageLaps: [...fp.damageDealFactPerLap.entries()]
            .filter(([, v]: [number, boolean]) => v)
            .map(([k]: [number, boolean]) => k)
            .sort((a: number, b: number) => a - b),
    };
}

/** Terrain state the engine changes during play: the classic hit counters and cleared sides, the dried lava centre,
 * and the standing scattered stones in layout order (Grid's fields are private). */
function terrainDigest(grid: any, fp: any): Record<string, unknown> {
    return {
        hitsL: fp.getObstacleHitsLeftLeft(),
        hitsR: fp.getObstacleHitsLeftRight(),
        leftCleared: grid.leftMountainCleared ? 1 : 0,
        rightCleared: grid.rightMountainCleared ? 1 : 0,
        cleanedUpCenter: grid.cleanedUpCenter ? 1 : 0,
        standing: grid.getScatteredMountainsStanding().map((c: any) => [c.x, c.y]),
    };
}

function digest(ctx: Ctx): { units: unknown[][]; fight: Record<string, unknown> } {
    const units: unknown[][] = [];
    for (const u of ctx.unitsHolder.getAllUnits().values()) units.push(unitDigest(u));
    const emberTeams = [...(ctx.unitsHolder.emberCovenantTeams ?? [])].sort();
    const fight: Record<string, unknown> = { ...fightDigest(ctx.fightProperties), emberTeams };
    if (TERRAIN) fight.terrain = terrainDigest(ctx.grid, ctx.fightProperties);
    return { units, fight };
}

function initialState(ctx: Ctx, rosterSeed: number): Record<string, unknown> {
    const settings = ctx.grid.getSettings();
    const units: unknown[] = [];
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        const p = u.getUnitProperties();
        units.push({
            id: u.getId(),
            name: u.getName(),
            // PBTypes.CreatureVals of the creature (creature_score.creatureIdForName), 0 when it has none.
            creatureId: creatureIdForName(u.getName()) ?? 0,
            faction: p.faction,
            team: u.getTeam(),
            level: u.getLevel(),
            size: u.getSize(),
            footprintW: u.getFootprintWidth(),
            footprintH: u.getFootprintHeight(),
            baseCell: { ...u.getBaseCell() },
            cells: u.getCells().map((c: any) => ({ ...c })),
            position: { ...u.getPosition() },
            props: JSON.parse(JSON.stringify(p)),
            ...(SETUP
                ? {
                      initialProps: JSON.parse(JSON.stringify(u.initialUnitProperties)),
                      buffsSources: u
                          .getBuffs()
                          .map((b: any) => `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`),
                  }
                : {}),
        });
    }
    const abilityConfigs: Record<string, any> = {};
    const effectConfigs: Record<string, unknown> = {};
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        for (const name of u.getUnitProperties().abilities) {
            if (name in abilityConfigs) continue;
            abilityConfigs[name] = JSON.parse(JSON.stringify(getAbilityConfig(name)));
            const effect = abilityConfigs[name].effect;
            if (effect && !(effect in effectConfigs)) {
                effectConfigs[effect] = JSON.parse(JSON.stringify(getEffectConfig(effect) ?? null));
            }
        }
    }
    // Configs the engine reads without an ability naming them: aura effects (range, power, recipients), the
    // Poison effect a Venom Cloud hit applies, and the System spell Ember Covenant seeds.
    const auraEffectConfigs: Record<string, unknown> = {};
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        for (const name of u.getUnitProperties().aura_effects ?? []) {
            if (!(name in auraEffectConfigs)) {
                auraEffectConfigs[name] = JSON.parse(JSON.stringify(getAuraEffectConfig(name) ?? null));
            }
        }
    }
    if (!("Poison" in effectConfigs))
        effectConfigs.Poison = JSON.parse(JSON.stringify(getEffectConfig("Poison") ?? null));
    // The Chaos synergy's break-on-attack effect.
    if (SETUP && !("Break" in effectConfigs))
        effectConfigs.Break = JSON.parse(JSON.stringify(getEffectConfig("Break") ?? null));
    const spellConfigs: Record<string, unknown> = {
        "Ember Covenant Blessing": JSON.parse(JSON.stringify(getSpellConfig("System", "Ember Covenant Blessing"))),
    };
    const fp = ctx.fightProperties;
    return {
        rosterSeed,
        keep: [...KEEP],
        abilityConfigs,
        effectConfigs,
        auraEffectConfigs,
        spellConfigs,
        grid: {
            gridType: fp.getGridType(),
            size: settings.getGridSize(),
            cellSize: settings.getCellSize(),
            minX: settings.getMinX(),
            maxX: settings.getMaxX(),
            minY: settings.getMinY(),
            maxY: settings.getMaxY(),
            matrix: ctx.grid.getMatrix(),
        },
        // The Zig start state rebuilds the board from these (grid.matrix stays as a cross-check): the scattered
        // layout in roll order (getCenterCells and the AI's strike search read that order), the stones standing,
        // the classic hit counters and cleared sides, the dried centre, and the board orientation.
        ...(TERRAIN
            ? {
                  terrain: {
                      ...terrainDigest(ctx.grid, fp),
                      layout: ctx.grid.scatteredMountainLayout.map((c: any) => [c.x, c.y]),
                      sideOriented: fp.isSideOrientedPlacement() ? 1 : 0,
                  },
              }
            : {}),
        fight: {
            ...fightDigest(fp),
            numberOfLapsTillNarrowing: fp.getNumberOfLapsTillNarrowing(),
            teamUnitsAlive: [...fp.teamUnitsAlive.entries()],
        },
        ...(SETUP ? { setup: setupState(fp) } : {}),
        units,
    };
}

/** Per-team setup as FightProperties holds it after the runMatch setup block (team 2 = LEFT/green, 1 = RIGHT/red). */
function setupState(fp: any): Record<string, unknown> {
    const perTeam: Record<string, unknown> = {};
    for (const team of [2, 1]) {
        perTeam[team] = {
            doctrine: fp.getDoctrine(team),
            upgradePoints: fp.getUpgradePoints(team),
            augments: {
                Placement: fp.getAugmentPlacementLevel(team),
                Armor: fp.getAugmentArmor(team),
                Might: fp.getAugmentMight(team),
                Sniper: fp.getAugmentSniper(team),
                Movement: fp.getAugmentMovement(team),
                Empower: fp.getAugmentEmpower(team),
            },
            artifactT1: fp.getArtifactTier1(team),
            artifactT2: fp.getArtifactTier2(team),
            synergies: [...fp.getSynergiesPerTeam(team)],
            abilityPower: fp.getAdditionalAbilityPowerPerTeam(team),
            movementSteps: fp.getAdditionalMovementStepsPerTeam(team),
            flyArmor: fp.getAdditionalFlyArmorPerTeam(team),
            morale: fp.getAdditionalMoralePerTeam(team),
            luck: fp.getAdditionalLuckPerTeam(team),
            supply: fp.getAdditionalSupplyPerTeam(team),
            auraRange: fp.getAdditionalAuraRangePerTeam(team),
            breakChance: fp.getBreakChancePerTeam(team),
            boardUnits: fp.getNumberOfUnitsAvailableForPlacement(team),
        };
    }
    return { variants: fp.getSynergyVariants(), perTeam };
}

function main(): void {
    const games = Number(process.argv[2] ?? 50);
    const firstSeed = Number(process.argv[3] ?? 1);
    const out = process.argv[4] ?? "zig/parity/out/battles.jsonl";
    mkdirSync(dirname(out), { recursive: true });

    let ctx: Ctx | undefined;
    let rng: Mulberry | undefined;
    let steps: unknown[] = [];
    let depth = 0;
    let engineNanos = 0n;
    let decideNanos = 0n;
    let decisions = 0;
    let warmDecideNanos = 0n;
    let warmDecisions = 0;
    let recording = false;
    const warmup = Number(process.env.RECORD_WARMUP_GAMES ?? 100);
    let warmNanos = 0n;
    let warmSteps = 0;

    // getRandomInt call sites (one entry per raw draw) while recording, for RECORD_TRACE_DRAWS.
    const siteLog: string[] = [];
    const siteTally = new Map<string, number>();

    const wrap = (proto: any, method: string, kind: string): void => {
        const original = proto[method];
        proto[method] = function (this: unknown, arg: unknown) {
            if (!recording || depth > 0 || !ctx || !rng) return original.call(this, arg);
            const r0 = rng.state;
            const d0 = rng.draws;
            const site0 = siteLog.length;
            depth += 1;
            const t0 = process.hrtime.bigint();
            let result: any;
            try {
                result = original.call(this, arg);
            } finally {
                engineNanos += process.hrtime.bigint() - t0;
                depth -= 1;
            }
            steps.push({
                k: kind,
                a: arg ?? {},
                r0,
                r1: rng.state,
                draws: rng.draws - d0,
                ok: kind === "advance" ? 1 : result.completed ? 1 : 0,
                rej: result.rejectionReason ?? null,
                ev: result.events.map((e: any) => [e.type, e.unitId ?? e.winningTeam ?? null]),
                s: digest(ctx),
                ...(TRACE ? { ds: siteLog.slice(site0) } : {}),
            });
            return result;
        };
    };
    wrap(GameActionEngine.prototype, "apply", "apply");
    wrap(TurnEngine.prototype, "advanceAfterNoActiveUnit", "advance");

    // Optional: every PathHelper.getMovePath call (inputs and the ordered knownPaths), for the Zig path check.
    const pathsOut = process.env.RECORD_PATHS;
    const pathLines: string[] = [];
    if (pathsOut) {
        const getMovePath = PathHelper.prototype.getMovePath;
        PathHelper.prototype.getMovePath = function (this: unknown, ...args: any[]) {
            const result = (getMovePath as any).apply(this, args);
            if (recording) {
                const [cell, matrix, maxSteps, aggrBoard, canFly, isSmall, isMadeOfFire, hasVineStride, w, h] = args;
                const known: unknown[] = [];
                for (const [key, routes] of result.knownPaths) {
                    const r = routes[0];
                    known.push([key, r.weight, r.route.map((c: any) => [c.x, c.y]), r.hasLavaCell ? 1 : 0]);
                }
                pathLines.push(
                    JSON.stringify({
                        cell: [cell.x, cell.y],
                        matrix,
                        maxSteps,
                        aggr: aggrBoard,
                        canFly: !!canFly,
                        isSmall: isSmall ?? true,
                        fire: !!isMadeOfFire,
                        vine: !!hasVineStride,
                        w: w ?? (isSmall === false ? 2 : 1),
                        h: h ?? (isSmall === false ? 2 : 1),
                        known,
                    }),
                );
            }
            return result;
        };
    }

    // AI decisions: the unit, the random state around the call and the actions it returned. Engine calls made
    // inside a decision (none are expected for v0.1) are not recorded as steps.
    const decideTurn = StrategyV0_1.prototype.decideTurn;
    StrategyV0_1.prototype.decideTurn = function (this: unknown, unit: any, context: any) {
        if (!recording || depth > 0 || !rng) return decideTurn.call(this, unit, context);
        const r0 = rng.state;
        const d0 = rng.draws;
        const site0 = siteLog.length;
        depth += 1;
        let actions: unknown[];
        const t0 = process.hrtime.bigint();
        try {
            actions = decideTurn.call(this, unit, context);
        } finally {
            decideNanos += process.hrtime.bigint() - t0;
            decisions += 1;
            depth -= 1;
        }
        steps.push({
            k: "decide",
            a: { unitId: unit.getId() },
            r0,
            r1: rng.state,
            draws: rng.draws - d0,
            out: JSON.parse(JSON.stringify(actions)),
            ...(TRACE ? { ds: siteLog.slice(site0) } : {}),
        });
        return actions;
    };

    const lines: string[] = [];
    const gridCounts: Record<string, number> = {};
    let totalSteps = 0;
    const t0 = performance.now();
    for (let g = 0; g < games; g += 1) {
        const seed = firstSeed + g;
        const roster = rosterFor(seed);
        const gridType = gridTypeFor(seed);
        gridCounts[gridType] = (gridCounts[gridType] ?? 0) + 1;
        const redRoster = DISTINCT_RED ? rosterFor((seed ^ 0x5bd1e995) >>> 0, 1) : roster;
        const greenDoctrine = doctrineFor(seed, 0);
        const redDoctrine = doctrineFor(seed, 1);
        const greenAugments = augmentsFor(seed, 0, getUpgradePoints(greenDoctrine ?? 0), roster, redRoster);
        const redAugments = augmentsFor(seed, 1, getUpgradePoints(redDoctrine ?? 0), redRoster, roster);
        const greenArtifacts = artifactsFor(seed, 0);
        const redArtifacts = artifactsFor(seed, 1);
        const synergyVariants = variantsFor(seed);
        const boardVariants = synergyVariants ?? (DEFAULT_SYNERGY_VARIANTS as Record<string, number>);
        const greenSynergies = synergiesFor(roster, boardVariants);
        const redSynergies = synergiesFor(redRoster, boardVariants);
        siteLog.length = 0;
        steps = [];
        let init: Record<string, unknown> | undefined;
        const result = runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster,
            ...(DISTINCT_RED ? { redRoster } : {}),
            seed,
            maxLaps: 60,
            headlessEvents: true,
            gridType,
            ...(SIDE_ORIENTED ? { sideOrientedPlacement: true } : {}),
            ...(greenDoctrine ? { greenDoctrine } : {}),
            ...(redDoctrine ? { redDoctrine } : {}),
            ...(greenAugments ? { greenAugments } : {}),
            ...(redAugments ? { redAugments } : {}),
            ...(greenSynergies ? { greenSynergies } : {}),
            ...(redSynergies ? { redSynergies } : {}),
            ...(synergyVariants ? { synergyVariants } : {}),
            ...(greenArtifacts?.[0] ? { greenArtifactT1: greenArtifacts[0] } : {}),
            ...(greenArtifacts?.[1] ? { greenArtifactT2: greenArtifacts[1] } : {}),
            ...(redArtifacts?.[0] ? { redArtifactT1: redArtifacts[0] } : {}),
            ...(redArtifacts?.[1] ? { redArtifactT2: redArtifacts[1] } : {}),
            ...(PLACEMENT_TIMING ? { placementAugmentTiming: PLACEMENT_TIMING as "setup-before-placement" } : {}),
            beforeFightStart: (context) => {
                ctx = context as unknown as Ctx;
                // Replace the match's seeded stream with one whose state we can observe. Still deterministic.
                if (!getDeterministicRandomSource()) throw new Error("expected a seeded match");
                rng = new Mulberry(Math.imul(seed, 0x9e3779b1) >>> 0);
                const next = rng.next;
                setDeterministicRandomSource(
                    TRACE
                        ? () => {
                              if (recording && depth > 0) {
                                  const site = drawSite();
                                  siteLog.push(site);
                                  siteTally.set(site, (siteTally.get(site) ?? 0) + 1);
                              }
                              return next();
                          }
                        : next,
                );
                init = initialState(ctx, seed);
                recording = true;
            },
        });
        recording = false;
        ctx = undefined;
        rng = undefined;
        totalSteps += steps.filter((step: any) => step.k !== "decide").length;
        if (g === warmup - 1) {
            warmNanos = -engineNanos;
            warmSteps = -totalSteps;
            warmDecideNanos = -decideNanos;
            warmDecisions = -decisions;
        }
        lines.push(
            JSON.stringify({
                seed,
                winner: result.winner,
                endReason: result.endReason,
                laps: result.laps,
                init,
                ...(SETUP
                    ? {
                          requested: {
                              greenAugments,
                              redAugments,
                              greenSynergies,
                              redSynergies,
                              greenDoctrine,
                              redDoctrine,
                              greenArtifacts,
                              redArtifacts,
                          },
                      }
                    : {}),
                steps,
            }),
        );
    }
    const wall = performance.now() - t0;
    writeFileSync(out, lines.join("\n") + "\n");
    if (pathsOut) writeFileSync(pathsOut, pathLines.join("\n") + "\n");
    const meta = {
        games,
        firstSeed,
        steps: totalSteps,
        engineSteps: totalSteps,
        decisions,
        decideMs: Number(decideNanos) / 1e6,
        warmDecideNsPerDecision:
            games > warmup ? Number(decideNanos + warmDecideNanos) / Math.max(1, decisions + warmDecisions) : null,
        engineMs: Number(engineNanos) / 1e6,
        engineNsPerStep: Number(engineNanos) / Math.max(1, totalSteps),
        warmGames: Math.max(0, games - warmup),
        warmEngineNsPerStep:
            games > warmup ? Number(engineNanos + warmNanos) / Math.max(1, totalSteps + warmSteps) : null,
        wallMs: wall,
        digestFields: DIGEST_FIELDS,
        keep: [...KEEP],
        keepRate: KEEP_RATE,
        gridMode: GRID_MODE,
        mapWeights: MAP_WEIGHTS,
        sideOriented: SIDE_ORIENTED,
        gridTypes: gridCounts,
        ...(SETUP
            ? {
                  setup: {
                      augments: AUG_MODE || null,
                      doctrine: DOCTRINE_MODE || null,
                      synergies: SYN_ON,
                      synergyVariants: VARIANT_MODE,
                      distinctRed: DISTINCT_RED,
                      placementTiming: PLACEMENT_TIMING || null,
                      artifacts: ARTIFACT_MODE || null,
                      faction: FACTION_MODE || null,
                  },
              }
            : {}),
    };
    writeFileSync(out.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
    if (TRACE) {
        const tally = Object.fromEntries([...siteTally.entries()].sort((a, b) => b[1] - a[1]));
        writeFileSync(out.replace(/\.jsonl$/, ".sites.json"), JSON.stringify(tally, null, 2) + "\n");
    }
    console.log(JSON.stringify(meta));
    void num;
}

main();
