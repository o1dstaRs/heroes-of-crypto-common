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
import { makeRng } from "../../src/simulation/army";
import {
    isUnitDescriptionRefreshSuppressed,
    withUnitDescriptionRefreshSuppressed,
} from "../../src/units/description_refresh";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import { createTestUnit } from "../helpers/combat";

// The pass rolls the lap's luck: give both passes the same random stream so only the suppression differs.
const seeded = <T>(run: () => T): T => {
    const saved = captureDeterministicRandomState();
    setDeterministicRandomSource(makeRng(20261123));
    try {
        return run();
    } finally {
        restoreDeterministicRandomState(saved);
    }
};

const luckyAbomination = () =>
    createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Stun Aura"],
        auraEffects: ["Stun"],
        auraRanges: [2],
        auraIsBuff: [true],
        stackPower: 5,
        luck: 7,
    });

describe("unit description refresh during a search", () => {
    it("keeps the stats pass and skips only the description text while suppressed", () => {
        const suppressed = luckyAbomination();
        const normal = luckyAbomination();
        const before = [...suppressed.getUnitProperties().abilities_descriptions];

        seeded(() => withUnitDescriptionRefreshSuppressed(() => suppressed.adjustBaseStats(true, 1, 0, 0, 0, 0, 0)));
        seeded(() => normal.adjustBaseStats(true, 1, 0, 0, 0, 0, 0));

        // The stat pass itself ran: the same stats as an unsuppressed pass.
        expect(suppressed.getLuck()).toBe(normal.getLuck());
        expect(suppressed.getBaseAttack()).toBe(normal.getBaseAttack());
        expect(suppressed.getUnitProperties().max_hp).toBe(normal.getUnitProperties().max_hp);
        // Only the description text was left as it was.
        expect(suppressed.getUnitProperties().abilities_descriptions).toEqual(before);
        const index = normal.getUnitProperties().abilities.indexOf("Stun Aura");
        expect(normal.getUnitProperties().abilities_descriptions[index]).not.toBe(before[index]);

        // The next unsuppressed pass (the real action after a search) brings the text up to date.
        seeded(() => suppressed.adjustBaseStats(true, 1, 0, 0, 0, 0, 0));
        expect(suppressed.getUnitProperties().abilities_descriptions).toEqual(
            normal.getUnitProperties().abilities_descriptions,
        );
    });

    it("nests and restores the flag when the search throws", () => {
        expect(isUnitDescriptionRefreshSuppressed()).toBe(false);
        expect(() =>
            withUnitDescriptionRefreshSuppressed(() => {
                withUnitDescriptionRefreshSuppressed(() => expect(isUnitDescriptionRefreshSuppressed()).toBe(true));
                expect(isUnitDescriptionRefreshSuppressed()).toBe(true);
                throw new Error("search failed");
            }),
        ).toThrow("search failed");
        expect(isUnitDescriptionRefreshSuppressed()).toBe(false);
    });
});
