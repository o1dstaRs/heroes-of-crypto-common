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
import { TeamType } from "../units/unit_properties";
import { getRandomInt, shuffle } from "../utils/lib";
import { getDistance, IXYDistance, matrixElementOrDefault, XY } from "../utils/math";
import { getCellForPosition, getPositionForCell } from "./grid_math";
import { GridSettings } from "./grid_settings";
import { IMovePath, IWeightedRoute } from "./path_definitions";

export class PathHelper {
    public static DIAGONAL_MOVE_COST = 1.4142135623730951;

    public static Y_FACTION_ICONS_OFFSET = 2;

    private readonly gridSettings: GridSettings;

    public constructor(gridSettings: GridSettings) {
        this.gridSettings = gridSettings;
    }

    public getNeighborCells(
        currentCell: XY,
        visited: Set<number> = new Set(),
        isSmallUnit = true,
        getDiag = true,
        includeLeftRightEdges = false,
    ): XY[] {
        const neighborsLine = [];
        const neighborsDiag = [];
        const diff = includeLeftRightEdges ? 2 : 0;
        const canGoLeft = currentCell.x > (isSmallUnit ? 0 : 1) - diff;
        const canGoRight = currentCell.x < this.gridSettings.getGridSize() - 1 + diff;
        let canGoDown;
        if (currentCell.x < 0) {
            canGoDown = currentCell.y > 2;
        } else if (isSmallUnit) {
            canGoDown = currentCell.y > 0;
        } else {
            canGoDown = currentCell.y > 1;
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
            targetUnitTeam === TeamType.UPPER ||
            (targetUnitTeam === TeamType.NO_TEAM &&
                (unitCell.x <= this.gridSettings.getGridSize() / 2 ||
                    unitCell.y <= this.gridSettings.getGridSize() / 2))
        ) {
            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }

            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }
        } else if (targetUnitTeam === TeamType.LOWER || targetUnitTeam === TeamType.NO_TEAM) {
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
            targetUnitTeam === TeamType.UPPER ||
            (targetUnitTeam === TeamType.NO_TEAM &&
                (unitCell.x > this.gridSettings.getGridSize() / 2 || unitCell.y > this.gridSettings.getGridSize() / 2))
        ) {
            if (availableAttackCellHashes.has((newUnitCellX << 4) | unitCell.y)) {
                return { x: newUnitCellX, y: unitCell.y };
            }

            if (availableAttackCellHashes.has((unitCell.x << 4) | newUnitCellY)) {
                return { x: unitCell.x, y: newUnitCellY };
            }
        } else if (targetUnitTeam === TeamType.LOWER || targetUnitTeam === TeamType.NO_TEAM) {
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
            targetUnitTeam === TeamType.UPPER ||
            (targetUnitTeam === TeamType.NO_TEAM &&
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
        } else if (targetUnitTeam === TeamType.LOWER || targetUnitTeam === TeamType.NO_TEAM) {
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
            targetUnitTeam === TeamType.UPPER ||
            (targetUnitTeam === TeamType.NO_TEAM &&
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
        } else if (targetUnitTeam === TeamType.LOWER) {
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

        shuffle(attackCells);
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
                isAttackerCell
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

    public areCellsFormingSquare(preStart: boolean, cells?: XY[]): boolean {
        if (!cells || cells.length !== 4) {
            return false;
        }

        let xMin = Number.MAX_SAFE_INTEGER;
        let xMax = Number.MIN_SAFE_INTEGER;
        let yMin = Number.MAX_SAFE_INTEGER;
        let yMax = Number.MIN_SAFE_INTEGER;

        const knownHashes: Set<string> = new Set();

        for (const c of cells) {
            if (preStart) {
                if (c.x < -2 || c.x >= this.gridSettings.getGridSize() + 2) {
                    return false;
                }
                if (c.x < 0 && c.y < PathHelper.Y_FACTION_ICONS_OFFSET) {
                    return false;
                }
                if (c.y < -2 || c.y >= this.gridSettings.getGridSize() + 2) {
                    return false;
                }
            } else if (
                c.x < 0 ||
                c.y < 0 ||
                c.x >= this.gridSettings.getGridSize() ||
                c.y >= this.gridSettings.getGridSize()
            ) {
                return false;
            }

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

        return xMax - xMin === 1 && yMax - yMin === 1;
    }

    public getClosestSquareCellIndices(
        mousePosition: XY,
        allowedPlacementCellHashes: Set<number>,
        occupiedCellKeys?: string[],
        unitCells?: XY[],
        allowedToMoveThere?: Set<number>,
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
    ): XY[] | undefined {
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
            if (!allowedPlacementCellHashes.size && !allowedToMoveThere) {
                return false;
            }

            return allowedPlacementCellHashes.has(cellKey) || (!!allowedToMoveThere && allowedToMoveThere.has(cellKey));
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
                    squareCells.length === 4 &&
                    c.x === maxX &&
                    c.y === maxY &&
                    !currentActiveKnownPaths.has((c.x << 4) | c.y)
                ) {
                    continue;
                }

                reachable.push(c);
            }

            return reachable;
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
                    const absX = Math.abs(sc.x - nc.xy.x);
                    if (absX > 1) {
                        needToAdd = false;
                        break;
                    }
                    const absY = Math.abs(sc.y - nc.xy.y);
                    if (absY > 1) {
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
                if (squareCells.length >= 4) {
                    break;
                }
            }
        } else {
            return undefined;
        }

        return getReachable();
    }

    public getMovePath(
        currentCell: XY,
        matrix: number[][],
        maxSteps: number,
        aggrBoard?: number[][],
        canFly = false,
        isSmallUnit = true,
        isMadeOfFire = false,
    ): IMovePath {
        const knownPaths: Map<number, IWeightedRoute[]> = new Map();
        const allowed: XY[] = [];
        let currentCellKeys: number[];
        if (isSmallUnit) {
            currentCellKeys = [(currentCell.x << 4) | currentCell.y];
        } else {
            currentCellKeys = [
                ((currentCell.x - 1) << 4) | currentCell.y,
                (currentCell.x << 4) | (currentCell.y - 1),
                ((currentCell.x - 1) << 4) | (currentCell.y - 1),
                (currentCell.x << 4) | currentCell.y,
            ];
        }
        const initialCellKeys: Set<number> = new Set(currentCellKeys);
        const visited: Set<number> = new Set([(currentCell.x << 4) | currentCell.y]);
        const allowedToMoveThere: Set<number> = new Set();
        const stepsRemaining: Map<number, number> = new Map();
        stepsRemaining.set((currentCell.x << 4) | currentCell.y, maxSteps);
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

        const aggr = (cells: XY[], weightedRoute: IWeightedRoute): number => {
            if (!cells.length) {
                return 1;
            }

            if (aggrBoard) {
                let sumAggr = 0;
                for (const cell of cells) {
                    sumAggr += aggrBoard[cell.x][cell.y] || 1;
                }

                const aggrValue = sumAggr / cells.length;
                if (aggrValue > 1) {
                    if (!weightedRoute.firstAggrMet) {
                        weightedRoute.firstAggrMet = true;
                        return 1;
                    }
                }
                return aggrValue;
            }

            return 1;
        };

        while (queue.length) {
            const curWeightedRoute = queue.shift();
            if (!curWeightedRoute) {
                break;
            }

            const cur = curWeightedRoute.cell;

            const key = (cur.x << 4) | cur.y;
            for (const n of this.getNeighborCells(cur, visited, isSmallUnit)) {
                const keyNeighbor = (n.x << 4) | n.y;
                const el1 = matrixElementOrDefault(matrix, n.x, n.y, 0);
                if (isSmallUnit) {
                    if (
                        ((el1 && !canFly && !(isMadeOfFire && el1 === ObstacleType.LAVA)) ||
                            (canFly && el1 && el1 !== ObstacleType.LAVA && el1 !== ObstacleType.WATER)) &&
                        !initialCellKeys.has(keyNeighbor)
                    ) {
                        visited.add(keyNeighbor);
                        continue;
                    }
                } else {
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
                        visited.add(keyNeighbor);
                        continue;
                    }
                }

                const isDiagMove = cur.x !== n.x && cur.y !== n.y;
                const remaining = stepsRemaining.get(key) ?? maxSteps;
                if (isDiagMove) {
                    let moveCost: number;
                    if (isSmallUnit) {
                        if (canFly) {
                            moveCost = PathHelper.DIAGONAL_MOVE_COST;
                        } else {
                            moveCost = PathHelper.DIAGONAL_MOVE_COST * aggr([n], curWeightedRoute);
                        }
                    } else if (canFly) {
                        moveCost = PathHelper.DIAGONAL_MOVE_COST;
                    } else {
                        moveCost =
                            PathHelper.DIAGONAL_MOVE_COST *
                            aggr(
                                [n, { x: n.x - 1, y: n.y }, { x: n.x - 1, y: n.y - 1 }, { x: n.x, y: n.y - 1 }],
                                curWeightedRoute,
                            );
                    }

                    if (remaining >= moveCost) {
                        // disallow sneaking between diagonals
                        if (!canFly) {
                            const xA = cur.x - 1;
                            const yA = cur.y - 1;
                            const xB = cur.x + 1;
                            const yB = cur.y + 1;
                            if (xA === n.x && yA === n.y) {
                                if (isSmallUnit) {
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
                                if (isSmallUnit) {
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
                                if (isSmallUnit) {
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
                                if (isSmallUnit) {
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

                        stepsRemaining.set(keyNeighbor, remaining - moveCost);
                        const weightedRoute = {
                            cell: { x: n.x, y: n.y },
                            route: [...curWeightedRoute.route, n],
                            weight: curWeightedRoute.weight + moveCost,
                            firstAggrMet: curWeightedRoute.firstAggrMet,
                            hasLavaCell: curWeightedRoute.hasLavaCell || el1 === ObstacleType.LAVA,
                            hasWaterCell: curWeightedRoute.hasWaterCell || el1 === ObstacleType.WATER,
                        };
                        if (this.captureRoute(knownPaths, keyNeighbor, weightedRoute)) {
                            if (!allowedToMoveThere.has(keyNeighbor)) {
                                allowedToMoveThere.add(keyNeighbor);
                                allowed.push({ x: n.x, y: n.y });
                            }
                            if (!isSmallUnit) {
                                const unitKeyLeft = ((n.x - 1) << 4) | n.y;
                                if (!allowedToMoveThere.has(unitKeyLeft)) {
                                    allowedToMoveThere.add(unitKeyLeft);
                                    allowed.push({ x: n.x - 1, y: n.y });
                                }
                                const unitKeyLeftDown = ((n.x - 1) << 4) | (n.y - 1);
                                if (!allowedToMoveThere.has(unitKeyLeftDown)) {
                                    allowedToMoveThere.add(unitKeyLeftDown);
                                    allowed.push({ x: n.x - 1, y: n.y - 1 });
                                }
                                const unitKeyDown = (n.x << 4) | (n.y - 1);
                                if (!allowedToMoveThere.has(unitKeyDown)) {
                                    allowedToMoveThere.add(unitKeyDown);
                                    allowed.push({ x: n.x, y: n.y - 1 });
                                }
                            }
                        }
                        queue.push(weightedRoute);
                        visited.add(keyNeighbor);
                    }
                } else {
                    let moveCost: number;
                    if (isSmallUnit) {
                        if (canFly) {
                            moveCost = 1;
                        } else {
                            moveCost = aggr([n], curWeightedRoute);
                        }
                    } else if (canFly) {
                        moveCost = 1;
                    } else {
                        moveCost = aggr(
                            [n, { x: n.x - 1, y: n.y }, { x: n.x - 1, y: n.y - 1 }, { x: n.x, y: n.y - 1 }],
                            curWeightedRoute,
                        );
                    }
                    if (remaining >= moveCost) {
                        stepsRemaining.set(keyNeighbor, remaining - moveCost);
                        const weightedRoute = {
                            cell: { x: n.x, y: n.y },
                            route: [...curWeightedRoute.route, n],
                            weight: curWeightedRoute.weight + moveCost,
                            firstAggrMet: curWeightedRoute.firstAggrMet,
                            hasLavaCell: curWeightedRoute.hasLavaCell || el1 === ObstacleType.LAVA,
                            hasWaterCell: curWeightedRoute.hasWaterCell || el1 === ObstacleType.WATER,
                        };

                        if (this.captureRoute(knownPaths, keyNeighbor, weightedRoute)) {
                            if (!allowedToMoveThere.has(keyNeighbor)) {
                                allowedToMoveThere.add(keyNeighbor);
                                allowed.push({ x: n.x, y: n.y });
                            }
                            if (!isSmallUnit) {
                                const unitKeyLeft = ((n.x - 1) << 4) | n.y;
                                if (!allowedToMoveThere.has(unitKeyLeft)) {
                                    allowedToMoveThere.add(unitKeyLeft);
                                    allowed.push({ x: n.x - 1, y: n.y });
                                }
                                const unitKeyLeftDown = ((n.x - 1) << 4) | (n.y - 1);
                                if (!allowedToMoveThere.has(unitKeyLeftDown)) {
                                    allowedToMoveThere.add(unitKeyLeftDown);
                                    allowed.push({ x: n.x - 1, y: n.y - 1 });
                                }
                                const unitKeyDown = (n.x << 4) | (n.y - 1);
                                if (!allowedToMoveThere.has(unitKeyDown)) {
                                    allowedToMoveThere.add(unitKeyDown);
                                    allowed.push({ x: n.x, y: n.y - 1 });
                                }
                            }
                        }
                        queue.push(weightedRoute);
                        visited.add(keyNeighbor);
                    }
                }
            }
        }

        const closestMoves = this.getNeighborCells(
            currentCell,
            new Set([(currentCell.x << 4) | currentCell.y]),
            isSmallUnit,
            false,
        );
        for (const c of closestMoves) {
            const pos = { x: c.x, y: c.y };
            const key = (c.x << 4) | c.y;
            if (isSmallUnit) {
                const me1 = matrixElementOrDefault(matrix, c.x, c.y, 0);
                if ((me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) || allowedToMoveThere.has(key)) {
                    continue;
                }

                allowed.push({ x: c.x, y: c.y });
                allowedToMoveThere.add(key);

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
            } else if (c.x < currentCell.x) {
                const unitKeyLeft = ((c.x - 1) << 4) | c.y;
                const unitKeyLeftDown = ((c.x - 1) << 4) | (c.y - 1);
                const me1 = matrixElementOrDefault(matrix, c.x - 1, c.y, 0);
                const me2 = matrixElementOrDefault(matrix, c.x - 1, c.y - 1, 0);
                if (
                    !allowedToMoveThere.has(unitKeyLeft) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !allowedToMoveThere.has(unitKeyLeftDown) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    allowedToMoveThere.add(unitKeyLeft);
                    allowed.push({ x: c.x - 1, y: c.y });
                    allowedToMoveThere.add(unitKeyLeftDown);
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
                    !allowedToMoveThere.has(unitKeyRight) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !allowedToMoveThere.has(unitKeyRightDown) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    allowedToMoveThere.add(unitKeyRight);
                    allowed.push({ x: c.x, y: c.y });
                    allowedToMoveThere.add(unitKeyRightDown);
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
                    !allowedToMoveThere.has(unitKeyDown) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !allowedToMoveThere.has(unitKeyDownLeft) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    allowedToMoveThere.add(unitKeyDown);
                    allowed.push({ x: c.x, y: c.y - 1 });
                    allowedToMoveThere.add(unitKeyDownLeft);
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
                    !allowedToMoveThere.has(unitKeyUp) &&
                    !(me1 && !(isMadeOfFire && me1 === ObstacleType.LAVA)) &&
                    !allowedToMoveThere.has(unitKeyUpLeft) &&
                    !(me2 && !(isMadeOfFire && me2 === ObstacleType.LAVA))
                ) {
                    allowedToMoveThere.add(unitKeyUp);
                    allowed.push({ x: c.x, y: c.y });
                    allowedToMoveThere.add(unitKeyUpLeft);
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
                hashes: allowedToMoveThere,
                knownPaths,
            },
            matrix,
            isSmallUnit,
            isMadeOfFire,
        );
    }
}
