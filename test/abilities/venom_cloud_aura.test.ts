/*
 * -----------------------------------------------------------------------------
 * The Wyvern's Venom Cloud Aura: the poison-on-hit passive, handed to allies standing
 * within TWO cells — the same reach as Poison Cloud (the Dryad's aura until it
 * traded poison for Guiding Winds; Poison Cloud stays declared but unassigned).
 *
 * Regression guard: the on-hit poison used to be looked up by the literal buff name
 * "Poison Cloud Aura", so a second poison aura landed on the right allies, showed the
 * right tooltip and then poisoned nobody. The lookup now goes through the config-derived
 * POISON_ON_HIT set, which is what these tests pin.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { processPoisonAuraAbility } from "../../src/abilities/poison_aura_ability";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getCreatureConfig,
    POISON_ON_HIT_AURA_BUFF_NAMES,
    POISON_ON_HIT_AURA_EFFECT_NAMES,
} from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

const AURA_POWER = getAbilityConfig("Venom Cloud Aura").power;

const capturingSceneLog = () => {
    const lines: string[] = [];
    return {
        lines,
        log: {
            getLog: () => lines.join("\n"),
            updateLog: (line?: string) => {
                if (line) lines.push(line);
            },
            hasBeenUpdated: () => lines.length > 0,
        },
    };
};

const makeWyvern = () =>
    createTestUnit({
        name: "Wyvern",
        team: PBTypes.TeamVals.LOWER,
        movementType: PBTypes.MovementVals.FLY,
        abilities: ["Venom Cloud Aura"],
        auraEffects: ["Venom Cloud"],
        auraRanges: [2],
        auraIsBuff: [true],
    });

const makeAlly = (name: string) => createTestUnit({ name, team: PBTypes.TeamVals.LOWER, attack: 10 });

describe("Venom Cloud Aura", () => {
    it("is a 2-cell buff aura with doubled poison and stack damage", () => {
        const aura = getAuraEffectConfig("Venom Cloud");
        expect(aura?.range).toBe(2);
        expect(aura?.is_buff).toBe(true);
        // Poison Cloud remains declared but unassigned; Wyvern's live aura has twice its base poison share.
        expect(aura?.range).toBe(getAuraEffectConfig("Poison Cloud")?.range);
        expect(AURA_POWER).toBe(30);
        expect(AURA_POWER).toBe(getAbilityConfig("Poison Cloud Aura").power * 2);
        expect(getAbilityConfig("Venom Cloud Aura").desc.join(" ")).toContain("+70% poison damage per stack");
        expect(getAbilityConfig("Venom Cloud Aura").stack_powered).toBe(false);
        // Both poison auras must be discoverable from the config, or the on-hit path silently skips one.
        expect([...POISON_ON_HIT_AURA_EFFECT_NAMES].sort()).toEqual(["Poison Cloud", "Venom Cloud"]);
        expect([...POISON_ON_HIT_AURA_BUFF_NAMES].sort()).toEqual(["Poison Cloud Aura", "Venom Cloud Aura"]);
    });

    it("buffs allies up to two cells out but not one three cells away", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = makeWyvern();
        const adjacentAlly = makeAlly("Adjacent Ally");
        const twoCellsAway = makeAlly("Two Cells Away");
        const threeCellsAway = makeAlly("Three Cells Away");

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, adjacentAlly, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, twoCellsAway, { x: 5, y: 3 });
        placeUnit(grid, unitsHolder, threeCellsAway, { x: 6, y: 3 });

        unitsHolder.refreshAuraEffectsForAllUnits();

        expect(adjacentAlly.getBuff("Venom Cloud Aura")?.getPower()).toBe(AURA_POWER);
        expect(twoCellsAway.getBuff("Venom Cloud Aura")?.getPower()).toBe(AURA_POWER);
        // The aura stops at two cells — the third ring is out of reach.
        expect(threeCellsAway.getBuff("Venom Cloud Aura")).toBeUndefined();
    });

    it("poisons the target for the aura's share of the damage dealt", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = makeWyvern();
        const ally = makeAlly("Ally");
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 200 });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, ally, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, enemy, { x: 4, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();

        const { log, lines } = capturingSceneLog();
        processPoisonAuraAbility(ally, enemy, 100, log);

        // 30% of a 100-damage hit at luck 0.
        expect(enemy.getEffect("Poison")?.getPower()).toBe(AURA_POWER);
        expect(lines.join("\n")).toContain("is poisoned");
    });

    it("stacks +70% of each further poison onto an already poisoned target", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = makeWyvern();
        const ally = makeAlly("Ally");
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 2000 });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, ally, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, enemy, { x: 4, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        const { log, lines } = capturingSceneLog();

        // First hit sets the tick outright: 30% of 100 damage.
        processPoisonAuraAbility(ally, enemy, 100, log);
        expect(enemy.getEffect("Poison")?.getPower()).toBe(30);

        // Each further poison adds 70% of its own value, rounded to whole hp — equal hits add a constant 21.
        processPoisonAuraAbility(ally, enemy, 100, log);
        expect(enemy.getEffect("Poison")?.getPower()).toBe(51);
        processPoisonAuraAbility(ally, enemy, 100, log);
        expect(enemy.getEffect("Poison")?.getPower()).toBe(72);

        expect(lines.join("\n")).toContain("poison stacks up");

        // The count rides the effect and is spelled out in the serialised description, which is what the
        // debuff tooltip renders — the same place Deep Wounds shows its accumulated power on the target.
        expect(enemy.getEffect("Poison")?.getStacks()).toBe(3);
        const properties = enemy.getUnitProperties();
        const poisonIndex = properties.applied_effects.indexOf("Poison");
        expect(poisonIndex).toBeGreaterThanOrEqual(0);
        expect(properties.applied_effects_descriptions[poisonIndex]).toBe(
            "Loses 72 hp at the start of each of its turns. Poison stacks: 3.",
        );
        // Index-parallel to applied_effects — this is what the sidebar reads for the count badge.
        expect(properties.applied_effects_stacks[poisonIndex]).toBe(3);
        expect(properties.applied_effects_stacks.length).toBe(properties.applied_effects.length);
    });

    it("rebases to a bigger poison instead of only adding its stack share", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = makeWyvern();
        const weakAlly = makeAlly("Weak Ally");
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 2000 });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, weakAlly, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, enemy, { x: 4, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        const { log } = capturingSceneLog();

        processPoisonAuraAbility(weakAlly, enemy, 20, log); // 30% of 20 = 6
        expect(enemy.getEffect("Poison")?.getPower()).toBe(6);

        // A 120-hp poison landing on a 6-hp stack would only reach 6 + 84 = 90 by the stack rule, but the
        // target must always suffer at least the strongest single poison dealt.
        processPoisonAuraAbility(weakAlly, enemy, 400, log); // 30% of 400 = 120
        expect(enemy.getEffect("Poison")?.getPower()).toBe(120);
    });

    it("leaves an ally outside the aura unpoisoning", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = makeWyvern();
        const farAlly = makeAlly("Far Ally");
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 200 });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, farAlly, { x: 9, y: 9 });
        placeUnit(grid, unitsHolder, enemy, { x: 9, y: 8 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        processPoisonAuraAbility(farAlly, enemy, 100, capturingSceneLog().log);

        expect(enemy.getEffect("Poison")).toBeUndefined();
    });
});

describe("Venom Cloud Aura on a response", () => {
    // Responding is a hit like any other: an aura'd unit struck on the enemy's turn poisons whoever it
    // strikes back at, with the same modifiers as on its own turn. Both response paths used to skip the
    // poison rider entirely while already firing Deep Wounds, Stun and the rest.
    const makeDefender = (name: string, attackType: number, extra: Record<string, unknown> = {}) =>
        createTestUnit({
            name,
            team: PBTypes.TeamVals.LOWER,
            attackType,
            attack: 10,
            armor: 30,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 3,
            ...extra,
        });

    it("poisons the attacker when an aura'd melee ally strikes back", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const wyvern = makeWyvern();
        const defender = makeDefender("Aura'd Defender", PBTypes.AttackVals.MELEE);
        const attacker = createTestUnit({
            name: "Melee Attacker",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            attack: 10,
            armor: 30,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 3,
        });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, defender, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        expect(defender.getBuff("Venom Cloud Aura")).toBeDefined();

        const damageForAnimation = createVisibleDamage(defender);
        damageForAnimation.hits = [];
        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            damageForAnimation,
            undefined,
            attacker,
            defender,
            { x: 5, y: 3 },
        );

        expect(result.completed).toBe(true);
        // The defender never acted on its own turn — the poison can only have come from its response.
        expect(attacker.getEffect("Poison")?.getPower()).toBeGreaterThan(0);
    });

    it("poisons the shooter when an aura'd archer counter-shoots", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const wyvern = makeWyvern();
        const archer = makeDefender("Aura'd Archer", PBTypes.AttackVals.RANGE, { rangeShots: 5 });
        const shooter = createTestUnit({
            name: "Enemy Shooter",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 10,
            armor: 30,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 5,
            amountAlive: 3,
        });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, archer, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, shooter, { x: 9, y: 9 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        expect(archer.getBuff("Venom Cloud Aura")).toBeDefined();

        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            createVisibleDamage(archer),
            shooter,
            [[archer]],
            [shooter],
            archer.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(shooter.getEffect("Poison")?.getPower()).toBeGreaterThan(0);
    });
});

describe("Wyvern", () => {
    it("is a Might level 2 flying melee unit with the poison aura and Wardguard", () => {
        const config = (faction: string, name: string) =>
            getCreatureConfig(PBTypes.TeamVals.LOWER, faction, name, `${name.toLowerCase()}_512`, 1, 0);
        const wyvern = config("Might", "Wyvern");

        expect(wyvern.level).toBe(PBTypes.UnitLevelVals.SECOND);
        expect(wyvern.movement_type).toBe(PBTypes.MovementVals.FLY);
        expect(wyvern.attack_type).toBe(PBTypes.AttackVals.MELEE);
        expect(wyvern.abilities).toEqual(["Venom Cloud Aura", "Wardguard"]);

        // Stats sit between the two level 2 flyers it was balanced against.
        const valkyrie = config("Life", "Valkyrie");
        const harpy = config("Might", "Harpy");
        const between = (value: number, a: number, b: number) => value >= Math.min(a, b) && value <= Math.max(a, b);

        expect(between(wyvern.max_hp, valkyrie.max_hp, harpy.max_hp)).toBe(true);
        expect(between(wyvern.steps, valkyrie.steps, harpy.steps)).toBe(true);
        expect(between(wyvern.speed, valkyrie.speed, harpy.speed)).toBe(true);
        expect(between(wyvern.base_armor, valkyrie.base_armor, harpy.base_armor)).toBe(true);
        expect(between(wyvern.base_attack, valkyrie.base_attack, harpy.base_attack)).toBe(true);
        // Exp is the deliberate exception: the rebalance took it to 33, UNDER both flyers, so a Wyvern stack
        // is cheaper than either despite fighting between them. Asserted as strictly-cheaper rather than
        // dropped, so a future change that quietly prices it back above them is still caught.
        expect(wyvern.exp).toBeLessThan(Math.min(valkyrie.exp, harpy.exp));
    });
});
