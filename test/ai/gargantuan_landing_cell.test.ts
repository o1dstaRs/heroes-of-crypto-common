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

import { enumerateCandidates } from "../../src/ai/candidates";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getRangeAttackSideCenter, type RangeAttackCellSide } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

/**
 * Area Throw splashes the ring of the cell the boulder LANDS on — the first cell of the target body the ray
 * enters — and the visible-edge aim (aimCell + aimSide) is what decides that cell on a 2x2. The same 2x2
 * target therefore offers different splash rings: this board puts an enemy stack behind its far corner and
 * an allied stack beside its near corner, so the near-cell throw splashes the ally and the far-cell throw
 * catches the stack behind. The AI must aim by the ring, not by the target.
 */
const board = () => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder, attackHandler } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const gargantuan = createTestUnit({
        name: "Gargantuan",
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 60,
        damageMin: 50,
        damageMax: 50,
        rangeShots: 5,
        shotDistance: 20,
        initiative: 9,
        size: PBTypes.UnitSizeVals.LARGE,
        abilities: ["Area Throw", "Double Throw", "Earth Element"],
    });
    placeUnit(grid, unitsHolder, gargantuan, { x: 3, y: 10 });
    const stack = (name: string, team: number, cell: XY, size = PBTypes.UnitSizeVals.SMALL): Unit => {
        const unit = createTestUnit({ name, team, maxHp: 300, amountAlive: 8, armor: 0, size });
        placeUnit(grid, unitsHolder, unit, cell);
        return unit;
    };
    const big = stack("Big", RIGHT, { x: 9, y: 8 }, PBTypes.UnitSizeVals.LARGE);
    const behind = stack("Behind", RIGHT, { x: 10, y: 7 });
    const ally = stack("Ally", LEFT, { x: 7, y: 9 });

    fightProperties.setTeamUnitsAlive(LEFT, 2);
    fightProperties.setTeamUnitsAlive(RIGHT, 2);
    fightProperties.startTurn(LEFT, 1000);

    const decisionContext = {
        grid,
        matrix: grid.getMatrix(),
        unitsHolder,
        pathHelper: new PathHelper(grid.getSettings()),
        attackHandler,
        fightProperties,
    };
    /** Landing cell and every stack the engine's own evaluation says the throw hits (primary + ring). */
    const impact = (action: GameAction): { lands: XY | undefined; hits: string[] } => {
        if (action.type !== "range_attack" || !action.aimCell || action.aimSide === undefined) {
            return { lands: undefined, hits: [] };
        }
        const to = getRangeAttackSideCenter(
            grid.getSettings(),
            action.aimCell,
            action.aimSide as RangeAttackCellSide,
            gargantuan.getPosition(),
        );
        const evaluation = attackHandler.evaluateRangeAttack(
            unitsHolder.getAllUnits(),
            gargantuan,
            gargantuan.getPosition(),
            to,
            false,
            false,
            true,
        );
        return {
            lands: evaluation.affectedCells[0]?.at(-1),
            hits: [...new Set(evaluation.affectedUnits.flat().map((unit) => unit.getName()))],
        };
    };
    return { gargantuan, big, behind, ally, decisionContext, impact };
};

describe("Gargantuan aims its throw by the splash ring", () => {
    it("the catalog prices the near-cell and far-cell throws on the same target differently", () => {
        const { gargantuan, decisionContext, impact } = board();
        const shots = enumerateCandidates(gargantuan, decisionContext as never, [
            { type: "end_turn", unitId: gargantuan.getId(), reason: "manual" },
        ]).candidates.filter((candidate) => candidate.kind === "shot");

        const byRing = shots.map((candidate) => ({ ...impact(candidate.actions.at(-1) as GameAction), candidate }));
        const nearCell = byRing.find((entry) => entry.lands?.x === 8 && entry.lands?.y === 8);
        const farCell = byRing.find((entry) => entry.lands?.x === 9 && entry.lands?.y === 8);
        expect(nearCell).toBeDefined();
        expect(farCell).toBeDefined();
        // Near corner: the ring catches the ally, so the throw is worth nothing. Far corner: Big + Behind.
        expect(nearCell!.hits).toEqual(["Big", "Ally"]);
        expect(nearCell!.candidate.shotFeatures?.friendlyFireDamage).toBeGreaterThan(0);
        expect(farCell!.hits).toEqual(["Big", "Behind"]);
        expect(farCell!.candidate.shotFeatures?.friendlyFireDamage).toBe(0);
        expect(farCell!.candidate.features.expectedDamage).toBeGreaterThan(nearCell!.candidate.features.expectedDamage);
    });

    it("v0.8 lands the boulder on the far cell so the ring catches the stack behind and spares the ally", () => {
        const { gargantuan, decisionContext, impact } = board();
        const decided = new StrategyV0_8().decideTurn(gargantuan, decisionContext as never);
        const attack = decided.at(-1) as GameAction;

        expect(attack.type).toBe("range_attack");
        expect(impact(attack)).toEqual({ lands: { x: 9, y: 8 }, hits: ["Big", "Behind"] });
    });
});
