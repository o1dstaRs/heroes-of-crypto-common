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

import {
    A19_QUEEN_COUNTER_ANSWER,
    A19_QUEEN_COUNTER_POLICY,
    A19_QUEEN_COUNTER_THREAT,
    a19QueenCounterCreature,
} from "../../src/ai/setup/a19_queen_counter";
import { creatureIdForName } from "../../src/ai/setup/creature_score";

const id = (name: string): number => {
    const found = creatureIdForName(name);
    if (found === undefined) throw new Error(`unknown creature ${name}`);
    return found;
};
const QUEEN = id("Arachna Queen");
const DRAGON = id("Magic Dragon");
const OFFER = [id("Champion"), id("Frenzied Boar"), DRAGON, id("Thunderbird")];

describe(A19_QUEEN_COUNTER_POLICY, () => {
    test("the threat and the answer are the Arachna Queen and Magic Dragon", () => {
        expect([A19_QUEEN_COUNTER_THREAT, A19_QUEEN_COUNTER_ANSWER]).toEqual([QUEEN, DRAGON]);
    });

    test("a visible Queen at the level-4 pick takes Magic Dragon when it is offered", () => {
        expect(a19QueenCounterCreature(4, OFFER, [id("Fairy"), QUEEN])).toBe(DRAGON);
    });

    test("it keeps the current choice without a visible Queen, without Magic Dragon, or below level 4", () => {
        expect(a19QueenCounterCreature(4, OFFER, [id("Fairy"), id("Hydra")])).toBeUndefined();
        expect(a19QueenCounterCreature(4, OFFER, [])).toBeUndefined();
        expect(
            a19QueenCounterCreature(
                4,
                OFFER.filter((creature) => creature !== DRAGON),
                [QUEEN],
            ),
        ).toBeUndefined();
        expect(a19QueenCounterCreature(3, [id("Crusader"), id("Zena")], [QUEEN])).toBeUndefined();
    });
});
