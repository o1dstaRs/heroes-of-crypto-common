import { expect, test } from "bun:test";
import {
    selectActualContinuationPosition,
    selectMidpointActualContinuationPair,
    type IActualContinuationPosition,
} from "../../src/simulation/a19_actual_continuation";
import { GREEN_TEAM, RED_TEAM } from "../../src/simulation/battle_engine";

function position(ordinal: number, score: number | null, team = GREEN_TEAM, lap = 1): IActualContinuationPosition {
    return {
        ordinal,
        actorId: `actor-${ordinal}`,
        actor: "Orc",
        team,
        lap,
        stateDigest: `state-${ordinal}`,
        prefixDigest: `prefix-${ordinal}`,
        baselineSignature: "baseline",
        candidates: [
            { signature: "baseline", actions: [], kind: "incumbent", returnedR2Score: score },
            { signature: "alternative", actions: [], kind: "move", returnedR2Score: 0 },
        ],
    };
}

test("midpoint sampling pairs the control by actor team and phase without reading outcomes", () => {
    const positions = Array.from({ length: 36 }, (_, ordinal) =>
        position(ordinal, ordinal % 3 === 0 ? 0.5 : 1, ordinal % 2 ? RED_TEAM : GREEN_TEAM, (ordinal % 9) + 1),
    );
    const phase = (lap: number) => (lap <= 2 ? 0 : lap <= 5 ? 1 : 2);
    for (let board = 0; board < 36; board++) {
        const pair = selectMidpointActualContinuationPair(positions, board, 8321);
        expect(pair.midpointAvailable).toBe(true);
        expect(pair.midpoint!.candidates[0].returnedR2Score).toBe(0.5);
        expect(pair.control!.team).toBe(pair.midpoint!.team);
        expect(phase(pair.control!.lap)).toBe(phase(pair.midpoint!.lap));
        expect(selectMidpointActualContinuationPair([...positions].reverse(), board, 8321)).toEqual(pair);
        const relabeled = positions.map((entry) => ({ ...entry, winner: entry.ordinal % 2 ? "green" : "red" }));
        const repeated = selectMidpointActualContinuationPair(relabeled, board, 8321);
        expect(repeated.control?.ordinal).toBe(pair.control?.ordinal);
        expect(repeated.midpoint?.ordinal).toBe(pair.midpoint?.ordinal);
    }
});

test("absent midpoint positions fall back to the unchanged sampler without dropping a family", () => {
    const positions = [position(1, 0), position(2, 1, RED_TEAM, 4)];
    for (let board = 0; board < 12; board++) {
        const pair = selectMidpointActualContinuationPair(positions, board, 8321);
        expect(pair.midpointAvailable).toBe(false);
        expect(pair.control).toBe(selectActualContinuationPosition(positions, board, 8321));
        expect(pair.midpoint).toBe(pair.control);
        expect(pair.midpointPositions).toBe(0);
    }
    expect(selectMidpointActualContinuationPair([], 0, 8321)).toEqual({
        control: null,
        midpoint: null,
        midpointAvailable: false,
        eligiblePositions: 0,
        midpointPositions: 0,
    });
});

test("only the selected action's finite midpoint score and distinct scored alternatives qualify", () => {
    const alternativeOnly = position(0, 1);
    alternativeOnly.candidates[1].returnedR2Score = 0.5;
    const duplicate = position(1, 0.5);
    duplicate.candidates[1].signature = "baseline";
    const unscored = position(2, 0.5);
    unscored.candidates[1].returnedR2Score = null;
    const pair = selectMidpointActualContinuationPair(
        [alternativeOnly, duplicate, unscored, position(3, null), position(4, NaN), position(5, 0.5)],
        0,
        8321,
    );
    expect(pair.eligiblePositions).toBe(2);
    expect(pair.midpointPositions).toBe(1);
    expect(pair.midpoint?.ordinal).toBe(5);
});
