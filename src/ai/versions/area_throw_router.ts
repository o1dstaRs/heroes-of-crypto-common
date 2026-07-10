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

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext } from "../ai_strategy";
import {
    enumerateCandidates,
    type ICandidateSet,
    type IEnumeratedCandidate,
    type IEnumerateOptions,
} from "../candidates";

type CandidateEnumerator = (
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options?: IEnumerateOptions,
) => ICandidateSet;

type ImmediateAttack = Extract<
    GameAction,
    { type: "melee_attack" | "range_attack" | "area_throw_attack" | "obstacle_attack" | "cast_spell" }
>;

const LOWER = PBTypes.TeamVals.LOWER;

function areaThrowGateOn(unit: Unit): boolean {
    const gate = process.env.V06_AREA_THROW;
    if (gate === "on" || gate === "both") {
        return true;
    }
    if (gate === "green" || gate === "red") {
        return gate === (unit.getTeam() === LOWER ? "green" : "red");
    }
    return false;
}

const sameCell = (a: XY | undefined, b: XY | undefined): boolean =>
    a === undefined || b === undefined ? a === b : a.x === b.x && a.y === b.y;

/** Return the turn's immediate combat action, ignoring a preceding attack-type selection or move. */
function immediateAttack(actions: readonly GameAction[]): ImmediateAttack | undefined {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
        const action = actions[i];
        if (
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "obstacle_attack" ||
            action.type === "cast_spell"
        ) {
            return action;
        }
    }
    return undefined;
}

/** Find the F4 estimate corresponding to the incumbent attack. */
function incumbentDamage(attack: ImmediateAttack, candidates: readonly IEnumeratedCandidate[]): number | undefined {
    // F4 does not yet price spell effects or obstacle HP. Preserve those decisions rather than comparing
    // them to a misleading zero-damage estimate. The universal caster router also intentionally runs first.
    if (attack.type === "cast_spell" || attack.type === "obstacle_attack") {
        return undefined;
    }

    const matches = candidates.filter((candidate) => {
        const candidateAttack = immediateAttack(candidate.actions);
        if (!candidateAttack || candidateAttack.type !== attack.type) {
            return false;
        }
        switch (attack.type) {
            case "melee_attack":
                return candidateAttack.type === "melee_attack" && candidateAttack.targetId === attack.targetId;
            case "range_attack":
                return (
                    candidateAttack.type === "range_attack" &&
                    candidateAttack.targetId === attack.targetId &&
                    // v0.2+ supplies bounded aim intent. For a legacy aim-less action, matching every aim at
                    // the same target and taking the maximum is conservative: Area Throw must beat even that.
                    (attack.aimCell === undefined || sameCell(candidateAttack.aimCell, attack.aimCell)) &&
                    (attack.aimSide === undefined || candidateAttack.aimSide === attack.aimSide)
                );
            case "area_throw_attack":
                return (
                    candidateAttack.type === "area_throw_attack" &&
                    sameCell(candidateAttack.targetCell, attack.targetCell)
                );
        }
    });
    if (!matches.length) {
        return undefined;
    }
    return Math.max(...matches.map((candidate) => candidate.features.expectedDamage));
}

/**
 * Q1/M2: opt-in Gargantuan Area Throw router.
 *
 * F4's Area Throw candidates already project the aimed cell onto the first trajectory interceptor and
 * score the resulting 3x3 splash, with enemy effective damage positive and friendly fire negative. This
 * router deliberately consumes that engine-mirrored score instead of reimplementing geometry here.
 *
 * `V06_AREA_THROW=on` is required until the LiveTwin A/B clears. `green`/`red` scope the router to one seat
 * for paired A/Bs and `both` aliases `on`. Gate-off returns the exact incumbent array without enumerating,
 * preserving frozen v0.6 fight behaviour. A strict comparison also preserves the incumbent on ties or whenever
 * F4 cannot price the incumbent combat action safely.
 */
export function routeAreaThrow(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    enumerate: CandidateEnumerator = enumerateCandidates,
): GameAction[] {
    if (!areaThrowGateOn(unit) || !unit.hasAbilityActive("Area Throw")) {
        return incumbent;
    }

    const enumerated = enumerate(unit, context, incumbent);
    const forcedTarget = context.unitsHolder.getAllUnits().get(unit.getTarget());
    const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;
    let best: IEnumeratedCandidate | undefined;
    for (const candidate of enumerated.candidates) {
        if (
            candidate.kind === "area_throw" &&
            (!forcedTargetId || candidate.targetId === forcedTargetId) &&
            (!best || candidate.features.expectedDamage > best.features.expectedDamage)
        ) {
            best = candidate;
        }
    }
    if (!best) {
        return incumbent;
    }

    const attack = immediateAttack(incumbent);
    let incumbentExpectedDamage = 0;
    if (attack) {
        // Candidate 0 is intentionally the feature-light anchor, and the equivalent generated attack is
        // deduped against it. Re-enumerate with a neutral anchor to recover the incumbent attack's F4 score.
        const neutral: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
        const estimatedDamage = incumbentDamage(attack, enumerate(unit, context, neutral).candidates);
        if (estimatedDamage === undefined) {
            return incumbent;
        }
        incumbentExpectedDamage = estimatedDamage;
    }

    return best.features.expectedDamage > incumbentExpectedDamage ? best.actions : incumbent;
}
