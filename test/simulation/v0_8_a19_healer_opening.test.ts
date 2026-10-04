import { describe, expect, it } from "bun:test";

import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { isEarlyUnsupportedHealerDive } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

const healer = {
    getId: () => "healer",
    getTeam: () => 2,
    getLevel: () => 4,
    canFly: () => true,
    getAbility: (name: string) => (name === "Resurrection" ? {} : undefined),
    getCells: () => [
        { x: 2, y: 8 },
        { x: 2, y: 9 },
    ],
};
const screen = { getId: () => "screen", isDead: () => false, getCells: () => [{ x: 1, y: 8 }] };
const holder = { getAllAllies: () => [healer, screen] } as unknown as ILookaheadDeps["unitsHolder"];
const dive = {
    actions: [
        {
            type: "move_unit" as const,
            unitId: "healer",
            path: [],
            targetCells: [
                { x: 11, y: 13 },
                { x: 10, y: 13 },
            ],
        },
        { type: "melee_attack" as const, attackerId: "healer", targetId: "enemy", attackFrom: { x: 11, y: 13 } },
    ],
};

describe("A19 opening healer cohesion", () => {
    it("detects a resurrection carry leaving its living screen on lap one", () => {
        expect(isEarlyUnsupportedHealerDive(healer as unknown as Unit, holder, 1, dive)).toBe(true);
    });

    it("allows stationary attacks and attacks that stay supported", () => {
        expect(isEarlyUnsupportedHealerDive(healer as unknown as Unit, holder, 1, { actions: [dive.actions[1]] })).toBe(
            false,
        );
        expect(
            isEarlyUnsupportedHealerDive(healer as unknown as Unit, holder, 1, {
                actions: [{ ...dive.actions[0], targetCells: [{ x: 3, y: 8 }] }, dive.actions[1]],
            }),
        ).toBe(false);
    });

    it("allows later turns and recovery by a healer already separated from its allies", () => {
        expect(isEarlyUnsupportedHealerDive(healer as unknown as Unit, holder, 2, dive)).toBe(false);
        expect(
            isEarlyUnsupportedHealerDive(
                { ...healer, getCells: () => [{ x: 12, y: 13 }] } as unknown as Unit,
                holder,
                1,
                dive,
            ),
        ).toBe(false);
    });

    it("does not apply to grounded units, nonhealers, or an army without a living screen", () => {
        expect(
            isEarlyUnsupportedHealerDive({ ...healer, canFly: () => false } as unknown as Unit, holder, 1, dive),
        ).toBe(false);
        expect(
            isEarlyUnsupportedHealerDive(
                { ...healer, getAbility: () => undefined } as unknown as Unit,
                holder,
                1,
                dive,
            ),
        ).toBe(false);
        const deadScreen = {
            getAllAllies: () => [healer, { ...screen, isDead: () => true }],
        } as unknown as ILookaheadDeps["unitsHolder"];
        expect(isEarlyUnsupportedHealerDive(healer as unknown as Unit, deadScreen, 1, dive)).toBe(false);
    });
});
