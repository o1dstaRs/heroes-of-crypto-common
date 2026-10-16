/**
 * Should a shooter retarget onto the enemy stack with the most ranged firepower left?
 *
 * The wide rule (first 384 games, sim-out/focus-shot.json) took any poke that dealt half
 * the best shot's damage. It won the shooter wall (+15.6pp) and lost the caster matchup
 * (−12.5pp): it abandoned kills, and it left a Beholder to chip a Dryad whose magazine was
 * only a few percent larger. This pass retargets an existing shot only. A kill on the
 * focus stack is still taken. A non-killing retarget has to be the best damage available
 * and the focus magazine has to be at least twice the stack the policy was already shooting.
 * Moves, spells, and waits are left alone. Search can still override the incumbent.
 *
 *   bun src/simulation/measure_focus_shot.ts --games 16 --workers 12
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { enumerateCandidates } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
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

const SCHEMA = "hoc.focus-shot.v1";
const AUGMENTS: ISetupAugment[] = [
    { kind: "Sniper", value: 3 },
    { kind: "Armor", value: 3 },
    { kind: "Might", value: 1 },
];
type Arm = "control" | "focus";
type Angle = "ground" | "splash" | "line" | "flyers" | "spells" | "shooters";
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
            creatureName,
            level,
            size: creature.size,
            amount: resolveStackAmount(creatureName, level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });

const outputOf = (unit: Unit): number =>
    Math.max(0, unit.getRangeShots()) * Math.max(0, unit.getAttackDamageMax()) * Math.max(0, unit.getAmountAlive());

/**
 * Non-killing retargets in the traced games were harmful at 1.02–1.34× the policy target's
 * magazine (Dryad over Beholder) and helpful at 4× (Medusa over Arbalester). Two sits in
 * that gap. Do not retune it against this same sample.
 */
const WIDE_OUTPUT_RATIO = 2;

let focusRedirects = 0;

const actionTarget = (action: GameAction): string | undefined =>
    "targetId" in action && action.targetId ? action.targetId : undefined;

/** Retarget a shot onto the enemy shooter with the most firepower left, when that shot is a kill or a clearly bigger magazine. */
export const focusFireDecision = (unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] => {
    if (context.decisionOrigin === "rollout" || !unit.isRangeCapable() || unit.getRangeShots() <= 0) return decision;
    if (!decision.some((action) => action.type === "range_attack" || action.type === "area_throw_attack")) {
        return decision;
    }
    const focus = context.unitsHolder
        .getAllEnemyUnits(unit.getTeam())
        .filter((enemy) => !enemy.isDead() && enemy.isRangeCapable() && enemy.getRangeShots() > 0)
        .sort((a, b) => outputOf(b) - outputOf(a))[0];
    if (!focus) return decision;
    if (decision.some((action) => actionTarget(action) === focus.getId())) return decision;
    const shots = enumerateCandidates(unit, context, decision, {
        maxShotAims: 0,
        maxAreaThrowCells: 0,
        preserveAttackTargetCoverage: true,
    }).candidates.filter((candidate) => candidate.kind === "shot" || candidate.kind === "area_throw");
    const onFocus = shots.filter((candidate) => candidate.targetId === focus.getId());
    if (!onFocus.length) return decision;
    const best = (rows: typeof shots) =>
        [...rows].sort(
            (a, b) =>
                b.features.expectedKill - a.features.expectedKill ||
                b.features.expectedDamage - a.features.expectedDamage,
        )[0];
    const focusShot = best(onFocus);
    const anyShot = best(shots);
    if (!focusShot || !anyShot || focusShot.features.expectedDamage <= 0) return decision;
    if (focusShot.features.expectedKill !== 1) {
        if (anyShot.features.expectedKill === 1) return decision;
        if (focusShot.features.expectedDamage < anyShot.features.expectedDamage) return decision;
        const policyId = decision.map(actionTarget).find((id): id is string => !!id);
        const policyUnit = policyId ? context.unitsHolder.getAllUnits().get(policyId) : undefined;
        const policyOutput =
            policyUnit && !policyUnit.isDead() && policyUnit.isRangeCapable() && policyUnit.getRangeShots() > 0
                ? outputOf(policyUnit)
                : 0;
        if (policyOutput > 0 && outputOf(focus) < WIDE_OUTPUT_RATIO * policyOutput) return decision;
    }
    focusRedirects += 1;
    return focusShot.actions;
};

export const consumeFocusRedirects = (): number => {
    const count = focusRedirects;
    focusRedirects = 0;
    return count;
};

class FocusStrategy implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly focus: boolean,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        return this.base.placeArmy(units, context);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const decision = this.base.decideTurn(unit, context);
        return this.focus ? focusFireDecision(unit, context, decision) : decision;
    }
}

interface IJob {
    angle: Angle;
    arm: Arm;
    side: Side;
    game: number;
    seed: number;
    maxLaps: number;
}
interface IRecord {
    angle: Angle;
    arm: Arm;
    side: Side;
    game: number;
    seed: number;
    score: number;
    redirects: number;
}

export const playFocusGame = (job: IJob): IRecord => {
    consumeFocusRedirects();
    const own = roster(OWN);
    const opponent = roster(OPPONENTS[job.angle]);
    const treatedIsGreen = job.side === "green";
    const treated = new FocusStrategy(createV08A19Strategy(), job.arm === "focus");
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
    return {
        angle: job.angle,
        arm: job.arm,
        side: job.side,
        game: job.game,
        seed: result.seed,
        score: result.winner === "draw" ? 0.5 : result.winner === job.side ? 1 : 0,
        redirects: consumeFocusRedirects(),
    };
};

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const keyOf = (row: Pick<IRecord, "angle" | "arm" | "side" | "game">): string =>
    `${row.angle}/${row.arm}/${row.side}/${row.game}`;

const summarize = (records: readonly IRecord[]): void => {
    const control = new Map(records.filter((row) => row.arm === "control").map((row) => [keyOf(row), row]));
    console.log("angle | games | delta pp | se pp | focus | control | redirects");
    for (const angle of ANGLES) {
        const rows = records.filter((row) => row.arm === "focus" && row.angle === angle);
        const deltas = rows.map((row) => {
            const base = control.get(keyOf({ ...row, arm: "control" }));
            if (!base || base.seed !== row.seed) throw new Error(`unpaired ${angle}`);
            return row.score - base.score;
        });
        const mean = average(deltas);
        const variance =
            deltas.length < 2 ? 0 : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
        const se = Math.sqrt(variance / Math.max(1, deltas.length));
        console.log(
            `${angle} | ${rows.length} | ${(mean * 100).toFixed(1)} | ${(se * 100).toFixed(1)} | ${(average(rows.map((row) => row.score)) * 100).toFixed(1)} | ${(average(rows.map((row) => control.get(keyOf({ ...row, arm: "control" }))!.score)) * 100).toFixed(1)} | ${average(rows.map((row) => row.redirects)).toFixed(1)}`,
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
            const worker = new Worker(new URL(import.meta.url), { workerData: { focusShotWorker: true } });
            pool.push(worker);
            const send = (): void => {
                const job = jobs[cursor++];
                if (job) worker.postMessage(job);
            };
            worker.on("message", (message: { type: string; record?: IRecord; error?: string }) => {
                if (settled) return;
                if (message.type === "error") return fail(new Error(message.error));
                if (message.type === "ready") return send();
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
            "base-seed": { type: "string", default: "81926028" },
            output: { type: "string", default: "sim-out/focus-shot.json" },
        },
        strict: true,
    });
    const games = Number(values.games);
    const maxLaps = Number(values["max-laps"]);
    const baseSeed = Number(values["base-seed"]);
    roster(OWN);
    for (const angle of ANGLES) roster(OPPONENTS[angle]);
    const jobs: IJob[] = [];
    for (const angle of ANGLES) {
        for (const arm of ["control", "focus"] as const) {
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
    console.error(`jobs ${jobs.length} workers ${Number(values.workers)}`);
    const records = await runPool(jobs, Number(values.workers));
    summarize(records);
    const output = resolve(values.output!);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ schema: SCHEMA, records }, null, 2));
    console.error(`wrote ${output}`);
};

if (!isMainThread && workerData?.focusShotWorker) {
    parentPort!.on("message", (job: IJob | { type: "stop" }) => {
        if ("type" in job && job.type === "stop") process.exit(0);
        try {
            parentPort!.postMessage({ type: "result", record: playFocusGame(job as IJob) });
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
