import { describe, expect, it } from "bun:test";
import { enumerateCandidates } from "../../src/ai/candidates";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import type { GameAction } from "../../src/engine/actions";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";
const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;
function fixture(gridType = PBTypes.GridVals.NORMAL, ranged = false, barrels = true) {
    const combat = createCombatTestContext(gridType),
        fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(gridType);
    combat.grid.setScatteredMountains([{ x: 5, y: 6 }]);
    const unit = createTestUnit({
        team: LEFT,
        attackType: ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: ranged ? 4 : 0,
    });
    const enemy = createTestUnit({ team: RIGHT });
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 4, y: 4 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 12 });
    if (barrels) {
        expect(combat.grid.placeArtifactBarrel(LEFT, 0, { x: 2, y: 4 })).toBe(true);
        expect(combat.grid.placeArtifactBarrel(RIGHT, 0, { x: 5, y: 4 })).toBe(true);
        expect(combat.grid.placeArtifactBarrel(RIGHT, 1, { x: 5, y: 5 })).toBe(true);
    }
    fp.setTeamUnitsAlive(LEFT, 1);
    fp.setTeamUnitsAlive(RIGHT, 1);
    fp.startFight();
    fp.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: fp,
    };
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fp,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => unit.getId(),
    });
    const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    return { combat, fp, unit, enemy, context, engine, incumbent };
}
describe("opt-in public artifact barrel target coverage", () => {
    for (const map of [1, 2, 3, 4])
        for (const ranged of [false, true])
            it(`applies every distinct obstacle attack on map ${map}, ranged ${ranged}`, () => {
                const h = fixture(map, ranged),
                    ordinary = enumerateCandidates(h.unit, h.context, h.incumbent, { includeMountainAttacks: true });
                const extended = enumerateCandidates(h.unit, h.context, h.incumbent, {
                    includeMountainAttacks: true,
                    includeArtifactBarrelAttackCoverage: true,
                });
                expect(extended.candidates[0]).toEqual(ordinary.candidates[0]);
                const mines = extended.candidates.filter((c) => c.kind === "mine");
                expect(new Set(mines.map((c) => `${c.targetCell?.x},${c.targetCell?.y}`))).toEqual(
                    new Set(["2,4", "5,4", "5,5", "5,6"]),
                );
                const baseline = snapshotBattle(h.combat.unitsHolder, h.combat.grid, h.fp);
                for (const c of mines) {
                    try {
                        for (const action of c.actions) expect(h.engine.apply(action).completed).toBe(true);
                    } finally {
                        restoreBattle(baseline, h.combat.unitsHolder, h.combat.grid, h.fp);
                        h.combat.damageStatisticHolder.clear();
                    }
                }
            });
    it("keeps the complete catalog identical when absent or explicitly disabled", () => {
        const h = fixture(),
            ordinary = enumerateCandidates(h.unit, h.context, h.incumbent, { includeMountainAttacks: true });
        expect(
            enumerateCandidates(h.unit, h.context, h.incumbent, {
                includeMountainAttacks: true,
                includeArtifactBarrelAttackCoverage: false,
            }),
        ).toEqual(ordinary);
        const none = fixture(1, true, false);
        expect(
            enumerateCandidates(none.unit, none.context, none.incumbent, {
                includeMountainAttacks: true,
                includeArtifactBarrelAttackCoverage: true,
            }),
        ).toEqual(enumerateCandidates(none.unit, none.context, none.incumbent, { includeMountainAttacks: true }));
    });
    it("does not offer obstacle attacks while a living enemy forces the actor's target", () => {
        const h = fixture();
        h.unit.setTarget(h.enemy.getId());
        expect(
            enumerateCandidates(h.unit, h.context, h.incumbent, {
                includeArtifactBarrelAttackCoverage: true,
            }).candidates.some((c) => c.kind === "mine"),
        ).toBe(false);
    });
});
