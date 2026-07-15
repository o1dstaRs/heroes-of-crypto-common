/*
 * -----------------------------------------------------------------------------
 * measure_reveal_placement: V07_PLACEMENT_REVEAL A/B harness. The historical preregistration is untracked;
 * these tests verify the declared battery (seeds 82xxx710), paired treated-seat design (identical armies +
 * battle seed per pair, only WHICH seat receives its legitimate reveals differs), reveal plumbing into
 * IMatchConfig, and the declared ship-bar arithmetic (pooled >= +1.0pp, no cell below -0.5pp).
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import {
    aggregateRevealRecord,
    emptyRevealAggregate,
    evaluateRevealShipBar,
    FLYER_MIRROR_ROSTER,
    GARG_MIRROR_ROSTER,
    mirrorRoster,
    playRevealGame,
    policyForPair,
    revealCells,
    summarizeRevealCell,
    validateRevealMeasurementEnvironment,
    type IRevealCellSummary,
} from "../../src/simulation/measure_reveal_placement";

const stubResult = (config: IMatchConfig, winner: "green" | "red" | "draw"): IMatchResult => ({
    seed: config.seed,
    gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
    winner,
    endReason: "elimination",
    laps: 5,
    totalActions: 0,
    roster: config.roster,
    ...(config.redRoster ? { redRoster: config.redRoster } : {}),
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

describe("registered battery", () => {
    it("binds the reported gate to the exact registered environment", () => {
        expect(validateRevealMeasurementEnvironment(false, { LIVETWIN: "1", V07_PLACEMENT_REVEAL: "on" })).toBe("on");
        expect(validateRevealMeasurementEnvironment(true, { LIVETWIN: "1" })).toBe("off");
        expect(() => validateRevealMeasurementEnvironment(false, { LIVETWIN: "1" })).toThrow(
            "requires V07_PLACEMENT_REVEAL=on",
        );
        expect(() => validateRevealMeasurementEnvironment(true, { LIVETWIN: "1", V07_PLACEMENT_REVEAL: "on" })).toThrow(
            "requires V07_PLACEMENT_REVEAL to be unset",
        );
        expect(() => validateRevealMeasurementEnvironment(false, { V07_PLACEMENT_REVEAL: "on" })).toThrow(
            "requires LIVETWIN=1",
        );
    });

    it("pins the declared amendment-1 82xxx710 seeds and game counts", () => {
        const byName = new Map(revealCells().map((cell) => [cell.name, cell]));
        expect(byName.get("drafted_fmr1")).toMatchObject({ seed: 82011710, games: 4000, policy: "champion" });
        expect(byName.get("drafted_fmr05")).toMatchObject({ seed: 82012710, games: 4000, policy: "mix" });
        expect(byName.get("drafted_fmr0")).toMatchObject({ seed: 82013710, games: 4000, policy: "policy_v0" });
        expect(byName.get("garg_null")).toMatchObject({ seed: 82014710, games: 1000, barExempt: true });
        expect(byName.get("flyer_mirror")).toMatchObject({ seed: 82015710, games: 3000 });
        expect(byName.get("charger_mirror")).toMatchObject({ seed: 82016710, games: 3000 });
    });

    it("maps the FMR axis to pick policies (mix = deterministic per-pair coin flip)", () => {
        const [fmr1, fmr05, fmr0] = revealCells();
        expect(policyForPair(fmr1, 123)).toBe("champion");
        expect(policyForPair(fmr0, 123)).toBe("policy_v0");
        const draws = new Set<string>();
        for (let seed = 0; seed < 64; seed += 1) {
            const policy = policyForPair(fmr05, seed);
            expect(policy).toBe(policyForPair(fmr05, seed)); // deterministic
            draws.add(policy);
        }
        expect(draws).toEqual(new Set(["champion", "policy_v0"]));
    });

    it("builds the fixed mirror rosters with LiveTwin exp-budget amounts", () => {
        for (const names of [GARG_MIRROR_ROSTER, FLYER_MIRROR_ROSTER]) {
            const roster = mirrorRoster(names);
            expect(roster).toHaveLength(6);
            for (const unit of roster) {
                expect(unit.amount).toBeGreaterThan(0);
            }
        }
        expect(mirrorRoster(GARG_MIRROR_ROSTER).map((u) => u.creatureName)).toContain("Gargantuan");
    });
});

describe("paired treated-seat design", () => {
    it("mirror cell: reveals go ONLY to the treated seat and swap across the pair", () => {
        const cell = revealCells().find((candidate) => candidate.name === "garg_null")!;
        const configs: IMatchConfig[] = [];
        const runner = (config: IMatchConfig): IMatchResult => {
            configs.push(config);
            return stubResult(config, "green");
        };
        const even = playRevealGame(cell, "v0.7", 0, { matchRunner: runner });
        const odd = playRevealGame(cell, "v0.7", 1, { matchRunner: runner });
        expect(even.treatedSide).toBe("green");
        expect(odd.treatedSide).toBe("red");
        expect(even.seed).toBe(odd.seed); // same pair -> same battle seed
        expect(configs[0].greenRevealedCreatures?.length).toBe(6);
        expect(configs[0].redRevealedCreatures).toBeUndefined();
        expect(configs[1].redRevealedCreatures?.length).toBe(6);
        expect(configs[1].greenRevealedCreatures).toBeUndefined();
        // Deterministic revealed splash threat (the registered mirror premise).
        expect(even.treatedThreats.splashAoe).toBeGreaterThan(0);
        // Identical armies + winner green => treated wins the even game, loses the odd one.
        expect(even.treatedResult).toBe("win");
        expect(odd.treatedResult).toBe("loss");
    });

    it("drafted cell: identical pick outcome across the pair; reveals never cross seats", () => {
        const cell = { ...revealCells()[0], games: 2 };
        const configs: IMatchConfig[] = [];
        const runner = (config: IMatchConfig): IMatchResult => {
            configs.push(config);
            return stubResult(config, "red");
        };
        const even = playRevealGame(cell, "v0.7", 0, { matchRunner: runner });
        const odd = playRevealGame(cell, "v0.7", 1, { matchRunner: runner });
        expect(even.policy).toBe("champion");
        expect(configs[0].seed).toBe(configs[1].seed);
        expect(JSON.stringify(configs[0].roster)).toBe(JSON.stringify(configs[1].roster));
        expect(JSON.stringify(configs[0].redRoster)).toBe(JSON.stringify(configs[1].redRoster));
        expect(configs[0].redRevealedCreatures).toBeUndefined();
        expect(configs[1].greenRevealedCreatures).toBeUndefined();
        expect(configs[0].greenRevealedCreatures?.length ?? 0).toBe(even.treatedRevealCount);
        expect(configs[1].redRevealedCreatures?.length ?? 0).toBe(odd.treatedRevealCount);
    });

    it("flyer mirror reveals classify as a flyer threat, not splash", () => {
        const cell = revealCells().find((candidate) => candidate.name === "flyer_mirror")!;
        const record = playRevealGame(cell, "v0.7", 0, {
            matchRunner: (config) => stubResult(config, "draw"),
        });
        expect(record.treatedThreats.flyers).toBeGreaterThanOrEqual(2);
        expect(record.treatedThreats.splashAoe).toBe(0);
        expect(record.treatedResult).toBe("draw");
    });

    it("charger mirror reveals classify as a pure charger threat", () => {
        const cell = revealCells().find((candidate) => candidate.name === "charger_mirror")!;
        const record = playRevealGame(cell, "v0.7", 0, {
            matchRunner: (config) => stubResult(config, "draw"),
        });
        expect(record.treatedThreats.chargers).toBeGreaterThanOrEqual(2);
        expect(record.treatedThreats.flyers).toBe(0);
        expect(record.treatedThreats.splashAoe).toBe(0);
    });
});

describe("aggregation + registered ship bar", () => {
    const summaryFor = (wins: number, losses: number, barExempt = false): IRevealCellSummary => {
        const cell = { ...revealCells()[0], games: wins + losses, barExempt };
        const aggregate = emptyRevealAggregate(cell);
        for (let game = 0; game < wins + losses; game += 1) {
            aggregateRevealRecord(aggregate, {
                cellName: cell.name,
                game,
                pairIndex: Math.floor(game / 2),
                seed: 1,
                treatedSide: game % 2 ? "red" : "green",
                winner: game < wins ? (game % 2 ? "red" : "green") : game % 2 ? "green" : "red",
                treatedResult: game < wins ? "win" : "loss",
                laps: 10,
                endReason: "elimination",
                treatedRevealCount: 1,
                treatedThreats: { splashAoe: 1, flyers: 0, chargers: 0 },
            });
        }
        return summarizeRevealCell(aggregate);
    };

    it("summarize computes the treated delta in pp with the sqrt(2) cluster SE", () => {
        const summary = summaryFor(60, 40);
        expect(summary.decisive).toBe(100);
        expect(summary.deltaPp).toBeCloseTo(10, 5);
        expect(summary.clusterSePp).toBeCloseTo(Math.SQRT2 * summary.sePp, 10);
        expect(summary.splashThreatRate).toBe(1);
    });

    it("PASS: pooled >= +1.0pp and every cell above the -0.5pp floor", () => {
        const verdict = evaluateRevealShipBar([summaryFor(530, 470), summaryFor(510, 490)]);
        expect(verdict.pooledDeltaPp).toBeCloseTo(2, 5);
        expect(verdict.verdict).toBe("PASS");
    });

    it("FAIL: pooled below the bar", () => {
        const verdict = evaluateRevealShipBar([summaryFor(502, 498), summaryFor(500, 500)]);
        expect(verdict.verdict).toBe("FAIL");
        expect(verdict.reason).toContain("pooled");
    });

    it("FAIL: a single cell breaching the -0.5pp floor kills an otherwise passing pooled result", () => {
        const verdict = evaluateRevealShipBar([summaryFor(560, 440), summaryFor(490, 510)]);
        expect(verdict.pooledDeltaPp).toBeGreaterThanOrEqual(1);
        expect(verdict.verdict).toBe("FAIL");
        expect(verdict.reason).toContain("floor");
    });

    it("bar-exempt null cells contribute neither to the pool nor to the floor", () => {
        const withNull = evaluateRevealShipBar([summaryFor(530, 470), summaryFor(300, 700, true)]);
        expect(withNull.pooledDeltaPp).toBeCloseTo(3, 5);
        expect(withNull.verdict).toBe("PASS");
        expect(withNull.worstCell).not.toBe(revealCells()[0].name === "drafted_fmr1" ? "garg_null" : "");
    });
});
