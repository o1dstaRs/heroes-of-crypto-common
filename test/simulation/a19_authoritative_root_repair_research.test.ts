import { describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PathHelper } from "../../src/grid/path_helper";
import {
    repairA19AuthoritativeRootResearch,
    type IAuthoritativeRootRepairResearchInput,
} from "../../src/simulation/a19_authoritative_root_repair_research";
import { captureDeterministicRandomState } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function fixture(): IAuthoritativeRootRepairResearchInput {
    const combat = createCombatTestContext();
    const unit = createTestUnit({ team: 1 });
    const target = createTestUnit({ team: 2 });
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 6, y: 5 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    const context: IDecisionContext = {
        ...combat,
        fightProperties,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        decisionOrigin: "root",
    };
    const actions: GameAction[] = [
        {
            type: "move_unit",
            unitId: unit.getId(),
            path: [
                { x: 3, y: 3 },
                { x: 4, y: 3 },
            ],
            targetCells: [{ x: 4, y: 3 }],
        },
        {
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: target.getId(),
            attackFrom: { x: 5, y: 4 },
            path: [
                { x: 3, y: 3 },
                { x: 4, y: 4 },
                { x: 5, y: 4 },
            ],
        },
    ];
    return { unit, version: "v0.8", actions, context, team: 1, searched: true };
}

describe("inactive final authoritative A19 repair", () => {
    it("aligns the chosen real plan without changing its source, physical state or RNG", () => {
        const input = fixture();
        const before = structuredClone(input.actions);
        const properties = structuredClone(input.unit.getUnitProperties());
        const random = captureDeterministicRandomState();
        const repaired = repairA19AuthoritativeRootResearch(input);
        expect(repaired.reason).toBe("aligned-approach");
        expect(repaired.actions).not.toBe(input.actions);
        expect(input.actions).toEqual(before);
        expect(input.unit.getUnitProperties()).toEqual(properties);
        expect(captureDeterministicRandomState()).toEqual(random);
        expect(repaired.actions[0]).toMatchObject({ type: "move_unit", targetCells: [{ x: 5, y: 4 }] });
        expect(repaired.actions[1]).toMatchObject({ type: "melee_attack", attackFrom: { x: 5, y: 4 } });
        expect("path" in repaired.actions[1]).toBe(false);
    });

    for (const origin of ["rollout", undefined] as const) {
        it(`preserves the original list for ${origin ?? "missing"} origin`, () => {
            const input = fixture();
            input.context = { ...input.context!, decisionOrigin: origin };
            expect(repairA19AuthoritativeRootResearch(input).actions).toBe(input.actions);
        });
    }

    it("preserves failed search, other versions, the other team and absent contexts", () => {
        const input = fixture();
        for (const patch of [{ searched: false }, { version: "v0.9" }, { team: 2 as const }, { context: undefined }]) {
            expect(repairA19AuthoritativeRootResearch({ ...input, ...patch }).actions).toBe(input.actions);
        }
    });

    it("leaves consistent real commands by reference for target-memory reconciliation", () => {
        const input = fixture();
        input.actions = [{ type: "wait_turn", unitId: input.unit.getId() }];
        expect(repairA19AuthoritativeRootResearch(input).actions).toBe(input.actions);
    });

    it("refuses a detached actor even when its ID and properties match", () => {
        const input = fixture();
        const detached = Object.assign(Object.create(Object.getPrototypeOf(input.unit)), input.unit);
        expect(repairA19AuthoritativeRootResearch({ ...input, unit: detached }).actions).toBe(input.actions);
    });
});
