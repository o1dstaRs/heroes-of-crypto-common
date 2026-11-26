/*
 * Records headless battles from the TypeScript engine so the Zig engine can replay them step by step.
 *
 *   bun zig/parity/record.ts [games=50] [firstSeed=1] [out=zig/parity/out/battles.jsonl]
 *
 * Scope of the spike: every creature's abilities and spells are stripped (except the creatures named in
 * RECORD_KEEP_ABILITIES), v0.1 AI on both sides (RECORD_VERSION picks another). No artifacts, augments, synergies or
 * doctrines unless the setup options say otherwise (RECORD_AUGMENTS, RECORD_SYNERGIES, ..., below). The map is NORMAL on
 * a classic board unless RECORD_GRID / RECORD_SIDE say otherwise (below). RECORD_RESUME embeds mid-battle snapshots for
 * `hoc-sim resume` (below). The AI only chooses actions; what is recorded is every
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
import { FightProperties } from "../../src/fights/fight_properties";
import { getAIStrategy } from "../../src/ai";
import { captureAITargetMemory } from "../../src/ai/ai";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
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
import {
    buildRoster,
    createCombatFactories,
    createUnitFromSpec,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
    resolveStackAmount,
} from "../../src/simulation/army";
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
import { battleDigest, digestFields, fightDigest, terrainDigest } from "./digest";
import { exportBattleState, SPIT_BALL_DEBUFFS } from "./state_export";

type Ctx = { grid: any; fightProperties: any; unitsHolder: any };

// ---- scope: strip abilities and spells from every creature (harness-local mutation of the shared config) ----
// RECORD_KEEP_ABILITIES="Leprechaun,Nomad" keeps those creatures' abilities and spells, so the ported abilities can be
// checked batch by batch. RECORD_KEEP_RATE (default 0.6) is the chance each roster slot is swapped for a kept creature
// of the same level. RECORD_SPELLS="Heal,Blessing" keeps only those entries of the kept creatures' spellbooks
// (creatures.json `spells`; a castable ability such as Trent's Vine Throw is not a book entry and stays), so a battle
// casts only the spells the port covers. RECORD_AMOUNTS=expBudget sizes every stack as the live server does
// (buildRoster's amountMode: ceil(STACK_EXPERIENCE_BUDGET / exp)); the default levelTable keeps the 50/30/15/8 table.
const KEEP = new Set(
    (process.env.RECORD_KEEP_ABILITIES ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
);
const KEEP_RATE = Number(process.env.RECORD_KEEP_RATE ?? 0.6);
const SPELL_KEEP = process.env.RECORD_SPELLS
    ? new Set(
          process.env.RECORD_SPELLS.split(",")
              .map((name) => name.trim())
              .filter(Boolean),
      )
    : undefined;
// RECORD_STRIP_ABILITIES="Deep Wounds Level 2,AI Driven" strips those cards from the kept creatures (a stripped castable
// card takes its charge with it), so each ported card of a creature can be checked alone.
const STRIP = new Set(
    (process.env.RECORD_STRIP_ABILITIES ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
);
const AMOUNT_MODE = (process.env.RECORD_AMOUNTS ?? "levelTable").trim() as "levelTable" | "expBudget";
if (AMOUNT_MODE !== "levelTable" && AMOUNT_MODE !== "expBudget") {
    throw new Error(`RECORD_AMOUNTS: expected levelTable or expBudget, got ${AMOUNT_MODE}`);
}
/** The batch-4 creatures: keeping any turns on the batch-3 digest columns and the batch-4 `forbidden_target` column. */
const BATCH4_CREATURES = [
    "Wolf",
    "Berserker",
    "Frenzied Boar",
    "Griffin",
    "White Tiger",
    "Manticore",
    "Behemoth",
    "Troll",
];
const BATCH4 = BATCH4_CREATURES.some((name) => KEEP.has(name));
/** The batch-6a creatures: keeping any turns on the batch-3 columns; a castable card (Wind Flow, Resurrection) holds a
 * charge, so it counts as a kept spellbook. */
const BATCH6A_CREATURES = ["Dryad", "Valkyrie", "Angel", "Champion", "Wolf Rider", "Unicorn", "Mantis"];
const BATCH6A = BATCH6A_CREATURES.some((name) => KEEP.has(name));
/** A kept creature with a spellbook (or RECORD_SPELLS set): the spellbook digest columns and spell configs are written.
 * A kept batch-4 creature with a castable card (Behemoth's Battle Roar, Troll's Wild Regeneration) holds a charge too. */
let keptSpellbook = false;
for (const [faction, creatures] of Object.entries(creaturesJson as Record<string, any>)) {
    if (faction === "version" || typeof creatures !== "object") continue;
    for (const [name, creature] of Object.entries(creatures as Record<string, any>)) {
        if (KEEP.has(name)) {
            if (STRIP.size) creature.abilities = creature.abilities.filter((card: string) => !STRIP.has(card));
            if (
                (BATCH4_CREATURES.includes(name) || BATCH6A_CREATURES.includes(name)) &&
                creature.abilities.some((card: string) => getAbilityConfig(card)?.can_be_cast)
            ) {
                keptSpellbook = true;
            }
            if (SPELL_KEEP) {
                creature.spells = creature.spells.filter((entry: string) =>
                    SPELL_KEEP.has(entry.slice(entry.indexOf(":") + 1)),
                );
            }
            if (creature.spells.length) keptSpellbook = true;
            continue;
        }
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
    const base =
        AMOUNT_MODE === "expBudget"
            ? buildRoster(makeRng(seed), undefined, undefined, faction, AMOUNT_MODE)
            : faction
              ? buildRoster(makeRng(seed), undefined, undefined, faction)
              : buildRoster(makeRng(seed));
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
            // A swapped-in creature gets its own budget amount, not the replaced one's.
            amount:
                AMOUNT_MODE === "expBudget"
                    ? resolveStackAmount(pick.creatureName, pick.level, DEFAULT_AMOUNT_BY_LEVEL, AMOUNT_MODE)
                    : spec.amount,
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
//                                     artifact batch (the Zig loader refuses the artifacts it does not play)
//   RECORD_ARTIFACTS="pool:1,3,4/2,5,0"   per team, a uniform pick from each list (the ported artifacts, 0 = none)
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
// RECORD_DROP_DECISIONS=k (a test hook for runMatch's recovery net): every top-level decideTurn whose (seed, call index)
// hash is 0 mod k is computed (its draws stand) and then replaced by [] (recorded as `out: []`), so runMatch's recovery
// net (the mindless retry, or advanceTowardEnemyAction then defend) plays that turn. `hoc-sim native --drop k` mirrors it.
const DROP = Number(process.env.RECORD_DROP_DECISIONS ?? 0);
const dropped = (seed: number, index: number): boolean =>
    DROP > 0 && ((Math.imul(seed, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0) % DROP === 0;
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
// ---- resume points, AI version and decision origin ----
// RECORD_RESUME=random|random:<n>|<k>[,<k>...] embeds mid-battle snapshots for `hoc-sim resume`: at a decision boundary
// (an advance has just selected the active unit; its decideTurn has not run) the recorder exports the whole battle
// (state_export.ts) with the harness state the loop needs (the active unit, the random state = the decide step's r0;
// the damage-statistic laps are part of the export). `random` keeps one uniformly chosen decision per battle and
// `random:<n>` n of them (reservoir sampling on a private stream hashed from the seed: deterministic per seed, and it
// touches no battle stream); `<k>` keeps the k-th decision (0-based), so a battle with fewer decisions gets none. The
// game line gains `resume: [{step, decision, unitId, rng, state}]`, sorted by step (`step` indexes the decide step in
// `steps`), and the .meta.json gains `resume`.
// RECORD_VERSION=<version> (default v0.1) plays and records that strategy version on both seats: the decision wrapper
// goes on getAIStrategy(version)'s class (StrategyV0_1 for v0.1, StrategyV0_8 for v0.8, ...).
// RECORD_ORIGIN=rollout passes decisionOrigin "rollout" to every recorded decision (the mode A19 rollouts run the
// native policy in). RECORD_LAYERS=1 (v0.8 only) installs zig/parity/v08/layers.ts and adds `layers` and `memory`
// (the AI target memory before the decision) to each decide step. The .meta.json gains version, decisionOrigin and
// layers whenever one of the three is set. RECORD_LEAF=1 adds `leaf` (layers.ts leafOracle: the production V2 leaf of
// each team at the decision's board) to each decide step.
const RESUME_MODE = (process.env.RECORD_RESUME ?? "").trim();
const VERSION = (process.env.RECORD_VERSION ?? "v0.1").trim();
const ROLLOUT_ORIGIN = process.env.RECORD_ORIGIN === "rollout";
const LAYER_LOG = process.env.RECORD_LAYERS === "1";
const AI_OPTIONS = process.env.RECORD_VERSION !== undefined || ROLLOUT_ORIGIN || LAYER_LOG;
if (process.env.RECORD_ORIGIN && !["rollout", "match"].includes(process.env.RECORD_ORIGIN)) {
    throw new Error(`RECORD_ORIGIN: expected rollout or match, got ${process.env.RECORD_ORIGIN}`);
}
type ResumePlan = { kind: "random"; count: number } | { kind: "list"; decisions: Set<number> };
function parseResume(mode: string): ResumePlan | undefined {
    if (!mode) return undefined;
    const random = mode.match(/^random(?::(\d+))?$/);
    if (random) {
        const count = random[1] === undefined ? 1 : Number(random[1]);
        if (!(count >= 1)) throw new Error(`RECORD_RESUME: random:<n> needs n >= 1, got ${mode}`);
        return { kind: "random", count };
    }
    const decisions = mode.split(",").map((part) => Number(part.trim()));
    if (decisions.some((k) => !Number.isSafeInteger(k) || k < 0)) {
        throw new Error(`RECORD_RESUME: expected random, random:<n> or decision indices, got ${mode}`);
    }
    return { kind: "list", decisions: new Set(decisions) };
}
const RESUME = parseResume(RESUME_MODE);

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
    if (ARTIFACT_MODE.startsWith("pool:")) {
        const rng = makeRng((Math.imul(seed, 0x2c1b3c6d) ^ (teamIndex * 0x297a2d39)) >>> 0);
        const [t1s, t2s] = ARTIFACT_MODE.slice("pool:".length).split("/");
        const t1 = (t1s || "0").split(",").map(Number);
        const t2 = (t2s || "0").split(",").map(Number);
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

// ---- batch 3 (summons, stolen abilities, the Web lock) ----
// Keeping any batch-3 creature turns on the batch-3 digest columns (digest.ts). A battle whose start state holds an
// Infest unit records `init.summonTemplates` (the fresh createUnitFromSpec props of the creatures Infest raises,
// stripped like every other creature here) and, once a unit is summoned, `summonIds` (the summoned unit ids in
// creation order); its resume points gain `summonSequence` (runMatch's createSummonedUnit counter) and
// `summonsCreated`. Keep "Arachna Spider" beside "Arachna Queen": the summon-only Spider is stripped otherwise.
const BATCH3_CREATURES = ["Zena", "Arachna Queen", "Arachna Spider", "Squire", "Troglodyte", "Monk"];
const BATCH3 = BATCH3_CREATURES.some((name) => KEEP.has(name));
const SUMMON_CREATURES = ["Arachna Spider", "Arachna Queen"];
// ---- spells (wave 1) ----
// A kept spellbook (or RECORD_SPELLS) turns on the spell columns: the unit digest gains the batch-3 columns and then
// `spell_entries` (unitProperties.spells) and `spellbook` (the parsed Spells as name:charges), the fight digest gains
// `vines` ([x, y, laps, team] in Map order), the start state gains `spellConfigs` for every spell a unit can cast
// (keyed by name; the System "Vine Throw" config too, which the snare reads) and, when a unit holds a summon spell,
// the "Wolf" summon template. A Trent-only battle (Vine Throw is a castable ability, not a book) sets RECORD_SPELLS to
// get the columns.
const SPELLS = keptSpellbook || SPELL_KEEP !== undefined;
// ---- batch 4 ----
// Keeping any batch-4 creature turns on the batch-3 columns (the active and stolen lists move with gifts and steals;
// `debuffs_sources` names the Range Null Field row's source) and adds `forbidden_target` (Terrifying Gaze's lock, the
// gazer's id or "") as the last unit column. A start state holding Disguise Aura gains the System "Hidden" and
// "Visible" configs in `spellConfigs`. Under a RECORD_VERSION other than v0.1, a mindless unit's ("AI Driven")
// decisions, which runMatch makes with StrategyV0_1, are recorded as decide steps marked `v: "v0.1"`.
const BATCH3_COLUMNS = BATCH3 || SPELLS || BATCH4 || BATCH6A;
// ---- batch 5 ----
// No new digest column. A start state holding a Spit Ball card gains the seven debuffs' configs in `spellConfigs` (they
// are applied by an ability, so no book names them) and the .meta.json gains `spit`; a start-state unit holding Sniper
// records `initialProps` without setup options too (placement's setPosition rewrites its props.shot_distance, so the
// props are no initial distance).
const holdsCard = (name: string): boolean =>
    Object.entries(creaturesJson as Record<string, any>).some(
        ([faction, creatures]) =>
            faction !== "version" &&
            typeof creatures === "object" &&
            Object.entries(creatures as Record<string, any>).some(
                ([creature, cfg]) => KEEP.has(creature) && (cfg.abilities ?? []).includes(name),
            ),
    );
const SPIT = holdsCard("Spit Ball");
const SPELL_SUMMON_CREATURES = ["Wolf"];

const DIGEST_FIELDS = digestFields(SETUP, BATCH3 || BATCH4 || BATCH6A, SPELLS, BATCH4, SPELLS);

function digest(ctx: Ctx): { units: unknown[][]; fight: Record<string, unknown> } {
    return battleDigest(ctx, {
        setup: SETUP,
        terrain: TERRAIN,
        batch3: BATCH3 || BATCH6A,
        spells: SPELLS,
        batch4: BATCH4,
        helpingHand: SPELLS,
    });
}

/** Whether a unit of the holder can ever cast a summon spell (Summon Wolves). */
function canSummonBySpell(ctx: Ctx): boolean {
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().spells.some((entry: string) => entry.includes(":Summon "))) return true;
    }
    return false;
}

/** Whether a unit of the holder can ever summon (Infest, or a summon spell). */
function canSummon(ctx: Ctx): boolean {
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().abilities.includes("Infest")) return true;
    }
    return canSummonBySpell(ctx);
}

function canInfest(ctx: Ctx): boolean {
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().abilities.includes("Infest")) return true;
    }
    return false;
}

/** The props a summon starts from: createUnitFromSpec as runMatch's createSummonedUnit calls it (team 2; the loader
 * sets the summoner's team), and the configs of its abilities and aura effects. */
function summonTemplates(
    ctx: Ctx,
    abilityConfigs: Record<string, any>,
    effectConfigs: Record<string, unknown>,
    auraEffectConfigs: Record<string, unknown>,
): Record<string, unknown> {
    const { abilityFactory, effectFactory } = createCombatFactories();
    const out: Record<string, unknown> = {};
    const creatures = [
        ...(canInfest(ctx) ? SUMMON_CREATURES : []),
        ...(canSummonBySpell(ctx) ? SPELL_SUMMON_CREATURES : []),
    ];
    for (const creatureName of creatures) {
        const unit = createUnitFromSpec(
            { faction: "Nature", creatureName, level: 0, size: 0, amount: 1 },
            2,
            ctx.grid.getSettings(),
            abilityFactory,
            effectFactory,
            true,
            "00000000-0000-5000-8000-000000000000",
        );
        const p = unit.getUnitProperties();
        for (const name of p.abilities) {
            if (name in abilityConfigs) continue;
            abilityConfigs[name] = JSON.parse(JSON.stringify(getAbilityConfig(name)));
            const effect = abilityConfigs[name].effect;
            if (effect && !(effect in effectConfigs)) {
                effectConfigs[effect] = JSON.parse(JSON.stringify(getEffectConfig(effect) ?? null));
            }
        }
        for (const name of p.aura_effects ?? []) {
            if (!(name in auraEffectConfigs)) {
                auraEffectConfigs[name] = JSON.parse(JSON.stringify(getAuraEffectConfig(name) ?? null));
            }
        }
        out[creatureName] = {
            name: unit.getName(),
            creatureId: creatureIdForName(unit.getName()) ?? 0,
            level: unit.getLevel(),
            size: unit.getSize(),
            footprintW: unit.getFootprintWidth(),
            footprintH: unit.getFootprintHeight(),
            props: JSON.parse(JSON.stringify(p)),
            initialProps: JSON.parse(JSON.stringify(unit.initialUnitProperties)),
        };
    }
    return out;
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
            ...(!SETUP && (p.abilities ?? []).includes("Sniper")
                ? { initialProps: JSON.parse(JSON.stringify(u.initialUnitProperties)) }
                : {}),
            ...(SETUP
                ? {
                      initialProps: JSON.parse(JSON.stringify(u.initialUnitProperties)),
                      buffsSources: u
                          .getBuffs()
                          .map((b: any) => `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`),
                      ...(BATCH3_COLUMNS
                          ? {
                                debuffsSources: u
                                    .getDebuffs()
                                    .map(
                                        (b: any) =>
                                            `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`,
                                    ),
                            }
                          : {}),
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
    // Craft grants four cards mid-fight and stuns by name: their configs and the Stun / Freeze effects travel when a book
    // holds a Craft charge.
    if (
        [...ctx.unitsHolder.getAllUnits().values()].some((u: any) =>
            (u.getUnitProperties().spells ?? []).some((entry: string) => entry.endsWith(":Craft")),
        )
    ) {
        for (const name of CRAFTED_CARDS) {
            if (name in abilityConfigs) continue;
            abilityConfigs[name] = JSON.parse(JSON.stringify(getAbilityConfig(name)));
            const effect = abilityConfigs[name].effect;
            if (effect && !(effect in effectConfigs)) {
                effectConfigs[effect] = JSON.parse(JSON.stringify(getEffectConfig(effect) ?? null));
            }
        }
        if (!("Stun" in effectConfigs))
            effectConfigs.Stun = JSON.parse(JSON.stringify(getEffectConfig("Stun") ?? null));
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
    if (SPELLS) {
        // Every spell a unit's book or castable ability can cast (getSpellConfig of the entry's faction), then the
        // System Vine Throw the snare on an enemy vine reads.
        for (const u of ctx.unitsHolder.getAllUnits().values()) {
            for (const entry of u.getUnitProperties().spells as string[]) {
                const name = entry.slice(entry.indexOf(":") + 1);
                if (name in spellConfigs) continue;
                const faction = entry.slice(0, entry.indexOf(":")) || "System";
                spellConfigs[name] = JSON.parse(JSON.stringify(getSpellConfig(faction, name)));
            }
        }
        if (!("Vine Throw" in spellConfigs)) {
            spellConfigs["Vine Throw"] = JSON.parse(JSON.stringify(getSpellConfig("System", "Vine Throw")));
        }
    }
    // The Disguise markers the stat refresh writes (laps and power of the System spells).
    let disguise = false;
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().abilities.includes("Disguise Aura")) disguise = true;
    }
    if (disguise) {
        for (const name of ["Hidden", "Visible"]) {
            spellConfigs[name] = JSON.parse(JSON.stringify(getSpellConfig("System", name)));
        }
    }
    // Spit Ball's seven debuffs (Death and Order spells applied by the ability).
    let spitBall = false;
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().abilities.includes("Spit Ball")) spitBall = true;
    }
    if (spitBall) {
        for (const [faction, name] of SPIT_BALL_DEBUFFS) {
            spellConfigs[name] = JSON.parse(JSON.stringify(getSpellConfig(faction, name)));
        }
    }
    // Batch 6a: Hamstring applies the Death "Hamstrung" debuff (no book names it).
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        if (u.getUnitProperties().abilities.includes("Hamstring")) {
            spellConfigs.Hamstrung = JSON.parse(JSON.stringify(getSpellConfig("Death", "Hamstrung")));
            break;
        }
    }
    // Artifacts: Rime Charm and Gravechain apply the Death "Quagmire" and "Gravebound" debuffs.
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        const names = u.getUnitProperties().applied_buffs as string[];
        if (names.includes("Rime Charm") || names.includes("Gravechain")) {
            for (const name of ["Quagmire", "Gravebound"]) {
                spellConfigs[name] = JSON.parse(JSON.stringify(getSpellConfig("Death", name)));
            }
            break;
        }
    }
    // Artifacts: a Lava Striders army's lava routes apply the System "Made of Fire" buff.
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        const names = u.getUnitProperties().applied_buffs as string[];
        if (names.includes("Lava Striders") || names.includes("Made of Fire")) {
            spellConfigs["Made of Fire"] = JSON.parse(JSON.stringify(getSpellConfig("System", "Made of Fire")));
            break;
        }
    }
    const templates = canSummon(ctx)
        ? summonTemplates(ctx, abilityConfigs, effectConfigs, auraEffectConfigs)
        : undefined;
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
        ...(templates ? { summonTemplates: templates } : {}),
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

// zig/parity/v08/layers.ts (owned by the v0.8 port) is loaded only for RECORD_LAYERS=1 (the layer log) or
// RECORD_LEAF=1 (each decide step gains `leaf`: layers.ts leafOracle, the production V2 rollout leaf at the board, which
// `hoc-sim v08 leaf` reads).
const LEAF_LOG = process.env.RECORD_LEAF === "1";
const layersModule = LAYER_LOG ? await import("./v08/layers") : undefined;
const FORCE_CASTS = (process.env.RECORD_FORCE_CASTS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
let forcedCastCount = 0;
/** The cards Craft grants (craft_ability.ts). */
const CRAFTED_CARDS = ["Crafted Double Punch", "Crafted Double Shot", "Crafted Frozen Sword", "Crafted Frozen Bow"];
const forceSpellHelper = FORCE_CASTS.length ? await import("../../src/spells/spell_helper") : undefined;
const forceSpellProps = FORCE_CASTS.length ? await import("../../src/spells/spell_properties") : undefined;
const leafModule = LEAF_LOG ? (layersModule ?? (await import("./v08/layers"))) : undefined;

function main(): void {
    const games = Number(process.argv[2] ?? 50);
    const firstSeed = Number(process.argv[3] ?? 1);
    const out = process.argv[4] ?? "zig/parity/out/battles.jsonl";
    mkdirSync(dirname(out), { recursive: true });
    const strategyClass = Object.getPrototypeOf(getAIStrategy(VERSION)).constructor;
    if (!strategyClass?.prototype?.decideTurn) throw new Error(`RECORD_VERSION: no strategy for ${VERSION}`);

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

    // Summons (batch 3): runMatch's createSummonedUnit counter and the summoned ids in creation order.
    let summonTracking = false;
    let summonSeed = 0;
    let summonSequence = 0;
    let summonIds: string[] = [];
    const seenIds = new Set<string>();
    const noteSummons = (): void => {
        if (!summonTracking || !ctx) return;
        for (const id of ctx.unitsHolder.getAllUnits().keys()) {
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            summonIds.push(id);
        }
    };

    // getRandomInt call sites (one entry per raw draw) while recording, for RECORD_TRACE_DRAWS.
    const siteLog: string[] = [];
    const siteTally = new Map<string, number>();

    // runMatch's forceStalledLap (turn_recovery.ts) marks every living unit as having made its turn BETWEEN engine calls
    // (completeTurn, the only other writer, runs inside one): the next recorded step carries `stall`, the ids in call
    // order, which the engine replay applies first. Absent when it never fires (the recording is then unchanged).
    let stallMarks: string[] = [];
    const addAlreadyMadeTurn = FightProperties.prototype.addAlreadyMadeTurn;
    FightProperties.prototype.addAlreadyMadeTurn = function (this: unknown, team: any, id: string, ...rest: any[]) {
        if (recording && depth === 0 && ctx && this === ctx.fightProperties) stallMarks.push(id);
        return (addAlreadyMadeTurn as any).call(this, team, id, ...rest);
    };

    const wrap = (proto: any, method: string, kind: string): void => {
        const original = proto[method];
        proto[method] = function (this: unknown, arg: unknown) {
            if (!recording || depth > 0 || !ctx || !rng) return original.call(this, arg);
            const r0 = rng.state;
            const d0 = rng.draws;
            const site0 = siteLog.length;
            const stall = stallMarks.splice(0);
            depth += 1;
            const t0 = process.hrtime.bigint();
            let result: any;
            try {
                result = original.call(this, arg);
            } finally {
                engineNanos += process.hrtime.bigint() - t0;
                depth -= 1;
            }
            noteSummons();
            steps.push({
                k: kind,
                a: arg ?? {},
                ...(stall.length ? { stall } : {}),
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
                // The vines the pather reads (the fight's store), when there are any: the cells in Map order.
                const vineStore = ctx?.fightProperties?.getVines?.();
                const vines = vineStore?.size?.() ? vineStore.cells().map((c: any) => [c.x, c.y]) : undefined;
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
                        ...(vines ? { vines } : {}),
                    }),
                );
            }
            return result;
        };
    }

    // RECORD_LAYERS=1 (v0.8 only): each decision also records every inheritance level's and v0.8 pass's output.
    // Installed before the decision wrapper below captures decideTurn, so the wrapper calls the logged copy.
    let layersSha: string | undefined;
    if (layersModule) {
        if (!(getAIStrategy(VERSION) instanceof StrategyV0_8)) throw new Error("RECORD_LAYERS needs a v0.8 strategy");
        layersSha = layersModule.installLayerLog(() => rng?.state ?? 0);
    }

    // RECORD_RESUME: the decision points kept for this battle (reset per battle) and the private stream that picks
    // them.
    type ResumePoint = {
        step: number;
        decision: number;
        unitId: string;
        rng: number;
        summonSequence?: number;
        summonsCreated?: number;
        state: unknown;
    };
    let resumePoints: ResumePoint[] = [];
    let resumeRng: () => number = () => 0;
    let decisionIndex = 0;
    let dropIndex = 0;
    let dropSeed = 0;
    const keepResumePoint = (unit: any): void => {
        const index = decisionIndex;
        decisionIndex += 1;
        if (!RESUME || !ctx || !rng) return;
        const point = (): ResumePoint => ({
            step: steps.length,
            decision: index,
            unitId: unit.getId(),
            rng: rng!.state,
            ...(summonTracking ? { summonSequence, summonsCreated: summonIds.length } : {}),
            state: exportBattleState(ctx as any, summonTracking ? { seed: summonSeed, summonSequence } : undefined),
        });
        if (RESUME.kind === "list") {
            if (RESUME.decisions.has(index)) resumePoints.push(point());
        } else if (index < RESUME.count) {
            resumePoints.push(point());
        } else {
            const slot = Math.floor(resumeRng() * (index + 1));
            if (slot < RESUME.count) resumePoints[slot] = point();
        }
    };

    // RECORD_FORCE_CASTS="Fireforged Sword,Misfortune": an engine-replay aid for spells the AI rarely casts. A unit whose
    // turn it is, that has not moved and holds a listed spell usable, casts the first one the engine gate allows instead
    // of the strategy's decision: a buff on an ally (sweepers first, then area, double and through shooters, then any
    // shooter, others before the caster), anything else on an enemy that is not Hidden (Magic Reflection, Absorb
    // Penalties and Luck Blessing holders first). Installed before the decision wrapper below captures decideTurn, so
    // the recorded decision is the forced one; the .meta.json lists `forcedCasts`, and a native v0.8 check must skip
    // these battles.
    if (FORCE_CASTS.length && forceSpellHelper) {
        const SH = forceSpellHelper;
        const strategyDecide = strategyClass.prototype.decideTurn;
        const SWEEPERS = [
            "Lightning Spin",
            "Fire Breath",
            "Skewer Strike",
            "Area Throw",
            "Large Caliber",
            "Through Shot",
            "Chakram",
            "Double Punch",
            "Double Shot",
            "Double Throw",
        ];
        strategyClass.prototype.decideTurn = function (this: unknown, unit: any, context: any) {
            if (unit && !unit.hasMovedThisTurn()) {
                const gs = context.grid.getSettings();
                const matrix = context.grid.getMatrix();
                const all = [...context.unitsHolder.getAllUnits().values()].filter((u: any) => !u.isDead());
                for (const name of FORCE_CASTS) {
                    const spell = unit.getSpells().find((s: any) => s.getName() === name);
                    if (!spell || !SH.isSpellUsableByCaster(unit, spell)) continue;
                    // A mass spell is cast with no target when canMassCastSpell opens.
                    const targetType = spell.getSpellTargetType();
                    const STT = forceSpellProps!.SpellTargetType;
                    if (
                        targetType === STT.ALL_ALLIES ||
                        targetType === STT.ALL_ENEMIES ||
                        targetType === STT.ALL_FLYING
                    ) {
                        const holder = context.unitsHolder;
                        const team = unit.getTeam();
                        const open = SH.canMassCastSpell(
                            spell,
                            holder.getAllTeamUnitsBuffs(team),
                            holder.getAllEnemyUnitsBuffs(team),
                            holder.getAllEnemyUnitsDebuffs(team),
                            holder.getAllTeamUnitsMagicResist(team),
                            holder.getAllEnemyUnitsMagicResist(team),
                            holder.getAllTeamUnitsHp(team),
                            holder.getAllTeamUnitsMaxHp(team),
                            holder.getAllTeamUnitsCanFly(team),
                            holder.getAllEnemyUnitsCanFly(team),
                        );
                        if (!open) continue;
                        forcedCastCount += 1;
                        return [{ type: "cast_spell", casterId: unit.getId(), spellName: name }];
                    }
                    const ok = (t: any) =>
                        SH.canCastSpell(
                            false,
                            gs,
                            matrix,
                            unit,
                            t,
                            spell,
                            t.getBaseCell(),
                            t.getMagicResist(),
                            t.hasMindAttackResistance(),
                            t.canBeHealed(),
                            undefined,
                        );
                    let pool: any[];
                    if (spell.isBuff()) {
                        pool = all.filter((u: any) => u.getTeam() === unit.getTeam() && ok(u));
                        const score = (u: any) =>
                            (SWEEPERS.some((n) => u.hasAbilityActive(n)) ? 4 : 0) +
                            (u.getAttackType() === 2 ? 2 : 0) +
                            (u.getId() === unit.getId() ? 0 : 1);
                        pool.sort((a: any, b: any) => score(b) - score(a));
                    } else {
                        pool = all.filter(
                            (u: any) => u.getTeam() !== unit.getTeam() && !u.hasBuffActive("Hidden") && ok(u),
                        );
                        const score = (u: any) =>
                            (u.hasAbilityActive("Magic Reflection") ? 4 : 0) +
                            (u.getBuff("Absorb Penalties Aura") ? 2 : 0) +
                            (u.hasBuffActive("Luck Blessing") ? 1 : 0);
                        pool.sort((a: any, b: any) => score(b) - score(a));
                    }
                    if (pool.length) {
                        forcedCastCount += 1;
                        return [
                            { type: "cast_spell", casterId: unit.getId(), spellName: name, targetId: pool[0].getId() },
                        ];
                    }
                }
            }
            return strategyDecide.call(this, unit, context);
        };
    }

    // AI decisions: the unit, the random state around the call and the actions it returned. Engine calls made
    // inside a decision (none are expected for v0.1) are not recorded as steps.
    const decideTurn = strategyClass.prototype.decideTurn;
    // Mindless units ("AI Driven") are decided by runMatch with the shared StrategyV0_1 whatever the seat's version: under
    // another RECORD_VERSION those top-level calls (a version's own super chain runs inside the wrapper below, at
    // depth > 0) are recorded too, marked `v: "v0.1"` (no resume point, no layer log).
    if (VERSION !== "v0.1" && strategyClass !== StrategyV0_1) {
        const v01DecideTurn = StrategyV0_1.prototype.decideTurn;
        StrategyV0_1.prototype.decideTurn = function (this: unknown, unit: any, context: any) {
            if (!recording || depth > 0 || !rng) return v01DecideTurn.call(this, unit, context);
            const r0 = rng.state;
            const d0 = rng.draws;
            const site0 = siteLog.length;
            depth += 1;
            let actions: unknown[];
            const t0 = process.hrtime.bigint();
            try {
                actions = v01DecideTurn.call(this, unit, context);
                if (dropped(dropSeed, dropIndex++)) actions = [];
            } finally {
                decideNanos += process.hrtime.bigint() - t0;
                decisions += 1;
                depth -= 1;
            }
            steps.push({
                k: "decide",
                a: { unitId: unit.getId() },
                v: "v0.1",
                r0,
                r1: rng.state,
                draws: rng.draws - d0,
                out: JSON.parse(JSON.stringify(actions)),
                ...(TRACE ? { ds: siteLog.slice(site0) } : {}),
            });
            return actions;
        };
    }
    strategyClass.prototype.decideTurn = function (this: unknown, unit: any, context: any) {
        if (ROLLOUT_ORIGIN) context = { ...context, decisionOrigin: "rollout" };
        if (!recording || depth > 0 || !rng) return decideTurn.call(this, unit, context);
        if (RESUME) keepResumePoint(unit);
        const r0 = rng.state;
        const d0 = rng.draws;
        const site0 = siteLog.length;
        depth += 1;
        let actions: unknown[];
        const t0 = process.hrtime.bigint();
        // The AI's target memory (ai.ts previousTargetsByBattle) before the decision, so each logged decision can be
        // checked on its own: attacker id -> remembered target id.
        const memory = layersModule ? [...captureAITargetMemory(context.unitsHolder)] : undefined;
        if (layersModule) layersModule.beginDecision();
        let layers: unknown[] | undefined;
        let candidates: unknown[] | undefined;
        try {
            actions = decideTurn.call(this, unit, context);
            if (dropped(dropSeed, dropIndex++)) actions = [];
        } finally {
            if (layersModule) {
                layers = layersModule.endDecision();
                candidates = layersModule.endCandidates();
            }
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
            ...(layers ? { layers, memory, ...(candidates?.length ? { candidates } : {}) } : {}),
            ...(leafModule && ctx ? { leaf: leafModule.leafOracle(ctx.unitsHolder, ctx.fightProperties) } : {}),
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
        stallMarks = [];
        steps = [];
        resumePoints = [];
        summonTracking = false;
        summonSeed = seed;
        summonSequence = 0;
        summonIds = [];
        seenIds.clear();
        decisionIndex = 0;
        dropIndex = 0;
        dropSeed = seed;
        if (RESUME) resumeRng = makeRng(Math.imul(seed ^ 0x2545f491, 0x9e3779b1) >>> 0);
        let init: Record<string, unknown> | undefined;
        const result = runMatch({
            greenVersion: VERSION,
            redVersion: VERSION,
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
                if (canSummon(ctx)) {
                    summonTracking = true;
                    for (const id of ctx.unitsHolder.getAllUnits().keys()) seenIds.add(id);
                    // Summons in creation order, as the holder receives them: a summon can also leave within the
                    // step that made it (an Infest spawn a Last Fuse chain blast kills), so the after-step holder scan
                    // (noteSummons) alone would miss its id.
                    // (Non-enumerable, so the state export's field coverage check does not see it.)
                    const holder = ctx.unitsHolder as any;
                    const addUnit = holder.addUnit.bind(holder);
                    Object.defineProperty(holder, "addUnit", {
                        configurable: true,
                        enumerable: false,
                        writable: true,
                        value: (unit: any): void => {
                            addUnit(unit);
                            const id = unit.getId();
                            if (summonTracking && !seenIds.has(id)) {
                                seenIds.add(id);
                                summonIds.push(id);
                            }
                        },
                    });
                    const engineContext = context as any;
                    const createSummonedUnit = engineContext.createSummonedUnit;
                    engineContext.createSummonedUnit = (opts: unknown) => {
                        summonSequence += 1;
                        return createSummonedUnit(opts);
                    };
                }
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
                ...(summonIds.length ? { summonIds } : {}),
                ...(RESUME ? { resume: [...resumePoints].sort((a, b) => a.step - b.step) } : {}),
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
        ...(AMOUNT_MODE !== "levelTable" ? { amounts: AMOUNT_MODE } : {}),
        ...(SPELL_KEEP ? { spells: [...SPELL_KEEP] } : {}),
        ...(STRIP.size ? { strip: [...STRIP] } : {}),
        ...(SPIT ? { spit: true } : {}),
        ...(FORCE_CASTS.length ? { forcedCasts: FORCE_CASTS, forcedCastCount } : {}),
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
        ...(AI_OPTIONS
            ? {
                  version: VERSION,
                  decisionOrigin: ROLLOUT_ORIGIN ? "rollout" : "match",
                  layers: layersModule ? { decideTurnSourceSha256: layersSha } : null,
              }
            : {}),
        ...(RESUME ? { resume: RESUME_MODE } : {}),
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
