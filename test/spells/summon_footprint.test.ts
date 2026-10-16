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

import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import {
    canCastSummon,
    noSpaceToSummonMessage,
    resolveSummonAnchor,
    summonFootprintOf,
} from "../../src/spells/spell_helper";
import type { XY } from "../../src/utils/math";

const summonWolves = (): Spell => new Spell({ spellProperties: getSpellConfig("Nature", "Summon Wolves"), amount: 1 });

const emptyBoard = (): number[][] => Array.from({ length: 16 }, () => new Array(16).fill(0));

/**
 * A summon must be seated using the body the summoned creature actually has.
 *
 * `canCastSummon` defaults to a 1x1 because at the first gate the summoned unit does not exist yet, and
 * that default was the whole truth while every summon was a 1x1. Summon Wolves spawns a Wolf, and Wolf
 * ships 2x1 — so a caller that takes the default asks whether ONE cell is free, proposes it, and
 * `action_engine.summonSpell` then re-checks with the real body and refuses. It deliberately never
 * re-routes an EXPLICIT cell, so the cast is not relocated, it is LOST.
 */
describe("a summon is seated with the summoned creature's real body", () => {
    it("reads Summon Wolves as the 2x1 it actually spawns", () => {
        expect(summonFootprintOf(summonWolves())).toEqual({ width: 2, height: 1 });
    });

    it("keeps a preferred cell that can seat the body, so 1x1 draws are untouched", () => {
        const spell = summonWolves();
        const matrix = emptyBoard();
        // (5,5) is free and so is (4,5), the second cell a 2x1 anchored there needs.
        expect(resolveSummonAnchor(spell, matrix, [{ x: 9, y: 9 }], { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    });

    it("falls back to a fitting anchor instead of losing the cast", () => {
        const spell = summonWolves();
        const matrix = emptyBoard();
        // The preferred anchor's own cell is free, but its second cell is not — exactly the case the
        // 1x1 gate waves through and the engine then refuses.
        matrix[5][4] = PBTypes.TeamVals.LEFT;
        const preferred: XY = { x: 5, y: 5 };
        expect(canCastSummon(spell, matrix, preferred)).toBe(true); // the 1x1 question says yes
        expect(canCastSummon(spell, matrix, preferred, 2, 1)).toBe(false); // the real body says no

        const ring: XY[] = [preferred, { x: 9, y: 9 }];
        const seated = resolveSummonAnchor(spell, matrix, ring, preferred);
        expect(seated).toEqual({ x: 9, y: 9 });
    });

    it("still refuses the real body when neither candidate can hold it", () => {
        const spell = summonWolves();
        const matrix = emptyBoard();
        matrix[5][4] = PBTypes.TeamVals.LEFT;
        matrix[9][8] = PBTypes.TeamVals.LEFT;
        expect(
            resolveSummonAnchor(
                spell,
                matrix,
                [
                    { x: 5, y: 5 },
                    { x: 9, y: 9 },
                ],
                { x: 5, y: 5 },
            ),
        ).toBeUndefined();
    });

    it("has no seat when one free cell is not wide enough for the Wolf", () => {
        const spell = summonWolves();
        const matrix = emptyBoard();
        // The reported fight: Satyr on the right edge, one empty cell beside him, and the cell a
        // left-extending Wolf would also need is occupied. The cast used to be refused.
        const occupy = (x: number, y: number) => {
            matrix[y][x] = PBTypes.TeamVals.LEFT;
        };
        occupy(15, 7); // Satyr
        occupy(15, 6); // Wandering Mage
        occupy(14, 7); // Manticore
        occupy(13, 7);
        occupy(14, 8); // Efreet
        occupy(13, 6); // Troglodyte
        const ring: XY[] = [
            { x: 14, y: 6 },
            { x: 14, y: 7 },
            { x: 14, y: 8 },
            { x: 15, y: 6 },
            { x: 15, y: 8 },
        ];

        expect(resolveSummonAnchor(spell, matrix, ring)).toBeUndefined();
        expect(noSpaceToSummonMessage("Satyr", "Wolf", 2, 1)).toBe(
            "No space next to Satyr. Wolf needs 2×1 free cells.",
        );
    });
});
