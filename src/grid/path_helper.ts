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

import { ObstacleType } from "../obstacles/obstacle_type";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { getRandomInt } from "../utils/lib";
import { getDistance, type IXYDistance, matrixElementOrDefault, type XY } from "../utils/math";
import {
    getCellForPosition,
    getPositionForCell,
    isCellWithinGrid,
    isPositionWithinGrid,
    normalizeFootprintSide,
} from "./grid_math";
import { GridSettings } from "./grid_settings";
import type { IMovePath, IWeightedRoute } from "./path_definitions";
import { TeamVals } from "../generated/protobuf/v1";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { VINE_CROSS_PENALTY, VINE_STRIDE_COST_MULTIPLIER } from "../spells/vines";
import { FIRE_WALL_CROSS_PENALTY } from "../spells/fire_walls";
import type { IPlacement } from "./placement_properties";
import { UnitsHolder } from "../units/units_holder";

export class PathHelper {
    public static DIAGONAL_MOVE_COST = 1.4142135623730951;
    public static Y_FACTION_ICONS_OFFSET = 2;
    private readonly gridSettings: GridSettings;
    public constructor(gridSettings: GridSettings) {
        this.gridSettings = gridSettings;
    }
    /**
     * The anchor cells a body of `footprintWidth` x `footprintHeight` may step onto from `currentCell`.
     *
     * An anchor is the footprint's TOP-RIGHT cell, so the body needs W-1 cells to its left and H-1 cells
     * below it to stay on the board. The legacy `isSmallUnit ? 0 : 1` bounds are exactly those two
     * expressions at 1x1 and 2x2; spelling them out per axis is what finally gives a 2x1 the whole
     * y === 0 row (and a 1x2 the whole x === 0 column) it used to be refused.
     */
    public getNeighborCells(
        currentCell: XY,
        visited: Set<number> = new Set(),
        isSmallUnit = true,
        getDiag = true,
        includeLeftRightEdges = false,
        footprintWidth = isSmallUnit ? 1 : 2,
        footprintHeight = isSmallUnit ? 1 : 2,
    ): XY[] {
        const neighborsLine = [];
        const neighborsDiag = [];
        const width = normalizeFootprintSide(footprintWidth, isSmallUnit ? 1 : 2);
        const height = normalizeFootprintSide(footprintHeight, isSmallUnit ? 1 : 2);
        const diff = includeLeftRightEdges ? 2 : 0;
        const canGoLeft = currentCell.x > width - 1 - diff;
        const canGoRight = currentCell.x < this.gridSettings.getGridSize() - 1 + diff;
        let canGoDown;
        if (currentCell.x < 0) {
            // The off-board staging columns (the faction icons) are not board geometry, so the body rule
            // does not apply there; keep the legacy floor.
            canGoDown = currentCell.y > 2;
        } else {
            canGoDown = currentCell.y > height - 1;
        }
        const canGoUp = currentCell.y < this.gridSettings.getGridSize() - 1;

        if (canGoLeft) {
            const newX = currentCell.x - 1;
            const p1 = (newX << 4) | currentCell.y;
            if (!visited.has(p1)) {
                neighborsLine.push({ x: newX, y: currentCell.y });
            }
            if (canGoDown && getDiag) {
                const newY = currentCell.y - 1;
                const p2 = (newX << 4) | newY;
                if (!visited.has(p2)) {
                    neighborsDiag.push({ x: newX, y: newY });
                }
            }
            if (canGoUp && getDiag) {
                const newY = currentCell.y + 1;
                const p3 = (newX << 4) | newY;
                if (!visited.has(p3)) {
                    neighborsDiag.push({ x: newX, y: newY });
                }
            }
        }
        if (canGoUp) {
            const newY = currentCell.y + 1;
            const p4 = (currentCell.x << 4) | newY;
            if (!visited.has(p4)) {
                neighborsLine.push({ x: currentCell.x, y: newY });
            }
        }
        if (canGoDown) {
            const newY = currentCell.y - 1;
            const p5 = (currentCell.x << 4) | newY;
            if (!visited.has(p5)) {
                neighborsLine.push({ x: currentCell.x, y: newY });
            }
        }
        if (canGoRight) {
            const newX = currentCell.x + 1;
            const p6 = (newX << 4) | currentCell.y;
            if (!visited.has(p6)) {
                neighborsLine.push({ x: newX, y: currentCell.y });
            }
            if (canGoDown && getDiag) {
                const newY = currentCell.y - 1;
                const p7 = (newX << 4) | newY;
                if (!visited.has(p7)) {
                    neighborsDiag.push({ x: newX, y: newY });
                }
            }
            if (canGoUp && getDiag) {
                const newY = currentCell.y + 1;
                const p8 = (newX << 4) | newY;
                if (!visited.has(p8)) {
                    neighborsDiag.push({ x: newX, y: newY });
                }
            }
        }

        return [...neighborsLine, ...neighborsDiag];
    }
    private attackCellA(
        unitCell: XY,
        newUnitCellX: number,
        newUnitCellY: number,
        availableAttackCellHashes: Set<number>,
        targetUnitTeam: TeamType,
    ): XY | undefined {
        if (availableAttackCellHashes.has((newUnitCellX << 4) | newUnitCellY)) {
            return { x: newUnitCellX, y: newUnitCellY };
        }

        if (
            targetUnitTeam === PBTypes.TeamVals.RIGHT ||
            (targetUnitTeam === PBTypes.TeamVals.NO_TEAM &&
                (unitCell.x <= this.gridSettings.getGridSize() / 2 ||
                    unitCell.y <= this.gridSettings.getGridSize() / 2))
        ) {
            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }

            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }
        } else if (targetUnitTeam === PBTypes.TeamVals.LEFT || targetUnitTeam === PBTypes.TeamVals.NO_TEAM) {
            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }

            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }
        }

        return undefined;
    }
    private attackCellB(
        unitCell: XY,
        newUnitCellX: number,
        newUnitCellY: number,
        availableAttackCellHashes: Set<number>,
        targetUnitTeam: TeamType,
    ): XY | undefined {
        if (availableAttackCellHashes.has((newUnitCellX << 4) | newUnitCellY)) {
            return { x: newUnitCellX, y: newUnitCellY };
        }

        if (
            targetUnitTeam === PBTypes.TeamVals.RIGHT ||
            (targetUnitTeam === PBTypes.TeamVals.NO_TEAM &&
                (unitCell.x > this.gridSettings.getGridSize() / 2 || unitCell.y > this.gridSettings.getGridSize() / 2))
        ) {
            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }

            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }
        } else if (targetUnitTeam === PBTypes.TeamVals.LEFT || targetUnitTeam === PBTypes.TeamVals.NO_TEAM) {
            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }

            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }
        }

        return undefined;
    }
    private attackCellC(
        unitCell: XY,
        newUnitCellX: number,
        availableAttackCellHashes: Set<number>,
        targetUnitTeam: TeamType,
    ): XY | undefined {
        if (
            targetUnitTeam === PBTypes.TeamVals.RIGHT ||
            (targetUnitTeam === PBTypes.TeamVals.NO_TEAM &&
                (unitCell.x > this.gridSettings.getGridSize() / 2 || unitCell.y <= this.gridSettings.getGridSize() / 2))
        ) {
            const firstUnitCellY = unitCell.y - 1;
            if (firstUnitCellY >= 0 && availableAttackCellHashes.has((newUnitCellX << 4) | firstUnitCellY)) {
                return { x: newUnitCellX, y: firstUnitCellY };
            }

            const secondUnitCellY = unitCell.y + 1;
            if (
                secondUnitCellY < this.gridSettings.getGridSize() &&
                availableAttackCellHashes.has((newUnitCellX << 4) | secondUnitCellY)
            ) {
                return { x: newUnitCellX, y: secondUnitCellY };
            }
        } else if (targetUnitTeam === PBTypes.TeamVals.LEFT || targetUnitTeam === PBTypes.TeamVals.NO_TEAM) {
            const firstUnitCellY = unitCell.y + 1;
            if (
                firstUnitCellY < this.gridSettings.getGridSize() &&
                availableAttackCellHashes.has((newUnitCellX << 4) | firstUnitCellY)
            ) {
                return { x: newUnitCellX, y: firstUnitCellY };
            }

            const secondUnitCellY = unitCell.y - 1;
            if (secondUnitCellY >= 0 && availableAttackCellHashes.has((newUnitCellX << 4) | secondUnitCellY)) {
                return { x: newUnitCellX, y: secondUnitCellY };
            }
        }

        return undefined;
    }
    private attackCellD(
        unitCell: XY,
        newUnitCellY: number,
        availableAttackCellHashes: Set<number>,
        targetUnitTeam: TeamType,
    ): XY | undefined {
        if (
            targetUnitTeam === PBTypes.TeamVals.RIGHT ||
            (targetUnitTeam === PBTypes.TeamVals.NO_TEAM &&
                (unitCell.x <= this.gridSettings.getGridSize() / 2 || unitCell.y > this.gridSettings.getGridSize() / 2))
        ) {
            const firstUnitCellX = unitCell.x - 1;
            if (firstUnitCellX >= 0 && availableAttackCellHashes.has((firstUnitCellX << 4) | newUnitCellY)) {
                return { x: firstUnitCellX, y: newUnitCellY };
            }

            const secondUnitCellX = unitCell.x + 1;
            if (
                secondUnitCellX < this.gridSettings.getGridSize() &&
                availableAttackCellHashes.has((secondUnitCellX << 4) | newUnitCellY)
            ) {
                return { x: secondUnitCellX, y: newUnitCellY };
            }
        } else if (targetUnitTeam === PBTypes.TeamVals.LEFT) {
            const firstUnitCellX = unitCell.x + 1;
            if (
                firstUnitCellX < this.gridSettings.getGridSize() &&
                availableAttackCellHashes.has((firstUnitCellX << 4) | newUnitCellY)
            ) {
                return { x: firstUnitCellX, y: newUnitCellY };
            }

            const secondUnitCellX = unitCell.x - 1;
            if (secondUnitCellX >= 0 && availableAttackCellHashes.has((secondUnitCellX << 4) | newUnitCellY)) {
                return { x: secondUnitCellX, y: newUnitCellY };
            }
        }

        return undefined;
    }
    private getClosestAttackCell(mousePosition: XY, isCornerPos: boolean, cells?: XY[]): XY | undefined {
        if (!cells?.length) {
            return undefined;
        }

        const attackCells: IXYDistance[] = [];
        for (const c of cells) {
            const position = getPositionForCell(
                c,
                this.gridSettings.getMinX(),
                this.gridSettings.getStep(),
                this.gridSettings.getHalfStep(),
            );
            const newPosition = {
                x: position.x - this.gridSettings.getHalfStep(),
                y: position.y - this.gridSettings.getHalfStep(),
            };
            attackCells.push({
                xy: c,
                distance: getDistance(mousePosition, newPosition),
            });
        }
        if (isCornerPos) {
            attackCells.sort((a: IXYDistance, b: IXYDistance) => {
                if (a.distance > b.distance) {
                    return -1;
                }
                if (b.distance > a.distance) {
                    return 1;
                }
                return 0;
            });
        } else {
            attackCells.sort((a: IXYDistance, b: IXYDistance) => {
                if (a.distance < b.distance) {
                    return -1;
                }
                if (a.distance > b.distance) {
                    return 1;
                }
                return 0;
            });
        }

        return attackCells[0].xy;
    }
    private isCornerMousePosition(
        unitPositionX: number,
        unitPositionY: number,
        xMin: number,
        xMax: number,
        yMin: number,
        yMax: number,
        mouseCell: XY,
        mousePosition: XY,
    ): boolean {
        const part = this.gridSettings.getCellSize() / 6;
        const xLeft = unitPositionX - part;
        const xRight = unitPositionX + part;
        const yDown = unitPositionY - part;
        const yTop = unitPositionY + part;

        return (
            (mouseCell.x === xMin && mouseCell.y === yMax && mousePosition.x < xLeft && mousePosition.y > yTop) ||
            (mouseCell.x === xMax && mouseCell.y === yMax && mousePosition.x > xRight && mousePosition.y > yTop) ||
            (mouseCell.x === xMax && mouseCell.y === yMin && mousePosition.x > xRight && mousePosition.y < yDown) ||
            (mouseCell.x === xMin && mouseCell.y === yMin && mousePosition.x < xLeft && mousePosition.y < yDown)
        );
    }
    private captureRoute(
        knownPaths: Map<number, IWeightedRoute[]>,
        key: number,
        weightedRoute: IWeightedRoute,
    ): boolean {
        const knownRoutes = knownPaths.get(key);
        let captured = false;
        if (!knownRoutes) {
            knownPaths.set(key, [weightedRoute]);
            captured = true;
        } else {
            const indices = [];
            let index = 0;
            for (const knownRoute of knownRoutes.values()) {
                if (knownRoute.weight < weightedRoute.weight) {
                    index++;
                    continue;
                } else if (knownRoute.weight === weightedRoute.weight) {
                    indices.push(index);
                } else if (!indices.length) {
                    knownRoutes.push(weightedRoute);
                } else {
                    const randIndex = indices[getRandomInt(0, indices.length)];
                    knownPaths.set(key, [
                        ...knownRoutes.slice(0, randIndex),
                        weightedRoute,
                        ...knownRoutes.slice(randIndex),
                    ]);
                    captured = true;
                }
                index++;
            }
        }

        return captured;
    }
    private filterUnallowedDestinations(
        movePath: IMovePath,
        matrix: number[][],
        isSmallUnit: boolean,
        isMadeOfFire: boolean,
    ): IMovePath {
        const filteredCells: XY[] = [];
        const hashes: Set<number> = new Set();
        const { knownPaths } = movePath;

        for (const cell of movePath.cells) {
            const key = (cell.x << 4) | cell.y;
            if (isSmallUnit) {
                if (!knownPaths.has(key)) {
                    continue;
                }
            }

            const matrixElement = matrixElementOrDefault(matrix, cell.x, cell.y, 0);
            if (
                (!isMadeOfFire && matrixElement === ObstacleType.LAVA) ||
                matrixElement === ObstacleType.WATER ||
                matrixElement === ObstacleType.BLOCK
            ) {
                continue;
            }

            filteredCells.push(cell);
            hashes.add(key);
        }

        return {
            cells: filteredCells,
            knownPaths,
            hashes,
        };
    }
    public calculateClosestAttackFrom(
        mousePosition: XY,
        attackCells: XY[],
        attackerUnitCells: XY[],
        targetUnitCells: XY[],
        unitIsSmallSize: boolean,
        attackRange: number,
        targetUnitIsSmallSize: boolean,
        targetUnitTeam: TeamType,
        attackCellHashesToLargeCells: Map<number, XY[]>,
    ): XY | undefined {
        if (!attackCells.length || !targetUnitCells.length) {
            return undefined;
        }

        const mouseCell = getCellForPosition(this.gridSettings, mousePosition);
        if (!mouseCell) {
            return undefined;
        }

        let foundCell = false;
        let xMin = Number.MAX_SAFE_INTEGER;
        let xMax = Number.MIN_SAFE_INTEGER;
        let yMin = Number.MAX_SAFE_INTEGER;
        let yMax = Number.MIN_SAFE_INTEGER;

        for (const uc of targetUnitCells) {
            xMin = Math.min(xMin, uc.x);
            xMax = Math.max(xMax, uc.x);
            yMin = Math.min(yMin, uc.y);
            yMax = Math.max(yMax, uc.y);
            if (uc.x === mouseCell.x && uc.y === mouseCell.y) {
                foundCell = true;
            }
        }
        if (!foundCell) {
            return undefined;
        }

        const positionForMouseCell = getPositionForCell(
            mouseCell,
            this.gridSettings.getMinX(),
            this.gridSettings.getStep(),
            this.gridSettings.getHalfStep(),
        );

        const unitPositionX = positionForMouseCell.x;
        const unitPositionY = positionForMouseCell.y;

        const part = targetUnitIsSmallSize ? this.gridSettings.getCellSize() / 6 : 0;
        const xLeft = unitPositionX - part;
        const xRight = unitPositionX + part;
        const yDown = unitPositionY - part;
        const yTop = unitPositionY + part;

        // An attacker's own standing cell is a valid "attack in place" spot for a LARGE (2x2) unit even
        // when its ANCHOR cell is out of attackRange of the target — its footprint may still be adjacent.
        // But that only holds when the footprint actually reaches the TARGET: without this check, a melee
        // unit standing next to enemy A "found" an attack-from cell for ANY hovered enemy B across the
        // board, and the hover painted a full attack preview (arrow from the unit + damage) that read as
        // a ranged shot (the Arachna Queen phantom-range bug).
        const attackerReachesTarget = attackerUnitCells.some((attackerCell) =>
            targetUnitCells.some(
                (targetCell) =>
                    Math.abs(attackerCell.x - targetCell.x) <= attackRange &&
                    Math.abs(attackerCell.y - targetCell.y) <= attackRange,
            ),
        );

        // shuffle(attackCells); // Removed to prevent flickering
        const availableAttackCells: XY[] = [];
        const availableAttackCellHashes: Set<number> = new Set();
        for (const position of attackCells) {
            let isAttackerCell = false;
            for (const auc of attackerUnitCells) {
                if (auc.x === position.x && auc.y === position.y) {
                    isAttackerCell = true;
                    break;
                }
            }

            if (
                (Math.abs(position.x - mouseCell.x) <= attackRange &&
                    Math.abs(position.y - mouseCell.y) <= attackRange) ||
                (isAttackerCell && attackerReachesTarget)
            ) {
                availableAttackCells.push(position);
                availableAttackCellHashes.add((position.x << 4) | position.y);
            }
        }

        if (availableAttackCells.length) {
            let cornerPos = false;
            if (!targetUnitIsSmallSize) {
                cornerPos =
                    (mouseCell.x === xMin &&
                        mouseCell.y === yMax &&
                        mousePosition.x < unitPositionX &&
                        mousePosition.y > unitPositionY) ||
                    (mouseCell.x === xMax &&
                        mouseCell.y === yMax &&
                        mousePosition.x > unitPositionX &&
                        mousePosition.y > unitPositionY) ||
                    (mouseCell.x === xMax &&
                        mouseCell.y === yMin &&
                        mousePosition.x > unitPositionX &&
                        mousePosition.y < unitPositionY) ||
                    (mouseCell.x === xMin &&
                        mouseCell.y === yMin &&
                        mousePosition.x < unitPositionX &&
                        mousePosition.y < unitPositionY);
            }

            if (
                (!targetUnitIsSmallSize && !cornerPos) ||
                (targetUnitIsSmallSize &&
                    mousePosition.x >= xLeft &&
                    mousePosition.x < xRight &&
                    mousePosition.y >= yDown &&
                    mousePosition.y < yTop)
            ) {
                let closestDistance = Number.MAX_SAFE_INTEGER;
                let closestCell = availableAttackCells[0];
                for (const ap of availableAttackCells) {
                    const distance = getDistance(
                        mousePosition,
                        getPositionForCell(
                            ap,
                            this.gridSettings.getMinX(),
                            this.gridSettings.getStep(),
                            this.gridSettings.getHalfStep(),
                        ),
                    );
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closestCell = ap;
                    }
                }

                if (closestCell && !unitIsSmallSize) {
                    return this.getClosestAttackCell(
                        mousePosition,
                        this.isCornerMousePosition(
                            unitPositionX,
                            unitPositionY,
                            xMin,
                            xMax,
                            yMin,
                            yMax,
                            mouseCell,
                            mousePosition,
                        ),
                        attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                    );
                }

                return closestCell;
            }

            if (mousePosition.x < xLeft && mousePosition.y < yDown) {
                const newUnitCellPositionX = mouseCell.x - 1;
                const newUnitCellPositionY = mouseCell.y - 1;

                if (newUnitCellPositionX >= 0 && newUnitCellPositionY >= 0) {
                    const closestCell = this.attackCellA(
                        mouseCell,
                        newUnitCellPositionX,
                        newUnitCellPositionY,
                        availableAttackCellHashes,
                        targetUnitTeam,
                    );
                    if (closestCell && !unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                        );
                    }
                    return closestCell;
                }
            } else if (mousePosition.x > xRight && mousePosition.y > yTop) {
                const newUnitCellPositionX = mouseCell.x + 1;
                const newUnitCellPositionY = mouseCell.y + 1;

                if (
                    newUnitCellPositionX < this.gridSettings.getGridSize() &&
                    newUnitCellPositionY < this.gridSettings.getGridSize()
                ) {
                    const closestCell = this.attackCellB(
                        mouseCell,
                        newUnitCellPositionX,
                        newUnitCellPositionY,
                        availableAttackCellHashes,
                        targetUnitTeam,
                    );
                    if (closestCell && !unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                        );
                    }
                    return closestCell;
                }
            } else if (mousePosition.x < xLeft && mousePosition.y > yTop) {
                const newUnitCellPositionX = mouseCell.x - 1;
                const newUnitCellPositionY = mouseCell.y + 1;

                if (newUnitCellPositionX >= 0 && newUnitCellPositionY < this.gridSettings.getGridSize()) {
                    const closestCell = this.attackCellB(
                        mouseCell,
                        newUnitCellPositionX,
                        newUnitCellPositionY,
                        availableAttackCellHashes,
                        targetUnitTeam,
                    );
                    if (closestCell && !unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                        );
                    }
                    return closestCell;
                }
            } else if (mousePosition.x > xRight && mousePosition.y < yDown) {
                const newUnitCellPositionX = mouseCell.x + 1;
                const newUnitCellPositionY = mouseCell.y - 1;

                if (newUnitCellPositionX < this.gridSettings.getGridSize() && newUnitCellPositionY >= 0) {
                    const closestCell = this.attackCellA(
                        mouseCell,
                        newUnitCellPositionX,
                        newUnitCellPositionY,
                        availableAttackCellHashes,
                        targetUnitTeam,
                    );
                    if (closestCell && !unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                        );
                    }
                    return closestCell;
                }
            } else if (mousePosition.x > xRight) {
                const newUnitCellPositionX = mouseCell.x + 1;
                if (availableAttackCellHashes.has((newUnitCellPositionX << 4) | mouseCell.y)) {
                    const p = { x: newUnitCellPositionX, y: mouseCell.y };
                    if (!unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((p.x << 4) | p.y),
                        );
                    }
                    return p;
                }

                const closestCell = this.attackCellC(
                    mouseCell,
                    newUnitCellPositionX,
                    availableAttackCellHashes,
                    targetUnitTeam,
                );
                if (closestCell && !unitIsSmallSize) {
                    return this.getClosestAttackCell(
                        mousePosition,
                        this.isCornerMousePosition(
                            unitPositionX,
                            unitPositionY,
                            xMin,
                            xMax,
                            yMin,
                            yMax,
                            mouseCell,
                            mousePosition,
                        ),
                        attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                    );
                }
                return closestCell;
            } else if (mousePosition.x < xLeft) {
                const newUnitCellPositionX = mouseCell.x - 1;
                if (availableAttackCellHashes.has((newUnitCellPositionX << 4) | mouseCell.y)) {
                    const p = { x: newUnitCellPositionX, y: mouseCell.y };
                    if (!unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((p.x << 4) | p.y),
                        );
                    }
                    return p;
                }

                const closestCell = this.attackCellC(
                    mouseCell,
                    newUnitCellPositionX,
                    availableAttackCellHashes,
                    targetUnitTeam,
                );
                if (closestCell && !unitIsSmallSize) {
                    return this.getClosestAttackCell(
                        mousePosition,
                        this.isCornerMousePosition(
                            unitPositionX,
                            unitPositionY,
                            xMin,
                            xMax,
                            yMin,
                            yMax,
                            mouseCell,
                            mousePosition,
                        ),
                        attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                    );
                }
                return closestCell;
            } else if (mousePosition.y > yTop) {
                const newUnitCellPositionY = mouseCell.y + 1;
                if (availableAttackCellHashes.has((mouseCell.x << 4) | newUnitCellPositionY)) {
                    const p = { x: mouseCell.x, y: newUnitCellPositionY };
                    if (!unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((p.x << 4) | p.y),
                        );
                    }
                    return p;
                }

                const closestCell = this.attackCellD(
                    mouseCell,
                    newUnitCellPositionY,
                    availableAttackCellHashes,
                    targetUnitTeam,
                );
                if (closestCell && !unitIsSmallSize) {
                    return this.getClosestAttackCell(
                        mousePosition,
                        this.isCornerMousePosition(
                            unitPositionX,
                            unitPositionY,
                            xMin,
                            xMax,
                            yMin,
                            yMax,
                            mouseCell,
                            mousePosition,
                        ),
                        attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                    );
                }
                return closestCell;
            } else if (mousePosition.y < yDown) {
                const newUnitCellPositionY = mouseCell.y - 1;
                if (availableAttackCellHashes.has((mouseCell.x << 4) | newUnitCellPositionY)) {
                    const p = { x: mouseCell.x, y: newUnitCellPositionY };
                    if (!unitIsSmallSize) {
                        return this.getClosestAttackCell(
                            mousePosition,
                            this.isCornerMousePosition(
                                unitPositionX,
                                unitPositionY,
                                xMin,
                                xMax,
                                yMin,
                                yMax,
                                mouseCell,
                                mousePosition,
                            ),
                            attackCellHashesToLargeCells.get((p.x << 4) | p.y),
                        );
                    }
                    return p;
                }

                const closestCell = this.attackCellD(
                    mouseCell,
                    newUnitCellPositionY,
                    availableAttackCellHashes,
                    targetUnitTeam,
                );
                if (closestCell && !unitIsSmallSize) {
                    return this.getClosestAttackCell(
                        mousePosition,
                        this.isCornerMousePosition(
                            unitPositionX,
                            unitPositionY,
                            xMin,
                            xMax,
                            yMin,
                            yMax,
                            mouseCell,
                            mousePosition,
                        ),
                        attackCellHashesToLargeCells.get((closestCell.x << 4) | closestCell.y),
                    );
                }
                return closestCell;
            }
        }

        return undefined;
    }
    /** A 2x2 block is the W === H === 2 instance of the footprint rule, so it is checked by the same code. */
    public areCellsFormingSquare(cells?: XY[]): boolean {
        return this.areCellsFormingFootprint(cells, 2, 2);
    }
    /**
     * Whether `cells` is exactly the `width` x `height` block of on-board cells a unit of that size occupies.
     *
     * Counting the cells and measuring the extents is not enough on its own: [(3,5), (3,5), (4,5), (4,6)]
     * has four entries and 1x1 extents while covering only three cells, so a repeated cell used to pass as a
     * square. W*H DISTINCT in-grid cells inside a bounding box of exactly W*H cells can only be the full
     * rectangle, which is why the three checks together are the whole rule.
     */
    public areCellsFormingFootprint(cells: XY[] | undefined, width: number, height: number): boolean {
        const w = normalizeFootprintSide(width);
        const h = normalizeFootprintSide(height);
        if (!cells || cells.length !== w * h) {
            return false;
        }

        let xMin = Number.MAX_SAFE_INTEGER;
        let xMax = Number.MIN_SAFE_INTEGER;
        let yMin = Number.MAX_SAFE_INTEGER;
        let yMax = Number.MIN_SAFE_INTEGER;

        const knownHashes: Set<string> = new Set();

        for (const c of cells) {
            if (
                c.x < 0 ||
                c.y < 0 ||
                c.x >= this.gridSettings.getGridSize() ||
                c.y >= this.gridSettings.getGridSize()
            ) {
                return false;
            }

            // String keys, not the packed (x << 4) | y ones: those collide once a board is wider than 16.
            const key = `${c.x}:${c.y}`;
            if (knownHashes.has(key)) {
                return false;
            }
            knownHashes.add(key);
            xMin = Math.min(xMin, c.x);
            xMax = Math.max(xMax, c.x);
            yMin = Math.min(yMin, c.y);
            yMax = Math.max(yMax, c.y);
        }

        return xMax - xMin === w - 1 && yMax - yMin === h - 1;
    }
    /**
     * The cells under the cursor a `footprintWidth` x `footprintHeight` body would stand on, or undefined
     * when the cursor is nowhere near a legal block. Named for the 2x2 square it was written for, which is
     * still the default; a 1x2 or 2x1 simply grows the block along one axis instead of both.
     */
    public getClosestSquareCellIndices(
        mousePosition: XY,
        allowedPlacementCellHashes?: ReadonlySet<number>,
        occupiedCellKeys?: string[],
        unitCells?: XY[],
        allowedToMoveThere?: Set<number>,
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
        footprintWidth = 2,
        footprintHeight = 2,
    ): XY[] | undefined {
        const width = normalizeFootprintSide(footprintWidth, 2);
        const height = normalizeFootprintSide(footprintHeight, 2);
        const footprintCellCount = width * height;
        const squareCells: XY[] = [];
        const mouseCell = getCellForPosition(this.gridSettings, mousePosition);
        const neightborCells: IXYDistance[] = [];

        const hasStarted = !!allowedToMoveThere;

        const isOneOfTheUnitCells = (cellToCheck: XY): boolean => {
            if (!unitCells?.length) {
                return false;
            }

            for (const c of unitCells) {
                if (c.x === cellToCheck.x && c.y === cellToCheck.y) {
                    return true;
                }
            }

            return false;
        };

        const isAllowed = (cellKey: number): boolean => {
            if (!allowedPlacementCellHashes?.size && !allowedToMoveThere) {
                return false;
            }

            return (
                allowedPlacementCellHashes?.has(cellKey) || (!!allowedToMoveThere && allowedToMoveThere.has(cellKey))
            );
        };

        const getReachable = (): XY[] => {
            const reachable: XY[] = [];

            let maxX = Number.MIN_SAFE_INTEGER;
            let maxY = Number.MIN_SAFE_INTEGER;

            for (const c of squareCells) {
                maxX = Math.max(maxX, c.x);
                maxY = Math.max(maxY, c.y);
            }

            for (const c of squareCells) {
                // need to make sure that top right corner is reachable
                if (
                    currentActiveKnownPaths &&
                    squareCells.length === footprintCellCount &&
                    c.x === maxX &&
                    c.y === maxY &&
                    !currentActiveKnownPaths.has((c.x << 4) | c.y)
                ) {
                    continue;
                }

                reachable.push(c);
            }

            let allWithinGrid = true;
            let allOutsideGrid = true;
            for (const c of reachable) {
                if (!isCellWithinGrid(this.gridSettings, c)) {
                    allWithinGrid = false;
                    break;
                }
            }
            for (const c of reachable) {
                if (isCellWithinGrid(this.gridSettings, c)) {
                    allOutsideGrid = false;
                    break;
                }
            }

            if (allOutsideGrid || allWithinGrid) {
                return reachable;
            }

            return [];
        };

        const yStart = PathHelper.Y_FACTION_ICONS_OFFSET - 1;

        if (mouseCell) {
            const mouseCellKey = (mouseCell.x << 4) | mouseCell.y;
            if (isOneOfTheUnitCells(mouseCell)) {
                squareCells.push(mouseCell);
            } else if (
                !hasStarted &&
                ((mouseCell.x < 0 && mouseCell.y > yStart) || mouseCell.x >= this.gridSettings.getGridSize())
            ) {
                if (!occupiedCellKeys?.includes(`${mouseCell.x}:${mouseCell.y}`)) {
                    squareCells.push(mouseCell);
                }
            } else if (!occupiedCellKeys?.includes(`${mouseCell.x}:${mouseCell.y}`) && isAllowed(mouseCellKey)) {
                squareCells.push(mouseCell);
            }

            const cellsToCheck = this.getNeighborCells(mouseCell, new Set([mouseCellKey]), true, true, !hasStarted);
            for (const c of cellsToCheck) {
                const cellPosition = getPositionForCell(
                    c,
                    this.gridSettings.getMinX(),
                    this.gridSettings.getStep(),
                    this.gridSettings.getHalfStep(),
                );
                neightborCells.push({
                    xy: c,
                    distance: getDistance(mousePosition, {
                        x: cellPosition.x,
                        y: cellPosition.y,
                    }),
                });
            }
        }

        if (neightborCells.length >= 3) {
            neightborCells.sort((a: IXYDistance, b: IXYDistance) => {
                if (a.distance < b.distance) {
                    return -1;
                }
                if (a.distance > b.distance) {
                    return 1;
                }
                return 0;
            });
            let refCell = mouseCell;
            let skipFirst = false;

            if (!refCell) {
                refCell = neightborCells[0].xy;
                const refCellKey = (refCell.x << 4) | refCell.y;
                if (isOneOfTheUnitCells(refCell)) {
                    squareCells.push(refCell);
                } else if (
                    !hasStarted &&
                    ((refCell.x < 0 && refCell.y > yStart) || refCell.x >= this.gridSettings.getGridSize())
                ) {
                    if (!occupiedCellKeys?.includes(`${refCell.x}:${refCell.y}`)) {
                        squareCells.push(refCell);
                    }
                } else if (!occupiedCellKeys?.includes(`${refCell.x}:${refCell.y}`) && isAllowed(refCellKey)) {
                    squareCells.push(refCell);
                }
                skipFirst = true;
            }

            for (const nc of neightborCells) {
                if (skipFirst) {
                    skipFirst = false;
                    continue;
                }
                let needToAdd = false;
                for (const sc of squareCells) {
                    // Two cells of one body are at most W-1 apart on x and H-1 apart on y, so a 1x2 accepts
                    // only its own column while a 2x2 keeps the legacy 1-cell slack on both axes.
                    const absX = Math.abs(sc.x - nc.xy.x);
                    if (absX > width - 1) {
                        needToAdd = false;
                        break;
                    }
                    const absY = Math.abs(sc.y - nc.xy.y);
                    if (absY > height - 1) {
                        needToAdd = false;
                        break;
                    }

                    needToAdd = true;
                }
                if (needToAdd) {
                    const ncKey = (nc.xy.x << 4) | nc.xy.y;
                    if (isOneOfTheUnitCells(nc.xy)) {
                        squareCells.push(nc.xy);
                    } else if (
                        !hasStarted &&
                        ((nc.xy.x < 0 && nc.xy.y > yStart) || nc.xy.x >= this.gridSettings.getGridSize())
                    ) {
                        if (!occupiedCellKeys?.includes(`${nc.xy.x}:${nc.xy.y}`)) {
                            squareCells.push(nc.xy);
                        }
                    } else if (!occupiedCellKeys?.includes(`${nc.xy.x}:${nc.xy.y}`) && isAllowed(ncKey)) {
                        squareCells.push(nc.xy);
                    }
                }
                if (squareCells.length >= footprintCellCount) {
                    break;
                }
            }
        } else {
            return undefined;
        }

        return getReachable();
    }
    public isAllowedPreStartUnitPosition(
        unit: Unit,
        cells: XY[],
        unitsHolder: UnitsHolder,
        leftBottomPlacement?: IPlacement,
        rightTopPlacement?: IPlacement,
        leftTopPlacement?: IPlacement,
        rightBottomPlacement?: IPlacement,
    ): boolean {
        if (!leftBottomPlacement || !rightTopPlacement) {
            return false;
        }

        const position = unit.getPosition();

        // --- core placement rule: team must be in its placement rectangles
        const isInTeamPlacement =
            ((unit.getTeam() === TeamVals.LEFT || unit.getTeam() === TeamVals.NO_TEAM) &&
                ((leftBottomPlacement.isAllowed(position) ?? false) ||
                    (leftTopPlacement?.isAllowed(position) ?? false))) ||
            ((unit.getTeam() === TeamVals.RIGHT || unit.getTeam() === TeamVals.NO_TEAM) &&
                ((rightTopPlacement.isAllowed(position) ?? false) ||
                    (rightBottomPlacement?.isAllowed(position) ?? false)));

        // Determine which team the mouse is targeting (proposed team)
        let proposedTeam: TeamType = TeamVals.NO_TEAM;
        if ((leftBottomPlacement.isAllowed(position) ?? false) || (leftTopPlacement?.isAllowed(position) ?? false)) {
            proposedTeam = TeamVals.LEFT;
        } else if (
            (rightTopPlacement.isAllowed(position) ?? false) ||
            (rightBottomPlacement?.isAllowed(position) ?? false)
        ) {
            proposedTeam = TeamVals.RIGHT;
        }

        // how many allies of this team are already placed on the field
        const alliesPlacedCount = unitsHolder.getAllAlliesPlaced(
            proposedTeam,
            leftBottomPlacement,
            rightTopPlacement,
            leftTopPlacement,
            rightBottomPlacement,
        ).length;

        const maxUnitsForTeam = FightStateManager.getInstance()
            .getFightProperties()
            .getNumberOfUnitsAvailableForPlacement(proposedTeam);

        const canPlaceMore = alliesPlacedCount < maxUnitsForTeam;

        // if the unit is already on the grid, we allow "reposition" even if cap is reached
        const isInsideGridAtOwnPosition = isPositionWithinGrid(this.gridSettings, unit.getPosition());

        const isInPlacementAndAllowedCount = isInTeamPlacement && (canPlaceMore || isInsideGridAtOwnPosition);

        // --- for multi-cell units, if we have a candidate block selection, validate that shape. Asking for
        // the unit's own WxH rather than a square is what lets a 1x2 be placed at all: its two cells could
        // never satisfy the square check, so every pre-fight position was refused.
        if (!isInPlacementAndAllowedCount || unit.isSmallSize()) {
            return isInPlacementAndAllowedCount;
        }

        return this.areCellsFormingFootprint(cells, unit.getFootprintWidth(), unit.getFootprintHeight());
    }
    public getMovePath(
        currentCell: XY,
        matrix: number[][],
        maxSteps: number,
        aggrBoard?: number[][],
        canFly = false,
        isSmallUnit = true,
        isMadeOfFire = false,
        hasVineStride = false,
        footprintWidth = isSmallUnit ? 1 : 2,
        footprintHeight = isSmallUnit ? 1 : 2,
    ): IMovePath {
        // From here on the body is read off W/H, never off isSmallUnit — that flag now only supplies their
        // defaults. A 1x1 IS the legacy small unit and a 2x2 IS the legacy large one, but a 1x2 is neither,
        // and asking "is it small?" about it gives the wrong answer whichever way it is answered.
        const width = normalizeFootprintSide(footprintWidth, isSmallUnit ? 1 : 2);
        const height = normalizeFootprintSide(footprintHeight, isSmallUnit ? 1 : 2);
        const isSmallFootprint = width === 1 && height === 1;
        // The two shipped shapes keep their hand-written branches below so their cell ORDER, their float
        // accumulation order in aggr() and their exact matrix probe order cannot drift. Every other
        // rectangle walks the generic path driven by these offsets, computed once here because they are
        // read for every neighbour of every visited cell.
        const usesLegacySquareFootprint = width === 2 && height === 2;
        const footprintOffsetsX: number[] = [];
        const footprintOffsetsY: number[] = [];
        for (let dx = 0; dx < width; dx++) {
            for (let dy = 0; dy < height; dy++) {
                footprintOffsetsX.push(dx);
                footprintOffsetsY.push(dy);
            }
        }
        const footprintCellCount = footprintOffsetsX.length;
        const knownPaths: Map<number, IWeightedRoute[]> = new Map();
        const allowed: XY[] = [];
        // Packed keys are collision-free 0..255 on the production board. Keep every custom/malformed case on
        // the generic collections path: overrides can observe calls, and packed-key collisions outside 16x16
        // are part of the public compatibility contract.
        const usesIndexedPathState =
            this.getNeighborCells === BASE_PATH_HELPER_GET_NEIGHBOR_CELLS &&
            this.captureRoute === BASE_PATH_HELPER_CAPTURE_ROUTE &&
            this.filterUnallowedDestinations === BASE_PATH_HELPER_FILTER_UNALLOWED_DESTINATIONS &&
            this.gridSettings.getGridSize() === 16 &&
            Number.isInteger(currentCell.x) &&
            Number.isInteger(currentCell.y) &&
            !Object.is(currentCell.x, -0) &&
            !Object.is(currentCell.y, -0) &&
            currentCell.x >= width - 1 &&
            currentCell.x < 16 &&
            currentCell.y >= height - 1 &&
            currentCell.y < 16;
        let currentCellKeys: number[];
        if (isSmallFootprint) {
            currentCellKeys = [(currentCell.x << 4) | currentCell.y];
        } else if (usesLegacySquareFootprint) {
            currentCellKeys = [
                ((currentCell.x - 1) << 4) | currentCell.y,
                (currentCell.x << 4) | (currentCell.y - 1),
                ((currentCell.x - 1) << 4) | (currentCell.y - 1),
                (currentCell.x << 4) | currentCell.y,
            ];
        } else {
            currentCellKeys = [];
            for (let i = 0; i < footprintCellCount; i++) {
                currentCellKeys.push(
                    ((currentCell.x - footprintOffsetsX[i]) << 4) | (currentCell.y - footprintOffsetsY[i]),
                );
            }
        }
        const initialCellKeys: Set<number> = new Set(currentCellKeys);
        const currentCellKey = (currentCell.x << 4) | currentCell.y;
        const indexedVisited: Uint8Array | undefined = usesIndexedPathState ? new Uint8Array(256) : undefined;
        const visited: Set<number> | undefined = usesIndexedPathState ? undefined : new Set([currentCellKey]);
        const indexedAllowed: Uint8Array | undefined = usesIndexedPathState ? new Uint8Array(256) : undefined;
        const allowedToMoveThere: Set<number> | undefined = usesIndexedPathState ? undefined : new Set();
        // Float64Array stores the same IEEE-754 values as number[]. Every queued key is written before it can
        // be read, so no sentinel/fill is needed. The generic Map retains malformed-key behavior.
        const indexedStepsRemaining: Float64Array | undefined = usesIndexedPathState
            ? new Float64Array(256)
            : undefined;
        const mappedStepsRemaining: Map<number, number> | undefined = usesIndexedPathState ? undefined : new Map();
        if (indexedVisited) {
            indexedVisited[currentCellKey] = 1;
        }
        if (indexedStepsRemaining) {
            indexedStepsRemaining[currentCellKey] = maxSteps;
        } else {
            mappedStepsRemaining!.set(currentCellKey, maxSteps);
        }
        const queue: IWeightedRoute[] = [
            {
                cell: currentCell,
                route: [currentCell],
                weight: 0,
                firstAggrMet: false,
                hasLavaCell: matrixElementOrDefault(matrix, currentCell.x, currentCell.y, 0) === ObstacleType.LAVA,
                hasWaterCell: matrixElementOrDefault(matrix, currentCell.x, currentCell.y, 0) === ObstacleType.WATER,
            },
        ];

        // Production aggression boards are dense and x-major. Read them directly without allocating footprint cells;
        // malformed/custom boards retain the legacy cell list and access expression so read order/errors stay exact.
        let usesDirectAggression =
            usesIndexedPathState && !canFly && Array.isArray(aggrBoard) && aggrBoard.length === 16;
        if (usesDirectAggression) {
            for (let x = 0; x < 16; x++) {
                if (!Array.isArray(aggrBoard![x]) || aggrBoard![x].length !== 16) {
                    usesDirectAggression = false;
                    break;
                }
            }
        }

        const aggr = (cell: XY, weightedRoute: IWeightedRoute): number => {
            if (!aggrBoard) {
                return 1;
            }

            let sumAggr = 0;
            let cellCount: number;
            if (usesDirectAggression) {
                sumAggr += aggrBoard[cell.x][cell.y] || 1;
                if (isSmallFootprint) {
                    cellCount = 1;
                } else if (usesLegacySquareFootprint) {
                    sumAggr += aggrBoard[cell.x - 1][cell.y] || 1;
                    sumAggr += aggrBoard[cell.x - 1][cell.y - 1] || 1;
                    sumAggr += aggrBoard[cell.x][cell.y - 1] || 1;
                    cellCount = 4;
                } else {
                    // Offset 0 is the anchor, already summed above.
                    for (let i = 1; i < footprintCellCount; i++) {
                        sumAggr += aggrBoard[cell.x - footprintOffsetsX[i]][cell.y - footprintOffsetsY[i]] || 1;
                    }
                    cellCount = footprintCellCount;
                }
            } else if (isSmallFootprint || usesLegacySquareFootprint) {
                const cells = isSmallFootprint
                    ? [cell]
                    : [
                          cell,
                          { x: cell.x - 1, y: cell.y },
                          { x: cell.x - 1, y: cell.y - 1 },
                          { x: cell.x, y: cell.y - 1 },
                      ];
                for (const cell of cells) {
                    sumAggr += aggrBoard[cell.x][cell.y] || 1;
                }
                cellCount = cells.length;
            } else {
                for (let i = 0; i < footprintCellCount; i++) {
                    sumAggr += aggrBoard[cell.x - footprintOffsetsX[i]][cell.y - footprintOffsetsY[i]] || 1;
                }
                cellCount = footprintCellCount;
            }

            const aggrValue = sumAggr / cellCount;
            if (aggrValue > 1) {
                if (!weightedRoute.firstAggrMet) {
                    weightedRoute.firstAggrMet = true;
                    return 1;
                }
            }
            return aggrValue;
        };

        // The occupancy predicate the legacy 1x1/2x2 branches spell out inline four times over: a walker is
        // stopped by anything standing on the cell (lava included, unless it is made of fire), a flyer only
        // by what it cannot fly over.
        const blocksBody = (el: number): boolean =>
            (!!el && !canFly && !(isMadeOfFire && el === ObstacleType.LAVA)) ||
            (canFly && !!el && el !== ObstacleType.LAVA && el !== ObstacleType.WATER);

        // Whether `anchor`'s footprint contains a cell — plain rectangle arithmetic, because the anchor is
        // the block's top-right cell and the body extends towards -x/-y.
        const footprintCovers = (anchor: XY, x: number, y: number): boolean =>
            x <= anchor.x && x > anchor.x - width && y <= anchor.y && y > anchor.y - height;

        /**
         * Whether a diagonal step would shear the body through a blocked cell.
         *
         * A body does not teleport across the diagonal: it has to pass along one of the two L routes (x
         * first, then y — or y first, then x), and every cell either route sweeps that the body is not
         * already standing on and does not end up standing on has to be free. For a 2x2 that is precisely
         * the four hand-written cases kept below (down-left, for example, reduces to "(x-2, y) and
         * (x, y-2) must both be free"), which is why the shipped large unit still takes the legacy branch
         * and this one only ever runs for the new shapes.
         */
        const shearsThroughBlockedCell = (from: XY, to: XY): boolean => {
            const stepX = to.x - from.x;
            const stepY = to.y - from.y;
            for (let route = 0; route < 2; route++) {
                const viaX = route === 0 ? from.x + stepX : from.x;
                const viaY = route === 0 ? from.y : from.y + stepY;
                for (let i = 0; i < footprintCellCount; i++) {
                    const cx = viaX - footprintOffsetsX[i];
                    const cy = viaY - footprintOffsetsY[i];
                    if (footprintCovers(from, cx, cy) || footprintCovers(to, cx, cy)) {
                        continue;
                    }
                    if (matrixElementOrDefault(matrix, cx, cy, 0)) {
                        return true;
                    }
                }
            }
            return false;
        };

        // A destination is a whole body, not just its anchor, so every cell of the footprint has to be
        // marked movable — otherwise the board offers a WxH unit a landing spot it only half fits on.
        const markFootprintAllowed = (anchor: XY): void => {
            // Offset 0 is the anchor itself, which the caller has already pushed.
            for (let i = 1; i < footprintCellCount; i++) {
                const cx = anchor.x - footprintOffsetsX[i];
                const cy = anchor.y - footprintOffsetsY[i];
                const footprintKey = (cx << 4) | cy;
                if (indexedAllowed ? indexedAllowed[footprintKey] : allowedToMoveThere!.has(footprintKey)) {
                    continue;
                }
                if (indexedAllowed) indexedAllowed[footprintKey] = 1;
                else allowedToMoveThere!.add(footprintKey);
                allowed.push({ x: cx, y: cy });
            }
        };

        // Vine Throw terrain. Read off the live fight the same way attack_handler reads smoke clouds — the
        // store is snapshotted with the rest of fight properties, so AI rollouts see the vines of whatever
        // state they are exploring rather than the live board.
        //
        // A vined cell slows everything that wades through it, except flyers stepping over the top — and
        // except Trent, whose "In Its Own World" turns its own vines into the fastest road on the board:
        // half a plain step, with a diagonal costing no more than a straight one.
        const vines = FightStateManager.getInstance().getFightProperties().getVines();
        const hasAnyVine = vines.size() > 0;
        const vineAdjustedCost = (baseCost: number, plainStepCost: number, cell: XY): number => {
            if (!hasAnyVine || !vines.has(cell)) {
                return baseCost;
            }
            if (hasVineStride) {
                return plainStepCost * VINE_STRIDE_COST_MULTIPLIER;
            }
            return canFly ? baseCost : baseCost + VINE_CROSS_PENALTY;
        };

        // Fire Wall terrain, read off the live fight the same way. A burning cell costs one extra step on
        // top of whatever the cell already cost — so a plain step through the wall is double price, and a
        // vined-and-burning cell charges for both. Flyers are NOT spared here (a vine is something to step
        // over; a wall of fire is not), which is also why this sits outside vineAdjustedCost's canFly check.
        const fireWalls = FightStateManager.getInstance().getFightProperties().getFireWalls();
        const hasAnyFireWall = fireWalls.size() > 0;
        const terrainAdjustedCost = (baseCost: number, plainStepCost: number, cell: XY): number => {
            const cost = vineAdjustedCost(baseCost, plainStepCost, cell);
            if (!hasAnyFireWall || !fireWalls.has(cell)) {
                return cost;
            }
            return cost + FIRE_WALL_CROSS_PENALTY;
        };

        const indexedNeighbors: XY[] | undefined = usesIndexedPathState ? [] : undefined;
        // FIFO traversal never removes or reorders queued entries. A read cursor preserves that order while
        // avoiding Array.shift's repeated tail compaction on every visited board cell.
        let queueIndex = 0;
        while (queueIndex < queue.length) {
            const curWeightedRoute = queue[queueIndex++];

            const cur = curWeightedRoute.cell;

            const key = (cur.x << 4) | cur.y;
            let neighbors: XY[];
            if (indexedNeighbors) {
                indexedNeighbors.length = 0;
                const canGoLeft = cur.x > width - 1;
                const canGoRight = cur.x < 15;
                const canGoDown = cur.y > height - 1;
                const canGoUp = cur.y < 15;
                if (canGoLeft) {
                    const x = cur.x - 1;
                    if (!indexedVisited![(x << 4) | cur.y]) indexedNeighbors.push({ x, y: cur.y });
                }
                if (canGoUp) {
                    const y = cur.y + 1;
                    if (!indexedVisited![(cur.x << 4) | y]) indexedNeighbors.push({ x: cur.x, y });
                }
                if (canGoDown) {
                    const y = cur.y - 1;
                    if (!indexedVisited![(cur.x << 4) | y]) indexedNeighbors.push({ x: cur.x, y });
                }
                if (canGoRight) {
                    const x = cur.x + 1;
                    if (!indexedVisited![(x << 4) | cur.y]) indexedNeighbors.push({ x, y: cur.y });
                }
                if (canGoLeft && canGoDown) {
                    const x = cur.x - 1;
                    const y = cur.y - 1;
                    if (!indexedVisited![(x << 4) | y]) indexedNeighbors.push({ x, y });
                }
                if (canGoLeft && canGoUp) {
                    const x = cur.x - 1;
                    const y = cur.y + 1;
                    if (!indexedVisited![(x << 4) | y]) indexedNeighbors.push({ x, y });
                }
                if (canGoRight && canGoDown) {
                    const x = cur.x + 1;
                    const y = cur.y - 1;
                    if (!indexedVisited![(x << 4) | y]) indexedNeighbors.push({ x, y });
                }
                if (canGoRight && canGoUp) {
                    const x = cur.x + 1;
                    const y = cur.y + 1;
                    if (!indexedVisited![(x << 4) | y]) indexedNeighbors.push({ x, y });
                }
                neighbors = indexedNeighbors;
            } else {
                neighbors = this.getNeighborCells(cur, visited!, isSmallUnit, true, false, width, height);
            }
            for (const n of neighbors) {
                const keyNeighbor = (n.x << 4) | n.y;
                // A legal anchor is the upper-right cell of its WxH footprint, so x must stay at least W-1
                // and y at least H-1 (the legacy "at least 1" is that rule at 2x2). Keep malformed state
                // (for example, a size-unsafe position swap) from evaluating occupancy or aggro outside the
                // board while recovery finds a valid re-entry.
                if (
                    !isSmallFootprint &&
                    (n.x < width - 1 || n.y < height - 1 || !isCellWithinGrid(this.gridSettings, n))
                ) {
                    if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                    else visited!.add(keyNeighbor);
                    continue;
                }
                const el1 = matrixElementOrDefault(matrix, n.x, n.y, 0);
                if (isSmallFootprint) {
                    if (
                        ((el1 && !canFly && !(isMadeOfFire && el1 === ObstacleType.LAVA)) ||
                            (canFly && el1 && el1 !== ObstacleType.LAVA && el1 !== ObstacleType.WATER)) &&
                        !initialCellKeys.has(keyNeighbor)
                    ) {
                        if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                        else visited!.add(keyNeighbor);
                        continue;
                    }
                } else if (usesLegacySquareFootprint) {
                    const unitKeyLeft = ((n.x - 1) << 4) | n.y;
                    const unitKeyLeftDown = ((n.x - 1) << 4) | (n.y - 1);
                    const unitKeyDown = (n.x << 4) | (n.y - 1);
                    const el2 = matrixElementOrDefault(matrix, n.x - 1, n.y, 0);
                    const el3 = matrixElementOrDefault(matrix, n.x - 1, n.y - 1, 0);
                    const el4 = matrixElementOrDefault(matrix, n.x, n.y - 1, 0);
                    if (
                        (((el1 && !canFly && !(isMadeOfFire && el1 === ObstacleType.LAVA)) ||
                            (canFly && el1 && el1 !== ObstacleType.LAVA && el1 !== ObstacleType.WATER)) &&
                            !initialCellKeys.has(keyNeighbor)) ||
                        (((el2 && !canFly && !(isMadeOfFire && el2 === ObstacleType.LAVA)) ||
                            (canFly && el2 && el2 !== ObstacleType.LAVA && el2 !== ObstacleType.WATER)) &&
                            !initialCellKeys.has(unitKeyLeft)) ||
                        (((el3 && !canFly && !(isMadeOfFire && el3 === ObstacleType.LAVA)) ||
                            (canFly && el3 && el3 !== ObstacleType.LAVA && el3 !== ObstacleType.WATER)) &&
                            !initialCellKeys.has(unitKeyLeftDown)) ||
                        (((el4 && !canFly && !(isMadeOfFire && el4 === ObstacleType.LAVA)) ||
                            (canFly && el4 && el4 !== ObstacleType.LAVA && el4 !== ObstacleType.WATER)) &&
                            !initialCellKeys.has(unitKeyDown))
                    ) {
                        if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                        else visited!.add(keyNeighbor);
                        continue;
                    }
                } else {
                    // Same probe as the 2x2 branch above, over however many cells the body actually has.
                    let footprintBlocked = false;
                    for (let i = 0; i < footprintCellCount; i++) {
                        const fx = n.x - footprintOffsetsX[i];
                        const fy = n.y - footprintOffsetsY[i];
                        const el = i === 0 ? el1 : matrixElementOrDefault(matrix, fx, fy, 0);
                        if (blocksBody(el) && !initialCellKeys.has((fx << 4) | fy)) {
                            footprintBlocked = true;
                            break;
                        }
                    }
                    if (footprintBlocked) {
                        if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                        else visited!.add(keyNeighbor);
                        continue;
                    }
                }

                const isDiagMove = cur.x !== n.x && cur.y !== n.y;
                const remaining = indexedStepsRemaining
                    ? (indexedStepsRemaining[key] ?? maxSteps)
                    : (mappedStepsRemaining!.get(key) ?? maxSteps);
                if (isDiagMove) {
                    let moveCost: number;
                    if (canFly || !aggrBoard) {
                        moveCost = PathHelper.DIAGONAL_MOVE_COST;
                    } else {
                        moveCost = PathHelper.DIAGONAL_MOVE_COST * aggr(n, curWeightedRoute);
                    }
                    // Dividing back out the diagonal factor recovers the aggression-adjusted plain step, which
                    // is what a vine strider pays for a diagonal.
                    moveCost = terrainAdjustedCost(moveCost, moveCost / PathHelper.DIAGONAL_MOVE_COST, n);

                    if (remaining >= moveCost) {
                        // disallow sneaking between diagonals
                        if (!canFly) {
                            const xA = cur.x - 1;
                            const yA = cur.y - 1;
                            const xB = cur.x + 1;
                            const yB = cur.y + 1;
                            if (!isSmallFootprint && !usesLegacySquareFootprint) {
                                if (shearsThroughBlockedCell(cur, n)) {
                                    continue;
                                }
                            } else if (xA === n.x && yA === n.y) {
                                if (isSmallFootprint) {
                                    if (
                                        matrixElementOrDefault(matrix, xA, cur.y, 0) &&
                                        matrixElementOrDefault(matrix, cur.x, yA, 0)
                                    ) {
                                        continue;
                                    }
                                } else if (
                                    matrixElementOrDefault(matrix, cur.x - 2, cur.y, 0) ||
                                    matrixElementOrDefault(matrix, cur.x, cur.y - 2, 0)
                                ) {
                                    continue;
                                }
                            } else if (xB === n.x && yB === n.y) {
                                if (isSmallFootprint) {
                                    if (
                                        matrixElementOrDefault(matrix, xB, cur.y, 0) &&
                                        matrixElementOrDefault(matrix, cur.x, yB, 0)
                                    ) {
                                        continue;
                                    }
                                } else if (
                                    matrixElementOrDefault(matrix, xA, yB, 0) ||
                                    matrixElementOrDefault(matrix, xB, yA, 0)
                                ) {
                                    continue;
                                }
                            } else if (xA === n.x && yB === n.y) {
                                if (isSmallFootprint) {
                                    if (
                                        matrixElementOrDefault(matrix, xA, cur.y, 0) &&
                                        matrixElementOrDefault(matrix, cur.x, yB, 0)
                                    ) {
                                        continue;
                                    }
                                } else if (
                                    matrixElementOrDefault(matrix, cur.x - 2, yA, 0) ||
                                    matrixElementOrDefault(matrix, cur.x, yB, 0)
                                ) {
                                    continue;
                                }
                            } else if (xB === n.x && yA === n.y) {
                                if (isSmallFootprint) {
                                    if (
                                        matrixElementOrDefault(matrix, xB, cur.y, 0) &&
                                        matrixElementOrDefault(matrix, cur.x, yA, 0)
                                    ) {
                                        continue;
                                    }
                                } else if (
                                    matrixElementOrDefault(matrix, xA, cur.y - 2, 0) ||
                                    matrixElementOrDefault(matrix, cur.x + 1, cur.y, 0)
                                ) {
                                    continue;
                                }
                            }
                        }

                        if (indexedStepsRemaining) {
                            indexedStepsRemaining[keyNeighbor] = remaining - moveCost;
                        } else {
                            mappedStepsRemaining!.set(keyNeighbor, remaining - moveCost);
                        }
                        const weightedRoute = {
                            cell: { x: n.x, y: n.y },
                            route: [...curWeightedRoute.route, n],
                            weight: curWeightedRoute.weight + moveCost,
                            firstAggrMet: curWeightedRoute.firstAggrMet,
                            hasLavaCell: curWeightedRoute.hasLavaCell || el1 === ObstacleType.LAVA,
                            hasWaterCell: curWeightedRoute.hasWaterCell || el1 === ObstacleType.WATER,
                        };
                        if (this.captureRoute(knownPaths, keyNeighbor, weightedRoute)) {
                            if (
                                !(indexedAllowed ? indexedAllowed[keyNeighbor] : allowedToMoveThere!.has(keyNeighbor))
                            ) {
                                if (indexedAllowed) indexedAllowed[keyNeighbor] = 1;
                                else allowedToMoveThere!.add(keyNeighbor);
                                allowed.push({ x: n.x, y: n.y });
                            }
                            if (usesLegacySquareFootprint) {
                                const unitKeyLeft = ((n.x - 1) << 4) | n.y;
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyLeft]
                                        : allowedToMoveThere!.has(unitKeyLeft))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyLeft] = 1;
                                    else allowedToMoveThere!.add(unitKeyLeft);
                                    allowed.push({ x: n.x - 1, y: n.y });
                                }
                                const unitKeyLeftDown = ((n.x - 1) << 4) | (n.y - 1);
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyLeftDown]
                                        : allowedToMoveThere!.has(unitKeyLeftDown))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyLeftDown] = 1;
                                    else allowedToMoveThere!.add(unitKeyLeftDown);
                                    allowed.push({ x: n.x - 1, y: n.y - 1 });
                                }
                                const unitKeyDown = (n.x << 4) | (n.y - 1);
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyDown]
                                        : allowedToMoveThere!.has(unitKeyDown))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyDown] = 1;
                                    else allowedToMoveThere!.add(unitKeyDown);
                                    allowed.push({ x: n.x, y: n.y - 1 });
                                }
                            } else if (!isSmallFootprint) {
                                markFootprintAllowed(n);
                            }
                        }
                        queue.push(weightedRoute);
                        if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                        else visited!.add(keyNeighbor);
                    }
                } else {
                    let moveCost: number;
                    if (canFly || !aggrBoard) {
                        moveCost = 1;
                    } else {
                        moveCost = aggr(n, curWeightedRoute);
                    }
                    moveCost = terrainAdjustedCost(moveCost, moveCost, n);
                    if (remaining >= moveCost) {
                        if (indexedStepsRemaining) {
                            indexedStepsRemaining[keyNeighbor] = remaining - moveCost;
                        } else {
                            mappedStepsRemaining!.set(keyNeighbor, remaining - moveCost);
                        }
                        const weightedRoute = {
                            cell: { x: n.x, y: n.y },
                            route: [...curWeightedRoute.route, n],
                            weight: curWeightedRoute.weight + moveCost,
                            firstAggrMet: curWeightedRoute.firstAggrMet,
                            hasLavaCell: curWeightedRoute.hasLavaCell || el1 === ObstacleType.LAVA,
                            hasWaterCell: curWeightedRoute.hasWaterCell || el1 === ObstacleType.WATER,
                        };

                        if (this.captureRoute(knownPaths, keyNeighbor, weightedRoute)) {
                            if (
                                !(indexedAllowed ? indexedAllowed[keyNeighbor] : allowedToMoveThere!.has(keyNeighbor))
                            ) {
                                if (indexedAllowed) indexedAllowed[keyNeighbor] = 1;
                                else allowedToMoveThere!.add(keyNeighbor);
                                allowed.push({ x: n.x, y: n.y });
                            }
                            if (usesLegacySquareFootprint) {
                                const unitKeyLeft = ((n.x - 1) << 4) | n.y;
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyLeft]
                                        : allowedToMoveThere!.has(unitKeyLeft))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyLeft] = 1;
                                    else allowedToMoveThere!.add(unitKeyLeft);
                                    allowed.push({ x: n.x - 1, y: n.y });
                                }
                                const unitKeyLeftDown = ((n.x - 1) << 4) | (n.y - 1);
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyLeftDown]
                                        : allowedToMoveThere!.has(unitKeyLeftDown))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyLeftDown] = 1;
                                    else allowedToMoveThere!.add(unitKeyLeftDown);
                                    allowed.push({ x: n.x - 1, y: n.y - 1 });
                                }
                                const unitKeyDown = (n.x << 4) | (n.y - 1);
                                if (
                                    !(indexedAllowed
                                        ? indexedAllowed[unitKeyDown]
                                        : allowedToMoveThere!.has(unitKeyDown))
                                ) {
                                    if (indexedAllowed) indexedAllowed[unitKeyDown] = 1;
                                    else allowedToMoveThere!.add(unitKeyDown);
                                    allowed.push({ x: n.x, y: n.y - 1 });
                                }
                            } else if (!isSmallFootprint) {
                                markFootprintAllowed(n);
                            }
                        }
                        queue.push(weightedRoute);
                        if (indexedVisited) indexedVisited[keyNeighbor] = 1;
                        else visited!.add(keyNeighbor);
                    }
                }
            }
        }

        const closestMoves = this.getNeighborCells(
            currentCell,
            new Set([(currentCell.x << 4) | currentCell.y]),
            isSmallUnit,
            false,
            false,
            width,
            height,
        );
        for (const c of closestMoves) {
            const pos = { x: c.x, y: c.y };
            const key = (c.x << 4) | c.y;
            if (isSmallFootprint) {
                const me1 = matrixElementOrDefault(matrix, c.x, c.y, 0);
                if (
                    (me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) ||
                    (indexedAllowed ? indexedAllowed[key] : allowedToMoveThere!.has(key))
                ) {
                    continue;
                }

                allowed.push({ x: c.x, y: c.y });
                if (indexedAllowed) indexedAllowed[key] = 1;
                else allowedToMoveThere!.add(key);

                knownPaths.set(key, [
                    {
                        cell: c,
                        route: [currentCell, pos],
                        weight: 1,
                        firstAggrMet: false,
                        hasLavaCell: me1 === ObstacleType.LAVA,
                        hasWaterCell: me1 === ObstacleType.WATER,
                    },
                ]);
            } else if (!usesLegacySquareFootprint) {
                // One straight step slides the body by a single cell, so only its LEADING EDGE — the cells
                // of the new footprint it is not already standing on — can stop it or has to be marked.
                // That is exactly what each 2x2 branch below does with its hand-written pair of cells.
                let edgeBlocked = false;
                let hasLavaCell = false;
                let hasWaterCell = false;
                for (let i = 0; i < footprintCellCount; i++) {
                    const cx = c.x - footprintOffsetsX[i];
                    const cy = c.y - footprintOffsetsY[i];
                    if (footprintCovers(currentCell, cx, cy)) {
                        continue;
                    }
                    const el = matrixElementOrDefault(matrix, cx, cy, 0);
                    const edgeKey = (cx << 4) | cy;
                    if (
                        (indexedAllowed ? indexedAllowed[edgeKey] : allowedToMoveThere!.has(edgeKey)) ||
                        (el && !(isMadeOfFire && el === ObstacleType.LAVA))
                    ) {
                        edgeBlocked = true;
                        break;
                    }
                    hasLavaCell = hasLavaCell || el === ObstacleType.LAVA;
                    hasWaterCell = hasWaterCell || el === ObstacleType.WATER;
                }
                if (!edgeBlocked) {
                    // Second pass on purpose: the legacy branches also clear every cell of the edge before
                    // marking any of them, so a half-blocked step leaves no trace behind.
                    for (let i = 0; i < footprintCellCount; i++) {
                        const cx = c.x - footprintOffsetsX[i];
                        const cy = c.y - footprintOffsetsY[i];
                        if (footprintCovers(currentCell, cx, cy)) {
                            continue;
                        }
                        const edgeKey = (cx << 4) | cy;
                        if (indexedAllowed) indexedAllowed[edgeKey] = 1;
                        else allowedToMoveThere!.add(edgeKey);
                        allowed.push({ x: cx, y: cy });
                    }

                    knownPaths.set(key, [
                        {
                            cell: c,
                            route: [currentCell, pos],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell,
                            hasWaterCell,
                        },
                    ]);
                }
            } else if (c.x < currentCell.x) {
                const unitKeyLeft = ((c.x - 1) << 4) | c.y;
                const unitKeyLeftDown = ((c.x - 1) << 4) | (c.y - 1);
                const me1 = matrixElementOrDefault(matrix, c.x - 1, c.y, 0);
                const me2 = matrixElementOrDefault(matrix, c.x - 1, c.y - 1, 0);
                if (
                    !(indexedAllowed ? indexedAllowed[unitKeyLeft] : allowedToMoveThere!.has(unitKeyLeft)) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !(indexedAllowed ? indexedAllowed[unitKeyLeftDown] : allowedToMoveThere!.has(unitKeyLeftDown)) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    if (indexedAllowed) indexedAllowed[unitKeyLeft] = 1;
                    else allowedToMoveThere!.add(unitKeyLeft);
                    allowed.push({ x: c.x - 1, y: c.y });
                    if (indexedAllowed) indexedAllowed[unitKeyLeftDown] = 1;
                    else allowedToMoveThere!.add(unitKeyLeftDown);
                    allowed.push({ x: c.x - 1, y: c.y - 1 });

                    knownPaths.set(key, [
                        {
                            cell: c,
                            route: [currentCell, pos],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: me1 === ObstacleType.LAVA || me2 === ObstacleType.LAVA,
                            hasWaterCell: me1 === ObstacleType.WATER || me2 === ObstacleType.WATER,
                        },
                    ]);
                }
            } else if (c.x > currentCell.x) {
                const unitKeyRight = (c.x << 4) | c.y;
                const unitKeyRightDown = (c.x << 4) | (c.y - 1);
                const me1 = matrixElementOrDefault(matrix, c.x, c.y, 0);
                const me2 = matrixElementOrDefault(matrix, c.x, c.y - 1, 0);
                if (
                    !(indexedAllowed ? indexedAllowed[unitKeyRight] : allowedToMoveThere!.has(unitKeyRight)) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !(indexedAllowed ? indexedAllowed[unitKeyRightDown] : allowedToMoveThere!.has(unitKeyRightDown)) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    if (indexedAllowed) indexedAllowed[unitKeyRight] = 1;
                    else allowedToMoveThere!.add(unitKeyRight);
                    allowed.push({ x: c.x, y: c.y });
                    if (indexedAllowed) indexedAllowed[unitKeyRightDown] = 1;
                    else allowedToMoveThere!.add(unitKeyRightDown);
                    allowed.push({ x: c.x, y: c.y - 1 });

                    knownPaths.set(key, [
                        {
                            cell: c,
                            route: [currentCell, pos],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: me1 === ObstacleType.LAVA || me2 === ObstacleType.LAVA,
                            hasWaterCell: me1 === ObstacleType.WATER || me2 === ObstacleType.WATER,
                        },
                    ]);
                }
            } else if (c.y < currentCell.y) {
                const unitKeyDown = (c.x << 4) | (c.y - 1);
                const unitKeyDownLeft = ((c.x - 1) << 4) | (c.y - 1);
                const me1 = matrixElementOrDefault(matrix, c.x, c.y - 1, 0);
                const me2 = matrixElementOrDefault(matrix, c.x - 1, c.y - 1, 0);
                if (
                    !(indexedAllowed ? indexedAllowed[unitKeyDown] : allowedToMoveThere!.has(unitKeyDown)) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !(indexedAllowed ? indexedAllowed[unitKeyDownLeft] : allowedToMoveThere!.has(unitKeyDownLeft)) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    if (indexedAllowed) indexedAllowed[unitKeyDown] = 1;
                    else allowedToMoveThere!.add(unitKeyDown);
                    allowed.push({ x: c.x, y: c.y - 1 });
                    if (indexedAllowed) indexedAllowed[unitKeyDownLeft] = 1;
                    else allowedToMoveThere!.add(unitKeyDownLeft);
                    allowed.push({ x: c.x - 1, y: c.y - 1 });

                    knownPaths.set(key, [
                        {
                            cell: c,
                            route: [currentCell, pos],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: me1 === ObstacleType.LAVA || me2 === ObstacleType.LAVA,
                            hasWaterCell: me1 === ObstacleType.WATER || me2 === ObstacleType.WATER,
                        },
                    ]);
                }
            } else {
                const unitKeyUp = (c.x << 4) | c.y;
                const unitKeyUpLeft = ((c.x - 1) << 4) | c.y;
                const me1 = matrixElementOrDefault(matrix, c.x, c.y, 0);
                const me2 = matrixElementOrDefault(matrix, c.x - 1, c.y, 0);
                if (
                    !(indexedAllowed ? indexedAllowed[unitKeyUp] : allowedToMoveThere!.has(unitKeyUp)) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !(indexedAllowed ? indexedAllowed[unitKeyUpLeft] : allowedToMoveThere!.has(unitKeyUpLeft)) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    if (indexedAllowed) indexedAllowed[unitKeyUp] = 1;
                    else allowedToMoveThere!.add(unitKeyUp);
                    allowed.push({ x: c.x, y: c.y });
                    if (indexedAllowed) indexedAllowed[unitKeyUpLeft] = 1;
                    else allowedToMoveThere!.add(unitKeyUpLeft);
                    allowed.push({ x: c.x - 1, y: c.y });

                    knownPaths.set(key, [
                        {
                            cell: c,
                            route: [currentCell, pos],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: me1 === ObstacleType.LAVA || me2 === ObstacleType.LAVA,
                            hasWaterCell: me1 === ObstacleType.WATER || me2 === ObstacleType.WATER,
                        },
                    ]);
                }
            }
        }

        return this.filterUnallowedDestinations(
            {
                cells: allowed,
                // filterUnallowedDestinations rebuilds hashes from the filtered ordered cells; the working
                // indexed membership table is intentionally not materialized as a redundant Set.
                hashes: allowedToMoveThere ?? new Set(),
                knownPaths,
            },
            matrix,
            isSmallFootprint,
            isMadeOfFire,
        );
    }
}

// Capture the native hooks once at module initialization. Comparing against the live prototype would let a
// prototype-level wrapper pass the fast-path gate after replacing the method, even though the indexed traversal
// deliberately bypasses those hooks. Instance and prototype instrumentation must both retain the generic contract.
const BASE_PATH_HELPER_GET_NEIGHBOR_CELLS = PathHelper.prototype.getNeighborCells;
const BASE_PATH_HELPER_CAPTURE_ROUTE = PathHelper.prototype["captureRoute"];
const BASE_PATH_HELPER_FILTER_UNALLOWED_DESTINATIONS = PathHelper.prototype["filterUnallowedDestinations"];
