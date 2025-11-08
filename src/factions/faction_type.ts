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
import { FactionType } from "@heroesofcrypto/common/src/generated/protobuf/v1/types_gen";
import { FactionVals } from "@heroesofcrypto/common/src/generated/protobuf/v1/types_pb";

export const AllFactions = [
    FactionVals.NO_FACTION,
    FactionVals.CHAOS,
    FactionVals.MIGHT,
    FactionVals.NATURE,
    FactionVals.LIFE,
    FactionVals.DEATH,
    FactionVals.ORDER,
];

export const ToFactionType: { [factionTypeValue: string]: FactionType } = {
    "": FactionVals.NO_FACTION,
    NO_FACTION: FactionVals.NO_FACTION,
    Chaos: FactionVals.CHAOS,
    Might: FactionVals.MIGHT,
    Nature: FactionVals.NATURE,
    Life: FactionVals.LIFE,
    Death: FactionVals.DEATH,
    Order: FactionVals.ORDER,
};
