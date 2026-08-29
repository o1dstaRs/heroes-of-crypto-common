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

import { describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { AppliedSpell } from "../../src/spells/applied_spell";
import { Spell } from "../../src/spells/spell";
import {
    calculateBuffsDebuffsEffect,
    canCastSpell,
    canCastSummon,
    canMassCastSpell,
    getMagicMirrorPower,
    hasAlreadyAppliedSpell,
    isMirrored,
    isTargetedSpellLineOfSightClear,
    spellToTextureName,
    targetedSpellRequiresLineOfSight,
} from "../../src/spells/spell_helper";
import {
    SpellElement,
    SpellMultiplierType,
    SpellPowerType,
    SpellProperties,
    SpellTargetType,
} from "../../src/spells/spell_properties";
import { createTestUnit, testGridSettings } from "../helpers/combat";

describe("spell_helper", () => {
    it("classifies and blocks every thrown targeted spell while leaving called-down spells unrestricted", () => {
        const blockedGrid = {
            getOccupantUnitId: (cell: { x: number; y: number }): string | undefined =>
                cell.x === 4 && cell.y === 2 ? "blocker" : undefined,
        };
        const withinGrid = (cell: { x: number; y: number }): boolean =>
            cell.x >= 0 &&
            cell.y >= 0 &&
            cell.x < testGridSettings.getGridSize() &&
            cell.y < testGridSettings.getGridSize();
        const from = { x: 2, y: 2 };
        const to = { x: 8, y: 2 };

        expect(targetedSpellRequiresLineOfSight("Vine Throw")).toBe(true);
        expect(targetedSpellRequiresLineOfSight("Fire Strike")).toBe(true);
        expect(targetedSpellRequiresLineOfSight("Ring of Fire")).toBe(true);
        expect(targetedSpellRequiresLineOfSight("Lightning Strike")).toBe(false);
        expect(isTargetedSpellLineOfSightClear("Vine Throw", blockedGrid, withinGrid, from, to)).toBe(false);
        expect(isTargetedSpellLineOfSightClear("Ring of Fire", blockedGrid, withinGrid, from, to)).toBe(false);
        // Fire Strike is the one thrown spell a creature no longer refuses (owner 2026-08-09): the engine
        // intercepts it onto that body instead. Terrain is still a hard no.
        expect(isTargetedSpellLineOfSightClear("Fire Strike", blockedGrid, withinGrid, from, to)).toBe(true);
        const rockGrid = {
            getOccupantUnitId: (cell: { x: number; y: number }): string | undefined =>
                cell.x === 4 && cell.y === 2 ? "B" : undefined,
        };
        expect(isTargetedSpellLineOfSightClear("Fire Strike", rockGrid, withinGrid, from, to)).toBe(false);
        expect(isTargetedSpellLineOfSightClear("Lightning Strike", blockedGrid, withinGrid, from, to)).toBe(true);
        expect(
            isTargetedSpellLineOfSightClear("Vine Throw", { getOccupantUnitId: () => undefined }, withinGrid, from, to),
        ).toBe(true);
    });

    it("evaluates mass flying, ally, heal, and enemy spell targets", () => {
        const windFlow = spell("System", "Wind Flow");
        const massHeal = spell("Life", "Mass Heal");
        const battleRoar = spell("System", "Battle Roar");
        const allEnemiesWeakness = customSpell("Weakness", SpellTargetType.ALL_ENEMIES, false);

        expect(
            canMassCastSpell(
                windFlow,
                new Map([["ally", []]]),
                new Map(),
                new Map(),
                new Map([["ally", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map([["ally", true]]),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                windFlow,
                new Map([["ally", [new AppliedSpell("Wind Flow", 0, 1)]]]),
                new Map(),
                new Map(),
                new Map([["ally", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map([["ally", true]]),
                new Map(),
            ),
        ).toBe(false);
        expect(
            canMassCastSpell(
                massHeal,
                new Map(),
                new Map(),
                new Map(),
                new Map([["ally", 0]]),
                new Map(),
                new Map([["ally", 5]]),
                new Map([["ally", 10]]),
                new Map(),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                battleRoar,
                new Map([["ally", []]]),
                new Map(),
                new Map(),
                new Map([["ally", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                allEnemiesWeakness,
                new Map(),
                new Map(),
                new Map([["enemy", []]]),
                new Map(),
                new Map([["enemy", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                allEnemiesWeakness,
                new Map(),
                new Map(),
                new Map([["enemy", [new AppliedSpell("Weakness", 0, 1)]]]),
                new Map(),
                new Map([["enemy", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ),
        ).toBe(false);
    });

    it("allows mass spells when at least one matching unit has only non-conflicting active spells", () => {
        const flyingBuff = customSpell("Wing Guard", SpellTargetType.ALL_FLYING, true, {
            conflictsWith: ["Grounded"],
        });
        const allyBuff = customSpell("Battle Focus", SpellTargetType.ALL_ALLIES, true, {
            conflictsWith: ["Fatigue"],
        });
        const enemyDebuff = customSpell("Fear", SpellTargetType.ALL_ENEMIES, false, {
            conflictsWith: ["Courage"],
        });

        expect(
            canMassCastSpell(
                flyingBuff,
                new Map([
                    ["blocked", [new AppliedSpell("Grounded", 0, 1)]],
                    ["eligible", [new AppliedSpell("Other", 0, 1)]],
                ]),
                new Map(),
                new Map(),
                new Map([
                    ["blocked", 0],
                    ["eligible", 0],
                ]),
                new Map(),
                new Map(),
                new Map(),
                new Map([
                    ["blocked", true],
                    ["eligible", true],
                ]),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                allyBuff,
                new Map([["ally", [new AppliedSpell("Other", 0, 1)]]]),
                new Map(),
                new Map(),
                new Map([["ally", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ),
        ).toBe(true);
        expect(
            canMassCastSpell(
                enemyDebuff,
                new Map(),
                new Map(),
                new Map([["enemy", [new AppliedSpell("Other", 0, 1)]]]),
                new Map(),
                new Map([["enemy", 0]]),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ),
        ).toBe(true);
    });

    it("validates summons and texture names", () => {
        const summon = spell("Nature", "Summon Wolves");
        const matrix = emptyMatrix();

        expect(canCastSummon(summon, matrix, { x: 2, y: 2 })).toBe(true);
        matrix[2][2] = 1;
        expect(canCastSummon(summon, matrix, { x: 2, y: 2 })).toBe(false);
        expect(canCastSummon(summon, matrix)).toBe(false);
        expect(canCastSummon(spell("Life", "Heal"), matrix, { x: 1, y: 1 })).toBe(false);
        expect(spellToTextureName("Magic Mirror")).toBe("magic_mirror_256");
        expect(spellToTextureName("Empower")).toBe("empower_256");
    });

    it("loads the Chaos:Misfortune luck-floor debuff config", () => {
        const misfortune = spell("Chaos", "Misfortune");
        expect(misfortune.getName()).toBe("Misfortune");
        expect(misfortune.getSpellTargetType()).toBe(SpellTargetType.ANY_ENEMY);
        expect(misfortune.isBuff()).toBe(false);
        expect(misfortune.getMinimalCasterStackPower()).toBe(1);
        // Texture names follow the standard icon/title-strip convention.
        expect(spellToTextureName("Misfortune")).toBe("misfortune_256");
    });

    it("validates direct spell casts across main target types", () => {
        const caster = createTestUnit({
            name: "Caster",
            team: PBTypes.TeamVals.RIGHT,
            spells: ["Life:Heal", "System:Resurrection", "Death:Weakness", "System:Castling"],
            stackPower: 4,
        });
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.RIGHT, amountAlive: 2 });
        const resurrectAlly = createTestUnit({ name: "Resurrect Ally", team: PBTypes.TeamVals.RIGHT, amountAlive: 2 });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.LEFT });
        const otherEnemy = createTestUnit({ name: "Other Enemy", team: PBTypes.TeamVals.LEFT });

        ally.applyDamage(5, 0, new SceneLogMock());
        resurrectAlly.applyDamage(10, 0, new SceneLogMock());

        expect(canCastSpell(true, testGridSettings, emptyMatrix(), caster, ally, caster.getSpells()[0])).toBe(false);
        expect(canCastSpell(false, testGridSettings, emptyMatrix(), caster, ally)).toBe(false);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                caster.getSpells().find((candidate) => candidate.getName() === "Heal"),
                ally.getBaseCell(),
                ally.getMagicResist(),
                false,
                ally.canBeHealed(),
            ),
        ).toBe(true);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                resurrectAlly,
                caster.getSpells().find((candidate) => candidate.getName() === "Resurrection"),
                resurrectAlly.getBaseCell(),
                resurrectAlly.getMagicResist(),
                false,
                resurrectAlly.canBeHealed(),
            ),
        ).toBe(true);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                enemy,
                caster.getSpells().find((candidate) => candidate.getName() === "Weakness"),
                enemy.getBaseCell(),
                100,
                false,
                enemy.canBeHealed(),
            ),
        ).toBe(false);

        caster.setTarget(otherEnemy.getId());

        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                enemy,
                caster.getSpells().find((candidate) => candidate.getName() === "Weakness"),
                enemy.getBaseCell(),
                enemy.getMagicResist(),
                false,
                enemy.canBeHealed(),
            ),
        ).toBe(false);

        caster.setTarget("");

        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                enemy,
                caster.getSpells().find((candidate) => candidate.getName() === "Castling"),
                enemy.getBaseCell(),
                enemy.getMagicResist(),
                false,
                enemy.canBeHealed(),
                [enemy.getBaseCell()],
            ),
        ).toBe(true);

        const freeCellSpell = customSpell("Heal", SpellTargetType.FREE_CELL, true);
        const matrix = emptyMatrix();
        matrix[3][3] = 1;

        expect(
            canCastSpell(
                false,
                testGridSettings,
                matrix,
                caster,
                undefined,
                freeCellSpell,
                { x: 3, y: 3 },
                undefined,
                false,
                false,
                undefined,
                { x: 3, y: 3 },
            ),
        ).toBe(true);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                matrix,
                caster,
                undefined,
                freeCellSpell,
                { x: 2, y: 2 },
                undefined,
                false,
                false,
                undefined,
                { x: 2, y: 2 },
            ),
        ).toBe(false);
    });

    it("rejects Castling inherited by a large caster", () => {
        const caster = createTestUnit({
            name: "Arachna Queen",
            team: PBTypes.TeamVals.RIGHT,
            size: PBTypes.UnitSizeVals.LARGE,
            spells: ["System:Castling"],
            stackPower: 5,
        });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.LEFT });
        const castling = caster.getSpells().find((candidate) => candidate.getName() === "Castling");

        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                enemy,
                castling,
                enemy.getBaseCell(),
                enemy.getMagicResist(),
                false,
                enemy.canBeHealed(),
                [enemy.getBaseCell()],
            ),
        ).toBe(false);
    });

    it("rejects direct spell casts for missing spells, immunity, and already-applied effects", () => {
        const caster = createTestUnit({
            name: "Caster",
            team: PBTypes.TeamVals.RIGHT,
            spells: [
                "System:Castling",
                "System:Wild Regeneration",
                "Life:Helping Hand",
                "Life:Courage",
                "Death:Sadness",
            ],
            stackPower: 5,
        });
        const ally = createTestUnit({
            name: "Ally",
            team: PBTypes.TeamVals.RIGHT,
            level: PBTypes.UnitLevelVals.SECOND,
        });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.LEFT });

        const castling = caster.getSpells().find((candidate) => candidate.getName() === "Castling");
        const wildRegeneration = caster.getSpells().find((candidate) => candidate.getName() === "Wild Regeneration");
        const helpingHand = caster.getSpells().find((candidate) => candidate.getName() === "Helping Hand");
        const courage = caster.getSpells().find((candidate) => candidate.getName() === "Courage");
        const sadness = caster.getSpells().find((candidate) => candidate.getName() === "Sadness");

        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                customSpell("Unowned", SpellTargetType.ANY_ALLY, true),
                ally.getBaseCell(),
                ally.getMagicResist(),
                false,
                ally.canBeHealed(),
            ),
        ).toBe(false);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                wildRegeneration,
                ally.getBaseCell(),
                ally.getMagicResist(),
                false,
                ally.canBeHealed(),
            ),
        ).toBe(true);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                castling,
                ally.getBaseCell(),
                ally.getMagicResist(),
                false,
                ally.canBeHealed(),
            ),
        ).toBe(false);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                courage,
                ally.getBaseCell(),
                100,
                false,
                ally.canBeHealed(),
            ),
        ).toBe(false);

        ally.applyBuff(helpingHand!);
        enemy.applyDebuff(sadness!);

        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                ally,
                helpingHand,
                ally.getBaseCell(),
                ally.getMagicResist(),
                false,
                ally.canBeHealed(),
            ),
        ).toBe(false);
        expect(
            canCastSpell(
                false,
                testGridSettings,
                emptyMatrix(),
                caster,
                enemy,
                sadness,
                enemy.getBaseCell(),
                enemy.getMagicResist(),
                false,
                enemy.canBeHealed(),
            ),
        ).toBe(false);
    });

    it("calculates buff and debuff stat effects", () => {
        expect(
            calculateBuffsDebuffsEffect(
                [
                    new AppliedSpell("Expired", 0, 0),
                    new AppliedSpell("Helping Hand", 0, 3),
                    new AppliedSpell("Helping Hand", 0, 3, 100, 20),
                    new AppliedSpell("Helping Hand", 0, 3, 100, 20),
                    new AppliedSpell("Luck Aura", 0, Number.MAX_SAFE_INTEGER),
                ],
                [],
            ),
        ).toEqual({
            baseStats: {
                hp: 30,
                armor: 6,
                luck: Number.MAX_SAFE_INTEGER,
                morale: 0,
            },
            additionalStats: {
                hp: 0,
                armor: 0,
                luck: 0,
                morale: 0,
            },
        });
        expect(calculateBuffsDebuffsEffect([], [new AppliedSpell("Helping Hand", 0, 3, 50, 10)]).baseStats).toEqual({
            hp: -15,
            armor: -3,
            luck: 0,
            morale: 0,
        });
    });

    it("calculates mirror power and detects already applied spells", () => {
        // Full stack: Magic Mirror is stack-powered (15/30/45/60/75 at power 75), so the 0..100 clamp this
        // test exists to pin is only reachable from a full stack.
        const target = createTestUnit({ team: PBTypes.TeamVals.LEFT, stackPower: 5 });
        const mirror = spell("Chaos", "Magic Mirror");

        mirror.setPower(150);
        target.applyBuff(mirror);

        expect(getMagicMirrorPower(target)).toBe(100);
        expect(isMirrored(target)).toBe(true);
        expect(hasAlreadyAppliedSpell(target, spell("Chaos", "Magic Mirror"))).toBe(true);

        mirror.setPower(20);
        const massMirror = spell("Chaos", "Mass Magic Mirror");
        massMirror.setPower(70);
        // Full stack again: this asserts the stronger of the two mirrors wins (70 over 20), which is about
        // the max() selection, not about stack scaling.
        const massMirrorTarget = createTestUnit({ team: PBTypes.TeamVals.LEFT, stackPower: 5 });
        massMirrorTarget.applyBuff(mirror);
        massMirrorTarget.applyBuff(massMirror);
        expect(getMagicMirrorPower(massMirrorTarget)).toBe(70);

        // Ranked hydration carries active buffs in the authoritative parallel arrays without rebuilding
        // AppliedSpell objects. The combat preview must read the same power instead of silently showing no
        // return damage after every snapshot refresh.
        const snapshotMirrorTarget = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const snapshotProperties = snapshotMirrorTarget.getUnitProperties();
        snapshotProperties.applied_buffs.push("Magic Mirror");
        snapshotProperties.applied_buffs_laps.push(2);
        snapshotProperties.applied_buffs_descriptions.push("Reflects 30% magic damage");
        snapshotProperties.applied_buffs_powers.push(30);
        expect(snapshotMirrorTarget.getBuff("Magic Mirror")).toBeUndefined();
        expect(getMagicMirrorPower(snapshotMirrorTarget)).toBe(30);

        const noMirrorTarget = createTestUnit({ team: PBTypes.TeamVals.LEFT });

        expect(getMagicMirrorPower(noMirrorTarget)).toBe(0);
        expect(isMirrored(noMirrorTarget)).toBe(false);
        expect(hasAlreadyAppliedSpell(noMirrorTarget, spell("Chaos", "Magic Mirror"))).toBe(false);
    });
});

function spell(faction: string, name: string): Spell {
    return new Spell({
        spellProperties: getSpellConfig(faction, name),
        amount: 1,
    });
}

function customSpell(
    name: string,
    targetType: SpellTargetType,
    isBuff: boolean,
    options: {
        conflictsWith?: string[];
        maximumGiftLevel?: number;
        minimalCasterStackPower?: number;
        element?: SpellElement;
        powerType?: SpellPowerType;
        selfCastAllowed?: boolean;
    } = {},
): Spell {
    return new Spell({
        spellProperties: new SpellProperties(
            PBTypes.FactionVals.NO_FACTION,
            name,
            0,
            [name],
            targetType,
            0,
            options.powerType ?? SpellPowerType.COMMON,
            options.element ?? SpellElement.NO_ELEMENT,
            SpellMultiplierType.NO_MULTIPLIER,
            1,
            isBuff,
            options.selfCastAllowed ?? true,
            false,
            options.minimalCasterStackPower ?? 1,
            options.conflictsWith ?? [],
            false,
            options.maximumGiftLevel ?? 0,
        ),
        amount: 1,
    });
}

function emptyMatrix(): number[][] {
    return Array.from({ length: testGridSettings.getGridSize() }, () =>
        Array.from({ length: testGridSettings.getGridSize() }, () => 0),
    );
}

describe("Fire Strike needs a visible edge on its target", () => {
    const withinGrid = (cell: { x: number; y: number }): boolean =>
        cell.x >= 0 &&
        cell.y >= 0 &&
        cell.x < testGridSettings.getGridSize() &&
        cell.y < testGridSettings.getGridSize();
    const FROM = { x: 2, y: 8 };
    const TARGET = { x: 8, y: 8 };
    /** Grid where the four cells around TARGET are held by `cover` and everything else is empty. */
    const boxedGrid = (cover: string) => ({
        getOccupantUnitId: (cell: { x: number; y: number }): string | undefined => {
            if (cell.x === TARGET.x && cell.y === TARGET.y) {
                return "target";
            }
            const covered =
                (cell.x === TARGET.x - 1 && cell.y === TARGET.y) ||
                (cell.x === TARGET.x + 1 && cell.y === TARGET.y) ||
                (cell.x === TARGET.x && cell.y === TARGET.y - 1) ||
                (cell.x === TARGET.x && cell.y === TARGET.y + 1);
            return covered ? cover : undefined;
        },
    });

    it("refuses a target covered on all four sides by the caster's enemies", () => {
        expect(isTargetedSpellLineOfSightClear("Fire Strike", boxedGrid("enemy"), withinGrid, FROM, TARGET)).toBe(
            false,
        );
    });

    it("still allows it when the cover is the caster's OWN troops, which it arcs over", () => {
        const alliesAreTransparent = (unitId: string) => unitId === "ally";
        expect(
            isTargetedSpellLineOfSightClear(
                "Fire Strike",
                boxedGrid("ally"),
                withinGrid,
                FROM,
                TARGET,
                alliesAreTransparent,
            ),
        ).toBe(true);
    });

    it("treats lava and water as open sky rather than cover", () => {
        for (const terrain of ["L", "W"]) {
            expect(isTargetedSpellLineOfSightClear("Fire Strike", boxedGrid(terrain), withinGrid, FROM, TARGET)).toBe(
                true,
            );
        }
    });

    it("scans the whole footprint, so a large target boxed in on one cell is still reachable", () => {
        // TARGET's own four sides are covered, but the unit also stands on (9,8) whose sides are open.
        const cells = [TARGET, { x: 9, y: 8 }];
        expect(
            isTargetedSpellLineOfSightClear(
                "Fire Strike",
                boxedGrid("enemy"),
                withinGrid,
                FROM,
                TARGET,
                undefined,
                cells,
            ),
        ).toBe(true);
    });

    it("does not extend the gate to a target with an ally-covered edge and a rock on the lane", () => {
        // Fire Strike arcs over the caster's troops, so ally cover leaves the edge visible — but the rock
        // sitting on the lane still refuses the cast. Proves the edge gate ADDS a reason to refuse rather
        // than replacing the existing line-walk one.
        const alliesAreTransparent = (unitId: string) => unitId === "ally";
        const rockOnLane = {
            getOccupantUnitId: (cell: { x: number; y: number }): string | undefined =>
                cell.x === 5 && cell.y === TARGET.y ? "B" : boxedGrid("ally").getOccupantUnitId(cell),
        };
        expect(
            isTargetedSpellLineOfSightClear("Fire Strike", rockOnLane, withinGrid, FROM, TARGET, alliesAreTransparent),
        ).toBe(false);
    });
});
