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

/**
 * Exact first melee-response gate shared by the engine and tactical policies.
 *
 * `Unit.canRespond()` intentionally covers only disabling effects and attack-type abilities. The complete
 * engine rule also includes the two retaliation-state sources used by server/headless and ranked snapshots,
 * skip-response attackers, Cowardice, Aggr's forced target, and Terrifying Gaze's forbidden target.
 */
export function canUnitRespondToMelee(
    attacker: Unit,
    target: Unit,
    fightProperties?: Pick<FightProperties, "hasAlreadyRepliedAttack">,
): boolean {
    const responseSpent = target.getResponded() || fightProperties?.hasAlreadyRepliedAttack(target.getId()) === true;
    return (
        !attacker.canSkipResponse() &&
        !responseSpent &&
        target.canRespond(PBTypes.AttackVals.MELEE) &&
        !target.hasAbilityActive("No Melee") &&
        !(target.hasStatusApplied("Cowardice") && target.getCumulativeHp() < attacker.getCumulativeHp()) &&
        (!target.getTarget() || target.getTarget() === attacker.getId()) &&
        !target.cannotAttackUnitId(attacker.getId())
    );
}
