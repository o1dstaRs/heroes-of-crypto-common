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

import { afterEach, describe, expect, it } from "bun:test";

import { scoreCreatureWeighted } from "../../src/ai/setup/creature_score";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Perk } from "../../src/perks/perk_properties";
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
    pickLeaguePerk,
    pickLeaguePlacement,
    scoreLeagueCreature,
} from "../../src/simulation/league_genome";
import {
    defaultLeaguePool,
    playLeagueGame,
    resolveLeaguePick,
    summarizeLeagueRecords,
    wilsonLowerBound,
    type ILeagueGameRecord,
} from "../../src/simulation/league_eval";

const ENV_KEYS = [
    "LIVETWIN",
    "SIM_NO_ACTIONS",
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "V06_CASTER_ROUTER",
    "V06_AREA_THROW",
    "V06_RIDER_EV",
    "V06_DISPERSE_TEAM",
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

    it("anchors setup at SEE_NONE, Armor3/Might3/Sniper1 and adaptive placement", () => {
        const anchor = createLeagueGenome("anchor");
        expect(pickLeaguePerk(anchor)).toBe(Perk.SEE_NONE);
        expect(pickLeagueAugments([], [], 7, anchor)).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 3 },
            { kind: "Sniper", value: 1 },
        ]);
        expect(pickLeaguePlacement([], [], anchor)).toBe("adaptive");

        const changed = [...LEAGUE_ANCHOR_GENOME];
        changed[LEAGUE_GENOME_LAYOUT.placement.offset] = -1;
        changed[LEAGUE_GENOME_LAYOUT.perks.offset + 1] = 100;
        const alternative = createLeagueGenome("alternative", changed);
        expect(pickLeaguePlacement([], [], alternative)).toBe("tight");
        expect(pickLeaguePerk(alternative)).toBe(Perk.SEE_NONE);
        expect(pickLeaguePerk(alternative, false)).toBe(Perk.SEE_ALL);
    });

    it("drives the exact pick reducer deterministically through retries to six-stack setups", () => {
        const anchor = createLeagueGenome("anchor");
        const melee = createMeleeLeagueGenome();
        const first = resolveLeaguePick(777, anchor, melee);
        const second = resolveLeaguePick(777, anchor, melee);
        expect(first).toEqual(second);
        expect(first.state.phaseSequence).toBe(10);
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
});

describe("B1 league evaluation", () => {
    it("mirrors candidate seats on one pair seed and restores the frozen fight environment", () => {
        const candidate = createLeagueGenome("candidate");
        const opponent = { ...createMeleeLeagueGenome("opponent"), prior: 1 };
        const configs: IMatchConfig[] = [];
        process.env.LIVETWIN = "ambient";
        process.env.V06_DISPERSE_TEAM = "ambient-dispersion";
        const options = { gamesPerOpponent: 2, baseSeed: 19, concurrency: 1 };
        const dependencies = {
            matchRunner: (config: IMatchConfig) => {
                configs.push(config);
                expect(process.env.LIVETWIN).toBe("1");
                expect(process.env.SIM_NO_ACTIONS).toBe("1");
                expect(process.env.V07_SEARCH).toBe("0");
                return fakeMatch("green", config);
            },
        };
        const lower = playLeagueGame(candidate, opponent, options, 0, dependencies);
        const upper = playLeagueGame(candidate, opponent, options, 1, dependencies);

        expect(lower.pairSeed).toBe(upper.pairSeed);
        expect(configs[0].seed).toBe(configs[1].seed);
        expect(lower.candidateSide).toBe("green");
        expect(lower.candidateResult).toBe("win");
        expect(upper.candidateSide).toBe("red");
        expect(upper.candidateResult).toBe("loss");
        expect(configs.every((config) => config.roster.length === 6 && config.redRoster?.length === 6)).toBe(true);
        expect(process.env.LIVETWIN).toBe("ambient");
        expect(process.env.V06_DISPERSE_TEAM).toBe("ambient-dispersion");
    });

    it("uses the worst per-opponent Wilson lower bound and reports a qualified adversarial mixture", () => {
        const candidate = createLeagueGenome("candidate");
        const pool = defaultLeaguePool();
        const makeRecords = (opponentId: string, wins: number, losses: number): ILeagueGameRecord[] => [
            ...Array.from({ length: wins }, (_, game) => ({
                opponentId,
                game,
                pairSeed: game,
                candidateSide: "green" as const,
                winner: "green" as const,
                candidateResult: "win" as const,
                laps: 5,
                collisions: 0,
            })),
            ...Array.from({ length: losses }, (_, index) => ({
                opponentId,
                game: wins + index,
                pairSeed: wins + index,
                candidateSide: "green" as const,
                winner: "red" as const,
                candidateResult: "loss" as const,
                laps: 5,
                collisions: 0,
            })),
        ];
        const records = [...makeRecords("anchor", 8, 2), ...makeRecords("melee_coevo", 5, 5)];
        const report = summarizeLeagueRecords(
            candidate,
            pool,
            { gamesPerOpponent: 10, baseSeed: 1, aggregate: "worst-case" },
            records,
            new Date("2026-07-10T00:00:00.000Z"),
        );

        expect(report.status).toBe("measurement_only");
        expect(report.aggregate.worstCaseOpponent).toBe("melee_coevo");
        expect(report.aggregate.fitness).toBe(wilsonLowerBound(5, 5));
        expect(report.aggregate.softminLowerBound).toBeGreaterThanOrEqual(report.aggregate.worstCaseLowerBound);
        expect(report.aggregate.adversarialMixture.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1);
        expect(report.aggregate.adversarialMixture[1].weight).toBeGreaterThan(0.5);
        expect(report.provenance.nashQualification).toContain("full Nash equilibrium");
        expect(report.limitations.some((limitation) => limitation.includes("not a powered acceptance panel"))).toBe(
            true,
        );
    });
});
