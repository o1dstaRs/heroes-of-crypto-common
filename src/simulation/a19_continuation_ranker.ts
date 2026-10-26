/** Offline actual-controller outcome ranker. No production registration or environment hooks. */
import type { IActualContinuationCandidate } from "./a19_actual_continuation";
import { makeRng } from "./army";
import { CONTINUATION_FEATURE_NAMES } from "./measure_search_continuation";
import { fitStableRidge } from "./optimizer/ridge_regression";

export const ACTUAL_RANKER_FEATURES: readonly string[] = Object.freeze([
    "returnedR2Score",
    ...["wait", "defend", "move", "melee", "shot", "area_throw", "spell"].map((kind) => `action_family_${kind}`),
    "candidate_moraleDelta",
    "candidate_luckDelta",
    "candidate_spendsRangeShot",
    "candidate_spendsSpellCharge",
    "candidate_burnsResurrectionCharge",
    "candidate_expectedKill",
    "action_movePathLengthNorm",
    "action_moveHasLava",
    "action_moveHasWater",
    "rich_targetLevel",
    "rich_targetHpFraction",
    "rich_targetFirepower",
    "rich_targetIsRanged",
    "rich_targetCanCast",
    "rich_targetNotActed",
    "rich_targetDistance",
    "rich_targetScreened",
    "rich_trajectoryIntercepted",
    "rich_rangeDivisor",
    "rich_distanceAfterMove",
    "rich_movesCloser",
    "rich_movesBehindFrontline",
    "rich_attackFromSafe",
    "rich_spellChargeFraction",
    "rich_expectedCounterDamage",
    "rich_selfExposure",
    "damageRelativeToCatalog",
    "signedLogDamage",
    "targetIsAlly",
    "damageFractionOfTargetHp",
]);
const indices = ACTUAL_RANKER_FEATURES.slice(1).map((name) => {
    const index = CONTINUATION_FEATURE_NAMES.indexOf(name);
    if (index < 0) throw new Error(`Unknown actual ranker feature: ${name}`);
    return index;
});

export interface IActualRankerFamily {
    family: string;
    candidates: readonly IActualContinuationCandidate[];
    /** Aligned, matched post-root combat worlds for every candidate; terminal scores only. */
    returns: readonly (readonly number[])[];
}
export interface IActualRankerModel {
    schema: "hoc.actual-r2-linear-ranker.v1";
    featureNames: readonly string[];
    familyIds: string[];
    scales: number[];
    weights: number[][];
    l2: number;
    bootstrapSeed: number;
    minimumMean: number;
    minimumLowerDecile: number;
}

function vector(candidate: IActualContinuationCandidate): number[] {
    if (
        !Number.isFinite(candidate.returnedR2Score) ||
        candidate.features?.length !== CONTINUATION_FEATURE_NAMES.length ||
        candidate.features.some((value) => !Number.isFinite(value))
    )
        throw new Error("Actual ranker requires complete finite public features and a retained score");
    return [candidate.returnedR2Score!, ...indices.map((index) => candidate.features![index])];
}
function delta(candidate: IActualContinuationCandidate, baseline: IActualContinuationCandidate): number[] {
    const left = vector(candidate),
        right = vector(baseline);
    return left.map((value, index) => value - right[index]);
}
const dot = (left: readonly number[], right: readonly number[]): number =>
    left.reduce((sum, value, index) => sum + value * right[index], 0);

export function fitActualContinuationRanker(
    families: readonly IActualRankerFamily[],
    options: { l2: number; bootstrapSeed: number; models: number; minimumMean: number; minimumLowerDecile: number },
): IActualRankerModel {
    if (!families.length || new Set(families.map((family) => family.family)).size !== families.length)
        throw new Error("Actual ranker requires unique independent families");
    if (
        !Number.isFinite(options.l2) ||
        options.l2 <= 0 ||
        !Number.isSafeInteger(options.models) ||
        options.models < 2 ||
        !Number.isSafeInteger(options.bootstrapSeed) ||
        options.bootstrapSeed < 0 ||
        options.bootstrapSeed > 0xffffffff ||
        !Number.isFinite(options.minimumMean) ||
        options.minimumMean < 0 ||
        !Number.isFinite(options.minimumLowerDecile) ||
        options.minimumLowerDecile < 0
    )
        throw new Error("Invalid actual ranker fit settings");
    const ordered = [...families].sort((a, b) => a.family.localeCompare(b.family));
    const groups = ordered.map((family) => {
        if (
            family.candidates.length < 2 ||
            family.returns.length !== family.candidates.length ||
            new Set(family.candidates.map((candidate) => candidate.signature)).size !== family.candidates.length
        )
            throw new Error("Invalid actual ranker candidate alignment");
        const count = family.returns[0].length;
        if (
            !count ||
            family.returns.some(
                (values) => values.length !== count || values.some((value) => ![0, 0.5, 1].includes(value)),
            )
        )
            throw new Error("Actual ranker requires matched terminal return vectors");
        const baseline = family.candidates[0],
            baselineReturns = family.returns[0];
        return family.candidates.slice(1).map((candidate, index) => ({
            x: delta(candidate, baseline),
            y: family.returns[index + 1].reduce((sum, value, world) => sum + value - baselineReturns[world], 0) / count,
        }));
    });
    const scales = ACTUAL_RANKER_FEATURES.map((_, column) =>
        Math.max(
            1e-8,
            Math.sqrt(
                groups.reduce(
                    (sum, rows) => sum + rows.reduce((inner, row) => inner + row.x[column] ** 2, 0) / rows.length,
                    0,
                ) / groups.length,
            ),
        ),
    );
    const normalized = groups.map((rows) =>
        rows.map((row) => ({
            x: row.x.map((value, index) => Math.max(-4, Math.min(4, value / scales[index]))),
            y: row.y,
        })),
    );
    const rng = makeRng(options.bootstrapSeed);
    const weights = Array.from({ length: options.models }, () => {
        const sampled = Array.from({ length: groups.length }, () => normalized[Math.floor(rng() * groups.length)]);
        const rowCount = sampled.reduce((sum, rows) => sum + rows.length * 2, 0);
        // Antisymmetric pairs force zero intercept. Each sampled army family has equal total weight.
        const rows = sampled.flatMap((group) => {
            const scale = Math.sqrt(rowCount / (2 * sampled.length * group.length));
            return group.flatMap((row) =>
                [1, -1].map((sign) => ({ x: row.x.map((value) => sign * scale * value), y: sign * scale * row.y })),
            );
        });
        const fitted = fitStableRidge(
            rows,
            scales.length,
            (row) => row.x,
            (row) => row.y,
            1000,
            options.l2,
        );
        if (Math.abs(fitted.b) > 1e-9) throw new Error("Actual ranker antisymmetric intercept drift");
        return fitted.w;
    });
    return {
        schema: "hoc.actual-r2-linear-ranker.v1",
        featureNames: ACTUAL_RANKER_FEATURES,
        familyIds: ordered.map((family) => family.family),
        scales,
        weights,
        l2: options.l2,
        bootstrapSeed: options.bootstrapSeed,
        minimumMean: options.minimumMean,
        minimumLowerDecile: options.minimumLowerDecile,
    };
}

export function selectActualContinuationRanker(
    model: IActualRankerModel,
    candidates: readonly IActualContinuationCandidate[],
): { signature: string | undefined; mean: number; lowerDecile: number } {
    if (
        model.schema !== "hoc.actual-r2-linear-ranker.v1" ||
        JSON.stringify(model.featureNames) !== JSON.stringify(ACTUAL_RANKER_FEATURES) ||
        model.scales.length !== ACTUAL_RANKER_FEATURES.length ||
        model.scales.some((value) => !Number.isFinite(value) || value <= 0) ||
        model.weights.length < 2 ||
        model.weights.some(
            (row) => row.length !== model.scales.length || row.some((value) => !Number.isFinite(value)),
        ) ||
        !Number.isFinite(model.minimumMean) ||
        model.minimumMean < 0 ||
        !Number.isFinite(model.minimumLowerDecile) ||
        model.minimumLowerDecile < 0
    )
        throw new Error("Invalid actual ranker model");
    let selected: { signature: string | undefined; mean: number; lowerDecile: number } = {
        signature: undefined,
        mean: 0,
        lowerDecile: 0,
    };
    if (candidates.length < 2 || !Number.isFinite(candidates[0].returnedR2Score)) return selected;
    for (const candidate of candidates.slice(1)) {
        if (!Number.isFinite(candidate.returnedR2Score)) continue;
        const x = delta(candidate, candidates[0]).map((value, index) =>
            Math.max(-4, Math.min(4, value / model.scales[index])),
        );
        const estimates = model.weights.map((weights) => dot(weights, x)).sort((a, b) => a - b);
        const mean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
        const lowerDecile = estimates[Math.floor((estimates.length - 1) * 0.1)];
        if (mean <= model.minimumMean || lowerDecile <= model.minimumLowerDecile) continue;
        if (mean > selected.mean || (mean === selected.mean && candidate.signature < (selected.signature ?? "")))
            selected = { signature: candidate.signature, mean, lowerDecile };
    }
    return selected;
}
