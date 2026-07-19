/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * The finite behavior catalog preserves aligned-v2's reviewed coverage while
 * redesigning all 48 search arms for v0.8s on the current engine.
 */

import {
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionIncumbentGenome,
} from "./v0_7_aligned_96h_v2_catalog";
import type { V07AlignedV2DecisionDeadlineMs } from "./v0_7_aligned_96h_v2_protocol";
import {
    V08_ALIGNED_96H_V1_VERSION_PROFILE,
    assertAligned96hVersionProfile,
    cloneAligned96hVersionProfile,
} from "./aligned_96h_version_profile";
import {
    V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
    V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL,
} from "./v0_8_aligned_96h_v1_core";
import {
    canonicalV08AlignedV1Json,
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
    normalizeV08AlignedV1CandidateGenome,
    type IV08AlignedV1CandidateGenome,
} from "./v0_8_aligned_96h_v1_protocol";

export const V08_ALIGNED_V1_PRODUCTION_CANDIDATE_LIMIT = V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT;

type V08AlignedV1Rollouts = 1 | 2 | 3;

interface IV08AlignedV1SearchPlan {
    rollouts: V08AlignedV1Rollouts;
    decisionDeadlineMs: V07AlignedV2DecisionDeadlineMs;
}

const CORE_PLAN_BY_DEADLINE = Object.freeze({
    125: { rollouts: 1, decisionDeadlineMs: 125 },
    150: { rollouts: 2, decisionDeadlineMs: 150 },
    175: { rollouts: 3, decisionDeadlineMs: 175 },
} as const satisfies Record<125 | 150 | 175, IV08AlignedV1SearchPlan>);

/**
 * Explicit non-core workload review. Deep h12 searches stop at two rollouts; three-rollout probes use h8 or h4
 * and a 175ms deadline. Every candidate retains at least 100ms of restore/call-site headroom below the 275ms
 * circuit breaker.
 */
const NON_CORE_SEARCH_PLAN = Object.freeze({
    "aligned-prod-policy-b9ce-dense0-windflow": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-policy-b9ce-dense0-resurrection_windflow": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-policy-b9ce-dense1-off": { rollouts: 1, decisionDeadlineMs: 125 },
    "aligned-prod-policy-b9ce-dense1-windflow": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-policy-b9ce-dense1-resurrection_windflow": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-depth-b9ce-h12-d150": { rollouts: 1, decisionDeadlineMs: 150 },
    "aligned-prod-depth-b9ce-h12-d175": { rollouts: 2, decisionDeadlineMs: 175 },
    "aligned-prod-depth-midpoint-h12-d150": { rollouts: 1, decisionDeadlineMs: 150 },
    "aligned-prod-depth-midpoint-h12-d175": { rollouts: 2, decisionDeadlineMs: 175 },
    "aligned-prod-ranged-b9ce-late2": { rollouts: 1, decisionDeadlineMs: 125 },
    "aligned-prod-ranged-b9ce-late4": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-ranged-b9ce-pure05": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-ranged-b9ce-pure1": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-control-b9ce-h8-inactive-s3": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-control-midpoint-h8-inactive-s3": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-control-b9ce-h12-s4": { rollouts: 1, decisionDeadlineMs: 150 },
    "aligned-prod-melee-ranged-target-b9ce-h8": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-placement-off-b9ce-h8": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-placement-off-b9ce-h12": { rollouts: 1, decisionDeadlineMs: 150 },
    "aligned-prod-melee-ranged-target-b9ce-h12": { rollouts: 2, decisionDeadlineMs: 175 },
    "aligned-prod-calibration-b9ce-gate01": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-calibration-midpoint-gate01": { rollouts: 3, decisionDeadlineMs: 175 },
    "aligned-prod-calibration-midpoint-late2": { rollouts: 2, decisionDeadlineMs: 150 },
    "aligned-prod-calibration-midpoint-pure05": { rollouts: 3, decisionDeadlineMs: 175 },
} as const satisfies Record<string, IV08AlignedV1SearchPlan>);

function reviewedSearchPlan(genome: IV08AlignedV1CandidateGenome): IV08AlignedV1SearchPlan {
    const label = genome.search.label;
    if (!label) throw new Error("v0.8 aligned v1 source candidate is missing its review label");
    if (label.startsWith("aligned-prod-core-")) {
        const deadline = genome.controls.decisionDeadlineMs;
        if (!(deadline in CORE_PLAN_BY_DEADLINE)) {
            throw new Error(`v0.8 aligned v1 core candidate has an unreviewed deadline: ${label}`);
        }
        return CORE_PLAN_BY_DEADLINE[deadline as keyof typeof CORE_PLAN_BY_DEADLINE];
    }
    const plan = NON_CORE_SEARCH_PLAN[label as keyof typeof NON_CORE_SEARCH_PLAN];
    if (!plan) throw new Error(`v0.8 aligned v1 source candidate has no reviewed search plan: ${label}`);
    return plan;
}

export function buildV08AlignedV1ProductionCandidateCatalog(): IV08AlignedV1CandidateGenome[] {
    const source = buildV07AlignedV2ProductionCandidateCatalog();
    const nonCoreLabels = new Set(
        source.map((genome) => genome.search.label).filter((label) => !label?.startsWith("aligned-prod-core-")),
    );
    if (
        nonCoreLabels.size !== Object.keys(NON_CORE_SEARCH_PLAN).length ||
        Object.keys(NON_CORE_SEARCH_PLAN).some((label) => !nonCoreLabels.has(label))
    ) {
        throw new Error("v0.8 aligned v1 non-core search-plan review drifted from its source catalog");
    }
    const catalog = source.map((sourceGenome) => {
        const genome = structuredClone(sourceGenome);
        const plan = reviewedSearchPlan(genome);
        genome.search.includeMoves = true;
        genome.search.rollouts = plan.rollouts;
        genome.controls.decisionDeadlineMs = plan.decisionDeadlineMs;
        return normalizeV08AlignedV1CandidateGenome(genome);
    });
    const hashes = catalog.map(fingerprintV08AlignedV1CandidateGenome);
    if (
        catalog.length !== V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT ||
        new Set(hashes).size !== V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT
    ) {
        throw new Error("v0.8 aligned v1 production candidate catalog census or uniqueness drifted");
    }
    return catalog.map((genome) => structuredClone(genome));
}

export function buildV08AlignedV1ProductionIncumbentGenome(): IV08AlignedV1CandidateGenome {
    return normalizeV08AlignedV1CandidateGenome(structuredClone(buildV07AlignedV2ProductionIncumbentGenome()));
}

export interface IV08AlignedV1ProductionCatalogIdentity {
    schemaVersion: 1;
    artifactKind: "v0_8_aligned_96h_v1_production_catalog_identity";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    candidateCount: 48;
    candidateLimit: 48;
    trainScenariosPerCell: 256;
    orderedCandidateGenomeSha256: string[];
    incumbentGenomeSha256: string;
    catalogSha256: string;
}

/** Pinned from the canonical identity after the current-engine catalog review. */
export const V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256 =
    "61d969139f574bf886820a5f0bd0b5c76677cda905b30a24e1fb0010c17eb64e" as const;

export function buildV08AlignedV1ProductionCatalogIdentity(): IV08AlignedV1ProductionCatalogIdentity {
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_8_aligned_96h_v1_production_catalog_identity" as const,
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        candidateCount: V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
        candidateLimit: V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
        trainScenariosPerCell: V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL,
        orderedCandidateGenomeSha256: buildV08AlignedV1ProductionCandidateCatalog().map(
            fingerprintV08AlignedV1CandidateGenome,
        ),
        incumbentGenomeSha256: fingerprintV08AlignedV1CandidateGenome(buildV08AlignedV1ProductionIncumbentGenome()),
    };
    return { ...unsigned, catalogSha256: fingerprintV08AlignedV1(unsigned) };
}

export interface IV08AlignedV1ProductionCatalogInput {
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    candidateLimit: number;
    candidateGenomes: readonly IV08AlignedV1CandidateGenome[];
    incumbentGenome: IV08AlignedV1CandidateGenome;
    trainScenariosPerCell: number;
}

export function assertV08AlignedV1ProductionCatalogInput(input: IV08AlignedV1ProductionCatalogInput): void {
    assertAligned96hVersionProfile(input.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    const expected = buildV08AlignedV1ProductionCatalogIdentity();
    const actualHashes = input.candidateGenomes.map(fingerprintV08AlignedV1CandidateGenome);
    const incumbentHash = fingerprintV08AlignedV1CandidateGenome(input.incumbentGenome);
    if (
        expected.catalogSha256 !== V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256 ||
        input.candidateLimit !== V08_ALIGNED_V1_PRODUCTION_CANDIDATE_LIMIT ||
        input.candidateGenomes.length !== V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT ||
        input.trainScenariosPerCell !== V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL ||
        incumbentHash !== expected.incumbentGenomeSha256 ||
        actualHashes.includes(incumbentHash) ||
        canonicalV08AlignedV1Json(actualHashes) !== canonicalV08AlignedV1Json(expected.orderedCandidateGenomeSha256)
    ) {
        throw new Error("v0.8 aligned v1 formal run must use the exact version-bound production catalog");
    }
}
