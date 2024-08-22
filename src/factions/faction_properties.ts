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

export enum FactionType {
    NO_TYPE = "",
    CHAOS = "Chaos",
    MIGHT = "Might",
    NATURE = "Nature",
    LIFE = "Life",
    DEATH = "Death",
    ORDER = "Order",
}

export const AllFactions = [
    FactionType.CHAOS,
    FactionType.MIGHT,
    FactionType.NATURE,
    FactionType.LIFE,
    FactionType.DEATH,
    FactionType.ORDER,
];

export type AllFactionsType = typeof AllFactions[number];

export const ToFactionType: { [key in AllFactionsType]: FactionType } = {
    "": FactionType.NO_TYPE,
    Chaos: FactionType.CHAOS,
    Might: FactionType.MIGHT,
    Nature: FactionType.NATURE,
    Life: FactionType.LIFE,
    Death: FactionType.DEATH,
    Order: FactionType.ORDER,
};
