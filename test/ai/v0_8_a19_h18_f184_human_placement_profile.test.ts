/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import {
    V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_CANDIDATE_ID,
    V08_A19_H18_GENOME_SHA256,
    V08_A19_H18_PROFILE,
    V08_A19_H18_PROFILE_SCHEMA,
} from "../../src/ai/versions/v0_8_a19_h18_profile";
import {
    createV08A19H18F184HumanPlacementStrategy,
    V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION,
    V08_A19_H18_F184_HUMAN_PLACEMENT_CANDIDATE_ID,
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
    V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING,
    V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE,
} from "../../src/ai/versions/v0_8_a19_h18_f184_human_placement_profile";
import {
    V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_HUMAN_PLACEMENT_POLICY,
    V08A19F184HumanPlacementStrategy,
} from "../../src/ai/versions/v0_8_a19_f184_human_placement";
import {
    V08_A19_PROD_F184_FIXTURE_ID,
    V08_A19_PROD_F184_FIXTURE_SHA256,
    V08_A19_PROD_F184_MATCH_ID,
} from "../../src/simulation/v0_8_a19_prod_f184_anchor";

const implementationUrl = new URL(`../../${V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE}`, import.meta.url);

describe("v0.8 A19-H18 f184 human-placement research profile", () => {
    it("derives explicitly from the unchanged frozen A19-H18 profile", () => {
        expect(V08_A19_H18_PROFILE).toMatchObject({
            schema: V08_A19_H18_PROFILE_SCHEMA,
            candidateId: V08_A19_H18_CANDIDATE_ID,
            genomeSha256: V08_A19_H18_GENOME_SHA256,
            behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
            researchOnly: true,
        });
        expect(Object.isFrozen(V08_A19_H18_PROFILE)).toBe(true);
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.derivesFrom).toBe(V08_A19_H18_PROFILE);
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE).toMatchObject({
            candidateId: V08_A19_H18_F184_HUMAN_PLACEMENT_CANDIDATE_ID,
            baseVersion: "v0.8",
            genomeSha256: V08_A19_H18_GENOME_SHA256,
            behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
            researchOnly: true,
        });
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.genome).toBe(V08_A19_H18_PROFILE.genome);
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.search).toBe(V08_A19_H18_PROFILE.search);
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.policy).toBe(V08_A19_H18_PROFILE.policy);
    });

    it("pins the exact placement implementation source bytes", () => {
        const bytes = readFileSync(implementationUrl);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
        );
    });

    it("binds the reviewed policy identity, public-roster requirement, and exact NORMAL opening scope", () => {
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING).toMatchObject({
            schema: V08_A19_F184_HUMAN_PLACEMENT_POLICY.schema,
            policyId: V08_A19_F184_HUMAN_PLACEMENT_POLICY.policyId,
            implementationSource: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
            implementationSha256: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
            informationRequirement: "public-roster",
            productionFixture: {
                matchId: V08_A19_PROD_F184_MATCH_ID,
                fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
                sha256: V08_A19_PROD_F184_FIXTURE_SHA256,
            },
            scope: {
                map: "NORMAL",
                formation: "prod-f184-observed-opening",
                placementType: "RECTANGLE",
                placementDepth: 3,
                legalZoneCellCount: 42,
                exactPublicMatchup: true,
                openingIds: ["prod-f184-lower-roster", "prod-f184-upper-roster"],
                rosterCreatureIds: {
                    left: [3, 4, 6, 9, 33, 37],
                    right: [12, 27, 34, 43, 47, 55],
                },
            },
        });
        expect(V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256).toBe(V08_A19_PROD_F184_FIXTURE_SHA256);
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING.scope.gridTypes).toBe(
            V08_A19_F184_HUMAN_PLACEMENT_POLICY.maps,
        );
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.placementPolicy).toBe(
            V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING,
        );
        expect(Object.isFrozen(V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING)).toBe(true);
        expect(Object.isFrozen(V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING.scope)).toBe(true);
    });

    it("creates a fresh decorator and fresh v0.8 base for every request", () => {
        const first = createV08A19H18F184HumanPlacementStrategy();
        const second = createV08A19H18F184HumanPlacementStrategy();
        const baseOf = (strategy: V08A19F184HumanPlacementStrategy): StrategyV0_8 =>
            (strategy as unknown as { base: StrategyV0_8 }).base;

        expect(first).toBeInstanceOf(V08A19F184HumanPlacementStrategy);
        expect(second).toBeInstanceOf(V08A19F184HumanPlacementStrategy);
        expect(first).not.toBe(second);
        expect(first.version).toBe(V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION);
        expect(baseOf(first)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(second)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(first)).not.toBe(baseOf(second));
        expect(baseOf(first).version).toBe("v0.8");
    });
});
