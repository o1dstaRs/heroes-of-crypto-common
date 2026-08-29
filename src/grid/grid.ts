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
import { getCellsAroundFootprint, isCellWithinGrid } from "./grid_math";
import { GridSettings } from "./grid_settings";
import { type XY, updateMatrixElementIfExists } from "../utils/math";
import { UPDATE_DOWN_LEFT, UPDATE_DOWN_RIGHT, UPDATE_UP_LEFT, UPDATE_UP_RIGHT } from "./grid_constants";

const OBSTACLE_SHORTS = ["B", "L", "W", "H"];
const NO_UNIT = "";

export class Grid {
    private cellsByUnitId: { [unitId: string]: XY[] } = {};
    private unitIdToTeam: { [unitId: string]: number } = {};
    private boardAggrPerTeam: Map<number, number[][]> = new Map();
    /**
     * Canonical numeric board for the current grid epoch. getMatrix retains its historical fresh-result
     * contract by cloning this value; every operation that can change occupancy or terrain invalidates it.
     * Battle rollback treats it as derived state and clears it after restoring the authoritative fields.
     */
    private matrixCache: number[][] | undefined;
    private gridType: GridType;
    private readonly boardCoord: string[][];
    private readonly gridSettings: GridSettings;
    private availableCenterStart: number;
    private availableCenterEnd: number;
    private cleanedUpCenter = false;
    // BLOCK_CENTER has two independent mountains; each is cleared to walkable when its own hit points hit 0.
    private leftMountainCleared = false;
    private rightMountainCleared = false;
    /**
     * SCATTERED MOUNTAINS — the newer BLOCK_CENTER shape ("barrels" on the Cemetery board): single-cell
     * mountains scattered over the neutral band instead of two fixed 2x2 blocks.
     *
     * It is still OPT-IN at this layer, but the reasoning has moved on: the layout is no longer "random" in
     * the irreproducible sense that once confined it to the sandbox. `scatteredMountainsForSeed` makes both
     * the cells AND the barrel count (rolled 9-12) a pure function of the game id, so the server, both
     * seats, replays and the headless sim reach the same board independently — which is exactly what let
     * RANKED start playing it. Ranked installs it from the game id, the sandbox from its fight id, and the
     * sim for side-oriented boards.
     *
     * What still does NOT travel is the layout itself; a snapshot carries only which stones still stand
     * (play.proto 58/59). The client must therefore install the SERVER's stone list rather than filtering
     * its own derivation by it — see planScatteredMountainSync — or a version skew in the rolled count
     * turns the difference into invisible walls.
     *
     * Empty layout = classic behaviour, unchanged down to the last cell.
     */
    private scatteredMountainLayout: XY[] = [];
    /** Packed keys of the scattered mountains still standing; a cleared one is simply dropped from here. */
    private scatteredMountainsStanding: Set<number> = new Set();
    public constructor(gridSettings: GridSettings, gridType: GridType) {
        this.gridSettings = gridSettings;
        const gridSize = gridSettings.getGridSize();
        this.gridType = gridType;
        const quarter = gridSize >> 2;
        const halfQuarter = quarter >> 1;
        this.availableCenterStart = quarter + halfQuarter;
        this.availableCenterEnd = this.availableCenterStart + quarter;
        this.boardCoord = new Array(gridSize);
        const boardAggTeamLeft: number[][] = new Array(gridSize);
        const boardAggTeamRight: number[][] = new Array(gridSize);

        for (let row = 0; row < gridSize; row++) {
            this.boardCoord[row] = new Array(gridSize).fill(NO_UNIT);
            boardAggTeamLeft[row] = new Array(gridSize);
            boardAggTeamRight[row] = new Array(gridSize);
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

                boardAggTeamLeft[row][column] = 1;
                boardAggTeamRight[row][column] = 1;
            }
        }

        this.boardAggrPerTeam.set(1, boardAggTeamRight);
        this.boardAggrPerTeam.set(2, boardAggTeamLeft);
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
            this.invalidateMatrixCache();
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
        this.invalidateMatrixCache();
        return true;
    }
    /** Packed cell key. GRID_SIZE is 16, so a byte per axis is ample and the key stays a small int. */
    private static packCell(x: number, y: number): number {
        return (x << 8) | y;
    }
    /**
     * Install a scattered-mountain layout, replacing whatever BLOCK_CENTER shape was in force. Pass an empty
     * array to go back to the classic two 2x2 mountains.
     *
     * Writes the obstacles straight into the board, so it is safe to call after construction (which is when
     * the caller knows the layout) and again on every re-roll.
     */
    public setScatteredMountains(cells: XY[]): void {
        // Clearing must ALWAYS be honoured. The caller switches the board type first and installs the new
        // layout second, so a type guard here would swallow the "wipe it" call on the way out of the
        // mountain board — leaving stones standing on lava and their cells still impassable.
        if (cells.length && this.gridType !== PBTypes.GridVals.BLOCK_CENTER) {
            return;
        }
        // Lift the previous layout off the board first, or a re-roll would leave the old rock behind.
        for (const cell of this.scatteredMountainLayout) {
            if (this.boardCoord[cell.x]?.[cell.y] === "B") {
                this.boardCoord[cell.x][cell.y] = NO_UNIT;
            }
        }
        this.scatteredMountainLayout = cells.map((c) => ({ x: c.x, y: c.y }));
        this.scatteredMountainsStanding = new Set(this.scatteredMountainLayout.map((c) => Grid.packCell(c.x, c.y)));
        if (cells.length) {
            // The classic pair and a scattered layout must never be on the board at once.
            this.leftMountainCleared = true;
            this.rightMountainCleared = true;
            const mid = this.gridSettings.getGridSize() >> 1;
            for (const row of [mid - 3, mid - 2, mid + 1, mid + 2]) {
                for (const column of [mid - 1, mid]) {
                    if (this.boardCoord[row]?.[column] === "B") {
                        this.boardCoord[row][column] = NO_UNIT;
                    }
                }
            }
        }
        for (const cell of this.scatteredMountainLayout) {
            this.boardCoord[cell.x][cell.y] = "B";
        }
        this.invalidateMatrixCache();
    }
    public hasScatteredMountains(): boolean {
        return this.scatteredMountainLayout.length > 0;
    }
    /** The mountains still standing, in layout order — the renderer keeps art per cell, so order matters. */
    public getScatteredMountainsStanding(): XY[] {
        return this.scatteredMountainLayout.filter((c) => this.scatteredMountainsStanding.has(Grid.packCell(c.x, c.y)));
    }
    /**
     * Knock out one scattered mountain. Idempotent, and returns false when there was nothing there, so the
     * caller can tell a real destruction from a stray hit.
     */
    public clearScatteredMountainAt(x: number, y: number): boolean {
        const key = Grid.packCell(x, y);
        if (!this.scatteredMountainsStanding.delete(key)) {
            return false;
        }
        if (this.boardCoord[x]?.[y] === "B") {
            this.boardCoord[x][y] = NO_UNIT;
        }
        this.invalidateMatrixCache();
        return true;
    }
    /** Destroy every standing scattered mountain contained in the supplied cells. */
    public clearScatteredMountainsInCells(cells: readonly XY[]): XY[] {
        const cleared: XY[] = [];
        for (const cell of cells) {
            if (this.clearScatteredMountainAt(cell.x, cell.y)) {
                cleared.push({ x: cell.x, y: cell.y });
            }
        }
        return cleared;
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
        this.invalidateMatrixCache();
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
    /**
     * The cells this grid currently has REGISTERED for a unit (empty if none). Read-only view for
     * occupancy audits: ranked's snapshot reconcile compares this against the authoritative cells to
     * self-heal a stale registration (a missed move -> phantom reachability the server then rejects).
     */
    public getRegisteredCells(unitId: string): XY[] {
        return this.cellsByUnitId[unitId] ? this.cellsByUnitId[unitId].map((cell) => ({ ...cell })) : [];
    }
    public cleanupAll(unitId: string, attackRange: number, _isSmallUnit: boolean) {
        this.invalidateMatrixCache();
        const occupiedCells = this.cellsByUnitId[unitId];
        const team = this.unitIdToTeam[unitId];
        // delete this.unitIdToTeam[unitId];
        if (occupiedCells) {
            if (occupiedCells.length) {
                let aggrGrid: number[][] | undefined;
                if (attackRange) {
                    aggrGrid = this.boardAggrPerTeam.get(team);
                }

                for (const oc of occupiedCells) {
                    this.boardCoord[oc.x][oc.y] = NO_UNIT;
                }

                this.stampAggrRing(occupiedCells, -1, aggrGrid);
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
        this.invalidateMatrixCache();

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
    /**
     * Whether one complete footprint may occupy ordinary cells plus traversable terrain. Any non-empty set of
     * cells is judged — a 1x1, a 2x2 and every WxH rectangle in between — because the shape is the caller's
     * business and this only answers "is that ground free". Existing units may overlap part of their current
     * footprint while sliding one cell; `ownUnitId` permits only that overlap. Callers placing a new unit omit
     * it, so another stack's cells remain blocked.
     */
    public canOccupyCells(cells: XY[], canOccupyLava: boolean, canOccupyWater: boolean, ownUnitId?: string): boolean {
        if (!cells.length) {
            return false;
        }

        for (const c of cells) {
            if (!isCellWithinGrid(this.gridSettings, c)) {
                return false;
            }
            const occupantUnitId = this.getOccupantUnitId(c);
            if (
                occupantUnitId &&
                occupantUnitId !== ownUnitId &&
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
            this.invalidateMatrixCache();
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
            team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
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
        if (!unitId || !team || !cells.length) {
            return false;
        }

        this.unitIdToTeam[unitId] = team;
        this.invalidateMatrixCache();

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
        // A unit may only be re-registered over a footprint of the same SIZE as the one it already holds (or
        // over nothing at all); anything else means the caller grew or shrank a body without cleanupAll and
        // would strand cells nobody owns. The legacy gate spelled that as "the previous registration must be
        // a 2x2", because occupyCells was the large-unit path and small stacks came through occupyCell — a
        // single-cell registration was therefore frozen here, and ranked's occupancy reconcile leans on that
        // refusal to detect a half-applied move. Keep the legacy reading verbatim for the two shipped sizes
        // and apply the size rule only to the rectangles that never went through the old path.
        if (occupiedCells?.length) {
            const isLegacyFootprint = cells.length === 1 || cells.length === 4;
            if (isLegacyFootprint ? occupiedCells.length !== 4 : occupiedCells.length !== cells.length) {
                return false;
            }
        }

        let aggrGrid: number[][] | undefined;
        if (attackRange) {
            aggrGrid = this.boardAggrPerTeam.get(team);
        }

        if (occupiedCells?.length) {
            const processed: Set<number> = new Set();
            const vacatedCells: XY[] = [];
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
                }

                vacatedCells.push(oc);
                processed.add(key);
            }
            // The ring comes off the whole body it is leaving, exactly as it went on. A cell the unit no
            // longer owns still counts towards that body: the mask form this replaces also worked off the
            // registration rather than the board, and a unit half-overwritten by someone else must not leave
            // a slice of permanent phantom threat behind.
            this.stampAggrRing(vacatedCells, -1, aggrGrid);
        }

        const processed: Set<number> = new Set();
        const occupiedNow: XY[] = [];
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
            occupiedNow.push(c);
            processed.add(key);
        }
        this.stampAggrRing(occupiedNow, 1, aggrGrid);
        // A copy, not the caller's array. The registry is read back by cleanupAll and by the aggro rebuild
        // long after the write, and a caller that reuses or mutates its cell buffer would silently rewrite
        // where the grid thinks a unit stands.
        this.cellsByUnitId[unitId] = cells.map((cell) => ({ x: cell.x, y: cell.y }));

        return true;
    }
    /**
     * Recompute every team's AGGRO board from the grid's CURRENT occupancy, without touching occupancy itself.
     * Mirrors the aggro-add path in occupyCells — one ring around each unit's whole footprint. Used to
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
            this.stampAggrRing(cells, 1, aggrGrid);
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
            const aggrRight = this.getAggrMatrixByTeam(1);
            if (aggrRight) {
                msg = "";
                for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
                    const rowElements: string[] = [];
                    for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                        rowElements.push(`${aggrRight[row][column]}`);
                    }
                    msg += rowElements.join(" ");
                    msg += "\n";
                }
                console.log(msg);
            }

            const aggrLeft = this.getAggrMatrixByTeam(2);
            if (aggrLeft) {
                msg = "";
                for (let column = this.gridSettings.getGridSize() - 1; column >= 0; column--) {
                    const rowElements: string[] = [];
                    for (let row = 0; row < this.gridSettings.getGridSize(); row++) {
                        rowElements.push(`${aggrLeft[row][column]}`);
                    }
                    msg += rowElements.join(" ");
                    msg += "\n";
                }
                console.log(msg);
            }
        }
    }
    /** @internal Clear the derived numeric board after authoritative state is restored out-of-band. */
    public invalidateMatrixCache(): void {
        this.matrixCache = undefined;
    }
    /**
     * Always returns a fresh two-dimensional array. Offline simulations may opt into retaining one canonical
     * matrix for the current grid epoch because a single AI decision reads the unchanged board several times.
     * Live matches keep the historical rebuild path so a benchmark-only speedup cannot alter wall-clock search.
     */
    public getMatrix(): number[][] {
        const cacheEnabled = process.env.SIM_GRID_MATRIX_CACHE === "1" || process.env.GRID_MATRIX_CACHE_VERIFY === "1";
        if (!cacheEnabled) {
            // Keep the production path structurally identical to the historical implementation: the live A19
            // deadline is wall-clock bounded, so even an otherwise-safe loop optimization can alter decisions.
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
        const gridSize = this.gridSettings.getGridSize();
        if (!this.matrixCache) {
            const canonical: number[][] = new Array(gridSize);
            for (let column = gridSize - 1; column >= 0; column--) {
                const rowNumbers: number[] = new Array(gridSize);
                for (let row = 0; row < gridSize; row++) {
                    rowNumbers[row] = this.getOccupantNumeric(row, column);
                }
                canonical[column] = rowNumbers;
            }
            this.matrixCache = canonical;
        }

        const matrix: number[][] = new Array(gridSize);
        for (let column = gridSize - 1; column >= 0; column--) {
            matrix[column] = this.matrixCache[column].slice();
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
            if (this.scatteredMountainLayout.length) {
                return this.getScatteredMountainsStanding();
            }
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
            // Scattered layout, when one is installed, is the whole answer: the cells are arbitrary, so
            // there is no geometry to fall back on.
            if (this.scatteredMountainLayout.length) {
                return this.scatteredMountainsStanding.has(Grid.packCell(row, column));
            }
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
    /**
     * Add (or lift) a unit's zone of control: `updBy` on every cell touching its whole FOOTPRINT, once each.
     *
     * One ring around the whole body is the only rule that survives a non-square footprint. What it replaces
     * was three different rules — an unmasked per-cell ring for a 1x1 and four masked corner rings for a
     * 2x2, the latter fired only when the body was wider than one cell in BOTH axes. A 1x2 or 2x1 satisfies
     * neither branch, so a rectangular unit used to stamp NO aggro at all and pathfinding read the ground
     * around it as unthreatened. For the two shipped shapes this is the same board to the cell: the four
     * corner masks of a 2x2 emit exactly its 12-cell ring, and an unmasked call emits exactly the 8-cell
     * ring of a 1x1 (test/grid/footprint_occupancy.test.ts pins both against the mask machinery itself).
     *
     * The aggro board is indexed [x][y] while updateMatrixElementIfExists is `(m, x, y, v) => m[y][x] += v`,
     * so the arguments go in swapped — as they always have.
     */
    private stampAggrRing(footprint: readonly XY[], updBy: number, aggrGrid?: number[][]): void {
        if (!aggrGrid || !updBy || !footprint.length) {
            return;
        }

        for (const ringCell of getCellsAroundFootprint(this.gridSettings, footprint)) {
            updateMatrixElementIfExists(aggrGrid, ringCell.y, ringCell.x, updBy);
        }
    }
    /**
     * The single-cell zone of control, optionally narrowed to one quadrant of the ring by an UPDATE_* mask.
     * Occupancy no longer needs the masked form now that stampAggrRing lays a whole footprint's ring down in
     * one pass, but occupyCell — which is single-cell by definition — still stamps through here.
     */
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
