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
 * UNIT-STRENGTH FIT: per-creature win contribution in the hands of the live ranked bot.
 *
 * Input is collect_ranked_draft_strength_data JSONL. Each decisive game is one row: the outcome is "the drafting
 * seat won", the features are one presence difference per creature (own army minus opposing army) plus a battle
 * side term. A ridge logistic regression (IRLS) gives each creature's effect in logits; lift is reported in
 * percentage points at an even matchup (beta / 4). Offer boards are resampled whole for bootstrap intervals, since
 * both battle mirrors of a board share armies. The prior's conservative lift is the ridge point shrunk toward zero
 * by one bootstrap standard error.
 *
 * Usage: bun src/simulation/fit_ranked_draft_unit_strength.ts --input train.jsonl --output prior.json \
 *     [--id ranked-unit-strength-a19-side-v1] [--lambda 4] [--bootstrap 200] [--commit b793e89]
 */

export const RANKED_UNIT_STRENGTH_SCHEMA_VERSION = 1;

export interface IUnitStrengthRow {
    board: number;
    /** +1 when the drafting seat fought green, -1 when red. */
    side: number;
    won: boolean;
    own: readonly number[];
    opponent: readonly number[];
}

export interface IUnitStrengthCreatureFit {
    creatureId: number;
    name: string;
    level: number;
    faction: number;
    /** Decisive games in which at least one army fielded the creature. */
    support: number;
    liftPp: number;
    standardErrorPp: number;
    ciLowPp: number;
    ciHighPp: number;
    conservativeLiftPp: number;
}

export interface IUnitStrengthFit {
    creatures: IUnitStrengthCreatureFit[];
    sideLiftPp: number;
    /** The drafting seat's own edge (LEFT picks first), kept out of the creature effects. */
    seatLiftPp: number;
    games: number;
    boards: number;
}

export function unitStrengthRows(records: readonly IRankedDraftGameRecord[]): IUnitStrengthRow[] {
    return records.flatMap((record) => {
        if (record.candidateResult === "draw") return [];
        if (!record.armies) throw new Error(`Record ${record.game} has no armies; collect with recordArmies`);
        return [
            {
                board: record.offerBoard,
                side: record.candidateSide === "green" ? 1 : -1,
                won: record.candidateResult === "win",
                own: record.armies.candidate.creatureIds,
                opponent: record.armies.opponent.creatureIds,
            },
        ];
    });
}

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

/** Solve A x = b for a symmetric positive-definite A (Cholesky). */
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

/** Unpenalized nuisance columns ahead of the creature columns: battle side, then drafting seat. */
const SIDE_COLUMN = 0;
const SEAT_COLUMN = 1;
const CREATURE_OFFSET = 2;

/**
 * Ridge logistic regression by Newton steps. Column 0 is the battle-side term and column 1 the drafting-seat
 * intercept (every row is the LEFT drafter, which picks first: that edge must not leak into creature effects);
 * both are unpenalized. The rest are creature presence differences, penalized by lambda. Rows are sparse.
 */
export function fitRidgeLogistic(
    rows: readonly IUnitStrengthRow[],
    creatureIndex: ReadonlyMap<number, number>,
    lambda: number,
    weights?: readonly number[],
): number[] {
    const size = creatureIndex.size + CREATURE_OFFSET;
    const sparse = rows.map((row) => {
        const entries = new Map<number, number>([
            [SIDE_COLUMN, row.side],
            [SEAT_COLUMN, 1],
        ]);
        for (const id of row.own) {
            const index = creatureIndex.get(id);
            if (index !== undefined) {
                entries.set(index + CREATURE_OFFSET, (entries.get(index + CREATURE_OFFSET) ?? 0) + 1);
            }
        }
        for (const id of row.opponent) {
            const index = creatureIndex.get(id);
            if (index !== undefined) {
                entries.set(index + CREATURE_OFFSET, (entries.get(index + CREATURE_OFFSET) ?? 0) - 1);
            }
        }
        return [...entries.entries()].filter(([, value]) => value !== 0);
    });
    let beta = new Array<number>(size).fill(0);
    for (let iteration = 0; iteration < 25; iteration += 1) {
        const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
        const gradient = new Array<number>(size).fill(0);
        for (let column = CREATURE_OFFSET; column < size; column += 1) {
            hessian[column][column] += lambda;
            gradient[column] -= lambda * beta[column];
        }
        sparse.forEach((entries, rowIndex) => {
            const weight = weights?.[rowIndex] ?? 1;
            if (!weight) return;
            let linear = 0;
            for (const [column, value] of entries) linear += beta[column] * value;
            const probability = sigmoid(linear);
            const residual = (rows[rowIndex].won ? 1 : 0) - probability;
            const curvature = probability * (1 - probability) * weight;
            for (const [column, value] of entries) {
                gradient[column] += weight * residual * value;
                for (const [other, otherValue] of entries) hessian[column][other] += curvature * value * otherValue;
            }
        });
        // A tiny ridge on the nuisance terms keeps the solve defined on degenerate panels.
        hessian[SIDE_COLUMN][SIDE_COLUMN] += 1e-9;
        hessian[SEAT_COLUMN][SEAT_COLUMN] += 1e-9;
        const step = solveSpd(hessian, gradient);
        beta = beta.map((value, index) => value + step[index]);
        if (Math.max(...step.map(Math.abs)) < 1e-9) break;
    }
    return beta;
}

export function fitUnitStrength(
    rows: readonly IUnitStrengthRow[],
    lambda: number,
    bootstrapSamples: number,
    seed: number = 97_100_001,
): IUnitStrengthFit {
    const creatureIds = [...new Set(rows.flatMap((row) => [...row.own, ...row.opponent]))].sort((a, b) => a - b);
    const creatureIndex = new Map(creatureIds.map((id, index) => [id, index]));
    const point = fitRidgeLogistic(rows, creatureIndex, lambda);

    const boards = [...new Set(rows.map((row) => row.board))];
    const rowsByBoard = new Map<number, number[]>();
    rows.forEach((row, index) => rowsByBoard.set(row.board, [...(rowsByBoard.get(row.board) ?? []), index]));
    const rng = makeRng(seed);
    const samples: number[][] = [];
    for (let sample = 0; sample < bootstrapSamples; sample += 1) {
        const weights = new Array<number>(rows.length).fill(0);
        for (let draw = 0; draw < boards.length; draw += 1) {
            const board = boards[Math.floor(rng() * boards.length)];
            for (const index of rowsByBoard.get(board) ?? []) weights[index] += 1;
        }
        samples.push(fitRidgeLogistic(rows, creatureIndex, lambda, weights));
    }

    const toPp = (logit: number): number => (logit / 4) * 100;
    const quantile = (values: number[], q: number): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const position = (sorted.length - 1) * q;
        const low = Math.floor(position);
        const high = Math.ceil(position);
        return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    };
    const creatures = creatureIds.map((creatureId, index): IUnitStrengthCreatureFit => {
        const info = creatureInfo(creatureId);
        const liftPp = toPp(point[index + CREATURE_OFFSET]);
        const draws = samples.map((sample) => toPp(sample[index + CREATURE_OFFSET]));
        const mean = draws.length ? draws.reduce((sum, value) => sum + value, 0) / draws.length : liftPp;
        const standardErrorPp =
            draws.length > 1
                ? Math.sqrt(draws.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (draws.length - 1))
                : 0;
        return {
            creatureId,
            name: info?.name ?? `creature-${creatureId}`,
            level: info?.level ?? 0,
            faction: info?.faction ?? 0,
            support: rows.filter((row) => row.own.includes(creatureId) || row.opponent.includes(creatureId)).length,
            liftPp,
            standardErrorPp,
            ciLowPp: draws.length ? quantile(draws, 0.025) : liftPp,
            ciHighPp: draws.length ? quantile(draws, 0.975) : liftPp,
            conservativeLiftPp: Math.sign(liftPp) * Math.max(0, Math.abs(liftPp) - standardErrorPp),
        };
    });
    creatures.sort((left, right) => left.level - right.level || right.liftPp - left.liftPp);
    return {
        creatures,
        sideLiftPp: toPp(point[SIDE_COLUMN]),
        seatLiftPp: toPp(point[SEAT_COLUMN]),
        games: rows.length,
        boards: boards.length,
    };
}

function parseCli(argv: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();
    const allowed = new Set(["input", "output", "id", "lambda", "bootstrap", "commit", "seed"]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument ${argument}`);
        const [key, inline] = argument.slice(2).split("=", 2);
        if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    if (!values.has("input") || !values.has("output")) throw new Error("--input and --output are required");
    return values;
}

function cliMain(): void {
    const values = parseCli(process.argv.slice(2));
    const inputPath = resolve(values.get("input")!);
    const raw = readFileSync(inputPath, "utf8");
    const records = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as IRankedDraftGameRecord);
    const lambda = Number(values.get("lambda") ?? 4);
    const bootstrap = Number(values.get("bootstrap") ?? 200);
    const fit = fitUnitStrength(unitStrengthRows(records), lambda, bootstrap, Number(values.get("seed") ?? 97_100_001));
    const prior = {
        schemaVersion: RANKED_UNIT_STRENGTH_SCHEMA_VERSION,
        id: values.get("id") ?? "ranked-unit-strength-a19-side-v1",
        source: {
            file: basename(inputPath),
            sha256: createHash("sha256").update(raw).digest("hex"),
            records: records.length,
            decisiveGames: fit.games,
            boards: fit.boards,
            harnessCommit: values.get("commit") ?? "unknown",
        },
        method: {
            model: "ridge-logistic-presence-difference-v1",
            ridgeLambda: lambda,
            bootstrapSamples: bootstrap,
            bootstrapUnit: "offer-board",
            liftScale: "percentage points at p=0.5 (beta/4)",
            conservative: "ridge point shrunk toward 0 by one bootstrap standard error",
        },
        sideLiftPp: fit.sideLiftPp,
        seatLiftPp: fit.seatLiftPp,
        creatures: fit.creatures,
    };
    const outputPath = resolve(values.get("output")!);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(prior, null, 2)}\n`);
    for (const creature of fit.creatures) {
        console.log(
            `L${creature.level} ${creature.name.padEnd(18)} lift ${creature.liftPp.toFixed(2).padStart(6)}pp ` +
                `[${creature.ciLowPp.toFixed(1)}, ${creature.ciHighPp.toFixed(1)}] cons ${creature.conservativeLiftPp.toFixed(2)} n=${creature.support}`,
        );
    }
    console.log(
        `side ${fit.sideLiftPp.toFixed(2)}pp; drafting seat ${fit.seatLiftPp.toFixed(2)}pp; ` +
            `${fit.games} decisive games over ${fit.boards} boards -> ${outputPath}`,
    );
}

if (import.meta.main) {
    cliMain();
}
