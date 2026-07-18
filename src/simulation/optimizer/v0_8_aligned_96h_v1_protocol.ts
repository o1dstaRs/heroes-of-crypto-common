/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import {
    V08_ALIGNED_96H_V1_VERSION_PROFILE,
    assertAligned96hVersionProfile,
    cloneAligned96hVersionProfile,
} from "./aligned_96h_version_profile";
import {
    V08_ALIGNED_96H_V1_CELLS,
    V08_ALIGNED_96H_V1_SEATS,
    type IV08AlignedV1GameObservation,
    type V08AlignedV1CandidateSeat,
    type V08AlignedV1CellId,
} from "./v0_8_aligned_96h_v1_core";
import type { IV07AlignedV2SearchAudit } from "./v0_7_aligned_96h_v2_core";
import {
    V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS,
    buildV07AlignedV2CandidateEnvironment,
    isV07AlignedV2BehaviorEnvironmentKey,
    normalizeV07AlignedV2CandidateGenome,
    validateV07AlignedV2SeedPlan,
    type IV07AlignedV2CandidateControls,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2InjectedSeedPlan,
    type IAligned96hCandidateBinding,
} from "./v0_7_aligned_96h_v2_protocol";

export type V08AlignedV1PanelPurpose = "train" | "confirm" | "final";
export type V08AlignedV1Distribution = "ranked_taxonomy" | "fixed_template";
export type V08AlignedV1ScenarioProtocol = "independent_seat_conditioned" | "fixed_physical_side_swap";
export type V08AlignedV1Archetype = "mage" | "meleeMage" | "aura" | "ranged";
export type V08AlignedV1Template =
    | "mage_frontline"
    | "mage_fireline"
    | "melee_magic_utility"
    | "melee_magic_brawler"
    | "aura_support"
    | "aura_offense"
    | "ranged_precision"
    | "ranged_control";

export interface IV08AlignedV1EvaluatorCell {
    id: V08AlignedV1CellId;
    cohort: (typeof V08_ALIGNED_96H_V1_CELLS)[number]["cohort"];
    distribution: V08AlignedV1Distribution;
    scenarioProtocol: V08AlignedV1ScenarioProtocol;
    archetype: V08AlignedV1Archetype;
    template?: V08AlignedV1Template;
    candidate: "v0.8s";
    candidateBase: "v0.8";
    opponent: "v0.7";
}

const ranked = (
    id: V08AlignedV1CellId,
    cohort: IV08AlignedV1EvaluatorCell["cohort"],
    archetype: V08AlignedV1Archetype,
): IV08AlignedV1EvaluatorCell => ({
    id,
    cohort,
    distribution: "ranked_taxonomy",
    scenarioProtocol: "independent_seat_conditioned",
    archetype,
    candidate: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidate,
    candidateBase: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidateBase,
    opponent: V08_ALIGNED_96H_V1_VERSION_PROFILE.opponent,
});

const fixed = (
    id: V08AlignedV1CellId,
    cohort: IV08AlignedV1EvaluatorCell["cohort"],
    archetype: V08AlignedV1Archetype,
    template: V08AlignedV1Template,
): IV08AlignedV1EvaluatorCell => ({
    id,
    cohort,
    distribution: "fixed_template",
    scenarioProtocol: "fixed_physical_side_swap",
    archetype,
    template,
    candidate: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidate,
    candidateBase: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidateBase,
    opponent: V08_ALIGNED_96H_V1_VERSION_PROFILE.opponent,
});

export const V08_ALIGNED_V1_EVALUATOR_CELLS: readonly Readonly<IV08AlignedV1EvaluatorCell>[] = Object.freeze(
    [
        ranked("ranked_mage", "mage", "mage"),
        ranked("ranked_melee_mage", "melee_mage", "meleeMage"),
        ranked("ranked_aura", "aura", "aura"),
        ranked("ranked_ranged", "ranged", "ranged"),
        fixed("fixed_mage_frontline", "mage", "mage", "mage_frontline"),
        fixed("fixed_mage_fireline", "mage", "mage", "mage_fireline"),
        fixed("fixed_melee_magic_utility", "melee_mage", "meleeMage", "melee_magic_utility"),
        fixed("fixed_melee_magic_brawler", "melee_mage", "meleeMage", "melee_magic_brawler"),
        fixed("fixed_aura_support", "aura", "aura", "aura_support"),
        fixed("fixed_aura_offense", "aura", "aura", "aura_offense"),
        fixed("fixed_ranged_precision", "ranged", "ranged", "ranged_precision"),
        fixed("fixed_ranged_control", "ranged", "ranged", "ranged_control"),
    ].map((cell) => Object.freeze(cell)),
);

const CELL_BY_ID = new Map(V08_ALIGNED_V1_EVALUATOR_CELLS.map((cell) => [cell.id, cell]));
const CELL_ORDER = new Map(V08_ALIGNED_V1_EVALUATOR_CELLS.map((cell, index) => [cell.id, index]));
const SEAT_ORDER = new Map(V08_ALIGNED_96H_V1_SEATS.map((seat, index) => [seat, index]));

if (
    JSON.stringify(
        V08_ALIGNED_V1_EVALUATOR_CELLS.map(({ id, cohort, distribution }) => ({ id, cohort, distribution })),
    ) !== JSON.stringify(V08_ALIGNED_96H_V1_CELLS)
) {
    throw new Error("v0.8 aligned v1 evaluator registry drifted from the statistical core");
}

export function canonicalV08AlignedV1Json(value: unknown): string {
    const canonical = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry.map(canonical);
        if (entry !== null && typeof entry === "object") {
            return Object.fromEntries(
                Object.entries(entry as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, child]) => [key, canonical(child)]),
            );
        }
        return entry;
    };
    return JSON.stringify(canonical(value));
}

export function fingerprintV08AlignedV1(value: unknown): string {
    return createHash("sha256").update(canonicalV08AlignedV1Json(value)).digest("hex");
}

export type IV08AlignedV1CandidateControls = IV07AlignedV2CandidateControls;
export type IV08AlignedV1CandidateGenome = IV07AlignedV2CandidateGenome;
export type IV08AlignedV1SearchAudit = IV07AlignedV2SearchAudit;

export const normalizeV08AlignedV1CandidateGenome = normalizeV07AlignedV2CandidateGenome;

export function fingerprintV08AlignedV1CandidateGenome(genome: IV08AlignedV1CandidateGenome): string {
    const normalized = normalizeV08AlignedV1CandidateGenome(genome);
    const search = { ...normalized.search };
    delete search.label;
    return fingerprintV08AlignedV1({
        artifactKind: "v0_8_aligned_96h_v1_candidate_genome",
        versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
        search,
        controls: normalized.controls,
    });
}

export interface IV08AlignedV1CandidateBinding extends IAligned96hCandidateBinding {
    schemaVersion: 3;
    artifactKind: "v0_8_aligned_96h_v1_candidate_binding";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    candidate: "v0.8s";
    candidateBase: "v0.8";
    opponent: "v0.7";
    profile: "candidate_scoped_v0_8_aligned_controls_melee57_fixed_275";
    genome: IV08AlignedV1CandidateGenome;
    genomeSha256: string;
    searchEnabled: boolean;
    behaviorEnvironment: Record<string, string>;
    behaviorEnvironmentSha256: string;
}

export function buildV08AlignedV1CandidateEnvironment(
    genome: IV08AlignedV1CandidateGenome,
    auditPath: string,
): Record<string, string> {
    return buildV07AlignedV2CandidateEnvironment(genome, auditPath, "v0.8s");
}

export function bindV08AlignedV1Candidate(genome: IV08AlignedV1CandidateGenome): IV08AlignedV1CandidateBinding {
    const normalized = normalizeV08AlignedV1CandidateGenome(genome);
    const behaviorEnvironment = buildV08AlignedV1CandidateEnvironment(normalized, "<worker-audit-path>");
    return {
        schemaVersion: 3,
        artifactKind: "v0_8_aligned_96h_v1_candidate_binding",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        candidate: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidate,
        candidateBase: V08_ALIGNED_96H_V1_VERSION_PROFILE.candidateBase,
        opponent: V08_ALIGNED_96H_V1_VERSION_PROFILE.opponent,
        profile: "candidate_scoped_v0_8_aligned_controls_melee57_fixed_275",
        genome: normalized,
        genomeSha256: fingerprintV08AlignedV1CandidateGenome(normalized),
        searchEnabled: normalized.search.leafMode !== "off",
        behaviorEnvironment,
        behaviorEnvironmentSha256: fingerprintV08AlignedV1(behaviorEnvironment),
    };
}

export function validateV08AlignedV1CandidateBinding(
    binding: IV08AlignedV1CandidateBinding,
): IV08AlignedV1CandidateBinding {
    assertAligned96hVersionProfile(binding.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    const expected = bindV08AlignedV1Candidate(binding.genome);
    if (canonicalV08AlignedV1Json(binding) !== canonicalV08AlignedV1Json(expected)) {
        throw new Error("v0.8 aligned v1 candidate binding does not match its canonical genome and version profile");
    }
    return binding;
}

export function verifyV08AlignedV1WorkerEnvironment(
    expected: Readonly<Record<string, string>>,
    source: NodeJS.ProcessEnv = process.env,
): { effective: Record<string, string>; sha256: string } {
    const effective = Object.fromEntries(
        Object.entries(source)
            .filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined &&
                    (isV07AlignedV2BehaviorEnvironmentKey(entry[0]) || entry[0].startsWith("V08_")),
            )
            .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (canonicalV08AlignedV1Json(effective) !== canonicalV08AlignedV1Json(expected)) {
        throw new Error("v0.8 aligned v1 worker environment does not match its exact candidate binding");
    }
    return { effective, sha256: fingerprintV08AlignedV1(effective) };
}

export interface IV08AlignedV1SeatSeedStream {
    setupSeeds: number[];
    combatSeed: number;
}

export interface IV08AlignedV1ScenarioPair {
    cellId: V08AlignedV1CellId;
    scenarioOrdinal: number;
    scenarioId: string;
    seats: Record<V08AlignedV1CandidateSeat, IV08AlignedV1SeatSeedStream>;
}

export interface IV08AlignedV1InjectedSeedPlan {
    schemaVersion: 1;
    artifactKind: "v0_8_aligned_96h_v1_seed_plan";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    panelId: string;
    purpose: V08AlignedV1PanelPurpose;
    scenariosPerCell: number;
    denysetSha256: string;
    pairs: IV08AlignedV1ScenarioPair[];
}

export interface IV08AlignedV1TaskCoordinates {
    panelId: string;
    cellId: V08AlignedV1CellId;
    scenarioOrdinal: number;
    scenarioId: string;
    candidateSeat: V08AlignedV1CandidateSeat;
}

export interface IV08AlignedV1ExecutionTask extends IV08AlignedV1TaskCoordinates {
    artifactKind: "v0_8_aligned_96h_v1_execution_task";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    purpose: V08AlignedV1PanelPurpose;
    setupSeeds: number[];
    combatSeed: number;
}

const legacySeedPlan = (plan: IV08AlignedV1InjectedSeedPlan): IV07AlignedV2InjectedSeedPlan => ({
    schemaVersion: plan.schemaVersion,
    panelId: plan.panelId,
    purpose: plan.purpose,
    scenariosPerCell: plan.scenariosPerCell,
    denysetSha256: plan.denysetSha256,
    pairs: plan.pairs.map((pair) => ({
        cellId: pair.cellId,
        scenarioOrdinal: pair.scenarioOrdinal,
        scenarioId: pair.scenarioId,
        seats: {
            candidate_green: {
                setupSeeds: [...pair.seats.candidate_green.setupSeeds],
                combatSeed: pair.seats.candidate_green.combatSeed,
            },
            candidate_red: {
                setupSeeds: [...pair.seats.candidate_red.setupSeeds],
                combatSeed: pair.seats.candidate_red.combatSeed,
            },
        },
    })),
});

export function validateV08AlignedV1SeedPlan(plan: IV08AlignedV1InjectedSeedPlan): void {
    if (plan.artifactKind !== "v0_8_aligned_96h_v1_seed_plan") {
        throw new Error("v0.8 aligned v1 seed plan artifact kind is invalid");
    }
    assertAligned96hVersionProfile(plan.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    validateV07AlignedV2SeedPlan(legacySeedPlan(plan));
}

export function flattenV08AlignedV1SeedPlan(plan: IV08AlignedV1InjectedSeedPlan): IV08AlignedV1ExecutionTask[] {
    validateV08AlignedV1SeedPlan(plan);
    return plan.pairs
        .flatMap((pair) =>
            V08_ALIGNED_96H_V1_SEATS.map((candidateSeat): IV08AlignedV1ExecutionTask => ({
                artifactKind: "v0_8_aligned_96h_v1_execution_task",
                versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
                panelId: plan.panelId,
                purpose: plan.purpose,
                cellId: pair.cellId,
                scenarioOrdinal: pair.scenarioOrdinal,
                scenarioId: pair.scenarioId,
                candidateSeat,
                setupSeeds: [...pair.seats[candidateSeat].setupSeeds],
                combatSeed: pair.seats[candidateSeat].combatSeed,
            })),
        )
        .sort(
            (left, right) =>
                CELL_ORDER.get(left.cellId)! - CELL_ORDER.get(right.cellId)! ||
                left.scenarioOrdinal - right.scenarioOrdinal ||
                SEAT_ORDER.get(left.candidateSeat)! - SEAT_ORDER.get(right.candidateSeat)!,
        );
}

export function fingerprintV08AlignedV1SeedPlan(plan: IV08AlignedV1InjectedSeedPlan): string {
    validateV08AlignedV1SeedPlan(plan);
    return fingerprintV08AlignedV1(plan);
}

export function v08AlignedV1TaskKey(identity: IV08AlignedV1TaskCoordinates): string {
    return `${identity.panelId}|${identity.cellId}|${identity.scenarioOrdinal}|${identity.scenarioId}|${identity.candidateSeat}`;
}

export function v08AlignedV1TaskIdentity(
    task: IV08AlignedV1ExecutionTask | IV08AlignedV1GameObservation,
    panelId?: string,
): IV08AlignedV1TaskCoordinates & { seedMaterialSha256: string | null } {
    if ("panelId" in task) {
        assertAligned96hVersionProfile(task.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
        return {
            panelId: task.panelId,
            cellId: task.cellId,
            scenarioOrdinal: task.scenarioOrdinal,
            scenarioId: task.scenarioId,
            candidateSeat: task.candidateSeat,
            seedMaterialSha256: fingerprintV08AlignedV1({
                artifactKind: "v0_8_aligned_96h_v1_seed_material",
                versionProfile: task.versionProfile,
                setupSeeds: task.setupSeeds,
                combatSeed: task.combatSeed,
            }),
        };
    }
    if (panelId === undefined) throw new Error("panelId is required for observation task identity");
    const ordinal = /^(?:scenario-)?(\d+)$/.exec(task.scenarioId);
    if (!ordinal) throw new Error(`observation scenarioId ${task.scenarioId} does not encode an ordinal`);
    return {
        panelId,
        cellId: task.cellId,
        scenarioOrdinal: Number(ordinal[1]),
        scenarioId: task.scenarioId,
        candidateSeat: task.candidateSeat,
        seedMaterialSha256: null,
    };
}

export function evaluatorCellV08AlignedV1(cellId: V08AlignedV1CellId): Readonly<IV08AlignedV1EvaluatorCell> {
    const cell = CELL_BY_ID.get(cellId);
    if (!cell) throw new Error(`unknown v0.8 aligned v1 evaluator cell ${cellId}`);
    return cell;
}

export { V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS as V08_ALIGNED_V1_TAXONOMY_SETUP_ATTEMPTS };
