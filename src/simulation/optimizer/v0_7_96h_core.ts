/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { VALUE_FEATURE_NAMES_V2 } from "../value_features";
import { DEFAULT_V07_VALUE_WEIGHTS, MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11 } from "../v0_7_value_weights";

export const V07_96H_TEMPLATES = [
    { archetype: "mage", template: "mage_frontline" },
    { archetype: "mage", template: "mage_fireline" },
    { archetype: "meleeMage", template: "melee_magic_utility" },
    { archetype: "meleeMage", template: "melee_magic_brawler" },
    { archetype: "aura", template: "aura_support" },
    { archetype: "aura", template: "aura_offense" },
    { archetype: "ranged", template: "ranged_precision" },
    { archetype: "ranged", template: "ranged_control" },
] as const;

export type V0796hTemplate = (typeof V07_96H_TEMPLATES)[number]["template"];
export type V0796hArchetype = (typeof V07_96H_TEMPLATES)[number]["archetype"];
export type V0796hLeafMode = "off" | "material" | "model";

export interface IV0796hValueLeaf {
    b: number;
    w: number[];
}

export interface IV0796hGenome {
    leafMode: V0796hLeafMode;
    leaf?: IV0796hValueLeaf;
    gate: number;
    horizon: number;
    rollouts: number;
    includeMoves: boolean;
    maxMelee: number;
    maxShots: number;
    maxThrows: number;
    label?: string;
}

export interface IV0796hTemplateMetric {
    template: V0796hTemplate;
    archetype: V0796hArchetype;
    games: number;
    decisiveWinRate: number;
    confidence95Low: number;
    standardErrorPp: number;
    scoreRate: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    missingRejectionCounts: number;
}

export interface IV0796hFitness {
    valid: boolean;
    fitness: number;
    minimumTemplateRate: number;
    minimumTemplateLow: number;
    geometricMeanRate: number;
    maximumDrawOrArmageddonRate: number;
    candidateRejections: number;
    missingRejectionCounts: number;
    reason?: string;
}

export interface IV0796hDistribution {
    mean: number[];
    sigma: number[];
    sigmaFloor: number[];
}

export interface IV0796hSeedPanel {
    id: string;
    gamesPerTemplate: number;
    seeds: Record<V0796hTemplate, number>;
}

export interface IV0796hPriorSeedSeries {
    id: string;
    baseSeed: number;
    streams: number;
    streamStride: number;
    gamesPerStream: number;
}

const MODEL_WIDTH = VALUE_FEATURE_NAMES_V2.length;
const SEARCH_DIMENSIONS = 6;
export const V07_96H_GENOME_DIM = 1 + MODEL_WIDTH + SEARCH_DIMENSIONS;
export const V07_96H_BONFERRONI_8_ONE_SIDED_Z = 2.497705474412374;
export const V07_96H_PAIR_SEED_STEP = 0x9e3779b1;

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function canonicalV0796hJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

export function fingerprintV0796h(value: unknown): string {
    return createHash("sha256").update(canonicalV0796hJson(value)).digest("hex");
}

/** SHA-derived uint32 seed. The panel id is immutable and identifies train/selection/final use. */
export function deriveV0796hSeed(runId: string, panelId: string, template: V0796hTemplate): number {
    const digest = createHash("sha256").update(`${runId}|${panelId}|${template}`).digest();
    return digest.readUInt32BE(0);
}

export function buildV0796hSeedPanel(runId: string, panelId: string, gamesPerTemplate: number): IV0796hSeedPanel {
    if (!runId || !panelId) throw new Error("runId and panelId must not be empty");
    if (!Number.isSafeInteger(gamesPerTemplate) || gamesPerTemplate < 2 || gamesPerTemplate % 2 !== 0) {
        throw new RangeError("gamesPerTemplate must be an even integer >= 2");
    }
    return {
        id: panelId,
        gamesPerTemplate,
        seeds: Object.fromEntries(
            V07_96H_TEMPLATES.map(({ template }) => [template, deriveV0796hSeed(runId, panelId, template)]),
        ) as Record<V0796hTemplate, number>,
    };
}

/** Expand compact historical tournament streams and reject malformed or internally colliding denylists. */
export function expandV0796hPriorSeedSeries(series: readonly IV0796hPriorSeedSeries[]): number[] {
    const seen = new Map<number, string>();
    for (const entry of series) {
        if (!entry.id.trim()) throw new Error("Prior seed series id must not be empty");
        if (!Number.isSafeInteger(entry.baseSeed) || entry.baseSeed < 0 || entry.baseSeed > 0xffffffff) {
            throw new RangeError(`${entry.id} baseSeed must be a uint32`);
        }
        if (!Number.isSafeInteger(entry.streams) || entry.streams < 1) {
            throw new RangeError(`${entry.id} streams must be a positive integer`);
        }
        if (!Number.isSafeInteger(entry.streamStride) || entry.streamStride < 0) {
            throw new RangeError(`${entry.id} streamStride must be a nonnegative integer`);
        }
        const lastBase = entry.baseSeed + (entry.streams - 1) * entry.streamStride;
        if (!Number.isSafeInteger(lastBase) || lastBase > 0xffffffff) {
            throw new RangeError(`${entry.id} generated stream base exceeds uint32`);
        }
        if (!Number.isSafeInteger(entry.gamesPerStream) || entry.gamesPerStream < 2 || entry.gamesPerStream % 2) {
            throw new RangeError(`${entry.id} gamesPerStream must be an even integer >= 2`);
        }
        for (let stream = 0; stream < entry.streams; stream += 1) {
            const base = entry.baseSeed + stream * entry.streamStride;
            for (let pair = 0; pair < entry.gamesPerStream / 2; pair += 1) {
                const seed = (base + Math.imul(pair, V07_96H_PAIR_SEED_STEP)) >>> 0;
                const label = `${entry.id}:stream${stream}:pair${pair}`;
                const previous = seen.get(seed);
                if (previous) throw new Error(`Prior seed series collision: ${previous} and ${label}`);
                seen.set(seed, label);
            }
        }
    }
    return [...seen.keys()];
}

/** Prove that every side-swap pair seed is unique across all immutable panels in this run. */
export function assertV0796hPanelsDisjoint(panels: readonly IV0796hSeedPanel[]): void {
    const seen = new Map<number, string>();
    for (const panel of panels) {
        for (const { template } of V07_96H_TEMPLATES) {
            const base = panel.seeds[template];
            for (let pair = 0; pair < panel.gamesPerTemplate / 2; pair += 1) {
                const seed = (base + Math.imul(pair, V07_96H_PAIR_SEED_STEP)) >>> 0;
                const label = `${panel.id}:${template}:${pair}`;
                const prior = seen.get(seed);
                if (prior) throw new Error(`v0.7 96h seed collision: ${prior} and ${label}`);
                seen.set(seed, label);
            }
        }
    }
}

const expandedCommittedLeaf = (): IV0796hValueLeaf => ({
    b: DEFAULT_V07_VALUE_WEIGHTS.b,
    w: [...DEFAULT_V07_VALUE_WEIGHTS.w, ...new Array(MODEL_WIDTH - DEFAULT_V07_VALUE_WEIGHTS.w.length).fill(0)],
});

export function v0796hProbeGenomes(): IV0796hGenome[] {
    const base = {
        includeMoves: false,
        maxMelee: 8,
        maxShots: 6,
        maxThrows: 4,
    };
    const anchors: { label: string; leafMode: V0796hLeafMode; leaf?: IV0796hValueLeaf }[] = [
        { label: "committed-20d", leafMode: "model", leaf: expandedCommittedLeaf() },
        {
            label: "multicohort-60d",
            leafMode: "model",
            leaf: {
                b: MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11.b,
                w: [...MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11.w],
            },
        },
        { label: "material", leafMode: "material" },
    ];
    const genomes: IV0796hGenome[] = [
        {
            ...base,
            label: "v0.7-default-no-search",
            leafMode: "off",
            gate: 0.01,
            horizon: 12,
            rollouts: 3,
        },
    ];
    for (const anchor of anchors) {
        for (const gate of [0, 0.01, 0.025]) {
            for (const horizon of [8, 12, 20]) {
                for (const rollouts of [1, 3]) {
                    genomes.push({ ...base, ...anchor, gate, horizon, rollouts });
                }
            }
        }
    }
    genomes.push({
        ...base,
        label: "committed-20d-move-ablation",
        leafMode: "model",
        leaf: expandedCommittedLeaf(),
        gate: 0.01,
        horizon: 12,
        rollouts: 3,
        includeMoves: true,
    });
    return genomes;
}

function bounded(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

export function normalizeV0796hGenome(genome: IV0796hGenome): IV0796hGenome {
    if (genome.leafMode === "model") {
        if (!genome.leaf || genome.leaf.w.length !== MODEL_WIDTH) {
            throw new RangeError(`model leaf must contain ${MODEL_WIDTH} weights`);
        }
        if (![genome.leaf.b, ...genome.leaf.w].every(Number.isFinite)) {
            throw new TypeError("model leaf coefficients must be finite");
        }
    }
    return {
        ...genome,
        ...(genome.leafMode === "model"
            ? {
                  leaf: {
                      b: bounded(genome.leaf!.b, -12, 12),
                      w: genome.leaf!.w.map((weight) => bounded(weight, -12, 12)),
                  },
              }
            : { leaf: undefined }),
        gate: bounded(genome.gate, 0, 0.05),
        horizon: Math.round(bounded(genome.horizon, 4, 32)),
        rollouts: Math.round(bounded(genome.rollouts, 1, 5)),
        maxMelee: Math.round(bounded(genome.maxMelee, 3, 12)),
        maxShots: Math.round(bounded(genome.maxShots, 2, 10)),
        maxThrows: Math.round(bounded(genome.maxThrows, 1, 8)),
    };
}

export function fingerprintV0796hGenome(genome: IV0796hGenome): string {
    const normalized = normalizeV0796hGenome(genome);
    const behavior = { ...normalized };
    delete behavior.label;
    return fingerprintV0796h(behavior);
}

export function encodeV0796hGenome(genome: IV0796hGenome): number[] {
    const normalized = normalizeV0796hGenome(genome);
    if (normalized.leafMode !== "model" || !normalized.leaf) {
        throw new Error("Only model-leaf genomes can seed CEM");
    }
    return [
        normalized.leaf.b,
        ...normalized.leaf.w,
        normalized.gate,
        normalized.horizon,
        normalized.rollouts,
        normalized.maxMelee,
        normalized.maxShots,
        normalized.maxThrows,
    ];
}

export function decodeV0796hGenome(vector: readonly number[], label?: string): IV0796hGenome {
    if (vector.length !== V07_96H_GENOME_DIM || !vector.every(Number.isFinite)) {
        throw new RangeError(`CEM vector must contain ${V07_96H_GENOME_DIM} finite values`);
    }
    const search = 1 + MODEL_WIDTH;
    return normalizeV0796hGenome({
        leafMode: "model",
        leaf: { b: vector[0], w: vector.slice(1, search) },
        gate: vector[search],
        horizon: vector[search + 1],
        rollouts: vector[search + 2],
        includeMoves: false,
        maxMelee: vector[search + 3],
        maxShots: vector[search + 4],
        maxThrows: vector[search + 5],
        label,
    });
}

export function createV0796hDistribution(genome: IV0796hGenome): IV0796hDistribution {
    const mean = encodeV0796hGenome(genome);
    const search = 1 + MODEL_WIDTH;
    const sigma = mean.map((value, index) => {
        if (index < search) return Math.max(0.03, 0.12 * (Math.abs(value) + 0.25));
        return [0.006, 3, 0.75, 1.5, 1, 1][index - search];
    });
    return { mean, sigma, sigmaFloor: sigma.map((value) => value * 0.15) };
}

function gaussianSource(seed: number): () => number {
    let state = seed >>> 0 || 1;
    const uniform = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    return () => {
        const u = Math.max(uniform(), 1e-12);
        const v = uniform();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
}

export function sampleV0796hPopulation(
    distribution: IV0796hDistribution,
    population: number,
    seed: number,
    generation: number,
): IV0796hGenome[] {
    if (!Number.isSafeInteger(population) || population < 2) throw new RangeError("population must be >= 2");
    if (
        distribution.mean.length !== V07_96H_GENOME_DIM ||
        distribution.sigma.length !== V07_96H_GENOME_DIM ||
        distribution.sigmaFloor.length !== V07_96H_GENOME_DIM
    ) {
        throw new RangeError("CEM distribution dimension mismatch");
    }
    const gaussian = gaussianSource((seed + Math.imul(generation + 1, 0x9e3779b1)) >>> 0);
    const vectors = [distribution.mean.slice()];
    for (let candidate = 1; candidate < population; candidate += 1) {
        vectors.push(distribution.mean.map((value, index) => value + distribution.sigma[index] * gaussian()));
    }
    return vectors.map((vector, index) => decodeV0796hGenome(vector, `cem-g${generation}-c${index}`));
}

export function refitV0796hDistribution(
    distribution: IV0796hDistribution,
    elite: readonly IV0796hGenome[],
    sigmaDecay = 0.88,
): IV0796hDistribution {
    if (!elite.length) throw new RangeError("elite must not be empty");
    const vectors = elite.map(encodeV0796hGenome);
    const mean = distribution.mean.map((_, dimension) => {
        return vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length;
    });
    const sigma = distribution.sigma.map((prior, dimension) => {
        const variance =
            vectors.reduce((sum, vector) => sum + (vector[dimension] - mean[dimension]) ** 2, 0) / vectors.length;
        return Math.max(distribution.sigmaFloor[dimension], Math.sqrt(variance), prior * sigmaDecay);
    });
    return { mean, sigma, sigmaFloor: [...distribution.sigmaFloor] };
}

export function scoreV0796hTrial(metrics: readonly IV0796hTemplateMetric[]): IV0796hFitness {
    if (metrics.length !== V07_96H_TEMPLATES.length) {
        throw new RangeError(`trial must report all ${V07_96H_TEMPLATES.length} fixed templates`);
    }
    const byTemplate = new Map(metrics.map((metric) => [metric.template, metric]));
    for (const { template, archetype } of V07_96H_TEMPLATES) {
        const metric = byTemplate.get(template);
        if (!metric || metric.archetype !== archetype) throw new Error(`missing or misclassified template ${template}`);
    }
    const candidateRejections = metrics.reduce((sum, metric) => sum + metric.candidateRejections, 0);
    const missingRejectionCounts = metrics.reduce((sum, metric) => sum + metric.missingRejectionCounts, 0);
    const minimumTemplateRate = Math.min(...metrics.map((metric) => metric.decisiveWinRate));
    const minimumTemplateLow = Math.min(...metrics.map((metric) => metric.confidence95Low));
    const geometricMeanRate = Math.exp(
        metrics.reduce((sum, metric) => sum + Math.log(Math.max(metric.decisiveWinRate, 1e-9)), 0) / metrics.length,
    );
    const maximumDrawOrArmageddonRate = Math.max(...metrics.map((metric) => metric.drawOrArmageddonRate));
    const valid = candidateRejections === 0 && missingRejectionCounts === 0;
    const drawPenalty = 0.1 * Math.max(0, maximumDrawOrArmageddonRate - 0.01);
    return {
        valid,
        fitness: valid ? minimumTemplateLow - drawPenalty : -1,
        minimumTemplateRate,
        minimumTemplateLow,
        geometricMeanRate,
        maximumDrawOrArmageddonRate,
        candidateRejections,
        missingRejectionCounts,
        ...(!valid
            ? { reason: `${candidateRejections} candidate rejections; ${missingRejectionCounts} missing counts` }
            : {}),
    };
}

export function shouldPromoteV0796h(
    challenger: readonly IV0796hTemplateMetric[],
    incumbent: readonly IV0796hTemplateMetric[],
    minimumGain = 0.005,
    maximumTemplateRegression = 0.01,
): boolean {
    const challengerScore = scoreV0796hTrial(challenger);
    const incumbentScore = scoreV0796hTrial(incumbent);
    if (!challengerScore.valid) return false;
    const incumbentByTemplate = new Map(incumbent.map((metric) => [metric.template, metric]));
    const noTemplateRegression = challenger.every(
        (metric) =>
            metric.decisiveWinRate >=
            incumbentByTemplate.get(metric.template)!.decisiveWinRate - maximumTemplateRegression,
    );
    return (
        noTemplateRegression &&
        challengerScore.minimumTemplateRate >= incumbentScore.minimumTemplateRate + minimumGain &&
        challengerScore.maximumDrawOrArmageddonRate <= 0.01
    );
}

export function assessV0796hTarget(
    metrics: readonly IV0796hTemplateMetric[],
    target = 0.9,
): {
    observed90ByCohort: boolean;
    strictAllTemplates: boolean;
    certifiedAllTemplates: boolean;
    simultaneousLowerBounds: Record<V0796hTemplate, number>;
} {
    scoreV0796hTrial(metrics);
    const byArchetype = new Map<V0796hArchetype, IV0796hTemplateMetric[]>();
    for (const metric of metrics) {
        const entries = byArchetype.get(metric.archetype) ?? [];
        entries.push(metric);
        byArchetype.set(metric.archetype, entries);
    }
    const observed90ByCohort = [...byArchetype.values()].every((entries) => {
        const wins = entries.reduce((sum, entry) => sum + entry.decisiveWinRate * entry.games, 0);
        const games = entries.reduce((sum, entry) => sum + entry.games, 0);
        return wins / games >= target;
    });
    const simultaneousLowerBounds = Object.fromEntries(
        metrics.map((metric) => [
            metric.template,
            Math.max(0, metric.decisiveWinRate - V07_96H_BONFERRONI_8_ONE_SIDED_Z * (metric.standardErrorPp / 100)),
        ]),
    ) as Record<V0796hTemplate, number>;
    return {
        observed90ByCohort,
        strictAllTemplates: metrics.every((metric) => metric.decisiveWinRate >= target),
        certifiedAllTemplates: Object.values(simultaneousLowerBounds).every((low) => low >= target),
        simultaneousLowerBounds,
    };
}
