/*
 * -----------------------------------------------------------------------------
 * Smoke lays a 3x3 cloud CENTRED on the aimed cell (was a 2x2 hanging off it as a
 * corner). The shape is asserted here against LITERAL cells rather than through
 * cellTargetedSpellBlockCells, so a change to the shared helper cannot quietly
 * agree with itself: the engine, the aim preview and the AI all read that helper,
 * and this is the one place that says what the answer must be.
 * -----------------------------------------------------------------------------
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

const key = (cell: XY): string => `${cell.x},${cell.y}`;

/** The nine cells a cast aimed at `centre` must smoke, written out longhand. */
const expectedBlock = (centre: XY): Set<string> => {
    const out = new Set<string>();
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            out.add(key({ x: centre.x + dx, y: centre.y + dy }));
        }
    }
    return out;
};

function wanderingMage(): Unit {
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

function smokeFight(casterCell: XY = { x: 2, y: 2 }) {
    const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const caster = wanderingMage();
    const enemy = createTestUnit({ team: RIGHT, name: "Enemy" });
    placeUnit(combat.grid, combat.unitsHolder, caster, casterCell);
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LEFT, 1);
    fightProperties.setTeamUnitsAlive(RIGHT, 1);
    fightProperties.startTurn(LEFT, 1_000);

    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => caster.getId(),
    });
    return { combat, caster, enemy, engine, fightProperties };
}

const castSmokeAt = (fight: ReturnType<typeof smokeFight>, targetCell: XY) =>
    fight.engine.apply({
        type: "cast_spell",
        casterId: fight.caster.getId(),
        spellName: "Smoke",
        targetCell,
    });

describe("Smoke lays a 3x3 centred on the aimed cell", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    test("smokes the nine cells around the target, and nothing else", () => {
        const fight = smokeFight();
        const centre = { x: 8, y: 8 };

        const result = castSmokeAt(fight, centre);

        expect(result.completed, result.rejectionReason).toBe(true);
        const clouds = fight.fightProperties.getSmokeClouds();
        expect(clouds.size()).toBe(9);
        expect(new Set(clouds.cells().map(key))).toEqual(expectedBlock(centre));
    });

    test("the aimed cell is the CENTRE, not a corner", () => {
        const fight = smokeFight();
        const centre = { x: 8, y: 8 };

        expect(castSmokeAt(fight, centre).completed).toBe(true);

        // A corner-anchored block would have left the cell up-and-left of the target clear.
        expect(fight.fightProperties.getSmokeClouds().has({ x: centre.x - 1, y: centre.y - 1 })).toBe(true);
        expect(fight.fightProperties.getSmokeClouds().has({ x: centre.x + 2, y: centre.y })).toBe(false);
    });

    test("the smoke_placed event carries all nine cells", () => {
        const fight = smokeFight();
        const centre = { x: 6, y: 9 };

        const result = castSmokeAt(fight, centre);

        const placed = result.events?.find((event) => event.type === "smoke_placed");
        expect(placed).toBeDefined();
        const cells = (placed as { cells: XY[] }).cells;
        expect(cells).toHaveLength(9);
        expect(new Set(cells.map(key))).toEqual(expectedBlock(centre));
    });

    test("is all-or-nothing: one blocked cell of the nine refuses the whole cast", () => {
        const fight = smokeFight();
        const centre = { x: 8, y: 8 };
        // A single hole in the block's corner — legal for the other eight cells, fatal for the cast.
        fight.combat.grid.occupyByHole({ x: centre.x + 1, y: centre.y + 1 });

        const result = castSmokeAt(fight, centre);

        expect(result.completed).toBe(false);
        expect(fight.fightProperties.getSmokeClouds().size()).toBe(0);
    });

    test("needs a cell of clearance on every side: a cast on the board edge is refused", () => {
        const fight = smokeFight();

        // The centre's own ring runs off the board at x = 0, so the whole block cannot be placed.
        expect(castSmokeAt(fight, { x: 0, y: 8 }).completed).toBe(false);
        expect(fight.fightProperties.getSmokeClouds().size()).toBe(0);

        // One cell in, the ring fits.
        expect(castSmokeAt(fight, { x: 1, y: 8 }).completed).toBe(true);
        expect(fight.fightProperties.getSmokeClouds().size()).toBe(9);
    });
});
