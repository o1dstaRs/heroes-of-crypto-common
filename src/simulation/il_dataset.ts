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

import type { ICandidateFeatures } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { XY } from "../utils/math";

export const IL_ROW_TYPE = "ild" as const;
export const IL_GAME_ROW_TYPE = "ild_game" as const;
export const IL_DATASET_VERSION = 2 as const;

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

/** Canonical action identity used by the IL target and its semantic-group evaluator. */
export function ilActionSignature(actions: readonly GameAction[]): string {
    const cell = (c?: XY): string => (c ? `${c.x},${c.y}` : "-");
    return actions
        .map((action) => {
            switch (action.type) {
                case "select_attack_type":
                    // Attack selection mutates the unit and can emit an event; it is not presentation metadata.
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
    cf: number[];
    m: number | null;
}

export interface IIlSearchConfig {
    gate: number;
    horizon: number;
    rollouts: number;
    leaf: "learned_v2" | "learned" | "material";
    shortlist: number | null;
    includeMoves: 0 | 1;
    oppModel: string | null;
}

export interface IIlRow {
    t: typeof IL_ROW_TYPE;
    v: typeof IL_DATASET_VERSION;
    runFingerprint: string;
    cohort: string;
    decision: number;
    seed: number;
    green: string;
    red: string;
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
    cfg: IIlSearchConfig;
}

export interface IIlGameRow {
    t: typeof IL_GAME_ROW_TYPE;
    v: typeof IL_DATASET_VERSION;
    runFingerprint: string;
    cohort: string;
    seed: number;
    green: string;
    red: string;
    winner: "green" | "red" | "draw";
    endReason: "elimination" | "turn_cap" | "stuck";
    rows: number;
    decisions: number;
    searched: number;
    singleCandidate: number;
    deadlineFallbacks: number;
    circuitOpened: 0 | 1;
    circuitSkipped: number;
    cfg: IIlSearchConfig;
}

type JsonRecord = Record<string, unknown>;

const fail = (context: string, message: string): never => {
    throw new Error(`${context}: ${message}`);
};
const record = (value: unknown, context: string): JsonRecord => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(context, "expected an object row");
    return value as JsonRecord;
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
const canonicalSeed = (value: unknown, context: string): number => {
    const parsed = finite(value, context);
    if (!Number.isSafeInteger(parsed) || parsed < INT32_MIN || parsed > UINT32_MAX) {
        fail(context, "expected a signed int32 or uint32 integer");
    }
    return parsed >>> 0;
};
const features = (value: unknown, width: number, context: string): number[] => {
    const values: unknown[] = Array.isArray(value) ? value : fail(context, `feature width non-array != ${width}`);
    if (values.length !== width) {
        fail(context, `feature width ${values.length} != ${width}`);
    }
    return values.map((feature, index) => finite(feature, `${context}[${index}]`));
};

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

function parseConfig(value: unknown, context: string): IIlSearchConfig {
    const cfg = record(value, context);
    const gate = finite(cfg.gate, `${context}.gate`);
    if (gate < 0) fail(`${context}.gate`, "expected a non-negative number");
    const horizon = integer(cfg.horizon, `${context}.horizon`, 1);
    const rollouts = integer(cfg.rollouts, `${context}.rollouts`, 1);
    const parsedLeaf = leaf(cfg.leaf, `${context}.leaf`);
    const shortlist = cfg.shortlist === null ? null : integer(cfg.shortlist, `${context}.shortlist`, 2);
    const oppModel = cfg.oppModel === null ? null : string(cfg.oppModel, `${context}.oppModel`);
    return {
        gate,
        horizon,
        rollouts,
        leaf: parsedLeaf,
        shortlist,
        includeMoves: binary(cfg.includeMoves, `${context}.includeMoves`),
        oppModel,
    };
}

/** Strict parse of one v2 IL decision row. */
export function parseIlRow(
    value: unknown,
    wfWidth: number,
    vfWidth: number,
    expectedFingerprint: string,
    context = "IL row",
): IIlRow {
    const row = record(value, context);
    if (row.t !== IL_ROW_TYPE || row.v !== IL_DATASET_VERSION) {
        fail(context, `expected ${IL_ROW_TYPE} v${IL_DATASET_VERSION}`);
    }
    const runFingerprint = requireIlRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requireIlRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) fail(context, `run fingerprint ${runFingerprint} does not match ${expected}`);
    const parsedSide = side(row.side, `${context}.side`);
    const ov = binary(row.ov, `${context}.ov`);
    const candidateRows: unknown[] = Array.isArray(row.cands)
        ? row.cands
        : fail(`${context}.cands`, "expected >= 2 candidates");
    if (candidateRows.length < 2) fail(`${context}.cands`, "expected >= 2 candidates");
    const cands = candidateRows.map((value, index): IIlCandidateRow => {
        const candidate = record(value, `${context}.cands[${index}]`);
        const mean = candidate.m === null ? null : finite(candidate.m, `${context}.cands[${index}].m`);
        return {
            kind: string(candidate.kind, `${context}.cands[${index}].kind`),
            ck: string(candidate.ck, `${context}.cands[${index}].ck`),
            sig: string(candidate.sig, `${context}.cands[${index}].sig`),
            cf: features(candidate.cf, IL_CANDIDATE_FEATURE_NAMES.length, `${context}.cands[${index}].cf`),
            m: mean,
        };
    });
    if (cands[0].kind !== "incumbent") fail(context, "cands[0] must be the incumbent");
    const chosen = integer(row.chosen, `${context}.chosen`);
    if (chosen >= cands.length) fail(`${context}.chosen`, `expected an index into cands (0..${cands.length - 1})`);
    if ((ov === 1) !== (chosen !== 0)) fail(context, "ov must be 1 exactly when chosen != 0");
    if (cands[chosen].m === null) fail(context, "chosen candidate must have a finite rollout mean");
    const incumbentKind = string(row.k, `${context}.k`);
    if (incumbentKind !== cands[0].ck) fail(context, "k must equal cands[0].ck");
    if (!Array.isArray(row.act) || row.act.length === 0) fail(`${context}.act`, "expected the chosen action list");
    const chosenSignature = (() => {
        try {
            return ilActionSignature(row.act as GameAction[]);
        } catch {
            return fail(`${context}.act`, "cannot derive the chosen action signature");
        }
    })();
    if (chosenSignature !== cands[chosen].sig) fail(context, "act signature must equal the chosen candidate signature");
    const cfg = parseConfig(row.cfg, `${context}.cfg`);
    const nc = integer(row.nc, `${context}.nc`, cands.length);
    if (cfg.shortlist === null && nc !== cands.length) fail(context, "nc must equal cands.length without a shortlist");
    if (cfg.shortlist !== null && cands.length > cfg.shortlist) fail(context, "cands exceeds the configured shortlist");
    return {
        t: IL_ROW_TYPE,
        v: IL_DATASET_VERSION,
        runFingerprint,
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
        act: row.act as GameAction[],
        wf: features(row.wf, wfWidth, `${context}.wf`),
        vf: features(row.vf, vfWidth, `${context}.vf`),
        cands,
        cfg,
    };
}

export function parseIlGameRow(value: unknown, expectedFingerprint: string, context = "IL game row"): IIlGameRow {
    const row = record(value, context);
    if (row.t !== IL_GAME_ROW_TYPE || row.v !== IL_DATASET_VERSION) {
        fail(context, `expected ${IL_GAME_ROW_TYPE} v${IL_DATASET_VERSION}`);
    }
    const runFingerprint = requireIlRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requireIlRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) fail(context, `run fingerprint ${runFingerprint} does not match ${expected}`);
    const parsedWinner = winner(row.winner, `${context}.winner`);
    const parsedEndReason = endReason(row.endReason, `${context}.endReason`);
    return {
        t: IL_GAME_ROW_TYPE,
        v: IL_DATASET_VERSION,
        runFingerprint,
        cohort: string(row.cohort, `${context}.cohort`),
        seed: canonicalSeed(row.seed, `${context}.seed`),
        green: string(row.green, `${context}.green`),
        red: string(row.red, `${context}.red`),
        winner: parsedWinner,
        endReason: parsedEndReason,
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

/** Validate complete per-game chunks and the mirrored tournament seed multiset. */
export function validateIlCorpus(
    lines: readonly string[],
    options: {
        wfWidth: number;
        vfWidth: number;
        runFingerprint: string;
        cohort: string;
        expectedGames: number;
        baseSeed: number;
    },
): IValidatedIlCorpus {
    const expectedFingerprint = requireIlRunFingerprint(options.runFingerprint);
    const expectedGames = integer(options.expectedGames, "expectedGames", 1);
    const baseSeed = canonicalSeed(options.baseSeed, "baseSeed");
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
            const row = parseIlRow(
                raw,
                options.wfWidth,
                options.vfWidth,
                expectedFingerprint,
                `${options.cohort}:${index + 1}`,
            );
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
    const completedConfig = configJson ?? fail(options.cohort, "corpus has no completed game configuration");
    return { decisions, games, config: JSON.parse(completedConfig) as IIlSearchConfig };
}
