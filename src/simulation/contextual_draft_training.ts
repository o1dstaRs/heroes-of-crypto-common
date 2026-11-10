/** Frozen paired collection and deterministic CPU ridge fitting for contextual draft research. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    runContextualDraftGame,
    type IContextualDraftBoard,
    type ContextualDraftCondition,
} from "./contextual_draft_battles";
import {
    CONTEXTUAL_DRAFT_BASE_FEATURES,
    CONTEXTUAL_DRAFT_FEATURE_NAMES,
    CONTEXTUAL_DRAFT_SCHEMA,
    CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
    predictContextualDraft,
    validateContextualDraftModel,
    type IContextualDraftModel,
} from "./contextual_draft_research";
import { permuteRankedDraftSeed } from "./ranked_draft_eval";

export const CONTEXTUAL_DRAFT_REGISTRATION_SCHEMA = "hoc.contextual-draft-training.v1";
export interface IContextualDraftRegistration {
    readonly schema: typeof CONTEXTUAL_DRAFT_REGISTRATION_SCHEMA;
    readonly registrationSha256: string;
    readonly sourceCommit: string;
    readonly sourceManifestSha256: string;
    readonly sourceManifest: readonly { path: string; sha256: string }[];
    readonly banks: {
        train: readonly IContextualDraftBoard[];
        qualification: readonly IContextualDraftBoard[];
        confirmation: readonly IContextualDraftBoard[];
    };
    readonly training: {
        lambdas: readonly number[];
        margins: readonly number[];
        validationBoards: number;
        splitSalt: number;
    };
    readonly productionPromotion: false;
}
export interface IContextualDraftExample {
    readonly board: number;
    readonly seed: number;
    readonly features: readonly number[];
    readonly gain: number;
}
export const contextualDraftSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + "\n", { flag: "wx" });
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Exact-byte verification avoids Python/JavaScript exponent-serialization differences. */
export function readContextualDraftRow(path: string) {
    const raw = readFileSync(path, "utf8").trimEnd();
    const row = JSON.parse(raw) as ReturnType<typeof runContextualDraftGame> & {
        registrationSha256: string;
        modelSha256: string | null;
        sha256: string;
    };
    const cut = raw.lastIndexOf(',"sha256":');
    if (
        cut < 0 ||
        createHash("sha256")
            .update(raw.slice(0, cut) + "}")
            .digest("hex") !== row.sha256 ||
        row.rejected !== 0
    )
        throw new Error("Invalid contextual draft row: " + path);
    return row;
}

/** Positive definite ridge solve, with no dependency on BLAS or GPU precision/transport. */
export function fitContextualDraftRidge(
    examples: readonly IContextualDraftExample[],
    lambda: number,
    information: IContextualDraftModel["information"],
    margin: number,
): IContextualDraftModel {
    if (
        !examples.length ||
        !Number.isFinite(lambda) ||
        lambda <= 0 ||
        examples.some(
            (row) =>
                row.features.length !== CONTEXTUAL_DRAFT_FEATURE_NAMES.length ||
                row.features.some((x) => !Number.isFinite(x)) ||
                !Number.isFinite(row.gain) ||
                Math.abs(row.gain) > 1,
        )
    )
        throw new Error("Invalid contextual ridge data");
    const dimension =
        information === "full" ? CONTEXTUAL_DRAFT_FEATURE_NAMES.length : CONTEXTUAL_DRAFT_BASE_FEATURES.length;
    const matrix = Array.from({ length: dimension }, () => new Float64Array(dimension));
    const target = new Float64Array(dimension);
    for (const row of examples) {
        for (let i = 0; i < dimension; i++) {
            const a = row.features[i];
            if (a === 0) continue;
            target[i] += a * row.gain;
            for (let j = 0; j <= i; j++) matrix[i][j] += a * row.features[j];
        }
    }
    for (let i = 0; i < dimension; i++) {
        matrix[i][i] += lambda;
        for (let j = 0; j <= i; j++) {
            let value = matrix[i][j];
            for (let k = 0; k < j; k++) value -= matrix[i][k] * matrix[j][k];
            if (i === j) {
                if (!(value > 0)) throw new Error("Non-positive contextual ridge matrix");
                matrix[i][j] = Math.sqrt(value);
            } else matrix[i][j] = value / matrix[j][j];
        }
    }
    const intermediate = new Float64Array(dimension),
        weights = new Array<number>(CONTEXTUAL_DRAFT_FEATURE_NAMES.length).fill(0);
    for (let i = 0; i < dimension; i++) {
        let value = target[i];
        for (let j = 0; j < i; j++) value -= matrix[i][j] * intermediate[j];
        intermediate[i] = value / matrix[i][i];
    }
    for (let i = dimension - 1; i >= 0; i--) {
        let value = intermediate[i];
        for (let j = i + 1; j < dimension; j++) value -= matrix[j][i] * weights[j];
        weights[i] = value / matrix[i][i];
    }
    const model: IContextualDraftModel = {
        schema: CONTEXTUAL_DRAFT_SCHEMA,
        featureSchema: CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
        features: CONTEXTUAL_DRAFT_FEATURE_NAMES,
        weights,
        information,
        margin,
        productionPromotion: false,
    };
    validateContextualDraftModel(model);
    return model;
}

function fit(root: string, registration: IContextualDraftRegistration) {
    const examples: IContextualDraftExample[] = [];
    for (const board of registration.banks.train) {
        const pairs = board.trainingGames.map((game) =>
            (["locked", "fork"] as const).map((condition) =>
                readContextualDraftRow(join(root, "train", `${board.board}-${game}-${condition}.json`)),
            ),
        );
        for (const pair of pairs)
            for (const row of pair)
                if (row.registrationSha256 !== registration.registrationSha256 || row.seed !== board.seed)
                    throw new Error("Mismatched contextual training board");
        const current = pairs[0][0].draftDecisions[0],
            alternate = pairs[0][1].draftDecisions[0];
        if (
            !current ||
            !alternate ||
            current.chosen !== current.preferred ||
            alternate.chosen !== current.alternative ||
            contextualDraftSha(current.features) !== contextualDraftSha(alternate.features)
        )
            throw new Error("Unmatched contextual intervention");
        if (
            pairs.some(
                ([a, b]) =>
                    contextualDraftSha(a.draftDecisions[0]) !== contextualDraftSha(current) ||
                    contextualDraftSha(b.draftDecisions[0]) !== contextualDraftSha(alternate),
            )
        )
            throw new Error("Draft decision changed between physical mirror seats");
        examples.push({
            board: board.board,
            seed: board.seed,
            features: current.features,
            gain: pairs.reduce((sum, [a, b]) => sum + b.score - a.score, 0) / pairs.length,
        });
    }
    const ordered = [...examples].sort(
        (a, b) =>
            permuteRankedDraftSeed((a.seed ^ registration.training.splitSalt) >>> 0) -
                permuteRankedDraftSeed((b.seed ^ registration.training.splitSalt) >>> 0) || a.board - b.board,
    );
    const development = ordered.slice(0, registration.training.validationBoards),
        train = ordered.slice(registration.training.validationBoards);
    if (!development.length || !train.length) throw new Error("Missing whole-board training/development split");
    const recipes: unknown[] = [];
    const selected: Record<string, unknown> = {};
    for (const information of ["full", "without-map-synergies"] as const) {
        let best: { lambda: number; margin: number; value: number } | undefined;
        for (const lambda of registration.training.lambdas) {
            const fitted = fitContextualDraftRidge(train, lambda, information, 0);
            for (const margin of registration.training.margins) {
                const model = { ...fitted, margin };
                const value =
                    development.reduce(
                        (sum, row) => sum + (predictContextualDraft(model, row.features) > margin ? row.gain : 0),
                        0,
                    ) / development.length;
                const switches = development.filter(
                    (row) => predictContextualDraft(model, row.features) > margin,
                ).length;
                recipes.push({
                    information,
                    lambda,
                    margin,
                    internalDevelopmentGain: value,
                    switches,
                    boards: development.length,
                });
                if (!best || value > best.value) best = { lambda, margin, value };
            }
        }
        if (!best) throw new Error("No registered contextual recipe");
        const model = fitContextualDraftRidge(examples, best.lambda, information, best.margin);
        const filename = information === "full" ? "full-model.json" : "ablated-model.json";
        save(join(root, filename), model);
        selected[information] = { ...best, modelSha256: contextualDraftSha(model), filename };
    }
    save(join(root, "dataset.json"), examples);
    const report = {
        registrationSha256: registration.registrationSha256,
        examples: examples.length,
        trainingBoards: train.length,
        internalDevelopmentBoards: development.length,
        wholeBoardSplit: true,
        datasetSha256: contextualDraftSha(examples),
        recipes,
        selected,
        allFinalWeightsRefittedOnTrainingBank: true,
        independentBattleStrengthClaim: false,
        productionPromotion: false,
    };
    save(join(root, "fit-report.json"), report);
    console.log(JSON.stringify(report));
}

if (import.meta.main) {
    const [rootText, stage, shardText = "0", shardsText = "8"] = process.argv.slice(2);
    if (!rootText)
        throw new Error("Usage: contextual_draft_training.ts ROOT train|qualification|confirmation|fit [SHARD SHARDS]");
    const root = resolve(rootText);
    const registration = read<IContextualDraftRegistration>(join(root, "registration.json"));
    const { registrationSha256, ...body } = registration;
    if (
        registration.schema !== CONTEXTUAL_DRAFT_REGISTRATION_SCHEMA ||
        contextualDraftSha(body) !== registrationSha256 ||
        registration.productionPromotion !== false
    )
        throw new Error("Changed contextual registration");
    for (const entry of registration.sourceManifest)
        if (
            createHash("sha256")
                .update(readFileSync(resolve(import.meta.dir, "../..", entry.path)))
                .digest("hex") !== entry.sha256
        )
            throw new Error("Frozen contextual policy source changed: " + entry.path);
    if (stage === "fit") fit(root, registration);
    else {
        if (!["train", "qualification", "confirmation"].includes(stage))
            throw new Error("Unregistered contextual stage");
        if (stage === "confirmation") {
            const prior = read<{ passed: boolean; registrationSha256: string }>(
                join(root, "qualification-analysis.json"),
            );
            if (!prior.passed || prior.registrationSha256 !== registrationSha256)
                throw new Error("Contextual qualification gate failed");
        }
        const shard = Number(shardText),
            shards = Number(shardsText);
        if (
            !Number.isSafeInteger(shards) ||
            shards < 1 ||
            shards > 12 ||
            !Number.isSafeInteger(shard) ||
            shard < 0 ||
            shard >= shards
        )
            throw new Error("Invalid contextual process shard");
        const full = stage === "train" ? undefined : read<IContextualDraftModel>(join(root, "full-model.json"));
        const ablated = stage === "train" ? undefined : read<IContextualDraftModel>(join(root, "ablated-model.json"));
        if (full) validateContextualDraftModel(full);
        if (ablated) validateContextualDraftModel(ablated);
        const conditions: ContextualDraftCondition[] =
            stage === "train" ? ["locked", "fork"] : ["current", "locked", "learned", "ablated"];
        mkdirSync(join(root, stage), { recursive: true });
        let completed = 0;
        const began = performance.now();
        for (const board of registration.banks[stage as keyof IContextualDraftRegistration["banks"]]) {
            if (board.board % shards !== shard) continue;
            const games = stage === "train" ? board.trainingGames : [0, 1, 2, 3];
            for (const game of games)
                for (let index = 0; index < conditions.length; index++) {
                    const condition = conditions[(index + board.board + game) % conditions.length];
                    const model = condition === "learned" ? full : condition === "ablated" ? ablated : undefined;
                    const modelSha256 = model ? contextualDraftSha(model) : null;
                    const path = join(root, stage, `${board.board}-${game}-${condition}.json`);
                    if (existsSync(path)) {
                        const row = readContextualDraftRow(path);
                        if (
                            row.registrationSha256 !== registrationSha256 ||
                            row.modelSha256 !== modelSha256 ||
                            row.seed !== board.seed
                        )
                            throw new Error("Stale contextual outcome");
                        continue;
                    }
                    const result = runContextualDraftGame({
                        ...board,
                        game,
                        condition,
                        model,
                        recordTrainingDecision: stage === "train",
                    });
                    const row = { ...result, registrationSha256, modelSha256 };
                    save(path, { ...row, sha256: contextualDraftSha(row) });
                    completed++;
                    if (completed % 8 === 0)
                        console.log(
                            JSON.stringify({ stage, shard, completed, seconds: (performance.now() - began) / 1000 }),
                        );
                }
        }
        console.log(
            JSON.stringify({ stage, shard, completed, done: true, seconds: (performance.now() - began) / 1000 }),
        );
    }
}
