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
import { isSmokeableCell } from "../../src/spells/smoke_clouds";
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
const RANGE = PBTypes.AttackVals.RANGE;

function nativeAshMoth(): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(LOWER, "Chaos", "Ash Moth", "", 50),
        testGridSettings,
        LOWER,
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
    const caster = nativeAshMoth();
    const enemy = createTestUnit({
        team: UPPER,
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
    fightProperties.setTeamUnitsAlive(LOWER, 1);
    fightProperties.setTeamUnitsAlive(UPPER, 1);
    fightProperties.startTurn(LOWER, 1_000);
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
        const caster = nativeAshMoth();
        const other = createTestUnit({ team: UPPER, name: "Occupant" });
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
            team: UPPER,
            name: "Edge-aware ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const target = createTestUnit({ team: LOWER, name: "Edge target", maxHp: 1_000 });
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
            team: UPPER,
            name: "Through ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
            abilities: ["Through Shot"],
        });
        const front = createTestUnit({ team: LOWER, name: "Front", maxHp: 1_000 });
        const rear = createTestUnit({ team: LOWER, name: "Rear", maxHp: 1_000 });
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
            team: UPPER,
            name: "Blocked ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const target = createTestUnit({ team: LOWER, name: "Blocked target", maxHp: 1_000 });
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
            team: UPPER,
            name: "Intercepted ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const front = createTestUnit({ team: LOWER, name: "Front interceptor", maxHp: 1_000 });
        const rear = createTestUnit({ team: LOWER, name: "Declared rear target", maxHp: 1_000 });
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
            team: UPPER,
            name: "Long-range ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 80,
            damageMax: 80,
            shotDistance: 2,
        });
        const target = createTestUnit({ team: LOWER, name: "Distant target", maxHp: 1_000 });
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
            team: UPPER,
            name: "Retargeting ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMin: 20,
            damageMax: 20,
            shotDistance: 16,
        });
        const screened = createTestUnit({ team: LOWER, name: "Screened target", maxHp: 1_000 });
        const open = createTestUnit({ team: LOWER, name: "Open target", maxHp: 1_000 });
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
                team: UPPER,
                name: `Fuzz shooter ${iteration}`,
                attackType: RANGE,
                rangeShots: 8,
                damageMin: 20,
                damageMax: 20,
                shotDistance: 2 + next(15),
                abilities,
            });
            const target = createTestUnit({ team: LOWER, name: `Fuzz target ${iteration}`, maxHp: 1_000 });
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
            expect(clouds.size()).toBe(liveSizeBefore);

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
    test("stores exact enemy prevention minus friendly prevention after both sides retarget", () => {
        const combat = createCombatTestContext();
        const caster = nativeAshMoth();
        const friendlyRanger = createTestUnit({
            team: LOWER,
            name: "Friendly ranger",
            attackType: RANGE,
            rangeShots: 12,
            damageMin: 30,
            damageMax: 30,
            amountAlive: 30,
            maxHp: 100,
        });
        const enemyRanger = createTestUnit({
            team: UPPER,
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

    test("never emits the legacy candidate that overlaps its own Ash Moth caster", () => {
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
