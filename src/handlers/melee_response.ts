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
        meleeRetaliationEverPossible(attacker, target) &&
        !responseSpent &&
        target.canRespond(PBTypes.AttackVals.MELEE) &&
        !(target.hasStatusApplied("Cowardice") && target.getCumulativeHp() < attacker.getCumulativeHp())
    );
}

/**
 * Whether a melee counter between these two is possible AT ALL — only the prohibitions the blow itself
 * cannot create: a Shadow Touch attacker ("the unit's attacks are not responded"), a target that cannot
 * fight in melee, an Aggr lock pointing elsewhere, a Terrifying Gaze that forbids this attacker.
 *
 * It exists because the client cannot ask the full rule. The client infers a counter from the HP the
 * attacker lost during the action, and by then the real rule says "no" for the wrong reason: a genuine
 * counter has already spent the defender's response. Asking only the permanent half lets the client
 * refuse the impossible ones while keeping every real counter — a Fairy's Shadow Touch strike had the
 * Wolf it hit lunge back on screen, because the attacker lost hit points to something else entirely
 * (Fire Wall on the approach, an aura, a reflect) and the client billed them to the defender
 * (owner report 2026-09-19).
 */
export function meleeRetaliationEverPossible(attacker: Unit, target: Unit): boolean {
    return (
        !attacker.canSkipResponse() &&
        !target.hasAbilityActive("No Melee") &&
        (!target.getTarget() || target.getTarget() === attacker.getId()) &&
        !target.cannotAttackUnitId(attacker.getId())
    );
}
