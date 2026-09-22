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

import { afterEach, describe, expect, it } from "bun:test";

import {
    formatUnitTurnMix,
    measureUnitTurnMix,
    type IUnitTurnMixCensus,
} from "../../src/simulation/measure_unit_turn_mix";

const saved = process.env.FORCE_CREATURES;
afterEach(() => {
    if (saved === undefined) delete process.env.FORCE_CREATURES;
    else process.env.FORCE_CREATURES = saved;
});

describe("unit turn-mix census", () => {
    it("restores the ambient FORCE_CREATURES roster override", () => {
        delete process.env.FORCE_CREATURES;
        measureUnitTurnMix("Abomination", 4, 0);
        expect(process.env.FORCE_CREATURES).toBeUndefined();

        process.env.FORCE_CREATURES = "2:Pikeman";
        measureUnitTurnMix("Abomination", 4, 0);
        expect(process.env.FORCE_CREATURES).toBe("2:Pikeman");
    });

    it("reports zeroed shares rather than dividing by zero when nothing was observed", () => {
        const census = measureUnitTurnMix("Abomination", 4, 0);
        expect(census).toMatchObject({
            creatureName: "Abomination",
            games: 0,
            stacks: 0,
            turns: 0,
            turnsPerStack: 0,
            attackShare: 0,
            damagePerTurn: 0,
            diedShare: 0,
            averageDeathLap: 0,
            averageLaps: 0,
        });
        expect(Number.isFinite(census.damagePerStack)).toBe(true);
    });

    it("formats a census as one comparable line", () => {
        const census: IUnitTurnMixCensus = {
            creatureName: "Abomination",
            games: 14,
            stacks: 28,
            turns: 513,
            turnsPerStack: 18.32,
            attackShare: 0.55,
            moveShare: 0.37,
            waitShare: 0.07,
            defendShare: 0,
            damagePerStack: 1420,
            damagePerTurn: 78,
            diedShare: 0.04,
            averageDeathLap: 8,
            averageLaps: 7.4,
            actionCounts: { melee_attack: 283, move_unit: 192, wait_turn: 37, defend_turn: 1 },
        };
        const line = formatUnitTurnMix(census);
        expect(line).toContain("Abomination");
        expect(line).toContain("turns/stack  18.3");
        expect(line).toContain("attack  55%");
        expect(line).toContain("defend   0%");
        expect(line).toContain("dmg/turn    78");
        expect(line).toContain("at lap 8.0");
    });
});
