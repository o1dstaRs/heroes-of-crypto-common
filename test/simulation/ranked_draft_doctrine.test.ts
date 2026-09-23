/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { pickRankedAIDoctrine } from "../../src/ai/setup/doctrine_variety";
import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { Doctrine, getUpgradePoints } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    playRankedDraftGame,
    rankedDraftCurrentIncumbent,
    RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY,
    resolveRankedDraftDoctrine,
    resolveRankedDraftPick,
    summarizeRankedDraftRecords,
    type IRankedDraftEvaluationOptions,
} from "../../src/simulation/ranked_draft_eval";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

const fakeMatch = (config: IMatchConfig): IMatchResult =>
    ({
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner: "green",
        endReason: "elimination",
        laps: 7,
        totalActions: 0,
        roster: config.roster,
        redRoster: config.redRoster,
        placements: { green: [], red: [] },
        actions: [],
        outcome: {
            green: { version: config.greenVersion, unitsAlive: 1, creaturesAlive: 1, hpRemaining: 10 },
            red: { version: config.redVersion, unitsAlive: 1, creaturesAlive: 1, hpRemaining: 10 },
        },
        attrition: {
            reachedArmageddon: false,
            armageddonWaves: 0,
            unitsKilledByArmageddon: 0,
            unitsKilledByNarrowing: 0,
            decidedByArmageddon: false,
        },
        rejectedGreen: 0,
        rejectedRed: 0,
    }) as IMatchResult;

/** Play every game of a panel: each record, plus the doctrine and augment points each side fought with. */
const playPanel = (options: IRankedDraftEvaluationOptions) => {
    const candidate = rankedDraftCurrentIncumbent();
    const opponent = { ...candidate, id: "doctrine-control" };
    return Array.from({ length: options.gamesPerOpponent }, (_, game) => {
        let config: IMatchConfig | undefined;
        const record = playRankedDraftGame(candidate, opponent, options, game, 0, {
            matchRunner: (matchConfig) => {
                config = matchConfig;
                return fakeMatch(matchConfig);
            },
        });
        const candidateIsGreen = record.candidateSide === "green";
        const points = (augments: IMatchConfig["greenAugments"]): number =>
            (augments ?? []).reduce((sum, augment) => sum + augment.value, 0);
        return {
            record,
            candidateDoctrine: candidateIsGreen ? config!.greenDoctrine : config!.redDoctrine,
            opponentDoctrine: candidateIsGreen ? config!.redDoctrine : config!.greenDoctrine,
            candidatePoints: points(candidateIsGreen ? config!.greenAugments : config!.redAugments),
            opponentPoints: points(candidateIsGreen ? config!.redAugments : config!.greenAugments),
        };
    });
};

describe("ranked draft doctrine policies", () => {
    it("keeps see-none as the default every earlier panel measured", () => {
        expect(RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY).toBe("see-none");
        expect(SETUP_POLICY_V0.pickDoctrine()).toBe(Doctrine.SEE_NONE);
        const options = { gamesPerOpponent: 8, baseSeed: 91_700_000, mapTypes: [PBTypes.GridVals.NORMAL] };
        const implicit = playPanel(options);
        const explicit = playPanel({
            ...options,
            candidateDoctrinePolicy: "see-none",
            opponentDoctrinePolicy: "see-none",
        });
        expect(explicit.map((game) => game.record)).toEqual(implicit.map((game) => game.record));
        for (const game of implicit) {
            expect(game.candidateDoctrine).toBe(Doctrine.SEE_NONE);
            expect(game.opponentDoctrine).toBe(Doctrine.SEE_NONE);
        }
    });

    it("gives each seat its own doctrine, and with it that doctrine's reveals and upgrade budget", () => {
        const games = playPanel({
            gamesPerOpponent: 8,
            baseSeed: 91_710_000,
            mapTypes: [PBTypes.GridVals.NORMAL],
            candidateDoctrinePolicy: "see-all",
        });
        expect(getUpgradePoints(Doctrine.SEE_ALL)).toBe(5);
        expect(getUpgradePoints(Doctrine.SEE_NONE)).toBe(7);
        for (const game of games) {
            expect(game.candidateDoctrine).toBe(Doctrine.SEE_ALL);
            expect(game.opponentDoctrine).toBe(Doctrine.SEE_NONE);
            expect(game.candidatePoints).toBeLessThanOrEqual(5);
            expect(game.opponentPoints).toBeLessThanOrEqual(7);
        }
        const total = (key: "candidatePoints" | "opponentPoints"): number =>
            games.reduce((sum, game) => sum + game[key], 0);
        expect(total("opponentPoints")).toBeGreaterThan(total("candidatePoints"));

        const live = rankedDraftCurrentIncumbent();
        const state = resolveRankedDraftPick(
            91_720_000,
            live,
            live,
            { leftDoctrine: Doctrine.SEE_ALL, rightDoctrine: Doctrine.THREE_REVEALS },
            { liveDraftRules: true },
        );
        expect(state.left.doctrine).toBe(Doctrine.SEE_ALL);
        expect(state.left.revealedOpponentSlots).toEqual([0, 1, 2, 3, 4, 5]);
        expect(state.right.doctrine).toBe(Doctrine.THREE_REVEALS);
        expect(state.right.revealedOpponentSlots.length).toBeGreaterThanOrEqual(3);
    });

    it("draws the live bot's per-match variety from the board's pick seed and the seat", () => {
        const counts = new Map<Doctrine, number>();
        for (let seed = 0; seed < 300; seed += 1) {
            for (const team of [LEFT, RIGHT] as const) {
                const doctrine = resolveRankedDraftDoctrine("ranked-variety", seed, team);
                expect(doctrine).toBe(pickRankedAIDoctrine({ matchId: String(seed), team, aiVersion: "v0.8" }));
                counts.set(doctrine, (counts.get(doctrine) ?? 0) + 1);
            }
        }
        expect([...counts.keys()].sort()).toEqual([Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE]);
        for (const count of counts.values()) expect(count).toBeGreaterThan(150);
        expect(resolveRankedDraftDoctrine("see-none", 1, LEFT)).toBe(Doctrine.SEE_NONE);
        expect(resolveRankedDraftDoctrine("see-all", 1, LEFT)).toBe(Doctrine.SEE_ALL);
        expect(resolveRankedDraftDoctrine("three-reveals", 1, LEFT)).toBe(Doctrine.THREE_REVEALS);
    });

    it("reports doctrine policies only when a seat leaves the default, and rejects unknown ones", () => {
        const candidate = rankedDraftCurrentIncumbent();
        const opponent = { ...candidate, id: "doctrine-control" };
        const base = { gamesPerOpponent: 8, baseSeed: 91_730_000, mapTypes: [PBTypes.GridVals.NORMAL] };
        const summarize = (options: IRankedDraftEvaluationOptions) =>
            summarizeRankedDraftRecords(
                candidate,
                [opponent],
                options,
                playPanel(options).map((game) => game.record),
            ).options;
        expect(summarize(base)).not.toHaveProperty("candidateDoctrinePolicy");
        expect(summarize(base)).not.toHaveProperty("opponentDoctrinePolicy");
        expect(summarize({ ...base, opponentDoctrinePolicy: "ranked-variety" })).toMatchObject({
            candidateDoctrinePolicy: "see-none",
            opponentDoctrinePolicy: "ranked-variety",
        });
        expect(() =>
            playRankedDraftGame(candidate, opponent, { ...base, candidateDoctrinePolicy: "see-some" as never }, 0),
        ).toThrow("doctrine policy");
    });
});
