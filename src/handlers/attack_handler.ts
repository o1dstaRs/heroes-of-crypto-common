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
import { amplifyCastBuffForTarget } from "../spells/castable_buff";
import * as SpellHelper from "../spells/spell_helper";
import { SpellPowerType } from "../spells/spell_properties";
import type { IWeightedRoute } from "../grid/path_definitions";
import { Spell } from "../spells/spell";
import * as HoCConstants from "../constants";
import * as AbilityHelper from "../abilities/ability_helper";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
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

export interface IRangeAttackEvaluation {
    rangeAttackDivisors: number[];
    affectedUnits: Array<Unit[]>;
    affectedCells: Array<HoCMath.XY[]>;
    attackObstacle?: IAttackObstacle;
}

export interface IAttackResult {
    completed: boolean;
    unitIdsDied: string[];
    animationData?: IAnimationData[];
    abilityStolen?: AllAbilities.IAbilityStolen[];
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
        const intersectedCellsToPositions = this.getCellsToPositions(
            this.getIntersectedPositions(fromPosition, lineEndPosition),
        );

        return this.getAffectedUnitsAndObstacles(
            allUnits,
            intersectedCellsToPositions,
            fromUnit,
            fromPosition,
            isThroughShot,
            isSelection,
            isAOEShot,
        );
    }
    /**
     * Area Throw projection (e.g. Gargantuan): a thrown AOE shot is intercepted by the first enemy
     * unit standing on the straight line between the attacker and the aimed cell. Returns that
     * unit's base cell so the splash "projects to it" instead of the throw passing through to the
     * empty cell behind. When the path is clear, the aimed cell is returned unchanged. Mirrors the
     * legacy behaviour (scripts/legacy/test_heroes.ts Area Throw branch), where a unit on the
     * trajectory intercepts the throw.
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
            !unit.hasDebuffActive("Rangebane")
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
                        if (!targetUnit.hasAbilityActive(currentActiveSpell.getName()) && deletedAbility) {
                            targetUnit.addAbility(deletedAbility);
                        }
                        clarifyingStr = holyCrossBuff ? `=> copied` : `=> gifted`;
                    } else {
                        const healPower = targetUnit.applyHeal(
                            Math.floor(currentActiveSpell.getPower() * attackerUnit.getAmountAlive() * holyCrossFactor),
                        );
                        clarifyingStr = `for ${healPower} hp`;
                    }
                } else if (currentActiveSpell.getPowerType() === SpellPowerType.RESURRECT) {
                    const wasHp = targetUnit.getHp();
                    const resurrectedAmount = targetUnit.applyResurrection(
                        Math.floor(attackerUnit.getCumulativeMaxHp() * holyCrossFactor),
                    );
                    if (resurrectedAmount) {
                        clarifyingStr = `for ${resurrectedAmount} units`;
                    } else {
                        clarifyingStr = `for ${targetUnit.getHp() - wasHp} hp`;
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

                const absorptionTarget = EffectHelper.getAbsorptionTarget(debuffTarget, this.grid, unitsHolder);
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
                                attackerUnit.hasAbilityActive("Made of Fire"),
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
                                debuffTarget.hasAbilityActive("Made of Fire"),
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

                if (
                    currentActiveSpell.getPowerType() !== SpellPowerType.POSITION_CHANGE &&
                    SpellHelper.isMirrored(debuffTarget) &&
                    !SpellHelper.hasAlreadyAppliedSpell(debuffTarget, currentActiveSpell) &&
                    !(
                        currentActiveSpell.getPowerType() === SpellPowerType.MIND &&
                        attackerUnit.hasMindAttackResistance()
                    )
                ) {
                    attackerUnit.applyDebuff(
                        currentActiveSpell,
                        undefined,
                        undefined,
                        attackerUnit.getId() === targetUnit.getId(),
                    );
                    mirroredStr = `${debuffTarget.getName()} mirrored ${currentActiveSpell.getName()} to ${attackerUnit.getName()} for ${HoCLib.getLapString(
                        laps,
                    )}`;
                }
            }

            if (currentActiveSpell.isSelfDebuffApplicable()) {
                // effect can be absorbed
                let debuffTarget = attackerUnit;
                const absorptionTarget = EffectHelper.getAbsorptionTarget(debuffTarget, this.grid, unitsHolder);
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
            }
            this.sceneLog.updateLog(mirroredStr);

            return { completed: true, unitIdsDied, animationData };
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
            unitsHolder.refreshStackPowerForAllUnits();
            return { completed: true, unitIdsDied, animationData, abilityStolen };
        }

        if (
            !isAOE &&
            (!targetUnit ||
                (targetUnit.getTeam() === attackerUnit.getTeam() && !isAOE) ||
                targetUnit.isDead() ||
                (attackerUnit.hasDebuffActive("Cowardice") &&
                    attackerUnit.getCumulativeHp() < targetUnit.getCumulativeHp()))
        ) {
            return { completed: false, unitIdsDied, animationData };
        }

        let hoverRangeAttackDivisor: number | undefined = hoverRangeAttackDivisors.at(targetUnitUndex);
        if (!hoverRangeAttackDivisor) {
            return { completed: false, unitIdsDied, animationData };
        }

        targetUnitUndex++;

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
        if (
            rangeResponseUnit &&
            !attackerUnit.canSkipResponse() &&
            !fightProperties.hasAlreadyRepliedAttack(targetUnit.getId()) &&
            targetUnit.canRespond(PBTypes.AttackVals.RANGE) &&
            this.canLandRangeAttack(targetUnit, this.grid.getEnemyAggrMatrixByUnitId(targetUnit.getId())) &&
            !(
                targetUnit.hasDebuffActive("Cowardice") &&
                targetUnit.getCumulativeHp() < rangeResponseUnit.getCumulativeHp()
            ) &&
            (!targetUnit.getTarget() || targetUnit.getTarget() === attackerUnit.getId())
        ) {
            isResponseMissed =
                HoCLib.getRandomInt(0, 100) <
                targetUnit.calculateMissChance(
                    rangeResponseUnit,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(rangeResponseUnit.getTeam()),
                );
            animationData.push({
                fromPosition: targetUnit.getPosition(),
                toPosition: attackerUnit.getPosition(),
                affectedUnit: rangeResponseUnit,
            });
        } else {
            rangeResponseUnit = undefined;
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
        );
        let attackDamageApplied = true;
        if (aoeRangeAttackResult.landed) {
            damageFromAttack = AllAbilities.processLuckyStrikeAbility(
                attackerUnit,
                aoeRangeAttackResult.maxDamage,
                this.sceneLog,
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
            );
            if (aoeRangeResponseResult.landed) {
                damageFromResponse = AllAbilities.processLuckyStrikeAbility(
                    targetUnit,
                    aoeRangeResponseResult.maxDamage,
                    this.sceneLog,
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
                const pegasusLightEffect = rangeResponseUnit.getEffect("Pegasus Light");
                if (pegasusLightEffect) {
                    targetUnitPlusMorale += pegasusLightEffect.getPower();
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
                const pegasusLightEffect = targetUnit.getEffect("Pegasus Light");
                if (pegasusLightEffect) {
                    attackerUnitPlusMorale += pegasusLightEffect.getPower();
                }
            }

            if (!targetUnit.isDead() && !isAttackMissed) {
                // On-hit effects only land when the shot itself did: a dodged/missed shot (Dodge /
                // Small Specie / Boar Saliva) must not stun/petrify/etc. — mirrors the melee path,
                // which gates this same block on !isAttackMissed (bug: an Orc could miss a Scavenger
                // and still Stun it).
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
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
                } else if (!isResponseMissed) {
                    // Same rule for the return shot: a dodged/missed counter lands no on-hit effects
                    // (mirrors the melee response path's isResponseMissed gate).
                    AllAbilities.processStunAbility(targetUnit, rangeResponseUnit, attackerUnit, this.sceneLog);
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
                (attackerUnit.hasDebuffActive("Cowardice") &&
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

        const secondShotResult = AllAbilities.processDoubleShotAbility(
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
            if (!targetUnit.isDead() && secondShotResult.applied) {
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
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
            (attackerUnit.hasDebuffActive("Cowardice") && attackerUnit.getCumulativeHp() < targetUnit.getCumulativeHp())
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
                        attackerUnit.hasAbilityActive("Made of Fire"),
                        attackerUnit.hasAbilityActive("Made of Water"),
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
                    attackerUnit.hasAbilityActive("Made of Fire"),
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
                        attackerUnit.hasAbilityActive("Made of Fire"),
                        attackerUnit.hasAbilityActive("Made of Water"),
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
                    attackerUnit.hasAbilityActive("Made of Fire"),
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
        if (currentActiveKnownPaths) {
            const paths = currentActiveKnownPaths.get((attackFromCell.x << 4) | attackFromCell.y);
            if (paths?.length) {
                rapidChargeCellsNumber = paths[0].route.length;
            }
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
        if (
            deepWoundsTargetEffect &&
            (attackerUnit.hasAbilityActive("Deep Wounds Level 1") ||
                attackerUnit.hasAbilityActive("Deep Wounds Level 2") ||
                attackerUnit.hasAbilityActive("Deep Wounds Level 3"))
        ) {
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
            if (
                !targetUnit.isDead() &&
                !fightProperties.hasAlreadyRepliedAttack(targetUnit.getId()) &&
                targetUnit.canRespond(PBTypes.AttackVals.MELEE) &&
                !attackerUnit.canSkipResponse() &&
                !targetUnit.hasAbilityActive("No Melee") &&
                !(
                    targetUnit.hasDebuffActive("Cowardice") &&
                    targetUnit.getCumulativeHp() < attackerUnit.getCumulativeHp()
                ) &&
                (!targetUnit.getTarget() || targetUnit.getTarget() === attackerUnit.getId())
            ) {
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
                    if (
                        deepWoundsAttackerEffect &&
                        (targetUnit.hasAbilityActive("Deep Wounds Level 1") ||
                            targetUnit.hasAbilityActive("Deep Wounds Level 2") ||
                            targetUnit.hasAbilityActive("Deep Wounds Level 3"))
                    ) {
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
                AllAbilities.processOneInTheFieldAbility(targetUnit);
            }
        };

        // Track amount alive for detailed hits calculation
        let initialAmountAlive = targetUnit.getAmountAlive();

        // capture response
        captureResponse();

        if (!hasLightningSpinAttackLanded && !isAttackMissed && !targetUnit.isDead()) {
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

            AllAbilities.processMinerAbility(attackerUnit, targetUnit, this.sceneLog);
            AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
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
            {
                const deepWoundsPower = AllAbilities.processDeepWoundsAbility(
                    attackerUnit,
                    targetUnit,
                    attackerUnit,
                    this.sceneLog,
                );
                if (deepWoundsPower > 0) {
                    (damageForAnimation.deepWounds ??= []).push({ unitId: targetUnit.getId(), power: deepWoundsPower });
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

            if (!secondPunchResult.missed) {
                AllAbilities.processMinerAbility(attackerUnit, targetUnit, this.sceneLog);
                AllAbilities.processStunAbility(attackerUnit, targetUnit, attackerUnit, this.sceneLog);
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

        AllAbilities.processDevourEssenceAbility(attackerUnit, unitIdsDied, unitsHolder, this.sceneLog);
        AllAbilities.processDevourEssenceAbility(targetUnit, unitIdsDied, unitsHolder, this.sceneLog);

        return { completed: true, unitIdsDied, animationData, abilityStolen };
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
            FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft() <= 0 ||
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
            animationData.push({
                fromPosition: attackerUnit.getPosition(),
                toPosition: targetPosition,
                affectedUnit: new AttackTarget(targetPosition, 1),
            });
            FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
            attackerUnit.decreaseNumberOfShots();
            this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
            rangeLanded = true;
        }

        // range second attack
        if (FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft()) {
            const doubleShotAbility = attackerUnit.getAbility("Double Shot");
            if (
                doubleShotAbility &&
                attackerUnit.getAttackTypeSelection() === PBTypes.AttackVals.RANGE &&
                this.canLandRangeAttack(attackerUnit, this.grid.getEnemyAggrMatrixByUnitId(attackerUnit.getId()))
            ) {
                animationData.push({
                    fromPosition: attackerUnit.getPosition(),
                    toPosition: targetPosition,
                    affectedUnit: new AttackTarget(targetPosition, 1),
                });
                FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
                attackerUnit.decreaseNumberOfShots();
                this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
                rangeLanded = true;
            }
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
                            attackerUnit.hasAbilityActive("Made of Fire"),
                            attackerUnit.hasAbilityActive("Made of Water"),
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
                        attackerUnit.hasAbilityActive("Made of Fire"),
                        attackerUnit.hasAbilityActive("Made of Water"),
                    );

                    animationData.push({
                        toPosition: attackerUnit.getPosition(),
                        affectedUnit: attackerUnit,
                        bodyUnit: attackerUnit,
                    });

                    FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
                    this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);
                    if (
                        FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft() &&
                        attackerUnit.getAbility("Double Punch")
                    ) {
                        FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
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
                            attackerUnit.hasAbilityActive("Made of Fire"),
                            attackerUnit.hasAbilityActive("Made of Water"),
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
                        attackerUnit.hasAbilityActive("Made of Fire"),
                        attackerUnit.hasAbilityActive("Made of Water"),
                    );

                    animationData.push({
                        toPosition: attackerUnit.getPosition(),
                        affectedUnit: attackerUnit,
                        bodyUnit: attackerUnit,
                    });

                    FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
                    this.sceneLog.updateLog(`${attackerUnit.getName()} hit mountain`);

                    if (
                        FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft() &&
                        attackerUnit.getAbility("Double Punch")
                    ) {
                        FightStateManager.getInstance().getFightProperties().encounterObstacleHit(isRightMountain);
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
    ): IRangeAttackEvaluation {
        const affectedUnitIds: string[] = [];
        const affectedUnits: Array<Unit[]> = [];
        const affectedCells: Array<HoCMath.XY[]> = [];
        const rangeAttackDivisors: number[] = [];
        let attackObstacle: IAttackObstacle | undefined;

        for (const cellToPosition of cellsToPositions) {
            const cell = cellToPosition[0];
            const position = cellToPosition[1];

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
            rangeAttackDivisors.push(this.getRangeAttackDivisor(attackerUnit, position, attackerPosition));

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
    private getCellsToPositions(positions: HoCMath.XY[]): Array<[HoCMath.XY, HoCMath.XY]> {
        const cells: Array<[HoCMath.XY, HoCMath.XY]> = [];
        const cellKeys: number[] = [];

        for (const position of positions) {
            const cell = GridMath.getCellForPosition(this.gridSettings, position);
            if (!cell) {
                continue;
            }
            const cellKey = (cell.x << 4) | cell.y;
            if (cellKeys.includes(cellKey)) {
                continue;
            }
            cells.push([cell, position]);
            cellKeys.push(cellKey);
        }
        return cells;
    }
    private getIntersectedPositions(start: HoCMath.XY, end: HoCMath.XY): HoCMath.XY[] {
        const positions: HoCMath.XY[] = [];

        // Convert world coordinates to grid coordinates
        const gridStart = start;
        const gridEnd = end;

        let x0 = Math.round(gridStart.x);
        let y0 = Math.round(gridStart.y);
        let x1 = Math.round(gridEnd.x);
        let y1 = Math.round(gridEnd.y);

        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;

        while (true) {
            positions.push({ x: x0, y: y0 });

            if (x0 === x1 && y0 === y1) break;

            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }

        return positions;
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
