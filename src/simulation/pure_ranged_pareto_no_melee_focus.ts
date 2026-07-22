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

import type { IEnumeratedCandidate, IShotCandidateFeatures } from "../ai";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { PureRangedTerminalState } from "./v0_7_pure_ranged_terminal";

const RANGE = PBTypes.AttackVals.RANGE;

/** The universal lap-nine a13 finish policy remains authoritative. */
export const PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP = 9;

export type PureRangedParetoFocusActorAbility = "through_shot" | "large_caliber";

export interface IPureRangedParetoNoMeleeFocusCandidate {
    readonly candidate: IEnumeratedCandidate;
    readonly actorAbility: PureRangedParetoFocusActorAbility;
    readonly noMeleeTargetId: string;
    readonly expectedNoMeleeDamage: number;
    readonly expectedEnemyDamageDelta: number;
}

interface IStationaryShot {
    readonly candidate: IEnumeratedCandidate;
    readonly index: number;
    readonly action: Extract<GameAction, { type: "range_attack" }>;
    readonly shotFeatures: IShotCandidateFeatures;
}

/** The only actor shapes whose collateral metadata is narrow enough for this experiment. */
export function pureRangedParetoNoMeleeFocusActorAbility(actor: Unit): PureRangedParetoFocusActorAbility | undefined {
    const throughShot = actor.hasAbilityActive("Through Shot");
    const largeCaliber = actor.hasAbilityActive("Large Caliber");
    const areaThrow = actor.hasAbilityActive("Area Throw");
    if (throughShot && !largeCaliber && !areaThrow) return "through_shot";
    if (largeCaliber && !throughShot && !areaThrow) return "large_caliber";
    return undefined;
}

const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

/** Only an exact, stationary one-shot delivery may enter this aim/target-only intervention. */
function stationaryPositiveShot(
    actor: Unit,
    candidate: IEnumeratedCandidate,
    index: number,
): IStationaryShot | undefined {
    const rangedActions = candidate.actions.filter(
        (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
    );
    const selectors = candidate.actions.filter(
        (action): action is Extract<GameAction, { type: "select_attack_type" }> => action.type === "select_attack_type",
    );
    const shotFeatures = candidate.shotFeatures;
    if (
        rangedActions.length !== 1 ||
        selectors.length > 1 ||
        candidate.actions.length !== rangedActions.length + selectors.length ||
        selectors.some(
            (selector) =>
                selector.unitId !== actor.getId() || selector.attackType !== RANGE || candidate.actions[0] !== selector,
        ) ||
        candidate.features.spendsRangeShot !== 1 ||
        !Number.isFinite(candidate.features.expectedDamage) ||
        candidate.features.expectedDamage <= 0 ||
        !shotFeatures ||
        !finiteNonnegative(shotFeatures.enemyDamage) ||
        !finiteNonnegative(shotFeatures.friendlyFireDamage) ||
        !Number.isFinite(shotFeatures.primaryTargetDamage) ||
        shotFeatures.primaryTargetDamage <= 0
    ) {
        return undefined;
    }
    const action = rangedActions[0];
    if (action.attackerId !== actor.getId() || candidate.targetId !== action.targetId) {
        return undefined;
    }
    return { candidate, index, action, shotFeatures };
}

function compareRanked(
    left: IPureRangedParetoNoMeleeFocusCandidate & { readonly index: number },
    right: IPureRangedParetoNoMeleeFocusCandidate & { readonly index: number },
): number {
    return (
        right.candidate.features.expectedKill - left.candidate.features.expectedKill ||
        right.expectedNoMeleeDamage - left.expectedNoMeleeDamage ||
        (right.candidate.shotFeatures?.enemyDamage ?? 0) - (left.candidate.shotFeatures?.enemyDamage ?? 0) ||
        right.candidate.features.expectedDamage - left.candidate.features.expectedDamage ||
        (left.candidate.shotFeatures?.friendlyFireDamage ?? 0) -
            (right.candidate.shotFeatures?.friendlyFireDamage ?? 0) ||
        left.index - right.index
    );
}

/**
 * Prefer a living original No-Melee target only when the engine-generated alternative is aggregate-Pareto-safe.
 * The target-local damage may be lower than the incumbent's because the target intentionally changes; total enemy
 * damage, net damage, the aimed primary's kill estimate, friendly fire, shot spend, and stationary posture may
 * never regress. Candidate metadata does not expose secondary-stack kill counts, so this experiment deliberately
 * makes no stronger claim about which collateral stack receives the aggregate damage.
 */
export function rankPureRangedParetoNoMeleeFocusCandidates(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    originalState: PureRangedTerminalState | null,
    currentLap: number,
): IPureRangedParetoNoMeleeFocusCandidate[] {
    const actorAbility = pureRangedParetoNoMeleeFocusActorAbility(actor);
    if (
        !originalState?.eligible ||
        !actorAbility ||
        actor.isDead() ||
        actor.getRangeShots() <= 0 ||
        !Number.isFinite(currentLap) ||
        currentLap < 1 ||
        currentLap >= PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP ||
        candidates[0]?.kind !== "incumbent"
    ) {
        return [];
    }

    const incumbent = stationaryPositiveShot(actor, candidates[0], 0);
    if (!incumbent) return [];

    const livingOriginalNoMeleeEnemyIds = new Set<string>();
    for (const original of originalState.originalUnits) {
        const unit = unitsHolder.getAllUnits().get(original.id);
        if (unit && !unit.isDead() && unit.getTeam() !== actor.getTeam() && unit.hasAbilityActive("No Melee")) {
            livingOriginalNoMeleeEnemyIds.add(unit.getId());
        }
    }
    if (!livingOriginalNoMeleeEnemyIds.size || livingOriginalNoMeleeEnemyIds.has(incumbent.action.targetId)) {
        return [];
    }

    const ranked: Array<IPureRangedParetoNoMeleeFocusCandidate & { readonly index: number }> = [];
    for (let index = 1; index < candidates.length; index += 1) {
        const challenger = stationaryPositiveShot(actor, candidates[index], index);
        if (!challenger || !livingOriginalNoMeleeEnemyIds.has(challenger.action.targetId)) continue;
        const candidate = challenger.candidate;
        if (
            candidate.features.expectedKill < incumbent.candidate.features.expectedKill ||
            candidate.features.expectedDamage < incumbent.candidate.features.expectedDamage ||
            challenger.shotFeatures.enemyDamage < incumbent.shotFeatures.enemyDamage ||
            challenger.shotFeatures.friendlyFireDamage > incumbent.shotFeatures.friendlyFireDamage
        ) {
            continue;
        }
        ranked.push({
            candidate,
            actorAbility,
            noMeleeTargetId: challenger.action.targetId,
            expectedNoMeleeDamage: challenger.shotFeatures.primaryTargetDamage,
            expectedEnemyDamageDelta: challenger.shotFeatures.enemyDamage - incumbent.shotFeatures.enemyDamage,
            index,
        });
    }

    return ranked.sort(compareRanked).map(({ index: _index, ...candidate }) => candidate);
}
