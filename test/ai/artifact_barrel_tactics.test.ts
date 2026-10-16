import { describe, expect, test } from "bun:test";
import { friendlyShotBlockingBarrels, projectBarrelShotTradeoff } from "../../src/ai/artifact_barrel_tactics";
import { PathHelper } from "../../src/grid/path_helper";
import { findBestLegalStationaryRangeAttack } from "../../src/ai/candidates";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
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
                        const projected = tradeoff(h).find((row) => row.unitId === h.shooter.getId())!;
                        h.grid.clearScatteredMountainAt(h.barrel.x, h.barrel.y);
                        expect([...h.blockers()]).toEqual([]);
                        const actual =
                            findBestLegalStationaryRangeAttack(h.shooter, {
                                ...h,
                                matrix: h.grid.getMatrix(),
                                pathHelper: new PathHelper(h.grid.getSettings()),
                                fightProperties: FightStateManager.getInstance().getFightProperties(),
                            })?.expectedDamage ?? 0;
                        expect(projected.after).toBe(actual);
                    });
            }
    test("projecting shots leaves authoritative combat state unchanged", () => {
        const h = fixture(1, teams[0], 1, 1);
        const fp = FightStateManager.getInstance().getFightProperties();
        const before = snapshotBattle(h.unitsHolder, h.grid, fp);
        expect([...h.blockers()]).toEqual([h.key]);
        expect(snapshotBattle(h.unitsHolder, h.grid, fp)).toEqual(before);
    });
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
        expect(tradeoff(h).find((row) => row.unitId === h.shooter.getId())!.gain).toBe(0);
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

    const tradeoff = (h: ReturnType<typeof fixture>) =>
        projectBarrelShotTradeoff(
            {
                ...h,
                matrix: h.grid.getMatrix(),
                pathHelper: new PathHelper(h.grid.getSettings()),
                fightProperties: FightStateManager.getInstance().getFightProperties(),
            },
            h.barrel,
        )!;

    test("opening the first of two blocking barrels is not credited as an available shot", () => {
        const h = fixture(1, teams[0], 1, 0);
        expect(h.grid.placeArtifactBarrel(teams[1], 0, { x: 6, y: 11 })).toBe(true);
        expect(tradeoff(h).find((row) => row.unitId === h.shooter.getId())!.gain).toBe(0);
        h.grid.clearArtifactBarrels(teams[1]);
        expect(tradeoff(h).find((row) => row.unitId === h.shooter.getId())!.gain).toBeGreaterThan(0);
    });

    test("clearing a barrel can expose both armies and reports both opportunity changes", () => {
        const h = fixture(1, teams[0], 1, 0);
        h.grid.cleanupAll(h.enemy.getId(), h.enemy.getAttackRange(), h.enemy.isSmallSize());
        h.unitsHolder.getAllUnits().delete(h.enemy.getId());
        const archer = createTestUnit({ team: teams[1], attackType: PBTypes.AttackVals.RANGE, rangeShots: 4 });
        placeUnit(h.grid, h.unitsHolder, archer, { x: 7, y: 11 });
        const opportunities = tradeoff(h);
        expect(opportunities.find((row) => row.unitId === h.shooter.getId())!.gain).toBeGreaterThan(0);
        expect(opportunities.find((row) => row.unitId === archer.getId())!.gain).toBeGreaterThan(0);
    });

    test("counterfactual shots leave the full battle and cached matrix unchanged", () => {
        const h = fixture(1, teams[0], 1, 1);
        const fp = FightStateManager.getInstance().getFightProperties();
        const before = snapshotBattle(h.unitsHolder, h.grid, fp);
        const matrix = h.grid.getMatrix();
        tradeoff(h);
        expect(snapshotBattle(h.unitsHolder, h.grid, fp)).toEqual(before);
        expect(h.grid.getMatrix()).toEqual(matrix);
    });
});
