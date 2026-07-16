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

import {
    buildSeatAbConfigs,
    summarizeSeatAb,
    type ISeatAbGameResult,
    type ISeatAbOptions,
} from "../../src/simulation/seat_ab_battery";

const options = (overrides: Partial<ISeatAbOptions> = {}): ISeatAbOptions => ({
    candidateVersion: "v0.7s",
    opponentVersion: "v0.7",
    pairs: 3,
    baseSeed: 87050710,
    draftSource: "heuristic",
    ...overrides,
});

describe("seat_ab_battery pair construction", () => {
    it("emits two games per pair with identical armies/setup and only the version strings swapped", () => {
        const configs = buildSeatAbConfigs(options());
        expect(configs).toHaveLength(6);
        for (let pair = 0; pair < 3; pair += 1) {
            const a = configs[2 * pair];
            const b = configs[2 * pair + 1];
            expect(a.greenVersion).toBe("v0.7s");
            expect(a.redVersion).toBe("v0.7");
            expect(b.greenVersion).toBe("v0.7");
            expect(b.redVersion).toBe("v0.7s");
            expect(b.roster).toEqual(a.roster);
            expect(b.redRoster).toEqual(a.redRoster);
            expect(b.seed).toBe(a.seed);
            expect(b.greenPerk).toBe(a.greenPerk);
            expect(b.redPerk).toBe(a.redPerk);
            expect(b.greenAugments).toEqual(a.greenAugments);
            expect(b.redAugments).toEqual(a.redAugments);
        }
        // Distinct pairs draw distinct boards (the census's per-pair seed stride).
        expect(configs[0].seed).not.toBe(configs[2].seed);
    });

    it("is deterministic for a given seed and diverges for another", () => {
        const first = buildSeatAbConfigs(options());
        const again = buildSeatAbConfigs(options());
        expect(again).toEqual(first);
        const other = buildSeatAbConfigs(options({ baseSeed: 87060710 }));
        expect(other.map((c) => c.seed)).not.toEqual(first.map((c) => c.seed));
    });

    it("builds round-1 boards with per-seat artifacts/synergies attached", () => {
        const configs = buildSeatAbConfigs(options({ draftSource: "round1", pairs: 2 }));
        expect(configs).toHaveLength(4);
        for (const config of configs) {
            expect(config.roster.length).toBeGreaterThan(0);
            expect(config.redRoster!.length).toBeGreaterThan(0);
            expect(config.greenPerk).toBeDefined();
            expect(config.greenSynergies).toBeDefined();
            expect(config.redSynergies).toBeDefined();
        }
    });
});

describe("seat_ab_battery attribution", () => {
    it("credits the candidate on even-game green wins and odd-game red wins only", () => {
        const results: ISeatAbGameResult[] = [
            { game: 0, winner: "green", laps: 5, endReason: "elimination" }, // candidate (green) win
            { game: 1, winner: "red", laps: 5, endReason: "elimination" }, // candidate (red) win
            { game: 2, winner: "red", laps: 6, endReason: "elimination" }, // opponent win
            { game: 3, winner: "green", laps: 6, endReason: "elimination" }, // opponent win
            { game: 4, winner: "draw", laps: 60, endReason: "turn_cap" },
        ];
        const summary = summarizeSeatAb(results);
        expect(summary.games).toBe(5);
        expect(summary.decisiveGames).toBe(4);
        expect(summary.candidateWins).toBe(2);
        expect(summary.opponentWins).toBe(2);
        expect(summary.draws).toBe(1);
        expect(summary.candidateGreenWins).toBe(1);
        expect(summary.candidateRedWins).toBe(1);
        expect(summary.candidateWinRate).toBe(0.5);
        expect(summary.deltaFromParityPp).toBe(0);
        expect(summary.endReasons).toEqual({ elimination: 4, turn_cap: 1 });
    });

    it("keeps a draws-only run at parity instead of dividing by zero", () => {
        const summary = summarizeSeatAb([{ game: 0, winner: "draw", laps: 60, endReason: "turn_cap" }]);
        expect(summary.candidateWinRate).toBe(0.5);
        expect(summary.decisiveGames).toBe(0);
    });
});
