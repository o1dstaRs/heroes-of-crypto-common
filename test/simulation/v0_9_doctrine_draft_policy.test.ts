import { describe, expect, test } from "bun:test";

import { isRankedDraftStrengthPolicy } from "../../src/ai/setup/draft_strength_prior";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    permuteRankedDraftSeed,
    type IRankedDraftResearchContext,
} from "../../src/simulation/ranked_draft_eval";
import { createLockedDoctrineDraftResearchChoices } from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import type { ScoutingDoctrine } from "../../src/simulation/v0_9/doctrine_draft_model";
import type { IDoctrineDraftResearchDecision } from "../../src/simulation/v0_9/doctrine_draft_policy";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import { synergyVariantsForSeed } from "../../src/synergies/synergy_properties";
import fixture from "./fixtures/doctrine_draft_v3_replay.json";

if (!isRankedDraftStrengthPolicy(fixture.draft)) throw new Error("Unknown historical draft policy");
const genome = rankedDraftStrengthCandidate(fixture.draft);

// These tests compare recorded drafts and setups, without simulating or asserting battle outcomes.
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

describe("reusable locked doctrine draft policy", () => {
    test("reproduces historical setups, decisions and collision counts across doctrines and seats", () => {
        expect(fixture.rows).toHaveLength(49);
        for (const row of fixture.rows) {
            const decisions: IDoctrineDraftResearchDecision[] = [];
            const record = playRankedDraftGame(
                genome,
                genome,
                {
                    gamesPerOpponent: 8,
                    baseSeed: row.seed,
                    mapTypes: [row.map],
                    fightProfile: "a19",
                    maxLaps: 256,
                    liveDraftRules: true,
                    sideBoard: true,
                    deterministicSearch: true,
                    liveSynergyVariants: true,
                    tacticalSplits: true,
                    candidateSetupPolicySpec: fixture.setup,
                    opponentSetupPolicySpec: fixture.setup,
                    candidateDoctrinePolicy: row.candidateDoctrinePolicy as ScoutingDoctrine,
                    opponentDoctrinePolicy: row.opponentDoctrinePolicy as ScoutingDoctrine,
                },
                row.game,
                0,
                {
                    researchCandidateDraftChoices: createLockedDoctrineDraftResearchChoices({
                        genome,
                        doctrine: row.candidateDoctrinePolicy as ScoutingDoctrine,
                        synergyVariants: synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(row.seed + 1)}`),
                        maskAdvanceInformation: row.condition === "masked",
                        onDecision: (decision) => decisions.push(decision),
                    }),
                    matchRunner: skippedFight,
                },
            );
            expect(record.setupFingerprint).toBe(row.setupFingerprint);
            expect(record.collisions).toBe(row.collisions);
            expect(fingerprintV09(decisions)).toBe(row.decisionsSha256);
            expect(decisions.filter((decision) => decision.chosen !== decision.preferred).length).toBeLessThanOrEqual(
                1,
            );
            if (row.candidateDoctrinePolicy === "see-none") expect(decisions).toEqual([]);
        }
    });

    test("a collided alternative consumes the override, and the next draft gets its own allowance", () => {
        const { doctrine, synergyVariants, previous, current } = fixture.collisionExample;
        const decisions: IDoctrineDraftResearchDecision[] = [];
        const options = {
            genome,
            doctrine: doctrine as ScoutingDoctrine,
            synergyVariants,
            onDecision: (decision: IDoctrineDraftResearchDecision) => decisions.push(decision),
        };
        const choices = createLockedDoctrineDraftResearchChoices(options);
        const choose = (row: typeof previous | typeof current) =>
            choices.creature!(row.available, row.context as IRankedDraftResearchContext, row.preferred);
        expect(previous.chosen).not.toBe(previous.preferred);
        expect(current.context.ownCreatureIds).toEqual(previous.context.ownCreatureIds);
        expect(current.context.knownOpponentCreatureIds).toContain(previous.chosen);
        expect(current.available).not.toContain(previous.chosen);
        expect(choose(previous)).toBe(previous.chosen);
        expect(choose(current)).toBe(current.preferred);
        expect(choose(previous)).toBe(previous.preferred);
        expect(decisions).toHaveLength(1);
        expect(
            createLockedDoctrineDraftResearchChoices(options).creature!(
                previous.available,
                previous.context as IRankedDraftResearchContext,
                previous.preferred,
            ),
        ).toBe(previous.chosen);
    });
});
