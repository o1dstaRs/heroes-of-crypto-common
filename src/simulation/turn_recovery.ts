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

import type { GameAction } from "../engine/actions";
import { canUnitLandAt } from "../ai/ai";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Grid } from "../grid/grid";
import type { IWeightedRoute } from "../grid/path_definitions";
import type { PathHelper } from "../grid/path_helper";
import type { FightProperties } from "../fights/fight_properties";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

const footprintCells = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

/** A guaranteed-legal move toward the nearest enemy for recovering a rejected/no-op policy decision. */
export function advanceTowardEnemyAction(
    unit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    pathHelper: PathHelper,
): GameAction | undefined {
    if (!unit.canMove()) {
        return undefined;
    }
    const enemyTeam = unit.getTeam() === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const enemies = unitsHolder.getAllAllies(enemyTeam).filter((candidate) => !candidate.isDead());
    if (!enemies.length) {
        return undefined;
    }
    const movePath = pathHelper.getMovePath(
        unit.getBaseCell(),
        grid.getMatrix(),
        unit.getSteps(),
        grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );
    if (!movePath.knownPaths.size) {
        return undefined;
    }

    const base = unit.getBaseCell();
    let best: IWeightedRoute | undefined;
    let bestScore = Infinity;
    for (const routeList of movePath.knownPaths.values()) {
        const route = routeList[0];
        if (!route?.route.length || (route.cell.x === base.x && route.cell.y === base.y)) {
            continue;
        }
        if (!canUnitLandAt(unit, grid, route.cell)) {
            continue;
        }
        const score = Math.min(
            ...enemies.map(
                (enemy) =>
                    Math.abs(route.cell.x - enemy.getBaseCell().x) + Math.abs(route.cell.y - enemy.getBaseCell().y),
            ),
        );
        if (score < bestScore) {
            bestScore = score;
            best = route;
        }
    }
    if (!best?.route.length) {
        return undefined;
    }
    return {
        type: "move_unit",
        unitId: unit.getId(),
        path: best.route.map((cell) => ({ x: cell.x, y: cell.y })),
        targetCells: footprintCells(unit, best.cell),
        hasLavaCell: best.hasLavaCell,
        hasWaterCell: best.hasWaterCell,
    };
}

/** Mark every living stack as acted so TurnEngine can perform its normal lap transition and rebuild queues. */
export function forceStalledLap(fightProperties: FightProperties, unitsHolder: UnitsHolder): boolean {
    let forced = false;
    for (const unit of unitsHolder.getAllUnits().values()) {
        if (!unit.isDead()) {
            fightProperties.addAlreadyMadeTurn(unit.getTeam(), unit.getId());
            forced = true;
        }
    }
    return forced;
}
