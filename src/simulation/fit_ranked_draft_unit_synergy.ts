/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { creatureInfo } from "../ai/setup/creature_score";
import { makeRng } from "./army";
import type { IRankedDraftGameRecord } from "./ranked_draft_eval";

/**
 * UNIT + SYNERGY + MAP FIT (v2 prior): extends the v1 unit-strength fit with what the draft can act on.
 *
 * - Synergy: faction tiers count DISTINCT creatures (2 -> tier 1, 4 -> tier 2). Two unpenalized columns carry the
 *   difference in how many factions each army has at tier >= 1 and at tier >= 2, so tier value is estimated on
 *   top of the units that make it up.
 * - Map: the live pick phase reveals the map right before the level-3 picks, so level-3 and level-4 creatures get
 *   one column per map; level-1 and level-2 creatures keep a single map-independent column.
 *
 * Everything else matches fit_ranked_draft_unit_strength: drafting-seat wins, battle-side and drafting-seat
 * intercepts, ridge on creature columns, offer-board bootstrap, conservative = point shrunk by one SE.
 *
 * Usage: bun src/simulation/fit_ranked_draft_unit_synergy.ts --input train.jsonl --output prior.json \
 *     [--lambda 4] [--bootstrap 200] [--commit <harness commit>]
 */

export const RANKED_UNIT_SYNERGY_SCHEMA_VERSION = 2;
export const RANKED_UNIT_SYNERGY_PRIOR_ID = "ranked-unit-synergy-a19-side-v2";
export const MAP_AWARE_CREATURE_LEVELS: readonly number[] = [3, 4];

export interface IUnitSynergyRow {
    board: number;
    gridType: number;
    side: number;
    won: boolean;
    own: readonly number[];
    opponent: readonly number[];
}

interface ISparseRow {
    entries: [number, number][];
    won: boolean;
}

export interface IFittedEffect {
    liftPp: number;
    standardErrorPp: number;
    ciLowPp: number;
    ciHighPp: number;
    conservativeLiftPp: number;
}

export interface IUnitSynergyCreatureFit extends IFittedEffect {
    creatureId: number;
    name: string;
    level: number;
    faction: number;
    /** Undefined for a map-independent creature column. */
    gridType?: number;
    support: number;
}

/** Faction -> distinct creature count. Creatures without a faction never form a synergy. */
export function factionCounts(creatureIds: readonly number[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const creatureId of new Set(creatureIds)) {
        const faction = creatureInfo(creatureId)?.faction ?? 0;
        if (faction) counts.set(faction, (counts.get(faction) ?? 0) + 1);
    }
    return counts;
}

export function synergyTierCounts(creatureIds: readonly number[]): { tier1: number; tier2: number } {
    let tier1 = 0;
    let tier2 = 0;
    for (const count of factionCounts(creatureIds).values()) {
        if (count >= 2) tier1 += 1;
        if (count >= 4) tier2 += 1;
    }
    return { tier1, tier2 };
}

export function unitSynergyRows(records: readonly IRankedDraftGameRecord[]): IUnitSynergyRow[] {
    return records.flatMap((record) => {
        if (record.candidateResult === "draw") return [];
        if (!record.armies) throw new Error(`Record ${record.game} has no armies; collect with recordArmies`);
        return [
            {
                board: record.offerBoard,
                gridType: record.gridType,
                side: record.candidateSide === "green" ? 1 : -1,
                won: record.candidateResult === "win",
                own: record.armies.candidate.creatureIds,
                opponent: record.armies.opponent.creatureIds,
            },
        ];
    });
}

const SIDE = 0;
const SEAT = 1;
const TIER1 = 2;
const TIER2 = 3;
const FIRST_CREATURE_COLUMN = 4;

const creatureColumnKey = (creatureId: number, gridType: number): string =>
    MAP_AWARE_CREATURE_LEVELS.includes(creatureInfo(creatureId)?.level ?? 0)
        ? `${creatureId}@${gridType}`
        : `${creatureId}`;

function solveSpd(matrix: number[][], vector: number[]): number[] {
    const size = vector.length;
    const lower = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column <= row; column += 1) {
            let sum = matrix[row][column];
            for (let k = 0; k < column; k += 1) sum -= lower[row][k] * lower[column][k];
            if (row === column) {
                if (sum <= 0) throw new Error("Ridge Hessian is not positive definite");
                lower[row][column] = Math.sqrt(sum);
            } else {
                lower[row][column] = sum / lower[column][column];
            }
        }
    }
    const forward = new Array<number>(size).fill(0);
    for (let row = 0; row < size; row += 1) {
        let sum = vector[row];
        for (let k = 0; k < row; k += 1) sum -= lower[row][k] * forward[k];
        forward[row] = sum / lower[row][row];
    }
    const solution = new Array<number>(size).fill(0);
    for (let row = size - 1; row >= 0; row -= 1) {
        let sum = forward[row];
        for (let k = row + 1; k < size; k += 1) sum -= lower[k][row] * solution[k];
        solution[row] = sum / lower[row][row];
    }
    return solution;
}

function fitSparseRidgeLogistic(
    rows: readonly ISparseRow[],
    size: number,
    lambda: number,
    weights?: readonly number[],
): number[] {
    let beta = new Array<number>(size).fill(0);
    for (let iteration = 0; iteration < 30; iteration += 1) {
        const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
        const gradient = new Array<number>(size).fill(0);
        for (let column = FIRST_CREATURE_COLUMN; column < size; column += 1) {
            hessian[column][column] += lambda;
            gradient[column] -= lambda * beta[column];
        }
        rows.forEach((row, rowIndex) => {
            const weight = weights?.[rowIndex] ?? 1;
            if (!weight) return;
            let linear = 0;
            for (const [column, value] of row.entries) linear += beta[column] * value;
            const probability = 1 / (1 + Math.exp(-linear));
            const residual = (row.won ? 1 : 0) - probability;
            const curvature = probability * (1 - probability) * weight;
            for (const [column, value] of row.entries) {
                gradient[column] += weight * residual * value;
                for (const [other, otherValue] of row.entries) hessian[column][other] += curvature * value * otherValue;
            }
        });
        for (let column = 0; column < FIRST_CREATURE_COLUMN; column += 1) hessian[column][column] += 1e-9;
        const step = solveSpd(hessian, gradient);
        beta = beta.map((value, index) => value + step[index]);
        if (Math.max(...step.map(Math.abs)) < 1e-9) break;
    }
    return beta;
}

export interface IUnitSynergyFit {
    creatures: IUnitSynergyCreatureFit[];
    tier1: IFittedEffect;
    tier2: IFittedEffect;
    sideLiftPp: number;
    seatLiftPp: number;
    games: number;
    boards: number;
}

export function fitUnitSynergy(
    rows: readonly IUnitSynergyRow[],
    lambda: number,
    bootstrapSamples: number,
    seed: number = 97_100_001,
): IUnitSynergyFit {
    const keys = [
        ...new Set(
            rows.flatMap((row) => [...row.own, ...row.opponent].map((id) => creatureColumnKey(id, row.gridType))),
        ),
    ].sort();
    const column = new Map(keys.map((key, index) => [key, index + FIRST_CREATURE_COLUMN]));
    const size = keys.length + FIRST_CREATURE_COLUMN;
    const sparse: ISparseRow[] = rows.map((row) => {
        const entries = new Map<number, number>([
            [SIDE, row.side],
            [SEAT, 1],
        ]);
        const ownTiers = synergyTierCounts(row.own);
        const opponentTiers = synergyTierCounts(row.opponent);
        entries.set(TIER1, ownTiers.tier1 - opponentTiers.tier1);
        entries.set(TIER2, ownTiers.tier2 - opponentTiers.tier2);
        for (const [ids, sign] of [
            [row.own, 1],
            [row.opponent, -1],
        ] as const) {
            for (const id of ids) {
                const index = column.get(creatureColumnKey(id, row.gridType))!;
                entries.set(index, (entries.get(index) ?? 0) + sign);
            }
        }
        return { entries: [...entries.entries()].filter(([, value]) => value !== 0), won: row.won };
    });
    const point = fitSparseRidgeLogistic(sparse, size, lambda);

    const boards = [...new Set(rows.map((row) => row.board))];
    const rowsByBoard = new Map<number, number[]>();
    rows.forEach((row, index) => rowsByBoard.set(row.board, [...(rowsByBoard.get(row.board) ?? []), index]));
    const rng = makeRng(seed);
    const samples: number[][] = [];
    for (let sample = 0; sample < bootstrapSamples; sample += 1) {
        const weights = new Array<number>(rows.length).fill(0);
        for (let draw = 0; draw < boards.length; draw += 1) {
            for (const index of rowsByBoard.get(boards[Math.floor(rng() * boards.length)]) ?? []) weights[index] += 1;
        }
        samples.push(fitSparseRidgeLogistic(sparse, size, lambda, weights));
    }

    const toPp = (logit: number): number => (logit / 4) * 100;
    const quantile = (values: number[], q: number): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const position = (sorted.length - 1) * q;
        const low = Math.floor(position);
        const high = Math.ceil(position);
        return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    };
    const effect = (index: number): IFittedEffect => {
        const liftPp = toPp(point[index]);
        const draws = samples.map((sample) => toPp(sample[index]));
        const mean = draws.length ? draws.reduce((sum, value) => sum + value, 0) / draws.length : liftPp;
        const standardErrorPp =
            draws.length > 1
                ? Math.sqrt(draws.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (draws.length - 1))
                : 0;
        return {
            liftPp,
            standardErrorPp,
            ciLowPp: draws.length ? quantile(draws, 0.025) : liftPp,
            ciHighPp: draws.length ? quantile(draws, 0.975) : liftPp,
            conservativeLiftPp: Math.sign(liftPp) * Math.max(0, Math.abs(liftPp) - standardErrorPp),
        };
    };
    const creatures = keys.map((key): IUnitSynergyCreatureFit => {
        const [idText, mapText] = key.split("@");
        const creatureId = Number(idText);
        const gridType = mapText === undefined ? undefined : Number(mapText);
        const info = creatureInfo(creatureId);
        return {
            creatureId,
            name: info?.name ?? `creature-${creatureId}`,
            level: info?.level ?? 0,
            faction: info?.faction ?? 0,
            ...(gridType === undefined ? {} : { gridType }),
            support: rows.filter(
                (row) =>
                    (gridType === undefined || row.gridType === gridType) &&
                    (row.own.includes(creatureId) || row.opponent.includes(creatureId)),
            ).length,
            ...effect(column.get(key)!),
        };
    });
    creatures.sort(
        (left, right) =>
            left.level - right.level || (left.gridType ?? 0) - (right.gridType ?? 0) || right.liftPp - left.liftPp,
    );
    return {
        creatures,
        tier1: effect(TIER1),
        tier2: effect(TIER2),
        sideLiftPp: toPp(point[SIDE]),
        seatLiftPp: toPp(point[SEAT]),
        games: rows.length,
        boards: boards.length,
    };
}

function cliMain(): void {
    const values = new Map<string, string>();
    const argv = process.argv.slice(2);
    const allowed = new Set(["input", "output", "lambda", "bootstrap", "commit", "seed"]);
    for (let index = 0; index < argv.length; index += 1) {
        const [key, inline] = argv[index].replace(/^--/, "").split("=", 2);
        if (!argv[index].startsWith("--") || !allowed.has(key)) throw new Error(`Unknown argument ${argv[index]}`);
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    if (!values.has("input") || !values.has("output")) throw new Error("--input and --output are required");
    const inputPath = resolve(values.get("input")!);
    const raw = readFileSync(inputPath, "utf8");
    const records = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as IRankedDraftGameRecord);
    const lambda = Number(values.get("lambda") ?? 4);
    const bootstrap = Number(values.get("bootstrap") ?? 200);
    const fit = fitUnitSynergy(unitSynergyRows(records), lambda, bootstrap, Number(values.get("seed") ?? 97_100_001));
    const prior = {
        schemaVersion: RANKED_UNIT_SYNERGY_SCHEMA_VERSION,
        id: RANKED_UNIT_SYNERGY_PRIOR_ID,
        source: {
            file: basename(inputPath),
            sha256: createHash("sha256").update(raw).digest("hex"),
            records: records.length,
            decisiveGames: fit.games,
            boards: fit.boards,
            harnessCommit: values.get("commit") ?? "unknown",
        },
        method: {
            model: "ridge-logistic-presence-difference-synergy-tiers-map-l3l4-v2",
            ridgeLambda: lambda,
            bootstrapSamples: bootstrap,
            bootstrapUnit: "offer-board",
            mapAwareLevels: MAP_AWARE_CREATURE_LEVELS,
            liftScale: "percentage points at p=0.5 (beta/4)",
            conservative: "point shrunk toward 0 by one bootstrap standard error",
        },
        sideLiftPp: fit.sideLiftPp,
        seatLiftPp: fit.seatLiftPp,
        synergyTiers: { tier1: fit.tier1, tier2: fit.tier2 },
        creatures: fit.creatures,
    };
    const outputPath = resolve(values.get("output")!);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(prior, null, 2)}\n`);
    const describe = (effect: IFittedEffect): string =>
        `${effect.liftPp.toFixed(2)}pp [${effect.ciLowPp.toFixed(1)}, ${effect.ciHighPp.toFixed(1)}] cons ${effect.conservativeLiftPp.toFixed(2)}`;
    for (const creature of fit.creatures) {
        const map = creature.gridType === undefined ? "all" : `g${creature.gridType}`;
        console.log(
            `L${creature.level} ${map.padEnd(3)} ${creature.name.padEnd(16)} ${describe(creature)} n=${creature.support}`,
        );
    }
    console.log(`tier1 ${describe(fit.tier1)}; tier2 ${describe(fit.tier2)}`);
    console.log(
        `side ${fit.sideLiftPp.toFixed(2)}pp; seat ${fit.seatLiftPp.toFixed(2)}pp; ${fit.games} games / ${fit.boards} boards -> ${outputPath}`,
    );
}

if (import.meta.main) {
    cliMain();
}
