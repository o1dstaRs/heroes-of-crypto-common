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
import { PBTypes } from "../generated/protobuf/v1/types";
import { getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";
import { AuraEffectProperties } from "./effect_properties";

const auraCellKeysPerGrid = new WeakMap<GridSettings, Map<number, Map<number, ReadonlyArray<number>>>>();

export function canApplyAuraEffect(unit: Unit, auraEffectProperties: AuraEffectProperties): boolean {
    if (auraEffectProperties.power_type === AbilityPowerType.DISABLE_FLY_MOVEMENT) {
        return unit.canFly();
    }

    if (
        auraEffectProperties.power_type === AbilityPowerType.UNTARGETABLE &&
        unit.hasAuraEffect("Disguise") &&
        unit.hasAbilityActive("Disguise Aura")
    ) {
        return true;
    }

    if (
        auraEffectProperties.power_type === AbilityPowerType.LUCK_10 ||
        auraEffectProperties.power_type === AbilityPowerType.POISON_ON_HIT ||
        auraEffectProperties.power_type === AbilityPowerType.ABSORB_DEBUFF ||
        auraEffectProperties.power_type === AbilityPowerType.ABSORB_DAMAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_MAGIC_RESIST_PERCENTAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS ||
        // Sylvan Focus (Satyr): deliberately NOT gated on attack type, unlike the ranged auras below. Magic
        // damage comes out of spells and out of abilities like Fire Breath just as much as out of a MAGIC
        // attack, so gating on the attack type would deny the bonus to a melee dragon breathing fire.
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_MAGIC_DAMAGE_PERCENTAGE ||
        (auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS_WALK && !unit.canFly())
    ) {
        return true;
    }

    // AURA Rallying Volley (Zena) and Guiding Winds (Dryad): extra shots and extra shot range are only
    // meaningful to a unit that SHOOTS, so they land on ranged allies alone — the same shape as the
    // DISABLE_RANGE_ATTACK rule just below. An aura power type absent from these lists is silently never
    // applied, which is why a new aura shows up on nobody.
    if (
        unit.getAttackType() === PBTypes.AttackVals.RANGE &&
        (auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_RANGE_SHOTS ||
            auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_SHOT_DISTANCE_PERCENTAGE)
    ) {
        return true;
    }

    if (
        unit.getAttackType() === PBTypes.AttackVals.RANGE &&
        auraEffectProperties.power_type === AbilityPowerType.DISABLE_RANGE_ATTACK
    ) {
        return true;
    }

    if (
        (unit.getAttackType() === PBTypes.AttackVals.MELEE ||
            unit.getAttackType() === PBTypes.AttackVals.MAGIC ||
            unit.getAttackType() === PBTypes.AttackVals.MELEE_MAGIC) &&
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE
    ) {
        return true;
    }

    return false;
}

function calculateAuraCellKeys(gridSettings: GridSettings, cell: XY, auraRange: number): number[] {
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

/**
 * Returns a shared, immutable view for production aura traversal.
 *
 * Aura geometry depends only on the immutable GridSettings instance, an in-bounds integer source cell, and an
 * integer range. The fallback deliberately recalculates malformed/custom inputs so getAuraCellKeys keeps its
 * historical behavior for callers outside the fight engine.
 */
export function getAuraCellKeysView(gridSettings: GridSettings, cell: XY, auraRange: number): ReadonlyArray<number> {
    const gridSize = gridSettings.getGridSize();
    if (
        !Number.isSafeInteger(gridSize) ||
        gridSize <= 0 ||
        !Number.isSafeInteger(cell.x) ||
        !Number.isSafeInteger(cell.y) ||
        !Number.isSafeInteger(auraRange) ||
        cell.x < 0 ||
        cell.y < 0 ||
        cell.x >= gridSize ||
        cell.y >= gridSize ||
        auraRange < 0
    ) {
        return calculateAuraCellKeys(gridSettings, cell, auraRange);
    }

    const cellKey = cell.x * gridSize + cell.y;
    if (!Number.isSafeInteger(cellKey)) {
        return calculateAuraCellKeys(gridSettings, cell, auraRange);
    }

    let rangesPerCell = auraCellKeysPerGrid.get(gridSettings);
    if (!rangesPerCell) {
        rangesPerCell = new Map();
        auraCellKeysPerGrid.set(gridSettings, rangesPerCell);
    }

    let keysPerRange = rangesPerCell.get(cellKey);
    if (!keysPerRange) {
        keysPerRange = new Map();
        rangesPerCell.set(cellKey, keysPerRange);
    }

    const cached = keysPerRange.get(auraRange);
    if (cached) {
        return cached;
    }

    const calculated = Object.freeze(calculateAuraCellKeys(gridSettings, cell, auraRange));
    keysPerRange.set(auraRange, calculated);
    return calculated;
}

export function getAuraCellKeys(gridSettings: GridSettings, cell: XY, auraRange: number): number[] {
    return Array.from(getAuraCellKeysView(gridSettings, cell, auraRange));
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

/**
 * Who actually takes a penalty aimed at `forUnit` — the Absorb Penalties aura's owner when its roll lands,
 * otherwise nobody (the penalty stays where it was aimed).
 *
 * `sceneLog` is optional only so the pure-query callers stay pure; PASS IT wherever a debuff is really being
 * redirected. A silent absorb is indistinguishable from the aura not working: the debuff simply appears on a
 * different creature than the one that was hit, with nothing saying why. Flesh Shield and Water Shield both
 * announce themselves for exactly this reason.
 */
export const getAbsorptionTarget = (
    forUnit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    sceneLog?: { updateLog: (line?: string) => void },
): Unit | undefined => {
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
                        sceneLog?.updateLog(
                            `${auraSourceUnit.getName()} absorbs the penalty aimed at ${forUnit.getName()}`,
                        );
                        return auraSourceUnit;
                    }
                }
            }
        }
    }

    return undefined;
};
