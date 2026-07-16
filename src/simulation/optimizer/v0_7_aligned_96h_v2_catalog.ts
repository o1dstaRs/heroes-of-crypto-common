/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import outcome from "../results/v0_7_96h_d68490a_outcome.json";
import { DEFAULT_V07_VALUE_WEIGHTS, MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11 } from "../v0_7_value_weights";
import { VALUE_FEATURE_NAMES_V2 } from "../value_features";
import {
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    fingerprintV07AlignedV2CandidateGenome,
    normalizeV07AlignedV2CandidateGenome,
    type IV07AlignedV2CandidateControls,
    type IV07AlignedV2CandidateGenome,
} from "./v0_7_aligned_96h_v2_protocol";
import { fingerprintV0796hGenome, normalizeV0796hGenome, type IV0796hGenome } from "./v0_7_96h_core";

export const V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT = 48 as const;
export const V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT = V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT;
export const V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL = 256 as const;
export const V07_ALIGNED_V2_B9CE_SOURCE_GENOME_SHA256 =
    "b9ce98a735b14c7e57a5b83b70b4bca6b2e45d6a23ce35dd27c2e5b914b1abaa" as const;
export const V07_ALIGNED_V2_PRODUCTION_INCUMBENT_GENOME_SHA256 =
    "06c6e947a645140e97d58baa8dc8ae2b58bc0085547b91acb6619a6a3ca926a4" as const;

const MODEL_WIDTH = VALUE_FEATURE_NAMES_V2.length;

type LeafId = "committed" | "multicohort" | "b9ce" | "midpoint";

interface ILeafAnchor {
    id: LeafId;
    leaf: { b: number; w: number[] };
}

const committedLeaf = (): ILeafAnchor => ({
    id: "committed",
    leaf: {
        b: DEFAULT_V07_VALUE_WEIGHTS.b,
        w: [...DEFAULT_V07_VALUE_WEIGHTS.w, ...new Array(MODEL_WIDTH - DEFAULT_V07_VALUE_WEIGHTS.w.length).fill(0)],
    },
});

const multicohortLeaf = (): ILeafAnchor => ({
    id: "multicohort",
    leaf: {
        b: MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11.b,
        w: [...MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11.w],
    },
});

function b9ceSourceGenome(): IV0796hGenome {
    const candidate = outcome.lateResearchCandidate;
    if (candidate.genomeId !== V07_ALIGNED_V2_B9CE_SOURCE_GENOME_SHA256) {
        throw new Error("aligned v2 b9ce source outcome identity drifted");
    }
    const genome = normalizeV0796hGenome(candidate.genome as IV0796hGenome);
    if (fingerprintV0796hGenome(genome) !== V07_ALIGNED_V2_B9CE_SOURCE_GENOME_SHA256) {
        throw new Error("aligned v2 b9ce source genome fingerprint drifted");
    }
    return genome;
}

const b9ceLeaf = (): ILeafAnchor => {
    const source = b9ceSourceGenome();
    if (source.leafMode !== "model" || !source.leaf) throw new Error("aligned v2 b9ce source leaf is unavailable");
    return { id: "b9ce", leaf: { b: source.leaf.b, w: [...source.leaf.w] } };
};

function productionLeafAnchors(): ILeafAnchor[] {
    const committed = committedLeaf();
    const multicohort = multicohortLeaf();
    const b9ce = b9ceLeaf();
    if ([committed, multicohort, b9ce].some(({ leaf }) => leaf.w.length !== MODEL_WIDTH)) {
        throw new Error(`aligned v2 production leaves must contain ${MODEL_WIDTH} weights`);
    }
    const midpoint: ILeafAnchor = {
        id: "midpoint",
        leaf: {
            b: (multicohort.leaf.b + b9ce.leaf.b) / 2,
            w: multicohort.leaf.w.map((weight, index) => (weight + b9ce.leaf.w[index]) / 2),
        },
    };
    return [committed, multicohort, b9ce, midpoint];
}

const BASE_CONTROLS: IV07AlignedV2CandidateControls = {
    activeChallengers: true,
    shortlist: 2,
    decisionDeadlineMs: 150,
    lateRangedFinishWeight: 0,
    pureRangedTerminalWeight: 0,
    meleeRangedTargetWeight: 0,
    placementReveal: true,
    denseMeleeMagicIsolation: false,
    auraCasterMode: "off",
};

interface ICandidateSpec {
    label: string;
    leaf: ILeafAnchor;
    horizon: number;
    shortlist: 2 | 3 | 4;
    deadline: 125 | 150 | 175;
    maxMelee: number;
    maxShots: number;
    maxThrows: number;
    gate?: number;
    activeChallengers?: boolean;
    lateRangedFinishWeight?: 0 | 2 | 4;
    pureRangedTerminalWeight?: 0 | 0.5 | 1;
    meleeRangedTargetWeight?: 0 | 2;
    placementReveal?: boolean;
    denseMeleeMagicIsolation?: boolean;
    auraCasterMode?: "off" | "windflow" | "resurrection_windflow";
}

function candidate(spec: ICandidateSpec): IV07AlignedV2CandidateGenome {
    return normalizeV07AlignedV2CandidateGenome({
        search: {
            leafMode: "model",
            leaf: { b: spec.leaf.leaf.b, w: [...spec.leaf.leaf.w] },
            gate: spec.gate ?? 0.025,
            horizon: spec.horizon,
            rollouts: 1,
            includeMoves: false,
            maxMelee: spec.maxMelee,
            maxShots: spec.maxShots,
            maxThrows: spec.maxThrows,
            label: spec.label,
        },
        controls: {
            ...BASE_CONTROLS,
            activeChallengers: spec.activeChallengers ?? BASE_CONTROLS.activeChallengers,
            shortlist: spec.shortlist,
            decisionDeadlineMs: spec.deadline,
            lateRangedFinishWeight: spec.lateRangedFinishWeight ?? BASE_CONTROLS.lateRangedFinishWeight,
            pureRangedTerminalWeight: spec.pureRangedTerminalWeight ?? BASE_CONTROLS.pureRangedTerminalWeight,
            meleeRangedTargetWeight: spec.meleeRangedTargetWeight ?? BASE_CONTROLS.meleeRangedTargetWeight,
            placementReveal: spec.placementReveal ?? BASE_CONTROLS.placementReveal,
            denseMeleeMagicIsolation: spec.denseMeleeMagicIsolation ?? BASE_CONTROLS.denseMeleeMagicIsolation,
            auraCasterMode: spec.auraCasterMode ?? BASE_CONTROLS.auraCasterMode,
        },
    });
}

function coreCandidates(leaves: readonly ILeafAnchor[]): IV07AlignedV2CandidateGenome[] {
    return leaves.flatMap((leaf) =>
        ([4, 8] as const).flatMap((horizon) =>
            ([125, 150, 175] as const).map((deadline) =>
                candidate({
                    label: `aligned-prod-core-${leaf.id}-h${horizon}-d${deadline}`,
                    leaf,
                    horizon,
                    shortlist: 2,
                    deadline,
                    maxMelee: 4,
                    maxShots: 3,
                    maxThrows: 2,
                }),
            ),
        ),
    );
}

function policyCandidates(b9ce: ILeafAnchor): IV07AlignedV2CandidateGenome[] {
    return ([false, true] as const).flatMap((denseMeleeMagicIsolation) =>
        (["off", "windflow", "resurrection_windflow"] as const)
            .filter((auraCasterMode) => denseMeleeMagicIsolation || auraCasterMode !== "off")
            .map((auraCasterMode) =>
                candidate({
                    label: `aligned-prod-policy-b9ce-dense${Number(denseMeleeMagicIsolation)}-${auraCasterMode}`,
                    leaf: b9ce,
                    horizon: 8,
                    shortlist: 2,
                    deadline: 150,
                    maxMelee: 4,
                    maxShots: 3,
                    maxThrows: 2,
                    denseMeleeMagicIsolation,
                    auraCasterMode,
                }),
            ),
    );
}

function depthCandidates(leaves: readonly ILeafAnchor[]): IV07AlignedV2CandidateGenome[] {
    return leaves.flatMap((leaf) =>
        ([150, 175] as const).map((deadline) =>
            candidate({
                label: `aligned-prod-depth-${leaf.id}-h12-d${deadline}`,
                leaf,
                horizon: 12,
                shortlist: 3,
                deadline,
                maxMelee: 6,
                maxShots: 4,
                maxThrows: 2,
            }),
        ),
    );
}

function rangedCandidates(b9ce: ILeafAnchor): IV07AlignedV2CandidateGenome[] {
    return [
        candidate({
            label: "aligned-prod-ranged-b9ce-late2",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            lateRangedFinishWeight: 2,
        }),
        candidate({
            label: "aligned-prod-ranged-b9ce-late4",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            lateRangedFinishWeight: 4,
        }),
        candidate({
            label: "aligned-prod-ranged-b9ce-pure05",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            pureRangedTerminalWeight: 0.5,
        }),
        candidate({
            label: "aligned-prod-ranged-b9ce-pure1",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            pureRangedTerminalWeight: 1,
        }),
    ];
}

function controlCandidates(b9ce: ILeafAnchor, midpoint: ILeafAnchor): IV07AlignedV2CandidateGenome[] {
    return [
        candidate({
            label: "aligned-prod-control-b9ce-h8-inactive-s3",
            leaf: b9ce,
            horizon: 8,
            shortlist: 3,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            activeChallengers: false,
        }),
        candidate({
            label: "aligned-prod-control-midpoint-h8-inactive-s3",
            leaf: midpoint,
            horizon: 8,
            shortlist: 3,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            activeChallengers: false,
        }),
        candidate({
            label: "aligned-prod-control-b9ce-h12-s4",
            leaf: b9ce,
            horizon: 12,
            shortlist: 4,
            deadline: 150,
            maxMelee: 6,
            maxShots: 4,
            maxThrows: 2,
        }),
    ];
}

/** Two matched w57 probes replace the redundant h4/midpoint placement-off arms; h8/h12 reveal controls remain. */
function meleeRangedTargetAndPlacementControls(b9ce: ILeafAnchor): IV07AlignedV2CandidateGenome[] {
    return [
        candidate({
            label: "aligned-prod-melee-ranged-target-b9ce-h8",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            meleeRangedTargetWeight: 2,
        }),
        candidate({
            label: "aligned-prod-placement-off-b9ce-h8",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            placementReveal: false,
        }),
        candidate({
            label: "aligned-prod-placement-off-b9ce-h12",
            leaf: b9ce,
            horizon: 12,
            shortlist: 3,
            deadline: 150,
            maxMelee: 6,
            maxShots: 4,
            maxThrows: 2,
            placementReveal: false,
        }),
        candidate({
            label: "aligned-prod-melee-ranged-target-b9ce-h12",
            leaf: b9ce,
            horizon: 12,
            shortlist: 3,
            deadline: 150,
            maxMelee: 6,
            maxShots: 4,
            maxThrows: 2,
            meleeRangedTargetWeight: 2,
        }),
    ];
}

function calibrationCandidates(b9ce: ILeafAnchor, midpoint: ILeafAnchor): IV07AlignedV2CandidateGenome[] {
    return [
        candidate({
            label: "aligned-prod-calibration-b9ce-gate01",
            leaf: b9ce,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            gate: 0.01,
        }),
        candidate({
            label: "aligned-prod-calibration-midpoint-gate01",
            leaf: midpoint,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            gate: 0.01,
        }),
        candidate({
            label: "aligned-prod-calibration-midpoint-late2",
            leaf: midpoint,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            lateRangedFinishWeight: 2,
        }),
        candidate({
            label: "aligned-prod-calibration-midpoint-pure05",
            leaf: midpoint,
            horizon: 8,
            shortlist: 2,
            deadline: 150,
            maxMelee: 4,
            maxShots: 3,
            maxThrows: 2,
            pureRangedTerminalWeight: 0.5,
        }),
    ];
}

export function buildV07AlignedV2ProductionCandidateCatalog(): IV07AlignedV2CandidateGenome[] {
    const leaves = productionLeafAnchors();
    const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
    const b9ce = byId.get("b9ce")!;
    const midpoint = byId.get("midpoint")!;
    const catalog = [
        ...coreCandidates(leaves),
        ...policyCandidates(b9ce),
        ...depthCandidates([b9ce, midpoint]),
        ...rangedCandidates(b9ce),
        ...controlCandidates(b9ce, midpoint),
        ...meleeRangedTargetAndPlacementControls(b9ce),
        ...calibrationCandidates(b9ce, midpoint),
    ];
    const hashes = catalog.map(fingerprintV07AlignedV2CandidateGenome);
    if (
        catalog.length !== V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT ||
        new Set(hashes).size !== V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT
    ) {
        throw new Error("aligned v2 production candidate catalog census or uniqueness drifted");
    }
    return catalog.map((genome) => structuredClone(genome));
}

export function buildV07AlignedV2ProductionIncumbentGenome(): IV07AlignedV2CandidateGenome {
    const committed = committedLeaf();
    return normalizeV07AlignedV2CandidateGenome({
        search: {
            leafMode: "model",
            leaf: { b: committed.leaf.b, w: [...committed.leaf.w] },
            gate: 0.01,
            horizon: 12,
            rollouts: 3,
            includeMoves: false,
            maxMelee: 8,
            maxShots: 6,
            maxThrows: 4,
            label: "aligned-production-incumbent-committed-20d",
        },
        controls: {
            activeChallengers: false,
            shortlist: null,
            decisionDeadlineMs: 200,
            lateRangedFinishWeight: 0,
            pureRangedTerminalWeight: 0,
            meleeRangedTargetWeight: 0,
            placementReveal: false,
            denseMeleeMagicIsolation: false,
            auraCasterMode: "off",
        },
    });
}

export interface IV07AlignedV2ProductionCatalogIdentity {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_production_catalog_identity";
    candidateCount: 48;
    candidateLimit: 48;
    trainScenariosPerCell: 256;
    orderedCandidateGenomeSha256: string[];
    incumbentGenomeSha256: string;
    catalogSha256: string;
}

/** Filled from the canonical identity below; changing any behavior requires an intentional update. */
export const V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256 =
    "b9978265851c8ea5e1b2d799332cff7937419db17e4cf6862659eadaf00138be" as const;

export function buildV07AlignedV2ProductionCatalogIdentity(): IV07AlignedV2ProductionCatalogIdentity {
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_production_catalog_identity" as const,
        candidateCount: V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT,
        candidateLimit: V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT,
        trainScenariosPerCell: V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL,
        orderedCandidateGenomeSha256: buildV07AlignedV2ProductionCandidateCatalog().map(
            fingerprintV07AlignedV2CandidateGenome,
        ),
        incumbentGenomeSha256: fingerprintV07AlignedV2CandidateGenome(buildV07AlignedV2ProductionIncumbentGenome()),
    };
    return { ...unsigned, catalogSha256: fingerprintV07AlignedV2(unsigned) };
}

export interface IV07AlignedV2ProductionCatalogInput {
    candidateLimit: number;
    candidateGenomes: readonly IV07AlignedV2CandidateGenome[];
    incumbentGenome: IV07AlignedV2CandidateGenome;
    trainScenariosPerCell: number;
}

/** Production callers supply the exact code-owned ordered catalog; declarations and subset hashes are not trusted. */
export function assertV07AlignedV2ProductionCatalogInput(input: IV07AlignedV2ProductionCatalogInput): void {
    const expected = buildV07AlignedV2ProductionCatalogIdentity();
    const actualHashes = input.candidateGenomes.map(fingerprintV07AlignedV2CandidateGenome);
    const incumbentHash = fingerprintV07AlignedV2CandidateGenome(input.incumbentGenome);
    if (
        expected.catalogSha256 !== V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256 ||
        expected.incumbentGenomeSha256 !== V07_ALIGNED_V2_PRODUCTION_INCUMBENT_GENOME_SHA256 ||
        input.candidateLimit !== V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT ||
        input.candidateGenomes.length !== V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT ||
        input.trainScenariosPerCell !== V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL ||
        incumbentHash !== expected.incumbentGenomeSha256 ||
        canonicalV07AlignedV2Json(actualHashes) !== canonicalV07AlignedV2Json(expected.orderedCandidateGenomeSha256)
    ) {
        throw new Error("aligned v2 formal run must use the exact code-owned production catalog and train census");
    }
}
