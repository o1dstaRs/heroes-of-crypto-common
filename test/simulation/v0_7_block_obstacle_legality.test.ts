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
import { playRankedDraftGame, rankedDraftCurrentIncumbent } from "../../src/simulation/ranked_draft_eval";

describe("v0.7 BLOCK obstacle legality", () => {
    test("ranked game 105 does not mine while Griffin has a live forced target", () => {
        const incumbent = rankedDraftCurrentIncumbent();
        const opponent = { ...incumbent, id: "same-policy-control", prior: 1 };
        const record = playRankedDraftGame(
            incumbent,
            opponent,
            {
                gamesPerOpponent: 1_600,
                baseSeed: 0x60000000,
                concurrency: 1,
                mapTypes: [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER],
                maxLaps: 60,
            },
            105,
            0,
            { matchRunner: runMatch },
        );

        expect(record.battleSeed).toBe(3_250_246_845);
        expect(record.gridType).toBe(PBTypes.GridVals.BLOCK_CENTER);
        expect(record.rejectedCandidate + record.rejectedOpponent).toBe(0);
    });
});
