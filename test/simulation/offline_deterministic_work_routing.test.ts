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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import { playGame, type ITournamentOptions } from "../../src/simulation/tournament";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";

const runTournamentGame = (offlineDeterministicWork: boolean | undefined): Record<string, unknown> => {
    const auditPath = join(
        mkdtempSync(join(tmpdir(), offlineDeterministicWork ? "tournament-offline-work-" : "tournament-live-work-")),
        "audit.jsonl",
    );
    const environment = {
        ...buildV08A13SearchEnvironment(),
        SEARCH_AUDIT: auditPath,
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        // These effectively-zero bounds make the live-path assertion independent of host speed.
        SEARCH_DECISION_DEADLINE_MS: "0.000001",
        SEARCH_CIRCUIT_BREAKER_MS: "0.00001",
    };
    const options: ITournamentOptions = {
        versionA: "v0.8",
        versionB: "v0.8",
        games: 2,
        baseSeed: 204,
        maxLaps: 1,
        ...(offlineDeterministicWork === undefined ? {} : { searchOfflineDeterministicWork: offlineDeterministicWork }),
    };

    withScopedAIEnvironment(environment, () => playGame(options, 0));
    return JSON.parse(readFileSync(auditPath, "utf8").trim()) as Record<string, unknown>;
};

describe("offline deterministic search-work routing", () => {
    it("keeps omitted tournament work live-bounded and requires an explicit offline opt-in", () => {
        expect(runTournamentGame(undefined)).toMatchObject({
            offlineDeterministicWork: false,
            circuitOpened: true,
        });
        expect(runTournamentGame(true)).toMatchObject({
            offlineDeterministicWork: true,
            deadlineFallbacks: 0,
            circuitOpened: false,
            circuitSkipped: 0,
        });
    });
});
