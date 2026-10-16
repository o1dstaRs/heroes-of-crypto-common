import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getAIStrategy } from "../../src/ai";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { lastFuseCounterTradePotential, reserveLastFuseShortlistCandidate } from "../../src/ai/last_fuse_tactics";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getEffectConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { Effect } from "../../src/effects/effect";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));

function fixture(
    options: {
        team?: typeof LEFT;
        rotate?: number;
        mirror?: boolean;
        actor?: TestUnitOptions;
        primary?: TestUnitOptions;
        primaryRooted?: boolean;
        neighbor?: TestUnitOptions;
        neighborCells?: readonly [XY, XY];
        hp?: number;
        ally?: boolean;
        allyCell?: XY;
        allyProps?: TestUnitOptions;
    } = {},
) {
    const combat = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    const team = options.team ?? LEFT,
        enemy = team === LEFT ? RIGHT : LEFT;
    const cell = (point: XY): XY => {
        let x = point.x - 8,
            y = point.y - 8;
        if (options.mirror) x = -x;
        for (let i = 0; i < (options.rotate ?? 0); i++) [x, y] = [-y, x];
        return { x: 8 + x, y: 8 + y };
    };
    const add = (name: string, anchor: XY, props: TestUnitOptions = {}) => {
        const u = createTestUnit({ name, team: enemy, maxHp: 500, damageMin: 0, damageMax: 0, ...props });
        placeUnit(combat.grid, combat.unitsHolder, u, cell(anchor));
        return u;
    };
    const actor = add(
        "Wounded fuse",
        { x: 5, y: 7 },
        { team, maxHp: 100, damageMin: 1, damageMax: 1, ...options.actor },
    );
    const primary = add("Lethal responder", { x: 8, y: 7 }, { damageMin: 1000, damageMax: 1000, ...options.primary });
    const a = add("Blast victim A", options.neighborCells?.[0] ?? { x: 8, y: 9 }, { maxHp: 70, ...options.neighbor });
    const b = add("Blast victim B", options.neighborCells?.[1] ?? { x: 8, y: 8 }, { maxHp: 70, ...options.neighbor });
    const ally =
        options.ally === false
            ? undefined
            : add("Safe ally", options.allyCell ?? { x: 2, y: 2 }, { team, maxHp: 1000, ...options.allyProps });
    actor.applyDamage(actor.getCumulativeHp() - (options.hp ?? 10), 0, new SceneLogMock(), false);
    fp.setArtifactPerTeam(team, 2, Tier2Artifact.LAST_FUSE);
    combat.unitsHolder.applyArtifacts(fp);
    combat.unitsHolder.refreshStackPowerForAllUnits();
    for (const u of [actor, primary, a, b]) {
        u.trySeedWaterShield();
        u.refreshPossibleAttackTypes(false);
    }
    if (options.primaryRooted) primary.applyEffect(new Effect({ ...getEffectConfig("Paralysis"), power: 50, laps: 3 }));
    fp.startFight();
    fp.setTeamUnitsAlive(team, combat.unitsHolder.getAllAllies(team).length);
    fp.setTeamUnitsAlive(enemy, combat.unitsHolder.getAllEnemyUnits(team).length);
    fp.startTurn(team, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fp,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    let active = actor.getId();
    const engineContext = {
        ...combat,
        fightProperties: fp,
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active || undefined,
    };
    const engine = new GameActionEngine(engineContext);
    const defend: GameAction[] = [{ type: "defend_turn", unitId: actor.getId() }];
    const catalog = (include = true, cap = 1, primaryTrades = false) =>
        enumerateCandidates(actor, context, defend, {
            maxMeleePairs: cap,
            maxMoveDestinations: 1,
            includeLastFuseCounterTrades: include,
            includeLastFusePrimaryTrades: primaryTrades,
            enrichIncumbentMetadata: true,
        });
    const reserved = (primaryTrades = false) => {
        const c = catalog(true, 1, primaryTrades).candidates.find(
            (candidate) => candidate.lastFuseCounterTradeReserved,
        );
        expect(c).toBeDefined();
        return c!;
    };
    const fire = (candidate: Pick<IEnumeratedCandidate, "actions">) => {
        setDeterministicRandomSource(() => 0);
        const events = candidate.actions.flatMap((action) => {
            const r = engine.apply(action);
            expect(r.completed).toBe(true);
            return r.events;
        });
        return events.filter((event) => event.type === "pyre_exploded");
    };
    const deps: ILookaheadDeps = {
        ...context,
        fightProperties: fp,
        engine,
        turnEngine: new TurnEngine(engineContext),
        strategyForTeam: () => getAIStrategy("v0.8"),
        getActiveUnitId: () => active,
        setActiveUnitId: (id) => {
            active = id;
        },
        damageDealtThisLap: () => combat.damageStatisticHolder.has(fp.getCurrentLap()),
        captureDamageStats: () => [...combat.damageStatisticHolder.get()],
        restoreDamageStats: (saved) => {
            combat.damageStatisticHolder.clear();
            for (const item of saved) combat.damageStatisticHolder.add(item);
        },
    };
    return {
        ...combat,
        fp,
        actor,
        primary,
        a,
        b,
        ally,
        context,
        engine,
        deps,
        defend,
        catalog,
        reserved,
        fire,
        cell,
        add,
    };
}

describe("own Last Fuse combat trades", () => {
    test("retains a counter trade that finishes only the armored primary instead of spending the blast twice", () => {
        const h = fixture({
            actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
            primary: { maxHp: 70, armor: 100 },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const old = h.catalog();
        expect(old.candidates.some((candidate) => candidate.lastFuseCounterTradeReserved)).toBe(false);
        expect(old.candidates.some((candidate) => candidate.targetId === h.primary.getId())).toBe(false);
        const trade = h.reserved(true);
        expect(trade.targetId).toBe(h.primary.getId());
        expect(trade.features.expectedDamage).toBe(0);
        const before = h.a.getCumulativeHp() + h.b.getCumulativeHp();
        const blast = h.fire(trade);
        expect(h.actor.isDead()).toBe(true);
        expect(h.primary.isDead()).toBe(true);
        expect(blast.flatMap((event) => event.hits)).toEqual([
            expect.objectContaining({ unitId: h.primary.getId(), amount: 70 }),
        ]);
        expect(h.a.getCumulativeHp() + h.b.getCumulativeHp()).toBe(before);
    });

    test("preserves the existing cluster reservation when the primary fallback is enabled", () => {
        const h = fixture();
        expect(h.catalog(true, 1, true)).toEqual(h.catalog());
        expect(h.catalog(false, 1, true)).toEqual(h.catalog(false));
    });

    test("does not forecast retaliation when even the whole remaining target cannot repay the holder's health", () => {
        const h = fixture({
            hp: 100,
            primary: { maxHp: 70, armor: 100 },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const trade = h.catalog(false, 0).candidates.find((candidate) => candidate.targetId === h.primary.getId())!;
        expect(trade).toBeDefined();
        const forecast = spyOn(h.primary, "calculateAttackDamageMin");
        try {
            expect(
                lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions, {
                    includePrimaryTarget: true,
                }),
            ).toBe(0);
            expect(forecast).not.toHaveBeenCalled();
        } finally {
            forecast.mockRestore();
        }
    });

    test("spends a primary Water Shield on a certain positive opening before the blast", () => {
        const h = fixture({
            primary: { maxHp: 70, abilities: ["Water Shield"] },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const trade = h.reserved(true);
        expect(trade.targetId).toBe(h.primary.getId());
        h.fire(trade);
        expect(h.primary.isDead()).toBe(true);
        expect(h.primary.hasBuffActive("Water Shield")).toBe(false);
    });

    test("does not count a primary shield that the opening cannot spend, or a primary already killed by the strike", () => {
        for (const options of [
            {
                actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
                primary: { maxHp: 70, armor: 100, abilities: ["Water Shield"] },
            },
            { actor: { abilities: ["Fire Element"] }, primary: { maxHp: 70, abilities: ["Water Shield"] } },
            { primary: { maxHp: 1 } },
            { primary: { maxHp: 70, abilities: ["Resurrection"], spells: [":Resurrection"] } },
            { primary: { maxHp: 70, armor: 100 }, hp: 100 },
            { primary: { maxHp: 70, armor: 100, damageMin: 0, damageMax: 0 } },
            { primary: { maxHp: 70, armor: 100 }, actor: { abilities: ["Water Shield"] } },
            { primary: { maxHp: 70, armor: 100 }, actor: { abilities: ["Double Punch"] } },
            { primary: { maxHp: 70, abilities: ["Water Shield", "Dodge"] } },
            {
                primary: { maxHp: 70, abilities: ["Water Shield"] },
                actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 0, damageMax: 4 },
            },
            { primary: { maxHp: 70 }, actor: { damageMin: 1, damageMax: 100 } },
        ]) {
            const h = fixture({
                ...options,
                neighborCells: [
                    { x: 3, y: 7 },
                    { x: 3, y: 8 },
                ],
            });
            expect(
                h.catalog(true, 1, true).candidates.some((candidate) => candidate.lastFuseCounterTradeReserved),
            ).toBe(false);
        }
    });

    test("public search can choose the zero-damage primary finisher and leaves the live battle untouched", () => {
        withSearchEnvironment(
            {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_SHORTLIST: "2",
                SEARCH_MAX_MELEE: "1",
                SEARCH_MAX_MOVES: "1",
                SEARCH_A19_LAST_FUSE_TRADES: "1",
                SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "1",
                SEARCH_HORIZON: "1",
                SEARCH_ROLLOUTS: "1",
                SEARCH_GATE: "0",
                V07_VALUE_WEIGHTS: "material",
                V07_VALUE_WEIGHTS_V2: undefined,
            },
            () => {
                const h = fixture({
                    actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
                    primary: { maxHp: 70, armor: 100 },
                    primaryRooted: true,
                    neighborCells: [
                        { x: 3, y: 7 },
                        { x: 3, y: 8 },
                    ],
                });
                const trade = h.reserved(true);
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
                const chosen = new SearchDriver(h.deps).chooseDecision(h.actor, "v0.8", h.defend);
                expect(chosen).toEqual(trade.actions);
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
                expect(h.deps.getActiveUnitId()).toBe(h.actor.getId());
                expect(h.damageStatisticHolder.get()).toHaveLength(0);
            },
        );
    });

    test("the production A19 profile can set up the primary-only blast on a zero-damage strike", () => {
        const h = fixture({
            actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
            primary: { maxHp: 70, armor: 100 },
            primaryRooted: true,
            neighbor: { team: LEFT },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        const chosen = createV08A19SearchDriver(h.deps, { greenVersion: "v0.8", redVersion: "v0.8" }).chooseDecision(
            h.actor,
            "v0.8",
            h.defend,
        );
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        const move = chosen.find((action) => action.type === "move_unit");
        expect(move).toBeDefined();
        expect(
            h.actor
                .getFootprintCellsForAnchor(move!.targetCells[0]!)
                .some((a) => h.primary.getCells().some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1)),
        ).toBe(true);
        h.fire({ actions: chosen });
        if (!h.actor.isDead()) {
            h.fp.startTurn(h.primary.getTeam(), 1000);
            h.deps.setActiveUnitId(h.primary.getId());
            expect(
                h.engine.apply({
                    type: "melee_attack",
                    attackerId: h.primary.getId(),
                    targetId: h.actor.getId(),
                    attackFrom: h.primary.getBaseCell(),
                }).completed,
            ).toBe(true);
        }
        expect(h.actor.isDead()).toBe(true);
        expect(h.primary.isDead()).toBe(true);
        expect(h.ally?.isDead()).toBe(false);
    });

    test.each([0, 1, 2, 3])("the primary fallback executes from rotation %i and either mirrored seat", (rotate) => {
        for (const team of [LEFT, RIGHT]) {
            const h = fixture({
                team,
                rotate,
                mirror: true,
                actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
                primary: { maxHp: 70, armor: 100 },
                neighborCells: [
                    { x: 3, y: 7 },
                    { x: 3, y: 8 },
                ],
            });
            h.fire(h.reserved(true));
            expect(h.primary.isDead()).toBe(true);
            expect(h.actor.isDead()).toBe(true);
        }
    });

    test.each([
        [1, 2],
        [2, 1],
        [2, 2],
    ])("the primary fallback respects a %ix%i enemy body", (width, height) => {
        const h = fixture({
            actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
            primary: { maxHp: 70, armor: 100, footprintWidth: width, footprintHeight: height },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const blast = h.fire(h.reserved(true));
        expect(blast.flatMap((event) => event.hits)).toEqual([
            expect.objectContaining({ unitId: h.primary.getId(), amount: 70 }),
        ]);
    });

    test("the primary projection is pure and does not spend live shields or consume RNG while caching", () => {
        const h = fixture({
            primary: { maxHp: 70, abilities: ["Water Shield"] },
            neighborCells: [
                { x: 3, y: 7 },
                { x: 3, y: 8 },
            ],
        });
        const trade = h.reserved(true);
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        const options = {
            includePrimaryTarget: true,
            fatalChanceByTarget: new Map<string, number>(),
            primaryBlastByTarget: new Map<string, number>(),
        };
        setDeterministicRandomSource(() => {
            throw new Error("Projection consumed combat RNG");
        });
        expect(
            lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions, options),
        ).toBe(60);
        expect(
            lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions, options),
        ).toBe(60);
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        expect(h.primary.hasBuffActive("Water Shield")).toBe(true);
    });

    test("the zero-damage reservation does not force a losing last-stack suicide", () => {
        withSearchEnvironment(
            {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_SHORTLIST: "2",
                SEARCH_MAX_MELEE: "1",
                SEARCH_MAX_MOVES: "1",
                SEARCH_A19_LAST_FUSE_TRADES: "1",
                SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "1",
                SEARCH_A19_EXACT_TERMINAL_RESULTS: "1",
                SEARCH_HORIZON: "1",
                SEARCH_ROLLOUTS: "1",
                SEARCH_GATE: "0",
                V07_VALUE_WEIGHTS: "material",
                V07_VALUE_WEIGHTS_V2: undefined,
            },
            () => {
                const h = fixture({
                    ally: false,
                    actor: { attackType: PBTypes.AttackVals.RANGE, rangeShots: 0, damageMin: 2, damageMax: 2 },
                    primary: { maxHp: 70, armor: 100 },
                    primaryRooted: true,
                    neighborCells: [
                        { x: 3, y: 7 },
                        { x: 3, y: 8 },
                    ],
                });
                const trade = h.reserved(true);
                const chosen = new SearchDriver(h.deps).chooseDecision(h.actor, "v0.8", h.defend);
                expect(chosen).not.toEqual(trade.actions);
                expect(h.actor.isDead()).toBe(false);
            },
        );
    });

    test("preserves a stronger explosion stand across a melee cap and hits the real neighboring enemies", () => {
        const h = fixture();
        const old = h.catalog(false),
            extended = h.catalog(true);
        const trade = extended.candidates.find((candidate) => candidate.lastFuseCounterTradeReserved);
        expect(trade).toBeDefined();
        expect(old.candidates.filter((c) => c.kind === "melee")).toHaveLength(1);
        expect(extended.candidates.filter((c) => c.kind === "melee")).toHaveLength(2);
        expect(trade?.targetId).toBe(h.primary.getId());
        const blast = h.fire(trade!);
        expect(h.actor.isDead()).toBe(true);
        expect(blast).toHaveLength(1);
        expect(blast[0]?.hits.map((hit) => hit.unitId)).toEqual(expect.arrayContaining([h.a.getId(), h.b.getId()]));
        expect(h.a.isDead()).toBe(true);
        expect(h.b.isDead()).toBe(true);
        expect(h.ally?.getCumulativeHp()).toBe(1000);
    });

    test.each([0, 1, 2, 3])("projects and executes the same trade at board rotation %i", (rotate) => {
        const h = fixture({ rotate });
        const trade = h.reserved();
        expect(
            lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions),
        ).toBeGreaterThan(0);
        const hits = h.fire(trade).flatMap((blast) => blast.hits);
        expect(hits.map((hit) => hit.unitId)).toEqual(expect.arrayContaining([h.a.getId(), h.b.getId()]));
    });

    test.each([LEFT, RIGHT])("handles either seat and a mirrored board (seat %i)", (team) => {
        const h = fixture({ team, mirror: true });
        const trade = h.reserved();
        h.fire(trade);
        expect(h.a.isDead()).toBe(true);
        expect(h.b.isDead()).toBe(true);
    });

    test.each([
        [1, 2],
        [2, 1],
        [2, 2],
    ])("uses a %ix%i future corpse footprint", (width, height) => {
        const h = fixture({ actor: { footprintWidth: width, footprintHeight: height } });
        const trade = h.reserved();
        const corpse = h.actor.getFootprintCellsForAnchor(trade.standCell!);
        const expected = [h.a, h.b].filter((enemy) =>
            enemy.getCells().some((a) => corpse.some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1)),
        );
        expect(expected.length).toBeGreaterThan(0);
        const hits = h.fire(trade).flatMap((blast) => blast.hits);
        for (const enemy of expected) expect(hits.map((hit) => hit.unitId)).toContain(enemy.getId());
    });

    test("uses fatal remaining health and the power floor rather than incoming overkill or original maximum health", () => {
        const h = fixture();
        h.actor.setStackPower(1);
        const all = h.catalog(true, 0).candidates;
        const trade = all.find((c) => c.lastFuseCounterTradeReserved)!;
        expect(h.actor.getLastFuseDamage()).toBe(20);
        expect(lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions)).toBe(30);
    });

    test("armor and magic immunity do not reduce a projected or real blast", () => {
        const h = fixture({ neighbor: { armor: 100, magicResist: 100 } });
        h.fire(h.reserved());
        expect(h.a.isDead()).toBe(true);
        expect(h.b.isDead()).toBe(true);
    });

    test("does not hunt death with a safe counter, a spent counter, native resurrection or an absorbing shield", () => {
        for (const options of [
            { primary: { damageMin: 0, damageMax: 0 } },
            { actor: { abilities: ["Resurrection"], spells: [":Resurrection"] } },
            { actor: { abilities: ["Water Shield"] } },
        ]) {
            const h = fixture(options);
            expect(h.catalog().candidates.some((candidate) => candidate.lastFuseCounterTradeReserved)).toBe(false);
        }
        const spent = fixture();
        spent.fp.addRepliedAttack(spent.primary.getId());
        expect(spent.catalog().candidates.some((candidate) => candidate.lastFuseCounterTradeReserved)).toBe(false);
    });

    test("ignores shielded blast recipients and never adds the same shortlist candidate twice", () => {
        const shielded = fixture({ neighbor: { abilities: ["Water Shield"] } });
        expect(shielded.catalog().candidates.some((candidate) => candidate.lastFuseCounterTradeReserved)).toBe(false);
        const h = fixture();
        const candidates = h.catalog().candidates;
        const trade = candidates.find((c) => c.lastFuseCounterTradeReserved)!;
        const normal = candidates.filter((c) => c.kind === "melee" && c !== trade);
        expect(reserveLastFuseShortlistCandidate(candidates, normal)).toEqual([...normal, trade]);
        const retained = [...normal, trade];
        expect(reserveLastFuseShortlistCandidate(candidates, retained)).toBe(retained);
    });

    test("can trade through a fire counter that bypasses the owner's shield, while a neighboring shield swallows one blast", () => {
        const h = fixture({ actor: { abilities: ["Water Shield"] }, primary: { abilities: ["Fire Element"] } });
        h.a.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        const hp = h.a.getCumulativeHp();
        const trade = h
            .catalog(true, 0)
            .candidates.find(
                (candidate) =>
                    candidate.targetId === h.primary.getId() &&
                    candidate.standCell?.x === 7 &&
                    candidate.standCell.y === 8,
            )!;
        expect(
            lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions),
        ).toBeGreaterThan(0);
        h.fire(trade);
        expect(h.actor.isDead()).toBe(true);
        expect(h.a.getCumulativeHp()).toBe(hp);
        expect(h.a.hasBuffActive("Water Shield")).toBe(false);
        expect(h.b.isDead()).toBe(true);
    });

    test("is RNG-free, leaves live state unchanged and preserves the historical catalog when disabled", () => {
        const h = fixture();
        const trade = h.reserved();
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        setDeterministicRandomSource(() => {
            throw new Error("Last Fuse projection must be pure");
        });
        expect(
            lastFuseCounterTradePotential(h.actor, h.primary, h.context, trade.standCell!, trade.actions),
        ).toBeGreaterThan(0);
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        expect(h.catalog(false)).toEqual(
            enumerateCandidates(h.actor, h.context, h.defend, {
                maxMeleePairs: 1,
                maxMoveDestinations: 1,
                enrichIncumbentMetadata: true,
            }),
        );
    });

    test("real search uses the profitable stand and restores the live battle", () => {
        withSearchEnvironment(
            {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_SHORTLIST: "2",
                SEARCH_MAX_MELEE: "1",
                SEARCH_MAX_MOVES: "1",
                SEARCH_A19_LAST_FUSE_TRADES: "1",
                SEARCH_HORIZON: "1",
                SEARCH_ROLLOUTS: "1",
                SEARCH_GATE: "0",
                V07_VALUE_WEIGHTS: "material",
                V07_VALUE_WEIGHTS_V2: undefined,
            },
            () => {
                const h = fixture();
                const trade = h.reserved();
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
                const chosen = new SearchDriver(h.deps).chooseDecision(h.actor, "v0.8", h.defend);
                expect(chosen).toEqual(trade.actions);
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
                expect(h.deps.getActiveUnitId()).toBe(h.actor.getId());
                expect(h.damageStatisticHolder.get()).toHaveLength(0);
            },
        );
    });

    test("the engine terminal score rejects a sacrifice that leaves the owner with no army", () => {
        withSearchEnvironment(
            {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_A19_LAST_FUSE_TRADES: "1",
                SEARCH_A19_EXACT_TERMINAL_RESULTS: "1",
                SEARCH_ROLLOUTS: "1",
                V07_VALUE_WEIGHTS: "material",
            },
            () => {
                const h = fixture({ ally: false });
                const trade = h.reserved();
                const driver = new SearchDriver(h.deps) as unknown as {
                    scoreCandidates: (
                        unit: Unit,
                        candidates: IEnumeratedCandidate[],
                        seed: number,
                        horizon: "turns",
                        count: number,
                        deadline: null,
                        turns: number,
                    ) => number[];
                };
                const retreat = enumerateCandidates(h.actor, h.context, h.defend).candidates.find(
                    (candidate) =>
                        candidate.kind === "move" && candidate.targetCell?.x === 2 && candidate.targetCell.y === 7,
                )!;
                expect(retreat).toBeDefined();
                const scores = driver.scoreCandidates(h.actor, [retreat, trade], 4433, "turns", 1, null, 1);
                expect(scores[0]).toBeGreaterThan(0);
                expect(scores[1]).toBe(0);
            },
        );
    });

    test("real search detects an enemy Fuse chain that would also destroy the protected ally", () => {
        withSearchEnvironment(
            {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_A19_LAST_FUSE_TRADES: "1",
                SEARCH_A19_EXACT_TERMINAL_RESULTS: "1",
                SEARCH_ROLLOUTS: "1",
                V07_VALUE_WEIGHTS: "material",
            },
            () => {
                const h = fixture({ allyCell: { x: 9, y: 10 }, allyProps: { maxHp: 50 } });
                h.fp.setArtifactPerTeam(h.primary.getTeam(), 2, Tier2Artifact.LAST_FUSE);
                h.unitsHolder.applyArtifacts(h.fp);
                const trade = h.reserved();
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
                const driver = new SearchDriver(h.deps) as unknown as {
                    scoreCandidates: (
                        unit: Unit,
                        candidates: IEnumeratedCandidate[],
                        seed: number,
                        horizon: "turns",
                        count: number,
                        deadline: null,
                        turns: number,
                    ) => number[];
                };
                expect(driver.scoreCandidates(h.actor, [trade], 4433, "turns", 1, null, 1)).toEqual([0]);
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
            },
        );
    });
});
