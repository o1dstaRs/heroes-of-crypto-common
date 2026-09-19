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

import { PBTypes } from "../generated/protobuf/v1/types";
import { Grid } from "../grid/grid";
import { isCellWithinGrid } from "../grid/grid_math";
import * as HoCMath from "../utils/math";
import * as HoCConstants from "../constants";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import * as AbilityHelper from "../abilities/ability_helper";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";
import { applyMagicMirrorDamage } from "../spells/magic_mirror_damage";
import { SpellElement } from "../spells/spell_properties";

export interface IFireBreathResult {
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

export function processFireBreathAbility(
    fromUnit: Unit,
    toUnit: Unit,
    sceneLog: ISceneLog,
    unitsHolder: UnitsHolder,
    grid: Grid,
    attackTypeString: string,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    targetMovePosition?: HoCMath.XY,
    secondaryDamage?: ISecondaryDamage[],
): IFireBreathResult {
    if (!fromUnit.getAbility("Fire Breath")) {
        return { increaseMorale: 0, moraleDecreaseForTheUnitTeam: {}, unitIdsDied: [] };
    }

    const targets = AbilityHelper.nextStandingTargets(fromUnit, toUnit, grid, unitsHolder, targetMovePosition);
    return breatheFireOnTargets(fromUnit, targets, sceneLog, attackTypeString, damageStatisticHolder, secondaryDamage);
}

/** A FULLY fire-immune unit (Fire Element, e.g. Efreet / Black Dragon, or 100% magic resist) takes no breath damage. */
function isFullyFireImmune(unit: Unit): boolean {
    return unit.getMagicResist() >= 100 || unit.hasAbilityActive("Fire Element");
}

/**
 * Land a Fire Breath on units that have already been chosen, in sweep order: damage, Magic Mirror, kills and morale.
 * processFireBreathAbility picks them past a unit target; a breath aimed at a cemetery barrel picks the unit behind
 * the barrel (fireBreathUnitBehindObstacle).
 */
export function breatheFireOnTargets(
    fromUnit: Unit,
    targets: readonly Unit[],
    sceneLog: ISceneLog,
    attackTypeString: string,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
): IFireBreathResult {
    const unitIdsDied: string[] = [];
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    const fireBreathAbility = fromUnit.getAbility("Fire Breath");
    let increaseMoraleTotal = 0;

    if (!fireBreathAbility) {
        return {
            increaseMorale: increaseMoraleTotal,
            moraleDecreaseForTheUnitTeam,
            unitIdsDied,
        };
    }

    const unitsDead: Unit[] = [];

    for (const nextStandingTarget of targets) {
        // A dead unit doesn't block the wave — the fire passes through its (about-to-be-emptied) cell.
        if (nextStandingTarget.isDead()) {
            continue;
        }
        // A fully fire-immune unit takes no damage AND acts as a fire wall: it shields every unit behind it in the
        // wave's path. Stop the sweep here — do not carry the breath through to further targets. Say so: the wave
        // stopping dead with no line at all read as the breath failing for no reason.
        if (isFullyFireImmune(nextStandingTarget)) {
            sceneLog.updateLog(`${nextStandingTarget.getName()} resisted from Fire Breath`);
            break;
        }

        const heavyArmorAbility = nextStandingTarget.getAbility("Heavy Armor");
        let multiplier = 1;
        if (heavyArmorAbility) {
            multiplier = Number(
                (
                    ((heavyArmorAbility.getPower() + nextStandingTarget.getLuck()) /
                        100 /
                        HoCConstants.MAX_UNIT_STACK_POWER) *
                        nextStandingTarget.getStackPower() +
                    1
                ).toFixed(2),
            );
        }

        // take magic resist into account
        let fireBreathAttackDamage = Math.floor(
            fromUnit.calculateAttackDamage(
                nextStandingTarget,
                PBTypes.AttackVals.MELEE,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                1,
                fromUnit.calculateAbilityMultiplier(
                    fireBreathAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                ),
            ) *
                (1 - nextStandingTarget.getMagicResist() / 100) *
                multiplier,
        );

        // ARTIFACT Giant's Maul does NOT apply here: Fire Breath is MAGICAL AOE (uses magic resist, not the
        // physical status-resistance path), and Giant's Maul only boosts non-magical AOE damage.
        // ARTIFACT Broken Aegis: the victim takes reduced damage from area attacks.
        const aegisShieldBuff = nextStandingTarget.getBuff("Broken Aegis");
        if (aegisShieldBuff) {
            fireBreathAttackDamage = Math.floor(fireBreathAttackDamage * (1 - aegisShieldBuff.getPower() / 100));
        }

        // ABILITY Flesh Shield Aura (Abomination) does NOT apply here either: the aura only soaks physical
        // damage, and Fire Breath is magical. Every breathed point stays on the unit that was breathed on.

        const positionAtImpact = { ...nextStandingTarget.getPosition() };
        const amountAliveBefore = nextStandingTarget.getAmountAlive();
        // fromUnit (Fire Element) passed so a Water Shield on the target is ignored by fire.
        const damageDealt = nextStandingTarget.applyDamage(
            fireBreathAttackDamage,
            0 /* magic attack */,
            sceneLog,
            false,
            fromUnit,
        );
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: damageDealt,
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });
        const unitsKilled = Math.max(0, amountAliveBefore - nextStandingTarget.getAmountAlive());
        secondaryDamage?.push({
            source: "fire_breath",
            unitId: nextStandingTarget.getId(),
            position: positionAtImpact,
            amount: damageDealt,
            unitsDied: unitsKilled,
        });

        sceneLog.updateLog(
            `${fromUnit.getName()} ${attackTypeString} ${nextStandingTarget.getName()} (${fireBreathAttackDamage})` +
                HoCLib.killTag(unitsKilled),
        );
        const mirror = applyMagicMirrorDamage({
            attacker: fromUnit,
            holder: nextStandingTarget,
            landedOnHolder: fireBreathAttackDamage,
            element: SpellElement.FIRE,
            sceneLog,
            secondaryDamage,
        });
        if (mirror?.unitDied && !unitIdsDied.includes(fromUnit.getId())) {
            unitIdsDied.push(fromUnit.getId());
        }

        if (nextStandingTarget.isDead()) {
            unitsDead.push(nextStandingTarget);
        }
    }

    for (const unitDead of unitsDead) {
        if (!unitIdsDied.includes(unitDead.getId())) {
            sceneLog.updateLog(`${unitDead.getName()} died`);
            unitIdsDied.push(unitDead.getId());
            increaseMoraleTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
            const unitNameKey = `${unitDead.getName()}:${unitDead.getTeam()}`;
            moraleDecreaseForTheUnitTeam[unitNameKey] =
                (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
        }
    }

    return {
        increaseMorale: increaseMoraleTotal,
        moraleDecreaseForTheUnitTeam,
        unitIdsDied,
    };
}

/**
 * The cemetery barrels a unit-aimed Fire Breath burns: every scattered barrel standing in the band the breath sweeps
 * behind its target (AbilityHelper.pierceSweepCells — one cell behind a small target, the target's own depth behind a
 * large one). Every barrel standing in that band burns.
 */
export function fireBreathObstacleCells(
    fromUnit: Unit,
    grid: Grid,
    attackFromCell: HoCMath.XY,
    target: Unit,
): HoCMath.XY[] {
    if (!grid.hasScatteredMountains() || !fromUnit.hasAbilityActive("Fire Breath")) {
        return [];
    }
    const settings = grid.getSettings();
    return AbilityHelper.pierceSweepCells(fromUnit, target, attackFromCell).filter(
        (cell) => isCellWithinGrid(settings, cell) && grid.getOccupantUnitId(cell) === "B",
    );
}

/**
 * The unit a barrel-aimed Fire Breath burns: whoever stands in the one cell behind the struck barrel on the strike
 * line (a barrel is a single-cell target). Like the unit sweep, the breath spares nobody for being an ally — only a
 * fully fire-immune unit, which takes no damage at all.
 */
export function fireBreathUnitBehindObstacle(
    fromUnit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    attackFromCell: HoCMath.XY,
    obstacleCell: HoCMath.XY,
): Unit | undefined {
    if (!fromUnit.hasAbilityActive("Fire Breath")) {
        return undefined;
    }
    const behindCell = AbilityHelper.pierceCellBehind(fromUnit, attackFromCell, obstacleCell);
    if (!behindCell || !isCellWithinGrid(grid.getSettings(), behindCell)) {
        return undefined;
    }
    const occupantId = grid.getOccupantUnitId(behindCell);
    const occupant = occupantId ? unitsHolder.getAllUnits().get(occupantId) : undefined;
    return occupant && !occupant.isDead() && occupant.getId() !== fromUnit.getId() && !isFullyFireImmune(occupant)
        ? occupant
        : undefined;
}
