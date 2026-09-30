/**
 * Placement-only A/B for a19. Control is today's createV08A19Strategy(). Treatment keeps that
 * strategy's combat, augments, search, and public-roster setup, and replaces placeArmy only.
 *
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r1c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r1c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r1c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r1c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r1c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r1c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r2c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r2c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r2c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r2c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r2c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r2c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r3c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r3c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r3c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r3c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r3c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r3c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r4c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r4c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r4c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r4c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r4c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r4c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r5c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r5c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r5c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r5c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r5c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r5c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r6c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r6c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r6c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r6c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r6c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r6c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r7c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r7c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r7c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r7c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r7c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r7c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r8c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r8c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r8c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r8c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r8c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r8c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r9c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r9c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r9c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r9c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r9c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r9c3.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r10c1 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r10c1.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r10c2 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r10c2.json
 *   bun src/simulation/measure_a19_placement_lift.ts --candidate r10c3 --games 16 --workers 12 \
 *     --output sim-out/a19-placement-lift-r10c3.json
 *
 * --games is a positive even count of paired deltas in every row. Seeds omit the arm and the
 * candidate, so each treatment game matches its control. Draws score 0.5. Cohort armies come from
 * prepareMetaPair. Angles are the six fixed shooter matchups. Workers are capped at 12 and stopped
 * when the batch finishes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";

import {
    PlacementLiftStrategy,
    PLACEMENT_LIFT_CANDIDATES,
    type PlacementLiftCandidateId,
} from "../ai/versions/v0_8_placement_lift";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import type { IAIStrategy } from "../ai/ai_strategy";
import { Doctrine } from "../doctrines/doctrine_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    AI_META_COHORTS,
    AI_META_FIGHT_VERSION,
    AI_META_GAMES_PER_MATCHUP,
    aiMetaSynergyVariantsForPair,
    prepareMetaPair,
    type AiMetaCohort,
} from "./ai_meta_cohorts_core";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    hashSimulationParts,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, type ISetupAugment, type Side } from "./battle_engine";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { materializeReplayAbSplits } from "./ranked_replay_tactics_ab_core";

const SCHEMA = "hoc.a19-placement-lift.v1";
const WORKER_FLAG = "a19PlacementLiftWorker";
const CONTROL_AUGMENTS: ISetupAugment[] = [
    { kind: "Sniper", value: 3 },
    { kind: "Armor", value: 3 },
    { kind: "Might", value: 1 },
];

type Arm = "control" | PlacementLiftCandidateId;
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
            creatureName: creature.creatureName,
            level: creature.level,
            size: creature.size,
            amount: resolveStackAmount(creature.creatureName, creature.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });

const isCandidate = (value: string): value is PlacementLiftCandidateId =>
    (PLACEMENT_LIFT_CANDIDATES as readonly string[]).includes(value);

const scoreFor = (winner: Side | "draw", side: Side): number => (winner === "draw" ? 0.5 : winner === side ? 1 : 0);

const pinRuntime = (): void => {
    process.env.SIM_NO_ACTIONS = "1";
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = "0";
};

const strategyFor = (arm: Arm): IAIStrategy =>
    arm === "control" ? createV08A19Strategy() : new PlacementLiftStrategy(createV08A19Strategy(), arm);

export interface ILiftAngleJob {
    readonly kind: "angle";
    readonly angle: Angle;
    readonly arm: Arm;
    readonly side: Side;
    readonly game: number;
    readonly seed: number;
    readonly maxLaps: number;
}

export interface ILiftCohortJob {
    readonly kind: "cohort";
    readonly cohort: AiMetaCohort;
    readonly arm: Arm;
    readonly pair: number;
    readonly aIsGreen: boolean;
    readonly games: number;
    readonly baseSeed: number;
    readonly maxLaps: number;
}

export type ILiftJob = ILiftAngleJob | ILiftCohortJob;

export interface ILiftRecord {
    readonly group: "cohort" | "angle";
    readonly name: string;
    readonly arm: Arm;
    readonly key: string;
    readonly score: number;
}

export interface ILiftRow {
    readonly name: string;
    readonly games: number;
    readonly delta_pp: number;
    readonly se_pp: number;
    readonly treated_pp: number;
    readonly control_pp: number;
}

const playAngle = (job: ILiftAngleJob): ILiftRecord => {
    const own = roster(OWN);
    const opponent = roster(OPPONENTS[job.angle]);
    const treatedIsGreen = job.side === "green";
    const treated = strategyFor(job.arm);
    const stock = createV08A19Strategy();
    const result = runMatch({
        greenVersion: AI_META_FIGHT_VERSION,
        redVersion: AI_META_FIGHT_VERSION,
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
        greenAugments: CONTROL_AUGMENTS,
        redAugments: CONTROL_AUGMENTS,
        placementAugmentTiming: "setup-before-placement",
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: treatedIsGreen ? treated : stock,
        redStrategyOverride: treatedIsGreen ? stock : treated,
    });
    return {
        group: "angle",
        name: job.angle,
        arm: job.arm,
        key: `${job.angle}/${job.side}/${job.game}`,
        score: scoreFor(result.winner, job.side),
    };
};

const playCohort = (job: ILiftCohortJob): ILiftRecord => {
    const prepared = prepareMetaPair({ cohort: job.cohort, games: job.games, baseSeed: job.baseSeed }, job.pair);
    const greenArmy = job.aIsGreen ? prepared.armyA : prepared.armyB;
    const redArmy = job.aIsGreen ? prepared.armyB : prepared.armyA;
    const synergyVariants = aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed);
    const greenSplit = materializeReplayAbSplits(
        greenArmy.roster,
        greenArmy.creatureIds,
        greenArmy.augment.augments,
        greenArmy.synergies,
    );
    const redSplit = materializeReplayAbSplits(
        redArmy.roster,
        redArmy.creatureIds,
        redArmy.augment.augments,
        redArmy.synergies,
    );
    const treated = strategyFor(job.arm);
    const stock = createV08A19Strategy();
    const result = runMatch({
        greenVersion: AI_META_FIGHT_VERSION,
        redVersion: AI_META_FIGHT_VERSION,
        roster: greenSplit.roster,
        redRoster: redSplit.roster,
        seed: prepared.combatSeed,
        maxLaps: job.maxLaps,
        gridType: prepared.map,
        greenDoctrine: greenArmy.doctrine,
        redDoctrine: redArmy.doctrine,
        greenAugments: greenArmy.augment.augments,
        redAugments: redArmy.augment.augments,
        greenArtifactT1: greenArmy.artifactT1.id,
        redArtifactT1: redArmy.artifactT1.id,
        greenArtifactT2: greenArmy.artifactT2.id,
        redArtifactT2: redArmy.artifactT2.id,
        greenSynergies: greenArmy.synergies,
        redSynergies: redArmy.synergies,
        synergyVariants,
        greenTacticalSplitStacks: greenSplit.splitRoles,
        redTacticalSplitStacks: redSplit.splitRoles,
        placementAugmentTiming: "setup-before-placement",
        headlessEvents: true,
        searchOfflineDeterministicWork: true,
        sideOrientedPlacement: true,
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: treated,
        redStrategyOverride: stock,
    });
    return {
        group: "cohort",
        name: job.cohort,
        arm: job.arm,
        key: `${job.cohort}/${job.pair}/${job.aIsGreen ? "a-green" : "b-green"}`,
        score: scoreFor(result.winner, "green"),
    };
};

export const playPlacementLiftJob = (job: ILiftJob): ILiftRecord => {
    pinRuntime();
    return job.kind === "angle" ? playAngle(job) : playCohort(job);
};

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const summarizePlacementLift = (
    records: readonly ILiftRecord[],
    candidate: PlacementLiftCandidateId,
): ILiftRow[] => {
    const control = new Map(records.filter((row) => row.arm === "control").map((row) => [row.key, row]));
    const names: { group: ILiftRecord["group"]; name: string }[] = [
        ...AI_META_COHORTS.map((name) => ({ group: "cohort" as const, name })),
        ...ANGLES.map((name) => ({ group: "angle" as const, name })),
    ];
    return names.map(({ group, name }) => {
        const treated = records.filter((row) => row.group === group && row.name === name && row.arm === candidate);
        const deltas = treated.map((row) => {
            const base = control.get(row.key);
            if (!base || base.group !== group || base.name !== name) {
                throw new Error(`unpaired ${group} ${name} ${row.key}`);
            }
            return row.score - base.score;
        });
        const mean = average(deltas);
        const variance =
            deltas.length < 2 ? 0 : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
        const se = Math.sqrt(variance / Math.max(1, deltas.length));
        const treatedScore = average(treated.map((row) => row.score));
        const controlScore = average(
            treated.map((row) => {
                const base = control.get(row.key);
                if (!base) throw new Error(`unpaired ${group} ${name} ${row.key}`);
                return base.score;
            }),
        );
        return {
            name,
            games: treated.length,
            delta_pp: mean * 100,
            se_pp: se * 100,
            treated_pp: treatedScore * 100,
            control_pp: controlScore * 100,
        };
    });
};

const jobsFor = (candidate: PlacementLiftCandidateId, games: number, baseSeed: number, maxLaps: number): ILiftJob[] => {
    const jobs: ILiftJob[] = [];
    const arms: readonly Arm[] = ["control", candidate];
    const perSide = games / 2;
    const pairs = games / AI_META_GAMES_PER_MATCHUP;
    for (const cohort of AI_META_COHORTS) {
        for (let pair = 0; pair < pairs; pair += 1) {
            for (const aIsGreen of [true, false]) {
                for (const arm of arms) {
                    jobs.push({ kind: "cohort", cohort, arm, pair, aIsGreen, games, baseSeed, maxLaps });
                }
            }
        }
    }
    for (const angle of ANGLES) {
        for (const side of ["green", "red"] as const) {
            for (let game = 0; game < perSide; game += 1) {
                const seed = hashSimulationParts(SCHEMA, baseSeed, "angle", angle, side, game);
                for (const arm of arms) jobs.push({ kind: "angle", angle, arm, side, game, seed, maxLaps });
            }
        }
    }
    return jobs;
};

const formatRows = (rows: readonly ILiftRow[]): string => {
    const lines = ["name | games | delta pp | se pp | treated | control"];
    for (const row of rows) {
        lines.push(
            `${row.name} | ${row.games} | ${row.delta_pp.toFixed(1)} | ${row.se_pp.toFixed(1)} | ${row.treated_pp.toFixed(1)} | ${row.control_pp.toFixed(1)}`,
        );
    }
    return lines.join("\n");
};

const main = async (): Promise<void> => {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            candidate: { type: "string" },
            games: { type: "string", default: "16" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            "base-seed": { type: "string", default: "81926026" },
            output: { type: "string" },
        },
        strict: true,
    });
    const candidate = values.candidate ?? "";
    if (!isCandidate(candidate)) {
        throw new Error(`--candidate must be one of ${PLACEMENT_LIFT_CANDIDATES.join(", ")}`);
    }
    const games = Number(values.games);
    const maxLaps = Number(values["max-laps"]);
    const baseSeed = Number(values["base-seed"]);
    if (!Number.isInteger(games) || games < 2 || games % 2 !== 0) {
        throw new Error("--games must be a positive even integer");
    }
    if (!Number.isInteger(maxLaps) || maxLaps < 1) throw new Error("--max-laps must be a positive integer");
    if (!Number.isSafeInteger(baseSeed)) throw new Error("--base-seed must be a safe integer");
    const requestedWorkers = Number(values.workers);
    const jobs = jobsFor(candidate, games, baseSeed, maxLaps);
    const workers = Math.max(1, Math.min(12, Math.floor(requestedWorkers), jobs.length));
    roster(OWN);
    for (const angle of ANGLES) roster(OPPONENTS[angle]);
    console.error(`candidate ${candidate} jobs ${jobs.length} workers ${workers}`);
    const pool = new PersistentWorkerPool<ILiftJob, ILiftRecord>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { [WORKER_FLAG]: true } },
    });
    let records: ILiftRecord[];
    try {
        records = await pool.runBatch(jobs, (progress) => {
            if (progress.completed % 24 === 0 || progress.completed === progress.total) {
                console.error(`progress ${progress.completed}/${progress.total}`);
            }
        });
    } finally {
        await pool.close();
    }
    const rows = summarizePlacementLift(records, candidate);
    console.log(formatRows(rows));
    const output = resolve(values.output ?? `sim-out/a19-placement-lift-${candidate}.json`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ schema: SCHEMA, candidate, games, baseSeed, rows }, null, 2));
    console.error(`wrote ${output}`);
};

if (!isMainThread && workerData?.[WORKER_FLAG] === true) {
    process.env.SIM_NO_ACTIONS = "1";
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = "0";
    startPersistentWorker(playPlacementLiftJob);
} else if (isMainThread && import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
}
