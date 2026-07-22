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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../constants";
import type { IEnumeratedCandidate, IShotCandidateFeatures } from "../ai";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { PureRangedTerminalState } from "./v0_7_pure_ranged_terminal";

const RANGE = PBTypes.AttackVals.RANGE;

/** Preregistered JIT window: six through one complete pre-Armageddon activations remain. */
export const PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP = 6;
export const PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON;
export const PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP = PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP - 1;
export const PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER = 1;
export const PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR = 0.8;

export interface IPureRangedJitNoMeleeFocusCandidate {
    readonly candidate: IEnumeratedCandidate;
    readonly noMeleeTargetId: string;
    readonly noMeleeTargetName: string;
    readonly incumbentLocked: boolean;
    readonly immediateKill: boolean;
    readonly activeEndlessQuiver: boolean;
    readonly targetWoundedFraction: number;
    /** Optimistic full-damage activation upper bound, recomputed from current ammo every turn. */
    readonly availableFullDamageActivationsUpperBound: number;
    readonly estimatedRequiredActivations: number;
    /** Optimistic activation upper bound minus required actions; negative values remain deliberately eligible. */
    readonly deadlineSlack: number;
    readonly expectedNoMeleeDamage: number;
    readonly expectedEnemyDamageDelta: number;
    readonly expectedNetDamageDelta: number;
    readonly enemyDamageRatio: number;
    readonly netDamageRatio: number;
    readonly minimumDamageRatio: number;
    readonly friendlyFireDamageDelta: number;
    readonly expectedKillDelta: number;
}

interface IStationaryShot {
    readonly candidate: IEnumeratedCandidate;
    readonly index: number;
    readonly action: Extract<GameAction, { type: "range_attack" }>;
    readonly shotFeatures: IShotCandidateFeatures;
}

const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

/** Stable intrinsic/granted card ownership: Break does not reclassify an actor, but a stolen card does. */
export function ownsPureRangedJitClassifyingAbility(unit: Unit, abilityName: string): boolean {
    const properties = unit.getUnitProperties();
    return properties.abilities.includes(abilityName) && !(properties.stolen_abilities ?? []).includes(abilityName);
}

/** This arm is intentionally limited to ordinary, original native shooters without collateral mechanics. */
export function pureRangedJitNoMeleeFocusActorEligible(
    actor: Unit,
    originalState: PureRangedTerminalState | null,
): boolean {
    return (
        originalState?.eligible === true &&
        originalState.originalUnits.some(
            (original) => original.id === actor.getId() && original.team === actor.getTeam(),
        ) &&
        !actor.isDead() &&
        !actor.isSummoned() &&
        actor.getAttackType() === RANGE &&
        actor.getRangeShots() > 0 &&
        !ownsPureRangedJitClassifyingAbility(actor, "No Melee") &&
        !ownsPureRangedJitClassifyingAbility(actor, "Through Shot") &&
        !ownsPureRangedJitClassifyingAbility(actor, "Large Caliber") &&
        !ownsPureRangedJitClassifyingAbility(actor, "Area Throw") &&
        // A Double Shot activation consumes two ammo while candidate damage describes both projectiles. Its
        // one-ammo tail therefore needs a separate damage model; exclude it from this deliberately narrow v1.
        !ownsPureRangedJitClassifyingAbility(actor, "Double Shot")
    );
}

export function pureRangedJitNoMeleeFocusLapEligible(currentLap: number): boolean {
    return (
        Number.isFinite(currentLap) &&
        currentLap >= PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP &&
        currentLap < PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP
    );
}

/** Only one stationary, positive ranged activation can enter this aim-only intervention. */
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
    if (action.attackerId !== actor.getId() || candidate.targetId !== action.targetId) return undefined;
    return { candidate, index, action, shotFeatures };
}

/** Cheap pre-enumeration guard used to keep move-shots and every non-shot incumbent catalog-identical. */
export function isPureRangedJitNoMeleeFocusStationaryIncumbent(actor: Unit, actions: readonly GameAction[]): boolean {
    const ranged = actions.filter((action) => action.type === "range_attack");
    const selectors = actions.filter((action) => action.type === "select_attack_type");
    return (
        ranged.length === 1 &&
        selectors.length <= 1 &&
        actions.length === ranged.length + selectors.length &&
        ranged[0].attackerId === actor.getId() &&
        selectors.every(
            (selector) => selector.unitId === actor.getId() && selector.attackType === RANGE && actions[0] === selector,
        )
    );
}

const retainedDamageRatio = (challenger: number, incumbent: number): number =>
    incumbent > 0 ? challenger / incumbent : 1;

function targetWoundedFraction(target: Unit): number {
    const originalHp = Math.max(0, target.getAmountAlive() + target.getAmountDied()) * Math.max(0, target.getMaxHp());
    if (!(originalHp > 0)) return 0;
    return Math.min(1, Math.max(0, 1 - target.getCumulativeHp() / originalHp));
}

function compareRanked(
    left: IPureRangedJitNoMeleeFocusCandidate & { readonly index: number },
    right: IPureRangedJitNoMeleeFocusCandidate & { readonly index: number },
): number {
    return (
        Number(right.immediateKill) - Number(left.immediateKill) ||
        Number(right.incumbentLocked) - Number(left.incumbentLocked) ||
        right.targetWoundedFraction - left.targetWoundedFraction ||
        left.deadlineSlack - right.deadlineSlack ||
        right.minimumDamageRatio - left.minimumDamageRatio ||
        right.expectedNoMeleeDamage - left.expectedNoMeleeDamage ||
        left.index - right.index
    );
}

/**
 * Rank a just-in-time No-Melee target lock for ordinary shooters. A target arms when it is immediately killable
 * or has at most one optimistic spare activation before Armageddon, using the smaller of remaining laps and
 * current ammo. Finite ammo may later be spent by ranged responses or reduced by Limited Supply, so this is a
 * recomputed upper bound rather than an ammo-safety guarantee. Endless Quiver is the exact unlimited branch.
 * Negative slack stays eligible: it identifies an already-late barrier rather than silently discarding it.
 *
 * Except for an immediate barrier kill, the inherited aim is a hard lock when it already shoots an armed barrier.
 * Redirects preserve the inherited primary-target kill estimate, retain at least 80% of both enemy-only and net
 * damage, never increase friendly fire, and remain exact one-activation stationary shots. The caller still probes
 * every lock or redirect through the authoritative engine before selection.
 */
export function rankPureRangedJitNoMeleeFocusCandidates(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    originalState: PureRangedTerminalState | null,
    currentLap: number,
): IPureRangedJitNoMeleeFocusCandidate[] {
    if (
        !pureRangedJitNoMeleeFocusActorEligible(actor, originalState) ||
        !pureRangedJitNoMeleeFocusLapEligible(currentLap) ||
        candidates[0]?.kind !== "incumbent"
    ) {
        return [];
    }
    const incumbent = stationaryPositiveShot(actor, candidates[0], 0);
    if (!incumbent) return [];

    const originalEnemyNoMelee = new Map<string, Unit>();
    for (const original of originalState!.originalUnits) {
        const unit = unitsHolder.getAllUnits().get(original.id);
        if (
            unit &&
            !unit.isDead() &&
            unit.getTeam() !== actor.getTeam() &&
            ownsPureRangedJitClassifyingAbility(unit, "No Melee")
        ) {
            originalEnemyNoMelee.set(unit.getId(), unit);
        }
    }
    if (!originalEnemyNoMelee.size) return [];

    const remainingLaps = Math.max(0, Math.floor(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - currentLap));
    const reportedShots = actor.getRangeShots();
    const currentAmmo = Number.isFinite(reportedShots) ? Math.max(0, Math.floor(reportedShots)) : remainingLaps;
    const activeEndlessQuiver = actor.getAbility("Endless Quiver") !== undefined;
    const availableFullDamageActivationsUpperBound = activeEndlessQuiver
        ? remainingLaps
        : Math.min(remainingLaps, currentAmmo);
    if (availableFullDamageActivationsUpperBound <= 0) return [];

    const ranked: Array<IPureRangedJitNoMeleeFocusCandidate & { readonly index: number }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
        const shot = stationaryPositiveShot(actor, candidates[index], index);
        if (!shot) continue;
        const target = originalEnemyNoMelee.get(shot.action.targetId);
        if (!target) continue;
        const immediateKill = shot.candidate.features.expectedKill === 1;
        const estimatedRequiredActivations = Math.max(
            1,
            Math.ceil(target.getCumulativeHp() / shot.shotFeatures.primaryTargetDamage),
        );
        const deadlineSlack = availableFullDamageActivationsUpperBound - estimatedRequiredActivations;
        if (!immediateKill && deadlineSlack > PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER) continue;

        const enemyDamageRatio = retainedDamageRatio(shot.shotFeatures.enemyDamage, incumbent.shotFeatures.enemyDamage);
        const netDamageRatio = retainedDamageRatio(
            shot.candidate.features.expectedDamage,
            incumbent.candidate.features.expectedDamage,
        );
        const friendlyFireDamageDelta =
            shot.shotFeatures.friendlyFireDamage - incumbent.shotFeatures.friendlyFireDamage;
        const expectedKillDelta = shot.candidate.features.expectedKill - incumbent.candidate.features.expectedKill;
        const incumbentLocked = index === 0;
        if (
            !incumbentLocked &&
            (expectedKillDelta < 0 ||
                enemyDamageRatio < PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR ||
                netDamageRatio < PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR ||
                friendlyFireDamageDelta > 0)
        ) {
            continue;
        }
        ranked.push({
            candidate: shot.candidate,
            noMeleeTargetId: target.getId(),
            noMeleeTargetName: target.getName(),
            incumbentLocked,
            immediateKill,
            activeEndlessQuiver,
            targetWoundedFraction: targetWoundedFraction(target),
            availableFullDamageActivationsUpperBound,
            estimatedRequiredActivations,
            deadlineSlack,
            expectedNoMeleeDamage: shot.shotFeatures.primaryTargetDamage,
            expectedEnemyDamageDelta: shot.shotFeatures.enemyDamage - incumbent.shotFeatures.enemyDamage,
            expectedNetDamageDelta:
                shot.candidate.features.expectedDamage - incumbent.candidate.features.expectedDamage,
            enemyDamageRatio,
            netDamageRatio,
            minimumDamageRatio: Math.min(enemyDamageRatio, netDamageRatio),
            friendlyFireDamageDelta,
            expectedKillDelta,
            index,
        });
    }

    const ordered = ranked.sort(compareRanked);
    // An immediate barrier kill is the sole tier above a safe incumbent lock. Once a lock reaches the front,
    // lower-ranked redirects are intentionally hidden from the caller and ordinary rollout search.
    const selected = ordered[0]?.incumbentLocked ? [ordered[0]] : ordered;
    return selected.map(({ index: _index, ...candidate }) => candidate);
}
