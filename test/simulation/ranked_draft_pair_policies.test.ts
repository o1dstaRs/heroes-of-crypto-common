import { expect, test } from "bun:test";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    type IRankedDraftResearchChoices,
} from "../../src/simulation/ranked_draft_eval";

const genome = rankedDraftStrengthCandidate("ranked-unit-strength-a19-side-v4-w16-r4");
const options = {
    gamesPerOpponent: 8,
    baseSeed: 31773291,
    mapTypes: [1],
    fightProfile: "a19" as const,
    liveDraftRules: true,
    sideBoard: true,
    liveSynergyVariants: true,
    candidateDoctrinePolicy: "see-all" as const,
    opponentDoctrinePolicy: "see-none" as const,
};
const skippedFight = (config: IMatchConfig): IMatchResult => ({
    seed: config.seed!,
    gridType: config.gridType!,
    winner: "draw",
    endReason: "turn_cap",
    laps: 0,
    totalActions: 0,
    roster: config.roster,
    redRoster: config.redRoster,
    placements: { green: [], red: [] },
    actions: [],
    outcome: {
        green: { version: config.greenVersion, unitsAlive: 0, creaturesAlive: 0, hpRemaining: 0 },
        red: { version: config.redVersion, unitsAlive: 0, creaturesAlive: 0, hpRemaining: 0 },
    },
    attrition: {
        reachedArmageddon: false,
        armageddonWaves: 0,
        unitsKilledByArmageddon: 0,
        unitsKilledByNarrowing: 0,
        decidedByArmageddon: false,
    },
});

test("both research draft seats retain their own public information through physical and draft mirrors", () => {
    for (let game = 0; game < 4; game++) {
        const expected = playRankedDraftGame(genome, genome, options, game, 0, {
            liveSequentialBundles: true,
            matchRunner: skippedFight,
        });
        const calls = { candidate: 0, opponent: 0 };
        const choice = (role: "candidate" | "opponent"): IRankedDraftResearchChoices => ({
            bundle: (_available, context, preferred) => {
                calls[role]++;
                expect(context.ownCreatureIds).toEqual([]);
                expect(context.scouting.map).toBe(role === "candidate" ? 1 : undefined);
                return preferred;
            },
        });
        const actual = playRankedDraftGame(genome, genome, options, game, 0, {
            liveSequentialBundles: true,
            researchCandidateDraftChoices: choice("candidate"),
            researchOpponentDraftChoices: choice("opponent"),
            matchRunner: skippedFight,
        });
        expect(calls).toEqual({ candidate: 1, opponent: 1 });
        expect(actual).toEqual(expected);
    }
});

test("an opponent-only policy runs and remains restricted to legal public choices", () => {
    for (let game = 0; game < 4; game++) {
        expect(() =>
            playRankedDraftGame(genome, genome, options, game, 0, {
                researchOpponentDraftChoices: { bundle: (available) => available.length },
                matchRunner: skippedFight,
            }),
        ).toThrow();
    }
});
