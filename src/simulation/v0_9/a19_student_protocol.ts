/** Source- and model-bound student trials. A diagnostic fixture can never unlock confirmation. */
import { createHash } from "node:crypto";
import { fingerprintV09 } from "./protocol";
import { V09_A19_OBSERVATION_SHA256 } from "./a19_observation";
import { V09A19CpuModel } from "./a19_inference";
import { validateV09A19PilotManifest, type IV09A19PilotManifest, type IV09PilotSource } from "./a19_pilot_protocol";

export const V09_A19_STUDENT_SCHEMA = "hoc.ai.v0_9_a19_student_trial.v1" as const;
export const V09_A19_STUDENT_STAGES = { smoke: 3, development: 192, confirmation_r2: 1500, secondary_r4: 750 } as const;
export type V09A19StudentStage = keyof typeof V09_A19_STUDENT_STAGES;

export interface IV09A19StudentRegistration {
    schema: "hoc.ai.v0_9_a19_student_evaluation.v1";
    promoted: false;
    actorManifestSha256: string;
    actorSourceSha256: string;
    observationSha256: string;
    stages: { development: number[]; confirmation_r2: number[]; secondary_r4: number[] };
    lockedModelSha256: null;
    registrationSha256: string;
}

export interface IV09A19StudentManifest {
    schema: typeof V09_A19_STUDENT_SCHEMA;
    promoted: false;
    diagnosticOnly: boolean;
    parent: IV09A19PilotManifest;
    registration: IV09A19StudentRegistration;
    source: IV09PilotSource;
    runtime: string;
    modelFileSha256: string;
    acceptedFitReceiptSha256: string | null;
    mode: "disabled" | "correction";
    minimumLogitGain: number;
    manifestSha256: string;
}

export const v09StudentFileSha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function validateV09StudentRegistration(
    registration: IV09A19StudentRegistration,
    parent: IV09A19PilotManifest,
): void {
    const { registrationSha256, ...unsigned } = registration;
    if (
        registration.schema !== "hoc.ai.v0_9_a19_student_evaluation.v1" ||
        registration.promoted !== false ||
        registration.lockedModelSha256 !== null ||
        fingerprintV09(unsigned) !== registrationSha256 ||
        registration.actorManifestSha256 !== parent.manifestSha256 ||
        registration.actorSourceSha256 !== parent.source.sha256 ||
        registration.observationSha256 !== parent.observationSha256
    )
        throw new Error("Student registration changed or belongs to another actor campaign");
    const channels = new Set<number>();
    for (const seeds of Object.values(parent.stages))
        for (const seed of seeds) for (const offset of [0, 1, 2]) channels.add(seed + offset);
    for (const [stage, count] of Object.entries(V09_A19_STUDENT_STAGES)) {
        if (stage === "smoke") continue;
        const seeds = registration.stages[stage as Exclude<V09A19StudentStage, "smoke">];
        if (!Array.isArray(seeds) || seeds.length !== count) throw new Error("Incomplete reserved student board bank");
        for (const seed of seeds) {
            if (
                !Number.isSafeInteger(seed) ||
                seed < 0 ||
                seed > 0xffffffff - 5 ||
                [0, 1, 2].some((offset) => channels.has(seed + offset))
            )
                throw new Error("Student boards overlap another phase or exceed indexed seed space");
            for (const offset of [0, 1, 2]) channels.add(seed + offset);
        }
    }
}

/** Evaluation may add isolated tools; every actor-era source input must retain its exact bytes. */
export function assertV09StudentSource(parent: IV09A19PilotManifest, source: IV09PilotSource): void {
    if (
        fingerprintV09(source.files) !== source.sha256 ||
        Object.entries(parent.source.files).some(([name, sha]) => source.files[name] !== sha)
    )
        throw new Error("Evaluation changed an actor-era source input; freeze an explicitly reviewed new baseline");
}

export function buildV09A19StudentManifest(input: {
    parent: IV09A19PilotManifest;
    registration: IV09A19StudentRegistration;
    source: IV09PilotSource;
    runtime: string;
    modelBytes: string;
    fitReceiptBytes?: string;
    diagnosticOnly: boolean;
    mode: "disabled" | "correction";
    minimumLogitGain: number;
}): IV09A19StudentManifest {
    validateV09A19PilotManifest(input.parent);
    validateV09StudentRegistration(input.registration, input.parent);
    assertV09StudentSource(input.parent, input.source);
    if (input.runtime !== input.parent.runtime || input.parent.observationSha256 !== V09_A19_OBSERVATION_SHA256)
        throw new Error("Student runtime or observation contract differs from its actor campaign");
    if (
        !Number.isFinite(input.minimumLogitGain) ||
        input.minimumLogitGain <= 0 ||
        (input.mode !== "disabled" && input.mode !== "correction")
    )
        throw new Error("Invalid registered student policy");
    const model = JSON.parse(input.modelBytes);
    const modelFileSha256 = v09StudentFileSha256(input.modelBytes);
    if (input.diagnosticOnly) {
        if (input.minimumLogitGain !== 1_000_000)
            throw new Error("Diagnostic models require the abstaining confidence margin and smoke-only evaluation");
    } else {
        if (model.untrainedDiagnostic === true || !input.fitReceiptBytes)
            throw new Error("Strength evaluation requires an accepted trained-model receipt");
        const receipt = JSON.parse(input.fitReceiptBytes);
        if (
            receipt.promoted !== false ||
            receipt.manifestSha256 !== input.parent.manifestSha256 ||
            receipt.modelFileSha256 !== modelFileSha256 ||
            !Number.isInteger(receipt.epochs) ||
            receipt.epochs < 1 ||
            !Number.isInteger(model.epoch) ||
            model.epoch < 0 ||
            model.epoch >= receipt.epochs ||
            !Number.isFinite(receipt.bestValidationPolicyLoss) ||
            receipt.bestValidationPolicyLoss < 0 ||
            receipt.bestValidationPolicyLoss !== model.validation?.policyLogLoss
        )
            throw new Error("Fitted model and completion receipt do not agree");
    }
    new V09A19CpuModel(model, {
        manifestSha256: input.parent.manifestSha256,
        sourceSha256: input.parent.source.sha256,
    });
    const body = {
        schema: V09_A19_STUDENT_SCHEMA,
        promoted: false as const,
        diagnosticOnly: input.diagnosticOnly,
        parent: input.parent,
        registration: input.registration,
        source: input.source,
        runtime: input.runtime,
        modelFileSha256,
        acceptedFitReceiptSha256: input.fitReceiptBytes ? v09StudentFileSha256(input.fitReceiptBytes) : null,
        mode: input.mode,
        minimumLogitGain: input.minimumLogitGain,
    };
    return { ...body, manifestSha256: fingerprintV09(body) };
}

export function validateV09A19StudentManifest(manifest: IV09A19StudentManifest): void {
    const { manifestSha256, ...body } = manifest;
    if (
        manifest.schema !== V09_A19_STUDENT_SCHEMA ||
        manifest.promoted !== false ||
        fingerprintV09(body) !== manifestSha256 ||
        manifest.runtime !== manifest.parent.runtime ||
        manifest.parent.observationSha256 !== V09_A19_OBSERVATION_SHA256 ||
        !Number.isFinite(manifest.minimumLogitGain) ||
        manifest.minimumLogitGain <= 0 ||
        (manifest.mode !== "disabled" && manifest.mode !== "correction") ||
        !/^[0-9a-f]{64}$/.test(manifest.modelFileSha256) ||
        (manifest.diagnosticOnly && manifest.minimumLogitGain !== 1_000_000) ||
        (!manifest.diagnosticOnly && !manifest.acceptedFitReceiptSha256)
    )
        throw new Error("Invalid student trial manifest");
    validateV09A19PilotManifest(manifest.parent);
    validateV09StudentRegistration(manifest.registration, manifest.parent);
    assertV09StudentSource(manifest.parent, manifest.source);
}

export function v09StudentSeeds(manifest: IV09A19StudentManifest, stage: V09A19StudentStage): readonly number[] {
    if (manifest.diagnosticOnly && stage !== "smoke")
        throw new Error("Diagnostic model cannot consume a strength bank");
    return stage === "smoke"
        ? manifest.registration.stages.development.slice(0, 3)
        : manifest.registration.stages[stage];
}

/** These receipts must come from the locked model, not the untrained architecture smoke. */
export interface IV09A19StudentReadiness {
    schema: "hoc.ai.v0_9_a19_student_readiness.v1";
    manifestSha256: string;
    modelFileSha256: string;
    evidenceSha256: { cpuParity: string; disabledParity: string; liveLatency: string };
    readinessSha256: string;
}

export function buildV09StudentReadiness(
    manifest: IV09A19StudentManifest,
    evidence: { cpuParity: string; disabledParity: string; liveLatency: string },
): IV09A19StudentReadiness {
    if (manifest.diagnosticOnly || manifest.mode !== "correction")
        throw new Error("Only a trained enabled model can qualify for confirmation");
    const cpu = JSON.parse(evidence.cpuParity),
        disabled = JSON.parse(evidence.disabledParity),
        live = JSON.parse(evidence.liveLatency);
    if (
        cpu.schema !== "hoc.ai.v0_9_a19_cpu_inference_diagnostic.v1" ||
        cpu.manifestSha256 !== manifest.parent.manifestSha256 ||
        cpu.sourceSha256 !== manifest.parent.source.sha256 ||
        cpu.modelFileSha256 !== manifest.modelFileSha256 ||
        cpu.fixtureModelBound !== true ||
        cpu.untrainedDiagnostic !== false ||
        cpu.inferenceSourceSha256 !== manifest.source.files["src/simulation/v0_9/a19_inference.ts"] ||
        cpu.runtime !== manifest.runtime ||
        cpu.platform !== "linux" ||
        cpu.architecture !== "x64" ||
        !Number.isInteger(cpu.observations) ||
        cpu.observations < 96 ||
        !Number.isFinite(cpu.maximumAbsoluteError) ||
        cpu.maximumAbsoluteError < 0 ||
        cpu.maximumAbsoluteError > 0.00001 ||
        cpu.tolerance !== 0.00001 ||
        cpu.resolvedRankingMismatches !== 0 ||
        cpu.permutationCases !== cpu.observations ||
        cpu.candidateOrderCases !== cpu.observations
    )
        throw new Error("Confirmation requires model-bound Linux CPU/PyTorch parity");
    for (const report of [disabled, live])
        if (
            report.manifestSha256 !== manifest.manifestSha256 ||
            report.modelFileSha256 !== manifest.modelFileSha256 ||
            report.sourceSha256 !== manifest.source.sha256 ||
            report.runtime !== manifest.runtime ||
            report.platform !== "linux" ||
            report.architecture !== "x64" ||
            report.rejectedActions !== 0
        )
            throw new Error("Confirmation evidence belongs to another model, source, or runtime");
    if (
        disabled.schema !== "hoc.ai.v0_9_a19_disabled_parity.v1" ||
        disabled.diagnosticOnly === true ||
        !Number.isInteger(disabled.games) ||
        disabled.games < 12 ||
        disabled.trajectoryMismatches !== 0 ||
        disabled.actionReferenceMismatches !== 0
    )
        throw new Error("Confirmation requires complete disabled-model trajectory parity");
    const deadline = Number(manifest.parent.baseline.SEARCH_DECISION_DEADLINE_MS),
        breaker = Number(manifest.parent.baseline.SEARCH_CIRCUIT_BREAKER_MS);
    const finitePositive = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;
    if (
        live.schema !== "hoc.ai.v0_9_a19_live_latency.v1" ||
        live.diagnosticOnly === true ||
        live.executionMode !== "wall-clock" ||
        live.modelErrors !== 0 ||
        live.inferenceOverruns !== 0 ||
        live.inferenceReserveMs !== 25 ||
        live.productionCpu !== true ||
        typeof live.cpuIdentity !== "string" ||
        live.cpuIdentity.length < 1 ||
        live.baselineProfileSha256 !== fingerprintV09(manifest.parent.profile) ||
        live.minimumLogitGain !== manifest.minimumLogitGain ||
        live.decisionDeadlineMs !== deadline ||
        live.circuitBreakerMs !== breaker ||
        !finitePositive(deadline) ||
        !finitePositive(breaker) ||
        !Number.isInteger(live.baselineTurns) ||
        live.baselineTurns < 1000 ||
        !Number.isInteger(live.candidateTurns) ||
        live.candidateTurns < 1000 ||
        !Number.isInteger(live.inferredTurns) ||
        live.inferredTurns < 1 ||
        !finitePositive(live.baselineP99Ms) ||
        !finitePositive(live.baselineMaxMs) ||
        !finitePositive(live.candidateP99Ms) ||
        !finitePositive(live.candidateMaxMs) ||
        live.baselineMaxMs < live.baselineP99Ms ||
        live.candidateMaxMs < live.candidateP99Ms ||
        live.candidateP99Ms > Math.max(deadline, live.baselineP99Ms) ||
        live.candidateMaxMs > Math.max(breaker, live.baselineMaxMs)
    )
        throw new Error("Confirmation requires actual production-CPU wall-clock turn timing within the A19 budget");
    const body = {
        schema: "hoc.ai.v0_9_a19_student_readiness.v1" as const,
        manifestSha256: manifest.manifestSha256,
        modelFileSha256: manifest.modelFileSha256,
        evidenceSha256: {
            cpuParity: v09StudentFileSha256(evidence.cpuParity),
            disabledParity: v09StudentFileSha256(evidence.disabledParity),
            liveLatency: v09StudentFileSha256(evidence.liveLatency),
        },
    };
    return { ...body, readinessSha256: fingerprintV09(body) };
}
