import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy } from "../../src/ai";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { v08HealingSpellPower } from "../../src/ai/versions/v0_8_support_roles";
import { Spell } from "../../src/spells/spell";
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
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { chooseHealerSupportDecision } from "../../src/simulation/healer_support_policy";
import { Unit } from "../../src/units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function fixture(team: TeamType = LEFT, side = true) {
    const combat = createCombatTestContext();
    const own: Unit[] = [];
    const add = (name: string, faction: string, amount: number, cell: XY, unitTeam = team, summoned = false) => {
        const effects = new EffectFactory();
        const unit = Unit.createUnit(
            getCreatureConfig(unitTeam, faction, name, "", amount),
            testGridSettings,
            unitTeam,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            summoned,
        );
        unit.setStackPower(5);
        const placed = side
            ? { x: team === LEFT ? cell.x : 15 - cell.x, y: cell.y }
            : { x: cell.y, y: team === LEFT ? cell.x : 15 - cell.x };
        placeUnit(combat.grid, combat.unitsHolder, unit, placed);
        own.push(unit);
        return unit;
    };
    const healer = add("Healer", "Life", 20, { x: 2, y: 7 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setSideOrientedPlacement(side);
    let active = healer.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active,
        createSummonedUnit: ({ amount }: { amount: number }) => {
            const effects = new EffectFactory();
            const wolf = Unit.createUnit(
                getCreatureConfig(team, "Nature", "Wolf", "", amount),
                testGridSettings,
                team,
                PBTypes.UnitVals.CREATURE,
                new AbilityFactory(effects),
                effects,
                true,
            );
            wolf.setStackPower(5);
            return wolf;
        },
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
        restoreDamageStats: (saved: ReturnType<typeof combat.damageStatisticHolder.get>) => {
            combat.damageStatisticHolder.clear();
            for (const row of saved) combat.damageStatisticHolder.add(row);
        },
    };
    const start = () => {
        expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
        fightProperties.startTurn(team, 1_000);
        context.matrix = combat.grid.getMatrix();
        healer.setStackPower(5);
    };
    const choose = (decision: GameAction[]) => chooseHealerSupportDecision(healer, context, decision, deps);
    const cast = (name: string, target?: Unit): GameAction[] => [
        {
            type: "cast_spell",
            casterId: healer.getId(),
            spellName: name,
            ...(target ? { targetId: target.getId() } : {}),
        },
    ];
    return {
        ...combat,
        add,
        healer,
        start,
        choose,
        cast,
        context,
        deps,
        engine,
        enemyTeam: team === LEFT ? RIGHT : LEFT,
    };
}

function witness(f: ReturnType<typeof fixture>) {
    return JSON.stringify(
        { ...snapshotBattle(f.unitsHolder, f.grid, f.context.fightProperties!), unitRefs: undefined },
        (_key, value) => (value instanceof Map || value instanceof Set ? [...value] : value),
    );
}

describe("Healer recovery estimates and research spell selection", () => {
    for (const team of [LEFT, RIGHT]) {
        for (const name of ["Heal", "Mass Heal"] as const) {
            test(`team ${team}: ${name} estimate matches the actual Holy Cross cast`, () => {
                const f = fixture(team);
                const target = f.add("Abomination", "Chaos", 1, { x: 6, y: 7 });
                f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
                f.start();
                const cross = new Spell({ spellProperties: getSpellConfig("System", "Holy Cross"), amount: 1 });
                cross.setPower(50); // Artifact application fills the system card's zero-power placeholder.
                f.healer.applyBuff(cross);
                f.healer.getUnitProperties().attack_multiplier = 1.5;
                target.applyDamage(400, 0, new SceneLogMock());
                const predicted = v08HealingSpellPower(f.healer, name);
                expect(predicted).toBe(name === "Heal" ? 225 : 75);
                const before = target.getHp();
                expect(f.engine.apply(f.cast(name, name === "Heal" ? target : undefined)[0]).completed).toBe(true);
                expect(target.getHp() - before).toBe(predicted);
                expect(target.getAmountAlive()).toBe(1);
            });
        }
        for (const side of [false, true]) {
            test(`team ${team}, side=${side}: heals the damaged body instead of armoring an idle ally`, () => {
                const f = fixture(team, side);
                const target = f.add("Abomination", "Chaos", 1, { x: 6, y: 7 });
                const idle = f.add("Peasant", "Life", 50, { x: 2, y: 1 });
                f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
                f.start();
                target.applyDamage(300, 0, new SceneLogMock());
                const selected = f.choose(f.cast("Spiritual Armor", idle));
                expect(selected.reason).toBe("support-value");
                expect(selected.actions[0]).toMatchObject({ spellName: "Heal", targetId: target.getId() });
                const heal = selected.proposals.find((p) => p.spellName === "Heal" && p.targetId === target.getId())!;
                expect(heal.recoveredHp).toBe(100);
                expect(f.engine.apply(selected.actions[0]).completed).toBe(true);
                expect(target.getHp()).toBe(300);
            });
        }
    }

    test("Mass Heal wins when three damaged front bodies genuinely restore more HP", () => {
        const f = fixture();
        const targets = [2, 7, 12].map((y) => f.add("Abomination", "Chaos", 1, { x: 6, y }));
        f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
        f.start();
        for (const target of targets) target.applyDamage(100, 0, new SceneLogMock());
        const decision = f.choose(f.cast("Heal", targets[0]));
        expect(decision.actions[0]).toMatchObject({ spellName: "Mass Heal" });
        const mass = decision.proposals.find((p) => p.spellName === "Mass Heal")!;
        expect(mass.recoveredHp).toBe(150);
        expect(mass.recovery).toHaveLength(3);
    });

    test("healing never pretends to resurrect missing bodies or repair a mechanism", () => {
        const f = fixture();
        const army = f.add("Peasant", "Life", 100, { x: 4, y: 3 });
        const cannon = f.add("Tsar Cannon", "Life", 1, { x: 4, y: 12 });
        const tank = f.add("Abomination", "Chaos", 1, { x: 6, y: 7 });
        f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
        f.start();
        army.applyDamage(400, 0, new SceneLogMock());
        cannon.applyDamage(50, 0, new SceneLogMock());
        tank.applyDamage(50, 0, new SceneLogMock());
        const result = f.choose(f.cast("Heal", tank));
        expect(
            result.proposals.filter(
                (p) => p.spellName === "Heal" && [army.getId(), cannon.getId()].includes(p.targetId ?? ""),
            ),
        ).toHaveLength(0);
        expect(result.proposals.find((p) => p.spellName === "Mass Heal")!.recoveredHp).toBe(50);
    });

    test("actual Blessing damage beats preventative armor on a productive ranged ally", () => {
        const f = fixture();
        const carry = createTestUnit({
            team: LEFT,
            name: "Carry",
            amountAlive: 20,
            attackType: PBTypes.AttackVals.RANGE,
            damageMin: 1,
            damageMax: 20,
            rangeShots: 8,
        });
        const enemy = createTestUnit({
            team: RIGHT,
            name: "Enemy",
            amountAlive: 100,
            maxHp: 100,
            damageMin: 1,
            damageMax: 1,
        });
        placeUnit(f.grid, f.unitsHolder, carry, { x: 4, y: 7 });
        placeUnit(f.grid, f.unitsHolder, enemy, { x: 14, y: 7 });
        f.start();
        const result = f.choose(f.cast("Spiritual Armor", carry));
        expect(result.actions[0]).toMatchObject({ spellName: "Blessing", targetId: carry.getId() });
        expect(result.selectedValue).toBeGreaterThan(5);
        expect(f.grid.placeArtifactBarrel(LEFT, 0, { x: 8, y: 7 })).toBe(true);
        const blocked = f.choose(f.cast("Spiritual Armor", carry));
        expect(
            blocked.proposals.find((p) => p.spellName === "Blessing" && p.targetId === carry.getId())!
                .physicalDamageGain,
        ).toBe(0);
        expect(blocked.reason).toBe("keep-stock");
    });

    test("keeps attacks, moves and tactical waits untouched", () => {
        const f = fixture();
        const enemy = f.add("Squire", "Life", 1, { x: 3, y: 7 }, RIGHT);
        f.start();
        for (const actions of [
            [
                {
                    type: "melee_attack",
                    attackerId: f.healer.getId(),
                    targetId: enemy.getId(),
                    attackFrom: f.healer.getBaseCell(),
                },
            ],
            [
                {
                    type: "move_unit",
                    unitId: f.healer.getId(),
                    path: [
                        { x: 2, y: 7 },
                        { x: 1, y: 7 },
                    ],
                    targetCells: [{ x: 1, y: 7 }],
                    hasLavaCell: false,
                    hasWaterCell: false,
                },
            ],
            [{ type: "wait_turn", unitId: f.healer.getId() }],
        ] as GameAction[][]) {
            const result = f.choose(actions);
            expect(result.reason).toBe("preserve-nonspell");
            expect(result.actions).toBe(actions);
            expect(result.proposals).toHaveLength(0);
        }
    });

    test("previews restore the exact board, unit references, charges, damage stats and RNG", () => {
        const random = captureDeterministicRandomState();
        setDeterministicRandomSource(makeRng(811822113));
        try {
            const f = fixture();
            const target = f.add("Abomination", "Chaos", 1, { x: 6, y: 7 });
            f.add("Squire", "Life", 10, { x: 14, y: 7 }, RIGHT);
            f.start();
            target.applyDamage(300, 0, new SceneLogMock());
            const before = witness(f),
                refs = [...f.unitsHolder.getAllUnits()],
                rng = captureDeterministicRandomState();
            const stats = f.deps.captureDamageStats(),
                active = f.deps.getActiveUnitId();
            expect(f.choose(f.cast("Spiritual Armor", target)).proposals.length).toBeGreaterThan(2);
            expect(witness(f)).toBe(before);
            expect([...f.unitsHolder.getAllUnits()]).toEqual(refs);
            expect(captureDeterministicRandomState()).toEqual(rng);
            expect(f.deps.captureDamageStats()).toEqual(stats);
            expect(f.deps.getActiveUnitId()).toBe(active);
        } finally {
            restoreDeterministicRandomState(random);
        }
    });
});
