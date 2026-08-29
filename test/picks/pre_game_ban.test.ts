/*
 * -----------------------------------------------------------------------------
 * Optional pre-game unit ban.
 *
 * During the DOCTRINE step either player may additionally nominate ONE creature to be
 * banned. When the step closes: nobody nominated -> nothing happens; both nominated
 * the same unit -> it is banned outright; two different -> exactly one of the two,
 * 50/50. The ban REPLACES an auto-ban of its own level, so each level still loses
 * LIVE_AUTO_BANS_BY_LEVEL[level - 1] creatures.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import {
    createPickSimState,
    getBannableCreatures,
    LIVE_AUTO_BANS_BY_LEVEL,
    transitionPickSim,
    type IPickSimState,
    type PickAction,
    type PickRandomInt,
} from "../../src/picks/pick_sim";
import { CreatureLevelMap } from "../../src/units/unit_properties";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const first: PickRandomInt = () => 0;

const accept = (state: IPickSimState, action: PickAction, rng: PickRandomInt = first): IPickSimState => {
    const result = transitionPickSim(state, action, rng);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
        throw new Error(`expected accepted, got ${result.status}`);
    }
    return result.state;
};

/** Close the doctrine step, which is where the nominations resolve. */
const finishDoctrines = (state: IPickSimState, rng: PickRandomInt = first): IPickSimState => {
    let next = accept(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.SEE_NONE }, rng);
    return accept(next, { type: "select_doctrine", team: RIGHT, doctrine: Doctrine.SEE_NONE }, rng);
};

const bansPerLevel = (state: IPickSimState): number[] => {
    const counts = [0, 0, 0, 0];
    for (const creatureId of state.creaturesBanned) {
        const level = CreatureLevelMap[creatureId];
        if (level) {
            counts[level - 1] += 1;
        }
    }
    return counts;
};

describe("pre-game unit ban", () => {
    it("offers only creatures that are neither auto-banned nor sitting in a bundle offer", () => {
        const state = createPickSimState(first);
        const bannable = getBannableCreatures(state);
        const offered = [...state.left.bundles, ...state.right.bundles].flatMap(([l1, l2]) => [l1, l2]);

        expect(bannable.length).toBeGreaterThan(0);
        for (const creatureId of bannable) {
            expect(state.creaturesBanned).not.toContain(creatureId);
            expect(offered).not.toContain(creatureId);
        }
    });

    it("bans nothing when neither player nominates one", () => {
        const before = createPickSimState(first);
        const after = finishDoctrines(before);

        expect(after.extraBan).toBeUndefined();
        expect(after.creaturesBanned).toEqual(before.creaturesBanned);
    });

    it("bans the agreed unit outright when both players nominate the same one", () => {
        let state = createPickSimState(first);
        const target = getBannableCreatures(state)[0];
        state = accept(state, { type: "propose_ban", team: LEFT, creatureId: target });
        state = accept(state, { type: "propose_ban", team: RIGHT, creatureId: target });

        // rng that would pick either side still has to land on the agreed unit — there is nothing to roll.
        for (const rng of [() => 0, () => 1] as PickRandomInt[]) {
            const resolved = finishDoctrines(state, rng);
            expect(resolved.extraBan).toBe(target);
            expect(resolved.creaturesBanned).toContain(target);
        }
    });

    it("takes one of the two nominations, chosen by the roll", () => {
        let state = createPickSimState(first);
        const bannable = getBannableCreatures(state);
        const leftPick = bannable[0];
        const rightPick = bannable.find((id) => id !== leftPick)!;
        state = accept(state, { type: "propose_ban", team: LEFT, creatureId: leftPick });
        state = accept(state, { type: "propose_ban", team: RIGHT, creatureId: rightPick });

        expect(finishDoctrines(state, () => 0).extraBan).toBe(leftPick);
        expect(finishDoctrines(state, () => 1).extraBan).toBe(rightPick);
        // Only ONE of them is ever banned.
        const resolved = finishDoctrines(state, () => 0);
        expect(resolved.creaturesBanned).toContain(leftPick);
        expect(resolved.creaturesBanned).not.toContain(rightPick);
    });

    it("bans a lone nomination, with no competing ban to roll against", () => {
        let state = createPickSimState(first);
        const target = getBannableCreatures(state)[0];
        state = accept(state, { type: "propose_ban", team: RIGHT, creatureId: target });

        const resolved = finishDoctrines(state);
        expect(resolved.extraBan).toBe(target);
        expect(resolved.creaturesBanned).toContain(target);
    });

    it("keeps each level's ban count unchanged by releasing an auto-ban of the same level", () => {
        const baseline = bansPerLevel(finishDoctrines(createPickSimState(first)));
        expect(baseline).toEqual([...LIVE_AUTO_BANS_BY_LEVEL]);

        let state = createPickSimState(first);
        const target = getBannableCreatures(state)[0];
        state = accept(state, { type: "propose_ban", team: LEFT, creatureId: target });
        const resolved = finishDoctrines(state);

        // The player steered one of that level's bans rather than adding one on top.
        expect(bansPerLevel(resolved)).toEqual(baseline);
        expect(resolved.creaturesBanned).toContain(target);
        expect(resolved.creaturesBanned.length).toBe(baseline.reduce((sum, count) => sum + count, 0));
    });

    it("refuses a second nomination, an unbannable creature, and anything after the doctrine step", () => {
        let state = createPickSimState(first);
        const bannable = getBannableCreatures(state);
        state = accept(state, { type: "propose_ban", team: LEFT, creatureId: bannable[0] });

        expect(
            transitionPickSim(state, { type: "propose_ban", team: LEFT, creatureId: bannable[1] }, first),
        ).toMatchObject({ status: "rejected", reason: "ban_already_proposed" });
        expect(
            transitionPickSim(state, { type: "propose_ban", team: RIGHT, creatureId: state.creaturesBanned[0] }, first),
        ).toMatchObject({ status: "rejected", reason: "creature_not_bannable" });

        const afterDoctrines = finishDoctrines(state);
        expect(
            transitionPickSim(afterDoctrines, { type: "propose_ban", team: RIGHT, creatureId: bannable[1] }, first),
        ).toMatchObject({ status: "rejected", reason: "wrong_phase" });
    });

    it("keeps a nomination out of the opponent's view until it resolves", () => {
        let state = createPickSimState(first);
        const target = getBannableCreatures(state)[0];
        state = accept(state, { type: "propose_ban", team: LEFT, creatureId: target });

        // Nothing the opponent can read has changed: the ban list is untouched until the step closes.
        expect(state.creaturesBanned).not.toContain(target);
        expect(state.extraBan).toBeUndefined();
        expect(state.right.proposedBan).toBeUndefined();
    });
});
