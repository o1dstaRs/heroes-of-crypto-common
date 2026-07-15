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

/**
 * IMITATION-LEARNING DATASET (v0.7 roadmap B3/NEURO groundwork; see docs/imitation_pipeline.md).
 *
 * SEARCH_IL_DATASET=<jsonl path> (V07_SEARCH=1 search mode only, default OFF) makes the SearchDriver dump
 * ONE row per SEARCHED decision (>= 2 candidates after class filtering): the state feature vectors already
 * used elsewhere in the pipeline (the 41-dim wait-scorer vector + the 60-dim deployed V2 value basis), the
 * full scored candidate set (kind, action class, semantic signature, the F4 enumeration-time candidate
 * features, and the search's mean rollout leaf value), the index the search finally CHOSE (0 = the
 * incumbent v0.7 policy decision was kept) and the chosen action list verbatim. Downstream:
 *   optimizer/extract_il.mjs  — dump -> fit-ready training rows + dataset stats
 *   optimizer/fit_il.mjs      — conditional-logit imitator of the search's choice (report only; NOT wired
 *                               into any strategy — distillation shipping is peer-coordinated)
 * Rows are buffered per game and appended once in onMatchEnd (same atomicity story as SEARCH_AUDIT).
 */

export const IL_ROW_TYPE = "ild" as const;
export const IL_DATASET_VERSION = 1 as const;

/** Serialization order of the F4 enumeration-time candidate features (ai/candidates.ICandidateFeatures). */
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

/** ICandidateFeatures -> the fixed IL_CANDIDATE_FEATURE_NAMES order (pure; no rounding). */
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

/**
 * SEMANTIC identity of an action list — ai/candidates.ts's dedupe signature MINUS the select_attack_type
 * token. The incumbent decision often carries a select_attack_type prefix that an effect-identical
 * enumerated candidate lacks; for imitation credit those must compare EQUAL, so a predicted candidate that
 * plays the exact same turn as the search's choice is never scored as a miss on a serialization artifact.
 */
export function ilActionSignature(actions: readonly GameAction[]): string {
    const cell = (c?: XY): string => (c ? `${c.x},${c.y}` : "-");
    const tokens: string[] = [];
    for (const a of actions) {
        switch (a.type) {
            case "select_attack_type":
                break; // presentation-only prefix — no board effect of its own
            case "move_unit":
                tokens.push(`mv:${cell(a.path[a.path.length - 1])}`);
                break;
            case "melee_attack":
                tokens.push(`ml:${a.targetId}@${cell(a.attackFrom)}`);
                break;
            case "range_attack":
                tokens.push(`rg:${a.targetId}@${cell(a.aimCell)}/${a.aimSide ?? "-"}`);
                break;
            case "area_throw_attack":
                tokens.push(`at:${cell(a.targetCell)}`);
                break;
            case "cast_spell":
                tokens.push(`cs:${a.spellName}>${a.targetId ?? "-"}@${cell(a.targetCell)}`);
                break;
            default:
                tokens.push(a.type);
                break;
        }
    }
    return tokens.join("|");
}

/** One dumped candidate: kind, action class, semantic signature, features, mean rollout leaf (null = illegal). */
export interface IIlCandidateRow {
    kind: string;
    ck: string;
    sig: string;
    cf: number[];
    m: number | null;
}

export interface IIlRow {
    t: typeof IL_ROW_TYPE;
    v: typeof IL_DATASET_VERSION;
    seed: number;
    green: string;
    red: string;
    side: "green" | "red";
    lap: number;
    unit: string;
    /** Action class of the incumbent (candidate 0). */
    k: string;
    /** 1 when the search overrode the incumbent. */
    ov: 0 | 1;
    /** Index of the search's final choice within `cands` (0 = incumbent kept). */
    chosen: number;
    /** Enumerated candidates after class filtering (before any shortlist). */
    nc: number;
    /** The chosen candidate's action list, verbatim. */
    act: GameAction[];
    /** 41-dim wait-scorer state vector (ai/versions/wait_scorer.WAIT_FEATURE_NAMES). */
    wf: number[];
    /** 60-dim deployed V2 value basis (simulation/value_features.VALUE_FEATURE_NAMES_V2). */
    vf: number[];
    cands: IIlCandidateRow[];
    cfg: {
        gate: number;
        horizon: number;
        rollouts: number;
        leaf: string;
        shortlist: number | null;
        includeMoves: 0 | 1;
        oppModel: string | null;
    };
}

const fail = (context: string, message: string): never => {
    throw new Error(`${context}: ${message}`);
};

/** Strict parse of one dumped IL row (extract_il.mjs input validation). */
export function parseIlRow(value: unknown, wfWidth: number, vfWidth: number, context = "IL row"): IIlRow {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(context, "expected an object row");
    }
    const row = value as Record<string, unknown>;
    if (row.t !== IL_ROW_TYPE || row.v !== IL_DATASET_VERSION) {
        fail(context, `expected ${IL_ROW_TYPE} v${IL_DATASET_VERSION}`);
    }
    const str = (key: string): string => {
        const v = row[key];
        if (typeof v !== "string" || !v.trim()) {
            fail(context, `${key}: expected a non-empty string`);
        }
        return v as string;
    };
    const num = (v: unknown, label: string): number => {
        if (typeof v !== "number" || !Number.isFinite(v)) {
            fail(context, `${label}: expected a finite number`);
        }
        return v as number;
    };
    const features = (v: unknown, width: number, label: string): number[] => {
        if (!Array.isArray(v) || v.length !== width) {
            fail(context, `${label}: feature width ${Array.isArray(v) ? v.length : "non-array"} != ${width}`);
        }
        return (v as unknown[]).map((x, i) => num(x, `${label}[${i}]`));
    };
    if (row.side !== "green" && row.side !== "red") {
        fail(context, "side: expected green or red");
    }
    if (row.ov !== 0 && row.ov !== 1) {
        fail(context, "ov: expected 0 or 1");
    }
    if (!Array.isArray(row.cands) || row.cands.length < 2) {
        fail(context, "cands: expected >= 2 candidates");
    }
    const cands = (row.cands as unknown[]).map((c, i): IIlCandidateRow => {
        if (!c || typeof c !== "object") {
            fail(context, `cands[${i}]: expected an object`);
        }
        const cand = c as Record<string, unknown>;
        if (typeof cand.kind !== "string" || typeof cand.ck !== "string" || typeof cand.sig !== "string") {
            fail(context, `cands[${i}]: kind/ck/sig must be strings`);
        }
        return {
            kind: cand.kind as string,
            ck: cand.ck as string,
            sig: cand.sig as string,
            cf: features(cand.cf, IL_CANDIDATE_FEATURE_NAMES.length, `cands[${i}].cf`),
            m: cand.m === null ? null : num(cand.m, `cands[${i}].m`),
        };
    });
    if (cands[0].kind !== "incumbent") {
        fail(context, "cands[0] must be the incumbent");
    }
    const chosen = num(row.chosen, "chosen");
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= cands.length) {
        fail(context, `chosen: expected an index into cands (0..${cands.length - 1})`);
    }
    if ((row.ov === 1) !== (chosen !== 0)) {
        fail(context, "ov must be 1 exactly when chosen != 0");
    }
    const lap = num(row.lap, "lap");
    if (!Number.isInteger(lap) || lap < 0) {
        fail(context, "lap: expected a non-negative integer");
    }
    const nc = num(row.nc, "nc");
    if (!Number.isInteger(nc) || nc < cands.length) {
        fail(context, "nc: expected an integer >= cands.length");
    }
    if (!Array.isArray(row.act) || row.act.length === 0) {
        fail(context, "act: expected the chosen action list");
    }
    const cfg = row.cfg as Record<string, unknown>;
    if (!cfg || typeof cfg !== "object") {
        fail(context, "cfg: expected the search configuration");
    }
    return {
        t: IL_ROW_TYPE,
        v: IL_DATASET_VERSION,
        seed: num(row.seed, "seed"),
        green: str("green"),
        red: str("red"),
        side: row.side as "green" | "red",
        lap,
        unit: str("unit"),
        k: str("k"),
        ov: row.ov as 0 | 1,
        chosen,
        nc,
        act: row.act as GameAction[],
        wf: features(row.wf, wfWidth, "wf"),
        vf: features(row.vf, vfWidth, "vf"),
        cands,
        cfg: {
            gate: num(cfg.gate, "cfg.gate"),
            horizon: num(cfg.horizon, "cfg.horizon"),
            rollouts: num(cfg.rollouts, "cfg.rollouts"),
            leaf: typeof cfg.leaf === "string" ? cfg.leaf : fail(context, "cfg.leaf: expected a string"),
            shortlist: cfg.shortlist === null ? null : num(cfg.shortlist, "cfg.shortlist"),
            includeMoves: cfg.includeMoves === 1 ? 1 : 0,
            oppModel:
                cfg.oppModel === null || cfg.oppModel === undefined
                    ? null
                    : typeof cfg.oppModel === "string"
                      ? cfg.oppModel
                      : fail(context, "cfg.oppModel: expected a string or null"),
        },
    };
}
