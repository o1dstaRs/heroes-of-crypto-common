import { expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { auditOwnBarrelDecision } from "../../src/simulation/barrel_decision_audit";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

function fixture() {
    const base = createCombatTestContext(1);
    const actor = createTestUnit({ name: "Guard", team: PBTypes.TeamVals.LEFT });
    const enemy = createTestUnit({ name: "Intruder", team: PBTypes.TeamVals.RIGHT });
    placeUnit(base.grid, base.unitsHolder, actor, { x: 3, y: 10 });
    placeUnit(base.grid, base.unitsHolder, enemy, { x: 3, y: 11 });
    const cell = { x: 4, y: 10 };
    expect(base.grid.placeArtifactBarrel(actor.getTeam(), 0, cell)).toBe(true);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    const settings = base.grid.getSettings();
    const context: IDecisionContext = {
        ...base,
        fightProperties,
        matrix: base.grid.getMatrix(),
        pathHelper: new PathHelper(settings),
    };
    const chosen: GameAction[] = [
        {
            type: "obstacle_attack",
            attackerId: actor.getId(),
            targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
        },
    ];
    return { actor, enemy, context, chosen };
}

test("owned-barrel audit records a forgone melee attack without changing battle state or action inputs", () => {
    const { actor, context, chosen } = fixture();
    const before = snapshotBattle(context.unitsHolder, context.grid, context.fightProperties!);
    const actionsBefore = structuredClone(chosen);
    const audit = auditOwnBarrelDecision(actor, context, chosen, chosen);
    expect(audit?.keptIncumbent).toBe(true);
    expect(audit?.alternatives.some((candidate) => candidate.kind === "melee" && candidate.expectedDamage > 0)).toBe(
        true,
    );
    expect(snapshotBattle(context.unitsHolder, context.grid, context.fightProperties!)).toEqual(before);
    expect(chosen).toEqual(actionsBefore);
    expect(auditOwnBarrelDecision(actor, context, chosen, chosen)).toEqual(audit);
});

test("audit output is detached from actions and live unit footprints", () => {
    const { actor, context, chosen } = fixture();
    const audit = auditOwnBarrelDecision(actor, context, chosen, chosen)!;
    audit.actorCells[0].x = 99;
    expect(audit.chosen).not.toBe(chosen);
    expect(audit.chosen[0]).not.toBe(chosen[0]);
    expect(actor.getBaseCell().x).toBe(3);
    expect(chosen).toHaveLength(1);
});

test("enemy barrels and ordinary turns produce no own-barrel audit", () => {
    const { actor, context, chosen } = fixture();
    expect(auditOwnBarrelDecision(actor, context, [], [{ type: "end_turn", unitId: actor.getId() }])).toBeUndefined();
    context.grid.clearArtifactBarrels(actor.getTeam());
    context.grid.placeArtifactBarrel(PBTypes.TeamVals.RIGHT, 0, { x: 4, y: 10 });
    expect(auditOwnBarrelDecision(actor, context, chosen, chosen)).toBeUndefined();
});
