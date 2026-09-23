/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { LIVE_TIER2_ARTIFACT_IDS } from "../../src/picks/pick_sim";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    playRankedDraftGame,
    rankedDraftCurrentIncumbent,
    summarizeRankedDraftRecords,
    type IRankedDraftEvaluationOptions,
} from "../../src/simulation/ranked_draft_eval";

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

const candidate = rankedDraftCurrentIncumbent();
const opponent = { ...candidate, id: "tier2-control" };

/** Each game's record plus the candidate's and opponent's fight config (roster, augments, artifacts). */
const playPanel = (options: IRankedDraftEvaluationOptions) =>
    Array.from({ length: options.gamesPerOpponent }, (_, game) => {
        let config: IMatchConfig | undefined;
        const record = playRankedDraftGame(candidate, opponent, options, game, 0, {
            matchRunner: (matchConfig) => {
                config = matchConfig;
                return fakeMatch(matchConfig);
            },
        });
        const green = record.candidateSide === "green";
        return {
            record,
            candidate: {
                roster: green ? config!.roster : config!.redRoster,
                augments: green ? config!.greenAugments : config!.redAugments,
                tier2: green ? config!.greenArtifactT2 : config!.redArtifactT2,
            },
            opponent: {
                roster: green ? config!.redRoster : config!.roster,
                augments: green ? config!.redAugments : config!.greenAugments,
                tier2: green ? config!.redArtifactT2 : config!.greenArtifactT2,
            },
        };
    });

describe("ranked draft candidate Tier-2 override", () => {
    const base = { gamesPerOpponent: 8, baseSeed: 91_800_000, mapTypes: [PBTypes.GridVals.NORMAL], recordArmies: true };

    it("replaces only the candidate's Tier-2 artifact and leaves both drafted armies as they were", () => {
        const plain = playPanel(base);
        const forced = playPanel({ ...base, candidateTier2Override: Tier2Artifact.ARCHMAGES_RING });
        for (let game = 0; game < plain.length; game += 1) {
            expect(forced[game].candidate.tier2).toBe(Tier2Artifact.ARCHMAGES_RING);
            expect(forced[game].candidate.roster).toEqual(plain[game].candidate.roster);
            expect(forced[game].candidate.augments).toEqual(plain[game].candidate.augments);
            expect(forced[game].opponent).toEqual(plain[game].opponent);
            const policyTier2 = plain[game].candidate.tier2!;
            const offers = forced[game].record.armies!.candidate.tier2Offers!;
            expect(offers).toHaveLength(3);
            expect(offers).toContain(policyTier2);
            expect(forced[game].record.armies).toEqual({
                candidate: {
                    ...plain[game].record.armies!.candidate,
                    tier2Artifact: Tier2Artifact.ARCHMAGES_RING,
                    tier2Offers: offers,
                    policyTier2Artifact: policyTier2,
                },
                opponent: plain[game].record.armies!.opponent,
            });
            expect(plain[game].record.armies!.candidate).not.toHaveProperty("tier2Offers");
        }
    });

    it("names the override in the report only when it is set, and accepts only live Tier-2 ids", () => {
        const summarize = (options: IRankedDraftEvaluationOptions) =>
            summarizeRankedDraftRecords(
                candidate,
                [opponent],
                options,
                playPanel(options).map((game) => game.record),
            ).options;
        expect(summarize(base)).not.toHaveProperty("candidateTier2Override");
        expect(summarize({ ...base, candidateTier2Override: Tier2Artifact.TOME_OF_AMPLIFICATION })).toMatchObject({
            candidateTier2Override: Tier2Artifact.TOME_OF_AMPLIFICATION,
        });
        expect(LIVE_TIER2_ARTIFACT_IDS).not.toContain(Tier2Artifact.HOLY_CROSS);
        for (const invalid of [Tier2Artifact.HOLY_CROSS, 0, 99]) {
            expect(() =>
                playRankedDraftGame(candidate, opponent, { ...base, candidateTier2Override: invalid }, 0),
            ).toThrow("candidateTier2Override");
        }
    });
});
