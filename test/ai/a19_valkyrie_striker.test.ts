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

import { describe, expect, test } from "bun:test";

import { a19StrikerRushFormation, type IA19StrikerRushBody } from "../../src/ai/setup/a19_striker_rush";
import { A19_VALKYRIE_STRIKER_POLICY, isA19FormationStriker } from "../../src/ai/setup/a19_valkyrie_striker";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { isA19DeliveryMelee } from "../../src/ai/setup/a19_revealed_ranged_draft";

const id = (name: string): number => {
    const found = creatureIdForName(name);
    if (found === undefined) throw new Error(`unknown creature ${name}`);
    return found;
};

describe("a19-valkyrie-striker-v1", () => {
    test("identity and the formation strikers", () => {
        expect(A19_VALKYRIE_STRIKER_POLICY).toBe("a19-valkyrie-striker-v1");
        // Valkyrie casts Wind Flow (an amplifiable buff): the striker test leaves it out, the formation does not.
        expect(isA19DeliveryMelee(id("Valkyrie"))).toBe(false);
        expect(isA19FormationStriker(id("Valkyrie"))).toBe(true);
        for (const name of ["Angel", "Wyvern", "Crusader", "Leprechaun"])
            expect(isA19FormationStriker(id(name))).toBe(true);
        // A flyer with ranged spell damage, shooters and casters stay where the native formation put them.
        for (const name of ["Magic Dragon", "Elf", "Centaur", "Battle Mage", "Wandering Mage"])
            expect(isA19FormationStriker(id(name))).toBe(false);
    });

    test("only Valkyrie joins the strikers", () => {
        const added: string[] = [];
        for (let creature = 1; creature <= 80; creature++) {
            if (isA19FormationStriker(creature) && !isA19DeliveryMelee(creature)) added.push(String(creature));
        }
        expect(added).toEqual([String(id("Valkyrie"))]);
    });

    test("game b02a58ce: the Valkyrie leaves the back row and the rest of the formation stays", () => {
        const zone: { x: number; y: number }[] = [];
        for (let x = 0; x <= 5; x++) for (let y = 0; y <= 15; y++) zone.push({ x, y });
        const native: IA19StrikerRushBody[] = [
            { id: "Centaur", x: 1, y: 4, width: 2, height: 1, striker: false },
            { id: "Leprechaun", x: 1, y: 2, width: 1, height: 1, striker: true },
            { id: "Valkyrie", x: 0, y: 2, width: 1, height: 1, striker: false },
            { id: "Wyvern", x: 5, y: 15, width: 2, height: 1, striker: true },
            { id: "Crusader", x: 1, y: 15, width: 1, height: 1, striker: true },
            { id: "Angel", x: 1, y: 1, width: 2, height: 2, striker: true },
        ];
        const cell = (out: IA19StrikerRushBody[], name: string) => {
            const body = out.find((entry) => entry.id === name)!;
            return [body.x, body.y];
        };
        expect(cell(a19StrikerRushFormation(native, zone, [], 1), "Valkyrie")).toEqual([0, 2]);
        const flagged = native.map((body) => (body.id === "Valkyrie" ? { ...body, striker: true } : body));
        const after = a19StrikerRushFormation(flagged, zone, [], 1);
        expect(cell(after, "Valkyrie")).toEqual([5, 4]);
        expect(cell(after, "Centaur")).toEqual([1, 4]);
    });
});
