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
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { format } from "prettier";

export const RANKED_DRAFT_INTERACTION_PRIOR_SELECTION = {
    allyPair: { minimumSupport: 50, minimumAbsoluteConfidencePp: 2 },
    counter: { minimumSupport: 50, minimumAbsoluteConfidencePp: 2 },
    allyTrio: { minimumSupport: 150, minimumConfidencePp: 4 },
} as const;

interface ISourceInteractionRow {
    units: string[];
    pairs: number;
    adjustedCiLowPp: number;
    adjustedCiHighPp: number;
    unit?: string;
    enemyUnit?: string;
}

interface ISourceInteractionSummary {
    schema: string;
    scope: {
        matchupPairs?: number;
        pairs: number;
        games: number;
        cohorts: string[];
        maps: number[];
    };
    allyPairs: ISourceInteractionRow[];
    allyTrios: ISourceInteractionRow[];
    counters: ISourceInteractionRow[];
}

interface ISourceSummary {
    generatedAt: string;
    interactions: ISourceInteractionSummary;
}

interface IPriorInteractionRow {
    units: string[];
    support: number;
    conservativeLiftPp: number;
}

interface IPriorCounterRow {
    unit: string;
    enemyUnit: string;
    support: number;
    conservativeLiftPp: number;
}

export interface IRankedDraftInteractionPriorArtifact {
    schemaVersion: 1;
    id: string;
    source: {
        sourceSha256: string;
        sourceRelativePath: string;
        generatedAt: string;
        matchupPairs: number;
        games: number;
        cohorts: string[];
        maps: number[];
    };
    selection: typeof RANKED_DRAFT_INTERACTION_PRIOR_SELECTION;
    allyPairs: IPriorInteractionRow[];
    counters: IPriorCounterRow[];
    allyTrios: IPriorInteractionRow[];
}

const assertFiniteNumber = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
    }
    return value;
};

const assertStringArray = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
        throw new TypeError(`${label} must be a non-empty string array`);
    }
    return [...value];
};

const assertNumberArray = (value: unknown, label: string): number[] => {
    if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) {
        throw new TypeError(`${label} must be an integer array`);
    }
    return [...value];
};

const requireRows = (value: unknown, label: string): ISourceInteractionRow[] => {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") throw new TypeError(`${label}[${index}] must be an object`);
        const row = entry as Record<string, unknown>;
        const units = assertStringArray(row.units, `${label}[${index}].units`);
        const pairs = assertFiniteNumber(row.pairs, `${label}[${index}].pairs`);
        const adjustedCiLowPp = assertFiniteNumber(row.adjustedCiLowPp, `${label}[${index}].adjustedCiLowPp`);
        const adjustedCiHighPp = assertFiniteNumber(row.adjustedCiHighPp, `${label}[${index}].adjustedCiHighPp`);
        if (!Number.isInteger(pairs) || pairs < 1) throw new RangeError(`${label}[${index}].pairs must be positive`);
        const unit = row.unit;
        const enemyUnit = row.enemyUnit;
        if (unit !== undefined && (typeof unit !== "string" || !unit.trim())) {
            throw new TypeError(`${label}[${index}].unit must be a non-empty string`);
        }
        if (enemyUnit !== undefined && (typeof enemyUnit !== "string" || !enemyUnit.trim())) {
            throw new TypeError(`${label}[${index}].enemyUnit must be a non-empty string`);
        }
        return {
            units,
            pairs,
            adjustedCiLowPp,
            adjustedCiHighPp,
            ...(typeof unit === "string" ? { unit } : {}),
            ...(typeof enemyUnit === "string" ? { enemyUnit } : {}),
        };
    });
};

const sourceSummary = (value: unknown): ISourceSummary => {
    if (!value || typeof value !== "object") throw new TypeError("AI-meta summary must be an object");
    const summary = value as Record<string, unknown>;
    if (typeof summary.generatedAt !== "string" || !summary.generatedAt.trim()) {
        throw new TypeError("AI-meta summary generatedAt must be a non-empty string");
    }
    if (!summary.interactions || typeof summary.interactions !== "object") {
        throw new TypeError("AI-meta summary omitted interactions");
    }
    const interactions = summary.interactions as Record<string, unknown>;
    if (interactions.schema !== "cross-fitted-ridge-unit-interactions-v1") {
        throw new TypeError("AI-meta summary has an unsupported interaction schema");
    }
    if (!interactions.scope || typeof interactions.scope !== "object") {
        throw new TypeError("AI-meta interaction summary omitted scope");
    }
    const scope = interactions.scope as Record<string, unknown>;
    const pairs = assertFiniteNumber(scope.pairs, "AI-meta interaction scope pairs");
    const games = assertFiniteNumber(scope.games, "AI-meta interaction scope games");
    if (!Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(games) || games < 1) {
        throw new RangeError("AI-meta interaction scope counts must be positive integers");
    }
    return {
        generatedAt: summary.generatedAt,
        interactions: {
            schema: interactions.schema,
            scope: {
                pairs,
                games,
                cohorts: assertStringArray(scope.cohorts, "AI-meta interaction scope cohorts"),
                maps: assertNumberArray(scope.maps, "AI-meta interaction scope maps"),
            },
            allyPairs: requireRows(interactions.allyPairs, "AI-meta allyPairs"),
            allyTrios: requireRows(interactions.allyTrios, "AI-meta allyTrios"),
            counters: requireRows(interactions.counters, "AI-meta counters"),
        },
    };
};

const conservativeLiftPp = (row: ISourceInteractionRow, threshold: number): number | undefined => {
    if (row.adjustedCiLowPp >= threshold) return row.adjustedCiLowPp;
    if (row.adjustedCiHighPp <= -threshold) return row.adjustedCiHighPp;
    return undefined;
};

const compareUnits = (left: readonly string[], right: readonly string[]): number =>
    left.join("|").localeCompare(right.join("|"));

export function buildRankedDraftInteractionPrior(
    source: unknown,
    sourceMetadata: { sourceSha256: string; sourceRelativePath: string },
    id: string = "ai-meta-a19-ranked-draft-10008-v1",
): IRankedDraftInteractionPriorArtifact {
    if (!/^[0-9a-f]{64}$/.test(sourceMetadata.sourceSha256)) {
        throw new TypeError("sourceSha256 must be a lowercase SHA-256 digest");
    }
    if (!sourceMetadata.sourceRelativePath.trim()) throw new TypeError("sourceRelativePath must not be empty");
    if (!id.trim()) throw new TypeError("interaction prior id must not be empty");

    const summary = sourceSummary(source);
    const { interactions } = summary;
    if (interactions.scope.cohorts.length !== 1 || interactions.scope.cohorts[0] !== "ranked-draft") {
        throw new TypeError("Ranked draft interaction prior input must contain only the ranked-draft cohort");
    }
    const allyPairs = interactions.allyPairs
        .flatMap((row): IPriorInteractionRow[] => {
            const lift = conservativeLiftPp(
                row,
                RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.allyPair.minimumAbsoluteConfidencePp,
            );
            return row.pairs >= RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.allyPair.minimumSupport && lift !== undefined
                ? [{ units: [...row.units], support: row.pairs, conservativeLiftPp: lift }]
                : [];
        })
        .sort((left, right) => compareUnits(left.units, right.units));
    const counters = interactions.counters
        .flatMap((row): IPriorCounterRow[] => {
            const lift = conservativeLiftPp(
                row,
                RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.counter.minimumAbsoluteConfidencePp,
            );
            if (
                row.pairs < RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.counter.minimumSupport ||
                lift === undefined ||
                !row.unit ||
                !row.enemyUnit
            ) {
                return [];
            }
            return [{ unit: row.unit, enemyUnit: row.enemyUnit, support: row.pairs, conservativeLiftPp: lift }];
        })
        .sort((left, right) => `${left.unit}>${left.enemyUnit}`.localeCompare(`${right.unit}>${right.enemyUnit}`));
    const allyTrios = interactions.allyTrios
        .flatMap((row): IPriorInteractionRow[] =>
            row.pairs >= RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.allyTrio.minimumSupport &&
            row.adjustedCiLowPp >= RANKED_DRAFT_INTERACTION_PRIOR_SELECTION.allyTrio.minimumConfidencePp
                ? [{ units: [...row.units], support: row.pairs, conservativeLiftPp: row.adjustedCiLowPp }]
                : [],
        )
        .sort((left, right) => compareUnits(left.units, right.units));

    return {
        schemaVersion: 1,
        id,
        source: {
            sourceSha256: sourceMetadata.sourceSha256,
            sourceRelativePath: sourceMetadata.sourceRelativePath,
            generatedAt: summary.generatedAt,
            matchupPairs: interactions.scope.pairs,
            games: interactions.scope.games,
            cohorts: [...interactions.scope.cohorts],
            maps: [...interactions.scope.maps],
        },
        selection: RANKED_DRAFT_INTERACTION_PRIOR_SELECTION,
        allyPairs,
        counters,
        allyTrios,
    };
}

async function cliMain(): Promise<void> {
    const [inputPath, outputPath, id = "ai-meta-a19-ranked-draft-10008-v1", sourcePath = inputPath] =
        process.argv.slice(2);
    if (!inputPath || !outputPath || process.argv.length > 6) {
        throw new Error(
            "Usage: bun src/simulation/build_ranked_draft_interaction_prior.ts <ranked-interactions.json> <output.json> [id] [source.pairs.jsonl.gz]",
        );
    }
    const resolvedInput = resolve(inputPath);
    const raw = readFileSync(resolvedInput);
    const resolvedSource = resolve(sourcePath);
    const sourceRaw = resolvedSource === resolvedInput ? raw : readFileSync(resolvedSource);
    const artifact = buildRankedDraftInteractionPrior(
        JSON.parse(raw.toString()) as unknown,
        {
            sourceSha256: createHash("sha256").update(sourceRaw).digest("hex"),
            sourceRelativePath: relative(process.cwd(), resolvedSource),
        },
        id,
    );
    writeFileSync(
        resolve(outputPath),
        await format(JSON.stringify(artifact, null, 4), { parser: "json", printWidth: 120, tabWidth: 4 }),
    );
}

if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    });
}
