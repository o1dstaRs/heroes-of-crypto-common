import { expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { preserveOwnBarrelCemeteryFallback } from "../../src/ai/barrel_cemetery_guard";
import { prioritizeV08CemeteryObstacleAttack } from "../../src/ai/versions/v0_8";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const) {
    for (const footprint of [
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
    ]) {
        test(`cleanup preserves a native hold instead of destroying an own barrel, team ${team}, ${footprint}`, () => {
            const base = createCombatTestContext(1);
            const actor = createTestUnit({ team, footprintWidth: footprint[0], footprintHeight: footprint[1] });
            const enemy = createTestUnit({
                team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
            });
            placeUnit(base.grid, base.unitsHolder, actor, { x: 3, y: 10 });
            placeUnit(base.grid, base.unitsHolder, enemy, { x: 13, y: 2 });
            expect(base.grid.placeArtifactBarrel(team, 0, { x: 4, y: 10 })).toBe(true);
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.startFight();
            const context: IDecisionContext = {
                ...base,
                matrix: base.grid.getMatrix(),
                fightProperties,
                pathHelper: new PathHelper(base.grid.getSettings()),
            };
            const hold: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];
            const snapshot = snapshotBattle(base.unitsHolder, base.grid, fightProperties);
            const cleanup = prioritizeV08CemeteryObstacleAttack(actor, context, hold);
            expect(cleanup.some((action) => action.type === "obstacle_attack")).toBe(true);
            expect(preserveOwnBarrelCemeteryFallback(actor, context, hold, cleanup)).toBe(hold);
            expect(preserveOwnBarrelCemeteryFallback(actor, context, cleanup, cleanup)).toBe(cleanup);
            expect(snapshotBattle(base.unitsHolder, base.grid, fightProperties)).toEqual(snapshot);

            base.grid.clearArtifactBarrels(team);
            base.grid.placeArtifactBarrel(enemy.getTeam(), 0, { x: 4, y: 10 });
            expect(preserveOwnBarrelCemeteryFallback(actor, context, hold, cleanup)).toBe(cleanup);
            base.grid.clearArtifactBarrels(enemy.getTeam());
            base.grid.setScatteredMountains([{ x: 4, y: 10 }]);
            expect(preserveOwnBarrelCemeteryFallback(actor, context, hold, cleanup)).toBe(cleanup);

            const attack: GameAction[] = [
                {
                    type: "melee_attack",
                    attackerId: actor.getId(),
                    targetId: enemy.getId(),
                    attackFrom: actor.getBaseCell(),
                },
            ];
            expect(preserveOwnBarrelCemeteryFallback(actor, context, hold, attack)).toBe(attack);
        });
    }
}
