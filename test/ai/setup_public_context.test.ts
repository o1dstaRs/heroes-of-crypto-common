import { describe, expect, test } from "bun:test";

import {
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    parseSetupPolicyBehavior,
    resolveSetupPolicy,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_PUBLIC_ROSTER_SETUP_SPEC,
    type IResolvedSetupPolicy,
} from "../../src/ai/setup/setup_ship";
import {
    createPlacementSetupDecisionContext,
    createTier2ArtifactDecisionContext,
    type IPlacementSetupDecisionContext,
    type ITier2ArtifactDecisionContext,
} from "../../src/ai/setup/setup_strategy";
import { RANKED_REPLAY_TACTICS_SETUP_SPEC } from "../../src/ai/setup/setup_replay_tactics";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const ownCreatureIds = Object.freeze([1, 2, 7, 15]);
const ownCreatureStacks = Object.freeze([1, 1, 2, 7, 15]);
const offeredArtifacts = Object.freeze([1, 4, 10]);

const setupContext = (
    publicOpponentCreatureIds: readonly number[],
    gridType: PBTypes.GridVals,
): Readonly<IPlacementSetupDecisionContext> =>
    createPlacementSetupDecisionContext({
        publicOpponentCreatureIds: Object.freeze([...publicOpponentCreatureIds]),
        gridType,
        gridSize: 16,
        ownDoctrine: 4,
        ownArtifactIds: Object.freeze([2, 10]),
    });

const decisions = (
    policy: IResolvedSetupPolicy,
    tier2Context?: Readonly<ITier2ArtifactDecisionContext>,
    placementContext?: Readonly<IPlacementSetupDecisionContext>,
): unknown => ({
    artifact: policy.pickArtifactT2(offeredArtifacts, ownCreatureIds, tier2Context),
    augments: policy.pickAugments(7, ownCreatureIds, placementContext),
    synergies: policy.pickSynergies(ownCreatureStacks, placementContext),
});

describe("fair setup decision context", () => {
    test("contains only public opponent identities, public map data, and the acting seat's setup", () => {
        const context = setupContext([9, 15, 37], PBTypes.GridVals.BLOCK_CENTER);

        expect(Object.keys(context).sort()).toEqual([
            "decisionPhase",
            "gridSize",
            "gridType",
            "opponentRosterVisibility",
            "ownArtifactIds",
            "ownDoctrine",
            "publicOpponentCreatureIds",
        ]);
        expect(context.decisionPhase).toBe("placement");
        expect(context.opponentRosterVisibility).toBe("complete");
        expect(context.publicOpponentCreatureIds).toEqual([9, 15, 37]);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.publicOpponentCreatureIds)).toBe(true);
        expect(Object.isFrozen(context.ownArtifactIds)).toBe(true);
    });

    test("marks a private Setup roster as partial without changing the public Board default", () => {
        const privateSetup = createPlacementSetupDecisionContext({
            publicOpponentCreatureIds: [9],
            opponentRosterVisibility: "partial",
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            gridSize: 16,
        });
        const publicBoard = createPlacementSetupDecisionContext({
            publicOpponentCreatureIds: [9, 15, 37],
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            gridSize: 16,
        });

        expect(privateSetup).toMatchObject({
            decisionPhase: "placement",
            opponentRosterVisibility: "partial",
            publicOpponentCreatureIds: [9],
        });
        expect(publicBoard.opponentRosterVisibility).toBe("complete");
    });

    test("Tier-2 context is necessarily partial and strips private fields", () => {
        const context = createTier2ArtifactDecisionContext({
            publicOpponentCreatureIds: [9, 9, 15],
            ownDoctrine: 4,
            ownArtifactIds: [2],
            // Exercise the runtime boundary as well as the discriminated TypeScript contract.
            gridType: PBTypes.GridVals.LAVA_CENTER,
            gridSize: 16,
            opponentPlacement: [{ x: 1, y: 2 }],
            decisionPhase: "placement",
            opponentRosterVisibility: "complete",
        } as unknown as Parameters<typeof createTier2ArtifactDecisionContext>[0]);

        expect(context).toEqual({
            decisionPhase: "tier2-artifact",
            opponentRosterVisibility: "partial",
            publicOpponentCreatureIds: [9, 15],
            gridType: PBTypes.GridVals.LAVA_CENTER,
            gridSize: 16,
            ownDoctrine: 4,
            ownArtifactIds: [2],
        });
        expect("opponentPlacement" in context).toBe(false);
        expect(Object.isFrozen(context)).toBe(true);
    });

    test("carries the opponent's artifacts and drafted army only with a complete public roster", () => {
        const army = [
            { creatureId: 37, amount: 12 },
            { creatureId: 9, amount: 140 },
            { creatureId: 15, amount: 0 },
        ];
        const publicSetup = createPlacementSetupDecisionContext({
            publicOpponentCreatureIds: [9, 15, 37],
            gridType: PBTypes.GridVals.NORMAL,
            gridSize: 16,
            publicOpponentArtifactIds: [3, 0],
            publicOpponentArmy: army,
        });
        expect(publicSetup.publicOpponentArtifactIds).toEqual([3]);
        expect(publicSetup.publicOpponentArmy).toEqual([
            { creatureId: 9, amount: 140 },
            { creatureId: 37, amount: 12 },
        ]);
        expect(Object.isFrozen(publicSetup.publicOpponentArtifactIds)).toBe(true);
        expect(Object.isFrozen(publicSetup.publicOpponentArmy)).toBe(true);
        expect(Object.isFrozen(publicSetup.publicOpponentArmy![0])).toBe(true);
        army[0].amount = 1;
        expect(publicSetup.publicOpponentArmy![1].amount).toBe(12);

        const privateSetup = createPlacementSetupDecisionContext({
            publicOpponentCreatureIds: [9],
            opponentRosterVisibility: "partial",
            gridType: PBTypes.GridVals.NORMAL,
            gridSize: 16,
            publicOpponentArtifactIds: [3, 17],
            publicOpponentArmy: army,
        });
        expect("publicOpponentArtifactIds" in privateSetup).toBe(false);
        expect("publicOpponentArmy" in privateSetup).toBe(false);
    });

    test("shipped setup modes decide the same with the opponent's artifacts and army in the context", () => {
        const plain = setupContext([9, 15, 37], PBTypes.GridVals.BLOCK_CENTER);
        const detailed = createPlacementSetupDecisionContext({
            publicOpponentCreatureIds: [9, 15, 37],
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            gridSize: 16,
            ownDoctrine: 4,
            ownArtifactIds: Object.freeze([2, 10]),
            publicOpponentArtifactIds: [5, 17],
            publicOpponentArmy: [
                { creatureId: 9, amount: 120 },
                { creatureId: 15, amount: 30 },
                { creatureId: 37, amount: 4 },
            ],
        });
        for (const spec of [
            undefined,
            "conditional-v1",
            RANKED_REPLAY_TACTICS_SETUP_SPEC,
            V07_NONFIGHT_SETUP_SPEC,
            V07_PUBLIC_ROSTER_SETUP_SPEC,
            V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
        ]) {
            const policy = resolveSetupPolicy(spec);
            expect(decisions(policy, undefined, detailed)).toEqual(decisions(policy, undefined, plain));
        }
    });

    test("all currently shipped setup modes remain opponent- and map-invariant", () => {
        const firstPlacement = setupContext([9, 15, 37], PBTypes.GridVals.BLOCK_CENTER);
        const secondPlacement = setupContext([31], PBTypes.GridVals.LAVA_CENTER);
        const firstTier2 = createTier2ArtifactDecisionContext({
            publicOpponentCreatureIds: [9, 15],
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            gridSize: 16,
        });
        const secondTier2 = createTier2ArtifactDecisionContext({
            publicOpponentCreatureIds: [31],
            gridType: PBTypes.GridVals.LAVA_CENTER,
            gridSize: 16,
        });

        for (const spec of [
            undefined,
            "conditional-v1",
            RANKED_REPLAY_TACTICS_SETUP_SPEC,
            V07_NONFIGHT_SETUP_SPEC,
            V07_PUBLIC_ROSTER_SETUP_SPEC,
            V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
        ]) {
            const policy = resolveSetupPolicy(spec);
            const baseline = decisions(policy);
            expect(decisions(policy, firstTier2, firstPlacement)).toEqual(baseline);
            expect(decisions(policy, secondTier2, secondPlacement)).toEqual(baseline);
        }
    });

    test("public-roster placement remains a distinct frozen artifact, not an incumbent mutation", () => {
        const candidate = parseSetupPolicyBehavior({
            ...V07_NONFIGHT_SETUP_ARTIFACT.policy,
            placement: "public-roster",
        });

        expect(candidate.placement).toBe("public-roster");
        expect(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy).toEqual(candidate);
        expect(V07_NONFIGHT_SETUP_ARTIFACT.policy.placement).toBe("legitimate-reveal");
        expect(resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC).placement).toBe("legitimate-reveal");
        expect(resolveSetupPolicy(V07_PUBLIC_ROSTER_SETUP_SPEC).placement).toBe("public-roster");
        expect(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy.placement).toBe(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT);
        expect(resolveSetupPolicy(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC).placement).toBe(
            COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
        );
    });
});
