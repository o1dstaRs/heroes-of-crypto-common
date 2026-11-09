import { afterEach, describe, expect, test } from "bun:test";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { evaluateAffectedUnits } from "../../src/abilities/aoe_range_ability";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { battleMageTargetsEnabled, V08_BATTLE_MAGE_TARGETS_ENV } from "../../src/ai/battle_mage_targets";
import { enumerateCandidates } from "../../src/ai/candidates";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { makeRng } from "../../src/simulation/army";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { cellTargetedSpellBlockCells } from "../../src/spells/spell_helper";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type TestUnitOptions,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;
const savedGate = process.env[V08_BATTLE_MAGE_TARGETS_ENV];
afterEach(() => {
    if (savedGate === undefined) delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
    else process.env[V08_BATTLE_MAGE_TARGETS_ENV] = savedGate;
});

function fixture(team: TeamType = LEFT) {
    const combat = createCombatTestContext();
    const effects = new EffectFactory();
    const mage = Unit.createUnit(
        getCreatureConfig(team, "Life", "Battle Mage", "", 10),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
    const map = (cell: XY) => (team === LEFT ? cell : { x: 15 - cell.x, y: cell.y });
    placeUnit(combat.grid, combat.unitsHolder, mage, map({ x: 1, y: 7 }));
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    const add = (cell: XY, options: TestUnitOptions = {}) => {
        const u = createTestUnit({ team: enemyTeam, name: "Target", maxHp: 100, exp: 10, ...options });
        placeUnit(combat.grid, combat.unitsHolder, u, map(cell));
        return u;
    };
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setSideOrientedPlacement(true);
    let active = mage.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active,
    };
    const engine = new GameActionEngine(engineContext);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties,
        decisionOrigin: "root",
    };
    const deps = {
        ...combat,
        engine,
        fightProperties,
        pathHelper: context.pathHelper,
        turnEngine: new TurnEngine(engineContext),
        getActiveUnitId: () => active,
        setActiveUnitId: (id: string) => {
            active = id;
        },
        strategyForTeam: () => getAIStrategy("v0.8"),
        damageDealtThisLap: () => false,
        captureDamageStats: () => [...combat.damageStatisticHolder.get()],
        restoreDamageStats: (rows: ReturnType<typeof combat.damageStatisticHolder.get>) => {
            combat.damageStatisticHolder.clear();
            for (const row of rows) combat.damageStatisticHolder.add(row);
        },
    };
    const start = () => {
        expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
        fightProperties.startTurn(team, 1_000);
        mage.setStackPower(5);
        context.matrix = combat.grid.getMatrix();
    };
    const catalog = (coverage = true) =>
        enumerateCandidates(mage, context, [], {
            maxMoveDestinations: 1,
            maxMeleePairs: 8,
            maxShotAims: 6,
            preserveMeteoriteTargetCoverage: coverage,
        }).candidates.filter((c) => c.spellName === "Meteorite");
    const victims = (action: GameAction) => {
        if (action.type !== "cast_spell" || !action.targetCell) return [];
        return (
            evaluateAffectedUnits(
                cellTargetedSpellBlockCells(action.spellName, action.targetCell),
                combat.unitsHolder,
                combat.grid,
                false,
            )?.[0] ?? []
        )
            .filter((u) => u.getTeam() === enemyTeam)
            .map((u) => u.getId());
    };
    return { ...combat, mage, add, start, catalog, victims, context, deps, engine, team, enemyTeam };
}

describe("Battle Mage target coverage", () => {
    test("retains distinct impacts, including a lower-damage isolated target, without duplicate footprints", () => {
        const f = fixture();
        f.add({ x: 9, y: 3 });
        f.add({ x: 10, y: 3 });
        const isolated = f.add({ x: 12, y: 10 }, { maxHp: 30, size: PBTypes.UnitSizeVals.LARGE });
        f.start();
        const old = f.catalog(false),
            wide = f.catalog();
        expect(old).toHaveLength(1);
        expect(wide[0].actions).toEqual(old[0].actions);
        expect(wide.some((c) => f.victims(c.actions[0]).includes(isolated.getId()))).toBe(true);
        const signatures = wide.map((c) => JSON.stringify(f.victims(c.actions[0])));
        expect(new Set(signatures).size).toBe(signatures.length);
        expect(wide.find((c) => f.victims(c.actions[0]).includes(isolated.getId()))!.features.expectedDamage).toBe(30);
    });

    test("every impact applies in the engine with exact projected enemy HP damage and one consumed charge", () => {
        const f = fixture();
        f.add({ x: 9, y: 3 }, { magicResist: 50 });
        f.add({ x: 10, y: 3 });
        f.add({ x: 12, y: 10 }, { maxHp: 20 });
        f.start();
        const root = snapshotBattle(f.unitsHolder, f.grid, f.context.fightProperties!);
        for (const c of f.catalog()) {
            const before = [...f.unitsHolder.getAllUnits().values()]
                .filter((u) => u.getTeam() === f.enemyTeam)
                .reduce((sum, u) => sum + u.getCumulativeHp(), 0);
            const result = f.engine.apply(c.actions[0]);
            expect(result.completed).toBe(true);
            const after = [...f.unitsHolder.getAllUnits().values()]
                .filter((u) => u.getTeam() === f.enemyTeam)
                .reduce((sum, u) => sum + u.getCumulativeHp(), 0);
            expect(before - after).toBe(c.features.expectedDamage);
            expect(
                f.mage
                    .getSpells()
                    .find((s) => s.getName() === "Meteorite")!
                    .getAmount(),
            ).toBe(0);
            restoreBattle(root, f.unitsHolder, f.grid, f.context.fightProperties!);
        }
    });

    test("retains a Water Shield break but excludes purely earth-immune impacts", () => {
        const f = fixture();
        const shield = f.add({ x: 9, y: 3 }, { abilities: ["Water Shield"] });
        const immune = f.add({ x: 12, y: 10 }, { abilities: ["Earth Element"] });
        f.start();
        const choices = f.catalog();
        expect(choices).toHaveLength(1);
        expect(f.victims(choices[0].actions[0])).toEqual([shield.getId()]);
        expect(choices[0].features.expectedDamage).toBe(0);
        expect(f.engine.apply(choices[0].actions[0]).completed).toBe(true);
        expect(shield.hasBuffActive("Water Shield")).toBe(false);
        expect(immune.getCumulativeHp()).toBe(100);
    });

    test("hidden enemies neither create anchors nor alter the visible catalog", () => {
        const f = fixture();
        f.add({ x: 9, y: 3 });
        f.start();
        const before = f.catalog().map((c) => ({ actions: c.actions, features: c.features }));
        f.add({ x: 10, y: 3 }).applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Hidden"), amount: 1 }));
        f.add({ x: 12, y: 10 }).applyBuff(
            new Spell({ spellProperties: getSpellConfig("System", "Hidden"), amount: 1 }),
        );
        const after = f.catalog().map((c) => ({ actions: c.actions, features: c.features }));
        expect(after.map((c) => c.actions)).toEqual(before.map((c) => c.actions));
        expect(after.map((c) => c.features.expectedDamage)).toEqual(before.map((c) => c.features.expectedDamage));
    });

    test.each([LEFT, RIGHT])(
        "full default A19 can kill the dangerous fire-immune shooter instead of hitting the larger decoy cluster, seat %s",
        (team) => {
            const random = captureDeterministicRandomState();
            setDeterministicRandomSource(makeRng(20261109));
            try {
                delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
                const f = fixture(team);
                f.add({ x: 9, y: 2 }, { exp: 1, damageMin: 0, damageMax: 0 });
                f.add({ x: 10, y: 2 }, { exp: 1, damageMin: 0, damageMax: 0 });
                const threat = f.add(
                    { x: 12, y: 11 },
                    {
                        name: "Fire shooter",
                        maxHp: 30,
                        exp: 1000,
                        attackType: PBTypes.AttackVals.RANGE,
                        rangeShots: 20,
                        attack: 100,
                        damageMin: 200,
                        damageMax: 200,
                        abilities: ["Fire Element"],
                    },
                );
                f.start();
                const driver = createV08A19SearchDriver(f.deps, {
                    greenVersion: "v0.8",
                    redVersion: "v0.8",
                    seed: 20261109,
                    offlineDeterministicWork: true,
                });
                driver.onFightReady();
                const before = snapshotBattle(f.unitsHolder, f.grid, f.context.fightProperties!);
                const rngBefore = captureDeterministicRandomState();
                process.env[V08_BATTLE_MAGE_TARGETS_ENV] = "off";
                const control = createV08A19SearchDriver(f.deps, {
                    greenVersion: "v0.8",
                    redVersion: "v0.8",
                    seed: 20261109,
                    offlineDeterministicWork: true,
                });
                control.onFightReady();
                const oldDecision = control.chooseDecision(
                    f.mage,
                    "v0.8",
                    getAIStrategy("v0.8").decideTurn(f.mage, f.context),
                    f.context,
                );
                expect(f.victims(oldDecision[0])).not.toContain(threat.getId());
                delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
                const decision = driver.chooseDecision(
                    f.mage,
                    "v0.8",
                    getAIStrategy("v0.8").decideTurn(f.mage, f.context),
                    f.context,
                );
                expect(decision[0]).toMatchObject({ type: "cast_spell", spellName: "Meteorite" });
                expect(f.victims(decision[0])).toContain(threat.getId());
                expect(snapshotBattle(f.unitsHolder, f.grid, f.context.fightProperties!)).toEqual(before);
                expect(captureDeterministicRandomState()).toEqual(rngBefore);
                expect(f.engine.apply(decision[0]).completed).toBe(true);
                expect(threat.isDead()).toBe(true);
            } finally {
                restoreDeterministicRandomState(random);
            }
        },
    );

    test("search can exclude a neighboring Magic Mirror from a lethal Meteorite", () => {
        const random = captureDeterministicRandomState();
        setDeterministicRandomSource(makeRng(20261109));
        try {
            delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
            const f = fixture();
            const mirror = f.add(
                { x: 11, y: 10 },
                { exp: 1, damageMin: 0, damageMax: 0, abilities: ["Magic Reflection"] },
            );
            const threat = f.add(
                { x: 12, y: 11 },
                {
                    name: "Fire shooter",
                    maxHp: 30,
                    exp: 1000,
                    attackType: PBTypes.AttackVals.RANGE,
                    rangeShots: 20,
                    attack: 100,
                    damageMin: 200,
                    damageMax: 200,
                    abilities: ["Fire Element"],
                },
            );
            f.start();
            mirror.setStackPower(5);
            const driver = createV08A19SearchDriver(f.deps, {
                greenVersion: "v0.8",
                redVersion: "v0.8",
                seed: 20261109,
                offlineDeterministicWork: true,
            });
            driver.onFightReady();
            const root = snapshotBattle(f.unitsHolder, f.grid, f.context.fightProperties!);
            const hp = f.mage.getCumulativeHp();
            expect(f.engine.apply(f.catalog(false)[0].actions[0]).completed).toBe(true);
            expect(f.mage.getCumulativeHp()).toBeLessThan(hp);
            restoreBattle(root, f.unitsHolder, f.grid, f.context.fightProperties!);
            const decision = driver.chooseDecision(
                f.mage,
                "v0.8",
                getAIStrategy("v0.8").decideTurn(f.mage, f.context),
                f.context,
            );
            expect(f.victims(decision[0])).toEqual([threat.getId()]);
            expect(f.engine.apply(decision[0]).completed).toBe(true);
            expect(threat.isDead()).toBe(true);
            expect(f.mage.getCumulativeHp()).toBe(hp);
        } finally {
            restoreDeterministicRandomState(random);
        }
    });

    test("spent Meteorite and insufficient stack power do not create extra choices", () => {
        const f = fixture();
        f.add({ x: 9, y: 3 });
        f.start();
        f.mage.setStackPower(4);
        expect(f.catalog()).toHaveLength(0);
        f.mage.setStackPower(5);
        f.mage
            .getSpells()
            .find((s) => s.getName() === "Meteorite")!
            .setAmount(0);
        expect(f.catalog()).toHaveLength(0);
    });

    test("seat switch covers only Battle Mage and permits exact old-policy controls", () => {
        const f = fixture();
        expect(battleMageTargetsEnabled(f.mage)).toBe(true);
        process.env[V08_BATTLE_MAGE_TARGETS_ENV] = "off";
        expect(battleMageTargetsEnabled(f.mage)).toBe(false);
        process.env[V08_BATTLE_MAGE_TARGETS_ENV] = "red";
        expect(battleMageTargetsEnabled(f.mage)).toBe(false);
        process.env[V08_BATTLE_MAGE_TARGETS_ENV] = "green";
        expect(battleMageTargetsEnabled(f.mage)).toBe(true);
        expect(battleMageTargetsEnabled(f.add({ x: 9, y: 3 }, { name: "Magic Dragon" }))).toBe(false);
    });
});
