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

import type { IA19ClosingPickInput } from "../../../src/ai/setup/a19_closing_pick";

/**
 * The level-4 picks of the six human games of confirmation CPC (docs/closing_pick_adoption.md), as the AI seat met them
 * in the production re-draft: offers, the earlier layers' choice, its five creatures, the opposing creatures it could
 * see and the game's bans. `expected` is the pick the research hook made there with counter model v1 (A19_COUNTER_MODEL=v1); `expectedV2` the
 * pick with model v2, the default since profile v37 (undefined: v2 keeps the earlier layers' choice).
 */
export const CPC_GAMES: (IA19ClosingPickInput & { game: string; expected: number; expectedV2: number | undefined })[] =
    [
        {
            game: "1a785955",
            seed: "1a785955-68f1-478a-8e0d-d633728c4701:1",
            level: 4,
            available: [19, 29, 39, 40, 41, 57],
            current: 40,
            ownCreatureIds: [2, 22, 4, 14, 37],
            knownOpponentCreatureIds: [33, 47, 26, 52, 28],
            bannedCreatureIds: [49, 21, 46, 23, 48, 11, 51, 25, 34, 53, 16, 5, 18, 7, 27, 42, 9, 43, 10, 20],
            expected: 57,
            expectedV2: 57,
        },
        {
            game: "9208870e",
            seed: "9208870e-10ae-4432-92d3-728c41f483a1:1",
            level: 4,
            available: [20, 39, 41, 42, 43, 44],
            current: 42,
            ownCreatureIds: [21, 2, 16, 51, 37],
            knownOpponentCreatureIds: [47, 22, 34, 27],
            bannedCreatureIds: [31, 1, 23, 46, 13, 48, 14, 4, 6, 52, 15, 36, 28, 18, 30, 40, 19, 29, 9, 10],
            expected: 44,
            expectedV2: 44,
        },
        {
            game: "76f5f3d5",
            seed: "76f5f3d5-7326-4949-8b28-4dfb96f10794:2",
            level: 4,
            available: [19, 39, 40, 41, 42, 43],
            current: 40,
            ownCreatureIds: [48, 22, 14, 6, 38],
            knownOpponentCreatureIds: [3, 26, 4, 29],
            bannedCreatureIds: [31, 49, 1, 32, 23, 46, 25, 53, 34, 55, 51, 24, 54, 27, 8, 9, 20, 10, 57, 44],
            expected: 19,
            expectedV2: 43,
        },
        {
            game: "909e7898",
            seed: "909e7898-ba42-4f8e-a9f4-14ea8bdd8e1d:1",
            level: 4,
            available: [9, 19, 39, 40, 42, 44],
            current: 40,
            ownCreatureIds: [32, 22, 51, 14, 37],
            knownOpponentCreatureIds: [1, 36, 8],
            bannedCreatureIds: [46, 48, 47, 2, 21, 49, 4, 55, 35, 6, 25, 53, 28, 38, 18, 41, 43, 29, 10, 57],
            expected: 44,
            expectedV2: 44,
        },
        {
            game: "3fd7b865",
            seed: "3fd7b865-579d-4c28-b2cd-cd18c153cc01:1",
            level: 4,
            available: [9, 19, 20, 29, 42, 57],
            current: 42,
            ownCreatureIds: [13, 23, 15, 25, 38],
            knownOpponentCreatureIds: [31, 50],
            bannedCreatureIds: [32, 22, 49, 2, 12, 3, 51, 16, 4, 35, 6, 52, 56, 17, 8, 44, 10, 41, 43, 40],
            expected: 19,
            expectedV2: undefined,
        },
        {
            game: "974d9737",
            seed: "974d9737-0f79-4f5e-965c-66e1216c1e39:1",
            level: 4,
            available: [10, 19, 29, 40, 41, 57],
            current: 40,
            ownCreatureIds: [21, 22, 35, 14, 37],
            knownOpponentCreatureIds: [1, 24],
            bannedCreatureIds: [47, 3, 32, 48, 2, 23, 5, 15, 25, 4, 52, 51, 17, 18, 38, 44, 9, 20, 43, 42],
            expected: 19,
            expectedV2: 10,
        },
    ];
