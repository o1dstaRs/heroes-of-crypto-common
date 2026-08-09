/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { conditionalArtifactT2, parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import { RANKED_A19_CASTER_EMPOWER_SETUP_SPEC, V07_NONFIGHT_SETUP_SPEC } from "../../src/ai/setup/setup_ship";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_LAYOUT,
    RANKED_SPELL_RANGED_DRAFT_POLICY_ID,
} from "../../src/simulation/league_genome";
import { RANKED_DRAFT_INTERACTION_PRIOR_ID } from "../../src/ai/setup/draft_interaction_prior";
import { RANKED_DRAFT_VARIETY_POLICY_ID } from "../../src/ai/setup/draft_variety";
import {
    normalizeRankedDraftGenome,
    permuteRankedDraftSeed,
    playRankedDraftGame,
    classifyRankedDraftCohorts,
    rankedDraftBehaviorTraceSha256,
    RANKED_DRAFT_COHORT_DEFINITIONS,
    rankedDraftCurrentIncumbent,
    rankedDraftA19CasterReplayCandidate,
    rankedDraftInteractionPriorCandidate,
    rankedDraftVersatileCandidate,
    evaluateRankedDraftTasks,
    inspectRankedDraftBoard,
    resolveRankedDraftPick,
    summarizeRankedDraftRecords,
} from "../../src/simulation/ranked_draft_eval";

const fakeMatch = (winner: "green" | "red" | "draw", config: IMatchConfig): IMatchResult =>
    ({
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner,
        endReason: winner === "draw" ? "turn_cap" : "elimination",
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

describe("exact ranked draft evaluator", () => {
    it("uses inclusive one-carrier definitions for every named roster cohort", () => {
        const creatureIds = Object.values(PBTypes.CreatureVals).filter(
            (value): value is number => typeof value === "number" && value > 0,
        );
        const ranged = creatureIds.find((creatureId) => creatureInfo(creatureId)?.ranged);
        const aura = creatureIds.find((creatureId) => (creatureInfo(creatureId)?.auraCount ?? 0) > 0);
        if (ranged === undefined || aura === undefined) throw new Error("Test catalog omitted a named cohort carrier");
        expect(classifyRankedDraftCohorts([ranged])).toContain("ranged");
        expect(classifyRankedDraftCohorts([aura])).toContain("aura_heavy");
        expect(RANKED_DRAFT_COHORT_DEFINITIONS.ranged).toContain("at least one");
        expect(RANKED_DRAFT_COHORT_DEFINITIONS.aura_heavy).toContain("at least one");
    });

    it("canonical behavior digests cover executed actions", () => {
        const config: IMatchConfig = {
            greenVersion: "v0.7",
            redVersion: "v0.7",
            roster: [],
            seed: 77,
            gridType: PBTypes.GridVals.NORMAL,
        };
        const baseline = fakeMatch("green", config);
        const withAction = structuredClone(baseline);
        withAction.actions.push({
            index: 0,
            lap: 1,
            side: "green",
            unitId: "u1",
            creatureName: "Unit",
            fromCell: { x: 0, y: 0 },
            actionType: "wait_turn",
            completed: true,
        });
        withAction.totalActions = 1;
        expect(rankedDraftBehaviorTraceSha256(baseline)).toMatch(/^[0-9a-f]{64}$/);
        expect(rankedDraftBehaviorTraceSha256(withAction)).not.toBe(rankedDraftBehaviorTraceSha256(baseline));
    });
    it("projects every candidate to the 15 deployable intrinsic dimensions", () => {
        const incumbent = rankedDraftCurrentIncumbent();
        const changed = {
            ...incumbent,
            weights: incumbent.weights.map((weight, index) =>
                index < LEAGUE_GENOME_LAYOUT.draftIntrinsic.length ? weight + index : 100_000 + index,
            ),
        };
        const projected = normalizeRankedDraftGenome(changed);
        expect(projected.weights.slice(0, LEAGUE_GENOME_LAYOUT.draftIntrinsic.length)).toEqual(
            changed.weights.slice(0, LEAGUE_GENOME_LAYOUT.draftIntrinsic.length),
        );
        expect(projected.weights.slice(LEAGUE_GENOME_LAYOUT.draftIntrinsic.length)).toEqual(
            LEAGUE_ANCHOR_GENOME.slice(LEAGUE_GENOME_LAYOUT.draftIntrinsic.length),
        );
    });

    it("preserves opt-in interaction and variety metadata through ranked normalization", () => {
        const incumbent = rankedDraftCurrentIncumbent();
        const casterReplayCandidate = rankedDraftA19CasterReplayCandidate();
        const interactionCandidate = rankedDraftInteractionPriorCandidate();
        const versatileCandidate = rankedDraftVersatileCandidate();
        const interactionNormalized = normalizeRankedDraftGenome(interactionCandidate);
        const versatileNormalized = normalizeRankedDraftGenome(versatileCandidate);
        const casterReplayNormalized = normalizeRankedDraftGenome(casterReplayCandidate);
        expect(interactionCandidate.weights).toEqual(incumbent.weights);
        expect(interactionNormalized.draftInteractionPrior).toBe(RANKED_DRAFT_INTERACTION_PRIOR_ID);
        expect(interactionNormalized.weights).toEqual(incumbent.weights);
        expect(versatileNormalized.draftInteractionPrior).toBe(RANKED_DRAFT_INTERACTION_PRIOR_ID);
        expect(versatileNormalized.draftVarietyPolicy).toBe(RANKED_DRAFT_VARIETY_POLICY_ID);
        expect(versatileNormalized.weights).toEqual(incumbent.weights);
        expect(casterReplayNormalized.draftSpellRangedPolicy).toBe(RANKED_SPELL_RANGED_DRAFT_POLICY_ID);
        expect(casterReplayNormalized.weights).toEqual(incumbent.weights);
        expect(incumbent.draftInteractionPrior).toBeUndefined();
        expect(incumbent.draftVarietyPolicy).toBeUndefined();
    });

    it("uses a collision-free uint32 seed permutation", () => {
        const values = Array.from({ length: 100_000 }, (_, index) => permuteRankedDraftSeed(91_000_000 + index));
        expect(new Set(values).size).toBe(values.length);
        expect(values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)).toBeTrue();
    });

    it("selects conditional Tier-2 at live phase 8 from five creatures", () => {
        const incumbent = rankedDraftCurrentIncumbent();
        const rules = parseConditionalRules("all");
        let witnessedConditionalOverride = false;
        for (let seed = 0; seed < 100; seed += 1) {
            const state = resolveRankedDraftPick(seed, incumbent, incumbent);
            for (const team of [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER] as const) {
                const own = team === PBTypes.TeamVals.LOWER ? state.lower : state.upper;
                const bundle = state.transcript.find(
                    (entry) => entry.type === "bundle_selected" && entry.team === team,
                );
                const selected = state.transcript.find(
                    (entry) => entry.type === "tier2_selected" && entry.team === team,
                );
                if (bundle?.type !== "bundle_selected" || selected?.type !== "tier2_selected") {
                    throw new Error("Complete pick omitted bundle or Tier-2 transcript evidence");
                }
                const creaturesAtT2 = [
                    ...bundle.creatures,
                    ...state.transcript
                        .filter(
                            (entry) => entry.type === "creature_picked" && entry.team === team && entry.phaseBefore < 8,
                        )
                        .map((entry) => (entry.type === "creature_picked" ? entry.creatureId : 0)),
                ];
                expect(selected.phaseBefore).toBe(8);
                expect(creaturesAtT2).toHaveLength(5);
                expect(selected.artifactId).toBe(conditionalArtifactT2(own.tier2Offers, creaturesAtT2, rules));
                if (selected.artifactId !== SETUP_POLICY_V0.pickArtifactT2(own.tier2Offers)) {
                    witnessedConditionalOverride = true;
                }
            }
        }
        expect(witnessedConditionalOverride).toBeTrue();
    });

    it("uses opposite draft seats, exact battle mirrors, and one common battle seed per board", () => {
        const candidate = rankedDraftCurrentIncumbent();
        const opponent = { ...candidate, id: "same-policy-control" };
        const configs: IMatchConfig[] = [];
        const records = Array.from({ length: 4 }, (_, game) =>
            playRankedDraftGame(
                candidate,
                opponent,
                { gamesPerOpponent: 8, baseSeed: 91_100_000, mapTypes: [PBTypes.GridVals.NORMAL] },
                game,
                0,
                {
                    matchRunner: (config) => {
                        configs.push(structuredClone(config));
                        return fakeMatch("green", config);
                    },
                },
            ),
        );
        expect(records.map((record) => record.pickSeat)).toEqual([
            "candidate-lower",
            "candidate-lower",
            "candidate-upper",
            "candidate-upper",
        ]);
        expect(new Set(records.map((record) => record.battleSeed)).size).toBe(1);
        expect(records.map((record) => record.candidateResult)).toEqual(["win", "loss", "loss", "win"]);
        expect(records.every((record) => /^[0-9a-f]{64}$/.test(record.behaviorTraceSha256))).toBeTrue();
        const firstRedRoster = configs[0].redRoster;
        const thirdRedRoster = configs[2].redRoster;
        if (!firstRedRoster || !thirdRedRoster) throw new Error("Mirrored config omitted an opposing roster");
        expect(configs[1].roster).toEqual(firstRedRoster);
        expect(configs[1].redRoster).toEqual(configs[0].roster);
        expect(configs[3].roster).toEqual(thirdRedRoster);
        expect(configs[3].redRoster).toEqual(configs[2].roster);
    });

    it("routes the caster setup candidate through only eligible ranked rosters", () => {
        const candidate = rankedDraftA19CasterReplayCandidate();
        const opponent = { ...rankedDraftCurrentIncumbent(), id: "caster-setup-control" };
        const configs: IMatchConfig[] = [];
        const options = {
            // Board 847 is a deterministic Magic Dragon + Satyr candidate roster. Pin the real draft fixture
            // rather than assuming a small random panel contains one of these intentionally rare combinations.
            gamesPerOpponent: 3_392,
            baseSeed: 91_150_000,
            mapTypes: [PBTypes.GridVals.NORMAL],
            candidateSetupPolicySpec: RANKED_A19_CASTER_EMPOWER_SETUP_SPEC,
            opponentSetupPolicySpec: V07_NONFIGHT_SETUP_SPEC,
        };
        const record = playRankedDraftGame(candidate, opponent, options, 847 * 4, 0, {
            matchRunner: (config) => {
                configs.push(structuredClone(config));
                return fakeMatch("green", config);
            },
        });

        expect(record.pickSeat).toBe("candidate-lower");
        expect(configs).toHaveLength(1);
        expect(configs.some((config) => config.greenAugments?.some((augment) => augment.kind === "Empower"))).toBe(
            true,
        );
        expect(configs.every((config) => config.redAugments?.every((augment) => augment.kind !== "Empower"))).toBe(
            true,
        );
    });

    it("validates clustered record integrity and keeps self-play exactly symmetric", () => {
        const candidate = rankedDraftCurrentIncumbent();
        const opponent = { ...candidate, id: "same-policy-control" };
        const options = { gamesPerOpponent: 8, baseSeed: 91_200_000, mapTypes: [PBTypes.GridVals.NORMAL] };
        const records = Array.from({ length: 8 }, (_, game) =>
            playRankedDraftGame(candidate, opponent, options, game, 0, {
                matchRunner: (config) => fakeMatch("green", config),
            }),
        );
        const report = summarizeRankedDraftRecords(candidate, [opponent], options, records);
        expect(report.opponents[0]).toMatchObject({ wins: 4, losses: 4, draws: 0, decisiveWinRate: 0.5 });
        expect(report.aggregate.rejectedCandidate).toBe(0);
        expect(report.aggregate.avgLaps).toBe(7);
        expect(report.aggregate.endReasons).toEqual({ elimination: 8, turn_cap: 0, stuck: 0 });
        expect(report.aggregate.behaviorTraceSetSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(report.options.executedActionsRecorded).toBeTrue();
        expect(report.cohortDefinitions).toEqual(RANKED_DRAFT_COHORT_DEFINITIONS);
        expect(report.maps[0]).toMatchObject({
            mapType: PBTypes.GridVals.NORMAL,
            games: 8,
            wins: 4,
            losses: 4,
            rejectedCandidate: 0,
            avgLaps: 7,
            endReasons: { elimination: 8, turn_cap: 0, stuck: 0 },
        });

        const corrupted = records.map((record) => ({ ...record }));
        corrupted[1].battleSeed ^= 1;
        expect(() => summarizeRankedDraftRecords(candidate, [opponent], options, corrupted)).toThrow(
            "paired-mirror integrity",
        );
    });

    it("runs sparse targeted tasks on a dedicated seed lane through one worker protocol", async () => {
        const candidate = rankedDraftCurrentIncumbent();
        const opponent = { ...candidate, id: "target-control" };
        const options = { gamesPerOpponent: 8, baseSeed: 91_300_000, concurrency: 2, mapTypes: [1] };
        const inspection = inspectRankedDraftBoard(candidate, opponent, options, 1, 3);
        expect(inspection.assignments).toHaveLength(2);
        const records = await evaluateRankedDraftTasks(
            candidate,
            [opponent],
            options,
            [0, 1, 2, 3].map((offset) => ({ opponentIndex: 0, seedLaneIndex: 3, game: 4 + offset })),
        );
        expect(records).toHaveLength(4);
        expect(new Set(records.map((record) => record.pairSeed))).toEqual(new Set([inspection.pairSeed]));
        expect(new Set(records.map((record) => record.battleSeed)).size).toBe(1);
        expect(records.every((record) => record.endReason.length > 0)).toBeTrue();
        expect(records.every((record) => /^[0-9a-f]{64}$/.test(record.behaviorTraceSha256))).toBeTrue();
    });

    it("rejects WATER from exact ranked panels", () => {
        const candidate = rankedDraftCurrentIncumbent();
        expect(() =>
            playRankedDraftGame(
                candidate,
                { ...candidate, id: "water-control" },
                { gamesPerOpponent: 8, baseSeed: 91_400_000, mapTypes: [PBTypes.GridVals.WATER_CENTER] },
                0,
            ),
        ).toThrow("WATER (2) is not live");
    });
});
