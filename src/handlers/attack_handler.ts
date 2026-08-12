/*
 * -----------------------------------------------------------------------------
 * This file is part of the browser implementation of the Heroes of Crypto game client.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import * as AllAbilities from "../abilities";
import * as HoCLib from "../utils/lib";
import * as HoCMath from "../utils/math";
import * as GridMath from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { Grid } from "../grid/grid";
import { traceGridRayCells } from "../grid/ray_traversal";
import { amplifyCastBuffForTarget } from "../spells/castable_buff";
import * as SpellHelper from "../spells/spell_helper";
import { SpellPowerType } from "../spells/spell_properties";
import type { IWeightedRoute } from "../grid/path_definitions";
import { Spell } from "../spells/spell";
import { SmokeClouds } from "../spells/smoke_clouds";
import * as HoCConstants from "../constants";
import * as AbilityHelper from "../abilities/ability_helper";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { IAbilityTransfer } from "../engine/events";
import { Unit } from "../units/unit";
import { recordEffectApplication } from "../units/effect_application_capture";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import * as EffectHelper from "../effects/effect_helper";
import { MoveHandler } from "./move_handler";
import type { IAnimationData } from "../scene/animations";
import type { IBoardObj } from "../units/unit";
import type { IVisibleDamage } from "../scene/animations";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import { PBTypes } from "../generated/protobuf/v1/types";
import { canUnitRespondToMelee } from "./melee_response";

export interface IRangeAttackEvaluation {
    rangeAttackDivisors: number[];
    affectedUnits: Array<Unit[]>;
    affectedCells: Array<HoCMath.XY[]>;
    attackObstacle?: IAttackObstacle;
}

/**
 * Immutable trajectory/interception geometry for repeatedly evaluating one unchanged ranged shot.
 *
 * The object deliberately exposes only the resolved geometry. Smoke-prefix indexes and uncapped base
 * divisors live in module-private metadata, so callers cannot accidentally invalidate a prepared ray. This
 * API intentionally does not hash mutable Unit/Grid state: it is valid only inside a synchronous, mutation-
 * free planning scope. Live Smoke is the one supported mutable overlay and is re-read by
 * evaluatePreparedRangeAttack.
 *
 * @internal
 */
export interface IPreparedRangeAttackEvaluation {
    readonly affectedUnits: ReadonlyArray<ReadonlyArray<Unit>>;
    readonly affectedCells: ReadonlyArray<ReadonlyArray<Readonly<HoCMath.XY>>>;
    readonly attackObstacle?: Readonly<{
        position: Readonly<HoCMath.XY>;
        size: number;
        distance: number;
    }>;
}

interface IPreparedRangeAttackMetadata {
    readonly owner: AttackHandler;
    readonly rayCells: ReadonlyArray<Readonly<HoCMath.XY>>;
    readonly firstRayIndexBySmokeKey: ReadonlyMap<number, number>;
    readonly hitRayIndices: readonly number[];
    readonly baseRangeAttackDivisors: readonly number[];
    readonly liveSmokeClouds: SmokeClouds;
    readonly liveSmokeRevision: number;
    readonly liveSmokeByHit: readonly boolean[];
}

interface IRangeAttackPreparationCapture {
    readonly hitRayIndices: number[];
    readonly baseRangeAttackDivisors: number[];
    readonly liveSmokeByHit: boolean[];
}

const preparedRangeAttackMetadata = new WeakMap<IPreparedRangeAttackEvaluation, IPreparedRangeAttackMetadata>();

/**
 * Multiplier on a Resurrection cast's hit-point budget (the caster's cumulative max hp). 1.5 = the raise is
 * 50% stronger than the Angel stack's own health, so a single Angel is worth casting with. Applied before
 * Holy Cross, which scales the already-boosted budget like it does healing.
 */
export const RESURRECTION_POWER_FACTOR = 1.5;

export interface IAttackResult {
    completed: boolean;
    unitIdsDied: string[];
    animationData?: IAnimationData[];
    abilityStolen?: AllAbilities.IAbilityStolen[];
    /** Healing actually restored by this cast, so the caller can put it on the spell_cast event. */
    healed?: { unitId: string; amount: number }[];
    /** Stacks and health a RESURRECT cast brought back, for the spell_cast event. Same contract as `healed`. */
    resurrected?: { unitId: string; amount: number; hp: number; position: HoCMath.XY }[];
    /** Ability cards a giftable cast actually delivered, for authoritative replay/log/VFX. */
    abilityTransfers?: IAbilityTransfer[];
}

export interface IAttackObstacle {
    position: HoCMath.XY;
    size: number;
    distance: number;
}

export class AttackTarget implements IBoardObj {
    private readonly position: HoCMath.XY;
    private readonly size: number;
    private renderPosition: HoCMath.XY;
    public constructor(position: HoCMath.XY, size: number) {
        this.position = position;
        this.size = size;
        this.renderPosition = structuredClone(position);
    }
    public getPosition(): HoCMath.XY {
        return this.position;
    }
    public getRenderPosition(): HoCMath.XY {
        return this.renderPosition;
    }
    public isSmallSize(): boolean {
        return this.size === 1;
    }
    public setRenderPosition(x: number, y: number): void {
        this.renderPosition.x = x;
        this.renderPosition.y = y;
    }
}

export class AttackHandler {
    public readonly gridSettings: GridSettings;
    public readonly grid: Grid;
    public readonly sceneLog: ISceneLog;
    public readonly damageStatisticHolder: IStatisticHolder<IDamageStatistic>;
    public constructor(
        gridSettings: GridSettings,
        grid: Grid,
        sceneLog: ISceneLog,
        damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    ) {
        this.gridSettings = gridSettings;
        this.grid = grid;
        this.sceneLog = sceneLog;
        this.damageStatisticHolder = damageStatisticHolder;
    }
    public getDamageStatisticHolder(): IStatisticHolder<IDamageStatistic> {
        return this.damageStatisticHolder;
    }
    public getRangeAttackDivisor(
        attackerUnit: Unit,
        attackPosition: HoCMath.XY,
        attackerPosition: HoCMath.XY = attackerUnit.getPosition(),
    ): number {
        let rangeAttackDivisor = 1;

        // Range falloff: damage halves for every full shot-distance of range. Only the Sniper ability negates
        // it entirely. Farsight Quiver no longer removes falloff — instead it extends the archer's basic
        // shot_distance (adjustBaseStats), pushing this threshold out so full-damage range is larger.
        if (!attackerUnit.hasAbilityActive("Sniper")) {
            const shotDistancePixels = Math.ceil(attackerUnit.getRangeShotDistance() * this.gridSettings.getStep());
            let distance = HoCMath.getDistance(attackerPosition, attackPosition);
            while (distance >= shotDistancePixels) {
                distance -= shotDistancePixels;
                rangeAttackDivisor *= 2;
            }
        }
        if (rangeAttackDivisor < 1) {
            rangeAttackDivisor = 1;
        }
        if (rangeAttackDivisor > 8) {
            rangeAttackDivisor = 8;
        }

        return Math.floor(rangeAttackDivisor);
    }
    public evaluateRangeAttack(
        allUnits: ReadonlyMap<string, Unit>,
        fromUnit: Unit,
        fromPosition: HoCMath.XY,
        toPosition: HoCMath.XY,
        isThroughShot = false,
        isSelection = false,
        isAOEShot = false,
        hypotheticalSmokeCells?: readonly HoCMath.XY[],
        preparedHypotheticalSmokeKeys?: ReadonlySet<number>,
    ): IRangeAttackEvaluation {
        // Through Shot keeps travelling past the aimed target to the edge of the field, so it can
        // hit every unit standing on that line - not just the ones up to the hovered target.
        const lineEndPosition = isThroughShot
            ? GridMath.projectLineToFieldEdge(
                  this.gridSettings,
                  fromPosition.x,
                  fromPosition.y,
                  toPosition.x,
                  toPosition.y,
              )
            : toPosition;
        const intersectedCellsToPositions = traceGridRayCells(this.gridSettings, fromPosition, lineEndPosition);

        return this.getAffectedUnitsAndObstacles(
            allUnits,
            intersectedCellsToPositions,
            fromUnit,
            fromPosition,
            isThroughShot,
            isSelection,
            isAOEShot,
            hypotheticalSmokeCells,
            preparedHypotheticalSmokeKeys,
        );
    }
    /**
     * Resolve an unchanged shot's ray, unit groups, terrain interception and base falloff once. This is useful
     * for pure look-ahead overlays such as comparing many hypothetical Smoke placements. Normal one-off combat
     * should continue to call evaluateRangeAttack.
     *
     * @internal
     */
    public prepareRangeAttack(
        allUnits: ReadonlyMap<string, Unit>,
        fromUnit: Unit,
        fromPosition: HoCMath.XY,
        toPosition: HoCMath.XY,
        isThroughShot = false,
        isSelection = false,
        isAOEShot = false,
    ): IPreparedRangeAttackEvaluation {
        const lineEndPosition = isThroughShot
            ? GridMath.projectLineToFieldEdge(
                  this.gridSettings,
                  fromPosition.x,
                  fromPosition.y,
                  toPosition.x,
                  toPosition.y,
              )
            : toPosition;
        const cellsToPositions = traceGridRayCells(this.gridSettings, fromPosition, lineEndPosition);
        const smokeClouds = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
        const liveSmokeRevision = smokeClouds.getRevision();
        const capture: IRangeAttackPreparationCapture = {
            hitRayIndices: [],
            baseRangeAttackDivisors: [],
            liveSmokeByHit: [],
        };
        const evaluation = this.getAffectedUnitsAndObstacles(
            allUnits,
            cellsToPositions,
            fromUnit,
            fromPosition,
            isThroughShot,
            isSelection,
            isAOEShot,
            undefined,
            undefined,
            capture,
        );
        const affectedUnits = Object.freeze(
            evaluation.affectedUnits.map((group) => Object.freeze([...group]) as readonly Unit[]),
        );
        const affectedCells = Object.freeze(
            evaluation.affectedCells.map((group) =>
                Object.freeze(group.map((cell) => Object.freeze({ x: cell.x, y: cell.y }))),
            ),
        );
        const attackObstacle = evaluation.attackObstacle
            ? Object.freeze({
                  position: Object.freeze({
                      x: evaluation.attackObstacle.position.x,
                      y: evaluation.attackObstacle.position.y,
                  }),
                  size: evaluation.attackObstacle.size,
                  distance: evaluation.attackObstacle.distance,
              })
            : undefined;
        const prepared = Object.freeze({ affectedUnits, affectedCells, attackObstacle });
        const rayCells = Object.freeze(cellsToPositions.map(([cell]) => Object.freeze({ x: cell.x, y: cell.y })));
        const firstRayIndexBySmokeKey = new Map<number, number>();
        for (let index = 0; index < rayCells.length; index += 1) {
            const key = SmokeClouds.key(rayCells[index]);
            if (!firstRayIndexBySmokeKey.has(key)) {
                firstRayIndexBySmokeKey.set(key, index);
            }
        }
        preparedRangeAttackMetadata.set(prepared, {
            owner: this,
            rayCells,
            firstRayIndexBySmokeKey,
            hitRayIndices: Object.freeze(capture.hitRayIndices),
            baseRangeAttackDivisors: Object.freeze(capture.baseRangeAttackDivisors),
            liveSmokeClouds: smokeClouds,
            liveSmokeRevision,
            liveSmokeByHit: Object.freeze(capture.liveSmokeByHit),
        });
        return prepared;
    }
    /**
     * Apply current live Smoke plus an optional hypothetical footprint to prepared immutable geometry. Each
     * call returns caller-owned arrays, matching evaluateRangeAttack's mutation/ownership contract.
     *
     * @internal
     */
    public evaluatePreparedRangeAttack(
        prepared: IPreparedRangeAttackEvaluation,
        hypotheticalSmokeCells?: readonly HoCMath.XY[],
        preparedHypotheticalSmokeKeys?: ReadonlySet<number>,
    ): IRangeAttackEvaluation {
        const metadata = preparedRangeAttackMetadata.get(prepared);
        if (!metadata || metadata.owner !== this) {
            throw new TypeError("Prepared range attack was not created by this AttackHandler instance");
        }
        const hypotheticalSmokeKeys =
            preparedHypotheticalSmokeKeys ??
            (hypotheticalSmokeCells?.length
                ? new Set(hypotheticalSmokeCells.map((cell) => SmokeClouds.key(cell)))
                : undefined);
        const smokeClouds = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
        let liveSmokeByHit = metadata.liveSmokeByHit;
        if (smokeClouds !== metadata.liveSmokeClouds || smokeClouds.getRevision() !== metadata.liveSmokeRevision) {
            const recomputed: boolean[] = [];
            let pathCrossedSmoke = false;
            let nextHit = 0;
            for (
                let rayIndex = 0;
                rayIndex < metadata.rayCells.length && nextHit < metadata.hitRayIndices.length;
                rayIndex += 1
            ) {
                if (!pathCrossedSmoke && smokeClouds.has(metadata.rayCells[rayIndex])) {
                    pathCrossedSmoke = true;
                }
                while (metadata.hitRayIndices[nextHit] === rayIndex) {
                    recomputed.push(pathCrossedSmoke);
                    nextHit += 1;
                }
            }
            liveSmokeByHit = recomputed;
        }
        const rangeAttackDivisors = metadata.baseRangeAttackDivisors.map((baseDivisor, hitIndex) => {
            let pathCrossedSmoke = liveSmokeByHit[hitIndex] ?? false;
            if (!pathCrossedSmoke && hypotheticalSmokeKeys?.size) {
                const hitRayIndex = metadata.hitRayIndices[hitIndex];
                for (const smokeKey of hypotheticalSmokeKeys) {
                    const smokeRayIndex = metadata.firstRayIndexBySmokeKey.get(smokeKey);
                    if (smokeRayIndex !== undefined && smokeRayIndex <= hitRayIndex) {
                        pathCrossedSmoke = true;
                        break;
                    }
                }
            }
            return pathCrossedSmoke ? Math.min(8, baseDivisor * 2) : baseDivisor;
        });
        return {
            rangeAttackDivisors,
            affectedUnits: prepared.affectedUnits.map((group) => [...group]),
            affectedCells: prepared.affectedCells.map((group) => group.map((cell) => ({ x: cell.x, y: cell.y }))),
            attackObstacle: prepared.attackObstacle
                ? {
                      position: {
                          x: prepared.attackObstacle.position.x,
                          y: prepared.attackObstacle.position.y,
                      },
                      size: prepared.attackObstacle.size,
                      distance: prepared.attackObstacle.distance,
                  }
                : undefined,
        };
    }
    /** Ordered, de-duplicated obstacle cells crossed before the supplied aim point. */
    public getObstacleIntersections(fromPosition: HoCMath.XY, toPosition: HoCMath.XY): IAttackObstacle[] {
        const seen = new Set<string>();
        const obstacles: IAttackObstacle[] = [];
        for (const [cell, position] of traceGridRayCells(this.gridSettings, fromPosition, toPosition)) {
            if (this.grid.getOccupantUnitId(cell) !== "B") {
                continue;
            }
            const key = `${cell.x}:${cell.y}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            obstacles.push({
                position: { ...position },
                size: 1,
                distance: HoCMath.getDistance(fromPosition, position),
            });
        }
        return obstacles;
    }
    /**
     * Area Throw projection (e.g. Gargantuan): a thrown AOE shot is intercepted by the first enemy
     * unit standing on the straight line between the attacker and the aimed cell. Returns that
     * unit's base cell so the splash "projects to it" instead of the throw passing through to the
     * empty cell behind. When the path is clear, the aimed cell is returned unchanged. Mirrors the
     * original Area Throw behaviour, where a unit on the trajectory intercepts the throw.
     */
    public projectAreaThrowTargetCell(
        allUnits: ReadonlyMap<string, Unit>,
        attackerUnit: Unit,
        targetCell: HoCMath.XY,
    ): HoCMath.XY {
        const targetPosition = GridMath.getPositionForCell(
            targetCell,
            this.gridSettings.getMinX(),
            this.gridSettings.getStep(),
            this.gridSettings.getHalfStep(),
        );
        const evaluation = this.evaluateRangeAttack(
            allUnits,
            attackerUnit,
            attackerUnit.getPosition(),
            targetPosition,
            false, // isThroughShot
            false, // isSelection
            true, // isAOEShot (Area Throw splash semantics)
        );
        const interceptingUnit = evaluation.affectedUnits?.[0]?.[0];
        const interceptedCell = interceptingUnit?.getBaseCell();
        if (interceptedCell) {
            return { x: interceptedCell.x, y: interceptedCell.y };
        }
        return { x: targetCell.x, y: targetCell.y };
    }
    public canLandRangeAttack(unit: Unit, aggrMatrix?: number[][]): boolean {
        return (
            // isRangeCapable, not attack_type === RANGE: a melee unit holding a stolen Endless Quiver
            // (Predatory Assimilation) is a legitimate shooter too.
            unit.isRangeCapable() &&
            !this.canBeAttackedByMelee(unit.getPosition(), unit.isSmallSize(), aggrMatrix) &&
            unit.getRangeShots() > 0 &&
            !unit.hasDebuffActive("Range Null Field Aura") &&
            // hasStatusApplied for Rangebane: it is applied in COMBAT (Spit Ball), so a ranked client — which
            // leaves the debuff OBJECT arrays empty by design — answered "no Rangebane" forever and kept
            // offering a shot the server refuses. The aura above needs no bridge; auras are reconciled from
            // the snapshot. This method is called straight from the client, so the rule has to hold here too.
            !unit.hasStatusApplied("Rangebane")
        );
    }
    public canBeAttackedByMelee(unitPosition: HoCMath.XY, isSmallUnit: boolean, enemyAggrMatrix?: number[][]): boolean {
        let cells: HoCMath.XY[];
        if (isSmallUnit) {
            const cell = GridMath.getCellForPosition(this.gridSettings, unitPosition);
            if (cell) {
                cells = [cell];
            } else {
                cells = [];
            }
        } else {
            cells = GridMath.getCellsAroundPosition(this.gridSettings, unitPosition);
        }

        for (const cell of cells) {
            if (enemyAggrMatrix && enemyAggrMatrix[cell.x][cell.y] > 1) {
                return true;
            }
        }

        return false;
    }
    public handleMagicAttack(
        gridMatrix: number[][],
        unitsHolder: UnitsHolder,
        currentActiveSpell?: Spell,
        attackerUnit?: Unit,
        targetUnit?: Unit,
        currentEnemiesCellsWithinMovementRange?: HoCMath.XY[],
    ): IAttackResult {
        const animationData: IAnimationData[] = [];
        const unitIdsDied: string[] = [];
        // Healing restored by this cast, reported on the result so the spell_cast event can carry it
        // (ranked's scene log is rebuilt from events, not from this handler's own log text).
        const healedUnits: { unitId: string; amount: number }[] = [];
        // Stacks the cast raised, reported on the result so the spell_cast event can carry them (ranked's
        // scene log and resurrection VFX are both rebuilt from events, not from this handler's log text).
        const resurrectedUnits: { unitId: string; amount: number; hp: number; position: HoCMath.XY }[] = [];
        // Ability cards this cast moved. A snapshot can show the resulting card lists, but it cannot say
        // WHEN the transfer happened (or distinguish Holy Cross copy from a pre-existing caster card), so
        // ranked needs the exact outcome on the spell event just like heals and resurrection do.
        const abilityTransfers: IAbilityTransfer[] = [];
        if (!currentActiveSpell || !attackerUnit) {
            return { completed: false, unitIdsDied, animationData };
        }

        if (targetUnit && targetUnit.getTeam() !== attackerUnit.getTeam() && targetUnit.hasBuffActive("Hidden")) {
            return { completed: false, unitIdsDied, animationData };
        }

        if (
            targetUnit &&
            SpellHelper.canCastSpell(
                false,
                this.gridSettings,
                gridMatrix,
                attackerUnit,
                targetUnit,
                currentActiveSpell,
                targetUnit.getBaseCell(),
                targetUnit.getMagicResist(),
                targetUnit.hasMindAttackResistance(),
                targetUnit.canBeHealed(),
                currentEnemiesCellsWithinMovementRange,
            )
        ) {
            let applied = true;
            let mirroredStr = "";
            const laps = currentActiveSpell.getLapsTotal();
            let clarifyingStr = `for ${HoCLib.getLapString(laps)}`;
            // ARTIFACT Holy Cross: +50% healing & resurrection, and the caster keeps a giftable ability
            // (e.g. the Troll's Wild Regeneration) instead of consuming it on cast.
            const holyCrossBuff = attackerUnit.getBuff("Holy Cross");
            const holyCrossFactor = holyCrossBuff ? 1 + holyCrossBuff.getPower() / 100 : 1;
            if (currentActiveSpell.isBuff()) {
                if (currentActiveSpell.getPowerType() === SpellPowerType.HEAL) {
                    if (currentActiveSpell.isGiftable()) {
                        const deletedAbility = holyCrossBuff
                            ? attackerUnit.getAbility(currentActiveSpell.getName())
                            : attackerUnit.deleteAbility(currentActiveSpell.getName());
                        // Break disables `hasAbilityActive`, but does not remove the durable card. Use the
                        // stored lists here so a broken ally can genuinely receive a new gift (and an ally
                        // that already owns the disabled card is not mistaken for an empty recipient).
                        const targetProperties = targetUnit.getUnitProperties();
                        const targetAlreadyOwnsAbility =
                            targetProperties.abilities.includes(currentActiveSpell.getName()) &&
                            !targetProperties.stolen_abilities?.includes(currentActiveSpell.getName());
                        if (!targetAlreadyOwnsAbility && deletedAbility) {
                            targetUnit.addAbility(deletedAbility);
                            const recipientProperties = targetUnit.getUnitProperties();
                            const delivered =
                                recipientProperties.abilities.includes(deletedAbility.getName()) &&
                                !recipientProperties.stolen_abilities?.includes(deletedAbility.getName());
                            if (delivered) {
                                abilityTransfers.push({
                                    abilityName: deletedAbility.getName(),
                                    fromUnitId: attackerUnit.getId(),
                                    toUnitId: targetUnit.getId(),
                                    mode: holyCrossBuff ? "copied" : "gifted",
                                });
                            }
                        }
                        clarifyingStr = holyCrossBuff ? `=> copied` : `=> gifted`;
                    } else {
                        const healPower = targetUnit.applyHeal(
                            Math.floor(currentActiveSpell.getPower() * attackerUnit.getAmountAlive() * holyCrossFactor),
                        );
                        clarifyingStr = `for ${healPower} hp`;
                        if (healPower) {
                            healedUnits.push({ unitId: targetUnit.getId(), amount: healPower });
                        }
                    }
                } else if (currentActiveSpell.getPowerType() === SpellPowerType.RESURRECT) {
                    const wasHp = targetUnit.getHp();
                    const resurrectedAmount = targetUnit.applyResurrection(
                        Math.floor(attackerUnit.getCumulativeMaxHp() * RESURRECTION_POWER_FACTOR * holyCrossFactor),
                    );
                    const restoredHp = targetUnit.getHp() - wasHp;
                    if (resurrectedAmount) {
                        clarifyingStr = `for ${resurrectedAmount} units`;
                    } else {
                        clarifyingStr = `for ${restoredHp} hp`;
                    }
                    if (resurrectedAmount || restoredHp) {
                        resurrectedUnits.push({
                            unitId: targetUnit.getId(),
                            amount: resurrectedAmount,
                            hp: restoredHp,
                            position: { ...targetUnit.getPosition() },
                        });
                    }
                    unitsHolder.refreshStackPowerForAllUnits();
                } else {
                    const appliedBuff = amplifyCastBuffForTarget(currentActiveSpell, attackerUnit, targetUnit);
                    targetUnit.applyBuff(
                        appliedBuff,
                        attackerUnit.getMaxHp(),
                        attackerUnit.getBaseArmor(),
                        attackerUnit.getId() === targetUnit.getId(),
                    );
                }
            } else if (
                HoCLib.getRandomInt(0, 100) < Math.floor(targetUnit.getMagicResist()) ||
                (currentActiveSpell.getPowerType() === SpellPowerType.MIND && targetUnit.hasMindAttackResistance())
            ) {
                applied = false;
            } else {
                // effect can be absorbed
                let debuffTarget = targetUnit;

                const absorptionTarget = EffectHelper.getAbsorptionTarget(
                    debuffTarget,
                    this.grid,
                    unitsHolder,
                    this.sceneLog,
                );
                if (absorptionTarget) {
                    debuffTarget = absorptionTarget;
                }

                const laps = currentActiveSpell.getLapsTotal();

                if (!(
                    currentActiveSpell.getPowerType() === SpellPowerType.MIND && debuffTarget.hasMindAttackResistance()
                )) {
                    // Castling's one-cell swap is only defined for two small units. Re-check the effective
                    // target after Absorb Penalties redirection so an aura cannot collapse a large unit's
                    // 2x2 footprint into a single occupied cell.
                    if (
                        currentActiveSpell.getPowerType() === SpellPowerType.POSITION_CHANGE &&
                        (!attackerUnit.isSmallSize() || !debuffTarget.isSmallSize())
                    ) {
                        applied = false;
                    } else if (currentActiveSpell.getPowerType() === SpellPowerType.POSITION_CHANGE) {
                        const attackerUnitPosition = structuredClone(attackerUnit.getPosition());
                        const targetUnitPosition = structuredClone(debuffTarget.getPosition());
                        const attackerBaseCell = attackerUnit.getBaseCell();
                        const debuffTargetBaseCell = debuffTarget.getBaseCell();
                        if (attackerBaseCell && debuffTargetBaseCell) {
                            const initialAttackerCell = structuredClone(attackerBaseCell);
                            const initialTargetUnitCell = structuredClone(debuffTargetBaseCell);

                            this.grid.cleanupAll(
                                attackerUnit.getId(),
                                attackerUnit.getAttackRange(),
                                attackerUnit.isSmallSize(),
                            );
                            this.grid.cleanupAll(
                                debuffTarget.getId(),
                                debuffTarget.getAttackRange(),
                                debuffTarget.isSmallSize(),
                            );

                            const newAttackerPosition = GridMath.getPositionForCell(
                                initialTargetUnitCell,
                                this.gridSettings.getMinX(),
                                this.gridSettings.getStep(),
                                this.gridSettings.getHalfStep(),
                            );
                            attackerUnit.setPosition(newAttackerPosition.x, newAttackerPosition.y, false);
                            this.grid.occupyCell(
                                initialTargetUnitCell,
                                attackerUnit.getId(),
                                attackerUnit.getTeam(),
                                attackerUnit.getAttackRange(),
                                attackerUnit.canTraverseLava(),
                                attackerUnit.hasAbilityActive("Made of Water"),
                            );

                            const newTargetUnitPosition = GridMath.getPositionForCell(
                                initialAttackerCell,
                                this.gridSettings.getMinX(),
                                this.gridSettings.getStep(),
                                this.gridSettings.getHalfStep(),
                            );
                            debuffTarget.setPosition(newTargetUnitPosition.x, newTargetUnitPosition.y, false);
                            this.grid.occupyCell(
                                initialAttackerCell,
                                debuffTarget.getId(),
                                debuffTarget.getTeam(),
                                debuffTarget.getAttackRange(),
                                debuffTarget.canTraverseLava(),
                                debuffTarget.hasAbilityActive("Made of Water"),
                            );

                            animationData.push(
                                {
                                    toPosition: targetUnitPosition,
                                    affectedUnit: attackerUnit,
                                    bodyUnit: attackerUnit,
                                },
                                {
                                    toPosition: attackerUnitPosition,
                                    affectedUnit: debuffTarget,
                                    bodyUnit: debuffTarget,
                                },
                            );
                        }
                    } else {
                        debuffTarget.applyDebuff(
                            currentActiveSpell,
                            undefined,
                            undefined,
                            attackerUnit.getId() === targetUnit.getId(),
                        );
                    }
                }

                // The "already applied" guard has to look at the unit that is about to RECEIVE the mirrored
                // copy — the attacker — not at the one that just took the original. Reading it off
                // debuffTarget made this branch dead code: the debuff is applied to debuffTarget a few lines
                // above, so the check was always true and no debuff was ever mirrored. The mass-cast path in
                // GameActionEngine already checks the caster; this now matches it.
                if (
                    currentActiveSpell.getPowerType() !== SpellPowerType.POSITION_CHANGE &&
                    SpellHelper.isMirrored(debuffTarget) &&
                    !SpellHelper.hasAlreadyAppliedSpell(attackerUnit, currentActiveSpell) &&
                    !(
                        currentActiveSpell.getPowerType() === SpellPowerType.MIND &&
                        attackerUnit.hasMindAttackResistance()
                    )
                ) {
                    // Extended, always. A mirrored debuff lands on the unit whose turn is ending THIS
                    // instant, so without the extra lap a 1-lap debuff (Whirlpool) would be consumed by the
                    // caster's own completeTurn and the mirror would do nothing at all. This is the same
                    // reason a self-cast gets the +1 — see the `extend` argument of applyDebuff.
                    attackerUnit.applyDebuff(currentActiveSpell, undefined, undefined, true);
                    mirroredStr = `${debuffTarget.getName()} mirrored ${currentActiveSpell.getName()} to ${attackerUnit.getName()} for ${HoCLib.getLapString(
                        laps,
                    )}`;
                }
            }

            if (currentActiveSpell.isSelfDebuffApplicable()) {
                // effect can be absorbed
                let debuffTarget = attackerUnit;
                const absorptionTarget = EffectHelper.getAbsorptionTarget(
                    debuffTarget,
                    this.grid,
                    unitsHolder,
                    this.sceneLog,
                );
                if (absorptionTarget) {
                    debuffTarget = absorptionTarget;
                }

                if (
                    !SpellHelper.hasAlreadyAppliedSpell(debuffTarget, currentActiveSpell) &&
                    !(
                        currentActiveSpell.getPowerType() === SpellPowerType.MIND &&
                        debuffTarget.hasMindAttackResistance()
                    )
                ) {
                    debuffTarget.applyDebuff(
                        currentActiveSpell,
                        attackerUnit.getMaxHp(),
                        attackerUnit.getBaseArmor(),
                        true,
                    );
                }
            }

            attackerUnit.useSpell(currentActiveSpell.getName());
            let newText = `${attackerUnit.getName()} cast ${currentActiveSpell.getName()}`;
            if (attackerUnit.getId() === targetUnit.getId()) {
                newText += ` on themselves ${clarifyingStr}`;
            } else {
                newText += ` on ${targetUnit.getName()} ${clarifyingStr}`;
            }
            this.sceneLog.updateLog(newText);
            if (!applied) {
                this.sceneLog.updateLog(`${targetUnit.getName()} resisted from ${currentActiveSpell.getName()}`);
                recordEffectApplication({
                    unitId: targetUnit.getId(),
                    name: currentActiveSpell.getName(),
                    kind: "debuff",
                    resisted: true,
                });
            }
            this.sceneLog.updateLog(mirroredStr);

            return {
                completed: true,
                unitIdsDied,
                animationData,
                healed: healedUnits,
                resurrected: resurrectedUnits,
                abilityTransfers,
            };
        }

        return { completed: false, unitIdsDied, animationData };
    }
    public handleRangeAttack(
        unitsHolder: UnitsHolder,
        hoverRangeAttackDivisors: number[],
        rangeResponseAttackDivisor: number,
        damageForAnimation: IVisibleDamage,
        attackerUnit?: Unit,
        targetUnits?: Array<Unit[]>,
        rangeResponseUnits?: Unit[],
        hoverRangeAttackPosition?: HoCMath.XY,
        isAOE = false,
        decreaseNumberOfShots = true,
        suppressDoubleShot = false,
    ): IAttackResult {
        const unitIdsDied: string[] = [];
        const animationData: IAnimationData[] = [];
        const abilityStolen: AllAbilities.IAbilityStolen[] = [];
        if (
            !attackerUnit ||
            attackerUnit.isDead() ||
            // AOE attack can have zero target units
            (!targetUnits?.length && !isAOE) ||
            !hoverRangeAttackDivisors.length ||
            !hoverRangeAttackPosition ||
            attackerUnit.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE ||
            !this.canLandRangeAttack(attackerUnit, this.grid.getEnemyAggrMatrixByUnitId(attackerUnit.getId()))
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        if (!targetUnits) {
            if (isAOE) {
                this.sceneLog.updateLog(`${attackerUnit.getName()} miss aoe`);
            }
            return { completed: isAOE, unitIdsDied, animationData };
        }

        if (targetUnits.length !== hoverRangeAttackDivisors.length) {
            return { completed: false, unitIdsDied, animationData };
        }

        let targetUnitUndex = 0;
        let affectedUnits = targetUnits.at(targetUnitUndex);
        if (!affectedUnits?.length) {
            return { completed: false, unitIdsDied, animationData };
        }

        let targetUnit = affectedUnits[0];

        if (!targetUnit && isAOE) {
            this.sceneLog.updateLog(`${attackerUnit.getName()} miss aoe`);
            return { completed: true, unitIdsDied, animationData };
        }

        const initialTargetUnit = targetUnit;
        let primaryAssimilationLanded = false;
        let responseAssimilationTarget: Unit | undefined;
        let assimilationResolved = false;
        const resolveAssimilation = (): void => {
            if (assimilationResolved) {
                return;
            }
            assimilationResolved = true;
            if (responseAssimilationTarget) {
                const responseStolen = AllAbilities.processPredatoryAssimilationAbility(
                    initialTargetUnit,
                    responseAssimilationTarget,
                    this.sceneLog,
                );
                if (responseStolen) {
                    abilityStolen.push(responseStolen);
                }
            }
            if (primaryAssimilationLanded) {
                const attackStolen = AllAbilities.processPredatoryAssimilationAbility(
                    attackerUnit,
                    initialTargetUnit,
                    this.sceneLog,
                );
                if (attackStolen) {
                    abilityStolen.push(attackStolen);
                }
            }
        };

        if (targetUnits.length === 1 && targetUnit && targetUnit.hasBuffActive("Hidden")) {
            return { completed: false, unitIdsDied, animationData };
        }

        // check if unit is forced to attack certain enemy only
        // if so, check if the forced target is still alive
        const forcedTargetUnitId = attackerUnit.getTarget();
        const forcedTargetUnit = unitsHolder.getAllUnits().get(forcedTargetUnitId);
        if (
            forcedTargetUnit &&
            !forcedTargetUnit.isDead() &&
            forcedTargetUnitId &&
            forcedTargetUnitId !== targetUnit.getId()
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        // ...and the inverse: Terrifying Gaze bars this one enemy while leaving every other target open.
        if (attackerUnit.cannotAttackUnitId(targetUnit.getId())) {
            return { completed: false, unitIdsDied, animationData };
        }

        // Track initial amount for kill counting
        // let initialAmountAlive = targetUnit.getAmountAlive();

        const throughShotResult = AllAbilities.processThroughShotAbility(
            attackerUnit,
            targetUnits,
            attackerUnit,
            hoverRangeAttackDivisors,
            hoverRangeAttackPosition,
            unitsHolder,
            this.grid,
            this.sceneLog,
            this.damageStatisticHolder,
            decreaseNumberOfShots,
            (damageForAnimation.secondary ??= []),
        );
        for (const uId of throughShotResult.unitIdsDied) {
            unitIdsDied.push(uId);
        }
        for (const ad of throughShotResult.animationData) {
            animationData.push(ad);
        }
        // Carry Through Shot's per-pierced-unit damage into splash so the client draws a floating number
        // on EVERY unit the shot passed through (like Large Caliber / Area Throw). Without this the
        // secondary hits dealt damage but rendered no animation at all.
        if (throughShotResult.perUnitDamage.length) {
            damageForAnimation.splash = throughShotResult.perUnitDamage.map((entry) => ({
                ...entry,
                position: { ...entry.position },
            }));
        }

        if (throughShotResult.landed) {
            primaryAssimilationLanded = true;
            resolveAssimilation();

            // Double Shot (incl. Crafted Double Shot) on a Through-Shot attacker fires a SECOND piercing
            // volley down the same lane. The generic double-shot path (processDoubleShotAbility, reached only
            // further below) delivers its second shot as an AOE splash — which a Through-Shot unit like Tsar
            // Cannon has no radius for — and this early return skips it entirely, so the crafted double shot
            // silently did nothing. Re-run the through shot here, scaling the volley by the Double Shot
            // multiplier: 100% for the base ability, stack-scaled 20/40/60/80/100% + luck for the crafted one.
            const doubleShotAbility =
                attackerUnit.getAbility("Double Shot") ?? attackerUnit.getAbility("Crafted Double Shot");
            if (
                !suppressDoubleShot &&
                doubleShotAbility &&
                !attackerUnit.isDead() &&
                !attackerUnit.isSkippingThisTurn()
            ) {
                let secondVolleyMultiplier = attackerUnit.calculateAbilityMultiplier(
                    doubleShotAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                );
                // ARTIFACT Dual Strike Charm: the second (Double Shot) volley deals extra damage. Paralysis is
                // deliberately NOT applied here — processThroughShotAbility already folds it into its own
                // multiplier, so applying it again would double-count the slow.
                secondVolleyMultiplier = AbilityHelper.withDualStrikeCharm(secondVolleyMultiplier, attackerUnit);
                if (secondVolleyMultiplier > 0) {
                    const secondThroughShot = AllAbilities.processThroughShotAbility(
                        attackerUnit,
                        targetUnits,
                        attackerUnit,
                        hoverRangeAttackDivisors,
                        hoverRangeAttackPosition,
                        unitsHolder,
                        this.grid,
                        this.sceneLog,
                        this.damageStatisticHolder,
                        false, // bonus volley — do not consume another range shot
                        (damageForAnimation.secondary ??= []),
                        secondVolleyMultiplier,
                    );
                    for (const uId of secondThroughShot.unitIdsDied) {
                        if (!unitIdsDied.includes(uId)) {
                            unitIdsDied.push(uId);
                        }
                    }
                    for (const ad of secondThroughShot.animationData) {
                        animationData.push(ad);
                    }
                    // Append THIS volley's per-pierced-unit damage as its own splash entries, so the client
                    // draws a second floating number on every unit the second shot passed through.
                    if (secondThroughShot.perUnitDamage.length) {
                        (damageForAnimation.splash ??= []).push(
                            ...secondThroughShot.perUnitDamage.map((entry) => ({
                                ...entry,
                                position: { ...entry.position },
                            })),
                        );
                    }
                }
            }

            unitsHolder.refreshStackPowerForAllUnits();
            return { completed: true, unitIdsDied, animationData, abilityStolen };
        }

        if (
            !isAOE &&
            (!targetUnit ||
                (targetUnit.getTeam() === attackerUnit.getTeam() && !isAOE) ||
                targetUnit.isDead() ||
                (attackerUnit.hasStatusApplied("Cowardice") &&
                    attackerUnit.getCumulativeHp() < targetUnit.getCumulativeHp()))
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        let hoverRangeAttackDivisor: number | undefined = hoverRangeAttackDivisors.at(targetUnitUndex);
        if (!hoverRangeAttackDivisor) {
            return { completed: false, unitIdsDied, animationData };
        }

        targetUnitUndex++;

        // ABILITY Absolving Arrow (Monk): the arrow cleanses the ALLIES it flies through on its way to the
        // target. Resolved here — after every gate that can still cancel the shot (Hidden, a forced or
        // forbidden target, Cowardice, a missing divisor), so a rejected action cannot hand out free
        // cleanses — but before the miss roll, because the arrow crosses its own line either way.
        AllAbilities.processAbsolvingArrowAbility(
            attackerUnit,
            hoverRangeAttackPosition,
            unitsHolder.getAllUnits(),
            this.grid,
            this.gridSettings,
            this.sceneLog,
        );

        animationData.push({
            fromPosition: attackerUnit.getPosition(),
            toPosition: hoverRangeAttackPosition,
            affectedUnit: targetUnit,
        });

        const isAttackMissed =
            HoCLib.getRandomInt(0, 100) <
            attackerUnit.calculateMissChance(
                targetUnit,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
            );
        let damageFromAttack = 0;

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        let rangeResponseUnit = rangeResponseUnits?.length ? rangeResponseUnits[0] : undefined;

        // response starts here
        let damageFromResponse = 0;
        let petrifyingGazeResponseDamage = 0;
        let isResponseMissed = false;
        // Water Shield on the RESPONDER's victim (the original attacker): captured before the counter-shot's
        // damage lands so its on-hit riders are skipped like a missed counter when the hit is absorbed.
        let rangeResponseAbsorbed = false;
        if (
            rangeResponseUnit &&
            !attackerUnit.canSkipResponse() &&
            !fightProperties.hasAlreadyRepliedAttack(targetUnit.getId()) &&
            targetUnit.canRespond(PBTypes.AttackVals.RANGE) &&
            this.canLandRangeAttack(targetUnit, this.grid.getEnemyAggrMatrixByUnitId(targetUnit.getId())) &&
            !(
                targetUnit.hasStatusApplied("Cowardice") &&
                targetUnit.getCumulativeHp() < rangeResponseUnit.getCumulativeHp()
            ) &&
            (!targetUnit.getTarget() || targetUnit.getTarget() === attackerUnit.getId()) &&
            !targetUnit.cannotAttackUnitId(attackerUnit.getId())
        ) {
            isResponseMissed =
                HoCLib.getRandomInt(0, 100) <
                targetUnit.calculateMissChance(
                    rangeResponseUnit,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(rangeResponseUnit.getTeam()),
                );
            // The counter-shot is its own arrow down its own line, so a responding Monk cleanses the allies
            // IT flies past (same rule as the initiating shot above).
            AllAbilities.processAbsolvingArrowAbility(
                targetUnit,
                attackerUnit.getPosition(),
                unitsHolder.getAllUnits(),
                this.grid,
                this.gridSettings,
                this.sceneLog,
            );
            animationData.push({
                fromPosition: targetUnit.getPosition(),
                toPosition: attackerUnit.getPosition(),
                affectedUnit: rangeResponseUnit,
            });
        } else {
            rangeResponseUnit = undefined;
        }

        // ABILITY Chakram (Zena): the disc may hit up to the attacker's stack power in TOTAL. After the
        // primary, it bounces among enemies standing apart — 1 empty cell keeps full bounce damage and 2
        // halves it — nearest first, each enemy at most once, then it returns to Zena.
        // resolveChakramTrajectory PRECOMPUTES the whole flight deterministically, so the client replay and
        // red hover preview use the exact same capped victims.
        // Victims JOIN affectedUnits, so they resolve through the very same AOE tail as Large Caliber /
        // Area Throw (Giant's Maul, status resistance, Flesh Shield ordering, per-unit numbers).
        const chakramTrajectory = AllAbilities.resolveChakramTrajectory(
            attackerUnit,
            targetUnit,
            unitsHolder,
            this.grid,
        );
        if (chakramTrajectory.hitUnits.length && affectedUnits) {
            for (const hitUnit of chakramTrajectory.hitUnits) {
                if (!affectedUnits.some((unit) => unit.getId() === hitUnit.getId())) {
                    affectedUnits.push(hitUnit);
                }
            }
            this.sceneLog.updateLog(
                `${attackerUnit.getName()} chakram bounces to ${chakramTrajectory.hitUnits
                    .map(
                        (u) =>
                            `${u.getName()}${chakramTrajectory.damageFactorByUnitId[u.getId()] === 1 ? "" : " (half)"}`,
                    )
                    .join(", ")}`,
            );
        }
        if (chakramTrajectory.steps.length) {
            // Hand the client the exact circles + per-leg hits so it flies the disc and lands each hit as the
            // disc reaches it (see IVisibleDamage.chakramArcs).
            damageForAnimation.chakramArcs = chakramTrajectory.steps.map((step) => ({
                targetUnitId: step.hitUnitIds[0] ?? "",
                cells: step.circleCells.map((cell) => ({ x: cell.x, y: cell.y })),
                hitUnitIds: [...step.hitUnitIds],
                mountainCells: step.mountainCells.map((cell) => ({ x: cell.x, y: cell.y })),
            }));
        }

        // handle attack damage
        let aoeRangeAttackResult = AllAbilities.processRangeAOEAbility(
            attackerUnit,
            affectedUnits,
            attackerUnit,
            hoverRangeAttackDivisor,
            unitsHolder,
            this.grid,
            this.sceneLog,
            this.damageStatisticHolder,
            true,
            (damageForAnimation.secondary ??= []),
            chakramTrajectory.damageFactorByUnitId,
        );
        let attackDamageApplied = true;
        if (aoeRangeAttackResult.landed) {
            damageFromAttack = AllAbilities.processLuckyStrikeAbility(
                attackerUnit,
                aoeRangeAttackResult.maxDamage,
                this.sceneLog,

                (damageForAnimation.luckyStrikeBy ??= []),
            );
            for (const uId of aoeRangeAttackResult.unitIdsDied) {
                unitIdsDied.push(uId);
            }
            // Carry per-affected-unit damage so the client can draw a floating number on EVERY splashed
            // unit at its own position. The AOE path (Large Caliber / Area Throw) never fills the single
            // `unitPosition`/`hits` payload used for single-target hits, so without this the renderer has
            // nowhere to place the secondary units' damage.
            if (aoeRangeAttackResult.perUnitDamage.length) {
                damageForAnimation.splash = aoeRangeAttackResult.perUnitDamage.map((entry) => ({
                    ...entry,
                    position: { ...entry.position },
                }));
            }
        } else if (isAttackMissed) {
            this.sceneLog.updateLog(`${attackerUnit.getName()} misses 🏹 on ${targetUnit.getName()}`);
            // Dodged ranged shot (Dodge / Small Specie / Boar Saliva / Broken Aegis): flag it so the
            // client pops "MISS" over the target. render stays false — no damage number.
            damageForAnimation.missed = true;
            damageForAnimation.unitId = targetUnit.getId();
            damageForAnimation.unitPosition = targetUnit.getPosition();
            damageForAnimation.unitIsSmall = targetUnit.isSmallSize();
        } else {
            let abilityMultiplier = 1;
            const paralysisAttackerEffect = attackerUnit.getEffect("Paralysis");
            if (paralysisAttackerEffect) {
                abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
            }
            damageFromAttack = AllAbilities.processLuckyStrikeAbility(
                attackerUnit,
                attackerUnit.calculateAttackDamage(
                    targetUnit,
                    PBTypes.AttackVals.RANGE,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                    hoverRangeAttackDivisor,
                    abilityMultiplier,
                    decreaseNumberOfShots,
                ),
                this.sceneLog,

                (damageForAnimation.luckyStrikeBy ??= []),
            );
            this.sceneLog.updateLog(
                `${attackerUnit.getName()} 🏹 ${targetUnit.getName()} (${damageFromAttack})` +
                    HoCLib.killTag(targetUnit.calculatePossibleLosses(damageFromAttack)),
            );
            attackDamageApplied = false;
        }
        // Flesh Shield may reduce the base hit below, but Petrifying Gaze remains attached to the unit
        // this shot landed on and therefore uses the complete pre-redirection impact.
        const petrifyingGazeAttackDamage = damageFromAttack;

        // handle response damage
        let aoeRangeResponseResult: AllAbilities.IAOERangeAttackResult | undefined = undefined;
        let targetUnitPlusMorale = 0;
        let rangeResponseFleshShieldAbsorb: AllAbilities.IFleshShieldResult | undefined = undefined;

        const increaseUnitMorale = (unitToIncreaseMoraleTo: Unit, increaseMoraleBy: number): void => {
            unitToIncreaseMoraleTo.increaseMorale(
                increaseMoraleBy,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalMoralePerTeam(unitToIncreaseMoraleTo.getTeam()),
            );
        };

        if (rangeResponseUnit && rangeResponseUnits) {
            // ABILITY Chakram (Zena) on the RESPONSE: a counter-throw behaves EXACTLY like the initiating one —
            // same stack-power total-target cap, separation chain, ally exclusion and Angel stop, with the
            // RESPONDER as the attacker and its shooter as the primary victim.
            const responseChakramTrajectory = AllAbilities.resolveChakramTrajectory(
                targetUnit,
                rangeResponseUnit,
                unitsHolder,
                this.grid,
            );
            if (responseChakramTrajectory.hitUnits.length) {
                for (const hitUnit of responseChakramTrajectory.hitUnits) {
                    if (!rangeResponseUnits.some((unit) => unit.getId() === hitUnit.getId())) {
                        rangeResponseUnits.push(hitUnit);
                    }
                }
                this.sceneLog.updateLog(
                    `${targetUnit.getName()} chakram bounces to ${responseChakramTrajectory.hitUnits
                        .map(
                            (u) =>
                                `${u.getName()}${
                                    responseChakramTrajectory.damageFactorByUnitId[u.getId()] === 1 ? "" : " (half)"
                                }`,
                        )
                        .join(", ")}`,
                );
            }
            if (responseChakramTrajectory.steps.length) {
                damageForAnimation.chakramArcs = [
                    ...(damageForAnimation.chakramArcs ?? []),
                    ...responseChakramTrajectory.steps.map((step) => ({
                        targetUnitId: step.hitUnitIds[0] ?? "",
                        cells: step.circleCells.map((cell) => ({ x: cell.x, y: cell.y })),
                        hitUnitIds: [...step.hitUnitIds],
                        mountainCells: step.mountainCells.map((cell) => ({ x: cell.x, y: cell.y })),
                    })),
                ];
            }

            aoeRangeResponseResult = AllAbilities.processRangeAOEAbility(
                targetUnit,
                rangeResponseUnits,
                targetUnit,
                rangeResponseAttackDivisor,
                unitsHolder,
                this.grid,
                this.sceneLog,
                this.damageStatisticHolder,
                false,
                (damageForAnimation.secondary ??= []),
                responseChakramTrajectory.damageFactorByUnitId,
            );
            if (aoeRangeResponseResult.landed) {
                damageFromResponse = AllAbilities.processLuckyStrikeAbility(
                    targetUnit,
                    aoeRangeResponseResult.maxDamage,
                    this.sceneLog,

                    (damageForAnimation.luckyStrikeBy ??= []),
                );
                for (const uId of aoeRangeResponseResult.unitIdsDied) {
                    unitIdsDied.push(uId);
                }
            } else if (isResponseMissed) {
                this.sceneLog.updateLog(`${targetUnit.getName()} misses 🏹 resp on ${rangeResponseUnit.getName()}`);
            } else {
                let abilityMultiplier = 1;
                const paralysisTargetUnitEffect = targetUnit.getEffect("Paralysis");
                if (paralysisTargetUnitEffect) {
                    abilityMultiplier *= (100 - paralysisTargetUnitEffect.getPower()) / 100;
                }

                damageFromResponse = AllAbilities.processLuckyStrikeAbility(
                    targetUnit,
                    targetUnit.calculateAttackDamage(
                        rangeResponseUnit,
                        PBTypes.AttackVals.RANGE,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
                        rangeResponseAttackDivisor,
                        abilityMultiplier,
                    ),
                    this.sceneLog,

                    (damageForAnimation.luckyStrikeBy ??= []),
                );
                petrifyingGazeResponseDamage = damageFromResponse;

                rangeResponseFleshShieldAbsorb = AllAbilities.processFleshShieldAura(
                    targetUnit,
                    rangeResponseUnit,
                    damageFromResponse,
                    true,
                    this.grid,
                    unitsHolder,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                damageFromResponse = rangeResponseFleshShieldAbsorb.remainingDamage;
                targetUnitPlusMorale += rangeResponseFleshShieldAbsorb.increaseMorale;
                for (const uId of rangeResponseFleshShieldAbsorb.unitIdsDied) {
                    if (!unitIdsDied.includes(uId)) {
                        unitIdsDied.push(uId);
                    }
                }

                this.sceneLog.updateLog(
                    `${targetUnit.getName()} resp ${rangeResponseUnit.getName()} (${damageFromResponse})` +
                        HoCLib.killTag(rangeResponseUnit.calculatePossibleLosses(damageFromResponse)),
                );

                rangeResponseAbsorbed = damageFromResponse > 0 && rangeResponseUnit.willWaterShieldAbsorb(targetUnit);
                // response damage
                this.damageStatisticHolder.add({
                    unitName: targetUnit.getName(),
                    damage: rangeResponseUnit.applyDamage(
                        damageFromResponse,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getBreakChancePerTeam(targetUnit.getTeam()),
                        this.sceneLog,
                        true,
                        targetUnit,
                    ),
                    team: targetUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
                if (!rangeResponseAbsorbed) {
                    const pegasusLightEffect = rangeResponseUnit.getEffect("Pegasus Light");
                    if (pegasusLightEffect) {
                        targetUnitPlusMorale += pegasusLightEffect.getPower();
                    }
                    // A counter-shot is a hit like any other: the responder's poison aura applies with the
                    // roles swapped, exactly as it does on its own turn. Same fix as the melee response path.
                    AllAbilities.processPoisonAuraAbility(
                        targetUnit,
                        rangeResponseUnit,
                        damageFromResponse,
                        this.sceneLog,
                    );
                }
            }

            AllAbilities.processOneInTheFieldAbility(targetUnit);
        }

        if (rangeResponseUnit && (aoeRangeResponseResult?.landed || !isResponseMissed)) {
            responseAssimilationTarget = rangeResponseUnit;
        }

        let attackerUnitPlusMorale = 0;
        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
        if (rangeResponseFleshShieldAbsorb) {
            this.updateMoraleDecreaseForTheUnitTeam(
                moraleDecreaseForTheUnitTeam,
                rangeResponseFleshShieldAbsorb.moraleDecreaseForTheUnitTeam,
            );
        }

        // A landed on-hit effect (notably Petrifying Gaze) can kill the primary target after the base-hit
        // death check. Keep this collector idempotent because several response-death paths return early and
        // Double Shot can reach the same bookkeeping later; a death must grant morale and be reported once.
        const recordPrimaryTargetDeath = (): boolean => {
            if (!targetUnit.isDead()) {
                return false;
            }
            if (!unitIdsDied.includes(targetUnit.getId())) {
                this.sceneLog.updateLog(`${targetUnit.getName()} died`);
                unitIdsDied.push(targetUnit.getId());
                attackerUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
                this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                    [`${targetUnit.getName()}:${targetUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
                });
            }
            return true;
        };

        let switchTargetUnit = false;
        // Water Shield: captured BEFORE the damage lands (applyDamage consumes the shield). An absorbed
        // shot applies nothing — the on-hit rider block below is skipped exactly like a missed shot.
        let rangeAttackAbsorbed = false;
        if (!aoeRangeAttackResult?.landed || !isAOE) {
            if (!attackDamageApplied) {
                const fleshShieldAbsorb = AllAbilities.processFleshShieldAura(
                    attackerUnit,
                    targetUnit,
                    damageFromAttack,
                    true,
                    this.grid,
                    unitsHolder,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                damageFromAttack = fleshShieldAbsorb.remainingDamage;
                attackerUnitPlusMorale += fleshShieldAbsorb.increaseMorale;
                for (const uId of fleshShieldAbsorb.unitIdsDied) {
                    if (!unitIdsDied.includes(uId)) {
                        unitIdsDied.push(uId);
                    }
                }
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    fleshShieldAbsorb.moraleDecreaseForTheUnitTeam,
                );
                damageForAnimation.render = true;
                damageForAnimation.amount = damageFromAttack;
                damageForAnimation.hits = []; // Initialize hits as an array of objects
                const initialAmountAlive = targetUnit.getAmountAlive();
                rangeAttackAbsorbed = damageFromAttack > 0 && targetUnit.willWaterShieldAbsorb(attackerUnit);
                // attack damage
                const damageDealt = targetUnit.applyDamage(
                    damageFromAttack,
                    FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
                    this.sceneLog,
                    false,
                    attackerUnit,
                );
                const currentAmount = targetUnit.getAmountAlive();
                damageForAnimation.hits.push({
                    amount: damageDealt,
                    unitsDied: Math.max(0, initialAmountAlive - currentAmount),
                }); // Initialize hits with first shot
                damageForAnimation.unitPosition = targetUnit.getPosition();
                damageForAnimation.unitIsSmall = targetUnit.isSmallSize();
                damageForAnimation.unitId = targetUnit.getId();

                this.damageStatisticHolder.add({
                    unitName: attackerUnit.getName(),
                    damage: damageDealt,
                    team: attackerUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
                if (!rangeAttackAbsorbed) {
                    const pegasusLightEffect = targetUnit.getEffect("Pegasus Light");
                    if (pegasusLightEffect) {
                        attackerUnitPlusMorale += pegasusLightEffect.getPower();
                    }
                }
            }

            if (!targetUnit.isDead() && !isAttackMissed && !rangeAttackAbsorbed) {
                // On-hit effects only land when the shot itself did: a dodged/missed shot (Dodge /
                // Small Specie / Boar Saliva) must not stun/petrify/etc. — mirrors the melee path,
                // which gates this same block on !isAttackMissed (bug: an Orc could miss a Scavenger
                // and still Stun it). A Water-Shield-absorbed shot is treated the same as a miss.
                const rangedFireforgedSwordResult = AllAbilities.processFireforgedSwordAbility(
                    attackerUnit,
                    targetUnit,
                    damageFromAttack,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                for (const uId of rangedFireforgedSwordResult.unitIdsDied) {
                    if (!unitIdsDied.includes(uId)) {
                        unitIdsDied.push(uId);
                    }
                }
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    rangedFireforgedSwordResult.moraleDecreaseForTheUnitTeam,
                );
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processStunAuraOnHit(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processFreezeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processRimeCharmAbility(attackerUnit, targetUnit, this.sceneLog);
                // Area Throw / Large Caliber already resolved Gaze for every struck unit in the AOE
                // processor. Keep the outer primary on-hit pass for its other effects, but do not petrify
                // the unit-targeted primary a second time.
                if (!aoeRangeAttackResult?.landed) {
                    AllAbilities.processPetrifyingGazeAbility(
                        attackerUnit,
                        targetUnit,
                        petrifyingGazeAttackDamage,
                        this.sceneLog,
                        this.damageStatisticHolder,
                        (damageForAnimation.secondary ??= []),
                        hoverRangeAttackDivisor,
                    );
                }
                AllAbilities.processSpitBallAbility(
                    attackerUnit,
                    targetUnit,
                    attackerUnit,
                    unitsHolder,
                    this.grid,
                    this.sceneLog,
                );
                AllAbilities.processHamstringAbility(
                    attackerUnit,
                    targetUnit,
                    attackerUnit,
                    unitsHolder,
                    this.grid,
                    this.sceneLog,
                );
                AllAbilities.processPoisonAuraAbility(attackerUnit, targetUnit, damageFromAttack, this.sceneLog);
                // ABILITY Borrowed Grace (Monk): a landed shot takes one active buff off the target and
                // wears it. An on-hit rider like the ones above — a missed or lethal shot takes nothing.
                AllAbilities.processBorrowedGraceAbility(attackerUnit, targetUnit, this.sceneLog);
            }
            if (recordPrimaryTargetDeath()) {
                switchTargetUnit = true;
            }
        }

        if (aoeRangeAttackResult?.landed || !isAttackMissed) {
            primaryAssimilationLanded = true;
        }

        if (rangeResponseUnit) {
            if (aoeRangeResponseResult?.landed) {
                if (rangeResponseUnit.isDead() && attackerUnit.getId() === rangeResponseUnit.getId()) {
                    unitIdsDied.push(rangeResponseUnit.getId());
                    increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                    increaseUnitMorale(targetUnit, targetUnitPlusMorale);
                    unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                    resolveAssimilation();
                    return { completed: true, unitIdsDied, animationData, abilityStolen };
                }
            } else {
                if (rangeResponseUnit.isDead()) {
                    if (!unitIdsDied.includes(rangeResponseUnit.getId())) {
                        this.sceneLog.updateLog(`${rangeResponseUnit.getName()} died`);
                        unitIdsDied.push(rangeResponseUnit.getId());
                        this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                            [`${rangeResponseUnit.getName()}:${rangeResponseUnit.getTeam()}`]:
                                HoCConstants.MORALE_CHANGE_FOR_KILL,
                        });
                        if (!targetUnit.isDead()) {
                            targetUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
                        }
                    }

                    if (attackerUnit.getId() === rangeResponseUnit.getId()) {
                        increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                        increaseUnitMorale(targetUnit, targetUnitPlusMorale);
                        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                        resolveAssimilation();
                        return { completed: true, unitIdsDied, animationData, abilityStolen };
                    }
                } else if (!isResponseMissed && !rangeResponseAbsorbed) {
                    // Same rule for the return shot: a dodged/missed counter lands no on-hit effects
                    // (mirrors the melee response path's isResponseMissed gate). A counter absorbed by
                    // the victim's Water Shield lands none either.
                    AllAbilities.processStunAbility(targetUnit, rangeResponseUnit, attackerUnit, this.sceneLog);
                    AllAbilities.processStunAuraOnHit(targetUnit, rangeResponseUnit, attackerUnit, this.sceneLog);
                    AllAbilities.processFreezeAbility(targetUnit, rangeResponseUnit, attackerUnit, this.sceneLog);
                    AllAbilities.processRimeCharmAbility(targetUnit, rangeResponseUnit, this.sceneLog);
                    AllAbilities.processPetrifyingGazeAbility(
                        targetUnit,
                        rangeResponseUnit,
                        petrifyingGazeResponseDamage,
                        this.sceneLog,
                        this.damageStatisticHolder,
                        (damageForAnimation.secondary ??= []),
                        rangeResponseAttackDivisor,
                    );
                    AllAbilities.processSpitBallAbility(
                        targetUnit,
                        rangeResponseUnit,
                        attackerUnit,
                        unitsHolder,
                        this.grid,
                        this.sceneLog,
                    );
                    // A Monk that shoots BACK steals just the same — the theft rides the landed shot, not
                    // the initiative (mirrors Predatory Assimilation's response branch).
                    AllAbilities.processBorrowedGraceAbility(targetUnit, rangeResponseUnit, this.sceneLog);
                    if (rangeResponseUnit.isDead()) {
                        if (!unitIdsDied.includes(rangeResponseUnit.getId())) {
                            this.sceneLog.updateLog(`${rangeResponseUnit.getName()} died`);
                            unitIdsDied.push(rangeResponseUnit.getId());
                            this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                                [`${rangeResponseUnit.getName()}:${rangeResponseUnit.getTeam()}`]:
                                    HoCConstants.MORALE_CHANGE_FOR_KILL,
                            });
                            if (!targetUnit.isDead()) {
                                targetUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
                            }
                        }
                        if (attackerUnit.getId() === rangeResponseUnit.getId()) {
                            increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                            increaseUnitMorale(targetUnit, targetUnitPlusMorale);
                            unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                            resolveAssimilation();
                            return { completed: true, unitIdsDied, animationData, abilityStolen };
                        }
                    }
                }
            }
        }

        unitsHolder.refreshStackPowerForAllUnits();

        if (switchTargetUnit) {
            while (targetUnitUndex < targetUnits.length) {
                affectedUnits = targetUnits.at(targetUnitUndex);
                if (!affectedUnits?.length) {
                    break;
                }

                let allDead = true;
                for (const au of affectedUnits) {
                    if (!au.isDead()) {
                        allDead = false;
                        break;
                    }
                }
                if (!allDead) {
                    break;
                }
                targetUnitUndex++;
            }

            if (!affectedUnits?.length) {
                increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                increaseUnitMorale(targetUnit, targetUnitPlusMorale);
                unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                resolveAssimilation();
                return { completed: true, unitIdsDied, animationData, abilityStolen };
            }

            const previousTargetUnit = targetUnit;
            targetUnit = affectedUnits[0];

            if (previousTargetUnit !== targetUnit) {
                // last chance to increase morale as we just switched target unit
                increaseUnitMorale(targetUnit, targetUnitPlusMorale);
            }

            if (
                !targetUnit ||
                targetUnit.getTeam() === attackerUnit.getTeam() ||
                targetUnit.isDead() ||
                (attackerUnit.hasStatusApplied("Cowardice") &&
                    attackerUnit.getCumulativeHp() < targetUnit.getCumulativeHp())
            ) {
                if (targetUnit.isDead() && !unitIdsDied.includes(targetUnit.getId())) {
                    unitIdsDied.push(targetUnit.getId());
                }
                increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                resolveAssimilation();
                return { completed: true, unitIdsDied, animationData, abilityStolen };
            }
            hoverRangeAttackDivisor = hoverRangeAttackDivisors.at(targetUnitUndex);
            if (!hoverRangeAttackDivisor) {
                increaseUnitMorale(attackerUnit, attackerUnitPlusMorale);
                unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
                resolveAssimilation();
                return { completed: true, unitIdsDied, animationData, abilityStolen };
            }
        }

        // Second attack (Double Shot)
        // Capture health state before second shot to calculate units died
        const preSecondShotAmount = targetUnit.getAmountAlive();

        const secondShotResult = suppressDoubleShot
            ? {
                  applied: false,
                  damage: 0,
                  moraleDecreaseForTheUnitTeam: {},
                  animationData: [],
                  unitIdsDied: [],
                  aoeRangeAttackLanded: false,
                  waterShieldAbsorbed: false,
                  petrifyingGazeDamage: 0,
                  moraleIncrease: 0,
              }
            : AllAbilities.processDoubleShotAbility(
                  attackerUnit,
                  targetUnit,
                  affectedUnits,
                  this.sceneLog,
                  unitsHolder,
                  this.grid,
                  hoverRangeAttackDivisor,
                  hoverRangeAttackPosition,
                  damageForAnimation,
                  this.damageStatisticHolder,
                  isAOE,
              );
        this.updateMoraleDecreaseForTheUnitTeam(
            moraleDecreaseForTheUnitTeam,
            secondShotResult.moraleDecreaseForTheUnitTeam,
        );

        if (secondShotResult.applied && secondShotResult.damage > 0 && damageForAnimation.hits) {
            const currentAmount = targetUnit.getAmountAlive();
            const unitsDied = Math.max(0, preSecondShotAmount - currentAmount);

            damageForAnimation.hits.push({
                amount: secondShotResult.damage,
                unitsDied: unitsDied,
            });
            damageForAnimation.unitId = targetUnit.getId();
        }

        for (const ad of secondShotResult.animationData) {
            animationData.push(ad);
        }

        for (const uId of secondShotResult.unitIdsDied) {
            unitIdsDied.push(uId);
        }

        if (!secondShotResult.aoeRangeAttackLanded) {
            if (!targetUnit.isDead() && secondShotResult.applied && !secondShotResult.waterShieldAbsorbed) {
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processStunAuraOnHit(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processFreezeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processPetrifyingGazeAbility(
                    attackerUnit,
                    targetUnit,
                    secondShotResult.petrifyingGazeDamage,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                    hoverRangeAttackDivisor,
                );
                AllAbilities.processSpitBallAbility(
                    attackerUnit,
                    targetUnit,
                    attackerUnit,
                    unitsHolder,
                    this.grid,
                    this.sceneLog,
                );
                AllAbilities.processPoisonAuraAbility(attackerUnit, targetUnit, secondShotResult.damage, this.sceneLog);
            }
            recordPrimaryTargetDeath();
        }

        attackerUnit.increaseMorale(
            attackerUnitPlusMorale + secondShotResult.moraleIncrease,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
        );
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);

        resolveAssimilation();
        unitsHolder.refreshStackPowerForAllUnits();

        return { completed: true, unitIdsDied, animationData, abilityStolen };
    }
    public handleMeleeAttack(
        unitsHolder: UnitsHolder,
        moveHandler: MoveHandler,
        damageForAnimation: IVisibleDamage,
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
        attackerUnit?: Unit,
        targetUnit?: Unit,
        attackFromCell?: HoCMath.XY,
    ): IAttackResult {
        const animationData: IAnimationData[] = [];
        const unitIdsDied: string[] = [];
        const abilityStolen: AllAbilities.IAbilityStolen[] = [];

        const updateUnitsDied = (updateBy: string[]): void => {
            for (const s of updateBy) {
                unitIdsDied.push(s);
            }
        };

        if (
            !attackerUnit ||
            attackerUnit.isDead() ||
            !targetUnit ||
            targetUnit.isDead() ||
            !attackFromCell ||
            (attackerUnit.getAttackTypeSelection() !== PBTypes.AttackVals.MELEE &&
                attackerUnit.getAttackTypeSelection() !== PBTypes.AttackVals.MELEE_MAGIC) ||
            attackerUnit.hasAbilityActive("No Melee") ||
            attackerUnit.getTeam() === targetUnit.getTeam() ||
            (attackerUnit.hasStatusApplied("Cowardice") &&
                attackerUnit.getCumulativeHp() < targetUnit.getCumulativeHp())
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        // check if unit is forced to attack certain enemy only
        // if so, check if the forced target is still alive
        const forcedTargetUnitId = attackerUnit.getTarget();
        const forcedTargetUnit = unitsHolder.getAllUnits().get(forcedTargetUnitId);
        if (
            forcedTargetUnit &&
            !forcedTargetUnit.isDead() &&
            forcedTargetUnitId &&
            forcedTargetUnitId !== targetUnit.getId()
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        // ...and the inverse: Terrifying Gaze bars this one enemy while leaving every other target open.
        if (attackerUnit.cannotAttackUnitId(targetUnit.getId())) {
            return { completed: false, unitIdsDied, animationData };
        }

        if (targetUnit && targetUnit.hasBuffActive("Hidden")) {
            return { completed: false, unitIdsDied, animationData };
        }

        const currentCell = GridMath.getCellForPosition(this.gridSettings, attackerUnit.getPosition());

        if (!currentCell) {
            return { completed: false, unitIdsDied, animationData };
        }

        const attackFromCells = [attackFromCell];
        if (!attackerUnit.isSmallSize()) {
            attackFromCells.push(
                { x: attackFromCell.x, y: attackFromCell.y - 1 },
                { x: attackFromCell.x - 1, y: attackFromCell.y },
                { x: attackFromCell.x - 1, y: attackFromCell.y - 1 },
            );
        }

        if (!this.grid.areCellsAdjacent(attackFromCells, targetUnit.getCells())) {
            return { completed: false, unitIdsDied, animationData };
        }

        const stationaryAttack = currentCell.x === attackFromCell.x && currentCell.y === attackFromCell.y;

        if (!stationaryAttack && !attackerUnit.canMove()) {
            return { completed: false, unitIdsDied, animationData };
        }

        let attackerUnitPlusMorale = 0;
        let targetUnitPlusMorale = 0;
        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};

        if (attackerUnit.isSmallSize()) {
            const attackFromCells = [attackFromCell];
            if (
                (this.grid.areAllCellsEmpty(attackFromCells, attackerUnit.getId()) ||
                    this.grid.canOccupyCells(
                        attackFromCells,
                        attackerUnit.canTraverseLava(),
                        attackerUnit.hasAbilityActive("Made of Water"),
                        attackerUnit.getId(),
                    )) &&
                (stationaryAttack || currentActiveKnownPaths?.get((attackFromCell.x << 4) | attackFromCell.y)?.length)
            ) {
                const position = GridMath.getPositionForCell(
                    attackFromCell,
                    this.gridSettings.getMinX(),
                    this.gridSettings.getStep(),
                    this.gridSettings.getHalfStep(),
                );

                const moveInitiated =
                    stationaryAttack ||
                    moveHandler.applyMoveModifiers(
                        attackFromCell,
                        attackerUnit,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalMoralePerTeam(attackerUnit.getTeam()),
                        currentActiveKnownPaths,
                    );
                if (!moveInitiated) {
                    return { completed: false, unitIdsDied, animationData };
                }

                attackerUnit.setPosition(position.x, position.y, false);
                this.grid.occupyCell(
                    attackFromCell,
                    attackerUnit.getId(),
                    attackerUnit.getTeam(),
                    attackerUnit.getAttackRange(),
                    attackerUnit.canTraverseLava(),
                    attackerUnit.hasAbilityActive("Made of Water"),
                );

                animationData.push({
                    toPosition: attackerUnit.getPosition(),
                    affectedUnit: attackerUnit,
                    bodyUnit: attackerUnit,
                });
            } else {
                return { completed: false, unitIdsDied, animationData };
            }
        } else {
            const position = GridMath.getPositionForCell(
                attackFromCell,
                this.gridSettings.getMinX(),
                this.gridSettings.getStep(),
                this.gridSettings.getHalfStep(),
            );
            const cells = GridMath.getCellsAroundPosition(this.gridSettings, {
                x: position.x - this.gridSettings.getHalfStep(),
                y: position.y - this.gridSettings.getHalfStep(),
            });
            if (
                (this.grid.areAllCellsEmpty(cells, attackerUnit.getId()) ||
                    this.grid.canOccupyCells(
                        attackFromCells,
                        attackerUnit.canTraverseLava(),
                        attackerUnit.hasAbilityActive("Made of Water"),
                        attackerUnit.getId(),
                    )) &&
                (stationaryAttack || currentActiveKnownPaths?.get((attackFromCell.x << 4) | attackFromCell.y)?.length)
            ) {
                const moveInitiated =
                    stationaryAttack ||
                    moveHandler.applyMoveModifiers(
                        attackFromCell,
                        attackerUnit,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalMoralePerTeam(attackerUnit.getTeam()),
                        currentActiveKnownPaths,
                    );
                if (!moveInitiated) {
                    return { completed: false, unitIdsDied, animationData };
                }

                attackerUnit.setPosition(
                    position.x - this.gridSettings.getHalfStep(),
                    position.y - this.gridSettings.getHalfStep(),
                    false,
                );

                this.grid.occupyCells(
                    cells,
                    attackerUnit.getId(),
                    attackerUnit.getTeam(),
                    attackerUnit.getAttackRange(),
                    attackerUnit.canTraverseLava(),
                    attackerUnit.hasAbilityActive("Made of Water"),
                );

                animationData.push({
                    toPosition: attackerUnit.getPosition(),
                    affectedUnit: attackerUnit,
                    bodyUnit: attackerUnit,
                });
            } else {
                return { completed: false, unitIdsDied, animationData };
            }
        }

        let abilityMultiplier = 1;
        let rapidChargeCellsNumber = 1;
        let hasRapidChargePath = false;
        const movedRouteCells =
            stationaryAttack && attackerUnit.hasMovedThisTurn() ? attackerUnit.getMovedRouteCellsThisTurn() : 0;
        if (movedRouteCells > 0) {
            // An explicit move followed by a stationary strike must use the route that the authoritative move
            // actually resolved. Ranked recomputes currentActiveKnownPaths after the move, where the attacker's
            // current cell is represented by a one-cell route; preferring that map would silently erase Rapid
            // Charge distance. The recorded value was populated only after move validation and is reset with
            // movedThisTurn, so clients cannot use this precedence to spoof a longer charge.
            hasRapidChargePath = true;
            rapidChargeCellsNumber = movedRouteCells;
        } else if (currentActiveKnownPaths) {
            hasRapidChargePath = true;
            const paths = currentActiveKnownPaths.get((attackFromCell.x << 4) | attackFromCell.y);
            if (paths?.length) {
                rapidChargeCellsNumber = paths[0].route.length;
            }
        }
        if (hasRapidChargePath) {
            abilityMultiplier = AllAbilities.processRapidChargeAbility(attackerUnit, rapidChargeCellsNumber);
        }

        const paralysisAttackerEffect = attackerUnit.getEffect("Paralysis");
        if (paralysisAttackerEffect) {
            abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
        }

        const abilitiesWithPositionCoeff = AbilityHelper.getAbilitiesWithPosisionCoefficient(
            attackerUnit.getAbilities(),
            attackFromCell,
            GridMath.getCellForPosition(this.gridSettings, targetUnit.getPosition()),
            targetUnit.isSmallSize(),
            attackerUnit.getTeam(),
        );

        if (abilitiesWithPositionCoeff.length) {
            for (const awpc of abilitiesWithPositionCoeff) {
                abilityMultiplier *= attackerUnit.calculateAbilityMultiplier(
                    awpc,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                );
            }
        }

        const deepWoundsTargetEffect = targetUnit.getEffect("Deep Wounds");
        if (deepWoundsTargetEffect && AllAbilities.hasAnyDeepWoundsAbility(attackerUnit)) {
            abilityMultiplier *= 1 + deepWoundsTargetEffect.getPower() / 100;
        }

        const isAttackMissed =
            HoCLib.getRandomInt(0, 100) <
            attackerUnit.calculateMissChance(
                targetUnit,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
            );

        attackerUnit.cleanupAttackModIncrease();
        attackerUnit.increaseAttackMod(unitsHolder.getUnitAuraAttackMod(attackerUnit));

        let damageFromAttack =
            AllAbilities.processLuckyStrikeAbility(
                attackerUnit,
                attackerUnit.calculateAttackDamage(
                    targetUnit,
                    PBTypes.AttackVals.MELEE,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                    1,
                    abilityMultiplier,
                ),
                this.sceneLog,

                (damageForAnimation.luckyStrikeBy ??= []),
            ) + AllAbilities.processPenetratingBiteAbility(attackerUnit, targetUnit);

        const fightProperties = FightStateManager.getInstance().getFightProperties();

        const lightningSpinAttackResult = AllAbilities.processLightningSpinAbility(
            attackerUnit,
            this.sceneLog,
            unitsHolder,
            rapidChargeCellsNumber,
            this.damageStatisticHolder,
            attackFromCell,
            true,
            (damageForAnimation.secondary ??= []),
            this.grid,
        );
        const hasLightningSpinAttackLanded = lightningSpinAttackResult.landed;
        updateUnitsDied(lightningSpinAttackResult.unitIdsDied);

        const fireBreathAttackResult = AllAbilities.processFireBreathAbility(
            attackerUnit,
            targetUnit,
            this.sceneLog,
            unitsHolder,
            this.grid,
            "attk",
            this.damageStatisticHolder,
            attackFromCell,
            (damageForAnimation.secondary ??= []),
        );
        updateUnitsDied(fireBreathAttackResult.unitIdsDied);
        this.updateMoraleDecreaseForTheUnitTeam(
            moraleDecreaseForTheUnitTeam,
            fireBreathAttackResult.moraleDecreaseForTheUnitTeam,
        );
        attackerUnitPlusMorale += fireBreathAttackResult.increaseMorale;

        const skewerStrikeAttackResult = AllAbilities.processSkewerStrikeAbility(
            attackerUnit,
            targetUnit,
            this.sceneLog,
            unitsHolder,
            this.grid,
            this.damageStatisticHolder,
            attackFromCell,
            true,
            (damageForAnimation.secondary ??= []),
        );
        updateUnitsDied(skewerStrikeAttackResult.unitIdsDied);
        this.updateMoraleDecreaseForTheUnitTeam(
            moraleDecreaseForTheUnitTeam,
            skewerStrikeAttackResult.moraleDecreaseForTheUnitTeam,
        );
        attackerUnitPlusMorale += skewerStrikeAttackResult.increaseMorale;
        for (const sd of skewerStrikeAttackResult.secondaryDamages) {
            (damageForAnimation.secondary ??= []).push({
                source: "skewer_strike",
                unitId: sd.unitId,
                position: sd.unitPosition,
                amount: sd.damage,
                unitsDied: sd.unitsDied,
            });
        }

        // Petrifying Gaze is resolved from the landed melee impact before Flesh Shield redirects any of
        // its base damage. The effect remains on target even when the aura absorbs the whole base hit.
        const petrifyingGazeAttackDamage = damageFromAttack;

        if (isAttackMissed) {
            this.sceneLog.updateLog(`${attackerUnit.getName()} misses ⚔️ on ${targetUnit.getName()}`);
            // Tell the client the blow was dodged (Dodge / Small Specie / Boar Saliva / Broken Aegis) so
            // it can pop a "MISS" over the target. render stays false — there is no damage number to draw.
            damageForAnimation.missed = true;
            damageForAnimation.unitId = targetUnit.getId();
            damageForAnimation.unitPosition = targetUnit.getPosition();
            damageForAnimation.unitIsSmall = targetUnit.isSmallSize();
        } else if (!hasLightningSpinAttackLanded && !targetUnit.isDead()) {
            const fleshShieldAbsorb = AllAbilities.processFleshShieldAura(
                attackerUnit,
                targetUnit,
                damageFromAttack,
                false,
                this.grid,
                unitsHolder,
                this.sceneLog,
                this.damageStatisticHolder,
                (damageForAnimation.secondary ??= []),
            );
            damageFromAttack = fleshShieldAbsorb.remainingDamage;
            attackerUnitPlusMorale += fleshShieldAbsorb.increaseMorale;
            updateUnitsDied(fleshShieldAbsorb.unitIdsDied);
            this.updateMoraleDecreaseForTheUnitTeam(
                moraleDecreaseForTheUnitTeam,
                fleshShieldAbsorb.moraleDecreaseForTheUnitTeam,
            );
            // just log attack here,
            // to make sure that logs are in chronological order
            this.sceneLog.updateLog(
                `${attackerUnit.getName()} ⚔️ ${targetUnit.getName()} (${damageFromAttack})` +
                    HoCLib.killTag(targetUnit.calculatePossibleLosses(damageFromAttack)),
            );

            const fireShieldReflectResult = AllAbilities.processFireShieldAbility(
                targetUnit,
                attackerUnit,
                this.sceneLog,
                damageFromAttack,
                unitsHolder,
                this.damageStatisticHolder,
                (damageForAnimation.secondary ??= []),
            );

            updateUnitsDied(fireShieldReflectResult.unitIdsDied);
            this.updateMoraleDecreaseForTheUnitTeam(
                moraleDecreaseForTheUnitTeam,
                fireShieldReflectResult.moraleDecreaseForTheUnitTeam,
            );
        }

        let hasLightningSpinResponseLanded = false;
        let assimilationResponseProcessed = false;
        let responseAssimilationLanded = false;

        const captureResponse = (): void => {
            hasLightningSpinResponseLanded = false;
            if (!targetUnit.isDead() && canUnitRespondToMelee(attackerUnit, targetUnit, fightProperties)) {
                const isResponseMissed =
                    HoCLib.getRandomInt(0, 100) <
                    targetUnit.calculateMissChance(
                        attackerUnit,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                    );

                const fireBreathResponseResult = AllAbilities.processFireBreathAbility(
                    targetUnit,
                    attackerUnit,
                    this.sceneLog,
                    unitsHolder,
                    this.grid,
                    "resp",
                    this.damageStatisticHolder,
                    GridMath.getCellForPosition(this.gridSettings, targetUnit.getPosition()),
                    (damageForAnimation.secondary ??= []),
                );
                updateUnitsDied(fireBreathResponseResult.unitIdsDied);
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    fireBreathResponseResult.moraleDecreaseForTheUnitTeam,
                );
                targetUnitPlusMorale += fireBreathResponseResult.increaseMorale;

                const skewerStrikeResponseResult = AllAbilities.processSkewerStrikeAbility(
                    targetUnit,
                    attackerUnit,
                    this.sceneLog,
                    unitsHolder,
                    this.grid,
                    this.damageStatisticHolder,
                    GridMath.getCellForPosition(this.gridSettings, targetUnit.getPosition()),
                    false,
                    (damageForAnimation.secondary ??= []),
                );
                updateUnitsDied(skewerStrikeResponseResult.unitIdsDied);
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    skewerStrikeResponseResult.moraleDecreaseForTheUnitTeam,
                );
                targetUnitPlusMorale += skewerStrikeResponseResult.increaseMorale;
                for (const sd of skewerStrikeResponseResult.secondaryDamages) {
                    (damageForAnimation.secondary ??= []).push({
                        source: "skewer_strike",
                        unitId: sd.unitId,
                        position: sd.unitPosition,
                        amount: sd.damage,
                        unitsDied: sd.unitsDied,
                    });
                }

                const lightningSpinResponseResult = AllAbilities.processLightningSpinAbility(
                    targetUnit,
                    this.sceneLog,
                    unitsHolder,
                    1,
                    this.damageStatisticHolder,
                    attackFromCell,
                    false,
                    (damageForAnimation.secondary ??= []),
                    this.grid,
                );
                hasLightningSpinResponseLanded = lightningSpinResponseResult.landed;
                updateUnitsDied(lightningSpinResponseResult.unitIdsDied);

                if (!isResponseMissed && !assimilationResponseProcessed) {
                    assimilationResponseProcessed = true;
                    responseAssimilationLanded = true;
                }

                if (isResponseMissed) {
                    this.sceneLog.updateLog(`${targetUnit.getName()} misses ⚔️ resp on ${attackerUnit.getName()}`);
                } else if (!hasLightningSpinResponseLanded && !attackerUnit.isDead()) {
                    abilityMultiplier = 1;
                    const abilitiesWithPositionCoeffResp = AbilityHelper.getAbilitiesWithPosisionCoefficient(
                        targetUnit.getAbilities(),
                        GridMath.getCellForPosition(this.gridSettings, targetUnit.getPosition()),
                        attackFromCell,
                        attackerUnit.isSmallSize(),
                        targetUnit.getTeam(),
                    );

                    if (abilitiesWithPositionCoeffResp.length) {
                        for (const awpc of abilitiesWithPositionCoeffResp) {
                            abilityMultiplier *= targetUnit.calculateAbilityMultiplier(
                                awpc,
                                FightStateManager.getInstance()
                                    .getFightProperties()
                                    .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
                            );
                        }
                    }

                    const paralysisTargetUnitEffect = targetUnit.getEffect("Paralysis");
                    if (paralysisTargetUnitEffect) {
                        abilityMultiplier *= (100 - paralysisTargetUnitEffect.getPower()) / 100;
                    }

                    const deepWoundsAttackerEffect = attackerUnit.getEffect("Deep Wounds");
                    if (deepWoundsAttackerEffect && AllAbilities.hasAnyDeepWoundsAbility(targetUnit)) {
                        abilityMultiplier *= 1 + deepWoundsAttackerEffect.getPower() / 100;
                    }

                    let damageFromResponse =
                        AllAbilities.processLuckyStrikeAbility(
                            targetUnit,
                            targetUnit.calculateAttackDamage(
                                attackerUnit,
                                PBTypes.AttackVals.MELEE,
                                FightStateManager.getInstance()
                                    .getFightProperties()
                                    .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
                                1,
                                abilityMultiplier,
                            ),
                            this.sceneLog,

                            (damageForAnimation.luckyStrikeBy ??= []),
                        ) + AllAbilities.processPenetratingBiteAbility(targetUnit, attackerUnit);
                    const petrifyingGazeResponseDamage = damageFromResponse;

                    const responseFleshShieldAbsorb = AllAbilities.processFleshShieldAura(
                        targetUnit,
                        attackerUnit,
                        damageFromResponse,
                        false,
                        this.grid,
                        unitsHolder,
                        this.sceneLog,
                        this.damageStatisticHolder,
                        (damageForAnimation.secondary ??= []),
                    );
                    damageFromResponse = responseFleshShieldAbsorb.remainingDamage;
                    targetUnitPlusMorale += responseFleshShieldAbsorb.increaseMorale;
                    updateUnitsDied(responseFleshShieldAbsorb.unitIdsDied);
                    this.updateMoraleDecreaseForTheUnitTeam(
                        moraleDecreaseForTheUnitTeam,
                        responseFleshShieldAbsorb.moraleDecreaseForTheUnitTeam,
                    );

                    this.sceneLog.updateLog(
                        `${targetUnit.getName()} resp ${attackerUnit.getName()} (${damageFromResponse})` +
                            HoCLib.killTag(attackerUnit.calculatePossibleLosses(damageFromResponse)),
                    );

                    // Water Shield on the counterattacked ATTACKER: an absorbed response lands none of the
                    // responder's on-hit riders — same rule as a missed response.
                    const meleeResponseAbsorbed =
                        damageFromResponse > 0 && attackerUnit.willWaterShieldAbsorb(targetUnit);
                    this.damageStatisticHolder.add({
                        unitName: targetUnit.getName(),
                        damage: attackerUnit.applyDamage(
                            damageFromResponse,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getBreakChancePerTeam(targetUnit.getTeam()),
                            this.sceneLog,
                            true,
                            targetUnit,
                        ),
                        team: targetUnit.getTeam(),
                        lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                    });
                    if (!meleeResponseAbsorbed) {
                        const pegasusLightEffect = attackerUnit.getEffect("Pegasus Light");
                        if (pegasusLightEffect) {
                            targetUnitPlusMorale += pegasusLightEffect.getPower();
                        }

                        AllAbilities.processMinerAbility(targetUnit, attackerUnit, this.sceneLog);
                        const fireShieldFromAttackerResult = AllAbilities.processFireShieldAbility(
                            attackerUnit,
                            targetUnit,
                            this.sceneLog,
                            damageFromResponse,
                            unitsHolder,
                            this.damageStatisticHolder,
                            (damageForAnimation.secondary ??= []),
                        );
                        updateUnitsDied(fireShieldFromAttackerResult.unitIdsDied);
                        this.updateMoraleDecreaseForTheUnitTeam(
                            moraleDecreaseForTheUnitTeam,
                            fireShieldFromAttackerResult.moraleDecreaseForTheUnitTeam,
                        );
                        AllAbilities.processStunAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processStunAuraOnHit(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processFreezeAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processDullingDefenseAblity(attackerUnit, targetUnit, this.sceneLog);
                        AllAbilities.processPetrifyingGazeAbility(
                            targetUnit,
                            attackerUnit,
                            petrifyingGazeResponseDamage,
                            this.sceneLog,
                            this.damageStatisticHolder,
                            (damageForAnimation.secondary ??= []),
                        );
                        AllAbilities.processBoarSalivaAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processAggrAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        {
                            const deepWoundsPower = AllAbilities.processDeepWoundsAbility(
                                targetUnit,
                                attackerUnit,
                                attackerUnit,
                                this.sceneLog,
                            );
                            if (deepWoundsPower > 0) {
                                (damageForAnimation.deepWounds ??= []).push({
                                    unitId: attackerUnit.getId(),
                                    power: deepWoundsPower,
                                });
                            }
                        }
                        // A response is a hit like any other, so every on-hit rider the responder owns fires with
                        // the roles swapped — including its poison aura. Left out originally, which made an
                        // aura'd unit poison only on its own turn and not when it struck back.
                        AllAbilities.processPoisonAuraAbility(
                            targetUnit,
                            attackerUnit,
                            damageFromResponse,
                            this.sceneLog,
                        );
                        AllAbilities.processPegasusLightAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processParalysisAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processRimeCharmAbility(targetUnit, attackerUnit, this.sceneLog);
                        AllAbilities.processBlindnessAbility(targetUnit, attackerUnit, attackerUnit, this.sceneLog);
                        updateUnitsDied(
                            AllAbilities.processChainLightningAbility(
                                targetUnit,
                                attackerUnit,
                                damageFromResponse,
                                this.grid,
                                unitsHolder,
                                this.sceneLog,
                                this.damageStatisticHolder,
                                (damageForAnimation.secondary ??= []),
                            ),
                        );
                    }
                }
                AllAbilities.processOneInTheFieldAbility(targetUnit);
            }
        };

        // Track amount alive for detailed hits calculation
        let initialAmountAlive = targetUnit.getAmountAlive();

        // capture response
        captureResponse();

        if (!hasLightningSpinAttackLanded && !isAttackMissed && !targetUnit.isDead()) {
            // Water Shield: captured BEFORE the blow lands (applyDamage consumes the shield). An absorbed
            // strike applies nothing — the whole on-hit rider block below is skipped like a missed blow.
            const meleeAttackAbsorbed = damageFromAttack > 0 && targetUnit.willWaterShieldAbsorb(attackerUnit);
            // this code has to be here to make sure that respond damage has been applied as well
            damageForAnimation.render = true;
            damageForAnimation.amount = damageFromAttack;
            damageForAnimation.unitPosition = targetUnit.getPosition();
            damageForAnimation.unitIsSmall = targetUnit.isSmallSize();
            damageForAnimation.unitId = targetUnit.getId();
            if (damageForAnimation.hits) {
                const damageDealt = targetUnit.applyDamage(
                    damageFromAttack,
                    FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
                    this.sceneLog,
                    false,
                    attackerUnit,
                );
                const currentAmount = targetUnit.getAmountAlive();
                damageForAnimation.hits.push({
                    amount: damageDealt,
                    unitsDied: Math.max(0, initialAmountAlive - currentAmount),
                });
                initialAmountAlive = currentAmount;

                this.damageStatisticHolder.add({
                    unitName: attackerUnit.getName(),
                    damage: damageDealt,
                    team: attackerUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
            } else {
                this.damageStatisticHolder.add({
                    unitName: attackerUnit.getName(),
                    damage: targetUnit.applyDamage(
                        damageFromAttack,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getBreakChancePerTeam(attackerUnit.getTeam()),
                        this.sceneLog,
                        false,
                        attackerUnit,
                    ),
                    team: attackerUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
            }

            // An absorbed strike lands no on-hit riders — same rule as a missed blow (the outer gate).
            if (!meleeAttackAbsorbed) {
                const fireforgedSwordResult = AllAbilities.processFireforgedSwordAbility(
                    attackerUnit,
                    targetUnit,
                    damageFromAttack,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                updateUnitsDied(fireforgedSwordResult.unitIdsDied);
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    fireforgedSwordResult.moraleDecreaseForTheUnitTeam,
                );
                AllAbilities.processMinerAbility(attackerUnit, targetUnit, this.sceneLog);
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processStunAuraOnHit(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processFreezeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processDullingDefenseAblity(targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processPetrifyingGazeAbility(
                    attackerUnit,
                    targetUnit,
                    petrifyingGazeAttackDamage,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                AllAbilities.processBoarSalivaAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processAggrAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processTerrifyingGazeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                {
                    const deepWoundsPower = AllAbilities.processDeepWoundsAbility(
                        attackerUnit,
                        targetUnit,
                        attackerUnit,
                        this.sceneLog,
                    );
                    if (deepWoundsPower > 0) {
                        (damageForAnimation.deepWounds ??= []).push({
                            unitId: targetUnit.getId(),
                            power: deepWoundsPower,
                        });
                    }
                }
                AllAbilities.processPegasusLightAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processParalysisAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processShatterArmorAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processHamstringAbility(
                    attackerUnit,
                    targetUnit,
                    attackerUnit,
                    unitsHolder,
                    this.grid,
                    this.sceneLog,
                );
                AllAbilities.processPoisonAuraAbility(attackerUnit, targetUnit, damageFromAttack, this.sceneLog);
                AllAbilities.processRimeCharmAbility(attackerUnit, targetUnit, this.sceneLog);
                updateUnitsDied(
                    AllAbilities.processChainLightningAbility(
                        attackerUnit,
                        targetUnit,
                        damageFromAttack,
                        this.grid,
                        unitsHolder,
                        this.sceneLog,
                        this.damageStatisticHolder,
                        (damageForAnimation.secondary ??= []),
                    ),
                );
                const pegasusLightEffect = targetUnit.getEffect("Pegasus Light");
                if (pegasusLightEffect) {
                    attackerUnitPlusMorale += pegasusLightEffect.getPower();
                }
            }
            // ~ already responded here
        }
        unitsHolder.refreshStackPowerForAllUnits();

        const secondPunchResult = AllAbilities.processDoublePunchAbility(attackerUnit, targetUnit, this.sceneLog);
        const petrifyingGazeSecondPunchDamage = secondPunchResult.damage;

        if (!hasLightningSpinResponseLanded && attackerUnit.isDead() && !unitIdsDied.includes(attackerUnit.getId())) {
            this.sceneLog.updateLog(`${attackerUnit.getName()} died`);

            unitIdsDied.push(attackerUnit.getId());
            targetUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
            this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                [`${attackerUnit.getName()}:${attackerUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
            });
        }

        if (!hasLightningSpinAttackLanded && targetUnit.isDead() && !unitIdsDied.includes(targetUnit.getId())) {
            this.sceneLog.updateLog(`${targetUnit.getName()} died`);

            unitIdsDied.push(targetUnit.getId());
            attackerUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
            this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                [`${targetUnit.getName()}:${targetUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
            });
        } else if (secondPunchResult.applied) {
            captureResponse();
            // Water Shield vs the second punch: possible when the FIRST punch missed (shield intact).
            // Captured before the second punch's damage lands; an absorbed punch applies no riders.
            const secondPunchAbsorbed = secondPunchResult.damage > 0 && targetUnit.willWaterShieldAbsorb(attackerUnit);
            if (secondPunchResult.damage > 0) {
                const secondPunchFleshShieldAbsorb = AllAbilities.processFleshShieldAura(
                    attackerUnit,
                    targetUnit,
                    secondPunchResult.damage,
                    false,
                    this.grid,
                    unitsHolder,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                secondPunchResult.damage = secondPunchFleshShieldAbsorb.remainingDamage;
                attackerUnitPlusMorale += secondPunchFleshShieldAbsorb.increaseMorale;
                updateUnitsDied(secondPunchFleshShieldAbsorb.unitIdsDied);
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    secondPunchFleshShieldAbsorb.moraleDecreaseForTheUnitTeam,
                );
                if (damageForAnimation.hits) {
                    const damageDealtSecond = targetUnit.applyDamage(
                        secondPunchResult.damage,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getBreakChancePerTeam(attackerUnit.getTeam()),
                        this.sceneLog,
                        false,
                        attackerUnit,
                    );
                    const currentAmount = targetUnit.getAmountAlive();
                    damageForAnimation.hits.push({
                        amount: damageDealtSecond,
                        unitsDied: Math.max(0, initialAmountAlive - currentAmount),
                    });
                    initialAmountAlive = currentAmount;
                    // Also accumulate total amount for fallback/legacy usage if needed
                    damageForAnimation.amount += damageDealtSecond;

                    this.damageStatisticHolder.add({
                        unitName: attackerUnit.getName(),
                        damage: damageDealtSecond,
                        team: attackerUnit.getTeam(),
                        lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                    });
                } else {
                    this.damageStatisticHolder.add({
                        unitName: attackerUnit.getName(),
                        damage: targetUnit.applyDamage(
                            secondPunchResult.damage,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getBreakChancePerTeam(attackerUnit.getTeam()),
                            this.sceneLog,
                            false,
                            attackerUnit,
                        ),
                        team: attackerUnit.getTeam(),
                        lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                    });
                }
            }

            const secondFireShieldResult = AllAbilities.processFireShieldAbility(
                targetUnit,
                attackerUnit,
                this.sceneLog,
                secondPunchResult.damage,
                unitsHolder,
                this.damageStatisticHolder,
                (damageForAnimation.secondary ??= []),
            );
            updateUnitsDied(secondFireShieldResult.unitIdsDied);
            this.updateMoraleDecreaseForTheUnitTeam(
                moraleDecreaseForTheUnitTeam,
                secondFireShieldResult.moraleDecreaseForTheUnitTeam,
            );

            if (!secondPunchResult.missed && !secondPunchAbsorbed) {
                const secondFireforgedSwordResult = AllAbilities.processFireforgedSwordAbility(
                    attackerUnit,
                    targetUnit,
                    secondPunchResult.damage,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                updateUnitsDied(secondFireforgedSwordResult.unitIdsDied);
                this.updateMoraleDecreaseForTheUnitTeam(
                    moraleDecreaseForTheUnitTeam,
                    secondFireforgedSwordResult.moraleDecreaseForTheUnitTeam,
                );
                AllAbilities.processMinerAbility(attackerUnit, targetUnit, this.sceneLog);
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processStunAuraOnHit(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processFreezeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processDullingDefenseAblity(targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processPetrifyingGazeAbility(
                    attackerUnit,
                    targetUnit,
                    petrifyingGazeSecondPunchDamage,
                    this.sceneLog,
                    this.damageStatisticHolder,
                    (damageForAnimation.secondary ??= []),
                );
                AllAbilities.processBoarSalivaAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processAggrAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processTerrifyingGazeAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                {
                    const deepWoundsPower = AllAbilities.processDeepWoundsAbility(
                        attackerUnit,
                        targetUnit,
                        attackerUnit,
                        this.sceneLog,
                    );
                    if (deepWoundsPower > 0) {
                        (damageForAnimation.deepWounds ??= []).push({
                            unitId: targetUnit.getId(),
                            power: deepWoundsPower,
                        });
                    }
                }
                AllAbilities.processPegasusLightAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processParalysisAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processShatterArmorAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
                AllAbilities.processPoisonAuraAbility(
                    attackerUnit,
                    targetUnit,
                    secondPunchResult.damage,
                    this.sceneLog,
                );
            }

            if (
                !hasLightningSpinResponseLanded &&
                attackerUnit.isDead() &&
                !unitIdsDied.includes(attackerUnit.getId())
            ) {
                this.sceneLog.updateLog(`${attackerUnit.getName()} died`);

                unitIdsDied.push(attackerUnit.getId());
                targetUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
                this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                    [`${attackerUnit.getName()}:${attackerUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
                });
            }

            if (!hasLightningSpinAttackLanded && targetUnit.isDead() && !unitIdsDied.includes(targetUnit.getId())) {
                this.sceneLog.updateLog(`${targetUnit.getName()} died`);

                unitIdsDied.push(targetUnit.getId());
                attackerUnitPlusMorale += HoCConstants.MORALE_CHANGE_FOR_KILL;
                this.updateMoraleDecreaseForTheUnitTeam(moraleDecreaseForTheUnitTeam, {
                    [`${targetUnit.getName()}:${targetUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
                });
            }
        }

        targetUnit.increaseMorale(
            targetUnitPlusMorale,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
        );

        attackerUnit.increaseMorale(
            attackerUnitPlusMorale + secondPunchResult.moraleIncrease,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
        );
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
        if (responseAssimilationLanded) {
            const responseStolen = AllAbilities.processPredatoryAssimilationAbility(
                targetUnit,
                attackerUnit,
                this.sceneLog,
            );
            if (responseStolen) {
                abilityStolen.push(responseStolen);
            }
        }
        if (!isAttackMissed) {
            const attackStolen = AllAbilities.processPredatoryAssimilationAbility(
                attackerUnit,
                targetUnit,
                this.sceneLog,
            );
            if (attackStolen) {
                abilityStolen.push(attackStolen);
            }
        }
        unitsHolder.refreshStackPowerForAllUnits();

        AllAbilities.processDevourEssenceAbility(
            attackerUnit,
            unitIdsDied,
            unitsHolder,
            this.sceneLog,
            (damageForAnimation.secondary ??= []),
        );
        AllAbilities.processDevourEssenceAbility(
            targetUnit,
            unitIdsDied,
            unitsHolder,
            this.sceneLog,
            (damageForAnimation.secondary ??= []),
        );

        return { completed: true, unitIdsDied, animationData, abilityStolen };
    }
    /**
     * Does anything still stand to be hit?
     *
     * The classic BLOCK_CENTER keeps two hit-point counters (left mountain / right mountain). A scattered
     * layout has no sides and no per-object counters at all — each stone is simply there or gone — so the
     * question has to be asked of the grid instead.
     */
    private obstacleStillStands(): boolean {
        if (this.grid.hasScatteredMountains()) {
            return this.grid.getScatteredMountainsStanding().length > 0;
        }
        return FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft() > 0;
    }
    /**
     * Land ONE hit on the obstacle at this cell.
     *
     * Scattered stones die outright — that is their whole hit-point model. The classic mountains keep
     * spending from their side's counter, untouched. Funnelling every hit site through here is what keeps
     * the two models from drifting: there are six of them (range, double-shot, and the melee variants).
     */
    private spendObstacleHit(targetCell: HoCMath.XY, isRightMountain: boolean): void {
        if (this.grid.hasScatteredMountains()) {
            this.grid.clearScatteredMountainAt(targetCell.x, targetCell.y);
            return;
        }
        FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
    }
    public handleObstacleAttack(
        targetPosition: HoCMath.XY,
        unitsHolder: UnitsHolder,
        moveHandler: MoveHandler,
        attackerUnit?: Unit,
        attackFromCell?: HoCMath.XY,
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
    ): IAttackResult {
        const targetCell = GridMath.getCellForPosition(this.gridSettings, targetPosition);
        // Which of the two 2x2 mountains was struck (left columns vs right columns), so only its own hit
        // points are spent. Corridor cells are never targeted, so the midpoint split is unambiguous.
        const isRightMountain = targetCell.x >= this.gridSettings.getGridSize() >> 1;
        const animationData: IAnimationData[] = [];
        if (
            this.grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            FightStateManager.getInstance().getFightProperties().getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            !this.obstacleStillStands() ||
            !attackerUnit ||
            attackerUnit.isDead() ||
            !GridMath.isPositionWithinGrid(this.gridSettings, targetPosition) ||
            !GridMath.isPositionWithinGrid(this.gridSettings, attackerUnit.getPosition())
        ) {
            return { completed: false, unitIdsDied: [], animationData };
        }

        // check if unit is forced to attack certain enemy only
        // if so, check if the forced target is still alive
        const forcedTargetUnitId = attackerUnit.getTarget();
        const forcedTargetUnit = unitsHolder.getAllUnits().get(forcedTargetUnitId);
        if (forcedTargetUnit && !forcedTargetUnit.isDead()) {
            return { completed: false, unitIdsDied: [], animationData };
        }

        const centerCells = this.grid.getCenterCells();
        let foundTargetCell = false;
        for (const c of centerCells) {
            if (c.x === targetCell.x && c.y === targetCell.y) {
                foundTargetCell = true;
                break;
            }
        }

        if (!foundTargetCell) {
            return { completed: false, unitIdsDied: [], animationData };
        }

        // range attack
        let rangeLanded = false;
        if (
            attackerUnit.getAttackTypeSelection() === PBTypes.AttackVals.RANGE &&
            this.canLandRangeAttack(attackerUnit, this.grid.getEnemyAggrMatrixByUnitId(attackerUnit.getId()))
        ) {
            const doubleShotAbility =
                attackerUnit.getAbility("Double Shot") ?? attackerUnit.getAbility("Crafted Double Shot");
            const trajectoryTargets = this.grid.hasScatteredMountains()
                ? this.getObstacleIntersections(attackerUnit.getPosition(), targetPosition).slice(
                      0,
                      doubleShotAbility ? 2 : 1,
                  )
                : [{ position: targetPosition }];
            for (const trajectoryTarget of trajectoryTargets) {
                const hitCell = GridMath.getCellForPosition(this.gridSettings, trajectoryTarget.position);
                animationData.push({
                    fromPosition: attackerUnit.getPosition(),
                    toPosition: trajectoryTarget.position,
                    affectedUnit: new AttackTarget(trajectoryTarget.position, 1),
                });
                this.spendObstacleHit(hitCell, hitCell.x >= this.gridSettings.getGridSize() >> 1);
                this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
            }
            attackerUnit.decreaseNumberOfShots();
            rangeLanded = trajectoryTargets.length > 0;
        }

        // land melee attack
        if (!rangeLanded && attackFromCell) {
            let isAdjacentToCenter = false;

            const currentCell = GridMath.getCellForPosition(this.gridSettings, attackerUnit.getPosition());

            if (!currentCell) {
                return { completed: rangeLanded, unitIdsDied: [], animationData };
            }

            const attackFromCells = [attackFromCell];
            if (!attackerUnit.isSmallSize()) {
                attackFromCells.push(
                    { x: attackFromCell.x, y: attackFromCell.y - 1 },
                    { x: attackFromCell.x - 1, y: attackFromCell.y },
                    { x: attackFromCell.x - 1, y: attackFromCell.y - 1 },
                );
            }

            for (const c of attackFromCells) {
                // Two-mountain BLOCK_CENTER: the 2x2 corridor between the mountains is WALKABLE, so a
                // unit standing there is a legal attack-from position. No inner-cell exclusion here —
                // that was a single solid-block leftover that blocked attacks from between the mountains.
                const centerCells = this.grid.getCenterCells(true);
                for (const centerCell of centerCells) {
                    if (Math.abs(c.x - centerCell.x) <= 1 && Math.abs(c.y - centerCell.y) <= 1) {
                        isAdjacentToCenter = true;
                        break;
                    }
                }

                if (isAdjacentToCenter) {
                    break;
                }
            }

            if (!isAdjacentToCenter) {
                return { completed: rangeLanded, unitIdsDied: [], animationData };
            }

            const stationaryAttack = currentCell.x === attackFromCell.x && currentCell.y === attackFromCell.y;

            if (attackerUnit.isSmallSize()) {
                if (
                    (this.grid.areAllCellsEmpty(attackFromCells, attackerUnit.getId()) ||
                        this.grid.canOccupyCells(
                            attackFromCells,
                            attackerUnit.canTraverseLava(),
                            attackerUnit.hasAbilityActive("Made of Water"),
                            attackerUnit.getId(),
                        )) &&
                    (stationaryAttack ||
                        currentActiveKnownPaths?.get((attackFromCell.x << 4) | attackFromCell.y)?.length)
                ) {
                    const position = GridMath.getPositionForCell(
                        attackFromCell,
                        this.gridSettings.getMinX(),
                        this.gridSettings.getStep(),
                        this.gridSettings.getHalfStep(),
                    );

                    const moveInitiated =
                        stationaryAttack ||
                        moveHandler.applyMoveModifiers(
                            attackFromCell,
                            attackerUnit,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalMoralePerTeam(attackerUnit.getTeam()),
                            currentActiveKnownPaths,
                        );
                    if (!moveInitiated) {
                        return { completed: rangeLanded, unitIdsDied: [], animationData };
                    }

                    attackerUnit.setPosition(position.x, position.y, false);
                    this.grid.occupyCell(
                        attackFromCell,
                        attackerUnit.getId(),
                        attackerUnit.getTeam(),
                        attackerUnit.getAttackRange(),
                        attackerUnit.canTraverseLava(),
                        attackerUnit.hasAbilityActive("Made of Water"),
                    );

                    animationData.push({
                        toPosition: attackerUnit.getPosition(),
                        affectedUnit: attackerUnit,
                        bodyUnit: attackerUnit,
                    });

                    this.spendObstacleHit(targetCell, isRightMountain);
                    this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
                    if (
                        this.obstacleStillStands() &&
                        (attackerUnit.getAbility("Double Punch") ?? attackerUnit.getAbility("Crafted Double Punch"))
                    ) {
                        this.spendObstacleHit(targetCell, isRightMountain);
                        this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
                    }
                } else {
                    return { completed: rangeLanded, unitIdsDied: [], animationData };
                }
            } else {
                const position = GridMath.getPositionForCell(
                    attackFromCell,
                    this.gridSettings.getMinX(),
                    this.gridSettings.getStep(),
                    this.gridSettings.getHalfStep(),
                );
                const cells = GridMath.getCellsAroundPosition(this.gridSettings, {
                    x: position.x - this.gridSettings.getHalfStep(),
                    y: position.y - this.gridSettings.getHalfStep(),
                });
                if (
                    (this.grid.areAllCellsEmpty(cells, attackerUnit.getId()) ||
                        this.grid.canOccupyCells(
                            cells,
                            attackerUnit.canTraverseLava(),
                            attackerUnit.hasAbilityActive("Made of Water"),
                            attackerUnit.getId(),
                        )) &&
                    (stationaryAttack ||
                        currentActiveKnownPaths?.get((attackFromCell.x << 4) | attackFromCell.y)?.length)
                ) {
                    const moveInitiated =
                        stationaryAttack ||
                        moveHandler.applyMoveModifiers(
                            attackFromCell,
                            attackerUnit,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalMoralePerTeam(attackerUnit.getTeam()),
                            currentActiveKnownPaths,
                        );
                    if (!moveInitiated) {
                        return { completed: rangeLanded, unitIdsDied: [], animationData };
                    }

                    attackerUnit.setPosition(
                        position.x - this.gridSettings.getHalfStep(),
                        position.y - this.gridSettings.getHalfStep(),
                        false,
                    );

                    this.grid.occupyCells(
                        cells,
                        attackerUnit.getId(),
                        attackerUnit.getTeam(),
                        attackerUnit.getAttackRange(),
                        attackerUnit.canTraverseLava(),
                        attackerUnit.hasAbilityActive("Made of Water"),
                    );

                    animationData.push({
                        toPosition: attackerUnit.getPosition(),
                        affectedUnit: attackerUnit,
                        bodyUnit: attackerUnit,
                    });

                    this.spendObstacleHit(targetCell, isRightMountain);
                    this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);

                    if (
                        this.obstacleStillStands() &&
                        (attackerUnit.getAbility("Double Punch") ?? attackerUnit.getAbility("Crafted Double Punch"))
                    ) {
                        this.spendObstacleHit(targetCell, isRightMountain);
                        this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
                    }
                } else {
                    return { completed: rangeLanded, unitIdsDied: [], animationData };
                }
            }
        }

        return { completed: true, unitIdsDied: [], animationData };
    }
    private getAffectedUnitsAndObstacles(
        allUnits: ReadonlyMap<string, Unit>,
        cellsToPositions: [HoCMath.XY, HoCMath.XY][],
        attackerUnit: Unit,
        attackerPosition: HoCMath.XY,
        isThroughShot = false,
        isSelection = false,
        isAOEShot = false,
        hypotheticalSmokeCells?: readonly HoCMath.XY[],
        preparedHypotheticalSmokeKeys?: ReadonlySet<number>,
        preparationCapture?: IRangeAttackPreparationCapture,
    ): IRangeAttackEvaluation {
        const affectedUnitIds: string[] = [];
        const affectedUnits: Array<Unit[]> = [];
        const affectedCells: Array<HoCMath.XY[]> = [];
        const rangeAttackDivisors: number[] = [];
        let attackObstacle: IAttackObstacle | undefined;
        // Smoke (Smoke spell): once the ray has crossed ANY smoked cell, every subsequent target on this shot
        // takes half damage. The cloud is neutral — applies to ranged attacks of BOTH teams. We track the flag
        // across the whole trajectory (not per-cell) so a single arrow piercing multiple targets after the
        // smoke stays halved for all of them, matching the user's "arrow becomes 1/2, then 1/4..." intent: the
        // existing range-falloff divisor already doubles per shot-distance, and smoke doubles it once more.
        const smokeClouds = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
        // AI planning can project a not-yet-cast cloud without touching FightProperties. Hypothetical cells
        // supplement (rather than replace) live smoke, so the same evaluator is truthful in later laps too.
        const hypotheticalSmokeKeys =
            preparedHypotheticalSmokeKeys ??
            (hypotheticalSmokeCells?.length
                ? new Set(hypotheticalSmokeCells.map((cell) => SmokeClouds.key(cell)))
                : undefined);
        let pathCrossedSmoke = false;

        for (let rayIndex = 0; rayIndex < cellsToPositions.length; rayIndex += 1) {
            const cellToPosition = cellsToPositions[rayIndex];
            const cell = cellToPosition[0];
            const position = cellToPosition[1];

            if (!pathCrossedSmoke && (smokeClouds.has(cell) || hypotheticalSmokeKeys?.has(SmokeClouds.key(cell)))) {
                pathCrossedSmoke = true;
            }

            const possibleUnitId = this.grid.getOccupantUnitId(cell);
            if (possibleUnitId === "B" && !isSelection && !isAOEShot) {
                // Intercept at the actual mountain cell the shot first reaches — NOT the board centre.
                // BLOCK_CENTER now has TWO 2x2 mountains flanking a walkable corridor, so the old "centre of
                // the board, size 4" (the single big mountain) projected the block marker into the empty
                // corridor between them; a shot at the left mountain still pointed at the middle.
                const obstaclePosition = { x: position.x, y: position.y };
                attackObstacle = {
                    position: obstaclePosition,
                    size: 2,
                    distance: HoCMath.getDistance(attackerUnit.getPosition(), obstaclePosition),
                };
                break;
            }

            if (!possibleUnitId) {
                continue;
            }

            if ((attackerUnit && attackerUnit.getId() === possibleUnitId) || affectedUnitIds.includes(possibleUnitId)) {
                continue;
            }
            const possibleUnit = allUnits.get(possibleUnitId);
            if (!possibleUnit) {
                if (possibleUnitId === "L" || possibleUnitId === "W") {
                    affectedCells.push([cell]);
                }
                continue;
            }

            if (attackerUnit) {
                if (attackerUnit.getTeam() === possibleUnit.getTeam()) {
                    continue;
                }
            }

            let unitsThisShot: Unit[] = [];
            unitsThisShot.push(possibleUnit);
            affectedUnitIds.push(possibleUnitId);

            if (
                (attackerUnit.hasAbilityActive("Large Caliber") || attackerUnit.hasAbilityActive("Area Throw")) &&
                !possibleUnit.hasAbilityActive("Arrows Wingshield Aura")
            ) {
                const unitIds: string[] = [possibleUnitId];

                let isCellOccupied = false;
                const possibleOccupantId = this.grid.getOccupantUnitId(cell);
                if (possibleOccupantId) {
                    if (allUnits.get(possibleOccupantId)) {
                        isCellOccupied = true;
                    }
                }

                if (isSelection || isCellOccupied) {
                    const cells = GridMath.getCellsAroundCell(this.gridSettings, cell);

                    for (const c of cells) {
                        const possibleUnitId = this.grid.getOccupantUnitId(c);
                        if (!possibleUnitId) {
                            continue;
                        }
                        if (unitIds.includes(possibleUnitId)) {
                            continue;
                        }

                        const possibleUnit = allUnits.get(possibleUnitId);
                        if (!possibleUnit) {
                            continue;
                        }

                        unitsThisShot.push(possibleUnit);
                        unitIds.push(possibleUnitId);
                    }

                    cells.push(cell);
                    affectedCells.push(cells);
                } else {
                    affectedCells.push([cell]);
                }
            } else {
                affectedCells.push([cell]);
            }

            affectedUnits.push(unitsThisShot);
            // Smoke halves damage by doubling the range-falloff divisor (capped at 8, same ceiling as
            // getRangeAttackDivisor). pathCrossedSmoke is sticky for the rest of this ray.
            let divisor = this.getRangeAttackDivisor(attackerUnit, position, attackerPosition);
            if (preparationCapture) {
                preparationCapture.hitRayIndices.push(rayIndex);
                preparationCapture.baseRangeAttackDivisors.push(divisor);
                preparationCapture.liveSmokeByHit.push(pathCrossedSmoke);
            }
            if (pathCrossedSmoke) {
                divisor = Math.min(8, divisor * 2);
            }
            rangeAttackDivisors.push(divisor);

            if (isThroughShot && possibleUnit.hasAbilityActive("Arrows Wingshield Aura")) {
                break;
            }
        }

        return {
            rangeAttackDivisors,
            affectedUnits,
            affectedCells,
            attackObstacle,
        };
    }
    private updateMoraleDecreaseForTheUnitTeam(
        initialRecord: Record<string, number>,
        updateBy: Record<string, number>,
    ): void {
        for (const updateByKey of Object.keys(updateBy)) {
            const updateByValue = updateBy[updateByKey];
            if (updateByValue > 0) {
                initialRecord[updateByKey] = (initialRecord[updateByKey] || 0) + updateByValue;
            }
        }
    }
}
