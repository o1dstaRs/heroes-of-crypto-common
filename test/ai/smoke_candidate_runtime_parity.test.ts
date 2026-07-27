import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates, getEnemiesCellsWithinMovementRange } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import { isCellWithinGrid } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
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
        getCreatureConfig(LOWER, "Chaos", "Ash Moth", "", 1),
        testGridSettings,
        LOWER,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
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
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
    };
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

describe("Smoke candidate/runtime parity", () => {
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
