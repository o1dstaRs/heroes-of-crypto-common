import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import {
    enumerateCandidates,
    findBestLegalStationaryRangeAttack,
    getEnemiesCellsWithinMovementRange,
} from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import {
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { traceGridRayCells } from "../../src/grid/ray_traversal";
import type { IRangeAttackEvaluation } from "../../src/handlers/attack_handler";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { isSmokeableCell, SmokeClouds } from "../../src/spells/smoke_clouds";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const RANGE = PBTypes.AttackVals.RANGE;

function nativeWanderingMage(): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(LEFT, "Chaos", "Wandering Mage", "", 50),
        testGridSettings,
        LEFT,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
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

function smokeCells(anchor: XY): XY[] {
    return [
        anchor,
        { x: anchor.x + 1, y: anchor.y },
        { x: anchor.x, y: anchor.y + 1 },
        { x: anchor.x + 1, y: anchor.y + 1 },
    ];
}

interface ISmokeHarness {
    combat: CombatTestContext;
    caster: Unit;
    enemy: Unit;
    context: IDecisionContext;
    engine: GameActionEngine;
}

function smokeHarness(
    gridType: GridType,
    casterCell: XY = { x: 2, y: 8 },
    enemyCell: XY = { x: 13, y: 8 },
): ISmokeHarness {
    const combat = createCombatTestContext(gridType);
    const caster = nativeWanderingMage();
    const enemy = createTestUnit({
        team: RIGHT,
        name: "Enemy Ranger",
        attackType: RANGE,
        rangeShots: 8,
        damageMax: 20,
    });
    placeUnit(combat.grid, combat.unitsHolder, caster, casterCell);
    placeUnit(combat.grid, combat.unitsHolder, enemy, enemyCell);

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LEFT, 1);
    fightProperties.setTeamUnitsAlive(RIGHT, 1);
    fightProperties.startTurn(LEFT, 1_000);
    const context = decisionContext(combat);
    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => caster.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(caster, context),
    });
    return { combat, caster, enemy, context, engine };
}

function smokeCandidates(harness: ISmokeHarness) {
    const incumbent: GameAction[] = [{ type: "end_turn", unitId: harness.caster.getId(), reason: "manual" }];
    return enumerateCandidates(harness.caster, harness.context, incumbent).candidates.filter(
        (candidate) => candidate.kind === "spell" && candidate.spellName === "Smoke",
    );
}

describe("Smoke cell legality oracle", () => {
    test("rejects off-grid, units, mountains, holes, and caster occupancy while allowing ground and fluids", () => {
        const normal = createCombatTestContext();
        const caster = nativeWanderingMage();
        const other = createTestUnit({ team: RIGHT, name: "Occupant" });
        placeUnit(normal.grid, normal.unitsHolder, caster, { x: 2, y: 8 });
        placeUnit(normal.grid, normal.unitsHolder, other, { x: 3, y: 8 });
        normal.grid.occupyByHole({ x: 4, y: 8 });

        const offGrid = { x: -1, y: 8 };
        expect(isCellWithinGrid(normal.grid.getSettings(), offGrid)).toBe(false);
        expect(isSmokeableCell(normal.grid, isCellWithinGrid(normal.grid.getSettings(), offGrid), offGrid)).toBe(false);
        expect(isSmokeableCell(normal.grid, true, other.getBaseCell())).toBe(false);
        expect(isSmokeableCell(normal.grid, true, caster.getBaseCell())).toBe(false);
        expect(isSmokeableCell(normal.grid, true, { x: 4, y: 8 })).toBe(false);
        expect(isSmokeableCell(normal.grid, true, { x: 5, y: 8 })).toBe(true);

        const block = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER).grid;
        const lava = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER).grid;
        const water = createCombatTestContext(PBTypes.GridVals.WATER_CENTER).grid;
        const terrainCell = { x: 6, y: 7 };
        expect(block.getOccupantUnitId(terrainCell)).toBe("B");
        expect(isSmokeableCell(block, true, terrainCell)).toBe(false);
        expect(lava.getOccupantUnitId(terrainCell)).toBe("L");
        expect(isSmokeableCell(lava, true, terrainCell)).toBe(true);
        expect(water.getOccupantUnitId(terrainCell)).toBe("W");
        expect(isSmokeableCell(water, true, terrainCell)).toBe(true);
    });
});

describe("authoritative hypothetical Smoke range evaluation", () => {
    test("does not credit a center-line cloud when another visible target edge bypasses it", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Edge-aware ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const target = createTestUnit({ team: LEFT, name: "Edge target", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 1 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 2, y: 3 });
        const context = decisionContext(combat);
        const hypothetical = smokeCells({ x: 2, y: 1 });
        const smokeHashes = new Set(hypothetical.map((cell) => `${cell.x},${cell.y}`));

        expect(
            traceGridRayCells(testGridSettings, shooter.getPosition(), target.getPosition()).some(([cell]) =>
                smokeHashes.has(`${cell.x},${cell.y}`),
            ),
        ).toBe(true);

        const divisors = RANGE_ATTACK_CELL_SIDES.map((side) => {
            const to = getRangeAttackSideCenter(testGridSettings, target.getBaseCell(), side, shooter.getPosition());
            return combat.attackHandler.evaluateRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                to,
                false,
                false,
                false,
                hypothetical,
            ).rangeAttackDivisors[0];
        });
        expect(divisors).toContain(1);
        expect(divisors).toContain(2);

        const before = findBestLegalStationaryRangeAttack(shooter, context);
        const after = findBestLegalStationaryRangeAttack(shooter, context, hypothetical);
        expect(before?.expectedDamage).toBe(20);
        expect(after?.expectedDamage).toBe(before?.expectedDamage);
        expect(after?.aimSide).toBe(RangeAttackCellSide.LEFT);
        expect(context.fightProperties!.getSmokeClouds().size()).toBe(0);
    });

    test("keeps Smoke sticky for downstream Through Shot targets only after the ray crosses it", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Through ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
            abilities: ["Through Shot"],
        });
        const front = createTestUnit({ team: LEFT, name: "Front", maxHp: 1_000 });
        const rear = createTestUnit({ team: LEFT, name: "Rear", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, front, { x: 6, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, rear, { x: 11, y: 5 });
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            front.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const hypothetical = smokeCells({ x: 8, y: 5 });

        const clear = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            true,
        );
        const smoked = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            true,
            false,
            false,
            hypothetical,
        );

        expect(clear.affectedUnits.map((group) => group[0]?.getId())).toEqual([front.getId(), rear.getId()]);
        expect(clear.rangeAttackDivisors).toEqual([1, 1]);
        expect(smoked.affectedUnits.map((group) => group[0]?.getId())).toEqual([front.getId(), rear.getId()]);
        expect(smoked.rangeAttackDivisors).toEqual([1, 2]);
    });

    test("stops at a mountain before downstream hypothetical Smoke or units", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Blocked ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const target = createTestUnit({ team: LEFT, name: "Blocked target", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 14, y: 8 });
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            target.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const hypothetical = smokeCells({ x: 10, y: 8 });

        const evaluation = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            false,
            false,
            false,
            hypothetical,
        );

        expect(evaluation.attackObstacle).toBeDefined();
        expect(evaluation.affectedUnits).toEqual([]);
        expect(evaluation.rangeAttackDivisors).toEqual([]);
    });

    test("does not apply a cloud behind the authoritative front interceptor", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Intercepted ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const front = createTestUnit({ team: LEFT, name: "Front interceptor", maxHp: 1_000 });
        const rear = createTestUnit({ team: LEFT, name: "Declared rear target", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, front, { x: 6, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, rear, { x: 11, y: 5 });
        const context = decisionContext(combat);
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            rear.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const hypothetical = smokeCells({ x: 8, y: 5 });

        const evaluation = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            false,
            false,
            false,
            hypothetical,
        );
        expect(evaluation.affectedUnits[0]?.[0]).toBe(front);
        expect(evaluation.affectedUnits[1]?.[0]).toBe(rear);
        expect(evaluation.rangeAttackDivisors).toEqual([1, 2]);
        expect(findBestLegalStationaryRangeAttack(shooter, context, hypothetical)?.expectedDamage).toBe(
            findBestLegalStationaryRangeAttack(shooter, context)?.expectedDamage,
        );
    });

    test("does not invent mitigation after range falloff has already reached the divisor-eight cap", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Long-range ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 80,
            damageMax: 80,
            shotDistance: 2,
        });
        const target = createTestUnit({ team: LEFT, name: "Distant target", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 1 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 14, y: 1 });
        const context = decisionContext(combat);
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            target.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const hypothetical = smokeCells({ x: 7, y: 1 });

        const clear = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
        );
        const smoked = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            false,
            false,
            false,
            hypothetical,
        );
        expect(clear.rangeAttackDivisors).toEqual([8]);
        expect(smoked.rangeAttackDivisors).toEqual([8]);
        expect(findBestLegalStationaryRangeAttack(shooter, context, hypothetical)?.expectedDamage).toBe(
            findBestLegalStationaryRangeAttack(shooter, context)?.expectedDamage,
        );
    });

    test("recomputes the best target after Smoke instead of valuing a blocked obsolete aim", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Retargeting ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const screened = createTestUnit({ team: LEFT, name: "Screened target", maxHp: 1_000 });
        const open = createTestUnit({ team: LEFT, name: "Open target", maxHp: 1_000 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 13, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, screened, { x: 2, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, open, { x: 13, y: 2 });
        const context = decisionContext(combat);
        const hypothetical = smokeCells({ x: 8, y: 7 });

        const before = findBestLegalStationaryRangeAttack(shooter, context);
        const after = findBestLegalStationaryRangeAttack(shooter, context, hypothetical);
        expect(before?.aimTargetId).toBe(screened.getId());
        expect(after?.aimTargetId).toBe(open.getId());
        expect(after?.expectedDamage).toBe(before?.expectedDamage);
    });
});

function evaluationView(evaluation: IRangeAttackEvaluation) {
    return {
        divisors: evaluation.rangeAttackDivisors,
        unitIds: evaluation.affectedUnits.map((group) => group.map((unit) => unit.getId())),
        affectedCells: evaluation.affectedCells,
        obstacle: evaluation.attackObstacle,
    };
}

describe("hypothetical/live Smoke differential", () => {
    test("rejects foreign prepared objects instead of evaluating unbound geometry", () => {
        const combat = createCombatTestContext();
        expect(() =>
            combat.attackHandler.evaluatePreparedRangeAttack({
                affectedUnits: [],
                affectedCells: [],
            }),
        ).toThrow("Prepared range attack was not created by this AttackHandler instance");

        const shooter = createTestUnit({ team: RIGHT, attackType: RANGE, rangeShots: 1 });
        const target = createTestUnit({ team: LEFT });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 1 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 8, y: 8 });
        const prepared = combat.attackHandler.prepareRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            target.getPosition(),
        );
        const other = createCombatTestContext().attackHandler;
        expect(() => other.evaluatePreparedRangeAttack(prepared)).toThrow(
            "Prepared range attack was not created by this AttackHandler instance",
        );
    });

    test("recomputes sticky live Smoke exactly for multiple hit groups", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Prepared Through ranger",
            attackType: RANGE,
            rangeShots: 8,
            abilities: ["Through Shot"],
        });
        const front = createTestUnit({ team: LEFT, name: "Prepared front" });
        const rear = createTestUnit({ team: LEFT, name: "Prepared rear" });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, front, { x: 6, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, rear, { x: 11, y: 5 });
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            front.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const prepared = combat.attackHandler.prepareRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            true,
        );
        const smoke = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
        smoke.add({ x: 8, y: 5 });

        const projected = combat.attackHandler.evaluatePreparedRangeAttack(prepared);
        const eager = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            true,
        );

        expect(projected.affectedUnits.map((group) => group[0]?.getId())).toEqual([front.getId(), rear.getId()]);
        expect(projected.rangeAttackDivisors).toEqual([1, 2]);
        expect(evaluationView(projected)).toEqual(evaluationView(eager));
    });

    test("applies revised live Smoke once to every unit in one prepared AOE hit group", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: RIGHT,
            name: "Prepared caliber ranger",
            attackType: RANGE,
            rangeShots: 8,
            abilities: ["Large Caliber"],
        });
        const primary = createTestUnit({ team: LEFT, name: "Prepared AOE primary" });
        const adjacent = createTestUnit({ team: LEFT, name: "Prepared AOE adjacent" });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 1, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, primary, { x: 6, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, adjacent, { x: 6, y: 6 });
        const aim = getRangeAttackSideCenter(
            testGridSettings,
            primary.getBaseCell(),
            RangeAttackCellSide.LEFT,
            shooter.getPosition(),
        );
        const prepared = combat.attackHandler.prepareRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            false,
            false,
            true,
        );
        FightStateManager.getInstance().getFightProperties().getSmokeClouds().add({ x: 3, y: 5 });

        const projected = combat.attackHandler.evaluatePreparedRangeAttack(prepared);
        const eager = combat.attackHandler.evaluateRangeAttack(
            combat.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            aim,
            false,
            false,
            true,
        );

        expect(projected.affectedUnits).toHaveLength(1);
        expect(projected.affectedUnits[0]).toEqual(expect.arrayContaining([primary, adjacent]));
        expect(projected.rangeAttackDivisors).toEqual([2]);
        expect(evaluationView(projected)).toEqual(evaluationView(eager));
    });

    test("prepared immutable rays match eager geometry across randomized terrain, interception, and Smoke revisions", () => {
        let state = 0x91e1_0da5;
        const next = (bound: number): number => {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            return state % bound;
        };
        const gridTypes = [
            PBTypes.GridVals.NORMAL,
            PBTypes.GridVals.BLOCK_CENTER,
            PBTypes.GridVals.LAVA_CENTER,
            PBTypes.GridVals.WATER_CENTER,
        ];

        for (let iteration = 0; iteration < 256; iteration += 1) {
            const combat = createCombatTestContext(gridTypes[iteration % gridTypes.length]!);
            const shooter = createTestUnit({
                team: RIGHT,
                name: `Prepared fuzz shooter ${iteration}`,
                attackType: RANGE,
                rangeShots: 8,
                shotDistance: 1 + next(20),
                abilities: iteration % 6 === 0 ? ["Through Shot"] : iteration % 6 === 1 ? ["Large Caliber"] : [],
            });
            const pickEmptyCell = (): XY => {
                for (let attempt = 0; attempt < 512; attempt += 1) {
                    const cell = { x: next(16), y: next(16) };
                    if (!combat.grid.getOccupantUnitId(cell)) return cell;
                }
                throw new Error("prepared-ray fuzz could not find an empty cell");
            };
            placeUnit(combat.grid, combat.unitsHolder, shooter, pickEmptyCell());

            const target = createTestUnit({ team: LEFT, name: `Prepared fuzz target ${iteration}` });
            placeUnit(combat.grid, combat.unitsHolder, target, pickEmptyCell());
            const extraCount = next(6);
            for (let extra = 0; extra < extraCount; extra += 1) {
                const unit = createTestUnit({
                    team: next(3) === 0 ? RIGHT : LEFT,
                    name: `Prepared fuzz extra ${iteration}:${extra}`,
                });
                placeUnit(combat.grid, combat.unitsHolder, unit, pickEmptyCell());
            }

            const side = RANGE_ATTACK_CELL_SIDES[next(RANGE_ATTACK_CELL_SIDES.length)]!;
            const aim = getRangeAttackSideCenter(testGridSettings, target.getBaseCell(), side, shooter.getPosition());
            const isThroughShot = iteration % 4 === 0;
            const isSelection = iteration % 7 === 0;
            const isAOEShot = iteration % 5 === 0;
            const clouds = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
            for (let live = 0; live < next(5); live += 1) {
                clouds.add({ x: next(18) - 1, y: next(18) - 1 });
            }

            const prepared = combat.attackHandler.prepareRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                aim,
                isThroughShot,
                isSelection,
                isAOEShot,
            );
            expect(Object.isFrozen(prepared)).toBe(true);
            expect(Object.isFrozen(prepared.affectedUnits)).toBe(true);
            expect(Object.isFrozen(prepared.affectedCells)).toBe(true);

            // Force evaluatePreparedRangeAttack's revision-aware path on half the corpus. Adding even an
            // already-smoked key advances the revision, just like a real recast refreshing its lifetime.
            if (iteration % 2 === 0) {
                clouds.add({ x: next(18) - 1, y: next(18) - 1 });
            }
            if (iteration % 11 === 0) {
                clouds.clear();
                clouds.add({ x: next(18) - 1, y: next(18) - 1 });
            }
            const hypothetical = Array.from({ length: next(7) }, () => ({
                x: next(20) - 2,
                y: next(20) - 2,
            }));
            const eager = combat.attackHandler.evaluateRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                aim,
                isThroughShot,
                isSelection,
                isAOEShot,
                hypothetical,
            );
            const projected = combat.attackHandler.evaluatePreparedRangeAttack(prepared, hypothetical);
            const projectedWithPreparedKeys = combat.attackHandler.evaluatePreparedRangeAttack(
                prepared,
                hypothetical,
                new Set(hypothetical.map((cell) => SmokeClouds.key(cell))),
            );
            expect(evaluationView(projected)).toEqual(evaluationView(eager));
            expect(evaluationView(projectedWithPreparedKeys)).toEqual(evaluationView(eager));

            expect(projected.rangeAttackDivisors).not.toBe(projectedWithPreparedKeys.rangeAttackDivisors);
            expect(projected.affectedUnits).not.toBe(projectedWithPreparedKeys.affectedUnits);
            expect(projected.affectedCells).not.toBe(projectedWithPreparedKeys.affectedCells);
            for (let group = 0; group < projected.affectedUnits.length; group += 1) {
                expect(projected.affectedUnits[group]).not.toBe(projectedWithPreparedKeys.affectedUnits[group]);
            }
            for (let group = 0; group < projected.affectedCells.length; group += 1) {
                expect(projected.affectedCells[group]).not.toBe(projectedWithPreparedKeys.affectedCells[group]);
                for (let cell = 0; cell < projected.affectedCells[group].length; cell += 1) {
                    expect(projected.affectedCells[group][cell]).not.toBe(
                        projectedWithPreparedKeys.affectedCells[group][cell],
                    );
                }
            }
            if (projected.attackObstacle) {
                expect(projected.attackObstacle).not.toBe(projectedWithPreparedKeys.attackObstacle);
                expect(projected.attackObstacle.position).not.toBe(projectedWithPreparedKeys.attackObstacle?.position);
            }

            // Results remain caller-owned even though their source geometry is shared and frozen.
            projected.rangeAttackDivisors.push(12345);
            projected.affectedUnits.push([]);
            projected.affectedCells.push([{ x: 12345, y: 12345 }]);
            expect(evaluationView(combat.attackHandler.evaluatePreparedRangeAttack(prepared, hypothetical))).toEqual(
                evaluationView(eager),
            );
        }
    });

    test("matches live FightProperties across deterministic random edge rays without mutating it", () => {
        let state = 0x5a17_c0de;
        const next = (bound: number): number => {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            return state % bound;
        };

        for (let iteration = 0; iteration < 64; iteration += 1) {
            const gridType = iteration % 4 === 0 ? PBTypes.GridVals.BLOCK_CENTER : PBTypes.GridVals.NORMAL;
            const combat = createCombatTestContext(gridType);
            const abilities = iteration % 5 === 0 ? ["Through Shot"] : iteration % 7 === 0 ? ["Large Caliber"] : [];
            const shooter = createTestUnit({
                team: RIGHT,
                name: `Fuzz shooter ${iteration}`,
                attackType: RANGE,
                rangeShots: 8,
                damageMin: 20,
                damageMax: 20,
                shotDistance: 2 + next(15),
                abilities,
            });
            const target = createTestUnit({ team: LEFT, name: `Fuzz target ${iteration}`, maxHp: 1_000 });
            const pickEmptyCell = (reserved?: XY): XY => {
                for (let attempt = 0; attempt < 256; attempt += 1) {
                    const cell = { x: next(16), y: next(16) };
                    if (
                        (!reserved || cell.x !== reserved.x || cell.y !== reserved.y) &&
                        !combat.grid.getOccupantUnitId(cell)
                    ) {
                        return cell;
                    }
                }
                throw new Error("deterministic fuzz could not find an empty cell");
            };
            const shooterCell = pickEmptyCell();
            placeUnit(combat.grid, combat.unitsHolder, shooter, shooterCell);
            const targetCell = pickEmptyCell(shooterCell);
            placeUnit(combat.grid, combat.unitsHolder, target, targetCell);

            const sides = RANGE_ATTACK_CELL_SIDES.filter((side) =>
                isRangeAttackSideObservable(
                    combat.grid.getMatrix(),
                    targetCell,
                    side,
                    shooter.getTeam(),
                    shooter.hasAbilityActive("Through Shot"),
                ),
            );
            expect(sides.length).toBeGreaterThan(0);
            const side = sides[next(sides.length)]!;
            const aim = getRangeAttackSideCenter(testGridSettings, targetCell, side, shooter.getPosition());

            let anchor: XY | undefined;
            for (let attempt = 0; attempt < 256 && !anchor; attempt += 1) {
                const probe = { x: next(15), y: next(15) };
                const cells = smokeCells(probe);
                if (
                    cells.every((cell) =>
                        isSmokeableCell(combat.grid, isCellWithinGrid(combat.grid.getSettings(), cell), cell),
                    )
                ) {
                    anchor = probe;
                }
            }
            expect(anchor).toBeDefined();
            const hypothetical = smokeCells(anchor!);
            const clouds = FightStateManager.getInstance().getFightProperties().getSmokeClouds();
            if (iteration % 3 === 0) {
                const liveCell = pickEmptyCell();
                clouds.add(liveCell);
            }
            const liveSizeBefore = clouds.size();

            const projected = combat.attackHandler.evaluateRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                aim,
                shooter.hasAbilityActive("Through Shot"),
                false,
                shooter.hasAbilityActive("Large Caliber"),
                hypothetical,
            );
            const projectedWithPreparedKeys = combat.attackHandler.evaluateRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                aim,
                shooter.hasAbilityActive("Through Shot"),
                false,
                shooter.hasAbilityActive("Large Caliber"),
                hypothetical,
                new Set(hypothetical.map((cell) => SmokeClouds.key(cell))),
            );
            expect(clouds.size()).toBe(liveSizeBefore);
            expect(evaluationView(projectedWithPreparedKeys)).toEqual(evaluationView(projected));

            for (const cell of hypothetical) clouds.add(cell);
            const live = combat.attackHandler.evaluateRangeAttack(
                combat.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                aim,
                shooter.hasAbilityActive("Through Shot"),
                false,
                shooter.hasAbilityActive("Large Caliber"),
            );
            expect(evaluationView(projected)).toEqual(evaluationView(live));
        }
    });
});

describe("Smoke candidate/runtime parity", () => {
    test("matches the eager fallback across randomized multi-ranger candidate boards", () => {
        let state = 0x50c0_a11e;
        const next = (bound: number): number => {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            return state % bound;
        };
        const gridTypes = [
            PBTypes.GridVals.NORMAL,
            PBTypes.GridVals.BLOCK_CENTER,
            PBTypes.GridVals.LAVA_CENTER,
            PBTypes.GridVals.WATER_CENTER,
        ];
        let eagerCalls = 0;

        for (let iteration = 0; iteration < 32; iteration += 1) {
            const combat = createCombatTestContext(gridTypes[iteration % gridTypes.length]!);
            const caster = nativeWanderingMage();
            const pickEmptyCell = (): XY => {
                for (let attempt = 0; attempt < 512; attempt += 1) {
                    const cell = { x: next(16), y: next(16) };
                    if (!combat.grid.getOccupantUnitId(cell)) return cell;
                }
                throw new Error("Smoke candidate fuzz could not find an empty cell");
            };
            placeUnit(combat.grid, combat.unitsHolder, caster, pickEmptyCell());

            let leftAlive = 1;
            let rightAlive = 0;
            const addRanger = (team: typeof LEFT | typeof RIGHT, index: number): void => {
                const ranger = createTestUnit({
                    team,
                    name: `Candidate fuzz ranger ${iteration}:${team}:${index}`,
                    attackType: RANGE,
                    rangeShots: 1 + next(12),
                    damageMin: 1 + next(20),
                    damageMax: 21 + next(20),
                    shotDistance: 1 + next(16),
                    abilities: index % 5 === 0 ? ["Through Shot"] : index % 5 === 1 ? ["Large Caliber"] : [],
                });
                placeUnit(combat.grid, combat.unitsHolder, ranger, pickEmptyCell());
                if (team === LEFT) leftAlive += 1;
                else rightAlive += 1;
            };
            for (let index = 0; index < 1 + next(4); index += 1) addRanger(RIGHT, index);
            for (let index = 0; index < next(4); index += 1) addRanger(LEFT, index + 10);
            for (let index = 0; index < next(4); index += 1) {
                const team = next(2) === 0 ? LEFT : RIGHT;
                const blocker = createTestUnit({ team, name: `Candidate fuzz blocker ${iteration}:${index}` });
                placeUnit(combat.grid, combat.unitsHolder, blocker, pickEmptyCell());
                if (team === LEFT) leftAlive += 1;
                else rightAlive += 1;
            }

            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.startFight();
            fightProperties.setTeamUnitsAlive(LEFT, leftAlive);
            fightProperties.setTeamUnitsAlive(RIGHT, rightAlive);
            fightProperties.startTurn(LEFT, 1_000);
            const context = decisionContext(combat);
            const incumbent: GameAction[] = [{ type: "end_turn", unitId: caster.getId(), reason: "manual" }];
            const candidates = () =>
                enumerateCandidates(caster, context, incumbent).candidates.filter(
                    (candidate) => candidate.kind === "spell" && candidate.spellName === "Smoke",
                );

            const preparedCandidates = candidates();
            const originalEvaluate = combat.attackHandler.evaluateRangeAttack;
            combat.attackHandler.evaluateRangeAttack = function (...args) {
                eagerCalls += 1;
                return originalEvaluate.apply(this, args);
            };
            expect(candidates()).toEqual(preparedCandidates);
        }
        expect(eagerCalls).toBeGreaterThan(0);
    });

    test("keeps wrapped/custom AttackHandler evaluation on the eager fallback with identical candidates", () => {
        const harness = smokeHarness(PBTypes.GridVals.NORMAL);
        const preparedCandidates = smokeCandidates(harness);
        const originalEvaluate = harness.combat.attackHandler.evaluateRangeAttack;
        let eagerCalls = 0;
        harness.combat.attackHandler.evaluateRangeAttack = function (...args) {
            eagerCalls += 1;
            return originalEvaluate.apply(this, args);
        };

        const fallbackCandidates = smokeCandidates(harness);

        expect(eagerCalls).toBeGreaterThan(0);
        expect(fallbackCandidates).toEqual(preparedCandidates);
    });

    test("stores exact enemy prevention minus friendly prevention after both sides retarget", () => {
        const combat = createCombatTestContext();
        const caster = nativeWanderingMage();
        const friendlyRanger = createTestUnit({
            team: LEFT,
            name: "Friendly ranger",
            attackType: RANGE,
            rangeShots: 12,
            damageMin: 30,
            damageMax: 30,
            amountAlive: 30,
            maxHp: 100,
        });
        const enemyRanger = createTestUnit({
            team: RIGHT,
            name: "Enemy ranger",
            attackType: RANGE,
            rangeShots: 4,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            maxHp: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, caster, { x: 2, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, friendlyRanger, { x: 2, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, enemyRanger, { x: 13, y: 8 });
        const context = decisionContext(combat);
        const candidate = enumerateCandidates(caster, context, [
            { type: "end_turn", unitId: caster.getId(), reason: "manual" },
        ]).candidates.find((value) => value.spellName === "Smoke");

        expect(candidate?.targetCell).toBeDefined();
        const hypothetical = smokeCells(candidate!.targetCell!);
        const bestDamage = (shooter: Unit, smoke?: readonly XY[]): number =>
            findBestLegalStationaryRangeAttack(shooter, context, smoke)?.expectedDamage ?? 0;
        const enemyPrevention = bestDamage(enemyRanger) - bestDamage(enemyRanger, hypothetical);
        const friendlyPrevention = bestDamage(friendlyRanger) - bestDamage(friendlyRanger, hypothetical);

        expect(enemyPrevention).toBeGreaterThan(friendlyPrevention);
        expect(candidate!.features.expectedDamage).toBeCloseTo(enemyPrevention - friendlyPrevention, 10);
        expect(context.fightProperties!.getSmokeClouds().size()).toBe(0);
    });

    test.each([
        ["lava", PBTypes.GridVals.LAVA_CENTER, "L"],
        ["water", PBTypes.GridVals.WATER_CENTER, "W"],
    ] as const)("emits one deterministic %s target that the engine accepts", (_label, gridType, terrain) => {
        const harness = smokeHarness(gridType);
        const first = smokeCandidates(harness);
        const second = smokeCandidates(harness);

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect(second[0].actions).toEqual(first[0].actions);
        expect(first[0].targetCell).toEqual({ x: 8, y: 8 });
        const cells = smokeCells(first[0].targetCell!);
        expect(cells.every((cell) => harness.combat.grid.getOccupantUnitId(cell) === terrain)).toBe(true);
        expect(
            cells.every((cell) =>
                isSmokeableCell(harness.combat.grid, isCellWithinGrid(harness.combat.grid.getSettings(), cell), cell),
            ),
        ).toBe(true);

        const action = first[0].actions[0];
        expect(action.type).toBe("cast_spell");
        const chargesBefore = harness.caster
            .getSpells()
            .find((spell) => spell.getName() === "Smoke")!
            .getAmount();
        const result = harness.engine.apply(action);
        expect(result.completed, result.rejectionReason).toBe(true);
        expect(result.events).toContainEqual({
            type: "smoke_placed",
            casterId: harness.caster.getId(),
            cells,
            lapsRemaining: 3,
        });
        expect(cells.every((cell) => harness.context.fightProperties!.getSmokeClouds().has(cell))).toBe(true);
        expect(
            harness.caster
                .getSpells()
                .find((spell) => spell.getName() === "Smoke")!
                .getAmount(),
        ).toBe(chargesBefore - 1);
    });

    test("never emits the legacy candidate that overlaps its own Wandering Mage caster", () => {
        const harness = smokeHarness(PBTypes.GridVals.NORMAL, { x: 2, y: 8 }, { x: 4, y: 8 });
        const casterOverlap = smokeCells({ x: 2, y: 8 });

        expect(harness.combat.grid.areAllCellsEmpty(casterOverlap, harness.caster.getId())).toBe(true);
        expect(
            casterOverlap.every((cell) =>
                isSmokeableCell(harness.combat.grid, isCellWithinGrid(harness.combat.grid.getSettings(), cell), cell),
            ),
        ).toBe(false);
        expect(smokeCandidates(harness)).toEqual([]);
    });
});
