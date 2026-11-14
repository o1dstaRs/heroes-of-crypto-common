import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { protectedAxisEmpowerPlan } from "../ai/setup/empower_protected_axis";
import { empowerSetupFeatures, selectEmpowerSetup } from "../ai/setup/empower_setup";
import { empowerResearchSha, type EmpowerResearchRow } from "./empower_setup_training";
import { sanitizedRankedDraftEnvironment } from "./ranked_draft_eval";
import type { IEmpowerResearchJob } from "./empower_setup_research";

if (import.meta.main) {
    const [output, priorPath] = process.argv.slice(2);
    const environment = sanitizedRankedDraftEnvironment(process.env, "a19");
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    const { runProtectedAxisEmpowerResearchGame, inspectProtectedAxisEmpowerInput } =
        await import("./empower_protected_axis_research");
    const prior = new Map<string, EmpowerResearchRow[]>();
    if (priorPath)
        for (const line of readFileSync(priorPath, "utf8").trim().split("\n")) {
            const row = JSON.parse(line) as EmpowerResearchRow;
            const key = `${row.board}:${row.game}`;
            prior.set(key, [...(prior.get(key) ?? []), row]);
        }
    const controls = new Map<string, EmpowerResearchRow>();
    for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line) as {
            job: IEmpowerResearchJob;
            registrationSha256: string;
            verifyPriorControl?: boolean;
        };
        const key = `${request.job.board}:${request.job.game}`;
        const original = prior.get(key)?.find((row) => row.requestedLevel === 0);
        const input = original ? inspectProtectedAxisEmpowerInput(request.job) : undefined;
        if (
            original &&
            (!input ||
                original.seed !== request.job.seed ||
                input.inputSha256 !== original.inputSha256 ||
                input.budget !== original.budget ||
                input.map !== original.map ||
                empowerResearchSha(input.own) !== empowerResearchSha(original.own) ||
                empowerResearchSha(input.enemy) !== empowerResearchSha(original.enemy))
        )
            throw new Error("Prior development input changed");
        const known = original ?? controls.get(key);
        const level = known
            ? request.job.model
                ? selectEmpowerSetup(request.job.model, known.budget, known.own)
                : empowerSetupFeatures(known.budget, known.own)
                  ? request.job.level
                  : 0
            : undefined;
        const plan =
            known && level !== undefined ? protectedAxisEmpowerPlan(known.budget, known.own, level) : undefined;
        const priorMatch = prior.get(key)?.find((row) => empowerResearchSha(row.plan) === empowerResearchSha(plan));
        const cached = controls.get(key);
        const reusable =
            priorMatch ?? (cached && empowerResearchSha(cached.plan) === empowerResearchSha(plan) ? cached : undefined);
        const result: EmpowerResearchRow & { priorReuse?: { registrationSha256: string; rowSha256: string } } =
            reusable && !request.verifyPriorControl
                ? {
                      ...reusable,
                      requestedLevel: request.job.level,
                      registrationSha256: request.registrationSha256,
                      reusedControl: true as const,
                      elapsedMs: 0,
                      ...(priorMatch
                          ? {
                                priorReuse: {
                                    registrationSha256: priorMatch.registrationSha256,
                                    rowSha256: empowerResearchSha(priorMatch),
                                },
                            }
                          : {}),
                  }
                : {
                      ...runProtectedAxisEmpowerResearchGame(request.job),
                      registrationSha256: request.registrationSha256,
                  };
        if (
            request.verifyPriorControl &&
            (!original ||
                request.job.level !== 0 ||
                ["inputSha256", "formationSha256", "traceSha256", "score"].some(
                    (field) =>
                        original[field as keyof EmpowerResearchRow] !== result[field as keyof EmpowerResearchRow],
                ))
        )
            throw new Error("Protected-axis control differs from preserved development control");
        if (request.job.level === 0) controls.set(key, result);
        appendFileSync(output, JSON.stringify(result) + "\n");
        console.log(
            JSON.stringify({
                board: result.board,
                game: result.game,
                level: result.requestedLevel,
                reused: !!result.reusedControl,
            }),
        );
    }
}
