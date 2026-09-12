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

import { describe, expect, it } from "bun:test";

import { AI_VERSIONS, createAIStrategy } from "../../src/ai/ranked_profile";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/**
 * Who can actually use a Gargantuan?
 *
 * Area Throw rides the unit's ORDINARY ranged attack — "ranged attacks inflict {}% of the damage on all
 * units adjacent to the target cell" — so the engine splashes every `range_attack` an Area Throw unit
 * makes. v0.2 and up therefore already splash without knowing the ability exists; the separate
 * `area_throw_attack` action only adds the ability to aim at a CELL, including an empty one.
 *
 * v0.1 was the real gap: it produced no attack at all for this unit. Only the shared candidate generator
 * builds an `area_throw_attack` and v0.1 never enumerates, so routeAreaThrow — now applied to every
 * registered profile — is what gives it one.
 *
 * The router keeps the env gate it always had, off by default, because v0.1-v0.5 are frozen baselines
 * (CEM trains against a frozen v0.4, v0.6's fight is byte-for-byte v0.5) and seeded traces are pinned to
 * their exact decisions.
 */
const withGate = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env.V06_AREA_THROW;
    if (value === undefined) delete process.env.V06_AREA_THROW;
    else process.env.V06_AREA_THROW = value;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.V06_AREA_THROW;
        else process.env.V06_AREA_THROW = previous;
    }
};

/** A Gargantuan facing three stacks packed tightly enough that one splash catches all of them. */
const splashBoard = () => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder, attackHandler } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const thrower = createTestUnit({
        name: "Gargantuan",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 50,
        damageMin: 40,
        damageMax: 40,
        rangeShots: 3,
        shotDistance: 16,
        initiative: 9,
        abilities: ["Area Throw"],
    });
    placeUnit(grid, unitsHolder, thrower, { x: 2, y: 8 });

    let index = 0;
    for (const cell of [
        { x: 9, y: 8 },
        { x: 10, y: 8 },
        { x: 9, y: 9 },
    ]) {
        placeUnit(
            grid,
            unitsHolder,
            createTestUnit({
                name: `Victim${index}`,
                team: PBTypes.TeamVals.RIGHT,
                maxHp: 500,
                amountAlive: 20,
                armor: 0,
            }),
            cell,
        );
        index += 1;
    }

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 3);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const decisionContext = {
        grid,
        matrix: grid.getMatrix(),
        unitsHolder,
        pathHelper: new PathHelper(grid.getSettings()),
        attackHandler,
        fightProperties,
    };

    /** How many enemy stacks the splash of a decided attack would actually catch. */
    const splashHits = (actions: readonly GameAction[]): number => {
        const shot = actions.find((action) => action.type === "range_attack");
        if (shot?.type !== "range_attack") return 0;
        const target = unitsHolder.getAllUnits().get(shot.targetId);
        if (!target) return 0;
        return attackHandler
            .evaluateRangeAttack(
                unitsHolder.getAllUnits(),
                thrower,
                thrower.getPosition(),
                target.getPosition(),
                false,
                false,
                true,
            )
            .affectedUnits.flat()
            .filter((unit) => unit.getTeam() === PBTypes.TeamVals.RIGHT).length;
    };

    return { thrower, decisionContext, splashHits };
};

const decide = (version: string): { actions: GameAction[]; splashHits: number } => {
    const { thrower, decisionContext, splashHits } = splashBoard();
    const actions = createAIStrategy(version).decideTurn(thrower, decisionContext as never);
    return { actions, splashHits: splashHits(actions) };
};

const attackOf = (actions: readonly GameAction[]): string | undefined =>
    actions.find((action) => action.type === "range_attack" || action.type === "area_throw_attack")?.type;

describe("Gargantuan's splash across every AI version", () => {
    it("v0.2 and up already splash through their ordinary ranged attack", () => {
        // Area Throw is an attack modifier, not a separate action: the engine splashes every range_attack
        // these versions were already making. No routing is involved, which is why the gate is irrelevant here.
        const later = AI_VERSIONS.filter((version) => version !== "v0.1");

        for (const version of later) {
            const { splashHits } = withGate(undefined, () => decide(version));
            expect(`${version}:${splashHits}`).toBe(`${version}:3`);
        }
    });

    it("v0.1 gains an attack it could not previously make", () => {
        // The real gap. v0.1 never enumerates candidates, so it could not build an area_throw_attack — and
        // on this board it decided on no attack at all.
        expect(attackOf(withGate(undefined, () => decide("v0.1")).actions)).toBeUndefined();
        expect(attackOf(withGate("on", () => decide("v0.1")).actions)).toBe("area_throw_attack");
    });

    it("no version changes its decision while the gate is off", () => {
        // The frozen baselines must stay exactly as they were, or every historical A/B and every seeded
        // trace silently moves under them.
        const splashing = withGate(undefined, () =>
            AI_VERSIONS.filter((version) => attackOf(decide(version).actions) === "area_throw_attack"),
        );

        expect(splashing).toEqual([]);
    });

    it("leaves a unit without the ability alone even with the gate on", () => {
        const actions = withGate("on", () => {
            const { thrower, decisionContext } = splashBoard();
            thrower.deleteAbility("Area Throw");
            return createAIStrategy("v0.4").decideTurn(thrower, decisionContext as never);
        });

        expect(attackOf(actions)).not.toBe("area_throw_attack");
    });
});
