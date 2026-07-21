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

import {
    isV08DirectCombatDecision,
    V08_DOMINANT_FINISH_HP_RATIO,
    V08_DOMINANT_FINISH_START_LAP,
    V08_URGENT_FINISH_START_LAP,
    v08DominantFinishState,
} from "../../src/ai/versions/v0_8_dominant_finish";
import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../src/constants";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

function strengthState(ownHp: number, enemyHp: number, lap: number, team: TeamType = LOWER) {
    const combat = createCombatTestContext();
    const enemyTeam = team === LOWER ? UPPER : LOWER;
    const own = createTestUnit({ team, maxHp: ownHp });
    const enemy = createTestUnit({ team: enemyTeam, maxHp: enemyHp });
    placeUnit(combat.grid, combat.unitsHolder, own, team === LOWER ? { x: 3, y: 3 } : { x: 3, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, team === LOWER ? { x: 3, y: 10 } : { x: 3, y: 3 });
    return { combat, state: v08DominantFinishState(combat.unitsHolder, team, lap) };
}

describe("v0.8 dominant-finish policy", () => {
    it("arms at a two-to-one original-stack HP lead with five pre-Armageddon laps left", () => {
        expect(V08_DOMINANT_FINISH_START_LAP).toBe(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 5);
        expect(V08_DOMINANT_FINISH_HP_RATIO).toBe(2);

        expect(strengthState(30, 10, V08_DOMINANT_FINISH_START_LAP - 1).state.active).toBe(false);
        expect(strengthState(19, 10, V08_DOMINANT_FINISH_START_LAP).state.active).toBe(false);
        expect(strengthState(20, 10, V08_DOMINANT_FINISH_START_LAP).state).toEqual({
            currentLap: V08_DOMINANT_FINISH_START_LAP,
            ownHp: 20,
            enemyHp: 10,
            dominant: true,
            urgent: false,
            active: true,
        });
    });

    it("forces every surviving army into a final sprint three laps before Armageddon", () => {
        expect(V08_URGENT_FINISH_START_LAP).toBe(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3);
        expect(strengthState(10, 20, V08_URGENT_FINISH_START_LAP - 1).state.active).toBe(false);
        expect(strengthState(10, 20, V08_URGENT_FINISH_START_LAP).state).toMatchObject({
            dominant: false,
            urgent: true,
            active: true,
        });
        expect(strengthState(10, 10, V08_URGENT_FINISH_START_LAP).state.active).toBe(true);
    });

    it("ignores summoned HP and is symmetric when the commanding side is swapped", () => {
        const { combat, state } = strengthState(10, 10, V08_DOMINANT_FINISH_START_LAP);
        const summon = createTestUnit({ team: LOWER, maxHp: 1_000, summoned: true });
        placeUnit(combat.grid, combat.unitsHolder, summon, { x: 5, y: 3 });

        expect(v08DominantFinishState(combat.unitsHolder, LOWER, V08_DOMINANT_FINISH_START_LAP)).toEqual(state);
        expect(strengthState(20, 10, V08_DOMINANT_FINISH_START_LAP, UPPER).state.active).toBe(true);
    });

    it("classifies only enemy-damaging attack actions as direct combat", () => {
        const id = "unit";
        const cases: Array<[GameAction[], boolean]> = [
            [[{ type: "melee_attack", attackerId: id, targetId: "enemy", attackFrom: { x: 3, y: 3 } }], true],
            [[{ type: "range_attack", attackerId: id, targetId: "enemy", aimCell: { x: 3, y: 10 } }], true],
            [[{ type: "area_throw_attack", attackerId: id, targetCell: { x: 3, y: 10 } }], true],
            [[{ type: "move_unit", unitId: id, path: [] }], false],
            [[{ type: "cast_spell", casterId: id, spellName: "Resurrection", targetId: id }], false],
            [[{ type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } }], false],
            [[{ type: "defend_turn", unitId: id }], false],
        ];

        for (const [actions, expected] of cases) {
            expect(isV08DirectCombatDecision(actions)).toBe(expected);
        }
    });
});
