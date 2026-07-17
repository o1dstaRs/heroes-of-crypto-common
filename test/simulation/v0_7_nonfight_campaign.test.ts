/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    assertV07NonfightCampaignLaunchable,
    buildV07NonfightCampaignProvenance,
    deriveV07NonfightCampaignTiming,
    fingerprintV07NonfightCampaign,
    renderV07NonfightCampaignLane,
    resolveV07NonfightCampaignConfig,
    sanitizeV07NonfightCampaignEnvironment,
} from "../../src/simulation/optimizer/v0_7_nonfight_campaign_core";

const rawConfig = () => ({
    schemaVersion: 1,
    outputDirectory: "/campaign-output",
    hours: 11,
    totalWorkers: 12,
    heartbeatSeconds: 30,
    stopGraceSeconds: 20,
    laneStopGraceMs: 30 * 60 * 1000,
    lanes: [
        {
            name: "draft",
            workers: 6,
            command: [
                "bun",
                "src/simulation/optimizer/v0_7_draft_overnight.ts",
                "--out",
                "{laneOutputDir}",
                "--workers",
                "{workers}",
                "--deadline-ms",
                "{deadlineAtMs}",
            ],
        },
        {
            name: "setup",
            workers: 6,
            command: [
                "bun",
                "src/simulation/optimizer/v0_7_setup_overnight.ts",
                "--out",
                "{laneOutputDir}",
                "--workers",
                "{workers}",
                "--deadline-ms",
                "{laneDeadlineAtMs}",
                "--run-id",
                "{runId}",
            ],
            env: { HARD_DEADLINE: "{hardDeadlineAtMs}" },
        },
    ],
});

const resolveConfig = (value: unknown = rawConfig()) =>
    resolveV07NonfightCampaignConfig(value, {
        configDirectory: "/config",
        repositoryRoot: "/repo",
    });

describe("v0.7 non-fight campaign configuration", () => {
    it("normalizes exactly two shell-free lanes and preserves the 6+6 allocation", () => {
        const config = resolveConfig();

        expect(config.outputDirectory).toBe("/campaign-output");
        expect(config.repositoryRoot).toBe("/repo");
        expect(config.durationMs).toBe(11 * 60 * 60 * 1000);
        expect(config.lanes.map(({ name, workers }) => ({ name, workers }))).toEqual([
            { name: "draft", workers: 6 },
            { name: "setup", workers: 6 },
        ]);
        expect(config.lanes[0].command[0]).toBe("bun");
        expect(config.configSha256).toBe(
            fingerprintV07NonfightCampaign({
                schemaVersion: config.schemaVersion,
                outputDirectory: config.outputDirectory,
                repositoryRoot: config.repositoryRoot,
                hours: config.hours,
                durationMs: config.durationMs,
                totalWorkers: config.totalWorkers,
                heartbeatMs: config.heartbeatMs,
                stopGraceMs: config.stopGraceMs,
                laneStopGraceMs: config.laneStopGraceMs,
                lanes: config.lanes,
            }),
        );
    });

    it("rejects source-tree output, escaped cwd, command strings, and allocation drift", () => {
        const inside = rawConfig();
        inside.outputDirectory = "/repo/sim-out";
        expect(() => resolveConfig(inside)).toThrow("outside the repository");

        const escaped = rawConfig();
        (escaped.lanes[0] as Record<string, unknown>).cwd = "/tmp";
        expect(() => resolveConfig(escaped)).toThrow("immutable repository root");

        const shell = rawConfig();
        (shell.lanes[0] as Record<string, unknown>).command = "bun optimizer.ts --workers 6";
        expect(() => resolveConfig(shell)).toThrow("argv array");

        const drift = rawConfig();
        drift.lanes[1].workers = 5;
        expect(() => resolveConfig(drift)).toThrow("does not equal totalWorkers 12");
    });

    it("renders optimizer deadlines before the immutable supervisor deadline", () => {
        const config = resolveConfig();
        const timing = deriveV07NonfightCampaignTiming(1_000, config.durationMs, config.laneStopGraceMs);
        const lane = renderV07NonfightCampaignLane(config.lanes[1], {
            runId: "run-1",
            repositoryRoot: config.repositoryRoot,
            campaignOutputDir: config.outputDirectory,
            laneOutputDir: "/campaign-output/lanes/setup/output",
            workers: 6,
            laneDeadlineAtMs: timing.laneDeadlineAtMs,
            hardDeadlineAtMs: timing.hardDeadlineAtMs,
        });

        expect(timing.hardDeadlineAtMs).toBe(1_000 + 11 * 60 * 60 * 1000);
        expect(timing.laneDeadlineAtMs).toBe(timing.hardDeadlineAtMs - 30 * 60 * 1000);
        expect(lane.command.at(-3)).toBe(String(timing.laneDeadlineAtMs));
        expect(lane.command.at(-1)).toBe("run-1");
        expect(lane.env.HARD_DEADLINE).toBe(String(timing.hardDeadlineAtMs));
    });

    it("does not permit an invalid or longer resumed deadline", () => {
        expect(() => deriveV07NonfightCampaignTiming(10, 1000, 1000)).toThrow("laneStopGraceMs");
        const timing = deriveV07NonfightCampaignTiming(10, 1000, 100);
        expect(timing).toEqual({
            startAtMs: 10,
            laneDeadlineAtMs: 910,
            hardDeadlineAtMs: 1010,
            laneStopGraceMs: 100,
            durationMs: 1000,
        });
    });

    it("removes ambient experiment controls before overlaying explicit lane env", () => {
        const clean = sanitizeV07NonfightCampaignEnvironment(
            {
                PATH: "/usr/bin",
                V07_FIGHT_WEIGHTS: "ambient",
                SEARCH_DEPTH: "9",
                Q2_PROFILE: "ambient",
                CEM_SEED: "1",
                FIGHT_MELEE_ROSTERS: "0",
                ROSTER_RANGED_MIN: "6",
                AUGCA_NOVISION: "0",
                LIVETWIN: "0",
                SIM_NO_ACTIONS: "1",
                VALUE_DATA: "/tmp/value",
                FORCE_CREATURES: "4:Black Dragon",
                NODE_OPTIONS: "--require=/tmp/inject.js",
            },
            { LIVETWIN: "1", V07_ACCEPTED_PROFILE: "recorded" },
        );

        expect(clean).toEqual({ LIVETWIN: "1", PATH: "/usr/bin", V07_ACCEPTED_PROFILE: "recorded" });
    });
});

describe("v0.7 non-fight campaign provenance", () => {
    const input = () => ({
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        branch: "main",
        originMain: "a".repeat(40),
        originUrl: "git@github.com:o1dstaRs/heroes-of-crypto-common.git",
        statusPorcelain: "",
        capturedAtMs: 1234,
        platform: "darwin" as const,
        arch: "arm64",
        hostname: "research-host",
        logicalCpuCount: 16,
        bunVersion: "1.3.0",
        bunRevision: "revision",
    });

    it("self-hashes exact clean-main source and runtime facts", () => {
        const provenance = buildV07NonfightCampaignProvenance(input());
        const { provenanceSha256, ...unsigned } = provenance;

        expect(provenance.cleanIncludingUntracked).toBe(true);
        expect(provenanceSha256).toBe(fingerprintV07NonfightCampaign(unsigned));
        expect(() => assertV07NonfightCampaignLaunchable(provenance)).not.toThrow();
    });

    it("refuses dirty, non-main, and unpushed checkouts", () => {
        const dirty = buildV07NonfightCampaignProvenance({ ...input(), statusPorcelain: "?? scratch.ts\n" });
        expect(() => assertV07NonfightCampaignLaunchable(dirty)).toThrow("clean including untracked");

        const branch = buildV07NonfightCampaignProvenance({ ...input(), branch: "experiment" });
        expect(() => assertV07NonfightCampaignLaunchable(branch)).toThrow("must launch from main");

        const unpushed = buildV07NonfightCampaignProvenance({ ...input(), originMain: "c".repeat(40) });
        expect(() => assertV07NonfightCampaignLaunchable(unpushed)).toThrow("does not match origin/main");
    });
});
