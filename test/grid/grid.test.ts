
import { describe, test, expect, beforeEach } from "bun:test";
import { Grid } from "../../src/grid/grid";
import { GridSettings } from "../../src/grid/grid_settings";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ObstacleType } from "../../src/obstacles/obstacle_type";

describe("Grid Aggregation Matrix Tests", () => {
    let grid: Grid;
    let gridSettings: GridSettings;

    const GRID_SIZE = 16;
    const MAX_Y = 2048;
    const MIN_Y = 0;
    const MAX_X = 1024;
    const MIN_X = -1024;
    const MOVEMENT_DELTA = 5;
    const UNIT_SIZE_DELTA = 0.06;

    beforeEach(() => {
        gridSettings = new GridSettings(
            GRID_SIZE,
            MAX_Y,
            MIN_Y,
            MAX_X,
            MIN_X,
            MOVEMENT_DELTA,
            UNIT_SIZE_DELTA
        );
        grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
    });

    test("should correctly update aggregation matrix for a unit in the center", () => {
        const unitId = "unit1";
        const cell = { x: 5, y: 5 };
        const range = 4;
        const team = 1;

        grid.occupyCell(cell, unitId, team, range, false, false);

        const aggrMatrix = grid.getAggrMatrixByTeam(team);
        expect(aggrMatrix).toBeDefined();
        if (!aggrMatrix) return;

        // Check immediate neighbor (right)
        // Base value is 1. Update adds 1. Result should be 2.
        expect(aggrMatrix[5][6]).toBe(2);
    });

    test("should correctly update aggregation matrix for a unit near the edge (Edge Case Bug)", () => {
        const unitId = "unitEdge";
        const cell = { x: 14, y: 5 }; // Near right edge (grid size 16)
        const range = 4; // Range extends beyond edge
        const team = 1;

        grid.occupyCell(cell, unitId, team, range, false, false);

        const aggrMatrix = grid.getAggrMatrixByTeam(team);
        expect(aggrMatrix).toBeDefined();
        if (!aggrMatrix) return;

        // Check right neighbor (15, 5)
        // Before fix, this would be 1 (skipped). After fix, should be 2.
        expect(aggrMatrix[15][5]).toBe(2);
    });

    test("should not double-count aggregation for large units (Large Unit Bug)", () => {
        const unitId = "largeUnit";
        // Place at (2,2). 2x2 means (2,2), (3,2), (2,3), (3,3).
        const cells = [
            { x: 2, y: 2 },
            { x: 3, y: 2 },
            { x: 2, y: 3 },
            { x: 3, y: 3 }
        ];
        const range = 4;
        const team = 1;

        grid.occupyCells(cells, unitId, team, range, false, false);

        const aggrMatrix = grid.getAggrMatrixByTeam(team);
        expect(aggrMatrix).toBeDefined();
        if (!aggrMatrix) return;

        // Internal cells should NOT be updated (remain at base value 1)
        expect(aggrMatrix[2][2]).toBe(1);
        expect(aggrMatrix[3][2]).toBe(1);
        expect(aggrMatrix[2][3]).toBe(1);
        expect(aggrMatrix[3][3]).toBe(1);

        // External neighbor (left of 2,2 -> 1,2) should be updated
        expect(aggrMatrix[1][2]).toBe(2);
    });

    test("should clean and refresh center obstacles for every center grid type", () => {
        const blockGrid = new Grid(gridSettings, PBTypes.GridVals.BLOCK_CENTER);
        const waterGrid = new Grid(gridSettings, PBTypes.GridVals.WATER_CENTER);
        const lavaGrid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
        const centerCell = blockGrid.getCenterCells()[0];

        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("B");
        expect(waterGrid.getOccupantUnitId(centerCell)).toBe("W");
        expect(lavaGrid.getOccupantUnitId(centerCell)).toBe("L");

        blockGrid.cleanupCenterObstacle();
        waterGrid.cleanupCenterObstacle();
        lavaGrid.cleanupCenterObstacle();
        blockGrid.cleanupCenterObstacle();

        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("");
        expect(waterGrid.getOccupantUnitId(centerCell)).toBe("");
        expect(lavaGrid.getOccupantUnitId(centerCell)).toBe("");

        blockGrid.refreshWithNewType(PBTypes.GridVals.WATER_CENTER);
        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("W");
        blockGrid.refreshWithNewType(PBTypes.GridVals.LAVA_CENTER);
        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("L");
        blockGrid.refreshWithNewType(PBTypes.GridVals.BLOCK_CENTER);
        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("B");
        blockGrid.refreshWithNewType(PBTypes.GridVals.NORMAL);
        expect(blockGrid.getOccupantUnitId(centerCell)).toBe("");
    });

    test("should expose matrices, holes, occupancy checks, and printable board state", () => {
        const printable = new Grid(gridSettings, PBTypes.GridVals.BLOCK_CENTER);
        const centerCell = printable.getCenterCells()[0];
        const logs: string[] = [];
        const originalLog = console.log;

        printable.occupyCell({ x: 1, y: 1 }, "unit1", PBTypes.TeamVals.UPPER, 2, false, false);
        printable.occupyCell({ x: 2, y: 2 }, "unit2", PBTypes.TeamVals.LOWER, 1, false, false);
        printable.occupyByHole({ x: 0, y: 0 });
        printable.occupyByHole({ x: -1, y: -1 });

        expect(printable.areAllCellsEmpty([{ x: 1, y: 1 }], "unit1")).toBe(true);
        expect(printable.areAllCellsEmpty([{ x: 1, y: 1 }])).toBe(false);
        expect(printable.areAllCellsEmpty([{ x: 0, y: 0 }])).toBe(false);
        expect(printable.canOccupyCells([{ x: 1, y: 1 }, { x: 2, y: 2 }], false, false)).toBe(false);
        expect(printable.canOccupyCells([centerCell], false, false)).toBe(false);

        const matrix = printable.getMatrix();
        const matrixNoUnits = printable.getMatrixNoUnits();

        expect(matrix[0][0]).toBe(ObstacleType.HOLE);
        expect(matrix[1][1]).toBe(PBTypes.TeamVals.UPPER);
        expect(matrix[2][2]).toBe(PBTypes.TeamVals.LOWER);
        expect(matrix[centerCell.y][centerCell.x]).toBe(ObstacleType.BLOCK);
        expect(matrixNoUnits[1][1]).toBe(0);
        expect(matrixNoUnits[2][2]).toBe(0);
        expect(matrixNoUnits[0][0]).toBe(ObstacleType.HOLE);

        console.log = (message?: unknown) => {
            logs.push(String(message));
        };

        try {
            printable.print("unit1");
        } finally {
            console.log = originalLog;
        }

        expect(logs).toHaveLength(3);
        expect(logs[0]).toContain(".");
        expect(logs[0]).toContain("x");
        expect(logs[0]).toContain("H");
    });
});
