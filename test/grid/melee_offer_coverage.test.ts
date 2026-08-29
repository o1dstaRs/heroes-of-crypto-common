import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { GridSettings } from "../../src/grid/grid_settings";
import * as GC from "../../src/grid/grid_constants";
import { getPositionForCell } from "../../src/grid/grid_math";
import { Unit } from "../../src/units/unit";

/**
 * Every landing the cursor can pick must actually yield an attack.
 *
 * A non-1x1 attacker resolves its melee attack-from cell through
 * PathHelper.calculateClosestAttackFrom, which for such a unit ALWAYS finishes by calling
 * getClosestAttackCell(..., attackCellHashesToLargeCells.get(hash)) — and getClosestAttackCell returns
 * undefined the moment that list is missing or empty. So the map produced by attackMeleeAllowed has to
 * carry an entry for every cell it also reports in attackCells: any cell present in one and absent from
 * the other is a landing the player can hover and click with nothing happening and nothing logged.
 */
const gs = new GridSettings(
    GC.GRID_SIZE,
    GC.MAX_Y,
    GC.MIN_Y,
    GC.MAX_X,
    GC.MIN_X,
    GC.MOVEMENT_DELTA,
    GC.UNIT_SIZE_DELTA,
);

const makeUnit = (faction: string, creature: string, team: number): Unit => {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team as never, faction, creature, `${creature.toLowerCase().replace(/ /g, "_")}_512`, 1),
        gs,
        team as never,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
};

const place = (unit: Unit, cell: { x: number; y: number }): void => {
    unit.setPosition(
        getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep()).x,
        getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep()).y,
    );
};

describe("melee offer coverage for rectangular attackers", () => {
    it("reports the footprint the side board actually ships", () => {
        const wolf = makeUnit("Nature", "Wolf", PBTypes.TeamVals.RIGHT);
        // Mounted creatures ship 2x1 with size 2 — this is the class the side-board work introduced.
        expect(wolf.isSmallSize()).toBe(false);
        expect([wolf.getFootprintWidth(), wolf.getFootprintHeight()].join("x")).toBe("2x1");
    });

    it("every attackCell a rectangular attacker reports also has a large-cell entry", () => {
        const attacker = makeUnit("Nature", "Wolf", PBTypes.TeamVals.RIGHT);
        const target = makeUnit("Life", "Peasant", PBTypes.TeamVals.LEFT);

        const attackerCell = { x: 5, y: 5 };
        const targetCell = { x: 7, y: 5 };
        place(attacker, attackerCell);
        place(target, targetCell);

        const positions = new Map([
            [target.getId(), getPositionForCell(targetCell, gs.getMinX(), gs.getStep(), gs.getHalfStep())],
        ]);

        // A walked path around the attacker, the way updateCurrentMovePath feeds it live.
        const pathCells: { x: number; y: number }[] = [];
        const knownPaths = new Map<number, { cell: { x: number; y: number }; weight: number }[]>();
        for (let x = 3; x <= 8; x++) {
            for (let y = 3; y <= 7; y++) {
                pathCells.push({ x, y });
                knownPaths.set((x << 4) | y, [{ cell: { x, y }, weight: 1 }]);
            }
        }

        const targets = attacker.attackMeleeAllowed([target], positions, [target], pathCells, knownPaths as never);

        expect(targets.unitIds.has(target.getId())).toBe(true);
        expect(targets.attackCells.length).toBeGreaterThan(0);

        const uncovered = targets.attackCells.filter(
            (c) => !(targets.attackCellHashesToLargeCells.get((c.x << 4) | c.y) ?? []).length,
        );
        expect({ uncovered: uncovered.map((c) => `${c.x},${c.y}`), total: targets.attackCells.length }).toEqual({
            uncovered: [],
            total: targets.attackCells.length,
        });
    });
});
