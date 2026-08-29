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
import { canCastSummon, resolveSummonAnchor, summonFootprintOf } from "../../src/spells/spell_helper";
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
        matrix[5][4] = PBTypes.TeamVals.LOWER;
        const preferred: XY = { x: 5, y: 5 };
        expect(canCastSummon(spell, matrix, preferred)).toBe(true); // the 1x1 question says yes
        expect(canCastSummon(spell, matrix, preferred, 2, 1)).toBe(false); // the real body says no

        const ring: XY[] = [preferred, { x: 9, y: 9 }];
        const seated = resolveSummonAnchor(spell, matrix, ring, preferred);
        expect(seated).toEqual({ x: 9, y: 9 });
    });

    it("still refuses when nothing around the caster can hold the body", () => {
        const spell = summonWolves();
        const matrix = emptyBoard();
        matrix[5][4] = PBTypes.TeamVals.LOWER;
        matrix[9][8] = PBTypes.TeamVals.LOWER;
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
});
