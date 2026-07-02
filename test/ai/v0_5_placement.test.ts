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

import { getAIStrategy } from "../../src/ai";
import { DEFAULT_PLACE_W, PLACEMENT_WEIGHT_KEYS, loadPlaceWeights } from "../../src/ai/versions/v0_5_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import { createTestUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const FLY = PBTypes.MovementVals.FLY;
const LARGE = PBTypes.UnitSizeVals.LARGE;

const v05 = getAIStrategy("v0.5");

/** Deploy `units` under a given V05_PLACEMENT mode, restoring the env afterwards. */
function place(mode: string, units: Unit[]): Map<string, { x: number; y: number }> {
    const prev = process.env.V05_PLACEMENT;
    process.env.V05_PLACEMENT = mode;
    const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
    const result = v05.placeArmy(units, {
        team: LOWER,
        grid: undefined as never,
        unitsHolder: undefined as never,
        pathHelper: undefined as never,
        placement: zone,
    });
    if (prev === undefined) {
        delete process.env.V05_PLACEMENT;
    } else {
        process.env.V05_PLACEMENT = prev;
    }
    return result;
}

const norm = (m: Map<string, { x: number; y: number }>): string[] =>
    [...m.entries()].map(([id, c]) => `${id}:${c.x},${c.y}`).sort();

// A mixed roster exercising every role branch: ground melee, flyers, ranged, and a LARGE (2x2) footprint.
const mixedRoster = (): Unit[] => [
    createTestUnit({ team: LOWER, name: "M1", attackType: MELEE }),
    createTestUnit({ team: LOWER, name: "M2", attackType: MELEE }),
    createTestUnit({ team: LOWER, name: "F1", attackType: MELEE, movementType: FLY }),
    createTestUnit({ team: LOWER, name: "F2", attackType: MELEE, movementType: FLY }),
    createTestUnit({ team: LOWER, name: "R1", attackType: RANGE, rangeShots: 5 }),
    createTestUnit({ team: LOWER, name: "Big", attackType: MELEE, size: LARGE }),
];

describe("v0.5 learned placement seam", () => {
    afterEach(() => {
        delete process.env.V05_PLACEMENT;
        delete process.env.V05_PLACE_WEIGHTS;
    });

    it("anchor vector has the right shape (13 dims: 1 incumbent + 3 features x 4 roles)", () => {
        expect(DEFAULT_PLACE_W.length).toBe(PLACEMENT_WEIGHT_KEYS.length);
        expect(DEFAULT_PLACE_W.length).toBe(13);
        expect(DEFAULT_PLACE_W[0]).toBeGreaterThan(0); // incumbent anchor dominates
        expect(DEFAULT_PLACE_W.slice(1).every((w) => w === 0)).toBe(true); // every learned feature off
    });

    it("with the anchor weights, learned placement reproduces v0.4 placement EXACTLY", () => {
        // DEFAULT_PLACE_W makes incumbent dominate, so byPolicy must pick v0.4's own cell for every unit —
        // the strict no-op property that lets us ship the seam dormant and only deviate once trained.
        for (let i = 0; i < 3; i += 1) {
            const roster = mixedRoster();
            const def = place("default", roster);
            const learned = place("learned", roster);
            expect(learned.size).toBe(def.size);
            expect(norm(learned)).toEqual(norm(def));
        }
    });

    it("a deviating weight vector CAN change placement (proves the features are live)", () => {
        // Kill the anchor and push flyers to the deepest, most central cell — placement must differ from v0.4.
        const roster = mixedRoster();
        const def = place("default", roster);
        process.env.V05_PLACE_WEIGHTS = JSON.stringify([
            0,
            0,
            0,
            0,
            -5,
            -5,
            5,
            0,
            0,
            0,
            0,
            0,
            0, // flyer: retreat (front -5), centre (edge -5), pack (cohesion +5)
        ]);
        const deviated = place("learned", roster);
        expect(deviated.size).toBe(def.size); // still a complete, valid deployment
        expect(norm(deviated)).not.toEqual(norm(def)); // but not identical
    });

    it("loadPlaceWeights honours a well-formed override and falls back to the anchor otherwise", () => {
        const custom = [3, 1, -1, 0.5, 2, -2, 1, 0, 0, 0, -1, 1, 0];
        process.env.V05_PLACE_WEIGHTS = JSON.stringify(custom);
        expect(loadPlaceWeights()).toEqual(custom);
        for (const bad of ["nope", "[1,2,3]", JSON.stringify([1, 2, "x"]), "{}"]) {
            process.env.V05_PLACE_WEIGHTS = bad;
            expect(loadPlaceWeights()).toEqual(DEFAULT_PLACE_W.slice());
        }
    });
});
