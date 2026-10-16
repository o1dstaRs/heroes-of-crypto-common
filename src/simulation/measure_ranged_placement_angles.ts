/**
 * Does extending the zone and parking shooters in the corners help, and when?
 *
 * The treated seat is a four-shooter army. The other seat is one fixed angle: plain ground,
 * splash (Area Throw), a fire-breath line, flyers, ranged spell damage, or a shooter wall.
 * Both seats fight with v0.8. Only the treated seat's setup and placement change.
 *
 *   bun src/simulation/measure_ranged_placement_angles.ts --games 16 --workers 12
 *
 * Score is draw-aware and paired against the control arm on the same seed and seat.
 * Positive means the arm beat today's spend (Sniper 3, Armor 3, Might 1, no placement extend).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import type { GameAction } from "../engine/actions";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import { creatureInfo } from "../ai/setup/creature_score";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import { SPLASH_AOE_ABILITIES, layoutRevealPlacement } from "../ai/versions/v0_7_placement_reveal";
import { Doctrine } from "../doctrines/doctrine_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    hashSimulationParts,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, type ISetupAugment, type Side } from "./battle_engine";

const SCHEMA = "hoc.ranged-placement-angles.v1";
const CONTROL_AUGMENTS: ISetupAugment[] = [
    { kind: "Sniper", value: 3 },
    { kind: "Armor", value: 3 },
    { kind: "Might", value: 1 },
];
const EXTENDED_AUGMENTS: ISetupAugment[] = [
    { kind: "Sniper", value: 3 },
    { kind: "Placement", value: 2 },
    { kind: "Armor", value: 2 },
];

type Arm = "control" | "extend" | "corners-blind" | "corners-aware" | "corners-unextended";
type Angle = "ground" | "splash" | "line" | "flyers" | "spells" | "shooters";

const ARMS: readonly Arm[] = ["control", "extend", "corners-blind", "corners-aware", "corners-unextended"];
const ANGLES: readonly Angle[] = ["ground", "splash", "line", "flyers", "spells", "shooters"];

const OWN: readonly [number, string][] = [
    [1, "Arbalester"],
    [1, "Dryad"],
    [2, "Medusa"],
    [3, "Monk"],
    [2, "Pikeman"],
    [2, "Troll"],
];

const OPPONENTS: Record<Angle, readonly [number, string][]> = {
    ground: [
        [1, "Peasant"],
        [1, "Squire"],
        [2, "Pikeman"],
        [2, "Troll"],
        [3, "Crusader"],
        [4, "Hydra"],
    ],
    splash: [
        [1, "Peasant"],
        [1, "Squire"],
        [2, "Pikeman"],
        [2, "Troll"],
        [3, "Ogre Mage"],
        [4, "Gargantuan"],
    ],
    line: [
        [1, "Peasant"],
        [1, "Squire"],
        [2, "Pikeman"],
        [2, "Troll"],
        [3, "Crusader"],
        [4, "Black Dragon"],
    ],
    flyers: [
        [1, "Wolf Rider"],
        [2, "Harpy"],
        [2, "Wyvern"],
        [3, "Griffin"],
        [3, "Pegasus"],
        [4, "Magic Dragon"],
    ],
    spells: [
        [1, "Wandering Mage"],
        [1, "Dryad"],
        [2, "Satyr"],
        [2, "Beholder"],
        [3, "Monk"],
        [3, "Zena"],
    ],
    shooters: [
        [1, "Arbalester"],
        [2, "Elf"],
        [2, "Medusa"],
        [2, "Beholder"],
        [3, "Monk"],
        [3, "Zena"],
    ],
};

const roster = (rows: readonly [number, string][]): IArmyUnitSpec[] =>
    rows.map(([level, creatureName]) => {
        const creature = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
        if (!creature) throw new Error(`Unknown creature ${creatureName} at level ${level}`);
        return {
            faction: creature.faction,
            creatureName: creature.creatureName,
            level: creature.level,
            size: creature.size,
            amount: resolveStackAmount(creature.creatureName, creature.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });

type Threat = "splash" | "flyer" | "spell" | "plain";

const threatOf = (context: IPlacementContext): Threat => {
    const ids = context.publicOpponentCreatureIds ?? [];
    const known = ids.map((id) => creatureInfo(id)).filter((info) => info !== undefined);
    if (known.some((info) => SPLASH_AOE_ABILITIES.some((ability) => info.abilities.includes(ability)))) return "splash";
    if (known.some((info) => info.canFly)) return "flyer";
    if (known.some((info) => info.rangedSpellDamage)) return "spell";
    return "plain";
};

const cornerLayout = (units: Unit[], context: IPlacementContext, gap: number): Map<string, XY> =>
    layoutRevealPlacement(units, context, {
        gap,
        screenShooters: true,
        cornerShift: false,
        physicalMeleeMagicRoles: true,
    });

class PlacementArmStrategy implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly arm: Arm,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const stock = this.base.placeArmy(units, context);
        if (this.arm === "control" || this.arm === "extend") return stock;
        if (this.arm === "corners-aware") {
            const threat = threatOf(context);
            if (context.placement.getSize() < 4) return stock;
            if (threat === "splash") return cornerLayout(units, context, 1);
            if (threat === "flyer" || threat === "spell") return stock;
        }
        return cornerLayout(units, context, 0);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

interface IJob {
    readonly angle: Angle;
    readonly arm: Arm;
    readonly side: Side;
    readonly game: number;
    readonly seed: number;
    readonly maxLaps: number;
}

interface IRecord {
    readonly angle: Angle;
    readonly arm: Arm;
    readonly side: Side;
    readonly game: number;
    readonly seed: number;
    readonly score: number;
    readonly winner: Side | "draw";
    readonly laps: number;
}

const scoreFor = (winner: Side | "draw", side: Side): number => (winner === "draw" ? 0.5 : winner === side ? 1 : 0);

export const playAngleGame = (job: IJob): IRecord => {
    const own = roster(OWN);
    const opponent = roster(OPPONENTS[job.angle]);
    const treatedIsGreen = job.side === "green";
    const extended = job.arm === "extend" || job.arm === "corners-blind" || job.arm === "corners-aware";
    const treatedAugments = extended ? EXTENDED_AUGMENTS : CONTROL_AUGMENTS;
    const treatedStrategy = new PlacementArmStrategy(createV08A19Strategy(), job.arm);
    const stock = createV08A19Strategy();
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster: treatedIsGreen ? own : opponent,
        redRoster: treatedIsGreen ? opponent : own,
        seed: job.seed,
        maxLaps: job.maxLaps,
        headlessEvents: true,
        searchOfflineDeterministicWork: true,
        sideOrientedPlacement: true,
        gridType: PBTypes.GridVals.NORMAL,
        greenDoctrine: Doctrine.SEE_NONE,
        redDoctrine: Doctrine.SEE_NONE,
        greenAugments: treatedIsGreen ? treatedAugments : CONTROL_AUGMENTS,
        redAugments: treatedIsGreen ? CONTROL_AUGMENTS : treatedAugments,
        placementAugmentTiming: "setup-before-placement",
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: treatedIsGreen ? treatedStrategy : stock,
        redStrategyOverride: treatedIsGreen ? stock : treatedStrategy,
    });
    return {
        angle: job.angle,
        arm: job.arm,
        side: job.side,
        game: job.game,
        seed: result.seed,
        score: scoreFor(result.winner, job.side),
        winner: result.winner,
        laps: result.laps,
    };
};

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const summarize = (records: readonly IRecord[]): void => {
    const control = new Map(records.filter((row) => row.arm === "control").map((row) => [keyOf(row), row]));
    const lines: string[] = [];
    lines.push("arm | angle | games | delta pp | se pp | treated | control");
    for (const arm of ARMS) {
        if (arm === "control") continue;
        for (const angle of ANGLES) {
            const rows = records.filter((row) => row.arm === arm && row.angle === angle);
            const deltas = rows.map((row) => {
                const base = control.get(keyOf({ ...row, arm: "control" }));
                if (!base || base.seed !== row.seed)
                    throw new Error(`unpaired ${angle} ${arm} ${row.game} ${row.side}`);
                return row.score - base.score;
            });
            const mean = average(deltas);
            const variance =
                deltas.length < 2
                    ? 0
                    : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
            const se = Math.sqrt(variance / Math.max(1, deltas.length));
            const treated = average(rows.map((row) => row.score));
            const baseScore = average(rows.map((row) => control.get(keyOf({ ...row, arm: "control" }))!.score));
            lines.push(
                `${arm} | ${angle} | ${rows.length} | ${(mean * 100).toFixed(1)} | ${(se * 100).toFixed(1)} | ${(treated * 100).toFixed(1)} | ${(baseScore * 100).toFixed(1)}`,
            );
        }
    }
    console.log(lines.join("\n"));
};

const keyOf = (row: Pick<IRecord, "angle" | "arm" | "side" | "game">): string =>
    `${row.angle}/${row.arm}/${row.side}/${row.game}`;

const runPool = async (jobs: readonly IJob[], workers: number): Promise<IRecord[]> => {
    if (!jobs.length) return [];
    return new Promise((resolvePromise, rejectPromise) => {
        const records: IRecord[] = [];
        const pool: Worker[] = [];
        let cursor = 0;
        let settled = false;
        const stopAll = (): void => {
            for (const worker of pool) worker.postMessage({ type: "stop" });
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            stopAll();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const count = Math.max(1, Math.min(workers, jobs.length));
        for (let index = 0; index < count; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: { rangedPlacementAngleWorker: true } });
            pool.push(worker);
            const send = (): void => {
                const job = jobs[cursor++];
                if (!job) return;
                worker.postMessage(job);
            };
            worker.on(
                "message",
                (
                    message: { type: "ready" } | { type: "result"; record: IRecord } | { type: "error"; error: string },
                ) => {
                    if (settled) return;
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        send();
                        return;
                    }
                    records.push(message.record);
                    if (records.length % 24 === 0 || records.length === jobs.length) {
                        console.error(`progress ${records.length}/${jobs.length}`);
                    }
                    if (records.length === jobs.length) {
                        settled = true;
                        stopAll();
                        resolvePromise(records);
                        return;
                    }
                    send();
                },
            );
            worker.on("error", fail);
        }
    });
};

const workerMain = (): void => {
    parentPort!.on("message", (job: IJob | { readonly type: "stop" }) => {
        if ("type" in job && job.type === "stop") {
            process.exit(0);
        }
        try {
            parentPort!.postMessage({ type: "result", record: playAngleGame(job as IJob) });
        } catch (error) {
            parentPort!.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    parentPort!.postMessage({ type: "ready" });
};

const main = async (): Promise<void> => {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "16" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            "base-seed": { type: "string", default: "81926026" },
            output: { type: "string", default: "sim-out/ranged-placement-angles.json" },
        },
        strict: true,
    });
    const games = Number(values.games);
    const workers = Number(values.workers);
    const maxLaps = Number(values["max-laps"]);
    const baseSeed = Number(values["base-seed"]);
    const jobs: IJob[] = [];
    for (const angle of ANGLES) {
        for (const arm of ARMS) {
            for (const side of ["green", "red"] as const) {
                for (let game = 0; game < games; game += 1) {
                    jobs.push({
                        angle,
                        arm,
                        side,
                        game,
                        maxLaps,
                        seed: hashSimulationParts(SCHEMA, baseSeed, angle, side, game),
                    });
                }
            }
        }
    }
    roster(OWN);
    for (const angle of ANGLES) roster(OPPONENTS[angle]);
    console.error(`jobs ${jobs.length} workers ${workers}`);
    const records = await runPool(jobs, workers);
    summarize(records);
    const output = resolve(values.output!);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ schema: SCHEMA, records }, null, 2));
    console.error(`wrote ${output}`);
};

if (!isMainThread && workerData?.rangedPlacementAngleWorker) {
    workerMain();
} else if (isMainThread && import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
