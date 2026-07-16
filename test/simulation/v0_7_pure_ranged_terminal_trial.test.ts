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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES,
    PURE_RANGED_TERMINAL_PAIR_SEED_STEP,
    PURE_RANGED_TERMINAL_SCOUT_WEIGHTS,
    auditPureRangedTerminalSeedRoots,
    estimatePureRangedTerminalDelta,
    findPureRangedTerminalSeedCollisions,
    plannedPureRangedTerminalSeeds,
    pureRangedTerminalEnvironment,
    readPureRangedTerminalManifest,
    selectPureRangedTerminalWeight,
    validatePureRangedTerminalManifest,
    type IPureRangedTerminalComparison,
    type IPureRangedTerminalManifest,
} from "../../src/simulation/v0_7_pure_ranged_terminal_trial";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cloneManifest(): IPureRangedTerminalManifest {
    return structuredClone(readPureRangedTerminalManifest().manifest);
}

function comparison(weight: number, gain: number, passed = true): IPureRangedTerminalComparison {
    return {
        weight,
        control: {} as IPureRangedTerminalComparison["control"],
        candidate: {} as IPureRangedTerminalComparison["candidate"],
        pairedScoreGain: { clusters: 256, mean: gain, standardError: 0.01, confidence95: { low: 0.01, high: 0.05 } },
        pairedDrawOrArmageddonDelta: {
            clusters: 256,
            mean: -0.06,
            standardError: 0.01,
            confidence95: { low: -0.08, high: -0.04 },
        },
        candidateActionHashChangedGames: 4,
        gates: {},
        passed,
    };
}

describe("pure-ranged terminal preregistration", () => {
    it("freezes the historical mechanism panel, paired arms, exact envelopes, and no-deploy authority", () => {
        const { manifest } = readPureRangedTerminalManifest();
        expect(manifest.panelScope).toContain("not current-ranked setup evidence");
        expect(manifest.mechanismPanel).toMatchObject({
            template: "ranged_precision",
            roster: ["Arbalester", "Centaur", "Elf", "Medusa", "Cyclops", "Tsar Cannon"],
            amountMode: "expBudget",
            originalStacksMustAllBeRange: true,
        });
        expect(manifest.arms.scoutWeights).toEqual([...PURE_RANGED_TERMINAL_SCOUT_WEIGHTS]);
        expect(manifest.searchEnvelope).toMatchObject({
            gate: 0.01,
            horizon: 4,
            rollouts: 1,
            shortlist: 3,
            maxMelee: 4,
            maxShots: 6,
            maxThrows: 2,
            decisionDeadlineMs: 200,
            circuitBreakerMs: 275,
            valueLeaf: "committed_default_20d",
        });
        expect(manifest.identityControlEnvelope).toMatchObject({
            decisionDeadlineMs: null,
            circuitBreakerMs: null,
        });
        expect(manifest.scoutGates.deadlineFallbacks).toBe(0);
        expect(manifest.authority).toEqual({
            defaultWeight: 0,
            bake: false,
            deploy: false,
            instruction: "NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY_FROM_THIS_HARNESS",
        });
    });

    it("reserves 2,262 unique scenarios separately from repeated weight-arm executions", () => {
        const { manifest } = readPureRangedTerminalManifest();
        const seeds = plannedPureRangedTerminalSeeds(manifest);
        expect(seeds.size).toBe(2_262);
        expect(manifest.scenarioReservation).toMatchObject({
            uniqueScenarioSeeds: 2_262,
            armExecutionsExcludedFromUniqueCount: true,
            scout: { baseSeed: 87_113_710, gamesPerArm: 512, pairSeeds: 256 },
            confirmation: { baseSeed: 87_123_710, gamesPerArm: 4_000, pairSeeds: 2_000 },
        });
        const identity = manifest.scenarioReservation.confirmation.identityPairSeeds;
        expect(Object.keys(identity)).toEqual([...PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES]);
        PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES.forEach((template, index) => {
            expect(identity[template]).toBe(
                (87_123_710 + Math.imul(2_000 + index, PURE_RANGED_TERMINAL_PAIR_SEED_STEP)) >>> 0,
            );
        });
        expect(findPureRangedTerminalSeedCollisions(manifest, [])).toEqual([]);
        expect(findPureRangedTerminalSeedCollisions(manifest, [87_113_710, 1, 87_113_710])).toEqual([87_113_710]);
    });

    it("fails closed on seed, performance, deterministic-control, gate, or authority drift", () => {
        const seed = cloneManifest();
        seed.scenarioReservation.scout.baseSeed += 1;
        expect(() => validatePureRangedTerminalManifest(seed)).toThrow("scenario reservation drifted");

        const envelope = cloneManifest();
        envelope.searchEnvelope.shortlist = 2;
        expect(() => validatePureRangedTerminalManifest(envelope)).toThrow("search envelope drifted");

        const identity = cloneManifest();
        identity.identityControlEnvelope.decisionDeadlineMs = 200 as never;
        expect(() => validatePureRangedTerminalManifest(identity)).toThrow("search envelope drifted");

        const fallback = cloneManifest();
        fallback.scoutGates.deadlineFallbacks = 1;
        expect(() => validatePureRangedTerminalManifest(fallback)).toThrow("scout gates drifted");

        const authority = cloneManifest();
        authority.authority.bake = true as never;
        expect(() => validatePureRangedTerminalManifest(authority)).toThrow("seed or authority declaration drifted");
    });
});

describe("pure-ranged terminal execution isolation", () => {
    it("strips ambient behavior and pins the exact ranged performance envelope", () => {
        const { manifest } = readPureRangedTerminalManifest();
        const environment = pureRangedTerminalEnvironment(manifest, 0.5, "ranged_performance", {
            PATH: "/bin",
            V07_WAIT_WEIGHTS_V3: "ambient",
            SEARCH_HORIZON: "99",
            SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "16",
            SIM_NO_ACTIONS: "1",
        });
        expect(environment.PATH).toBe("/bin");
        expect(environment.V07_WAIT_WEIGHTS_V3).toBeUndefined();
        expect(environment.SIM_NO_ACTIONS).toBeUndefined();
        expect(environment).toMatchObject({
            LIVETWIN: "1",
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_GATE: "0.01",
            SEARCH_HORIZON: "4",
            SEARCH_ROLLOUTS: "1",
            SEARCH_SHORTLIST: "3",
            SEARCH_MAX_MELEE: "4",
            SEARCH_MAX_SHOTS: "6",
            SEARCH_MAX_THROWS: "2",
            SEARCH_DECISION_DEADLINE_MS: "200",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0.5",
            SEARCH_AUDIT_TURNS: "1",
        });
    });

    it("removes both wall-clock cutoffs from deterministic ineligible action-hash controls", () => {
        const { manifest } = readPureRangedTerminalManifest();
        const environment = pureRangedTerminalEnvironment(manifest, 1, "deterministic_identity", {});
        expect(environment.SEARCH_DECISION_DEADLINE_MS).toBe("");
        expect(environment.SEARCH_CIRCUIT_BREAKER_MS).toBe("");
        expect(environment.SEARCH_HORIZON).toBe("4");
        expect(environment.SEARCH_SHORTLIST).toBe("3");
    });

    it("rejects unregistered research weights", () => {
        const { manifest } = readPureRangedTerminalManifest();
        expect(() => pureRangedTerminalEnvironment(manifest, 2, "ranged_performance", {})).toThrow(
            "Unregistered pure-ranged terminal weight 2",
        );
    });
});

describe("pure-ranged terminal analysis primitives", () => {
    it("uses paired scenario clusters for confidence intervals", () => {
        const estimate = estimatePureRangedTerminalDelta([0.25, 0.25, -0.25, 0.25]);
        expect(estimate.clusters).toBe(4);
        expect(estimate.mean).toBe(0.125);
        expect(estimate.standardError).toBeCloseTo(0.125, 12);
        expect(estimate.confidence95?.low).toBeCloseTo(0.125 - 1.959963984540054 * 0.125, 12);
    });

    it("selects the highest passing score gain and breaks exact ties toward the lower weight", () => {
        expect(selectPureRangedTerminalWeight([comparison(0.5, 0.04), comparison(1, 0.06)])).toBe(1);
        expect(selectPureRangedTerminalWeight([comparison(1, 0.04), comparison(0.5, 0.04)])).toBe(0.5);
        expect(selectPureRangedTerminalWeight([comparison(0.5, 0.1, false), comparison(1, 0.09, false)])).toBeNull();
    });

    it("fails an external evidence-root audit on any derived scenario collision", () => {
        const { manifest } = readPureRangedTerminalManifest();
        const directory = mkdtempSync(join(tmpdir(), "hoc-pure-terminal-seeds-"));
        temporaryDirectories.push(directory);
        writeFileSync(join(directory, "evidence.txt"), "historical seed 87113710\n");
        expect(() => auditPureRangedTerminalSeedRoots(manifest, [directory])).toThrow(
            "fresh-seed collision(s): 87113710",
        );
    });
});
