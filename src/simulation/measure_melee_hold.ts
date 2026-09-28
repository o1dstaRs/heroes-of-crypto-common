/**
 * When the enemy still outshoots us, should a melee unit that cannot attack this turn wait
 * instead of walking into the volley?
 *
 * Same six angles as the placement study. Placement and augments stay on today's spend.
 * Only the treated seat's melee advances change.
 *
 *   bun src/simulation/measure_melee_hold.ts --games 16 --workers 12
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import type { GameAction } from "../engine/actions";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import { v08DominantFinishState } from "../ai/versions/v0_8_dominant_finish";
import { v08TeamRangedOutput } from "../ai/versions/v0_8";
import { otherTeam } from "../ai/versions/v0_1";
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

const SCHEMA = "hoc.melee-hold-outshot.v1";
const AUGMENTS: ISetupAugment[] = [
    { kind: "Sniper", value: 3 },
    { kind: "Armor", value: 3 },
    { kind: "Might", value: 1 },
];

type Arm = "control" | "hold";
type Angle = "ground" | "splash" | "line" | "flyers" | "spells" | "shooters";
const ARMS: readonly Arm[] = ["control", "hold"];
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

/** A melee step with no attack, while the enemy still has more ranged firepower than we do. */
export const shouldHoldOutshotAdvance = (
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean => {
    if (unit.getAttackType() !== PBTypes.AttackVals.MELEE || unit.isRangeCapable() || !unit.canMove()) return false;
    const productive = decision.some(
        (action) =>
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "cast_spell" ||
            action.type === "wait_turn" ||
            action.type === "defend_turn",
    );
    const moving = decision.some((action) => action.type === "move_unit");
    if (!moving || productive) return false;
    const lap = context.fightProperties?.getCurrentLap() ?? 0;
    if (v08DominantFinishState(context.unitsHolder, unit.getTeam(), lap).active) return false;
    return (
        v08TeamRangedOutput(otherTeam(unit.getTeam()), context.unitsHolder) >
        v08TeamRangedOutput(unit.getTeam(), context.unitsHolder)
    );
};

class HoldStrategy implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly hold: boolean,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        return this.base.placeArmy(units, context);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const decision = this.base.decideTurn(unit, context);
        if (this.hold && shouldHoldOutshotAdvance(unit, context, decision)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        return decision;
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
    readonly laps: number;
}

export const playHoldGame = (job: IJob): IRecord => {
    const own = roster(OWN);
    const opponent = roster(OPPONENTS[job.angle]);
    const treatedIsGreen = job.side === "green";
    const treated = new HoldStrategy(createV08A19Strategy(), job.arm === "hold");
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
        greenAugments: AUGMENTS,
        redAugments: AUGMENTS,
        placementAugmentTiming: "setup-before-placement",
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: treatedIsGreen ? treated : stock,
        redStrategyOverride: treatedIsGreen ? stock : treated,
    });
    const score = result.winner === "draw" ? 0.5 : result.winner === job.side ? 1 : 0;
    return {
        angle: job.angle,
        arm: job.arm,
        side: job.side,
        game: job.game,
        seed: result.seed,
        score,
        laps: result.laps,
    };
};

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const keyOf = (row: Pick<IRecord, "angle" | "arm" | "side" | "game">): string =>
    `${row.angle}/${row.arm}/${row.side}/${row.game}`;

const summarize = (records: readonly IRecord[]): void => {
    const control = new Map(records.filter((row) => row.arm === "control").map((row) => [keyOf(row), row]));
    console.log("angle | games | delta pp | se pp | hold | control");
    for (const angle of ANGLES) {
        const rows = records.filter((row) => row.arm === "hold" && row.angle === angle);
        const deltas = rows.map((row) => {
            const base = control.get(keyOf({ ...row, arm: "control" }));
            if (!base || base.seed !== row.seed) throw new Error(`unpaired ${angle} ${row.game} ${row.side}`);
            return row.score - base.score;
        });
        const mean = average(deltas);
        const variance =
            deltas.length < 2 ? 0 : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
        const se = Math.sqrt(variance / Math.max(1, deltas.length));
        console.log(
            `${angle} | ${rows.length} | ${(mean * 100).toFixed(1)} | ${(se * 100).toFixed(1)} | ${(average(rows.map((row) => row.score)) * 100).toFixed(1)} | ${(average(rows.map((row) => control.get(keyOf({ ...row, arm: "control" }))!.score)) * 100).toFixed(1)}`,
        );
    }
};

const runPool = async (jobs: readonly IJob[], workers: number): Promise<IRecord[]> =>
    new Promise((resolvePromise, rejectPromise) => {
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
            const worker = new Worker(new URL(import.meta.url), { workerData: { meleeHoldWorker: true } });
            pool.push(worker);
            const send = (): void => {
                const job = jobs[cursor++];
                if (job) worker.postMessage(job);
            };
            worker.on("message", (message: { type: string; record?: IRecord; error?: string }) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    send();
                    return;
                }
                records.push(message.record!);
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
            });
            worker.on("error", fail);
        }
    });

const main = async (): Promise<void> => {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "16" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            "base-seed": { type: "string", default: "81926027" },
            output: { type: "string", default: "sim-out/melee-hold-outshot.json" },
        },
        strict: true,
    });
    const games = Number(values.games);
    const workers = Number(values.workers);
    const maxLaps = Number(values["max-laps"]);
    const baseSeed = Number(values["base-seed"]);
    roster(OWN);
    for (const angle of ANGLES) roster(OPPONENTS[angle]);
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
    console.error(`jobs ${jobs.length} workers ${workers}`);
    const records = await runPool(jobs, workers);
    summarize(records);
    const output = resolve(values.output!);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ schema: SCHEMA, records }, null, 2));
    console.error(`wrote ${output}`);
};

if (!isMainThread && workerData?.meleeHoldWorker) {
    parentPort!.on("message", (job: IJob | { type: "stop" }) => {
        if ("type" in job && job.type === "stop") process.exit(0);
        try {
            parentPort!.postMessage({ type: "result", record: playHoldGame(job as IJob) });
        } catch (error) {
            parentPort!.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    parentPort!.postMessage({ type: "ready" });
} else if (isMainThread && import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
