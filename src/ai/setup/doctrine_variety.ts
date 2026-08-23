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

import { Doctrine } from "../../doctrines/doctrine_properties";

export interface IRankedAIDoctrineChoiceContext {
    readonly matchId: string;
    readonly team: number;
    readonly aiVersion: string;
}

export const RANKED_AI_DOCTRINE_CHOICES: readonly Doctrine[] = Object.freeze([
    Doctrine.THREE_REVEALS,
    Doctrine.SEE_ALL,
    Doctrine.SEE_NONE,
]);

const stableHash = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

export const pickRankedAIDoctrine = (context: Readonly<IRankedAIDoctrineChoiceContext>): Doctrine => {
    const key = `${context.matchId}\u0000${context.team}\u0000${context.aiVersion}`;
    return RANKED_AI_DOCTRINE_CHOICES[stableHash(key) % RANKED_AI_DOCTRINE_CHOICES.length];
};
