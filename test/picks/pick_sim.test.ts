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
import { Doctrine } from "../../src/doctrines/doctrine_properties";
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

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const first: PickRandomInt = () => 0;

const apply = (state: IPickSimState, action: PickAction, rng: PickRandomInt = first): PickTransition =>
    transitionPickSim(state, action, rng);

const accept = (state: IPickSimState, action: PickAction, rng: PickRandomInt = first): IPickSimState => {
    const result = apply(state, action, rng);
    expect(result.status).toBe("accepted");
    return result.state;
};

const finishDoctrinePhase = (state: IPickSimState): IPickSimState => {
    state = accept(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.SEE_NONE });
    return accept(state, { type: "select_doctrine", team: RIGHT, doctrine: Doctrine.SEE_NONE });
};

const finishBundlePhase = (state: IPickSimState): IPickSimState => {
    state = accept(state, { type: "select_bundle", team: LEFT, bundleIndex: 0 });
    return accept(state, { type: "select_bundle", team: RIGHT, bundleIndex: 0 });
};

describe("pick_sim", () => {
    it("generates the live bundles, offers, and 6/6/3/5 auto-bans in server RNG order", () => {
        const drawPoolSizes: number[] = [];
        const state = createPickSimState((maxExclusive) => {
            drawPoolSizes.push(maxExclusive);
            return 0;
        });

        // The two bundles a team is offered carry DIFFERENT Tier-1 artifacts. Note what the old fixture
        // pinned here: with a constant RNG both bundles held artifact 1, which is precisely the bug --
        // the artifact stopped being part of the choice.
        expect(state.left.bundles).toEqual([
            [1, 4, 1],
            [2, 5, 2],
        ]);
        expect(state.right.bundles).toEqual([
            [3, 6, 1],
            [11, 14, 2],
        ]);
        expect(state.left.tier2Offers).toEqual([1, 2, 4]);
        expect(state.right.tier2Offers).toEqual([1, 2, 4]);
        expect(state.creaturesBanned).toEqual([
            12, 13, 21, 22, 23, 31, 15, 16, 24, 25, 26, 34, 7, 8, 17, 9, 10, 19, 20, 29,
        ]);
        expect(drawPoolSizes).toEqual([
            16,
            15,
            14,
            13, // four globally distinct L1 offers (16-creature pool: Mermaid, Dryad, Blacksmith, Wandering Mage)
            16,
            15,
            14,
            13, // four globally distinct L2 offers (16-creature pool: Battle Mage in, Zena out to L3)
            12,
            11, // left's distinct T1 pair (12-artifact live pool: the arcane ring is in)
            12,
            11, // right's distinct T1 pair
            12,
            11,
            10, // lower T2 offer (12-artifact live pool)
            12,
            11,
            10, // upper T2 offer
            12,
            11,
            10,
            9,
            8,
            7, // six L1 bans after excluding all four offers (16-creature pool)
            12,
            11,
            10,
            9,
            8,
            7, // six L2 bans after excluding all four offers (16-creature pool: Battle Mage in, Zena out to L3)
            12,
            11,
            10, // L3 bans (12-creature pool: the Life Monk, the Chaos Nightmare, Zena up from L2, Pegasus down from L4)
            12,
            11,
            10,
            9,
            8, // L4 bans (12-creature pool: Arachna Queen and Magic Dragon in, Pegasus out to L3)
        ]);

        const offered = [...state.left.bundles, ...state.right.bundles].flatMap(([l1, l2]) => [l1, l2]);
        expect(state.creaturesBanned.some((creatureId) => offered.includes(creatureId))).toBe(false);
    });

    it("splits DOCTRINE (doctrine) from INITIAL_PICK (bundle) into two sequential both-teams phases", () => {
        let state = createPickSimState(first);
        const last: PickRandomInt = (maxExclusive) => maxExclusive - 1;

        // DOCTRINE phase (seq 0): doctrine only. Bundle selections are NOT accepted here.
        const rejectedBundle = apply(state, { type: "select_bundle", team: LEFT, bundleIndex: 1 });
        expect(rejectedBundle).toMatchObject({ status: "rejected", reason: "wrong_phase" });
        state = accept(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.THREE_REVEALS }, last);
        // By-level reveal (server arango_hoc.ts): one L1 slot (rng(2)->1), one L2 slot (2+1=3),
        // and the L3 slot (rng(2)->1 truthy -> 4); sorted [1, 3, 4].
        expect(state.left.revealedOpponentSlots).toEqual([1, 3, 4]);
        expect(state.phaseSequence).toBe(0);
        state = accept(state, { type: "select_doctrine", team: RIGHT, doctrine: Doctrine.SEE_ALL });
        // Both doctrines chosen -> DOCTRINE advances to the INITIAL_PICK (bundle) phase.
        expect(state.phaseSequence).toBe(1);
        expect(state.right.revealedOpponentSlots).toEqual([0, 1, 2, 3, 4, 5]);

        // INITIAL_PICK phase (seq 1): starting bundle only.
        expect(getPickTeamView(state, LEFT).bundles).toEqual([
            [1, 4, 1],
            [2, 5, 2],
        ]);
        const rejectedDoctrine = apply(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.SEE_NONE });
        expect(rejectedDoctrine).toMatchObject({ status: "rejected", reason: "wrong_phase" });
        state = accept(state, { type: "select_bundle", team: RIGHT, bundleIndex: 0 });
        expect(state.phaseSequence).toBe(1);
        state = accept(state, { type: "select_bundle", team: LEFT, bundleIndex: 1 });
        // Both bundles chosen -> INITIAL_PICK advances to the first PICK phase (seq 2).
        expect(state.phaseSequence).toBe(2);
        expect(state.left.creatures).toEqual([2, 5]);
        expect(state.right.creatures).toEqual([3, 6]);
        expect(getPickTeamView(state, LEFT).bundles).toEqual([]);
    });

    it("reveals a hidden collision without advancing, then enforces the shared exclusive pool", () => {
        let state = finishBundlePhase(finishDoctrinePhase(createPickSimState(first)));
        const before = state;
        const collision = apply(state, { type: "pick_creature", team: LEFT, creatureId: 3 });

        expect(collision.status).toBe("collision");
        state = collision.state;
        expect(before.left.revealedOpponentSlots).toEqual([]);
        expect(state.phaseSequence).toBe(2);
        expect(state.left.revealedOpponentSlots).toEqual([0]);
        expect(getKnownOpponentCreatures(state, LEFT)).toEqual([3]);
        expect(getVisibleCreatureChoices(state, LEFT)).not.toContain(3);
        expect(getOmniscientCreatureChoices(before, LEFT)).not.toContain(3);
        expect(state.transcript.at(-1)).toMatchObject({
            type: "creature_collision",
            creatureId: 3,
            phaseBefore: 2,
            phaseAfter: 2,
        });

        const repeated = apply(state, { type: "pick_creature", team: LEFT, creatureId: 3 });
        expect(repeated).toMatchObject({ status: "rejected", reason: "creature_already_taken" });
        expect(repeated.state).toBe(state);
    });

    it("runs the exact snake order through simultaneous Tier-2 picks to completion", () => {
        let state = finishBundlePhase(finishDoctrinePhase(createPickSimState(first)));
        const creatureActions: PickAction[] = [
            { type: "pick_creature", team: LEFT, creatureId: 2 },
            { type: "pick_creature", team: RIGHT, creatureId: 11 },
            { type: "pick_creature", team: RIGHT, creatureId: 5 },
            { type: "pick_creature", team: LEFT, creatureId: 14 },
            { type: "pick_creature", team: LEFT, creatureId: 18 },
            { type: "pick_creature", team: RIGHT, creatureId: 27 },
        ];
        for (const action of creatureActions) {
            state = accept(state, action);
        }
        expect(state.phaseSequence).toBe(8);

        const outsideOffer = apply(state, { type: "select_tier2", team: LEFT, artifactId: 5 });
        expect(outsideOffer).toMatchObject({ status: "rejected", reason: "artifact_not_offered" });
        state = accept(state, { type: "select_tier2", team: RIGHT, artifactId: 1 });
        expect(state.phaseSequence).toBe(8);
        state = accept(state, { type: "select_tier2", team: LEFT, artifactId: 1 });
        expect(state.phaseSequence).toBe(9);

        // Angel (40) rather than Pegasus (30) for the last L4 slot — Pegasus dropped to L3.
        state = accept(state, { type: "pick_creature", team: RIGHT, creatureId: 40 });
        state = accept(state, { type: "pick_creature", team: LEFT, creatureId: 39 });

        expect(isPickSimComplete(state)).toBe(true);
        expect(state.phaseSequence).toBe(11);
        expect(state.left.creatures).toEqual([1, 4, 2, 14, 18, 39]);
        expect(state.right.creatures).toEqual([3, 6, 11, 5, 27, 40]);
        expect(state.left.remainingByLevel).toEqual([0, 0, 0, 0]);
        expect(state.right.remainingByLevel).toEqual([0, 0, 0, 0]);
        expect(state.transcript.map((event) => event.type)).toEqual([
            "doctrine_selected",
            "doctrine_selected",
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
        const state = finishBundlePhase(finishDoctrinePhase(createPickSimState(first)));
        let draws = 0;
        const rng: PickRandomInt = () => {
            draws += 1;
            return 0;
        };
        const result = apply(state, { type: "pick_creature", team: RIGHT, creatureId: 11 }, rng);

        expect(result).toMatchObject({ status: "rejected", reason: "not_actor" });
        expect(result.state).toBe(state);
        expect(draws).toBe(0);
    });

    it("does not expose future reveal slots or alias transcript entries through transition events", () => {
        let state = createPickSimState(first);
        const result = apply(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.SEE_ALL });
        expect(result.status).toBe("accepted");
        state = result.state;

        expect(getPickTeamView(state, LEFT)).not.toHaveProperty("revealedOpponentSlots");
        expect(getPickTeamView(state, LEFT).knownOpponentCreatures).toEqual([]);
        if (result.status === "accepted" && result.event.type === "doctrine_selected") {
            result.event.revealedOpponentSlots.length = 0;
        }
        expect(state.transcript[0]).toMatchObject({
            type: "doctrine_selected",
            revealedOpponentSlots: [0, 1, 2, 3, 4, 5],
        });
    });
});

describe("the starting bundles", () => {
    // A player was offered the SAME Tier-1 artifact in both bundles. Each bundle used to draw its artifact
    // independently out of twelve, so about one team in twelve lost the artifact half of the choice
    // entirely -- whichever bundle they took, they got that artifact. One seed proves nothing here, so
    // sweep enough of them that an 8%-per-team collision cannot hide.
    const lcg = (seed: number): PickRandomInt => {
        let state = seed >>> 0;
        return (maxExclusive: number) => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % maxExclusive;
        };
    };

    it("never offers a team the same artifact in both bundles", () => {
        for (let seed = 1; seed <= 400; seed += 1) {
            const state = createPickSimState(lcg(seed));
            for (const team of [state.left, state.right]) {
                const [first, second] = team.bundles;
                expect(first[2]).not.toBe(second[2]);
            }
        }
    });

    it("still offers two genuinely different bundles either side of the artifact", () => {
        for (let seed = 1; seed <= 200; seed += 1) {
            const state = createPickSimState(lcg(seed));
            const creatures = [...state.left.bundles, ...state.right.bundles].flatMap(([l1, l2]) => [l1, l2]);
            // All four bundles' creatures are distinct across BOTH teams, so no two bundles anywhere are alike.
            expect(new Set(creatures).size).toBe(creatures.length);
        }
    });

    it("keeps the Tier-2 offers distinct too", () => {
        for (let seed = 1; seed <= 200; seed += 1) {
            const state = createPickSimState(lcg(seed));
            for (const team of [state.left, state.right]) {
                expect(new Set(team.tier2Offers).size).toBe(team.tier2Offers.length);
            }
        }
    });
});
