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
import type { Unit } from "../units/unit";
import { assertNoLegacySeatEnv, seatEnvName } from "./seat_env";

export const A19_WILD_REGEN_GIFT_ID = "a19-wild-regen-gift-v1";
/** Per-seat switch (seat_env): on unless `A19_WILD_REGEN_GIFT_<LEFT|RIGHT>=0`. */
export const A19_WILD_REGEN_GIFT_ENV = "A19_WILD_REGEN_GIFT";

export function a19WildRegenGiftEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_WILD_REGEN_GIFT_ENV);
    return process.env[seatEnvName(A19_WILD_REGEN_GIFT_ENV, team)] !== "0";
}

/**
 * Wild Regeneration is a one-way gift (Holy Cross lets the caster keep a copy) of "refill the top creature to its max HP
 * at the start of its turn", so it is worth about one creature's max HP per turn. Giving it to a creature with no more HP
 * than the caster's loses value: the owner saw a Troll give it to a one-creature Fairy split instead of the Griffin. It is
 * worth giving only to an ally that does not already regenerate and whose creatures have more max HP than the caster's,
 * or to any such ally while Holy Cross keeps the caster's card. See docs/wild_regen_gift_adoption.md.
 */
export function isWorthwhileWildRegenerationGift(caster: Unit, ally: Unit): boolean {
    if (ally.hasAbilityActive("Wild Regeneration")) {
        return false;
    }
    return caster.hasBuffActive("Holy Cross") || ally.getMaxHp() > caster.getMaxHp();
}
