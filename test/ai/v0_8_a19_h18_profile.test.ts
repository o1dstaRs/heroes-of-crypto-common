import { describe, expect, it } from "bun:test";

import {
    buildV08A19H18SearchEnvironment,
    V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_CANDIDATE_ID,
    V08_A19_H18_GENOME,
    V08_A19_H18_GENOME_SHA256,
    V08_A19_H18_PROFILE,
    V08_A19_H18_SEARCH,
} from "../../src/ai/versions/v0_8_a19_h18_profile";
import { V08_A13_GENOME, V08_A13_SEARCH } from "../../src/ai/versions/v0_8_a13_profile";
import {
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";

describe("v0.8 a19 h18 research profile", () => {
    it("changes only the bounded rollout horizon from a13", () => {
        expect(V08_A19_H18_SEARCH).toMatchObject({
            ...V08_A13_SEARCH,
            horizon: 18,
        });
        expect(V08_A19_H18_GENOME.search.horizon).toBe(18);
        expect(V08_A19_H18_GENOME.controls).toBe(V08_A13_GENOME.controls);
        expect(fingerprintV08AlignedV1CandidateGenome(V08_A19_H18_GENOME)).toBe(V08_A19_H18_GENOME_SHA256);
    });

    it("materializes an exact h18 environment and clear research derivation", () => {
        const environment = buildV08A19H18SearchEnvironment();
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_HORIZON: "18",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_SHORTLIST: "3",
            SEARCH_VERSIONS: "v0.8",
        });
        expect(fingerprintV08AlignedV1(environment)).toBe(V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256);
        expect(V08_A19_H18_PROFILE).toMatchObject({
            candidateId: V08_A19_H18_CANDIDATE_ID,
            researchOnly: true,
            derivesFrom: {
                candidateId: "a13",
                changedSearchControls: { horizon: { from: 12, to: 18 } },
            },
        });
    });

    it("constructs an enabled driver with the requested 18-unit-turn horizon", () => {
        const driver = withScopedAIEnvironment(
            buildV08A19H18SearchEnvironment(),
            () =>
                new SearchDriver({} as ILookaheadDeps, {
                    seed: 19,
                    greenVersion: "v0.8",
                    redVersion: "v0.7",
                }),
        );
        expect(driver.enabled).toBe(true);
        expect((driver as unknown as { horizon: number }).horizon).toBe(18);
    });
});
