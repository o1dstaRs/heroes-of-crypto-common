import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { selectContextualEmpower, validateContextualEmpowerModel } from "../ai/setup/empower_context";
import { protectedAxisEmpowerPlan } from "../ai/setup/empower_protected_axis";
import { empowerResearchSha } from "./empower_setup_training";
import { sanitizedRankedDraftEnvironment } from "./ranked_draft_eval";
import type { runContextualEmpowerResearchGame, IContextualEmpowerJob } from "./empower_context_research";
import type { runProtectedAxisEmpowerResearchGame } from "./empower_protected_axis_research";

type PriorRow = ReturnType<typeof runProtectedAxisEmpowerResearchGame> & { registrationSha256: string };
interface IPriorEntry {
    row: PriorRow;
    sourceFile: string;
    sourceLine: number;
    sourceFileSha256: string;
    rawLineSha256: string;
}
export type ContextualEmpowerRow = ReturnType<typeof runContextualEmpowerResearchGame> & {
    registrationSha256: string;
    reusedControl?: true;
    priorReuse?: Omit<IPriorEntry, "row"> & { registrationSha256: string; rowSha256: string };
};

if (import.meta.main) {
    const [output, priorPath] = process.argv.slice(2);
    const environment = sanitizedRankedDraftEnvironment(process.env, "a19");
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    const { inspectContextualEmpowerInput, runContextualEmpowerResearchGame } =
        await import("./empower_context_research");
    const keyOf = (seed: number, game: number, plan: unknown) => `${seed}:${game}:${empowerResearchSha(plan)}`;
    const prior = new Map<string, IPriorEntry>();
    if (priorPath)
        for (const line of readFileSync(priorPath, "utf8").trim().split("\n")) {
            const entry = JSON.parse(line) as IPriorEntry;
            prior.set(keyOf(entry.row.seed, entry.row.game, entry.row.plan), entry);
        }
    const controls = new Map<string, ContextualEmpowerRow>();
    const inspections = new Map<string, ReturnType<typeof inspectContextualEmpowerInput>>();
    for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line) as {
            job: IContextualEmpowerJob;
            registrationSha256: string;
            verifyPriorControl?: boolean;
        };
        const job = request.job;
        if (job.model) validateContextualEmpowerModel(job.model);
        const key = `${job.seed}:${job.game}`;
        const inspected = inspections.get(key) ?? inspectContextualEmpowerInput(job);
        inspections.set(key, inspected);
        const level = job.model
            ? selectContextualEmpower(job.model, inspected.budget, inspected.own, inspected.context)
            : inspected.features
              ? job.level
              : 0;
        const plan = protectedAxisEmpowerPlan(inspected.budget, inspected.own, level);
        const previous = prior.get(keyOf(job.seed, job.game, plan));
        const control = controls.get(key);
        let result: ContextualEmpowerRow;
        if (previous && !request.verifyPriorControl) {
            if (previous.row.inputSha256 !== inspected.inputSha256) throw new Error("Prior contextual input mismatch");
            const { row, ...source } = previous;
            result = {
                ...row,
                ...inspected,
                board: job.board,
                requestedLevel: job.level,
                level,
                registrationSha256: request.registrationSha256,
                reusedControl: true,
                priorReuse: {
                    ...source,
                    registrationSha256: row.registrationSha256,
                    rowSha256: empowerResearchSha(row),
                },
                elapsedMs: 0,
            };
        } else if (control && level === 0 && job.level !== 0 && !request.verifyPriorControl) {
            result = { ...control, requestedLevel: job.level, reusedControl: true, elapsedMs: 0 };
        } else {
            result = { ...runContextualEmpowerResearchGame(job), registrationSha256: request.registrationSha256 };
            if (request.verifyPriorControl) {
                if (!previous) throw new Error("Missing prior control for contextual preflight");
                for (const field of [
                    "inputSha256",
                    "formationSha256",
                    "traceSha256",
                    "score",
                    "plan",
                    "budget",
                    "map",
                    "own",
                    "enemy",
                ] as const)
                    if (empowerResearchSha(result[field]) !== empowerResearchSha(previous.row[field]))
                        throw new Error(`Contextual preflight mismatch: ${field}`);
            }
        }
        if (job.level === 0) controls.set(key, result);
        appendFileSync(output, JSON.stringify(result) + "\n");
        console.log(
            JSON.stringify({ board: result.board, game: result.game, level: job.level, elapsedMs: result.elapsedMs }),
        );
    }
}
