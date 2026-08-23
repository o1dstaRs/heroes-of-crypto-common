/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { scoreCreatureWeighted } from "../../src/ai/setup/creature_score";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { createPickSimState, getKnownOpponentCreatures, type IPickSimState } from "../../src/picks/pick_sim";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    createLeagueGenome,
    createMeleeLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_DIM,
    LEAGUE_GENOME_KEYS,
    LEAGUE_GENOME_LAYOUT,
    leagueComposition,
    pickLeagueAugments,
    pickLeagueCreature,
    pickLeagueDoctrine,
    pickLeaguePlacement,
    scoreLeagueCreature,
} from "../../src/simulation/league_genome";
import {
    createLeagueCemSigma,
    refitLeagueCemDistribution,
    retainComparableLeagueBest,
    sampleLeagueCemPopulation,
    type ILeagueCemScore,
} from "../../src/simulation/optimizer/cem_league_core";
import {
    clusteredLowerBound,
    defaultLeaguePool,
    evaluateLeagueCandidate,
    evaluateLeagueCandidateSequential,
    playLeagueGame,
    resolveLeaguePick,
    sanitizedLeagueEnvironment,
    summarizeLeagueRecords,
    type ILeagueGameRecord,
} from "../../src/simulation/league_eval";
import { CreatureLevelList } from "../../src/units/unit_properties";

const ENV_KEYS = [
    "LIVETWIN",
    "SIM_NO_ACTIONS",
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "V06_CASTER_ROUTER",
    "V06_AREA_THROW",
    "V06_RIDER_EV",
    "V06_DISPERSE_TEAM",
    "V05_HOURGLASS",
    "V04_FRONTMOVE",
    "CEM_LEAGUE_MEAN",
    "FIGHT_MELEE_ROSTERS",
] as const;
const initialEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const [key, value] of initialEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const creature = (name: string): number =>
    (PBTypes.CreatureVals as unknown as Record<string, number>)[name.toUpperCase().replace(/ /g, "_")];

const levelFourPickState = (
    choices: readonly number[],
    own: readonly number[],
    opponent: readonly number[],
    revealedOpponentSlots: readonly number[] = [],
): IPickSimState => {
    const state = createPickSimState(() => 0);
    state.phaseSequence = 10;
    state.creaturesBanned = CreatureLevelList[4].filter((creatureId) => !choices.includes(creatureId));
    state.lower.creatures = [...own];
    state.upper.creatures = [...opponent];
    state.lower.revealedOpponentSlots = [...revealedOpponentSlots];
    return state;
};

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
    }) as IMatchResult;

describe("B1 full-game league genome", () => {
    it("defines a complete 95-dimensional anchor and preserves the intrinsic draft scorer", () => {
        expect(LEAGUE_ANCHOR_GENOME).toHaveLength(LEAGUE_GENOME_DIM);
        expect(LEAGUE_GENOME_KEYS).toHaveLength(LEAGUE_GENOME_DIM);
        expect(new Set(LEAGUE_GENOME_KEYS).size).toBe(LEAGUE_GENOME_DIM);

        const id = creature("Arbalester");
        expect(scoreLeagueCreature(id, [], [], LEAGUE_ANCHOR_GENOME)).toBe(
            scoreCreatureWeighted(id, LEAGUE_ANCHOR_GENOME),
        );
        expect(createMeleeLeagueGenome().weights.slice(0, 11)).not.toEqual(LEAGUE_ANCHOR_GENOME.slice(0, 11));
    });

    it("can represent role-conditioned own/opponent counter-draft terms", () => {
        const ranged = creature("Arbalester");
        const flyer = creature("Pegasus");
        const ground = creature("Squire");
        expect(leagueComposition([ranged, flyer, ground])).toEqual([1 / 3, 1 / 3, 1 / 3]);

        const weights = [...LEAGUE_ANCHOR_GENOME];
        const rangedOpponentFlyer = LEAGUE_GENOME_LAYOUT.draftInteractions.offset + 4;
        weights[rangedOpponentFlyer] = 500;
        const withoutFlyer = scoreLeagueCreature(ranged, [], [ground], weights);
        const withFlyer = scoreLeagueCreature(ranged, [], [flyer], weights);
        expect(withFlyer - withoutFlyer).toBeCloseTo(500);
        expect(scoreLeagueCreature(ground, [], [flyer], weights)).toBe(
            scoreLeagueCreature(ground, [], [ground], weights),
        );
    });

    it("uses the same protector eligibility gate in league training as live ranked", () => {
        const anchor = {
            ...createLeagueGenome("anchor"),
            backlineProtectorDraftSafety: true,
        };
        const abomination = creature("Abomination");
        const queen = creature("Arachna Queen");
        const champion = creature("Champion");
        const ward = creature("Arbalester");
        const flyer = creature("Manticore");

        expect(
            pickLeagueCreature(levelFourPickState([abomination, champion], [], []), PBTypes.TeamVals.LOWER, anchor),
        ).toBe(champion);
        expect(
            pickLeagueCreature(levelFourPickState([abomination, champion], [ward], []), PBTypes.TeamVals.LOWER, anchor),
        ).toBe(champion);
        expect(
            pickLeagueCreature(
                levelFourPickState([abomination, champion], [ward, creature("Battle Mage")], []),
                PBTypes.TeamVals.LOWER,
                anchor,
            ),
        ).toBe(abomination);
        expect(
            pickLeagueCreature(levelFourPickState([queen, champion], [ward], [flyer]), PBTypes.TeamVals.LOWER, anchor),
        ).toBe(champion);
        expect(
            pickLeagueCreature(
                levelFourPickState([queen, champion], [ward], [flyer], [0]),
                PBTypes.TeamVals.LOWER,
                anchor,
            ),
        ).toBe(queen);
        expect(
            [abomination, queen].includes(
                pickLeagueCreature(levelFourPickState([abomination, queen], [], []), PBTypes.TeamVals.LOWER, anchor),
            ),
        ).toBe(true);
    });

    it("anchors setup at SEE_NONE, Armor3/Might3/Sniper1 and adaptive placement", () => {
        const anchor = createLeagueGenome("anchor");
        expect(pickLeagueDoctrine(anchor)).toBe(Doctrine.SEE_NONE);
        expect(pickLeagueAugments([], [], 7, anchor)).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 3 },
            { kind: "Sniper", value: 1 },
        ]);
        expect(pickLeaguePlacement([], [], anchor)).toBe("adaptive");

        const changed = [...LEAGUE_ANCHOR_GENOME];
        changed[LEAGUE_GENOME_LAYOUT.placement.offset] = -1;
        changed[LEAGUE_GENOME_LAYOUT.doctrines.offset + 1] = 100;
        const alternative = createLeagueGenome("alternative", changed);
        expect(pickLeaguePlacement([], [], alternative)).toBe("tight");
        expect(pickLeagueDoctrine(alternative)).toBe(Doctrine.SEE_NONE);
        expect(pickLeagueDoctrine(alternative, false)).toBe(Doctrine.SEE_ALL);
    });

    it("drives the exact pick reducer deterministically through retries to six-stack setups", () => {
        const anchor = createLeagueGenome("anchor");
        const melee = createMeleeLeagueGenome();
        const first = resolveLeaguePick(777, anchor, melee);
        const second = resolveLeaguePick(777, anchor, melee);
        expect(first).toEqual(second);
        expect(first.state.phaseSequence).toBe(11);
        expect(first.state.lower.creatures).toHaveLength(6);
        expect(first.state.upper.creatures).toHaveLength(6);
        expect(first.state.lower.tier1Artifact).toBeGreaterThan(0);
        expect(first.state.lower.tier2Artifact).toBeGreaterThan(0);
        expect(first.lowerAugments.reduce((sum, augment) => sum + augment.value, 0)).toBe(7);

        const collisionSeed = Array.from({ length: 200 }, (_, seed) => seed).find((seed) =>
            resolveLeaguePick(seed, anchor, melee).state.transcript.some(
                (entry) => entry.type === "creature_collision",
            ),
        );
        expect(collisionSeed).toBeDefined();
        expect(resolveLeaguePick(collisionSeed!, anchor, melee).state.lower.creatures).toHaveLength(6);
    });

    it("wires draft, T2, augment, doctrine and deployable placement heads into a resolved setup", () => {
        const changed = [...LEAGUE_ANCHOR_GENOME];
        changed[2] = 10_000; // prefer ranged draft choices
        changed[4] = -10_000;
        changed.fill(-100, LEAGUE_GENOME_LAYOUT.tier2.offset, LEAGUE_GENOME_LAYOUT.tier2.offset + 12);
        changed[LEAGUE_GENOME_LAYOUT.tier2.offset] = 10_000; // artifact 1 when offered
        changed.fill(
            -100,
            LEAGUE_GENOME_LAYOUT.augments.offset,
            LEAGUE_GENOME_LAYOUT.augments.offset + LEAGUE_GENOME_LAYOUT.augments.length,
        );
        changed.fill(0, LEAGUE_GENOME_LAYOUT.augments.offset + 3 * 7, LEAGUE_GENOME_LAYOUT.augments.offset + 4 * 7);
        changed[LEAGUE_GENOME_LAYOUT.augments.offset + 3 * 7] = 100; // Movement bias
        changed[LEAGUE_GENOME_LAYOUT.placement.offset] = 100;
        changed.fill(-100, LEAGUE_GENOME_LAYOUT.doctrines.offset, LEAGUE_GENOME_LAYOUT.doctrines.offset + 3);
        changed[LEAGUE_GENOME_LAYOUT.doctrines.offset + 1] = 100; // SEE_ALL
        const alternative = createLeagueGenome("wired", changed);
        const anchor = createLeagueGenome("anchor");
        const opponent = createLeagueGenome("opponent");
        const seed = Array.from({ length: 500 }, (_, value) => value).find((value) => {
            const resolved = resolveLeaguePick(value, alternative, opponent, false);
            return resolved.state.lower.tier2Offers.includes(1) && resolved.lowerPlacement === "adaptive";
        });
        expect(seed).toBeDefined();

        const baseline = resolveLeaguePick(seed!, anchor, opponent, false);
        const resolved = resolveLeaguePick(seed!, alternative, opponent, false);
        expect(resolved.state.lower.creatures).not.toEqual(baseline.state.lower.creatures);
        expect(resolved.state.lower.tier2Artifact).toBe(1);
        expect(resolved.state.lower.doctrine).toBe(Doctrine.SEE_ALL);
        expect(resolved.lowerAugments).toEqual([{ kind: "Movement", value: 2 }]);
        expect(resolved.lowerPlacement).toBe("adaptive");

        let wiredConfig: IMatchConfig | undefined;
        let wiredGate = "";
        const baseSeed = Array.from({ length: 500 }, (_, value) => value).find((value) => {
            playLeagueGame(
                alternative,
                { ...opponent, prior: 1 },
                { gamesPerOpponent: 8, baseSeed: value, freezeDoctrine: false },
                0,
                {
                    matchRunner: (config) => {
                        wiredConfig = config;
                        wiredGate = process.env.V06_DISPERSE_TEAM ?? "";
                        return fakeMatch("draw", config);
                    },
                },
            );
            return wiredGate === "lower" || wiredGate === "both";
        });
        expect(baseSeed).toBeDefined();
        expect(wiredConfig?.greenDoctrine).toBe(Doctrine.SEE_ALL);
        expect(wiredConfig?.greenAugments).toEqual([{ kind: "Movement", value: 2 }]);
        expect(["lower", "both"]).toContain(wiredGate);

        // Re-pinned after Blacksmith expanded the Life L1 offer pool: seed 150 preserved the fixture's
        // no-vision collision outcome without weakening the SEE_NONE or tight-placement assertions.
        // Re-pinned 150 -> 54 after Zena (50) grew the L2 pool and shifted the same draw (seed 150 now
        // leaks known opponent creatures). Re-pinned 54 -> 71 after Wyvern (51) and Trent (52) grew that
        // pool 13 -> 15, shifting it again; 71 is the lowest surviving seed. Re-pinned 71 -> 645 after the
        // Manticore (53) took that pool 15 -> 16 and shifted it once more; 645 is again the lowest
        // survivor. Re-pinned 645 -> 591 after the Battle Mage (55) took that pool 16 -> 17. Re-pinned
        // 591 -> 75 after L1/L2 auto-bans went 5 -> 6 (LIVE_AUTO_BANS_BY_LEVEL): removing one more
        // creature from each pool shifts every seeded draft draw. 75 is the lowest survivor, of 45 in the
        // first 5000 seeds. The binding assertion is the empty known-creature list — SEE_NONE and "tight"
        // hold broadly. The search stays out of the test so it cannot pass tautologically.
        const noVision = resolveLeaguePick(75, alternative, opponent, true);
        expect(getKnownOpponentCreatures(noVision.state, PBTypes.TeamVals.LOWER)).toEqual([]);
        expect(noVision.state.lower.doctrine).toBe(Doctrine.SEE_NONE);
        expect(noVision.lowerPlacement).toBe("tight");
    });
});

describe("B1 league evaluation", () => {
    it("sanitizes inherited AI and measurement flags before worker module initialization", () => {
        const environment = sanitizedLeagueEnvironment({
            PATH: "/bin",
            KEEP_ME: "yes",
            V04_FRONTMOVE: "off",
            V05_HOURGLASS: "off",
            V06_WEIGHTS: "[]",
            V07_SEARCH: "1",
            SEARCH_GATE: "0",
            Q2_WAIT_ABLATION: "1",
            CEM_POP: "99",
            FIGHT_MELEE_ROSTERS: "1",
            ROSTER_RANGED_MIN: "3",
            AUGCA_NOVISION: "1",
            LIVETWIN: "ambient",
            SIM_NO_ACTIONS: "ambient",
            VALUE_DATA: "/tmp/value.jsonl",
        });
        expect(environment.PATH).toBe("/bin");
        expect(environment.KEEP_ME).toBe("yes");
        for (const key of Object.keys(environment)) {
            expect(key).not.toMatch(/^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/);
        }
        expect(environment.LIVETWIN).toBeUndefined();
        expect(environment.SIM_NO_ACTIONS).toBeUndefined();
        expect(environment.VALUE_DATA).toBeUndefined();
        expect(() =>
            playLeagueGame(
                createLeagueGenome("candidate"),
                { ...createLeagueGenome("opponent"), prior: 1 },
                { gamesPerOpponent: 8, baseSeed: 1 },
                0,
            ),
        ).toThrow("not environment-isolated");
    });

    it("uses four-game offer boards with exact fixed-setup battle mirrors", () => {
        const candidate = createLeagueGenome("candidate");
        const opponent = { ...createMeleeLeagueGenome("opponent"), prior: 1 };
        const configs: IMatchConfig[] = [];
        const placementGates: string[] = [];
        process.env.LIVETWIN = "ambient";
        process.env.V06_DISPERSE_TEAM = "ambient-dispersion";
        const options = { gamesPerOpponent: 8, baseSeed: 19, concurrency: 1 };
        const dependencies = {
            matchRunner: (config: IMatchConfig) => {
                configs.push(config);
                placementGates.push(process.env.V06_DISPERSE_TEAM ?? "");
                expect(process.env.LIVETWIN).toBe("1");
                expect(process.env.SIM_NO_ACTIONS).toBe("1");
                expect(process.env.V07_SEARCH).toBe("0");
                return fakeMatch("green", config);
            },
        };
        const records = Array.from({ length: 4 }, (_, game) =>
            playLeagueGame(candidate, opponent, options, game, dependencies),
        );

        expect(new Set(records.map((record) => record.pairSeed)).size).toBe(1);
        expect(configs[0].seed).toBe(configs[1].seed);
        expect(configs[2].seed).toBe(configs[3].seed);
        expect(records.map((record) => record.battleSeed)).toEqual(configs.map((config) => config.seed));
        expect(records.map((record) => record.candidateSide)).toEqual(["green", "red", "red", "green"]);
        expect(records.map((record) => record.candidateResult)).toEqual(["win", "loss", "loss", "win"]);
        expect(records[0].setupFingerprint).toBe(records[1].setupFingerprint);
        expect(records[2].setupFingerprint).toBe(records[3].setupFingerprint);

        const assertSetupSwap = (first: IMatchConfig, mirror: IMatchConfig): void => {
            expect(first.roster).toEqual(mirror.redRoster);
            expect(first.redRoster).toEqual(mirror.roster);
            expect(first.greenArtifactT1).toBe(mirror.redArtifactT1);
            expect(first.redArtifactT1).toBe(mirror.greenArtifactT1);
            expect(first.greenArtifactT2).toBe(mirror.redArtifactT2);
            expect(first.redArtifactT2).toBe(mirror.greenArtifactT2);
            expect(first.greenDoctrine).toBe(mirror.redDoctrine);
            expect(first.redDoctrine).toBe(mirror.greenDoctrine);
            expect(first.greenAugments).toEqual(mirror.redAugments);
            expect(first.redAugments).toEqual(mirror.greenAugments);
            expect(first.greenSynergies).toEqual(mirror.redSynergies);
            expect(first.redSynergies).toEqual(mirror.greenSynergies);
        };
        assertSetupSwap(configs[0], configs[1]);
        assertSetupSwap(configs[2], configs[3]);
        const swappedGate = (gate: string): string => (gate === "lower" ? "upper" : gate === "upper" ? "lower" : gate);
        expect(placementGates[1]).toBe(swappedGate(placementGates[0]));
        expect(placementGates[3]).toBe(swappedGate(placementGates[2]));
        expect(placementGates[0]).not.toBe("ambient-dispersion");
        expect(configs.every((config) => config.roster.length === 6 && config.redRoster?.length === 6)).toBe(true);
        expect(process.env.LIVETWIN).toBe("ambient");
        expect(process.env.V06_DISPERSE_TEAM).toBe("ambient-dispersion");
    });

    it("produces identical reports through sanitized one-worker and concurrent execution", async () => {
        process.env.V04_FRONTMOVE = "off";
        process.env.V05_HOURGLASS = "off";
        const candidate = createLeagueGenome("candidate");
        const pool = defaultLeaguePool();
        const options = { gamesPerOpponent: 8, baseSeed: 123, concurrency: 4 };
        const sequential = await evaluateLeagueCandidateSequential(candidate, pool, options);
        const concurrent = await evaluateLeagueCandidate(candidate, pool, options);

        expect(concurrent.opponents).toEqual(sequential.opponents);
        expect(concurrent.aggregate).toEqual(sequential.aggregate);
        expect(concurrent.totalGames).toBe(sequential.totalGames);
    }, 30_000);

    it("uses the worst offer-board-cluster lower bound and reports a qualified adversarial mixture", () => {
        const candidate = createLeagueGenome("candidate");
        const pool = defaultLeaguePool();
        const makeRecords = (opponentId: string, results: readonly ("win" | "loss" | "draw")[]): ILeagueGameRecord[] =>
            results.map((candidateResult, game) => {
                const withinBoard = game % 4;
                const candidateSide = withinBoard === 0 || withinBoard === 3 ? "green" : "red";
                const winner =
                    candidateResult === "draw"
                        ? "draw"
                        : candidateResult === "win"
                          ? candidateSide
                          : candidateSide === "green"
                            ? "red"
                            : "green";
                const offerBoard = Math.floor(game / 4);
                return {
                    opponentId,
                    game,
                    offerBoard,
                    pickSeat: withinBoard < 2 ? "candidate-lower" : "candidate-upper",
                    battleMirror: (withinBoard % 2) as 0 | 1,
                    setupFingerprint: Math.floor(game / 2),
                    pairSeed: (1 + Math.imul(offerBoard, 0x9e3779b1)) >>> 0,
                    battleSeed: Math.floor(game / 2),
                    candidateSide,
                    winner,
                    candidateResult,
                    laps: 5,
                    collisions: 0,
                };
            });
        const anchorRecords = makeRecords("anchor", [
            "win",
            "win",
            "win",
            "loss",
            "win",
            "win",
            "win",
            "loss",
            "win",
            "win",
            "loss",
            "loss",
        ]);
        const meleeRecords = makeRecords("melee_coevo", [
            "win",
            "loss",
            "win",
            "loss",
            "win",
            "loss",
            "win",
            "loss",
            "win",
            "loss",
            "win",
            "loss",
        ]);
        const records = [...anchorRecords, ...meleeRecords];
        const report = summarizeLeagueRecords(
            candidate,
            pool,
            { gamesPerOpponent: 12, baseSeed: 1, aggregate: "worst-case" },
            records,
            new Date("2026-07-10T00:00:00.000Z"),
        );

        expect(report.status).toBe("measurement_only");
        expect(report.aggregate.worstCaseOpponent).toBe("melee_coevo");
        expect(report.aggregate.fitness).toBe(clusteredLowerBound(meleeRecords));
        expect(report.opponents[1].offerBoards).toBe(3);
        expect(report.aggregate.softminLowerBound).toBeGreaterThanOrEqual(report.aggregate.worstCaseLowerBound);
        expect(report.aggregate.adversarialMixture.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1);
        expect(report.aggregate.adversarialMixture[1].weight).toBeGreaterThan(0.5);
        expect(report.provenance.nashQualification).toContain("full Nash equilibrium");
        expect(report.limitations.some((limitation) => limitation.includes("not a powered acceptance panel"))).toBe(
            true,
        );

        const sparseDecisiveRecords = anchorRecords.map((record, game) => ({
            ...record,
            game,
            offerBoard: Math.floor(game / 4),
            candidateResult: game === 0 || game === 4 ? ("win" as const) : ("draw" as const),
        }));
        const drawOnlyBoards = Array.from({ length: 32 }, (_, offset) => ({
            ...anchorRecords[offset % 4],
            game: offset + sparseDecisiveRecords.length,
            offerBoard: Math.floor(offset / 4) + 3,
            candidateResult: "draw" as const,
        }));
        expect(clusteredLowerBound([...sparseDecisiveRecords, ...drawOnlyBoards])).toBe(
            clusteredLowerBound(sparseDecisiveRecords),
        );

        const brokenMirror = records.map((record) => ({ ...record }));
        brokenMirror[1].setupFingerprint += 1;
        expect(() =>
            summarizeLeagueRecords(candidate, pool, { gamesPerOpponent: 12, baseSeed: 1 }, brokenMirror),
        ).toThrow("not a fixed-setup battle mirror");
    });
});

describe("B1 league CEM validity", () => {
    const score = (weights: number[], fitness: number): ILeagueCemScore => ({
        weights,
        fitness,
        worstCase: fitness,
        softmin: fitness,
    });

    it("samples deterministically while keeping the frozen doctrine head bit-identical", () => {
        const sigma = createLeagueCemSigma(LEAGUE_ANCHOR_GENOME, 0.25, 2.5, true);
        const first = sampleLeagueCemPopulation(LEAGUE_ANCHOR_GENOME, sigma, 5, 17, 3, true);
        const second = sampleLeagueCemPopulation(LEAGUE_ANCHOR_GENOME, sigma, 5, 17, 3, true);
        expect(second).toEqual(first);
        for (let dimension = LEAGUE_GENOME_LAYOUT.doctrines.offset; dimension < LEAGUE_GENOME_DIM; dimension += 1) {
            expect(sigma[dimension]).toBe(0);
            expect(first.every((candidate) => candidate[dimension] === LEAGUE_ANCHOR_GENOME[dimension])).toBe(true);
        }

        const mean = [...LEAGUE_ANCHOR_GENOME];
        const elite = [score(first[1], 0.5), score(first[2], 0.4)];
        refitLeagueCemDistribution(
            elite,
            mean,
            sigma,
            sigma.map((value) => value * 0.2),
            0.9,
            true,
        );
        expect(mean.slice(LEAGUE_GENOME_LAYOUT.doctrines.offset)).toEqual(
            LEAGUE_ANCHOR_GENOME.slice(LEAGUE_GENOME_LAYOUT.doctrines.offset),
        );
        expect(sigma.slice(LEAGUE_GENOME_LAYOUT.doctrines.offset)).toEqual([0, 0, 0]);
    });

    it("retains comparable best provenance and rejects cross-panel comparisons", () => {
        const weights = [...LEAGUE_ANCHOR_GENOME];
        const first = retainComparableLeagueBest(undefined, score(weights, 0.55), 2, 123, "panel-a");
        const retained = retainComparableLeagueBest(first, score(weights, 0.5), 5, 123, "panel-a");
        expect(retained.foundGeneration).toBe(2);
        expect(retained.selectionSeed).toBe(123);
        expect(retained.selectionPanelFingerprint).toBe("panel-a");

        const improved = retainComparableLeagueBest(retained, score(weights, 0.6), 6, 123, "panel-a");
        expect(improved.foundGeneration).toBe(6);
        expect(improved.fitness).toBe(0.6);
        expect(() => retainComparableLeagueBest(improved, score(weights, 0.7), 7, 124, "panel-a")).toThrow(
            "different selection panels",
        );
        expect(() => retainComparableLeagueBest(improved, score(weights, 0.7), 7, 123, "panel-b")).toThrow(
            "different selection panels",
        );
    });

    it("snapshots a custom pool and persists the complete selection-panel fingerprint", () => {
        const temporaryDirectory = mkdtempSync(join(tmpdir(), "hoc-league-cem-"));
        const packageRoot = join(import.meta.dir, "../..");
        try {
            const pool = defaultLeaguePool().map((entry, index) => ({ ...entry, prior: index ? 1 : 3 }));
            const poolPath = join(temporaryDirectory, "pool.json");
            const outputPath = join(temporaryDirectory, "out");
            writeFileSync(poolPath, JSON.stringify({ entries: pool }));
            const processResult = Bun.spawnSync({
                cmd: [process.execPath, "src/simulation/optimizer/cem_league.mjs"],
                cwd: packageRoot,
                env: {
                    ...process.env,
                    CEM_AGGREGATE: "softmin",
                    CEM_ELITE: "1",
                    CEM_EVAL_PARALLEL: "2",
                    CEM_GAMES: "8",
                    CEM_GENS: "1",
                    CEM_LEAGUE_MEAN: "",
                    CEM_LEAGUE_POOL: poolPath,
                    CEM_MAPS: "1,2",
                    CEM_MATCH_CONC: "1",
                    CEM_OUT: outputPath,
                    CEM_POP: "2",
                    CEM_SEED: "17",
                    CEM_SOFTMIN_TEMPERATURE: "0.04",
                    CEM_UNFREEZE_DOCTRINE: "0",
                    CEM_VAL_GAMES: "8",
                },
                stderr: "pipe",
                stdout: "pipe",
            });
            expect(new TextDecoder().decode(processResult.stderr)).toBe("");
            expect(processResult.exitCode).toBe(0);

            const best = JSON.parse(readFileSync(join(outputPath, "best.json"), "utf8")) as {
                status: string;
                train: { selectionPanelFingerprint: string };
                selectionPanel: {
                    aggregate: string;
                    fightVersion: string;
                    freezeDoctrine: boolean;
                    gamesPerOpponent: number;
                    mapTypes: number[];
                    pool: unknown[];
                    seed: number;
                    softminTemperature: number;
                };
                poolSnapshot: { fingerprint: string; path: string; source: string };
            };
            const panelFingerprint = createHash("sha256").update(JSON.stringify(best.selectionPanel)).digest("hex");
            expect(best.train.selectionPanelFingerprint).toBe(panelFingerprint);
            expect(best.status).toBe("measurement_only");
            expect(best.selectionPanel).toMatchObject({
                aggregate: "softmin",
                fightVersion: "v0.6",
                freezeDoctrine: true,
                gamesPerOpponent: 8,
                mapTypes: [1, 2],
                pool,
                seed: 17,
                softminTemperature: 0.04,
            });
            const snapshot = readFileSync(best.poolSnapshot.path, "utf8");
            expect(JSON.parse(snapshot)).toEqual({ entries: pool });
            expect(best.poolSnapshot.fingerprint).toBe(createHash("sha256").update(snapshot).digest("hex"));
            expect(best.poolSnapshot.source).toBe(poolPath);
            expect(statSync(best.poolSnapshot.path).mode & 0o222).toBe(0);
        } finally {
            rmSync(temporaryDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
