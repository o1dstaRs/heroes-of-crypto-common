/*
 * -----------------------------------------------------------------------------
 * Step (movement) modifiers must fold into getSteps() through adjustBaseStats — the SAME path the ranked
 * server runs via UnitsHolder.refreshStackPowerForAllUnits. Guards the reported "Chaos movement synergy
 * not working in ranked": if adjustBaseStats is fed the synergy/morale, getSteps() must reflect it.
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const RANGE = PBTypes.AttackVals.RANGE;

// adjustBaseStats(hasFightStarted, lap, synAbilityPower, synMovementSteps, synFlyArmor, synMorale, synLuck, stepsMoraleMult)
const adjust = (u: ReturnType<typeof createTestUnit>, synMove: number, stepsMoraleMult = 0) =>
    u.adjustBaseStats(true, 1, 0, synMove, 0, 0, 0, stepsMoraleMult);

describe("step modifiers fold into getSteps (ranked adjustBaseStats path)", () => {
    const mk = () => createTestUnit({ name: "Beholder", team: LOWER, attackType: RANGE, speed: 4, morale: 0 });

    it("Chaos MOVEMENT synergy adds its steps to getSteps()", () => {
        const u = mk();
        adjust(u, 0);
        const base = u.getSteps();
        adjust(u, 2);
        expect(u.getSteps()).toBe(base + 2);
    });

    it("morale × multiplier adds steps (Crown of Command morale, high-morale units)", () => {
        const u = createTestUnit({ name: "Mover", team: LOWER, attackType: RANGE, speed: 4, morale: 10 });
        adjust(u, 0, 0);
        const noMorale = u.getSteps();
        adjust(u, 0, 0.2); // +0.2 step per morale point → +2 at morale 10
        expect(u.getSteps()).toBe(noMorale + 2);
    });

    it("synergy and morale stack", () => {
        const u = createTestUnit({ name: "Mover2", team: LOWER, attackType: RANGE, speed: 4, morale: 5 });
        adjust(u, 0, 0);
        const base = u.getSteps();
        adjust(u, 1, 0.2); // +1 synergy, +1 morale (0.2*5)
        expect(u.getSteps()).toBe(base + 2);
    });
});
