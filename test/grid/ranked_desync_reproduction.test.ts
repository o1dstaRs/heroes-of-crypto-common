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
import { PathHelper } from "../../src/grid/path_helper";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";

// Miniature reproduction of the RANKED reject class. The aggro (threat) board a unit pathfinds against decides
// which cells it can reach: a route that enters an enemy zone-of-control cell (aggr > 1) STOPS there
// (firstAggrMet), so cells reachable only THROUGH threat drop out. In ranked, the client sometimes pathfinds
// on a STALE threat board (baseline, less restrictive than the server's) and therefore plans a move the
// server's AUTHORITATIVE board blocks -> attack_not_available / invalid_move. This test pins the mechanism:
// the SAME query yields a strictly SMALLER, and always subset, reachable set under the authoritative threat
// board. A client that decides on the authoritative board (the fix) proposes only server-legal moves.
describe("ranked desync reproduction: stale vs authoritative aggro board", () => {
    it("authoritative threat strictly restricts reachability (and only restricts — never expands)", () => {
        const gridSettings = simulationGridSettings();
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const pathHelper = new PathHelper(gridSettings);

        // Enemy (team 2) sits centrally and threatens its 8 neighbours (zone of control).
        grid.occupyCell({ x: 8, y: 8 }, "enemy", 2, 1, false, false);
        grid.rebuildAggrBoards(new Map([["enemy", 1]]));

        const matrix = grid.getMatrix();
        const authoritativeThreat = grid.getAggrMatrixByTeam(2);
        expect(authoritativeThreat).toBeDefined();

        // Team-1 mover approaching from below with enough steps to cross to the far side of the enemy.
        const mover = { x: 8, y: 4 };
        const steps = 7;

        // STALE client board: no/baseline threat -> the AI treats the crossing as free.
        const staleReach = pathHelper.getMovePath(mover, matrix, steps, undefined, false, true, false).knownPaths;
        // AUTHORITATIVE (server) board: the enemy's zone of control is stamped.
        const authReach = pathHelper.getMovePath(
            mover,
            matrix,
            steps,
            authoritativeThreat,
            false,
            true,
            false,
        ).knownPaths;

        expect(staleReach.size).toBeGreaterThan(0);
        expect(authReach.size).toBeGreaterThan(0);

        // Threat only ever RESTRICTS: authoritative reachable set is a subset of the stale one...
        for (const key of authReach.keys()) {
            expect(staleReach.has(key)).toBe(true);
        }
        // ...and strictly smaller — the stale board reaches cells the server would block (the reject in miniature).
        expect(authReach.size).toBeLessThan(staleReach.size);
    });
});
