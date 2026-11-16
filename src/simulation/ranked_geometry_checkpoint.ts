import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const LOCKED_RANKED_GEOMETRY_ID = "ranked-geometry-current-spending-20261115";
export const LOCKED_RANKED_GEOMETRY_EVIDENCE_SHA256 =
    "e2b7460772787f8e32bf57901dfc02a2e57c94dc5e3f55e1301477ea241d8161";
export const LOCKED_RANKED_GEOMETRY_POLICY_SHA256 = "928540a4b21981aeb3240440f611ba7d5b9ce55be4a489656e6afa43e64fc7a0";

interface ILockedGeometryEvidence {
    checkpointId: string;
    productionPromotion: false;
    servingQualified: false;
    policyBundleSha256: string;
    registrationSha256: string;
    primaryIndependentResult: {
        gate: true;
        independentFamilies: number;
        contrast: { gainPoints: number; ci95Points: number[] };
    };
    workCounts: { logical: number; unique: number; reuse: number };
    reservedNewChannels: number[];
    familyScores: { task: { id: string }; scores: number[][] }[];
}

interface ILockedGeometryPolicy {
    id: string;
    files: { path: string; sha256: string; text: string }[];
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export function lockedRankedGeometryCheckpoint(): {
    evidence: ILockedGeometryEvidence;
    policy: ILockedGeometryPolicy;
} {
    const evidenceBytes = readFileSync(
        new URL("../../docs/evidence/ranked_geometry_confirmation_20261115.json", import.meta.url),
    );
    const policyBytes = readFileSync(
        new URL("./checkpoints/ranked_geometry_20261115/policy_bundle.json", import.meta.url),
    );
    if (
        sha256(evidenceBytes) !== LOCKED_RANKED_GEOMETRY_EVIDENCE_SHA256 ||
        sha256(policyBytes) !== LOCKED_RANKED_GEOMETRY_POLICY_SHA256
    ) {
        throw new Error("Locked ranked geometry artifact changed");
    }
    const evidence = JSON.parse(evidenceBytes.toString("utf8")) as ILockedGeometryEvidence;
    const policy = JSON.parse(policyBytes.toString("utf8")) as ILockedGeometryPolicy;
    if (
        evidence.checkpointId !== LOCKED_RANKED_GEOMETRY_ID ||
        policy.id !== LOCKED_RANKED_GEOMETRY_ID ||
        evidence.policyBundleSha256 !== LOCKED_RANKED_GEOMETRY_POLICY_SHA256 ||
        evidence.productionPromotion !== false ||
        evidence.servingQualified !== false ||
        evidence.primaryIndependentResult.gate !== true ||
        evidence.primaryIndependentResult.independentFamilies !== 324 ||
        evidence.workCounts.logical !== 25920 ||
        evidence.workCounts.unique !== 16514 ||
        evidence.workCounts.reuse !== 9406 ||
        evidence.familyScores.length !== 324 ||
        evidence.reservedNewChannels.length !== 12312 ||
        new Set(evidence.reservedNewChannels).size !== 12312
    ) {
        throw new Error("Locked ranked geometry contract changed");
    }
    for (const source of policy.files) {
        if (sha256(source.text) !== source.sha256) throw new Error(`Locked geometry source changed: ${source.path}`);
    }
    return { evidence, policy };
}
