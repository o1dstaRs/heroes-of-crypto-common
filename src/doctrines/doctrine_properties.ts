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

// Doctrines are the FIRST pick-phase choice (Stage 0), made simultaneously by both players. A doctrine is a
// "scouting doctrine" trade-off: it sets BOTH how much of the opponent's draft you can see AND your upgrade
// (augment) point budget. More vision costs points. The chosen doctrine id is the wire value sent via
// DoctrineRequest and stored on the pick document (doctrineLower/doctrineUpper).

import { MAX_AUGMENT_POINTS } from "../constants";

export enum Doctrine {
    NO_DOCTRINE = 0,
    THREE_REVEALS = 1, // auto-reveal the opponent's picks in 3 random slots -> 6 upgrade points
    SEE_ALL = 2, // see all of the opponent's picks -> 5 upgrade points
    SEE_NONE = 3, // see nothing of the opponent's picks -> 7 upgrade points
}

// How the server seeds the player's scouting (slotsSeen) when the doctrine is committed.
export type DoctrineRevealMode = "random3" | "all" | "none";

// Number of opponent slots auto-revealed by the THREE_REVEALS doctrine.
export const DOCTRINE_RANDOM_REVEAL_SLOTS = 3;

export interface DoctrineProperties {
    readonly id: Doctrine;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly upgradePoints: number;
    readonly revealMode: DoctrineRevealMode;
    /**
     * Key into game/core image_imports. The art ships as doctrine_scout / doctrine_spymaster /
     * doctrine_blind_fury — named after the doctrine, not after its reveal mechanic — so this is derived
     * from the NAME rather than the slug. It used to be built as `perk_<slug>_256`, which matched no
     * asset that has ever existed: every key it produced resolved to nothing.
     */
    readonly imageKey: string;
}

const doctrine = (
    id: Doctrine,
    slug: string,
    name: string,
    description: string,
    upgradePoints: number,
    revealMode: DoctrineRevealMode,
): DoctrineProperties => ({
    id,
    slug,
    name,
    description,
    upgradePoints,
    revealMode,
    imageKey: `doctrine_${name.toLowerCase().replace(/\s+/g, "_")}`,
});

export const DOCTRINES: { [key in Doctrine]: DoctrineProperties } = {
    [Doctrine.NO_DOCTRINE]: doctrine(
        Doctrine.NO_DOCTRINE,
        "none",
        "None",
        "No doctrine selected.",
        MAX_AUGMENT_POINTS,
        "none",
    ),
    [Doctrine.THREE_REVEALS]: doctrine(
        Doctrine.THREE_REVEALS,
        "three_reveals",
        "Scout",
        "Reveal the opponent's picks in 3 random slots. Grants 6 upgrade points.",
        6,
        "random3",
    ),
    [Doctrine.SEE_ALL]: doctrine(
        Doctrine.SEE_ALL,
        "see_all",
        "Spymaster",
        "See all of the opponent's picks during the draft. Grants 5 upgrade points.",
        5,
        "all",
    ),
    [Doctrine.SEE_NONE]: doctrine(
        Doctrine.SEE_NONE,
        "see_none",
        "Blind Fury",
        "See none of the opponent's picks. Grants 7 upgrade points.",
        7,
        "none",
    ),
};

export const getDoctrineProperties = (doctrineId: Doctrine): DoctrineProperties =>
    DOCTRINES[doctrineId] ?? DOCTRINES[Doctrine.NO_DOCTRINE];

// Upgrade (augment) point budget granted by a doctrine. Falls back to the default budget for NO_DOCTRINE.
export const getUpgradePoints = (doctrineId: Doctrine): number => getDoctrineProperties(doctrineId).upgradePoints;

export const getDoctrineRevealMode = (doctrineId: Doctrine): DoctrineRevealMode =>
    getDoctrineProperties(doctrineId).revealMode;

// Selectable doctrines (excludes the NO_DOCTRINE sentinel), in display order.
export const DOCTRINE_LIST: DoctrineProperties[] = [
    DOCTRINES[Doctrine.THREE_REVEALS],
    DOCTRINES[Doctrine.SEE_ALL],
    DOCTRINES[Doctrine.SEE_NONE],
];

export const ToDoctrine: { [key: string]: Doctrine } = {
    "": Doctrine.NO_DOCTRINE,
    "0": Doctrine.NO_DOCTRINE,
    "1": Doctrine.THREE_REVEALS,
    "2": Doctrine.SEE_ALL,
    "3": Doctrine.SEE_NONE,
};
