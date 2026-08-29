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
    name?: string;
    level?: number;
    steps?: number;
    flying?: boolean;
}

const mockUnit = ({
    id,
    cells,
    name = "Ally",
    level = PBTypes.UnitLevelVals.FIRST,
    steps = 5,
    flying = false,
}: MockUnitOptions): Unit =>
    ({
        canFly: () => flying,
        getCells: () => cells,
        getId: () => id,
        getLevel: () => level,
        getName: () => name,
        getSteps: () => steps,
        getTeam: () => PBTypes.TeamVals.RIGHT,
        isDead: () => false,
    }) as unknown as Unit;

const holderWith = (...units: Unit[]): ILookaheadDeps["unitsHolder"] =>
    ({ getAllAllies: () => units, getAllEnemyUnits: () => [] }) as unknown as ILookaheadDeps["unitsHolder"];

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
        name: "Black Dragon",
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

    it("blocks the unsupported Black Dragon move-and-strike hole but preserves supported attacks", () => {
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
        ).toBe(true);
        expect(
            isEarlyIsolatingFastFlyerWaitMove(
                dragon,
                allies,
                1,
                moveCandidate(
                    [
                        { x: 10, y: 11 },
                        { x: 9, y: 11 },
                        { x: 10, y: 10 },
                        { x: 9, y: 10 },
                    ],
                    [
                        {
                            type: "melee_attack",
                            attackerId: "dragon",
                            targetId: "enemy",
                            attackFrom: { x: 10, y: 11 },
                        },
                    ],
                ),
            ),
        ).toBe(false);
    });

    it("does not apply the move-and-strike extension to other fast flyers", () => {
        const thunderbird = mockUnit({
            id: "dragon",
            cells: dragonCells,
            name: "Thunderbird",
            level: PBTypes.UnitLevelVals.FOURTH,
            steps: 8,
            flying: true,
        });
        expect(
            isEarlyIsolatingFastFlyerWaitMove(
                thunderbird,
                holderWith(thunderbird, ...allies.getAllAllies(PBTypes.TeamVals.RIGHT).slice(1)),
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

    it("allows an already-isolated Black Dragon to move back toward its army", () => {
        const isolatedDragon = mockUnit({
            id: "dragon",
            cells: [{ x: 0, y: 0 }],
            name: "Black Dragon",
            level: PBTypes.UnitLevelVals.FOURTH,
            steps: 8,
            flying: true,
        });
        const recoveringMove = moveCandidate([{ x: 5, y: 0 }]);
        const distantAlly = mockUnit({ id: "ally", cells: [{ x: 10, y: 0 }] });

        expect(
            isEarlyIsolatingFastFlyerWaitMove(
                isolatedDragon,
                holderWith(isolatedDragon, distantAlly),
                1,
                recoveringMove,
            ),
        ).toBe(false);
    });
});
