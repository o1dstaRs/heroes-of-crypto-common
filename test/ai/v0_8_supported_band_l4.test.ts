/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the root directory
 * of this source tree.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getEnemiesCellsWithinMovementRange, type IAIPolicyEvent, type IDecisionContext } from "../../src/ai";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings, type CombatTestContext } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

const LEVEL4_UNITS = [
    {
        faction: "Life",
        name: "Champion",
        abilities: ["Tie up the Horses Aura", "Crusade", "Rapid Charge"],
        configuredSteps: 5.2,
        effectiveSteps: 5,
    },
    {
        faction: "Nature",
        name: "Arachna Queen",
        abilities: ["Web Aura", "Infest", "Predatory Assimilation"],
        configuredSteps: 6.3,
        effectiveSteps: 6,
    },
    {
        faction: "Chaos",
        name: "Abomination",
        abilities: ["Dense Flesh", "Flesh Shield Aura"],
        configuredSteps: 4.2,
        effectiveSteps: 4,
    },
    {
        faction: "Might",
        name: "Frenzied Boar",
        abilities: ["AI Driven", "Magic Shield", "Boar Saliva"],
        configuredSteps: 7,
        effectiveSteps: 7,
    },
] as const;

type Level4Spec = (typeof LEVEL4_UNITS)[number];

interface IBandHarness {
    combat: CombatTestContext;
    shooter: Unit;
    target: Unit;
    context: IDecisionContext;
    destination: XY;
}

function configuredUnit(spec: Level4Spec, team: typeof LOWER | typeof UPPER): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, spec.faction, spec.name, "", 1),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function footprint(unit: Unit, anchor: XY): XY[] {
    if (unit.isSmallSize()) return [{ ...anchor }];
    return [
        { ...anchor },
        { x: anchor.x, y: anchor.y - 1 },
        { x: anchor.x - 1, y: anchor.y },
        { x: anchor.x - 1, y: anchor.y - 1 },
    ];
}

function placeAtAnchor(combat: CombatTestContext, unit: Unit, anchor: XY): void {
    const cells = footprint(unit, anchor);
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error(`Unable to place ${unit.getName()} at ${anchor.x},${anchor.y}`);
    unit.setPosition(position.x, position.y);
    expect(
        combat.grid.occupyCells(
            cells,
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.hasAbilityActive("Made of Fire"),
            unit.hasAbilityActive("Made of Water"),
        ),
        `${unit.getName()} footprint should be legal`,
    ).toBe(true);
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
        decisionOrigin: "root",
    };
}

function setOnlyRoute(context: IDecisionContext, destination: XY): void {
    const destinationHash = (destination.x << 4) | destination.y;
    context.pathHelper = {
        getMovePath: () => ({
            cells: [destination],
            hashes: new Set([destinationHash]),
            knownPaths: new Map([
                [
                    destinationHash,
                    [
                        {
                            cell: destination,
                            route: [destination],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: false,
                            hasWaterCell: false,
                        },
                    ],
                ],
            ]),
        }),
    } as unknown as PathHelper;
}

function enableSupportedBand(): void {
    process.env.V08_RANGED_POSITION_MODE = "both";
    process.env.V08_RANGED_POSITION_VERSIONS = "v0.8";
    process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
    process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";
    process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
    process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
}

function observeDecision(harness: IBandHarness): {
    actions: ReturnType<StrategyV0_8["decideTurn"]>;
    events: IAIPolicyEvent[];
    stages: string[];
} {
    const events: IAIPolicyEvent[] = [];
    harness.context.policyEventObserver = (event) => events.push(event);
    const actions = new StrategyV0_8().decideTurn(harness.shooter, harness.context);
    return {
        actions,
        events,
        stages: events.flatMap((event) =>
            event.kind === "v0.8_supported_band_advance_funnel" && event.stage ? [event.stage] : [],
        ),
    };
}

function setupLevel4Guard(spec: Level4Spec, stolenQuiver = false): IBandHarness & { guard: Unit } {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Level-4 guarded archer",
        attackType: RANGE,
        speed: 1,
        rangeShots: 8,
        shotDistance: 5,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: UPPER,
        name: "Ranged band target",
        attackType: RANGE,
        speed: 0,
        rangeShots: 8,
        shotDistance: 16,
        damageMin: 1,
        damageMax: 1,
        amountAlive: 20,
        maxHp: 20,
    });
    const guard = configuredUnit(spec, LOWER);
    const destination = { x: 7, y: 7 };
    placeAtAnchor(combat, shooter, { x: 7, y: 8 });
    placeAtAnchor(combat, target, { x: 7, y: 2 });
    placeAtAnchor(combat, guard, { x: 10, y: 7 });
    if (stolenQuiver) {
        guard.grantStolenAbility("Endless Quiver");
        guard.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        guard.refreshPossibleAttackTypes(
            combat.attackHandler.canLandRangeAttack(guard, combat.grid.getEnemyAggrMatrixByUnitId(guard.getId())),
        );
    }
    const context = decisionContext(combat);
    context.fightProperties!.addRepliedAttack(target.getId());
    setOnlyRoute(context, destination);
    shooter.refreshPossibleAttackTypes(
        combat.attackHandler.canLandRangeAttack(shooter, combat.grid.getEnemyAggrMatrixByUnitId(shooter.getId())),
    );
    return { combat, shooter, target, guard, context, destination };
}

function setupLevel4Target(
    spec: Level4Spec,
    options: {
        safe: boolean;
        stolenQuiver?: boolean;
        spentResponse?: boolean;
        urgentFinish?: boolean;
        shooterShots?: number;
    },
): IBandHarness {
    const combat = createCombatTestContext();
    const target = configuredUnit(spec, UPPER);
    if (options.stolenQuiver) {
        target.grantStolenAbility("Endless Quiver");
        target.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
    }
    const meleeHorizon = Math.ceil(target.getSteps()) + 1;
    const targetAnchor = { x: 7, y: 3 };
    const targetTopY = targetAnchor.y;
    const destinationDistance = options.safe ? meleeHorizon + 1 : meleeHorizon;
    const destination = { x: 7, y: targetTopY + destinationDistance };
    const shooter = createTestUnit({
        team: LOWER,
        name: "Level-4 target archer",
        attackType: RANGE,
        speed: 1,
        rangeShots: options.shooterShots ?? 8,
        shotDistance: destinationDistance,
        damageMin: 10,
        damageMax: 10,
    });
    const guard = createTestUnit({ team: LOWER, name: "Target-horizon guard", attackType: MELEE, speed: 1 });
    placeAtAnchor(combat, target, targetAnchor);
    placeAtAnchor(combat, shooter, { x: destination.x, y: destination.y + 1 });
    placeAtAnchor(combat, guard, { x: destination.x + 2, y: destination.y - 2 });

    const context = decisionContext(combat);
    if (options.spentResponse) context.fightProperties!.addRepliedAttack(target.getId());
    if (options.urgentFinish) {
        while (context.fightProperties!.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            context.fightProperties!.flipLap();
        }
    }
    setOnlyRoute(context, destination);
    shooter.refreshPossibleAttackTypes(
        combat.attackHandler.canLandRangeAttack(shooter, combat.grid.getEnemyAggrMatrixByUnitId(shooter.getId())),
    );
    if (options.stolenQuiver) {
        target.refreshPossibleAttackTypes(
            combat.attackHandler.canLandRangeAttack(target, combat.grid.getEnemyAggrMatrixByUnitId(target.getId())),
        );
    }
    return { combat, shooter, target, context, destination };
}

afterEach(() => {
    delete process.env.V08_RANGED_POSITION_MODE;
    delete process.env.V08_RANGED_POSITION_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS;
});

describe("v0.8 supported-band level-4 promotion coverage", () => {
    it("uses every configured v0.8 level-4 stack as a size-two native melee guard", () => {
        enableSupportedBand();
        for (const spec of LEVEL4_UNITS) {
            const harness = setupLevel4Guard(spec);
            expect(harness.guard.getAttackType(), spec.name).toBe(MELEE);
            expect(harness.guard.isSmallSize(), spec.name).toBe(false);
            expect(
                harness.guard.getAbilities().map((ability) => ability.getName()),
                spec.name,
            ).toEqual(spec.abilities);

            const result = observeDecision(harness);
            expect(
                result.actions.map((action) => action.type),
                spec.name,
            ).toEqual(["move_unit", "range_attack"]);
            expect(result.actions[0], spec.name).toMatchObject({
                type: "move_unit",
                targetCells: [harness.destination],
            });
            expect(result.actions[1], spec.name).toMatchObject({
                type: "range_attack",
                targetId: harness.target.getId(),
            });
            expect(result.stages, spec.name).toContain("native_guard");
            expect(result.stages, spec.name).toContain("target_screened");
            expect(
                result.events.map((event) => event.kind),
                spec.name,
            ).toContain("v0.8_supported_band_advance");
        }
    });

    it("uses each level-4 target's real size and optimistic melee horizon", () => {
        enableSupportedBand();
        for (const spec of LEVEL4_UNITS) {
            const safe = setupLevel4Target(spec, { safe: true, urgentFinish: true });
            expect(safe.target.getAllProperties().steps, spec.name).toBe(spec.configuredSteps);
            expect(safe.target.getSteps(), spec.name).toBe(spec.effectiveSteps);
            expect(safe.target.getCells(), spec.name).toHaveLength(4);
            const safeResult = observeDecision(safe);
            expect(
                safeResult.actions.map((action) => action.type),
                `${spec.name} safe`,
            ).toEqual(["move_unit", "range_attack"]);
            expect(safeResult.stages, `${spec.name} safe`).toContain("zero_exposure_route");
            expect(
                safeResult.events.map((event) => event.kind),
                `${spec.name} safe`,
            ).toContain("v0.8_supported_band_advance");

            const reachable = setupLevel4Target(spec, { safe: false, urgentFinish: true });
            const reachableResult = observeDecision(reachable);
            expect(
                reachableResult.actions.map((action) => action.type),
                `${spec.name} reachable`,
            ).toEqual(["range_attack"]);
            expect(reachableResult.stages, `${spec.name} reachable`).not.toContain("zero_exposure_route");
            expect(
                reachableResult.events.map((event) => event.kind),
                `${spec.name} reachable`,
            ).not.toContain("v0.8_supported_band_advance");
        }
    });

    it("keeps an assimilated Arachna Queen outside the native ranged actor gate", () => {
        enableSupportedBand();
        const combat = createCombatTestContext();
        const queenSpec = LEVEL4_UNITS[1];
        const queen = configuredUnit(queenSpec, LOWER);
        const target = createTestUnit({
            team: UPPER,
            name: "Assimilated shot target",
            maxHp: 1_000,
            amountAlive: 10,
        });
        placeAtAnchor(combat, queen, { x: 7, y: 11 });
        placeAtAnchor(combat, target, { x: 7, y: 1 });
        queen.grantStolenAbility("Endless Quiver");
        queen.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        const context = decisionContext(combat);
        queen.refreshPossibleAttackTypes(
            combat.attackHandler.canLandRangeAttack(queen, combat.grid.getEnemyAggrMatrixByUnitId(queen.getId())),
        );
        expect(queen.getAttackType()).toBe(MELEE);
        expect(queen.isRangeCapable()).toBe(true);
        expect(queen.selectAttackType(RANGE)).toBe(true);

        const events: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => events.push(event);
        const actions = new StrategyV0_8().decideTurn(queen, context);
        expect(actions.map((action) => action.type)).toEqual(["range_attack"]);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(
            events.filter((event) => event.kind === "v0.8_supported_band_advance_funnel").map((event) => event.stage),
        ).toEqual(["ordinary_shot"]);
        expect(events.map((event) => event.kind)).not.toContain("v0.8_supported_band_advance");
    });

    it("keeps an assimilated Arachna Queen as a native guard while its ranged output holds the line", () => {
        enableSupportedBand();
        const harness = setupLevel4Guard(LEVEL4_UNITS[1], true);
        expect(harness.guard.getAttackType()).toBe(MELEE);
        expect(harness.guard.isRangeCapable()).toBe(true);
        expect(harness.guard.getRangeShots()).toBe(99);

        const result = observeDecision(harness);
        expect(result.actions.map((action) => action.type)).toEqual(["range_attack"]);
        expect(result.stages).toContain("native_guard");
        expect(result.stages).not.toContain("ranged_posture");
        expect(result.events.map((event) => event.kind)).not.toContain("v0.8_supported_band_advance");
    });

    it("treats an assimilated enemy Arachna Queen as a live ranged counter until its response is spent", () => {
        enableSupportedBand();
        const queenSpec = LEVEL4_UNITS[1];
        const liveCounter = setupLevel4Target(queenSpec, {
            safe: true,
            stolenQuiver: true,
        });
        const liveResult = observeDecision(liveCounter);
        expect(liveCounter.target.isRangeCapable()).toBe(true);
        expect(liveResult.actions.map((action) => action.type)).toEqual(["range_attack"]);
        expect(liveResult.stages).toEqual(["ordinary_shot", "eligible_shooter"]);

        const spentCounter = setupLevel4Target(queenSpec, {
            safe: true,
            stolenQuiver: true,
            spentResponse: true,
        });
        const spentResult = observeDecision(spentCounter);
        expect(spentResult.actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(spentResult.stages).toContain("target_no_counter");
        expect(spentResult.events.map((event) => event.kind)).toContain("v0.8_supported_band_advance");
    });

    it("executes the moved shot against Dense Flesh with its exact ammo cost and damage", () => {
        enableSupportedBand();
        const harness = setupLevel4Target(LEVEL4_UNITS[2], {
            safe: true,
            urgentFinish: true,
            shooterShots: 3,
        });
        const decision = observeDecision(harness).actions;
        expect(decision.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(harness.target.hasAbilityActive("Dense Flesh")).toBe(true);

        const fightProperties = harness.context.fightProperties!;
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(LOWER, harness.combat.unitsHolder.getAllAllies(LOWER).length);
        fightProperties.setTeamUnitsAlive(UPPER, harness.combat.unitsHolder.getAllAllies(UPPER).length);
        fightProperties.startTurn(LOWER, 1_000);
        const engine = new GameActionEngine({
            fightProperties,
            grid: harness.combat.grid,
            unitsHolder: harness.combat.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, harness.combat.grid, harness.combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: harness.combat.attackHandler,
            getCurrentActiveUnitId: () => harness.shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () =>
                getEnemiesCellsWithinMovementRange(harness.shooter, harness.context),
        });
        const hpBefore = harness.target.getCumulativeHp();
        const shotsBefore = harness.shooter.getRangeShots();
        const results = decision.map((action) => engine.apply(action));

        expect(results.every((result) => result.completed)).toBe(true);
        expect(harness.target.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(shotsBefore - harness.shooter.getRangeShots()).toBe(2);
    });
});
