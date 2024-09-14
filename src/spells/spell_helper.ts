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
import { IModifyableUnitProperties, TeamType } from "../units/unit_properties";
import { XY } from "../utils/math";
import { AppliedSpell } from "./applied_spell";
import { ICalculatedBuffsDebuffsEffect, Spell } from "./spell";
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
    enemiesDebuffs: Map<string, AppliedSpell[]>,
    alliesMagicResists: Map<string, number>,
    enemiesMagicResists: Map<string, number>,
    alliesHp: Map<string, number>,
    alliesMaxHp: Map<string, number>,
): boolean {
    let canBeCasted = false;

    if (spell.getSpellTargetType() === SpellTargetType.ALL_ALLIES) {
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
                    let canBeCastedForAlly = false;

                    for (const buff of allyBuffs) {
                        if (
                            !spell.getConflictsWith().includes(buff.getName()) &&
                            buff.getName() !== spell.getName() &&
                            magicResist !== 100
                        ) {
                            canBeCastedForAlly = true;
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
                let canBeCastedForEnemy = false;

                for (const debuff of enemyDebuffs) {
                    if (
                        !spell.getConflictsWith().includes(debuff.getName()) &&
                        debuff.getName() !== spell.getName() &&
                        magicResist !== 100
                    ) {
                        canBeCastedForEnemy = true;
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
    alreadyAppliedBuffAndDebuffs?: AppliedSpell[],
    spell?: Spell,
    unitSpells?: Spell[],
    targetUnitSpells?: Spell[],
    emptyGridCell?: XY,
    fromUnitId?: string,
    toUnitId?: string,
    fromTeamType?: TeamType,
    toTeamType?: TeamType,
    fromUnitName?: string,
    toUnitName?: string,
    toUnitLevel?: number,
    toUnitHp?: number,
    toUnitMaxHp?: number,
    fromUnitStackPower?: number,
    toUnitMagicResistance?: number,
    toUnitHasMindResistance?: boolean,
    toUnitCanBeHealded?: boolean,
    targetGridCell?: XY,
) {
    if (
        isLocked ||
        !fromUnitStackPower ||
        !spell ||
        spell.getLapsTotal() <= 0 ||
        !spell.isRemaining() ||
        !unitSpells?.length ||
        spell.getMinimalCasterStackPower() > fromUnitStackPower
    ) {
        return false;
    }

    let spellFound = false;
    for (const s of unitSpells) {
        if (s.getName() === spell.getName() && s.isRemaining()) {
            spellFound = true;
            break;
        }
    }
    if (!spellFound) {
        return false;
    }

    const isSelfCast =
        (fromUnitId && toUnitId && fromUnitId === toUnitId) ||
        (fromUnitName && toUnitName && fromUnitName === toUnitName && fromTeamType === toTeamType);

    if (spell.getPowerType() === SpellPowerType.HEAL) {
        if (spell.isGiftable()) {
            let alreadyHasSpell = false;
            if (targetUnitSpells) {
                for (const targetUnitSpell of targetUnitSpells) {
                    if (targetUnitSpell.getName() === spell.getName()) {
                        alreadyHasSpell = true;
                        break;
                    }
                }
            }

            return (
                !alreadyHasSpell &&
                fromTeamType &&
                toTeamType &&
                fromTeamType === toTeamType &&
                toUnitLevel &&
                toUnitLevel <= spell.getMaximumGiftLevel() &&
                (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
            );
        } else {
            return (
                toUnitCanBeHealded &&
                toUnitHp &&
                toUnitMaxHp &&
                toUnitHp < toUnitMaxHp &&
                toUnitMagicResistance !== 100 &&
                (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
            );
        }
    }

    const notAlreadyApplied = (): boolean => {
        const willConclictWith = spell.getConflictsWith();
        if (alreadyAppliedBuffAndDebuffs?.length) {
            for (const existingBuff of alreadyAppliedBuffAndDebuffs) {
                if (
                    (existingBuff.getName() === spell.getName() || willConclictWith.includes(existingBuff.getName())) &&
                    existingBuff.getLaps()
                ) {
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
            fromTeamType &&
            toTeamType &&
            fromTeamType === toTeamType &&
            (spell.isSelfCastAllowed() || (!spell.isSelfCastAllowed() && !isSelfCast))
        ) {
            return notAlreadyApplied();
        }
    }

    if (spell.getSpellTargetType() === SpellTargetType.ANY_ENEMY) {
        if (
            (toUnitMagicResistance && toUnitMagicResistance === 100) ||
            (spell.getPowerType() === SpellPowerType.MIND && toUnitHasMindResistance)
        ) {
            return false;
        }

        if (fromTeamType && toTeamType && fromTeamType !== toTeamType && !isSelfCast) {
            return notAlreadyApplied();
        }
    }

    if (
        !toUnitId &&
        !toUnitName &&
        spell.getSpellTargetType() === SpellTargetType.FREE_CELL &&
        isCellWithinGrid(gridSettings, targetGridCell)
    ) {
        return !verifyEmptyCell(gridMatrix, emptyGridCell);
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
