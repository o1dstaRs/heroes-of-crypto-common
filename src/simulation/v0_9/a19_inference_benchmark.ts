/** Validate exported floats against independent PyTorch references, then time warmed CPU inference only. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { V09A19CpuModel, type IV09A19Prediction } from "./a19_inference";
import type { IV09A19Observation } from "./a19_observation";

export function benchmarkV09A19Inference(modelBytes: string, fixtureBytes: string) {
    const fixture = JSON.parse(fixtureBytes) as {
        manifestSha256: string;
        sourceSha256: string;
        modelFileSha256?: string;
        observations: IV09A19Observation[];
        expected: IV09A19Prediction[];
    };
    if (
        !Array.isArray(fixture.observations) ||
        fixture.observations.length < 1 ||
        fixture.observations.length !== fixture.expected.length
    )
        throw new Error("Incomplete PyTorch reference fixture");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const artifact = JSON.parse(modelBytes);
    if (fixture.modelFileSha256 !== undefined && fixture.modelFileSha256 !== sha(modelBytes))
        throw new Error("PyTorch reference fixture belongs to another model export");
    const model = new V09A19CpuModel(artifact, fixture);
    const tolerance = 0.00001;
    let maximumAbsoluteError = 0,
        resolvedRankingMismatches = 0;
    const compare = (actual: IV09A19Prediction, expected: IV09A19Prediction) => {
        if (actual.policy.length !== expected.policy.length || actual.primary.length !== expected.primary.length)
            throw new Error("Reference candidate count differs");
        const left = [...actual.policy, ...actual.primary, actual.valueLogit];
        const right = [...expected.policy, ...expected.primary, expected.valueLogit];
        for (let index = 0; index < left.length; index++) {
            const error = Math.abs(left[index] - right[index]);
            if (!Number.isFinite(error) || error > tolerance) throw new Error(`CPU/PyTorch inference drift: ${error}`);
            maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
        }
    };
    const best = (scores: number[]) => scores.reduce((top, score, index) => (score > scores[top] ? index : top), 0);
    for (const [index, observation] of fixture.observations.entries()) {
        const predicted = model.predict(observation),
            expected = fixture.expected[index];
        compare(predicted, expected);
        const ranked = [...expected.policy].sort((a, b) => b - a);
        if (
            ranked.length > 1 &&
            ranked[0] - ranked[1] > 2 * tolerance &&
            best(predicted.policy) !== best(expected.policy)
        )
            resolvedRankingMismatches++;
        const n = observation.entities.length;
        const permuted = {
            ...observation,
            entities: [...observation.entities].reverse(),
            entityIds: [...observation.entityIds].reverse(),
            actorIndex: n - 1 - observation.actorIndex,
            candidates: observation.candidates.map((candidate) => ({
                ...candidate,
                targetIndex: candidate.targetIndex < 0 ? -1 : n - 1 - candidate.targetIndex,
            })),
        };
        compare(model.predict(permuted), predicted);
        const reversed = model.predict({ ...observation, candidates: [...observation.candidates].reverse() });
        compare(
            { policy: reversed.policy.reverse(), primary: reversed.primary.reverse(), valueLogit: reversed.valueLogit },
            predicted,
        );
    }
    if (resolvedRankingMismatches) throw new Error("CPU inference changed a numerically resolved PyTorch preference");
    const warmupCalls = Math.max(20, fixture.observations.length * 2);
    for (let i = 0; i < warmupCalls; i++) model.predict(fixture.observations[i % fixture.observations.length]);
    const cpuTimes: number[] = [];
    const pairedTimings: { wallMs: number; processCpuMs: number; entities: number; candidates: number }[] = [];
    const times = Array.from({ length: Math.max(256, fixture.observations.length * 4) }, (_, index) => {
        const before = performance.now();
        const cpuBefore = process.cpuUsage();
        model.predict(fixture.observations[index % fixture.observations.length]);
        const cpu = process.cpuUsage(cpuBefore);
        const wallMs = performance.now() - before;
        const processCpuMs = (cpu.user + cpu.system) / 1000;
        cpuTimes.push(processCpuMs);
        const observation = fixture.observations[index % fixture.observations.length];
        pairedTimings.push({
            wallMs,
            processCpuMs,
            entities: observation.entities.length,
            candidates: observation.candidates.length,
        });
        return wallMs;
    }).sort((a, b) => a - b);
    cpuTimes.sort((a, b) => a - b);
    const percentile = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
    return {
        schema: "hoc.ai.v0_9_a19_cpu_inference_diagnostic.v1",
        promoted: false,
        scope: "CPU/PyTorch numerical parity and warmed inference timing; excludes feature extraction, search and full-turn latency",
        untrainedDiagnostic: artifact.untrainedDiagnostic === true,
        fixtureModelBound: fixture.modelFileSha256 === sha(modelBytes),
        manifestSha256: fixture.manifestSha256,
        sourceSha256: fixture.sourceSha256,
        modelFileSha256: sha(modelBytes),
        fixtureFileSha256: sha(fixtureBytes),
        inferenceSourceSha256: sha(readFileSync(new URL("./a19_inference.ts", import.meta.url), "utf8")),
        runtime: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        observations: fixture.observations.length,
        maximumAbsoluteError,
        tolerance,
        resolvedRankingMismatches,
        permutationCases: fixture.observations.length,
        candidateOrderCases: fixture.observations.length,
        timingSamples: times.length,
        warmupCalls,
        processCpuP50Ms: cpuTimes[Math.floor(cpuTimes.length * 0.5)],
        processCpuP99Ms: cpuTimes[Math.floor(cpuTimes.length * 0.99)],
        slowestCalls: pairedTimings.sort((a, b) => b.wallMs - a.wallMs).slice(0, 5),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: times.at(-1),
        maxEntities: Math.max(...fixture.observations.map((row) => row.entities.length)),
        maxCandidates: Math.max(...fixture.observations.map((row) => row.candidates.length)),
    };
}

if (import.meta.main) {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            model: { type: "string" },
            fixture: { type: "string" },
            out: { type: "string" },
        },
        strict: true,
    });
    if (!values.model || !values.fixture)
        throw new Error("Required: --model <diagnostic model> --fixture <PyTorch references>");
    const result = benchmarkV09A19Inference(readFileSync(values.model, "utf8"), readFileSync(values.fixture, "utf8"));
    const output = JSON.stringify(result, null, 2) + "\n";
    if (values.out) writeFileSync(values.out, output, { flag: "wx" });
    process.stdout.write(output);
}
