import { afterEach, expect, test } from "bun:test";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { evaluateAffectedUnits } from "../../src/abilities/aoe_range_ability";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { enumerateCandidates } from "../../src/ai/candidates";
import { planA19SupportSplits } from "../../src/ai/support_setup";
import { tacticalSplitUnitFromUnit } from "../../src/ai/tactical_split_placement";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { makeRng } from "../../src/simulation/army";
import { snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import {
    MAGIC_DRAGON_TACTICS,
    planMagicDragonResearchSplits,
    protectMagicDragonResearchPlacement,
    withMagicDragonResearch,
    type DragonSearchTrace,
} from "../../src/simulation/magic_dragon_tactics_research";
import { SearchDriver } from "../../src/simulation/search_driver";
import {
    withProtectedMeteorResearch,
    type ProtectedMeteorTrace,
} from "../../src/simulation/magic_dragon_protected_meteor_research";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { cellTargetedSpellBlockCells, isSpellUsableByCaster } from "../../src/spells/spell_helper";
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
afterEach(() => setDeterministicRandomSource(undefined));
function fixture(amount = 4, team: TeamType = LEFT) {
    const board = createCombatTestContext(),
        effects = new EffectFactory();
    const create = (count: number) =>
        Unit.createUnit(
            getCreatureConfig(team, "Nature", "Magic Dragon", "", count),
            testGridSettings,
            team,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            false,
        );
    const dragon = create(amount),
        enemyTeam = team === LEFT ? RIGHT : LEFT;
    const map = (c: XY, large = false) => (team === LEFT ? c : { x: 15 - c.x + Number(large), y: c.y });
    placeUnit(board.grid, board.unitsHolder, dragon, map({ x: 2, y: 7 }, true));
    const add = (cell: XY, options: TestUnitOptions = {}) => {
        const u = createTestUnit({
            team: enemyTeam,
            name: "Target",
            maxHp: 1000,
            amountAlive: 20,
            exp: 100,
            ...options,
        });
        placeUnit(board.grid, board.unitsHolder, u, map(cell, !u.isSmallSize()));
        return u;
    };
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setSideOrientedPlacement(true);
    let active = dragon.getId();
    const engineContext = {
        ...board,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, board.grid, board.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active,
        canSplitUnit: () => true,
        createSplitUnit: (_u: Unit, count: number) => create(count),
    };
    const engine = new GameActionEngine(engineContext);
    const context: IDecisionContext = {
        ...board,
        matrix: board.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: fight,
        decisionOrigin: "root",
    };
    const split = (count: number) => {
        const result = engine.apply({ type: "split_unit", unitId: dragon.getId(), amount: count });
        expect(result.completed).toBe(true);
        const event = result.events.find((e) => e.type === "unit_split");
        if (event?.type !== "unit_split") throw new Error("Missing native split");
        return board.unitsHolder.getAllUnits().get(event.newUnitId)!;
    };
    const start = () => {
        expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
        fight.startTurn(team, 1000);
        context.matrix = board.grid.getMatrix();
    };
    const deps = {
        ...board,
        engine,
        fightProperties: fight,
        pathHelper: context.pathHelper,
        turnEngine: new TurnEngine(engineContext),
        getActiveUnitId: () => active,
        setActiveUnitId: (id: string) => {
            active = id;
        },
        strategyForTeam: () => getAIStrategy("v0.8"),
        damageDealtThisLap: () => false,
        captureDamageStats: () => [...board.damageStatisticHolder.get()],
        restoreDamageStats: (rows: ReturnType<typeof board.damageStatisticHolder.get>) => {
            board.damageStatisticHolder.clear();
            for (const row of rows) board.damageStatisticHolder.add(row);
        },
    };
    const catalog = (wide = false) =>
        enumerateCandidates(dragon, context, [], {
            maxMoveDestinations: 2,
            maxMeleePairs: 4,
            maxShotAims: 6,
            researchMagicDragonMeteorCoverage: wide,
        }).candidates;
    return { ...board, dragon, add, split, start, catalog, context, engine, fight, deps, team, enemyTeam };
}

for (const fail of [false, true])
    test(`protected Meteor restores real probe state; injected failure=${fail}`, () => {
        const f = fixture(8);
        f.add({ x: 10, y: 8 }, { amountAlive: 3 });
        f.add({ x: 12, y: 9 }, { amountAlive: 3 });
        f.start();
        setDeterministicRandomSource(makeRng(7281));
        const driver = createV08A19SearchDriver(f.deps, {
            seed: 173,
            greenVersion: "v0.8",
            redVersion: "v0.8",
            offlineDeterministicWork: true,
        });
        const traces: ProtectedMeteorTrace[] = [];
        const internal = driver as unknown as { scoreCandidates: (...args: unknown[]) => number[] };
        const score = internal.scoreCandidates;
        let probing = false,
            checked = 0;
        internal.scoreCandidates = function (...args) {
            if (!probing) return score.apply(this, args);
            if (fail) {
                const meteor = (args[1] as { actions: import("../../src/engine/actions").GameAction[] }[])[1];
                for (const action of meteor.actions) f.engine.apply(action);
                f.deps.setActiveUnitId("speculative-only");
                throw new Error("probe fault after mutation");
            }
            return (args[1] as unknown[]).map((_, i) => (args[3] === "leaf" ? 0.5 : i === 0 ? 0.1 : 0.9));
        };
        try {
            withProtectedMeteorResearch(
                LEFT,
                (transform) => {
                    const base = driver.chooseDecision(
                        f.dragon,
                        "v0.8",
                        [{ type: "defend_turn", unitId: f.dragon.getId() }],
                        f.context,
                    );
                    const before = snapshotBattle(f.unitsHolder, f.grid, f.fight),
                        random = captureDeterministicRandomState(),
                        activeId = f.deps.getActiveUnitId(),
                        stats = f.deps.captureDamageStats();
                    probing = true;
                    const probe = () =>
                        transform(
                            f.dragon,
                            f.context,
                            base,
                            () => {
                                checked++;
                                return { failure: null };
                            },
                            "v0.8",
                        );
                    let chosen = base;
                    if (fail) expect(probe).toThrow("probe fault after mutation");
                    else chosen = probe();
                    probing = false;
                    expect(snapshotBattle(f.unitsHolder, f.grid, f.fight)).toEqual(before);
                    expect(captureDeterministicRandomState()).toEqual(random);
                    expect(f.deps.getActiveUnitId()).toBe(activeId);
                    expect(f.deps.captureDamageStats()).toEqual(stats);
                    if (!fail) {
                        expect(checked).toBe(1);
                        expect(traces).toHaveLength(1);
                        expect(traces[0].incumbent).toEqual(base);
                        expect(chosen.some((a) => a.type === "cast_spell" && a.spellName === "Meteor Shower")).toBe(
                            true,
                        );
                        const second = driver.chooseDecision(f.dragon, "v0.8", base, f.context);
                        expect(
                            transform(
                                f.dragon,
                                f.context,
                                second,
                                () => {
                                    throw new Error("second override");
                                },
                                "v0.8",
                            ),
                        ).toEqual(second);
                        for (const action of chosen) expect(f.engine.apply(action).completed).toBe(true);
                    }
                },
                (t) => traces.push(t),
            );
        } finally {
            internal.scoreCandidates = score;
        }
    });

for (const team of [LEFT, RIGHT]) {
    test(`real 2x2 half splits retain two usable Whirlpools but lose the full-stack area spells, team ${team}`, () => {
        const f = fixture(4, team);
        f.add({ x: 10, y: 8 });
        const original = [...f.dragon.getUnitProperties().spells].sort();
        const child = f.split(2);
        f.start();
        for (const u of [f.dragon, child]) {
            expect(u.getCells()).toHaveLength(4);
            expect(u.getStackPower()).toBe(3);
            expect([...u.getUnitProperties().spells].sort()).toEqual(original);
            expect(
                u
                    .getSpells()
                    .filter((s) => isSpellUsableByCaster(u, s))
                    .map((s) => s.getName()),
            ).toEqual(["Whirlpool", "Lightning Strike"]);
        }
        child.useSpell("Whirlpool");
        expect(
            f.dragon
                .getSpells()
                .find((s) => s.getName() === "Whirlpool")!
                .getAmount(),
        ).toBe(1);
    });
    test(`one-body split can lose Whirlpool despite retaining the scroll, team ${team}`, () => {
        const f = fixture(2, team);
        f.add({ x: 10, y: 8 });
        const child = f.split(1);
        f.start();
        for (const u of [f.dragon, child]) {
            expect(u.getStackPower()).toBe(2);
            const spell = u.getSpells().find((s) => s.getName() === "Whirlpool")!;
            expect(spell.getAmount()).toBe(1);
            expect(isSpellUsableByCaster(u, spell)).toBe(false);
        }
    });
    test(`distinct Meteor Shower impacts preserve native legality and footprint deduplication, team ${team}`, () => {
        const f = fixture(8, team);
        f.add({ x: 10, y: 3 });
        f.add({ x: 11, y: 3 });
        const isolated = f.add({ x: 12, y: 12 }, { maxHp: 20, amountAlive: 1, size: PBTypes.UnitSizeVals.LARGE });
        f.start();
        const old = f.catalog().filter((c) => c.spellName === "Meteor Shower"),
            wide = f.catalog(true).filter((c) => c.spellName === "Meteor Shower");
        expect(old).toHaveLength(1);
        expect(wide.length).toBeGreaterThan(1);
        expect(wide[0].actions).toEqual(old[0].actions);
        const signatures = wide.map((c) => {
            const cast = c.actions[0];
            if (cast.type !== "cast_spell" || !cast.targetCell) throw new Error("Expected meteor");
            return (
                evaluateAffectedUnits(
                    cellTargetedSpellBlockCells("Meteor Shower", cast.targetCell),
                    f.unitsHolder,
                    f.grid,
                    false,
                )?.[0] ?? []
            )
                .filter((u) => u.getTeam() === f.enemyTeam)
                .map((u) => u.getId());
        });
        expect(new Set(signatures.map((s) => JSON.stringify(s))).size).toBe(wide.length);
        expect(signatures.some((ids) => ids.length === 1 && ids[0] === isolated.getId())).toBe(true);
        const root = snapshotBattle(f.unitsHolder, f.grid, f.fight);
        for (const candidate of wide) {
            expect(f.engine.apply(candidate.actions[0]).completed).toBe(true);
            restoreBattle(root, f.unitsHolder, f.grid, f.fight);
        }
    });
}

test("research splits keep adopted Healer/Mage slots and do not use enemy roster inputs", () => {
    const f = fixture(4);
    const dragon = tacticalSplitUnitFromUnit(f.dragon);
    const basic = {
        ...dragon,
        small: true,
        amount: 40,
        level: 1,
        attackType: PBTypes.AttackVals.MELEE,
        identity: "Peasant:1",
        supportSpellCount: 0,
        auraUtilityCount: 0,
    };
    const healer = { ...basic, id: "healer", identity: "Healer:2", level: 2, hpPerCreature: 10, supportSpellCount: 2 };
    const mage = { ...basic, id: "mage", identity: "Wandering Mage:1", supportSpellCount: 2 };
    const units = [dragon, healer, mage, ...[1, 2, 3].map((i) => ({ ...basic, id: `u${i}`, identity: `x${i}:1` }))];
    const baseline = planA19SupportSplits(units, 8);
    expect(planMagicDragonResearchSplits(units, 8, "none")).toEqual(baseline);
    const candidate = planMagicDragonResearchSplits(units, 8, "half");
    for (const plan of baseline.filter((p) => p.sourceUnitId === "healer" || p.sourceUnitId === "mage"))
        expect(candidate).toContainEqual(plan);
    expect(planMagicDragonResearchSplits(units, 6, "single")).toEqual([]);
    expect(
        planMagicDragonResearchSplits(
            [dragon, ...[1, 2, 3, 4, 5].map((i) => ({ ...basic, id: `u${i}` }))],
            7,
            "control-pair",
        ).some((p) => p.sourceUnitId === dragon.id && p.amount === 2),
    ).toBe(true);
});

test("rear placement handles full 2x2 bodies and preserves the entire incumbent if no legal space exists", () => {
    const units = [
        { id: "d", name: "Magic Dragon", small: false, amount: 2 },
        { id: "child", name: "Magic Dragon", small: false, amount: 2 },
        { id: "ally", name: "Healer", small: true, amount: 40 },
    ];
    const incumbent = new Map([
        ["d", { x: 3, y: 4 }],
        ["child", { x: 3, y: 12 }],
        ["ally", { x: 0, y: 7 }],
    ]);
    const legal = new Set(
        Array.from({ length: 3 }, (_, x) => Array.from({ length: 16 }, (_, y) => (x << 4) | y)).flat(),
    );
    const placed = protectMagicDragonResearchPlacement(incumbent, units, {
        team: LEFT,
        sideOrientedPlacement: true,
        legalCellHashes: legal,
    });
    expect(placed.get("ally")).toEqual(incumbent.get("ally"));
    expect(placed.get("d")!.x).toBe(1);
    expect(placed.get("child")!.x).toBe(1);
    expect(Math.abs(placed.get("d")!.y - placed.get("child")!.y)).toBeGreaterThanOrEqual(2);
    expect(
        protectMagicDragonResearchPlacement(incumbent, units, {
            team: LEFT,
            sideOrientedPlacement: true,
            legalCellHashes: new Set([0]),
        }),
    ).toEqual(incumbent);
});

test("observation-only A19 decisions are exact and research restores driver scope on failure", () => {
    const f = fixture(4);
    f.add({ x: 10, y: 3 });
    f.add({ x: 11, y: 3 });
    f.start();
    const root = snapshotBattle(f.unitsHolder, f.grid, f.fight);
    setDeterministicRandomSource(makeRng(90217));
    const random = captureDeterministicRandomState();
    const choose = () => {
        const driver = createV08A19SearchDriver(f.deps, { timingMode: "operation-bounded" });
        return driver.chooseDecision(
            f.dragon,
            "v0.8",
            getAIStrategy("v0.8").decideTurn(f.dragon, f.context),
            f.context,
        );
    };
    const baseline = choose();
    restoreBattle(root, f.unitsHolder, f.grid, f.fight);
    restoreDeterministicRandomState(random);
    const traces: DragonSearchTrace[] = [];
    expect(withMagicDragonResearch(LEFT, MAGIC_DRAGON_TACTICS[0], choose, (t) => traces.push(t))).toEqual(baseline);
    expect(traces.length).toBeGreaterThan(0);
    const before = SearchDriver.prototype.chooseDecision;
    expect(() =>
        withMagicDragonResearch(LEFT, MAGIC_DRAGON_TACTICS[1], () => {
            throw new Error("owned failure");
        }),
    ).toThrow("owned failure");
    expect(SearchDriver.prototype.chooseDecision).toBe(before);
    expect(() => withMagicDragonResearch(LEFT, MAGIC_DRAGON_TACTICS[1], () => Promise.resolve(0))).toThrow(
        "synchronous",
    );
});
