import { describe, expect, test } from "bun:test";

import registration from "../../docs/evidence/v0_9_native_draft_registration_20261105.json";
import previous from "../../docs/evidence/v0_9_doctrine_draft_v4_registration_20261105.json";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../../src/ai/setup/doctrine_draft_policy";
import { v09DoctrineBoard, V09_A19_DOCTRINES } from "../../src/simulation/v0_9/a19_doctrine_population";
import {
    lockedDoctrineDraftNativeQualification,
    LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
} from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import { NATIVE_V09_DRAFT_SETUP } from "../../src/simulation/v0_9/doctrine_draft_native";
import { pairedDoctrineDraftStatistics } from "../../src/simulation/v0_9/doctrine_draft_training";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

describe("locked native v0.9 draft qualification", () => {
    test("preserves the prospective registration, native profile and fresh seed channels", () => {
        const { registrationSha256, ...body } = registration;
        expect(fingerprintV09(body)).toBe(registrationSha256);
        const fixture = lockedDoctrineDraftNativeQualification();
        expect(fixture.result.registrationSha256).toBe(registrationSha256);
        expect(fixture.result.modelSha256).toBe(LOCKED_DOCTRINE_DRAFT_MODEL_SHA256);
        expect(fixture.result.profile).toEqual(registration.profile);
        expect(registration.profile.draft).toBe(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
        expect(registration.profile.setup).toBe(NATIVE_V09_DRAFT_SETUP);
        expect(registration.profile.fight).toBe("v0.9");
        expect(registration.profile.search).toBe(false);
        expect(fixture.result.nativeDecisions).toBeGreaterThan(0);
        expect(fixture.result.rejectedActions).toBe(0);
        expect(fixture.result.preflightFailures).toBe(0);
        expect(fixture.result.fullDoctrineBudgets).toBe(true);
        expect(fixture.combatArtifactPromotion).toBe(false);
        expect(fixture.result.originalScoutingSpecificGatePassed).toBe(false);
        const prior = new Set(
            Object.values(previous.banks).flatMap((bank) => bank.flatMap((seed) => [seed, seed + 1, seed + 2])),
        );
        const channels = Object.values(registration.banks).flatMap((bank) =>
            bank.flatMap((seed) => [seed, seed + 1, seed + 2]),
        );
        expect(new Set(channels).size).toBe(channels.length);
        expect(channels.some((seed) => prior.has(seed))).toBe(false);
        fixture.result.comparisons.current.boardDeltaEighths[0] += 1;
        expect(lockedDoctrineDraftNativeQualification().result.comparisons.current.boardDeltaEighths[0]).not.toBe(
            fixture.result.comparisons.current.boardDeltaEighths[0],
        );
    });

    test("replays both comparisons from all 1512 independent paired board scores", () => {
        const fixture = lockedDoctrineDraftNativeQualification();
        for (const control of ["current", "masked"] as const) {
            const comparison = fixture.result.comparisons[control];
            expect(comparison.boardDeltaEighths).toHaveLength(registration.banks.qualification.length);
            const rows = comparison.boardDeltaEighths.map((score, board) => {
                const { candidateDoctrinePolicy, opponentDoctrinePolicy } = v09DoctrineBoard(
                    board,
                    "balanced-doctrines-v1",
                );
                if (candidateDoctrinePolicy === "ranked-variety" || opponentDoctrinePolicy === "ranked-variety")
                    throw new Error("Native doctrine schedule changed");
                expect(Number.isInteger(score) && Math.abs(score) <= 8).toBe(true);
                return {
                    board,
                    map: [1, 3, 4][board % 3],
                    candidateDoctrinePolicy,
                    opponentDoctrinePolicy,
                    delta: score / 8,
                };
            });
            const independent = fixture.independentVerification.comparisons[control];
            expect(pairedDoctrineDraftStatistics(rows)).toEqual(comparison.pooled);
            expect(comparison.pooled).toEqual(independent.pooled);
            for (const doctrine of V09_A19_DOCTRINES) {
                const selected = rows.filter((row) => row.candidateDoctrinePolicy === doctrine);
                expect(pairedDoctrineDraftStatistics(selected)).toEqual(comparison.doctrines[doctrine]);
                expect(comparison.doctrines[doctrine]).toEqual(independent.doctrines[doctrine]);
                if (doctrine === "see-none") expect(selected.every((row) => row.delta === 0)).toBe(true);
            }
        }
    });
});
