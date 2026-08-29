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

import { AIActionType, findTarget, isLineBlockedByFriendlyUnit } from "../../src/ai/ai";
import { createDecisionPathCatalog } from "../../src/ai/decision_path_catalog";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

const createConfiguredUnit = (factionName: string, creatureName: string, team: PBTypes.TeamVals, amount: number) => {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, factionName, creatureName, `${creatureName.toLowerCase()}_512`, amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
};

/**
 * A multi-cell shooter must not mistake its OWN body for a friendly screen.
 *
 * `findRangeAttackAction` refuses a plain shot whose line is blocked by a friendly, because the projectile
 * stops at the first body it meets and damaging your own unit is rejected by the engine. The occupancy
 * matrix stamps EVERY footprint cell with the owner's team, so the walk from a 2x1 shooter's anchor toward
 * a target on its long axis steps through the shooter's own second cell and read it as that wall.
 *
 * A 1x1 shooter has nothing to walk through, and the only two multi-cell shooters that predate rectangles
 * are both exempt from the guard by ability — Gargantuan carries Area Throw and Tsar Cannon Through Shot.
 * The Centaur is the first unit for which the guard actually runs on a multi-cell body, so this defect
 * arrived with the shipped rectangles rather than lurking behind them.
 *
 * The engine would have ALLOWED these shots (`getAffectedUnitsAndObstacles` skips the attacker by id), so
 * the AI just quietly moved into melee instead. No action was ever rejected, which is exactly why the
 * rejection-counting clash harness could not see it.
 */
describe("a multi-cell shooter does not screen itself", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("walks through its own body cells but still stops at a genuine ally", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        // Centaur is 2x1: anchor (8,8) is the top-right cell, so the body is (8,8) and (7,8).
        const centaur = createConfiguredUnit("Might", "Centaur", LOWER, 10);
        placeUnit(combat.grid, combat.unitsHolder, centaur, { x: 8, y: 8 });
        const matrix = combat.grid.getMatrix();
        const body = centaur.getCells();
        expect(body).toHaveLength(2);
        expect(matrix[8][7]).toBe(LOWER); // the shooter's own second cell is stamped with its team

        // Firing WEST, straight along its own long axis and over its own second cell.
        expect(isLineBlockedByFriendlyUnit({ x: 8, y: 8 }, { x: 4, y: 8 }, matrix, LOWER, body)).toBe(false);

        // A real ally further down that same line still blocks — own cells are stepped OVER, not treated
        // as "line is clear". Without this the fix would trade one wrong answer for another.
        const ally = createConfiguredUnit("Might", "Mermaid", LOWER, 10);
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 6, y: 8 });
        const withAlly = combat.grid.getMatrix();
        expect(isLineBlockedByFriendlyUnit({ x: 8, y: 8 }, { x: 4, y: 8 }, withAlly, LOWER, body)).toBe(true);
    });

    it("shoots a western enemy instead of walking into melee", () => {
        setDeterministicRandomSource(() => 0.5);
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const centaur = createConfiguredUnit("Might", "Centaur", LOWER, 10);
        placeUnit(combat.grid, combat.unitsHolder, centaur, { x: 8, y: 8 });
        // Due WEST of the anchor, so the line crosses the Centaur's own second cell at (7,8).
        const enemy = createConfiguredUnit("Chaos", "Troglodyte", UPPER, 10);
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 8 });

        const matrix = combat.grid.getMatrix();
        const catalog = createDecisionPathCatalog(combat.grid, new PathHelper(testGridSettings), centaur, matrix);
        const action = findTarget(centaur, combat.grid, matrix, combat.unitsHolder, catalog);

        expect(action).toBeDefined();
        expect(action!.actionType()).toBe(AIActionType.RANGE_ATTACK);
    });
});
