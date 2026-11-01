import { expect, test } from "bun:test";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { buildV09A19PilotManifest } from "../../src/simulation/v0_9/a19_pilot_protocol";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import {
    assertV09StudentSource,
    buildV09A19StudentManifest,
    buildV09StudentReadiness,
    validateV09A19StudentManifest,
    validateV09StudentRegistration,
    v09StudentSeeds,
    V09_A19_STUDENT_SCHEMA,
    type IV09A19StudentManifest,
    type IV09A19StudentRegistration,
} from "../../src/simulation/v0_9/a19_student_protocol";

const environment = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () =>
    buildV08A19SearchEnvironment(),
);
const files = { "src/engine/fixture.ts": "a".repeat(64) };
const parent = buildV09A19PilotManifest({
    source: { files, sha256: fingerprintV09(files) },
    profile: { revision: "fixture", draft: "fixture", setup: "fixture", environment, overrides: {}, sourceSha256: {} },
    seed: 9617,
    sourceCommit: "a".repeat(40),
    runtime: Bun.version,
    protectedV08Roots: ["/protected-v08"],
    teacherPreset: "precise-r8",
});

function readinessFixture() {
    const sourceFiles = { ...files, "src/simulation/v0_9/a19_inference.ts": "f".repeat(64) };
    const body = {
        schema: V09_A19_STUDENT_SCHEMA,
        promoted: false as const,
        diagnosticOnly: false,
        parent,
        registration: registration(),
        source: { files: sourceFiles, sha256: fingerprintV09(sourceFiles) },
        runtime: Bun.version,
        modelFileSha256: "d".repeat(64),
        acceptedFitReceiptSha256: "e".repeat(64),
        mode: "correction" as const,
        minimumLogitGain: 1,
    };
    const manifest = { ...body, manifestSha256: fingerprintV09(body) };
    const identity = {
        manifestSha256: manifest.manifestSha256,
        modelFileSha256: manifest.modelFileSha256,
        sourceSha256: manifest.source.sha256,
        runtime: Bun.version,
        platform: "linux",
        architecture: "x64",
        rejectedActions: 0,
    };
    return {
        manifest,
        cpuParity: {
            schema: "hoc.ai.v0_9_a19_cpu_inference_diagnostic.v1",
            ...identity,
            manifestSha256: parent.manifestSha256,
            sourceSha256: parent.source.sha256,
            inferenceSourceSha256: sourceFiles["src/simulation/v0_9/a19_inference.ts"],
            fixtureModelBound: true,
            untrainedDiagnostic: false,
            observations: 96,
            permutationCases: 96,
            candidateOrderCases: 96,
            maximumAbsoluteError: 0.0000001,
            tolerance: 0.00001,
            resolvedRankingMismatches: 0,
        },
        disabledParity: {
            schema: "hoc.ai.v0_9_a19_disabled_parity.v1",
            ...identity,
            games: 12,
            trajectoryMismatches: 0,
            actionReferenceMismatches: 0,
        },
        liveLatency: {
            schema: "hoc.ai.v0_9_a19_live_latency.v1",
            ...identity,
            executionMode: "wall-clock",
            modelErrors: 0,
            inferenceOverruns: 0,
            inferenceReserveMs: 25,
            productionCpu: true,
            cpuIdentity: "fixture production CPU",
            baselineProfileSha256: fingerprintV09(parent.profile),
            minimumLogitGain: 1,
            decisionDeadlineMs: 1000,
            circuitBreakerMs: 1500,
            baselineTurns: 1000,
            candidateTurns: 1000,
            inferredTurns: 100,
            baselineP99Ms: 700,
            baselineMaxMs: 1200,
            candidateP99Ms: 703,
            candidateMaxMs: 1203,
        },
    };
}

test("confirmation readiness binds all three prerequisites to the exact fitted model and CPU source", () => {
    const fixture = readinessFixture();
    const evidence = () => ({
        cpuParity: JSON.stringify(fixture.cpuParity),
        disabledParity: JSON.stringify(fixture.disabledParity),
        liveLatency: JSON.stringify(fixture.liveLatency),
    });
    const ready = buildV09StudentReadiness(fixture.manifest, evidence());
    expect(ready.modelFileSha256).toBe(fixture.manifest.modelFileSha256);
    expect(ready.readinessSha256).toHaveLength(64);
    fixture.cpuParity.fixtureModelBound = false;
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("CPU/PyTorch parity");
    fixture.cpuParity.fixtureModelBound = true;
    fixture.disabledParity.trajectoryMismatches = 1;
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("trajectory parity");
    fixture.disabledParity.trajectoryMismatches = 0;
    fixture.liveLatency.modelFileSha256 = "b".repeat(64);
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("another model");
});

test("loaded-host operation-bounded timing and turn overruns cannot unlock untouched confirmation", () => {
    const fixture = readinessFixture();
    const evidence = () => ({
        cpuParity: JSON.stringify(fixture.cpuParity),
        disabledParity: JSON.stringify(fixture.disabledParity),
        liveLatency: JSON.stringify(fixture.liveLatency),
    });
    fixture.liveLatency.executionMode = "operation-bounded";
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("wall-clock turn timing");
    fixture.liveLatency.executionMode = "wall-clock";
    fixture.liveLatency.candidateP99Ms = 1001;
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("within the A19 budget");
    fixture.liveLatency.candidateP99Ms = 703;
    fixture.liveLatency.candidateMaxMs = 1501;
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("within the A19 budget");
    fixture.liveLatency.candidateMaxMs = 1203;
    fixture.liveLatency.productionCpu = false;
    expect(() => buildV09StudentReadiness(fixture.manifest, evidence())).toThrow("production-CPU");
});

function registration(): IV09A19StudentRegistration {
    const used = new Set(
        Object.values(parent.stages)
            .flat()
            .flatMap((seed) => [seed, seed + 1, seed + 2]),
    );
    let next = 1;
    const seeds = (count: number) =>
        Array.from({ length: count }, () => {
            while ([0, 1, 2].some((offset) => used.has(next + offset))) next += 3;
            const result = next;
            for (const offset of [0, 1, 2]) used.add(next + offset);
            next += 3;
            return result;
        });
    const body = {
        schema: "hoc.ai.v0_9_a19_student_evaluation.v1" as const,
        promoted: false as const,
        actorManifestSha256: parent.manifestSha256,
        actorSourceSha256: parent.source.sha256,
        observationSha256: parent.observationSha256,
        lockedModelSha256: null,
        stages: { development: seeds(192), confirmation_r2: seeds(1500), secondary_r4: seeds(750) },
    };
    return { ...body, registrationSha256: fingerprintV09(body) };
}

test("student banks reserve complete independent seed channels and reject rehashed overlap", () => {
    const value = registration();
    expect(() => validateV09StudentRegistration(value, parent)).not.toThrow();
    value.stages.confirmation_r2[0] = parent.stages.corpus_train[0] + 1;
    const { registrationSha256: _sha, ...body } = value;
    expect(fingerprintV09(body)).not.toBe(_sha);
    expect(() => validateV09StudentRegistration({ ...body, registrationSha256: fingerprintV09(body) }, parent)).toThrow(
        "overlap",
    );
});

test("student evaluation can add isolated tools while retaining every actor-era source input", () => {
    const added = { ...files, "src/simulation/new_research.ts": "b".repeat(64) };
    expect(() => assertV09StudentSource(parent, { files: added, sha256: fingerprintV09(added) })).not.toThrow();
    const changed = { ...added, "src/engine/fixture.ts": "c".repeat(64) };
    expect(() => assertV09StudentSource(parent, { files: changed, sha256: fingerprintV09(changed) })).toThrow(
        "actor-era",
    );
});

test("an untrained fixture cannot initialize a strength trial", () => {
    expect(() =>
        buildV09A19StudentManifest({
            parent,
            registration: registration(),
            source: parent.source,
            runtime: Bun.version,
            modelBytes: JSON.stringify({ untrainedDiagnostic: true }),
            diagnosticOnly: false,
            mode: "correction",
            minimumLogitGain: 1,
        }),
    ).toThrow("trained-model receipt");
});

test("diagnostic trials stay in smoke and cannot unlock confirmation by changing a threshold", () => {
    const body = {
        schema: V09_A19_STUDENT_SCHEMA,
        promoted: false as const,
        diagnosticOnly: true,
        parent,
        registration: registration(),
        source: parent.source,
        runtime: Bun.version,
        modelFileSha256: "d".repeat(64),
        acceptedFitReceiptSha256: null,
        mode: "correction" as const,
        minimumLogitGain: 1_000_000,
    };
    const manifest: IV09A19StudentManifest = { ...body, manifestSha256: fingerprintV09(body) };
    expect(() => validateV09A19StudentManifest(manifest)).not.toThrow();
    expect(v09StudentSeeds(manifest, "smoke")).toHaveLength(3);
    expect(() => v09StudentSeeds(manifest, "confirmation_r2")).toThrow("Diagnostic model");
    const changed = { ...body, minimumLogitGain: 0.1 };
    expect(() => validateV09A19StudentManifest({ ...changed, manifestSha256: fingerprintV09(changed) })).toThrow();
});
