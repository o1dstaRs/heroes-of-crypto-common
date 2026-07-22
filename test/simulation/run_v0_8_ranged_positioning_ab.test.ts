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

import { describe, expect, it } from "bun:test";

import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import {
    buildV08RangedPositioningABEnvironment,
    buildV08RangedPositioningABInvocations,
    buildV08RangedPositioningABManifest,
    normalizeV08RangedPositioningCohorts,
    parseV08RangedPositioningABOptions,
    runV08RangedPositioningAB,
    V08_RANGED_POSITIONING_AB_RUNNER,
    V08_RANGED_POSITIONING_AB_VERSIONS,
    type IV08RangedPositioningABOptions,
} from "../../src/simulation/run_v0_8_ranged_positioning_ab";

const BASE_OPTIONS: IV08RangedPositioningABOptions = {
    cohorts: ["hybrid", "ranged_max_sniper3"],
    games: 200,
    seed: 872511,
    concurrency: 12,
    out: "/tmp/hoc-v08-ranged-ab-test",
    mode: "both",
    timingMode: "operational_bounded",
    moveShots: 0,
    diag: false,
};

const argValue = (args: readonly string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};

describe("v0.8 ranged-positioning mirrored A/B runner", () => {
    it("rebinds the exact bounded a13 profile to both seats and scopes only positioning to v0.8", () => {
        const canonical = buildV08A13SearchEnvironment();
        const environment = buildV08RangedPositioningABEnvironment("both", "operational_bounded", {
            PATH: "/bin",
            SEARCH_GATE: "99",
            SEARCH_MAX_MOVE_SHOTS: "2",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8s",
            SEARCH_VERSIONS: "v0.4",
            V08_RANGED_POSITION_VERSIONS: "v0.8s",
            HOSTILE_EXPERIMENT: "1",
        });

        for (const [key, value] of Object.entries(canonical)) {
            if (value === undefined) {
                expect(environment[key]).toBeUndefined();
            } else if (
                [
                    "SEARCH_VERSIONS",
                    "V06_MELEE_DIMS_VERSIONS",
                    "V07_AURA_CASTER_ROUTER_VERSIONS",
                    "V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS",
                    "V07_PLACEMENT_REVEAL_VERSIONS",
                ].includes(key)
            ) {
                expect(environment[key]).toBe(V08_RANGED_POSITIONING_AB_VERSIONS);
            } else {
                expect(environment[key]).toBe(value);
            }
        }
        expect(environment).toMatchObject({
            PATH: "/bin",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_MAX_MOVE_SHOTS: "0",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
            V08_A13_SEARCH: "0",
            V08_RANGED_POSITION_VERSIONS: "v0.8",
            V08_RANGED_POSITION_MODE: "both",
        });
        expect(environment.HOSTILE_EXPERIMENT).toBeUndefined();
    });

    it("makes research timing unbounded without changing the a13 genome or seat scopes", () => {
        const bounded = buildV08RangedPositioningABEnvironment("advance", "operational_bounded", {});
        const unbounded = buildV08RangedPositioningABEnvironment("advance", "research_unbounded", {});
        const differingKeys = [...new Set([...Object.keys(bounded), ...Object.keys(unbounded)])].filter(
            (key) => bounded[key] !== unbounded[key],
        );
        expect(differingKeys.sort()).toEqual(["SEARCH_CIRCUIT_BREAKER_MS", "SEARCH_DECISION_DEADLINE_MS"]);
        expect(unbounded.SEARCH_CIRCUIT_BREAKER_MS).toBe("");
        expect(unbounded.SEARCH_DECISION_DEADLINE_MS).toBe("");
        expect(unbounded.SEARCH_GATE).toBe("0.03");
        expect(unbounded.V08_RANGED_POSITION_MODE).toBe("advance");
    });

    it("invokes measure_mirror_cohorts for every cohort with fixed v0.8/v0.8s paired geometry", () => {
        const invocations = buildV08RangedPositioningABInvocations(BASE_OPTIONS, { PATH: "/bin" });
        expect(V08_RANGED_POSITIONING_AB_RUNNER.endsWith("/measure_mirror_cohorts.ts")).toBe(true);
        expect(invocations.map(({ cohort }) => cohort)).toEqual(["hybrid", "ranged_max_sniper3"]);
        for (const invocation of invocations) {
            expect(invocation.args[0]).toBe(V08_RANGED_POSITIONING_AB_RUNNER);
            expect(argValue(invocation.args, "--cohort")).toBe(invocation.cohort);
            expect(argValue(invocation.args, "--games")).toBe("200");
            expect(argValue(invocation.args, "--seed")).toBe("872511");
            expect(argValue(invocation.args, "--concurrency")).toBe("12");
            expect(argValue(invocation.args, "--amount-mode")).toBe("expBudget");
            expect(argValue(invocation.args, "--livetwin")).toBe("1");
            expect(argValue(invocation.args, "--vA")).toBe("v0.8");
            expect(argValue(invocation.args, "--vB")).toBe("v0.8s");
            expect(invocation.args).not.toContain("--diag");
            expect(argValue(invocation.args, "--out")).toBe(`/tmp/hoc-v08-ranged-ab-test/${invocation.cohort}`);
            expect(invocation.environment.SEARCH_MAX_MOVE_SHOTS).toBe("0");
        }
    });

    it("parses all experiment controls and rejects geometry that would break pair swaps", () => {
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "pure_ranged,hybrid",
                "--games",
                "400",
                "--seed",
                "17",
                "--concurrency",
                "6",
                "--out",
                "/tmp/ranged-ab",
                "--mode",
                "retreat",
                "--move-shots",
                "2",
                "--diag",
                "--timing",
                "research_unbounded",
            ]),
        ).toEqual({
            cohorts: ["pure_ranged", "hybrid"],
            games: 400,
            seed: 17,
            concurrency: 6,
            out: "/tmp/ranged-ab",
            mode: "retreat",
            timingMode: "research_unbounded",
            moveShots: 2,
            diag: true,
        });
        expect(parseV08RangedPositioningABOptions([]).moveShots).toBe(0);
        expect(parseV08RangedPositioningABOptions([]).diag).toBe(false);
        expect(() => parseV08RangedPositioningABOptions(["--games", "3"])).toThrow("paired side swaps");
        expect(() => parseV08RangedPositioningABOptions(["--mode", "unsafe"])).toThrow("--mode");
        expect(() => parseV08RangedPositioningABOptions(["--move-shots", "3"])).toThrow("--move-shots");
        expect(() => parseV08RangedPositioningABOptions(["--move-shots", "1.5"])).toThrow("--move-shots");
        expect(() => normalizeV08RangedPositioningCohorts("hybrid,hybrid")).toThrow("duplicate cohort");
        expect(() => normalizeV08RangedPositioningCohorts("unknown")).toThrow("unknown cohort");
    });

    it("supports advance, retreat, both, and off as explicit seat-scoped arms", () => {
        for (const mode of ["advance", "retreat", "both", "off"] as const) {
            const environment = buildV08RangedPositioningABEnvironment(mode, "operational_bounded", {});
            expect(environment.V08_RANGED_POSITION_MODE).toBe(mode);
            expect(environment.V08_RANGED_POSITION_VERSIONS).toBe("v0.8");
        }
    });

    it("exposes the default-off composite probe at validated caps zero, one, and two", () => {
        for (const moveShots of [0, 1, 2] as const) {
            const environment = buildV08RangedPositioningABEnvironment("off", "operational_bounded", {}, moveShots);
            expect(environment.SEARCH_MAX_MOVE_SHOTS).toBe(String(moveShots));
            expect(environment.SEARCH_MOVE_SHOT_VERSIONS).toBe("v0.8");
        }
        const [probe] = buildV08RangedPositioningABInvocations(
            { ...BASE_OPTIONS, cohorts: ["hybrid"], moveShots: 2, diag: true },
            { PATH: "/bin" },
        );
        expect(probe.environment.SEARCH_MAX_MOVE_SHOTS).toBe("2");
        expect(probe.environment.SEARCH_MOVE_SHOT_VERSIONS).toBe("v0.8");
        expect(probe.args.filter((arg) => arg === "--diag")).toHaveLength(1);
    });

    it("builds a stable, source-bound manifest containing the exact auditable arm", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "off",
            timingMode: "research_unbounded",
            moveShots: 2,
            diag: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, {
            PATH: "/bin",
            SEARCH_MAX_MOVE_SHOTS: "0",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8s",
        });
        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: true } as const;
        const first = buildV08RangedPositioningABManifest(invocation, options, source);
        const second = buildV08RangedPositioningABManifest(invocation, options, source);

        expect(first).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v1",
            source,
            geometry: {
                cohort: "hybrid",
                games: 200,
                seed: 872511,
                concurrency: 12,
                amountMode: "expBudget",
                livetwin: true,
                pairedSideSwap: true,
                symmetricRosters: true,
            },
            arm: {
                mode: "off",
                timingMode: "research_unbounded",
                moveShots: 2,
                diag: true,
                candidateVersion: "v0.8",
                controlVersion: "v0.8s",
            },
            artifacts: { summary: "/tmp/hoc-v08-ranged-ab-test/hybrid.summary.json" },
        });
        expect(first.behaviorEnvironment).toMatchObject({
            SEARCH_GATE: "0.03",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_DECISION_DEADLINE_MS: "",
            SEARCH_CIRCUIT_BREAKER_MS: "",
            SEARCH_MAX_MOVE_SHOTS: "2",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
            V08_RANGED_POSITION_MODE: "off",
            V08_RANGED_POSITION_VERSIONS: "v0.8",
        });
        expect(first.behaviorEnvironment.PATH).toBeUndefined();
        expect(Object.keys(first.behaviorEnvironment)).toEqual(Object.keys(first.behaviorEnvironment).sort());
        expect(first.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(second.fingerprintSha256).toBe(first.fingerprintSha256);

        const [changedInvocation] = buildV08RangedPositioningABInvocations(
            { ...options, moveShots: 1 },
            { PATH: "/bin" },
        );
        expect(
            buildV08RangedPositioningABManifest(changedInvocation, { ...options, moveShots: 1 }, source)
                .fingerprintSha256,
        ).not.toBe(first.fingerprintSha256);

        const [noDiagInvocation] = buildV08RangedPositioningABInvocations(
            { ...options, diag: false },
            { PATH: "/bin" },
        );
        const noDiagManifest = buildV08RangedPositioningABManifest(
            noDiagInvocation,
            { ...options, diag: false },
            source,
        );
        expect(noDiagManifest.arm.diag).toBe(false);
        expect(noDiagManifest.fingerprintSha256).not.toBe(first.fingerprintSha256);
    });

    it("runs cohort children sequentially and fails closed on a nonzero child", async () => {
        const seen: string[] = [];
        const manifests: Array<{ path: string; fingerprint: string }> = [];
        await runV08RangedPositioningAB(BASE_OPTIONS, {
            runChild: async (invocation) => {
                seen.push(invocation.cohort);
                return 0;
            },
            discoverSourceIdentity: () => ({ head: "c".repeat(40), tree: "d".repeat(40), dirty: false }),
            writeManifest: (path, manifest) => manifests.push({ path, fingerprint: manifest.fingerprintSha256 }),
        });
        expect(seen).toEqual(["hybrid", "ranged_max_sniper3"]);
        expect(manifests.map(({ path }) => path)).toEqual([
            "/tmp/hoc-v08-ranged-ab-test/hybrid.experiment.json",
            "/tmp/hoc-v08-ranged-ab-test/ranged_max_sniper3.experiment.json",
        ]);
        expect(manifests.every(({ fingerprint: value }) => /^[a-f0-9]{64}$/.test(value))).toBe(true);

        let wroteFailedManifest = false;
        await expect(
            runV08RangedPositioningAB(BASE_OPTIONS, {
                runChild: async (invocation) => (invocation.cohort === "hybrid" ? 7 : 0),
                discoverSourceIdentity: () => ({ head: null, tree: null, dirty: null }),
                writeManifest: () => {
                    wroteFailedManifest = true;
                },
            }),
        ).rejects.toThrow("hybrid exited with code 7");
        expect(wroteFailedManifest).toBe(false);
    });
});
