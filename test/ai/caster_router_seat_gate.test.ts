/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import { routeUniversalCaster } from "../../src/ai/versions/caster_router";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
    };
}

const fallback = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];

afterEach(() => {
    delete process.env.V06_CASTER_ROUTER;
});

/**
 * A/B seat scoping (Q1 LiveTwin A/B): both seats of a sim game share process env, so the paired
 * routed-vs-unrouted measurement needs the gate to address ONE team. `green` must route only LOWER,
 * `red` only UPPER, `both` == `on`, anything else = off — and the un-routed seat must get its incumbent
 * array back by REFERENCE (no enumeration side effects).
 */
describe("v0.6 caster router A/B seat gate", () => {
    function seatProbe(): {
        combat: CombatTestContext;
        greenCaster: Unit;
        redCaster: Unit;
        context: IDecisionContext;
        enumerated: Unit[];
    } {
        const combat = createCombatTestContext();
        const greenCaster = createTestUnit({ team: LOWER, attackType: MELEE_MAGIC });
        const redCaster = createTestUnit({ team: UPPER, attackType: MELEE_MAGIC });
        placeUnit(combat.grid, combat.unitsHolder, greenCaster, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, redCaster, { x: 5, y: 12 });
        const enumerated: Unit[] = [];
        return { combat, greenCaster, redCaster, context: contextFor(combat), enumerated };
    }
    /** Enumeration spy: records which unit reached routing and yields no candidates (incumbent stands). */
    const spyEnumerator =
        (enumerated: Unit[]) =>
        (
            unit: Unit,
            _context: IDecisionContext,
            incumbent: GameAction[],
        ): { candidates: never[]; truncated: never[] } => {
            enumerated.push(unit);
            void incumbent;
            return { candidates: [], truncated: [] };
        };

    it("green routes only the LOWER seat; the UPPER seat keeps its incumbent untouched", () => {
        const { greenCaster, redCaster, context, enumerated } = seatProbe();
        process.env.V06_CASTER_ROUTER = "green";
        const greenIncumbent = fallback(greenCaster);
        const redIncumbent = fallback(redCaster);
        expect(routeUniversalCaster(greenCaster, context, greenIncumbent, spyEnumerator(enumerated))).toBe(
            greenIncumbent,
        );
        expect(routeUniversalCaster(redCaster, context, redIncumbent, spyEnumerator(enumerated))).toBe(redIncumbent);
        expect(enumerated.map((u) => u.getId())).toEqual([greenCaster.getId()]);
    });

    it("red routes only the UPPER seat", () => {
        const { greenCaster, redCaster, context, enumerated } = seatProbe();
        process.env.V06_CASTER_ROUTER = "red";
        expect(routeUniversalCaster(greenCaster, context, fallback(greenCaster), spyEnumerator(enumerated))).toEqual(
            fallback(greenCaster),
        );
        routeUniversalCaster(redCaster, context, fallback(redCaster), spyEnumerator(enumerated));
        expect(enumerated.map((u) => u.getId())).toEqual([redCaster.getId()]);
    });

    it("both behaves like on, and unknown values keep the gate off", () => {
        const { greenCaster, redCaster, context, enumerated } = seatProbe();
        process.env.V06_CASTER_ROUTER = "both";
        routeUniversalCaster(greenCaster, context, fallback(greenCaster), spyEnumerator(enumerated));
        routeUniversalCaster(redCaster, context, fallback(redCaster), spyEnumerator(enumerated));
        expect(enumerated).toHaveLength(2);

        process.env.V06_CASTER_ROUTER = "1"; // not a recognised value — must stay off
        const incumbent = fallback(greenCaster);
        expect(routeUniversalCaster(greenCaster, context, incumbent, spyEnumerator(enumerated))).toBe(incumbent);
        expect(enumerated).toHaveLength(2);
    });
});
