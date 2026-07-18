import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    collectPublicRosterPlacementBoards,
    pairedPublicRosterPlacementDelta,
    publicRosterPlacementBoard,
    publicRosterPlacementContext,
    publicRosterPlacementRosterTargets,
    type IPublicRosterPlacementRecord,
} from "../../src/simulation/measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "../../src/simulation/optimizer/v0_7_setup_overnight_core";

const C = PBTypes.CreatureVals;

describe("public-roster placement measurement", () => {
    test("control preserves the shipped legitimate-reveal context", () => {
        const context = publicRosterPlacementContext(
            "control",
            [C.ARBALESTER, C.SQUIRE],
            [C.GRIFFIN, C.BLACK_DRAGON],
            [C.GRIFFIN],
        );
        expect(context.placementPolicy).toBe("legitimate-reveal");
        expect(context.publicOpponentCreatureIds).toBeUndefined();
        expect(context.revealedOpponentCreatureIds).toEqual([C.GRIFFIN]);
        expect(context.actionable).toBe(false);
    });

    test("flyer arm adds only missing public flyers and triggers the screen", () => {
        const context = publicRosterPlacementContext(
            "flyers",
            [C.ARBALESTER, C.SQUIRE],
            [C.GRIFFIN, C.BLACK_DRAGON, C.WOLF_RIDER],
            [C.GRIFFIN, C.WOLF_RIDER],
        );
        expect(context.placementPolicy).toBe("public-roster");
        expect(context.addedPublicCreatureIds).toEqual([C.BLACK_DRAGON]);
        expect(context.publicOpponentCreatureIds).toEqual([C.GRIFFIN, C.WOLF_RIDER, C.BLACK_DRAGON]);
        expect(context.incumbentAction).toBe("corner-shift");
        expect(context.candidateAction).toBe("flyer-screen");
        expect(context.actionable).toBe(true);
    });

    test("charger arm preserves legitimate flyers and adds only public chargers", () => {
        const context = publicRosterPlacementContext(
            "chargers",
            [C.ARBALESTER, C.SQUIRE],
            [C.GRIFFIN, C.WOLF_RIDER, C.NOMAD],
            [C.GRIFFIN],
        );
        expect(context.addedPublicCreatureIds).toEqual([C.WOLF_RIDER, C.NOMAD]);
        expect(context.publicOpponentCreatureIds).toEqual([C.GRIFFIN, C.WOLF_RIDER, C.NOMAD]);
        expect(context.incumbentAction).toBe("unchanged");
        expect(context.candidateAction).toBe("corner-shift");
        expect(context.actionable).toBe(true);
    });

    test("splash precedence makes public flyer/charger additions a no-op", () => {
        const context = publicRosterPlacementContext(
            "both",
            [C.ARBALESTER, C.SQUIRE],
            [C.GARGANTUAN, C.GRIFFIN, C.BLACK_DRAGON, C.WOLF_RIDER, C.PIKEMAN],
            [],
        );
        expect(context.addedPublicCreatureIds).toEqual([
            C.GARGANTUAN,
            C.GRIFFIN,
            C.BLACK_DRAGON,
            C.WOLF_RIDER,
            C.PIKEMAN,
        ]);
        expect(context.publicOpponentCreatureIds).toEqual([
            C.GARGANTUAN,
            C.GRIFFIN,
            C.BLACK_DRAGON,
            C.WOLF_RIDER,
            C.PIKEMAN,
        ]);
        expect(context.candidateAction).toBe("unchanged");
        expect(context.actionable).toBe(false);
    });

    test("board allocator uses three deterministic, disjoint panel channels", () => {
        const first = publicRosterPlacementBoard(97071710, "train", 0);
        const replay = publicRosterPlacementBoard(97071710, "train", 0);
        const second = publicRosterPlacementBoard(97071710, "train", 1);
        expect(first).toEqual(replay);
        expect(new Set([first.pairSeed, first.pickSeed, first.battleSeed])).toHaveLength(3);
        expect([first.pairSeed, first.pickSeed, first.battleSeed]).not.toContain(second.pairSeed);
        expect(first.gridType).toBe(SETUP_LIVE_GRID_TYPES[first.battleSeed % SETUP_LIVE_GRID_TYPES.length]);
        const natural = collectPublicRosterPlacementBoards(97071710, "train", 2, "natural");
        expect(natural.boards).toEqual([first, second]);
        expect(natural.scannedBoards).toBe(2);
    });

    test("roster evidence uses inclusive diagnostic tags while melee-other stays exact", () => {
        expect(publicRosterPlacementRosterTargets([C.ARBALESTER, C.SATYR, C.ANGEL, C.ANGEL])).toEqual([
            "natural",
            "ranged",
            "mage",
            "melee-magic",
            "aura-heavy",
        ]);
        expect(publicRosterPlacementRosterTargets([C.SQUIRE])).toEqual(["natural", "melee-other"]);
    });

    test("matched-control delta compares the same selected game slice", () => {
        const record = (pairSeed: number, game: number, result: "win" | "loss"): IPublicRosterPlacementRecord => ({
            arm: "both",
            boardIndex: pairSeed,
            game,
            pairSeed,
            pickSeed: pairSeed + 10,
            battleSeed: pairSeed + 20,
            gridType: PBTypes.GridVals.NORMAL,
            pickSeat: game < 2 ? "candidate-lower" : "candidate-upper",
            battleMirror: (game % 2) as 0 | 1,
            candidateSide: game % 2 ? "red" : "green",
            candidateResult: result,
            candidateCohort: "mage",
            opponentCohort: "melee-magic",
            incumbentAction: "unchanged",
            candidateAction: "corner-shift",
            actionable: true,
            legitimateRevealCount: 0,
            addedPublicCount: 1,
            candidateRejections: 0,
            baselineRejections: 0,
            laps: 1,
            endReason: "elimination",
            decidedByArmageddon: false,
            setupFingerprint: "a".repeat(64),
            behaviorTraceSha256: "b".repeat(64),
        });
        const control = [record(1, 0, "loss"), record(2, 0, "loss")].map((value) => ({
            ...value,
            arm: "control" as const,
        }));
        const candidate = [record(1, 0, "win"), record(2, 0, "loss")];
        const delta = pairedPublicRosterPlacementDelta(candidate, control);
        expect(delta.scoreGainPp).toBe(50);
        expect(delta.outcomeChanges).toBe(1);
        expect(delta.clusteredSePp).not.toBeNull();
    });
});
