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

import type { Side } from "../../src/simulation/battle_engine";
import {
    V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE,
    playV08A19RangedCornerPlacementGame,
} from "../../src/simulation/measure_a19_ranged_corner_placement";

const SCENARIO = "ground-control" as const;
const CLUSTER = 0;
const BASE_SEED = 819_024_611;
const MAX_LAPS = 20;
const EXPECTED_BATTLE_SEED = 4_173_708_502;

export function registerV08A19RangedCornerPlacementSideTest(supportSide: Side): void {
    describe("A19 Ogre Mage and Behemoth ranged-corner A/B", () => {
        test(`crosses candidate and incumbent with real A19 search on the ${supportSide} support side`, () => {
            const schedules = V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.filter(
                (schedule) => schedule.supportSide === supportSide,
            );
            const games = schedules.map((schedule) =>
                playV08A19RangedCornerPlacementGame(SCENARIO, CLUSTER, BASE_SEED, MAX_LAPS, schedule),
            );

            expect(games.map(({ id }) => id)).toEqual(schedules.map(({ id }) => id));
            expect(new Set(games.map(({ seed }) => seed))).toEqual(new Set([EXPECTED_BATTLE_SEED]));
            expect(games.every((game) => game.supportRejectedActions === 0 && game.opponentRejectedActions === 0)).toBe(
                true,
            );

            const control = games.find((game) => game.arm === "control");
            const candidates = games.filter((game) => game.arm === "candidate");
            expect(control).toBeDefined();
            expect(candidates).toHaveLength(1);
            for (const candidate of candidates) {
                expect(candidate.candidateAudit).toMatchObject({ treatmentApplied: true, placementChanged: true });
                expect(candidate.behemothAdjacentToFireline).toBe(true);
                expect(candidate.supportFirelineSpan).toBeLessThan(control!.supportFirelineSpan);
            }
        }, 120_000);
    });
}
