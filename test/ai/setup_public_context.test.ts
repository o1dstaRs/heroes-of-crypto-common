import { describe, expect, test } from "bun:test";

import {
    parseSetupPolicyBehavior,
    resolveSetupPolicy,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    type IResolvedSetupPolicy,
} from "../../src/ai/setup/setup_ship";
import type { ISetupDecisionContext } from "../../src/ai/setup/setup_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const ownCreatureIds = Object.freeze([1, 2, 7, 15]);
const ownCreatureStacks = Object.freeze([1, 1, 2, 7, 15]);
const offeredArtifacts = Object.freeze([1, 4, 10]);

const setupContext = (
    publicOpponentCreatureIds: readonly number[],
    gridType: PBTypes.GridVals,
): Readonly<ISetupDecisionContext> =>
    Object.freeze({
        publicOpponentCreatureIds: Object.freeze([...publicOpponentCreatureIds]),
        gridType,
        gridSize: 16,
        ownPerk: 4,
        ownArtifactIds: Object.freeze([2, 10]),
    });

const decisions = (policy: IResolvedSetupPolicy, context?: Readonly<ISetupDecisionContext>): unknown => ({
    artifact: policy.pickArtifactT2(offeredArtifacts, ownCreatureIds, context),
    augments: policy.pickAugments(7, ownCreatureIds, context),
    synergies: policy.pickSynergies(ownCreatureStacks, context),
});

describe("fair setup decision context", () => {
    test("contains only public opponent identities, public map data, and the acting seat's setup", () => {
        const context = setupContext([9, 15, 37], PBTypes.GridVals.BLOCK_CENTER);

        expect(Object.keys(context).sort()).toEqual([
            "gridSize",
            "gridType",
            "ownArtifactIds",
            "ownPerk",
            "publicOpponentCreatureIds",
        ]);
        expect(context.publicOpponentCreatureIds).toEqual([9, 15, 37]);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.publicOpponentCreatureIds)).toBe(true);
        expect(Object.isFrozen(context.ownArtifactIds)).toBe(true);
    });

    test("all currently shipped setup modes remain opponent- and map-invariant", () => {
        const first = setupContext([9, 15, 37], PBTypes.GridVals.BLOCK_CENTER);
        const second = setupContext([31], PBTypes.GridVals.LAVA_CENTER);

        for (const spec of [undefined, "conditional-v1", V07_NONFIGHT_SETUP_SPEC]) {
            const policy = resolveSetupPolicy(spec);
            const baseline = decisions(policy);
            expect(decisions(policy, first)).toEqual(baseline);
            expect(decisions(policy, second)).toEqual(baseline);
        }
    });

    test("public-roster placement is an explicit candidate, not a frozen-policy mutation", () => {
        const candidate = parseSetupPolicyBehavior({
            ...V07_NONFIGHT_SETUP_ARTIFACT.policy,
            placement: "public-roster",
        });

        expect(candidate.placement).toBe("public-roster");
        expect(V07_NONFIGHT_SETUP_ARTIFACT.policy.placement).toBe("legitimate-reveal");
        expect(resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC).placement).toBe("legitimate-reveal");
    });
});
