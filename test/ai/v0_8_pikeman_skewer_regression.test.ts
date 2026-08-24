import { describe, expect, test } from "bun:test";

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

describe("v0.8 Pikeman Skewer regression", () => {
    test("attacks a two-stack Skewer line instead of hourglassing", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.LAVA_CENTER);
        fightProperties.startFight();
        fightProperties.flipLap();

        const pikeman = createTestUnit({
            team: LOWER,
            name: "Pikeman",
            amountAlive: 20,
            maxHp: 27,
            initiative: 5,
            abilities: ["Aggr", "Skewer Strike", "Wardguard"],
        });
        const goblin = createTestUnit({ team: UPPER, name: "Goblin Knight", amountAlive: 7, maxHp: 10 });
        const wanderingMage = createTestUnit({
            team: UPPER,
            name: "Wandering Mage",
            attackType: PBTypes.AttackVals.MAGIC,
            amountAlive: 25,
        });
        const blackDragon = createTestUnit({ team: UPPER, name: "Black Dragon", amountAlive: 1, maxHp: 300 });
        const ally = createTestUnit({ team: LOWER, name: "Healer", attackType: PBTypes.AttackVals.MAGIC });

        placeUnit(combat.grid, combat.unitsHolder, pikeman, { x: 4, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, goblin, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, wanderingMage, { x: 2, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, blackDragon, { x: 1, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 10, y: 2 });
        fightProperties.setTeamUnitsAlive(LOWER, 2);
        fightProperties.setTeamUnitsAlive(UPPER, 3);

        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        for (const version of ["v0.5", "v0.8"]) {
            const decision = getAIStrategy(version).decideTurn(pikeman, context);

            expect(decision.some((action) => action.type === "wait_turn")).toBe(false);
            expect(decision).toContainEqual(
                expect.objectContaining({
                    type: "melee_attack",
                    targetId: wanderingMage.getId(),
                    attackFrom: { x: 3, y: 6 },
                }),
            );
        }
    });
});
