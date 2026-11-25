/*
 * Records headless battles from the TypeScript engine so the Zig engine can replay them step by step.
 *
 *   bun zig/parity/record.ts [games=50] [firstSeed=1] [out=zig/parity/out/battles.jsonl]
 *
 * Scope of the spike: every creature's abilities and spells are stripped (except the creatures named in
 * RECORD_KEEP_ABILITIES), no artifacts, augments, synergies or doctrines, NORMAL grid, v0.1 AI on both sides. The AI only chooses actions; what is recorded is every
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
import { buildRoster, creaturesByLevel, makeRng } from "../../src/simulation/army";
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

/** buildRoster, then each slot swapped (deterministically per seed) for a kept creature of the same level. */
function rosterFor(seed: number): ReturnType<typeof buildRoster> {
    const base = buildRoster(makeRng(seed));
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

function digest(ctx: Ctx): { units: unknown[][]; fight: Record<string, unknown> } {
    const units: unknown[][] = [];
    for (const u of ctx.unitsHolder.getAllUnits().values()) units.push(unitDigest(u));
    const emberTeams = [...(ctx.unitsHolder.emberCovenantTeams ?? [])].sort();
    return { units, fight: { ...fightDigest(ctx.fightProperties), emberTeams } };
}

function initialState(ctx: Ctx, rosterSeed: number): Record<string, unknown> {
    const settings = ctx.grid.getSettings();
    const units: unknown[] = [];
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        const p = u.getUnitProperties();
        units.push({
            id: u.getId(),
            name: u.getName(),
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
        fight: {
            ...fightDigest(fp),
            numberOfLapsTillNarrowing: fp.getNumberOfLapsTillNarrowing(),
            teamUnitsAlive: [...fp.teamUnitsAlive.entries()],
        },
        units,
    };
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

    const wrap = (proto: any, method: string, kind: string): void => {
        const original = proto[method];
        proto[method] = function (this: unknown, arg: unknown) {
            if (!recording || depth > 0 || !ctx || !rng) return original.call(this, arg);
            const r0 = rng.state;
            const d0 = rng.draws;
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
                    known.push([key, r.weight, r.route.map((c: any) => [c.x, c.y])]);
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
        });
        return actions;
    };

    const lines: string[] = [];
    let totalSteps = 0;
    const t0 = performance.now();
    for (let g = 0; g < games; g += 1) {
        const seed = firstSeed + g;
        const roster = rosterFor(seed);
        steps = [];
        let init: Record<string, unknown> | undefined;
        const result = runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster,
            seed,
            maxLaps: 60,
            headlessEvents: true,
            beforeFightStart: (context) => {
                ctx = context as unknown as Ctx;
                // Replace the match's seeded stream with one whose state we can observe. Still deterministic.
                if (!getDeterministicRandomSource()) throw new Error("expected a seeded match");
                rng = new Mulberry(Math.imul(seed, 0x9e3779b1) >>> 0);
                setDeterministicRandomSource(rng.next);
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
    };
    writeFileSync(out.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(JSON.stringify(meta));
    void num;
}

main();
