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

import { isCellWithinGrid } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { Unit } from "../units/unit";
import type { IModifyableUnitProperties } from "../units/unit_properties";
import { getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";
import { AppliedSpell } from "./applied_spell";
import type { ICalculatedBuffsDebuffsEffect, Spell } from "./spell";
import { SpellPowerType, SpellTargetType } from "./spell_properties";

const verifyEmptyCell = (gridMatrix: number[][], emptyGridCell?: XY): boolean => {
    if (!emptyGridCell) {
        return false;
    }

    if (!(emptyGridCell.y in gridMatrix)) {
        return false;
    }

    if (!(emptyGridCell.x in gridMatrix[emptyGridCell.y])) {
        return false;
    }

    return !gridMatrix[emptyGridCell.y][emptyGridCell.x];
};

export function canMassCastSpell(
    spell: Spell,
    alliesBuffs: Map<string, AppliedSpell[]>,
    enemiesBuffs: Map<string, AppliedSpell[]>,
    enemiesDebuffs: Map<string, AppliedSpell[]>,
    alliesMagicResists: Map<string, number>,
    enemiesMagicResists: Map<string, number>,
    alliesHp: Map<string, number>,
    alliesMaxHp: Map<string, number>,
    alliesCanFly: Map<string, boolean>,
    enemiesCanFly: Map<string, boolean>,
): boolean {
    let canBeCasted = false;

    if (spell.getSpellTargetType() === SpellTargetType.ALL_FLYING) {
        const checkFlyingUnitsEffect = (
            unitsCanFly: Map<string, boolean>,
            unitsBuffs: Map<string, AppliedSpell[]>,
            magicResists: Map<string, number>,
            spell: Spell,
        ): boolean => {
            for (const [unitId, canFly] of unitsCanFly) {
                if (canFly && magicResists.get(unitId) !== 100) {
                    const buffs = unitsBuffs.get(unitId);

                    if (buffs?.length) {
                        let canBeCastedForUnit = true;

                        for (const b of buffs) {
                            if (spell.getConflictsWith().includes(b.getName()) || b.getName() === spell.getName()) {
                                canBeCastedForUnit = false;
                                break;
                            }
                        }

                        if (canBeCastedForUnit) {
                            return true;
                        }
                    } else {
                        return true;
                    }
                }
            }
            return false;
        };

        if (
            checkFlyingUnitsEffect(alliesCanFly, alliesBuffs, alliesMagicResists, spell) ||
            checkFlyingUnitsEffect(enemiesCanFly, enemiesBuffs, enemiesMagicResists, spell)
        ) {
            canBeCasted = true;
        }
    } else if (spell.getSpellTargetType() === SpellTargetType.ALL_ALLIES) {
        if (spell.getPowerType() === SpellPowerType.HEAL) {
            for (const [unitId, hp] of alliesHp) {
                const maxHp = alliesMaxHp.get(unitId);
                const magicResist = alliesMagicResists.get(unitId);
                if (maxHp !== undefined && hp < maxHp && magicResist !== 100) {
                    canBeCasted = true;
                    break;
                }
            }
        } else {
            for (const [unitId, magicResist] of alliesMagicResists) {
                const allyBuffs = alliesBuffs.get(unitId);

                if (allyBuffs?.length) {
                    let canBeCastedForAlly = true;

                    for (const buff of allyBuffs) {
                        if (
                            spell.getConflictsWith().includes(buff.getName()) ||
                            buff.getName() === spell.getName() ||
                            magicResist === 100
                        ) {
                            canBeCastedForAlly = false;
                            break;
                        }
                    }

                    if (canBeCastedForAlly) {
                        canBeCasted = true;
                        break;
                    }
                } else if (magicResist !== 100) {
                    canBeCasted = true;
                    break;
                }
            }
        }
    } else if (spell.getSpellTargetType() === SpellTargetType.ALL_ENEMIES) {
        for (const [unitId, magicResist] of enemiesMagicResists) {
            const enemyDebuffs = enemiesDebuffs.get(unitId);

            if (enemyDebuffs?.length) {
                let canBeCastedForEnemy = true;

                for (const debuff of enemyDebuffs) {
                    if (
                        spell.getConflictsWith().includes(debuff.getName()) ||
                        debuff.getName() === spell.getName() ||
                        magicResist === 100
                    ) {
                        canBeCastedForEnemy = false;
                        break;
                    }
                }

                if (canBeCastedForEnemy) {
                    canBeCasted = true;
                    break;
                }
            } else if (magicResist !== 100) {
                canBeCasted = true;
                break;
            }
        }
    }

    return canBeCasted;
}

export function canCastSummon(spell: Spell, gridMatrix: number[][], emptyGridCell?: XY): boolean {
    if (spell.isSummon() && spell.getSpellTargetType() === SpellTargetType.RANDOM_CLOSE_TO_CASTER) {
        return verifyEmptyCell(gridMatrix, emptyGridCell);
    }

    return false;
}

export const spellToTextureNames = (spellName: string): [string, string] => {
    const baseName = spellName.toLowerCase().replace(/ /g, "_");
    return [`${baseName}_256`, `${baseName}_font`];
};

export function canCastSpell(
    isLocked: boolean,
    gridSettings: GridSettings,
    gridMatrix: number[][],
    casterUnit: Unit,
    targetUnit?: Unit,
    spell?: Spell,
    targetCell?: XY,
    toUnitMagicResistance?: number,
    toUnitHasMindResistance?: boolean,
    toUnitCanBeHealded?: boolean,
    currentEnemiesCellsWithinMovementRange?: XY[],
    targetGridCell?: XY,
) {
    if (
        isLocked ||
        !spell ||
        spell.getLapsTotal() <= 0 ||
        !spell.isRemaining() ||
        spell.getMinimalCasterStackPower() > casterUnit.getStackPower()
    ) {
        return false;
    }

    let spellFound = false;
    for (const s of casterUnit.getSpells()) {
        if (s.getName() === spell.getName() && s.isRemaining()) {
            spellFound = true;
            break;
        }
    }
    if (!spellFound) {
        return false;
    }

    const isSelfCast =
        (targetUnit && casterUnit.getId() === targetUnit.getId()) ||
        (targetUnit && casterUnit.getName() === targetUnit.getName() && casterUnit.getTeam() === targetUnit.getTeam());

    if (spell.getPowerType() === SpellPowerType.RESURRECT) {
        return (
            targetUnit &&
            targetUnit.getTeam() === casterUnit.getTeam() &&
            targetUnit.getAmountDied() > 0 &&
            (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
        );
    }

    if (spell.getPowerType() === SpellPowerType.HEAL) {
        if (spell.isGiftable()) {
            return (
                targetUnit &&
                !targetUnit.hasAbilityActive(spell.getName()) &&
                casterUnit.getTeam() === targetUnit.getTeam() &&
                targetUnit.getLevel() <= spell.getMaximumGiftLevel() &&
                (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
            );
        } else {
            return (
                toUnitCanBeHealded &&
                targetUnit &&
                targetUnit.getHp() < targetUnit.getMaxHp() &&
                toUnitMagicResistance !== 100 &&
                casterUnit.getTeam() === targetUnit.getTeam() &&
                (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
            );
        }
    }

    const oneOfTheEnemiesHasTargetCell = (): boolean => {
        if (!currentEnemiesCellsWithinMovementRange?.length) {
            return false;
        }

        for (const c of currentEnemiesCellsWithinMovementRange) {
            if (c.x === targetCell?.x && c.y === targetCell?.y) {
                return true;
            }
        }

        return false;
    };

    const notAlreadyApplied = (): boolean => {
        const willConclictWith = spell.getConflictsWith();
        if (!targetUnit) {
            return false;
        }

        if (spell.isBuff()) {
            const existingBuff = targetUnit.getBuff(spell.getName());

            if (existingBuff && existingBuff.getLaps() > 0) {
                return false;
            }
            for (const b of targetUnit.getBuffs()) {
                if ((b.getName() === spell.getName() || willConclictWith.includes(b.getName())) && b.getLaps()) {
                    return false;
                }
            }
        } else {
            const existingDebuff = targetUnit.getDebuff(spell.getName());
            if (existingDebuff && existingDebuff.getLaps() > 0) {
                return false;
            }
            for (const d of targetUnit.getDebuffs()) {
                if ((d.getName() === spell.getName() || willConclictWith.includes(d.getName())) && d.getLaps()) {
                    return false;
                }
            }
        }

        return true;
    };

    if (spell.getSpellTargetType() === SpellTargetType.ANY_ALLY) {
        if (toUnitMagicResistance && toUnitMagicResistance === 100) {
            return false;
        }

        if (
            targetUnit &&
            casterUnit.getTeam() === targetUnit.getTeam() &&
            (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
        ) {
            return notAlreadyApplied();
        }
    }

    if (
        spell.getSpellTargetType() === SpellTargetType.ANY_ENEMY ||
        (spell.getSpellTargetType() === SpellTargetType.ENEMY_WITHIN_MOVEMENT_RANGE &&
            targetUnit &&
            targetUnit.getSize() === 1 &&
            oneOfTheEnemiesHasTargetCell())
    ) {
        const forcedUnitId = casterUnit.getTarget();
        if (
            (toUnitMagicResistance && toUnitMagicResistance === 100) ||
            (spell.getPowerType() === SpellPowerType.MIND && toUnitHasMindResistance) ||
            !targetUnit ||
            (targetUnit && forcedUnitId && forcedUnitId !== targetUnit.getId())
        ) {
            return false;
        }

        if (casterUnit.getTeam() !== targetUnit.getTeam() && !isSelfCast) {
            return notAlreadyApplied();
        }
    }

    if (
        !targetUnit &&
        spell.getSpellTargetType() === SpellTargetType.FREE_CELL &&
        targetGridCell &&
        isCellWithinGrid(gridSettings, targetGridCell)
    ) {
        return !verifyEmptyCell(gridMatrix, targetCell);
    }

    return false;
}

export function calculateBuffsDebuffsEffect(
    buffs: AppliedSpell[],
    debuffs: AppliedSpell[],
): ICalculatedBuffsDebuffsEffect {
    const baseStats: IModifyableUnitProperties = {
        hp: 0,
        armor: 0,
        luck: 0,
        morale: 0,
    };
    const additionalStats: IModifyableUnitProperties = {
        hp: 0,
        armor: 0,
        luck: 0,
        morale: 0,
    };

    const alreadyAppliedBuffs: string[] = [];
    for (const b of buffs) {
        if (b.getLaps() <= 0) {
            continue;
        }

        if (alreadyAppliedBuffs.includes(b.getName())) {
            continue;
        }
        if (b.getName() === "Helping Hand") {
            const maxHp = b.getFirstSpellProperty();
            if (maxHp === undefined) {
                continue;
            }

            const baseArmor = b.getSecondSpellProperty();
            if (baseArmor === undefined) {
                continue;
            }

            baseStats.hp = Math.ceil(maxHp * 0.3);
            baseStats.armor = Math.ceil(baseArmor * 0.3);
            alreadyAppliedBuffs.push(b.getName());
        }
        if (b.getName() === "Luck Aura") {
            baseStats.luck = Number.MAX_SAFE_INTEGER;
        }
    }

    const alreadyAppliedDebuffs: string[] = [];
    for (const db of debuffs) {
        if (db.getLaps() <= 0) {
            continue;
        }

        if (alreadyAppliedDebuffs.includes(db.getName())) {
            continue;
        }
        if (db.getName() === "Helping Hand") {
            const maxHp = db.getFirstSpellProperty();
            if (maxHp === undefined) {
                continue;
            }

            const baseArmor = db.getSecondSpellProperty();
            if (baseArmor === undefined) {
                continue;
            }

            baseStats.hp = -Math.ceil(maxHp * 0.3);
            baseStats.armor = -Math.ceil(baseArmor * 0.3);
            alreadyAppliedDebuffs.push(db.getName());
        }
    }

    return {
        baseStats,
        additionalStats,
    };
}

export const getMagicMirrorPower = (targetUnit: Unit): number => {
    let mirrorPower = 0;
    const magicMirrorBuff = targetUnit.getBuff("Magic Mirror");
    const massMagicMirrorBuff = targetUnit.getBuff("Mass Magic Mirror");
    if (magicMirrorBuff) {
        mirrorPower = magicMirrorBuff.getPower();
    }
    if (massMagicMirrorBuff) {
        mirrorPower = Math.max(mirrorPower, massMagicMirrorBuff.getPower());
    }
    if (mirrorPower > 100) {
        mirrorPower = 100;
    }
    if (mirrorPower < 0) {
        mirrorPower = 0;
    }
    mirrorPower = Math.floor(mirrorPower);

    return mirrorPower;
};

export const isMirrored = (targetUnit: Unit): boolean => {
    return getRandomInt(0, 100) < Math.floor(getMagicMirrorPower(targetUnit));
};

export const hasAlreadyAppliedSpell = (targetUnit: Unit, spell: Spell): boolean => {
    const conflictingSpells = [...spell.getConflictsWith(), spell.getName()];
    let alreadyApplied = false;
    for (const cs of conflictingSpells) {
        if ((spell.isBuff() && targetUnit.hasBuffActive(cs)) || (!spell.isBuff() && targetUnit.hasDebuffActive(cs))) {
            alreadyApplied = true;
            break;
        }
    }

    return alreadyApplied;
};
