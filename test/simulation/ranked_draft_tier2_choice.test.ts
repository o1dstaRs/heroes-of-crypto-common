import { expect, test } from "bun:test";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    resolveRankedDraftPick,
    type IRankedDraftTier2Decision,
} from "../../src/simulation/ranked_draft_eval";

const genome = rankedDraftStrengthCandidate("ranked-unit-strength-a19-side-v4-w16-r4");
const left = PBTypes.TeamVals.LEFT;
const right = PBTypes.TeamVals.RIGHT;
const setup = "artifact-fit-v6:conditional-v1:sniper+t2a19";

test("an omitted, undefined or identity research choice preserves the complete legal draft", () => {
    for (let seed = 1; seed <= 20; seed++) {
        const base = resolveRankedDraftPick(
            seed,
            genome,
            genome,
            { left: setup, right: setup },
            { liveDraftRules: true },
        );
        for (const choices of [
            undefined,
            { [left]: (_a: readonly number[], _b: readonly number[], _c: unknown, chosen: number) => chosen },
        ]) {
            expect(
                resolveRankedDraftPick(
                    seed,
                    genome,
                    genome,
                    { left: setup, right: setup },
                    {
                        liveDraftRules: true,
                        researchTier2ChoiceByTeam: choices,
                    },
                ),
            ).toEqual(base);
        }
    }
});

test("research sees immutable public five-creature information and only changes the selected seat", () => {
    for (let seed = 1; seed <= 30; seed++) {
        let seen = 0;
        const decisions: IRankedDraftTier2Decision[] = [];
        const base = resolveRankedDraftPick(
            seed,
            genome,
            genome,
            { left: setup, right: setup },
            { liveDraftRules: true },
        );
        const changed = resolveRankedDraftPick(
            seed,
            genome,
            genome,
            { left: setup, right: setup },
            {
                liveDraftRules: true,
                researchTier2ChoiceByTeam: {
                    [left]: (offered, own, context, chosen) => {
                        seen++;
                        expect(own).toHaveLength(5);
                        expect(own).toEqual(base.left.creatures.slice(0, 5));
                        expect(offered).toHaveLength(3);
                        expect(offered).toContain(chosen);
                        expect(Object.isFrozen(offered)).toBe(true);
                        expect(Object.isFrozen(own)).toBe(true);
                        expect(Object.isFrozen(context)).toBe(true);
                        // Even SEE_NONE can learn a creature through a public pick collision.
                        expect(
                            context.publicOpponentCreatureIds.every((id) =>
                                base.right.creatures.slice(0, 5).includes(id),
                            ),
                        ).toBe(true);
                        expect(Object.keys(context).sort()).toEqual(
                            [
                                "decisionPhase",
                                "opponentRosterVisibility",
                                "ownArtifactIds",
                                "ownDoctrine",
                                "publicOpponentCreatureIds",
                            ].sort(),
                        );
                        return offered[2];
                    },
                },
                onTier2Decision: (decision) => decisions.push(decision),
            },
        );
        expect(seen).toBe(1);
        expect(changed.left.tier2Artifact).toBe(changed.left.tier2Offers[2]);
        expect(changed.right.tier2Artifact).toBe(base.right.tier2Artifact);
        expect(changed.left.creatures.slice(0, 5)).toEqual(base.left.creatures.slice(0, 5));
        expect(changed.right.creatures.slice(0, 5)).toEqual(base.right.creatures.slice(0, 5));
        expect(decisions.find((d) => d.team === left)?.policyChosen).toBe(base.left.tier2Artifact);
        expect(decisions.find((d) => d.team === right)).not.toHaveProperty("policyChosen");
    }
});

test("invalid callbacks, teams, legacy rules and non-offered artifacts fail closed", () => {
    for (const rules of [
        { liveDraftRules: false, researchTier2ChoiceByTeam: { [left]: () => 1 } },
        { liveDraftRules: true, researchTier2ChoiceByTeam: { 99: () => 1 } },
        { liveDraftRules: true, researchTier2ChoiceByTeam: { [left]: null } },
        ...[0, 3, 999, NaN, 1.5].map((id) => ({
            liveDraftRules: true,
            researchTier2ChoiceByTeam: { [left]: () => id },
        })),
    ])
        expect(() => resolveRankedDraftPick(1, genome, genome, {}, rules as any)).toThrow();
});

const fakeMatch = (config: IMatchConfig): IMatchResult =>
    ({
        seed: config.seed,
        gridType: config.gridType,
        winner: "draw",
        endReason: "elimination",
        laps: 1,
        totalActions: 0,
        actions: [],
        placements: { green: [], red: [] },
        attrition: { decidedByArmageddon: false },
        rejectedGreen: 0,
        rejectedRed: 0,
    }) as IMatchResult;

test("the real game pipeline scopes research to the candidate across draft assignments and physical mirrors", () => {
    for (let game = 0; game < 24; game++) {
        let calls = 0;
        const options = {
            gamesPerOpponent: 24,
            baseSeed: 2026102449,
            liveDraftRules: true,
            recordArmies: true,
            candidateSetupPolicySpec: setup,
            opponentSetupPolicySpec: setup,
        };
        const baseline = playRankedDraftGame(genome, genome, options, game, 0, { matchRunner: fakeMatch });
        const changed = playRankedDraftGame(genome, genome, options, game, 0, {
            matchRunner: fakeMatch,
            researchCandidateTier2Choice: (offered) => {
                calls++;
                return offered[0];
            },
        });
        expect(calls).toBe(1);
        expect(changed.armies?.candidate.tier2Artifact).toBe(changed.armies?.candidate.tier2Offers?.[0]);
        expect(changed.armies?.candidate.tier2Decision?.ownCreatureIds).toHaveLength(5);
        expect(changed.armies?.candidate.tier2Decision?.policyChosen).toBe(baseline.armies?.candidate.tier2Artifact);
        expect(changed.armies?.opponent.tier2Artifact).toBe(baseline.armies?.opponent.tier2Artifact);
        expect(changed.armies?.opponent.tier2Decision).not.toHaveProperty("policyChosen");
        const identity = playRankedDraftGame(genome, genome, options, game, 0, {
            matchRunner: fakeMatch,
            researchCandidateTier2Choice: (_a, _b, _c, chosen) => chosen,
        });
        expect(identity.setupFingerprint).toBe(baseline.setupFingerprint);
        expect(identity.behaviorTraceSha256).toBe(baseline.behaviorTraceSha256);
    }
    expect(() =>
        playRankedDraftGame(genome, genome, { gamesPerOpponent: 8, baseSeed: 1 }, 0, 0, {
            researchCandidateTier2Choice: () => 1,
        }),
    ).toThrow("live draft rules");
});
