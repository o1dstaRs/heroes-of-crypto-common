import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy } from "../../src/ai";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { advanceDeltaBetween } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { makeRng } from "../../src/simulation/army";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import {
    chooseA19SatyrContactDecision as chooseSatyrContactDecision,
    observeA19SatyrContact as observeSatyrContact,
} from "../../src/ai/satyr_contact_support";
import { attachA19SupportDecision } from "../../src/simulation/a19_support";
import { SearchRollbackError, type SearchDriver } from "../../src/simulation/search_driver";
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
    const satyr = add("Satyr", "Nature", 20, { x: 2, y: 7 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setSideOrientedPlacement(side);
    let active = satyr.getId();
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
    };
    const choose = (decision: GameAction[]) => chooseSatyrContactDecision(satyr, context, decision, deps);
    const courage = (target: Unit): GameAction[] => [
        { type: "cast_spell", casterId: satyr.getId(), spellName: "Courage", targetId: target.getId() },
    ];
    return {
        ...combat,
        add,
        satyr,
        start,
        choose,
        courage,
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

describe("production: unqualified Satyr contact policy", () => {
    for (const team of [LEFT, RIGHT])
        for (const side of [true, false]) {
            test(`forward reinforcement policy mirrors correctly: team ${team}, side=${side}`, () => {
                const f = fixture(team, side);
                const ally = f.add("Peasant", "Life", 100, { x: 4, y: 7 });
                f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
                f.start();
                const before = f.satyr.getBaseCell();
                const decision = f.choose(f.courage(ally));
                expect(decision.reason).toBe("summon-before-contact");
                expect(f.engine.apply(decision.actions[0]).completed).toBe(true);
                const wolf = f.unitsHolder.getAllAllies(team).find((u) => u.isSummoned() && u.getName() === "Wolf")!;
                expect(advanceDeltaBetween(team, before, wolf.getBaseCell(), side)).toBeGreaterThan(0);
                expect(f.satyr.getBaseCell()).toEqual(before);
            });
        }
    test("summons before contact, using a forward Wolf body and preserving Satyr's root", () => {
        const random = captureDeterministicRandomState();
        setDeterministicRandomSource(makeRng(20261108));
        try {
            const f = fixture();
            const ally = f.add("Peasant", "Life", 100, { x: 4, y: 7 });
            f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
            f.start();
            const before = witness(f),
                ids = [...f.unitsHolder.getAllUnits()],
                state = captureDeterministicRandomState();
            const result = f.choose(f.courage(ally));
            expect(result.reason).toBe("summon-before-contact");
            expect(result.actions[0]).toMatchObject({ type: "cast_spell", spellName: "Summon Wolves" });
            expect(result.before!.filter((u) => u.engaged)).toHaveLength(0);
            expect(witness(f)).toBe(before);
            expect([...f.unitsHolder.getAllUnits()]).toEqual(ids);
            expect(captureDeterministicRandomState()).toEqual(state);
            expect(f.engine.apply(result.actions[0]).completed).toBe(true);
            expect(f.satyr.getBaseCell()).toEqual({ x: 2, y: 7 });
        } finally {
            restoreDeterministicRandomState(random);
        }
    });

    test("helps an engaged level-1 stack instead of the larger distant stack", () => {
        const f = fixture();
        const engaged = f.add("Fairy", "Nature", 50, { x: 10, y: 7 });
        const distant = f.add("Peasant", "Life", 150, { x: 0, y: 0 });
        f.add("Squire", "Life", 5, { x: 11, y: 7 }, f.enemyTeam);
        f.start();
        const result = f.choose(f.courage(distant));
        expect(result.reason).toBe("help-engaged-ally");
        expect(result.actions[0]).toMatchObject({ spellName: "Helping Hand", targetId: engaged.getId() });
        expect(result.proposals.find((p) => p.value !== undefined)!.value).toBeGreaterThan(0);
        expect(f.engine.apply(result.actions[0]).completed).toBe(true);
        expect(engaged.getUnitProperties().helping_hand_caster_id).toBe(f.satyr.getId());
        expect(f.satyr.hasDebuffActive("Helping Hand")).toBe(true);
    });

    test("a donor-killing Helping Hand is not selected even with a large engaged beneficiary", () => {
        const f = fixture();
        const ally = f.add("Fairy", "Nature", 100, { x: 4, y: 6 });
        f.add("Squire", "Life", 300, { x: 4, y: 7 }, f.enemyTeam);
        f.start();
        f.satyr.setStackPower(5); // Keep this fixture eligible for the level-3 spell despite the huge enemy.
        const result = f.choose(f.courage(ally));
        expect(result.reason).not.toBe("help-engaged-ally");
        const help = result.proposals.find((p) =>
            p.actions.some((a) => a.type === "cast_spell" && a.spellName === "Helping Hand"),
        );
        expect(help).toBeDefined();
        expect(help!.casterExposure!).toBeGreaterThanOrEqual(help!.casterHp!);
    });

    test("does not replace a real attack with a support spell", () => {
        const f = fixture();
        const enemy = f.add("Squire", "Life", 1, { x: 3, y: 7 }, f.enemyTeam);
        f.start();
        const decision: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: f.satyr.getId(),
                targetId: enemy.getId(),
                attackFrom: f.satyr.getBaseCell(),
            },
        ];
        const result = f.choose(decision);
        expect(result.reason).toBe("keep-attack");
        expect(result.actions).toBe(decision);
        expect(result.proposals).toHaveLength(0);
    });

    test("reinforces the existing Wolf without treating the summon hint as a caster move", () => {
        const f = fixture();
        const ally = f.add("Peasant", "Life", 100, { x: 4, y: 7 });
        const wolf = f.add("Wolf", "Nature", 3, { x: 12, y: 1 }, LEFT, true);
        f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
        f.start();
        const result = f.choose(f.courage(ally));
        expect(result.reason).toBe("summon-before-contact");
        expect(f.engine.apply(result.actions[0]).completed).toBe(true);
        expect(wolf.getBaseCell()).toEqual({ x: 12, y: 1 });
        expect(wolf.getAmountAlive()).toBe(33);
        expect(f.satyr.getBaseCell()).toEqual({ x: 2, y: 7 });
    });

    test("does not count a one-body split as the main level-1 line", () => {
        const f = fixture();
        const main = f.add("Peasant", "Life", 100, { x: 4, y: 0 });
        const split = f.add("Peasant", "Life", 1, { x: 13, y: 7 });
        f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
        f.start();
        const rows = observeSatyrContact(f.satyr, f.context);
        expect(rows.find((r) => r.id === split.getId())!.mainLevelOne).toBe(false);
        expect(rows.find((r) => r.id === main.getId())!.engaged).toBe(false);
    });

    test("a barrel-intercepted shot is not counted as incoming damage on the level-1 ally", () => {
        const f = fixture();
        const ally = f.add("Peasant", "Life", 100, { x: 4, y: 7 });
        const shooter = createTestUnit({
            team: f.enemyTeam,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 30,
            damageMin: 5,
            damageMax: 5,
            rangeShots: 10,
            amountAlive: 20,
        });
        placeUnit(f.grid, f.unitsHolder, shooter, { x: 14, y: 7 });
        f.start();
        expect(
            observeSatyrContact(f.satyr, f.context).find((r) => r.id === ally.getId())!.incomingRanged,
        ).toBeGreaterThan(0);
        expect(f.grid.placeArtifactBarrel(LEFT, 0, { x: 8, y: 7 })).toBe(true);
        const shielded = observeSatyrContact(f.satyr, f.context).find((r) => r.id === ally.getId())!;
        expect(shielded.incomingRanged).toBe(0);
        expect(shielded.engaged).toBe(false);
    });

    test("an unsafe advance can become a less exposed backline action", () => {
        const f = fixture();
        f.add("Peasant", "Life", 100, { x: 7, y: 9 });
        f.add("Squire", "Life", 30, { x: 7, y: 7 }, f.enemyTeam);
        f.start();
        for (const spell of f.satyr.getSpells()) while (spell.isRemaining()) f.satyr.useSpell(spell.getName());
        const advances = enumerateCandidates(f.satyr, f.context, []).candidates.filter(
            (c) => c.kind === "move" && c.targetCell!.x > 2,
        );
        advances.sort(
            (a, b) =>
                b.targetCell!.x - a.targetCell!.x || Math.abs(a.targetCell!.y - 7) - Math.abs(b.targetCell!.y - 7),
        );
        expect(advances.length).toBeGreaterThan(0);
        const result = f.choose(advances[0].actions);
        expect(result.reason).toBe("safer-backline");
        const stock = result.proposals[0];
        const chosen = result.proposals.find((p) => p.actions === result.actions)!;
        expect(chosen.casterExposure! / chosen.casterHp!).toBeLessThan(stock.casterExposure! / stock.casterHp!);
    });

    test("does not walk ahead of the surviving main stack just because immediate exposure is zero", () => {
        const f = fixture();
        f.add("Peasant", "Life", 100, { x: 4, y: 10 });
        f.add("Squire", "Life", 5, { x: 15, y: 7 }, f.enemyTeam);
        f.start();
        for (const spell of f.satyr.getSpells()) while (spell.isRemaining()) f.satyr.useSpell(spell.getName());
        const advance = enumerateCandidates(f.satyr, f.context, []).candidates.find(
            (c) => c.kind === "move" && c.targetCell?.x === 5 && c.targetCell.y === 7,
        )!;
        expect(advance).toBeDefined();
        const result = f.choose(advance.actions);
        expect(result.reason).toBe("safer-backline");
        expect(result.actions.some((a) => a.type === "wait_turn" || a.type === "defend_turn")).toBe(true);
    });

    test("ordinary non-Satyr actors remain exactly unchanged", () => {
        const f = fixture();
        const other = createTestUnit({ team: LEFT });
        const decision: GameAction[] = [{ type: "end_turn", unitId: other.getId() }];
        expect(chooseSatyrContactDecision(other, f.context, decision, f.deps).actions).toBe(decision);
    });
});

test("production Satyr layer runs after the completed selector, restores the root and respects elapsed budget", () => {
    const f = fixture();
    const ally = f.add("Peasant", "Life", 100, { x: 4, y: 0 });
    f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
    f.start();
    const selected = f.courage(ally);
    const before = snapshotBattle(f.context.unitsHolder, f.context.grid, f.context.fightProperties);
    const driver = { appliesTo: () => true, chooseDecision: () => selected } as unknown as SearchDriver;
    const live = attachA19SupportDecision(driver, f.deps, false);
    f.context.decisionStartedAtMs = performance.now() - 1001;
    expect(live.chooseDecision(f.satyr, "v0.8", [], f.context)).toBe(selected);
    f.context.decisionStartedAtMs = performance.now();
    const actions = live.chooseDecision(f.satyr, "v0.8", [], f.context);
    expect(actions.some((a) => a.type === "cast_spell" && a.spellName === "Summon Wolves")).toBe(true);
    expect(snapshotBattle(f.context.unitsHolder, f.context.grid, f.context.fightProperties)).toEqual(before);
    expect(attachA19SupportDecision(driver, f.deps, false)).toBe(live);
    expect(chooseSatyrContactDecision(f.satyr, f.context, selected, f.deps, -1).reason).toBe("budget-exhausted");
    expect(live.chooseDecision(f.satyr, "v0.9", [], f.context)).toBe(selected);
});

test("a failed Satyr restore attempts every cleanup and propagates quarantine instead of a safe-looking fallback", () => {
    const f = fixture();
    const ally = f.add("Peasant", "Life", 100, { x: 4, y: 0 });
    f.add("Squire", "Life", 10, { x: 14, y: 7 }, f.enemyTeam);
    f.start();
    const before = witness(f);
    const random = captureDeterministicRandomState();
    const driver = { appliesTo: () => true, chooseDecision: () => f.courage(ally) } as unknown as SearchDriver;
    const live = attachA19SupportDecision(
        driver,
        {
            ...f.deps,
            restoreDamageStats: () => {
                throw new Error("injected statistics restore failure");
            },
        },
        true,
    );
    expect(() => live.chooseDecision(f.satyr, "v0.8", [], f.context)).toThrow(SearchRollbackError);
    expect(witness(f)).toBe(before);
    expect(captureDeterministicRandomState()).toEqual(random);
});
