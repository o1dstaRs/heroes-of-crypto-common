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

import type { ICandidateFeatures, IEnumeratedCandidate, IShotCandidateFeatures } from "../ai/candidates";
import { WAIT_FEATURE_NAMES } from "../ai/versions/wait_scorer";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { GRID_SIZE } from "../grid/grid_constants";
import { RANGE_ATTACK_CELL_SIDES } from "../grid/grid_math";
import type { XY } from "../utils/math";
import {
    IL_ACTION_FAMILIES,
    IL_ACTION_FEATURE_NAMES,
    IL_SHOT_FEATURE_NAMES,
    ilCandidateActionEncoding,
    type IIlCandidateActionMetadata,
    type IIlMoveMetadata,
    type IIlSpellMetadata,
    type IlActionFamily,
} from "./il_action_features";
import { VALUE_FEATURE_NAMES_V2 } from "./value_features";

export const IL_ROW_TYPE = "ild" as const;
export const IL_GAME_ROW_TYPE = "ild_game" as const;
export const IL_DATASET_VERSION = 3 as const;

const RUN_FINGERPRINT = /^[0-9a-f]{64}$/i;
const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;
const PAIR_SEED_STEP = 0x9e3779b1;

export const IL_CANDIDATE_FEATURE_NAMES = [
    "moraleDelta",
    "luckDelta",
    "enemiesNotYetActedFrac",
    "alliesNotYetActedFrac",
    "lap",
    "hourglassSpent",
    "spendsRangeShot",
    "spendsSpellCharge",
    "burnsResurrectionCharge",
    "expectedDamage",
    "expectedKill",
] as const;

export function ilCandidateFeatureVector(features: ICandidateFeatures): number[] {
    return [
        features.moraleDelta,
        features.luckDelta,
        features.enemiesNotYetActedFrac,
        features.alliesNotYetActedFrac,
        features.lap,
        features.hourglassSpent,
        features.spendsRangeShot,
        features.spendsSpellCharge,
        features.burnsResurrectionCharge,
        features.expectedDamage,
        features.expectedKill,
    ];
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprintNames = (key: string, names: readonly string[]): string => sha256({ key, names });

const wfFingerprint = fingerprintNames("ild-v3-wf", WAIT_FEATURE_NAMES);
const vfFingerprint = fingerprintNames("ild-v3-vf", VALUE_FEATURE_NAMES_V2);
const cfFingerprint = fingerprintNames("ild-v3-cf", IL_CANDIDATE_FEATURE_NAMES);
const afFingerprint = fingerprintNames("ild-v3-af", IL_ACTION_FEATURE_NAMES);
const IL_CANDIDATE_ROW_FIELDS = ["kind", "ck", "sig", "act", "cf", "am", "af", "m"] as const;
const IL_ACTION_METADATA_FIELDS = [
    "family",
    "actionCount",
    "attackSelection",
    "move",
    "hasUnitTarget",
    "targetCell",
    "standCell",
    "aimCell",
    "aimSide",
    "spell",
    "shotFeatures",
] as const;
const IL_MOVE_METADATA_FIELDS = ["pathLength", "destination", "hasLava", "hasWater"] as const;
const IL_SPELL_METADATA_FIELDS = ["name", "targetMode"] as const;
const IL_SEARCH_CONFIG_FIELDS = [
    "gate",
    "horizon",
    "rollouts",
    "leaf",
    "shortlist",
    "includeMoves",
    "activeChallengers",
    "maxMoveShotComposites",
    "moveShotVersions",
    "oppModel",
    "decisionDeadlineMs",
    "circuitBreakerMs",
    "caps",
] as const;
const IL_SEARCH_CAP_FIELDS = ["maxMoveDestinations", "maxMeleePairs", "maxShotAims", "maxAreaThrowCells"] as const;
const IL_ACTION_FIELDS = Object.freeze({
    end_turn: ["type", "unitId", "reason"],
    wait_turn: ["type", "unitId"],
    defend_turn: ["type", "unitId"],
    select_attack_type: ["type", "unitId", "attackType"],
    move_unit: ["type", "unitId", "path", "targetCells", "hasLavaCell", "hasWaterCell"],
    melee_attack: ["type", "attackerId", "targetId", "attackFrom", "path", "hasLavaCell", "hasWaterCell"],
    range_attack: ["type", "attackerId", "targetId", "aimCell", "aimSide"],
    obstacle_attack: ["type", "attackerId", "targetPosition", "attackFrom", "path", "hasLavaCell", "hasWaterCell"],
    area_throw_attack: ["type", "attackerId", "targetCell"],
    cast_spell: ["type", "casterId", "spellName", "targetId", "targetCell"],
} as const);
const IL_DECISION_ROW_FIELDS = [
    "t",
    "v",
    "runFingerprint",
    "featureFingerprints",
    "cohort",
    "decision",
    "seed",
    "green",
    "red",
    "side",
    "lap",
    "unit",
    "k",
    "ov",
    "chosen",
    "nc",
    "act",
    "wf",
    "vf",
    "cands",
    "cfg",
] as const;
const IL_GAME_ROW_FIELDS = [
    "t",
    "v",
    "runFingerprint",
    "featureFingerprints",
    "cohort",
    "seed",
    "green",
    "red",
    "winner",
    "endReason",
    "rows",
    "decisions",
    "searched",
    "singleCandidate",
    "deadlineFallbacks",
    "circuitOpened",
    "circuitSkipped",
    "cfg",
] as const;

/** The only numeric arrays a policy trainer may consume from an extracted v3 row. */
export const IL_MODEL_INPUT_CONTRACT = Object.freeze({
    numeric: Object.freeze(["wf", "vf", "cands[].cf", "cands[].af"]),
    labelsAndProvenance: Object.freeze(["chosen", "targetSig", "cands[].sig", "m"]),
});

/** Feature-order provenance repeated on every decision/footer so shards cannot be mixed silently. */
export const IL_FEATURE_FINGERPRINTS = Object.freeze({
    wf: wfFingerprint,
    vf: vfFingerprint,
    cf: cfFingerprint,
    af: afFingerprint,
    schema: sha256({
        rowType: IL_ROW_TYPE,
        gameRowType: IL_GAME_ROW_TYPE,
        version: IL_DATASET_VERSION,
        wf: wfFingerprint,
        vf: vfFingerprint,
        cf: cfFingerprint,
        af: afFingerprint,
        actionFamilies: IL_ACTION_FAMILIES,
        candidateFields: IL_CANDIDATE_ROW_FIELDS,
        decisionFields: IL_DECISION_ROW_FIELDS,
        gameFields: IL_GAME_ROW_FIELDS,
        actionMetadataFields: IL_ACTION_METADATA_FIELDS,
        moveMetadataFields: IL_MOVE_METADATA_FIELDS,
        spellMetadataFields: IL_SPELL_METADATA_FIELDS,
        shotFields: IL_SHOT_FEATURE_NAMES,
        actionFields: IL_ACTION_FIELDS,
        searchConfigFields: IL_SEARCH_CONFIG_FIELDS,
        searchCapFields: IL_SEARCH_CAP_FIELDS,
        modelInputContract: IL_MODEL_INPUT_CONTRACT,
    }),
});

export type IIlFeatureFingerprints = typeof IL_FEATURE_FINGERPRINTS;

/** Canonical action identity used by the IL target and its semantic-group evaluator. */
export function ilActionSignature(actions: readonly GameAction[]): string {
    const cell = (c?: XY): string => (c ? `${c.x},${c.y}` : "-");
    return actions
        .map((action) => {
            switch (action.type) {
                case "select_attack_type":
                    return `sel:${action.attackType}`;
                case "move_unit":
                    return `mv:${cell(action.path[action.path.length - 1])}`;
                case "melee_attack":
                    return `ml:${action.targetId}@${cell(action.attackFrom)}`;
                case "range_attack":
                    return `rg:${action.targetId}@${cell(action.aimCell)}/${action.aimSide ?? "-"}`;
                case "area_throw_attack":
                    return `at:${cell(action.targetCell)}`;
                case "cast_spell":
                    return `cs:${action.spellName}>${action.targetId ?? "-"}@${cell(action.targetCell)}`;
                default:
                    return action.type;
            }
        })
        .join("|");
}

export function requireIlRunFingerprint(value: unknown, context = "SEARCH_IL_RUN_FINGERPRINT"): string {
    if (typeof value !== "string" || !RUN_FINGERPRINT.test(value)) {
        throw new Error(`${context} must be exactly 64 hexadecimal characters`);
    }
    return value.toLowerCase();
}

export interface IIlCandidateRow {
    kind: string;
    ck: string;
    sig: string;
    act: GameAction[];
    cf: number[];
    am: IIlCandidateActionMetadata;
    af: number[];
    m: number | null;
}

export interface IIlSearchConfig {
    gate: number;
    horizon: number;
    rollouts: number;
    leaf: "learned_v2" | "learned" | "material";
    shortlist: number | null;
    includeMoves: 0 | 1;
    activeChallengers: 0 | 1;
    maxMoveShotComposites: number;
    moveShotVersions: string[];
    oppModel: string | null;
    decisionDeadlineMs: number | null;
    circuitBreakerMs: number | null;
    caps: {
        maxMoveDestinations: number;
        maxMeleePairs: number;
        maxShotAims: number;
        maxAreaThrowCells: number;
    };
}

interface IIlProvenance {
    v: typeof IL_DATASET_VERSION;
    runFingerprint: string;
    featureFingerprints: IIlFeatureFingerprints;
    cohort: string;
    seed: number;
    green: string;
    red: string;
    cfg: IIlSearchConfig;
}

export interface IIlRow extends IIlProvenance {
    t: typeof IL_ROW_TYPE;
    decision: number;
    side: "green" | "red";
    lap: number;
    unit: string;
    k: string;
    ov: 0 | 1;
    chosen: number;
    nc: number;
    act: GameAction[];
    wf: number[];
    vf: number[];
    cands: IIlCandidateRow[];
}

export interface IIlGameRow extends IIlProvenance {
    t: typeof IL_GAME_ROW_TYPE;
    winner: "green" | "red" | "draw";
    endReason: "elimination" | "turn_cap" | "stuck";
    rows: number;
    decisions: number;
    searched: number;
    singleCandidate: number;
    deadlineFallbacks: number;
    circuitOpened: 0 | 1;
    circuitSkipped: number;
}

type JsonRecord = Record<string, unknown>;

const fail = (context: string, message: string): never => {
    throw new Error(`${context}: ${message}`);
};
const record = (value: unknown, context: string): JsonRecord => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(context, "expected an object row");
    return value as JsonRecord;
};
const exactKeys = (value: JsonRecord, expected: readonly string[], context: string): void => {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        fail(context, `keys ${actual.join(",")} do not match ${wanted.join(",")}`);
    }
};
const allowedKeys = (value: JsonRecord, allowed: readonly string[], context: string): void => {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) fail(context, `unknown keys ${unknown.sort().join(",")}`);
};
const string = (value: unknown, context: string): string => {
    if (typeof value !== "string" || !value.trim()) fail(context, "expected a non-empty string");
    return value as string;
};
const finite = (value: unknown, context: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(context, "expected a finite number");
    return value as number;
};
const integer = (value: unknown, context: string, minimum = 0): number => {
    const parsed = finite(value, context);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(context, `expected an integer >= ${minimum}`);
    return parsed;
};
const binary = (value: unknown, context: string): 0 | 1 => {
    if (value === 0 || value === 1) return value;
    return fail(context, "expected 0 or 1");
};
const boolean = (value: unknown, context: string): boolean => {
    if (typeof value !== "boolean") fail(context, "expected a boolean");
    return value as boolean;
};
const canonicalSeed = (value: unknown, context: string): number => {
    const parsed = finite(value, context);
    if (!Number.isSafeInteger(parsed) || parsed < INT32_MIN || parsed > UINT32_MAX) {
        fail(context, "expected a signed int32 or uint32 integer");
    }
    return parsed >>> 0;
};
const features = (value: unknown, width: number, context: string): number[] => {
    const values: unknown[] = Array.isArray(value) ? value : fail(context, `feature width non-array != ${width}`);
    if (values.length !== width) fail(context, `feature width ${values.length} != ${width}`);
    return values.map((feature, index) => finite(feature, `${context}[${index}]`));
};
const cell = (value: unknown, context: string): XY => {
    const parsed = record(value, context);
    exactKeys(parsed, ["x", "y"], context);
    const x = integer(parsed.x, `${context}.x`);
    const y = integer(parsed.y, `${context}.y`);
    if (x >= GRID_SIZE || y >= GRID_SIZE) fail(context, `cell must be inside the ${GRID_SIZE}x${GRID_SIZE} grid`);
    return { x, y };
};
const point = (value: unknown, context: string): XY => {
    const parsed = record(value, context);
    exactKeys(parsed, ["x", "y"], context);
    return { x: finite(parsed.x, `${context}.x`), y: finite(parsed.y, `${context}.y`) };
};
const optionalCell = (value: unknown, context: string): XY | null => (value === null ? null : cell(value, context));

const leaf = (value: unknown, context: string): IIlSearchConfig["leaf"] => {
    if (value === "learned_v2" || value === "learned" || value === "material") return value;
    return fail(context, "unsupported leaf");
};
const side = (value: unknown, context: string): IIlRow["side"] => {
    if (value === "green" || value === "red") return value;
    return fail(context, "expected green or red");
};
const winner = (value: unknown, context: string): IIlGameRow["winner"] => {
    if (value === "green" || value === "red" || value === "draw") return value;
    return fail(context, "expected green, red, or draw");
};
const endReason = (value: unknown, context: string): IIlGameRow["endReason"] => {
    if (value === "elimination" || value === "turn_cap" || value === "stuck") return value;
    return fail(context, "unsupported match end reason");
};

function parseFeatureFingerprints(value: unknown, context: string): IIlFeatureFingerprints {
    const parsed = record(value, context);
    exactKeys(parsed, ["wf", "vf", "cf", "af", "schema"], context);
    for (const key of ["wf", "vf", "cf", "af", "schema"] as const) {
        const fingerprint = requireIlRunFingerprint(parsed[key], `${context}.${key}`);
        if (fingerprint !== IL_FEATURE_FINGERPRINTS[key]) {
            fail(
                `${context}.${key}`,
                `feature fingerprint ${fingerprint} does not match ${IL_FEATURE_FINGERPRINTS[key]}`,
            );
        }
    }
    return IL_FEATURE_FINGERPRINTS;
}

function parseConfig(value: unknown, context: string): IIlSearchConfig {
    const cfg = record(value, context);
    exactKeys(cfg, IL_SEARCH_CONFIG_FIELDS, context);
    const gate = finite(cfg.gate, `${context}.gate`);
    if (gate < 0) fail(`${context}.gate`, "expected a non-negative number");
    const deadline = (value: unknown, field: string): number | null => {
        if (value === null) return null;
        const parsed = finite(value, `${context}.${field}`);
        if (parsed <= 0) fail(`${context}.${field}`, "expected a positive number or null");
        return parsed;
    };
    const rawCaps = record(cfg.caps, `${context}.caps`);
    exactKeys(rawCaps, IL_SEARCH_CAP_FIELDS, `${context}.caps`);
    const maxMoveShotComposites = integer(cfg.maxMoveShotComposites, `${context}.maxMoveShotComposites`);
    if (maxMoveShotComposites > 2) {
        fail(`${context}.maxMoveShotComposites`, "expected an integer between 0 and 2");
    }
    const rawMoveShotVersions: unknown[] = Array.isArray(cfg.moveShotVersions)
        ? cfg.moveShotVersions
        : fail(`${context}.moveShotVersions`, "expected an array");
    const moveShotVersions = rawMoveShotVersions.map((version, index) =>
        string(version, `${context}.moveShotVersions[${index}]`),
    );
    if (
        moveShotVersions.some((version) => !version.trim()) ||
        new Set(moveShotVersions).size !== moveShotVersions.length ||
        (maxMoveShotComposites > 0 && moveShotVersions.length === 0)
    ) {
        fail(`${context}.moveShotVersions`, "expected unique non-empty versions for an enabled move-shot probe");
    }
    return {
        gate,
        horizon: integer(cfg.horizon, `${context}.horizon`, 1),
        rollouts: integer(cfg.rollouts, `${context}.rollouts`, 1),
        leaf: leaf(cfg.leaf, `${context}.leaf`),
        shortlist: cfg.shortlist === null ? null : integer(cfg.shortlist, `${context}.shortlist`, 2),
        includeMoves: binary(cfg.includeMoves, `${context}.includeMoves`),
        activeChallengers: binary(cfg.activeChallengers, `${context}.activeChallengers`),
        maxMoveShotComposites,
        moveShotVersions,
        oppModel: cfg.oppModel === null ? null : string(cfg.oppModel, `${context}.oppModel`),
        decisionDeadlineMs: deadline(cfg.decisionDeadlineMs, "decisionDeadlineMs"),
        circuitBreakerMs: deadline(cfg.circuitBreakerMs, "circuitBreakerMs"),
        caps: {
            maxMoveDestinations: integer(rawCaps.maxMoveDestinations, `${context}.caps.maxMoveDestinations`, 1),
            maxMeleePairs: integer(rawCaps.maxMeleePairs, `${context}.caps.maxMeleePairs`, 1),
            maxShotAims: integer(rawCaps.maxShotAims, `${context}.caps.maxShotAims`, 1),
            maxAreaThrowCells: integer(rawCaps.maxAreaThrowCells, `${context}.caps.maxAreaThrowCells`, 1),
        },
    };
}

const ACTION_TYPES = new Set(Object.keys(IL_ACTION_FIELDS));

const parseActionPath = (value: unknown, context: string): XY[] => {
    const path: unknown[] = Array.isArray(value) ? value : fail(context, "expected a non-empty path");
    if (!path.length) fail(context, "expected a non-empty path");
    return path.map((point, index) => cell(point, `${context}[${index}]`));
};

function parseActions(value: unknown, context: string): GameAction[] {
    const actions: unknown[] = Array.isArray(value) ? value : fail(context, "expected a non-empty action list");
    if (!actions.length) fail(context, "expected a non-empty action list");
    return actions.map((value, index) => {
        const action = record(value, `${context}[${index}]`);
        const type = string(action.type, `${context}[${index}].type`);
        if (!ACTION_TYPES.has(type)) fail(`${context}[${index}].type`, `unsupported candidate action ${type}`);
        allowedKeys(action, IL_ACTION_FIELDS[type as keyof typeof IL_ACTION_FIELDS], `${context}[${index}]`);
        if (type === "end_turn") {
            string(action.unitId, `${context}[${index}].unitId`);
            if (
                action.reason !== undefined &&
                action.reason !== "effect" &&
                action.reason !== "timeout" &&
                action.reason !== "manual" &&
                action.reason !== "skip"
            ) {
                fail(`${context}[${index}].reason`, "unsupported end-turn reason");
            }
        } else if (type === "wait_turn" || type === "defend_turn") {
            string(action.unitId, `${context}[${index}].unitId`);
        } else if (type === "move_unit") {
            string(action.unitId, `${context}[${index}].unitId`);
            parseActionPath(action.path, `${context}[${index}].path`);
            if (action.targetCells !== undefined) {
                const targetCells: unknown[] = Array.isArray(action.targetCells)
                    ? action.targetCells
                    : fail(`${context}[${index}].targetCells`, "expected a non-empty cell list");
                if (!targetCells.length) fail(`${context}[${index}].targetCells`, "expected a non-empty cell list");
                targetCells.forEach((target, targetIndex) =>
                    cell(target, `${context}[${index}].targetCells[${targetIndex}]`),
                );
            }
            if (action.hasLavaCell !== undefined) boolean(action.hasLavaCell, `${context}[${index}].hasLavaCell`);
            if (action.hasWaterCell !== undefined) boolean(action.hasWaterCell, `${context}[${index}].hasWaterCell`);
        } else if (type === "melee_attack") {
            string(action.attackerId, `${context}[${index}].attackerId`);
            string(action.targetId, `${context}[${index}].targetId`);
            cell(action.attackFrom, `${context}[${index}].attackFrom`);
            if (action.path !== undefined) parseActionPath(action.path, `${context}[${index}].path`);
            if (action.hasLavaCell !== undefined) boolean(action.hasLavaCell, `${context}[${index}].hasLavaCell`);
            if (action.hasWaterCell !== undefined) boolean(action.hasWaterCell, `${context}[${index}].hasWaterCell`);
        } else if (type === "range_attack") {
            string(action.attackerId, `${context}[${index}].attackerId`);
            string(action.targetId, `${context}[${index}].targetId`);
            if (action.aimCell !== undefined) cell(action.aimCell, `${context}[${index}].aimCell`);
            if (
                action.aimSide !== undefined &&
                !RANGE_ATTACK_CELL_SIDES.includes(finite(action.aimSide, `${context}[${index}].aimSide`) as never)
            ) {
                fail(`${context}[${index}].aimSide`, "unsupported aim side");
            }
        } else if (type === "area_throw_attack") {
            string(action.attackerId, `${context}[${index}].attackerId`);
            cell(action.targetCell, `${context}[${index}].targetCell`);
        } else if (type === "obstacle_attack") {
            string(action.attackerId, `${context}[${index}].attackerId`);
            point(action.targetPosition, `${context}[${index}].targetPosition`);
            if (action.attackFrom !== undefined) cell(action.attackFrom, `${context}[${index}].attackFrom`);
            if (action.path !== undefined) parseActionPath(action.path, `${context}[${index}].path`);
            if (action.hasLavaCell !== undefined) boolean(action.hasLavaCell, `${context}[${index}].hasLavaCell`);
            if (action.hasWaterCell !== undefined) boolean(action.hasWaterCell, `${context}[${index}].hasWaterCell`);
        } else if (type === "cast_spell") {
            string(action.casterId, `${context}[${index}].casterId`);
            string(action.spellName, `${context}[${index}].spellName`);
            if (action.targetId !== undefined) string(action.targetId, `${context}[${index}].targetId`);
            if (action.targetCell !== undefined) cell(action.targetCell, `${context}[${index}].targetCell`);
        } else if (type === "select_attack_type") {
            string(action.unitId, `${context}[${index}].unitId`);
            integer(action.attackType, `${context}[${index}].attackType`);
        }
        return action as unknown as GameAction;
    });
}

function parseShotFeatures(value: unknown, context: string): IShotCandidateFeatures | null {
    if (value === null) return null;
    const parsed = record(value, context);
    exactKeys(parsed, IL_SHOT_FEATURE_NAMES, context);
    const result = Object.fromEntries(
        IL_SHOT_FEATURE_NAMES.map((name) => [name, finite(parsed[name], `${context}.${name}`)]),
    ) as unknown as IShotCandidateFeatures;
    result.targetIsRanged = binary(result.targetIsRanged, `${context}.targetIsRanged`);
    result.targetCanCastSpells = binary(result.targetCanCastSpells, `${context}.targetCanCastSpells`);
    result.targetNotYetActed = binary(result.targetNotYetActed, `${context}.targetNotYetActed`);
    if (result.targetWoundedFraction < 0 || result.targetWoundedFraction > 1) {
        fail(`${context}.targetWoundedFraction`, "expected a value in [0,1]");
    }
    for (const name of IL_SHOT_FEATURE_NAMES) {
        if (result[name] < 0) fail(`${context}.${name}`, "expected a non-negative observation");
    }
    return result;
}

function parseMove(value: unknown, context: string): IIlMoveMetadata | null {
    if (value === null) return null;
    const parsed = record(value, context);
    exactKeys(parsed, IL_MOVE_METADATA_FIELDS, context);
    return {
        pathLength: integer(parsed.pathLength, `${context}.pathLength`, 1),
        destination: cell(parsed.destination, `${context}.destination`),
        hasLava: binary(parsed.hasLava, `${context}.hasLava`),
        hasWater: binary(parsed.hasWater, `${context}.hasWater`),
    };
}

function parseSpell(value: unknown, context: string): IIlSpellMetadata | null {
    if (value === null) return null;
    const parsed = record(value, context);
    exactKeys(parsed, IL_SPELL_METADATA_FIELDS, context);
    const targetMode = parsed.targetMode;
    if (targetMode !== "unit" && targetMode !== "cell" && targetMode !== "mass") {
        fail(`${context}.targetMode`, "unsupported spell target mode");
    }
    return { name: string(parsed.name, `${context}.name`), targetMode: targetMode as IIlSpellMetadata["targetMode"] };
}

function parseActionMetadata(value: unknown, context: string): IIlCandidateActionMetadata {
    const parsed = record(value, context);
    exactKeys(parsed, IL_ACTION_METADATA_FIELDS, context);
    const family = string(parsed.family, `${context}.family`);
    if (!(IL_ACTION_FAMILIES as readonly string[]).includes(family)) {
        fail(`${context}.family`, `unsupported action family ${family}`);
    }
    const aimSide = parsed.aimSide === null ? null : finite(parsed.aimSide, `${context}.aimSide`);
    if (aimSide !== null && !RANGE_ATTACK_CELL_SIDES.includes(aimSide as never)) {
        fail(`${context}.aimSide`, "unsupported aim side");
    }
    return {
        family: family as IlActionFamily,
        actionCount: integer(parsed.actionCount, `${context}.actionCount`, 1),
        attackSelection:
            parsed.attackSelection === null ? null : finite(parsed.attackSelection, `${context}.attackSelection`),
        move: parseMove(parsed.move, `${context}.move`),
        hasUnitTarget: binary(parsed.hasUnitTarget, `${context}.hasUnitTarget`),
        targetCell: optionalCell(parsed.targetCell, `${context}.targetCell`),
        standCell: optionalCell(parsed.standCell, `${context}.standCell`),
        aimCell: optionalCell(parsed.aimCell, `${context}.aimCell`),
        aimSide,
        spell: parseSpell(parsed.spell, `${context}.spell`),
        shotFeatures: parseShotFeatures(parsed.shotFeatures, `${context}.shotFeatures`),
    };
}

const candidateFeaturesFromVector = (vector: readonly number[]): ICandidateFeatures =>
    Object.fromEntries(
        IL_CANDIDATE_FEATURE_NAMES.map((name, index) => [name, vector[index]]),
    ) as unknown as ICandidateFeatures;

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCandidate(value: unknown, index: number, perspectiveTeam: TeamType, context: string): IIlCandidateRow {
    const parsed = record(value, context);
    exactKeys(parsed, IL_CANDIDATE_ROW_FIELDS, context);
    const kind = string(parsed.kind, `${context}.kind`);
    const ck = string(parsed.ck, `${context}.ck`);
    const sig = string(parsed.sig, `${context}.sig`);
    const act = parseActions(parsed.act, `${context}.act`);
    const derivedSignature = ilActionSignature(act);
    if (sig !== derivedSignature) fail(context, "sig must equal the candidate action signature");
    const cf = features(parsed.cf, IL_CANDIDATE_FEATURE_NAMES.length, `${context}.cf`);
    const am = parseActionMetadata(parsed.am, `${context}.am`);
    const af = features(parsed.af, IL_ACTION_FEATURE_NAMES.length, `${context}.af`);
    const reconstructed: IEnumeratedCandidate = {
        kind: index === 0 ? "incumbent" : (kind as IEnumeratedCandidate["kind"]),
        actions: act,
        shotFeatures: am.shotFeatures ?? undefined,
        features: candidateFeaturesFromVector(cf),
    };
    const canonical = ilCandidateActionEncoding(reconstructed, perspectiveTeam);
    if (JSON.stringify(am) !== JSON.stringify(canonical.metadata)) {
        fail(context, "action metadata does not match the candidate action list");
    }
    if (!sameNumbers(af, canonical.features)) fail(context, "action feature vector does not match action metadata");
    if (ck !== am.family) fail(context, "ck must equal the canonical action family");
    if (index === 0 ? kind !== "incumbent" : kind !== am.family) {
        fail(context, index === 0 ? "cands[0] must be the incumbent" : "generated kind must equal action family");
    }
    return {
        kind,
        ck,
        sig,
        act,
        cf,
        am,
        af,
        m: parsed.m === null ? null : finite(parsed.m, `${context}.m`),
    };
}

/** Strict parse of one current IL decision row. Legacy schemas are rejected explicitly. */
export function parseIlRow(value: unknown, expectedFingerprint: string, context = "IL row"): IIlRow {
    const row = record(value, context);
    if (row.t !== IL_ROW_TYPE || row.v !== IL_DATASET_VERSION) {
        fail(context, `expected ${IL_ROW_TYPE} v${IL_DATASET_VERSION}; legacy schemas are not accepted`);
    }
    exactKeys(row, IL_DECISION_ROW_FIELDS, context);
    const runFingerprint = requireIlRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requireIlRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) fail(context, `run fingerprint ${runFingerprint} does not match ${expected}`);
    const featureFingerprints = parseFeatureFingerprints(row.featureFingerprints, `${context}.featureFingerprints`);
    const parsedSide = side(row.side, `${context}.side`);
    const ov = binary(row.ov, `${context}.ov`);
    const candidateRows: unknown[] = Array.isArray(row.cands)
        ? row.cands
        : fail(`${context}.cands`, "expected >= 2 candidates");
    if (candidateRows.length < 2) fail(`${context}.cands`, "expected >= 2 candidates");
    const perspectiveTeam = parsedSide === "green" ? PBTypes.TeamVals.LOWER : PBTypes.TeamVals.UPPER;
    const cands = candidateRows.map((candidate, index) =>
        parseCandidate(candidate, index, perspectiveTeam, `${context}.cands[${index}]`),
    );
    const chosen = integer(row.chosen, `${context}.chosen`);
    if (chosen >= cands.length) fail(`${context}.chosen`, `expected an index into cands (0..${cands.length - 1})`);
    if ((ov === 1) !== (chosen !== 0)) fail(context, "ov must be 1 exactly when chosen != 0");
    if (cands[chosen].m === null) fail(context, "chosen candidate must have a finite rollout mean");
    const incumbentKind = string(row.k, `${context}.k`);
    if (incumbentKind !== cands[0].ck) fail(context, "k must equal cands[0].ck");
    const chosenActions = parseActions(row.act, `${context}.act`);
    if (ilActionSignature(chosenActions) !== cands[chosen].sig) {
        fail(context, "act signature must equal the chosen candidate signature");
    }
    const cfg = parseConfig(row.cfg, `${context}.cfg`);
    const nc = integer(row.nc, `${context}.nc`, cands.length);
    if (cfg.shortlist === null && nc !== cands.length) fail(context, "nc must equal cands.length without a shortlist");
    if (cfg.shortlist !== null && cands.length > cfg.shortlist) fail(context, "cands exceeds the configured shortlist");
    return {
        t: IL_ROW_TYPE,
        v: IL_DATASET_VERSION,
        runFingerprint,
        featureFingerprints,
        cohort: string(row.cohort, `${context}.cohort`),
        decision: integer(row.decision, `${context}.decision`),
        seed: canonicalSeed(row.seed, `${context}.seed`),
        green: string(row.green, `${context}.green`),
        red: string(row.red, `${context}.red`),
        side: parsedSide,
        lap: integer(row.lap, `${context}.lap`),
        unit: string(row.unit, `${context}.unit`),
        k: incumbentKind,
        ov,
        chosen,
        nc,
        act: chosenActions,
        wf: features(row.wf, WAIT_FEATURE_NAMES.length, `${context}.wf`),
        vf: features(row.vf, VALUE_FEATURE_NAMES_V2.length, `${context}.vf`),
        cands,
        cfg,
    };
}

export function parseIlGameRow(value: unknown, expectedFingerprint: string, context = "IL game row"): IIlGameRow {
    const row = record(value, context);
    if (row.t !== IL_GAME_ROW_TYPE || row.v !== IL_DATASET_VERSION) {
        fail(context, `expected ${IL_GAME_ROW_TYPE} v${IL_DATASET_VERSION}; legacy schemas are not accepted`);
    }
    exactKeys(row, IL_GAME_ROW_FIELDS, context);
    const runFingerprint = requireIlRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requireIlRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) fail(context, `run fingerprint ${runFingerprint} does not match ${expected}`);
    return {
        t: IL_GAME_ROW_TYPE,
        v: IL_DATASET_VERSION,
        runFingerprint,
        featureFingerprints: parseFeatureFingerprints(row.featureFingerprints, `${context}.featureFingerprints`),
        cohort: string(row.cohort, `${context}.cohort`),
        seed: canonicalSeed(row.seed, `${context}.seed`),
        green: string(row.green, `${context}.green`),
        red: string(row.red, `${context}.red`),
        winner: winner(row.winner, `${context}.winner`),
        endReason: endReason(row.endReason, `${context}.endReason`),
        rows: integer(row.rows, `${context}.rows`),
        decisions: integer(row.decisions, `${context}.decisions`),
        searched: integer(row.searched, `${context}.searched`),
        singleCandidate: integer(row.singleCandidate, `${context}.singleCandidate`),
        deadlineFallbacks: integer(row.deadlineFallbacks, `${context}.deadlineFallbacks`),
        circuitOpened: binary(row.circuitOpened, `${context}.circuitOpened`),
        circuitSkipped: integer(row.circuitSkipped, `${context}.circuitSkipped`),
        cfg: parseConfig(row.cfg, `${context}.cfg`),
    };
}

export interface IValidatedIlCorpus {
    decisions: IIlRow[];
    games: IIlGameRow[];
    config: IIlSearchConfig;
}

const plannedVersions = (value: unknown, context: string): readonly [string, string] => {
    if (!Array.isArray(value) || value.length !== 2) {
        return fail(context, "expected exactly two planned strategy versions");
    }
    const items: readonly unknown[] = value;
    const left = string(items[0], `${context}[0]`);
    const right = string(items[1], `${context}[1]`);
    if (left === right) fail(context, "planned strategy versions must be distinct");
    return [left, right];
};

/** Validate complete per-game chunks and the mirrored tournament seed multiset. */
export function validateIlCorpus(
    lines: readonly string[],
    options: {
        runFingerprint: string;
        cohort: string;
        expectedGames: number;
        baseSeed: number;
        versions: readonly [string, string];
    },
): IValidatedIlCorpus {
    const expectedFingerprint = requireIlRunFingerprint(options.runFingerprint);
    const expectedGames = integer(options.expectedGames, "expectedGames", 2);
    if (expectedGames % 2 !== 0) fail(options.cohort, "expectedGames must be even for mirrored pairs");
    const baseSeed = canonicalSeed(options.baseSeed, "baseSeed");
    const versions = plannedVersions(options.versions, "versions");
    const decisions: IIlRow[] = [];
    const games: IIlGameRow[] = [];
    let pending: IIlRow[] = [];
    let configJson: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch {
            fail(`${options.cohort}:${index + 1}`, "invalid JSON");
        }
        const type = record(raw, `${options.cohort}:${index + 1}`).t;
        if (type === IL_ROW_TYPE) {
            const row = parseIlRow(raw, expectedFingerprint, `${options.cohort}:${index + 1}`);
            if (row.cohort !== options.cohort) fail(`${options.cohort}:${index + 1}`, "cohort mismatch");
            if (row.decision !== pending.length) fail(`${options.cohort}:${index + 1}`, "decision ordinal mismatch");
            pending.push(row);
            continue;
        }
        if (type !== IL_GAME_ROW_TYPE) fail(`${options.cohort}:${index + 1}`, `unexpected row type ${String(type)}`);
        const game = parseIlGameRow(raw, expectedFingerprint, `${options.cohort}:${index + 1}`);
        if (game.cohort !== options.cohort) fail(`${options.cohort}:${index + 1}`, "cohort mismatch");
        if (game.rows !== pending.length) fail(`${options.cohort}:${index + 1}`, "footer row count mismatch");
        if (game.decisions !== game.searched + game.singleCandidate) {
            fail(`${options.cohort}:${index + 1}`, "decision/search accounting mismatch");
        }
        if (game.rows !== game.searched - game.deadlineFallbacks) {
            fail(`${options.cohort}:${index + 1}`, "searched-row accounting mismatch");
        }
        if (game.deadlineFallbacks || game.circuitOpened || game.circuitSkipped) {
            fail(`${options.cohort}:${index + 1}`, "deadline or circuit loss makes the corpus incomplete");
        }
        if (game.cfg.decisionDeadlineMs !== null || game.cfg.circuitBreakerMs !== null) {
            fail(
                `${options.cohort}:${index + 1}`,
                "configured deadline or circuit breaker makes the corpus ineligible for policy extraction",
            );
        }
        const serializedConfig = JSON.stringify(game.cfg);
        if (configJson !== null && configJson !== serializedConfig) {
            fail(`${options.cohort}:${index + 1}`, "search configuration drifted within the corpus");
        }
        configJson = serializedConfig;
        for (const row of pending) {
            if (
                row.seed !== game.seed ||
                row.green !== game.green ||
                row.red !== game.red ||
                row.featureFingerprints.schema !== game.featureFingerprints.schema ||
                JSON.stringify(row.cfg) !== serializedConfig
            ) {
                fail(`${options.cohort}:${index + 1}`, "decision provenance does not match its game footer");
            }
        }
        decisions.push(...pending);
        pending = [];
        games.push(game);
    }
    if (pending.length) fail(options.cohort, "missing final game footer");
    if (games.length !== expectedGames) {
        fail(options.cohort, `completed games ${games.length} != expected ${expectedGames}`);
    }
    const expectedSeeds = new Map<number, number>();
    for (let game = 0; game < expectedGames; game += 1) {
        const seed = (baseSeed + Math.floor(game / 2) * PAIR_SEED_STEP) >>> 0;
        expectedSeeds.set(seed, (expectedSeeds.get(seed) ?? 0) + 1);
    }
    const actualSeeds = new Map<number, number>();
    for (const game of games) actualSeeds.set(game.seed, (actualSeeds.get(game.seed) ?? 0) + 1);
    if (
        expectedSeeds.size !== actualSeeds.size ||
        [...expectedSeeds].some(([seed, count]) => actualSeeds.get(seed) !== count)
    ) {
        fail(options.cohort, "completed game seeds do not match the expected mirrored tournament panel");
    }
    const gamesBySeed = new Map<number, IIlGameRow[]>();
    for (const game of games) {
        if (game.green === game.red) {
            fail(options.cohort, `seed ${game.seed} uses the same version in both seats; orientation is untestable`);
        }
        if (!(
            (game.green === versions[0] && game.red === versions[1]) ||
            (game.green === versions[1] && game.red === versions[0])
        )) {
            fail(
                options.cohort,
                `seed ${game.seed} versions ${game.green},${game.red} do not match planned pair ${versions.join(",")}`,
            );
        }
        const paired = gamesBySeed.get(game.seed) ?? [];
        paired.push(game);
        gamesBySeed.set(game.seed, paired);
    }
    for (const [seed, pair] of gamesBySeed) {
        if (pair.length !== 2 || pair[0].green !== pair[1].red || pair[0].red !== pair[1].green) {
            fail(options.cohort, `seed ${seed} does not contain one exact reversed version orientation`);
        }
    }
    const completedConfig = configJson ?? fail(options.cohort, "corpus has no completed game configuration");
    return { decisions, games, config: JSON.parse(completedConfig) as IIlSearchConfig };
}
