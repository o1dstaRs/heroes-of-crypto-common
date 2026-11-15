import { readFileSync, writeFileSync } from "node:fs";
import {
    EMPOWER_CONTEXT_FEATURES,
    EMPOWER_CONTEXT_SCHEMA,
    predictContextualEmpower,
    validateContextualEmpowerModel,
    type EmpowerEffectTree,
    type IContextualEmpowerModel,
} from "../ai/setup/empower_context";
import { protectedAxisEmpowerPlan } from "../ai/setup/empower_protected_axis";
import { empowerResearchSha } from "./empower_setup_training";
import { fitStableRidge } from "./optimizer/ridge_regression";
import { permuteRankedDraftSeed } from "./ranked_draft_eval";
import type { ContextualEmpowerRow } from "./empower_context_worker";

export interface IContextualEmpowerExample {
    board: number;
    seed: number;
    game: number;
    budget: number;
    map: number;
    features: number[];
    gain: number;
}

export function contextualEmpowerExamples(rows: readonly ContextualEmpowerRow[]): IContextualEmpowerExample[] {
    const groups = new Map<string, ContextualEmpowerRow[]>();
    const seen = new Set<string>();
    for (const row of rows) {
        const key = `${row.board}:${row.game}:${row.requestedLevel}`;
        if (
            seen.has(key) ||
            ![0, 1].includes(row.requestedLevel) ||
            ![0, 1, 2, 3].includes(row.game) ||
            row.rejected !== 0 ||
            ![0, 0.5, 1].includes(row.score)
        )
            throw new Error("Invalid contextual Empower training row");
        seen.add(key);
        const pair = `${row.board}:${row.game}`;
        groups.set(pair, [...(groups.get(pair) ?? []), row]);
    }
    const examples = new Map<string, IContextualEmpowerExample & { count: number }>();
    const boards = new Map<number, number>();
    for (const pair of groups.values()) {
        pair.sort((a, b) => a.requestedLevel - b.requestedLevel);
        const base = pair[0],
            candidate = pair[1];
        if (
            pair.length !== 2 ||
            base.requestedLevel !== 0 ||
            candidate.requestedLevel !== 1 ||
            pair.some(
                (row) =>
                    row.inputSha256 !== base.inputSha256 ||
                    row.formationSha256 !== base.formationSha256 ||
                    row.seed !== base.seed ||
                    row.registrationSha256 !== base.registrationSha256 ||
                    empowerResearchSha(row.features) !== empowerResearchSha(base.features) ||
                    row.level !== (row.features ? row.requestedLevel : 0) ||
                    empowerResearchSha(row.plan) !==
                        empowerResearchSha(protectedAxisEmpowerPlan(row.budget, row.own, row.level)),
            )
        )
            throw new Error("Unmatched contextual Empower training pair");
        boards.set(base.board, (boards.get(base.board) ?? 0) + 1);
        if (!base.features) {
            if (candidate.score !== base.score || candidate.traceSha256 !== base.traceSha256)
                throw new Error("Non-magic contextual control changed");
            continue;
        }
        const key = `${base.board}:${Math.floor(base.game / 2)}`;
        const example = examples.get(key) ?? {
            board: base.board,
            seed: base.seed,
            game: Math.floor(base.game / 2),
            budget: base.budget,
            map: base.map!,
            features: base.features,
            gain: 0,
            count: 0,
        };
        if (empowerResearchSha(example.features) !== empowerResearchSha(base.features))
            throw new Error("Contextual features changed across physical seats");
        example.gain += candidate.score - base.score;
        example.count++;
        examples.set(key, example);
    }
    if ([...boards.values()].some((count) => count !== 4)) throw new Error("Incomplete contextual training board");
    return [...examples.values()].map(({ count, ...example }) => {
        if (count !== 2) throw new Error("Incomplete contextual physical-seat pair");
        return { ...example, gain: example.gain / count };
    });
}

interface IForestOptions {
    depth: number;
    minimumLeaf: number;
    trees: number;
    featureFraction: number;
    boardSampleFraction: number;
    leafShrinkage: number;
    seed: number;
}
type Recipe = { kind: "ridge"; lambda: number } | ({ kind: "forest" } & IForestOptions);
export interface IContextualEmpowerTrainingOptions {
    folds: number;
    foldSalt: number;
    ridgeLambdas: number[];
    forests: Omit<IForestOptions, "depth" | "minimumLeaf"> & { depths: number[]; minimumLeaves: number[] };
    margins: number[];
}

function random(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}

function fitForest(examples: readonly IContextualEmpowerExample[], options: IForestOptions): EmpowerEffectTree[] {
    const dimensions = EMPOWER_CONTEXT_FEATURES.length;
    const thresholds = Array.from({ length: dimensions }, (_, feature) => {
        const values = examples.map((row) => row.features[feature]).sort((a, b) => a - b);
        const unique = [...new Set(values)];
        if (unique.length <= 9) return unique.slice(1).map((value, i) => (value + unique[i]) / 2);
        const cuts = Array.from({ length: 7 }, (_, i) => values[Math.floor(((i + 1) * values.length) / 8)]);
        return [
            ...new Set(
                cuts.flatMap((value) => {
                    const index = unique.indexOf(value);
                    return index < unique.length - 1 ? [(value + unique[index + 1]) / 2] : [];
                }),
            ),
        ];
    });
    const bins = thresholds.map((cuts, feature) =>
        Uint8Array.from(examples, (row) => {
            let bin = 0;
            while (bin < cuts.length && row.features[feature] > cuts[bin]) bin++;
            return bin;
        }),
    );
    const boardIds = [...new Set(examples.map((row) => row.board))].sort((a, b) => a - b);
    const rng = random(options.seed);
    const build = (indices: number[], depth: number): EmpowerEffectTree => {
        const sum = indices.reduce((total, i) => total + examples[i].gain, 0);
        const leaf = { value: sum / (indices.length + options.leafShrinkage) };
        if (depth >= options.depth || indices.length < 2 * options.minimumLeaf) return leaf;
        const candidates = Array.from({ length: dimensions }, (_, i) => i);
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        let best = 1e-10;
        let split: { feature: number; bin: number } | undefined;
        for (const feature of candidates.slice(0, Math.ceil(dimensions * options.featureFraction))) {
            const cuts = thresholds[feature];
            if (!cuts.length) continue;
            const counts = new Uint32Array(cuts.length + 1),
                sums = new Float64Array(cuts.length + 1);
            for (const i of indices) {
                const bin = bins[feature][i];
                counts[bin]++;
                sums[bin] += examples[i].gain;
            }
            let leftCount = 0,
                leftSum = 0;
            for (let bin = 0; bin < cuts.length; bin++) {
                leftCount += counts[bin];
                leftSum += sums[bin];
                const rightCount = indices.length - leftCount;
                if (leftCount < options.minimumLeaf || rightCount < options.minimumLeaf) continue;
                const rightSum = sum - leftSum;
                const improvement =
                    (leftSum * leftSum) / leftCount + (rightSum * rightSum) / rightCount - (sum * sum) / indices.length;
                if (improvement > best) {
                    best = improvement;
                    split = { feature, bin };
                }
            }
        }
        if (!split) return leaf;
        const { feature, bin } = split;
        return {
            feature,
            threshold: thresholds[feature][bin],
            left: build(
                indices.filter((i) => bins[feature][i] <= bin),
                depth + 1,
            ),
            right: build(
                indices.filter((i) => bins[feature][i] > bin),
                depth + 1,
            ),
        };
    };
    return Array.from({ length: options.trees }, () => {
        const selected = new Set(boardIds.filter(() => rng() < options.boardSampleFraction));
        const indices = examples.flatMap((row, i) => (selected.has(row.board) ? [i] : []));
        return build(indices.length ? indices : examples.map((_, i) => i), 0);
    });
}

export function fitContextualEmpower(
    examples: readonly IContextualEmpowerExample[],
    recipe: Recipe,
    margin: number,
): IContextualEmpowerModel {
    if (!examples.length) throw new Error("No contextual Empower training examples");
    const estimator: IContextualEmpowerModel["estimator"] =
        recipe.kind === "ridge"
            ? {
                  kind: "ridge",
                  ...fitStableRidge(
                      examples,
                      EMPOWER_CONTEXT_FEATURES.length,
                      (row) => row.features,
                      (row) => row.gain,
                      1000,
                      recipe.lambda,
                  ),
              }
            : { kind: "forest", trees: fitForest(examples, recipe) };
    const model: IContextualEmpowerModel = {
        schema: EMPOWER_CONTEXT_SCHEMA,
        features: EMPOWER_CONTEXT_FEATURES,
        margin,
        estimator,
    };
    validateContextualEmpowerModel(model);
    return model;
}

export function trainContextualEmpower(
    rows: readonly ContextualEmpowerRow[],
    options: IContextualEmpowerTrainingOptions,
) {
    const examples = contextualEmpowerExamples(rows);
    const boardSeeds = new Map(rows.map((row) => [row.board, row.seed]));
    const boards = [...boardSeeds].sort(
        (a, b) =>
            permuteRankedDraftSeed((a[1] ^ options.foldSalt) >>> 0) -
                permuteRankedDraftSeed((b[1] ^ options.foldSalt) >>> 0) || a[0] - b[0],
    );
    const foldOf = new Map(boards.map(([board], i) => [board, i % options.folds]));
    const foldCounts = Array.from(
        { length: options.folds },
        (_, fold) => boards.filter(([board]) => foldOf.get(board) === fold).length,
    );
    const recipes: Recipe[] = [
        ...options.ridgeLambdas.map((lambda): Recipe => ({ kind: "ridge", lambda })),
        ...options.forests.depths.flatMap((depth) =>
            options.forests.minimumLeaves.map((minimumLeaf): Recipe => ({
                kind: "forest",
                depth,
                minimumLeaf,
                trees: options.forests.trees,
                featureFraction: options.forests.featureFraction,
                boardSampleFraction: options.forests.boardSampleFraction,
                leafShrinkage: options.forests.leafShrinkage,
                seed: options.forests.seed,
            })),
        ),
    ];
    const scores: {
        recipe: Recipe;
        margin: number;
        gain: number;
        foldGains: number[];
        switched: number;
        activatedBoards: number;
        eligible: boolean;
    }[] = [];
    for (const recipe of recipes) {
        const held = Array.from({ length: options.folds }, (_, fold) => {
            const model = fitContextualEmpower(
                examples.filter((row) => foldOf.get(row.board) !== fold),
                recipe.kind === "forest" ? { ...recipe, seed: recipe.seed + fold * 1009 } : recipe,
                0,
            );
            return examples
                .filter((row) => foldOf.get(row.board) === fold)
                .map((row) => ({ ...row, prediction: predictContextualEmpower(model, row.features) }));
        });
        for (const margin of options.margins) {
            const selected = held.map((fold) => fold.filter((row) => row.prediction > margin));
            const sums = selected.map((fold) => fold.reduce((total, row) => total + row.gain, 0));
            const gain = sums.reduce((a, b) => a + b, 0) / (2 * boards.length);
            const foldGains = sums.map((sum, fold) => sum / (2 * foldCounts[fold]));
            const score = {
                recipe,
                margin,
                gain,
                foldGains,
                switched: selected.flat().length,
                activatedBoards: new Set(selected.flat().map((row) => row.board)).size,
                eligible: gain >= 0.005 && foldGains.filter((value) => value > 0).length >= 3,
            };
            scores.push(score);
            console.log(JSON.stringify({ stage: "development-cross-validation", ...score }));
        }
    }
    const eligible = scores.filter((score) => score.eligible);
    const selected = eligible.reduce<(typeof scores)[number] | undefined>(
        (best, score) => (!best || score.gain > best.gain ? score : best),
        undefined,
    );
    return {
        examples: examples.length,
        boards: boards.length,
        foldCounts,
        scores,
        selected: selected ?? null,
        model: selected ? fitContextualEmpower(examples, selected.recipe, selected.margin) : null,
    };
}

if (import.meta.main) {
    const [rowsPath, registrationPath, output] = process.argv.slice(2);
    const rows = readFileSync(rowsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ContextualEmpowerRow);
    const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as {
        registrationSha256: string;
        training: IContextualEmpowerTrainingOptions;
        banks: { train: { board: number; seed: number }[] };
    };
    const seeds = new Map(registration.banks.train.map((row) => [row.board, row.seed]));
    if (
        rows.length !== seeds.size * 8 ||
        rows.some(
            (row) => row.registrationSha256 !== registration.registrationSha256 || seeds.get(row.board) !== row.seed,
        )
    )
        throw new Error("Contextual training does not match the complete registered bank");
    const fit = trainContextualEmpower(rows, registration.training);
    writeFileSync(output, JSON.stringify(fit) + "\n", { flag: "wx" });
    console.log(
        JSON.stringify({
            stage: "frozen-refit",
            examples: fit.examples,
            selected: fit.selected,
            modelSha256: empowerResearchSha(fit.model),
        }),
    );
}
