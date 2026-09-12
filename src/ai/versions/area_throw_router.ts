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
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
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

const LEFT = PBTypes.TeamVals.LEFT;

function areaThrowGateOn(unit: Unit): boolean {
    const gate = process.env.V06_AREA_THROW;
    if (gate === "on" || gate === "both") {
        return true;
    }
    if (gate === "green" || gate === "red") {
        return gate === (unit.getTeam() === LEFT ? "green" : "red");
    }
    return false;
}

const sameCell = (a: XY | undefined, b: XY | undefined): boolean =>
    a === undefined || b === undefined ? a === b : a.x === b.x && a.y === b.y;

/**
 * Optional version scoping for a seat-scoped A/B (the rider-EV router's `V06_RIDER_EV_VERSIONS` pattern,
 * itself modelled on the wait-scorer's `V07_WAIT_VERSIONS`). With `V06_AREA_THROW_VERSIONS` unset, every
 * caller is in scope (the router's original team-color-only gate semantics, unchanged). When set to a
 * comma list (e.g. "v0.7s"), only strategies whose version string is listed route — so a v0.7s-vs-v0.7
 * mirror can carry the router on ONE seat while the other stays the frozen incumbent, isolating the
 * router's own effect (W16's seat-scoped battery credits the pattern; see rider_ev_router.ts).
 */
function areaThrowScopeAllows(version: string | undefined): boolean {
    const raw = process.env.V06_AREA_THROW_VERSIONS;
    if (!raw) {
        return true;
    }
    if (!version) {
        return false;
    }
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .includes(version);
}

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
 * for paired A/Bs and `both` aliases `on`. `V06_AREA_THROW_VERSIONS` additionally scopes by AI strategy
 * version (see `areaThrowScopeAllows`), for a seat-scoped mirror A/B (e.g. v0.7s vs v0.7) independent of
 * team color. Gate-off returns the exact incumbent array without enumerating, preserving frozen v0.6 fight
 * behaviour. A strict comparison also preserves the incumbent on ties or whenever F4 cannot price the
 * incumbent combat action safely.
 */
export function routeAreaThrow(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    enumerate: CandidateEnumerator = enumerateCandidates,
    version?: string,
): GameAction[] {
    if (!areaThrowGateOn(unit) || !areaThrowScopeAllows(version) || !unit.hasAbilityActive("Area Throw")) {
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

/**
 * Give EVERY registered version access to Area Throw.
 *
 * Gargantuan's whole identity is the splash, and most versions could never fire one: only the shared
 * candidate generator builds an `area_throw_attack`, and v0.1-v0.5 never enumerate candidates at all.
 * routeAreaThrow is already version-agnostic — it enumerates, takes the best splash, and swaps only when
 * it strictly beats what the version decided — so the capability belongs here, at the one point every
 * profile passes through, rather than copied into six strategy files.
 *
 * It stays behind the SAME env gate it always had, off by default. v0.1-v0.5 are frozen research
 * baselines (v0.6's fight is byte-for-byte v0.5, CEM trains against a frozen v0.4, and seeded traces are
 * pinned to their exact decisions) — silently changing what they do would invalidate every A/B the AI
 * program rests on. Gate off, routeAreaThrow returns the incumbent array before enumerating, so those
 * versions stay bit-identical; gate on (V06_AREA_THROW), they can all finally use the ability.
 *
 * Re-routing a version that already routes internally (v0.6) is harmless: the comparison is strict, so a
 * decision that is already the best splash is preserved rather than swapped for itself.
 *
 * SCOPE: this reaches the LIVE bot only — ranked_profile.createAIStrategy, which the server's
 * ranked_ai_profile.ts calls. The simulation resolves through ai/index.ts getAIStrategy instead, whose
 * registry is deliberately identity- and byte-pinned (rollout drivers compare strategy identity, and a
 * profile test pins the registry bytes), so wrapping it there breaks that research infrastructure —
 * measured, 12 failures. The consequence is real and worth stating: this behaviour cannot currently be
 * A/B'd by the sim harness, so flipping its gate on for live play needs evidence from somewhere else.
 */
export const withAreaThrow = (strategy: IAIStrategy): IAIStrategy => {
    const decideTurn = strategy.decideTurn.bind(strategy);
    return new Proxy(strategy, {
        get(target, property, receiver) {
            if (property !== "decideTurn") {
                return Reflect.get(target, property, receiver);
            }
            return (unit: Unit, context: IDecisionContext): GameAction[] =>
                routeAreaThrow(unit, context, decideTurn(unit, context), undefined, target.version);
        },
    });
};
