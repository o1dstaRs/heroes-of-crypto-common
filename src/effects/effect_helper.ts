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
import { getCellsAroundCell } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { AttackType } from "../units/unit_properties";
import { XY } from "../utils/math";
import { AuraEffectProperties } from "./effect_properties";

export function canApplyAuraEffect(unitAttackType: AttackType, auraEffectProperties: AuraEffectProperties): boolean {
    if (
        auraEffectProperties.power_type === AbilityPowerType.LUCK_10 ||
        auraEffectProperties.power_type === AbilityPowerType.ABSORB_DEBUFF ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS
    ) {
        return true;
    }

    if (
        unitAttackType === AttackType.RANGE &&
        auraEffectProperties.power_type === AbilityPowerType.DISABLE_RANGE_ATTACK
    ) {
        return true;
    }

    if (
        (unitAttackType === AttackType.MELEE || unitAttackType === AttackType.MAGIC) &&
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
