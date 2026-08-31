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

import { LUCK_CHANGE_FOR_SHIELD, MORALE_CHANGE_FOR_CLOCK, MORALE_CHANGE_FOR_SHIELD } from "../constants";
import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import { getDoubleShotAbility, hasDoubleShotAbility, withDualStrikeCharm } from "../abilities/ability_helper";
import type { GameAction } from "../engine/actions";
import { canWaitOnHourglass } from "../engine/hourglass";
import { projectPostMoveActorAvailability } from "../engine/post_move_actor_availability";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    getCellsAroundCell,
    getCellsAroundFootprint,
    getFootprintCellsForPosition,
    getPositionForCell,
    getPositionForFootprintAnchor,
    getPositionForCells,
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../grid/grid_math";
import { getCreatureFootprint } from "../configuration/config_provider";
import { ToFactionName } from "../factions/faction_type";
import { AttackHandler, type IPreparedRangeAttackEvaluation } from "../handlers/attack_handler";
import {
    canCastSpell,
    firstSummonableAnchor,
    canMassCastSpell,
    thrownSpellReachesAimedTarget,
    isSpellUsableByCaster,
} from "../spells/spell_helper";
import type { Spell } from "../spells/spell";
import { spellDamageAgainstUnit, spellRawDamage } from "../spells/spell_cast_projection";
import { isOffensiveSpellMultiplier } from "../spells/spell_damage";
import {
    FIRE_WALL_ORIENTATIONS,
    fireWallCells,
    type FireWalls,
    isFireWallableCell,
    normalizeFireWallOrientation,
} from "../spells/fire_walls";
import { isSmokeableCell, SmokeClouds } from "../spells/smoke_clouds";
import { SpellTargetType } from "../spells/spell_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { decisionFireWalls } from "./decision_fight_state";
import { decisionPathSource, type IReadonlyMovePath, type IReadonlyWeightedRoute } from "./decision_path_catalog";
import { meleeAttackTypeSelectionPrefix } from "./melee_attack_type";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

const otherTeam = (team: number): number => (team === LEFT ? RIGHT : LEFT);
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
const haveAdjacentCells = (left: readonly XY[], right: readonly XY[]): boolean => {
    for (const leftCell of left) {
        for (const rightCell of right) {
            if (isAdjacentCell(leftCell, rightCell)) {
                return true;
            }
        }
    }
    return false;
};
const isHidden = (u: Unit): boolean => u.hasBuffActive("Hidden") || u.hasAbilityActive("Hidden");

/**
 * F4 — THE shared enumerated candidate generator (v0.7 roadmap).
 *
 * One enumeration of every ENGINE-LEGAL candidate turn for the acting unit, consumed by the tactical
 * capability modules (Q1), the wide-candidate rollout search (B2/RAWS) and any future learned policy
 * (B3/NEURO). It supersedes lookahead.ts buildCandidates (<=5, melee-only). Design rules:
 *
 *  - CANDIDATE 0 IS ALWAYS THE INCUMBENT decision (the strategy's own v0.6 pick, passed in), so every
 *    consumer inherits the anchor pattern: a consumer that always scores candidate 0 highest reproduces
 *    the shipped behaviour byte-for-byte.
 *  - LEGALITY FIRST: every candidate mirrors the exact checks the GameActionEngine / AttackHandler /
 *    spell_helper run on apply, so a candidate the ranked server would reject is a bug (see the
 *    obstacle-attack world-pos incident: a silently-rejected action class cost days). Enumerated classes:
 *      move          — every reachable destination (pathHelper.getMovePath, footprint-checked)
 *      melee         — every legal (target x stand-cell) pair, in-place and move-and-strike, emitted as
 *                      the measured-better separate move_unit + stationary melee_attack pair
 *      shot          — every enemy x visible-edge aim (incl. alternative aims with DIFFERENT hit sets;
 *                      redundant aims hitting the identical unit set at identical divisors are deduped)
 *      area_throw    — Area Throw (Gargantuan): every legal empty target cell whose splash reaches >=1
 *                      enemy (previously ZERO AI emission for this whole action class)
 *      spell         — every castable spell x target, incl. the MELEE_MAGIC-granted ones: Angel's
 *                      Resurrection (targets living allies with dead bodies; BURNS the on-death passive
 *                      charge — exposed as an opportunity-cost feature), Valkyrie's Wind Flow
 *                      (ALL_FLYING mass), Harpy's Castling (ENEMY_WITHIN_MOVEMENT_RANGE), plus
 *                      heals/buffs/debuffs/summons
 *      mine          — one deterministic reachable strike against a BLOCK_CENTER obstacle (melee for classic
 *                      mountains; melee or ranged for the one-hit objects in a scattered/cemetery layout)
 *      defend        — luck shield (always legal for the acting unit)
 *      wait          — hourglass, when the engine would accept it
 *    Mountain challengers are opt-in so versions predating v0.8 retain their exact candidate set.
 *  - Enumeration is COMPLETE by default; per-class caps are opt-in and every applied cap is reported in
 *    `truncated` so consumers can log it (the "principled top-K with the cap logged" contract).
 *  - DETERMINISTIC and RNG-FREE: never draws from the seeded tournament stream (summon target cells are
 *    picked deterministically, not via getRandomGridCellAroundPosition), so generating candidates cannot
 *    desync a paired A/B or a replay.
 *
 * FEATURIZATION STUB (ICandidateFeatures): every candidate carries the morale/luck-economy and
 * initiative-order fields that were flagged invisible in every prior feature set, plus cheap value/cost
 * stubs. Backlog for consumers to extend: morale-from-move-distance, luck-aura coverage deltas, the
 * target's own morale/luck state, deny-turn (target hasn't acted yet), spell power economy.
 */
export type CandidateKind =
    "incumbent" | "wait" | "defend" | "move" | "melee" | "shot" | "area_throw" | "spell" | "mine";

export interface ICandidateFeatures {
    /** Immediate morale cost/gain of the action ITSELF (wait -3, defend -2; 0 stub for the rest). */
    moraleDelta: number;
    /** Immediate luck gain (defend/luck-shield +3; 0 otherwise). */
    luckDelta: number;
    /** Fraction of LIVING enemies that have not yet acted this lap (v0.5's hourglass/first-mover signal). */
    enemiesNotYetActedFrac: number;
    /** Fraction of LIVING allies (excl. the acting unit) that have not yet acted this lap. */
    alliesNotYetActedFrac: number;
    /** Current lap number (0 when fightProperties is unavailable). */
    lap: number;
    /** 1 when this candidate spends the unit's once-per-lap hourglass. */
    hourglassSpent: 0 | 1;
    /** 1 when this candidate consumes a ranged shot (range_attack / area_throw_attack). */
    spendsRangeShot: 0 | 1;
    /** 1 when this candidate consumes a spell charge (cast_spell). */
    spendsSpellCharge: 0 | 1;
    /**
     * 1 when this cast burns the caster's own on-death Resurrection charge (Angel: the 50%-on-death
     * passive and the castable spell share ONE charge — units_holder.deleteUnitById useSpell()s it).
     * The opportunity cost of casting Resurrection on an ally is losing the Angel's own auto-res.
     */
    burnsResurrectionCharge: 0 | 1;
    /** Hit-weighted damage estimate using engine miss/AOE modifiers; splash friendly-fire subtracts. */
    expectedDamage: number;
    /** 1 when the estimate kills the primary target stack outright. */
    expectedKill: 0 | 1;
}

/**
 * Shot-only observations that are useful to a same-class target/aim scorer. They deliberately stay outside
 * `ICandidateFeatures`: the hardened IL v2 corpus has a fixed 11-value feature vector, and extending that
 * serialized schema requires a separately versioned corpus. These values are deterministic views of signals
 * the v0.5 shot scorer already reads; they do not affect candidate generation or live decisions.
 */
export interface IShotCandidateFeatures {
    /** Expected effective damage to all enemies before friendly-fire is subtracted. */
    enemyDamage: number;
    /** Expected effective damage to allied stacks caught by the shot. */
    friendlyFireDamage: number;
    /** Expected effective damage dealt specifically to the authoritative first stack hit by the trajectory. */
    primaryTargetDamage: number;
    /**
     * Expected effective damage dealt specifically to the stack whose visible edge anchors the action aim.
     * Absent on historical/frozen IL-v3 metadata, which deliberately keeps its existing feature schema.
     */
    aimTargetDamage?: number;
    /** v0.5's target firepower proxy, normalized by 1,000. */
    targetFirepower: number;
    targetLevel: number;
    targetIsRanged: 0 | 1;
    targetCanCastSpells: 0 | 1;
    targetNotYetActed: 0 | 1;
    /** Fraction of the target stack already dead. */
    targetWoundedFraction: number;
    /** v0.5's focus-fire signal: adjacent allied stacks divided by two. */
    targetFocusFire: number;
}

export interface IRangeCandidateDamage {
    value: number;
    kill: 0 | 1;
    enemyDamage: number;
    friendlyFireDamage: number;
    primaryTargetDamage: number;
    aimTargetDamage: number;
}

interface IPreparedRangeCandidateDamage {
    attack: number;
    attackerAbilityPower: number;
    attackerTeam: number;
    enemyAbilityPower: number;
    enemyTeam: number;
    giantsMaulPower?: number;
    isPhysicalAoe: boolean;
    isThroughShot: boolean;
    reducesBrokenAegis: boolean;
    secondVolleyMultiplier: number;
    sharedAbilityMultiplier: number;
}

/** Attacker-only terms shared by every aim considered during one immutable decision. */
function prepareRangeCandidateDamage(
    unit: Unit,
    context: IDecisionContext,
    shots: number,
    isAOE: boolean,
): IPreparedRangeCandidateDamage {
    const attackerTeam = unit.getTeam();
    const enemyTeam = otherTeam(attackerTeam);
    const attackerAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(attackerTeam) ?? 0;
    const enemyAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(enemyTeam) ?? 0;
    const throughShotAbility = unit.getAbility("Through Shot");
    const aoeAbility =
        !throughShotAbility && isAOE ? (unit.getAbility("Area Throw") ?? unit.getAbility("Large Caliber")) : undefined;
    const specialAbility = throughShotAbility ?? aoeAbility;
    const isPhysicalAoe = !!throughShotAbility || !!aoeAbility;
    let sharedAbilityMultiplier = specialAbility
        ? unit.calculateAbilityMultiplier(specialAbility, attackerAbilityPower)
        : 1;
    const paralysis = unit.getEffect("Paralysis");
    if (paralysis) {
        sharedAbilityMultiplier *= (100 - paralysis.getPower()) / 100;
    }
    const giantsMaul = isPhysicalAoe ? unit.getBuff("Giants Maul") : undefined;
    const doubleShotAbility = shots > 1 ? getDoubleShotAbility(unit) : undefined;
    const secondVolleyMultiplier = doubleShotAbility
        ? aoeAbility
            ? 1
            : withDualStrikeCharm(unit.calculateAbilityMultiplier(doubleShotAbility, attackerAbilityPower), unit)
        : 0;
    return {
        attack: unit.getAttack(),
        attackerAbilityPower,
        attackerTeam,
        enemyAbilityPower,
        enemyTeam,
        giantsMaulPower: giantsMaul?.getPower(),
        isPhysicalAoe,
        isThroughShot: !!throughShotAbility,
        reducesBrokenAegis: !!aoeAbility,
        secondVolleyMultiplier,
        sharedAbilityMultiplier,
    };
}

/**
 * Deterministic expected net damage for one authoritative ranged-ray evaluation. Candidate enumeration and
 * independent action qualification share this exact calculation so an engine-valid AOE with greater allied
 * splash is never mislabeled as productive merely because its primary enemy takes damage.
 */
export function evaluateRangeCandidateDamage(
    unit: Unit,
    context: IDecisionContext,
    evaluation: { affectedUnits: Array<Unit[]>; rangeAttackDivisors: number[] },
    primaryTargetId: string | undefined,
    shots: number,
    isAOE: boolean,
    aimTargetId = primaryTargetId,
    attackerAmountAlive = unit.getAmountAlive(),
): IRangeCandidateDamage {
    return evaluatePreparedRangeCandidateDamage(
        unit,
        context,
        evaluation,
        primaryTargetId,
        attackerAmountAlive,
        aimTargetId,
        prepareRangeCandidateDamage(unit, context, shots, isAOE),
    );
}

function evaluatePreparedRangeCandidateDamage(
    unit: Unit,
    context: IDecisionContext,
    evaluation: { affectedUnits: Array<Unit[]>; rangeAttackDivisors: number[] },
    primaryTargetId: string | undefined,
    attackerAmountAlive: number,
    aimTargetId: string | undefined,
    prepared: IPreparedRangeCandidateDamage,
): IRangeCandidateDamage {
    let value = 0;
    let kill: 0 | 1 = 0;
    let enemyDamage = 0;
    let friendlyFireDamage = 0;
    let primaryTargetDamage = 0;
    let aimTargetDamage = 0;
    const counted = new Set<string>();
    const fightProperties = context.fightProperties;
    // Through Shot owns the ranged attack outright when active; Large Caliber / Area Throw use the
    // separate splash tail. Both are physical AOE for damage purposes, but only the latter applies
    // Broken Aegis' incoming-damage reduction. Keep this order identical to the authoritative handlers:
    // ability (and Paralysis), Giant's Maul, target-specific Aegis where applicable, then status resist.
    // Large Caliber / Area Throw's authoritative AOE tail repeats the same full splash when Double Shot
    // exists. Ordinary and Through shots scale their second volley by the Double/Crafted ability and
    // Dual Strike Charm. Through then folds that into its own stack-powered line multiplier.
    // Only Through Shot traverses and damages every ray group. Ordinary attacks and Large Caliber resolve
    // the first impact group; Large Caliber's group already contains its complete 3x3 splash. Counting later
    // screened groups manufactures damage the engine never applies.
    const groupCount = prepared.isThroughShot
        ? evaluation.affectedUnits.length
        : Math.min(1, evaluation.affectedUnits.length);
    for (let i = 0; i < groupCount; i += 1) {
        const divisor = evaluation.rangeAttackDivisors[i] ?? 1;
        for (const target of evaluation.affectedUnits[i]) {
            if (counted.has(target.getId())) {
                continue;
            }
            counted.add(target.getId());
            const minRaw = unit.calculateAttackDamageMin(
                prepared.attack,
                target,
                true,
                prepared.attackerAbilityPower,
                divisor,
                1,
                attackerAmountAlive,
            );
            const maxRaw = unit.calculateAttackDamageMax(
                prepared.attack,
                target,
                true,
                prepared.attackerAbilityPower,
                divisor,
                1,
                attackerAmountAlive,
            );
            const applyEngineVolleyModifiers = (rawDamage: number, volleyMultiplier = 1): number => {
                let adjusted = Math.floor(rawDamage * prepared.sharedAbilityMultiplier * volleyMultiplier);
                if (prepared.isPhysicalAoe) {
                    if (prepared.giantsMaulPower !== undefined) {
                        adjusted = Math.floor(adjusted * (1 + prepared.giantsMaulPower / 100));
                    }
                    if (prepared.reducesBrokenAegis) {
                        const brokenAegis = target.getBuff("Broken Aegis");
                        if (brokenAegis) {
                            adjusted = Math.floor(adjusted * (1 - brokenAegis.getPower() / 100));
                        }
                    }
                    adjusted = Math.floor(adjusted * target.getPhysicalAoeDamageMultiplier());
                }
                return adjusted;
            };
            const firstMin = applyEngineVolleyModifiers(minRaw);
            const firstMax = applyEngineVolleyModifiers(maxRaw);
            const secondMin = prepared.secondVolleyMultiplier
                ? applyEngineVolleyModifiers(minRaw, prepared.secondVolleyMultiplier)
                : 0;
            const secondMax = prepared.secondVolleyMultiplier
                ? applyEngineVolleyModifiers(maxRaw, prepared.secondVolleyMultiplier)
                : 0;
            const hp = target.getCumulativeHp();
            const firstConditionalDamage = (firstMin + firstMax) / 2;
            const secondConditionalDamage = (secondMin + secondMax) / 2;
            const targetTeam = target.getTeam();
            const defenderAbilityPower =
                targetTeam === prepared.attackerTeam
                    ? prepared.attackerAbilityPower
                    : targetTeam === prepared.enemyTeam
                      ? prepared.enemyAbilityPower
                      : (fightProperties?.getAdditionalAbilityPowerPerTeam(targetTeam) ?? 0);
            const hitChance =
                1 - Math.min(100, Math.max(0, unit.calculateMissChance(target, defenderAbilityPower))) / 100;
            const missChance = 1 - hitChance;
            const effective =
                prepared.secondVolleyMultiplier > 0
                    ? hitChance * missChance * Math.min(firstConditionalDamage, hp) +
                      missChance * hitChance * Math.min(secondConditionalDamage, hp) +
                      hitChance * hitChance * Math.min(firstConditionalDamage + secondConditionalDamage, hp)
                    : hitChance * Math.min(firstConditionalDamage, hp);
            if (targetTeam === prepared.enemyTeam) {
                value += effective;
                enemyDamage += effective;
                if (primaryTargetId && target.getId() === primaryTargetId && effective >= hp) {
                    kill = 1;
                }
                if (primaryTargetId && target.getId() === primaryTargetId) {
                    primaryTargetDamage = effective;
                }
                if (aimTargetId && target.getId() === aimTargetId) {
                    aimTargetDamage = effective;
                }
            } else {
                value -= effective;
                friendlyFireDamage += effective;
            }
        }
    }
    return { value, kill, enemyDamage, friendlyFireDamage, primaryTargetDamage, aimTargetDamage };
}

export interface IBestLegalStationaryRangeAttack {
    expectedDamage: number;
    aimTargetId: string;
    primaryTargetId: string;
    aimCell: XY;
    aimSide: RangeAttackCellSide;
}

interface IStationaryRangeAttackProbe {
    readonly aimTargetId: string;
    readonly aimCell: XY;
    readonly aimSide: RangeAttackCellSide;
    readonly prepared: IPreparedRangeAttackEvaluation;
}

interface IStationaryRangeAttackSearch {
    readonly shooter: Unit;
    readonly context: IDecisionContext;
    readonly attackHandler: AttackHandler;
    readonly enemyTeam: number;
    readonly attackerAmountAlive: number;
    readonly isThroughShot: boolean;
    readonly isAOE: boolean;
    readonly forcedTargetId?: string;
    readonly hasCowardice: boolean;
    readonly shooterCumulativeHp: number;
    readonly preparedDamage: IPreparedRangeCandidateDamage;
    readonly probes: readonly IStationaryRangeAttackProbe[];
}

function canUseNativePreparedRangeAttack(attackHandler: AttackHandler): boolean {
    // A wrapped/spied/custom evaluator may deliberately expose calls or alter geometry. Falling back keeps its
    // observable contract; the immutable fast path is reserved for the unmodified authoritative handler.
    return (
        Object.getPrototypeOf(attackHandler) === AttackHandler.prototype &&
        attackHandler.canLandRangeAttack === AttackHandler.prototype.canLandRangeAttack &&
        attackHandler.canBeAttackedByMelee === AttackHandler.prototype.canBeAttackedByMelee &&
        attackHandler.getRangeAttackDivisor === AttackHandler.prototype.getRangeAttackDivisor &&
        attackHandler.evaluateRangeAttack === AttackHandler.prototype.evaluateRangeAttack &&
        attackHandler.prepareRangeAttack === AttackHandler.prototype.prepareRangeAttack &&
        attackHandler.evaluatePreparedRangeAttack === AttackHandler.prototype.evaluatePreparedRangeAttack
    );
}

function prepareStationaryRangeAttackSearch(
    shooter: Unit,
    context: IDecisionContext,
): IStationaryRangeAttackSearch | undefined {
    const attackHandler = context.attackHandler;
    const shooterId = shooter.getId();
    if (
        !attackHandler ||
        !attackHandler.canLandRangeAttack(shooter, context.grid.getEnemyAggrMatrixByUnitId(shooterId)) ||
        !(shooter.getAttackTypeSelection() === RANGE || shooter.getPossibleAttackTypes().includes(RANGE))
    ) {
        return undefined;
    }

    const allUnits = context.unitsHolder.getAllUnits();
    const shooterTeam = shooter.getTeam();
    const enemyTeam = otherTeam(shooterTeam);
    const targets = context.unitsHolder.getAllAllies(enemyTeam).filter((target) => !target.isDead());
    const gridSettings = context.grid.getSettings();
    const matrix = context.matrix;
    const shooterPosition = shooter.getPosition();
    const attackerAmountAlive = shooter.getAmountAlive();
    const isThroughShot = shooter.hasAbilityActive("Through Shot");
    const isAOE = shooter.hasAbilityActive("Large Caliber") || shooter.hasAbilityActive("Area Throw");
    const shots = hasDoubleShotAbility(shooter) ? 2 : 1;
    const preparedDamage = prepareRangeCandidateDamage(shooter, context, shots, isAOE);
    const forcedTarget = allUnits.get(shooter.getTarget());
    const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;
    const hasCowardice = !isThroughShot && shooter.hasStatusApplied("Cowardice");
    const shooterCumulativeHp = hasCowardice ? shooter.getCumulativeHp() : 0;
    const probes: IStationaryRangeAttackProbe[] = [];

    for (const aimTarget of targets) {
        const aimTargetId = aimTarget.getId();
        if (isHidden(aimTarget) || shooter.cannotAttackUnitId(aimTargetId)) continue;
        for (const aimCell of aimTarget.getCells()) {
            for (const aimSide of RANGE_ATTACK_CELL_SIDES) {
                if (!isRangeAttackSideObservable(matrix, aimCell, aimSide, shooterTeam, isThroughShot)) continue;
                const toPosition = getRangeAttackSideCenter(gridSettings, aimCell, aimSide, shooterPosition);
                probes.push({
                    aimTargetId,
                    aimCell,
                    aimSide,
                    prepared: attackHandler.prepareRangeAttack(
                        allUnits,
                        shooter,
                        shooterPosition,
                        toPosition,
                        isThroughShot,
                        false,
                        isAOE,
                    ),
                });
            }
        }
    }

    return {
        shooter,
        context,
        attackHandler,
        enemyTeam,
        attackerAmountAlive,
        isThroughShot,
        isAOE,
        forcedTargetId,
        hasCowardice,
        shooterCumulativeHp,
        preparedDamage,
        probes,
    };
}

function findBestPreparedStationaryRangeAttack(
    search: IStationaryRangeAttackSearch | undefined,
    hypotheticalSmokeCells?: readonly XY[],
): IBestLegalStationaryRangeAttack | undefined {
    if (!search) return undefined;
    const hypotheticalSmokeKeys = hypotheticalSmokeCells?.length
        ? new Set(hypotheticalSmokeCells.map((cell) => SmokeClouds.key(cell)))
        : undefined;
    let best: IBestLegalStationaryRangeAttack | undefined;

    for (const probe of search.probes) {
        const evaluation = search.attackHandler.evaluatePreparedRangeAttack(
            probe.prepared,
            hypotheticalSmokeCells,
            hypotheticalSmokeKeys,
        );
        const primaryTarget = evaluation.affectedUnits[0]?.[0];
        if (
            !primaryTarget ||
            evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length ||
            primaryTarget.isDead() ||
            primaryTarget.getTeam() !== search.enemyTeam ||
            isHidden(primaryTarget)
        ) {
            continue;
        }
        const primaryTargetId = primaryTarget.getId();
        if (
            search.shooter.cannotAttackUnitId(primaryTargetId) ||
            (search.forcedTargetId !== undefined && primaryTargetId !== search.forcedTargetId) ||
            (search.hasCowardice && search.shooterCumulativeHp < primaryTarget.getCumulativeHp()) ||
            (!search.isThroughShot && !search.isAOE && primaryTargetId !== probe.aimTargetId)
        ) {
            continue;
        }
        const damage = evaluatePreparedRangeCandidateDamage(
            search.shooter,
            search.context,
            evaluation,
            primaryTargetId,
            search.attackerAmountAlive,
            probe.aimTargetId,
            search.preparedDamage,
        ).value;
        if (damage > 0 && (!best || damage > best.expectedDamage)) {
            best = {
                expectedDamage: damage,
                aimTargetId: probe.aimTargetId,
                primaryTargetId,
                aimCell: { x: probe.aimCell.x, y: probe.aimCell.y },
                aimSide: probe.aimSide,
            };
        }
    }
    return best;
}

/**
 * The strongest productive stationary ranged action available to one shooter under an optional not-yet-cast
 * Smoke footprint. This deliberately walks the same target-cell/visible-side space as addShots, then delegates
 * trajectory, interception, mountains, Through Shot, falloff and Smoke divisors to AttackHandler. Re-running
 * the complete space for each cloud models rational retargeting: a cloud gets credit only for damage the
 * shooter cannot recover by choosing another visible edge or another stack.
 */
export function findBestLegalStationaryRangeAttack(
    shooter: Unit,
    context: IDecisionContext,
    hypotheticalSmokeCells?: readonly XY[],
): IBestLegalStationaryRangeAttack | undefined {
    const attackHandler = context.attackHandler;
    const shooterId = shooter.getId();
    if (
        !attackHandler ||
        !attackHandler.canLandRangeAttack(shooter, context.grid.getEnemyAggrMatrixByUnitId(shooterId)) ||
        !(shooter.getAttackTypeSelection() === RANGE || shooter.getPossibleAttackTypes().includes(RANGE))
    ) {
        return undefined;
    }

    const allUnits = context.unitsHolder.getAllUnits();
    const shooterTeam = shooter.getTeam();
    const enemyTeam = otherTeam(shooterTeam);
    const targets = context.unitsHolder.getAllAllies(enemyTeam).filter((target) => !target.isDead());
    const gridSettings = context.grid.getSettings();
    const matrix = context.matrix;
    const shooterPosition = shooter.getPosition();
    const attackerAmountAlive = shooter.getAmountAlive();
    const isThroughShot = shooter.hasAbilityActive("Through Shot");
    const isAOE = shooter.hasAbilityActive("Large Caliber") || shooter.hasAbilityActive("Area Throw");
    const shots = hasDoubleShotAbility(shooter) ? 2 : 1;
    const preparedDamage = prepareRangeCandidateDamage(shooter, context, shots, isAOE);
    const forcedTarget = allUnits.get(shooter.getTarget());
    const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;
    const hasCowardice = !isThroughShot && shooter.hasStatusApplied("Cowardice");
    const shooterCumulativeHp = hasCowardice ? shooter.getCumulativeHp() : 0;
    const hypotheticalSmokeKeys = hypotheticalSmokeCells?.length
        ? new Set(hypotheticalSmokeCells.map((cell) => SmokeClouds.key(cell)))
        : undefined;
    let best: IBestLegalStationaryRangeAttack | undefined;

    for (const aimTarget of targets) {
        const aimTargetId = aimTarget.getId();
        if (isHidden(aimTarget) || shooter.cannotAttackUnitId(aimTargetId)) continue;
        for (const aimCell of aimTarget.getCells()) {
            for (const aimSide of RANGE_ATTACK_CELL_SIDES) {
                if (!isRangeAttackSideObservable(matrix, aimCell, aimSide, shooterTeam, isThroughShot)) continue;
                const to = getRangeAttackSideCenter(gridSettings, aimCell, aimSide, shooterPosition);
                const evaluation = attackHandler.evaluateRangeAttack(
                    allUnits,
                    shooter,
                    shooterPosition,
                    to,
                    isThroughShot,
                    false,
                    isAOE,
                    hypotheticalSmokeCells,
                    hypotheticalSmokeKeys,
                );
                const primaryTarget = evaluation.affectedUnits[0]?.[0];
                if (
                    !primaryTarget ||
                    evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length ||
                    primaryTarget.isDead() ||
                    primaryTarget.getTeam() !== enemyTeam ||
                    isHidden(primaryTarget)
                ) {
                    continue;
                }
                const primaryTargetId = primaryTarget.getId();
                if (
                    shooter.cannotAttackUnitId(primaryTargetId) ||
                    (forcedTargetId !== undefined && primaryTargetId !== forcedTargetId) ||
                    (hasCowardice && shooterCumulativeHp < primaryTarget.getCumulativeHp()) ||
                    (!isThroughShot && !isAOE && primaryTargetId !== aimTargetId)
                ) {
                    continue;
                }
                const damage = evaluatePreparedRangeCandidateDamage(
                    shooter,
                    context,
                    evaluation,
                    primaryTargetId,
                    attackerAmountAlive,
                    aimTargetId,
                    preparedDamage,
                ).value;
                if (damage > 0 && (!best || damage > best.expectedDamage)) {
                    best = {
                        expectedDamage: damage,
                        aimTargetId,
                        primaryTargetId,
                        aimCell: { x: aimCell.x, y: aimCell.y },
                        aimSide,
                    };
                }
            }
        }
    }
    return best;
}

export interface IEnumeratedCandidate {
    kind: CandidateKind;
    /** Ordered engine actions implementing the candidate (same convention as IAIStrategy.decideTurn). */
    actions: GameAction[];
    /** Engine-resolved primary target unit id (attacks) or declared recipient (targeted spells). */
    targetId?: string;
    /** Enemy stack used by v0.8s target-pressure scheduling when engine interception makes targetId an ally. */
    pressureTargetId?: string;
    /** Experiment-only kill estimate for pressureTargetId when it differs from the engine-primary targetId. */
    pressureExpectedKill?: 0 | 1;
    /** Spell name for kind === "spell". */
    spellName?: string;
    /** Move destination / area-throw aim cell / summon cell (base cell for large units). */
    targetCell?: XY;
    /** Melee stand cell (the attackFrom base cell). */
    standCell?: XY;
    /** Deterministic shot-only metadata; absent for non-shot candidates. */
    shotFeatures?: IShotCandidateFeatures;
    /** Research-only marker for the one exact Rapid Charge challenger retained across a capped melee catalog. */
    researchRapidChargeDifferentTargetReserved?: true;
    features: ICandidateFeatures;
}

export interface IEnumerateOptions {
    /** Cap on move destinations, kept nearest-to-enemy first (0/undefined = all reachable). */
    maxMoveDestinations?: number;
    /**
     * Optional consumer-specific move gate applied before maxMoveDestinations. This lets a role-aware caller
     * retain the nearest move satisfying a hard geometry contract instead of capping first and accidentally
     * erasing the entire legal role-preserving move class. Default undefined keeps every existing consumer's
     * candidate set and ordering exact.
     */
    retainMoveCandidateBeforeCap?: (candidate: Readonly<IEnumeratedCandidate>) => boolean;
    /**
     * Opt-in capped-move diversity for ranged-posture search. When both classes exist, retain the nearest
     * closing move and the least-retreating non-closing move; a cap of one expands to two so neither posture is
     * erased. Default false so historical capped consumers, including v0.7 search, keep their exact ordering.
     */
    preserveMovePostureDiversity?: boolean;
    /** Cap on melee (target x stand-cell) pairs, kept by expected damage (0/undefined = all). */
    maxMeleePairs?: number;
    /**
     * Research-only Rapid Charge catalog arm. When the incumbent is a non-lethal melee attack, preserve at most
     * one strictly stronger, supported long-charge challenger against a different target across maxMeleePairs.
     * Default false leaves candidate values, ordering, and caps byte-identical for every production consumer.
     */
    researchReserveRapidChargeDifferentTarget?: boolean;
    /** Cap on ranged aims, kept by expected damage (0/undefined = all distinct hit sets). */
    maxShotAims?: number;
    /**
     * Experimental move-then-shot challengers. Values above two are clamped to two; 0/undefined disables the
     * class completely so every existing consumer retains byte-identical actions and candidate ordering.
     */
    maxMoveShotComposites?: number;
    /**
     * Let the bounded move-shot probe discover a newly opened line when no stationary shot exists. The ordinary
     * probe only repositions an existing exact aim; this opt-in is reserved for the lap-9 terminal finisher.
     */
    discoverMoveShotTargetsAfterMove?: boolean;
    /** Cap on area-throw target cells, kept by expected damage (0/undefined = all relevant). */
    maxAreaThrowCells?: number;
    /**
     * Experimental late-finish coverage: when an attack-class cap is active, retain its best delivery to every
     * distinct primary target before filling the remaining budget. The effective budget expands to at least the
     * number of targets. Default false so every existing strategy/search arm keeps byte-identical enumeration.
     */
    preserveAttackTargetCoverage?: boolean;
    /** Opt in to deterministic BLOCK_CENTER melee-mining challengers (v0.8 search only). */
    includeMountainAttacks?: boolean;
    /**
     * Metadata enrichment for candidate 0. When its exact action is rediscovered by the generator (or is an
     * exact legal move-shot handled by the bounded incumbent probe), copy those observations onto the anchor.
     * Default false; actions, ordering, deduplication, and challenger caps are unchanged.
     */
    enrichIncumbentMetadata?: boolean;
}

interface IAttackCapView<T> {
    readonly value: T;
    readonly index: number;
    readonly targetId: string;
    readonly expectedDamage: number;
    readonly expectedKill: 0 | 1;
    readonly stationary: boolean;
}

/**
 * Apply an opt-in attack cap without erasing a target from the candidate set. Per-target delivery is ordered by
 * kill, expected damage, stationary-over-move, then stable source order. Remaining slots use the same order.
 */
function capAttackCandidates<T>(
    values: readonly T[],
    cap: number,
    preserveTargetCoverage: boolean,
    view: (value: T, index: number) => Omit<IAttackCapView<T>, "value" | "index">,
): T[] {
    if (cap <= 0 || values.length <= cap) {
        return values as T[];
    }
    if (!preserveTargetCoverage) {
        return [...values]
            .map((value, index) => ({ value, index, ...view(value, index) }))
            .sort((left, right) => right.expectedDamage - left.expectedDamage || left.index - right.index)
            .slice(0, cap)
            .map(({ value }) => value);
    }

    const annotated: IAttackCapView<T>[] = values.map((value, index) => ({ value, index, ...view(value, index) }));
    const precedes = (left: IAttackCapView<T>, right: IAttackCapView<T>): boolean =>
        left.expectedKill > right.expectedKill ||
        (left.expectedKill === right.expectedKill &&
            (left.expectedDamage > right.expectedDamage ||
                (left.expectedDamage === right.expectedDamage &&
                    ((left.stationary && !right.stationary) ||
                        (left.stationary === right.stationary && left.index < right.index)))));
    const bestByTarget = new Map<string, IAttackCapView<T>>();
    for (const candidate of annotated) {
        const best = bestByTarget.get(candidate.targetId);
        if (!best || precedes(candidate, best)) {
            bestByTarget.set(candidate.targetId, candidate);
        }
    }

    const coverage = [...bestByTarget.values()];
    const coverageIndices = new Set(coverage.map(({ index }) => index));
    const fill = annotated
        .filter(({ index }) => !coverageIndices.has(index))
        .sort((left, right) => {
            if (precedes(left, right)) return -1;
            if (precedes(right, left)) return 1;
            return 0;
        });
    return [...coverage, ...fill].slice(0, Math.max(cap, bestByTarget.size)).map(({ value }) => value);
}

export interface ICandidateSet {
    /** Candidate 0 is ALWAYS the incumbent decision passed in. */
    candidates: IEnumeratedCandidate[];
    /** Candidate classes whose enumeration hit a cap — consumers should log these. */
    truncated: CandidateKind[];
}

/**
 * Base cells of SMALL living enemies standing within the unit's movement range — the legality input for
 * ENEMY_WITHIN_MOVEMENT_RANGE spells (Harpy's Castling). Mirrors the client's arming path
 * (Sandbox.currentEnemiesCellsWithinMovementRange): pathing runs on grid.getMatrixNoUnits() (enemy-occupied
 * cells must be REACHABLE-through, not blocked), no aggro board, small/fly/lava flags from the unit.
 *
 * Exported for consumers to wire into IGameActionEngineContext.getCurrentEnemiesCellsWithinMovementRange —
 * the engine's castSpell re-validates against that context callback, so the SAME list must be visible on
 * both sides or the cast is rejected (battle_engine currently wires neither; see roadmap F4/Q1-M1).
 */
export function getEnemiesCellsWithinMovementRange(unit: Unit, context: IDecisionContext): XY[] {
    const provided = context.getCurrentEnemiesCellsWithinMovementRange?.();
    if (provided) {
        return provided;
    }
    if (!unit.canMove()) {
        return [];
    }
    const moveCells = context.pathHelper.getMovePath(
        unit.getBaseCell(),
        context.grid.getMatrixNoUnits(),
        unit.getSteps(),
        undefined,
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    ).cells;
    const out: XY[] = [];
    for (const c of moveCells) {
        const enemyId = context.grid.getOccupantUnitId(c);
        if (!enemyId) {
            continue;
        }
        const enemy = context.unitsHolder.getAllUnits().get(enemyId);
        if (!enemy || enemy.isDead() || enemy.getTeam() === unit.getTeam() || !enemy.isSmallSize()) {
            continue;
        }
        out.push(enemy.getBaseCell());
    }
    return out;
}

export function enumerateCandidates(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options: IEnumerateOptions = {},
): ICandidateSet {
    const gen = new CandidateGenerator(unit, context, options);
    return gen.enumerate(incumbent);
}

/** Internal single-use builder (one instance per decision; caches shared per-decision state). */
class CandidateGenerator {
    private readonly unit: Unit;
    private readonly context: IDecisionContext;
    private readonly options: IEnumerateOptions;
    private readonly enemyTeam: number;
    private readonly enemies: Unit[];
    private readonly allies: Unit[];
    private readonly candidates: IEnumeratedCandidate[] = [];
    private readonly truncated: CandidateKind[] = [];
    private readonly seen = new Set<string>();
    private readonly shared: Pick<ICandidateFeatures, "enemiesNotYetActedFrac" | "alliesNotYetActedFrac" | "lap">;
    private movePathCache?: IReadonlyMovePath;
    private incumbentSignature?: string;
    private preparedRangeDamage?: {
        shots: number;
        isAOE: boolean;
        value: IPreparedRangeCandidateDamage;
    };
    public constructor(unit: Unit, context: IDecisionContext, options: IEnumerateOptions) {
        this.unit = unit;
        this.context = context;
        this.options = options;
        this.enemyTeam = otherTeam(unit.getTeam());
        this.enemies = context.unitsHolder.getAllAllies(this.enemyTeam).filter((e) => !e.isDead());
        this.allies = context.unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        this.shared = this.sharedFeatures();
    }
    public enumerate(incumbent: GameAction[]): ICandidateSet {
        // Candidate 0 — the incumbent (anchor). Never deduped away; everything else dedupes against it.
        this.push({
            kind: "incumbent",
            actions: incumbent,
            features: this.features(this.incumbentFeatureOverrides(incumbent)),
        });
        this.addWait();
        this.addDefend();
        this.addMelee();
        this.addMountainAttack();
        this.addShots();
        this.addAreaThrows();
        this.addSpells();
        this.addMoves();
        return { candidates: this.candidates, truncated: this.truncated };
    }
    // ---- shared feature plumbing ---------------------------------------------------------------
    private sharedFeatures(): Pick<ICandidateFeatures, "enemiesNotYetActedFrac" | "alliesNotYetActedFrac" | "lap"> {
        const fp = this.context.fightProperties;
        const frac = (units: Unit[]): number => {
            if (!fp || !units.length) {
                return 0;
            }
            const notActed = units.filter((u) => !fp.hasAlreadyMadeTurn(u.getId())).length;
            return notActed / units.length;
        };
        return {
            enemiesNotYetActedFrac: frac(this.enemies),
            alliesNotYetActedFrac: frac(this.allies),
            lap: fp?.getCurrentLap() ?? 0,
        };
    }
    private features(overrides: Partial<ICandidateFeatures> = {}): ICandidateFeatures {
        return {
            moraleDelta: 0,
            luckDelta: 0,
            hourglassSpent: 0,
            spendsRangeShot: 0,
            spendsSpellCharge: 0,
            burnsResurrectionCharge: 0,
            expectedDamage: 0,
            expectedKill: 0,
            ...this.shared,
            ...overrides,
        };
    }
    /**
     * Resurrection's cast and Angel's on-death passive share one stored charge. Active-ability queries are
     * intentionally unsuitable here: Break temporarily hides abilities but does not remove the castable spell,
     * and casting while Broken still permanently consumes both the spell and the persisted passive.
     */
    private ownsResurrectionCharge(): boolean {
        return (
            this.unit.getUnitProperties().abilities.includes("Resurrection") &&
            this.unit.getSpells().some((spell) => spell.getName() === "Resurrection" && spell.isRemaining())
        );
    }
    /** Derive the cheap economy features of an arbitrary (incumbent) action list. */
    private incumbentFeatureOverrides(actions: GameAction[]): Partial<ICandidateFeatures> {
        const o: Partial<ICandidateFeatures> = {};
        for (const a of actions) {
            if (a.type === "wait_turn") {
                o.moraleDelta = -MORALE_CHANGE_FOR_CLOCK;
                o.hourglassSpent = 1;
            } else if (a.type === "defend_turn") {
                o.moraleDelta = -MORALE_CHANGE_FOR_SHIELD;
                o.luckDelta = LUCK_CHANGE_FOR_SHIELD;
            } else if (a.type === "range_attack" || a.type === "area_throw_attack") {
                o.spendsRangeShot = 1;
            } else if (a.type === "cast_spell") {
                o.spendsSpellCharge = 1;
                if (a.spellName === "Resurrection" && this.ownsResurrectionCharge()) {
                    o.burnsResurrectionCharge = 1;
                }
            }
        }
        return o;
    }
    // ---- dedupe ---------------------------------------------------------------------------------
    /** Canonical identity of an action list (field-order independent), for dedupe vs the incumbent. */
    private signature(actions: GameAction[]): string {
        const cell = (c?: XY): string => (c ? `${c.x},${c.y}` : "-");
        let result = "";
        for (const action of actions) {
            let part: string;
            switch (action.type) {
                case "select_attack_type":
                    part = `sel:${action.attackType}`;
                    break;
                case "move_unit":
                    part = `mv:${cell(action.path[action.path.length - 1])}`;
                    break;
                case "melee_attack":
                    part = `ml:${action.targetId}@${cell(action.attackFrom)}`;
                    break;
                case "range_attack":
                    part = `rg:${action.targetId}@${cell(action.aimCell)}/${action.aimSide ?? "-"}`;
                    break;
                case "area_throw_attack":
                    part = `at:${cell(action.targetCell)}`;
                    break;
                case "cast_spell": {
                    // Fire Wall rotations at one anchor cover different cells and are therefore distinct
                    // engine actions. Other spells ignore targetOrientation, so keep their historical
                    // identity stable even if a malformed caller supplies one.
                    const orientation =
                        action.spellName === "Fire Wall"
                            ? `/${normalizeFireWallOrientation(action.targetOrientation)}`
                            : "";
                    part = `cs:${action.spellName}>${action.targetId ?? "-"}@${cell(action.targetCell)}${orientation}`;
                    break;
                }
                case "obstacle_attack":
                    part = `mn:${cell(action.targetPosition)}@${cell(action.attackFrom)}`;
                    break;
                default:
                    part = action.type;
            }
            result += result ? `|${part}` : part;
        }
        return result;
    }
    private push(cand: IEnumeratedCandidate): boolean {
        const sig = this.signature(cand.actions);
        if (this.seen.has(sig)) {
            this.enrichIncumbentCandidate(cand, sig);
            return false;
        }
        this.seen.add(sig);
        this.candidates.push(cand);
        if (this.candidates.length === 1) {
            this.incumbentSignature = sig;
        }
        return true;
    }
    /**
     * Candidate 0 is intentionally retained when enumeration rediscovers the incumbent action. A duplicate
     * generated candidate nevertheless has information the raw incumbent action list cannot carry, so copy
     * that observation onto the anchor without changing its kind, actions, identity, or position. Shot
     * enrichment predates IL v3 and remains unconditional; other classes are explicitly opt-in.
     */
    private enrichIncumbentCandidate(cand: IEnumeratedCandidate, sig = this.signature(cand.actions)): void {
        const incumbent = this.candidates[0];
        if (!incumbent || incumbent.kind !== "incumbent" || this.incumbentSignature !== sig) {
            return;
        }
        if (!this.options.enrichIncumbentMetadata) {
            if (cand.kind === "shot") {
                // Preserve the historical shot-only enrichment object shape and assignments exactly.
                incumbent.targetId = cand.targetId;
                incumbent.shotFeatures = cand.shotFeatures;
                incumbent.features.spendsRangeShot = cand.features.spendsRangeShot;
                incumbent.features.expectedDamage = cand.features.expectedDamage;
                incumbent.features.expectedKill = cand.features.expectedKill;
            }
            return;
        }
        incumbent.targetId = cand.targetId;
        if (cand.pressureTargetId !== undefined) incumbent.pressureTargetId = cand.pressureTargetId;
        if (cand.pressureExpectedKill !== undefined) incumbent.pressureExpectedKill = cand.pressureExpectedKill;
        incumbent.spellName = cand.spellName;
        incumbent.targetCell = cand.targetCell ? { ...cand.targetCell } : undefined;
        incumbent.standCell = cand.standCell ? { ...cand.standCell } : undefined;
        incumbent.shotFeatures = cand.shotFeatures;
        incumbent.features = { ...cand.features };
    }
    // ---- wait / defend ---------------------------------------------------------------------------
    /** Hourglass — mirrors GameActionEngine.canWaitOnHourglass exactly. */
    private addWait(): void {
        const fp = this.context.fightProperties;
        const id = this.unit.getId();
        if (!fp || !canWaitOnHourglass(this.unit, fp, this.context.unitsHolder.getAllUnits())) {
            return;
        }
        this.push({
            kind: "wait",
            actions: [{ type: "wait_turn", unitId: id }],
            features: this.features({ moraleDelta: -MORALE_CHANGE_FOR_CLOCK, hourglassSpent: 1 }),
        });
    }
    /** Luck shield — always accepted for the acting unit (validateTurnAction only). */
    private addDefend(): void {
        this.push({
            kind: "defend",
            actions: [{ type: "defend_turn", unitId: this.unit.getId() }],
            features: this.features({ moraleDelta: -MORALE_CHANGE_FOR_SHIELD, luckDelta: LUCK_CHANGE_FOR_SHIELD }),
        });
    }
    // ---- movement --------------------------------------------------------------------------------
    private movePath(): IReadonlyMovePath | undefined {
        if (!this.unit.canMove()) {
            return undefined;
        }
        if (!this.movePathCache) {
            this.movePathCache = decisionPathSource(this.context).getMovePath(
                this.unit.getBaseCell(),
                this.context.matrix,
                this.unit.getSteps(),
                this.context.grid.getAggrMatrixByTeam(this.enemyTeam),
                this.unit.canFly(),
                this.unit.isSmallSize(),
                this.unit.canTraverseLava(),
                this.unit.hasAbilityActive("In Its Own World"),
                this.unit.getFootprintWidth(),
                this.unit.getFootprintHeight(),
            );
        }
        return this.movePathCache;
    }
    /**
     * The unit's real body at a candidate anchor. This is what becomes every generated candidate's
     * `move_unit.targetCells`, so it is also the shape the engine will occupy — the round trip through
     * `getPositionForCell(...) - halfStep` into `getCellsAroundPosition` it replaces could only ever describe
     * a 2x2, and handed a rectangle a body two cells too tall that the engine then refused as `invalid_move`.
     * Routed through the position so the two shipped shapes keep their exact legacy cell ORDER — this list is
     * iterated by the mountain-strike search, where the order decides which of two equidistant mountains a
     * large unit mines, and the ordering the generic anchor expansion produces is not the one that has always
     * come out of getCellsAroundPosition.
     */
    private footprintForCell(cell: XY): XY[] {
        const gs = this.context.grid.getSettings();
        return getFootprintCellsForPosition(
            gs,
            getPositionForFootprintAnchor(gs, cell, this.unit.getFootprintWidth(), this.unit.getFootprintHeight()),
            this.unit.getFootprintWidth(),
            this.unit.getFootprintHeight(),
        );
    }
    private footprintOk(cell: XY): boolean {
        return this.context.grid.canOccupyFootprintAt(
            cell,
            this.unit.getFootprintWidth(),
            this.unit.getFootprintHeight(),
            this.unit.canTraverseLava(),
            this.unit.hasAbilityActive("Made of Water"),
            this.unit.getId(),
        );
    }
    private moveAction(route: IReadonlyWeightedRoute): Extract<GameAction, { type: "move_unit" }> {
        return {
            type: "move_unit",
            unitId: this.unit.getId(),
            path: route.route.map((c) => ({ x: c.x, y: c.y })),
            targetCells: this.footprintForCell(route.cell),
            hasLavaCell: route.hasLavaCell,
            hasWaterCell: route.hasWaterCell,
        };
    }
    private meleeCumulativeHpAfterMove(
        route: IReadonlyWeightedRoute,
        hasCowardice: boolean,
        currentCumulativeHp: number,
        fireWalls: FireWalls,
    ): number | undefined {
        // The projection can only remove a stack through Fire Wall damage. Without a wall it matters to melee
        // legality solely when Cowardice needs the Made-of-Fire max-HP increase from a lava route. Avoid cloning
        // every path into a temporary action for the overwhelmingly common wall-free, non-Cowardice decision.
        if (!fireWalls.size() && (!hasCowardice || !route.hasLavaCell)) {
            return this.unit.getAmountAlive() > 0 ? currentCumulativeHp : undefined;
        }
        const action = this.moveAction(route);
        if (action.type !== "move_unit") {
            return currentCumulativeHp;
        }
        const projection = projectPostMoveActorAvailability(this.unit, fireWalls, action);
        if (!projection.availableAfterMove) {
            return undefined;
        }
        return (projection.stack.amountAlive - 1) * projection.stack.maxHp + Math.max(0, projection.stack.hp);
    }
    /** Every reachable destination (or nearest-to-enemy top-K when capped). */
    private addMoves(): void {
        const movePath = this.movePath();
        if (!movePath) {
            return;
        }
        const base = this.unit.getBaseCell();
        let routes: IReadonlyWeightedRoute[] = [];
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            if (route.cell.x === base.x && route.cell.y === base.y) {
                continue;
            }
            if (!this.footprintOk(route.cell)) {
                continue;
            }
            routes.push(route);
        }
        const candidateOf = (route: IReadonlyWeightedRoute): IEnumeratedCandidate => ({
            kind: "move",
            actions: [this.moveAction(route)],
            targetCell: { x: route.cell.x, y: route.cell.y },
            features: this.features(),
        });
        if (this.options.retainMoveCandidateBeforeCap) {
            routes = routes.filter((route) => this.options.retainMoveCandidateBeforeCap?.(candidateOf(route)));
        }
        const cap = this.options.maxMoveDestinations ?? 0;
        let kept = routes;
        if (cap > 0 && routes.length > cap) {
            // Principled top-K: nearest-to-an-enemy destinations first (v0.1 fallbackTurn's advance metric);
            // stable sort keeps enumeration order on ties -> deterministic.
            const dist = (cell: XY): number =>
                this.enemies.length
                    ? this.enemies.reduce((best, enemy) => {
                          const enemyCell = enemy.getBaseCell();
                          return Math.min(best, Math.abs(cell.x - enemyCell.x) + Math.abs(cell.y - enemyCell.y));
                      }, Number.POSITIVE_INFINITY)
                    : 0;
            const ranked = routes
                .map((route, index) => ({ route, index, distance: dist(route.cell) }))
                .sort((a, b) => a.distance - b.distance || a.index - b.index);
            if (this.options.preserveMovePostureDiversity === true) {
                const currentDistance = dist(base);
                const closing = ranked.find(({ distance }) => distance < currentDistance);
                const nonClosing = ranked.find(({ distance }) => distance >= currentDistance);
                if (closing && nonClosing) {
                    const required = new Set([closing.index, nonClosing.index]);
                    const budget = Math.max(cap, required.size);
                    kept = [closing, nonClosing, ...ranked.filter(({ index }) => !required.has(index))]
                        .slice(0, budget)
                        .map(({ route }) => route);
                } else {
                    kept = ranked.slice(0, cap).map(({ route }) => route);
                }
            } else {
                kept = ranked.slice(0, cap).map(({ route }) => route);
            }
            if (kept.length < routes.length) this.truncated.push("move");
        }
        if (this.options.enrichIncumbentMetadata) {
            for (const route of routes) this.enrichIncumbentCandidate(candidateOf(route));
        }
        for (const route of kept) {
            this.push(candidateOf(route));
        }
    }
    // ---- melee -------------------------------------------------------------------------------------
    private canMelee(): boolean {
        if (this.unit.hasAbilityActive("No Melee")) {
            return false;
        }
        const sel = this.unit.getAttackTypeSelection();
        if (sel === MELEE || sel === MELEE_MAGIC) {
            return true;
        }
        const possible = this.unit.getPossibleAttackTypes();
        return possible.includes(MELEE) || possible.includes(MELEE_MAGIC);
    }
    private meleeTargets(): Unit[] {
        // Mirrors AttackHandler.handleMeleeAttack's guards: never a Hidden target, never a Cowardice-blocked
        // one, when the unit carries a FORCED target (aggro) only that enemy is accepted, and when Terrifying
        // Gaze has frightened it, the one gazer it may not touch is dropped.
        const forcedTarget = this.context.unitsHolder.getAllUnits().get(this.unit.getTarget());
        const forced = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;
        return this.enemies.filter((e) => {
            if (isHidden(e)) {
                return false;
            }
            if (this.unit.hasStatusApplied("Cowardice") && this.unit.getCumulativeHp() < e.getCumulativeHp()) {
                return false;
            }
            if (forced && forced !== e.getId()) {
                return false;
            }
            if (this.unit.cannotAttackUnitId(e.getId())) {
                return false;
            }
            return true;
        });
    }
    private meleeDamage(target: Unit): { effective: number; kill: 0 | 1 } {
        const atkMul = this.unit.hasAbilityActive("Double Punch") ? 2 : 1;
        // Unit.calculateAttackDamage applies this after rolling the raw melee damage. Keep candidate metadata on
        // that authoritative scale: native shooters deal half melee damage unless Handyman removes the penalty.
        const nativeRangedMeleeMultiplier =
            this.unit.getAttackType() === RANGE && !this.unit.hasAbilityActive("Handyman") ? 0.5 : 1;
        const min =
            atkMul *
            Math.floor(
                this.unit.calculateAttackDamageMin(this.unit.getAttack(), target, false, 0, 1) *
                    nativeRangedMeleeMultiplier,
            );
        const max =
            atkMul *
            Math.floor(
                this.unit.calculateAttackDamageMax(this.unit.getAttack(), target, false, 0, 1) *
                    nativeRangedMeleeMultiplier,
            );
        const hp = target.getCumulativeHp();
        const effective = Math.min((min + max) / 2, hp);
        return { effective, kill: effective >= hp ? 1 : 0 };
    }
    /** Every legal (target x stand-cell) pair: in-place strikes + move-and-strike over reachable cells. */
    private addMelee(): void {
        if (!this.canMelee()) {
            return;
        }
        const targets = this.meleeTargets();
        if (!targets.length) {
            return;
        }
        const base = this.unit.getBaseCell();
        const myCells = this.unit.getCells();
        const prefix = meleeAttackTypeSelectionPrefix(this.unit);
        const hasCowardice = this.unit.hasStatusApplied("Cowardice");
        const currentCumulativeHp = this.unit.getCumulativeHp();
        const fireWalls = decisionFireWalls(this.context);

        interface IMeleeTarget {
            unit: Unit;
            cells: XY[];
            damage?: { effective: number; kill: 0 | 1 };
        }
        interface IMeleePair {
            target: Unit;
            cell: XY;
            route?: IReadonlyWeightedRoute;
            effective: number;
            kill: 0 | 1;
            sourceIndex: number;
        }
        const targetViews: IMeleeTarget[] = targets.map((target) => ({ unit: target, cells: target.getCells() }));
        const pairs: IMeleePair[] = [];
        const pair = (target: IMeleeTarget, cell: XY, route?: IReadonlyWeightedRoute): IMeleePair => {
            target.damage ??= this.meleeDamage(target.unit);
            return {
                target: target.unit,
                cell,
                route,
                ...target.damage,
                sourceIndex: pairs.length,
            };
        };
        // In-place strikes: enemies already adjacent to the current footprint.
        for (const e of targetViews) {
            if (haveAdjacentCells(e.cells, myCells)) {
                pairs.push(pair(e, base));
            }
        }
        // Move-and-strike: every reachable stand cell whose footprint is adjacent to a target.
        const movePath = this.movePath();
        if (movePath) {
            for (const routeList of movePath.knownPaths.values()) {
                const route = routeList[0];
                if (!route?.route.length || !this.footprintOk(route.cell)) {
                    continue;
                }
                const moved = route.cell.x !== base.x || route.cell.y !== base.y;
                const postMoveCumulativeHp = moved
                    ? this.meleeCumulativeHpAfterMove(route, hasCowardice, currentCumulativeHp, fireWalls)
                    : currentCumulativeHp;
                if (postMoveCumulativeHp === undefined) {
                    continue;
                }
                const fpCells = this.footprintForCell(route.cell);
                for (const e of targetViews) {
                    if (hasCowardice && postMoveCumulativeHp < e.unit.getCumulativeHp()) {
                        continue;
                    }
                    if (haveAdjacentCells(fpCells, e.cells)) {
                        pairs.push(pair(e, route.cell, route));
                    }
                }
            }
        }

        const actionsOf = (p: IMeleePair): GameAction[] => {
            const actions: GameAction[] = [...prefix];
            // Move-and-strike is emitted as a SEPARATE move_unit + stationary melee_attack — the pattern
            // v0.5 measured ~+2.5pp over folding the path into the melee_attack (the standalone move runs
            // the full move handler). The ranked client folds the pair back for transport.
            if (p.route && (p.cell.x !== base.x || p.cell.y !== base.y)) {
                actions.push(this.moveAction(p.route));
            }
            actions.push({
                type: "melee_attack",
                attackerId: this.unit.getId(),
                targetId: p.target.getId(),
                attackFrom: { x: p.cell.x, y: p.cell.y },
            });
            return actions;
        };

        let reservedRapidChargePair: IMeleePair | undefined;
        if (
            this.options.researchReserveRapidChargeDifferentTarget === true &&
            this.unit.hasAbilityActive("Rapid Charge")
        ) {
            const incumbentActions = this.candidates[0]?.actions;
            const incumbentMelee = incumbentActions?.find(
                (action): action is Extract<GameAction, { type: "melee_attack" }> =>
                    action.type === "melee_attack" && action.attackerId === this.unit.getId(),
            );
            const incumbentTarget = incumbentMelee
                ? this.context.unitsHolder.getAllUnits().get(incumbentMelee.targetId)
                : undefined;
            const incumbentEstimate =
                incumbentActions && incumbentMelee && incumbentTarget && !incumbentTarget.isDead()
                    ? estimatePrimaryMeleeDamage(
                          this.unit,
                          incumbentTarget,
                          this.context,
                          incumbentMelee.attackFrom,
                          incumbentActions,
                      )
                    : undefined;
            if (incumbentMelee && incumbentEstimate && !incumbentEstimate.secureKill) {
                let bestDamage = incumbentEstimate.expectedEffectiveDamage;
                let bestRouteLength = -1;
                let bestSourceIndex = Number.MAX_SAFE_INTEGER;
                for (const candidate of pairs) {
                    const routeLength = candidate.route?.route.length ?? 0;
                    if (
                        candidate.target.getId() === incumbentMelee.targetId ||
                        routeLength < 3 ||
                        candidate.route?.hasLavaCell ||
                        candidate.route?.hasWaterCell
                    ) {
                        continue;
                    }
                    const estimate = estimatePrimaryMeleeDamage(
                        this.unit,
                        candidate.target,
                        this.context,
                        candidate.cell,
                        actionsOf(candidate),
                    );
                    if (!estimate || estimate.expectedEffectiveDamage <= incumbentEstimate.expectedEffectiveDamage) {
                        continue;
                    }
                    if (
                        estimate.expectedEffectiveDamage > bestDamage ||
                        (estimate.expectedEffectiveDamage === bestDamage &&
                            (routeLength > bestRouteLength ||
                                (routeLength === bestRouteLength && candidate.sourceIndex < bestSourceIndex)))
                    ) {
                        reservedRapidChargePair = candidate;
                        bestDamage = estimate.expectedEffectiveDamage;
                        bestRouteLength = routeLength;
                        bestSourceIndex = candidate.sourceIndex;
                    }
                }
            }
        }

        const cap = this.options.maxMeleePairs ?? 0;
        let kept = pairs;
        if (cap > 0 && pairs.length > cap) {
            kept = capAttackCandidates(pairs, cap, this.options.preserveAttackTargetCoverage === true, (pair) => ({
                targetId: pair.target.getId(),
                expectedDamage: pair.effective,
                expectedKill: pair.kill,
                stationary: pair.route === undefined,
            }));
            if (kept.length < pairs.length) this.truncated.push("melee");
            if (reservedRapidChargePair && !kept.includes(reservedRapidChargePair)) {
                kept = [...kept, reservedRapidChargePair];
            }
        }
        const candidateOf = (p: IMeleePair): IEnumeratedCandidate => {
            return {
                kind: "melee",
                actions: actionsOf(p),
                targetId: p.target.getId(),
                standCell: { x: p.cell.x, y: p.cell.y },
                ...(p === reservedRapidChargePair ? { researchRapidChargeDifferentTargetReserved: true as const } : {}),
                features: this.features({ expectedDamage: p.effective, expectedKill: p.kill }),
            };
        };
        if (this.options.enrichIncumbentMetadata) {
            for (const pair of pairs) this.enrichIncumbentCandidate(candidateOf(pair));
        }
        for (const p of kept) {
            this.push(candidateOf(p));
        }
    }
    // ---- mountain mining -------------------------------------------------------------------------
    /**
     * v0.8-only mountain selector. The shared <=v0.7 helper intentionally retains its historical base-cell
     * adjacency semantics; challengers instead mirror the engine and consider every cell in a LARGE footprint.
     */
    private mountainMeleeStrike(
        targetCells: readonly XY[],
    ): { attackFrom: XY; targetCell: XY; route?: IReadonlyWeightedRoute } | undefined {
        interface IStrike {
            attackFrom: XY;
            targetCell: XY;
            route?: IReadonlyWeightedRoute;
            weight: number;
        }

        const targets = [...targetCells].sort((left, right) => left.x - right.x || left.y - right.y);
        const adjacentTarget = (standCell: XY): XY | undefined => {
            for (const footprintCell of this.footprintForCell(standCell)) {
                const target = targets.find((cell) => isAdjacentCell(footprintCell, cell));
                if (target) {
                    return target;
                }
            }
            return undefined;
        };
        const routeSignature = (route?: IReadonlyWeightedRoute): string =>
            route
                ? `${route.route.map((cell) => `${cell.x},${cell.y}`).join(";")}|${Number(route.hasLavaCell)}|${Number(route.hasWaterCell)}`
                : "";
        const precedes = (left: IStrike, right: IStrike): boolean => {
            if (left.weight !== right.weight) return left.weight < right.weight;
            if (left.attackFrom.x !== right.attackFrom.x) return left.attackFrom.x < right.attackFrom.x;
            if (left.attackFrom.y !== right.attackFrom.y) return left.attackFrom.y < right.attackFrom.y;
            if (left.targetCell.x !== right.targetCell.x) return left.targetCell.x < right.targetCell.x;
            if (left.targetCell.y !== right.targetCell.y) return left.targetCell.y < right.targetCell.y;
            return routeSignature(left.route) < routeSignature(right.route);
        };

        const strikes: IStrike[] = [];
        const consider = (attackFrom: XY, weight: number, route?: IReadonlyWeightedRoute): void => {
            if (!Number.isFinite(weight) || !this.footprintOk(attackFrom)) {
                return;
            }
            const targetCell = adjacentTarget(attackFrom);
            if (!targetCell) {
                return;
            }
            strikes.push({ attackFrom, targetCell, route, weight });
        };

        // Any current footprint cell touching rock is an authoritative stationary strike, regardless of reach.
        const base = this.unit.getBaseCell();
        consider(base, 0);
        const stationary = strikes[0];
        if (stationary) {
            return { attackFrom: stationary.attackFrom, targetCell: stationary.targetCell };
        }

        // Otherwise select the cheapest legal reachable anchor. Inspect every route so flags come from the
        // exact route selected by the deterministic tie-break, rather than whichever route happened to be first.
        for (const routes of this.movePath()?.knownPaths.values() ?? []) {
            for (const route of routes) {
                if (!route?.route.length || (route.cell.x === base.x && route.cell.y === base.y)) {
                    continue;
                }
                consider(route.cell, route.weight, route);
            }
        }
        strikes.sort((left, right) => (precedes(left, right) ? -1 : precedes(right, left) ? 1 : 0));
        const best = strikes[0];
        return best ? { attackFrom: best.attackFrom, targetCell: best.targetCell, route: best.route } : undefined;
    }
    /** One deterministic, engine-legal strike against an intact BLOCK_CENTER obstacle. */
    private addMountainAttack(): void {
        if (!this.options.includeMountainAttacks) {
            return;
        }
        const { attackHandler, fightProperties, grid, unitsHolder } = this.context;
        const scattered = grid.hasScatteredMountains();
        const standingScattered = scattered ? grid.getScatteredMountainsStanding() : [];
        if (
            !attackHandler ||
            !fightProperties ||
            grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            fightProperties.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            (scattered ? standingScattered.length <= 0 : fightProperties.getObstacleHitsLeft() <= 0) ||
            this.unit.isDead() ||
            (!scattered &&
                (!this.unit.canMove() ||
                    this.unit.getAttackType() === RANGE ||
                    this.unit.getAttackTypeSelection() === RANGE ||
                    !this.canMelee()))
        ) {
            return;
        }

        const forcedTarget = unitsHolder.getAllUnits().get(this.unit.getTarget());
        if (forcedTarget && !forcedTarget.isDead()) {
            return;
        }

        const settings = grid.getSettings();
        const targetPositionFor = (cell: XY): XY =>
            getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep());

        // Cemetery objects are individually targetable one-hit obstacles. A shooter with a legal ranged attack
        // should clear the nearest standing object instead of treating the whole layout like the classic two-sided
        // mountain. The authoritative handler traces the projectile and removes the first stone on that ray.
        if (scattered && this.canShoot(attackHandler)) {
            const base = this.unit.getBaseCell();
            let targetCell = standingScattered[0];
            let targetDistance = Number.POSITIVE_INFINITY;
            for (const cell of standingScattered) {
                const distance = Math.abs(cell.x - base.x) + Math.abs(cell.y - base.y);
                if (distance < targetDistance) {
                    targetCell = cell;
                    targetDistance = distance;
                }
            }
            if (!targetCell) {
                return;
            }
            const actions: GameAction[] = [
                ...this.rangePrefix(),
                {
                    type: "obstacle_attack",
                    attackerId: this.unit.getId(),
                    targetPosition: targetPositionFor(targetCell),
                },
            ];
            this.push({
                kind: "mine",
                actions,
                targetCell: { x: targetCell.x, y: targetCell.y },
                standCell: { x: base.x, y: base.y },
                features: this.features({ spendsRangeShot: 1 }),
            });
            return;
        }

        if (!this.unit.canMove() || this.unit.getAttackTypeSelection() === RANGE || !this.canMelee()) {
            return;
        }

        const mid = grid.getSettings().getGridSize() >> 1;
        const strike = this.mountainMeleeStrike(
            scattered
                ? standingScattered
                : grid
                      .getCenterCells(true)
                      .filter((cell) =>
                          cell.x >= mid
                              ? fightProperties.getObstacleHitsLeftRight() > 0
                              : fightProperties.getObstacleHitsLeftLeft() > 0,
                      ),
        );
        if (!strike) {
            return;
        }

        const base = this.unit.getBaseCell();
        const inPlace = strike.attackFrom.x === base.x && strike.attackFrom.y === base.y;
        const route = inPlace ? undefined : strike.route;
        if (!inPlace && !route?.route.length) {
            return;
        }
        const targetPosition = targetPositionFor(strike.targetCell);
        const actions: GameAction[] = [
            {
                type: "obstacle_attack",
                attackerId: this.unit.getId(),
                targetPosition: { x: targetPosition.x, y: targetPosition.y },
                attackFrom: { x: strike.attackFrom.x, y: strike.attackFrom.y },
                path: route?.route.map((cell) => ({ x: cell.x, y: cell.y })),
                hasLavaCell: route?.hasLavaCell,
                hasWaterCell: route?.hasWaterCell,
            },
        ];
        this.push({
            kind: "mine",
            actions,
            targetCell: { x: strike.targetCell.x, y: strike.targetCell.y },
            standCell: { x: strike.attackFrom.x, y: strike.attackFrom.y },
            features: this.features(),
        });
    }
    // ---- ranged shots --------------------------------------------------------------------------------
    private canShoot(attackHandler: AttackHandler): boolean {
        if (
            !attackHandler.canLandRangeAttack(
                this.unit,
                this.context.grid.getEnemyAggrMatrixByUnitId(this.unit.getId()),
            )
        ) {
            return false;
        }
        return this.unit.getAttackTypeSelection() === RANGE || this.unit.getPossibleAttackTypes().includes(RANGE);
    }
    private rangePrefix(): GameAction[] {
        return this.unit.getAttackTypeSelection() !== RANGE
            ? [{ type: "select_attack_type", unitId: this.unit.getId(), attackType: RANGE }]
            : [];
    }
    /**
     * Enrich an exact native move-then-shot incumbent without enabling the experimental move-shot catalog.
     * This is deliberately a one-candidate probe: the action must match one authoritative reachable route and
     * the ordinary ranged prefix exactly, and no candidate is pushed. In particular, a zero move-shot cap stays
     * a zero challenger cap while a13 can still compare its inherited ranged-positioning action fairly.
     */
    private enrichIncumbentMoveShot(
        attackHandler: AttackHandler,
        shots: number,
        forcedTargetId: string | undefined,
    ): void {
        const isThroughShot = this.unit.hasAbilityActive("Through Shot");
        const isLargeCaliber = this.unit.hasAbilityActive("Large Caliber");
        if (!this.options.enrichIncumbentMetadata || this.unit.hasAbilityActive("Area Throw") || !this.unit.canMove()) {
            return;
        }
        const incumbent = this.candidates[0];
        const prefix = this.rangePrefix();
        if (!incumbent || incumbent.kind !== "incumbent" || incumbent.actions.length !== prefix.length + 2) {
            return;
        }
        const move = incumbent.actions[0];
        const shot = incumbent.actions[incumbent.actions.length - 1];
        if (
            move?.type !== "move_unit" ||
            move.unitId !== this.unit.getId() ||
            shot?.type !== "range_attack" ||
            shot.attackerId !== this.unit.getId() ||
            !shot.aimCell ||
            shot.aimSide === undefined
        ) {
            return;
        }
        for (let index = 0; index < prefix.length; index += 1) {
            const expected = prefix[index];
            const actual = incumbent.actions[index + 1];
            if (
                expected.type !== "select_attack_type" ||
                actual?.type !== "select_attack_type" ||
                actual.unitId !== expected.unitId ||
                actual.attackType !== expected.attackType
            ) {
                return;
            }
        }

        const sameCellsInOrder = (left: readonly XY[] | undefined, right: readonly XY[] | undefined): boolean => {
            if (!left || !right || left.length !== right.length) return false;
            return left.every((cell, index) => cell.x === right[index]?.x && cell.y === right[index]?.y);
        };
        const sameCellSet = (left: readonly XY[] | undefined, right: readonly XY[] | undefined): boolean => {
            if (!left || !right || left.length !== right.length) return false;
            const keys = (cells: readonly XY[]): Set<string> => new Set(cells.map((cell) => `${cell.x},${cell.y}`));
            const leftKeys = keys(left);
            const rightKeys = keys(right);
            return (
                leftKeys.size === left.length &&
                rightKeys.size === right.length &&
                [...leftKeys].every((key) => rightKeys.has(key))
            );
        };
        const movePath = this.movePath();
        if (!movePath) return;
        let route: IReadonlyWeightedRoute | undefined;
        let postMoveActor: ReturnType<typeof projectPostMoveActorAvailability> | undefined;
        for (const routeList of movePath.knownPaths.values()) {
            const candidateRoute = routeList[0];
            if (!candidateRoute?.route.length || candidateRoute.hasLavaCell || candidateRoute.hasWaterCell) {
                continue;
            }
            const exactMove = this.moveAction(candidateRoute);
            if (
                exactMove.type === "move_unit" &&
                sameCellsInOrder(move.path, exactMove.path) &&
                sameCellSet(move.targetCells, exactMove.targetCells) &&
                move.hasLavaCell === exactMove.hasLavaCell &&
                move.hasWaterCell === exactMove.hasWaterCell &&
                this.footprintOk(candidateRoute.cell)
            ) {
                const projected = projectPostMoveActorAvailability(
                    this.unit,
                    decisionFireWalls(this.context),
                    exactMove,
                );
                if (!projected.availableAfterMove || projected.resurrected) return;
                route = candidateRoute;
                postMoveActor = projected;
                break;
            }
        }
        if (!route || !postMoveActor) return;
        const postMoveCumulativeHp =
            (postMoveActor.stack.amountAlive - 1) * postMoveActor.stack.maxHp + Math.max(0, postMoveActor.stack.hp);

        const aimTarget = this.context.unitsHolder.getAllUnits().get(shot.targetId);
        if (
            !aimTarget ||
            aimTarget.isDead() ||
            aimTarget.getTeam() !== this.enemyTeam ||
            isHidden(aimTarget) ||
            this.unit.cannotAttackUnitId(aimTarget.getId()) ||
            !aimTarget.getCells().some((cell) => cell.x === shot.aimCell!.x && cell.y === shot.aimCell!.y) ||
            !RANGE_ATTACK_CELL_SIDES.includes(shot.aimSide as RangeAttackCellSide) ||
            !isRangeAttackSideObservable(
                this.context.matrix,
                shot.aimCell,
                shot.aimSide as RangeAttackCellSide,
                this.unit.getTeam(),
                isThroughShot,
            )
        ) {
            return;
        }
        const targetCells = move.targetCells;
        if (!targetCells) return;
        const origin = getPositionForCells(this.context.grid.getSettings(), targetCells);
        if (!origin) return;
        // handleRangeAttack re-checks canLandRangeAttack after the move has updated the actor's position. Mirror
        // that check at the hypothetical destination: current-cell eligibility is insufficient when the move
        // lands inside an enemy melee-aggression cell.
        if (
            !this.unit.isRangeCapable() ||
            // The unit itself, not the legacy boolean: a rectangle's pin test must run on its REAL
            // body — the 2x2 window read a 2x1 as pinned where it is safe, and missed a 1x3's far
            // cell entirely (AI proposes, engine rejects).
            attackHandler.canBeAttackedByMelee(
                origin,
                this.unit,
                this.context.grid.getEnemyAggrMatrixByUnitId(this.unit.getId()),
            ) ||
            this.unit.getRangeShots() <= 0 ||
            this.unit.hasDebuffActive("Range Null Field Aura") ||
            this.unit.hasStatusApplied("Rangebane")
        ) {
            return;
        }
        const to = getRangeAttackSideCenter(
            this.context.grid.getSettings(),
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            origin,
        );
        const evaluation = attackHandler.evaluateRangeAttack(
            this.context.unitsHolder.getAllUnits(),
            this.unit,
            origin,
            to,
            isThroughShot,
            false,
            isLargeCaliber,
        );
        const primaryHit = evaluation.affectedUnits[0]?.[0];
        if (
            evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length ||
            !primaryHit ||
            primaryHit.isDead() ||
            primaryHit.getTeam() !== this.enemyTeam ||
            isHidden(primaryHit) ||
            this.unit.cannotAttackUnitId(primaryHit.getId()) ||
            (!isThroughShot && !isLargeCaliber && primaryHit.getId() !== aimTarget.getId()) ||
            (forcedTargetId !== undefined && primaryHit.getId() !== forcedTargetId) ||
            (!isThroughShot &&
                this.unit.hasStatusApplied("Cowardice") &&
                postMoveCumulativeHp < primaryHit.getCumulativeHp())
        ) {
            return;
        }
        const damage = this.shotDamage(
            evaluation,
            primaryHit.getId(),
            shots,
            isLargeCaliber,
            aimTarget.getId(),
            postMoveActor.stack.amountAlive,
        );
        this.enrichIncumbentCandidate({
            kind: "shot",
            actions: incumbent.actions,
            targetId: primaryHit.getId(),
            targetCell: { x: route.cell.x, y: route.cell.y },
            shotFeatures: this.shotFeatures(primaryHit, damage),
            features: this.features({ spendsRangeShot: 1, expectedDamage: damage.value, expectedKill: damage.kill }),
        });
    }
    /**
     * Expected effective damage of a hit set (enemies add, splash friendly fire subtracts).
     *
     * The engine owns all target-specific combat semantics used here: calculateMissChance covers Dodge,
     * Small Specie, Boar Saliva and the Broken Aegis self-cost; getPhysicalAoeDamageMultiplier covers status
     * resistance and Mechanism vulnerability. Keeping those terms in the score prevents a high-raw-damage but
     * low-hit-probability cluster from incorrectly beating a reliable incumbent shot.
     */
    private shotDamage(
        evaluation: { affectedUnits: Array<Unit[]>; rangeAttackDivisors: number[] },
        primaryTargetId: string | undefined,
        shots: number,
        isAOE: boolean,
        aimTargetId = primaryTargetId,
        attackerAmountAlive = this.unit.getAmountAlive(),
    ): IRangeCandidateDamage {
        if (
            !this.preparedRangeDamage ||
            this.preparedRangeDamage.shots !== shots ||
            this.preparedRangeDamage.isAOE !== isAOE
        ) {
            this.preparedRangeDamage = {
                shots,
                isAOE,
                value: prepareRangeCandidateDamage(this.unit, this.context, shots, isAOE),
            };
        }
        return evaluatePreparedRangeCandidateDamage(
            this.unit,
            this.context,
            evaluation,
            primaryTargetId,
            attackerAmountAlive,
            aimTargetId,
            this.preparedRangeDamage.value,
        );
    }
    /** Target-local signals already used by v0.5's shot scorer, exposed without changing that scorer. */
    private shotFeatures(
        target: Unit,
        damage: Pick<
            IShotCandidateFeatures,
            "enemyDamage" | "friendlyFireDamage" | "primaryTargetDamage" | "aimTargetDamage"
        >,
    ): IShotCandidateFeatures {
        const died = target.getAmountDied();
        const alive = target.getAmountAlive();
        const focus =
            this.allies.filter((ally) =>
                ally.getCells().some((ac) => target.getCells().some((tc) => isAdjacentCell(ac, tc))),
            ).length / 2;
        return {
            ...damage,
            targetFirepower: (Math.max(1, target.getRangeShots()) * Math.max(1, target.getAttackDamageMax())) / 1_000,
            targetLevel: target.getLevel(),
            targetIsRanged: target.getAttackType() === RANGE ? 1 : 0,
            targetCanCastSpells: target.getCanCastSpells() ? 1 : 0,
            targetNotYetActed:
                this.context.fightProperties && !this.context.fightProperties.hasAlreadyMadeTurn(target.getId())
                    ? 1
                    : 0,
            targetWoundedFraction: died + alive > 0 ? died / (died + alive) : 0,
            targetFocusFire: focus,
        };
    }
    /** Every enemy x visible edge; aims with identical hit sets (units + divisors) are deduped. */
    private addShots(): void {
        const attackHandler = this.context.attackHandler;
        if (!attackHandler || !this.canShoot(attackHandler)) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const matrix = this.context.matrix;
        const gs = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const fromTeam = this.unit.getTeam();
        const from = this.unit.getPosition();
        const isLargeCaliber = this.unit.hasAbilityActive("Large Caliber");
        const isAreaThrow = this.unit.hasAbilityActive("Area Throw");
        const isAOE = isLargeCaliber || isAreaThrow;
        const isThroughShot = this.unit.hasAbilityActive("Through Shot");
        const shots = hasDoubleShotAbility(this.unit) ? 2 : 1;
        const prefix = this.rangePrefix();
        const forcedTarget = allUnits.get(this.unit.getTarget());
        const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;

        interface IShot {
            /** Engine-resolved first stack hit and used by every target-local score/feature. */
            target: Unit;
            targetId: string;
            /** Unit whose visible cell edge anchors the exact trajectory sent to the action engine. */
            aimTargetId: string;
            aimCell: XY;
            aimSide: RangeAttackCellSide;
            value: number;
            kill: 0 | 1;
            shotFeatures: IShotCandidateFeatures;
            hitUnitSignature: string;
        }
        const found: IShot[] = [];
        const hitSetSeen = new Set<string>();
        for (const enemy of this.enemies) {
            if (isHidden(enemy)) {
                continue; // the engine's melee/hidden guard; a Hidden unit cannot be targeted
            }
            if (this.unit.cannotAttackUnitId(enemy.getId())) {
                continue; // frightened by Terrifying Gaze: the gazer is not a legal shot this turn
            }
            for (const cell of enemy.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(matrix, cell, side, fromTeam, isThroughShot)) {
                        continue;
                    }
                    const to = getRangeAttackSideCenter(gs, cell, side, from);
                    const evaluation = attackHandler.evaluateRangeAttack(
                        allUnits,
                        this.unit,
                        from,
                        to,
                        isThroughShot,
                        false,
                        isAOE,
                    );
                    const primaryHit = evaluation.affectedUnits[0]?.[0];
                    // Apply handleRangeAttack's structural/live-forced-target checks against the ACTUAL first
                    // unit resolved by line geometry, not merely the enemy whose edge was aimed at. Candidate
                    // enumeration is deliberately stricter than the handler for special multi-group shots: even
                    // though the handler only rejects Hidden for a single group (and permits allied primaries for
                    // AOE), no candidate may advertise a dead, allied, or Hidden unit as its scored primary.
                    // Reject before dedupe/enrichment so an invalid incumbent cannot acquire truthful-looking
                    // shot metadata. The group/divisor equality is the handler's unconditional structural guard.
                    if (
                        !primaryHit ||
                        evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length ||
                        primaryHit.isDead() ||
                        primaryHit.getTeam() !== this.enemyTeam ||
                        isHidden(primaryHit) ||
                        this.unit.cannotAttackUnitId(primaryHit.getId()) ||
                        (forcedTargetId !== undefined && primaryHit.getId() !== forcedTargetId) ||
                        (!isThroughShot &&
                            this.unit.hasStatusApplied("Cowardice") &&
                            this.unit.getCumulativeHp() < primaryHit.getCumulativeHp())
                    ) {
                        continue;
                    }
                    // A plain ranged attack has no strategic reason to advertise a rear stack while an
                    // intervening enemy is the unit the engine will actually damage. The primary's own
                    // visible-edge iteration emits the canonical action instead. Special line/AOE attacks are
                    // different: a rear aim can deliberately select a Through Shot line or a Large Caliber
                    // impact cell, so retain that exact aim anchor while exposing the resolved first hit as the
                    // candidate target and target-local feature source.
                    if (!isThroughShot && !isAOE && primaryHit.getId() !== enemy.getId()) {
                        continue;
                    }
                    // Alternative aims are only interesting when they change WHAT the shot hits: dedupe
                    // aims resolving to the identical (unit set, divisors) outcome per target.
                    const hitSig =
                        enemy.getId() +
                        "#" +
                        evaluation.affectedUnits
                            .map(
                                (g, i) =>
                                    `${evaluation.rangeAttackDivisors[i] ?? 1}:${g.map((u) => u.getId()).join(",")}`,
                            )
                            .join(";");
                    if (hitSetSeen.has(hitSig)) {
                        continue;
                    }
                    hitSetSeen.add(hitSig);
                    const damage = this.shotDamage(evaluation, primaryHit.getId(), shots, isAOE, enemy.getId());
                    found.push({
                        target: primaryHit,
                        targetId: primaryHit.getId(),
                        aimTargetId: enemy.getId(),
                        aimCell: { x: cell.x, y: cell.y },
                        aimSide: side,
                        value: damage.value,
                        kill: damage.kill,
                        shotFeatures: this.shotFeatures(primaryHit, damage),
                        hitUnitSignature: evaluation.affectedUnits
                            .map((group) => group.map((unit) => unit.getId()).join(","))
                            .join(";"),
                    });
                }
            }
        }
        const cap = this.options.maxShotAims ?? 0;
        let kept = found;
        if (cap > 0 && found.length > cap) {
            kept = capAttackCandidates(found, cap, this.options.preserveAttackTargetCoverage === true, (shot) => ({
                // Coverage preserves every declared visible-edge anchor. For ordinary shots this is the
                // resolved primary too; special line/AOE shots may intentionally aim through a different rear
                // stack, and collapsing those anchors by first hit would erase distinct legal geometry.
                targetId: shot.aimTargetId,
                expectedDamage: shot.value,
                expectedKill: shot.kill,
                stationary: true,
            }));
            if (kept.length < found.length) this.truncated.push("shot");
        }
        const candidateOf = (s: IShot): IEnumeratedCandidate => ({
            kind: "shot",
            actions: [
                ...prefix,
                {
                    type: "range_attack",
                    attackerId: this.unit.getId(),
                    targetId: s.aimTargetId,
                    aimCell: s.aimCell,
                    aimSide: s.aimSide,
                },
            ],
            targetId: s.targetId,
            shotFeatures: s.shotFeatures,
            features: this.features({ spendsRangeShot: 1, expectedDamage: s.value, expectedKill: s.kill }),
        });
        // Enrichment is independent of the challenger cap: even a capped-out duplicate is still the truthful
        // observation of candidate 0's exact shot.
        for (const s of found) {
            const candidate = candidateOf(s);
            this.enrichIncumbentCandidate(candidate);
        }
        for (const s of kept) {
            this.push(candidateOf(s));
        }

        const moveShotCap = Math.min(2, Math.max(0, Math.floor(this.options.maxMoveShotComposites ?? 0)));
        const moveShotDiscoveryRequested = this.options.discoverMoveShotTargetsAfterMove === true;
        // A missing origin is a direct/live library call. Only explicit hypothetical rollout contexts suppress
        // this terminal root escape hatch.
        const discoverMoveShotTargetsAfterMove =
            moveShotDiscoveryRequested && this.context.decisionOrigin !== "rollout";
        this.enrichIncumbentMoveShot(attackHandler, shots, forcedTargetId);
        if (
            moveShotCap === 0 ||
            isAreaThrow ||
            ((isLargeCaliber || isThroughShot) && !discoverMoveShotTargetsAfterMove) ||
            (moveShotDiscoveryRequested && !discoverMoveShotTargetsAfterMove) ||
            (this.unit.hasAbilityActive("Sniper") && !discoverMoveShotTargetsAfterMove) ||
            !this.unit.canMove()
        ) {
            return;
        }
        // Discovery is an escape hatch for a closed or counterproductive stationary line. It must not silently
        // opt the terminal finisher into the legacy "move for more damage" class while a positive-net shot
        // already exists. A structurally valid Large Caliber ray whose allied splash outweighs enemy damage is
        // not productive and must not hide a safe positive move-then-shot.
        if (discoverMoveShotTargetsAfterMove && found.some(({ value }) => value > 0)) {
            return;
        }
        const movePath = this.movePath();
        if (!movePath) {
            return;
        }
        interface IMoveShot {
            shot: IShot;
            route: IReadonlyWeightedRoute;
            value: number;
            kill: 0 | 1;
            shotFeatures: IShotCandidateFeatures;
            improvement: number;
            sourceIndex: number;
        }
        const moveShots: IMoveShot[] = [];
        const base = this.unit.getBaseCell();
        let sourceIndex = 0;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (
                !route?.route.length ||
                (route.cell.x === base.x && route.cell.y === base.y) ||
                route.hasLavaCell ||
                route.hasWaterCell ||
                !this.footprintOk(route.cell)
            ) {
                continue;
            }
            const postMoveActor = projectPostMoveActorAvailability(
                this.unit,
                decisionFireWalls(this.context),
                this.moveAction(route),
            );
            // Resurrection also resets effects in the engine. That post-revival attack state is intentionally
            // outside this cheap projection, so do not advertise a suffix whose exact damage/legality is unknown.
            if (!postMoveActor.availableAfterMove || postMoveActor.resurrected) continue;
            const postMoveCumulativeHp =
                postMoveActor.stack.amountAlive <= 0
                    ? 0
                    : (postMoveActor.stack.amountAlive - 1) * postMoveActor.stack.maxHp +
                      Math.max(0, postMoveActor.stack.hp);
            const footprint = this.footprintForCell(route.cell);
            const origin = getPositionForCells(gs, footprint);
            if (
                !origin ||
                attackHandler.canBeAttackedByMelee(
                    origin,
                    this.unit,
                    grid.getEnemyAggrMatrixByUnitId(this.unit.getId()),
                )
            ) {
                continue;
            }
            if (discoverMoveShotTargetsAfterMove) {
                const routeHitSets = new Set<string>();
                for (const enemy of this.enemies) {
                    if (isHidden(enemy) || this.unit.cannotAttackUnitId(enemy.getId())) continue;
                    for (const cell of enemy.getCells()) {
                        for (const side of RANGE_ATTACK_CELL_SIDES) {
                            if (!isRangeAttackSideObservable(matrix, cell, side, fromTeam, isThroughShot)) continue;
                            const to = getRangeAttackSideCenter(gs, cell, side, origin);
                            const evaluation = attackHandler.evaluateRangeAttack(
                                allUnits,
                                this.unit,
                                origin,
                                to,
                                isThroughShot,
                                false,
                                isAOE,
                            );
                            const primaryHit = evaluation.affectedUnits[0]?.[0];
                            if (
                                !primaryHit ||
                                evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length ||
                                primaryHit.isDead() ||
                                primaryHit.getTeam() !== this.enemyTeam ||
                                isHidden(primaryHit) ||
                                this.unit.cannotAttackUnitId(primaryHit.getId()) ||
                                (!isThroughShot && !isAOE && primaryHit.getId() !== enemy.getId()) ||
                                (forcedTargetId !== undefined && primaryHit.getId() !== forcedTargetId) ||
                                (!isThroughShot &&
                                    this.unit.hasStatusApplied("Cowardice") &&
                                    postMoveCumulativeHp < primaryHit.getCumulativeHp())
                            ) {
                                continue;
                            }
                            const hitUnitSignature = evaluation.affectedUnits
                                .map((group) => group.map((candidate) => candidate.getId()).join(","))
                                .join(";");
                            const hitSignature = `${enemy.getId()}#${evaluation.rangeAttackDivisors.join(",")}#${hitUnitSignature}`;
                            if (routeHitSets.has(hitSignature)) continue;
                            routeHitSets.add(hitSignature);
                            const damage = this.shotDamage(
                                evaluation,
                                primaryHit.getId(),
                                shots,
                                isAOE,
                                enemy.getId(),
                                postMoveActor.stack.amountAlive,
                            );
                            if (!(damage.value > 0)) continue;
                            moveShots.push({
                                shot: {
                                    target: primaryHit,
                                    targetId: primaryHit.getId(),
                                    aimTargetId: enemy.getId(),
                                    aimCell: { x: cell.x, y: cell.y },
                                    aimSide: side,
                                    value: 0,
                                    kill: 0,
                                    shotFeatures: this.shotFeatures(primaryHit, damage),
                                    hitUnitSignature,
                                },
                                route,
                                value: damage.value,
                                kill: damage.kill,
                                shotFeatures: this.shotFeatures(primaryHit, damage),
                                improvement: damage.value,
                                sourceIndex: sourceIndex++,
                            });
                        }
                    }
                }
                continue;
            }
            for (const shot of kept) {
                if (
                    (forcedTargetId && shot.targetId !== forcedTargetId) ||
                    (this.unit.hasStatusApplied("Cowardice") && postMoveCumulativeHp < shot.target.getCumulativeHp())
                ) {
                    continue;
                }
                const to = getRangeAttackSideCenter(gs, shot.aimCell, shot.aimSide, origin);
                const evaluation = attackHandler.evaluateRangeAttack(
                    allUnits,
                    this.unit,
                    origin,
                    to,
                    false,
                    false,
                    false,
                );
                const primaryHit = evaluation.affectedUnits[0]?.[0];
                const hitUnitSignature = evaluation.affectedUnits
                    .map((group) => group.map((candidate) => candidate.getId()).join(","))
                    .join(";");
                // Preserve the incumbent aim's exact semantic target/interception. A changed first hit or hit
                // set is a different shot, and special line/AOE geometry is deliberately outside this probe.
                if (
                    primaryHit?.getId() !== shot.targetId ||
                    hitUnitSignature !== shot.hitUnitSignature ||
                    isHidden(primaryHit)
                ) {
                    continue;
                }
                const damage = this.shotDamage(
                    evaluation,
                    shot.targetId,
                    shots,
                    false,
                    shot.aimTargetId,
                    postMoveActor.stack.amountAlive,
                );
                if (!(damage.value > shot.value)) {
                    continue;
                }
                moveShots.push({
                    shot,
                    route,
                    value: damage.value,
                    kill: damage.kill,
                    shotFeatures: this.shotFeatures(shot.target, damage),
                    improvement: damage.value - shot.value,
                    sourceIndex: sourceIndex++,
                });
            }
        }
        moveShots.sort(
            (left, right) =>
                right.kill - left.kill ||
                right.improvement - left.improvement ||
                right.value - left.value ||
                (left.route.weight ?? left.route.route.length) - (right.route.weight ?? right.route.route.length) ||
                left.route.cell.y - right.route.cell.y ||
                left.route.cell.x - right.route.cell.x ||
                left.sourceIndex - right.sourceIndex,
        );
        if (moveShots.length > moveShotCap && !this.truncated.includes("shot")) {
            this.truncated.push("shot");
        }
        const moveShotCandidateOf = (moveShot: IMoveShot): IEnumeratedCandidate => ({
            kind: "shot",
            actions: [
                this.moveAction(moveShot.route),
                ...prefix,
                {
                    type: "range_attack",
                    attackerId: this.unit.getId(),
                    // The action engine authoritatively reconstructs the ray from an edge of `targetId`.
                    // Special shots may aim at a rear stack while exposing the intercepted front stack as
                    // candidate metadata, so keep transport intent anchored to the unit that owns aimCell.
                    targetId: moveShot.shot.aimTargetId,
                    aimCell: moveShot.shot.aimCell,
                    aimSide: moveShot.shot.aimSide,
                },
            ],
            targetId: moveShot.shot.targetId,
            targetCell: { x: moveShot.route.cell.x, y: moveShot.route.cell.y },
            shotFeatures: moveShot.shotFeatures,
            features: this.features({
                spendsRangeShot: 1,
                expectedDamage: moveShot.value,
                expectedKill: moveShot.kill,
            }),
        });
        for (const moveShot of moveShots) {
            this.enrichIncumbentCandidate(moveShotCandidateOf(moveShot));
        }
        for (const moveShot of moveShots.slice(0, moveShotCap)) {
            this.push(moveShotCandidateOf(moveShot));
        }
    }
    // ---- area throw (Gargantuan) ------------------------------------------------------------------
    /**
     * area_throw_attack — engine legality (GameActionEngine.areaThrowAttack): Area Throw ability active,
     * RANGE selected (or selectable), shots > 0, target cell inside the grid and not occupied by a unit
     * (lava "L" / water "W" markers are fine). NOTE the engine does NOT re-check melee pinning for this
     * action, but RANGE selectability already encodes it via refreshPossibleAttackTypes. Relevance filter:
     * only cells whose 3x3 splash (cells around the aim + interception projection) reaches >=1 living
     * enemy — aiming at bare ground is legal but strictly dominated, and including ~200 empty cells would
     * drown every consumer.
     */
    private addAreaThrows(): void {
        if (
            !this.unit.hasAbilityActive("Area Throw") ||
            this.unit.getRangeShots() <= 0 ||
            !(this.unit.getAttackTypeSelection() === RANGE || this.unit.getPossibleAttackTypes().includes(RANGE))
        ) {
            return;
        }
        const attackHandler = this.context.attackHandler;
        if (!attackHandler) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const gs = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const prefix = this.rangePrefix();
        const shots = hasDoubleShotAbility(this.unit) ? 2 : 1;
        const forcedTarget = allUnits.get(this.unit.getTarget());
        const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;

        // Aim-cell pool: empty cells adjacent to a living enemy's footprint (the only aims whose splash
        // can reach an enemy), deduped, in deterministic enemy/cell order.
        const poolSeen = new Set<number>();
        const pool: XY[] = [];
        for (const enemy of this.enemies) {
            for (const ec of enemy.getCells()) {
                for (const c of [...getCellsAroundCell(gs, ec)]) {
                    const key = (c.x << 4) | c.y;
                    if (poolSeen.has(key)) {
                        continue;
                    }
                    poolSeen.add(key);
                    if (!isCellWithinGrid(gs, c)) {
                        continue;
                    }
                    const occupantId = grid.getOccupantUnitId(c);
                    if (occupantId && occupantId !== "L" && occupantId !== "W") {
                        continue; // engine rejects unit-occupied aim cells
                    }
                    pool.push(c);
                }
            }
        }

        interface IThrow {
            aim: XY;
            primaryTargetId: string;
            pressureTargetId: string;
            pressureKill: 0 | 1;
            value: number;
            kill: 0 | 1;
        }
        const found: IThrow[] = [];
        for (const aim of pool) {
            // Mirror the engine: a unit on the trajectory intercepts the throw — evaluate the splash at
            // the PROJECTED cell, not the aimed one, so the feature reflects what would actually happen.
            const projected = attackHandler.projectAreaThrowTargetCell(allUnits, this.unit, aim);
            const targetPosition = getPositionForCell(projected, gs.getMinX(), gs.getStep(), gs.getHalfStep());
            const affectedCells = [...getCellsAroundCell(gs, projected), projected];
            const affectedUnits = evaluateAffectedUnits(affectedCells, unitsHolder, grid) ?? [];
            const primaryTargetId = affectedUnits[0]?.[0]?.getId();
            if (
                !primaryTargetId ||
                this.unit.cannotAttackUnitId(primaryTargetId) ||
                (forcedTargetId && forcedTargetId !== primaryTargetId)
            ) {
                continue; // AttackHandler enforces the same first-affected-unit forced-target check.
            }
            // An interceptor can be allied even though the same legal splash deals positive net enemy damage.
            // Keep engine-primary metadata intact while exposing the first affected enemy to v0.8s scheduling.
            const pressureTargetId = affectedUnits
                .flat()
                .find((target) => target.getTeam() === this.enemyTeam)
                ?.getId();
            if (!pressureTargetId) continue;
            const divisor = attackHandler.getRangeAttackDivisor(this.unit, targetPosition);
            const evaluation = { affectedUnits, rangeAttackDivisors: affectedUnits.map(() => divisor) };
            const { value, kill } = this.shotDamage(evaluation, primaryTargetId, shots, true);
            const pressureKill =
                this.options.preserveAttackTargetCoverage && pressureTargetId !== primaryTargetId
                    ? this.shotDamage(evaluation, pressureTargetId, shots, true).kill
                    : kill;
            found.push({ aim, primaryTargetId, pressureTargetId, pressureKill, value, kill });
        }
        const cap = this.options.maxAreaThrowCells ?? 0;
        let kept = found;
        if (cap > 0 && found.length > cap) {
            kept = capAttackCandidates(found, cap, this.options.preserveAttackTargetCoverage === true, (areaThrow) => ({
                targetId: areaThrow.pressureTargetId,
                expectedDamage: areaThrow.value,
                expectedKill: this.options.preserveAttackTargetCoverage ? areaThrow.pressureKill : areaThrow.kill,
                stationary: true,
            }));
            if (kept.length < found.length) this.truncated.push("area_throw");
        }
        const candidateOf = (t: IThrow): IEnumeratedCandidate => ({
            kind: "area_throw",
            actions: [
                ...prefix,
                {
                    type: "area_throw_attack",
                    attackerId: this.unit.getId(),
                    targetCell: { x: t.aim.x, y: t.aim.y },
                },
            ],
            targetId: t.primaryTargetId,
            ...(this.options.preserveAttackTargetCoverage
                ? { pressureTargetId: t.pressureTargetId, pressureExpectedKill: t.pressureKill }
                : {}),
            targetCell: { x: t.aim.x, y: t.aim.y },
            features: this.features({ spendsRangeShot: 1, expectedDamage: t.value, expectedKill: t.kill }),
        });
        if (this.options.enrichIncumbentMetadata) {
            for (const candidate of found) this.enrichIncumbentCandidate(candidateOf(candidate));
        }
        for (const t of kept) {
            this.push(candidateOf(t));
        }
    }
    // ---- spells ----------------------------------------------------------------------------------
    /** Mirrors GameActionEngine.canUseSpell. */
    private canUseSpell(spell: Spell): boolean {
        return isSpellUsableByCaster(this.unit, spell);
    }
    private castAction(spell: Spell, targetId?: string, targetCell?: XY, targetOrientation?: number): GameAction {
        return {
            type: "cast_spell",
            casterId: this.unit.getId(),
            spellName: spell.getName(),
            targetId,
            targetCell,
            targetOrientation,
        };
    }
    private pushSpell(
        spell: Spell,
        targetId?: string,
        targetCell?: XY,
        overrides: Partial<ICandidateFeatures> = {},
        targetOrientation?: number,
    ): void {
        this.push({
            kind: "spell",
            actions: [this.castAction(spell, targetId, targetCell, targetOrientation)],
            spellName: spell.getName(),
            targetId,
            targetCell,
            features: this.features({
                spendsSpellCharge: 1,
                burnsResurrectionCharge: spell.getName() === "Resurrection" && this.ownsResurrectionCharge() ? 1 : 0,
                ...overrides,
            }),
        });
    }
    /**
     * ALL castable spells x targets — including the MELEE_MAGIC-granted ones no AI version has ever
     * emitted (Angel Resurrection, Valkyrie Wind Flow, Harpy Castling) and offensive debuffs (v0.2+ only
     * ever casts beneficial spells). Target-type coverage:
     *   ANY_ALLY (Heal/buffs/Resurrection)         -> per-ally canCastSpell
     *   ANY_ENEMY (debuffs)                        -> per-enemy canCastSpell
     *   ALLIES_AREA (Blacksmith Craft)             -> every useful in-grid 2x2 ally footprint
     *   ENEMY_WITHIN_MOVEMENT_RANGE (Castling)     -> small enemies on getEnemiesCellsWithinMovementRange
     *   ALL_ALLIES / ALL_ENEMIES / ALL_FLYING      -> single mass candidate via canMassCastSpell
     *   RANDOM_CLOSE_TO_CASTER summons             -> deterministic first empty adjacent cell
     * AUTO-targeted entries (system effects like Morale) are not player-castable and are skipped.
     */
    /**
     * Blacksmith Craft targets a 2x2 area rather than one unit. Its target cell has no persistent terrain
     * meaning: two anchors affecting the same living allies produce the same stochastic Craft operation. Scan
     * in stable grid order and retain the first anchor for each sorted recipient-id set, avoiding four copies
     * of an isolated small ally (or nine copies of an isolated large ally) in the rollout catalog.
     */
    private addAlliesAreaCastCandidates(spell: Spell): void {
        const { grid, unitsHolder } = this.context;
        const gs = grid.getSettings();
        const gridSize = gs.getGridSize();
        const team = this.unit.getTeam();
        const seenRecipientSets = new Set<string>();
        for (let x = 0; x < gridSize - 1; x += 1) {
            for (let y = 0; y < gridSize - 1; y += 1) {
                const anchor = { x, y };
                const cells = [anchor, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
                const affected = evaluateAffectedUnits(cells, unitsHolder, grid)?.[0] ?? [];
                const recipientIds = affected
                    .filter((unit) => unit.getTeam() === team && !unit.isDead())
                    .map((unit) => unit.getId())
                    .sort();
                if (!recipientIds.length) {
                    continue;
                }
                const recipientSet = recipientIds.join("|");
                if (seenRecipientSets.has(recipientSet)) {
                    continue;
                }
                seenRecipientSets.add(recipientSet);
                this.pushSpell(spell, undefined, anchor);
            }
        }
    }
    /**
     * Smoke spell candidate selection. Smoke is a defensive tool: it halves ranged damage that crosses a 2x2
     * cloud, so the AI wants it on the line of fire BETWEEN enemy ranged units and its own army. There is no
     * cast-range gate, so we search a bounded set of engine-legal cells sampled between each enemy shooter and
     * our army. Every sample is scored by the authoritative best legal shot before versus after the cloud:
     *   - visible target edges, first interception, mountains, Through Shot and capped falloff all come from
     *     AttackHandler, with the proposed cells passed as a pure hypothetical;
     *   - the shooter may retarget after Smoke, so a bypassable cloud receives no imaginary protection value;
     *   - enemy damage prevented adds value and friendly damage prevented subtracts it;
     *   - all 4 footprint cells must pass the engine's exact smoke-placement oracle.
     * Determinism: ties broken by grid order (no RNG), so the lookahead is reproducible.
     */
    private addSmokeCastCandidates(spell: Spell): void {
        const { grid } = this.context;
        const gs = grid.getSettings();
        const enemyRangers = this.enemies.filter((e) => e.isRangeCapable() && e.getRangeShots() > 0);
        if (enemyRangers.length === 0) {
            return; // nobody to blindfire through — save the charge.
        }
        // Centroid of our living units (the army we want to shield).
        const allies = [this.unit, ...this.allies].filter((u) => !u.isDead());
        if (allies.length === 0) {
            return;
        }
        let ax = 0;
        let ay = 0;
        for (const a of allies) {
            const c = a.getBaseCell();
            ax += c.x;
            ay += c.y;
        }
        ax = Math.round(ax / allies.length);
        ay = Math.round(ay / allies.length);

        const alliedRangers = allies.filter((ally) => ally.isRangeCapable() && ally.getRangeShots() > 0);
        const baselineDamage = new Map<string, number>();
        const stationarySearches = new Map<string, IStationaryRangeAttackSearch | undefined>();
        const usePreparedGeometry = Boolean(
            this.context.attackHandler && canUseNativePreparedRangeAttack(this.context.attackHandler),
        );
        for (const shooter of [...enemyRangers, ...alliedRangers]) {
            if (usePreparedGeometry) {
                const search = prepareStationaryRangeAttackSearch(shooter, this.context);
                stationarySearches.set(shooter.getId(), search);
                baselineDamage.set(shooter.getId(), findBestPreparedStationaryRangeAttack(search)?.expectedDamage ?? 0);
            } else {
                baselineDamage.set(
                    shooter.getId(),
                    findBestLegalStationaryRangeAttack(shooter, this.context)?.expectedDamage ?? 0,
                );
            }
        }
        const preventedDamage = (shooters: readonly Unit[], cells: readonly XY[]): number => {
            let total = 0;
            for (const shooter of shooters) {
                const before = baselineDamage.get(shooter.getId()) ?? 0;
                if (before <= 0) continue;
                const after = usePreparedGeometry
                    ? (findBestPreparedStationaryRangeAttack(stationarySearches.get(shooter.getId()), cells)
                          ?.expectedDamage ?? 0)
                    : (findBestLegalStationaryRangeAttack(shooter, this.context, cells)?.expectedDamage ?? 0);
                total += Math.max(0, before - after);
            }
            return total;
        };

        let best: { cell: XY; score: number } | undefined;
        const seenAnchors = new Set<number>();
        // Sample candidate anchors along each enemy-ranger -> ally-centroid segment (midpoint is the highest-
        // value blocker; we also probe one cell either side for occupancy fit). Bounded by the grid.
        for (const e of enemyRangers) {
            const ec = e.getBaseCell();
            for (const frac of [0.45, 0.5, 0.55, 0.66]) {
                const anchor = {
                    x: Math.round(ec.x + (ax - ec.x) * frac),
                    y: Math.round(ec.y + (ay - ec.y) * frac),
                };
                // The 2x2 expands +x/+y from the anchor; slide a little to fit if the anchor is at the edge.
                for (const ox of [0, -1]) {
                    for (const oy of [0, -1]) {
                        const c = { x: anchor.x + ox, y: anchor.y + oy };
                        const anchorKey = (c.x << 8) | (c.y & 0xff);
                        if (seenAnchors.has(anchorKey)) continue;
                        seenAnchors.add(anchorKey);
                        const cells = [c, { x: c.x + 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x + 1, y: c.y + 1 }];
                        if (!cells.every((cell) => isSmokeableCell(grid, isCellWithinGrid(gs, cell), cell))) {
                            continue;
                        }
                        const score = preventedDamage(enemyRangers, cells) - preventedDamage(alliedRangers, cells);
                        if (!best || score > best.score) {
                            best = { cell: c, score };
                        }
                    }
                }
            }
        }
        if (best && best.score > 0) {
            this.pushSpell(spell, undefined, best.cell, { expectedDamage: best.score });
        }
    }
    /**
     * Fire Wall candidate selection. Unlike Smoke (which shields us from shooters), a wall is a road block:
     * it is worth casting only where something is going to walk into it, so the anchors worth testing come
     * off the enemies that still have to close the distance.
     *
     * For each such enemy, anchors are sampled along the segment from it to our army's centroid — that
     * segment IS its approach — and the wall is laid across that line, picking whichever of the four
     * orientations is closest to perpendicular so the enemy cannot simply walk around the end of it.
     *
     * Scored by the threat being blocked over how far down the approach the wall sits (nearer the enemy =
     * it pays the toll sooner, and has less room to path around). Determinism: strict improvement only,
     * walked in enemy then fraction order, so ties keep the first wall and the lookahead stays reproducible.
     */
    private addFireWallCastCandidates(spell: Spell): void {
        const { grid } = this.context;
        const gs = grid.getSettings();
        const allies = [this.unit, ...this.allies].filter((u) => !u.isDead());
        const blockable = this.enemies.filter((e) => !e.isDead() && !isHidden(e));
        if (!allies.length || !blockable.length) {
            return;
        }

        let ax = 0;
        let ay = 0;
        for (const a of allies) {
            const c = a.getBaseCell();
            ax += c.x;
            ay += c.y;
        }
        ax = Math.round(ax / allies.length);
        ay = Math.round(ay / allies.length);

        const gridSize = gs.getGridSize();
        const plans: Array<{
            threat: number;
            orientations: number[];
            samples: Array<{ cell: XY; frac: number }>;
        }> = [];
        let best: { cell: XY; orientation: number; score: number } | undefined;
        const isLegalWall = (cell: XY, orientation: number): boolean =>
            fireWallCells(cell, orientation).every((c) => isFireWallableCell(grid, isCellWithinGrid(gs, c), c));
        for (const e of blockable) {
            const ec = e.getBaseCell();
            const dx = ax - ec.x;
            const dy = ay - ec.y;
            const approach = Math.hypot(dx, dy);
            if (approach < 1) {
                continue; // already on top of us — a wall behind it blocks nothing.
            }
            // Threat this enemy represents if it reaches us, and thus what blocking it is worth.
            const threat = Math.max(1, e.getAmountAlive()) * Math.max(1, e.getAttackDamageMax());
            // Try orientations closest to perpendicular first. If the ideal rotation crosses an edge/body,
            // another legal rotation at that exact approach anchor is still a useful wall.
            const orientations = FIRE_WALL_ORIENTATIONS.map((orientation, index) => {
                const [a0, a1] = fireWallCells({ x: 0, y: 0 }, orientation);
                const wx = a1.x - a0.x;
                const wy = a1.y - a0.y;
                return {
                    orientation,
                    index,
                    alignment: Math.abs((wx * dx + wy * dy) / (Math.hypot(wx, wy) * approach)),
                };
            })
                .sort((left, right) => left.alignment - right.alignment || left.index - right.index)
                .map(({ orientation }) => orientation);
            const samples = [0.25, 0.35, 0.5].map((frac) => ({
                frac,
                cell: {
                    x: Math.round(ec.x + dx * frac),
                    y: Math.round(ec.y + dy * frac),
                },
            }));
            plans.push({ threat, orientations, samples });
            for (const { cell: anchor, frac } of samples) {
                const score = threat / Math.max(frac, 0.01);
                for (const orientation of orientations) {
                    if (!isLegalWall(anchor, orientation)) {
                        continue;
                    }
                    if (!best || score > best.score) {
                        best = { cell: anchor, orientation, score };
                    }
                    break;
                }
            }
        }

        // At a field edge every sampled centre can be invalid even though shifting the wall one cell sideways
        // still blocks the same approach. Only pay for this bounded full-grid fallback when all exact samples
        // failed. Score by proximity to the sampled approach cells; stable plan/x/y/orientation order resolves
        // ties deterministically.
        if (!best) {
            for (const { threat, orientations, samples } of plans) {
                for (let x = 0; x < gridSize; x += 1) {
                    for (let y = 0; y < gridSize; y += 1) {
                        const cell = { x, y };
                        const distance = Math.min(
                            ...samples.map(({ cell: sample }) => Math.hypot(cell.x - sample.x, cell.y - sample.y)),
                        );
                        const score = threat / (1 + distance);
                        for (const orientation of orientations) {
                            if (!isLegalWall(cell, orientation)) {
                                continue;
                            }
                            if (!best || score > best.score) {
                                best = { cell, orientation, score };
                            }
                            break;
                        }
                    }
                }
            }
        }
        if (best) {
            // A newly placed wall deals no immediate damage; its internal threat score chooses geometry only.
            this.pushSpell(spell, undefined, best.cell, {}, best.orientation);
        }
    }
    /**
     * What an offensive spell would actually land on `target`, from the same multiplier-aware helper the
     * engine deals and the spellbook card prints. This covers both flat-per-caster Battle Mage damage and
     * stack-powered Magic Dragon damage.
     */
    private offensiveSpellDamage(spell: Spell, target: Unit): { value: number; kill: 0 | 1 } {
        const rawDamage = spellDamageAgainstUnit(spell, spellRawDamage(spell, this.unit), target);
        const targetHp = target.getCumulativeHp();
        return { value: Math.min(rawDamage, targetHp), kill: rawDamage >= targetHp ? 1 : 0 };
    }
    /**
     * Ring of Fire spares the enemy it is aimed at and burns every other living stack touching that enemy's
     * full footprint, including allies. Mirror the engine's exact geometry/filtering so an empty ring is never
     * proposed, then score enemy damage positively and friendly fire negatively.
     */
    private ringOfFireDamage(spell: Spell, target: Unit): { value: number; kill: 0 | 1 } | undefined {
        const cells = getCellsAroundFootprint(
            this.context.grid.getSettings(),
            target.isSmallSize() ? [target.getBaseCell()] : target.getCells(),
        );
        const caught = (evaluateAffectedUnits(cells, this.context.unitsHolder, this.context.grid)?.[0] ?? []).filter(
            (unit) => !unit.isDead() && unit.getId() !== this.unit.getId() && unit.getId() !== target.getId(),
        );
        if (!caught.length) {
            return undefined;
        }

        let value = 0;
        let kill: 0 | 1 = 0;
        for (const victim of caught) {
            const damage = this.offensiveSpellDamage(spell, victim);
            if (victim.getTeam() === this.enemyTeam) {
                value += damage.value;
                if (damage.kill) {
                    kill = 1;
                }
            } else {
                value -= damage.value;
            }
        }
        return { value, kill };
    }
    /**
     * A thrown spell must actually REACH the unit we are scoring. Terrain refuses it outright, and a screening
     * body intercepts it (Fire Strike) or refuses it (Vine Throw, Ring of Fire) — either way the aimed target
     * is not the one that gets hit, so proposing it would mis-attribute the damage.
     *
     * Only Fire Strike is arced over the caster's own troops, matching the engine; for the other throws a
     * friendly body blocks the lane exactly as an enemy one does.
     */
    private hasTargetedSpellLineOfSight(spell: Spell, target: Unit): boolean {
        const gs = this.context.grid.getSettings();
        const allUnits = this.context.unitsHolder.getAllUnits();
        return thrownSpellReachesAimedTarget(
            spell.getName(),
            this.context.grid,
            (cell) => isCellWithinGrid(gs, cell),
            this.unit.getBaseCell(),
            target.getBaseCell(),
            spell.getName() === "Fire Strike"
                ? (unitId) => allUnits.get(unitId)?.getTeam() === this.unit.getTeam()
                : undefined,
            target.getCells(),
        );
    }
    /**
     * Meteorite candidate selection. Unlike Smoke this is pure offence, and the engine REFUSES a drop that
     * catches nobody, so only blocks holding at least one enemy are enumerated.
     *
     * Serves both meteor spells. Meteorite drops a 2x2 anchored at its bottom-left corner — an even-sided block
     * has no centre cell to pivot on — while the Magic Dragon's Meteor Shower drops a 3x3 anchored at its
     * CENTRE. Either way the anchors worth testing come off every OCCUPIED enemy cell, not only its base cell:
     * a large unit can be caught by a block whose anchor lies two cells from its base. The offsets below cover
     * every block that can catch any enemy footprint while a set prevents overlapping footprints from making
     * us evaluate the same anchor repeatedly.
     *
     * Scored by damage that isn't overkill (a stack only has so much health to take) plus the kills it lands.
     * Determinism: strict improvement only, walked in enemy then offset order, so ties keep the first block and
     * the lookahead stays reproducible.
     */
    private addMeteoriteCastCandidates(spell: Spell): void {
        const { grid, unitsHolder } = this.context;
        const gs = grid.getSettings();
        const rawDamage = spellRawDamage(spell, this.unit);
        if (rawDamage <= 0) {
            return;
        }

        // 3x3 about the centre for Meteor Shower, 2x2 up-and-right of the corner for Meteorite.
        const spread = spell.getName() === "Meteor Shower" ? [-1, 0, 1] : [0, 1];
        const anchorOffsets = spell.getName() === "Meteor Shower" ? [-1, 0, 1] : [0, -1];

        let best: { cell: XY; value: number; kill: 0 | 1 } | undefined;
        const seenAnchors = new Set<string>();
        for (const enemy of this.enemies) {
            for (const ec of enemy.getCells()) {
                for (const ox of anchorOffsets) {
                    for (const oy of anchorOffsets) {
                        const anchor = { x: ec.x + ox, y: ec.y + oy };
                        const anchorKey = `${anchor.x},${anchor.y}`;
                        if (seenAnchors.has(anchorKey)) {
                            continue;
                        }
                        seenAnchors.add(anchorKey);
                        const cells: XY[] = [];
                        for (const dx of spread) {
                            for (const dy of spread) {
                                cells.push({ x: anchor.x + dx, y: anchor.y + dy });
                            }
                        }
                        if (cells.some((c) => !isCellWithinGrid(gs, c))) {
                            continue;
                        }
                        const caught = evaluateAffectedUnits(cells, unitsHolder, grid)?.[0] ?? [];
                        let value = 0;
                        let kill: 0 | 1 = 0;
                        for (const unit of caught) {
                            if (unit.getTeam() === this.unit.getTeam() || unit.isDead()) {
                                continue;
                            }
                            const dealt = spellDamageAgainstUnit(spell, rawDamage, unit);
                            const hp = unit.getCumulativeHp();
                            value += Math.min(dealt, hp);
                            if (dealt >= hp) {
                                kill = 1;
                            }
                        }
                        if (value <= 0) {
                            continue;
                        }
                        if (!best || value > best.value) {
                            best = { cell: anchor, value, kill };
                        }
                    }
                }
            }
        }
        if (best) {
            this.pushSpell(spell, undefined, best.cell, { expectedDamage: best.value, expectedKill: best.kill });
        }
    }
    private addSpells(): void {
        const spells = this.unit.getSpells();
        if (!spells.length) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const matrix = this.context.matrix;
        const gs = grid.getSettings();
        const team = this.unit.getTeam();
        const livingAllies = [this.unit, ...this.allies];
        let castlingCells: XY[] | undefined;

        for (const spell of spells) {
            if (!this.canUseSpell(spell)) {
                continue;
            }
            const targetType = spell.getSpellTargetType();

            if (spell.isSummon() && targetType === SpellTargetType.RANDOM_CLOSE_TO_CASTER) {
                const amount = Math.floor(this.unit.getAmountAlive() * spell.getPower());
                if (amount <= 0) {
                    continue;
                }
                // Deterministic (RNG-free) summon cell: the first anchor around the caster that the
                // summoned creature actually FITS on. Asking only whether ONE cell is empty was right
                // while every summon was a 1x1; now that the mounted class ships 2x1, a free cell is a
                // coin flip on whether the body fits — and the engine refuses an EXPLICIT cell outright
                // rather than re-routing it (only its own fallback retries), so the cast was simply lost.
                // Ring the caster's whole FOOTPRINT too: from the base cell alone, a rectangular
                // summoner offers spots that hug one end of its body.
                const summonFootprint = getCreatureFootprint(
                    ToFactionName[spell.getSummonUnitRace()],
                    spell.getSummonUnitName(),
                );
                const cell = firstSummonableAnchor(
                    spell,
                    matrix,
                    getCellsAroundFootprint(gs, this.unit.getCells()),
                    summonFootprint.width,
                    summonFootprint.height,
                );
                if (cell) {
                    this.pushSpell(spell, undefined, { x: cell.x, y: cell.y });
                }
                continue;
            }

            if (
                targetType === SpellTargetType.ALL_ALLIES ||
                targetType === SpellTargetType.ALL_ENEMIES ||
                targetType === SpellTargetType.ALL_FLYING
            ) {
                // Mass cast (e.g. Valkyrie's Wind Flow = ALL_FLYING) — exact engine gate.
                if (
                    canMassCastSpell(
                        spell,
                        unitsHolder.getAllTeamUnitsBuffs(team),
                        unitsHolder.getAllEnemyUnitsBuffs(team),
                        unitsHolder.getAllEnemyUnitsDebuffs(team),
                        unitsHolder.getAllTeamUnitsMagicResist(team),
                        unitsHolder.getAllEnemyUnitsMagicResist(team),
                        unitsHolder.getAllTeamUnitsHp(team),
                        unitsHolder.getAllTeamUnitsMaxHp(team),
                        unitsHolder.getAllTeamUnitsCanFly(team),
                        unitsHolder.getAllEnemyUnitsCanFly(team),
                    )
                ) {
                    this.pushSpell(spell);
                }
                continue;
            }

            if (targetType === SpellTargetType.ANY_ALLY) {
                for (const ally of livingAllies) {
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            ally,
                            spell,
                            ally.getBaseCell(),
                            ally.getMagicResist(),
                            ally.hasMindAttackResistance(),
                            ally.canBeHealed(),
                            undefined,
                        )
                    ) {
                        this.pushSpell(spell, ally.getId());
                    }
                }
                continue;
            }

            if (targetType === SpellTargetType.ANY_ENEMY) {
                for (const enemy of this.enemies) {
                    // handleMagicAttack rejects Hidden enemy targets before canCastSpell runs.
                    if (isHidden(enemy)) {
                        continue;
                    }
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            enemy,
                            spell,
                            enemy.getBaseCell(),
                            enemy.getMagicResist(),
                            enemy.hasMindAttackResistance(),
                            enemy.canBeHealed(),
                            undefined,
                        )
                    ) {
                        // A thrown spell must clear the same exact line the engine checks. This includes Vine
                        // Throw even though it is a status spell, not an offensive-damage multiplier.
                        if (!this.hasTargetedSpellLineOfSight(spell, enemy)) {
                            continue;
                        }
                        // An offensive spell must be valued at the damage it lands — a debuff candidate carries
                        // neither number. Called-down spells have no line to keep.
                        if (isOffensiveSpellMultiplier(spell.getMultiplierType())) {
                            if (spell.getName() === "Ring of Fire") {
                                const damage = this.ringOfFireDamage(spell, enemy);
                                if (!damage) {
                                    continue;
                                }
                                this.pushSpell(spell, enemy.getId(), undefined, {
                                    expectedDamage: damage.value,
                                    expectedKill: damage.kill,
                                });
                                continue;
                            }
                            const damage = this.offensiveSpellDamage(spell, enemy);
                            this.pushSpell(spell, enemy.getId(), undefined, {
                                expectedDamage: damage.value,
                                expectedKill: damage.kill,
                            });
                            continue;
                        }
                        this.pushSpell(spell, enemy.getId());
                    }
                }
                continue;
            }

            if (targetType === SpellTargetType.ALLIES_AREA) {
                this.addAlliesAreaCastCandidates(spell);
                continue;
            }

            if (targetType === SpellTargetType.FREE_CELL && spell.getName() === "Smoke") {
                this.addSmokeCastCandidates(spell);
                continue;
            }

            if (targetType === SpellTargetType.FREE_CELL && spell.getName() === "Fire Wall") {
                this.addFireWallCastCandidates(spell);
                continue;
            }

            if (
                targetType === SpellTargetType.FREE_CELL &&
                (spell.getName() === "Meteorite" || spell.getName() === "Meteor Shower")
            ) {
                this.addMeteoriteCastCandidates(spell);
                continue;
            }

            if (targetType === SpellTargetType.ENEMY_WITHIN_MOVEMENT_RANGE) {
                // Castling swaps two SMALL units. Predatory Assimilation can install the spell on a large
                // Arachna Queen, but that inherited cast is not engine-legal and must never be enumerated.
                if (!this.unit.isSmallSize()) {
                    continue;
                }
                // The legality list is computed once per decision; the engine must see the same list through
                // its own context callback (see getEnemiesCellsWithinMovementRange docs).
                castlingCells ??= getEnemiesCellsWithinMovementRange(this.unit, this.context);
                if (!castlingCells.length) {
                    continue;
                }
                for (const enemy of this.enemies) {
                    if (isHidden(enemy) || !enemy.isSmallSize()) {
                        continue;
                    }
                    const bc = enemy.getBaseCell();
                    if (!castlingCells.some((c) => c.x === bc.x && c.y === bc.y)) {
                        continue;
                    }
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            enemy,
                            spell,
                            bc,
                            enemy.getMagicResist(),
                            enemy.hasMindAttackResistance(),
                            enemy.canBeHealed(),
                            castlingCells,
                        )
                    ) {
                        this.pushSpell(spell, enemy.getId(), { x: bc.x, y: bc.y });
                    }
                }
                continue;
            }
            // AUTO / other target types: not directly castable through the cast_spell action — skip.
        }
    }
}
