import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
    EMPOWER_SETUP_FEATURES,
    EMPOWER_SETUP_SCHEMA,
    selectEmpowerSetup,
    type IEmpowerSetupModel,
} from "../ai/setup/empower_setup";
import { fitStableRidge } from "./optimizer/ridge_regression";
import { permuteRankedDraftSeed, sanitizedRankedDraftEnvironment } from "./ranked_draft_eval";
import type { runEmpowerResearchGame, IEmpowerResearchJob } from "./empower_setup_research";

export type EmpowerResearchRow = ReturnType<typeof runEmpowerResearchGame> & {
    registrationSha256: string;
    reusedControl?: true;
};
export interface IEmpowerExample {
    board: number;
    seed: number;
    budget: number;
    own: number[];
    features: number[];
    gains: number[];
}
export const empowerResearchSha = (value: unknown) =>
    createHash("sha256")
        .update(JSON.stringify(value ?? null))
        .digest("hex");

export function empowerTrainingExamples(rows: readonly EmpowerResearchRow[]): IEmpowerExample[] {
    const pairs = new Map<string, EmpowerResearchRow[]>();
    for (const row of rows) {
        const key = `${row.board}:${row.game}`;
        const bucket = pairs.get(key) ?? [];
        bucket.push(row);
        pairs.set(key, bucket);
    }
    const examples = new Map<string, IEmpowerExample & { count: number }>();
    for (const pair of pairs.values()) {
        pair.sort((a, b) => a.requestedLevel - b.requestedLevel);
        const base = pair[0];
        if (
            pair.length !== 4 ||
            pair.some(
                (row, index) =>
                    row.requestedLevel !== index ||
                    row.inputSha256 !== base.inputSha256 ||
                    row.formationSha256 !== base.formationSha256 ||
                    row.registrationSha256 !== base.registrationSha256 ||
                    empowerResearchSha(row.features) !== empowerResearchSha(base.features),
            )
        )
            throw new Error("Unmatched Empower interventions");
        if (!base.features) {
            if (pair.some((row) => row.level !== 0 || row.traceSha256 !== base.traceSha256 || row.score !== base.score))
                throw new Error("Non-magic control changed");
            continue;
        }
        const key = `${base.board}:${Math.floor(base.game / 2)}`;
        const example = examples.get(key) ?? {
            board: base.board,
            seed: base.seed,
            own: base.own,
            budget: base.budget,
            features: base.features,
            gains: [0, 0, 0],
            count: 0,
        };
        if (empowerResearchSha(example.features) !== empowerResearchSha(base.features))
            throw new Error("Empower features changed between seats");
        pair.slice(1).forEach((row, index) => {
            example.gains[index] += row.score - base.score;
        });
        example.count++;
        examples.set(key, example);
    }
    return [...examples.values()].map(({ count, ...row }) => {
        if (count !== 2) throw new Error("Missing physical mirror seat");
        return { ...row, gains: row.gains.map((value) => value / count) };
    });
}

export function fitEmpowerSetup(examples: readonly IEmpowerExample[], l2: number, margin: number): IEmpowerSetupModel {
    return {
        schema: EMPOWER_SETUP_SCHEMA,
        features: EMPOWER_SETUP_FEATURES,
        margin,
        heads: [0, 1, 2].map((level) =>
            fitStableRidge(
                examples,
                EMPOWER_SETUP_FEATURES.length,
                (row) => row.features,
                (row) => row.gains[level],
                1000,
                l2,
            ),
        ),
    };
}

export function trainEmpowerSetup(
    rows: readonly EmpowerResearchRow[],
    options: { validationBoards: number; splitSalt: number; lambdas: number[]; margins: number[] },
) {
    const examples = empowerTrainingExamples(rows);
    const boardSeeds = new Map(rows.map((row) => [row.board, row.seed]));
    const boards = [...boardSeeds].sort(
        (a, b) =>
            permuteRankedDraftSeed((a[1] ^ options.splitSalt) >>> 0) -
                permuteRankedDraftSeed((b[1] ^ options.splitSalt) >>> 0) || a[0] - b[0],
    );
    const validation = new Set(boards.slice(0, options.validationBoards).map(([board]) => board));
    const train = examples.filter((row) => !validation.has(row.board)),
        held = examples.filter((row) => validation.has(row.board));
    if (!train.length || !held.length || validation.size !== options.validationBoards)
        throw new Error("Missing whole-board internal validation");
    const recipes: { lambda: number; margin: number; gain: number; switched: number }[] = [];
    for (const lambda of options.lambdas) {
        const model = fitEmpowerSetup(train, lambda, 0);
        for (const margin of options.margins) {
            model.margin = margin;
            let sum = 0,
                switched = 0;
            for (const row of held) {
                const level = selectEmpowerSetup(model, row.budget, row.own);
                if (level) {
                    sum += row.gains[level - 1];
                    switched++;
                }
            }
            recipes.push({ lambda, margin, gain: sum / (2 * options.validationBoards), switched });
        }
    }
    const selected = recipes.reduce((best, current) => (current.gain > best.gain ? current : best));
    if (!(selected.gain > 0) || !selected.switched)
        return { examples: examples.length, recipes, selected, model: null };
    return {
        examples: examples.length,
        recipes,
        selected,
        model: fitEmpowerSetup(examples, selected.lambda, selected.margin),
    };
}

if (import.meta.main) {
    const [command, path, extra] = process.argv.slice(2);
    if (command === "worker") {
        const environment = sanitizedRankedDraftEnvironment(process.env, "a19");
        for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
        Object.assign(process.env, environment);
        const { runEmpowerResearchGame } = await import("./empower_setup_research");
        const controls = new Map<string, EmpowerResearchRow>();
        for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line) as { job: IEmpowerResearchJob; registrationSha256: string };
            const key = `${request.job.board}:${request.job.game}`;
            const cached = controls.get(key);
            const unchanged =
                cached &&
                (request.job.model
                    ? selectEmpowerSetup(request.job.model, cached.budget, cached.own) === 0
                    : !cached.features);
            const result =
                cached && unchanged && request.job.level !== 0
                    ? { ...cached, requestedLevel: request.job.level, reusedControl: true as const, elapsedMs: 0 }
                    : { ...runEmpowerResearchGame(request.job), registrationSha256: request.registrationSha256 };
            if (request.job.level === 0) controls.set(key, result);
            appendFileSync(path, JSON.stringify(result) + "\n");
            console.log(
                JSON.stringify({
                    board: result.board,
                    game: result.game,
                    level: result.requestedLevel,
                    elapsedMs: result.elapsedMs,
                }),
            );
        }
    } else if (command === "fit") {
        const rows = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as EmpowerResearchRow);
        const result = trainEmpowerSetup(rows, {
            validationBoards: 108,
            splitSalt: 2026111411,
            lambdas: [0.01, 0.1, 1],
            margins: [0.01, 0.03, 0.05, 0.1],
        });
        writeFileSync(extra, JSON.stringify(result) + "\n", { flag: "wx" });
        console.log(
            JSON.stringify({
                examples: result.examples,
                selected: result.selected,
                modelSha256: result.model ? empowerResearchSha(result.model) : null,
            }),
        );
    } else throw new Error("Usage: empower_setup_training.ts worker output.jsonl | fit rows.jsonl fit.json");
}
