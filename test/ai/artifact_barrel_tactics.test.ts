import { describe, expect, test } from "bun:test";
import { friendlyShotBlockingBarrels } from "../../src/ai/artifact_barrel_tactics";
import { Spell } from "../../src/spells/spell";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const directions = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
] as const;
const teams = [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const;

function fixture(
    map: GridType,
    team: TeamType,
    dx: number,
    dy: number,
    owner = team,
    shots = 4,
    abilities: string[] = [],
) {
    const context = createCombatTestContext(map);
    const shooter = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: shots, abilities });
    const enemyTeam = team === teams[0] ? teams[1] : teams[0];
    const enemy = createTestUnit({ team: enemyTeam });
    placeUnit(context.grid, context.unitsHolder, shooter, { x: 4, y: 11 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 4 + 3 * dx, y: 11 + 3 * dy });
    const barrel = { x: 4 + dx, y: 11 + dy };
    expect(context.grid.placeArtifactBarrel(owner, 0, barrel)).toBe(true);
    return {
        ...context,
        shooter,
        enemy,
        barrel,
        key: `${barrel.x},${barrel.y}`,
        blockers: () => friendlyShotBlockingBarrels(team, context.grid, context.unitsHolder, context.attackHandler),
    };
}

describe("barrel shot projection", () => {
    for (const map of [1, 2, 3, 4] as const)
        for (const team of teams)
            for (const owner of teams) {
                for (const [dx, dy] of directions)
                    test(`map ${map}, team ${team}, owner ${owner}, ray ${dx}/${dy}`, () => {
                        const h = fixture(map, team, dx, dy, owner);
                        expect([...h.blockers()]).toEqual([h.key]);
                        h.grid.clearScatteredMountainAt(h.barrel.x, h.barrel.y);
                        expect([...h.blockers()]).toEqual([]);
                    });
            }
    test("does not mistake a melee unit's file for a shot", () => {
        const context = createCombatTestContext();
        const melee = createTestUnit({ team: teams[0] });
        const enemy = createTestUnit({ team: teams[1] });
        placeUnit(context.grid, context.unitsHolder, melee, { x: 2, y: 3 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 8, y: 3 });
        expect(context.grid.placeArtifactBarrel(teams[0], 0, { x: 3, y: 3 })).toBe(true);
        expect([
            ...friendlyShotBlockingBarrels(teams[0], context.grid, context.unitsHolder, context.attackHandler),
        ]).toEqual([]);
    });
    test("empty ammunition and melee pinning provide no shot to unblock", () => {
        const empty = fixture(1, teams[0], 1, 1, teams[0], 0);
        expect([...empty.blockers()]).toEqual([]);
        const pinned = fixture(1, teams[0], 1, 1);
        const enemy = createTestUnit({ team: teams[1] });
        placeUnit(pinned.grid, pinned.unitsHolder, enemy, { x: 3, y: 11 });
        expect([...pinned.blockers()]).toEqual([]);
    });
    test("Area Throw passes over barrels and never requests a clearing shot", () => {
        const h = fixture(1, teams[0], 1, 1, teams[0], 4, ["Area Throw"]);
        expect([...h.blockers()]).toEqual([]);
    });
    test("does not open a shot at a hidden or forbidden-by-provocation target", () => {
        const h = fixture(1, teams[0], 1, 1);
        h.enemy.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Hidden"), amount: 1 }));
        expect([...h.blockers()]).toEqual([]);
        const forced = fixture(1, teams[0], 1, 1);
        const provoker = createTestUnit({ team: teams[1] });
        placeUnit(forced.grid, forced.unitsHolder, provoker, { x: 13, y: 11 });
        forced.shooter.setTarget(provoker.getId());
        expect([...forced.blockers()]).toEqual([]);
    });
    test("identifies only the first obstacle on a ray", () => {
        const h = fixture(1, teams[0], 1, 1);
        expect(h.grid.placeArtifactBarrel(teams[1], 0, { x: 6, y: 13 })).toBe(true);
        expect([...h.blockers()]).toEqual([h.key]);
    });
});
