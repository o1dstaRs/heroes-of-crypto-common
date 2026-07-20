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
import type { GridType } from "../generated/protobuf/v1/types_gen";
import { isCellWithinGrid } from "./grid_math";
import { GridSettings } from "./grid_settings";
import { type XY, updateMatrixElementIfExists } from "../utils/math";
import { UPDATE_DOWN_LEFT, UPDATE_DOWN_RIGHT, UPDATE_UP_LEFT, UPDATE_UP_RIGHT } from "./grid_constants";

const OBSTACLE_SHORTS = ["B", "L", "W", "H"];
const NO_UNIT = "";

export class Grid {
    private cellsByUnitId: { [unitId: string]: XY[] } = {};
    private unitIdToTeam: { [unitId: string]: number } = {};
    private boardAggrPerTeam: Map<number, number[][]> = new Map();
    private gridType: GridType;
    private readonly boardCoord: string[][];
    private readonly gridSettings: GridSettings;
    private availableCenterStart: number;
    private availableCenterEnd: number;
    private cleanedUpCenter = false;
    // BLOCK_CENTER has two independent mountains; each is cleared to walkable when its own hit points hit 0.
    private leftMountainCleared = false;
    private rightMountainCleared = false;
    public constructor(gridSettings: GridSettings, gridType: GridType) {
        this.gridSettings = gridSettings;
        const gridSize = gridSettings.getGridSize();
        this.gridType = gridType;
        const quarter = gridSize >> 2;
        const halfQuarter = quarter >> 1;
        this.availableCenterStart = quarter + halfQuarter;
        this.availableCenterEnd = this.availableCenterStart + quarter;
        this.boardCoord = new Array(gridSize);
        const boardAggTeamLower: number[][] = new Array(gridSize);
        const boardAggTeamUpper: number[][] = new Array(gridSize);

        for (let row = 0; row < gridSize; row++) {
            this.boardCoord[row] = new Array(gridSize).fill(NO_UNIT);
            boardAggTeamLower[row] = new Array(gridSize);
            boardAggTeamUpper[row] = new Array(gridSize);
        }

        for (let row = 0; row < gridSize; row++) {
            for (let column = 0; column < gridSize; column++) {
                if (this.isCenterObstacleCell(row, column)) {
                    const obstacleType = this.getObstacleTypePerGrid();
                    if (obstacleType === ObstacleType.BLOCK) {
                        this.boardCoord[row][column] = "B";
                    } else if (obstacleType === ObstacleType.LAVA) {
                        this.boardCoord[row][column] = "L";
                    } else if (obstacleType === ObstacleType.WATER) {
                        this.boardCoord[row][column] = "W";
                    }
                }

                boardAggTeamLower[row][column] = 1;
                boardAggTeamUpper[row][column] = 1;
            }
        }

        this.boardAggrPerTeam.set(1, boardAggTeamUpper);
        this.boardAggrPerTeam.set(2, boardAggTeamLower);
    }
    public cleanupCenterObstacle(): void {
        if (
            !this.cleanedUpCenter &&
            (this.gridType === PBTypes.GridVals.LAVA_CENTER ||
                this.gridType === PBTypes.GridVals.WATER_CENTER ||
                this.gridType === PBTypes.GridVals.BLOCK_CENTER)
        ) {
            const quarter = this.gridSettings.getGridSize() >> 2;
            const halfQuarter = quarter >> 1;
            this.availableCenterStart = quarter + halfQuarter;
            this.availableCenterEnd = this.availableCenterStart + quarter;

            for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                for (let column = 0; column < this.gridSettings.getGridSize(); column++) {
                    const boardVal = this.boardCoord[row][column];
                    if (
                        // lava and water cells may be taken by certain units
                        ((this.gridType === PBTypes.GridVals.LAVA_CENTER && boardVal === "L") ||
                            (this.gridType === PBTypes.GridVals.WATER_CENTER && boardVal === "W") ||
                            this.gridType === PBTypes.GridVals.BLOCK_CENTER) &&
                        this.isCenterObstacleCell(row, column)
                    ) {
                        this.boardCoord[row][column] = NO_UNIT;
                    }
                }
            }
            this.cleanedUpCenter = true;
        }
    }
    // Clear ONE of the two BLOCK_CENTER mountains (left/right) to walkable once its hit points run out.
    // Idempotent: returns false (and does nothing) if it isn't a mountain map or that side is already gone.
    public clearMountainSide(isRight: boolean): boolean {
        if (this.gridType !== PBTypes.GridVals.BLOCK_CENTER) {
            return false;
        }
        if (isRight ? this.rightMountainCleared : this.leftMountainCleared) {
            return false;
        }
        if (isRight) {
            this.rightMountainCleared = true;
        } else {
            this.leftMountainCleared = true;
        }
        const mid = this.gridSettings.getGridSize() >> 1;
        // Mountains are separated along rows (world-X); both share the middle two columns (world-Y).
        const rows = isRight ? [mid + 1, mid + 2] : [mid - 3, mid - 2];
        const columns = [mid - 1, mid];
        for (const row of rows) {
            for (const column of columns) {
                this.boardCoord[row][column] = NO_UNIT;
            }
        }
        return true;
    }
    public refreshWithNewType(gridType: GridType): void {
        this.gridType = gridType;

        const quarter = this.gridSettings.getGridSize() >> 2;
        const halfQuarter = quarter >> 1;
        this.availableCenterStart = quarter + halfQuarter;
        this.availableCenterEnd = this.availableCenterStart + quarter;

        for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
            for (let column = 0; column < this.gridSettings.getGridSize(); column++) {
                if (this.isCenterObstacleCell(row, column)) {
                    const obstacleType = this.getObstacleTypePerGrid();
                    if (obstacleType === undefined) {
                        this.boardCoord[row][column] = NO_UNIT;
                    } else if (obstacleType === ObstacleType.BLOCK) {
                        this.boardCoord[row][column] = "B";
                    } else if (obstacleType === ObstacleType.LAVA) {
                        this.boardCoord[row][column] = "L";
                    } else if (obstacleType === ObstacleType.WATER) {
                        this.boardCoord[row][column] = "W";
                    }
                } else {
                    // Clear the PREVIOUS map's terrain marker. Only cells that are center-obstacles
                    // under the NEW type get rewritten above, so switching e.g. Lava -> Mountains
                    // used to leave stale "L" on the corridor and the rows hugging the rocks —
                    // invisible cells that blocked standing/pathing there ("can't attack the
                    // mountain from certain positions"). Unit ids are never touched.
                    const current = this.boardCoord[row][column];
                    if (current === "B" || current === "L" || current === "W") {
                        this.boardCoord[row][column] = NO_UNIT;
                    }
                }
            }
        }
        this.cleanedUpCenter = false;
        this.leftMountainCleared = false;
        this.rightMountainCleared = false;
    }
    public areCellsAdjacent(cells1: XY[], cells2: XY[]): boolean {
        if (!cells1.length || !cells2.length) {
            return false;
        }

        for (const cell1 of cells1) {
            for (const cell2 of cells2) {
                const dx = Math.abs(cell1.x - cell2.x);
                const dy = Math.abs(cell1.y - cell2.y);
                if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1) || (dx === 1 && dy === 1)) {
                    return true;
                }
            }
        }

        return false;
    }
    public cleanupAll(unitId: string, attackRange: number, isSmallUnit: boolean) {
        const occupiedCells = this.cellsByUnitId[unitId];
        const team = this.unitIdToTeam[unitId];
        // delete this.unitIdToTeam[unitId];
        if (occupiedCells) {
            if (occupiedCells.length) {
                let xMin = Number.MAX_SAFE_INTEGER;
                let xMax = Number.MIN_SAFE_INTEGER;
                let yMin = Number.MAX_SAFE_INTEGER;
                let yMax = Number.MIN_SAFE_INTEGER;

                for (const oc of occupiedCells) {
                    this.boardCoord[oc.x][oc.y] = NO_UNIT;
                    let aggrGrid: number[][] | undefined;
                    if (attackRange) {
                        aggrGrid = this.boardAggrPerTeam.get(team);
                    }

                    // Update aggregation grid for each cell that had a unit, regardless of size
                    if (isSmallUnit) {
                        this.updateAggrGrid(oc, attackRange, -1, aggrGrid);
                    }

                    // Track bounding box for large units (for potential other logic)
                    if (!isSmallUnit) {
                        xMin = Math.min(xMin, oc.x);
                        xMax = Math.max(xMax, oc.x);
                        yMin = Math.min(yMin, oc.y);
                        yMax = Math.max(yMax, oc.y);
                    }
                }

                // Still update corners for large units with proper mask if needed for other logic
                if (!isSmallUnit && xMin !== xMax && yMin !== yMax && attackRange) {
                    const aggrGrid = this.boardAggrPerTeam.get(team);
                    if (aggrGrid) {
                        this.updateAggrGrid({ x: xMin, y: yMin }, attackRange, -1, aggrGrid, UPDATE_DOWN_LEFT);
                        this.updateAggrGrid({ x: xMin, y: yMax }, attackRange, -1, aggrGrid, UPDATE_UP_LEFT);
                        this.updateAggrGrid({ x: xMax, y: yMin }, attackRange, -1, aggrGrid, UPDATE_DOWN_RIGHT);
                        this.updateAggrGrid({ x: xMax, y: yMax }, attackRange, -1, aggrGrid, UPDATE_UP_RIGHT);
                    }
                }
            }
            this.cellsByUnitId[unitId] = [];
        }
    }
    public occupyCell(
        cell: XY,
        unitId: string,
        team: number,
        attackRange: number,
        canOccupyLava: boolean,
        canOccupyWater: boolean,
    ): boolean {
        if (
            !unitId ||
            !team ||
            cell.x < 0 ||
            cell.y < 0 ||
            cell.x >= this.gridSettings.getGridSize() ||
            cell.y >= this.gridSettings.getGridSize() ||
            !isCellWithinGrid(this.gridSettings, cell)
        ) {
            return false;
        }

        this.unitIdToTeam[unitId] = team;

        // console.log(`${unitId} TRY OCCUPY ${cell.x} ${cell.y}`);

        const occupantUnitId = this.getOccupantUnitId(cell);
        if (
            occupantUnitId &&
            !((occupantUnitId === "L" && canOccupyLava) || (occupantUnitId === "W" && canOccupyWater))
        ) {
            return false;
            // console.log(`${unitId} ALREADY OCCUPIED ${cell.x} ${cell.y} by ${occupantUnitId}`);
        }

        let aggrGrid: number[][] | undefined;
        if (attackRange) {
            aggrGrid = this.boardAggrPerTeam.get(team);
        }

        const occupiedCells = this.cellsByUnitId[unitId];
        if (occupiedCells?.length && occupiedCells.length !== 1) {
            return false;
        }

        if (occupiedCells?.length) {
            for (const oc of occupiedCells) {
                if (this.boardCoord[oc.x][oc.y] === unitId) {
                    const isLava = !this.cleanedUpCenter && this.gridType === PBTypes.GridVals.LAVA_CENTER;
                    const isWater = !this.cleanedUpCenter && this.gridType === PBTypes.GridVals.WATER_CENTER;
                    if (
                        (isLava || isWater) &&
                        oc.x >= this.availableCenterStart &&
                        oc.x < this.availableCenterEnd &&
                        oc.y >= this.availableCenterStart &&
                        oc.y < this.availableCenterEnd
                    ) {
                        if (isLava) {
                            this.boardCoord[oc.x][oc.y] = "L";
                        } else if (isWater) {
                            this.boardCoord[oc.x][oc.y] = "W";
                        }
                    } else {
                        this.boardCoord[oc.x][oc.y] = NO_UNIT;
                    }
                    //                console.log(`${unitId} tick: ${currentTick} cleaning up ${occupying.x} ${occupying.y}`);

                    this.updateAggrGrid(oc, attackRange, -1, aggrGrid);
                }
            }
        }

        this.boardCoord[cell.x][cell.y] = unitId;
        this.updateAggrGrid(cell, attackRange, 1, aggrGrid);
        this.cellsByUnitId[unitId] = [cell];

        return true;
    }
    public getGridType(): GridType {
        return this.gridType;
    }
    public getSettings(): GridSettings {
        return this.gridSettings;
    }
    public canOccupyCells(cells: XY[], canOccupyLava: boolean, canOccupyWater: boolean): boolean {
        if (cells.length !== 1 && cells.length !== 4) {
            return false;
        }

        for (const c of cells) {
            const occupantUnitId = this.getOccupantUnitId(c);
            if (
                occupantUnitId &&
                (occupantUnitId !== "L" || !canOccupyLava) &&
                (occupantUnitId !== "W" || !canOccupyWater)
            ) {
                return false;
            }
        }

        return true;
    }
    public areAllCellsEmpty(cells: XY[], unitId?: string) {
        for (const c of cells) {
            if (!isCellWithinGrid(this.gridSettings, c)) {
                return false;
            }

            const occupantUnitId = this.getOccupantUnitId(c);
            if (occupantUnitId && OBSTACLE_SHORTS.includes(occupantUnitId)) {
                return false;
            }

            if (occupantUnitId && (!unitId || unitId !== occupantUnitId)) return false;
        }

        return true;
    }
    public occupyByHole(cell: XY) {
        if (isCellWithinGrid(this.gridSettings, cell)) {
            this.boardCoord[cell.x][cell.y] = "H";
        }
    }
    public getAggrMatrixByTeam(team: number): number[][] | undefined {
        return this.boardAggrPerTeam.get(team);
    }
    public getEnemyAggrMatrixByUnitId(unitId: string): number[][] | undefined {
        const team = this.unitIdToTeam[unitId];
        if (!team) {
            return undefined;
        }

        return this.getAggrMatrixByTeam(
            team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER,
        );
    }
    public occupyCells(
        cells: XY[],
        unitId: string,
        team: number,
        attackRange: number,
        canOccupyLava: boolean,
        canOccupyWater: boolean,
    ): boolean {
        if (!unitId || !team || !cells.length || !(cells.length === 1 || cells.length === 4)) {
            return false;
        }

        this.unitIdToTeam[unitId] = team;

        for (const c of cells) {
            if (!isCellWithinGrid(this.gridSettings, c)) {
                return false;
            }

            const occupantUnitId = this.getOccupantUnitId(c);
            if (
                occupantUnitId &&
                unitId !== occupantUnitId &&
                !((occupantUnitId === "L" && canOccupyLava) || (occupantUnitId === "W" && canOccupyWater))
            ) {
                return false;
            }
        }

        const occupiedCells = this.cellsByUnitId[unitId];
        if (occupiedCells?.length && occupiedCells.length !== 4) {
            return false;
        }

        let aggrGrid: number[][] | undefined;
        if (attackRange) {
            aggrGrid = this.boardAggrPerTeam.get(team);
        }

        if (occupiedCells?.length) {
            const processed: Set<number> = new Set();
            let xMin = Number.MAX_SAFE_INTEGER;
            let xMax = Number.MIN_SAFE_INTEGER;
            let yMin = Number.MAX_SAFE_INTEGER;
            let yMax = Number.MIN_SAFE_INTEGER;
            for (const oc of occupiedCells) {
                const key = (oc.x << 4) | oc.y;
                if (processed.has(key)) {
                    continue;
                }
                if (this.boardCoord[oc.x][oc.y] === unitId) {
                    const isLava = !this.cleanedUpCenter && this.gridType === PBTypes.GridVals.LAVA_CENTER;
                    const isWater = !this.cleanedUpCenter && this.gridType === PBTypes.GridVals.WATER_CENTER;
                    if (
                        (isLava || isWater) &&
                        oc.x >= this.availableCenterStart &&
                        oc.x < this.availableCenterEnd &&
                        oc.y >= this.availableCenterStart &&
                        oc.y < this.availableCenterEnd
                    ) {
                        if (isLava) {
                            this.boardCoord[oc.x][oc.y] = "L";
                        } else if (isWater) {
                            this.boardCoord[oc.x][oc.y] = "W";
                        }
                    } else {
                        this.boardCoord[oc.x][oc.y] = NO_UNIT;
                    }
                    // Update aggregation grid for each cell that is being vacated
                    if (aggrGrid && occupiedCells.length === 1) {
                        this.updateAggrGrid(oc, attackRange, -1, aggrGrid);
                    }
                }

                xMin = Math.min(xMin, oc.x);
                xMax = Math.max(xMax, oc.x);
                yMin = Math.min(yMin, oc.y);
                yMax = Math.max(yMax, oc.y);
                processed.add(key);
            }
            // Still update corners for large units with proper mask if needed for other logic
            if (xMin !== xMax && yMin !== yMax && aggrGrid) {
                this.updateAggrGrid({ x: xMin, y: yMin }, attackRange, -1, aggrGrid, UPDATE_DOWN_LEFT);
                this.updateAggrGrid({ x: xMin, y: yMax }, attackRange, -1, aggrGrid, UPDATE_UP_LEFT);
                this.updateAggrGrid({ x: xMax, y: yMin }, attackRange, -1, aggrGrid, UPDATE_DOWN_RIGHT);
                this.updateAggrGrid({ x: xMax, y: yMax }, attackRange, -1, aggrGrid, UPDATE_UP_RIGHT);
            }
        }

        const processed: Set<number> = new Set();
        let xMin = Number.MAX_SAFE_INTEGER;
        let xMax = Number.MIN_SAFE_INTEGER;
        let yMin = Number.MAX_SAFE_INTEGER;
        let yMax = Number.MIN_SAFE_INTEGER;
        for (const c of cells) {
            if (
                c.x < 0 ||
                c.y < 0 ||
                c.x >= this.gridSettings.getGridSize() ||
                c.y >= this.gridSettings.getGridSize()
            ) {
                continue;
            }

            const key = (c.x << 4) | c.y;
            if (processed.has(key)) {
                continue;
            }
            this.boardCoord[c.x][c.y] = unitId;
            // Update aggregation grid for each cell that is being occupied
            if (aggrGrid && cells.length === 1) {
                this.updateAggrGrid(c, attackRange, 1, aggrGrid);
            }
            xMin = Math.min(xMin, c.x);
            xMax = Math.max(xMax, c.x);
            yMin = Math.min(yMin, c.y);
            yMax = Math.max(yMax, c.y);
            processed.add(key);
        }
        // Still update corners for large units with proper mask if needed for other logic
        if (xMin !== xMax && yMin !== yMax && aggrGrid) {
            this.updateAggrGrid({ x: xMin, y: yMin }, attackRange, 1, aggrGrid, UPDATE_DOWN_LEFT);
            this.updateAggrGrid({ x: xMin, y: yMax }, attackRange, 1, aggrGrid, UPDATE_UP_LEFT);
            this.updateAggrGrid({ x: xMax, y: yMin }, attackRange, 1, aggrGrid, UPDATE_DOWN_RIGHT);
            this.updateAggrGrid({ x: xMax, y: yMax }, attackRange, 1, aggrGrid, UPDATE_UP_RIGHT);
        }
        this.cellsByUnitId[unitId] = cells;

        return true;
    }
    /**
     * Recompute every team's AGGRO board from the grid's CURRENT occupancy, without touching occupancy itself.
     * Mirrors the aggro-add path in occupyCells (small unit: per-cell; large unit: four corner masks). Used to
     * repair a stale aggro board (ranked skip-rebuild snapshots move units without re-stamping aggro) so the
     * AI's pathfinding sees the same enemy threat zones the server enforces — WITHOUT the ghost-occupancy risk
     * of a cleanupAll/occupyCells re-stamp (occupyCells silently drops a unit whose cells are momentarily
     * invalid). attackRangeByUnitId supplies each live unit's range (the grid does not store it).
     */
    public rebuildAggrBoards(attackRangeByUnitId: Map<string, number>): void {
        // Reset to the BASELINE (1), matching the constructor — NOT 0. A cell counts as "threatened" only when
        // its aggr exceeds 1 (path_helper: `aggrValue > 1`), and each unit's updateAggrGrid ADDS on top of the
        // baseline. Filling 0 would leave every threatened cell at 0+1=1 (== baseline → reads as UNthreatened),
        // making the client's aggro board LESS restrictive than the server's → the AI walks into threat cells
        // and the move/melee is refused (attack_not_available / invalid_move) — worse than not rebuilding.
        for (const board of this.boardAggrPerTeam.values()) {
            for (const row of board) {
                row.fill(1);
            }
        }
        for (const unitId of Object.keys(this.cellsByUnitId)) {
            const cells = this.cellsByUnitId[unitId];
            const team = this.unitIdToTeam[unitId];
            const attackRange = attackRangeByUnitId.get(unitId);
            if (!cells?.length || !team || !attackRange) {
                continue;
            }
            const aggrGrid = this.boardAggrPerTeam.get(team);
            if (!aggrGrid) {
                continue;
            }
            if (cells.length === 1) {
                this.updateAggrGrid(cells[0], attackRange, 1, aggrGrid);
                continue;
            }
            let xMin = Number.MAX_SAFE_INTEGER;
            let xMax = Number.MIN_SAFE_INTEGER;
            let yMin = Number.MAX_SAFE_INTEGER;
            let yMax = Number.MIN_SAFE_INTEGER;
            for (const c of cells) {
                xMin = Math.min(xMin, c.x);
                xMax = Math.max(xMax, c.x);
                yMin = Math.min(yMin, c.y);
                yMax = Math.max(yMax, c.y);
            }
            if (xMin !== xMax && yMin !== yMax) {
                this.updateAggrGrid({ x: xMin, y: yMin }, attackRange, 1, aggrGrid, UPDATE_DOWN_LEFT);
                this.updateAggrGrid({ x: xMin, y: yMax }, attackRange, 1, aggrGrid, UPDATE_UP_LEFT);
                this.updateAggrGrid({ x: xMax, y: yMin }, attackRange, 1, aggrGrid, UPDATE_DOWN_RIGHT);
                this.updateAggrGrid({ x: xMax, y: yMax }, attackRange, 1, aggrGrid, UPDATE_UP_RIGHT);
            }
        }
    }
    public getOccupantUnitId(cell: XY): string | undefined {
        const subArray = this.boardCoord[cell.x];
        if (!subArray) {
            return undefined;
        }
        return subArray[cell.y];
    }
    public print(unitId: string, printAggrGrids = true) {
        let msg = "";
        for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
            const rowElements: string[] = [];
            for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                const occupantUnitId = this.boardCoord[row][column];
                if (occupantUnitId === unitId) {
                    rowElements.push(".");
                } else if (occupantUnitId && occupantUnitId.length !== 1) {
                    rowElements.push("x");
                } else if (occupantUnitId) {
                    rowElements.push(occupantUnitId[0]);
                } else {
                    rowElements.push("o");
                }
            }
            msg += rowElements.join(" ");
            msg += "\n";
        }
        console.log(msg);

        if (printAggrGrids) {
            const aggrUpper = this.getAggrMatrixByTeam(1);
            if (aggrUpper) {
                msg = "";
                for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
                    const rowElements: string[] = [];
                    for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                        rowElements.push(`${aggrUpper[row][column]}`);
                    }
                    msg += rowElements.join(" ");
                    msg += "\n";
                }
                console.log(msg);
            }

            const aggrLower = this.getAggrMatrixByTeam(2);
            if (aggrLower) {
                msg = "";
                for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
                    const rowElements: string[] = [];
                    for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                        rowElements.push(`${aggrLower[row][column]}`);
                    }
                    msg += rowElements.join(" ");
                    msg += "\n";
                }
                console.log(msg);
            }
        }
    }
    /**
     * Always generates a new two-dimensional array
     */
    public getMatrix(): number[][] {
        const matrix: number[][] = new Array(this.gridSettings.getGridSize());
        for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
            const rowNumbers: number[] = new Array(this.gridSettings.getGridSize());
            for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                rowNumbers[row] = this.getOccupantNumeric(row, column);
            }
            matrix[column] = rowNumbers;
        }
        return matrix;
    }
    /**
     * Always generates a new two-dimensional array
     */
    public getMatrixNoUnits(): number[][] {
        const matrix: number[][] = new Array(this.gridSettings.getGridSize());
        for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
            const rowNumbers: number[] = new Array(this.gridSettings.getGridSize());
            for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                rowNumbers[row] = this.getOccupantNumeric(row, column, true);
            }
            matrix[column] = rowNumbers;
        }
        return matrix;
    }
    public getCenterCells(excludeInner = false): XY[] {
        // Two separate 2x2 mountains: return only the cells of the mountains still standing, so obstacle
        // attack targeting + the AI's mining only ever see intact rock. Rows are world-X (left mid-3,mid-2 /
        // right mid+1,mid+2), columns are world-Y (mid-1,mid). excludeInner has no meaning for this shape.
        if (this.gridType === PBTypes.GridVals.BLOCK_CENTER) {
            const mid = this.gridSettings.getGridSize() >> 1;
            const mountainColumns = [mid - 1, mid];
            const cells: XY[] = [];
            const pushSide = (rows: number[]): void => {
                for (const row of rows) {
                    for (const column of mountainColumns) {
                        cells.push({ x: row, y: column });
                    }
                }
            };
            if (!this.leftMountainCleared) {
                pushSide([mid - 3, mid - 2]);
            }
            if (!this.rightMountainCleared) {
                pushSide([mid + 1, mid + 2]);
            }
            return cells;
        }
        const quarter = this.gridSettings.getGridSize() >> 2;
        const halfQuarter = quarter >> 1;
        const start = quarter + halfQuarter;
        const end = start + quarter;
        const centerCells: XY[] = [];

        for (let x = start; x < end; x++) {
            for (let y = start; y < end; y++) {
                if (
                    !excludeInner ||
                    !(
                        (x === this.gridSettings.getGridSize() / 2 || x === this.gridSettings.getGridSize() / 2 - 1) &&
                        (y === this.gridSettings.getGridSize() / 2 || y === this.gridSettings.getGridSize() / 2 - 1)
                    )
                ) {
                    centerCells.push({ x, y });
                }
            }
        }

        return centerCells;
    }
    private getOccupantNumeric(row: number, column: number, excludeUnits = false): number {
        const r = this.boardCoord[row];
        if (r === undefined) {
            return 0;
        }

        if (r[column]) {
            const team = this.unitIdToTeam[r[column]];
            if (team) {
                if (excludeUnits) {
                    return 0;
                } else {
                    return team;
                }
            }
        }

        if (!this.cleanedUpCenter && this.isCenterObstacleCell(row, column)) {
            const obstacleType = this.getObstacleTypePerGrid();
            if (obstacleType !== undefined) {
                return obstacleType;
            }
        }

        if (r[column] === "H") {
            return ObstacleType.HOLE;
        }

        return 0;
    }
    private getObstacleTypePerGrid(): ObstacleType | undefined {
        if (this.gridType === PBTypes.GridVals.BLOCK_CENTER) {
            return ObstacleType.BLOCK;
        }

        if (this.gridType === PBTypes.GridVals.LAVA_CENTER) {
            return ObstacleType.LAVA;
        }

        if (this.gridType === PBTypes.GridVals.WATER_CENTER) {
            return ObstacleType.WATER;
        }

        return undefined;
    }
    // Whether (row, column) holds a center obstacle for the current grid type.
    //   BLOCK_CENTER (mountains): two 2x2 destructible mountains flanking a 2x2 walkable corridor, centered
    //     across the middle two rows — [MM][··][MM]. (To make the corridor run the other way, swap the row
    //     and column roles below.)
    //   LAVA_CENTER / WATER_CENTER: the full availableCenter square (unchanged).
    private isCenterObstacleCell(row: number, column: number): boolean {
        if (this.gridType === PBTypes.GridVals.BLOCK_CENTER) {
            // NOTE: in this grid `row` is the horizontal (world-X) axis and `column` is vertical (world-Y).
            // The two mountains sit side by side along X (rows), sharing the middle two Y columns, with a 2x2
            // walkable corridor between them (rows mid-1,mid). This matches the two sprites (offset in world-X).
            const mid = this.gridSettings.getGridSize() >> 1;
            if (column !== mid - 1 && column !== mid) {
                return false;
            }
            const isLeftMountain = row === mid - 3 || row === mid - 2; // left 2x2  (rows 5,6)
            const isRightMountain = row === mid + 1 || row === mid + 2; // right 2x2 (rows 9,10); corridor = 7,8
            // A mountain stops being an obstacle once its own hit points run out.
            if (isLeftMountain) {
                return !this.leftMountainCleared;
            }
            if (isRightMountain) {
                return !this.rightMountainCleared;
            }
            return false;
        }
        return (
            row >= this.availableCenterStart &&
            row < this.availableCenterEnd &&
            column >= this.availableCenterStart &&
            column < this.availableCenterEnd
        );
    }
    private updateAggrGrid(
        cell: XY,
        range: number,
        updBy: number,
        aggrGrid?: number[][],
        updatePositionMask?: number,
    ): void {
        if (!aggrGrid || !updBy) {
            return;
        }
        let lookRight = false;
        let lookUp = false;
        let lookLeft = false;
        let lookDown = false;

        if (
            cell.x + 1 < this.gridSettings.getGridSize() &&
            (!updatePositionMask ||
                (updatePositionMask &&
                    (updatePositionMask & UPDATE_DOWN_RIGHT || updatePositionMask & UPDATE_UP_RIGHT)))
        ) {
            lookRight = true;
        }
        if (
            cell.y + 1 < this.gridSettings.getGridSize() &&
            (!updatePositionMask ||
                (updatePositionMask && (updatePositionMask & UPDATE_UP_RIGHT || updatePositionMask & UPDATE_UP_LEFT)))
        ) {
            lookUp = true;
        }
        if (
            cell.x - 1 >= 0 &&
            (!updatePositionMask ||
                (updatePositionMask && (updatePositionMask & UPDATE_DOWN_LEFT || updatePositionMask & UPDATE_UP_LEFT)))
        ) {
            lookLeft = true;
        }
        if (
            cell.y - 1 >= 0 &&
            (!updatePositionMask ||
                (updatePositionMask &&
                    (updatePositionMask & UPDATE_DOWN_RIGHT || updatePositionMask & UPDATE_DOWN_LEFT)))
        ) {
            lookDown = true;
        }

        if (lookRight) {
            updateMatrixElementIfExists(aggrGrid, cell.y, cell.x + 1, updBy);
        }
        if (lookUp) {
            updateMatrixElementIfExists(aggrGrid, cell.y + 1, cell.x, updBy);
        }
        if (lookLeft) {
            updateMatrixElementIfExists(aggrGrid, cell.y, cell.x - 1, updBy);
        }
        if (lookDown) {
            updateMatrixElementIfExists(aggrGrid, cell.y - 1, cell.x, updBy);
        }
        if (
            lookUp &&
            lookRight &&
            (!updatePositionMask || (updatePositionMask && updatePositionMask & UPDATE_UP_RIGHT))
        ) {
            updateMatrixElementIfExists(aggrGrid, cell.y + 1, cell.x + 1, updBy);
        }
        if (
            lookUp &&
            lookLeft &&
            (!updatePositionMask || (updatePositionMask && updatePositionMask & UPDATE_UP_LEFT))
        ) {
            updateMatrixElementIfExists(aggrGrid, cell.y + 1, cell.x - 1, updBy);
        }
        if (
            lookDown &&
            lookRight &&
            (!updatePositionMask || (updatePositionMask && updatePositionMask & UPDATE_DOWN_RIGHT))
        ) {
            updateMatrixElementIfExists(aggrGrid, cell.y - 1, cell.x + 1, updBy);
        }
        if (
            lookDown &&
            lookLeft &&
            (!updatePositionMask || (updatePositionMask && updatePositionMask & UPDATE_DOWN_LEFT))
        ) {
            updateMatrixElementIfExists(aggrGrid, cell.y - 1, cell.x - 1, updBy);
        }
    }
}
