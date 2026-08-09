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

import type { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";

/** A live holder suppresses Hourglass globally, including for the holder's own team. */
export const TIME_DENIAL_ABILITY = "Time Denial";

/**
 * Time Denial is a board-wide card effect rather than an aura: range and ownership do not matter.
 * `hasAbilityActive` deliberately makes the check respond to Break, and stolen cards move from their
 * former owner to the thief's active ability list, so either change updates the rule immediately.
 */
export function hasActiveTimeDenial(units: Iterable<Unit>): boolean {
    for (const unit of units) {
        if (!unit.isDead() && unit.hasAbilityActive(TIME_DENIAL_ABILITY)) {
            return true;
        }
    }
    return false;
}

/** One canonical Hourglass gate for the engine, AI candidates, search, and local-model action lists. */
export function canWaitOnHourglass(
    unit: Unit,
    fightProperties: FightProperties,
    allUnits: ReadonlyMap<string, Unit>,
): boolean {
    const team = unit.getTeam();
    return (
        (team === PBTypes.TeamVals.LOWER || team === PBTypes.TeamVals.UPPER) &&
        !hasActiveTimeDenial(allUnits.values()) &&
        fightProperties.hasUnactedTeammate(team, unit.getId(), allUnits) &&
        !unit.isOnHourglass() &&
        !fightProperties.hourglassIncludes(unit.getId()) &&
        !fightProperties.hasAlreadyMadeTurn(unit.getId()) &&
        !fightProperties.hasAlreadyHourglass(unit.getId())
    );
}
