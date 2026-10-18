import { expect, test } from "bun:test";
import { DefaultPlacementLevel1 } from "../../src/augments/augment_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { mirrorBarrelStudyDeployment } from "../../src/simulation/barrel_deployment_research";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

for (const side of [true, false]) {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const) {
        test(`mirrored research opponent preserves bodies, resources, legal cells and the other army, side=${side}, team=${team}`, () => {
            const c = createCombatTestContext();
            const fp = FightStateManager.getInstance().getFightProperties();
            fp.setSideOrientedPlacement(side);
            fp.setDefaultPlacementPerTeam(team, DefaultPlacementLevel1.THREE_BY_THREE);
            const unit = createTestUnit({ team, size: 2, footprintWidth: 1, footprintHeight: 2 });
            const ally = createTestUnit({ team });
            const other = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
            const enemy = createTestUnit({ team: other });
            placeUnit(
                c.grid,
                c.unitsHolder,
                unit,
                side
                    ? { x: team === PBTypes.TeamVals.LEFT ? 1 : 14, y: 3 }
                    : { x: 3, y: team === PBTypes.TeamVals.LEFT ? 2 : 14 },
            );
            placeUnit(
                c.grid,
                c.unitsHolder,
                ally,
                side
                    ? { x: team === PBTypes.TeamVals.LEFT ? 2 : 14, y: 11 }
                    : { x: 11, y: team === PBTypes.TeamVals.LEFT ? 2 : 14 },
            );
            placeUnit(
                c.grid,
                c.unitsHolder,
                enemy,
                side
                    ? { x: team === PBTypes.TeamVals.LEFT ? 14 : 1, y: 8 }
                    : { x: 8, y: team === PBTypes.TeamVals.LEFT ? 14 : 1 },
            );
            const enemyBefore = structuredClone(enemy.getUnitProperties());
            const before = unit.getCells();
            const hp = unit.getCumulativeHp(),
                amount = unit.getAmountAlive();
            c.grid.getMatrix();
            expect(mirrorBarrelStudyDeployment({ ...c, fightProperties: fp }, team)).toBe(true);
            expect(unit.getCells().sort((a, b) => a.x - b.x || a.y - b.y)).toEqual(
                before
                    .map((cell) => (side ? { x: cell.x, y: 15 - cell.y } : { x: 15 - cell.x, y: cell.y }))
                    .sort((a, b) => a.x - b.x || a.y - b.y),
            );
            for (const member of [unit, ally])
                for (const cell of member.getCells()) expect(c.grid.getOccupantUnitId(cell)).toBe(member.getId());
            expect(enemy.getUnitProperties()).toEqual(enemyBefore);
            expect(unit.getCumulativeHp()).toBe(hp);
            expect(unit.getAmountAlive()).toBe(amount);
        });
    }
}

test("an occupied mirrored cell cancels the whole formation without moving anything", () => {
    const c = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setSideOrientedPlacement(true);
    fp.setDefaultPlacementPerTeam(PBTypes.TeamVals.LEFT, DefaultPlacementLevel1.THREE_BY_THREE);
    const unit = createTestUnit({ team: PBTypes.TeamVals.LEFT });
    placeUnit(c.grid, c.unitsHolder, unit, { x: 1, y: 3 });
    c.grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, { x: 1, y: 12 });
    const before = snapshotBattle(c.unitsHolder, c.grid, fp);
    expect(mirrorBarrelStudyDeployment({ ...c, fightProperties: fp }, PBTypes.TeamVals.LEFT)).toBe(false);
    expect(snapshotBattle(c.unitsHolder, c.grid, fp)).toEqual(before);
});
