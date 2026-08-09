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
import { MAGIC_REFLECTION_ABILITY_NAME, magicReflectionPercent } from "../abilities/magic_reflection_ability";
import { Unit } from "../units/unit";
import type { IModifyableUnitProperties } from "../units/unit_properties";
import { getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";
import { AppliedSpell } from "./applied_spell";
import type { ICalculatedBuffsDebuffsEffect, Spell } from "./spell";
import { elementalSpellMultiplier, isThrownOffensiveSpell } from "./spell_damage";
import { SpellPowerType, SpellTargetType } from "./spell_properties";
import { vinePathCells } from "./vines";

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

/** Minimal grid surface the line-of-sight walk needs, mirroring ISmokeGrid for the same reason. */
export interface ISpellSightGrid {
    getOccupantUnitId(cell: XY): string | undefined;
}

/**
 * Is the straight line from `from` to `to` clear enough for a THROWN spell to reach its target?
 *
 * The rule an archer's shot obeys: everything strictly BETWEEN the two cells must be clear. The target stands
 * on the last cell of the walk, and the caster's own cell is excluded by the walk itself. Lava ("L") and water
 * ("W") are open ground a projectile flies over; a body or the centre mountain is not. Distance is deliberately
 * NOT considered — a spell has no shot range, so what the caster can SEE is the whole limit.
 *
 * `vinePathCells` supplies the walk: it is the same supercover line the range-attack blocker check uses, so a
 * thrown spell crosses exactly the cells the player watched the aim line pass over.
 *
 * Shared by the engine's Fire Strike cast, the AI's candidate enumeration and the client's aim preview for the
 * same reason isSmokeableCell is shared: three copies of a targeting rule is three chances to promise a cast
 * the engine then refuses.
 */
export function isSpellLineOfSightClear(
    grid: ISpellSightGrid,
    isWithinGrid: (cell: XY) => boolean,
    from: XY,
    to: XY,
): boolean {
    return firstSpellSightBlocker(grid, isWithinGrid, from, to) === undefined;
}

/** What refused a thrown spell: the first intercepting cell and who stands on it ("B"/"H" = terrain). */
export interface ISpellSightBlocker {
    cell: XY;
    occupantId: string;
}

/**
 * The first cell that intercepts the throw, or undefined when the line is clear — the same walk
 * isSpellLineOfSightClear answers with a boolean, kept as one loop so the yes/no gate and the
 * "blocked by X" feedback can never disagree about which body stopped the spell.
 */
export function firstSpellSightBlocker(
    grid: ISpellSightGrid,
    isWithinGrid: (cell: XY) => boolean,
    from: XY,
    to: XY,
    // Vine Throw alone is thrown in an ARC (owner 2026-08-08): only a creature standing in the way can
    // intercept it, so terrain — the centre mountain, a narrowed hole, off-board cells — no longer refuses
    // the cast. Every other thrown spell keeps the archer's rule where terrain blocks too. The vine simply
    // does not take root on a cell that cannot hold it (see canVineTakeRoot).
    blockedBy: "creatures" | "creatures-and-terrain" = "creatures-and-terrain",
): ISpellSightBlocker | undefined {
    const pathCells = vinePathCells(from, to);
    if (!pathCells.length) {
        return { cell: from, occupantId: "B" };
    }
    // NEITHER endpoint's own body is an obstacle. A 2x2 creature stands on four cells but is addressed by
    // one base cell, so the straight line to that base cell routinely crosses the creature's other three —
    // and, aimed from the far side, the caster's own. Read literally, "everything between must be clear"
    // made a large target unhittable from one half of the board and a large caster unable to shoot into
    // it, which is not line of sight failing: the shot starts inside the caster and ends inside the
    // target, so only a THIRD body (or the mountain) can intercept it.
    //
    // The two ids come off the endpoint cells rather than from parameters so every calling surface — the
    // engine's cast, the AI's enumeration, the client's aim preview — gets this without having to
    // remember to pass them. An empty endpoint (a cell-targeted spell) yields undefined and changes
    // nothing.
    const casterUnitId = grid.getOccupantUnitId(from);
    const targetUnitId = grid.getOccupantUnitId(to);
    const creaturesOnly = blockedBy === "creatures";
    for (const cell of pathCells.slice(0, -1)) {
        if (!isWithinGrid(cell)) {
            if (creaturesOnly) {
                continue;
            }
            return { cell, occupantId: "B" };
        }
        const occupant = grid.getOccupantUnitId(cell);
        if (!occupant || occupant === "L" || occupant === "W") {
            continue;
        }
        // "B" (mountain) and "H" (narrowed hole) are TERRAIN markers, not creatures.
        if (creaturesOnly && (occupant === "B" || occupant === "H")) {
            continue;
        }
        if (occupant !== casterUnitId && occupant !== targetUnitId) {
            return { cell, occupantId: occupant };
        }
    }
    return undefined;
}

/**
 * Whether a unit-targeted spell travels across the board instead of being called down on its recipient.
 *
 * Keep this classification beside the shared line walk: candidate generation, native/fallback AI, manual
 * targeting and the authoritative engine must all agree that Vine Throw, Fire Strike and Ring of Fire can be
 * intercepted by terrain or a creature. Non-thrown targeted spells deliberately return false.
 */
export function targetedSpellRequiresLineOfSight(spellName: string): boolean {
    return spellName === "Vine Throw" || isThrownOffensiveSpell(spellName);
}

/**
 * Shared target-specific reachability gate. Returning true for non-thrown spells lets callers apply this after
 * the generic canCastSpell check without growing another spell-name branch at every decision surface.
 */
export function isTargetedSpellLineOfSightClear(
    spellName: string,
    grid: ISpellSightGrid,
    isWithinGrid: (cell: XY) => boolean,
    from: XY,
    to: XY,
): boolean {
    if (!targetedSpellRequiresLineOfSight(spellName)) {
        return true;
    }
    return firstTargetedSpellSightBlocker(spellName, grid, isWithinGrid, from, to) === undefined;
}

/**
 * The blocker for a specific spell, applying that spell's own interception rule — creature-only for the
 * arcing Vine Throw, terrain-inclusive for every other thrown spell. One place decides, so the engine's
 * cast, the AI's enumeration and the client's aim preview can never disagree about what stops a throw.
 */
export function firstTargetedSpellSightBlocker(
    spellName: string,
    grid: ISpellSightGrid,
    isWithinGrid: (cell: XY) => boolean,
    from: XY,
    to: XY,
): ISpellSightBlocker | undefined {
    if (!targetedSpellRequiresLineOfSight(spellName)) {
        return undefined;
    }
    return firstSpellSightBlocker(
        grid,
        isWithinGrid,
        from,
        to,
        spellName === "Vine Throw" ? "creatures" : "creatures-and-terrain",
    );
}

export function canCastSummon(spell: Spell, gridMatrix: number[][], emptyGridCell?: XY): boolean {
    if (spell.isSummon() && spell.getSpellTargetType() === SpellTargetType.RANDOM_CLOSE_TO_CASTER) {
        return verifyEmptyCell(gridMatrix, emptyGridCell);
    }

    return false;
}

/**
 * The spell's ICON texture key. Spell names are rendered as text now, so there is no longer a companion
 * "<spell>_font" title strip: those had to be hand-authored per spell, and a missing one silently dropped
 * the spell from the whole spellbook (RenderableUnit could not build the card without it) — which is how
 * Ash Moth shipped with an empty book. One icon is all a new spell needs.
 */
export const spellToTextureName = (spellName: string): string => `${spellName.toLowerCase().replace(/ /g, "_")}_256`;

/** Shared charge/stack gate used by the engine and AI before target-specific spell legality. */
export function isSpellUsableByCaster(casterUnit: Unit, spell: Spell): boolean {
    return (
        spell.getLapsTotal() > 0 &&
        spell.isRemaining() &&
        spell.getMinimalCasterStackPower() <= casterUnit.getStackPower()
    );
}

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
    if (isLocked || !spell || !isSpellUsableByCaster(casterUnit, spell)) {
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

    /**
     * An element cannot be aimed at the creature that IS it: no Whirlpool on a Water Element, no Lightning
     * Strike on a Wind Element, no Ring of Fire on a Fire Element. This mirrors the MIND-resistance gate one
     * block below — the target simply is not a legal one, so the UI greys it out instead of letting a player
     * spend a charge on a spell that would land for nothing. Damage that merely SPLASHES onto such a creature
     * is a separate question, answered where the damage is dealt.
     */
    const targetIsImmuneToSpellElement = (): boolean =>
        !!targetUnit &&
        elementalSpellMultiplier({
            element: spell.getElement(),
            targetIsFireElement: targetUnit.hasAbilityActive("Fire Element"),
            targetIsWaterElement: targetUnit.hasAbilityActive("Water Element"),
            targetIsWindElement: targetUnit.hasAbilityActive("Wind Element"),
        }) <= 0;

    const notAlreadyApplied = (): boolean => {
        const willConclictWith = spell.getConflictsWith();
        if (!targetUnit) {
            return false;
        }

        if (spell.isBuff()) {
            // Blacksmith's runes (Armor Rune / Weapon Rune) STACK: re-casting on a unit that already carries the
            // rune adds +1, so they must stay targetable (green) instead of being rejected as "already applied".
            // A declared conflict with a DIFFERENT buff still blocks.
            const stacks = spell.getName() === "Armor Rune" || spell.getName() === "Weapon Rune";
            const existingBuff = targetUnit.getBuff(spell.getName());

            if (!stacks && existingBuff && existingBuff.getLaps() > 0) {
                return false;
            }
            for (const b of targetUnit.getBuffs()) {
                const blocksBySameName = !stacks && b.getName() === spell.getName();
                if ((blocksBySameName || willConclictWith.includes(b.getName())) && b.getLaps()) {
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
            casterUnit.isSmallSize() &&
            targetUnit &&
            targetUnit.isSmallSize() &&
            oneOfTheEnemiesHasTargetCell())
    ) {
        const forcedUnitId = casterUnit.getTarget();
        if (
            (toUnitMagicResistance && toUnitMagicResistance === 100) ||
            (spell.getPowerType() === SpellPowerType.MIND && toUnitHasMindResistance) ||
            targetIsImmuneToSpellElement() ||
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

            // Older snapshots stored Helping Hand with power 0 because its 30% lived only in this helper.
            // New casts carry the real (and possibly Tome-amplified) power on AppliedSpell.
            const powerMultiplier = (b.getPower() || 30) / 100;
            baseStats.hp = Math.ceil(maxHp * powerMultiplier);
            baseStats.armor = Math.ceil(baseArmor * powerMultiplier);
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

            const powerMultiplier = (db.getPower() || 30) / 100;
            baseStats.hp = -Math.ceil(maxHp * powerMultiplier);
            baseStats.armor = -Math.ceil(baseArmor * powerMultiplier);
            alreadyAppliedDebuffs.push(db.getName());
        }
    }

    return {
        baseStats,
        additionalStats,
    };
}

/**
 * The reflected share, as a percentage: the buff's own power PLUS the holder's luck, clamped to 0..100.
 * Luck moves it the same way it moves every other percentage in the game, so a lucky unit mirrors more —
 * and the spell card shows this exact figure rather than the flat configured number (see
 * magicMirrorDescriptionPercent, which the client uses to fill the {} placeholders).
 */
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
    // FLAT and stable: the Ogre Mage's Magic Mirror / Mass Magic Mirror reflect exactly their configured
    // percentage (30 / 25) — NOT stack-scaled and NOT moved by luck (unlike the Magic Dragon's ability). The
    // buff's own power is the whole answer; an unbuffed unit still reflects nothing (mirrorPower stays 0).
    if (mirrorPower > 100) {
        mirrorPower = 100;
    }
    if (mirrorPower < 0) {
        mirrorPower = 0;
    }
    mirrorPower = Math.floor(mirrorPower);

    return mirrorPower;
};

/**
 * The Magic Dragon's passive "Magic Mirror" ability, as a CHANCE in 0..100 (0 when the unit has no such
 * ability, or while it is Broken).
 *
 * The ability's base power plus the holder's own LUCK, the same way the poison auras combine theirs — a
 * lucky dragon rebounds more often, an unlucky one less. Clamped to 0..100 at the end, so the sum can never
 * push the chance past certain or below impossible.
 *
 * Deliberately separate from getMagicMirrorPower: the BUFF and passive ability have independent configured
 * values. For the passive, this same advertised percentage is both the proc chance and the share of landed
 * damage returned by getMagicMirrorAbilityShare.
 */
export const getMagicMirrorAbilityChance = (targetUnit: Unit): number => {
    if (!targetUnit.hasAbilityActive("Magic Reflection")) {
        return 0;
    }

    // Stack-powered like the Magic Mirror spell: 15/30/45/60/75 across the stack at power 75, then shifted
    // by the holder's luck. Shared with the client's cards through magicReflectionPercent so the advertised
    // chance and the rolled chance are the same number.
    return magicReflectionPercent(
        targetUnit.getAbilityPower(MAGIC_REFLECTION_ABILITY_NAME),
        targetUnit.getStackPower(),
        targetUnit.getLuck(),
    );
};

/**
 * The SHARE of a rebounded spell's damage the passive ability sends back, as a percentage.
 *
 * A mirror returns what it reflects, not more: the caster takes this share of the damage the spell actually
 * landed, never the whole hit. It is the same figure the ability card advertises (base power moved by the
 * holder's luck), so the number the player reads is the number that comes back — a mirror that says 75 and
 * returns 100 is the kind of surprise that makes a stat sheet worthless.
 *
 * Effects are a separate question and stay all-or-nothing (see isMirrored): half a Stun is not a thing.
 */
export const getMagicMirrorAbilityShare = (targetUnit: Unit): number => getMagicMirrorAbilityChance(targetUnit);

/**
 * Whether an incoming spell rebounds off `targetUnit` — its effects whole, its damage cut to the mirror's own
 * share (getMagicMirrorAbilityShare) — landing on the caster IN ADDITION to landing on the holder, which is
 * hit in full either way. Only the passive ability rebounds a spell; the Magic Mirror buff keeps its own
 * partial behaviour.
 */
export const reboundsSpell = (targetUnit: Unit): boolean => {
    const chance = getMagicMirrorAbilityChance(targetUnit);

    return chance > 0 && getRandomInt(0, 100) < chance;
};

export const isMirrored = (targetUnit: Unit): boolean => {
    // Either source can send a debuff back: the buff at its own power, the passive ability at its chance.
    const chance = Math.max(getMagicMirrorPower(targetUnit), getMagicMirrorAbilityChance(targetUnit));

    return getRandomInt(0, 100) < Math.floor(chance);
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
