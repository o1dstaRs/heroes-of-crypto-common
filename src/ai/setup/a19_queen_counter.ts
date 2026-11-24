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

import { PBTypes } from "../../generated/protobuf/v1/types";

/**
 * a19-queen-counter-v1 (the owner: "They never pick tsar cannon, magic dragon, zena or anything to counterbalance me").
 * The owner beats the default AI with an Arachna Queen web; replays of his games with the AI's level-4 pick changed
 * found Magic Dragon decisive against it, and the matchup model lists Magic Dragon among the Queen's top counters.
 *
 * At the seat's level-4 pick, once the opposing Arachna Queen is visible to it (doctrine reveals and hidden-pick
 * collisions: only legally visible creatures may be passed), it takes Magic Dragon when Magic Dragon is offered.
 * Otherwise the earlier layers' choice stands. See docs/queen_counter_adoption.md.
 */
export const A19_QUEEN_COUNTER_POLICY = "a19-queen-counter-v1" as const;

export const A19_QUEEN_COUNTER_THREAT = PBTypes.CreatureVals.ARACHNA_QUEEN;
export const A19_QUEEN_COUNTER_ANSWER = PBTypes.CreatureVals.MAGIC_DRAGON;
const LEVEL = 4;

/** Magic Dragon when the rule fires, else undefined (keep the current choice). */
export function a19QueenCounterCreature(
    level: number,
    available: readonly number[],
    knownOpponentIds: readonly number[],
): number | undefined {
    return level === LEVEL &&
        knownOpponentIds.includes(A19_QUEEN_COUNTER_THREAT) &&
        available.includes(A19_QUEEN_COUNTER_ANSWER)
        ? A19_QUEEN_COUNTER_ANSWER
        : undefined;
}
