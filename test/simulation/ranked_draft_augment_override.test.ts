/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    parseRankedDraftAugmentOverride,
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
const opponent = { ...candidate, id: "augment-control" };

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
                synergies: (green ? config!.greenSynergies : config!.redSynergies) ?? [],
            },
            opponent: {
                roster: green ? config!.redRoster : config!.roster,
                augments: green ? config!.redAugments : config!.greenAugments,
                synergies: green ? config!.redSynergies : config!.greenSynergies,
            },
        };
    });

describe("ranked draft candidate augment override", () => {
    const base = {
        gamesPerOpponent: 8,
        baseSeed: 91_950_000,
        mapTypes: [PBTypes.GridVals.NORMAL],
        recordArmies: true,
    };
    const plan = [
        { kind: "Sniper", value: 3 },
        { kind: "Armor", value: 3 },
        { kind: "Empower", value: 1 },
    ] as const;

    it("parses augment plans and rejects anything the setup could not spend", () => {
        expect(parseRankedDraftAugmentOverride("Sniper:3, armor:3,EMPOWER:1")).toEqual([...plan]);
        for (const bad of ["Sniper:4", "Sniper:0", "Sniper:3,Sniper:1", "Luck:1", "Sniper:3,Armor:3,Might:2", ""]) {
            expect(() => parseRankedDraftAugmentOverride(bad)).toThrow();
        }
    });

    it("replaces only the candidate's augments and records both plans", () => {
        const plain = playPanel(base);
        const forced = playPanel({ ...base, candidateAugmentsOverride: plan });
        for (let game = 0; game < plain.length; game += 1) {
            const { augments, ...rest } = forced[game].candidate;
            const { augments: plainAugments, ...plainRest } = plain[game].candidate;
            expect(augments).toEqual([...plan]);
            expect(rest).toEqual(plainRest);
            expect(forced[game].opponent).toEqual(plain[game].opponent);
            expect(forced[game].record.armies!.candidate.augments).toEqual([...plan]);
            expect(forced[game].record.armies!.candidate.policyAugments).toEqual(plainAugments);
            expect(plain[game].record.armies!.candidate).not.toHaveProperty("augments");
        }
    });

    it("names the override in the report only when set and refuses a plan above the doctrine's budget", () => {
        const summarize = (options: IRankedDraftEvaluationOptions) =>
            summarizeRankedDraftRecords(
                candidate,
                [opponent],
                options,
                playPanel(options).map((game) => game.record),
            ).options;
        expect(summarize(base)).not.toHaveProperty("candidateAugmentsOverride");
        expect(summarize({ ...base, candidateAugmentsOverride: plan })).toMatchObject({
            candidateAugmentsOverride: [...plan],
        });
        expect(() =>
            playRankedDraftGame(
                candidate,
                opponent,
                { ...base, candidateAugmentsOverride: plan, candidateDoctrinePolicy: "see-all" },
                0,
            ),
        ).toThrow("doctrine allows 5");
    });
});
