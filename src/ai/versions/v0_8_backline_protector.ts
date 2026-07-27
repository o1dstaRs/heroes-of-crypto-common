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
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureInfo } from "../setup/creature_score";
import { decisionPathSource, type IReadonlyWeightedRoute } from "../decision_path_catalog";
import { otherTeam } from "./v0_1";
import { enemyFieldsSplashAoe, layoutRevealPlacement, opponentCreatureIdsForPlacement } from "./v0_7_placement_reveal";
import { v08DominantFinishState } from "./v0_8_dominant_finish";

export type V08BacklineProtectorKind = "abomination" | "arachna_queen";

export interface IV08BacklineProtectorIntent {
    readonly kind: V08BacklineProtectorKind;
    readonly ward: Unit;
    readonly wards: readonly Unit[];
    readonly flyerThreats: readonly Unit[];
}

export interface IV08BacklineWardIntent {
    readonly protector: Unit;
    readonly protectorIntent: IV08BacklineProtectorIntent;
}

export const v08BacklineProtectorKind = (unit: Unit): V08BacklineProtectorKind | undefined => {
    if (unit.getName() === "Abomination") return "abomination";
    if (unit.getName() === "Arachna Queen") return "arachna_queen";
    return undefined;
};

export const isV08BacklineProtectionBeneficiary = (unit: Unit): boolean => {
    if (unit.isDead()) return false;
    const hasRangedOutput = unit.isRangeCapable() && unit.getRangeShots() > 0;
    const hasSpellOutput =
        unit.getCanCastSpells() && unit.getSpells().some((spell) => isSpellUsableByCaster(unit, spell));
    return hasRangedOutput || hasSpellOutput;
};

const finitePositive = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

/**
 * Stable protected-asset value. This is deliberately a capability ordering, not a learned combat score:
 * remaining maximum ranged output plus remaining spell activations scaled by the stack's direct output.
 */
export const v08BacklineWardValue = (unit: Unit): number => {
    const amount = Math.max(1, finitePositive(unit.getAmountAlive()));
    const perActivation = Math.max(1, finitePositive(unit.getAttackDamageMax()) * amount);
    const ranged = unit.isRangeCapable() ? finitePositive(unit.getRangeShots()) * perActivation : 0;
    const spells = unit.getCanCastSpells()
        ? unit.getSpells().filter((spell) => isSpellUsableByCaster(unit, spell)).length * perActivation
        : 0;
    return Math.min(Number.MAX_SAFE_INTEGER, ranged + spells);
};

const sortedWards = (unit: Unit, context: IDecisionContext): Unit[] =>
    context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter(
            (ally) => ally.getId() !== unit.getId() && !ally.isSummoned() && isV08BacklineProtectionBeneficiary(ally),
        )
        .sort(
            (left, right) =>
                v08BacklineWardValue(right) - v08BacklineWardValue(left) || left.getId().localeCompare(right.getId()),
        );

const liveEnemyFlyers = (unit: Unit, context: IDecisionContext): Unit[] =>
    context.unitsHolder
        .getAllEnemyUnits(unit.getTeam())
        .filter((enemy) => !enemy.isDead() && enemy.canFly())
        .sort((left, right) => left.getId().localeCompare(right.getId()));

/**
 * One shared intent object drives native v0.8 and a13 challenger filtering. Abomination always protects the
 * highest-value live ward. Queen is an anti-fly interceptor only: summoned Infest rewards and no-flyer boards
 * remain offensive. Late dominant/urgent finish releases both roles.
 */
export function buildV08BacklineProtectorIntent(
    unit: Unit,
    context: IDecisionContext,
): IV08BacklineProtectorIntent | undefined {
    const kind = v08BacklineProtectorKind(unit);
    if (!kind || (kind === "arachna_queen" && unit.isSummoned())) return undefined;
    const wards = sortedWards(unit, context);
    if (!wards.length) return undefined;
    if (
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), context.fightProperties?.getCurrentLap() ?? 0)
            .active
    ) {
        return undefined;
    }
    const flyerThreats = kind === "arachna_queen" ? liveEnemyFlyers(unit, context) : [];
    if (kind === "arachna_queen" && !flyerThreats.length) return undefined;
    return { kind, ward: wards[0], wards, flyerThreats };
}

const footprintForBase = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

const cellDistance = (left: XY, right: XY): number => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

const footprintDistance = (left: readonly XY[], right: readonly XY[]): number => {
    let closest = Infinity;
    for (const a of left) {
        for (const b of right) {
            closest = Math.min(closest, cellDistance(a, b));
        }
    }
    return closest;
};

export const v08BacklineProtectorCoverageRange = (unit: Unit, context: IDecisionContext): number => {
    const kind = v08BacklineProtectorKind(unit);
    const auraName = kind === "abomination" ? "Flesh Shield" : kind === "arachna_queen" ? "Web" : undefined;
    const baseRange = auraName ? (unit.getAuraEffect(auraName)?.getRange() ?? 1) : 0;
    const synergyRange = context.fightProperties?.getAdditionalAuraRangePerTeam(unit.getTeam()) ?? 0;
    return Math.max(0, Math.floor(baseRange + synergyRange));
};

const coversWard = (protectorCells: readonly XY[], ward: Unit, protector: Unit, context: IDecisionContext): boolean =>
    footprintDistance(protectorCells, ward.getCells()) <= v08BacklineProtectorCoverageRange(protector, context);

const decisionDestinationCells = (unit: Unit, decision: readonly GameAction[]): XY[] => {
    const obstacle = [...decision]
        .reverse()
        .find(
            (action): action is Extract<GameAction, { type: "obstacle_attack" }> => action.type === "obstacle_attack",
        );
    if (obstacle?.attackFrom) return footprintForBase(unit, obstacle.attackFrom);
    const melee = [...decision]
        .reverse()
        .find((action): action is Extract<GameAction, { type: "melee_attack" }> => action.type === "melee_attack");
    if (melee) return footprintForBase(unit, melee.attackFrom);
    const move = [...decision]
        .reverse()
        .find((action): action is Extract<GameAction, { type: "move_unit" }> => action.type === "move_unit");
    if (!move) return unit.getCells();
    if (move.targetCells?.length) return move.targetCells;
    const base = move.path.at(-1);
    return base ? footprintForBase(unit, base) : unit.getCells();
};

const sameFootprint = (left: readonly XY[], right: readonly XY[]): boolean =>
    left.length === right.length &&
    left.every((cell) => right.some((candidate) => candidate.x === cell.x && candidate.y === cell.y));

const coveredWardsAt = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    protectorCells: readonly XY[],
): Unit[] => intent.wards.filter((ward) => coversWard(protectorCells, ward, unit, context));

const preservesCurrentlyCoveredWards = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    destination: readonly XY[],
    permittedLossId?: string,
): boolean =>
    coveredWardsAt(intent, unit, context, unit.getCells()).every(
        (ward) => ward.getId() === permittedLossId || coversWard(destination, ward, unit, context),
    );

const totalWardValue = (wards: readonly Unit[]): number =>
    wards.reduce((total, ward) => Math.min(Number.MAX_SAFE_INTEGER, total + v08BacklineWardValue(ward)), 0);

const catchUpDestinationAllowed = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    destination: readonly XY[],
): boolean => {
    const current = unit.getCells();
    const range = v08BacklineProtectorCoverageRange(unit, context);
    const currentPrimaryDistance = footprintDistance(current, intent.ward.getCells());
    const destinationPrimaryDistance = footprintDistance(destination, intent.ward.getCells());
    if (currentPrimaryDistance <= range || destinationPrimaryDistance >= currentPrimaryDistance) return false;
    if (preservesCurrentlyCoveredWards(intent, unit, context, destination)) return true;
    // A high-value primary can be on the opposite side of a forced formation split. Abandoning a secondary
    // screen is permitted only as an atomic value upgrade: this very step must restore the primary and increase
    // total covered ward value. Partial progress is never allowed to shed an already covered stack.
    return (
        coversWard(destination, intent.ward, unit, context) &&
        totalWardValue(coveredWardsAt(intent, unit, context, destination)) >
            totalWardValue(coveredWardsAt(intent, unit, context, current))
    );
};

const isPureMoveDecision = (decision: readonly GameAction[]): boolean =>
    decision.length > 0 && decision.every((action) => action.type === "move_unit");

const nearbyWardThreats = (intent: IV08BacklineProtectorIntent, unit: Unit, context: IDecisionContext): Unit[] => {
    const currentlyCoveredWards = coveredWardsAt(intent, unit, context, unit.getCells());
    if (!currentlyCoveredWards.length) return [];
    const threats =
        intent.kind === "arachna_queen"
            ? intent.flyerThreats
            : context.unitsHolder.getAllEnemyUnits(unit.getTeam()).filter((enemy) => !enemy.isDead());
    return threats.filter((threat) =>
        currentlyCoveredWards.some((ward) => footprintDistance(threat.getCells(), ward.getCells()) <= 1),
    );
};

const queenInterceptsLocalDiver = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    decision: readonly GameAction[],
    destination: readonly XY[],
    context: IDecisionContext,
): boolean => {
    if (intent.kind !== "arachna_queen") return false;
    const targetId = [...decision]
        .reverse()
        .find(
            (action): action is Extract<GameAction, { type: "melee_attack" | "range_attack" }> =>
                action.type === "melee_attack" || action.type === "range_attack",
        )?.targetId;
    if (!targetId) return false;
    const target = context.unitsHolder.getAllUnits().get(targetId);
    return (
        !!target &&
        !target.isDead() &&
        footprintDistance(target.getCells(), intent.ward.getCells()) <= 1 &&
        footprintDistance(destination, intent.ward.getCells()) <= v08BacklineProtectorCoverageRange(unit, context) + 1
    );
};

/**
 * Exact final-geometry constraint used by SearchDriver. Abomination never abandons Flesh Shield range.
 * Queen may step one extra ring to intercept an enemy already touching the ward, but cannot convert that
 * exception into a forward charge.
 */
export function preservesV08BacklineProtectorIntent(
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    const destination = decisionDestinationCells(unit, decision);
    // Forced displacement can put the selected ward outside the aura even while the protector happens to cover
    // lower-value stacks. In that recovery state, allow strict no-loss catch-up or an immediate higher-value
    // primary swap; a13 must not require one activation to restore range when a preserving route needs several.
    if (catchUpDestinationAllowed(intent, unit, context, destination)) return true;
    const localQueenIntercept = queenInterceptsLocalDiver(intent, unit, decision, destination, context);
    // A protector may be assigned to one primary ward while its aura currently covers several valuable
    // shooters/casters. Every relocating challenger owns that full live contract: it cannot preserve only the
    // primary while silently dropping a second covered stack. Queen's existing one-ring intercept exception is
    // deliberately narrow — it may suspend coverage only for the primary ward whose adjacent diver it attacks.
    if (
        !preservesCurrentlyCoveredWards(
            intent,
            unit,
            context,
            destination,
            localQueenIntercept ? intent.ward.getId() : undefined,
        )
    ) {
        return false;
    }
    if (coversWard(destination, intent.ward, unit, context)) return true;
    return localQueenIntercept;
}

/**
 * A role-preserving pure move is active work only when it makes strict progress. Lateral motion inside the same
 * screen is not progress: treating it as such converts a deliberate hold into deterministic x/y oscillation.
 * Progress is one of: tighten formation toward the primary ward, add protected ward value without losing any
 * currently covered stack, or close on an enemy already touching a protected ward.
 */
export function isV08BacklineProtectorPureMoveMeaningful(
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    if (!isPureMoveDecision(decision)) return false;
    const current = unit.getCells();
    const destination = decisionDestinationCells(unit, decision);
    if (sameFootprint(current, destination) || !preservesV08BacklineProtectorIntent(intent, unit, context, decision)) {
        return false;
    }
    const currentPrimaryDistance = footprintDistance(current, intent.ward.getCells());
    const destinationPrimaryDistance = footprintDistance(destination, intent.ward.getCells());
    if (destinationPrimaryDistance < currentPrimaryDistance) {
        return true;
    }
    const currentCovered = coveredWardsAt(intent, unit, context, current);
    const destinationCovered = coveredWardsAt(intent, unit, context, destination);
    if (totalWardValue(destinationCovered) > totalWardValue(currentCovered)) {
        return true;
    }
    const localThreats = nearbyWardThreats(intent, unit, context);
    if (!localThreats.length) return false;
    const closestThreat = (cells: readonly XY[]): number =>
        Math.min(...localThreats.map((threat) => footprintDistance(cells, threat.getCells())));
    return closestThreat(destination) < closestThreat(current);
}

export function isV08BacklineProtectorDecisionAllowed(
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    const intent = buildV08BacklineProtectorIntent(unit, context);
    return !intent || preservesV08BacklineProtectorIntent(intent, unit, context, decision);
}

interface IProtectorRoute {
    route: IReadonlyWeightedRoute;
    distance: number;
}

const betterRoute = (candidate: IProtectorRoute, incumbent: IProtectorRoute | undefined): boolean => {
    if (!incumbent) return true;
    if (candidate.distance !== incumbent.distance) return candidate.distance < incumbent.distance;
    const candidateWeight = candidate.route.weight ?? candidate.route.route.length;
    const incumbentWeight = incumbent.route.weight ?? incumbent.route.route.length;
    if (candidateWeight !== incumbentWeight) return candidateWeight < incumbentWeight;
    return (
        candidate.route.cell.y < incumbent.route.cell.y ||
        (candidate.route.cell.y === incumbent.route.cell.y && candidate.route.cell.x < incumbent.route.cell.x)
    );
};

const followWard = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
): GameAction[] | undefined => {
    if (!unit.canMove()) return undefined;
    const ward = intent.ward;
    const currentDistance = footprintDistance(unit.getCells(), ward.getCells());
    const movePath = decisionPathSource(context).getMovePath(
        unit.getBaseCell(),
        context.matrix,
        unit.getSteps(),
        context.grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
    );
    let bestPreserving: IProtectorRoute | undefined;
    let bestValueSwap: IProtectorRoute | undefined;
    for (const routes of movePath.knownPaths.values()) {
        const route = routes[0];
        if (!route?.route.length) continue;
        const candidate: IProtectorRoute = {
            route,
            distance: footprintDistance(footprintForBase(unit, route.cell), ward.getCells()),
        };
        const destination = footprintForBase(unit, route.cell);
        if (candidate.distance >= currentDistance || !catchUpDestinationAllowed(intent, unit, context, destination)) {
            continue;
        }
        if (preservesCurrentlyCoveredWards(intent, unit, context, destination)) {
            if (betterRoute(candidate, bestPreserving)) bestPreserving = candidate;
        } else if (betterRoute(candidate, bestValueSwap)) {
            bestValueSwap = candidate;
        }
    }
    const best = bestPreserving ?? bestValueSwap;
    if (!best) return undefined;
    return [
        {
            type: "move_unit",
            unitId: unit.getId(),
            path: best.route.route.map((cell) => ({ x: cell.x, y: cell.y })),
            targetCells: footprintForBase(unit, best.route.cell),
            hasLavaCell: best.route.hasLavaCell,
            hasWaterCell: best.route.hasWaterCell,
        },
    ];
};

export const v08BacklineProtectorHasCatchUpRoute = (
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
): boolean => !!followWard(intent, unit, context);

/**
 * Exact runtime boundary for a protector candidate. The normal contract is strict coverage preservation.
 * Forced displacement is the sole exception: when no legal catch-up route exists, native v0.8 retains a useful
 * in-place action (or its final wait/defend hold) instead of inventing a charge that abandons every ward.
 *
 * Callers evaluating a candidate set should calculate `hasCatchUpRoute` once and pass it to every candidate.
 */
export function isV08BacklineProtectorRuntimeDecisionAllowed(
    intent: IV08BacklineProtectorIntent,
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
    hasCatchUpRoute = v08BacklineProtectorHasCatchUpRoute(intent, unit, context),
): boolean {
    if (preservesV08BacklineProtectorIntent(intent, unit, context, decision)) return true;
    return !hasCatchUpRoute && sameFootprint(unit.getCells(), decisionDestinationCells(unit, decision));
}

/**
 * Native v0.8 protector policy. Preserve protection-compatible attacks/casts; otherwise follow a displaced
 * ward, or spend this activation holding the exact screen rather than rushing toward the enemy.
 */
export function prioritizeV08BacklineProtector(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    canHourglass: boolean,
): GameAction[] {
    const intent = buildV08BacklineProtectorIntent(unit, context);
    if (!intent) return decision;
    const currentlyCovered = coversWard(unit.getCells(), intent.ward, unit, context);
    if (!currentlyCovered) {
        const destination = decisionDestinationCells(unit, decision);
        if (
            catchUpDestinationAllowed(intent, unit, context, destination) &&
            preservesCurrentlyCoveredWards(intent, unit, context, destination)
        ) {
            return decision;
        }
        const follow = followWard(intent, unit, context);
        if (follow) return follow;
        if (catchUpDestinationAllowed(intent, unit, context, destination)) return decision;
        // Preserve an otherwise useful in-place attack/cast when forced displacement and occupancy leave no
        // closer route. This avoids turning a movement lock into a needless defend without allowing a charge.
        if (sameFootprint(destination, unit.getCells())) return decision;
    } else if (preservesV08BacklineProtectorIntent(intent, unit, context, decision)) {
        // Native v0.8 is SearchDriver's incumbent. Suppress only a pure relocation that changes no protection
        // objective; otherwise candidate zero can retain lateral screen jitter without ever entering the hard
        // passive repair path. Attacks, casts, move-attacks, and the uncovered-primary catch-up above are kept.
        if (
            !isPureMoveDecision(decision) ||
            isV08BacklineProtectorPureMoveMeaningful(intent, unit, context, decision)
        ) {
            return decision;
        }
    }
    return canHourglass
        ? [{ type: "wait_turn", unitId: unit.getId() }]
        : [{ type: "defend_turn", unitId: unit.getId() }];
}

/**
 * A productive shooter/caster assigned to a live protector should not voluntarily run out of its screen.
 * Forced displacement is handled non-worsening until either stack can restore coverage; depletion and the
 * universal finish release the relationship through the protector intent itself.
 */
export function buildV08BacklineWardIntent(unit: Unit, context: IDecisionContext): IV08BacklineWardIntent | undefined {
    if (unit.isSummoned() || !isV08BacklineProtectionBeneficiary(unit)) return undefined;
    const protectors = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter(
            (ally) =>
                ally.getId() !== unit.getId() &&
                !ally.isDead() &&
                !ally.isSummoned() &&
                v08BacklineProtectorKind(ally) !== undefined,
        )
        .sort(
            (left, right) =>
                Number(v08BacklineProtectorKind(right) === "abomination") -
                    Number(v08BacklineProtectorKind(left) === "abomination") ||
                left.getId().localeCompare(right.getId()),
        );
    for (const protector of protectors) {
        const protectorIntent = buildV08BacklineProtectorIntent(protector, context);
        if (protectorIntent?.ward.getId() === unit.getId()) {
            return { protector, protectorIntent };
        }
    }
    return undefined;
}

export function preservesV08BacklineWardIntent(
    intent: IV08BacklineWardIntent,
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    const destination = decisionDestinationCells(unit, decision);
    const range = v08BacklineProtectorCoverageRange(intent.protector, context);
    const currentDistance = footprintDistance(intent.protector.getCells(), unit.getCells());
    const destinationDistance = footprintDistance(intent.protector.getCells(), destination);
    return currentDistance <= range ? destinationDistance <= range : destinationDistance <= currentDistance;
}

/**
 * A screened ward's pure move must either restore lost coverage or escape an enemy already pinning its current
 * footprint. Merely choosing another cell inside the same aura is deliberate-hold jitter, not productive work.
 */
export function isV08BacklineWardPureMoveMeaningful(
    intent: IV08BacklineWardIntent,
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    if (!isPureMoveDecision(decision)) return false;
    const current = unit.getCells();
    const destination = decisionDestinationCells(unit, decision);
    if (sameFootprint(current, destination) || !preservesV08BacklineWardIntent(intent, unit, context, decision)) {
        return false;
    }
    const range = v08BacklineProtectorCoverageRange(intent.protector, context);
    const currentProtectorDistance = footprintDistance(intent.protector.getCells(), current);
    const destinationProtectorDistance = footprintDistance(intent.protector.getCells(), destination);
    if (currentProtectorDistance > range && destinationProtectorDistance < currentProtectorDistance) {
        return true;
    }
    const adjacentThreats = context.unitsHolder
        .getAllEnemyUnits(unit.getTeam())
        .filter((enemy) => !enemy.isDead() && footprintDistance(current, enemy.getCells()) <= 1);
    if (!adjacentThreats.length) return false;
    const closestThreat = (cells: readonly XY[]): number =>
        Math.min(...adjacentThreats.map((enemy) => footprintDistance(cells, enemy.getCells())));
    return closestThreat(destination) > closestThreat(current);
}

const placementWards = (units: readonly Unit[]): Unit[] =>
    units
        .filter((unit) => !unit.isSummoned() && isV08BacklineProtectionBeneficiary(unit))
        .sort(
            (left, right) =>
                v08BacklineWardValue(right) - v08BacklineWardValue(left) || left.getId().localeCompare(right.getId()),
        );

const placementKnowsEnemyFlyer = (context: IPlacementContext): boolean => {
    const visibleOpponentIds = opponentCreatureIdsForPlacement(context, "v0.8");
    return !!visibleOpponentIds?.some((creatureId) => creatureInfo(creatureId)?.canFly);
};

/**
 * v0.8-only opening geometry. v0.7 stays byte-stable. The measured anti-splash layout keeps precedence;
 * otherwise active protectors are assigned to the highest-value ranged/caster wards. Queen is selected as a
 * guard only when the public enemy roster contains a flyer.
 */
export function v08BacklineProtectorPlacement(units: Unit[], context: IPlacementContext): Map<string, XY> | undefined {
    const wards = placementWards(units);
    if (!wards.length || enemyFieldsSplashAoe(context)) return undefined;
    const activeProtectors = units
        .filter((unit) => {
            const kind = v08BacklineProtectorKind(unit);
            return kind === "abomination" || (kind === "arachna_queen" && placementKnowsEnemyFlyer(context));
        })
        .sort((left, right) => {
            const leftKind = v08BacklineProtectorKind(left);
            const rightKind = v08BacklineProtectorKind(right);
            return (
                Number(rightKind === "abomination") - Number(leftKind === "abomination") ||
                left.getId().localeCompare(right.getId())
            );
        });
    if (!activeProtectors.length) return undefined;
    const activeIds = new Set(activeProtectors.map((unit) => unit.getId()));
    const inactiveQueenIds = units
        .filter((unit) => v08BacklineProtectorKind(unit) === "arachna_queen" && !activeIds.has(unit.getId()))
        .map((unit) => unit.getId());
    return layoutRevealPlacement(units, context, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
        screenBacklineProtectors: true,
        preferredGuardUnitIds: activeProtectors.map((unit) => unit.getId()),
        excludedGuardUnitIds: inactiveQueenIds,
        preferredBacklineUnitIds: wards.map((unit) => unit.getId()),
    });
}
