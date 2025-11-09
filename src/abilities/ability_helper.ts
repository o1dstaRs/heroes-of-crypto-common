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

import { Grid } from "../grid/grid";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getDistance, XY } from "../utils/math";
import { Ability } from "./ability";

export function getAbilitiesWithPosisionCoefficient(
    unitAbilities: Ability[],
    fromCell?: XY,
    toCell?: XY,
    toUnitSmallSize?: boolean,
    fromUnitTeam?: TeamType,
): Ability[] {
    const abilities: Ability[] = [];
    if (!unitAbilities?.length || !fromCell || !toCell) {
        return abilities;
    }

    for (const a of unitAbilities) {
        if (a.getName() === "Backstab") {
            const aY = fromCell.y;
            const tY = toCell.y;

            if (fromUnitTeam === PBTypes.TeamVals.LOWER && aY > tY) {
                abilities.push(a);
            }

            if (fromUnitTeam === PBTypes.TeamVals.UPPER && aY < tY - (toUnitSmallSize ? 0 : 1)) {
                abilities.push(a);
            }
        }
    }

    return abilities;
}

export const abilityToTextureName = (abilityName: string): string =>
    `${abilityName.toLowerCase().replace(/ /g, "_")}_256`;

function addToTargetList(
    ix: number,
    iy: number,
    targetList: Unit[],
    target: Unit,
    attacker: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    onlyOppositeTeam: boolean,
): Unit[] {
    const nextTargetId = grid.getOccupantUnitId({ x: ix, y: iy });
    if (nextTargetId) {
        const nextStanding = unitsHolder.getAllUnits().get(nextTargetId);
        if (
            nextStanding &&
            !targetList.includes(nextStanding) &&
            nextStanding.getId() !== attacker.getId() &&
            nextStanding.getId() !== target.getId() &&
            (!onlyOppositeTeam || nextStanding.getTeam() !== attacker.getTeam())
        ) {
            targetList.push(nextStanding);
        }
    }
    return targetList;
}

function getTargetList(
    startingPos: XY[],
    cellsDiff: XY,
    target: Unit,
    attacker: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    onlyOppositeTeam: boolean,
): Unit[] {
    let targetList: Unit[] = [];
    const signX = Math.sign(cellsDiff.x);
    const signY = Math.sign(cellsDiff.y);
    const bX = Math.floor(Math.abs(cellsDiff.x));
    const bY = Math.floor(Math.abs(cellsDiff.y));
    for (const startingCell of startingPos) {
        targetList = addToTargetList(
            startingCell.x + bX * signX,
            startingCell.y + bY * signY,
            targetList,
            target,
            attacker,
            grid,
            unitsHolder,
            onlyOppositeTeam,
        );
    }
    return targetList;
}

export function nextStandingTargets(
    attackerUnit: Unit,
    targetUnit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    attackFromCell?: XY,
    pierceLargeUnits = true,
    onlyOppositeTeam = false,
): Unit[] {
    let targetList: Unit[] = [];
    let targetBaseCell = targetUnit.getBaseCell();

    const attackFromBaseCell = attackFromCell ? attackFromCell : attackerUnit.getBaseCell();

    if (!attackFromBaseCell || !targetBaseCell) {
        return targetList;
    }

    let attackerBaseCell = attackFromBaseCell;

    if (!attackerUnit.isSmallSize()) {
        const attackerCells = [
            attackerBaseCell,
            { x: attackerBaseCell.x - 1, y: attackerBaseCell.y },
            { x: attackerBaseCell.x, y: attackerBaseCell.y - 1 },
            { x: attackerBaseCell.x - 1, y: attackerBaseCell.y - 1 },
        ];
        let closestCell = attackerCells[0];
        let minDistance = getDistance(closestCell, targetBaseCell);

        for (const cell of attackerCells) {
            const distance = getDistance(cell, targetBaseCell);
            if (distance < minDistance) {
                closestCell = cell;
                minDistance = distance;
            }
        }

        attackerBaseCell = closestCell;

        if (!targetUnit.isSmallSize()) {
            const targetCells = targetUnit.getCells();
            let closestTargetCell = targetCells[0];
            minDistance = getDistance(closestTargetCell, attackerBaseCell);

            for (const cell of targetCells) {
                const distance = getDistance(cell, attackerBaseCell);
                if (distance < minDistance) {
                    closestTargetCell = cell;
                    minDistance = distance;
                }
            }

            targetBaseCell = closestTargetCell;
        }
    }

    const tbs = targetUnit.getBaseCell();
    let xCoefficient = 0;
    let yCoefficient = 0;
    if (!targetUnit.isSmallSize()) {
        const baseCellDiffX = tbs.x - attackFromBaseCell.x;
        const baseCellDiffY = tbs.y - attackFromBaseCell.y;
        if (baseCellDiffX === 2) {
            xCoefficient = 1;
        } else if (baseCellDiffX === -2) {
            xCoefficient = -1;
        }
        if (baseCellDiffY === 2) {
            yCoefficient = 1;
        } else if (baseCellDiffY === -2) {
            yCoefficient = -1;
        }
        xCoefficient = tbs.x - attackFromBaseCell.x - xCoefficient;
        yCoefficient = tbs.y - attackFromBaseCell.y - yCoefficient;
    }

    if (targetBaseCell && attackerBaseCell) {
        const cellsDiff = {
            x: targetBaseCell.x - attackerBaseCell.x + xCoefficient,
            y: targetBaseCell.y - attackerBaseCell.y + yCoefficient,
        };
        if (targetUnit.isSmallSize() || pierceLargeUnits) {
            targetList = getTargetList(
                targetUnit.getCells(),
                cellsDiff,
                targetUnit,
                attackerUnit,
                grid,
                unitsHolder,
                onlyOppositeTeam,
            );
        }
    }

    return targetList;
}
