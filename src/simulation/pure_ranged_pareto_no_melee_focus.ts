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
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

/** The universal lap-nine a13 finish policy remains authoritative. */
export const PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP = 9;

export type PureRangedParetoFocusActorAbility = "through_shot" | "large_caliber";
export type PureRangedParetoNoMeleeFocusScope = "pure_ranged" | "any_board" | "mixed_supported";

export const DEFAULT_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: PureRangedParetoNoMeleeFocusScope = "pure_ranged";

export interface IPureRangedParetoNoMeleeFocusCandidate {
    readonly candidate: IEnumeratedCandidate;
    readonly actorAbility: PureRangedParetoFocusActorAbility;
    readonly noMeleeTargetId: string;
    readonly support?: IMixedSupportedParetoNoMeleeFocusSupport;
    readonly expectedNoMeleeDamage: number;
    readonly expectedEnemyDamageDelta: number;
    readonly expectedNetDamageDelta: number;
    readonly enemyDamageRatio: number;
    readonly netDamageRatio: number;
    /** Worst retained fraction across net and enemy-only aggregate damage. */
    readonly minimumDamageRatio: number;
}

export interface IMixedSupportedParetoNoMeleeFocusSupport {
    /** Living original native melee or melee-magic allies available to form a screen. */
    readonly guardCount: number;
    /** Living melee-capable enemies inside their optimistic next-activation reach. */
    readonly reachableThreats: number;
    /** Reachable threats with at least one original native guard geometrically between them and the actor. */
    readonly screenedThreats: number;
}

export interface IMixedSupportedParetoNoMeleeFocusContext {
    readonly actorAbility: PureRangedParetoFocusActorAbility;
    readonly noMeleeTargetIds: readonly string[];
    readonly support: IMixedSupportedParetoNoMeleeFocusSupport;
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

/** Stable native/granted card ownership: a stolen-away card remains visible but cannot classify a unit. */
function ownsParetoClassifyingAbility(unit: Unit, abilityName: string): boolean {
    const properties = unit.getUnitProperties();
    return properties.abilities.includes(abilityName) && !(properties.stolen_abilities ?? []).includes(abilityName);
}

/**
 * The mixed-board expansion is deliberately narrower than the legacy pure-ranged arm: only a living original
 * native shooter with exactly one matching native/current collateral card may expand the target catalog.
 */
export function anyBoardParetoNoMeleeFocusActorAbility(
    actor: Unit,
    originalState: PureRangedTerminalState | null,
): PureRangedParetoFocusActorAbility | undefined {
    const originalActor = originalState?.originalUnits.find(
        (original) => original.id === actor.getId() && original.team === actor.getTeam(),
    );
    if (
        !originalActor ||
        actor.isDead() ||
        actor.isSummoned() ||
        actor.getAttackType() !== RANGE ||
        actor.getRangeShots() <= 0
    ) {
        return undefined;
    }

    const nativeThroughShot = ownsParetoClassifyingAbility(actor, "Through Shot");
    const nativeLargeCaliber = ownsParetoClassifyingAbility(actor, "Large Caliber");
    const nativeAreaThrow = ownsParetoClassifyingAbility(actor, "Area Throw");
    const activeThroughShot = actor.hasAbilityActive("Through Shot");
    const activeLargeCaliber = actor.hasAbilityActive("Large Caliber");
    const activeAreaThrow = actor.hasAbilityActive("Area Throw");
    const capturedThroughShot = originalActor.activeAbilityNames?.includes("Through Shot") === true;
    const capturedLargeCaliber = originalActor.activeAbilityNames?.includes("Large Caliber") === true;
    const capturedAreaThrow = originalActor.activeAbilityNames?.includes("Area Throw") === true;
    if (
        capturedThroughShot &&
        nativeThroughShot &&
        activeThroughShot &&
        !capturedLargeCaliber &&
        !nativeLargeCaliber &&
        !activeLargeCaliber &&
        !capturedAreaThrow &&
        !nativeAreaThrow &&
        !activeAreaThrow
    ) {
        return "through_shot";
    }
    if (
        capturedLargeCaliber &&
        nativeLargeCaliber &&
        activeLargeCaliber &&
        !capturedThroughShot &&
        !nativeThroughShot &&
        !activeThroughShot &&
        !capturedAreaThrow &&
        !nativeAreaThrow &&
        !activeAreaThrow
    ) {
        return "large_caliber";
    }
    return undefined;
}

const cellDistance = (
    left: readonly { x: number; y: number }[],
    right: readonly { x: number; y: number }[],
): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const a of left) {
        for (const b of right) {
            best = Math.min(best, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
        }
    }
    return best;
};

function mixedSupportedGuardScreensThreat(actor: Unit, guard: Unit, threat: Unit): boolean {
    const actorToThreat = cellDistance(actor.getCells(), threat.getCells());
    const guardToThreat = cellDistance(guard.getCells(), threat.getCells());
    const actorToGuard = cellDistance(actor.getCells(), guard.getCells());
    return guardToThreat < actorToThreat && actorToGuard <= 3 && guardToThreat + actorToGuard <= actorToThreat + 1;
}

/**
 * Eligibility shared by catalog generation and selection for the conservative mixed-board arm.
 * It admits only the fixed native Cyclops/Large-Caliber and Tsar-Cannon/Through-Shot identities, rejects
 * structurally pure-ranged boards, and requires every enemy inside an optimistic one-activation melee horizon
 * to be screened by a living original native melee ally. The target is equally narrow: a living original native
 * Tsar Cannon whose captured, owned, and currently active card is No Melee.
 */
export function mixedSupportedParetoNoMeleeFocusContext(
    actor: Unit,
    unitsHolder: UnitsHolder,
    originalState: PureRangedTerminalState | null,
): IMixedSupportedParetoNoMeleeFocusContext | undefined {
    if (originalState?.eligible !== false) return undefined;
    const actorAbility = anyBoardParetoNoMeleeFocusActorAbility(actor, originalState);
    if (
        !actorAbility ||
        (actor.getName() === "Cyclops" && actorAbility !== "large_caliber") ||
        (actor.getName() === "Tsar Cannon" && actorAbility !== "through_shot") ||
        (actor.getName() !== "Cyclops" && actor.getName() !== "Tsar Cannon")
    ) {
        return undefined;
    }

    const units = unitsHolder.getAllUnits();
    const guards: Unit[] = [];
    const noMeleeTargetIds: string[] = [];
    for (const original of originalState.originalUnits) {
        const unit = units.get(original.id);
        if (!unit || original.team !== unit.getTeam() || unit.isDead() || unit.isSummoned()) {
            continue;
        }
        const attackType = unit.getAttackType();
        if (
            unit.getTeam() === actor.getTeam() &&
            unit.getId() !== actor.getId() &&
            (attackType === MELEE || attackType === MELEE_MAGIC)
        ) {
            guards.push(unit);
        }
        if (
            unit.getTeam() !== actor.getTeam() &&
            unit.getName() === "Tsar Cannon" &&
            original.activeAbilityNames?.includes("No Melee") === true &&
            ownsParetoClassifyingAbility(unit, "No Melee") &&
            unit.hasAbilityActive("No Melee")
        ) {
            noMeleeTargetIds.push(unit.getId());
        }
    }
    if (!guards.length || !noMeleeTargetIds.length) return undefined;

    const reachableThreats = [...units.values()].filter(
        (unit) =>
            !unit.isDead() &&
            unit.getTeam() !== actor.getTeam() &&
            !unit.hasAbilityActive("No Melee") &&
            cellDistance(actor.getCells(), unit.getCells()) <= Math.ceil(Math.max(0, unit.getSteps())) + 1,
    );
    if (!reachableThreats.length) return undefined;
    const screenedThreats = reachableThreats.filter((threat) =>
        guards.some((guard) => mixedSupportedGuardScreensThreat(actor, guard, threat)),
    ).length;
    if (screenedThreats !== reachableThreats.length) return undefined;

    return {
        actorAbility,
        noMeleeTargetIds,
        support: {
            guardCount: guards.length,
            reachableThreats: reachableThreats.length,
            screenedThreats,
        },
    };
}

export function pureRangedParetoNoMeleeFocusLapEligible(currentLap: number): boolean {
    return Number.isFinite(currentLap) && currentLap >= 1 && currentLap < PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP;
}

/** Cheap exact-delivery guard used before mixed-board target expansion. */
export function isParetoNoMeleeFocusStationaryIncumbent(actor: Unit, actions: readonly GameAction[]): boolean {
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
    damageFloor: number,
): number {
    return (
        right.candidate.features.expectedKill - left.candidate.features.expectedKill ||
        (damageFloor < 1 ? right.minimumDamageRatio - left.minimumDamageRatio : 0) ||
        right.expectedNoMeleeDamage - left.expectedNoMeleeDamage ||
        (right.candidate.shotFeatures?.enemyDamage ?? 0) - (left.candidate.shotFeatures?.enemyDamage ?? 0) ||
        right.candidate.features.expectedDamage - left.candidate.features.expectedDamage ||
        (left.candidate.shotFeatures?.friendlyFireDamage ?? 0) -
            (right.candidate.shotFeatures?.friendlyFireDamage ?? 0) ||
        left.index - right.index
    );
}

function retainedDamageRatio(challenger: number, incumbent: number): number {
    return incumbent > 0 ? challenger / incumbent : 1;
}

/**
 * Prefer a living original No-Melee target only when the engine-generated alternative retains the configured
 * fraction of both enemy-only and net aggregate damage. The default floor of one is exact Pareto; preregistered
 * research may lower it no further than 0.9. The aimed primary's kill estimate, friendly fire, shot spend, and
 * stationary posture may never regress. Candidate metadata does not expose secondary-stack kill counts, so this
 * experiment deliberately makes no stronger claim about which collateral stack receives the aggregate damage.
 */
export function rankPureRangedParetoNoMeleeFocusCandidates(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    originalState: PureRangedTerminalState | null,
    currentLap: number,
    damageFloor = 1,
    scope: PureRangedParetoNoMeleeFocusScope = DEFAULT_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE,
): IPureRangedParetoNoMeleeFocusCandidate[] {
    if (scope === "mixed_supported") {
        const context = mixedSupportedParetoNoMeleeFocusContext(actor, unitsHolder, originalState);
        if (
            !context ||
            damageFloor !== 1 ||
            !pureRangedParetoNoMeleeFocusLapEligible(currentLap) ||
            candidates[0]?.kind !== "incumbent"
        ) {
            return [];
        }

        const incumbent = stationaryPositiveShot(actor, candidates[0], 0);
        if (!incumbent) return [];
        const livingOriginalNoMeleeEnemyIds = new Set(context.noMeleeTargetIds);
        if (livingOriginalNoMeleeEnemyIds.has(incumbent.action.targetId)) return [];

        const ranked: Array<IPureRangedParetoNoMeleeFocusCandidate & { readonly index: number }> = [];
        for (let index = 1; index < candidates.length; index += 1) {
            const challenger = stationaryPositiveShot(actor, candidates[index], index);
            if (!challenger || !livingOriginalNoMeleeEnemyIds.has(challenger.action.targetId)) continue;
            const candidate = challenger.candidate;
            const netDamageRatio = retainedDamageRatio(
                candidate.features.expectedDamage,
                incumbent.candidate.features.expectedDamage,
            );
            const enemyDamageRatio = retainedDamageRatio(
                challenger.shotFeatures.enemyDamage,
                incumbent.shotFeatures.enemyDamage,
            );
            if (
                candidate.features.expectedKill < incumbent.candidate.features.expectedKill ||
                netDamageRatio < 1 ||
                enemyDamageRatio < 1 ||
                challenger.shotFeatures.friendlyFireDamage > incumbent.shotFeatures.friendlyFireDamage
            ) {
                continue;
            }
            ranked.push({
                candidate,
                actorAbility: context.actorAbility,
                noMeleeTargetId: challenger.action.targetId,
                support: context.support,
                expectedNoMeleeDamage: challenger.shotFeatures.primaryTargetDamage,
                expectedEnemyDamageDelta: challenger.shotFeatures.enemyDamage - incumbent.shotFeatures.enemyDamage,
                expectedNetDamageDelta: candidate.features.expectedDamage - incumbent.candidate.features.expectedDamage,
                enemyDamageRatio,
                netDamageRatio,
                minimumDamageRatio: Math.min(netDamageRatio, enemyDamageRatio),
                index,
            });
        }

        return ranked
            .sort((left, right) => compareRanked(left, right, 1))
            .map(({ index: _index, ...candidate }) => candidate);
    }
    if (scope === "any_board") {
        const actorAbility = anyBoardParetoNoMeleeFocusActorAbility(actor, originalState);
        if (
            !actorAbility ||
            damageFloor !== 1 ||
            !pureRangedParetoNoMeleeFocusLapEligible(currentLap) ||
            candidates[0]?.kind !== "incumbent"
        ) {
            return [];
        }

        const incumbent = stationaryPositiveShot(actor, candidates[0], 0);
        if (!incumbent) return [];

        const livingOriginalNoMeleeEnemyIds = new Set<string>();
        for (const original of originalState!.originalUnits) {
            const unit = unitsHolder.getAllUnits().get(original.id);
            if (
                unit &&
                original.team === unit.getTeam() &&
                !unit.isDead() &&
                !unit.isSummoned() &&
                unit.getTeam() !== actor.getTeam() &&
                original.activeAbilityNames?.includes("No Melee") === true &&
                ownsParetoClassifyingAbility(unit, "No Melee") &&
                unit.hasAbilityActive("No Melee")
            ) {
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
            const netDamageRatio = retainedDamageRatio(
                candidate.features.expectedDamage,
                incumbent.candidate.features.expectedDamage,
            );
            const enemyDamageRatio = retainedDamageRatio(
                challenger.shotFeatures.enemyDamage,
                incumbent.shotFeatures.enemyDamage,
            );
            if (
                candidate.features.expectedKill < incumbent.candidate.features.expectedKill ||
                netDamageRatio < 1 ||
                enemyDamageRatio < 1 ||
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
                expectedNetDamageDelta: candidate.features.expectedDamage - incumbent.candidate.features.expectedDamage,
                enemyDamageRatio,
                netDamageRatio,
                minimumDamageRatio: Math.min(netDamageRatio, enemyDamageRatio),
                index,
            });
        }

        return ranked
            .sort((left, right) => compareRanked(left, right, 1))
            .map(({ index: _index, ...candidate }) => candidate);
    }
    if (scope !== DEFAULT_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE) return [];

    const actorAbility = pureRangedParetoNoMeleeFocusActorAbility(actor);
    if (
        !originalState?.eligible ||
        !actorAbility ||
        actor.isDead() ||
        actor.getRangeShots() <= 0 ||
        !Number.isFinite(currentLap) ||
        currentLap < 1 ||
        currentLap >= PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP ||
        !Number.isFinite(damageFloor) ||
        damageFloor < 0.9 ||
        damageFloor > 1 ||
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
        const netDamageRatio = retainedDamageRatio(
            candidate.features.expectedDamage,
            incumbent.candidate.features.expectedDamage,
        );
        const enemyDamageRatio = retainedDamageRatio(
            challenger.shotFeatures.enemyDamage,
            incumbent.shotFeatures.enemyDamage,
        );
        if (
            candidate.features.expectedKill < incumbent.candidate.features.expectedKill ||
            netDamageRatio < damageFloor ||
            enemyDamageRatio < damageFloor ||
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
            expectedNetDamageDelta: candidate.features.expectedDamage - incumbent.candidate.features.expectedDamage,
            enemyDamageRatio,
            netDamageRatio,
            minimumDamageRatio: Math.min(netDamageRatio, enemyDamageRatio),
            index,
        });
    }

    return ranked
        .sort((left, right) => compareRanked(left, right, damageFloor))
        .map(({ index: _index, ...candidate }) => candidate);
}
