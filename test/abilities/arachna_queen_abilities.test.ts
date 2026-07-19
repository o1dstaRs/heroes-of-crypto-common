/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { processPredatoryAssimilationAbility } from "../../src/abilities/predatory_assimilation_ability";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());
afterEach(() => setDeterministicRandomSource(undefined));

describe("Arachna Queen configuration", () => {
    it("configures Arachna Spider as a small level-3 Infest summon", () => {
        const queen = getCreatureConfig(PBTypes.TeamVals.LOWER, "Nature", "Arachna Queen", "arachna_queen_512", 1);
        const spider = getCreatureConfig(PBTypes.TeamVals.LOWER, "Nature", "Arachna Spider", "arachna_spider_512", 1);

        expect(queen.abilities).toEqual(["Web Aura", "Infest", "Predatory Assimilation"]);
        expect(queen.abilities_stack_powered[queen.abilities.indexOf("Predatory Assimilation")]).toBe(true);
        expect(queen.steps).toBe(6.3);
        expect(spider.abilities).toEqual(["Infest"]);
        for (const [queenStat, spiderStat] of [
            [queen.max_hp, spider.max_hp],
            [queen.base_attack, spider.base_attack],
            [queen.attack_damage_min, spider.attack_damage_min],
            [queen.attack_damage_max, spider.attack_damage_max],
            [queen.exp, spider.exp],
        ]) {
            expect(spiderStat).toBe(queenStat / 2);
        }
        expect(spider.steps).toBe(6);
        expect(spider.speed).toBe(5.1);
        expect(spider.base_armor).toBe(16);
        expect(spider.magic_resist).toBe(10);
        expect(spider.size).toBe(PBTypes.UnitSizeVals.SMALL);
        expect(spider.level).toBe(PBTypes.UnitLevelVals.THIRD);
        expect(spider.movement_type).toBe(PBTypes.MovementVals.WALK);
    });
});

describe("Web Aura", () => {
    it("affects enemy flyers only and snapshots the movement lock at turn start", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const queen = createTestUnit({
            name: "Arachna Queen",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Web Aura"],
            auraEffects: ["Web"],
            auraRanges: [1],
            auraIsBuff: [false],
        });
        const enemyFlyer = createTestUnit({
            name: "Enemy Flyer",
            team: PBTypes.TeamVals.UPPER,
            movementType: PBTypes.MovementVals.FLY,
        });
        const enemyWalker = createTestUnit({ name: "Enemy Walker", team: PBTypes.TeamVals.UPPER });
        const alliedFlyer = createTestUnit({
            name: "Allied Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(grid, unitsHolder, queen, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemyFlyer, { x: 5, y: 4 });
        placeUnit(grid, unitsHolder, enemyWalker, { x: 4, y: 5 });
        placeUnit(grid, unitsHolder, alliedFlyer, { x: 3, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        expect(enemyFlyer.hasDebuffActive("Web Aura")).toBe(true);
        expect(enemyWalker.hasDebuffActive("Web Aura")).toBe(false);
        expect(alliedFlyer.hasDebuffActive("Web Aura")).toBe(false);

        // Entering/landing in Web during the preceding action is legal until activation snapshots it.
        expect(enemyFlyer.canMove()).toBe(true);
        enemyFlyer.refreshPreTurnState(new SceneLogMock());
        expect(enemyFlyer.isWebMovementLocked()).toBe(true);
        expect(enemyFlyer.canMove()).toBe(false);

        // The snapshot remains stable for the turn even if the live aura disappears, then clears next turn.
        enemyFlyer.deleteDebuff("Web Aura");
        expect(enemyFlyer.canMove()).toBe(false);
        enemyFlyer.refreshPreTurnState(new SceneLogMock());
        expect(enemyFlyer.isWebMovementLocked()).toBe(false);
        expect(enemyFlyer.canMove()).toBe(true);
    });
});

describe("Predatory Assimilation", () => {
    const setAssimilationRoll = (roll: number) => {
        // getRandomInt combines one 21-bit and one 32-bit source draw. Feed an exact raw integer so the
        // percentage boundary stays explicit instead of depending on a float-to-53-bit conversion.
        const draws = [0, roll / 0x100000000];
        let index = 0;
        setDeterministicRandomSource(() => draws[index++] ?? 0);
    };
    const setup = (targetAbilities: string[], targetAura = false, thiefStackPower = 1, thiefLuck = 0) => {
        const thief = createTestUnit({
            name: "Arachna Queen",
            abilities: ["Predatory Assimilation"],
            stackPower: thiefStackPower,
            luck: thiefLuck,
        });
        const target = createTestUnit({
            name: "Target",
            abilities: targetAbilities,
            auraEffects: targetAura ? ["Web"] : [],
            auraRanges: targetAbilities.map((ability) => (ability === "Web Aura" ? 1 : 0)),
            auraIsBuff: targetAbilities.map((ability) => ability !== "Web Aura"),
            spells: targetAbilities.includes("Resurrection") ? [":Resurrection"] : [],
        });
        return { thief, target };
    };

    it("scales its proc chance from 5% at stack power 1 to 25% at stack power 5", () => {
        const lowStackSuccess = setup(["Dodge"]);
        expect(
            lowStackSuccess.thief.calculateAbilityApplyChance(
                lowStackSuccess.thief.getAbility("Predatory Assimilation")!,
                0,
            ),
        ).toBe(5);
        setAssimilationRoll(4);
        expect(
            processPredatoryAssimilationAbility(lowStackSuccess.thief, lowStackSuccess.target, new SceneLogMock()),
        ).toMatchObject({
            thiefId: lowStackSuccess.thief.getId(),
            targetId: lowStackSuccess.target.getId(),
            abilityName: "Dodge",
        });

        const lowStackFailure = setup(["Dodge"]);
        setAssimilationRoll(5);
        expect(
            processPredatoryAssimilationAbility(lowStackFailure.thief, lowStackFailure.target, new SceneLogMock()),
        ).toBeUndefined();
        expect(lowStackFailure.target.hasAbilityActive("Dodge")).toBe(true);

        const fullStackSuccess = setup(["Dodge"], false, 5);
        expect(
            fullStackSuccess.thief.calculateAbilityApplyChance(
                fullStackSuccess.thief.getAbility("Predatory Assimilation")!,
                0,
            ),
        ).toBe(25);
        setAssimilationRoll(24);
        expect(
            processPredatoryAssimilationAbility(fullStackSuccess.thief, fullStackSuccess.target, new SceneLogMock()),
        ).toMatchObject({
            thiefId: fullStackSuccess.thief.getId(),
            targetId: fullStackSuccess.target.getId(),
            abilityName: "Dodge",
        });

        const fullStackFailure = setup(["Dodge"], false, 5);
        setAssimilationRoll(25);
        expect(
            processPredatoryAssimilationAbility(fullStackFailure.thief, fullStackFailure.target, new SceneLogMock()),
        ).toBeUndefined();
        expect(fullStackFailure.target.hasAbilityActive("Dodge")).toBe(true);
    });

    it("adds one percentage point per Luck, ranging from 15% to 35% at full stack", () => {
        for (const [luck, expectedChance] of [
            [-10, 15],
            [0, 25],
            [10, 35],
        ] as const) {
            const { thief } = setup(["Dodge"], false, 5, luck);
            expect(thief.calculateAbilityApplyChance(thief.getAbility("Predatory Assimilation")!, 0)).toBe(
                expectedChance,
            );
        }
    });

    it("keeps the target card visible but disables its aura and grants a working persistent aura to the thief", () => {
        const { thief, target } = setup(["Web Aura"], true);
        setDeterministicRandomSource(() => 0);

        expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe("Web Aura");
        expect(target.getAllProperties().abilities).toContain("Web Aura");
        expect(target.getStolenAbilityNames()).toEqual(["Web Aura"]);
        expect(target.hasAbilityActive("Web Aura")).toBe(false);
        expect(target.getAuraEffects()).toHaveLength(0);
        expect(target.getAllProperties().aura_effects).not.toContain("Web");
        expect(target.getAllProperties().aura_ranges).toEqual([0]);
        expect(thief.hasAbilityActive("Web Aura")).toBe(true);
        expect(thief.getAuraEffects().map((aura) => aura.getName())).toContain("Web");
        expect(thief.getAllProperties().aura_ranges).toEqual([0, 1]);

        const effectFactory = new EffectFactory();
        const restored = Unit.createUnit(
            thief.getAllProperties(),
            testGridSettings,
            thief.getTeam(),
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effectFactory),
            effectFactory,
            false,
        );
        expect(restored.hasAbilityActive("Web Aura")).toBe(true);
        expect(restored.getAuraEffects().map((aura) => aura.getName())).toContain("Web");

        // Legacy/reconnect properties can still contain the native aura list; stolen_abilities is authoritative.
        const staleTargetProperties = target.getAllProperties();
        staleTargetProperties.aura_effects.push("Web");
        const restoredTarget = Unit.createUnit(
            staleTargetProperties,
            testGridSettings,
            target.getTeam(),
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effectFactory),
            effectFactory,
            false,
        );
        expect(restoredTarget.hasAbilityActive("Web Aura")).toBe(false);
        expect(restoredTarget.getAuraEffects()).toHaveLength(0);
    });

    it("removes and grants the castable spell mechanics with a stolen castable ability", () => {
        const { thief, target } = setup(["Resurrection"]);
        setDeterministicRandomSource(() => 0);

        expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe(
            "Resurrection",
        );
        expect(target.getAllProperties().abilities).toContain("Resurrection");
        expect(target.hasAbilityActive("Resurrection")).toBe(false);
        expect(target.hasSpellRemaining("Resurrection")).toBe(false);
        expect(thief.hasAbilityActive("Resurrection")).toBe(true);
        expect(thief.hasSpellRemaining("Resurrection")).toBe(true);

        const staleProperties = target.getAllProperties();
        staleProperties.spells.push(":Resurrection");
        const effectFactory = new EffectFactory();
        const restoredTarget = Unit.createUnit(
            staleProperties,
            testGridSettings,
            target.getTeam(),
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effectFactory),
            effectFactory,
            false,
        );
        expect(restoredTarget.hasAbilityActive("Resurrection")).toBe(false);
        expect(restoredTarget.hasSpellRemaining("Resurrection")).toBe(false);
    });

    it("does not recreate an already-spent castable ability charge when stealing its card", () => {
        const { thief, target } = setup(["Wind Flow"]);
        target.useSpell("Wind Flow");
        expect(target.hasAbilityActive("Wind Flow")).toBe(true);
        expect(target.getAllProperties().spells).toEqual([]);
        setDeterministicRandomSource(() => 0);

        expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe("Wind Flow");
        expect(target.hasAbilityActive("Wind Flow")).toBe(false);
        expect(target.getAllProperties().spells).toEqual([]);
        expect(thief.hasAbilityActive("Wind Flow")).toBe(true);
        expect(thief.getAllProperties().spells).toEqual([]);
        expect(thief.hasSpellRemaining("Wind Flow")).toBe(false);
    });

    it("keeps spent stolen direct-cast cards empty across serialized reconstruction", () => {
        for (const abilityName of ["Wind Flow", "Battle Roar"]) {
            const { thief, target } = setup([abilityName]);
            target.useSpell(abilityName);
            expect(target.hasSpellRemaining(abilityName)).toBe(false);
            setDeterministicRandomSource(() => 0);

            expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe(
                abilityName,
            );
            expect(thief.hasAbilityActive(abilityName)).toBe(true);
            expect(thief.hasSpellRemaining(abilityName)).toBe(false);

            const serializedProperties = JSON.parse(JSON.stringify(thief.getAllProperties()));
            const effectFactory = new EffectFactory();
            const restored = Unit.createUnit(
                serializedProperties,
                testGridSettings,
                thief.getTeam(),
                PBTypes.UnitVals.CREATURE,
                new AbilityFactory(effectFactory),
                effectFactory,
                false,
            );
            expect(restored.hasAbilityActive(abilityName)).toBe(true);
            expect(restored.getAllProperties().spells).toEqual([]);
            expect(restored.hasSpellRemaining(abilityName)).toBe(false);
        }
    });

    it("adds the initial direct-cast charge for ordinary native creature construction", () => {
        for (const [faction, creatureName, textureName, abilityName] of [
            ["Life", "Valkyrie", "valkyrie_512", "Wind Flow"],
            ["Might", "Behemoth", "behemoth_512", "Battle Roar"],
        ] as const) {
            const properties = getCreatureConfig(PBTypes.TeamVals.LOWER, faction, creatureName, textureName, 1);
            expect(properties.spell_entries_authoritative).toBeUndefined();
            const effectFactory = new EffectFactory();
            const unit = Unit.createUnit(
                properties,
                testGridSettings,
                PBTypes.TeamVals.LOWER,
                PBTypes.UnitVals.CREATURE,
                new AbilityFactory(effectFactory),
                effectFactory,
                false,
            );

            expect(unit.hasAbilityActive(abilityName)).toBe(true);
            expect(unit.getAllProperties().spells).toContain(`:${abilityName}`);
            expect(unit.hasSpellRemaining(abilityName)).toBe(true);
            expect(unit.getAllProperties().spell_entries_authoritative).toBe(true);
        }
    });

    it("moves every remaining castable ability charge while retaining unrelated victim spells", () => {
        const thief = createTestUnit({ name: "Arachna Queen", abilities: ["Predatory Assimilation"] });
        const target = createTestUnit({
            name: "Valkyrie with another spell source",
            abilities: ["Wind Flow"],
            spells: [":Wind Flow", "System:Wind Flow", "Life:Heal"],
        });
        setDeterministicRandomSource(() => 0);

        expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe("Wind Flow");
        expect(target.getAllProperties().spells).toEqual(["Life:Heal"]);
        expect(target.hasSpellRemaining("Wind Flow")).toBe(false);
        expect(thief.getAllProperties().spells).toEqual([":Wind Flow", ":Wind Flow"]);
        expect(
            thief
                .getSpells()
                .find((spell) => spell.getName() === "Wind Flow")
                ?.getAmount(),
        ).toBe(2);
    });

    it("transfers only the exact remaining duplicate charges owned by a stolen spellbook", () => {
        const thief = createTestUnit({ name: "Arachna Queen", abilities: ["Predatory Assimilation"] });
        const target = createTestUnit({
            name: "Satyr with another spell source",
            abilities: ["Forest Spellbook"],
            spells: ["Life:Courage", "Life:Courage", "Life:Helping Hand", "Nature:Summon Wolves", "Life:Heal"],
        });
        setDeterministicRandomSource(() => 0);

        expect(processPredatoryAssimilationAbility(thief, target, new SceneLogMock())?.abilityName).toBe(
            "Forest Spellbook",
        );
        expect(target.getAllProperties().spells).toEqual(["Life:Heal"]);
        expect(thief.getAllProperties().spells).toEqual([
            "Life:Courage",
            "Life:Courage",
            "Life:Helping Hand",
            "Nature:Summon Wolves",
        ]);

        // Neither the string API nor the Ability API may silently undo a permanent theft.
        target.grantAbility("Forest Spellbook");
        target.addAbility(new AbilityFactory(new EffectFactory()).makeAbility("Forest Spellbook"));
        expect(target.hasAbilityActive("Forest Spellbook")).toBe(false);
        expect(target.getAllProperties().spells).toEqual(["Life:Heal"]);
    });

    it("keeps ability-aligned aura slots stable and restores the configured range on an explicit stolen grant", () => {
        const angel = createTestUnit({
            name: "Angel",
            abilities: ["Resurrection", "Arrows Wingshield Aura"],
            auraEffects: ["Arrows Wingshield"],
            auraRanges: [0, 2],
            auraIsBuff: [true, true],
            spells: [":Resurrection"],
        });

        expect(angel.disableAbilityAsStolen("Arrows Wingshield Aura")).toBeDefined();
        expect(angel.getAllProperties().abilities).toEqual(["Resurrection", "Arrows Wingshield Aura"]);
        expect(angel.getAllProperties().aura_ranges).toEqual([0, 0]);
        expect(angel.getAuraEffects()).toHaveLength(0);

        angel.grantAbility("Arrows Wingshield Aura");
        expect(angel.hasAbilityActive("Arrows Wingshield Aura")).toBe(false);
        expect(angel.getAllProperties().aura_ranges).toEqual([0, 0]);

        angel.grantStolenAbility("Arrows Wingshield Aura");
        expect(angel.hasAbilityActive("Arrows Wingshield Aura")).toBe(true);
        expect(angel.getAllProperties().aura_ranges).toEqual([0, 2]);
        expect(angel.getAuraEffects().map((aura) => aura.getName())).toEqual(["Arrows Wingshield"]);
    });
});

describe("Infest", () => {
    type CleanupHarness = {
        cleanupDeadUnits(unitIds: string[], attributions: Map<string, Unit>): GameEvent[];
    };

    const setup = (victim: Unit) => {
        const context = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const killer = createTestUnit({
            name: "Infester",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Infest"],
        });
        const place = (unit: Unit, cell: XY) => {
            const position = getPositionForCell(
                cell,
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            );
            unit.setPosition(position.x, position.y);
            context.grid.occupyCells(
                unit.getCells(),
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                false,
                false,
            );
            context.unitsHolder.addUnit(unit);
        };
        place(killer, { x: 2, y: 2 });
        place(victim, { x: 5, y: 5 });

        const effectFactory = new EffectFactory();
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            createSummonedUnit: ({ team, unitName }) =>
                createTestUnit({
                    name: unitName,
                    team,
                    size: unitName === "Arachna Queen" ? PBTypes.UnitSizeVals.LARGE : PBTypes.UnitSizeVals.SMALL,
                    level: unitName === "Arachna Queen" ? PBTypes.UnitLevelVals.FOURTH : PBTypes.UnitLevelVals.FIRST,
                    abilities:
                        unitName === "Arachna Queen" ? ["Web Aura", "Infest", "Predatory Assimilation"] : ["Infest"],
                    summoned: true,
                }),
        });
        const cleanup = (engine as unknown as CleanupHarness).cleanupDeadUnits.bind(engine);
        return { ...context, killer, victim, cleanup, effectFactory };
    };

    it.each([
        [PBTypes.UnitLevelVals.FIRST, PBTypes.UnitSizeVals.SMALL, "Arachna Spider"],
        [PBTypes.UnitLevelVals.SECOND, PBTypes.UnitSizeVals.SMALL, "Arachna Spider"],
        [PBTypes.UnitLevelVals.THIRD, PBTypes.UnitSizeVals.SMALL, "Arachna Spider"],
        [PBTypes.UnitLevelVals.FOURTH, PBTypes.UnitSizeVals.LARGE, "Arachna Queen"],
    ] as const)("spawns the correct child for destroyed level %i", (level, size, expectedName) => {
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 10,
            level,
            size,
        });
        const { killer, cleanup, unitsHolder } = setup(victim);
        victim.applyDamage(1000, 0, new SceneLogMock());

        const events = cleanup([victim.getId()], new Map([[victim.getId(), killer]]));
        expect(events).toContainEqual(expect.objectContaining({ type: "unit_destroyed", unitId: victim.getId() }));
        expect(events).toContainEqual(
            expect.objectContaining({ type: "unit_summoned", unitName: expectedName, sourceAbility: "Infest" }),
        );
        const child = [...unitsHolder.getAllUnits().values()].find((unit) => unit.getName() === expectedName);
        expect(child?.getAmountAlive()).toBe(1);
        expect(child?.getTeam()).toBe(killer.getTeam());
        expect(child?.hasAbilityActive("Infest")).toBe(true);
    });

    it("does not spawn from a destroyed no-level stack", () => {
        const victim = createTestUnit({
            name: "No-level Victim",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 10,
            level: PBTypes.UnitLevelVals.NO_LEVEL,
        });
        const { killer, cleanup, unitsHolder } = setup(victim);
        victim.applyDamage(1000, 0, new SceneLogMock());

        const events = cleanup([victim.getId()], new Map([[victim.getId(), killer]]));
        expect(events).toContainEqual(expect.objectContaining({ type: "unit_destroyed", unitId: victim.getId() }));
        expect(events.some((event) => event.type === "unit_summoned")).toBe(false);
        expect([...unitsHolder.getAllUnits().values()].map((unit) => unit.getName())).toEqual([killer.getName()]);
    });

    it("does not spawn when the destroyed stack actually resurrects", () => {
        const victim = createTestUnit({
            name: "Resurrecting Victim",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 10,
            amountAlive: 2,
            level: PBTypes.UnitLevelVals.FIRST,
            abilities: ["Resurrection"],
            spells: [":Resurrection"],
        });
        const { killer, cleanup, unitsHolder } = setup(victim);
        victim.applyDamage(1000, 0, new SceneLogMock());

        const events = cleanup([victim.getId()], new Map([[victim.getId(), killer]]));
        expect(events).toContainEqual(expect.objectContaining({ type: "unit_resurrected", unitId: victim.getId() }));
        expect(events.some((event) => event.type === "unit_summoned")).toBe(false);
        expect(unitsHolder.getAllUnits().get(victim.getId())?.isDead()).toBe(false);
    });
});

describe("Stolen Endless Quiver", () => {
    it("turns a natively-melee thief into a real shooter, with melee still the default attack type", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const thief = createTestUnit({
            name: "Arachna Queen",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Predatory Assimilation"],
            shotDistance: 0,
        });
        const archer = createTestUnit({
            name: "Medusa",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 9,
            shotDistance: 6.5,
            abilities: ["Endless Quiver"],
        });
        placeUnit(grid, unitsHolder, thief, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, archer, { x: 10, y: 10 });
        setDeterministicRandomSource(() => 0);
        expect(processPredatoryAssimilationAbility(thief, archer, new SceneLogMock())?.abilityName).toBe(
            "Endless Quiver",
        );

        // Before the stat pass the thief still reads as a plain melee unit.
        expect(thief.getRangeShots()).toBe(0);
        thief.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

        // Endless ammo via range_shots_mod + the quiver's native owner's shot range.
        expect(thief.getRangeShots()).toBe(99);
        expect(thief.getRangeShotDistance()).toBe(6.5);
        expect(thief.getAttackType()).toBe(PBTypes.AttackVals.MELEE);
        expect(thief.isRangeCapable()).toBe(true);
        expect(attackHandler.canLandRangeAttack(thief)).toBe(true);

        // RANGE becomes selectable, but the unit's native MELEE stays the DEFAULT selection.
        thief.refreshPossibleAttackTypes(true);
        expect(thief.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.MELEE, PBTypes.AttackVals.RANGE]);
        expect(thief.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
        expect(thief.selectAttackType(PBTypes.AttackVals.RANGE)).toBe(true);
        expect(thief.getAttackTypeSelection()).toBe(PBTypes.AttackVals.RANGE);

        // Shooting never depletes the endless quiver (decrement touches range_shots, not the mod).
        thief.decreaseNumberOfShots();
        expect(thief.getRangeShots()).toBe(99);

        // Losing the quiver (e.g. re-assimilated by another thief) reverts the whole grant.
        thief.disableAbilityAsStolen("Endless Quiver");
        thief.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(thief.getRangeShots()).toBe(0);
        expect(thief.getRangeShotDistance()).toBe(0);
        expect(thief.isRangeCapable()).toBe(false);
        thief.refreshPossibleAttackTypes(true);
        expect(thief.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.MELEE]);
    });

    it("lets the quiver thief actually EXECUTE a ranged attack through the action engine", () => {
        const context = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.NORMAL);
        fightProperties.startFight();

        const thief = createTestUnit({
            name: "Arachna Queen",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Predatory Assimilation"],
            shotDistance: 0,
            attack: 40,
            damageMin: 30,
            damageMax: 30,
            speed: 5,
        });
        const farEnemy = createTestUnit({
            name: "Far Enemy",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 400,
            amountAlive: 20,
            armor: 0,
        });
        placeUnit(context.grid, context.unitsHolder, thief, { x: 2, y: 5 });
        placeUnit(context.grid, context.unitsHolder, farEnemy, { x: 8, y: 5 });

        thief.grantStolenAbility("Endless Quiver");
        thief.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        thief.refreshPossibleAttackTypes(true);
        expect(thief.selectAttackType(PBTypes.AttackVals.RANGE)).toBe(true);

        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => thief.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
        });

        const hpBefore = farEnemy.getCumulativeHp();
        const result = engine.apply({
            type: "range_attack",
            attackerId: thief.getId(),
            targetId: farEnemy.getId(),
            aimCell: { x: 8, y: 5 },
        });
        expect(result.completed).toBe(true);
        expect(farEnemy.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(result.events.some((event) => event.type === "unit_attacked")).toBe(true);
    });

    it("never offers RANGE to a melee unit without the quiver", () => {
        const melee = createTestUnit({ name: "Plain Melee", shotDistance: 0 });
        melee.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        melee.refreshPossibleAttackTypes(true);
        expect(melee.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.MELEE]);
        expect(melee.selectAttackType(PBTypes.AttackVals.RANGE)).toBe(false);
        expect(melee.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
    });
});
