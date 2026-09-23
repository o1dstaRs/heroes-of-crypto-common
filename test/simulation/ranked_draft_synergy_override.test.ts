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
    parseRankedDraftSynergyOverride,
    playRankedDraftGame,
    rankedDraftCurrentIncumbent,
    summarizeRankedDraftRecords,
    type IRankedDraftEvaluationOptions,
} from "../../src/simulation/ranked_draft_eval";

const { LIFE, CHAOS, MIGHT, NATURE } = PBTypes.FactionVals;

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
const opponent = { ...candidate, id: "synergy-control" };

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

describe("ranked draft candidate synergy override", () => {
    const base = {
        gamesPerOpponent: 16,
        baseSeed: 91_900_000,
        mapTypes: [PBTypes.GridVals.NORMAL],
        recordArmies: true,
    };

    it("parses faction names and rejects anything the fight cannot apply", () => {
        expect(parseRankedDraftSynergyOverride("NATURE:1")).toEqual({ [NATURE]: 1 });
        expect(parseRankedDraftSynergyOverride(" nature:2, chaos:1 ")).toEqual({ [NATURE]: 2, [CHAOS]: 1 });
        for (const bad of ["NATURE:3", "NATURE:0", "DEATH:1", "HORSES:1", "", "NATURE"]) {
            expect(() => parseRankedDraftSynergyOverride(bad)).toThrow();
        }
    });

    it("changes only the overridden faction's option on the candidate, where its army qualifies", () => {
        const plain = playPanel(base);
        const forced = playPanel({ ...base, candidateSynergyOverride: { [NATURE]: 1, [LIFE]: 2 } });
        let applied = 0;
        for (let game = 0; game < plain.length; game += 1) {
            const { synergies, ...rest } = forced[game].candidate;
            const { synergies: plainSynergies, ...plainRest } = plain[game].candidate;
            expect(rest).toEqual(plainRest);
            expect(forced[game].opponent).toEqual(plain[game].opponent);
            expect(synergies.map((entry) => entry.faction)).toEqual(plainSynergies.map((entry) => entry.faction));
            for (let index = 0; index < synergies.length; index += 1) {
                const { faction } = synergies[index];
                const expected =
                    faction === NATURE ? 1 : faction === LIFE ? 2 : (plainSynergies[index].synergy as number);
                expect(synergies[index].synergy).toBe(expected);
                if (expected !== plainSynergies[index].synergy) applied += 1;
            }
            expect(forced[game].record.armies!.candidate.synergies).toEqual(synergies);
            expect(forced[game].record.armies!.candidate.policySynergies).toEqual(plainSynergies);
            expect(plain[game].record.armies!.candidate).not.toHaveProperty("synergies");
        }
        expect(applied).toBeGreaterThan(0);
        expect(plain.some((game) => game.candidate.synergies.some((entry) => entry.faction === MIGHT))).toBe(true);
    });

    it("names the override in the report only when it is set", () => {
        const summarize = (options: IRankedDraftEvaluationOptions) =>
            summarizeRankedDraftRecords(
                candidate,
                [opponent],
                options,
                playPanel(options).map((game) => game.record),
            ).options;
        expect(summarize(base)).not.toHaveProperty("candidateSynergyOverride");
        expect(summarize({ ...base, candidateSynergyOverride: { [CHAOS]: 2 } })).toMatchObject({
            candidateSynergyOverride: { [CHAOS]: 2 },
        });
        expect(() =>
            playRankedDraftGame(candidate, opponent, { ...base, candidateSynergyOverride: { [MIGHT]: 5 } }, 0),
        ).toThrow("synergy override");
    });
});
