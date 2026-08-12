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

import { Perk } from "../../perks/perk_properties";

export interface IRankedAIPerkChoiceContext {
    readonly matchId: string;
    readonly team: number;
    readonly aiVersion: string;
}

export const RANKED_AI_PERK_CHOICES: readonly Perk[] = Object.freeze([Perk.THREE_REVEALS, Perk.SEE_ALL, Perk.SEE_NONE]);

const stableHash = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

export const pickRankedAIPerk = (context: Readonly<IRankedAIPerkChoiceContext>): Perk => {
    const key = `${context.matchId}\u0000${context.team}\u0000${context.aiVersion}`;
    return RANKED_AI_PERK_CHOICES[stableHash(key) % RANKED_AI_PERK_CHOICES.length];
};
