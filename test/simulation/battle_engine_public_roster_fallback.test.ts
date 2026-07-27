import { describe, expect, test } from "bun:test";

import type { IAIStrategy, IPlacementContext } from "../../src/ai";
import { opponentCreatureIdsForPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import type { IArmyUnitSpec } from "../../src/simulation/army";
import { runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";

const C = PBTypes.CreatureVals;

const SQUIRE: IArmyUnitSpec = {
    faction: "Life",
    creatureName: "Squire",
    level: 1,
    size: 1,
    amount: 1,
};
const BATTLE_MAGE: IArmyUnitSpec = {
    faction: "Life",
    creatureName: "Battle Mage",
    level: 2,
    size: 1,
    amount: 1,
};
const GRIFFIN: IArmyUnitSpec = {
    faction: "Life",
    creatureName: "Griffin",
    level: 3,
    size: 1,
    amount: 1,
};
const ARACHNA_QUEEN: IArmyUnitSpec = {
    faction: "Nature",
    creatureName: "Arachna Queen",
    level: 4,
    size: 2,
    amount: 1,
};

interface IPlacementObservation {
    readonly publicOpponentCreatureIds: readonly number[] | undefined;
    readonly revealedOpponentCreatures: readonly number[] | undefined;
    readonly selectedOpponentCreatureIds: readonly number[] | undefined;
}

class CapturePlacementStrategy implements IAIStrategy {
    public readonly version = "placement-capture";
    public readonly observations: IPlacementObservation[] = [];

    public placeArmy(_units: Unit[], context: IPlacementContext): Map<string, XY> {
        this.observations.push({
            publicOpponentCreatureIds: context.publicOpponentCreatureIds,
            revealedOpponentCreatures: context.revealedOpponentCreatures,
            selectedOpponentCreatureIds: opponentCreatureIdsForPlacement(context, "v0.7"),
        });
        return new Map();
    }

    public decideTurn(unit: Unit): GameAction[] {
        return [{ type: "defend_turn", unitId: unit.getId() }];
    }
}

type CaptureConfig = Pick<IMatchConfig, "roster"> &
    Partial<
        Pick<
            IMatchConfig,
            | "redRoster"
            | "greenPublicOpponentCreatures"
            | "redPublicOpponentCreatures"
            | "greenRevealedCreatures"
            | "redRevealedCreatures"
            | "greenSetupPlacementPolicy"
            | "redSetupPlacementPolicy"
        >
    >;

function capturePlacement(config: CaptureConfig): {
    green: CapturePlacementStrategy;
    red: CapturePlacementStrategy;
} {
    const green = new CapturePlacementStrategy();
    const red = new CapturePlacementStrategy();
    runMatch({
        ...config,
        greenVersion: "v0.1",
        redVersion: "v0.1",
        greenStrategyOverride: green,
        redStrategyOverride: red,
        seed: 880_021,
        maxLaps: 0,
    });
    expect(green.observations).toHaveLength(1);
    expect(red.observations).toHaveLength(1);
    return { green, red };
}

const observed = (strategy: CapturePlacementStrategy): IPlacementObservation => strategy.observations[0]!;

describe("BattleEngine public opponent roster fallback", () => {
    test("derives asymmetric opposing identities and deduplicates in finalized roster order", () => {
        const { green, red } = capturePlacement({
            roster: [SQUIRE, BATTLE_MAGE],
            redRoster: [GRIFFIN, SQUIRE, GRIFFIN],
        });

        expect(observed(green).publicOpponentCreatureIds).toEqual([C.GRIFFIN, C.SQUIRE]);
        expect(observed(red).publicOpponentCreatureIds).toEqual([C.SQUIRE, C.BATTLE_MAGE]);
    });

    test("uses the mirrored default roster when redRoster is omitted", () => {
        const { green, red } = capturePlacement({ roster: [SQUIRE, BATTLE_MAGE] });

        expect(observed(green).publicOpponentCreatureIds).toEqual([C.SQUIRE, C.BATTLE_MAGE]);
        expect(observed(red).publicOpponentCreatureIds).toEqual([C.SQUIRE, C.BATTLE_MAGE]);
    });

    test("preserves explicit empty opt-outs and explicit partial arrays exactly", () => {
        const empty: readonly number[] = [];
        const optedOut = capturePlacement({
            roster: [SQUIRE, BATTLE_MAGE],
            redRoster: [GRIFFIN, SQUIRE],
            greenPublicOpponentCreatures: empty,
            redPublicOpponentCreatures: empty,
            greenSetupPlacementPolicy: "public-roster",
            redSetupPlacementPolicy: "public-roster",
        });
        expect(observed(optedOut.green).publicOpponentCreatureIds).toBe(empty);
        expect(observed(optedOut.red).publicOpponentCreatureIds).toBe(empty);
        expect(observed(optedOut.green).selectedOpponentCreatureIds).toBe(empty);
        expect(observed(optedOut.red).selectedOpponentCreatureIds).toBe(empty);

        const greenPartial = [C.SQUIRE] as const;
        const redPartial = [C.BATTLE_MAGE] as const;
        const partial = capturePlacement({
            roster: [SQUIRE, BATTLE_MAGE],
            redRoster: [GRIFFIN, SQUIRE],
            greenPublicOpponentCreatures: greenPartial,
            redPublicOpponentCreatures: redPartial,
            greenSetupPlacementPolicy: "public-roster",
            redSetupPlacementPolicy: "public-roster",
        });
        expect(observed(partial.green).publicOpponentCreatureIds).toBe(greenPartial);
        expect(observed(partial.red).publicOpponentCreatureIds).toBe(redPartial);
        expect(observed(partial.green).selectedOpponentCreatureIds).toBe(greenPartial);
        expect(observed(partial.red).selectedOpponentCreatureIds).toBe(redPartial);
    });

    test("keeps baseline blind and legitimate-reveal limited to the partial reveal list", () => {
        const baseline = capturePlacement({
            roster: [SQUIRE, BATTLE_MAGE],
            redRoster: [GRIFFIN, SQUIRE],
            greenRevealedCreatures: [C.GRIFFIN],
            greenSetupPlacementPolicy: "baseline",
        });
        expect(observed(baseline.green).publicOpponentCreatureIds).toEqual([C.GRIFFIN, C.SQUIRE]);
        expect(observed(baseline.green).selectedOpponentCreatureIds).toBeUndefined();

        const legitimateReveals = [C.SQUIRE] as const;
        const legitimate = capturePlacement({
            roster: [SQUIRE, BATTLE_MAGE],
            redRoster: [GRIFFIN, SQUIRE],
            greenRevealedCreatures: legitimateReveals,
            greenSetupPlacementPolicy: "legitimate-reveal",
        });
        expect(observed(legitimate.green).publicOpponentCreatureIds).toEqual([C.GRIFFIN, C.SQUIRE]);
        expect(observed(legitimate.green).revealedOpponentCreatures).toBe(legitimateReveals);
        expect(observed(legitimate.green).selectedOpponentCreatureIds).toBe(legitimateReveals);
    });

    test("makes native v0.8 Queen-and-ward placement identical for omitted and explicit-complete rosters", () => {
        const base = {
            greenVersion: "v0.8",
            redVersion: "v0.8",
            roster: [ARACHNA_QUEEN, BATTLE_MAGE],
            redRoster: [GRIFFIN],
            seed: 880_022,
            maxLaps: 0,
        } satisfies IMatchConfig;
        const omitted = runMatch(base);
        const explicit = runMatch({
            ...base,
            greenPublicOpponentCreatures: [C.GRIFFIN],
            redPublicOpponentCreatures: [C.ARACHNA_QUEEN, C.BATTLE_MAGE],
        });

        expect(omitted.placements).toEqual(explicit.placements);
        const queen = omitted.placements.green.find((placement) => placement.creatureName === "Arachna Queen");
        const ward = omitted.placements.green.find((placement) => placement.creatureName === "Battle Mage");
        expect(queen).toBeDefined();
        expect(ward).toBeDefined();
        const queenCells = [
            queen!.cell,
            { x: queen!.cell.x - 1, y: queen!.cell.y },
            { x: queen!.cell.x, y: queen!.cell.y - 1 },
            { x: queen!.cell.x - 1, y: queen!.cell.y - 1 },
        ];
        expect(
            Math.min(
                ...queenCells.map((cell) => Math.max(Math.abs(cell.x - ward!.cell.x), Math.abs(cell.y - ward!.cell.y))),
            ),
        ).toBe(1);
    });
});
