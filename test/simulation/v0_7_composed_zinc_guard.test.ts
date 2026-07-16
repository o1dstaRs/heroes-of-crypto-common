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

import {
    validateV07ComposedZincFinalSnapshot,
    validateV07ComposedZincInitialSnapshot,
    validateV07ComposedZincSnapshot,
    v07ComposedZincSnapshotSha256,
    v07ComposedZincReservedTournamentSeeds,
    type IV07ComposedZincGuardContract,
    type IV07ComposedZincSnapshot,
} from "../../src/simulation/v0_7_composed_zinc_guard";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ROOT = "/home/agent-zinc/hoc-common";

function contract(): IV07ComposedZincGuardContract {
    const paths = {
        commonRoot: ROOT,
        keepaliveScript: `${ROOT}/rl_state/keepalive_fight58b.sh`,
        cemScript: `${ROOT}/src/simulation/optimizer/cem.mjs`,
        concurrentTournament: `${ROOT}/src/simulation/concurrent_tournament.ts`,
        runTournament: `${ROOT}/src/simulation/run_tournament.ts`,
        tournament: `${ROOT}/src/simulation/tournament.ts`,
        tournamentWorker: `${ROOT}/src/simulation/tournament_worker.ts`,
        log: `${ROOT}/rl_state/fight58_keepalive.log`,
        state: `${ROOT}/sim-out/cem/state.json`,
    };
    const approvedReadOnlyScanner = {
        cwd: "/home/agent-zinc/hoc-common-v07-overnight",
        sourcePath: "/tmp/v0_7_composed_seed_scan.ts",
        configPath: "/tmp/v07_composed_seed_scan_zinc.json",
        cutoff: "2026-07-16T07:00:00Z",
        seedSetOutput: "/tmp/v07-composed-zinc-seeds-structured-v2.txt",
        summaryOutput: "/tmp/v07-composed-zinc-seed-scan-summary-v2.json",
        excluded: [
            `${ROOT}/rl_state/fight58_keepalive.log`,
            `${ROOT}/sim-out/cem/best.json`,
            `${ROOT}/sim-out/cem/log.md`,
            `${ROOT}/sim-out/cem/state.json`,
        ].sort(),
        excludedPathPrefixes: [`${ROOT}/sim-out/cem/best-`, `${ROOT}/sim-out/cem/eval_11_`].sort(),
        excludedRelativeSuffixes: [
            "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
            "src/simulation/v0_7_composed_ranked_ladder.ts",
        ] as [
            "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
            "src/simulation/v0_7_composed_ranked_ladder.ts",
        ],
    };
    return {
        schemaVersion: 1,
        guardId: "v0.7-composed-zinc-guard-test",
        sealBefore: "2026-07-17T06:00:00Z",
        remote: { host: "puffalo.tailbe7bef.ts.net", user: "agent-zinc", port: 2222 },
        limits: {
            maxIteration: 64,
            maxPass: 8,
            maxGeneration: 12,
            seed0Base: 970000,
            iterationStep: 911,
            trainingPassStep: 1000003,
            trainingGenerationStep: 7919,
            trainingGames: 3000,
            validationOffsets: [11, 17, 19, 23, 29],
            validationGames: 2500,
        },
        paths,
        requiredFileSha256: Object.fromEntries(
            [
                paths.keepaliveScript,
                paths.cemScript,
                paths.concurrentTournament,
                paths.runTournament,
                paths.tournament,
                paths.tournamentWorker,
                approvedReadOnlyScanner.sourcePath,
                approvedReadOnlyScanner.configPath,
            ].map((path, index) => [path, index % 2 ? HASH_A : HASH_B]),
        ),
        approvedReadOnlyScanner,
        requiredCemEnvironment: {
            BASE_VERSION: "v0.4",
            CEM_BATCH: "44",
            CEM_CORES: "44",
            CEM_DIM: "58",
            CEM_EVAL_TIMEOUT_MS: "1200000",
            CEM_GAMES: "3000",
            CEM_HOURS: "6",
            CEM_POP: "40",
            CEM_ELITE: "8",
            CEM_VAL_GAMES: "2500",
            FIGHT_MELEE_ROSTERS: "0.5",
            OPT_VERSION: "v0.6",
            OPT_WEIGHTS_ENV: "V06_WEIGHTS",
        },
        forbiddenCemEnvironment: ["CEM_GENS", "CEM_MAPS"],
        initialObservation: {
            capturedAt: "2026-07-16T06:00:00Z",
            keepalivePid: 10,
            cemPid: 11,
            keepaliveStartTicks: "100",
            cemStartTicks: "101",
            snapshotSha256: HASH_A,
        },
    };
}

function snapshot(frozen = contract()): IV07ComposedZincSnapshot {
    const seed0 = frozen.limits.seed0Base + frozen.limits.iterationStep;
    const trainingSeed = seed0 + frozen.limits.trainingPassStep + frozen.limits.trainingGenerationStep;
    return {
        schemaVersion: 1,
        capturedAt: "2026-07-16T07:00:00Z",
        files: { ...frozen.requiredFileSha256 },
        logText: ["=== 06:14:21 f58b iter 1 seed 970911 START ===", "[cem] pass 1 gen 1/12: best-cand 72.00%"].join(
            "\n",
        ),
        stateText: JSON.stringify({ pass: 1, gen: 1 }),
        processes: [
            {
                pid: 10,
                ppid: 1,
                startTicks: "100",
                cwd: ROOT,
                argv: ["bash", frozen.paths.keepaliveScript],
                environment: {},
            },
            {
                pid: 11,
                ppid: 10,
                startTicks: "101",
                cwd: ROOT,
                argv: ["bun", "src/simulation/optimizer/cem.mjs"],
                environment: {
                    ...frozen.requiredCemEnvironment,
                    CEM_SEED: String(seed0),
                    CEM_VAL_SEEDS: frozen.limits.validationOffsets.map((offset) => seed0 + offset).join(","),
                },
            },
            {
                pid: 12,
                ppid: 11,
                startTicks: "102",
                cwd: ROOT,
                argv: [
                    "bun",
                    "src/simulation/run_tournament.ts",
                    "v0.6",
                    "v0.4",
                    String(frozen.limits.trainingGames),
                    String(trainingSeed),
                    `${ROOT}/sim-out/cem/eval_11_0`,
                    "1",
                    "--maps",
                ],
                environment: {},
            },
        ],
        processScanErrors: [],
        readOnlyScannerConfig: {
            cutoff: frozen.approvedReadOnlyScanner.cutoff,
            seedSetOutput: frozen.approvedReadOnlyScanner.seedSetOutput,
            summaryOutput: frozen.approvedReadOnlyScanner.summaryOutput,
            excluded: frozen.approvedReadOnlyScanner.excluded,
            excludedPathPrefixes: frozen.approvedReadOnlyScanner.excludedPathPrefixes,
            excludedRelativeSuffixes: frozen.approvedReadOnlyScanner.excludedRelativeSuffixes,
        },
    };
}

describe("v0.7 composed Zinc concurrent-job guard", () => {
    it("expands the exact i=1..64, pass=1..8 tournament closure", () => {
        const frozen = contract();
        const seeds = v07ComposedZincReservedTournamentSeeds(frozen);
        expect(seeds.size).toBe(64 * (5 + 8 * 12));
        expect(seeds.has(970928)).toBe(true);
        expect(seeds.has(970911 + 1000003 + 7919)).toBe(true);
        expect(seeds.has(970000 + 64 * 911 + 8 * 1000003 + 12 * 7919)).toBe(true);
    });

    it("accepts exact source, process, state, log, and active tournament evidence", () => {
        const frozen = contract();
        const result = validateV07ComposedZincSnapshot(frozen, snapshot(frozen));
        expect(result).toMatchObject({
            guardId: frozen.guardId,
            checkedAt: "2026-07-16T07:00:00Z",
            maxObservedIteration: 1,
            maxObservedPass: 1,
            activeKeepalivePids: [10],
            activeCemPids: [11],
            activeTournamentSeeds: [1978833],
            passed: true,
        });
    });

    it("permits a reserved periodic CEM handoff and rejects a forged replacement", () => {
        const frozen = contract();
        const handoff = snapshot(frozen);
        const nextIteration = 2;
        const nextSeed0 = frozen.limits.seed0Base + nextIteration * frozen.limits.iterationStep;
        handoff.processes[1] = {
            ...handoff.processes[1],
            pid: 21,
            ppid: 10,
            startTicks: "201",
            environment: {
                ...frozen.requiredCemEnvironment,
                CEM_SEED: String(nextSeed0),
                CEM_VAL_SEEDS: frozen.limits.validationOffsets.map((offset) => nextSeed0 + offset).join(","),
            },
        };
        handoff.processes[2].ppid = 21;
        expect(validateV07ComposedZincSnapshot(frozen, handoff).activeCemPids).toEqual([21]);

        const outOfRange = structuredClone(handoff);
        const escapedSeed0 = frozen.limits.seed0Base + (frozen.limits.maxIteration + 1) * frozen.limits.iterationStep;
        outOfRange.processes[1].environment.CEM_SEED = String(escapedSeed0);
        outOfRange.processes[1].environment.CEM_VAL_SEEDS = frozen.limits.validationOffsets
            .map((offset) => escapedSeed0 + offset)
            .join(",");
        expect(() => validateV07ComposedZincSnapshot(frozen, outOfRange)).toThrow("outside iterations 1..64");

        const wrongParent = structuredClone(handoff);
        wrongParent.processes[1].ppid = 1;
        expect(() => validateV07ComposedZincSnapshot(frozen, wrongParent)).toThrow("exact child");

        const wrongEnvironment = structuredClone(handoff);
        wrongEnvironment.processes[1].environment.CEM_GAMES = "1";
        expect(() => validateV07ComposedZincSnapshot(frozen, wrongEnvironment)).toThrow("changed CEM_GAMES");
    });

    it("rejects a noncanonical scanner path-prefix contract", () => {
        const frozen = contract();
        frozen.approvedReadOnlyScanner.excludedPathPrefixes = [`${ROOT}/sim-out/cem/../cem/eval_11_`];
        expect(() => validateV07ComposedZincSnapshot(frozen, snapshot(frozen))).toThrow(
            "bind every executable source/config file",
        );
    });

    it("fails closed on an unreserved active tournament", () => {
        const frozen = contract();
        const observed = snapshot(frozen);
        observed.processes[2].argv[5] = "123456789";
        expect(() => validateV07ComposedZincSnapshot(frozen, observed)).toThrow("unreserved");
    });

    it("fails closed on tournament protocol or process-inventory drift", () => {
        const frozen = contract();
        const wrongGames = snapshot(frozen);
        wrongGames.processes[2].argv[4] = "6000";
        expect(() => validateV07ComposedZincSnapshot(frozen, wrongGames)).toThrow("protocol argv");

        const wrongParent = snapshot(frozen);
        wrongParent.processes[2].ppid = 1;
        expect(() => validateV07ComposedZincSnapshot(frozen, wrongParent)).toThrow("exact child");

        const scanFailed = snapshot(frozen);
        scanFailed.processScanErrors = ["/proc/99: permission denied"];
        expect(() => validateV07ComposedZincSnapshot(frozen, scanFailed)).toThrow("inventory failed closed");

        const unapproved = snapshot(frozen);
        unapproved.processes.push({
            pid: 13,
            ppid: 1,
            startTicks: "103",
            cwd: ROOT,
            argv: ["bun", "src/simulation/other_experiment.ts"],
            environment: {},
        });
        expect(() => validateV07ComposedZincSnapshot(frozen, unapproved)).toThrow("Unclassified");
    });

    it("permits only the exact bound read-only seed scanner", () => {
        const frozen = contract();
        const observed = snapshot(frozen);
        observed.processes.push({
            pid: 13,
            ppid: 99,
            startTicks: "103",
            cwd: frozen.approvedReadOnlyScanner.cwd,
            argv: ["bun", frozen.approvedReadOnlyScanner.sourcePath, frozen.approvedReadOnlyScanner.configPath],
            environment: {},
        });
        expect(validateV07ComposedZincSnapshot(frozen, observed).activeReadOnlyScannerPids).toEqual([13]);

        observed.processes.at(-1)!.argv[2] = "/tmp/unbound-config.json";
        expect(() => validateV07ComposedZincSnapshot(frozen, observed)).toThrow("exact cwd/argv");
    });

    it("fails closed when the log or state crosses the reserved closure", () => {
        const frozen = contract();
        const logExceeded = snapshot(frozen);
        logExceeded.logText += "\n=== 08:00:00 f58b iter 65 seed 1029215 START ===";
        expect(() => validateV07ComposedZincSnapshot(frozen, logExceeded)).toThrow("reserved iteration/pass");

        const stateExceeded = snapshot(frozen);
        stateExceeded.stateText = JSON.stringify({ pass: 9, gen: 1 });
        expect(() => validateV07ComposedZincSnapshot(frozen, stateExceeded)).toThrow("reserved pass/generation");

        const generationExceeded = snapshot(frozen);
        generationExceeded.logText += "\n[cem] pass 1 gen 13/13: escaped";
        expect(() => validateV07ComposedZincSnapshot(frozen, generationExceeded)).toThrow("generation marker crossed");
    });

    it("fails closed on source drift, environment drift, or a late snapshot", () => {
        const frozen = contract();
        const scannerExclusionDrift = snapshot(frozen);
        scannerExclusionDrift.readOnlyScannerConfig.excludedPathPrefixes = [];
        expect(() => validateV07ComposedZincSnapshot(frozen, scannerExclusionDrift)).toThrow(
            "scanner config projection drifted",
        );

        const sourceDrift = snapshot(frozen);
        sourceDrift.files[frozen.paths.cemScript] = "c".repeat(64);
        expect(() => validateV07ComposedZincSnapshot(frozen, sourceDrift)).toThrow("source hashes drifted");

        const environmentDrift = snapshot(frozen);
        environmentDrift.processes[1].environment.CEM_GAMES = "1";
        expect(() => validateV07ComposedZincSnapshot(frozen, environmentDrift)).toThrow("changed CEM_GAMES");

        const generationInjection = snapshot(frozen);
        generationInjection.processes[1].environment.CEM_GENS = "13";
        expect(() => validateV07ComposedZincSnapshot(frozen, generationInjection)).toThrow("injected CEM_GENS");

        const runtimeInjection = snapshot(frozen);
        runtimeInjection.processes[2].environment.BUN_PRELOAD = "/tmp/inject.ts";
        expect(() => validateV07ComposedZincSnapshot(frozen, runtimeInjection)).toThrow(
            "forbidden runtime injection BUN_PRELOAD",
        );

        const late = snapshot(frozen);
        late.capturedAt = "2026-07-17T06:00:01Z";
        expect(() => validateV07ComposedZincSnapshot(frozen, late)).toThrow("after the sealing deadline");
    });

    it("binds the initial process anchor and a narrow post-combat final window", () => {
        const frozen = contract();
        const initial = snapshot(frozen);
        frozen.initialObservation = {
            capturedAt: initial.capturedAt,
            keepalivePid: 10,
            cemPid: 11,
            keepaliveStartTicks: "100",
            cemStartTicks: "101",
            snapshotSha256: v07ComposedZincSnapshotSha256(initial),
        };
        expect(validateV07ComposedZincInitialSnapshot(frozen, initial).passed).toBe(true);

        const drifted = structuredClone(initial);
        drifted.processes[1].startTicks = "999";
        expect(() => validateV07ComposedZincInitialSnapshot(frozen, drifted)).toThrow("process anchor");

        const swappedLabels = structuredClone(frozen);
        swappedLabels.initialObservation.keepalivePid = 11;
        swappedLabels.initialObservation.keepaliveStartTicks = "101";
        swappedLabels.initialObservation.cemPid = 10;
        swappedLabels.initialObservation.cemStartTicks = "100";
        expect(() => validateV07ComposedZincInitialSnapshot(swappedLabels, initial)).toThrow("process anchor");

        expect(validateV07ComposedZincFinalSnapshot(frozen, initial, "2026-07-16T06:59:59Z").passed).toBe(true);
        expect(() => validateV07ComposedZincFinalSnapshot(frozen, initial, "2026-07-16T07:00:01Z")).toThrow(
            "must follow combat completion",
        );
        expect(() => validateV07ComposedZincFinalSnapshot(frozen, initial, "2026-07-16T06:54:59Z")).toThrow(
            "must follow combat completion",
        );
    });
});
