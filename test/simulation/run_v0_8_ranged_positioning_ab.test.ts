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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, spyOn } from "bun:test";

import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import {
    buildV08RangedPositioningABEnvironment,
    buildV08RangedPositioningABInvocations,
    buildV08RangedPositioningABManifest,
    main,
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
    noMeleeTerminalPressure: false,
    deadlineFinisher: false,
    paretoNoMeleeFocus: false,
    paretoNoMeleeFocusCatalogOnly: false,
    paretoNoMeleeFocusDamageFloor: 1,
    paretoNoMeleeFocusScope: "pure_ranged",
    jitNoMeleeFocus: false,
    jitNoMeleeFocusCatalogOnly: false,
    supportedRangedDelta: false,
    supportedRangedDeltaCatalogOnly: false,
    supportedRangedDeltaLiveOnly: false,
    responseNeutralAdvance: false,
    supportedPrepinEgress: false,
    supportedPrepinEgressCatalogOnly: false,
    supportedPrepinEgressLiveOnly: false,
    supportedBandAdvance: false,
    supportedBandAdvanceCatalogOnly: false,
    supportedBandAdvanceLiveOnly: false,
    supportedBandAdvanceVsLegacy: false,
    supportedBandAdvanceOverlayVsLegacy: false,
    supportedBandAdvanceOverlayControl: false,
    supportedBandAdvanceDominanceOverlay: false,
    supportedBandAdvanceDominanceOverlayControl: false,
    supportedBandScreenedCloserOverlay: false,
    supportedBandScreenedCloserOverlayControl: false,
    supportedBandDecisiveScreenedCloserOverlay: false,
    supportedBandDecisiveScreenedCloserOverlayControl: false,
    protectedAdvanceGuardrails: false,
    protectedAdvanceGuardrailsMode: "both",
    diag: false,
};

const argValue = (args: readonly string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};

const createScreenedCloserReceipt = (
    contents = `${JSON.stringify({
        schema: "hoc.supported_band_screened_closer_prelaunch_receipt.v1",
        hypothesis: "Prefer an otherwise-equal closer native-screened route.",
    })}\n`,
): { path: string; contents: string } => {
    const directory = mkdtempSync(join(tmpdir(), "hoc-screened-closer-receipt-"));
    const path = join(directory, "prelaunch-receipt.json");
    writeFileSync(path, contents);
    chmodSync(path, 0o444);
    return { path, contents };
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
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "pure_ranged",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            V08_A13_SEARCH: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
            V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "",
            V08_RANGED_POSITION_VERSIONS: "v0.8",
            V08_RANGED_POSITION_MODE: "both",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "0",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY: "0",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS: "0",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "0",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "",
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
            expect(invocation.environment.SEARCH_AUDIT).toBe("0");
            expect(invocation.searchAuditPath).toBeUndefined();
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
            noMeleeTerminalPressure: false,
            deadlineFinisher: false,
            paretoNoMeleeFocus: false,
            paretoNoMeleeFocusCatalogOnly: false,
            paretoNoMeleeFocusDamageFloor: 1,
            paretoNoMeleeFocusScope: "pure_ranged",
            jitNoMeleeFocus: false,
            jitNoMeleeFocusCatalogOnly: false,
            supportedRangedDelta: false,
            supportedRangedDeltaCatalogOnly: false,
            supportedRangedDeltaLiveOnly: false,
            responseNeutralAdvance: false,
            supportedPrepinEgress: false,
            supportedPrepinEgressCatalogOnly: false,
            supportedPrepinEgressLiveOnly: false,
            supportedBandAdvance: false,
            supportedBandAdvanceCatalogOnly: false,
            supportedBandAdvanceLiveOnly: false,
            supportedBandAdvanceVsLegacy: false,
            supportedBandAdvanceOverlayVsLegacy: false,
            supportedBandAdvanceOverlayControl: false,
            supportedBandAdvanceDominanceOverlay: false,
            supportedBandAdvanceDominanceOverlayControl: false,
            supportedBandScreenedCloserOverlay: false,
            supportedBandScreenedCloserOverlayControl: false,
            supportedBandDecisiveScreenedCloserOverlay: false,
            supportedBandDecisiveScreenedCloserOverlayControl: false,
            prelaunchReceipt: undefined,
            protectedAdvanceGuardrails: false,
            protectedAdvanceGuardrailsMode: "both",
            diag: true,
        });
        expect(parseV08RangedPositioningABOptions([]).moveShots).toBe(0);
        expect(parseV08RangedPositioningABOptions([]).noMeleeTerminalPressure).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).deadlineFinisher).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).paretoNoMeleeFocus).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).paretoNoMeleeFocusCatalogOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).paretoNoMeleeFocusDamageFloor).toBe(1);
        expect(parseV08RangedPositioningABOptions([]).paretoNoMeleeFocusScope).toBe("pure_ranged");
        expect(parseV08RangedPositioningABOptions([]).jitNoMeleeFocus).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).jitNoMeleeFocusCatalogOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedRangedDelta).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedRangedDeltaCatalogOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedRangedDeltaLiveOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).responseNeutralAdvance).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedPrepinEgress).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedPrepinEgressCatalogOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedPrepinEgressLiveOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvance).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceCatalogOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceLiveOnly).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceVsLegacy).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceOverlayVsLegacy).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceOverlayControl).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceDominanceOverlay).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandAdvanceDominanceOverlayControl).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandScreenedCloserOverlay).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandScreenedCloserOverlayControl).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandDecisiveScreenedCloserOverlay).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).supportedBandDecisiveScreenedCloserOverlayControl).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).prelaunchReceipt).toBeUndefined();
        expect(parseV08RangedPositioningABOptions([]).protectedAdvanceGuardrails).toBe(false);
        expect(parseV08RangedPositioningABOptions([]).protectedAdvanceGuardrailsMode).toBe("both");
        expect(parseV08RangedPositioningABOptions([]).diag).toBe(false);
        expect(() => parseV08RangedPositioningABOptions(["--games", "3"])).toThrow("paired side swaps");
        expect(() => parseV08RangedPositioningABOptions(["--mode", "unsafe"])).toThrow("--mode");
        expect(() => parseV08RangedPositioningABOptions(["--move-shots", "3"])).toThrow("--move-shots");
        expect(() => parseV08RangedPositioningABOptions(["--move-shots", "1.5"])).toThrow("--move-shots");
        expect(() => normalizeV08RangedPositioningCohorts("hybrid,hybrid")).toThrow("duplicate cohort");
        expect(() => normalizeV08RangedPositioningCohorts("unknown")).toThrow("unknown cohort");
        expect(normalizeV08RangedPositioningCohorts("mixed_cyclops_tsar")).toEqual(["mixed_cyclops_tsar"]);
        expect(parseV08RangedPositioningABOptions(["--cohorts", "mixed_cyclops_tsar"]).cohorts).toEqual([
            "mixed_cyclops_tsar",
        ]);
    });

    it("advertises the mixed_cyclops_tsar measurement cohort in help", async () => {
        const log = spyOn(console, "log").mockImplementation(() => undefined);
        try {
            await main(["--help"]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(String(log.mock.calls[0]?.[0])).toContain("mixed_cyclops_tsar");
            expect(String(log.mock.calls[0]?.[0])).toContain("mixed_supported");
            expect(String(log.mock.calls[0]?.[0])).toContain("supported-band-overlay-control");
            expect(String(log.mock.calls[0]?.[0])).toContain("supported-band-dominance-overlay");
            expect(String(log.mock.calls[0]?.[0])).toContain("supported-band-dominance-overlay-control");
            expect(String(log.mock.calls[0]?.[0])).toContain("supported-band-screened-closer-overlay");
            expect(String(log.mock.calls[0]?.[0])).toContain("supported-band-decisive-screened-closer-overlay");
            expect(String(log.mock.calls[0]?.[0])).toContain("prelaunch-receipt");
        } finally {
            log.mockRestore();
        }
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

    it("exposes a candidate-only terminal-pressure arm and rejects confounded runner geometry", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            mode: "off",
            moveShots: 0,
            noMeleeTerminalPressure: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });
        expect(invocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "1",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
            SEARCH_VERSIONS: "v0.8,v0.8s",
        });
        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest.arm.noMeleeTerminalPressure).toBe(true);
        expect(manifest.behaviorEnvironment.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE).toBe("1");
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "pure_ranged",
                "--mode",
                "off",
                "--no-melee-terminal-pressure",
            ]).noMeleeTerminalPressure,
        ).toBe(true);
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...options, cohorts: ["pure_ranged", "hybrid"] }),
        ).toThrow("requires cohorts=pure_ranged");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "advance" })).toThrow("mode=off");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, moveShots: 1 })).toThrow("moveShots=0");
    });

    it("exposes the candidate-only pure-ranged deadline finisher with isolated geometry", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            mode: "off",
            deadlineFinisher: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });
        expect(invocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "1",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_VERSIONS: "v0.8,v0.8s",
        });
        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest.arm.deadlineFinisher).toBe(true);
        expect(manifest.arm.noMeleeTerminalPressure).toBe(false);
        expect(
            parseV08RangedPositioningABOptions(["--cohorts", "pure_ranged", "--mode", "off", "--deadline-finisher"])
                .deadlineFinisher,
        ).toBe(true);
        expect(() => buildV08RangedPositioningABInvocations({ ...options, cohorts: ["hybrid"] })).toThrow(
            "requires cohorts=pure_ranged",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "retreat" })).toThrow("mode=off");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, moveShots: 1 })).toThrow("moveShots=0");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, noMeleeTerminalPressure: true })).toThrow(
            "mutually exclusive",
        );
        expect(() => buildV08RangedPositioningABEnvironment("off", "operational_bounded", {}, 0, true, true)).toThrow(
            "mutually exclusive",
        );
    });

    it("exposes Pareto No-Melee focus as a default-off, candidate-only pure-ranged arm", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            mode: "off",
            paretoNoMeleeFocus: true,
            paretoNoMeleeFocusDamageFloor: 0.95,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });
        expect(invocation.searchAuditPath).toBe("/tmp/hoc-v08-ranged-ab-test/pure_ranged.search-audit.jsonl");
        expect(invocation.environment).toMatchObject({
            SEARCH_AUDIT: invocation.searchAuditPath,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "0.95",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
            SEARCH_VERSIONS: "v0.8,v0.8s",
        });
        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest.arm.paretoNoMeleeFocus).toBe(true);
        expect(manifest.arm.paretoNoMeleeFocusDamageFloor).toBe(0.95);
        expect(manifest.arm.paretoNoMeleeFocusScope).toBe("pure_ranged");
        expect(manifest.artifacts.searchAudit).toBe(invocation.searchAuditPath);
        expect(manifest.behaviorEnvironment.SEARCH_AUDIT).toBeUndefined();
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "pure_ranged",
                "--mode",
                "off",
                "--pareto-no-melee-focus",
                "--pareto-damage-floor",
                "0.95",
            ]),
        ).toMatchObject({ paretoNoMeleeFocus: true, paretoNoMeleeFocusDamageFloor: 0.95 });
        expect(() => parseV08RangedPositioningABOptions(["--pareto-damage-floor", "0.95"])).toThrow(
            "requires paretoNoMeleeFocus",
        );
        expect(() =>
            parseV08RangedPositioningABOptions(["--pareto-no-melee-focus", "--pareto-damage-floor", "0.89"]),
        ).toThrow("must be one of 0.9, 0.95, or 1");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, cohorts: ["hybrid"] })).toThrow(
            "requires cohorts=pure_ranged",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "advance" })).toThrow("mode=off");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, moveShots: 1 })).toThrow("moveShots=0");
        for (const conflictingArm of [
            { noMeleeTerminalPressure: true },
            { deadlineFinisher: true },
            { supportedRangedDelta: true },
            { responseNeutralAdvance: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...options, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
        expect(() =>
            buildV08RangedPositioningABEnvironment(
                "off",
                "operational_bounded",
                {},
                0,
                false,
                false,
                false,
                false,
                true,
            ),
        ).not.toThrow();
    });

    it("manifests a catalog-matched selector-off Pareto control", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            mode: "off",
            paretoNoMeleeFocusCatalogOnly: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });
        expect(invocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "catalog-only-control",
        });
        expect(invocation.searchAuditPath).toBe("/tmp/hoc-v08-ranged-ab-test/pure_ranged.search-audit.jsonl");
        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest.arm).toMatchObject({
            paretoNoMeleeFocus: false,
            paretoNoMeleeFocusCatalogOnly: true,
            paretoNoMeleeFocusDamageFloor: 1,
            paretoNoMeleeFocusScope: "pure_ranged",
        });
        expect(manifest.behaviorEnvironment.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS).toBe(
            "catalog-only-control",
        );
        expect(
            parseV08RangedPositioningABOptions(["--cohorts", "pure_ranged", "--mode", "off", "--pareto-catalog-only"])
                .paretoNoMeleeFocusCatalogOnly,
        ).toBe(true);
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...options,
                paretoNoMeleeFocus: true,
            }),
        ).toThrow("mutually exclusive");
    });

    it("widens exact Pareto catalogs to any cohort while keeping selection scoped to v0.8", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid", "ranged_max_sniper3"],
            mode: "off",
            paretoNoMeleeFocus: true,
            paretoNoMeleeFocusScope: "any_board",
            paretoNoMeleeFocusDamageFloor: 1,
        };
        const invocations = buildV08RangedPositioningABInvocations(options, {
            PATH: "/bin",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "hostile",
        });
        expect(invocations.map(({ cohort }) => cohort)).toEqual(["hybrid", "ranged_max_sniper3"]);
        for (const invocation of invocations) {
            expect(invocation.environment).toMatchObject({
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1",
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "1",
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "any_board",
            });
        }
        const manifest = buildV08RangedPositioningABManifest(invocations[0], options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                paretoNoMeleeFocus: true,
                paretoNoMeleeFocusScope: "any_board",
                paretoNoMeleeFocusDamageFloor: 1,
                candidateVersion: "v0.8",
                controlVersion: "v0.8s",
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "off",
                "--pareto-no-melee-focus",
                "--pareto-scope",
                "any_board",
            ]),
        ).toMatchObject({ paretoNoMeleeFocus: true, paretoNoMeleeFocusScope: "any_board" });
        expect(() =>
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "off",
                "--pareto-no-melee-focus",
                "--pareto-scope",
                "any_board",
                "--pareto-damage-floor",
                "0.95",
            ]),
        ).toThrow("requires paretoNoMeleeFocusDamageFloor=1");
        expect(() => parseV08RangedPositioningABOptions(["--pareto-scope", "any_board"])).toThrow(
            "requires paretoNoMeleeFocus",
        );
        expect(() => parseV08RangedPositioningABOptions(["--pareto-scope", "invalid"])).toThrow("--pareto-scope");
    });

    it("routes the fixed mixed_cyclops_tsar cohort through the screened exact-Pareto v13 protocol", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["mixed_cyclops_tsar"],
            mode: "off",
            paretoNoMeleeFocus: true,
            paretoNoMeleeFocusScope: "mixed_supported",
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });

        expect(argValue(invocation.args, "--cohort")).toBe("mixed_cyclops_tsar");
        expect(argValue(invocation.args, "--amount-mode")).toBe("expBudget");
        expect(argValue(invocation.args, "--livetwin")).toBe("1");
        expect(argValue(invocation.args, "--vA")).toBe("v0.8");
        expect(argValue(invocation.args, "--vB")).toBe("v0.8s");
        expect(invocation.outBase).toBe("/tmp/hoc-v08-ranged-ab-test/mixed_cyclops_tsar");
        expect(invocation.searchAuditPath).toBe("/tmp/hoc-v08-ranged-ab-test/mixed_cyclops_tsar.search-audit.jsonl");
        expect(invocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "1",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "mixed_supported",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
        });

        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            geometry: {
                cohort: "mixed_cyclops_tsar",
                amountMode: "expBudget",
                livetwin: true,
                pairedSideSwap: true,
                symmetricRosters: true,
            },
            arm: {
                paretoNoMeleeFocus: true,
                paretoNoMeleeFocusDamageFloor: 1,
                paretoNoMeleeFocusScope: "mixed_supported",
                candidateVersion: "v0.8",
                controlVersion: "v0.8s",
            },
            artifacts: {
                summary: "/tmp/hoc-v08-ranged-ab-test/mixed_cyclops_tsar.summary.json",
                searchAudit: "/tmp/hoc-v08-ranged-ab-test/mixed_cyclops_tsar.search-audit.jsonl",
            },
        });
        expect(manifest.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "mixed_cyclops_tsar",
                "--mode",
                "off",
                "--pareto-no-melee-focus",
                "--pareto-scope",
                "mixed_supported",
            ]),
        ).toMatchObject({
            paretoNoMeleeFocus: true,
            paretoNoMeleeFocusScope: "mixed_supported",
            paretoNoMeleeFocusDamageFloor: 1,
        });
        expect(() =>
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "mixed_cyclops_tsar",
                "--mode",
                "off",
                "--pareto-no-melee-focus",
                "--pareto-scope",
                "mixed_supported",
                "--pareto-damage-floor",
                "0.95",
            ]),
        ).toThrow("mixed_supported requires paretoNoMeleeFocusDamageFloor=1");
        expect(() => parseV08RangedPositioningABOptions(["--pareto-scope", "mixed_supported"])).toThrow(
            "mixed_supported requires paretoNoMeleeFocus",
        );

        const [catalogOnly] = buildV08RangedPositioningABInvocations(
            { ...options, paretoNoMeleeFocus: false, paretoNoMeleeFocusCatalogOnly: true },
            { PATH: "/bin" },
        );
        expect(catalogOnly.environment).toMatchObject({
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "mixed_supported",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "catalog-only-control",
        });
    });

    it("exposes fixed JIT No-Melee treatment and catalog-only control with isolated geometry", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            mode: "off",
            jitNoMeleeFocus: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(treatment, { PATH: "/bin" });
        expect(invocation.searchAuditPath).toBe("/tmp/hoc-v08-ranged-ab-test/pure_ranged.search-audit.jsonl");
        expect(invocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "1",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
            SEARCH_VERSIONS: "v0.8,v0.8s",
        });
        const manifest = buildV08RangedPositioningABManifest(invocation, treatment, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                jitNoMeleeFocus: true,
                jitNoMeleeFocusCatalogOnly: false,
                jitNoMeleeFocusStartLap: 1,
                jitNoMeleeFocusLastLap: 11,
                jitNoMeleeFocusActivationBuffer: 1,
                jitNoMeleeFocusDamageFloor: 0.8,
                paretoNoMeleeFocus: false,
            },
            artifacts: { searchAudit: invocation.searchAuditPath },
        });
        expect(
            parseV08RangedPositioningABOptions(["--cohorts", "pure_ranged", "--mode", "off", "--jit-no-melee-focus"])
                .jitNoMeleeFocus,
        ).toBe(true);

        const control = { ...treatment, jitNoMeleeFocus: false, jitNoMeleeFocusCatalogOnly: true };
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, { PATH: "/bin" });
        expect(controlInvocation.environment).toMatchObject({
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "1",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "jit-catalog-only-control",
        });
        expect(buildV08RangedPositioningABManifest(controlInvocation, control, manifest.source).arm).toMatchObject({
            jitNoMeleeFocus: false,
            jitNoMeleeFocusCatalogOnly: true,
            jitNoMeleeFocusStartLap: 1,
            jitNoMeleeFocusLastLap: 11,
            jitNoMeleeFocusActivationBuffer: 1,
            jitNoMeleeFocusDamageFloor: 0.8,
        });
        expect(
            parseV08RangedPositioningABOptions(["--cohorts", "pure_ranged", "--mode", "off", "--jit-catalog-only"])
                .jitNoMeleeFocusCatalogOnly,
        ).toBe(true);

        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, cohorts: ["hybrid"] })).toThrow(
            "requires cohorts=pure_ranged",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "advance" })).toThrow("mode=off");
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, moveShots: 1 })).toThrow("moveShots=0");
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, paretoNoMeleeFocus: true })).toThrow(
            "mutually exclusive",
        );
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...treatment, jitNoMeleeFocusCatalogOnly: true }),
        ).toThrow("mutually exclusive");
    });

    it("isolates live-root supported ranged escape with a catalog-identical selector-off control", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "retreat",
            supportedRangedDelta: true,
            supportedRangedDeltaLiveOnly: true,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedRangedDelta: false,
            supportedRangedDeltaCatalogOnly: true,
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, { PATH: "/bin" });
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, { PATH: "/bin" });
        expect(treatmentInvocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "retreat",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY: "1",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "v0.8",
        });
        expect(controlInvocation.environment).toMatchObject({
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY: "1",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "supported-ranged-delta-catalog-only-control",
        });
        const differingEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ].filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key]);
        expect(differingEnvironmentKeys).toEqual(["V08_SUPPORTED_RANGED_DELTA_VERSIONS"]);

        const source = {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        } as const;
        expect(buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source)).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedRangedDelta: true,
                supportedRangedDeltaCatalogOnly: false,
                supportedRangedDeltaLiveOnly: true,
            },
        });
        expect(buildV08RangedPositioningABManifest(controlInvocation, control, source)).toMatchObject({
            arm: {
                supportedRangedDelta: false,
                supportedRangedDeltaCatalogOnly: true,
                supportedRangedDeltaLiveOnly: true,
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "retreat",
                "--supported-ranged-delta",
                "--supported-ranged-delta-live-only",
            ]),
        ).toMatchObject({ supportedRangedDelta: true, supportedRangedDeltaLiveOnly: true });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "retreat",
                "--supported-ranged-delta-catalog-only",
                "--supported-ranged-delta-live-only",
            ]),
        ).toMatchObject({ supportedRangedDeltaCatalogOnly: true, supportedRangedDeltaLiveOnly: true });
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "advance" })).toThrow(
            "mode=retreat|both",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "off" })).toThrow(
            "mode=retreat|both",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, moveShots: 1 })).toThrow("moveShots=0");
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...treatment, supportedRangedDeltaCatalogOnly: true }),
        ).toThrow("mutually exclusive");
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, deadlineFinisher: true })).toThrow(
            "mutually exclusive",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, noMeleeTerminalPressure: true })).toThrow(
            "mutually exclusive",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "both" })).not.toThrow();
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...BASE_OPTIONS,
                cohorts: ["hybrid"],
                mode: "retreat",
                supportedRangedDeltaLiveOnly: true,
            }),
        ).toThrow("requires a supported ranged");
        expect(() =>
            buildV08RangedPositioningABEnvironment("off", "operational_bounded", {}, 0, false, false, true),
        ).toThrow("mode=retreat|both");
    });

    it("compares response-neutral advance against the same shipped positioning baseline", () => {
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "advance",
            responseNeutralAdvance: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(options, { PATH: "/bin" });
        expect(invocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "advance",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "v0.8",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "",
        });
        const manifest = buildV08RangedPositioningABManifest(invocation, options, {
            head: "a".repeat(40),
            tree: "b".repeat(40),
            dirty: false,
        });
        expect(manifest.arm.responseNeutralAdvance).toBe(true);
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "advance",
                "--response-neutral-advance",
            ]).responseNeutralAdvance,
        ).toBe(true);
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "retreat" })).toThrow(
            "mode=advance|both",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "off" })).toThrow("mode=advance|both");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, moveShots: 1 })).toThrow("moveShots=0");
        expect(() => buildV08RangedPositioningABInvocations({ ...options, supportedRangedDelta: true })).toThrow(
            "mutually exclusive",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...options, mode: "both" })).not.toThrow();
        expect(() =>
            buildV08RangedPositioningABEnvironment("retreat", "operational_bounded", {}, 0, false, false, false, true),
        ).toThrow("mode=advance|both");
    });

    it("isolates live-root pre-pin egress with a catalog-identical selector-off control", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "retreat",
            supportedPrepinEgress: true,
            supportedPrepinEgressLiveOnly: true,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedPrepinEgress: false,
            supportedPrepinEgressCatalogOnly: true,
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, { PATH: "/bin" });
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, { PATH: "/bin" });

        expect(treatmentInvocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "retreat",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_PREPIN_EGRESS: "1",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "1",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "v0.8",
        });
        expect(controlInvocation.environment).toMatchObject({
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_PREPIN_EGRESS: "1",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "1",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "supported-prepin-egress-catalog-only-control",
        });
        const differingEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ].filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key]);
        expect(differingEnvironmentKeys).toEqual(["V08_SUPPORTED_PREPIN_EGRESS_VERSIONS"]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        expect(buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source)).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedPrepinEgress: true,
                supportedPrepinEgressCatalogOnly: false,
                supportedPrepinEgressLiveOnly: true,
            },
        });
        expect(buildV08RangedPositioningABManifest(controlInvocation, control, source)).toMatchObject({
            arm: {
                supportedPrepinEgress: false,
                supportedPrepinEgressCatalogOnly: true,
                supportedPrepinEgressLiveOnly: true,
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "retreat",
                "--supported-prepin-egress",
                "--supported-prepin-live-only",
            ]).supportedPrepinEgress,
        ).toBe(true);
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "retreat",
                "--supported-prepin-egress",
                "--supported-prepin-live-only",
            ]).supportedPrepinEgressLiveOnly,
        ).toBe(true);
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-prepin-catalog-only",
            ]).supportedPrepinEgressCatalogOnly,
        ).toBe(true);

        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "advance" })).toThrow(
            "mode=retreat|both",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "off" })).toThrow(
            "mode=retreat|both",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, moveShots: 1 })).toThrow("moveShots=0");
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...treatment, supportedPrepinEgressCatalogOnly: true }),
        ).toThrow("mutually exclusive");
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, supportedRangedDelta: true })).toThrow(
            "mutually exclusive",
        );
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode: "both" })).not.toThrow();
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...BASE_OPTIONS,
                cohorts: ["hybrid"],
                mode: "retreat",
                supportedPrepinEgressLiveOnly: true,
            }),
        ).toThrow("requires a supported pre-pin");
    });

    it("isolates live-root supported-band advance with a catalog-identical selector-off control", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvance: true,
            supportedBandAdvanceLiveOnly: true,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedBandAdvance: false,
            supportedBandAdvanceCatalogOnly: true,
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, { PATH: "/bin" });
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, { PATH: "/bin" });

        expect(treatmentInvocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
        });
        expect(controlInvocation.environment).toMatchObject({
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "supported-band-advance-catalog-only-control",
        });
        const differingEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ].filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key]);
        expect(differingEnvironmentKeys).toEqual(["V08_SUPPORTED_BAND_ADVANCE_VERSIONS"]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        expect(buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source)).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvance: true,
                supportedBandAdvanceCatalogOnly: false,
                supportedBandAdvanceLiveOnly: true,
            },
        });
        expect(buildV08RangedPositioningABManifest(controlInvocation, control, source)).toMatchObject({
            arm: {
                supportedBandAdvance: false,
                supportedBandAdvanceCatalogOnly: true,
                supportedBandAdvanceLiveOnly: true,
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-advance",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({ supportedBandAdvance: true, supportedBandAdvanceLiveOnly: true });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-catalog-only",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({ supportedBandAdvanceCatalogOnly: true, supportedBandAdvanceLiveOnly: true });

        for (const mode of ["advance", "retreat", "off"] as const) {
            expect(() => buildV08RangedPositioningABInvocations({ ...treatment, mode })).toThrow("mode=both");
        }
        expect(() => buildV08RangedPositioningABInvocations({ ...treatment, moveShots: 1 })).toThrow("moveShots=0");
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...treatment, supportedBandAdvanceCatalogOnly: true }),
        ).toThrow("mutually exclusive");
        for (const conflictingArm of [
            { noMeleeTerminalPressure: true },
            { deadlineFinisher: true },
            { paretoNoMeleeFocus: true },
            { paretoNoMeleeFocusCatalogOnly: true },
            { jitNoMeleeFocus: true },
            { jitNoMeleeFocusCatalogOnly: true },
            { supportedRangedDelta: true },
            { responseNeutralAdvance: true },
            { supportedPrepinEgress: true },
            { supportedPrepinEgressCatalogOnly: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...treatment, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...BASE_OPTIONS,
                cohorts: ["hybrid"],
                mode: "both",
                supportedBandAdvanceLiveOnly: true,
            }),
        ).toThrow("requires a supported-band");
    });

    it("configures a sealed live-root strict-versus-shipped-legacy duel", () => {
        const duel: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvanceLiveOnly: true,
            supportedBandAdvanceVsLegacy: true,
            diag: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(duel, {
            PATH: "/bin",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "hostile",
        });

        expect(invocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "",
        });
        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const manifest = buildV08RangedPositioningABManifest(invocation, duel, source);
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvance: false,
                supportedBandAdvanceCatalogOnly: false,
                supportedBandAdvanceLiveOnly: true,
                supportedBandAdvanceVsLegacy: true,
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-vs-legacy",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({ supportedBandAdvanceVsLegacy: true, supportedBandAdvanceLiveOnly: true });

        expect(() => buildV08RangedPositioningABInvocations({ ...duel, supportedBandAdvanceLiveOnly: false })).toThrow(
            "requires supportedBandAdvanceLiveOnly",
        );
        for (const mode of ["advance", "retreat", "off"] as const) {
            expect(() => buildV08RangedPositioningABInvocations({ ...duel, mode })).toThrow("mode=both");
        }
        expect(() => buildV08RangedPositioningABInvocations({ ...duel, moveShots: 1 })).toThrow("moveShots=0");
        for (const conflictingArm of [
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceOverlayVsLegacy: true },
            { supportedBandAdvanceOverlayControl: true },
            { noMeleeTerminalPressure: true },
            { deadlineFinisher: true },
            { paretoNoMeleeFocus: true },
            { paretoNoMeleeFocusCatalogOnly: true },
            { jitNoMeleeFocus: true },
            { jitNoMeleeFocusCatalogOnly: true },
            { supportedRangedDelta: true },
            { responseNeutralAdvance: true },
            { supportedPrepinEgress: true },
            { supportedPrepinEgressCatalogOnly: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...duel, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
    });

    it("configures a distinct live-root supported-band overlay against shipped legacy", () => {
        const overlay: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvanceLiveOnly: true,
            supportedBandAdvanceOverlayVsLegacy: true,
            diag: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(overlay, {
            PATH: "/bin",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "v0.6",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "v0.7",
        });

        expect(invocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "",
        });
        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const manifest = buildV08RangedPositioningABManifest(invocation, overlay, source);
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvance: false,
                supportedBandAdvanceCatalogOnly: false,
                supportedBandAdvanceLiveOnly: true,
                supportedBandAdvanceVsLegacy: false,
                supportedBandAdvanceOverlayVsLegacy: true,
                supportedBandAdvanceOverlayControl: false,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
                V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
                V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "v0.8",
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-overlay-vs-legacy",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({
            supportedBandAdvanceOverlayVsLegacy: true,
            supportedBandAdvanceVsLegacy: false,
            supportedBandAdvanceLiveOnly: true,
        });

        expect(() =>
            buildV08RangedPositioningABInvocations({ ...overlay, supportedBandAdvanceLiveOnly: false }),
        ).toThrow("requires supportedBandAdvanceLiveOnly");
        for (const mode of ["advance", "retreat", "off"] as const) {
            expect(() => buildV08RangedPositioningABInvocations({ ...overlay, mode })).toThrow("mode=both");
        }
        expect(() => buildV08RangedPositioningABInvocations({ ...overlay, moveShots: 1 })).toThrow("moveShots=0");
        for (const conflictingArm of [
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceVsLegacy: true },
            { supportedBandAdvanceOverlayControl: true },
            { protectedAdvanceGuardrails: true },
            { noMeleeTerminalPressure: true },
            { deadlineFinisher: true },
            { paretoNoMeleeFocus: true },
            { paretoNoMeleeFocusCatalogOnly: true },
            { jitNoMeleeFocus: true },
            { jitNoMeleeFocusCatalogOnly: true },
            { supportedRangedDelta: true },
            { responseNeutralAdvance: true },
            { supportedPrepinEgress: true },
            { supportedPrepinEgressCatalogOnly: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...overlay, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
    });

    it("matches the overlay selector-off control to treatment except for its sealed control selector", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvanceLiveOnly: true,
            supportedBandAdvanceOverlayVsLegacy: true,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedBandAdvanceOverlayVsLegacy: false,
            supportedBandAdvanceOverlayControl: true,
        };
        const hostileEnvironment = {
            PATH: "/bin",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "v0.7",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "hostile",
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, hostileEnvironment);
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, hostileEnvironment);

        const expectedCommonEnvironment = {
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
        };
        expect(treatmentInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
        });
        expect(controlInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "v0.8",
        });
        const changedEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ]
            .filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key])
            .sort();
        expect(changedEnvironmentKeys).toEqual(["V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS"]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const treatmentManifest = buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source);
        const controlManifest = buildV08RangedPositioningABManifest(controlInvocation, control, source);
        expect(controlManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvanceLiveOnly: true,
                supportedBandAdvanceVsLegacy: false,
                supportedBandAdvanceOverlayVsLegacy: false,
                supportedBandAdvanceOverlayControl: true,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
                V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            },
        });
        const changedBehaviorKeys = [
            ...new Set([
                ...Object.keys(treatmentManifest.behaviorEnvironment),
                ...Object.keys(controlManifest.behaviorEnvironment),
            ]),
        ]
            .filter((key) => treatmentManifest.behaviorEnvironment[key] !== controlManifest.behaviorEnvironment[key])
            .sort();
        expect(changedBehaviorKeys).toEqual(["V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS"]);

        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-overlay-control",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({
            supportedBandAdvanceOverlayControl: true,
            supportedBandAdvanceOverlayVsLegacy: false,
            supportedBandAdvanceVsLegacy: false,
            supportedBandAdvanceLiveOnly: true,
        });
        expect(() =>
            buildV08RangedPositioningABInvocations({ ...control, supportedBandAdvanceLiveOnly: false }),
        ).toThrow("requires supportedBandAdvanceLiveOnly");
        for (const mode of ["advance", "retreat", "off"] as const) {
            expect(() => buildV08RangedPositioningABInvocations({ ...control, mode })).toThrow("mode=both");
        }
        expect(() => buildV08RangedPositioningABInvocations({ ...control, moveShots: 1 })).toThrow("moveShots=0");
        for (const conflictingArm of [
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceVsLegacy: true },
            { supportedBandAdvanceOverlayVsLegacy: true },
            { protectedAdvanceGuardrails: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...control, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
    });

    it("seals a matched dominance-overlay treatment/control pair with one selector-only behavior difference", () => {
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvanceLiveOnly: true,
            supportedBandAdvanceDominanceOverlay: true,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedBandAdvanceDominanceOverlay: false,
            supportedBandAdvanceDominanceOverlayControl: true,
        };
        const hostileEnvironment = {
            PATH: "/bin",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "v0.7",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "hostile",
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, hostileEnvironment);
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, hostileEnvironment);
        const expectedCommonEnvironment = {
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
        };
        expect(treatmentInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "",
        });
        expect(controlInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "v0.8",
        });
        const changedEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ]
            .filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key])
            .sort();
        expect(changedEnvironmentKeys).toEqual(["V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS"]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const treatmentManifest = buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source);
        const controlManifest = buildV08RangedPositioningABManifest(controlInvocation, control, source);
        expect(treatmentManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvanceDominanceOverlay: true,
                supportedBandAdvanceDominanceOverlayControl: false,
                supportedBandAdvanceLiveOnly: true,
                supportedBandAdvanceOverlayControl: false,
                supportedBandAdvanceOverlayVsLegacy: false,
                supportedBandAdvanceVsLegacy: false,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "",
                V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
                V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            },
        });
        expect(controlManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvanceDominanceOverlay: false,
                supportedBandAdvanceDominanceOverlayControl: true,
                supportedBandAdvanceLiveOnly: true,
                supportedBandAdvanceOverlayControl: false,
                supportedBandAdvanceOverlayVsLegacy: false,
                supportedBandAdvanceVsLegacy: false,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
                V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            },
        });
        const changedBehaviorKeys = [
            ...new Set([
                ...Object.keys(treatmentManifest.behaviorEnvironment),
                ...Object.keys(controlManifest.behaviorEnvironment),
            ]),
        ]
            .filter((key) => treatmentManifest.behaviorEnvironment[key] !== controlManifest.behaviorEnvironment[key])
            .sort();
        expect(changedBehaviorKeys).toEqual(["V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS"]);

        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-dominance-overlay",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({
            supportedBandAdvanceDominanceOverlay: true,
            supportedBandAdvanceDominanceOverlayControl: false,
            supportedBandAdvanceLiveOnly: true,
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-dominance-overlay-control",
                "--supported-band-live-only",
            ]),
        ).toMatchObject({
            supportedBandAdvanceDominanceOverlay: false,
            supportedBandAdvanceDominanceOverlayControl: true,
            supportedBandAdvanceLiveOnly: true,
        });

        for (const arm of [treatment, control]) {
            expect(() =>
                buildV08RangedPositioningABInvocations({
                    ...arm,
                    supportedBandAdvanceLiveOnly: false,
                }),
            ).toThrow("requires supportedBandAdvanceLiveOnly");
            for (const mode of ["advance", "retreat", "off"] as const) {
                expect(() => buildV08RangedPositioningABInvocations({ ...arm, mode })).toThrow("mode=both");
            }
            expect(() => buildV08RangedPositioningABInvocations({ ...arm, moveShots: 1 })).toThrow("moveShots=0");
        }
        for (const conflictingArm of [
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceVsLegacy: true },
            { supportedBandAdvanceOverlayVsLegacy: true },
            { supportedBandAdvanceOverlayControl: true },
            { protectedAdvanceGuardrails: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...treatment, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
            expect(() => buildV08RangedPositioningABInvocations({ ...control, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...treatment,
                supportedBandAdvanceDominanceOverlayControl: true,
            }),
        ).toThrow("mutually exclusive");
    });

    it("seals screened-closer treatment/control to one selector key and an immutable receipt", () => {
        const receipt = createScreenedCloserReceipt();
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            supportedBandAdvanceLiveOnly: true,
            supportedBandScreenedCloserOverlay: true,
            prelaunchReceipt: receipt.path,
            diag: true,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedBandScreenedCloserOverlay: false,
            supportedBandScreenedCloserOverlayControl: true,
        };
        const hostileEnvironment = {
            PATH: "/bin",
            V08_SUPPORTED_BAND_ADVANCE: "1",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "v0.7",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "hostile",
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, hostileEnvironment);
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, hostileEnvironment);
        const expectedCommonEnvironment = {
            SEARCH_VERSIONS: "v0.8,v0.8s",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
        };
        expect(treatmentInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
        });
        expect(controlInvocation.environment).toMatchObject({
            ...expectedCommonEnvironment,
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "v0.8",
        });
        const changedEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ]
            .filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key])
            .sort();
        expect(changedEnvironmentKeys).toEqual(["V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS"]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const treatmentManifest = buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source);
        const controlManifest = buildV08RangedPositioningABManifest(controlInvocation, control, source);
        const receiptSha256 = createHash("sha256").update(receipt.contents).digest("hex");
        expect(treatmentManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvanceLiveOnly: true,
                supportedBandScreenedCloserOverlay: true,
                supportedBandScreenedCloserOverlayControl: false,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
            },
            prelaunchReceipt: {
                path: receipt.path,
                sha256: receiptSha256,
            },
        });
        expect(controlManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandAdvanceLiveOnly: true,
                supportedBandScreenedCloserOverlay: false,
                supportedBandScreenedCloserOverlayControl: true,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
            },
            prelaunchReceipt: {
                path: receipt.path,
                sha256: receiptSha256,
            },
        });
        expect(treatmentManifest.prelaunchReceipt?.mtimeMs).toBeGreaterThan(0);
        expect(controlManifest.prelaunchReceipt).toEqual(treatmentManifest.prelaunchReceipt);
        expect(controlManifest.fingerprintSha256).not.toBe(treatmentManifest.fingerprintSha256);

        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-live-only",
                "--supported-band-screened-closer-overlay",
                "--prelaunch-receipt",
                receipt.path,
            ]),
        ).toMatchObject({
            supportedBandScreenedCloserOverlay: true,
            supportedBandScreenedCloserOverlayControl: false,
            prelaunchReceipt: receipt.path,
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--supported-band-live-only",
                "--supported-band-screened-closer-overlay-control",
                "--prelaunch-receipt",
                receipt.path,
            ]),
        ).toMatchObject({
            supportedBandScreenedCloserOverlay: false,
            supportedBandScreenedCloserOverlayControl: true,
            prelaunchReceipt: receipt.path,
        });

        for (const arm of [treatment, control]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...arm, prelaunchReceipt: undefined })).toThrow(
                "require --prelaunch-receipt",
            );
            expect(() =>
                buildV08RangedPositioningABInvocations({ ...arm, supportedBandAdvanceLiveOnly: false }),
            ).toThrow("requires supportedBandAdvanceLiveOnly");
            expect(() => buildV08RangedPositioningABInvocations({ ...arm, moveShots: 1 })).toThrow("moveShots=0");
        }
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...BASE_OPTIONS,
                prelaunchReceipt: receipt.path,
            }),
        ).toThrow("only valid for screened-closer overlays");
        expect(() =>
            parseV08RangedPositioningABOptions([
                "--supported-band-screened-closer-overlay",
                "--supported-band-live-only",
                "--prelaunch-receipt",
                "relative-receipt.json",
            ]),
        ).toThrow("absolute path");
        for (const conflictingArm of [
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceVsLegacy: true },
            { supportedBandAdvanceOverlayVsLegacy: true },
            { supportedBandAdvanceOverlayControl: true },
            { supportedBandAdvanceDominanceOverlay: true },
            { supportedBandAdvanceDominanceOverlayControl: true },
            { supportedBandScreenedCloserOverlayControl: true },
            { protectedAdvanceGuardrails: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...treatment, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }

        const missingOptions = { ...treatment, prelaunchReceipt: join(tmpdir(), "missing-screened-receipt.json") };
        const [missingInvocation] = buildV08RangedPositioningABInvocations(missingOptions, { PATH: "/bin" });
        expect(() => buildV08RangedPositioningABManifest(missingInvocation, missingOptions, source)).toThrow();

        const writableReceipt = createScreenedCloserReceipt();
        chmodSync(writableReceipt.path, 0o644);
        const writableOptions = { ...treatment, prelaunchReceipt: writableReceipt.path };
        const [writableInvocation] = buildV08RangedPositioningABInvocations(writableOptions, { PATH: "/bin" });
        expect(() => buildV08RangedPositioningABManifest(writableInvocation, writableOptions, source)).toThrow(
            "read-only",
        );

        const wrongSchemaReceipt = createScreenedCloserReceipt('{"schema":"wrong"}\n');
        const wrongSchemaOptions = { ...treatment, prelaunchReceipt: wrongSchemaReceipt.path };
        const [wrongSchemaInvocation] = buildV08RangedPositioningABInvocations(wrongSchemaOptions, { PATH: "/bin" });
        expect(() => buildV08RangedPositioningABManifest(wrongSchemaInvocation, wrongSchemaOptions, source)).toThrow(
            "incompatible schema",
        );
    });

    it("seals the decisive screened-closer arm under distinct selector and manifest fields", () => {
        const receipt = createScreenedCloserReceipt();
        const treatment: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            supportedBandAdvanceLiveOnly: true,
            supportedBandDecisiveScreenedCloserOverlay: true,
            prelaunchReceipt: receipt.path,
        };
        const control: IV08RangedPositioningABOptions = {
            ...treatment,
            supportedBandDecisiveScreenedCloserOverlay: false,
            supportedBandDecisiveScreenedCloserOverlayControl: true,
        };
        const hostileEnvironment = {
            PATH: "/bin",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "hostile",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "hostile",
        };
        const [treatmentInvocation] = buildV08RangedPositioningABInvocations(treatment, hostileEnvironment);
        const [controlInvocation] = buildV08RangedPositioningABInvocations(control, hostileEnvironment);

        expect(treatmentInvocation.environment).toMatchObject({
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "v0.8s",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
        });
        expect(controlInvocation.environment).toMatchObject({
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
        });
        const changedEnvironmentKeys = [
            ...new Set([
                ...Object.keys(treatmentInvocation.environment),
                ...Object.keys(controlInvocation.environment),
            ]),
        ]
            .filter((key) => treatmentInvocation.environment[key] !== controlInvocation.environment[key])
            .sort();
        expect(changedEnvironmentKeys).toEqual([
            "V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS",
        ]);

        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        const treatmentManifest = buildV08RangedPositioningABManifest(treatmentInvocation, treatment, source);
        const controlManifest = buildV08RangedPositioningABManifest(controlInvocation, control, source);
        expect(treatmentManifest).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                supportedBandScreenedCloserOverlay: false,
                supportedBandScreenedCloserOverlayControl: false,
                supportedBandDecisiveScreenedCloserOverlay: true,
                supportedBandDecisiveScreenedCloserOverlayControl: false,
            },
            behaviorEnvironment: {
                V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
                V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS: "v0.8",
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
                V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
            },
        });
        expect(controlManifest.arm).toMatchObject({
            supportedBandScreenedCloserOverlay: false,
            supportedBandScreenedCloserOverlayControl: false,
            supportedBandDecisiveScreenedCloserOverlay: false,
            supportedBandDecisiveScreenedCloserOverlayControl: true,
        });
        expect(controlManifest.fingerprintSha256).not.toBe(treatmentManifest.fingerprintSha256);

        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--supported-band-live-only",
                "--supported-band-decisive-screened-closer-overlay",
                "--prelaunch-receipt",
                receipt.path,
            ]),
        ).toMatchObject({
            supportedBandScreenedCloserOverlay: false,
            supportedBandDecisiveScreenedCloserOverlay: true,
            supportedBandDecisiveScreenedCloserOverlayControl: false,
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--supported-band-live-only",
                "--supported-band-decisive-screened-closer-overlay-control",
                "--prelaunch-receipt",
                receipt.path,
            ]),
        ).toMatchObject({
            supportedBandScreenedCloserOverlayControl: false,
            supportedBandDecisiveScreenedCloserOverlay: false,
            supportedBandDecisiveScreenedCloserOverlayControl: true,
        });
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...treatment,
                supportedBandScreenedCloserOverlay: true,
            }),
        ).toThrow("mutually exclusive");
    });

    it("isolates live-root protected-advance guardrails over one shipped legacy catalog", () => {
        const guardrails: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            mode: "both",
            moveShots: 0,
            protectedAdvanceGuardrails: true,
            diag: true,
        };
        const [invocation] = buildV08RangedPositioningABInvocations(guardrails, {
            PATH: "/bin",
            V08_PROTECTED_ADVANCE_GUARDRAILS: "hostile",
            V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "hostile",
            V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "v0.7",
        });

        expect(invocation.environment).toMatchObject({
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_MAX_MOVE_SHOTS: "0",
            V08_RANGED_POSITION_MODE: "both",
            V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
            V08_PROTECTED_ADVANCE_GUARDRAILS: "1",
            V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "1",
            V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
            V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "v0.8",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "0",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS: "0",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "0",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "",
        });
        const source = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false } as const;
        expect(buildV08RangedPositioningABManifest(invocation, guardrails, source)).toMatchObject({
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
            arm: {
                protectedAdvanceGuardrails: true,
                protectedAdvanceGuardrailsMode: "both",
                candidateVersion: "v0.8",
                controlVersion: "v0.8s",
            },
            behaviorEnvironment: {
                V08_PROTECTED_ADVANCE_GUARDRAILS: "1",
                V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "1",
                V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
                V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "v0.8",
            },
        });
        expect(
            parseV08RangedPositioningABOptions([
                "--cohorts",
                "hybrid",
                "--mode",
                "both",
                "--protected-advance-guardrails",
            ]),
        ).toMatchObject({ protectedAdvanceGuardrails: true, protectedAdvanceGuardrailsMode: "both" });

        for (const protectedAdvanceGuardrailsMode of [
            "catalog_only",
            "partial_band",
            "ranged_superior_hold",
        ] as const) {
            const ablation = { ...guardrails, protectedAdvanceGuardrailsMode };
            const [ablationInvocation] = buildV08RangedPositioningABInvocations(ablation, { PATH: "/bin" });
            expect(ablationInvocation.environment.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE).toBe(
                protectedAdvanceGuardrailsMode,
            );
            expect(
                buildV08RangedPositioningABManifest(ablationInvocation, ablation, source).arm
                    .protectedAdvanceGuardrailsMode,
            ).toBe(protectedAdvanceGuardrailsMode);
            expect(
                parseV08RangedPositioningABOptions([
                    "--cohorts",
                    "hybrid",
                    "--mode",
                    "both",
                    "--protected-advance-guardrails",
                    "--protected-advance-guardrails-mode",
                    protectedAdvanceGuardrailsMode,
                ]).protectedAdvanceGuardrailsMode,
            ).toBe(protectedAdvanceGuardrailsMode);
        }

        const catalogControl = {
            ...guardrails,
            cohorts: ["hybrid", "ranged_max_sniper3"] as const,
            protectedAdvanceGuardrailsMode: "catalog_only" as const,
        };
        const catalogInvocations = buildV08RangedPositioningABInvocations(catalogControl, { PATH: "/bin" });
        expect(catalogInvocations.map(({ cohort }) => cohort)).toEqual(["hybrid", "ranged_max_sniper3"]);
        for (const catalogInvocation of catalogInvocations) {
            expect(catalogInvocation.environment).toMatchObject({
                SEARCH_VERSIONS: "v0.8,v0.8s",
                V08_RANGED_POSITION_MODE: "both",
                V08_RANGED_POSITION_VERSIONS: "v0.8,v0.8s",
                V08_PROTECTED_ADVANCE_GUARDRAILS: "1",
                V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "1",
                V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "catalog_only",
                V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "v0.8",
            });
            expect(argValue(catalogInvocation.args, "--livetwin")).toBe("1");
            expect(argValue(catalogInvocation.args, "--vA")).toBe("v0.8");
            expect(argValue(catalogInvocation.args, "--vB")).toBe("v0.8s");
            expect(buildV08RangedPositioningABManifest(catalogInvocation, catalogControl, source)).toMatchObject({
                schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
                geometry: { pairedSideSwap: true, symmetricRosters: true },
                arm: { protectedAdvanceGuardrails: true, protectedAdvanceGuardrailsMode: "catalog_only" },
            });
        }

        for (const mode of ["advance", "retreat", "off"] as const) {
            expect(() => buildV08RangedPositioningABInvocations({ ...guardrails, mode })).toThrow("mode=both");
        }
        expect(() => buildV08RangedPositioningABInvocations({ ...guardrails, moveShots: 1 })).toThrow("moveShots=0");
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...guardrails,
                protectedAdvanceGuardrails: "yes" as unknown as boolean,
            }),
        ).toThrow("must be a boolean");
        expect(() =>
            buildV08RangedPositioningABInvocations({
                ...guardrails,
                protectedAdvanceGuardrailsMode: "invalid" as "both",
            }),
        ).toThrow("catalog_only");
        for (const protectedAdvanceGuardrailsMode of [
            "catalog_only",
            "partial_band",
            "ranged_superior_hold",
        ] as const) {
            expect(() =>
                buildV08RangedPositioningABInvocations({
                    ...BASE_OPTIONS,
                    protectedAdvanceGuardrailsMode,
                }),
            ).toThrow("requires protectedAdvanceGuardrails");
        }
        expect(() =>
            parseV08RangedPositioningABOptions([
                "--protected-advance-guardrails",
                "--protected-advance-guardrails-mode",
                "invalid",
            ]),
        ).toThrow("--protected-advance-guardrails-mode");
        for (const conflictingArm of [
            { noMeleeTerminalPressure: true },
            { deadlineFinisher: true },
            { paretoNoMeleeFocus: true },
            { paretoNoMeleeFocusCatalogOnly: true },
            { jitNoMeleeFocus: true },
            { jitNoMeleeFocusCatalogOnly: true },
            { supportedRangedDelta: true },
            { responseNeutralAdvance: true },
            { supportedPrepinEgress: true },
            { supportedPrepinEgressCatalogOnly: true },
            { supportedBandAdvance: true },
            { supportedBandAdvanceCatalogOnly: true },
            { supportedBandAdvanceVsLegacy: true, supportedBandAdvanceLiveOnly: true },
            { supportedBandAdvanceOverlayVsLegacy: true, supportedBandAdvanceLiveOnly: true },
            { supportedBandAdvanceOverlayControl: true, supportedBandAdvanceLiveOnly: true },
        ]) {
            expect(() => buildV08RangedPositioningABInvocations({ ...guardrails, ...conflictingArm })).toThrow(
                "mutually exclusive",
            );
        }
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
            schema: "hoc.v0_8_ranged_positioning_ab_experiment.v18",
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
                noMeleeTerminalPressure: false,
                deadlineFinisher: false,
                paretoNoMeleeFocus: false,
                paretoNoMeleeFocusCatalogOnly: false,
                paretoNoMeleeFocusDamageFloor: 1,
                paretoNoMeleeFocusScope: "pure_ranged",
                jitNoMeleeFocus: false,
                jitNoMeleeFocusCatalogOnly: false,
                jitNoMeleeFocusStartLap: 1,
                jitNoMeleeFocusLastLap: 11,
                jitNoMeleeFocusActivationBuffer: 1,
                jitNoMeleeFocusDamageFloor: 0.8,
                supportedRangedDelta: false,
                supportedRangedDeltaCatalogOnly: false,
                supportedRangedDeltaLiveOnly: false,
                responseNeutralAdvance: false,
                supportedPrepinEgress: false,
                supportedPrepinEgressCatalogOnly: false,
                supportedPrepinEgressLiveOnly: false,
                supportedBandAdvance: false,
                supportedBandAdvanceCatalogOnly: false,
                supportedBandAdvanceLiveOnly: false,
                supportedBandAdvanceVsLegacy: false,
                supportedBandAdvanceOverlayVsLegacy: false,
                supportedBandAdvanceOverlayControl: false,
                supportedBandAdvanceDominanceOverlay: false,
                supportedBandAdvanceDominanceOverlayControl: false,
                supportedBandScreenedCloserOverlay: false,
                supportedBandScreenedCloserOverlayControl: false,
                protectedAdvanceGuardrails: false,
                protectedAdvanceGuardrailsMode: "both",
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
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "v0.8",
            V08_RANGED_POSITION_MODE: "off",
            V08_RANGED_POSITION_VERSIONS: "v0.8",
            V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "0",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY: "0",
            V08_SUPPORTED_RANGED_DELTA_VERSIONS: "",
            V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS: "0",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "0",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "",
        });
        expect(first.behaviorEnvironment.PATH).toBeUndefined();
        expect(first.behaviorEnvironment.SEARCH_AUDIT).toBeUndefined();
        expect(first.artifacts.searchAudit).toBeUndefined();
        expect(Object.keys(first.behaviorEnvironment)).toEqual(Object.keys(first.behaviorEnvironment).sort());
        expect(first.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(second.fingerprintSha256).toBe(first.fingerprintSha256);

        const auditRoutingOnly = buildV08RangedPositioningABManifest(
            {
                ...invocation,
                environment: { ...invocation.environment, SEARCH_AUDIT: "/tmp/execution-only-search-audit.jsonl" },
            },
            options,
            source,
        );
        expect(auditRoutingOnly.behaviorEnvironment).toEqual(first.behaviorEnvironment);
        expect(auditRoutingOnly.fingerprintSha256).toBe(first.fingerprintSha256);

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

    it("truncates the unique Pareto-focus audit immediately before launch and declares the fresh artifact", async () => {
        const out = mkdtempSync(join(tmpdir(), "hoc-pareto-focus-runner-"));
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["pure_ranged"],
            out,
            mode: "off",
            paretoNoMeleeFocus: true,
        };
        const [expected] = buildV08RangedPositioningABInvocations(options);
        expect(expected.searchAuditPath).toBe(join(out, "pure_ranged.search-audit.jsonl"));
        writeFileSync(expected.searchAuditPath!, "stale-run\n");

        let declaredAudit: string | undefined;
        await runV08RangedPositioningAB(options, {
            runChild: async (invocation) => {
                expect(invocation.searchAuditPath).toBe(expected.searchAuditPath);
                expect(readFileSync(invocation.searchAuditPath!, "utf8")).toBe("");
                writeFileSync(invocation.searchAuditPath!, "fresh-child-output\n");
                return 0;
            },
            discoverSourceIdentity: () => ({ head: null, tree: null, dirty: false }),
            writeManifest: (_path, manifest) => {
                declaredAudit = manifest.artifacts.searchAudit;
            },
        });

        expect(readFileSync(expected.searchAuditPath!, "utf8")).toBe("fresh-child-output\n");
        expect(declaredAudit).toBe(expected.searchAuditPath);
    });

    it("binds screened-closer receipt bytes before the child can mutate external state", async () => {
        const receipt = createScreenedCloserReceipt();
        const originalSha256 = createHash("sha256").update(receipt.contents).digest("hex");
        const options: IV08RangedPositioningABOptions = {
            ...BASE_OPTIONS,
            cohorts: ["hybrid"],
            out: mkdtempSync(join(tmpdir(), "hoc-screened-closer-runner-")),
            supportedBandAdvanceLiveOnly: true,
            supportedBandScreenedCloserOverlay: true,
            prelaunchReceipt: receipt.path,
        };
        let writtenSha256: string | undefined;
        await runV08RangedPositioningAB(options, {
            discoverSourceIdentity: () => ({ head: null, tree: null, dirty: false }),
            runChild: async () => {
                chmodSync(receipt.path, 0o644);
                writeFileSync(
                    receipt.path,
                    `${JSON.stringify({
                        schema: "hoc.supported_band_screened_closer_prelaunch_receipt.v1",
                        hypothesis: "post-launch mutation",
                    })}\n`,
                );
                chmodSync(receipt.path, 0o444);
                return 0;
            },
            writeManifest: (_path, manifest) => {
                writtenSha256 = manifest.prelaunchReceipt?.sha256;
            },
        });
        expect(writtenSha256).toBe(originalSha256);
        expect(createHash("sha256").update(readFileSync(receipt.path)).digest("hex")).not.toBe(originalSha256);
    });

    it("runs cohort children sequentially and fails closed on a nonzero child", async () => {
        const seen: string[] = [];
        const lifecycle: string[] = [];
        const manifests: Array<{ path: string; fingerprint: string }> = [];
        await runV08RangedPositioningAB(BASE_OPTIONS, {
            prepareInvocation: (invocation) => {
                lifecycle.push(`prepare:${invocation.cohort}`);
            },
            runChild: async (invocation) => {
                lifecycle.push(`child:${invocation.cohort}`);
                seen.push(invocation.cohort);
                return 0;
            },
            discoverSourceIdentity: () => ({ head: "c".repeat(40), tree: "d".repeat(40), dirty: false }),
            writeManifest: (path, manifest) => manifests.push({ path, fingerprint: manifest.fingerprintSha256 }),
        });
        expect(seen).toEqual(["hybrid", "ranged_max_sniper3"]);
        expect(lifecycle).toEqual([
            "prepare:hybrid",
            "child:hybrid",
            "prepare:ranged_max_sniper3",
            "child:ranged_max_sniper3",
        ]);
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
