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

import { MORALE_CHANGE_FOR_DISTANCE } from "../constants";
import { Grid } from "../grid/grid";
import { NO_UPDATE, UPDATE_DOWN, UPDATE_LEFT, UPDATE_RIGHT, UPDATE_UP } from "../grid/grid_constants";
import { getCellsAroundPosition, getPositionForCell, getPositionForCells } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { IWeightedRoute } from "../grid/path_definitions";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import { TeamType } from "../units/unit_properties";
import { XY } from "../utils/math";

export interface ISystemMoveResult {
    log: string;
    unitIdsDestroyed: string[];
    unitIdToNewPosition: Map<string, XY>;
}

export interface IDirectedMoveResult {
    log: string;
    deleteUnit: boolean;
    newPosition?: XY;
}

export class MoveHandler {
    public readonly gridSettings: GridSettings;

    private readonly grid: Grid;

    private readonly unitsHolder: UnitsHolder;

    public constructor(gridSettings: GridSettings, grid: Grid, unitsHolder: UnitsHolder) {
        this.gridSettings = gridSettings;
        this.grid = grid;
        this.unitsHolder = unitsHolder;
    }

    public moveUnitTowardsCenter(cell: XY, updatePositionMask: number, lapsNarrowed: number): ISystemMoveResult {
        const possibleUnitId = this.grid.getOccupantUnitId(cell);
        const logs: string[] = [];
        const unitIdsDestroyed: string[] = [];
        const unitIdToNewPosition = new Map<string, XY>();

        if (possibleUnitId) {
            const unit = this.unitsHolder.getAllUnits().get(possibleUnitId);
            // nothing to move
            if (!unit) {
                return { log: "", unitIdsDestroyed, unitIdToNewPosition };
            }

            const unitId = unit.getId();

            const currentPosition = unit.getPosition();
            let cells: XY[];
            if (unit.isSmallSize()) {
                cells = [cell];
            } else {
                cells = getCellsAroundPosition(this.gridSettings, currentPosition);
            }

            let targetCells = [];
            for (const c of cells) {
                if (updatePositionMask & UPDATE_UP) {
                    targetCells.push({ x: c.x, y: c.y + 1 });
                } else if (updatePositionMask & UPDATE_DOWN) {
                    targetCells.push({ x: c.x, y: c.y - 1 });
                } else if (updatePositionMask & UPDATE_LEFT) {
                    targetCells.push({ x: c.x - 1, y: c.y });
                } else if (updatePositionMask & UPDATE_RIGHT) {
                    targetCells.push({ x: c.x + 1, y: c.y });
                }
            }

            if (
                this.grid.areAllCellsEmpty(targetCells, unitId) ||
                this.grid.canOccupyCells(
                    targetCells,
                    unit.hasAbilityActive("Made of Fire"),
                    unit.hasAbilityActive("Made of Water"),
                )
            ) {
                const systemMoveResult = this.finishDirectedUnitMove(unit, targetCells, undefined, updatePositionMask);
                if (systemMoveResult.log) {
                    logs.push(systemMoveResult.log);
                }
                if (systemMoveResult.deleteUnit) {
                    unitIdsDestroyed.push(unitId);
                }
                if (systemMoveResult.newPosition) {
                    unitIdToNewPosition.set(unitId, systemMoveResult.newPosition);
                }
            } else {
                let moveX = false;
                let moveY = false;
                let priorityShift = 0;
                if (updatePositionMask & UPDATE_UP) {
                    priorityShift = unit.getTeam() === TeamType.LOWER ? 1 : -1;
                    moveX = true;
                } else if (updatePositionMask & UPDATE_DOWN) {
                    priorityShift = unit.getTeam() === TeamType.LOWER ? 1 : -1;
                    moveX = true;
                } else if (updatePositionMask & UPDATE_LEFT) {
                    priorityShift = unit.getTeam() === TeamType.LOWER ? 1 : -1;
                    moveY = true;
                } else if (updatePositionMask & UPDATE_RIGHT) {
                    priorityShift = unit.getTeam() === TeamType.LOWER ? 1 : -1;
                    moveY = true;
                }
                const initialTargetCells = structuredClone(targetCells);
                let flippedDirection = false;
                let movedUnit = false;
                while (priorityShift) {
                    if (moveX) {
                        const shiftedCells = this.getShiftedCells(targetCells, priorityShift, lapsNarrowed, true);
                        if (shiftedCells) {
                            if (
                                this.grid.areAllCellsEmpty(shiftedCells, unitId) ||
                                this.grid.canOccupyCells(
                                    shiftedCells,
                                    unit.hasAbilityActive("Made of Fire"),
                                    unit.hasAbilityActive("Made of Water"),
                                )
                            ) {
                                const position = getPositionForCells(this.gridSettings, shiftedCells);
                                if (!position) {
                                    targetCells = shiftedCells;
                                    continue;
                                }
                                const systemMoveResult = this.finishDirectedUnitMove(
                                    unit,
                                    shiftedCells,
                                    position,
                                    NO_UPDATE,
                                );
                                if (systemMoveResult.log) {
                                    logs.push(systemMoveResult.log);
                                }
                                if (systemMoveResult.deleteUnit && !unitIdsDestroyed.includes(unitId)) {
                                    unitIdsDestroyed.push(unitId);
                                }
                                if (systemMoveResult.newPosition) {
                                    unitIdToNewPosition.set(unitId, systemMoveResult.newPosition);
                                }
                                priorityShift = 0;
                                movedUnit = true;
                            } else {
                                targetCells = shiftedCells;
                            }
                        } else if (flippedDirection) {
                            priorityShift = 0;
                        } else {
                            priorityShift = -priorityShift;
                            targetCells = initialTargetCells;
                            flippedDirection = true;
                        }
                    }
                    if (moveY) {
                        const shiftedCells = this.getShiftedCells(targetCells, priorityShift, lapsNarrowed, false);
                        if (shiftedCells) {
                            if (
                                this.grid.areAllCellsEmpty(shiftedCells, unitId) ||
                                this.grid.canOccupyCells(
                                    shiftedCells,
                                    unit.hasAbilityActive("Made of Fire"),
                                    unit.hasAbilityActive("Made of Water"),
                                )
                            ) {
                                const position = getPositionForCells(this.gridSettings, shiftedCells);
                                if (!position) {
                                    targetCells = shiftedCells;
                                    continue;
                                }
                                const systemMoveResult = this.finishDirectedUnitMove(
                                    unit,
                                    shiftedCells,
                                    position,
                                    NO_UPDATE,
                                );
                                if (systemMoveResult.log) {
                                    logs.push(systemMoveResult.log);
                                }
                                if (systemMoveResult.deleteUnit && !unitIdsDestroyed.includes(unitId)) {
                                    unitIdsDestroyed.push(unitId);
                                }
                                if (systemMoveResult.newPosition) {
                                    unitIdToNewPosition.set(unitId, systemMoveResult.newPosition);
                                }
                                priorityShift = 0;
                                movedUnit = true;
                            } else {
                                targetCells = shiftedCells;
                            }
                        } else if (flippedDirection) {
                            priorityShift = 0;
                        } else {
                            priorityShift = -priorityShift;
                            targetCells = initialTargetCells;
                            flippedDirection = true;
                        }
                    }
                }

                if (!movedUnit) {
                    if (!unitIdsDestroyed.includes(unitId)) {
                        unitIdsDestroyed.push(unitId);
                    }
                    logs.push(`${unit.getName()} destroyed`);
                }
            }
        }

        return { log: logs.join("\n"), unitIdsDestroyed, unitIdToNewPosition };
    }

    public applyMoveModifiers(
        toCell: XY,
        unit: Unit,
        synergyAbilityPowerIncrease: number,
        synergyMoraleIncrease: number,
        currentActiveKnownPaths?: ReadonlyMap<number, IWeightedRoute[]>,
    ): boolean {
        if (!currentActiveKnownPaths) {
            return false;
        }

        const movePaths = currentActiveKnownPaths.get((toCell.x << 4) | toCell.y);
        if (movePaths?.length) {
            const path = movePaths[0].route;
            const targetPos = getPositionForCell(
                path[path.length - 1],
                this.gridSettings.getMinX(),
                this.gridSettings.getStep(),
                this.gridSettings.getHalfStep(),
            );
            const distanceBefore = this.unitsHolder.getDistanceToClosestEnemy(
                unit.getOppositeTeam(),
                unit.getPosition(),
            );
            const distanceAfter = this.unitsHolder.getDistanceToClosestEnemy(unit.getOppositeTeam(), targetPos);
            if (distanceAfter < distanceBefore) {
                unit.increaseMorale(MORALE_CHANGE_FOR_DISTANCE, synergyMoraleIncrease);
            } else if (distanceAfter > distanceBefore) {
                unit.decreaseMorale(MORALE_CHANGE_FOR_DISTANCE, synergyMoraleIncrease);
            }
            unit.applyTravelledDistanceModifier(path.length, synergyAbilityPowerIncrease);
            unit.applyLavaWaterModifier(movePaths[0].hasLavaCell, movePaths[0].hasWaterCell);
        } else {
            return false;
        }

        return true;
    }

    public finishDirectedUnitMove(
        unit: Unit,
        targetCells: XY[],
        bodyNewPosition?: XY,
        updatePositionMask: number = NO_UPDATE,
    ): IDirectedMoveResult {
        const unitIdsDestroyed: string[] = [];
        if (!targetCells?.length) {
            return {
                log: "",
                deleteUnit: false,
                newPosition: undefined,
            };
        }

        // this.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
        if (unit.isSmallSize()) {
            this.grid.occupyCell(
                targetCells[0],
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        } else {
            this.grid.occupyCells(
                targetCells,
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        }
        let deleteUnit = false;
        const bodyPosition = unit.getPosition();
        if (!bodyNewPosition) {
            if (updatePositionMask & UPDATE_UP) {
                bodyNewPosition = { x: bodyPosition.x, y: bodyPosition.y + this.gridSettings.getStep() };
            } else if (updatePositionMask & UPDATE_DOWN) {
                bodyNewPosition = { x: bodyPosition.x, y: bodyPosition.y - this.gridSettings.getStep() };
            } else if (updatePositionMask & UPDATE_LEFT) {
                bodyNewPosition = { x: bodyPosition.x - this.gridSettings.getStep(), y: bodyPosition.y };
            } else if (updatePositionMask & UPDATE_RIGHT) {
                bodyNewPosition = { x: bodyPosition.x + this.gridSettings.getStep(), y: bodyPosition.y };
            }
        }
        if (bodyNewPosition) {
            unit.setPosition(bodyNewPosition.x, bodyNewPosition.y);
        } else {
            deleteUnit = true;
        }
        if (deleteUnit) {
            unitIdsDestroyed.push(unit.getId());
            return {
                log: `${unit.getId()} destroyed`,
                newPosition: undefined,
                deleteUnit: deleteUnit,
            };
        }

        return { log: "", newPosition: bodyNewPosition, deleteUnit: deleteUnit };
    }

    private getShiftedCells(
        cells: XY[],
        shiftFactor: number,
        lapsNarrowed: number,
        isMovingX = true,
    ): XY[] | undefined {
        const shiftedCells: XY[] = new Array(cells.length);
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (isMovingX) {
                const newX = cell.x + shiftFactor;
                if (newX < lapsNarrowed || newX >= this.gridSettings.getGridSize() - lapsNarrowed) {
                    return undefined;
                }

                shiftedCells[i] = { x: newX, y: cell.y };
            } else {
                const newY = cell.y + shiftFactor;
                if (newY < lapsNarrowed || newY >= this.gridSettings.getGridSize() - lapsNarrowed) {
                    return undefined;
                }

                shiftedCells[i] = { x: cell.x, y: newY };
            }
        }

        return shiftedCells;
    }
}
