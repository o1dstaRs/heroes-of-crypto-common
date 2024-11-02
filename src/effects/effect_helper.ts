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

import { AbilityPowerType } from "../abilities/ability_properties";
import { Grid } from "../grid/grid";
import { getCellsAroundCell } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import { AttackType } from "../units/unit_properties";
import { getRandomInt } from "../utils/lib";
import { XY } from "../utils/math";
import { AuraEffectProperties } from "./effect_properties";

export function canApplyAuraEffect(unit: Unit, auraEffectProperties: AuraEffectProperties): boolean {
    if (
        auraEffectProperties.power_type === AbilityPowerType.UNTARGETABLE &&
        unit.hasAuraEffect("Disguise") &&
        unit.hasAbilityActive("Disguise Aura")
    ) {
        return true;
    }

    if (
        auraEffectProperties.power_type === AbilityPowerType.LUCK_10 ||
        auraEffectProperties.power_type === AbilityPowerType.ABSORB_DEBUFF ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS ||
        (auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS_WALK && !unit.canFly())
    ) {
        return true;
    }

    if (
        unit.getAttackType() === AttackType.RANGE &&
        auraEffectProperties.power_type === AbilityPowerType.DISABLE_RANGE_ATTACK
    ) {
        return true;
    }

    if (
        (unit.getAttackType() === AttackType.MELEE ||
            unit.getAttackType() === AttackType.MAGIC ||
            unit.getAttackType() === AttackType.MELEE_MAGIC) &&
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE
    ) {
        return true;
    }

    return false;
}

export function getAuraCellKeys(gridSettings: GridSettings, cell: XY, auraRange: number): number[] {
    const ret: number[] = [];
    let cellsPool: XY[] = [cell];
    const cellsCheckedAura: number[] = [];

    if (auraRange >= 0) {
        ret.push((cell.x << 4) | cell.y);
    }

    while (auraRange > 0) {
        let nextPool: XY[] = [];
        while (cellsPool.length) {
            const cellToCheck = cellsPool.pop();
            if (!cellToCheck) {
                continue;
            }

            const cellToCheckKey = (cellToCheck.x << 4) | cellToCheck.y;

            if (cellsCheckedAura.includes(cellToCheckKey)) {
                continue;
            }

            const cells = getCellsAroundCell(gridSettings, cellToCheck);
            for (const c of cells) {
                nextPool.push(c);
                const cellKey = (c.x << 4) | c.y;
                if (!ret.includes(cellKey)) {
                    ret.push(cellKey);
                }
            }

            cellsCheckedAura.push(cellToCheckKey);
        }
        cellsPool = nextPool;

        auraRange--;
    }

    return ret;
}

export function getAuraCells(gridSettings: GridSettings, cell: XY, auraRange: number): XY[] {
    const ret: XY[] = [];
    const cellKeys: number[] = [];
    let cellsPool: XY[] = [cell];
    const cellsCheckedAura: number[] = [];

    if (auraRange >= 0) {
        ret.push(cell);
        cellKeys.push((cell.x << 4) | cell.y);
    }

    while (auraRange > 0) {
        let nextPool: XY[] = [];
        while (cellsPool.length) {
            const cellToCheck = cellsPool.pop();
            if (!cellToCheck) {
                continue;
            }

            const cellToCheckKey = (cellToCheck.x << 4) | cellToCheck.y;

            if (cellsCheckedAura.includes(cellToCheckKey)) {
                continue;
            }

            const cells = getCellsAroundCell(gridSettings, cellToCheck);
            for (const c of cells) {
                nextPool.push(c);
                const cellKey = (c.x << 4) | c.y;
                if (!cellKeys.includes(cellKey)) {
                    ret.push(c);
                    cellKeys.push(cellKey);
                }
            }

            cellsCheckedAura.push(cellToCheckKey);
        }
        cellsPool = nextPool;

        auraRange--;
    }

    return ret;
}

export const getAbsorptionTarget = (forUnit: Unit, grid: Grid, unitsHolder: UnitsHolder): Unit | undefined => {
    const absorbPenaltiesAura = forUnit.getBuff("Absorb Penalties Aura");
    if (absorbPenaltiesAura) {
        const x = absorbPenaltiesAura.getFirstSpellProperty();
        const y = absorbPenaltiesAura.getSecondSpellProperty();
        if (x !== undefined && y !== undefined) {
            const auraSourceUnitId = grid.getOccupantUnitId({ x: x, y: y });
            if (auraSourceUnitId) {
                const auraSourceUnit = unitsHolder.getAllUnits().get(auraSourceUnitId);
                if (auraSourceUnit) {
                    if (getRandomInt(0, 100) < Math.floor(absorbPenaltiesAura.getPower()) && !auraSourceUnit.isDead()) {
                        return auraSourceUnit;
                    }
                }
            }
        }
    }

    return undefined;
};
