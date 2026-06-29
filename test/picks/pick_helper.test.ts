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

import { canBanCreatureLevel } from "../../src/picks/pick_helper";
import { CreatureLevelMap } from "../../src/units/unit_properties";

describe("pick_helper", () => {
    it("allows bans while enough creatures of that level remain available", () => {
        const levelOne = creatureIdsForLevel(1);
        const levelTwo = creatureIdsForLevel(2);
        const levelFour = creatureIdsForLevel(4);

        expect(levelOne.length).toBeGreaterThan(1);
        expect(canBanCreatureLevel(1, [], [], [])).toBe(true);
        expect(canBanCreatureLevel(2, [], [], [])).toBe(true);
        expect(canBanCreatureLevel(2, levelTwo.slice(0, 2), [], [])).toBe(true);
        expect(canBanCreatureLevel(2, levelTwo.slice(0, 10), [], [])).toBe(false);
        expect(canBanCreatureLevel(4, [], [], [])).toBe(true);
        expect(canBanCreatureLevel(4, levelFour.slice(0, 6), [], [])).toBe(false);
    });

    it("uses the generated level buckets without the no-creature sentinel offset", () => {
        const levelOne = creatureIdsForLevel(1);
        const levelFour = creatureIdsForLevel(4);

        // L1 has a 12-creature pool and both teams may pick 2 each (4 reserved): the 8th ban is the
        // last legal one, so with 8 already banned a 9th is refused (it would strand a pick). A
        // sentinel-inflated bucket would wrongly allow it, so this still pins the bucket size.
        expect(canBanCreatureLevel(1, levelOne.slice(0, 7), [], [])).toBe(true);
        expect(canBanCreatureLevel(1, levelOne.slice(0, 8), [], [])).toBe(false);
        expect(canBanCreatureLevel(1, levelOne.slice(0, 10), [], [])).toBe(false);
        expect(canBanCreatureLevel(4, levelFour.slice(0, 4), [], [])).toBe(true);
        expect(canBanCreatureLevel(4, levelFour.slice(0, 6), [], [])).toBe(false);
    });

    it("accounts for known creatures and each team's picked creatures", () => {
        const levelThree = creatureIdsForLevel(3);
        const levelFour = creatureIdsForLevel(4);

        expect(canBanCreatureLevel(3, [], levelThree.slice(0, 3), [])).toBe(true);
        expect(canBanCreatureLevel(4, [], levelFour.slice(0, 6), [])).toBe(true);
        expect(canBanCreatureLevel(3, [], [], levelThree.slice(0, 4))).toBe(true);
        expect(canBanCreatureLevel(4, [levelFour[0]], levelFour.slice(1, 3), levelFour.slice(3, 6))).toBe(true);
    });
});

function creatureIdsForLevel(level: number): number[] {
    return Object.entries(CreatureLevelMap)
        .filter(([, creatureLevel]) => creatureLevel === level)
        .map(([creatureId]) => Number(creatureId));
}
