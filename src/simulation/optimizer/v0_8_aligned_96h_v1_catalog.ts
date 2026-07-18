/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * The finite behavior catalog intentionally preserves aligned-v2's reviewed 48
 * arms. Every arm is rebound and re-evaluated as v0.8s on the current engine.
 */

import {
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionIncumbentGenome,
} from "./v0_7_aligned_96h_v2_catalog";
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

export function buildV08AlignedV1ProductionCandidateCatalog(): IV08AlignedV1CandidateGenome[] {
    const catalog = buildV07AlignedV2ProductionCandidateCatalog().map((genome) =>
        normalizeV08AlignedV1CandidateGenome(structuredClone(genome)),
    );
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

/** Filled from the canonical v0.8 identity after the current-engine catalog is reviewed. */
export const V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256 =
    "2295126ba6fc694e66f8bb646504769099a1ea18d05b9474bdd358a07d61da29" as const;

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
