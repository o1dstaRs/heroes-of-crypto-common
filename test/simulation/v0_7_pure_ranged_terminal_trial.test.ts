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
    assertPureRangedTerminalRawMatchesSealed,
    auditPureRangedTerminalSeedRoots,
    estimatePureRangedTerminalDelta,
    findPureRangedTerminalSeedCollisions,
    hasPureRangedTerminalCommand,
    isPureRangedTerminalCausalActionChange,
    plannedPureRangedTerminalSeeds,
    probePureRangedTerminalWorkerEnvironment,
    pureRangedTerminalEnvironment,
    pureRangedTerminalRawReportSha256,
    readPureRangedTerminalManifest,
    selectPureRangedTerminalWeight,
    validatePureRangedTerminalManifest,
    validatePureRangedTerminalExactDirectoryEntries,
    validatePureRangedTerminalRawArmSet,
    type IPureRangedTerminalComparison,
    type IPureRangedTerminalManifest,
    type IPureRangedTerminalRawArmIdentity,
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
        causalCandidateActionHashChangedGames: 4,
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
        expect(manifest.scoutGates.circuitOpenGameRateMax).toBe(0);
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

        const circuit = cloneManifest();
        circuit.scoutGates.circuitOpenGameRateMax = 0.01;
        expect(() => validatePureRangedTerminalManifest(circuit)).toThrow("scout gates drifted");

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

    it("installs the frozen profile before static worker policy imports despite a poisoned parent", async () => {
        const { manifest } = readPureRangedTerminalManifest();
        const poison = {
            AUGCA_NOVISION: "1",
            FORCE_CREATURES: "Arbalester,Arbalester,Arbalester,Arbalester,Arbalester,Arbalester",
            ROSTER_RANGED_MIN: "6",
            ROSTER_RANGED_MAX: "6",
            V04_FRONTMOVE: "off",
            V05_AURAFLY: "off",
            V06_KITE: "on",
            V07_DENSE_MM_SALVAGE_ISOLATION: "1",
            SEARCH_HORIZON: "99",
            SIM_NO_ACTIONS: "1",
        } as const;
        const saved = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
        Object.assign(process.env, poison);
        try {
            const evidence = await probePureRangedTerminalWorkerEnvironment(
                manifest,
                0.5,
                "ranged_performance",
                process.env,
            );
            expect(evidence.importTimeBehaviorEnvironment).toEqual(evidence.runtimeBehaviorEnvironment);
            expect(evidence.importTimeBehaviorEnvironment).toMatchObject({
                LIVETWIN: "1",
                V07_SEARCH: "1",
                SEARCH_HORIZON: "4",
                SEARCH_ROLLOUTS: "1",
                SEARCH_SHORTLIST: "3",
                SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0.5",
            });
            for (const key of [
                "AUGCA_NOVISION",
                "FORCE_CREATURES",
                "ROSTER_RANGED_MIN",
                "ROSTER_RANGED_MAX",
                "V04_FRONTMOVE",
                "V05_AURAFLY",
                "V06_KITE",
                "V07_DENSE_MM_SALVAGE_ISOLATION",
                "SIM_NO_ACTIONS",
            ]) {
                expect(evidence.importTimeBehaviorEnvironment[key]).toBeUndefined();
            }
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    }, 30_000);

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

    it("credits changed action hashes only on same-game nonzero leaf exposure with clean timing", () => {
        const control = {
            candidateActionsSha256: "a".repeat(64),
            terminalNonzeroLeaves: 0,
            deadlineFallbacks: 0,
            circuitOpened: false,
        };
        const cleanCandidate = {
            candidateActionsSha256: "b".repeat(64),
            terminalNonzeroLeaves: 2,
            deadlineFallbacks: 0,
            circuitOpened: false,
        };
        expect(isPureRangedTerminalCausalActionChange(control, cleanCandidate)).toBe(true);
        expect(isPureRangedTerminalCausalActionChange(control, { ...cleanCandidate, terminalNonzeroLeaves: 0 })).toBe(
            false,
        );
        expect(isPureRangedTerminalCausalActionChange(control, { ...cleanCandidate, circuitOpened: true })).toBe(false);
        expect(isPureRangedTerminalCausalActionChange({ ...control, circuitOpened: true }, cleanCandidate)).toBe(false);
        expect(isPureRangedTerminalCausalActionChange(control, { ...cleanCandidate, deadlineFallbacks: 1 })).toBe(
            false,
        );
        expect(isPureRangedTerminalCausalActionChange({ ...control, deadlineFallbacks: 1 }, cleanCandidate)).toBe(
            false,
        );
        expect(
            isPureRangedTerminalCausalActionChange(control, {
                ...cleanCandidate,
                candidateActionsSha256: control.candidateActionsSha256,
            }),
        ).toBe(false);
    });

    it("rejects missing, extra, reordered, or miscounted raw-report arms", () => {
        const control: IPureRangedTerminalRawArmIdentity = {
            id: "weight-0",
            phase: "scout",
            weight: 0,
            template: "ranged_precision",
            games: 512,
            timingEnvelope: "ranged_performance",
        };
        const candidate: IPureRangedTerminalRawArmIdentity = {
            ...control,
            id: "weight-0p5",
            weight: 0.5,
        };
        const expected = [control, candidate];
        expect(() => validatePureRangedTerminalRawArmSet(expected, expected, 1_024)).not.toThrow();
        expect(() => validatePureRangedTerminalRawArmSet([control], expected, 512)).toThrow("arm set/order/count");
        expect(() => validatePureRangedTerminalRawArmSet([...expected, candidate], expected, 1_536)).toThrow(
            "arm set/order/count",
        );
        expect(() => validatePureRangedTerminalRawArmSet([candidate, control], expected, 1_024)).toThrow(
            "arm set/order/count",
        );
        expect(() => validatePureRangedTerminalRawArmSet(expected, expected, 512)).toThrow("arm set/order/count");
    });

    it("rejects a mutable raw concatenation that differs from sealed evidence", () => {
        const sealed = '{"game":0}\n{"game":1}\n';
        const sealedSha256 = new Bun.CryptoHasher("sha256").update(sealed).digest("hex");
        expect(() =>
            assertPureRangedTerminalRawMatchesSealed(
                "scout/weight-0/games",
                sealed,
                sealed,
                Buffer.byteLength(sealed),
                sealedSha256,
            ),
        ).not.toThrow();
        expect(() =>
            assertPureRangedTerminalRawMatchesSealed(
                "scout/weight-0/games",
                '{"game":0}\n{"game":2}\n',
                sealed,
                Buffer.byteLength(sealed),
                sealedSha256,
            ),
        ).toThrow("does not match sealed bytes/hash");
    });

    it("rejects dot-prefixed extras in exact evidence directories", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-pure-terminal-exact-dir-"));
        temporaryDirectories.push(directory);
        writeFileSync(join(directory, "expected.jsonl"), "{}\n");
        expect(() => validatePureRangedTerminalExactDirectoryEntries(directory, ["expected.jsonl"])).not.toThrow();

        writeFileSync(join(directory, ".unregistered"), "unexpected\n");
        expect(() => validatePureRangedTerminalExactDirectoryEntries(directory, ["expected.jsonl"])).toThrow(
            "expected exactly",
        );
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

    it("treats a throwing optional-command probe as unavailable", () => {
        expect(
            hasPureRangedTerminalCommand("rg", () => {
                throw new Error("Executable not found in $PATH");
            }),
        ).toBe(false);
        expect(hasPureRangedTerminalCommand("rg", () => ({ status: null, error: new Error("ENOENT") }))).toBe(false);
        expect(hasPureRangedTerminalCommand("rg", () => ({ status: 0 }))).toBe(true);
    });

    it("binds analysis provenance to exact raw-report file bytes", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-pure-terminal-raw-hash-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "scout-raw-report.json");
        const first = '{\n  "verdict": "PASS"\n}\n';
        writeFileSync(path, first);
        expect(pureRangedTerminalRawReportSha256(directory, "scout")).toBe(
            new Bun.CryptoHasher("sha256").update(first).digest("hex"),
        );

        const whitespaceChanged = '{"verdict":"PASS"}\n';
        writeFileSync(path, whitespaceChanged);
        expect(pureRangedTerminalRawReportSha256(directory, "scout")).toBe(
            new Bun.CryptoHasher("sha256").update(whitespaceChanged).digest("hex"),
        );
        expect(new Bun.CryptoHasher("sha256").update(first).digest("hex")).not.toBe(
            new Bun.CryptoHasher("sha256").update(whitespaceChanged).digest("hex"),
        );
    });
});
