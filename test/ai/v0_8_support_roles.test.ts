import { afterEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { enumerateCandidates, findBestLegalStationaryRangeAttack } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { V08_NIGHTMARE_ROLE_VERSIONS_ENV, V08_SUPPORT_ROLE_VERSIONS_ENV } from "../../src/ai/versions/v0_8";
import { isV08DurableHealAnchor, prioritizeV08HealerSustain } from "../../src/ai/versions/v0_8_support_roles";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
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
const RANGE = PBTypes.AttackVals.RANGE;
const savedNightmareScope = process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV];
const savedSupportScope = process.env[V08_SUPPORT_ROLE_VERSIONS_ENV];

afterEach(() => {
    if (savedNightmareScope === undefined) delete process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV];
    else process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV] = savedNightmareScope;
    if (savedSupportScope === undefined) delete process.env[V08_SUPPORT_ROLE_VERSIONS_ENV];
    else process.env[V08_SUPPORT_ROLE_VERSIONS_ENV] = savedSupportScope;
});

function nativeUnit(team: number, faction: string, name: string, amount: number): Unit {
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

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

const cast = (actions: readonly GameAction[]) =>
    actions.find((action): action is Extract<GameAction, { type: "cast_spell" }> => action.type === "cast_spell");

function startEngine(combat: CombatTestContext, active: Unit, context: IDecisionContext): GameActionEngine {
    const fightProperties = context.fightProperties!;
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(active.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => active.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    });
}

describe("v0.8 Ash Moth anti-ranged role", () => {
    test("promotes a net-positive Smoke cloud to the native decision", () => {
        const combat = createCombatTestContext();
        const moth = nativeUnit(LOWER, "Chaos", "Ash Moth", 50);
        const ally = createTestUnit({ team: LOWER, name: "Screened melee", attackType: MELEE, amountAlive: 30 });
        const ranger = createTestUnit({
            team: UPPER,
            name: "Enemy ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 20,
        });
        placeUnit(combat.grid, combat.unitsHolder, moth, { x: 2, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 2, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, ranger, { x: 13, y: 8 });

        expect(cast(getAIStrategy("v0.8").decideTurn(moth, contextFor(combat)))?.spellName).toBe("Smoke");
        process.env[V08_SUPPORT_ROLE_VERSIONS_ENV] = "v0.8";
        expect(cast(getAIStrategy("v0.8").decideTurn(moth, contextFor(combat)))?.spellName).toBe("Smoke");
        expect(cast(getAIStrategy("v0.8s").decideTurn(moth, contextFor(combat)))?.spellName).not.toBe("Smoke");
    });

    test("routes Smoke away from a stronger friendly firing line", () => {
        const combat = createCombatTestContext();
        const moth = nativeUnit(LOWER, "Chaos", "Ash Moth", 50);
        const friendlyRanger = createTestUnit({
            team: LOWER,
            name: "Friendly ranger",
            attackType: RANGE,
            rangeShots: 12,
            damageMax: 30,
            amountAlive: 30,
        });
        const enemyRanger = createTestUnit({
            team: UPPER,
            name: "Enemy ranger",
            attackType: RANGE,
            rangeShots: 4,
            damageMax: 10,
            amountAlive: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, moth, { x: 2, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, friendlyRanger, { x: 2, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, enemyRanger, { x: 13, y: 8 });
        const context = contextFor(combat);
        const candidates = enumerateCandidates(moth, context, [
            { type: "end_turn", unitId: moth.getId(), reason: "manual" },
        ]).candidates;

        const smoke = candidates.find((candidate) => candidate.spellName === "Smoke");
        expect(smoke?.targetCell).toBeDefined();
        const smokeCells = [
            smoke!.targetCell!,
            { x: smoke!.targetCell!.x + 1, y: smoke!.targetCell!.y },
            { x: smoke!.targetCell!.x, y: smoke!.targetCell!.y + 1 },
            { x: smoke!.targetCell!.x + 1, y: smoke!.targetCell!.y + 1 },
        ];
        const friendlyBefore = findBestLegalStationaryRangeAttack(friendlyRanger, context)?.expectedDamage;
        const friendlyAfter = findBestLegalStationaryRangeAttack(friendlyRanger, context, smokeCells)?.expectedDamage;
        expect(friendlyAfter).toBe(friendlyBefore);
        expect(cast(getAIStrategy("v0.8").decideTurn(moth, context))?.spellName).toBe("Smoke");
    });
});

describe("v0.8 Nightmare roadblock role", () => {
    test("promotes and executes a threat-aware Fire Wall over a pure advance", () => {
        const combat = createCombatTestContext();
        const nightmare = nativeUnit(LOWER, "Chaos", "Nightmare", 20);
        nightmare.setStackPower(5);
        const threat = createTestUnit({
            team: UPPER,
            name: "Approaching threat",
            attackType: MELEE,
            initiative: 6,
            damageMax: 20,
            amountAlive: 20,
        });
        placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 7, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, threat, { x: 7, y: 12 });
        const context = contextFor(combat);

        expect(new StrategyV0_7().decideTurn(nightmare, context).some((action) => action.type === "move_unit")).toBe(
            true,
        );
        const decision = cast(getAIStrategy("v0.8").decideTurn(nightmare, context));
        expect(decision).toMatchObject({ spellName: "Fire Wall" });
        expect(decision?.targetCell).toBeDefined();

        process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV] = "v0.8";
        expect(cast(getAIStrategy("v0.8").decideTurn(nightmare, context))?.spellName).toBe("Fire Wall");
        expect(cast(getAIStrategy("v0.8s").decideTurn(nightmare, context))?.spellName).not.toBe("Fire Wall");

        const result = startEngine(combat, nightmare, context).apply(decision!);
        expect(result.completed).toBe(true);
        expect(context.fightProperties!.getFireWalls().size()).toBe(3);
    });

    test("keeps an immediate melee attack instead of spending the wall", () => {
        const combat = createCombatTestContext();
        const nightmare = nativeUnit(LOWER, "Chaos", "Nightmare", 20);
        nightmare.setStackPower(5);
        const target = createTestUnit({ team: UPPER, name: "Reachable enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 7, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 8 });

        const decision = getAIStrategy("v0.8").decideTurn(nightmare, contextFor(combat));
        expect(cast(decision)?.spellName).not.toBe("Fire Wall");
        expect(decision.some((action) => action.type === "melee_attack")).toBe(true);
    });
});

describe("v0.8 Healer durable-anchor role", () => {
    test("does not mistake a pre-damage lethal melee for a safe action over healing", () => {
        const combat = createCombatTestContext();
        const healer = createTestUnit({
            team: LOWER,
            name: "Healer",
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 20,
            stackPower: 4,
            spells: ["Life:Heal"],
        });
        const abomination = nativeUnit(LOWER, "Chaos", "Abomination", 1);
        const target = createTestUnit({
            team: UPPER,
            name: "Fragile responder",
            attackType: MELEE,
            maxHp: 1,
            amountAlive: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, abomination, { x: 3, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 4, y: 5 });
        abomination.applyDamage(20, 0, new SceneLogMock());
        const context = contextFor(combat);
        const lethal: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: healer.getId(),
                targetId: target.getId(),
                attackFrom: healer.getBaseCell(),
            },
        ];

        expect(cast(prioritizeV08HealerSustain(healer, context, lethal))?.spellName).toBe("Heal");
        target.setResponded(true);
        expect(prioritizeV08HealerSustain(healer, context, lethal)).toBe(lethal);

        target.grantStolenAbility("Fire Shield");
        expect(cast(prioritizeV08HealerSustain(healer, context, lethal))?.spellName).toBe("Heal");
    });

    test("heals a damaged Abomination before a more-wounded generic stack", () => {
        const combat = createCombatTestContext();
        const healer = nativeUnit(LOWER, "Life", "Healer", 20);
        const abomination = nativeUnit(LOWER, "Chaos", "Abomination", 1);
        const generic = createTestUnit({
            team: LOWER,
            name: "Generic fourth-level",
            attackType: MELEE,
            maxHp: 200,
            amountAlive: 1,
            level: PBTypes.UnitLevelVals.FOURTH,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, abomination, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, generic, { x: 3, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
        abomination.applyDamage(80, 0, new SceneLogMock());
        generic.applyDamage(150, 0, new SceneLogMock());

        const action = cast(getAIStrategy("v0.8").decideTurn(healer, contextFor(combat)));
        expect(action?.spellName).toBe("Heal");
        expect(action?.targetId).toBe(abomination.getId());
    });

    for (const [anchorFaction, anchorName] of [
        ["Might", "Frenzied Boar"],
        ["Chaos", "Goblin Knight"],
    ] as const) {
        test(`sustains ${anchorName} through the same durable-anchor contract`, () => {
            const combat = createCombatTestContext();
            const healer = nativeUnit(LOWER, "Life", "Healer", 20);
            const anchor = nativeUnit(LOWER, anchorFaction, anchorName, 1);
            const generic = createTestUnit({
                team: LOWER,
                name: "Generic target",
                attackType: MELEE,
                maxHp: 300,
                amountAlive: 1,
                level: PBTypes.UnitLevelVals.FOURTH,
            });
            const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
            placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
            placeUnit(combat.grid, combat.unitsHolder, anchor, { x: 6, y: 6 });
            placeUnit(combat.grid, combat.unitsHolder, generic, { x: 3, y: 6 });
            placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
            anchor.applyDamage(80, 0, new SceneLogMock());
            generic.applyDamage(150, 0, new SceneLogMock());

            const action = cast(getAIStrategy("v0.8").decideTurn(healer, contextFor(combat)));
            expect(action?.spellName).toBe("Heal");
            expect(action?.targetId).toBe(anchor.getId());
        });
    }

    test("treats Angel as a sustain anchor only while it screens a real firing line", () => {
        const combat = createCombatTestContext();
        const healer = nativeUnit(LOWER, "Life", "Healer", 20);
        const angel = nativeUnit(LOWER, "Life", "Angel", 1);
        const archer = createTestUnit({
            team: LOWER,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 5,
        });
        const caster = createTestUnit({
            team: LOWER,
            name: "Mage",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
            amountAlive: 5,
        });
        const generic = createTestUnit({
            team: LOWER,
            name: "Generic fourth-level",
            attackType: MELEE,
            maxHp: 300,
            amountAlive: 1,
            level: PBTypes.UnitLevelVals.FOURTH,
        });
        const shooter = createTestUnit({
            team: UPPER,
            name: "Enemy shooter",
            attackType: RANGE,
            rangeShots: 8,
        });
        placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, angel, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, archer, { x: 6, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, caster, { x: 7, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, generic, { x: 3, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 13, y: 13 });
        angel.applyDamage(80, 0, new SceneLogMock());
        generic.applyDamage(150, 0, new SceneLogMock());
        const context = contextFor(combat);

        expect(isV08DurableHealAnchor(angel, context)).toBe(true);
        const action = cast(getAIStrategy("v0.8").decideTurn(healer, context));
        expect(action?.spellName).toBe("Heal");
        expect(action?.targetId).toBe(angel.getId());

        while (shooter.getRangeShots() > 0) shooter.decreaseNumberOfShots();
        expect(isV08DurableHealAnchor(angel, context)).toBe(false);
    });

    test("does not spend Mass Heal for an unhealable Mechanism", () => {
        const combat = createCombatTestContext();
        const healer = nativeUnit(LOWER, "Life", "Healer", 20);
        const abomination = nativeUnit(LOWER, "Chaos", "Abomination", 1);
        const mechanism = createTestUnit({
            team: LOWER,
            name: "Mechanism",
            attackType: RANGE,
            rangeShots: 4,
            maxHp: 300,
            amountAlive: 1,
            abilities: ["Mechanism"],
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, abomination, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, mechanism, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
        abomination.applyDamage(20, 0, new SceneLogMock());
        mechanism.applyDamage(250, 0, new SceneLogMock());

        expect(mechanism.canBeHealed()).toBe(false);
        const action = cast(getAIStrategy("v0.8").decideTurn(healer, contextFor(combat)));
        expect(action?.spellName).toBe("Heal");
        expect(action?.targetId).toBe(abomination.getId());
    });

    test("puts preventative Spiritual Armor on a healthy durable anchor", () => {
        const combat = createCombatTestContext();
        const healer = nativeUnit(LOWER, "Life", "Healer", 20);
        const abomination = nativeUnit(LOWER, "Chaos", "Abomination", 1);
        const damageDealer = createTestUnit({
            team: LOWER,
            name: "Damage dealer",
            attackType: MELEE,
            damageMax: 100,
            maxHp: 100,
            amountAlive: 1,
            level: PBTypes.UnitLevelVals.FOURTH,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, healer, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, abomination, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, damageDealer, { x: 3, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });

        const action = cast(getAIStrategy("v0.8").decideTurn(healer, contextFor(combat)));
        expect(action?.spellName).toBe("Spiritual Armor");
        expect(action?.targetId).toBe(abomination.getId());
    });
});
