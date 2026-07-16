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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    readV07ComposedPrelaunchLedger,
    type IV07ComposedPrelaunchGuardArtifact,
    type IV07ComposedPrelaunchLedger,
} from "../../src/simulation/v0_7_composed_zinc_monitor";
import {
    validateV07ComposedZincInitialSnapshot,
    validateV07ComposedZincSnapshot,
    v07ComposedZincSnapshotSha256,
    type IV07ComposedZincGuardContract,
    type IV07ComposedZincSnapshot,
} from "../../src/simulation/v0_7_composed_zinc_guard";

const ROOT = "/home/agent-zinc/hoc-common";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const temporaryRoots: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

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
        cutoff: "2026-07-16T07:00:30Z",
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
        guardId: "v0.7-composed-prelaunch-test",
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
            capturedAt: "2026-07-16T07:00:00Z",
            keepalivePid: 10,
            cemPid: 11,
            keepaliveStartTicks: "100",
            cemStartTicks: "101",
            snapshotSha256: HASH_A,
        },
    };
}

function snapshot(
    frozen: IV07ComposedZincGuardContract,
    capturedAt: string,
    logText: string,
): IV07ComposedZincSnapshot {
    const seed0 = frozen.limits.seed0Base + frozen.limits.iterationStep;
    return {
        schemaVersion: 1,
        capturedAt,
        files: { ...frozen.requiredFileSha256 },
        logText,
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

function writeHarness(
    snapshots: IV07ComposedZincSnapshot[],
    status: IV07ComposedPrelaunchLedger["status"] = "monitoring",
): {
    root: string;
    ledgerPath: string;
    frozen: IV07ComposedZincGuardContract;
    contractBytes: string;
    initialBytes: string;
    ledger: IV07ComposedPrelaunchLedger;
} {
    const root = mkdtempSync(join(tmpdir(), "v07-zinc-monitor-test-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "artifacts"));
    const frozen = contract();
    frozen.initialObservation.snapshotSha256 = v07ComposedZincSnapshotSha256(snapshots[0]);
    const contractBytes = `${JSON.stringify(frozen, null, 2)}\n`;
    const initialBytes = `${JSON.stringify(snapshots[0], null, 2)}\n`;
    const entries: IV07ComposedPrelaunchLedger["entries"] = [];
    for (const [sequence, observed] of snapshots.entries()) {
        const phase = sequence === 0 ? "initial" : "periodic";
        const result =
            sequence === 0
                ? validateV07ComposedZincInitialSnapshot(frozen, observed, contractBytes)
                : validateV07ComposedZincSnapshot(frozen, observed, contractBytes);
        const artifact: IV07ComposedPrelaunchGuardArtifact = { phase, result, snapshot: observed };
        const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
        const path = `artifacts/${String(sequence).padStart(4, "0")}-${phase}.json`;
        writeFileSync(join(root, path), bytes);
        entries.push({
            sequence,
            phase,
            path,
            sha256: sha256(bytes),
            checkedAt: result.checkedAt,
            snapshotSha256: result.snapshotSha256,
        });
    }
    const ledger: IV07ComposedPrelaunchLedger = {
        schemaVersion: 1,
        guardId: frozen.guardId,
        contractSha256: sha256(contractBytes),
        initialSnapshotSha256: sha256(initialBytes),
        guardIntervalMs: 60_000,
        maxGuardGapMs: 90_000,
        startedAt: snapshots[0].capturedAt,
        updatedAt: snapshots.at(-1)!.capturedAt,
        status,
        entries,
        ...(status === "stopped" ? { stoppedAt: snapshots.at(-1)!.capturedAt } : {}),
    };
    const ledgerPath = join(root, "ledger.json");
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    return { root, ledgerPath, frozen, contractBytes, initialBytes, ledger };
}

const BASE_LOG = "=== 06:14:21 f58b iter 1 seed 970911 START ===\n[cem] pass 1 gen 1/12: running";

describe("v0.7 composed Zinc prelaunch monitor evidence", () => {
    it("validates an immutable, cutoff-covering observation chain", () => {
        const frozen = contract();
        const harness = writeHarness([
            snapshot(frozen, "2026-07-16T07:00:00Z", BASE_LOG),
            snapshot(frozen, "2026-07-16T07:01:00Z", `${BASE_LOG}\nprogress`),
        ]);
        const verified = readV07ComposedPrelaunchLedger(
            harness.ledgerPath,
            harness.frozen,
            harness.contractBytes,
            harness.initialBytes,
            "2026-07-16T07:00:30Z",
        );
        expect(verified.artifacts).toHaveLength(2);
        expect(verified.lastSnapshot.capturedAt).toBe("2026-07-16T07:01:00Z");
    });

    it("fails on a gap, rewritten log, or cutoff outside the monitored interval", () => {
        const frozen = contract();
        const late = writeHarness([
            snapshot(frozen, "2026-07-16T07:00:00Z", BASE_LOG),
            snapshot(frozen, "2026-07-16T07:01:31Z", `${BASE_LOG}\nlate`),
        ]);
        expect(() =>
            readV07ComposedPrelaunchLedger(
                late.ledgerPath,
                late.frozen,
                late.contractBytes,
                late.initialBytes,
                "2026-07-16T07:00:30Z",
            ),
        ).toThrow("observation gap");

        const rewritten = writeHarness([
            snapshot(frozen, "2026-07-16T07:00:00Z", BASE_LOG),
            snapshot(frozen, "2026-07-16T07:01:00Z", `prefix-replaced\n${BASE_LOG}`),
        ]);
        expect(() =>
            readV07ComposedPrelaunchLedger(
                rewritten.ledgerPath,
                rewritten.frozen,
                rewritten.contractBytes,
                rewritten.initialBytes,
                "2026-07-16T07:00:30Z",
            ),
        ).toThrow("truncated, replaced, or changed");

        const valid = writeHarness([
            snapshot(frozen, "2026-07-16T07:00:00Z", BASE_LOG),
            snapshot(frozen, "2026-07-16T07:01:00Z", `${BASE_LOG}\nprogress`),
        ]);
        expect(() =>
            readV07ComposedPrelaunchLedger(
                valid.ledgerPath,
                valid.frozen,
                valid.contractBytes,
                valid.initialBytes,
                "2026-07-16T07:02:00Z",
            ),
        ).toThrow("does not continuously cover");
    });

    it("rejects forged status, a failure marker, or a stale stopped handoff", () => {
        const frozen = contract();
        const observed = [
            snapshot(frozen, "2026-07-16T07:00:00Z", BASE_LOG),
            snapshot(frozen, "2026-07-16T07:01:00Z", `${BASE_LOG}\nprogress`),
        ];
        const forged = writeHarness(observed);
        forged.ledger.status = "unknown" as IV07ComposedPrelaunchLedger["status"];
        writeFileSync(forged.ledgerPath, `${JSON.stringify(forged.ledger, null, 2)}\n`);
        expect(() =>
            readV07ComposedPrelaunchLedger(
                forged.ledgerPath,
                forged.frozen,
                forged.contractBytes,
                forged.initialBytes,
                "2026-07-16T07:00:30Z",
            ),
        ).toThrow("incomplete, failed");

        const failed = writeHarness(observed);
        writeFileSync(join(failed.root, "failure.json"), "{}\n");
        expect(() =>
            readV07ComposedPrelaunchLedger(
                failed.ledgerPath,
                failed.frozen,
                failed.contractBytes,
                failed.initialBytes,
                "2026-07-16T07:00:30Z",
            ),
        ).toThrow("incomplete, failed");

        const stopped = writeHarness(observed, "stopped");
        stopped.ledger.stoppedAt = "2026-07-16T07:02:31Z";
        writeFileSync(stopped.ledgerPath, `${JSON.stringify(stopped.ledger, null, 2)}\n`);
        expect(() =>
            readV07ComposedPrelaunchLedger(
                stopped.ledgerPath,
                stopped.frozen,
                stopped.contractBytes,
                stopped.initialBytes,
                "2026-07-16T07:00:30Z",
            ),
        ).toThrow("does not continuously cover");
    });
});
