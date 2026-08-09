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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates } from "../../src/ai/candidates";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import {
    buildV08BacklineWardIntent,
    preservesV08BacklineWardIntent,
} from "../../src/ai/versions/v0_8_backline_protector";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

function makeNative(team: number, faction: string, name: string, amount: number): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function placeCombatUnit(combat: CombatTestContext, unit: Unit, base: XY): void {
    if (unit.isSmallSize()) {
        placeUnit(combat.grid, combat.unitsHolder, unit, base);
        return;
    }
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error("invalid large-unit placement");
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function decisionContext(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

function castAction(actions: readonly GameAction[]): Extract<GameAction, { type: "cast_spell" }> | undefined {
    return actions.find(
        (action): action is Extract<GameAction, { type: "cast_spell" }> => action.type === "cast_spell",
    );
}

function applyCast(
    combat: CombatTestContext,
    caster: Unit,
    context: IDecisionContext,
    action: Extract<GameAction, { type: "cast_spell" }>,
): boolean {
    const fightProperties = context.fightProperties!;
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(caster.getTeam(), 1_000);
    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => caster.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    });
    return engine.apply(action).completed;
}

function enemy(name: string, magicResist = 0): Unit {
    return createTestUnit({
        team: UPPER,
        name,
        attackType: MELEE,
        maxHp: 1_000,
        magicResist,
    });
}

function spell(unit: Unit, name: string) {
    const found = unit.getSpells().find((entry) => entry.getName() === name);
    if (!found) throw new Error(`${unit.getName()} does not have ${name}`);
    return found;
}

describe("v0.8 damage-spell policy", () => {
    it("Battle Mage and the v0.8s alias cast Fire Strike instead of walking when it is the best legal hit", () => {
        const combat = createCombatTestContext();
        const mage = makeNative(LOWER, "Life", "Battle Mage", 5);
        const target = enemy("Single target");
        placeCombatUnit(combat, mage, { x: 2, y: 2 });
        placeCombatUnit(combat, target, { x: 10, y: 10 });
        const context = decisionContext(combat);

        const production = castAction(new StrategyV0_8().decideTurn(mage, context));
        const alias = castAction(new StrategyV0_8S().decideTurn(mage, context));
        expect(production).toMatchObject({ spellName: "Fire Strike", targetId: target.getId() });
        expect(alias).toMatchObject({ spellName: "Fire Strike", targetId: target.getId() });

        const fireStrike = spell(mage, "Fire Strike");
        expect(fireStrike.getAmount()).toBe(3);
        const hpBefore = target.getCumulativeHp();
        expect(applyCast(combat, mage, context, production!)).toBe(true);
        expect(fireStrike.getAmount()).toBe(2);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("Battle Mage spends Meteorite on a stronger cluster, then falls back to Fire Strike when it is exhausted", () => {
        const setup = () => {
            const combat = createCombatTestContext();
            const mage = makeNative(LOWER, "Life", "Battle Mage", 5);
            const first = enemy("Meteorite first");
            const second = enemy("Meteorite second");
            placeCombatUnit(combat, mage, { x: 2, y: 2 });
            placeCombatUnit(combat, first, { x: 9, y: 9 });
            placeCombatUnit(combat, second, { x: 10, y: 10 });
            return { combat, mage, first, second, context: decisionContext(combat) };
        };

        const clustered = setup();
        const meteorite = castAction(new StrategyV0_8().decideTurn(clustered.mage, clustered.context));
        expect(meteorite?.spellName).toBe("Meteorite");
        const meteoriteCharge = spell(clustered.mage, "Meteorite");
        expect(meteoriteCharge.getAmount()).toBe(1);
        const firstHp = clustered.first.getCumulativeHp();
        const secondHp = clustered.second.getCumulativeHp();
        expect(applyCast(clustered.combat, clustered.mage, clustered.context, meteorite!)).toBe(true);
        expect(meteoriteCharge.getAmount()).toBe(0);
        expect(clustered.first.getCumulativeHp()).toBeLessThan(firstHp);
        expect(clustered.second.getCumulativeHp()).toBeLessThan(secondHp);

        const depleted = setup();
        spell(depleted.mage, "Meteorite").setAmount(0);
        expect(castAction(new StrategyV0_8().decideTurn(depleted.mage, depleted.context))?.spellName).toBe(
            "Fire Strike",
        );
    });

    it("Battle Mage never proposes a depleted Meteorite or a blocked Fire Strike", () => {
        const combat = createCombatTestContext();
        const mage = makeNative(LOWER, "Life", "Battle Mage", 5);
        // An ENEMY screen — a friendly one is transparent, the mage arcs the throw over its own troops.
        const blocker = createTestUnit({ team: UPPER, name: "Line blocker", attackType: MELEE });
        const target = enemy("Blocked target");
        placeCombatUnit(combat, mage, { x: 2, y: 2 });
        placeCombatUnit(combat, blocker, { x: 5, y: 2 });
        placeCombatUnit(combat, target, { x: 9, y: 2 });
        spell(mage, "Meteorite").setAmount(0);

        const decision = new StrategyV0_8().decideTurn(mage, decisionContext(combat));
        expect(castAction(decision)).toBeUndefined();
        expect(decision.some((action) => action.type === "move_unit")).toBe(true);
    });

    it("conserves a finite damage charge when the selected physical hit is equal or stronger", () => {
        for (const setup of [
            { label: "equal", attack: 10, damage: 6, targetArmor: 10 },
            { label: "stronger", attack: 100, damage: 100, targetArmor: 0 },
        ]) {
            const combat = createCombatTestContext();
            const hybrid = createTestUnit({
                team: LOWER,
                name: `${setup.label} hybrid`,
                attackType: PBTypes.AttackVals.MELEE_MAGIC,
                attack: setup.attack,
                damageMin: setup.damage,
                damageMax: setup.damage,
                spells: ["Life:Fire Strike"],
                stackPower: 5,
            });
            const target = createTestUnit({
                team: UPPER,
                name: `${setup.label} adjacent target`,
                attackType: MELEE,
                armor: setup.targetArmor,
                maxHp: 1_000,
            });
            placeCombatUnit(combat, hybrid, { x: 5, y: 5 });
            placeCombatUnit(combat, target, { x: 5, y: 6 });

            const fireStrike = spell(hybrid, "Fire Strike");
            const decision = new StrategyV0_8().decideTurn(hybrid, decisionContext(combat));
            expect(castAction(decision)).toBeUndefined();
            expect(decision.some((action) => action.type === "melee_attack")).toBe(true);
            expect(fireStrike.getAmount()).toBe(1);
        }
    });

    it("conserves a finite spell when both the physical hit and its overkill would kill the target", () => {
        const combat = createCombatTestContext();
        const hybrid = createTestUnit({
            team: LOWER,
            name: "Overkill hybrid",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            attack: 100,
            damageMin: 100,
            damageMax: 100,
            spells: ["Life:Fire Strike"],
            stackPower: 5,
        });
        const target = createTestUnit({
            team: UPPER,
            name: "One HP adjacent target",
            attackType: MELEE,
            armor: 0,
            maxHp: 1,
        });
        placeCombatUnit(combat, hybrid, { x: 5, y: 5 });
        placeCombatUnit(combat, target, { x: 5, y: 6 });

        const candidates = enumerateCandidates(hybrid, decisionContext(combat), [], {
            enrichIncumbentMetadata: true,
        }).candidates;
        const fireStrike = candidates.find(
            (candidate) =>
                candidate.kind === "spell" &&
                candidate.actions.some((action) => action.type === "cast_spell" && action.spellName === "Fire Strike"),
        );
        expect(fireStrike?.features).toMatchObject({ expectedDamage: 1, expectedKill: 1 });

        const charge = spell(hybrid, "Fire Strike");
        const decision = new StrategyV0_8().decideTurn(hybrid, decisionContext(combat));
        expect(castAction(decision)).toBeUndefined();
        expect(decision.some((action) => action.type === "melee_attack")).toBe(true);
        expect(charge.getAmount()).toBe(1);
    });

    it("overrides the selected adjacent physical hit when Fire Strike is strictly better", () => {
        const combat = createCombatTestContext();
        const hybrid = createTestUnit({
            team: LOWER,
            name: "Weak hybrid",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            attack: 10,
            damageMin: 1,
            damageMax: 1,
            spells: ["Life:Fire Strike"],
            stackPower: 5,
        });
        const target = createTestUnit({
            team: UPPER,
            name: "Durable adjacent target",
            attackType: MELEE,
            armor: 10,
            maxHp: 1_000,
        });
        placeCombatUnit(combat, hybrid, { x: 5, y: 5 });
        placeCombatUnit(combat, target, { x: 5, y: 6 });
        const context = decisionContext(combat);

        expect(new StrategyV0_7().decideTurn(hybrid, context).some((action) => action.type === "melee_attack")).toBe(
            true,
        );
        expect(castAction(new StrategyV0_8().decideTurn(hybrid, context))).toMatchObject({
            spellName: "Fire Strike",
            targetId: target.getId(),
        });
    });

    it("Magic Dragon picks Lightning Strike for one target and executes the called-down cast", () => {
        const combat = createCombatTestContext();
        const dragon = makeNative(LOWER, "Nature", "Magic Dragon", 1);
        const target = enemy("Lightning target");
        placeCombatUnit(combat, dragon, { x: 3, y: 3 });
        placeCombatUnit(combat, target, { x: 10, y: 10 });
        const context = decisionContext(combat);

        const decision = castAction(new StrategyV0_8().decideTurn(dragon, context));
        expect(decision).toMatchObject({ spellName: "Lightning Strike", targetId: target.getId() });
        const lightning = spell(dragon, "Lightning Strike");
        expect(lightning.getAmount()).toBe(4);
        const hpBefore = target.getCumulativeHp();
        expect(applyCast(combat, dragon, context, decision!)).toBe(true);
        expect(lightning.getAmount()).toBe(3);
        expect(hpBefore - target.getCumulativeHp()).toBe(150);
    });

    it("Magic Dragon ranks Meteor Shower, Ring of Fire, then Lightning as cluster charges run out", () => {
        const setup = () => {
            const combat = createCombatTestContext();
            const dragon = makeNative(LOWER, "Nature", "Magic Dragon", 1);
            const aim = enemy("Cluster aim");
            const first = enemy("Cluster first");
            const second = enemy("Cluster second");
            placeCombatUnit(combat, dragon, { x: 3, y: 3 });
            placeCombatUnit(combat, aim, { x: 9, y: 9 });
            placeCombatUnit(combat, first, { x: 8, y: 9 });
            placeCombatUnit(combat, second, { x: 9, y: 8 });
            return { combat, dragon, aim, first, second, context: decisionContext(combat) };
        };

        const showerSetup = setup();
        const shower = castAction(new StrategyV0_8().decideTurn(showerSetup.dragon, showerSetup.context));
        expect(shower?.spellName).toBe("Meteor Shower");
        const showerCharge = spell(showerSetup.dragon, "Meteor Shower");
        const hpBefore = [showerSetup.aim, showerSetup.first, showerSetup.second].map((unit) => unit.getCumulativeHp());
        expect(applyCast(showerSetup.combat, showerSetup.dragon, showerSetup.context, shower!)).toBe(true);
        expect(showerCharge.getAmount()).toBe(0);
        expect([showerSetup.aim, showerSetup.first, showerSetup.second].map((unit) => unit.getCumulativeHp())).toEqual(
            // Meteor Shower at power 21.6: 1 dragon x stack power 5 x 21.6, floored.
            hpBefore.map((hp) => hp - 108),
        );

        const ringSetup = setup();
        spell(ringSetup.dragon, "Meteor Shower").setAmount(0);
        const ring = castAction(new StrategyV0_8().decideTurn(ringSetup.dragon, ringSetup.context));
        expect(ring?.spellName).toBe("Ring of Fire");
        const ringCharge = spell(ringSetup.dragon, "Ring of Fire");
        expect(ringCharge.getAmount()).toBe(2);
        expect(applyCast(ringSetup.combat, ringSetup.dragon, ringSetup.context, ring!)).toBe(true);
        expect(ringCharge.getAmount()).toBe(1);

        const lightningSetup = setup();
        spell(lightningSetup.dragon, "Meteor Shower").setAmount(0);
        spell(lightningSetup.dragon, "Ring of Fire").setAmount(0);
        expect(
            castAction(new StrategyV0_8().decideTurn(lightningSetup.dragon, lightningSetup.context))?.spellName,
        ).toBe("Lightning Strike");
    });

    it("rejects a friendly-fire-negative Ring candidate and casts Lightning instead", () => {
        const combat = createCombatTestContext();
        const dragon = makeNative(LOWER, "Nature", "Magic Dragon", 1);
        const ally = createTestUnit({ team: LOWER, name: "Ring-exposed ally", attackType: MELEE, maxHp: 1_000 });
        const aim = enemy("Ring aim");
        placeCombatUnit(combat, dragon, { x: 3, y: 3 });
        placeCombatUnit(combat, aim, { x: 9, y: 9 });
        placeCombatUnit(combat, ally, { x: 9, y: 8 });
        const context = decisionContext(combat);

        const ring = enumerateCandidates(
            dragon,
            context,
            [{ type: "end_turn", unitId: dragon.getId(), reason: "manual" }],
            { enrichIncumbentMetadata: true },
        ).candidates.find((candidate) => candidate.spellName === "Ring of Fire");
        expect(ring?.features.expectedDamage).toBeLessThan(0);
        expect(castAction(new StrategyV0_8().decideTurn(dragon, context))).toMatchObject({
            spellName: "Lightning Strike",
            targetId: aim.getId(),
        });
    });

    it("does not treat Whirlpool as damage and falls back without an illegal immune cast", () => {
        const combat = createCombatTestContext();
        const dragon = makeNative(LOWER, "Nature", "Magic Dragon", 1);
        const immune = enemy("Magic-immune target", 100);
        placeCombatUnit(combat, dragon, { x: 3, y: 3 });
        placeCombatUnit(combat, immune, { x: 10, y: 10 });

        const decision = new StrategyV0_8().decideTurn(dragon, decisionContext(combat));
        expect(castAction(decision)).toBeUndefined();
        expect(decision.some((action) => action.type === "move_unit")).toBe(true);
        expect(spell(dragon, "Whirlpool").getAmount()).toBe(1);
    });

    it("leaves an existing pure-MAGIC beneficial cast byte-identical", () => {
        const combat = createCombatTestContext();
        const healer = makeNative(LOWER, "Life", "Healer", 5);
        const wounded = createTestUnit({ team: LOWER, name: "Wounded ally", attackType: MELEE, maxHp: 100 });
        const target = enemy("Distant enemy");
        wounded.applyDamage(50, 0, new SceneLogMock());
        placeCombatUnit(combat, healer, { x: 2, y: 2 });
        placeCombatUnit(combat, wounded, { x: 3, y: 2 });
        placeCombatUnit(combat, target, { x: 10, y: 10 });
        const context = decisionContext(combat);

        const inherited = new StrategyV0_7().decideTurn(healer, context);
        const production = new StrategyV0_8().decideTurn(healer, context);
        expect(castAction(inherited)?.spellName).toBe("Spiritual Armor");
        expect(production).toEqual(inherited);
    });

    it("lets Battle Mage cast while its stationary turn remains inside an Abomination ward", () => {
        const combat = createCombatTestContext();
        const mage = makeNative(LOWER, "Life", "Battle Mage", 5);
        const abomination = createTestUnit({ team: LOWER, name: "Abomination", attackType: MELEE });
        const target = enemy("Ward-safe target");
        placeCombatUnit(combat, abomination, { x: 5, y: 4 });
        placeCombatUnit(combat, mage, { x: 5, y: 5 });
        placeCombatUnit(combat, target, { x: 10, y: 10 });
        const context = decisionContext(combat);
        const intent = buildV08BacklineWardIntent(mage, context);

        expect(intent?.protector).toBe(abomination);
        const decision = new StrategyV0_8().decideTurn(mage, context);
        expect(castAction(decision)?.spellName).toBe("Fire Strike");
        expect(decision.some((action) => action.type === "move_unit")).toBe(false);
        expect(preservesV08BacklineWardIntent(intent!, mage, context, decision)).toBe(true);
    });

    it("uses only exact remaining charges when the two spellbooks are acquired at runtime", () => {
        const cases = [
            {
                ability: "Basic Tome of Battle Magic",
                entries: ["Life:Meteorite"],
                expected: "Meteorite",
            },
            {
                ability: "Tome of Elements",
                entries: ["Nature:Ring of Fire", "Nature:Ring of Fire"],
                expected: "Ring of Fire",
            },
        ] as const;

        for (const testCase of cases) {
            const combat = createCombatTestContext();
            const queen = makeNative(LOWER, "Nature", "Arachna Queen", 1);
            queen.grantStolenAbility(testCase.ability, [...testCase.entries]);
            const aim = enemy(`${testCase.expected} aim`);
            const victim = enemy(`${testCase.expected} victim`);
            placeCombatUnit(combat, queen, { x: 3, y: 3 });
            placeCombatUnit(combat, aim, { x: 9, y: 9 });
            placeCombatUnit(combat, victim, { x: 8, y: 9 });
            const context = decisionContext(combat);

            expect(queen.getSpells().map((entry) => entry.getName())).toEqual([testCase.expected]);
            const remaining = spell(queen, testCase.expected);
            expect(remaining.getAmount()).toBe(testCase.entries.length);
            const decision = castAction(new StrategyV0_8().decideTurn(queen, context));
            expect(decision?.spellName).toBe(testCase.expected);
            expect(applyCast(combat, queen, context, decision!)).toBe(true);
            expect(remaining.getAmount()).toBe(testCase.entries.length - 1);
        }
    });
});
