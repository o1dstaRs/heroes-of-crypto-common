
import { describe, test, expect, beforeEach } from "bun:test";
import { PathHelper } from "../../src/grid/path_helper";
import { GridSettings } from "../../src/grid/grid_settings";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMovePath } from "../../src/grid/path_definitions";

describe("PathHelper Tests", () => {
    let pathHelper: PathHelper;
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
        pathHelper = new PathHelper(gridSettings);
    });

    describe("getNeighborCells", () => {
        test("should return all 8 neighbors for a center cell (small unit)", () => {
            const centerCell = { x: 5, y: 5 };
            const neighbors = pathHelper.getNeighborCells(centerCell, new Set(), true, true);
            // 4 line + 4 diag = 8
            expect(neighbors.length).toBe(8);

            // Verify some neighbors
            expect(neighbors).toContainEqual({ x: 5, y: 6 }); // Up
            expect(neighbors).toContainEqual({ x: 5, y: 4 }); // Down
            expect(neighbors).toContainEqual({ x: 4, y: 5 }); // Left
            expect(neighbors).toContainEqual({ x: 6, y: 5 }); // Right
            expect(neighbors).toContainEqual({ x: 6, y: 6 }); // Up-Right
        });

        test("should return fewer neighbors for a corner cell (0,0)", () => {
            const cornerCell = { x: 0, y: 0 };
            const neighbors = pathHelper.getNeighborCells(cornerCell, new Set(), true, true);

            // Should have Up (0,1), Right (1,0), Up-Right (1,1)
            // Left and Down are out of bounds.
            expect(neighbors.length).toBe(3);
            expect(neighbors).toContainEqual({ x: 0, y: 1 });
            expect(neighbors).toContainEqual({ x: 1, y: 0 });
            expect(neighbors).toContainEqual({ x: 1, y: 1 });
        });

        test("should respect visited set", () => {
            const centerCell = { x: 5, y: 5 };
            const visited = new Set<number>();
            // Mark (5,6) as visited (Up)
            visited.add((5 << 4) | 6);

            const neighbors = pathHelper.getNeighborCells(centerCell, visited, true, true);
            expect(neighbors).not.toContainEqual({ x: 5, y: 6 });
            expect(neighbors.length).toBe(7);
        });
    });

    describe("filterUnallowedDestinations", () => {
        test("should filter out lava and water for normal units", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            // Set (5,5) to LAVA
            matrix[5][5] = ObstacleType.LAVA;
            // Set (5,6) to WATER
            matrix[6][5] = ObstacleType.WATER;

            const movePath: IMovePath = {
                cells: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 4 }],
                knownPaths: new Map(),
                hashes: new Set()
            };
            // Add known paths for small unit check
            movePath.knownPaths.set((5 << 4) | 5, []);
            movePath.knownPaths.set((5 << 4) | 6, []);
            movePath.knownPaths.set((4 << 4) | 4, []);

            // @ts-ignore - Accessing private method via any cast or public wrapper if available.
            // Since it's private, we might need to test via a public method that uses it, 
            // but for unit testing internal logic, we can cast to any.
            const filtered = (pathHelper as any).filterUnallowedDestinations(movePath, matrix, true, false);

            expect(filtered.cells).toContainEqual({ x: 4, y: 4 });
            expect(filtered.cells).not.toContainEqual({ x: 5, y: 5 }); // Lava
            expect(filtered.cells).not.toContainEqual({ x: 5, y: 6 }); // Water
        });

        test("should allow lava for fire units", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            matrix[5][5] = ObstacleType.LAVA;

            const movePath: IMovePath = {
                cells: [{ x: 5, y: 5 }],
                knownPaths: new Map(),
                hashes: new Set()
            };
            movePath.knownPaths.set((5 << 4) | 5, []);

            const filtered = (pathHelper as any).filterUnallowedDestinations(movePath, matrix, true, true); // isMadeOfFire = true

            expect(filtered.cells).toContainEqual({ x: 5, y: 5 });
        });
    });

    describe("calculateClosestAttackFrom", () => {
        test("should find closest attack cell", () => {
            // Grid X range: [-1024, 1024]. Cell size: 128.
            // Cell (0,0) corresponds to X in [-1024, -896], Y in [0, 128].
            // Use center of cell (0,0): X = -1024 + 64 = -960, Y = 64.
            const mousePos = { x: -960, y: 64 };

            const attackerCells = [{ x: 2, y: 2 }];
            const targetCells = [{ x: 0, y: 0 }];
            const attackCells = [{ x: 1, y: 1 }, { x: 5, y: 5 }]; // (1,1) is closer to (0,0)

            const result = pathHelper.calculateClosestAttackFrom(
                mousePos,
                attackCells,
                attackerCells,
                targetCells,
                true, // unitIsSmall
                2, // range
                true, // targetIsSmall
                PBTypes.TeamVals.LOWER,
                new Map()
            );

            expect(result).toEqual({ x: 1, y: 1 });
        });
    });

    describe("getMovePath", () => {
        test("should find path around an obstacle (another unit)", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            // Place obstacle at (5,5) - representing another unit (Team 1)
            matrix[5][5] = 1;

            const startCell = { x: 5, y: 4 };
            const maxSteps = 5;

            // PathHelper.getMovePath(currentCell, matrix, maxSteps, aggrBoard?, canFly?, isSmallUnit?, isMadeOfFire?)
            const movePath = pathHelper.getMovePath(startCell, matrix, maxSteps, undefined, false, true, false);

            // Should find cells around (5,5)
            // (5,5) should NOT be in the allowed cells
            const cellKeys = new Set(movePath.cells.map(c => (c.x << 4) | c.y));
            expect(cellKeys.has((5 << 4) | 5)).toBe(false);

            // Should be able to reach (5,6) by going around
            // e.g., (4,4)->(4,5)->(4,6)->(5,6) or similar
            expect(cellKeys.has((5 << 4) | 6)).toBe(true);
        });

        test("should be blocked if surrounded by obstacles", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            const startCell = { x: 5, y: 5 };

            // Surround (5,5) with obstacles
            const neighbors = pathHelper.getNeighborCells(startCell, new Set(), true, true);
            for (const n of neighbors) {
                matrix[n.y][n.x] = 1; // Block all neighbors (matrix[y][x])
            }

            const movePath = pathHelper.getMovePath(startCell, matrix, 5);

            // Only the start cell should be in the path (or empty depending on implementation, 
            // but usually start cell is part of the structure or it returns reachable cells)
            // Looking at implementation: 
            // const visited: Set<number> = new Set([(currentCell.x << 4) | currentCell.y]);
            // ...
            // return { cells: allowed, ... }
            // If no neighbors are valid, allowed might be empty or just start if logic adds it.
            // Let's check if it found any *other* cells.

            expect(movePath.cells.length).toBe(0);
        });

        test("should respect max steps", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            const startCell = { x: 0, y: 0 };
            const maxSteps = 2;

            const movePath = pathHelper.getMovePath(startCell, matrix, maxSteps);

            // With 2 steps, can reach distance 2.
            // (0,0) -> (0,1) -> (0,2)
            // (0,0) -> (0,3) should NOT be reachable

            const cellKeys = new Set(movePath.cells.map(c => (c.x << 4) | c.y));
            expect(cellKeys.has((0 << 4) | 2)).toBe(true);
            expect(cellKeys.has((0 << 4) | 3)).toBe(false);
        });

        test("large unit should be blocked by single cell obstacle", () => {
            const matrix = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
            // Large unit occupies (2,2), (3,2), (2,3), (3,3)
            // Moving Right to (3,2) means occupying (3,2), (4,2), (3,3), (4,3)
            // If we block (4,2), it shouldn't be able to move right.

            matrix[2][4] = 1; // Block (4,2) -> matrix[y=2][x=4]
            matrix[4][4] = 1; // Block (4,4) -> matrix[y=4][x=4]

            const startCell = { x: 3, y: 3 }; // Top-Right corner of large unit at (2,2)
            // Note: PathHelper expects the "main" cell. For large units, logic usually uses Top-Right?
            // Let's check getMovePath implementation:
            // if (!isSmallUnit) { currentCellKeys = [ ... (x-1, y), (x, y-1), (x-1, y-1), (x, y) ] }
            // So if input is (3,3), it checks (2,3), (3,2), (2,2), (3,3). Correct.

            const movePath = pathHelper.getMovePath(startCell, matrix, 5, undefined, false, false); // isSmallUnit = false

            // Should NOT be able to move to (4,3) (which corresponds to unit at (3,2))
            // because (4,2) is blocked and (4,4) is blocked (preventing access from top).

            const cellKeys = new Set(movePath.cells.map(c => (c.x << 4) | c.y));
            expect(cellKeys.has((4 << 4) | 3)).toBe(false);
        });
    });
});
