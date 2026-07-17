/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { runMatch } from "../../src/simulation/battle_engine";
import {
    defaultRankedDraftPool,
    playRankedDraftGame,
    rankedDraftCurrentIncumbent,
} from "../../src/simulation/ranked_draft_eval";

const CASES = [
    { opponentIndex: 3, game: 775, battleSeed: 2_256_355_110 },
    { opponentIndex: 2, game: 1_114, battleSeed: 4_209_506_949 },
    { opponentIndex: 2, game: 776, battleSeed: 3_257_484_925 },
    { opponentIndex: 1, game: 986, battleSeed: 3_835_495_073 },
] as const;

describe("v0.7 LAVA_CENTER melee landing legality", () => {
    test.each(CASES)("ranked opponent $opponentIndex game $game has no rejected hazard landing", (scenario) => {
        const candidate = rankedDraftCurrentIncumbent();
        const opponents = defaultRankedDraftPool();
        const record = playRankedDraftGame(
            candidate,
            opponents[scenario.opponentIndex],
            {
                gamesPerOpponent: 1_600,
                baseSeed: 0x60000000,
                concurrency: 1,
                mapTypes: [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER],
                maxLaps: 60,
            },
            scenario.game,
            scenario.opponentIndex,
            { matchRunner: runMatch },
        );

        expect(record.battleSeed).toBe(scenario.battleSeed);
        expect(record.gridType).toBe(PBTypes.GridVals.LAVA_CENTER);
        expect(record.rejectedCandidate + record.rejectedOpponent).toBe(0);
    });
});
