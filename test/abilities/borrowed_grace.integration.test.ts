import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    borrowedGraceChance,
    isTakeableBuff,
    processBorrowedGraceAbility,
} from "../../src/abilities/borrowed_grace_ability";
import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { AppliedSpell } from "../../src/spells/applied_spell";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => {
    FightStateManager.getInstance().reset();
    setDeterministicRandomSource(() => 0);
});
afterEach(() => setDeterministicRandomSource(undefined));

const bless = (unit: Unit, name = "Blessing", laps = 3, power?: number, first?: number, second?: number) => {
    const properties = getSpellConfig(name.endsWith("Rune") || name === "Made of Fire" ? "System" : "Life", name, laps);
    unit.applyBuff(
        new Spell({ spellProperties: { ...properties, ...(power === undefined ? {} : { power }) }, amount: 1 }),
        first,
        second,
    );
};

const rawRolls = (...rolls: number[]) => {
    const draws = rolls.flatMap((roll) => [0, roll / 0x100000000]);
    let index = 0;
    setDeterministicRandomSource(() => draws[index++] ?? 0);
};

function fixture(extraAbilities: string[] = [], enemyAbilities: string[] = [], thiefName = "Monk") {
    const context = createCombatTestContext();
    const monk = createTestUnit({
        name: thiefName,
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        abilities: ["Borrowed Grace", ...extraAbilities],
        damageMin: 1,
        damageMax: 1,
        rangeShots: 6,
        amountAlive: 5,
        maxHp: 5000,
        stackPower: 5,
    });
    const enemy = createTestUnit({
        name: "Enemy",
        team: PBTypes.TeamVals.RIGHT,
        abilities: enemyAbilities,
        amountAlive: 5,
        maxHp: 5000,
        stackPower: 5,
    });
    placeUnit(context.grid, context.unitsHolder, monk, { x: 5, y: 2 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 5, y: 5 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fight.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fight.startFight();
    fight.startTurn(PBTypes.TeamVals.LEFT, 1_000, 1);
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        attackHandler: context.attackHandler,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => monk.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1_500] }),
    });
    const fire = () =>
        engine.apply({
            type: "range_attack",
            attackerId: monk.getId(),
            targetId: enemy.getId(),
            targetPosition: enemy.getPosition(),
        });
    return { ...context, monk, enemy, fight, engine, fire };
}

function counterFixture(attackerAbilities: string[] = [], defenderAbilities: string[] = []) {
    const f = fixture(defenderAbilities);
    const attacker = createTestUnit({
        name: "Shooter",
        team: PBTypes.TeamVals.RIGHT,
        attackType: PBTypes.AttackVals.RANGE,
        abilities: attackerAbilities,
        rangeShots: 5,
        damageMin: 1,
        damageMax: 1,
        maxHp: 5000,
        amountAlive: 5,
    });
    placeUnit(f.grid, f.unitsHolder, attacker, { x: 8, y: 2 });
    f.fight.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 2);
    f.fight.startTurn(PBTypes.TeamVals.RIGHT, 1_000, 1);
    const engine = new GameActionEngine({
        fightProperties: f.fight,
        grid: f.grid,
        unitsHolder: f.unitsHolder,
        attackHandler: f.attackHandler,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => attacker.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1_500] }),
    });
    const shootMonk = () =>
        engine.apply({
            type: "range_attack",
            attackerId: attacker.getId(),
            targetId: f.monk.getId(),
            targetPosition: f.monk.getPosition(),
        });
    return { ...f, attacker, shootMonk };
}

describe("Borrowed Grace through real fight actions", () => {
    it("keeps a stolen one-turn blessing through the attacking turn's handoff", () => {
        const f = fixture();
        bless(f.enemy, "Blessing", 1, 73);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(1);
        expect(f.monk.getBuff("Blessing")?.getPower()).toBe(73);
        f.monk.minusLap();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("does not add an extra turn when Morale already pauses the thief's buff countdown", () => {
        const f = fixture();
        f.monk.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Morale", 1), amount: 1 }));
        bless(f.enemy, "Blessing", 1);
        expect(f.fire().completed).toBe(true);
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(1);
        f.monk.minusLap();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(1);
        f.monk.deleteBuff("Morale");
        f.monk.minusLap();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("reports the donor and stolen buff in the authoritative action events", () => {
        const f = fixture();
        bless(f.enemy);
        const result = f.fire();
        expect(result.completed).toBe(true);
        const event = result.events.find((entry) => entry.type === "effects_applied");
        expect(event?.type === "effects_applied" ? event.applications : []).toContainEqual(
            expect.objectContaining({
                unitId: f.monk.getId(),
                name: "Blessing",
                kind: "buff",
                sourceUnitId: f.enemy.getId(),
            }),
        );
        expect(result.events.findIndex((entry) => entry.type === "effects_applied")).toBeLessThan(
            result.events.findIndex((entry) => entry.type === "turn_completed"),
        );
    });

    it("a Crafted Double Shot rolls one theft for each landed arrow", () => {
        const f = fixture(["Crafted Double Shot"]);
        bless(f.enemy, "Blessing");
        bless(f.enemy, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(f.enemy.getBuff("Spiritual Armor")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeDefined();
    });

    it("an acquired Borrowed Grace works on each enemy a Through Shot actually hits", () => {
        const f = fixture(["Through Shot"]);
        const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.RIGHT, maxHp: 5000, amountAlive: 5 });
        placeUnit(f.grid, f.unitsHolder, behind, { x: 5, y: 8 });
        bless(f.enemy, "Blessing");
        bless(behind, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(behind.getBuff("Spiritual Armor")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeDefined();
    });

    it.each(["Area Throw", "Large Caliber", "Chakram"])(
        "%s steals once per struck enemy without rolling twice on the primary",
        (ability) => {
            const f = fixture([ability]);
            const bystander = createTestUnit({
                name: "Bystander",
                team: PBTypes.TeamVals.RIGHT,
                maxHp: 5000,
                amountAlive: 5,
            });
            placeUnit(f.grid, f.unitsHolder, bystander, { x: ability === "Chakram" ? 7 : 6, y: 5 });
            bless(f.enemy, "Blessing");
            bless(f.enemy, "Spiritual Armor");
            bless(bystander, "Weapon Rune", NUMBER_OF_LAPS_TOTAL, undefined, 3, 1);
            const result = f.fire();
            expect(result.completed).toBe(true);
            expect(f.enemy.getBuff("Blessing")).toBeUndefined();
            expect(f.enemy.getBuff("Spiritual Armor")).toBeDefined();
            expect(bystander.getBuff("Weapon Rune")).toBeUndefined();
            expect(f.monk.getBuff("Weapon Rune")?.getFirstSpellProperty()).toBe(3);
            expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
            const thefts = result.events.flatMap((event) =>
                event.type === "effects_applied" ? event.applications.filter((entry) => entry.sourceUnitId) : [],
            );
            expect(thefts).toHaveLength(2);
        },
    );

    it("each volley of a Crafted Double Through Shot gets its own theft", () => {
        const f = fixture(["Through Shot", "Crafted Double Shot"]);
        bless(f.enemy, "Blessing");
        bless(f.enemy, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuffs()).toHaveLength(0);
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
        expect(f.monk.getBuff("Spiritual Armor")?.getLaps()).toBe(3);
    });

    it("Through Shot takes nothing from an enemy behind Arrows Wingshield", () => {
        const f = fixture(["Through Shot"], ["Arrows Wingshield Blessing"]);
        f.monk.calculateMissChance = () => 0;
        const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.RIGHT, maxHp: 5000, amountAlive: 5 });
        placeUnit(f.grid, f.unitsHolder, behind, { x: 5, y: 8 });
        bless(f.enemy, "Blessing");
        bless(behind, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(behind.getBuff("Spiritual Armor")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeUndefined();
        expect(behind.getCumulativeHp()).toBe(25_000);
    });

    it("a splash volley steals only from the victims whose own hit lands", () => {
        const f = fixture(["Area Throw"]);
        const dodger = createTestUnit({
            name: "Dodger",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Dodge"],
            maxHp: 5000,
            amountAlive: 5,
        });
        placeUnit(f.grid, f.unitsHolder, dodger, { x: 6, y: 5 });
        bless(f.enemy, "Blessing");
        bless(dodger, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(dodger.getBuff("Spiritual Armor")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeUndefined();
    });

    it("both volleys of a crafted splash shot can take a buff", () => {
        const f = fixture(["Area Throw", "Crafted Double Shot"]);
        bless(f.enemy, "Blessing");
        bless(f.enemy, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(f.enemy.getBuff("Spiritual Armor")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
        expect(f.monk.getBuff("Spiritual Armor")?.getLaps()).toBe(3);
    });

    it("a missed second arrow leaves the second buff on its owner", () => {
        const f = fixture(["Crafted Double Shot"]);
        let arrow = 0;
        f.monk.calculateMissChance = () => (++arrow === 2 ? 100 : 0);
        bless(f.enemy, "Blessing");
        bless(f.enemy, "Spiritual Armor");
        expect(f.fire().completed).toBe(true);
        expect(f.monk.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeUndefined();
        expect(f.enemy.getBuff("Spiritual Armor")).toBeDefined();
    });

    it.each([{ abilities: [] }, { abilities: ["Through Shot"] }, { abilities: ["Area Throw"] }])(
        "Water Shield absorption prevents theft on %j",
        ({ abilities }) => {
            const f = fixture(abilities, ["Water Shield"]);
            f.enemy.trySeedWaterShield();
            bless(f.enemy);
            expect(f.fire().completed).toBe(true);
            expect(f.enemy.hasBuffActive("Water Shield")).toBe(false);
            expect(f.enemy.getBuff("Blessing")).toBeDefined();
            expect(f.monk.getBuff("Blessing")).toBeUndefined();
        },
    );

    it("an absorbed first arrow can steal on the unshielded second arrow", () => {
        const f = fixture(["Crafted Double Shot"], ["Water Shield"]);
        f.enemy.trySeedWaterShield();
        bless(f.enemy);
        const result = f.fire();
        expect(result.completed).toBe(true);
        expect(f.enemy.hasBuffActive("Water Shield")).toBe(false);
        expect(f.enemy.getBuff("Blessing")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
        expect(
            result.events.flatMap((event) =>
                event.type === "effects_applied" ? event.applications.filter((entry) => entry.sourceUnitId) : [],
            ),
        ).toHaveLength(1);
    });

    it.each([
        { abilities: [] },
        { abilities: ["Petrifying Gaze"] },
        { abilities: ["Through Shot", "Petrifying Gaze"] },
        { abilities: ["Area Throw", "Petrifying Gaze"] },
    ])("a lethal hit cannot take a buff from a dead target on %j", ({ abilities }) => {
        const f = fixture(abilities);
        f.enemy.getUnitProperties().amount_alive = 1;
        f.monk.calculateAttackDamage = () => (abilities.includes("Petrifying Gaze") ? 1 : 100_000);
        bless(f.enemy);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.isDead()).toBe(true);
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("a rejected attack with no arrows consumes no buff", () => {
        const f = fixture();
        f.monk.getUnitProperties().range_shots = 0;
        bless(f.enemy);
        expect(f.fire().completed).toBe(false);
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("a dodged arrow cannot steal a buff", () => {
        const f = fixture([], ["Dodge"]);
        bless(f.enemy);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("Break suppresses the theft without removing the ability", () => {
        const f = fixture();
        bless(f.enemy);
        f.monk.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(borrowedGraceChance(f.monk, 0)).toBe(0);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("takes the entire permanent rune total and keeps its stats and serialization stable", () => {
        const f = fixture();
        const baseArmor = f.monk.getArmor();
        const enemyArmor = f.enemy.getArmor();
        bless(f.enemy, "Armor Rune", NUMBER_OF_LAPS_TOTAL, undefined, 4, 2);
        f.unitsHolder.refreshStackPowerForAllUnits();
        expect(f.enemy.getArmor()).toBe(enemyArmor + 4);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Armor Rune")).toBeUndefined();
        expect(f.enemy.getArmor()).toBe(enemyArmor);
        expect(f.monk.getArmor()).toBe(baseArmor + 4);
        expect(f.monk.getBuff("Armor Rune")?.getLaps()).toBe(NUMBER_OF_LAPS_TOTAL);
        expect(f.monk.getBuff("Armor Rune")?.getFirstSpellProperty()).toBe(4);
        expect(f.monk.getBuff("Armor Rune")?.getSecondSpellProperty()).toBe(2);
        for (let turn = 0; turn < 4; turn++) f.monk.minusLap();
        expect(f.monk.getBuff("Armor Rune")?.getLaps()).toBe(NUMBER_OF_LAPS_TOTAL);
        const properties = f.monk.getUnitProperties();
        const index = properties.applied_buffs.indexOf("Armor Rune");
        expect(properties.applied_buffs_laps[index]).toBe(NUMBER_OF_LAPS_TOTAL);
        expect(properties.applied_buffs_descriptions[index]).toEndWith(";4;2");
    });

    it("replaces an existing buff of the same name instead of duplicating it", () => {
        const f = fixture();
        bless(f.monk, "Blessing", 5, 10);
        bless(f.enemy, "Blessing", 3, 73);
        const stolen = processBorrowedGraceAbility(f.monk, f.enemy, new SceneLogMock());
        expect(stolen?.buffName).toBe("Blessing");
        expect(f.monk.getBuffs().filter((entry) => entry.getName() === "Blessing")).toHaveLength(1);
        expect(f.monk.getBuff("Blessing")?.getPower()).toBe(73);
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
        expect(f.monk.getUnitProperties().applied_buffs.filter((name) => name === "Blessing")).toHaveLength(1);
    });

    it("retains cast-time power and description in all four serialized buff arrays", () => {
        const f = fixture();
        bless(f.enemy, "Blessing", 3, 73, 11, 7);
        const source = f.enemy.getUnitProperties();
        const description = source.applied_buffs_descriptions[0];
        expect(f.fire().completed).toBe(true);
        const stored = JSON.parse(JSON.stringify(f.monk.getUnitProperties()));
        const index = stored.applied_buffs.indexOf("Blessing");
        expect(stored.applied_buffs_laps[index]).toBe(3);
        expect(stored.applied_buffs_powers[index]).toBe(73);
        expect(stored.applied_buffs_descriptions[index]).toBe(description);
        expect(f.monk.getBuff("Blessing")?.getFirstSpellProperty()).toBe(11);
        expect(f.monk.getBuff("Blessing")?.getSecondSpellProperty()).toBe(7);
        expect(source.applied_buffs).toHaveLength(0);
        expect(source.applied_buffs_laps).toHaveLength(0);
        expect(source.applied_buffs_descriptions).toHaveLength(0);
        expect(source.applied_buffs_powers).toHaveLength(0);
    });

    it("an acquired ability follows the same theft rules as a native Monk", () => {
        const f = fixture([], [], "Lich");
        f.monk.disableAbilityAsStolen("Borrowed Grace");
        f.monk.grantStolenAbility("Borrowed Grace");
        bless(f.enemy, "Made of Fire", NUMBER_OF_LAPS_TOTAL);
        expect(f.fire().completed).toBe(true);
        expect(f.enemy.getBuff("Made of Fire")).toBeUndefined();
        expect(f.monk.getBuff("Made of Fire")?.getLaps()).toBe(NUMBER_OF_LAPS_TOTAL);
    });

    it("a landed counter-shot steals for the defending Monk", () => {
        const f = counterFixture();
        bless(f.attacker);
        expect(f.monk.canRespond(PBTypes.AttackVals.RANGE)).toBe(true);
        const result = f.shootMonk();
        expect(result.completed).toBe(true);
        expect(f.attacker.getBuff("Blessing")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(3);
        expect(
            result.events.flatMap((event) => (event.type === "effects_applied" ? event.applications : [])),
        ).toContainEqual(
            expect.objectContaining({ unitId: f.monk.getId(), sourceUnitId: f.attacker.getId(), name: "Blessing" }),
        );
    });

    it("a dodged counter-shot cannot steal", () => {
        const f = counterFixture();
        f.monk.calculateMissChance = () => 100;
        bless(f.attacker);
        expect(f.shootMonk().completed).toBe(true);
        expect(f.attacker.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("Water Shield absorption prevents counter-shot theft", () => {
        const f = counterFixture(["Water Shield"]);
        f.attacker.trySeedWaterShield();
        bless(f.attacker);
        expect(f.shootMonk().completed).toBe(true);
        expect(f.attacker.hasBuffActive("Water Shield")).toBe(false);
        expect(f.attacker.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("a dead Monk cannot steal through a previously resolved retaliation", () => {
        const f = counterFixture();
        f.attacker.calculateAttackDamage = () => 100_000;
        bless(f.attacker);
        expect(f.shootMonk().completed).toBe(true);
        expect(f.monk.isDead()).toBe(true);
        expect(f.attacker.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("an acquired splash counter-shot keeps the donor's duration without adding a turn", () => {
        const f = counterFixture([], ["Area Throw"]);
        bless(f.attacker, "Blessing", 1);
        expect(f.shootMonk().completed).toBe(true);
        expect(f.attacker.getBuff("Blessing")).toBeUndefined();
        expect(f.monk.getBuff("Blessing")?.getLaps()).toBe(1);
    });

    it("Crafted Double Shot does not create a second counter-shot theft", () => {
        const f = counterFixture([], ["Crafted Double Shot"]);
        bless(f.attacker, "Blessing");
        bless(f.attacker, "Spiritual Armor");
        expect(f.shootMonk().completed).toBe(true);
        expect(f.attacker.getBuff("Blessing")).toBeUndefined();
        expect(f.attacker.getBuff("Spiritual Armor")).toBeDefined();
        expect(f.monk.getBuff("Spiritual Armor")).toBeUndefined();
    });

    it("a melee attack does not trigger a shot-only theft", () => {
        const f = fixture();
        f.grid.cleanupAll(f.enemy.getId(), f.enemy.getAttackRange(), f.enemy.isSmallSize());
        placeUnit(f.grid, f.unitsHolder, f.enemy, { x: 5, y: 3 });
        bless(f.enemy);
        f.monk.refreshPossibleAttackTypes(false);
        const result = f.engine.apply({
            type: "melee_attack",
            attackerId: f.monk.getId(),
            targetId: f.enemy.getId(),
            attackFrom: { x: 5, y: 2 },
        });
        expect(result.completed).toBe(true);
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });
});

describe("Borrowed Grace chance and eligibility", () => {
    it.each([
        [6_324, true],
        [6_325, false],
    ])("Made of Fire keeps its fractional roll boundary exact at %s", (roll, lands) => {
        const monk = createTestUnit({ abilities: ["Borrowed Grace"], stackPower: 4, luck: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        bless(monk, "Made of Fire", 2);
        bless(enemy);
        expect(borrowedGraceChance(monk, 0)).toBe(63.25);
        rawRolls(roll);
        expect(!!processBorrowedGraceAbility(monk, enemy, new SceneLogMock())).toBe(lands);
    });
    it.each([
        [2, 32.49, true],
        [2, 32.5, false],
        [4, 57.49, true],
        [4, 57.5, false],
    ])("stack %s: a %s%% roll lands=%s", (stackPower, roll, lands) => {
        const monk = createTestUnit({ abilities: ["Borrowed Grace"], stackPower });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        bless(enemy);
        rawRolls(Math.round(roll * 100));
        expect(!!processBorrowedGraceAbility(monk, enemy, new SceneLogMock())).toBe(lands);
    });

    it("adds current luck and team power, and clamps the result", () => {
        const monk = createTestUnit({ abilities: ["Borrowed Grace"], stackPower: 2, luck: 10 });
        expect(borrowedGraceChance(monk, 8)).toBe(50.5);
        expect(borrowedGraceChance(monk, 100)).toBe(100);
        expect(borrowedGraceChance(monk, -100)).toBe(0);
        monk.setStackPower(9);
        expect(borrowedGraceChance(monk, 0)).toBe(80);
        monk.setStackPower(0);
        expect(borrowedGraceChance(monk, 0)).toBe(30);
    });

    it.each([1, 2, 5])("Made of Fire boosts the stack %s base chance by its stated 10%%", (stackPower) => {
        const monk = createTestUnit({ abilities: ["Borrowed Grace"], stackPower, luck: 10 });
        const baseChance = borrowedGraceChance(monk, 0) - 10;
        bless(monk, "Made of Fire", 2);
        expect(borrowedGraceChance(monk, 8)).toBeCloseTo(baseChance * 1.1 + 10 + 8, 4);
    });

    it("uses the thief's team synergy when the chance is actually rolled", () => {
        const f = fixture();
        f.monk.setStackPower(2);
        f.fight.setSynergiesPerTeam(PBTypes.TeamVals.LEFT, ["Might:2:2"]);
        f.fight.setSynergiesPerTeam(PBTypes.TeamVals.RIGHT, []);
        bless(f.enemy);
        rawRolls(4_000);
        expect(processBorrowedGraceAbility(f.monk, f.enemy, new SceneLogMock())?.buffName).toBe("Blessing");
    });

    it("randomly selects exactly one eligible buff", () => {
        const f = fixture();
        bless(f.enemy, "Blessing");
        bless(f.enemy, "Spiritual Armor");
        f.enemy.applyAuraEffect("Luck Aura", "aura", true, 12, "5;5");
        rawRolls(0, 1);
        expect(processBorrowedGraceAbility(f.monk, f.enemy, new SceneLogMock())?.buffName).toBe("Spiritual Armor");
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.enemy.getBuff("Luck Aura")).toBeDefined();
    });

    it("does not spend a random roll when only ineligible buffs exist", () => {
        const f = fixture();
        f.enemy.applyAuraEffect("Luck Aura", "aura", true, 12, "5;5");
        let draws = 0;
        setDeterministicRandomSource(() => {
            draws++;
            return 0;
        });
        expect(processBorrowedGraceAbility(f.monk, f.enemy, new SceneLogMock())).toBeUndefined();
        expect(draws).toBe(0);
    });

    it("excludes every artifact, augment, army blessing, marker and expired buff", () => {
        const names = [...TIER1_ARTIFACT_LIST, ...TIER2_ARTIFACT_LIST]
            .map((artifact) => artifact.buffName)
            .filter(Boolean);
        names.push(
            "Armor Augment",
            "Angelic Host Blessing",
            "Arcane Ward Blessing",
            "Warding Mane Blessing",
            "Arrows Wingshield Blessing",
            "Rallying Volley Blessing",
            "Water Shield",
            "Morale",
            "Hidden",
            "Visible",
        );
        for (const name of names) expect(isTakeableBuff(new AppliedSpell(name, 12, NUMBER_OF_LAPS_TOTAL))).toBe(false);
        expect(isTakeableBuff(new AppliedSpell("Blessing", 12, 0))).toBe(false);
        expect(isTakeableBuff(new AppliedSpell("Blessing", 12, -1))).toBe(false);
        expect(isTakeableBuff(new AppliedSpell("Luck Aura", 12, Number.MAX_SAFE_INTEGER))).toBe(false);
        expect(isTakeableBuff(new AppliedSpell("Made of Fire", 12, NUMBER_OF_LAPS_TOTAL))).toBe(true);
    });

    it("a malformed donor's display arrays cannot cause a partial transfer", () => {
        const f = fixture();
        bless(f.enemy, "Blessing");
        f.enemy.getUnitProperties().applied_buffs_powers.length = 0;
        expect(processBorrowedGraceAbility(f.monk, f.enemy, new SceneLogMock())).toBeUndefined();
        expect(f.enemy.getBuff("Blessing")).toBeDefined();
        expect(f.monk.getBuff("Blessing")).toBeUndefined();
    });

    it("a runtime-granted card and the shared engine card show the current chance", () => {
        const bearer = createTestUnit({ stackPower: 2, luck: 10 });
        bearer.grantAbility("Borrowed Grace");
        const index = bearer.getUnitProperties().abilities.indexOf("Borrowed Grace");
        expect(bearer.getUnitProperties().abilities_descriptions[index]).toContain("42.5% chance");
        bearer.setStackPower(4);
        bearer.adjustBaseStats(false, 1, 8, 0, 0, 0, 0, 0);
        const chance = borrowedGraceChance(bearer, 8);
        expect(bearer.getUnitProperties().abilities_descriptions[index]).toContain(`${chance}% chance`);
    });
});
