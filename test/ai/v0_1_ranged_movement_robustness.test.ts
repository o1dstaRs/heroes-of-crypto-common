import { describe, expect, test } from "bun:test";

import { canUnitLandAt } from "../../src/ai/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IArmyUnitSpec } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { liveTwinSetup } from "../../src/simulation/livetwin";
import type { XY } from "../../src/utils/math";

interface IObservedMove {
    readonly from: XY;
    readonly destination?: XY;
    readonly travelledCells: number;
    readonly stepBudget: number;
    readonly rangeShots: number;
    readonly hasWaterCell: boolean;
    readonly crossesWater: boolean;
    readonly canLand: boolean;
}

interface IRejectedAction {
    readonly creatureName: string;
    readonly type: string;
    readonly reason?: string;
}

// Frozen outputs of the all-random LIVETWIN exp-budget roster builder. Keeping the armies fixed means
// future catalog additions cannot silently turn these two production-failure seeds into different fights.
const TSAR_GREEN_ROSTER: IArmyUnitSpec[] = [
    { faction: "Chaos", creatureName: "Scavenger", level: 1, size: 1, amount: 164 },
    { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 124 },
    { faction: "Chaos", creatureName: "Beholder", level: 2, size: 1, amount: 22 },
    { faction: "Chaos", creatureName: "Troll", level: 2, size: 1, amount: 25 },
    { faction: "Life", creatureName: "Griffin", level: 3, size: 1, amount: 9 },
    { faction: "Life", creatureName: "Tsar Cannon", level: 4, size: 2, amount: 2 },
];

const TSAR_RED_ROSTER: IArmyUnitSpec[] = [
    { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 100 },
    { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 132 },
    { faction: "Chaos", creatureName: "Medusa", level: 2, size: 1, amount: 24 },
    { faction: "Might", creatureName: "Hyena", level: 2, size: 1, amount: 26 },
    { faction: "Chaos", creatureName: "Goblin Knight", level: 3, size: 1, amount: 9 },
    { faction: "Life", creatureName: "Angel", level: 4, size: 2, amount: 2 },
];

const BEHOLDER_GREEN_ROSTER: IArmyUnitSpec[] = [
    { faction: "Might", creatureName: "Centaur", level: 1, size: 1, amount: 73 },
    { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 124 },
    { faction: "Nature", creatureName: "Elf", level: 2, size: 1, amount: 26 },
    { faction: "Might", creatureName: "Harpy", level: 2, size: 1, amount: 27 },
    { faction: "Life", creatureName: "Griffin", level: 3, size: 1, amount: 9 },
    { faction: "Nature", creatureName: "Gargantuan", level: 4, size: 2, amount: 2 },
];

const BEHOLDER_RED_ROSTER: IArmyUnitSpec[] = [
    { faction: "Might", creatureName: "Centaur", level: 1, size: 1, amount: 73 },
    { faction: "Might", creatureName: "Wolf Rider", level: 1, size: 1, amount: 81 },
    { faction: "Chaos", creatureName: "Beholder", level: 2, size: 1, amount: 22 },
    { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 25 },
    { faction: "Life", creatureName: "Griffin", level: 3, size: 1, amount: 9 },
    { faction: "Chaos", creatureName: "Abomination", level: 4, size: 2, amount: 1 },
];

function replayRangedMovementFailure(
    seed: number,
    gridType: number,
    roster: IArmyUnitSpec[],
    redRoster: IArmyUnitSpec[],
    creatureName: string,
): { moves: IObservedMove[]; rejected: IRejectedAction[]; rejectedGreen: number; rejectedRed: number } {
    const moves: IObservedMove[] = [];
    const rejected: IRejectedAction[] = [];
    const greenSetup = liveTwinSetup();
    const redSetup = liveTwinSetup();

    const result = runMatch({
        greenVersion: "v0.1",
        redVersion: "v0.1",
        roster: structuredClone(roster),
        redRoster: structuredClone(redRoster),
        seed,
        gridType,
        maxLaps: 60,
        greenPerk: greenSetup.perk,
        redPerk: redSetup.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
        decisionObserver: ({ unit, context, incumbent }) => {
            if (unit.getName() !== creatureName) return;

            for (const action of incumbent) {
                if (action.type !== "move_unit") continue;

                const from = { ...unit.getBaseCell() };
                const first = action.path[0];
                const startsAtCurrentCell = first?.x === from.x && first.y === from.y;
                const destination = action.path.at(-1);
                moves.push({
                    from,
                    destination: destination ? { ...destination } : undefined,
                    travelledCells: action.path.length - (startsAtCurrentCell ? 1 : 0),
                    stepBudget: Math.max(1, Math.ceil(unit.getSteps())),
                    rangeShots: unit.getRangeShots(),
                    hasWaterCell: action.hasWaterCell === true,
                    crossesWater: action.path.some((cell) => context.grid.getOccupantUnitId(cell) === "W"),
                    canLand: destination !== undefined && canUnitLandAt(unit, context.grid, destination),
                });
            }
        },
        turnExecutionObserver: (observation) => {
            for (const execution of observation.strategyActions) {
                if (execution.completed) continue;
                rejected.push({
                    creatureName: observation.creatureName,
                    type: execution.action.type,
                    reason: execution.rejectionReason,
                });
            }
        },
    });

    return {
        moves,
        rejected,
        rejectedGreen: result.rejectedGreen ?? 0,
        rejectedRed: result.rejectedRed ?? 0,
    };
}

describe("v0.1 ranged movement robustness", () => {
    test("keeps an ammo-depleted Tsar Cannon within its movement budget on BLOCK seed 696926536", () => {
        const replay = replayRangedMovementFailure(
            696926536,
            PBTypes.GridVals.BLOCK_CENTER,
            TSAR_GREEN_ROSTER,
            TSAR_RED_ROSTER,
            "Tsar Cannon",
        );

        expect(replay.moves.length).toBeGreaterThan(0);
        expect(replay.moves.every((move) => move.rangeShots === 0)).toBe(true);
        expect(replay.moves.some((move) => move.travelledCells === move.stepBudget)).toBe(true);
        expect(replay.moves.filter((move) => move.travelledCells > move.stepBudget)).toEqual([]);
        expect(replay.rejected).toEqual([]);
        expect({ green: replay.rejectedGreen, red: replay.rejectedRed }).toEqual({ green: 0, red: 0 });
    });

    test("lets a Beholder cross water but never land on it on WATER seed 2763957387", () => {
        const replay = replayRangedMovementFailure(
            2763957387,
            PBTypes.GridVals.WATER_CENTER,
            BEHOLDER_GREEN_ROSTER,
            BEHOLDER_RED_ROSTER,
            "Beholder",
        );

        expect(replay.moves.length).toBeGreaterThan(0);
        expect(replay.moves.some((move) => move.crossesWater && move.hasWaterCell)).toBe(true);
        expect(replay.moves.filter((move) => !move.canLand)).toEqual([]);
        expect(replay.rejected).toEqual([]);
        expect({ green: replay.rejectedGreen, red: replay.rejectedRed }).toEqual({ green: 0, red: 0 });
    });
});
