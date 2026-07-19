/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import {
    aggregateV07AlignedV2,
    assessV07AlignedV2Final,
    assessV07AlignedV2Promotion,
    evaluateV07AlignedV2OperationalEligibility,
    V07_ALIGNED_96H_V2_CELLS,
    V07_ALIGNED_96H_V2_SEATS,
    type IV07AlignedV2Aggregate,
    type IV07AlignedV2ConfirmPair,
    type IV07AlignedV2GameObservation,
    type IV07AlignedV2PromotionVerdict,
    type IV07AlignedV2ResearchTerminal,
} from "./v0_7_aligned_96h_v2_core";
import {
    assertV07AlignedV2ProductionCatalogInput,
    buildV07AlignedV2ProductionCatalogIdentity,
    V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT,
    V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
    V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL,
} from "./v0_7_aligned_96h_v2_catalog";
import {
    bindV07AlignedV2Candidate,
    bindV07AlignedV2SeedPlan,
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    validateV07AlignedV2CandidateBinding,
    validateV07AlignedV2CheckpointPanelBinding,
    validateV07AlignedV2SeedPlan,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2CheckpointPanelBinding,
    type IV07AlignedV2InjectedSeedPlan,
} from "./v0_7_aligned_96h_v2_protocol";
import {
    V07_ALIGNED_96H_V2_VERSION_PROFILE,
    V08_ALIGNED_96H_V1_VERSION_PROFILE,
    assertAligned96hVersionProfile,
    cloneAligned96hVersionProfile,
    type IAligned96hVersionProfile,
} from "./aligned_96h_version_profile";
import {
    V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
    V08_ALIGNED_V1_PRODUCTION_CANDIDATE_LIMIT,
    assertV08AlignedV1ProductionCatalogInput,
    buildV08AlignedV1ProductionCatalogIdentity,
} from "./v0_8_aligned_96h_v1_catalog";
import {
    bindV08AlignedV1Candidate,
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateBinding,
} from "./v0_8_aligned_96h_v1_protocol";
import {
    aggregateV08AlignedV1,
    assessV08AlignedV1Final,
    assessV08AlignedV1Promotion,
    exactGridCountsV08AlignedV1,
    evaluateV08AlignedV1OperationalEligibility,
    type IV08AlignedV1Aggregate,
    type IV08AlignedV1GameObservation,
    type IV08AlignedV1ResearchTerminal,
} from "./v0_8_aligned_96h_v1_core";

const HOUR_MS = 60 * 60 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBSERVATION_CELL_ORDER = new Map(V07_ALIGNED_96H_V2_CELLS.map((cell, index) => [cell.id, index]));
const OBSERVATION_SEAT_ORDER = new Map(V07_ALIGNED_96H_V2_SEATS.map((seat, index) => [seat, index]));

export type V07AlignedV2OrchestratorMode = "formal" | "synthetic_dry_run";
export type V07AlignedV2OrchestratorPhase = "training" | "confirmation" | "await_final_plan" | "final" | "terminal";

export interface IV07AlignedV2OrchestratorSchedule {
    startAtMs: number;
    trainDeadlineAtMs: number;
    confirmDeadlineAtMs: number;
    finalDeadlineAtMs: number;
}

export interface IV07AlignedV2SeedArtifactRef {
    path: string;
    bytesSha256: string;
    artifactSha256: string;
}

export interface IV07AlignedV2RevealedSeedArtifacts {
    commitment: IV07AlignedV2SeedArtifactRef;
    finalReveal: IV07AlignedV2SeedArtifactRef;
}

export interface IV07AlignedV2OrchestratorDefinition {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_orchestrator_definition" | "v0_8_aligned_96h_v1_orchestrator_definition";
    /** Omitted only for the byte-stable historical v0.7 definition profile. */
    versionProfile?: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    mode: V07AlignedV2OrchestratorMode;
    runId: string;
    createdAtMs: number;
    composedSealSha256: string;
    candidateLimit: number;
    schedule: IV07AlignedV2OrchestratorSchedule;
    candidates: Array<IV07AlignedV2CandidateBinding | IV08AlignedV1CandidateBinding>;
    incumbent: IV07AlignedV2CandidateBinding | IV08AlignedV1CandidateBinding;
    panels: {
        train: IV07AlignedV2CheckpointPanelBinding;
        confirm: IV07AlignedV2CheckpointPanelBinding;
        finalCommitment: IV07AlignedV2CheckpointPanelBinding;
    };
    seedCommitment: IV07AlignedV2SeedArtifactRef;
    definitionSha256: string;
}

export interface IV07AlignedV2OrchestratorDefinitionInput {
    /** Omission preserves the historical v0.7 definition bytes exactly. */
    versionProfile?: typeof V07_ALIGNED_96H_V2_VERSION_PROFILE | typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    mode: V07AlignedV2OrchestratorMode;
    runId: string;
    createdAtMs: number;
    composedSealSha256: string;
    candidateLimit: number;
    schedule: IV07AlignedV2OrchestratorSchedule;
    candidateGenomes: IV07AlignedV2CandidateGenome[];
    incumbentGenome: IV07AlignedV2CandidateGenome;
    trainSeedPlan: IV07AlignedV2InjectedSeedPlan;
    confirmSeedPlan: IV07AlignedV2InjectedSeedPlan;
    finalPanelCommitment: IV07AlignedV2CheckpointPanelBinding;
    seedCommitment: IV07AlignedV2SeedArtifactRef;
}

export interface IV07AlignedV2EvidenceArtifactRef {
    directory: string;
    manifestSha256: string;
}

export interface IV07AlignedV2PanelEvidenceInput {
    panel: IV07AlignedV2CheckpointPanelBinding;
    genomeSha256: string;
    artifacts: IV07AlignedV2EvidenceArtifactRef[];
    observations: IV07AlignedV2GameObservation[];
}

export interface IV07AlignedV2PanelEvidenceSummary {
    schemaVersion: 1;
    panel: IV07AlignedV2CheckpointPanelBinding;
    genomeSha256: string;
    artifacts: IV07AlignedV2EvidenceArtifactRef[];
    observationsSha256: string;
    observations: number;
    aggregate: IV07AlignedV2Aggregate | IV08AlignedV1Aggregate;
    evidenceSha256: string;
}

export interface IV07AlignedV2FrozenCandidate {
    genomeSha256: string;
    trainingEvidenceSha256: string;
    frozenAtMs: number;
    reason: "all_candidates_complete" | "train_deadline";
    freezeArtifactSha256: string;
}

export type V07AlignedV2TerminalReason =
    | "no_eligible_candidate"
    | "confirm_hold"
    | "train_catalog_incomplete"
    | "train_deadline_after_confirm_cutoff"
    | "confirm_deadline"
    | "final_deadline"
    | "final_assessment";

export interface IV07AlignedV2OrchestratorTerminal {
    schemaVersion: 1;
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    frozenCandidateSha256: string | null;
    reason: V07AlignedV2TerminalReason;
    verdict: "PASS" | "FAIL" | "HOLD" | "INCOMPLETE";
    promotion: IV07AlignedV2PromotionVerdict | null;
    final: IV07AlignedV2ResearchTerminal | IV08AlignedV1ResearchTerminal | null;
    terminalSha256: string;
}

interface IV07AlignedV2EventBase {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_transition";
    runFingerprint: string;
    sequence: number;
    previousEventSha256: string | null;
    commandId: string;
    commandSha256: string;
    nowMs: number;
    eventSha256: string;
}

export type IV07AlignedV2OrchestratorEvent = IV07AlignedV2EventBase &
    (
        | { eventType: "train_recorded"; payload: { evidence: IV07AlignedV2PanelEvidenceSummary } }
        | { eventType: "candidate_frozen"; payload: { frozen: IV07AlignedV2FrozenCandidate } }
        | {
              eventType: "final_plan_revealed";
              payload: {
                  panel: IV07AlignedV2CheckpointPanelBinding;
                  seedArtifacts: IV07AlignedV2RevealedSeedArtifacts;
                  threePanelSeedSetSha256: string;
              };
          }
        | {
              eventType: "confirmation_recorded";
              payload: {
                  challenger: IV07AlignedV2PanelEvidenceSummary;
                  incumbent: IV07AlignedV2PanelEvidenceSummary;
                  promotion: IV07AlignedV2PromotionVerdict;
                  terminal: IV07AlignedV2OrchestratorTerminal | null;
              };
          }
        | {
              eventType: "final_recorded";
              payload: { evidence: IV07AlignedV2PanelEvidenceSummary; terminal: IV07AlignedV2OrchestratorTerminal };
          }
        | { eventType: "terminal_recorded"; payload: { terminal: IV07AlignedV2OrchestratorTerminal } }
    );

export interface IV07AlignedV2OrchestratorState {
    definitionSha256: string;
    runFingerprint: string;
    phase: V07AlignedV2OrchestratorPhase;
    nextSequence: number;
    eventHeadSha256: string | null;
    lastNowMs: number;
    training: IV07AlignedV2PanelEvidenceSummary[];
    frozen: IV07AlignedV2FrozenCandidate | null;
    finalPlanRevealed: boolean;
    revealedSeedArtifacts: IV07AlignedV2RevealedSeedArtifacts | null;
    confirmation: {
        challenger: IV07AlignedV2PanelEvidenceSummary;
        incumbent: IV07AlignedV2PanelEvidenceSummary;
        promotion: IV07AlignedV2PromotionVerdict;
    } | null;
    terminal: IV07AlignedV2OrchestratorTerminal | null;
}

interface ICommandBase {
    commandId: string;
    nowMs: number;
}

export type IV07AlignedV2OrchestratorCommand =
    | (ICommandBase & {
          type: "record_train";
          candidateGenomeSha256: string;
          evidence: IV07AlignedV2PanelEvidenceInput;
      })
    | (ICommandBase & { type: "freeze_candidate" })
    | (ICommandBase & {
          type: "reveal_final_plan";
          trainSeedPlan: IV07AlignedV2InjectedSeedPlan;
          confirmSeedPlan: IV07AlignedV2InjectedSeedPlan;
          finalSeedPlan: IV07AlignedV2InjectedSeedPlan;
          seedArtifacts: IV07AlignedV2RevealedSeedArtifacts;
      })
    | (ICommandBase & {
          type: "record_confirmation";
          challenger: IV07AlignedV2PanelEvidenceInput;
          incumbent: IV07AlignedV2PanelEvidenceInput;
      })
    | (ICommandBase & { type: "record_final"; evidence: IV07AlignedV2PanelEvidenceInput })
    | (ICommandBase & { type: "tick" });

export interface IV07AlignedV2OrchestratorApplyResult {
    events: IV07AlignedV2OrchestratorEvent[];
    state: IV07AlignedV2OrchestratorState;
    appended: IV07AlignedV2OrchestratorEvent | null;
    reused: boolean;
}

export type V07AlignedV2EvidenceResolver = (
    summary: IV07AlignedV2PanelEvidenceSummary,
) => readonly IV07AlignedV2GameObservation[];

export interface IV07AlignedV2ResolvedSeedPlans {
    train: IV07AlignedV2InjectedSeedPlan;
    confirm: IV07AlignedV2InjectedSeedPlan;
    final: IV07AlignedV2InjectedSeedPlan;
}

export interface IV07AlignedV2ResolvedSeedCommitment {
    train: IV07AlignedV2InjectedSeedPlan;
    confirm: IV07AlignedV2InjectedSeedPlan;
    final: {
        panelId: string;
        purpose: "final";
        scenariosPerCell: number;
        denysetSha256: string;
        panelFingerprint: string;
        taskCount: number;
        tasksSha256: string;
    };
}

export type V07AlignedV2SeedCommitmentResolver = (
    artifact: IV07AlignedV2SeedArtifactRef,
) => IV07AlignedV2ResolvedSeedCommitment;

export type V07AlignedV2SeedPlanResolver = (
    artifacts: IV07AlignedV2RevealedSeedArtifacts,
    frozen: IV07AlignedV2FrozenCandidate,
) => IV07AlignedV2ResolvedSeedPlans;

export interface IV07AlignedV2OrchestratorReplayResolvers {
    evidence?: V07AlignedV2EvidenceResolver;
    seedCommitment?: V07AlignedV2SeedCommitmentResolver;
    seedPlans?: V07AlignedV2SeedPlanResolver;
}

function requireSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw new Error(`${label} must be a nonnegative integer`);
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256`);
    }
}

function validateSeedArtifactRef(value: IV07AlignedV2SeedArtifactRef, label: string): IV07AlignedV2SeedArtifactRef {
    if (!isObjectRecord(value) || !hasExactKeys(value, ["path", "bytesSha256", "artifactSha256"])) {
        throw new Error(`${label} fields are not exact`);
    }
    const segments = typeof value.path === "string" ? value.path.split("/") : [];
    if (
        typeof value.path !== "string" ||
        !value.path.length ||
        value.path.startsWith("/") ||
        value.path.includes("\\") ||
        segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
        throw new Error(`${label}.path must be a safe run-relative artifact path`);
    }
    requireSha256(value.bytesSha256, `${label}.bytesSha256`);
    requireSha256(value.artifactSha256, `${label}.artifactSha256`);
    return { path: value.path, bytesSha256: value.bytesSha256, artifactSha256: value.artifactSha256 };
}

function validateRevealedSeedArtifacts(value: IV07AlignedV2RevealedSeedArtifacts): IV07AlignedV2RevealedSeedArtifacts {
    if (!isObjectRecord(value) || !hasExactKeys(value, ["commitment", "finalReveal"])) {
        throw new Error("aligned v2 revealed seed artifact fields are not exact");
    }
    const commitment = validateSeedArtifactRef(value.commitment, "seedArtifacts.commitment");
    const finalReveal = validateSeedArtifactRef(value.finalReveal, "seedArtifacts.finalReveal");
    if (commitment.path === finalReveal.path) {
        throw new Error("aligned v2 seed commitment and final reveal paths must be distinct");
    }
    return { commitment, finalReveal };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

function validateSchedule(schedule: IV07AlignedV2OrchestratorSchedule): void {
    for (const [label, value] of Object.entries(schedule)) requireSafeInteger(value, `schedule.${label}`);
    if (!(
        schedule.startAtMs < schedule.trainDeadlineAtMs &&
        schedule.trainDeadlineAtMs < schedule.confirmDeadlineAtMs &&
        schedule.confirmDeadlineAtMs < schedule.finalDeadlineAtMs
    )) {
        throw new Error("aligned v2 orchestration deadlines must be strictly ordered");
    }
    if (schedule.finalDeadlineAtMs - schedule.startAtMs !== 96 * HOUR_MS) {
        throw new Error("aligned v2 orchestration must have an immutable 96-hour outer deadline");
    }
    if (schedule.confirmDeadlineAtMs > schedule.finalDeadlineAtMs - 36 * HOUR_MS) {
        throw new Error("aligned v2 orchestration must reserve at least 36 hours for final evaluation");
    }
}

function uniquePlanSeeds(plan: IV07AlignedV2InjectedSeedPlan): Set<number> {
    validateV07AlignedV2SeedPlan(plan);
    const seeds = new Set<number>();
    for (const pair of plan.pairs) {
        for (const seat of ["candidate_green", "candidate_red"] as const) {
            for (const seed of pair.seats[seat].setupSeeds) seeds.add(seed);
            seeds.add(pair.seats[seat].combatSeed);
        }
    }
    return seeds;
}

export function assertV07AlignedV2InjectedPlansDisjoint(plans: readonly IV07AlignedV2InjectedSeedPlan[]): string {
    const seen = new Map<number, string>();
    const panelFingerprints: string[] = [];
    for (const plan of plans) {
        const binding = bindV07AlignedV2SeedPlan(plan);
        panelFingerprints.push(binding.panelFingerprint);
        for (const seed of uniquePlanSeeds(plan)) {
            const prior = seen.get(seed);
            if (prior) throw new Error(`aligned v2 cross-panel seed collision ${seed}: ${prior} and ${plan.panelId}`);
            seen.set(seed, plan.panelId);
        }
    }
    if (new Set(panelFingerprints).size !== panelFingerprints.length) {
        throw new Error("aligned v2 injected train/confirm/final panel fingerprints must be distinct");
    }
    return fingerprintV07AlignedV2(
        [...seen.entries()].sort(([left], [right]) => left - right).map(([seed, panelId]) => ({ seed, panelId })),
    );
}

function expectedPanelScenarios(mode: V07AlignedV2OrchestratorMode, purpose: "confirm" | "final"): number {
    if (mode === "synthetic_dry_run") return 1;
    return purpose === "confirm" ? 1000 : 2000;
}

function definitionVersionProfile(
    value: IAligned96hVersionProfile | undefined,
): typeof V07_ALIGNED_96H_V2_VERSION_PROFILE | typeof V08_ALIGNED_96H_V1_VERSION_PROFILE {
    if (value === undefined) return V07_ALIGNED_96H_V2_VERSION_PROFILE;
    if (value.candidate === V07_ALIGNED_96H_V2_VERSION_PROFILE.candidate) {
        assertAligned96hVersionProfile(value, V07_ALIGNED_96H_V2_VERSION_PROFILE);
        return V07_ALIGNED_96H_V2_VERSION_PROFILE;
    }
    assertAligned96hVersionProfile(value, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    return V08_ALIGNED_96H_V1_VERSION_PROFILE;
}

const isV08AlignedV1Profile = (
    profile: typeof V07_ALIGNED_96H_V2_VERSION_PROFILE | typeof V08_ALIGNED_96H_V1_VERSION_PROFILE,
): profile is typeof V08_ALIGNED_96H_V1_VERSION_PROFILE =>
    profile.candidate === V08_ALIGNED_96H_V1_VERSION_PROFILE.candidate;

const isV08AlignedV1Definition = (definition: IV07AlignedV2OrchestratorDefinition): boolean =>
    definition.artifactKind === "v0_8_aligned_96h_v1_orchestrator_definition";

function assessDefinitionFinal(
    definition: IV07AlignedV2OrchestratorDefinition,
    observations: readonly IV07AlignedV2GameObservation[],
): IV07AlignedV2ResearchTerminal | IV08AlignedV1ResearchTerminal {
    return definition.artifactKind === "v0_8_aligned_96h_v1_orchestrator_definition"
        ? assessV08AlignedV1Final(observations as IV08AlignedV1GameObservation[])
        : assessV07AlignedV2Final(observations);
}

function assessDefinitionPromotion(
    definition: IV07AlignedV2OrchestratorDefinition,
    pairs: readonly IV07AlignedV2ConfirmPair[],
): IV07AlignedV2PromotionVerdict {
    return isV08AlignedV1Definition(definition)
        ? assessV08AlignedV1Promotion(pairs)
        : assessV07AlignedV2Promotion(pairs);
}

export function createV07AlignedV2OrchestratorDefinition(
    input: IV07AlignedV2OrchestratorDefinitionInput,
): IV07AlignedV2OrchestratorDefinition {
    const versionProfile = definitionVersionProfile(input.versionProfile);
    const v08Profile = isV08AlignedV1Profile(versionProfile);
    if (!(["formal", "synthetic_dry_run"] as const).includes(input.mode)) {
        throw new Error("aligned v2 orchestrator mode is invalid");
    }
    if (!input.runId.trim()) throw new Error("aligned v2 orchestrator runId must not be empty");
    requireSafeInteger(input.createdAtMs, "createdAtMs");
    requireSha256(input.composedSealSha256, "composedSealSha256");
    requireSafeInteger(input.candidateLimit, "candidateLimit");
    if (input.candidateLimit < 1 || input.candidateLimit > 64) {
        throw new Error("aligned v2 candidateLimit must be within 1..64");
    }
    validateSchedule(input.schedule);
    if (input.createdAtMs > input.schedule.startAtMs) {
        throw new Error("aligned v2 definition cannot be created after its immutable start time");
    }
    if (input.mode === "formal") {
        if (v08Profile) {
            assertV08AlignedV1ProductionCatalogInput({
                versionProfile,
                candidateLimit: input.candidateLimit,
                candidateGenomes: input.candidateGenomes,
                incumbentGenome: input.incumbentGenome,
                trainScenariosPerCell: input.trainSeedPlan.scenariosPerCell,
            });
        } else {
            assertV07AlignedV2ProductionCatalogInput({
                candidateLimit: input.candidateLimit,
                candidateGenomes: input.candidateGenomes,
                incumbentGenome: input.incumbentGenome,
                trainScenariosPerCell: input.trainSeedPlan.scenariosPerCell,
            });
        }
    }
    if (!input.candidateGenomes.length || input.candidateGenomes.length > input.candidateLimit) {
        throw new Error("aligned v2 candidate catalog is empty or exceeds its finite limit");
    }
    const bindCandidate = v08Profile ? bindV08AlignedV1Candidate : bindV07AlignedV2Candidate;
    const candidates = input.candidateGenomes
        .map((genome) => bindCandidate(genome))
        .sort((left, right) => left.genomeSha256.localeCompare(right.genomeSha256));
    const incumbent = bindCandidate(input.incumbentGenome);
    const genomeHashes = candidates.map((candidate) => candidate.genomeSha256);
    if (new Set(genomeHashes).size !== genomeHashes.length || genomeHashes.includes(incumbent.genomeSha256)) {
        throw new Error("aligned v2 candidate catalog and incumbent genome hashes must be unique");
    }
    const train = bindV07AlignedV2SeedPlan(input.trainSeedPlan);
    const confirm = bindV07AlignedV2SeedPlan(input.confirmSeedPlan);
    const finalCommitment = validateV07AlignedV2CheckpointPanelBinding(input.finalPanelCommitment);
    const seedCommitment = validateSeedArtifactRef(input.seedCommitment, "seedCommitment");
    if (
        train.purpose !== "train" ||
        confirm.purpose !== "confirm" ||
        finalCommitment.mode !== "seed_plan" ||
        finalCommitment.purpose !== "final" ||
        confirm.scenariosPerCell !== expectedPanelScenarios(input.mode, "confirm") ||
        finalCommitment.scenariosPerCell !== expectedPanelScenarios(input.mode, "final")
    ) {
        throw new Error("aligned v2 definition panel purposes or formal sample sizes are invalid");
    }
    if (input.mode === "formal" && v08Profile) {
        exactGridCountsV08AlignedV1(train.scenariosPerCell);
        exactGridCountsV08AlignedV1(confirm.scenariosPerCell);
        exactGridCountsV08AlignedV1(finalCommitment.scenariosPerCell);
    }
    if (
        new Set([train.panelId, confirm.panelId, finalCommitment.panelId]).size !== 3 ||
        new Set([train.panelFingerprint, confirm.panelFingerprint, finalCommitment.panelFingerprint]).size !== 3
    ) {
        throw new Error("aligned v2 train, confirm, and final panels must be separate immutable panels");
    }
    assertV07AlignedV2InjectedPlansDisjoint([input.trainSeedPlan, input.confirmSeedPlan]);
    if (v08Profile) {
        const unsigned = {
            schemaVersion: 1 as const,
            artifactKind: "v0_8_aligned_96h_v1_orchestrator_definition" as const,
            versionProfile: cloneAligned96hVersionProfile(versionProfile),
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            mode: input.mode,
            runId: input.runId,
            createdAtMs: input.createdAtMs,
            composedSealSha256: input.composedSealSha256,
            candidateLimit: input.candidateLimit,
            schedule: { ...input.schedule },
            candidates,
            incumbent,
            panels: { train, confirm, finalCommitment },
            seedCommitment,
        };
        return { ...unsigned, definitionSha256: fingerprintV07AlignedV2(unsigned) };
    }
    const legacyUnsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_orchestrator_definition" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        mode: input.mode,
        runId: input.runId,
        createdAtMs: input.createdAtMs,
        composedSealSha256: input.composedSealSha256,
        candidateLimit: input.candidateLimit,
        schedule: { ...input.schedule },
        candidates,
        incumbent,
        panels: { train, confirm, finalCommitment },
        seedCommitment,
    };
    return { ...legacyUnsigned, definitionSha256: fingerprintV07AlignedV2(legacyUnsigned) };
}

export function validateV07AlignedV2OrchestratorDefinition(
    definition: IV07AlignedV2OrchestratorDefinition,
): IV07AlignedV2OrchestratorDefinition {
    validateDefinitionWithoutSeedPlans(definition);
    return definition;
}

function normalizeArtifacts(
    artifacts: readonly IV07AlignedV2EvidenceArtifactRef[],
): IV07AlignedV2EvidenceArtifactRef[] {
    if (!Array.isArray(artifacts)) throw new Error("aligned v2 panel evidence artifacts must be an array");
    if (!artifacts.length) throw new Error("aligned v2 panel evidence must reference at least one persisted shard");
    const normalized = artifacts
        .map((artifact) => {
            if (
                !isObjectRecord(artifact) ||
                !hasExactKeys(artifact, ["directory", "manifestSha256"]) ||
                typeof artifact.directory !== "string" ||
                typeof artifact.manifestSha256 !== "string"
            ) {
                throw new Error("aligned v2 evidence artifact fields are not exact");
            }
            const directory = artifact.directory;
            const manifestSha256 = artifact.manifestSha256;
            const segments = directory.split("/");
            if (
                !directory.length ||
                directory.startsWith("/") ||
                directory.includes("\\") ||
                segments.some((segment) => !segment || segment === "." || segment === "..")
            ) {
                throw new Error("aligned v2 evidence artifact directory must be a safe run-relative path");
            }
            requireSha256(manifestSha256, "evidence manifestSha256");
            return { directory, manifestSha256 };
        })
        .sort((left, right) => left.directory.localeCompare(right.directory));
    if (new Set(normalized.map((artifact) => artifact.directory)).size !== normalized.length) {
        throw new Error("aligned v2 panel evidence repeats an artifact directory");
    }
    return normalized;
}

interface IPreparedEvidence {
    summary: IV07AlignedV2PanelEvidenceSummary;
    observations: IV07AlignedV2GameObservation[];
}

function prepareEvidence(
    input: IV07AlignedV2PanelEvidenceInput,
    expectedPanel: IV07AlignedV2CheckpointPanelBinding,
    expectedGenomeSha256: string,
    v08Definition: boolean,
): IPreparedEvidence {
    if (
        canonicalV07AlignedV2Json(input.panel) !== canonicalV07AlignedV2Json(expectedPanel) ||
        input.genomeSha256 !== expectedGenomeSha256
    ) {
        throw new Error("aligned v2 panel evidence does not match its precommitted panel/genome");
    }
    const artifacts = normalizeArtifacts(input.artifacts);
    const observations = [...input.observations].sort(
        (left, right) =>
            OBSERVATION_CELL_ORDER.get(left.cellId)! - OBSERVATION_CELL_ORDER.get(right.cellId)! ||
            (left.scenarioId < right.scenarioId ? -1 : left.scenarioId > right.scenarioId ? 1 : 0) ||
            OBSERVATION_SEAT_ORDER.get(left.candidateSeat)! - OBSERVATION_SEAT_ORDER.get(right.candidateSeat)!,
    );
    const aggregate = v08Definition
        ? aggregateV08AlignedV1(observations as IV08AlignedV1GameObservation[], {
              expectedGamesPerCellSeat: expectedPanel.scenariosPerCell,
              requireExactGridCoverage: expectedPanel.scenariosPerCell !== 1,
          })
        : aggregateV07AlignedV2(observations, {
              expectedGamesPerCellSeat: expectedPanel.scenariosPerCell,
          });
    if (!aggregate.complete) throw new Error("aligned v2 panel evidence is incomplete");
    const unsigned = {
        schemaVersion: 1 as const,
        panel: expectedPanel,
        genomeSha256: expectedGenomeSha256,
        artifacts,
        observationsSha256: fingerprintV07AlignedV2(observations),
        observations: observations.length,
        aggregate,
    };
    return {
        summary: { ...unsigned, evidenceSha256: fingerprintV07AlignedV2(unsigned) },
        observations,
    };
}

function summarizeEvidence(
    input: IV07AlignedV2PanelEvidenceInput,
    expectedPanel: IV07AlignedV2CheckpointPanelBinding,
    expectedGenomeSha256: string,
    v08Definition: boolean,
): IV07AlignedV2PanelEvidenceSummary {
    return prepareEvidence(input, expectedPanel, expectedGenomeSha256, v08Definition).summary;
}

function validateEvidenceSummary(summary: IV07AlignedV2PanelEvidenceSummary): void {
    if (
        !isObjectRecord(summary) ||
        !hasExactKeys(summary, [
            "schemaVersion",
            "panel",
            "genomeSha256",
            "artifacts",
            "observationsSha256",
            "observations",
            "aggregate",
            "evidenceSha256",
        ]) ||
        summary.schemaVersion !== 1
    ) {
        throw new Error("aligned v2 panel evidence summary fields/header are invalid");
    }
    const unsigned = { ...summary };
    delete (unsigned as Partial<IV07AlignedV2PanelEvidenceSummary>).evidenceSha256;
    if (summary.evidenceSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 panel evidence summary self-hash mismatch");
    }
    validateV07AlignedV2CheckpointPanelBinding(summary.panel);
    requireSha256(summary.genomeSha256, "evidence genomeSha256");
    requireSha256(summary.observationsSha256, "evidence observationsSha256");
    const normalizedArtifacts = normalizeArtifacts(summary.artifacts);
    if (canonicalV07AlignedV2Json(summary.artifacts) !== canonicalV07AlignedV2Json(normalizedArtifacts)) {
        throw new Error("aligned v2 panel evidence artifact references are not in canonical order");
    }
}

function evidenceEligible(summary: IV07AlignedV2PanelEvidenceSummary, v08Definition: boolean): boolean {
    const operational = v08Definition
        ? evaluateV08AlignedV1OperationalEligibility(summary.aggregate as IV08AlignedV1Aggregate)
        : evaluateV07AlignedV2OperationalEligibility(summary.aggregate as IV07AlignedV2Aggregate);
    return (
        summary.aggregate.complete &&
        summary.aggregate.integrity.passed &&
        operational.passed &&
        summary.aggregate.objective.minimumCellSeatDecisiveWinRate !== null
    );
}

function selectBestTraining(
    training: readonly IV07AlignedV2PanelEvidenceSummary[],
    v08Definition: boolean,
): IV07AlignedV2PanelEvidenceSummary | null {
    const eligible = training.filter((summary) => evidenceEligible(summary, v08Definition));
    eligible.sort((left, right) => {
        const leftMin = left.aggregate.objective.minimumCellSeatDecisiveWinRate!;
        const rightMin = right.aggregate.objective.minimumCellSeatDecisiveWinRate!;
        return (
            rightMin - leftMin ||
            (right.aggregate.pooled.decisiveWinRate ?? -1) - (left.aggregate.pooled.decisiveWinRate ?? -1) ||
            left.aggregate.pooled.drawOrArmageddonRate - right.aggregate.pooled.drawOrArmageddonRate ||
            left.genomeSha256.localeCompare(right.genomeSha256)
        );
    });
    return eligible[0] ?? null;
}

function pairConfirmObservations(
    challenger: readonly IV07AlignedV2GameObservation[],
    incumbent: readonly IV07AlignedV2GameObservation[],
): IV07AlignedV2ConfirmPair[] {
    const key = (row: IV07AlignedV2GameObservation): string => `${row.cellId}|${row.candidateSeat}|${row.scenarioId}`;
    const incumbentByKey = new Map(incumbent.map((row) => [key(row), row]));
    if (incumbentByKey.size !== incumbent.length || challenger.length !== incumbent.length) {
        throw new Error("aligned v2 confirmation panels do not contain one-to-one scenario rows");
    }
    const pairs = challenger.map((row): IV07AlignedV2ConfirmPair => {
        const incumbentRow = incumbentByKey.get(key(row));
        if (!incumbentRow) throw new Error(`aligned v2 confirmation incumbent omitted ${key(row)}`);
        return { challenger: row, incumbent: incumbentRow };
    });
    if (new Set(challenger.map(key)).size !== challenger.length) {
        throw new Error("aligned v2 confirmation challenger repeats a scenario row");
    }
    return pairs;
}

function createTerminal(
    definition: IV07AlignedV2OrchestratorDefinition,
    frozenCandidateSha256: string | null,
    reason: V07AlignedV2TerminalReason,
    verdict: IV07AlignedV2OrchestratorTerminal["verdict"],
    promotion: IV07AlignedV2PromotionVerdict | null = null,
    final: IV07AlignedV2ResearchTerminal | IV08AlignedV1ResearchTerminal | null = null,
): IV07AlignedV2OrchestratorTerminal {
    const unsigned = {
        schemaVersion: 1 as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runFingerprint: definition.definitionSha256,
        frozenCandidateSha256,
        reason,
        verdict,
        promotion,
        final,
    };
    return { ...unsigned, terminalSha256: fingerprintV07AlignedV2(unsigned) };
}

function validateTerminal(terminal: IV07AlignedV2OrchestratorTerminal): void {
    if (
        !isObjectRecord(terminal) ||
        !hasExactKeys(terminal, [
            "schemaVersion",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "frozenCandidateSha256",
            "reason",
            "verdict",
            "promotion",
            "final",
            "terminalSha256",
        ]) ||
        terminal.schemaVersion !== 1
    ) {
        throw new Error("aligned v2 orchestrator terminal fields/header are invalid");
    }
    const unsigned = { ...terminal };
    delete (unsigned as Partial<IV07AlignedV2OrchestratorTerminal>).terminalSha256;
    if (
        terminal.status !== "research_only_no_bake" ||
        terminal.automaticBake !== false ||
        terminal.automaticDeploy !== false ||
        !(
            [
                "no_eligible_candidate",
                "confirm_hold",
                "train_catalog_incomplete",
                "train_deadline_after_confirm_cutoff",
                "confirm_deadline",
                "final_deadline",
                "final_assessment",
            ] as const
        ).includes(terminal.reason) ||
        !(["PASS", "FAIL", "HOLD", "INCOMPLETE"] as const).includes(terminal.verdict) ||
        terminal.terminalSha256 !== fingerprintV07AlignedV2(unsigned)
    ) {
        throw new Error("aligned v2 orchestrator terminal is invalid");
    }
    requireSha256(terminal.runFingerprint, "terminal.runFingerprint");
    if (terminal.frozenCandidateSha256 !== null) {
        requireSha256(terminal.frozenCandidateSha256, "terminal.frozenCandidateSha256");
    }
}

function initialState(definition: IV07AlignedV2OrchestratorDefinition): IV07AlignedV2OrchestratorState {
    return {
        definitionSha256: definition.definitionSha256,
        runFingerprint: definition.definitionSha256,
        phase: "training",
        nextSequence: 0,
        eventHeadSha256: null,
        lastNowMs: definition.schedule.startAtMs,
        training: [],
        frozen: null,
        finalPlanRevealed: false,
        revealedSeedArtifacts: null,
        confirmation: null,
        terminal: null,
    };
}

function eventUnsigned(event: IV07AlignedV2OrchestratorEvent): Omit<IV07AlignedV2OrchestratorEvent, "eventSha256"> {
    const unsigned = { ...event };
    delete (unsigned as Partial<IV07AlignedV2OrchestratorEvent>).eventSha256;
    return unsigned as Omit<IV07AlignedV2OrchestratorEvent, "eventSha256">;
}

function validateEventBase(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    event: IV07AlignedV2OrchestratorEvent,
    commandIds: Set<string>,
): void {
    if (
        !isObjectRecord(event) ||
        !hasExactKeys(event, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "sequence",
            "previousEventSha256",
            "commandId",
            "commandSha256",
            "nowMs",
            "eventType",
            "payload",
            "eventSha256",
        ]) ||
        !isObjectRecord(event.payload)
    ) {
        throw new Error("aligned v2 transition fields are not exact");
    }
    requireSafeInteger(event.sequence, "transition.sequence");
    requireSafeInteger(event.nowMs, `transition ${event.sequence} nowMs`);
    if (typeof event.commandId !== "string" || !event.commandId.trim()) {
        throw new Error(`aligned v2 transition ${event.sequence} commandId must not be empty`);
    }
    if (event.previousEventSha256 !== null) {
        requireSha256(event.previousEventSha256, `transition ${event.sequence} previousEventSha256`);
    }
    requireSha256(event.eventSha256, `transition ${event.sequence} eventSha256`);
    const payloadKeys: Record<IV07AlignedV2OrchestratorEvent["eventType"], readonly string[]> = {
        train_recorded: ["evidence"],
        candidate_frozen: ["frozen"],
        final_plan_revealed: ["panel", "seedArtifacts", "threePanelSeedSetSha256"],
        confirmation_recorded: ["challenger", "incumbent", "promotion", "terminal"],
        final_recorded: ["evidence", "terminal"],
        terminal_recorded: ["terminal"],
    };
    if (!payloadKeys[event.eventType] || !hasExactKeys(event.payload, payloadKeys[event.eventType])) {
        throw new Error(`aligned v2 transition ${event.sequence} payload fields are not exact`);
    }
    if (
        event.schemaVersion !== 1 ||
        event.artifactKind !== "v0_7_aligned_96h_v2_transition" ||
        event.runFingerprint !== definition.definitionSha256 ||
        event.sequence !== state.nextSequence ||
        event.previousEventSha256 !== state.eventHeadSha256 ||
        event.nowMs < state.lastNowMs ||
        commandIds.has(event.commandId)
    ) {
        throw new Error(`aligned v2 transition ${event.sequence} breaks its immutable chain`);
    }
    requireSha256(event.commandSha256, `transition ${event.sequence} commandSha256`);
    if (event.eventSha256 !== fingerprintV07AlignedV2(eventUnsigned(event))) {
        throw new Error(`aligned v2 transition ${event.sequence} self-hash mismatch`);
    }
    commandIds.add(event.commandId);
}

function applyStoredEvent(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    event: IV07AlignedV2OrchestratorEvent,
): void {
    switch (event.eventType) {
        case "train_recorded": {
            const evidence = event.payload.evidence;
            validateEvidenceSummary(evidence);
            if (
                state.phase !== "training" ||
                event.nowMs >= definition.schedule.trainDeadlineAtMs ||
                canonicalV07AlignedV2Json(evidence.panel) !== canonicalV07AlignedV2Json(definition.panels.train) ||
                !definition.candidates.some((candidate) => candidate.genomeSha256 === evidence.genomeSha256) ||
                state.training.some((entry) => entry.genomeSha256 === evidence.genomeSha256)
            ) {
                throw new Error("aligned v2 train transition is illegal or duplicated");
            }
            state.training.push(evidence);
            break;
        }
        case "candidate_frozen": {
            const best = selectBestTraining(state.training, isV08AlignedV1Definition(definition));
            const { frozen } = event.payload;
            if (
                state.phase !== "training" ||
                !best ||
                !isObjectRecord(frozen) ||
                !hasExactKeys(frozen, [
                    "genomeSha256",
                    "trainingEvidenceSha256",
                    "frozenAtMs",
                    "reason",
                    "freezeArtifactSha256",
                ]) ||
                !(frozen.reason === "all_candidates_complete" || frozen.reason === "train_deadline") ||
                frozen.genomeSha256 !== best.genomeSha256 ||
                frozen.trainingEvidenceSha256 !== best.evidenceSha256 ||
                frozen.frozenAtMs !== event.nowMs ||
                (frozen.reason === "all_candidates_complete" &&
                    (state.training.length !== definition.candidates.length ||
                        event.nowMs >= definition.schedule.trainDeadlineAtMs)) ||
                (frozen.reason === "train_deadline" &&
                    (state.training.length !== definition.candidates.length ||
                        event.nowMs < definition.schedule.trainDeadlineAtMs ||
                        event.nowMs >= definition.schedule.confirmDeadlineAtMs))
            ) {
                throw new Error("aligned v2 frozen candidate is not the deterministic eligible max-min selection");
            }
            const frozenUnsigned = { ...frozen };
            delete (frozenUnsigned as Partial<IV07AlignedV2FrozenCandidate>).freezeArtifactSha256;
            if (frozen.freezeArtifactSha256 !== fingerprintV07AlignedV2(frozenUnsigned)) {
                throw new Error("aligned v2 frozen candidate self-hash mismatch");
            }
            state.frozen = frozen;
            state.phase = "confirmation";
            break;
        }
        case "final_plan_revealed": {
            const seedArtifacts = validateRevealedSeedArtifacts(event.payload.seedArtifacts);
            if (
                !state.frozen ||
                state.finalPlanRevealed ||
                !(state.phase === "confirmation" || state.phase === "await_final_plan") ||
                (state.phase === "confirmation" && event.nowMs >= definition.schedule.confirmDeadlineAtMs) ||
                (state.phase === "await_final_plan" && event.nowMs >= definition.schedule.finalDeadlineAtMs) ||
                canonicalV07AlignedV2Json(event.payload.panel) !==
                    canonicalV07AlignedV2Json(definition.panels.finalCommitment) ||
                canonicalV07AlignedV2Json(seedArtifacts.commitment) !==
                    canonicalV07AlignedV2Json(definition.seedCommitment)
            ) {
                throw new Error("aligned v2 final plan reveal is illegal or does not open its commitment");
            }
            requireSha256(event.payload.threePanelSeedSetSha256, "threePanelSeedSetSha256");
            state.finalPlanRevealed = true;
            state.revealedSeedArtifacts = seedArtifacts;
            if (state.phase === "await_final_plan") state.phase = "final";
            break;
        }
        case "confirmation_recorded": {
            const { challenger, incumbent, promotion, terminal } = event.payload;
            validateEvidenceSummary(challenger);
            validateEvidenceSummary(incumbent);
            if (
                state.phase !== "confirmation" ||
                event.nowMs >= definition.schedule.confirmDeadlineAtMs ||
                !state.frozen ||
                challenger.genomeSha256 !== state.frozen.genomeSha256 ||
                incumbent.genomeSha256 !== definition.incumbent.genomeSha256 ||
                canonicalV07AlignedV2Json(challenger.panel) !== canonicalV07AlignedV2Json(definition.panels.confirm) ||
                canonicalV07AlignedV2Json(incumbent.panel) !== canonicalV07AlignedV2Json(definition.panels.confirm)
            ) {
                throw new Error("aligned v2 confirmation transition is not bound to the frozen/incumbent pair");
            }
            state.confirmation = { challenger, incumbent, promotion };
            if (promotion.verdict === "HOLD") {
                if (
                    !terminal ||
                    terminal.reason !== "confirm_hold" ||
                    terminal.verdict !== "HOLD" ||
                    terminal.runFingerprint !== definition.definitionSha256 ||
                    terminal.frozenCandidateSha256 !== state.frozen.genomeSha256 ||
                    canonicalV07AlignedV2Json(terminal.promotion) !== canonicalV07AlignedV2Json(promotion) ||
                    terminal.final !== null
                ) {
                    throw new Error("aligned v2 HOLD confirmation omitted its research-only terminal");
                }
                validateTerminal(terminal);
                state.terminal = terminal;
                state.phase = "terminal";
            } else {
                if (terminal) throw new Error("aligned v2 promoted confirmation cannot carry a terminal");
                state.phase = state.finalPlanRevealed ? "final" : "await_final_plan";
            }
            break;
        }
        case "final_recorded": {
            validateEvidenceSummary(event.payload.evidence);
            validateTerminal(event.payload.terminal);
            if (
                state.phase !== "final" ||
                event.nowMs >= definition.schedule.finalDeadlineAtMs ||
                !state.frozen ||
                !state.finalPlanRevealed ||
                event.payload.evidence.genomeSha256 !== state.frozen.genomeSha256 ||
                event.payload.terminal.reason !== "final_assessment" ||
                event.payload.terminal.runFingerprint !== definition.definitionSha256 ||
                event.payload.terminal.frozenCandidateSha256 !== state.frozen.genomeSha256 ||
                event.payload.terminal.final?.verdict !== event.payload.terminal.verdict ||
                canonicalV07AlignedV2Json(event.payload.terminal.promotion) !==
                    canonicalV07AlignedV2Json(state.confirmation?.promotion ?? null) ||
                canonicalV07AlignedV2Json(event.payload.evidence.panel) !==
                    canonicalV07AlignedV2Json(definition.panels.finalCommitment)
            ) {
                throw new Error("aligned v2 final transition is illegal or not bound to the frozen candidate");
            }
            state.terminal = event.payload.terminal;
            state.phase = "terminal";
            break;
        }
        case "terminal_recorded": {
            const { terminal } = event.payload;
            validateTerminal(terminal);
            const noEligibleTiming =
                (state.training.length === definition.candidates.length &&
                    event.nowMs < definition.schedule.trainDeadlineAtMs) ||
                (event.nowMs >= definition.schedule.trainDeadlineAtMs &&
                    event.nowMs < definition.schedule.confirmDeadlineAtMs);
            const legalReason =
                (terminal.reason === "no_eligible_candidate" &&
                    state.phase === "training" &&
                    selectBestTraining(state.training, isV08AlignedV1Definition(definition)) === null &&
                    noEligibleTiming &&
                    terminal.verdict === "INCOMPLETE" &&
                    terminal.promotion === null &&
                    terminal.final === null) ||
                (terminal.reason === "train_catalog_incomplete" &&
                    state.phase === "training" &&
                    state.training.length < definition.candidates.length &&
                    event.nowMs >= definition.schedule.trainDeadlineAtMs &&
                    event.nowMs < definition.schedule.confirmDeadlineAtMs &&
                    terminal.verdict === "INCOMPLETE" &&
                    terminal.promotion === null &&
                    terminal.final === null) ||
                (terminal.reason === "train_deadline_after_confirm_cutoff" &&
                    state.phase === "training" &&
                    event.nowMs >= definition.schedule.confirmDeadlineAtMs &&
                    terminal.verdict === "INCOMPLETE" &&
                    terminal.promotion === null &&
                    terminal.final === null) ||
                (terminal.reason === "confirm_deadline" &&
                    state.phase === "confirmation" &&
                    event.nowMs >= definition.schedule.confirmDeadlineAtMs &&
                    terminal.verdict === "INCOMPLETE" &&
                    terminal.promotion === null &&
                    terminal.final === null) ||
                (terminal.reason === "final_deadline" &&
                    (state.phase === "await_final_plan" || state.phase === "final") &&
                    event.nowMs >= definition.schedule.finalDeadlineAtMs &&
                    terminal.verdict === "INCOMPLETE" &&
                    terminal.final === null &&
                    canonicalV07AlignedV2Json(terminal.promotion) ===
                        canonicalV07AlignedV2Json(state.confirmation?.promotion ?? null));
            if (
                state.phase === "terminal" ||
                !legalReason ||
                terminal.runFingerprint !== definition.definitionSha256 ||
                terminal.frozenCandidateSha256 !== (state.frozen?.genomeSha256 ?? null)
            ) {
                throw new Error("aligned v2 terminal transition is duplicated or illegal for its phase/deadline");
            }
            state.terminal = terminal;
            state.phase = "terminal";
            break;
        }
    }
    state.nextSequence += 1;
    state.eventHeadSha256 = event.eventSha256;
    state.lastNowMs = event.nowMs;
}

export function deriveV07AlignedV2OrchestratorState(
    definition: IV07AlignedV2OrchestratorDefinition,
    events: readonly IV07AlignedV2OrchestratorEvent[],
    resolvers: IV07AlignedV2OrchestratorReplayResolvers = {},
): IV07AlignedV2OrchestratorState {
    validateDefinitionWithoutSeedPlans(definition);
    if (resolvers.seedCommitment) validateResolvedSeedCommitment(definition, resolvers.seedCommitment);
    const state = initialState(definition);
    const commandIds = new Set<string>();
    for (const event of events) {
        validateEventBase(definition, state, event, commandIds);
        applyStoredEvent(definition, state, event);
        validateResolvedEventEvidence(definition, state, event, resolvers);
    }
    return state;
}

function validateResolvedSeedCommitment(
    definition: IV07AlignedV2OrchestratorDefinition,
    resolver: V07AlignedV2SeedCommitmentResolver,
): void {
    const plans = resolver(definition.seedCommitment);
    const train = bindV07AlignedV2SeedPlan(plans.train);
    const confirm = bindV07AlignedV2SeedPlan(plans.confirm);
    const final = definition.panels.finalCommitment;
    if (
        canonicalV07AlignedV2Json(train) !== canonicalV07AlignedV2Json(definition.panels.train) ||
        canonicalV07AlignedV2Json(confirm) !== canonicalV07AlignedV2Json(definition.panels.confirm) ||
        !isObjectRecord(plans.final) ||
        !hasExactKeys(plans.final, [
            "panelId",
            "purpose",
            "scenariosPerCell",
            "denysetSha256",
            "panelFingerprint",
            "taskCount",
            "tasksSha256",
        ]) ||
        plans.final.panelId !== final.panelId ||
        plans.final.purpose !== "final" ||
        plans.final.scenariosPerCell !== final.scenariosPerCell ||
        plans.final.denysetSha256 !== final.denysetSha256 ||
        plans.final.panelFingerprint !== final.panelFingerprint ||
        plans.final.taskCount !== final.taskCount ||
        plans.final.tasksSha256 !== final.tasksSha256
    ) {
        throw new Error("aligned v2 resolved seed commitment does not replay all panel commitments exactly");
    }
    assertV07AlignedV2InjectedPlansDisjoint([plans.train, plans.confirm]);
}

function validateDefinitionWithoutSeedPlans(definition: IV07AlignedV2OrchestratorDefinition): void {
    const v08Definition = definition.artifactKind === "v0_8_aligned_96h_v1_orchestrator_definition";
    const expectedDefinitionKeys = [
        "schemaVersion",
        "artifactKind",
        ...(v08Definition ? ["versionProfile"] : []),
        "status",
        "automaticBake",
        "automaticDeploy",
        "mode",
        "runId",
        "createdAtMs",
        "composedSealSha256",
        "candidateLimit",
        "schedule",
        "candidates",
        "incumbent",
        "panels",
        "seedCommitment",
        "definitionSha256",
    ];
    if (
        !isObjectRecord(definition) ||
        !hasExactKeys(definition, expectedDefinitionKeys) ||
        definition.schemaVersion !== 1 ||
        !(
            definition.artifactKind === "v0_7_aligned_96h_v2_orchestrator_definition" ||
            definition.artifactKind === "v0_8_aligned_96h_v1_orchestrator_definition"
        ) ||
        definition.status !== "research_only_no_bake" ||
        definition.automaticBake !== false ||
        definition.automaticDeploy !== false ||
        !(["formal", "synthetic_dry_run"] as const).includes(definition.mode) ||
        typeof definition.runId !== "string" ||
        !definition.runId.trim()
    ) {
        throw new Error("aligned v2 orchestrator definition header/fields are invalid");
    }
    const versionProfile = v08Definition
        ? definitionVersionProfile(definition.versionProfile)
        : definitionVersionProfile(undefined);
    if (v08Definition !== isV08AlignedV1Profile(versionProfile)) {
        throw new Error("aligned orchestrator definition artifact kind and version profile disagree");
    }
    requireSafeInteger(definition.createdAtMs, "createdAtMs");
    requireSafeInteger(definition.candidateLimit, "candidateLimit");
    if (
        !Array.isArray(definition.candidates) ||
        !isObjectRecord(definition.schedule) ||
        !hasExactKeys(definition.schedule, [
            "startAtMs",
            "trainDeadlineAtMs",
            "confirmDeadlineAtMs",
            "finalDeadlineAtMs",
        ]) ||
        !isObjectRecord(definition.panels) ||
        !hasExactKeys(definition.panels, ["train", "confirm", "finalCommitment"])
    ) {
        throw new Error("aligned v2 orchestrator definition limits/schedule/panels are invalid");
    }
    if (
        definition.candidateLimit < 1 ||
        definition.candidateLimit > 64 ||
        !definition.candidates.length ||
        definition.candidates.length > definition.candidateLimit ||
        definition.createdAtMs > definition.schedule.startAtMs
    ) {
        throw new Error("aligned v2 orchestrator definition limits/schedule/panels are invalid");
    }
    validateSchedule(definition.schedule);
    requireSha256(definition.composedSealSha256, "composedSealSha256");
    requireSha256(definition.definitionSha256, "definitionSha256");
    validateSeedArtifactRef(definition.seedCommitment, "seedCommitment");
    if (v08Definition) {
        definition.candidates.forEach((candidate) =>
            validateV08AlignedV1CandidateBinding(candidate as IV08AlignedV1CandidateBinding),
        );
        validateV08AlignedV1CandidateBinding(definition.incumbent as IV08AlignedV1CandidateBinding);
    } else {
        definition.candidates.forEach((candidate) =>
            validateV07AlignedV2CandidateBinding(candidate as IV07AlignedV2CandidateBinding),
        );
        validateV07AlignedV2CandidateBinding(definition.incumbent as IV07AlignedV2CandidateBinding);
    }
    for (const panel of Object.values(definition.panels)) validateV07AlignedV2CheckpointPanelBinding(panel);
    const candidateHashes = definition.candidates.map((candidate) => candidate.genomeSha256);
    if (definition.mode === "formal") {
        const production = v08Definition
            ? buildV08AlignedV1ProductionCatalogIdentity()
            : buildV07AlignedV2ProductionCatalogIdentity();
        const expectedSorted = [...production.orderedCandidateGenomeSha256].sort();
        if (
            production.catalogSha256 !==
                (v08Definition ? V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256 : V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256) ||
            definition.candidateLimit !==
                (v08Definition
                    ? V08_ALIGNED_V1_PRODUCTION_CANDIDATE_LIMIT
                    : V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT) ||
            definition.panels.train.scenariosPerCell !== V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL ||
            definition.incumbent.genomeSha256 !== production.incumbentGenomeSha256 ||
            canonicalV07AlignedV2Json(candidateHashes) !== canonicalV07AlignedV2Json(expectedSorted)
        ) {
            throw new Error("aligned v2 formal definition does not match the code-owned production catalog");
        }
    }
    if (
        new Set(candidateHashes).size !== candidateHashes.length ||
        candidateHashes.includes(definition.incumbent.genomeSha256) ||
        canonicalV07AlignedV2Json(candidateHashes) !== canonicalV07AlignedV2Json([...candidateHashes].sort()) ||
        definition.panels.train.purpose !== "train" ||
        definition.panels.confirm.purpose !== "confirm" ||
        definition.panels.finalCommitment.purpose !== "final" ||
        definition.panels.confirm.scenariosPerCell !== expectedPanelScenarios(definition.mode, "confirm") ||
        definition.panels.finalCommitment.scenariosPerCell !== expectedPanelScenarios(definition.mode, "final") ||
        new Set([
            definition.panels.train.panelId,
            definition.panels.confirm.panelId,
            definition.panels.finalCommitment.panelId,
        ]).size !== 3 ||
        new Set([
            definition.panels.train.panelFingerprint,
            definition.panels.confirm.panelFingerprint,
            definition.panels.finalCommitment.panelFingerprint,
        ]).size !== 3
    ) {
        throw new Error("aligned v2 orchestrator definition catalog or panel commitments are invalid");
    }
    const unsigned = { ...definition };
    delete (unsigned as Partial<IV07AlignedV2OrchestratorDefinition>).definitionSha256;
    if (definition.definitionSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 orchestrator definition self-hash mismatch");
    }
}

function validateResolvedSummary(
    definition: IV07AlignedV2OrchestratorDefinition,
    summary: IV07AlignedV2PanelEvidenceSummary,
    resolver: V07AlignedV2EvidenceResolver,
): readonly IV07AlignedV2GameObservation[] {
    const observations = resolver(summary);
    const rebuilt = prepareEvidence(
        {
            panel: summary.panel,
            genomeSha256: summary.genomeSha256,
            artifacts: summary.artifacts,
            observations: [...observations],
        },
        summary.panel,
        summary.genomeSha256,
        isV08AlignedV1Definition(definition),
    );
    if (canonicalV07AlignedV2Json(rebuilt.summary) !== canonicalV07AlignedV2Json(summary)) {
        throw new Error(`aligned v2 resolved evidence ${summary.evidenceSha256} does not replay exactly`);
    }
    return rebuilt.observations;
}

function validateResolvedEventEvidence(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    event: IV07AlignedV2OrchestratorEvent,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
): void {
    if (event.eventType === "train_recorded") {
        if (resolvers.evidence) validateResolvedSummary(definition, event.payload.evidence, resolvers.evidence);
    } else if (event.eventType === "final_plan_revealed") {
        if (!resolvers.seedPlans) return;
        if (!state.frozen) throw new Error("aligned v2 seed reveal replay lacks its frozen candidate");
        const plans = resolvers.seedPlans(event.payload.seedArtifacts, state.frozen);
        const train = bindV07AlignedV2SeedPlan(plans.train);
        const confirm = bindV07AlignedV2SeedPlan(plans.confirm);
        const finalPanel = bindV07AlignedV2SeedPlan(plans.final);
        if (
            canonicalV07AlignedV2Json(train) !== canonicalV07AlignedV2Json(definition.panels.train) ||
            canonicalV07AlignedV2Json(confirm) !== canonicalV07AlignedV2Json(definition.panels.confirm) ||
            canonicalV07AlignedV2Json(finalPanel) !== canonicalV07AlignedV2Json(definition.panels.finalCommitment) ||
            assertV07AlignedV2InjectedPlansDisjoint([plans.train, plans.confirm, plans.final]) !==
                event.payload.threePanelSeedSetSha256
        ) {
            throw new Error("aligned v2 resolved final seed reveal does not replay its commitments exactly");
        }
    } else if (event.eventType === "confirmation_recorded") {
        if (!resolvers.evidence) return;
        const challenger = validateResolvedSummary(definition, event.payload.challenger, resolvers.evidence);
        const incumbent = validateResolvedSummary(definition, event.payload.incumbent, resolvers.evidence);
        const promotion = assessDefinitionPromotion(definition, pairConfirmObservations(challenger, incumbent));
        if (canonicalV07AlignedV2Json(promotion) !== canonicalV07AlignedV2Json(event.payload.promotion)) {
            throw new Error("aligned v2 persisted confirmation verdict does not replay exactly");
        }
    } else if (event.eventType === "final_recorded") {
        if (!resolvers.evidence) return;
        const observations = validateResolvedSummary(definition, event.payload.evidence, resolvers.evidence);
        const final = assessDefinitionFinal(definition, observations);
        if (canonicalV07AlignedV2Json(final) !== canonicalV07AlignedV2Json(event.payload.terminal.final)) {
            throw new Error("aligned v2 persisted final terminal does not replay exactly");
        }
    }
}

/** Validate only one newly appended event against its externally persisted evidence. */
export function validateV07AlignedV2AppendedEventEvidence(
    definition: IV07AlignedV2OrchestratorDefinition,
    stateAfter: IV07AlignedV2OrchestratorState,
    event: IV07AlignedV2OrchestratorEvent,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
): void {
    validateDefinitionWithoutSeedPlans(definition);
    if (
        stateAfter.nextSequence !== event.sequence + 1 ||
        stateAfter.eventHeadSha256 !== event.eventSha256 ||
        stateAfter.lastNowMs !== event.nowMs
    ) {
        throw new Error("aligned v2 appended evidence validation requires the exact post-event state");
    }
    if (!resolvers.seedCommitment) {
        throw new Error("aligned v2 appended evidence validation requires a seed-commitment resolver");
    }
    validateResolvedSeedCommitment(definition, resolvers.seedCommitment);
    if (
        ["train_recorded", "confirmation_recorded", "final_recorded"].includes(event.eventType) &&
        !resolvers.evidence
    ) {
        throw new Error("aligned v2 appended evidence validation requires an evidence resolver");
    }
    if (event.eventType === "final_plan_revealed" && !resolvers.seedPlans) {
        throw new Error("aligned v2 appended evidence validation requires a final seed-reveal resolver");
    }
    validateResolvedEventEvidence(definition, stateAfter, event, resolvers);
}

function makeEvent(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    command: IV07AlignedV2OrchestratorCommand,
    eventType: IV07AlignedV2OrchestratorEvent["eventType"],
    payload: IV07AlignedV2OrchestratorEvent["payload"],
): IV07AlignedV2OrchestratorEvent {
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_transition" as const,
        runFingerprint: definition.definitionSha256,
        sequence: state.nextSequence,
        previousEventSha256: state.eventHeadSha256,
        commandId: command.commandId,
        commandSha256: fingerprintV07AlignedV2(command),
        nowMs: command.nowMs,
        eventType,
        payload,
    };
    return { ...unsigned, eventSha256: fingerprintV07AlignedV2(unsigned) } as IV07AlignedV2OrchestratorEvent;
}

function requireCommandTime(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    command: IV07AlignedV2OrchestratorCommand,
): void {
    if (!command.commandId.trim()) throw new Error("aligned v2 commandId must not be empty");
    requireSafeInteger(command.nowMs, "command.nowMs");
    if (command.nowMs < state.lastNowMs || command.nowMs < definition.schedule.startAtMs) {
        throw new Error("aligned v2 command time cannot move backward or precede the run start");
    }
}

function beforeDeadline(nowMs: number, deadlineMs: number, label: string): void {
    if (nowMs >= deadlineMs) throw new Error(`aligned v2 ${label} command reached its immutable deadline`);
}

function appendAndDerive(
    definition: IV07AlignedV2OrchestratorDefinition,
    events: readonly IV07AlignedV2OrchestratorEvent[],
    state: IV07AlignedV2OrchestratorState,
    event: IV07AlignedV2OrchestratorEvent,
): IV07AlignedV2OrchestratorApplyResult {
    const nextEvents = [...events, event];
    return {
        events: nextEvents,
        state: deriveV07AlignedV2OrchestratorState(definition, nextEvents),
        appended: event,
        reused: false,
    };
}

function freezeEvent(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
    command: IV07AlignedV2OrchestratorCommand,
    reason: IV07AlignedV2FrozenCandidate["reason"],
): IV07AlignedV2OrchestratorEvent {
    const best = selectBestTraining(state.training, isV08AlignedV1Definition(definition));
    if (!best) {
        const terminal = createTerminal(definition, null, "no_eligible_candidate", "INCOMPLETE");
        return makeEvent(definition, state, command, "terminal_recorded", { terminal });
    }
    const frozenUnsigned = {
        genomeSha256: best.genomeSha256,
        trainingEvidenceSha256: best.evidenceSha256,
        frozenAtMs: command.nowMs,
        reason,
    };
    return makeEvent(definition, state, command, "candidate_frozen", {
        frozen: { ...frozenUnsigned, freezeArtifactSha256: fingerprintV07AlignedV2(frozenUnsigned) },
    });
}

export function applyV07AlignedV2OrchestratorCommand(
    definition: IV07AlignedV2OrchestratorDefinition,
    events: readonly IV07AlignedV2OrchestratorEvent[],
    command: IV07AlignedV2OrchestratorCommand,
): IV07AlignedV2OrchestratorApplyResult {
    const state = deriveV07AlignedV2OrchestratorState(definition, events);
    if (!command.commandId.trim()) throw new Error("aligned v2 commandId must not be empty");
    const commandSha256 = fingerprintV07AlignedV2(command);
    const prior = events.find((event) => event.commandId === command.commandId);
    if (prior) {
        if (prior.commandSha256 !== commandSha256) throw new Error("aligned v2 commandId was reused with new content");
        return { events: [...events], state, appended: null, reused: true };
    }
    requireCommandTime(definition, state, command);
    if (state.phase === "terminal") return { events: [...events], state, appended: null, reused: true };

    let event: IV07AlignedV2OrchestratorEvent | null = null;
    if (command.type === "record_train") {
        if (state.phase !== "training") throw new Error("aligned v2 training result arrived outside training");
        beforeDeadline(command.nowMs, definition.schedule.trainDeadlineAtMs, "training");
        const candidate = definition.candidates.find((entry) => entry.genomeSha256 === command.candidateGenomeSha256);
        if (!candidate || state.training.some((entry) => entry.genomeSha256 === candidate.genomeSha256)) {
            throw new Error("aligned v2 training candidate is unknown or already recorded");
        }
        const evidence = summarizeEvidence(
            command.evidence,
            definition.panels.train,
            candidate.genomeSha256,
            isV08AlignedV1Definition(definition),
        );
        event = makeEvent(definition, state, command, "train_recorded", { evidence });
    } else if (command.type === "freeze_candidate") {
        if (state.phase !== "training") throw new Error("aligned v2 candidate freeze arrived outside training");
        beforeDeadline(command.nowMs, definition.schedule.trainDeadlineAtMs, "candidate freeze");
        if (state.training.length !== definition.candidates.length) {
            throw new Error("aligned v2 candidate cannot freeze before the finite catalog is fully evaluated");
        }
        event = freezeEvent(definition, state, command, "all_candidates_complete");
    } else if (command.type === "reveal_final_plan") {
        if (
            !state.frozen ||
            state.finalPlanRevealed ||
            !(state.phase === "confirmation" || state.phase === "await_final_plan")
        ) {
            throw new Error("aligned v2 final plan cannot be revealed before immutable candidate freeze");
        }
        beforeDeadline(
            command.nowMs,
            state.phase === "confirmation"
                ? definition.schedule.confirmDeadlineAtMs
                : definition.schedule.finalDeadlineAtMs,
            "final plan reveal",
        );
        const train = bindV07AlignedV2SeedPlan(command.trainSeedPlan);
        const confirm = bindV07AlignedV2SeedPlan(command.confirmSeedPlan);
        const finalPanel = bindV07AlignedV2SeedPlan(command.finalSeedPlan);
        const seedArtifacts = validateRevealedSeedArtifacts(command.seedArtifacts);
        if (
            canonicalV07AlignedV2Json(train) !== canonicalV07AlignedV2Json(definition.panels.train) ||
            canonicalV07AlignedV2Json(confirm) !== canonicalV07AlignedV2Json(definition.panels.confirm) ||
            canonicalV07AlignedV2Json(finalPanel) !== canonicalV07AlignedV2Json(definition.panels.finalCommitment) ||
            canonicalV07AlignedV2Json(seedArtifacts.commitment) !== canonicalV07AlignedV2Json(definition.seedCommitment)
        ) {
            throw new Error("aligned v2 final plan reveal does not open all precommitted panels");
        }
        const threePanelSeedSetSha256 = assertV07AlignedV2InjectedPlansDisjoint([
            command.trainSeedPlan,
            command.confirmSeedPlan,
            command.finalSeedPlan,
        ]);
        event = makeEvent(definition, state, command, "final_plan_revealed", {
            panel: finalPanel,
            seedArtifacts,
            threePanelSeedSetSha256,
        });
    } else if (command.type === "record_confirmation") {
        if (state.phase !== "confirmation" || !state.frozen) {
            throw new Error("aligned v2 confirmation arrived without a frozen candidate");
        }
        beforeDeadline(command.nowMs, definition.schedule.confirmDeadlineAtMs, "confirmation");
        const challenger = prepareEvidence(
            command.challenger,
            definition.panels.confirm,
            state.frozen.genomeSha256,
            isV08AlignedV1Definition(definition),
        );
        const incumbent = prepareEvidence(
            command.incumbent,
            definition.panels.confirm,
            definition.incumbent.genomeSha256,
            isV08AlignedV1Definition(definition),
        );
        const promotion = assessDefinitionPromotion(
            definition,
            pairConfirmObservations(challenger.observations, incumbent.observations),
        );
        const terminal =
            promotion.verdict === "HOLD"
                ? createTerminal(definition, state.frozen.genomeSha256, "confirm_hold", "HOLD", promotion)
                : null;
        event = makeEvent(definition, state, command, "confirmation_recorded", {
            challenger: challenger.summary,
            incumbent: incumbent.summary,
            promotion,
            terminal,
        });
    } else if (command.type === "record_final") {
        if (state.phase !== "final" || !state.frozen || !state.finalPlanRevealed) {
            throw new Error("aligned v2 final evidence arrived before promotion and final-plan reveal");
        }
        beforeDeadline(command.nowMs, definition.schedule.finalDeadlineAtMs, "final");
        const evidence = prepareEvidence(
            command.evidence,
            definition.panels.finalCommitment,
            state.frozen.genomeSha256,
            isV08AlignedV1Definition(definition),
        );
        const final = assessDefinitionFinal(definition, evidence.observations);
        const terminal = createTerminal(
            definition,
            state.frozen.genomeSha256,
            "final_assessment",
            final.verdict,
            state.confirmation?.promotion ?? null,
            final,
        );
        event = makeEvent(definition, state, command, "final_recorded", { evidence: evidence.summary, terminal });
    } else if (command.type === "tick") {
        if (state.phase === "training" && command.nowMs >= definition.schedule.trainDeadlineAtMs) {
            event =
                command.nowMs >= definition.schedule.confirmDeadlineAtMs
                    ? makeEvent(definition, state, command, "terminal_recorded", {
                          terminal: createTerminal(
                              definition,
                              null,
                              "train_deadline_after_confirm_cutoff",
                              "INCOMPLETE",
                          ),
                      })
                    : state.training.length < definition.candidates.length
                      ? makeEvent(definition, state, command, "terminal_recorded", {
                            terminal: createTerminal(definition, null, "train_catalog_incomplete", "INCOMPLETE"),
                        })
                      : freezeEvent(definition, state, command, "train_deadline");
        } else if (state.phase === "confirmation" && command.nowMs >= definition.schedule.confirmDeadlineAtMs) {
            event = makeEvent(definition, state, command, "terminal_recorded", {
                terminal: createTerminal(
                    definition,
                    state.frozen?.genomeSha256 ?? null,
                    "confirm_deadline",
                    "INCOMPLETE",
                ),
            });
        } else if (
            (state.phase === "await_final_plan" || state.phase === "final") &&
            command.nowMs >= definition.schedule.finalDeadlineAtMs
        ) {
            event = makeEvent(definition, state, command, "terminal_recorded", {
                terminal: createTerminal(
                    definition,
                    state.frozen?.genomeSha256 ?? null,
                    "final_deadline",
                    "INCOMPLETE",
                    state.confirmation?.promotion ?? null,
                ),
            });
        }
    }
    if (!event) return { events: [...events], state, appended: null, reused: false };
    return appendAndDerive(definition, events, state, event);
}
