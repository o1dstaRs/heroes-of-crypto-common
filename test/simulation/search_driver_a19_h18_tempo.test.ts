import { describe, expect, it } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { isEarlyIsolatingFastFlyerWaitMove } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";

interface MockUnitOptions {
    id: string;
    cells: XY[];
    level?: number;
    steps?: number;
    flying?: boolean;
}

const mockUnit = ({
    id,
    cells,
    level = PBTypes.UnitLevelVals.FIRST,
    steps = 5,
    flying = false,
}: MockUnitOptions): Unit =>
    ({
        canFly: () => flying,
        getCells: () => cells,
        getId: () => id,
        getLevel: () => level,
        getSteps: () => steps,
        getTeam: () => PBTypes.TeamVals.UPPER,
        isDead: () => false,
    }) as unknown as Unit;

const holderWith = (...units: Unit[]): ILookaheadDeps["unitsHolder"] =>
    ({ getAllAllies: () => units }) as unknown as ILookaheadDeps["unitsHolder"];

const moveCandidate = (targetCells: XY[], extraActions: GameAction[] = []): Pick<IEnumeratedCandidate, "actions"> => ({
    actions: [
        {
            type: "move_unit",
            unitId: "dragon",
            path: targetCells,
            targetCells,
        },
        ...extraActions,
    ],
});

describe("A19 H18 opening-tempo guard", () => {
    const dragonCells = [
        { x: 12, y: 13 },
        { x: 11, y: 13 },
        { x: 12, y: 12 },
        { x: 11, y: 12 },
    ];
    const isolatedDestination = [
        { x: 7, y: 8 },
        { x: 6, y: 8 },
        { x: 7, y: 7 },
        { x: 6, y: 7 },
    ];
    const dragon = mockUnit({
        id: "dragon",
        cells: dragonCells,
        level: PBTypes.UnitLevelVals.FOURTH,
        steps: 8,
        flying: true,
    });
    // Exact red opening geometry from regression seed 2288740294 / game 171: the Black Dragon begins two
    // cells from the Blacksmith, then the rejected H18 challenger dives from (12,13) to (7,8), four cells
    // from its closest living ally.
    const allies = holderWith(
        dragon,
        mockUnit({ id: "mermaid", cells: [{ x: 7, y: 12 }] }),
        mockUnit({ id: "blacksmith", cells: [{ x: 9, y: 12 }] }),
        mockUnit({ id: "nomad", cells: [{ x: 5, y: 12 }] }),
        mockUnit({ id: "medusa", cells: [{ x: 1, y: 14 }] }),
        mockUnit({ id: "cyclops", cells: [{ x: 14, y: 14 }] }),
    );

    it("recognizes the exact game-171 move-only Black Dragon solo dive", () => {
        expect(isEarlyIsolatingFastFlyerWaitMove(dragon, allies, 1, moveCandidate(isolatedDestination))).toBe(true);
    });

    it("does not block later movement, supported movement, or a move that delivers an attack", () => {
        expect(isEarlyIsolatingFastFlyerWaitMove(dragon, allies, 2, moveCandidate(isolatedDestination))).toBe(false);
        expect(
            isEarlyIsolatingFastFlyerWaitMove(
                dragon,
                allies,
                1,
                moveCandidate([
                    { x: 10, y: 11 },
                    { x: 9, y: 11 },
                    { x: 10, y: 10 },
                    { x: 9, y: 10 },
                ]),
            ),
        ).toBe(false);
        expect(
            isEarlyIsolatingFastFlyerWaitMove(
                dragon,
                allies,
                1,
                moveCandidate(isolatedDestination, [
                    {
                        type: "melee_attack",
                        attackerId: "dragon",
                        targetId: "enemy",
                        attackFrom: { x: 7, y: 8 },
                    },
                ]),
            ),
        ).toBe(false);
    });
});
