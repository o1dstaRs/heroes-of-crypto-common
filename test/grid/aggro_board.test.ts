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
import { describe, expect, it } from "bun:test";
import { Grid } from "../../src/grid/grid";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";

// rebuildAggrBoards is the seam that makes the RANKED client's threat map mirror the server's before the AI
// pathfinds. It is the fix for the dominant attack_not_available reject, and it carries a subtle invariant
// that was a real bug: the board must reset to BASELINE 1 (not 0), because path_helper treats a cell as
// threatened only when aggr > 1 and each unit ADDS on top of the baseline. Filling 0 would leave every
// threatened cell at 0+1=1 (== baseline → reads UNthreatened), making the client less restrictive than the
// server and re-introducing the reject. These tests pin that behaviour.
describe("aggro board (rebuildAggrBoards)", () => {
    const TEAM = 1;

    it("resets to baseline 1 and stamps threat > 1 around a unit (guards the fill(1) baseline)", () => {
        const grid = new Grid(simulationGridSettings(), PBTypes.GridVals.NORMAL);
        expect(grid.occupyCell({ x: 8, y: 8 }, "u1", TEAM, 1, false, false)).toBe(true);
        grid.rebuildAggrBoards(new Map([["u1", 1]]));

        const board = grid.getAggrMatrixByTeam(TEAM);
        expect(board).toBeDefined();

        // Baseline: a far corner is EXACTLY 1 — not 0 (the reverted fill(0) bug), not > 1.
        expect(board![0][0]).toBe(1);

        // Threat: at least one cell exceeds the baseline (path_helper: aggrValue > 1 == threatened).
        let threatened = 0;
        let maxVal = 0;
        for (const row of board!) {
            for (const v of row) {
                if (v > 1) threatened += 1;
                if (v > maxVal) maxVal = v;
            }
        }
        expect(threatened).toBeGreaterThan(0);
        expect(maxVal).toBeGreaterThan(1);
    });

    it("clears stale threat on rebuild — a unit dropped from the range map leaves the board at baseline", () => {
        const grid = new Grid(simulationGridSettings(), PBTypes.GridVals.NORMAL);
        grid.occupyCell({ x: 8, y: 8 }, "u1", TEAM, 3, false, false);
        grid.rebuildAggrBoards(new Map([["u1", 3]]));

        // Re-stamp with NO ranges (unit contributes nothing) → every cell must return to baseline 1.
        grid.rebuildAggrBoards(new Map());
        const board = grid.getAggrMatrixByTeam(TEAM)!;
        let nonBaseline = 0;
        for (const row of board) {
            for (const v of row) {
                if (v !== 1) nonBaseline += 1;
            }
        }
        expect(nonBaseline).toBe(0);
    });

    it("threatens exactly the zone-of-control ring (8 neighbours) around a small unit", () => {
        const grid = new Grid(simulationGridSettings(), PBTypes.GridVals.NORMAL);
        grid.occupyCell({ x: 8, y: 8 }, "u1", TEAM, 1, false, false);
        grid.rebuildAggrBoards(new Map([["u1", 1]]));

        const board = grid.getAggrMatrixByTeam(TEAM)!;
        const threatened: Array<[number, number]> = [];
        for (let i = 0; i < board.length; i += 1) {
            for (let j = 0; j < board[i].length; j += 1) {
                if (board[i][j] > 1) threatened.push([i, j]);
            }
        }
        // The aggro (zone-of-control) footprint of a small unit is exactly the 8 Chebyshev-adjacent cells.
        expect(threatened).toHaveLength(8);
        for (const [i, j] of threatened) {
            expect(Math.max(Math.abs(i - 8), Math.abs(j - 8))).toBe(1);
        }
    });
});
