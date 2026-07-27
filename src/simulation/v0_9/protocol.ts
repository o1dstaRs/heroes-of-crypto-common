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

import {
    V09_CANDIDATE_FEATURE_NAMES,
    V09_FEATURE_SCHEMA,
    V09_FEATURE_SCHEMA_SHA256,
    V09_INPUT_FEATURE_NAMES,
    V09_RICH_FEATURE_NAMES,
} from "../../ai/versions/v0_9_features";
import { V09_MODEL_SCHEMA } from "../../ai/versions/v0_9_model";
import type { GameAction } from "../../engine/actions";
import type { XY } from "../../utils/math";
import { IL_ACTION_FEATURE_NAMES } from "../il_action_features";
import { VALUE_FEATURE_NAMES_V2 } from "../value_features";

export const V09_IL_SCHEMA = "hoc.ai.v0_9_il.v4" as const;
export const V09_IL_VERSION = 4 as const;
export const V09_IL_DECISION_TYPE = "v09_il_decision" as const;
export const V09_IL_GAME_TYPE = "v09_il_game" as const;
export const V09_MAX_CANDIDATES = 96;
export { V09_FEATURE_SCHEMA, V09_MODEL_SCHEMA, V09_RICH_FEATURE_NAMES };

/**
 * The bootstrap basis is deliberately the exact feature order already available to the native candidate
 * enumerator. v0.9 adds a separately fingerprinted rich basis instead of mutating IL-v3.
 */
export const V09_BOOTSTRAP_FEATURE_NAMES = [
    ...VALUE_FEATURE_NAMES_V2.map((name) => `state_${name}`),
    ...V09_CANDIDATE_FEATURE_NAMES.map((name) => `candidate_${name}`),
    ...IL_ACTION_FEATURE_NAMES.map((name) => `action_${name}`),
] as const;

/**
 * Public, pre-decision observations required to learn the failure modes v0.8's compact basis cannot express.
 * Values are candidate-relative and are recorded in this exact order. Raw ids live only in metadata and are
 * never part of model input.
 */
export const V09_FULL_FEATURE_NAMES = V09_INPUT_FEATURE_NAMES;

export type V09FeatureSet = "bootstrap" | "full";
export type V09CorpusPhase = "wide_teacher" | "dagger_1" | "dagger_2";
export type V09CorpusSplit = "train" | "validation";
export type V09Seat = "green" | "red";
export type V09Map = "normal" | "water" | "lava" | "block";

export const V09_TEACHER_COHORTS = [
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
    "mirror-anchor",
    "mirror-melee",
    "pure-ranged",
    "mixed-cyclops-tsar",
    "new-level4",
] as const;
export const V09_TEACHER_MAP_NAMES = ["normal", "water", "lava", "block"] as const;
export const V09_DAGGER_TRAJECTORY_PATTERNS = [
    "student-green",
    "student-red",
    "student-self-a",
    "student-self-b",
] as const;
export const V09_TEACHER_SCHEDULE = Object.freeze({
    cohorts: V09_TEACHER_COHORTS,
    maps: V09_TEACHER_MAP_NAMES,
    daggerPatterns: V09_DAGGER_TRAJECTORY_PATTERNS,
});
export const V09_TEACHER_SCHEDULE_SHA256 = fingerprintV09(V09_TEACHER_SCHEDULE);

export interface IV09FeatureFingerprints {
    bootstrap: string;
    rich: string;
    full: string;
    schema: string;
}

export interface IV09TargetMetadata {
    declaredUnitId: string | null;
    firstHitUnitId: string | null;
    aimUnitId: string | null;
    aimCell: XY | null;
    aimSide: number | null;
    spellName: string | null;
    spellTargetMode: "unit" | "cell" | "mass" | null;
}

export interface IV09CandidateFlags {
    productive: 0 | 1;
    waitEligible: 0 | 1;
    luckShield: 0 | 1;
    mountainAttack: 0 | 1;
    urgentFinish: 0 | 1;
    dominantFinish: 0 | 1;
    aimVisibleEdge: 0 | 1;
    trajectoryIntercepted: 0 | 1;
}

export interface IV09CandidateRow {
    kind: string;
    signature: string;
    actions: GameAction[];
    /** Existing candidate features in the exact frozen IL-v3 order. */
    candidateFeatures: number[];
    /** Existing action features in the exact frozen IL-v3 order. */
    actionFeatures: number[];
    /** New candidate-relative observations in V09_RICH_FEATURE_NAMES order. */
    richFeatures: number[];
    metadata: IV09TargetMetadata;
    flags: IV09CandidateFlags;
    /** Null means the real engine rejected this candidate during paired rollout application. */
    teacherMean: number | null;
    teacherStdErr: number | null;
    teacherVisits: number;
}

export interface IV09DecisionRow {
    t: typeof V09_IL_DECISION_TYPE;
    v: typeof V09_IL_VERSION;
    schema: typeof V09_IL_SCHEMA;
    runFingerprint: string;
    featureFingerprints: IV09FeatureFingerprints;
    sourceCommit: string;
    rulesFingerprint: string;
    anchorFingerprint: string;
    phase: V09CorpusPhase;
    split: V09CorpusSplit;
    cohort: string;
    map: V09Map;
    seed: number;
    gameId: string;
    decision: number;
    seat: V09Seat;
    lap: number;
    actorUnitName: string;
    /** State vector in the exact VALUE_FEATURE_NAMES_V2 order. */
    valueFeatures: number[];
    incumbentIndex: 0;
    teacherIndex: number;
    candidates: IV09CandidateRow[];
}

export interface IV09GameRow {
    t: typeof V09_IL_GAME_TYPE;
    v: typeof V09_IL_VERSION;
    schema: typeof V09_IL_SCHEMA;
    runFingerprint: string;
    featureFingerprints: IV09FeatureFingerprints;
    sourceCommit: string;
    rulesFingerprint: string;
    anchorFingerprint: string;
    phase: V09CorpusPhase;
    split: V09CorpusSplit;
    cohort: string;
    map: V09Map;
    seed: number;
    gameId: string;
    greenVersion: string;
    redVersion: string;
    winner: V09Seat | "draw";
    endReason: "elimination" | "turn_cap" | "stuck";
    decisions: number;
    rowChainSha256: string;
}

export interface IV09ParsedCorpus {
    decisions: IV09DecisionRow[];
    games: IV09GameRow[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;

function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
}

export function canonicalV09Json(value: unknown): string {
    return canonical(value);
}

export function fingerprintV09(value: unknown): string {
    return createHash("sha256").update(canonicalV09Json(value)).digest("hex");
}

/**
 * Advance an IL-v4 game's tamper-evident row chain using the exact emitted decision-line bytes.
 *
 * This deliberately does not parse and re-serialize the row. JavaScript and Python spell some otherwise
 * equivalent floating-point JSON values differently (for example `1e-7` versus `1e-07`), so a cross-language
 * verifier must hash the stripped source line it actually consumed.
 */
export function v09RowChainNext(previous: string, rawDecisionLine: string): string {
    if (!SHA256.test(previous)) throw new Error("v0.9 row-chain predecessor must be a lowercase SHA-256");
    const line = rawDecisionLine.trim();
    if (!line) throw new Error("v0.9 row-chain decision line must not be empty");
    return createHash("sha256").update(previous).update("\n").update(line).digest("hex");
}

const bootstrapFingerprint = fingerprintV09({
    schema: "hoc.ai.v0_9_features.bootstrap.v1",
    names: V09_BOOTSTRAP_FEATURE_NAMES,
});
const richFingerprint = fingerprintV09({
    schema: "hoc.ai.v0_9_features.rich.v1",
    names: V09_RICH_FEATURE_NAMES,
});
const fullFingerprint = V09_FEATURE_SCHEMA_SHA256;

export const V09_FEATURE_FINGERPRINTS: IV09FeatureFingerprints = Object.freeze({
    bootstrap: bootstrapFingerprint,
    rich: richFingerprint,
    full: fullFingerprint,
    schema: fingerprintV09({
        dataset: V09_IL_SCHEMA,
        bootstrap: bootstrapFingerprint,
        rich: richFingerprint,
        full: fullFingerprint,
        maxCandidates: V09_MAX_CANDIDATES,
    }),
});

export function v09FeatureNames(featureSet: V09FeatureSet): readonly string[] {
    return featureSet === "full" ? V09_FULL_FEATURE_NAMES : V09_BOOTSTRAP_FEATURE_NAMES;
}

export function v09CandidateInputVector(
    row: Pick<IV09DecisionRow, "valueFeatures">,
    candidate: Pick<IV09CandidateRow, "candidateFeatures" | "actionFeatures" | "richFeatures">,
    featureSet: V09FeatureSet = "full",
): number[] {
    const bootstrap = [...row.valueFeatures, ...candidate.candidateFeatures, ...candidate.actionFeatures];
    return featureSet === "full" ? [...bootstrap, ...candidate.richFeatures] : bootstrap;
}

function fail(context: string, message: string): never {
    throw new Error(`${context}: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(context, "expected object");
    return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
    if (typeof value !== "string" || !value.trim()) return fail(context, "expected non-empty string");
    return value;
}

function finite(value: unknown, context: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail(context, "expected finite number");
    return value;
}

function integer(value: unknown, context: string, minimum = 0): number {
    const parsed = finite(value, context);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        return fail(context, `expected safe integer >= ${minimum}`);
    }
    return parsed;
}

function binary(value: unknown, context: string): 0 | 1 {
    if (value === 0 || value === 1) return value;
    return fail(context, "expected 0 or 1");
}

function vector(value: unknown, width: number, context: string): number[] {
    if (!Array.isArray(value) || value.length !== width) {
        return fail(context, `expected feature vector width ${width}`);
    }
    return value.map((entry, index) => finite(entry, `${context}[${index}]`));
}

function sha(value: unknown, context: string): string {
    const parsed = text(value, context).toLowerCase();
    if (!SHA256.test(parsed)) return fail(context, "expected lowercase SHA-256");
    return parsed;
}

function gitCommit(value: unknown, context: string): string {
    const parsed = text(value, context).toLowerCase();
    if (!GIT_COMMIT.test(parsed)) return fail(context, "expected lowercase Git commit");
    return parsed;
}

function featureFingerprints(value: unknown, context: string): IV09FeatureFingerprints {
    const parsed = record(value, context);
    for (const key of ["bootstrap", "rich", "full", "schema"] as const) {
        if (sha(parsed[key], `${context}.${key}`) !== V09_FEATURE_FINGERPRINTS[key]) {
            fail(`${context}.${key}`, "feature fingerprint mismatch");
        }
    }
    return V09_FEATURE_FINGERPRINTS;
}

function phase(value: unknown, context: string): V09CorpusPhase {
    if (value === "wide_teacher" || value === "dagger_1" || value === "dagger_2") return value;
    return fail(context, "unsupported corpus phase");
}

function split(value: unknown, context: string): V09CorpusSplit {
    if (value === "train" || value === "validation") return value;
    return fail(context, "unsupported corpus split");
}

function seat(value: unknown, context: string): V09Seat {
    if (value === "green" || value === "red") return value;
    return fail(context, "unsupported seat");
}

function map(value: unknown, context: string): V09Map {
    if (value === "normal" || value === "water" || value === "lava" || value === "block") return value;
    return fail(context, "unsupported map");
}

function optionalText(value: unknown, context: string): string | null {
    return value === null ? null : text(value, context);
}

function optionalCell(value: unknown, context: string): XY | null {
    if (value === null) return null;
    const parsed = record(value, context);
    return {
        x: integer(parsed.x, `${context}.x`),
        y: integer(parsed.y, `${context}.y`),
    };
}

function parseCandidate(value: unknown, context: string): IV09CandidateRow {
    const parsed = record(value, context);
    const actions = parsed.actions;
    if (!Array.isArray(actions) || !actions.length) fail(`${context}.actions`, "expected non-empty action list");
    const metadata = record(parsed.metadata, `${context}.metadata`);
    const rawTargetMode = metadata.spellTargetMode;
    if (rawTargetMode !== null && rawTargetMode !== "unit" && rawTargetMode !== "cell" && rawTargetMode !== "mass") {
        fail(`${context}.metadata.spellTargetMode`, "unsupported spell target mode");
    }
    const flags = record(parsed.flags, `${context}.flags`);
    const teacherStdErr =
        parsed.teacherStdErr === null ? null : finite(parsed.teacherStdErr, `${context}.teacherStdErr`);
    if (teacherStdErr !== null && teacherStdErr < 0) fail(`${context}.teacherStdErr`, "expected non-negative value");
    return {
        kind: text(parsed.kind, `${context}.kind`),
        signature: text(parsed.signature, `${context}.signature`),
        actions: actions as GameAction[],
        candidateFeatures: vector(
            parsed.candidateFeatures,
            V09_CANDIDATE_FEATURE_NAMES.length,
            `${context}.candidateFeatures`,
        ),
        actionFeatures: vector(parsed.actionFeatures, IL_ACTION_FEATURE_NAMES.length, `${context}.actionFeatures`),
        richFeatures: vector(parsed.richFeatures, V09_RICH_FEATURE_NAMES.length, `${context}.richFeatures`),
        metadata: {
            declaredUnitId: optionalText(metadata.declaredUnitId, `${context}.metadata.declaredUnitId`),
            firstHitUnitId: optionalText(metadata.firstHitUnitId, `${context}.metadata.firstHitUnitId`),
            aimUnitId: optionalText(metadata.aimUnitId, `${context}.metadata.aimUnitId`),
            aimCell: optionalCell(metadata.aimCell, `${context}.metadata.aimCell`),
            aimSide: metadata.aimSide === null ? null : integer(metadata.aimSide, `${context}.metadata.aimSide`),
            spellName: optionalText(metadata.spellName, `${context}.metadata.spellName`),
            spellTargetMode: rawTargetMode,
        },
        flags: {
            productive: binary(flags.productive, `${context}.flags.productive`),
            waitEligible: binary(flags.waitEligible, `${context}.flags.waitEligible`),
            luckShield: binary(flags.luckShield, `${context}.flags.luckShield`),
            mountainAttack: binary(flags.mountainAttack, `${context}.flags.mountainAttack`),
            urgentFinish: binary(flags.urgentFinish, `${context}.flags.urgentFinish`),
            dominantFinish: binary(flags.dominantFinish, `${context}.flags.dominantFinish`),
            aimVisibleEdge: binary(flags.aimVisibleEdge, `${context}.flags.aimVisibleEdge`),
            trajectoryIntercepted: binary(flags.trajectoryIntercepted, `${context}.flags.trajectoryIntercepted`),
        },
        teacherMean: parsed.teacherMean === null ? null : finite(parsed.teacherMean, `${context}.teacherMean`),
        teacherStdErr,
        teacherVisits: integer(parsed.teacherVisits, `${context}.teacherVisits`, 1),
    };
}

function common(value: Record<string, unknown>, context: string) {
    if (value.v !== V09_IL_VERSION || value.schema !== V09_IL_SCHEMA) {
        fail(context, `expected ${V09_IL_SCHEMA} version ${V09_IL_VERSION}`);
    }
    return {
        runFingerprint: sha(value.runFingerprint, `${context}.runFingerprint`),
        featureFingerprints: featureFingerprints(value.featureFingerprints, `${context}.featureFingerprints`),
        sourceCommit: gitCommit(value.sourceCommit, `${context}.sourceCommit`),
        rulesFingerprint: sha(value.rulesFingerprint, `${context}.rulesFingerprint`),
        anchorFingerprint: sha(value.anchorFingerprint, `${context}.anchorFingerprint`),
        phase: phase(value.phase, `${context}.phase`),
        split: split(value.split, `${context}.split`),
        cohort: text(value.cohort, `${context}.cohort`),
        map: map(value.map, `${context}.map`),
        seed: integer(value.seed, `${context}.seed`) >>> 0,
        gameId: text(value.gameId, `${context}.gameId`),
    };
}

export function parseV09DecisionRow(value: unknown, context = "v0.9 IL decision"): IV09DecisionRow {
    const parsed = record(value, context);
    if (parsed.t !== V09_IL_DECISION_TYPE) fail(`${context}.t`, "unexpected row type");
    const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.map((candidate, index) => parseCandidate(candidate, `${context}.candidates[${index}]`))
        : fail(`${context}.candidates`, "expected candidate array");
    if (!candidates.length || candidates.length > V09_MAX_CANDIDATES) {
        fail(`${context}.candidates`, `expected 1..${V09_MAX_CANDIDATES} candidates`);
    }
    const teacherIndex = integer(parsed.teacherIndex, `${context}.teacherIndex`);
    if (teacherIndex >= candidates.length) fail(`${context}.teacherIndex`, "outside candidate array");
    if (parsed.incumbentIndex !== 0) fail(`${context}.incumbentIndex`, "candidate 0 must remain the incumbent");
    return {
        t: V09_IL_DECISION_TYPE,
        v: V09_IL_VERSION,
        schema: V09_IL_SCHEMA,
        ...common(parsed, context),
        decision: integer(parsed.decision, `${context}.decision`),
        seat: seat(parsed.seat, `${context}.seat`),
        lap: integer(parsed.lap, `${context}.lap`),
        actorUnitName: text(parsed.actorUnitName, `${context}.actorUnitName`),
        valueFeatures: vector(parsed.valueFeatures, VALUE_FEATURE_NAMES_V2.length, `${context}.valueFeatures`),
        incumbentIndex: 0,
        teacherIndex,
        candidates,
    };
}

export function parseV09GameRow(value: unknown, context = "v0.9 IL game"): IV09GameRow {
    const parsed = record(value, context);
    if (parsed.t !== V09_IL_GAME_TYPE) fail(`${context}.t`, "unexpected row type");
    const winner = parsed.winner;
    if (winner !== "green" && winner !== "red" && winner !== "draw") {
        fail(`${context}.winner`, "unsupported winner");
    }
    const endReason = parsed.endReason;
    if (endReason !== "elimination" && endReason !== "turn_cap" && endReason !== "stuck") {
        fail(`${context}.endReason`, "unsupported end reason");
    }
    return {
        t: V09_IL_GAME_TYPE,
        v: V09_IL_VERSION,
        schema: V09_IL_SCHEMA,
        ...common(parsed, context),
        greenVersion: text(parsed.greenVersion, `${context}.greenVersion`),
        redVersion: text(parsed.redVersion, `${context}.redVersion`),
        winner,
        endReason,
        decisions: integer(parsed.decisions, `${context}.decisions`),
        rowChainSha256: sha(parsed.rowChainSha256, `${context}.rowChainSha256`),
    };
}

export function parseV09Corpus(lines: Iterable<string>): IV09ParsedCorpus {
    const decisions: IV09DecisionRow[] = [];
    const games: IV09GameRow[] = [];
    const gameRows = new Map<string, Array<{ row: IV09DecisionRow; raw: string }>>();
    for (const [index, line] of [...lines].entries()) {
        if (!line.trim()) continue;
        const raw = line.trim();
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            fail(`line ${index + 1}`, "invalid JSON");
        }
        const parsed = record(value, `line ${index + 1}`);
        if (parsed.t === V09_IL_DECISION_TYPE) {
            const row = parseV09DecisionRow(parsed, `line ${index + 1}`);
            decisions.push(row);
            const prior = gameRows.get(row.gameId) ?? [];
            if (row.decision !== prior.length) fail(`line ${index + 1}`, "decision index is not contiguous");
            prior.push({ row, raw });
            gameRows.set(row.gameId, prior);
        } else if (parsed.t === V09_IL_GAME_TYPE) {
            const row = parseV09GameRow(parsed, `line ${index + 1}`);
            const rows = gameRows.get(row.gameId) ?? [];
            if (rows.length !== row.decisions) fail(`line ${index + 1}`, "decision count mismatch");
            for (const [decisionIndex, { row: decision }] of rows.entries()) {
                for (const key of [
                    "runFingerprint",
                    "sourceCommit",
                    "rulesFingerprint",
                    "anchorFingerprint",
                    "phase",
                    "split",
                    "cohort",
                    "map",
                    "seed",
                    "gameId",
                ] as const) {
                    if (decision[key] !== row[key]) {
                        fail(`line ${index + 1}`, `decision ${decisionIndex} ${key} does not match footer`);
                    }
                }
            }
            const chain = rows.reduce((hash, decision) => v09RowChainNext(hash, decision.raw), "0".repeat(64));
            if (chain !== row.rowChainSha256) fail(`line ${index + 1}`, "row-chain fingerprint mismatch");
            games.push(row);
            gameRows.delete(row.gameId);
        } else {
            fail(`line ${index + 1}`, "unknown row type");
        }
    }
    if (gameRows.size) fail("corpus", `missing footers for ${gameRows.size} games`);
    return { decisions, games };
}
