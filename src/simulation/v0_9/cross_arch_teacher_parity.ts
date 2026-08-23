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

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    fingerprintV09,
    parseV09Corpus,
    type IV09CandidateRow,
    type V09CorpusPhase,
    type V09CorpusSplit,
    type IV09DecisionRow,
    type IV09GameRow,
} from "./protocol";

export const V09_CROSS_ARCH_TEACHER_PARITY_SCHEMA = "hoc.ai.v0_9_cross_arch_teacher_parity.v1" as const;
export const V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE = 1e-12;
export const V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES = 96;

export interface IV09CrossArchTeacherParityShard {
    file: string;
    gameId: string;
    decisions: number;
    leftSha256: string;
    rightSha256: string;
    rawExact: boolean;
    scoreDifferences: number;
    maximumScoreDifference: number;
}

export interface IV09CrossArchTeacherParityReceipt {
    schema: typeof V09_CROSS_ARCH_TEACHER_PARITY_SCHEMA;
    mode: "production" | "test_fixture";
    eligibleForDistributedTeacher: boolean;
    leftArchitecture: string;
    rightArchitecture: string;
    tolerance: typeof V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE;
    minimumGames: number;
    games: number;
    rawExactGames: number;
    labelExactGames: number;
    outcomeExactGames: number;
    scoreDifferences: number;
    maximumScoreDifference: number;
    runFingerprint: string;
    sourceCommit: string;
    rulesFingerprint: string;
    anchorFingerprint: string;
    phase: V09CorpusPhase;
    split: V09CorpusSplit;
    shards: IV09CrossArchTeacherParityShard[];
    receiptSha256: string;
}

export interface IV09CrossArchTeacherParityOptions {
    leftDirectory: string;
    rightDirectory: string;
    leftArchitecture: string;
    rightArchitecture: string;
    mode?: "production" | "test_fixture";
    minimumGames?: number;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function jsonlFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .sort();
}

function parseOneShard(path: string): { text: string; decisions: IV09DecisionRow[]; game: IV09GameRow } {
    const text = readFileSync(path, "utf8");
    const corpus = parseV09Corpus(text.split(/\r?\n/));
    if (corpus.games.length !== 1) throw new Error(`${path} must contain exactly one complete v0.9 game`);
    const game = corpus.games[0]!;
    if (corpus.decisions.length !== game.decisions) throw new Error(`${path} decision count does not match footer`);
    return { text, decisions: corpus.decisions, game };
}

function candidateWithoutTeacherScores(
    candidate: IV09CandidateRow,
): Omit<IV09CandidateRow, "teacherMean" | "teacherStdErr"> {
    const structural: Partial<IV09CandidateRow> = { ...candidate };
    delete structural.teacherMean;
    delete structural.teacherStdErr;
    return structural as Omit<IV09CandidateRow, "teacherMean" | "teacherStdErr">;
}

function decisionWithoutTeacherScores(decision: IV09DecisionRow): Omit<IV09DecisionRow, "candidates"> & {
    candidates: Array<Omit<IV09CandidateRow, "teacherMean" | "teacherStdErr">>;
} {
    return {
        ...decision,
        candidates: decision.candidates.map(candidateWithoutTeacherScores),
    };
}

function gameWithoutRowChain(game: IV09GameRow): Omit<IV09GameRow, "rowChainSha256"> {
    const structural: Partial<IV09GameRow> = { ...game };
    delete structural.rowChainSha256;
    return structural as Omit<IV09GameRow, "rowChainSha256">;
}

function compareNullableScore(left: number | null, right: number | null, context: string): number {
    if (left === null || right === null) {
        if (left !== right) throw new Error(`${context} nullability differs across architectures`);
        return 0;
    }
    const difference = Math.abs(left - right);
    if (!Number.isFinite(difference) || difference > V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE) {
        throw new Error(`${context} differs by ${difference}, beyond ${V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE}`);
    }
    return difference;
}

function compareShard(
    file: string,
    left: ReturnType<typeof parseOneShard>,
    right: ReturnType<typeof parseOneShard>,
): IV09CrossArchTeacherParityShard {
    if (left.decisions.length !== right.decisions.length) {
        throw new Error(`${file} decision counts differ across architectures`);
    }
    if (fingerprintV09(gameWithoutRowChain(left.game)) !== fingerprintV09(gameWithoutRowChain(right.game))) {
        throw new Error(`${file} outcome or game identity differs across architectures`);
    }

    let scoreDifferences = 0;
    let maximumScoreDifference = 0;
    for (let decisionIndex = 0; decisionIndex < left.decisions.length; decisionIndex += 1) {
        const leftDecision = left.decisions[decisionIndex]!;
        const rightDecision = right.decisions[decisionIndex]!;
        if (
            fingerprintV09(decisionWithoutTeacherScores(leftDecision)) !==
            fingerprintV09(decisionWithoutTeacherScores(rightDecision))
        ) {
            throw new Error(`${file} decision ${decisionIndex} labels, candidates, actions, or features differ`);
        }
        for (let candidateIndex = 0; candidateIndex < leftDecision.candidates.length; candidateIndex += 1) {
            const leftCandidate = leftDecision.candidates[candidateIndex]!;
            const rightCandidate = rightDecision.candidates[candidateIndex]!;
            for (const [name, leftScore, rightScore] of [
                ["teacherMean", leftCandidate.teacherMean, rightCandidate.teacherMean],
                ["teacherStdErr", leftCandidate.teacherStdErr, rightCandidate.teacherStdErr],
            ] as const) {
                const difference = compareNullableScore(
                    leftScore,
                    rightScore,
                    `${file} decision ${decisionIndex} candidate ${candidateIndex} ${name}`,
                );
                if (difference > 0) scoreDifferences += 1;
                maximumScoreDifference = Math.max(maximumScoreDifference, difference);
            }
        }
    }

    return {
        file,
        gameId: left.game.gameId,
        decisions: left.game.decisions,
        leftSha256: sha256(left.text),
        rightSha256: sha256(right.text),
        rawExact: left.text === right.text,
        scoreDifferences,
        maximumScoreDifference,
    };
}

export function buildV09CrossArchTeacherParityReceipt(
    options: IV09CrossArchTeacherParityOptions,
): IV09CrossArchTeacherParityReceipt {
    const mode = options.mode ?? "production";
    const minimumGames = options.minimumGames ?? V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES;
    if (!Number.isSafeInteger(minimumGames) || minimumGames < 1) {
        throw new Error("cross-architecture parity minimumGames must be a positive safe integer");
    }
    if (mode === "production" && minimumGames < V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES) {
        throw new Error(
            `production cross-architecture parity requires at least ${V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES} games`,
        );
    }
    if (!options.leftArchitecture.trim() || !options.rightArchitecture.trim()) {
        throw new Error("cross-architecture parity requires both architecture labels");
    }
    const leftDirectory = resolve(options.leftDirectory);
    const rightDirectory = resolve(options.rightDirectory);
    const leftFiles = jsonlFiles(leftDirectory);
    const rightFiles = jsonlFiles(rightDirectory);
    if (leftFiles.length < minimumGames) {
        throw new Error(`cross-architecture parity requires at least ${minimumGames} games`);
    }
    if (fingerprintV09(leftFiles) !== fingerprintV09(rightFiles)) {
        throw new Error("cross-architecture parity shard filenames differ");
    }

    const shards = leftFiles.map((file) =>
        compareShard(file, parseOneShard(resolve(leftDirectory, file)), parseOneShard(resolve(rightDirectory, file))),
    );
    const first = parseOneShard(resolve(leftDirectory, leftFiles[0]!)).game;
    for (const file of leftFiles.slice(1)) {
        const game = parseOneShard(resolve(leftDirectory, file)).game;
        if (
            game.runFingerprint !== first.runFingerprint ||
            game.sourceCommit !== first.sourceCommit ||
            game.rulesFingerprint !== first.rulesFingerprint ||
            game.anchorFingerprint !== first.anchorFingerprint ||
            game.phase !== first.phase ||
            game.split !== first.split
        ) {
            throw new Error("cross-architecture parity shards do not share one source and corpus phase");
        }
    }
    const unsigned = {
        schema: V09_CROSS_ARCH_TEACHER_PARITY_SCHEMA,
        mode,
        eligibleForDistributedTeacher: mode === "production" && shards.length >= V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES,
        leftArchitecture: options.leftArchitecture,
        rightArchitecture: options.rightArchitecture,
        tolerance: V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE as typeof V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE,
        minimumGames,
        games: shards.length,
        rawExactGames: shards.filter((shard) => shard.rawExact).length,
        labelExactGames: shards.length,
        outcomeExactGames: shards.length,
        scoreDifferences: shards.reduce((sum, shard) => sum + shard.scoreDifferences, 0),
        maximumScoreDifference: Math.max(...shards.map((shard) => shard.maximumScoreDifference)),
        runFingerprint: first.runFingerprint,
        sourceCommit: first.sourceCommit,
        rulesFingerprint: first.rulesFingerprint,
        anchorFingerprint: first.anchorFingerprint,
        phase: first.phase,
        split: first.split,
        shards,
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

export function validateV09CrossArchTeacherParityReceipt(
    receipt: IV09CrossArchTeacherParityReceipt,
): IV09CrossArchTeacherParityReceipt {
    const { receiptSha256, ...unsigned } = receipt;
    const shardFiles = receipt.shards.map((shard) => shard.file);
    const gameIds = receipt.shards.map((shard) => shard.gameId);
    const expectedMaximum = Math.max(...receipt.shards.map((shard) => shard.maximumScoreDifference));
    if (
        receipt.schema !== V09_CROSS_ARCH_TEACHER_PARITY_SCHEMA ||
        receipt.tolerance !== V09_CROSS_ARCH_TEACHER_SCORE_TOLERANCE ||
        receipt.shards.length !== receipt.games ||
        new Set(shardFiles).size !== shardFiles.length ||
        new Set(gameIds).size !== gameIds.length ||
        receipt.rawExactGames !== receipt.shards.filter((shard) => shard.rawExact).length ||
        receipt.scoreDifferences !== receipt.shards.reduce((sum, shard) => sum + shard.scoreDifferences, 0) ||
        receipt.maximumScoreDifference !== expectedMaximum ||
        receipt.games < receipt.minimumGames ||
        receipt.labelExactGames !== receipt.games ||
        receipt.outcomeExactGames !== receipt.games ||
        receipt.maximumScoreDifference > receipt.tolerance ||
        receipt.eligibleForDistributedTeacher !==
            (receipt.mode === "production" && receipt.games >= V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES) ||
        (receipt.mode === "production" && receipt.minimumGames < V09_CROSS_ARCH_TEACHER_MINIMUM_GAMES) ||
        fingerprintV09(unsigned) !== receiptSha256
    ) {
        throw new Error("invalid v0.9 cross-architecture teacher parity receipt");
    }
    return receipt;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
}

function main(): void {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            left: { type: "string" },
            right: { type: "string" },
            "left-arch": { type: "string" },
            "right-arch": { type: "string" },
            "minimum-games": { type: "string" },
            out: { type: "string" },
        },
        strict: true,
    });
    if (!values.left || !values.right || !values["left-arch"] || !values["right-arch"]) {
        throw new Error(
            "usage: bun cross_arch_teacher_parity.ts --left <dir> --right <dir> " +
                "--left-arch <label> --right-arch <label> [--minimum-games 96] [--out <json>]",
        );
    }
    const minimumGames = values["minimum-games"] === undefined ? undefined : Number(values["minimum-games"]);
    const receipt = buildV09CrossArchTeacherParityReceipt({
        leftDirectory: values.left,
        rightDirectory: values.right,
        leftArchitecture: values["left-arch"],
        rightArchitecture: values["right-arch"],
        minimumGames,
    });
    validateV09CrossArchTeacherParityReceipt(receipt);
    if (values.out) atomicJson(resolve(values.out), receipt);
    process.stdout.write(
        `${JSON.stringify({
            receiptSha256: receipt.receiptSha256,
            eligibleForDistributedTeacher: receipt.eligibleForDistributedTeacher,
            games: receipt.games,
            rawExactGames: receipt.rawExactGames,
            scoreDifferences: receipt.scoreDifferences,
            maximumScoreDifference: receipt.maximumScoreDifference,
        })}\n`,
    );
}

if (import.meta.main) main();
