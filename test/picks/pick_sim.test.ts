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

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Perk } from "../../src/perks/perk_properties";
import {
    createPickSimState,
    getKnownOpponentCreatures,
    getOmniscientCreatureChoices,
    getPickTeamView,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type PickAction,
    type PickRandomInt,
    type PickTransition,
} from "../../src/picks/pick_sim";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const first: PickRandomInt = () => 0;

const apply = (state: IPickSimState, action: PickAction, rng: PickRandomInt = first): PickTransition =>
    transitionPickSim(state, action, rng);

const accept = (state: IPickSimState, action: PickAction, rng: PickRandomInt = first): IPickSimState => {
    const result = apply(state, action, rng);
    expect(result.status).toBe("accepted");
    return result.state;
};

const finishPerkPhase = (state: IPickSimState): IPickSimState => {
    state = accept(state, { type: "select_perk", team: LOWER, perk: Perk.SEE_NONE });
    return accept(state, { type: "select_perk", team: UPPER, perk: Perk.SEE_NONE });
};

const finishBundlePhase = (state: IPickSimState): IPickSimState => {
    state = accept(state, { type: "select_bundle", team: LOWER, bundleIndex: 0 });
    return accept(state, { type: "select_bundle", team: UPPER, bundleIndex: 0 });
};

describe("pick_sim", () => {
    it("generates the live bundles, offers, and 5/5/3/3 auto-bans in server RNG order", () => {
        const drawPoolSizes: number[] = [];
        const state = createPickSimState((maxExclusive) => {
            drawPoolSizes.push(maxExclusive);
            return 0;
        });

        expect(state.lower.bundles).toEqual([
            [1, 4, 1],
            [2, 5, 1],
        ]);
        expect(state.upper.bundles).toEqual([
            [3, 6, 1],
            [11, 14, 1],
        ]);
        expect(state.lower.tier2Offers).toEqual([1, 2, 3]);
        expect(state.upper.tier2Offers).toEqual([1, 2, 3]);
        expect(state.creaturesBanned).toEqual([12, 13, 21, 22, 23, 15, 16, 24, 25, 26, 7, 8, 17, 9, 10, 19]);
        expect(drawPoolSizes).toEqual([
            12,
            11,
            10,
            9, // four globally distinct L1 offers
            12,
            11,
            10,
            9, // four globally distinct L2 offers
            12,
            12,
            12,
            12, // independent T1 rolls
            12,
            11,
            10, // lower T2 offer
            12,
            11,
            10, // upper T2 offer
            8,
            7,
            6,
            5,
            4, // L1 bans after excluding all four offers
            8,
            7,
            6,
            5,
            4, // L2 bans after excluding all four offers
            8,
            7,
            6, // L3 bans
            12,
            11,
            10, // L4 bans (12-creature pool after enabling Arachna Queen)
        ]);

        const offered = [...state.lower.bundles, ...state.upper.bundles].flatMap(([l1, l2]) => [l1, l2]);
        expect(state.creaturesBanned.some((creatureId) => offered.includes(creatureId))).toBe(false);
    });

    it("splits PERK (doctrine) from INITIAL_PICK (bundle) into two sequential both-teams phases", () => {
        let state = createPickSimState(first);
        const last: PickRandomInt = (maxExclusive) => maxExclusive - 1;

        // PERK phase (seq 0): doctrine only. Bundle selections are NOT accepted here.
        const rejectedBundle = apply(state, { type: "select_bundle", team: LOWER, bundleIndex: 1 });
        expect(rejectedBundle).toMatchObject({ status: "rejected", reason: "wrong_phase" });
        state = accept(state, { type: "select_perk", team: LOWER, perk: Perk.THREE_REVEALS }, last);
        // By-level reveal (server arango_hoc.ts): one L1 slot (rng(2)->1), one L2 slot (2+1=3),
        // and the L3 slot (rng(2)->1 truthy -> 4); sorted [1, 3, 4].
        expect(state.lower.revealedOpponentSlots).toEqual([1, 3, 4]);
        expect(state.phaseSequence).toBe(0);
        state = accept(state, { type: "select_perk", team: UPPER, perk: Perk.SEE_ALL });
        // Both doctrines chosen -> PERK advances to the INITIAL_PICK (bundle) phase.
        expect(state.phaseSequence).toBe(1);
        expect(state.upper.revealedOpponentSlots).toEqual([0, 1, 2, 3, 4, 5]);

        // INITIAL_PICK phase (seq 1): starting bundle only.
        expect(getPickTeamView(state, LOWER).bundles).toEqual([
            [1, 4, 1],
            [2, 5, 1],
        ]);
        const rejectedPerk = apply(state, { type: "select_perk", team: LOWER, perk: Perk.SEE_NONE });
        expect(rejectedPerk).toMatchObject({ status: "rejected", reason: "wrong_phase" });
        state = accept(state, { type: "select_bundle", team: UPPER, bundleIndex: 0 });
        expect(state.phaseSequence).toBe(1);
        state = accept(state, { type: "select_bundle", team: LOWER, bundleIndex: 1 });
        // Both bundles chosen -> INITIAL_PICK advances to the first PICK phase (seq 2).
        expect(state.phaseSequence).toBe(2);
        expect(state.lower.creatures).toEqual([2, 5]);
        expect(state.upper.creatures).toEqual([3, 6]);
        expect(getPickTeamView(state, LOWER).bundles).toEqual([]);
    });

    it("reveals a hidden collision without advancing, then enforces the shared exclusive pool", () => {
        let state = finishBundlePhase(finishPerkPhase(createPickSimState(first)));
        const before = state;
        const collision = apply(state, { type: "pick_creature", team: LOWER, creatureId: 3 });

        expect(collision.status).toBe("collision");
        state = collision.state;
        expect(before.lower.revealedOpponentSlots).toEqual([]);
        expect(state.phaseSequence).toBe(2);
        expect(state.lower.revealedOpponentSlots).toEqual([0]);
        expect(getKnownOpponentCreatures(state, LOWER)).toEqual([3]);
        expect(getVisibleCreatureChoices(state, LOWER)).not.toContain(3);
        expect(getOmniscientCreatureChoices(before, LOWER)).not.toContain(3);
        expect(state.transcript.at(-1)).toMatchObject({
            type: "creature_collision",
            creatureId: 3,
            phaseBefore: 2,
            phaseAfter: 2,
        });

        const repeated = apply(state, { type: "pick_creature", team: LOWER, creatureId: 3 });
        expect(repeated).toMatchObject({ status: "rejected", reason: "creature_already_taken" });
        expect(repeated.state).toBe(state);
    });

    it("runs the exact snake order through simultaneous 3-of-12 T2 picks to completion", () => {
        let state = finishBundlePhase(finishPerkPhase(createPickSimState(first)));
        const creatureActions: PickAction[] = [
            { type: "pick_creature", team: LOWER, creatureId: 2 },
            { type: "pick_creature", team: UPPER, creatureId: 11 },
            { type: "pick_creature", team: UPPER, creatureId: 5 },
            { type: "pick_creature", team: LOWER, creatureId: 14 },
            { type: "pick_creature", team: LOWER, creatureId: 18 },
            { type: "pick_creature", team: UPPER, creatureId: 27 },
        ];
        for (const action of creatureActions) {
            state = accept(state, action);
        }
        expect(state.phaseSequence).toBe(8);

        const outsideOffer = apply(state, { type: "select_tier2", team: LOWER, artifactId: 4 });
        expect(outsideOffer).toMatchObject({ status: "rejected", reason: "artifact_not_offered" });
        state = accept(state, { type: "select_tier2", team: UPPER, artifactId: 1 });
        expect(state.phaseSequence).toBe(8);
        state = accept(state, { type: "select_tier2", team: LOWER, artifactId: 1 });
        expect(state.phaseSequence).toBe(9);

        state = accept(state, { type: "pick_creature", team: UPPER, creatureId: 20 });
        state = accept(state, { type: "pick_creature", team: LOWER, creatureId: 29 });

        expect(isPickSimComplete(state)).toBe(true);
        expect(state.phaseSequence).toBe(11);
        expect(state.lower.creatures).toEqual([1, 4, 2, 14, 18, 29]);
        expect(state.upper.creatures).toEqual([3, 6, 11, 5, 27, 20]);
        expect(state.lower.remainingByLevel).toEqual([0, 0, 0, 0]);
        expect(state.upper.remainingByLevel).toEqual([0, 0, 0, 0]);
        expect(state.transcript.map((event) => event.type)).toEqual([
            "perk_selected",
            "perk_selected",
            "bundle_selected",
            "bundle_selected",
            "creature_picked",
            "creature_picked",
            "creature_picked",
            "creature_picked",
            "creature_picked",
            "creature_picked",
            "tier2_selected",
            "tier2_selected",
            "creature_picked",
            "creature_picked",
        ]);
    });

    it("rejects out-of-turn actions without mutating state or consuming RNG", () => {
        const state = finishBundlePhase(finishPerkPhase(createPickSimState(first)));
        let draws = 0;
        const rng: PickRandomInt = () => {
            draws += 1;
            return 0;
        };
        const result = apply(state, { type: "pick_creature", team: UPPER, creatureId: 11 }, rng);

        expect(result).toMatchObject({ status: "rejected", reason: "not_actor" });
        expect(result.state).toBe(state);
        expect(draws).toBe(0);
    });

    it("does not expose future reveal slots or alias transcript entries through transition events", () => {
        let state = createPickSimState(first);
        const result = apply(state, { type: "select_perk", team: LOWER, perk: Perk.SEE_ALL });
        expect(result.status).toBe("accepted");
        state = result.state;

        expect(getPickTeamView(state, LOWER)).not.toHaveProperty("revealedOpponentSlots");
        expect(getPickTeamView(state, LOWER).knownOpponentCreatures).toEqual([]);
        if (result.status === "accepted" && result.event.type === "perk_selected") {
            result.event.revealedOpponentSlots.length = 0;
        }
        expect(state.transcript[0]).toMatchObject({
            type: "perk_selected",
            revealedOpponentSlots: [0, 1, 2, 3, 4, 5],
        });
    });
});
