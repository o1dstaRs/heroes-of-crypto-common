/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    captureV07AlignedV2DependencyManifest,
    durableAtomicV07AlignedV2Text,
    runV07AlignedV2Supervisor,
    validateV07AlignedV2ComposedSeal,
    validateV07AlignedV2PreparedBundleLaunch,
    type IV07AlignedV2HostAssessment,
    type IV07AlignedV2LinuxProcessIdentity,
    type IV07AlignedV2OptimizerHandle,
    type IV07AlignedV2SupervisorClock,
    type IV07AlignedV2SupervisorConfig,
    type IV07AlignedV2SupervisorDependencies,
    type IV07AlignedV2SupervisorProvenance,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor";
import {
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";

const HOUR_MS = 3_600_000;
const RUN_FINGERPRINT = "a".repeat(64);
const TEST_BOOT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_PID_NAMESPACE = "pid:[4026531836]";

const processIdentity = (pid: number, pgid = pid, sid = pgid): IV07AlignedV2LinuxProcessIdentity => ({
    platform: "linux",
    bootId: TEST_BOOT_ID,
    pidNamespace: TEST_PID_NAMESPACE,
    pid,
    startTimeTicks: String(pid * 100),
    pgid,
    sid,
});

const rawSha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const canonical = (value: unknown): string => `${canonicalV07AlignedV2Json(value)}\n`;
const OWNER_TOKEN = "123e4567-e89b-42d3-a456-426614174000";

class FakeClock implements IV07AlignedV2SupervisorClock {
    public now = 0;
    public signal: "SIGHUP" | "SIGINT" | "SIGTERM" | null = null;
    public sleepMultiplier = 1;
    public afterSleep: (() => void) | null = null;

    public nowMs(): number {
        return this.now;
    }
    public requestedSignal(): "SIGHUP" | "SIGINT" | "SIGTERM" | null {
        return this.signal;
    }
    public async sleep(milliseconds: number): Promise<void> {
        this.now += milliseconds * this.sleepMultiplier;
        this.afterSleep?.();
    }
}

class FakeOptimizer implements IV07AlignedV2OptimizerHandle {
    public readonly pid: number;
    public readonly pgid: number;
    public alive = true;
    public exitCode: number | null = null;
    public readonly signals: NodeJS.Signals[] = [];
    public pollsUntilExit: number | null = null;
    public ignoreSignals = false;
    public readonly activations: string[] = [];

    public constructor(pid = 1001) {
        this.pid = pid;
        this.pgid = pid;
    }
    public async poll(): Promise<{ alive: boolean; exitCode: number | null }> {
        if (this.alive && this.pollsUntilExit !== null) {
            this.pollsUntilExit -= 1;
            if (this.pollsUntilExit < 0) this.alive = false;
        }
        return { alive: this.alive, exitCode: this.exitCode };
    }
    public activate(ownerToken: string): void {
        this.activations.push(ownerToken);
    }
    public signalGroup(signal: NodeJS.Signals): void {
        this.signals.push(signal);
        if (!this.ignoreSignals) {
            this.alive = false;
            this.exitCode ??= signal === "SIGTERM" ? 143 : 137;
        }
    }
}

const provenance = (): IV07AlignedV2SupervisorProvenance => {
    const unsigned = {
        schemaVersion: 1 as const,
        commit: "b".repeat(40),
        branch: "main" as const,
        originMain: "b".repeat(40),
        liveOriginMain: "b".repeat(40),
        originUrl: "git@github.com:o1dstaRs/heroes-of-crypto-common.git",
        originIdentity: "github.com/o1dstars/heroes-of-crypto-common",
        cleanIncludingUntracked: true as const,
        statusPorcelainSha256: fingerprintV07AlignedV2(""),
        sourceTreeSha256: "c".repeat(64),
        bunVersion: "1.3.14",
        bunRevision: "d".repeat(40),
        bunExecutableSha256: "e".repeat(64),
        dependencyPackages: 12,
        dependencyManifestSha256: "f".repeat(64),
        lockfileSha256: null,
    };
    return { ...unsigned, provenanceSha256: fingerprintV07AlignedV2(unsigned) };
};

const provenanceAfterRemoteAdvance = (): IV07AlignedV2SupervisorProvenance => {
    const initial = provenance();
    const unsigned = { ...initial, liveOriginMain: "9".repeat(40) };
    delete (unsigned as Partial<IV07AlignedV2SupervisorProvenance>).provenanceSha256;
    return { ...unsigned, provenanceSha256: fingerprintV07AlignedV2(unsigned) } as IV07AlignedV2SupervisorProvenance;
};

const config = (outputDirectory: string): IV07AlignedV2SupervisorConfig => ({
    outputDirectory,
    repositoryRoot: "/repo",
    definitionPath: "/repo/definition.json",
    definitionSha256: "1".repeat(64),
    composedSealPath: "/evidence/composed-seal.json",
    composedSealSha256: "2".repeat(64),
    composedSealAttestation: {
        manifestId: "composed-predecessor",
        qualificationVerdict: "FAIL",
        sealedAt: "2026-07-16T12:00:00.000Z",
        sha256: "2".repeat(64),
    },
    runFingerprint: RUN_FINGERPRINT,
    startAtMs: 0,
    deadlineAtMs: 96 * HOUR_MS,
    optimizerEntry: "/repo/src/simulation/optimizer/v0_7_aligned_96h_v2_runner.ts",
    optimizerEntrySha256: "3".repeat(64),
    optimizerArgs: ["--run", "--config=/inputs/runner-config.json"],
    runnerConfigPath: "/inputs/runner-config.json",
    runnerConfigSha256: "4".repeat(64),
    runnerConfigBytesSha256: "5".repeat(64),
    rateAttestationPath: "/inputs/throughput.json",
    rateAttestationSha256: "6".repeat(64),
    rateAttestationBytesSha256: "7".repeat(64),
    preparedBundlePath: "/inputs/prepared/bundle.json",
    preparedBundleSha256: "8".repeat(64),
    preparedBundleBytesSha256: "9".repeat(64),
    heartbeatIntervalMs: 100,
    runnerStartupWatchdogMs: 1000,
    runnerProgressWatchdogMs: 3000,
    hostProbeIntervalMs: 1000,
    watchdogMs: 2000,
    hostProbeTimeoutMs: 500,
    restartBaseMs: 100,
    restartMaxMs: 400,
    maxRestarts: 3,
    stopGraceMs: 100,
    minimumIdleCpus: 1,
    niceLevel: 10,
    provenance: provenance(),
});

const healthy = (): IV07AlignedV2HostAssessment => ({
    schemaVersion: 1,
    ok: true,
    reasons: [],
    minimumIdleCpus: 1,
    cpuCount: 12,
    idleCpus: 4,
    blockers: [],
});

const terminal = () => {
    const unsigned = {
        schemaVersion: 1 as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runFingerprint: RUN_FINGERPRINT,
        frozenCandidateSha256: null,
        reason: "no_eligible_candidate" as const,
        verdict: "INCOMPLETE" as const,
        promotion: null,
        final: null,
    };
    return { ...unsigned, terminalSha256: fingerprintV07AlignedV2(unsigned) };
};

const dependencies = (
    clock: FakeClock,
    spawn: () => FakeOptimizer,
    terminalAt: () => boolean = () => false,
    probe: () => IV07AlignedV2HostAssessment = healthy,
): IV07AlignedV2SupervisorDependencies => {
    let runnerSequence = 0;
    return {
        clock,
        processId: 77,
        readProcessIdentity: (pid) => processIdentity(pid),
        probeProcessGroup: () => "alive",
        captureProvenance: provenance,
        verifyImmutableInputs: () => undefined,
        probeHost: async () => probe(),
        spawnOptimizer: async () => spawn(),
        validateTerminal: () => (terminalAt() ? terminal() : null),
        readRunnerHeartbeat: () => {
            const unsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat" as const,
                runFingerprint: RUN_FINGERPRINT,
                sequence: runnerSequence++,
                phase: "test-progress",
                activePanelFingerprint: null,
                activeGenomeSha256: null,
                completedShards: 0,
                completedGames: 0,
                eventHeadSha256: null,
                updatedAtMs: clock.nowMs(),
            };
            return { ...unsigned, heartbeatSha256: fingerprintV07AlignedV2(unsigned) };
        },
        log: () => undefined,
    };
};

const writeSelfHashedFixture = (
    path: string,
    unsigned: Record<string, unknown>,
    hashField: string,
): Record<string, unknown> => {
    const value = { ...unsigned, [hashField]: fingerprintV07AlignedV2(unsigned) };
    writeFileSync(path, canonical(value));
    return value;
};

const writeStaleOwnership = (
    root: string,
    options: {
        attempt?: number;
        child?: boolean;
        activationState?: "pre_activation" | "activated";
        pidRecord?: boolean;
    } = {},
): { armed: Record<string, unknown>; pidRecord: Record<string, unknown> | null } => {
    const attempt = options.attempt ?? 1;
    const child = options.child ?? true;
    const activationState = options.activationState ?? (child ? "activated" : "pre_activation");
    const supervisor = processIdentity(55);
    const guard = child ? processIdentity(1001) : null;
    const armed = writeSelfHashedFixture(
        join(root, "SUPERVISOR_ARMED.json"),
        {
            schemaVersion: 2,
            artifactKind: "v0_7_aligned_96h_v2_supervisor_armed",
            runFingerprint: RUN_FINGERPRINT,
            ownerToken: OWNER_TOKEN,
            supervisorPid: supervisor.pid,
            supervisorIdentity: supervisor,
            attempt,
            activationState,
            childPid: guard?.pid ?? null,
            childPgid: guard?.pgid ?? null,
            childIdentity: guard,
            armedAtMs: 100,
        },
        "armedSha256",
    );
    const pidRecord =
        guard && (options.pidRecord ?? true)
            ? writeSelfHashedFixture(
                  join(root, "optimizer.pid.json"),
                  {
                      schemaVersion: 2,
                      artifactKind: "v0_7_aligned_96h_v2_optimizer_pid",
                      runFingerprint: RUN_FINGERPRINT,
                      attempt,
                      pid: guard.pid,
                      pgid: guard.pgid,
                      identity: guard,
                      ownerToken: OWNER_TOKEN,
                      startedAtMs: 100,
                  },
                  "pidRecordSha256",
              )
            : null;
    return { armed, pidRecord };
};

const initializeSupervisorFixture = async (root: string): Promise<void> => {
    const setupClock = new FakeClock();
    setupClock.signal = "SIGTERM";
    await runV07AlignedV2Supervisor(
        config(root),
        dependencies(setupClock, () => new FakeOptimizer()),
    );
};

function temporaryDirectory(): string {
    return mkdtempSync(join(tmpdir(), "v07-aligned-supervisor-"));
}

describe("v0.7 aligned v2 durable supervisor", () => {
    it("requires the exact prepared-bundle inventory and binds every launch input", () => {
        const root = temporaryDirectory();
        const prepared = join(root, "prepared");
        const seedDirectory = join(prepared, "seed-allocation");
        const definitionPath = join(prepared, "definition.json");
        const bundlePath = join(prepared, "bundle.json");
        const commitmentPath = join(seedDirectory, "commitment.json");
        try {
            mkdirSync(seedDirectory, { recursive: true });
            const commitmentSha256 = "c".repeat(64);
            const commitmentBytes = canonical({ commitmentSha256 });
            const definitionBytes = canonical({ definition: "fixture" });
            writeFileSync(commitmentPath, commitmentBytes);
            writeFileSync(definitionPath, definitionBytes);
            const budgetUnsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_throughput_budget" as const,
                totalWorkers: 4,
                reservedCpus: 2,
                trainGames: 100,
                confirmGames: 20,
                finalGames: 20,
                trainWindowHours: 42,
                confirmWindowHours: 18,
                finalWindowHours: 36,
                estimatedTrainHours: 1,
                estimatedConfirmHours: 1,
                estimatedFinalHours: 1,
                finalHoursReserved: 36,
                actualLogicalCpus: 8,
                maxShardGames: 16,
                estimatedMaxShardMinutes: 1,
                shardTimeoutMinutes: 30,
                rateAttestationSha256: "6".repeat(64),
                rateAttestationBytesSha256: "7".repeat(64),
                passed: true as const,
            };
            const budget = { ...budgetUnsigned, budgetSha256: fingerprintV07AlignedV2(budgetUnsigned) };
            const definitionSha256 = "d".repeat(64);
            const definitionBytesSha256 = rawSha256(definitionBytes);
            const commitmentBytesSha256 = rawSha256(commitmentBytes);
            const bundleUnsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_prepared_definition_bundle" as const,
                status: "research_only_no_bake" as const,
                automaticBake: false as const,
                automaticDeploy: false as const,
                runFingerprint: RUN_FINGERPRINT,
                configSha256: "4".repeat(64),
                configBytesSha256: "5".repeat(64),
                requestSha256: "b".repeat(64),
                commitmentPath: "seed-allocation/commitment.json" as const,
                commitmentSha256,
                commitmentBytesSha256,
                definitionPath: "definition.json" as const,
                definitionSha256,
                definitionBytesSha256,
                composedSealBytesSha256: "2".repeat(64),
                rateAttestationSha256: "6".repeat(64),
                rateAttestationBytesSha256: "7".repeat(64),
                budget,
                gamesExecuted: 0 as const,
                workersStarted: 0 as const,
            };
            const bundle = { ...bundleUnsigned, bundleSha256: fingerprintV07AlignedV2(bundleUnsigned) };
            const bundleBytes = canonical(bundle);
            writeFileSync(bundlePath, bundleBytes);
            const expected = {
                bundlePath,
                definitionPath: realpathSync(definitionPath),
                runFingerprint: RUN_FINGERPRINT,
                definitionSha256,
                definitionBytesSha256,
                composedSealBytesSha256: "2".repeat(64),
                runnerConfigSha256: "4".repeat(64),
                runnerConfigBytesSha256: "5".repeat(64),
                rateAttestationSha256: "6".repeat(64),
                rateAttestationBytesSha256: "7".repeat(64),
                seedCommitment: {
                    path: "seed-allocation/commitment.json",
                    artifactSha256: commitmentSha256,
                    bytesSha256: commitmentBytesSha256,
                },
                budget,
            };

            expect(validateV07AlignedV2PreparedBundleLaunch(expected)).toMatchObject({
                bundlePath: realpathSync(bundlePath),
                bundleSha256: bundle.bundleSha256,
                bundleBytesSha256: rawSha256(bundleBytes),
                commitmentSha256,
                commitmentBytesSha256,
            });
            writeFileSync(join(prepared, "unreviewed.json"), "{}\n");
            expect(() => validateV07AlignedV2PreparedBundleLaunch(expected)).toThrow("root inventory is not exact");
            rmSync(join(prepared, "unreviewed.json"));
            expect(() =>
                validateV07AlignedV2PreparedBundleLaunch({
                    ...expected,
                    runnerConfigSha256: "f".repeat(64),
                }),
            ).toThrow("does not bind the exact launch inputs");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts only an exact, internally bound composed predecessor seal", () => {
        const parent = temporaryDirectory();
        const manifestId = "composed-predecessor";
        const root = join(parent, manifestId);
        mkdirSync(root, { recursive: true });
        const writeArtifact = (path: string, bytes: string): { path: string; sha256: string } => {
            const destination = join(root, path);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, bytes);
            return { path, sha256: rawSha256(bytes) };
        };
        try {
            const manifest = writeArtifact("manifest.json", pretty({ manifestId, cells: [{ id: "cell-a" }] }));
            const contract = writeArtifact(
                "zinc-guard/contract.json",
                pretty({ sealBefore: "2026-07-16T12:02:00.000Z" }),
            );
            const guardSpecifications = [
                { phase: "initial", checkedAt: "2026-07-16T11:58:30.000Z", logText: "a" },
                { phase: "periodic", checkedAt: "2026-07-16T11:59:00.000Z", logText: "ab" },
                { phase: "pre", checkedAt: "2026-07-16T11:59:20.000Z", logText: "abc" },
                { phase: "post-assembly", checkedAt: "2026-07-16T11:59:45.000Z", logText: "abcd" },
            ];
            const snapshots: Array<{ capturedAt: string; logText: string }> = [];
            const guardLedger = guardSpecifications.map((specification, sequence) => {
                const snapshot = {
                    capturedAt: specification.checkedAt,
                    logText: specification.logText,
                };
                snapshots.push(snapshot);
                const snapshotSha256 = rawSha256(pretty(snapshot));
                const path =
                    sequence < 2
                        ? `zinc-guard/prelaunch/artifacts/${String(sequence).padStart(4, "0")}-${specification.phase}.json`
                        : `zinc-guard/${String(sequence).padStart(4, "0")}-${specification.phase}.json`;
                const artifact = writeArtifact(
                    path,
                    pretty({
                        phase: specification.phase,
                        result: { checkedAt: specification.checkedAt, snapshotSha256, passed: true },
                        snapshot,
                    }),
                );
                return {
                    sequence,
                    phase: specification.phase,
                    path,
                    sha256: artifact.sha256,
                    checkedAt: specification.checkedAt,
                    snapshotSha256,
                };
            });
            const initialSnapshot = writeArtifact("zinc-guard/initial-source.json", pretty(snapshots[0]));
            const prelaunchEntries = guardLedger.slice(0, 2).map((entry) => ({
                ...entry,
                path: entry.path.replace("zinc-guard/prelaunch/", ""),
            }));
            const prelaunchLedgerValue = {
                schemaVersion: 1,
                guardIntervalMs: 60_000,
                maxGuardGapMs: 90_000,
                startedAt: guardLedger[0].checkedAt,
                updatedAt: guardLedger[1].checkedAt,
                status: "monitoring",
                entries: prelaunchEntries,
            };
            const checkpoint = writeArtifact("zinc-guard/prelaunch/checkpoint.json", pretty(prelaunchLedgerValue));
            const prelaunchLedger = writeArtifact(
                "zinc-guard/prelaunch/ledger-source.json",
                pretty(prelaunchLedgerValue),
            );
            writeArtifact("zinc-guard/ledger.json", pretty(guardLedger));
            const raw = writeArtifact("cells/cell-a/raw.jsonl", '{"game":1}\n');
            const audit = writeArtifact("cells/cell-a/audit/worker-0.jsonl", '{"audit":true}\n');
            const completionBytes = pretty({ cellId: "cell-a", raw, audits: [audit] });
            const completion = writeArtifact("cells/cell-a/complete.json", completionBytes);
            const cellEvidence = [{ cellId: "cell-a", completion, raw, audits: [audit] }];
            const completionEvidenceSha256 = createHash("sha256")
                .update(completion.path)
                .update("\0")
                .update(completionBytes)
                .update("\0")
                .digest("hex");
            const finalReport = writeArtifact(
                "final-report.json",
                pretty({
                    schemaVersion: 1,
                    manifestId,
                    manifestSha256: manifest.sha256,
                    authority: "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL",
                    allCellsComplete: true,
                    completionEvidence: {
                        derivation: "sha256_manifest_ordered_completion_marker_paths_and_bytes",
                        markers: 1,
                        sha256: completionEvidenceSha256,
                    },
                    qualification: { verdict: "FAIL" },
                    releaseInstruction: "NO_AUTOMATIC_BAKE_OR_DEPLOY",
                }),
            );
            const seal = {
                schemaVersion: 1,
                manifestId,
                manifestPath: manifest.path,
                manifestSha256: manifest.sha256,
                guardContractPath: contract.path,
                guardContractSha256: contract.sha256,
                initialSnapshotPath: initialSnapshot.path,
                initialSnapshotSha256: initialSnapshot.sha256,
                prelaunchCheckpointPath: checkpoint.path,
                prelaunchCheckpointSha256: checkpoint.sha256,
                prelaunchLedgerPath: prelaunchLedger.path,
                prelaunchLedgerSha256: prelaunchLedger.sha256,
                prelaunchEntries: 2,
                prelaunchFirstCapturedAt: guardLedger[0].checkedAt,
                prelaunchLastCapturedAt: guardLedger[1].checkedAt,
                guardIntervalMs: 60_000,
                maxGuardGapMs: 90_000,
                guardLedger,
                guardLedgerSha256: rawSha256(pretty(guardLedger)),
                finalReportPath: finalReport.path,
                finalReportSha256: finalReport.sha256,
                cellEvidence,
                cellEvidenceSha256: rawSha256(pretty(cellEvidence)),
                qualificationVerdict: "FAIL",
                sealedAt: "2026-07-16T12:00:00.000Z",
                guardPassed: true,
            };
            const sealBytes = pretty(seal);
            const sealPath = join(root, "sealed-run.json");
            writeFileSync(sealPath, sealBytes);

            expect(validateV07AlignedV2ComposedSeal(sealPath, rawSha256(sealBytes))).toEqual({
                manifestId,
                qualificationVerdict: "FAIL",
                sealedAt: "2026-07-16T12:00:00.000Z",
                sha256: rawSha256(sealBytes),
            });

            writeFileSync(join(root, finalReport.path), pretty({ qualification: { verdict: "PASS" } }));
            expect(() => validateV07AlignedV2ComposedSeal(sealPath, rawSha256(sealBytes))).toThrow(
                "bytes changed after composed seal",
            );
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("binds installed dependency paths, modes, types, and raw implementation bytes", () => {
        const root = temporaryDirectory();
        const packageRoot = join(root, "node_modules", "fixture-package");
        const implementation = join(packageRoot, "index.js");
        try {
            mkdirSync(packageRoot, { recursive: true });
            writeFileSync(join(packageRoot, "package.json"), '{"name":"fixture-package","version":"1.0.0"}\n');
            writeFileSync(implementation, "export const value = 1;\n");

            const baseline = captureV07AlignedV2DependencyManifest(root);
            expect(baseline).toMatchObject({ packages: 1, files: 2, directories: 2, links: 0 });

            writeFileSync(implementation, "export const value = 2;\n");
            const changedBytes = captureV07AlignedV2DependencyManifest(root);
            expect(changedBytes.packages).toBe(baseline.packages);
            expect(changedBytes.sha256).not.toBe(baseline.sha256);

            chmodSync(implementation, 0o755);
            const changedMode = captureV07AlignedV2DependencyManifest(root);
            expect(changedMode.sha256).not.toBe(changedBytes.sha256);

            rmSync(implementation);
            mkdirSync(implementation);
            const changedType = captureV07AlignedV2DependencyManifest(root);
            expect(changedType.sha256).not.toBe(changedMode.sha256);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("hashes standard in-tree executable links and rejects other dependency symlinks", () => {
        const root = temporaryDirectory();
        const packageRoot = join(root, "node_modules", "fixture-package");
        const binRoot = join(root, "node_modules", ".bin");
        try {
            mkdirSync(packageRoot, { recursive: true });
            mkdirSync(binRoot);
            writeFileSync(join(packageRoot, "package.json"), '{"name":"fixture-package","version":"1.0.0"}\n');
            writeFileSync(join(packageRoot, "first.js"), "first\n");
            writeFileSync(join(packageRoot, "second.js"), "second\n");
            const executableLink = join(binRoot, "fixture");
            symlinkSync("../fixture-package/first.js", executableLink);
            const first = captureV07AlignedV2DependencyManifest(root);
            expect(first.links).toBe(1);

            rmSync(executableLink);
            symlinkSync("../fixture-package/second.js", executableLink);
            expect(captureV07AlignedV2DependencyManifest(root).sha256).not.toBe(first.sha256);

            symlinkSync("first.js", join(packageRoot, "unsafe-link.js"));
            expect(() => captureV07AlignedV2DependencyManifest(root)).toThrow(
                "installed dependency contains an unsafe symlink",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("fsyncs the file and parent directory around atomic rename", () => {
        const root = temporaryDirectory();
        try {
            const steps: string[] = [];
            const destination = join(root, "nested", "value.json");
            durableAtomicV07AlignedV2Text(destination, "value\n", {
                afterDurableStep: (step) => steps.push(step),
            });
            expect(readFileSync(destination, "utf8")).toBe("value\n");
            expect(steps).toEqual(["file-fsync", "rename", "directory-fsync"]);

            expect(() =>
                durableAtomicV07AlignedV2Text(join(root, "failed"), "x", {
                    afterDurableStep: (step) => {
                        if (step === "file-fsync") throw new Error("injected crash");
                    },
                }),
            ).toThrow("injected crash");
            expect(readdirSync(root).some((name) => name.startsWith("failed.tmp."))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects malformed UTF-8 before reusing an authoritative lifecycle artifact", async () => {
        const root = temporaryDirectory();
        try {
            const setupClock = new FakeClock();
            setupClock.signal = "SIGTERM";
            await runV07AlignedV2Supervisor(
                config(root),
                dependencies(setupClock, () => new FakeOptimizer()),
            );
            writeFileSync(join(root, "supervisor.heartbeat.json"), Buffer.from([0xff, 0x0a]));
            await expect(
                runV07AlignedV2Supervisor(
                    config(root),
                    dependencies(new FakeClock(), () => new FakeOptimizer()),
                ),
            ).rejects.toThrow("existing heartbeat is not valid UTF-8");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses to adopt payload that predates the immutable supervisor run record", async () => {
        const root = temporaryDirectory();
        writeFileSync(join(root, "unowned-evidence.json"), "{}\n");
        try {
            await expect(
                runV07AlignedV2Supervisor(
                    config(root),
                    dependencies(new FakeClock(), () => new FakeOptimizer()),
                ),
            ).rejects.toThrow("refusing to adopt preexisting unsupervised output");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts a terminal only through the injected replay validator and stops the owned group", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(
                    clock,
                    () => child,
                    () => clock.now >= 100,
                ),
            );
            expect(result).toMatchObject({ stop: "terminal", attempts: 1 });
            expect(child.signals).toEqual(["SIGTERM"]);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            const run = JSON.parse(readFileSync(join(root, "supervisor-run.json"), "utf8"));
            expect(run).toMatchObject({
                status: "research_only_no_bake",
                automaticBake: false,
                automaticDeploy: false,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps authentic supervisor heartbeats advancing during verified terminal replay", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        const injected = dependencies(clock, () => child);
        injected.validateTerminal = (onReplayProgress) => {
            if (clock.now < 100) return null;
            for (let verifiedShard = 0; verifiedShard < 25; verifiedShard += 1) {
                clock.now += 100;
                onReplayProgress();
            }
            return terminal();
        };
        try {
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "terminal", attempts: 1 });
            expect(clock.now).toBeGreaterThan(config(root).watchdogMs);
            expect(child.signals).toEqual(["SIGTERM"]);
            const heartbeat = JSON.parse(readFileSync(join(root, "supervisor.heartbeat.json"), "utf8")) as {
                sequence: number;
                state: string;
            };
            expect(heartbeat.sequence).toBeGreaterThanOrEqual(25);
            expect(heartbeat.state).toBe("terminal");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a pinned clean launch valid when origin/main advances elsewhere", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        const injected = dependencies(
            clock,
            () => child,
            () => clock.now >= 100,
        );
        injected.captureProvenance = provenanceAfterRemoteAdvance;
        try {
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "terminal", attempts: 1 });
            expect(child.signals).toEqual(["SIGTERM"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("makes zero exit without a terminal permanently invalid and never restarts it", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            const first = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    const child = new FakeOptimizer();
                    child.pollsUntilExit = 0;
                    child.exitCode = 0;
                    return child;
                }),
            );
            expect(first.stop).toBe("invalid");
            expect(spawns).toBe(1);
            expect(readFileSync(join(root, "SUPERVISOR_INVALID.json"), "utf8")).toContain("zero-exit-without-terminal");

            const second = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            expect(second.stop).toBe("invalid");
            expect(spawns).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("permanently quarantines failed host preflight without spawning", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            const blocked = (): IV07AlignedV2HostAssessment => ({
                ...healthy(),
                ok: false,
                reasons: ["other-hoc-compute-process"],
                blockers: [{ pid: 91 }],
            });
            const first = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(
                    clock,
                    () => {
                        spawns += 1;
                        return new FakeOptimizer();
                    },
                    () => false,
                    blocked,
                ),
            );
            expect(first.stop).toBe("quarantined");
            expect(spawns).toBe(0);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");

            const second = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            expect(second.stop).toBe("quarantined");
            expect(spawns).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("promotes a stale armed sentinel to permanent quarantine", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            clock.signal = "SIGTERM";
            await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            clock.signal = null;
            writeFileSync(join(root, "SUPERVISOR_ARMED.json"), "stale\n");
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            expect(result).toMatchObject({ stop: "quarantined", attempts: 0 });
            expect(spawns).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reclaims only a conclusively dead Linux owner and group, then resumes the durable attempt", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const replacement = new FakeOptimizer(2001);
        let spawned = false;
        let oldChildReads = 0;
        let groupChecks = 0;
        try {
            await initializeSupervisorFixture(root);
            const stale = writeStaleOwnership(root, { attempt: 1 });
            const injected = dependencies(clock, () => replacement);
            injected.readProcessIdentity = (pid) => {
                if (pid === 55) return null;
                if (pid === 1001) return oldChildReads++ === 0 ? processIdentity(1001) : null;
                return processIdentity(pid);
            };
            injected.probeProcessGroup = () => (groupChecks++ === 0 ? "alive" : "absent");
            injected.spawnOptimizer = async (attempt, ownerToken) => {
                expect(attempt).toBe(2);
                expect(ownerToken).not.toBe(OWNER_TOKEN);
                spawned = true;
                return replacement;
            };
            clock.afterSleep = () => {
                if (spawned) clock.signal = "SIGTERM";
            };

            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "signal", attempts: 2 });
            expect(groupChecks).toBe(2);
            expect(replacement.activations).toHaveLength(1);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            expect(readdirSync(root)).not.toContain("optimizer.pid.json");
            const recoveryNames = readdirSync(join(root, "supervisor-recoveries"));
            expect(recoveryNames).toEqual([`${String(stale.armed.armedSha256)}.json`]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reclaims a dead pre-activation owner without inventing an optimizer group", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let groupChecks = 0;
        let spawns = 0;
        let immutableInputChecks = 0;
        try {
            await initializeSupervisorFixture(root);
            writeStaleOwnership(root, { child: false });
            const injected = dependencies(
                clock,
                () => {
                    spawns += 1;
                    return new FakeOptimizer();
                },
                () => true,
            );
            injected.readProcessIdentity = (pid) => (pid === 55 ? null : processIdentity(pid));
            injected.probeProcessGroup = () => {
                groupChecks += 1;
                return "absent";
            };
            injected.verifyImmutableInputs = () => {
                immutableInputChecks += 1;
            };

            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "terminal", attempts: 1 });
            expect(groupChecks).toBe(0);
            expect(spawns).toBe(0);
            expect(immutableInputChecks).toBe(2);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            const heartbeat = JSON.parse(readFileSync(join(root, "supervisor.heartbeat.json"), "utf8")) as Record<
                string,
                unknown
            >;
            expect(heartbeat).toMatchObject({ state: "terminal", attempt: 1, childPid: null });
            const { heartbeatSha256, ...unsignedHeartbeat } = heartbeat;
            expect(heartbeatSha256).toBe(fingerprintV07AlignedV2(unsignedHeartbeat));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("recovers both durable pre-activation child boundaries but rejects an activated record without its PID", async () => {
        for (const pidRecord of [false, true]) {
            const root = temporaryDirectory();
            try {
                await initializeSupervisorFixture(root);
                const stale = writeStaleOwnership(root, {
                    activationState: "pre_activation",
                    pidRecord,
                });
                const injected = dependencies(
                    new FakeClock(),
                    () => new FakeOptimizer(),
                    () => true,
                );
                injected.readProcessIdentity = (pid) => (pid === 55 || pid === 1001 ? null : processIdentity(pid));
                injected.probeProcessGroup = () => "absent";

                const result = await runV07AlignedV2Supervisor(config(root), injected);
                expect(result).toMatchObject({ stop: "terminal", attempts: 1 });
                const recovery = JSON.parse(
                    readFileSync(
                        join(root, "supervisor-recoveries", `${String(stale.armed.armedSha256)}.json`),
                        "utf8",
                    ),
                ) as { pidRecordSha256: string | null };
                expect(recovery.pidRecordSha256).toBe(pidRecord ? String(stale.pidRecord?.pidRecordSha256) : null);
                expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }

        const activatedRoot = temporaryDirectory();
        try {
            await initializeSupervisorFixture(activatedRoot);
            writeStaleOwnership(activatedRoot, { activationState: "activated", pidRecord: false });
            const injected = dependencies(new FakeClock(), () => new FakeOptimizer());
            injected.readProcessIdentity = (pid) => (pid === 55 || pid === 1001 ? null : processIdentity(pid));
            injected.probeProcessGroup = () => "absent";
            const result = await runV07AlignedV2Supervisor(config(activatedRoot), injected);
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("activated armed record has no matching optimizer ownership");
            expect(readdirSync(activatedRoot)).toContain("SUPERVISOR_ARMED.json");
        } finally {
            rmSync(activatedRoot, { recursive: true, force: true });
        }
    });

    it("leaves exact live ownership retryable without mutating its records", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            await initializeSupervisorFixture(root);
            const stale = writeStaleOwnership(root);
            const armedBefore = readFileSync(join(root, "SUPERVISOR_ARMED.json"), "utf8");
            const injected = dependencies(clock, () => {
                spawns += 1;
                return new FakeOptimizer();
            });
            injected.readProcessIdentity = (pid) => processIdentity(pid);

            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "busy", attempts: 1 });
            expect(readFileSync(join(root, "SUPERVISOR_ARMED.json"), "utf8")).toBe(armedBefore);
            expect(JSON.parse(armedBefore).armedSha256).toBe(stale.armed.armedSha256);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_QUARANTINED.json");
            expect(spawns).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("waits a bounded interval for an exact child group, then leaves ownership retryable", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        try {
            await initializeSupervisorFixture(root);
            writeStaleOwnership(root);
            const injected = dependencies(clock, () => new FakeOptimizer());
            injected.readProcessIdentity = (pid) => (pid === 55 ? null : processIdentity(pid));
            injected.probeProcessGroup = () => "alive";

            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result).toMatchObject({ stop: "busy", attempts: 1 });
            expect(clock.now).toBe(config(root).stopGraceMs);
            expect(readdirSync(root)).toContain("SUPERVISOR_ARMED.json");
            expect(readdirSync(root)).not.toContain("SUPERVISOR_QUARANTINED.json");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses PID reuse and ambiguous process-group ownership without signaling it", async () => {
        const reusedRoot = temporaryDirectory();
        const ambiguousRoot = temporaryDirectory();
        try {
            await initializeSupervisorFixture(reusedRoot);
            writeStaleOwnership(reusedRoot);
            const reused = dependencies(new FakeClock(), () => new FakeOptimizer());
            reused.readProcessIdentity = (pid) =>
                pid === 55 ? { ...processIdentity(pid), startTimeTicks: "999999" } : processIdentity(pid);
            const reusedResult = await runV07AlignedV2Supervisor(config(reusedRoot), reused);
            expect(reusedResult.stop).toBe("quarantined");
            expect(reusedResult.detail).toContain("stale-supervisor-pid-reused");
            expect(readdirSync(reusedRoot)).toContain("SUPERVISOR_ARMED.json");

            await initializeSupervisorFixture(ambiguousRoot);
            writeStaleOwnership(ambiguousRoot);
            let spawns = 0;
            const ambiguous = dependencies(new FakeClock(), () => {
                spawns += 1;
                return new FakeOptimizer();
            });
            ambiguous.readProcessIdentity = (pid) => (pid === 55 ? null : processIdentity(pid));
            ambiguous.probeProcessGroup = () => "ambiguous";
            const ambiguousResult = await runV07AlignedV2Supervisor(config(ambiguousRoot), ambiguous);
            expect(ambiguousResult.stop).toBe("quarantined");
            expect(ambiguousResult.detail).toContain("stale-child-group-ambiguous");
            expect(spawns).toBe(0);
            expect(readdirSync(ambiguousRoot)).toContain("SUPERVISOR_ARMED.json");
        } finally {
            rmSync(reusedRoot, { recursive: true, force: true });
            rmSync(ambiguousRoot, { recursive: true, force: true });
        }
    });

    it("does not activate work when the durable guard handshake fails", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        child.activate = () => {
            throw new Error("injected activation failure");
        };
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => child),
            );
            expect(result.stop).toBe("invalid");
            expect(result.detail).toContain("optimizer-activation-failed");
            expect(child.signals).toEqual(["SIGTERM"]);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            expect(readdirSync(root)).not.toContain("optimizer.pid.json");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("waits for the spawned guard to become the setsid leader before activation", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        child.pollsUntilExit = 0;
        child.exitCode = 0;
        let childIdentityReads = 0;
        try {
            const injected = dependencies(clock, () => child);
            injected.readProcessIdentity = (pid) => {
                if (pid !== child.pid) return processIdentity(pid);
                childIdentityReads += 1;
                return childIdentityReads === 1 ? processIdentity(pid, 77, 77) : processIdentity(pid);
            };
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result.stop).toBe("invalid");
            expect(result.detail).toContain("zero-exit-without-terminal");
            expect(childIdentityReads).toBe(2);
            expect(child.activations).toHaveLength(1);
            expect(clock.now).toBeGreaterThanOrEqual(10);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines an optimizer pid record that lost its armed ownership sentinel", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            clock.signal = "SIGTERM";
            await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            clock.signal = null;
            writeFileSync(join(root, "optimizer.pid.json"), "stale\n");
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            expect(result).toMatchObject({ stop: "quarantined", attempts: 0 });
            expect(result.detail).toContain("orphan-optimizer-pid-record");
            expect(spawns).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts a replay-valid terminal published just before the immutable deadline is observed", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        clock.sleepMultiplier = (96 * HOUR_MS) / 100;
        const child = new FakeOptimizer();
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(
                    clock,
                    () => child,
                    () => clock.now >= 96 * HOUR_MS,
                ),
            );
            expect(result.stop).toBe("terminal");
            expect(child.signals).toEqual(["SIGTERM"]);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_DEADLINE.json");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("gives the immutable deadline precedence over further work and never restarts after it", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        clock.sleepMultiplier = (96 * HOUR_MS) / 100;
        const child = new FakeOptimizer();
        try {
            const first = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => child),
            );
            expect(first.stop).toBe("deadline");
            expect(child.signals).toEqual(["SIGTERM"]);

            let spawns = 0;
            const second = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    return new FakeOptimizer();
                }),
            );
            expect(second.stop).toBe("deadline");
            expect(spawns).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines a heartbeat-loop watchdog lapse and cleans the process group", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        clock.sleepMultiplier = 30;
        const child = new FakeOptimizer();
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => child),
            );
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("supervisor-watchdog-lapse");
            expect(child.signals).toEqual(["SIGTERM"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines a live child that never publishes a runner-owned heartbeat", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        const injected = dependencies(clock, () => child);
        injected.readRunnerHeartbeat = () => null;
        try {
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("runner-heartbeat-startup-timeout");
            expect(child.signals).toEqual(["SIGTERM"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("requires a replacement child to advance the pre-spawn runner heartbeat", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        const injected = dependencies(clock, () => child);
        const unsigned = {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat" as const,
            runFingerprint: RUN_FINGERPRINT,
            sequence: 7,
            phase: "prior-attempt",
            activePanelFingerprint: null,
            activeGenomeSha256: null,
            completedShards: 3,
            completedGames: 48,
            eventHeadSha256: null,
            updatedAtMs: 0,
        };
        const unchanged = { ...unsigned, heartbeatSha256: fingerprintV07AlignedV2(unsigned) };
        injected.readRunnerHeartbeat = () => unchanged;
        try {
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("runner-heartbeat-startup-stale");
            expect(child.signals).toEqual(["SIGTERM"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines a child whose adopted runner heartbeat stops advancing", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        const injected = dependencies(clock, () => child);
        let reads = 0;
        injected.readRunnerHeartbeat = () => {
            const sequence = reads++ === 0 ? 0 : 1;
            const unsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat" as const,
                runFingerprint: RUN_FINGERPRINT,
                sequence,
                phase: sequence === 0 ? "prior-attempt" : "worker-running",
                activePanelFingerprint: null,
                activeGenomeSha256: null,
                completedShards: 0,
                completedGames: 0,
                eventHeadSha256: null,
                updatedAtMs: 0,
            };
            return { ...unsigned, heartbeatSha256: fingerprintV07AlignedV2(unsigned) };
        };
        try {
            const result = await runV07AlignedV2Supervisor(config(root), injected);
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("runner-heartbeat-progress-timeout");
            expect(child.signals).toEqual(["SIGTERM"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does controlled TERM cleanup without inventing terminal or refusal markers", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        const child = new FakeOptimizer();
        clock.afterSleep = () => {
            clock.signal = "SIGTERM";
        };
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => child),
            );
            expect(result.stop).toBe("signal");
            expect(child.signals).toEqual(["SIGTERM"]);
            expect(readdirSync(root)).not.toContain("SUPERVISOR_ARMED.json");
            expect(
                readdirSync(root).filter((name) => /^SUPERVISOR_(?:INVALID|QUARANTINED|DEADLINE)/.test(name)),
            ).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("restarts only transient nonzero exits and preserves monotone heartbeats", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(
                    clock,
                    () => {
                        spawns += 1;
                        const child = new FakeOptimizer(1000 + spawns);
                        if (spawns === 1) {
                            child.pollsUntilExit = 0;
                            child.exitCode = 9;
                        }
                        return child;
                    },
                    () => spawns === 2 && clock.now >= 300,
                ),
            );
            expect(result).toMatchObject({ stop: "terminal", attempts: 2 });
            expect(spawns).toBe(2);
            const heartbeat = JSON.parse(readFileSync(join(root, "supervisor.heartbeat.json"), "utf8"));
            expect(heartbeat.sequence).toBeGreaterThan(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("never restarts an optimizer stopped by the independent heartbeat watchdog", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    const child = new FakeOptimizer();
                    child.pollsUntilExit = 0;
                    child.exitCode = 121;
                    return child;
                }),
            );
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("independent-watchdog-stop");
            expect(spawns).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines a guard killed while force-cleaning its owned process group", async () => {
        const root = temporaryDirectory();
        const clock = new FakeClock();
        let spawns = 0;
        try {
            const result = await runV07AlignedV2Supervisor(
                config(root),
                dependencies(clock, () => {
                    spawns += 1;
                    const child = new FakeOptimizer();
                    child.pollsUntilExit = 0;
                    child.exitCode = 128;
                    return child;
                }),
            );
            expect(result.stop).toBe("quarantined");
            expect(result.detail).toContain("independent-watchdog-stop");
            expect(spawns).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the shell launch path setsid-owned and pipe-watchdog guarded", () => {
        const runner = readFileSync(new URL("../../scripts/run_v0_7_aligned_96h_v2.sh", import.meta.url), "utf8");
        const guard = readFileSync(
            new URL("../../scripts/v0_7_aligned_96h_v2_child_guard.sh", import.meta.url),
            "utf8",
        );
        const keepalive = readFileSync(
            new URL("../../scripts/v0_7_aligned_96h_v2_keepalive.sh", import.meta.url),
            "utf8",
        );
        const supervisor = readFileSync(
            new URL("../../src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor.ts", import.meta.url),
            "utf8",
        );
        expect(runner).toContain("V07_ALIGNED_V2_HOST_LOCK");
        expect(runner).toContain("flock -n 8");
        expect(runner).toContain("flock -n 9");
        expect(keepalive).toContain('--inspect-launch-window="${definition}"');
        expect(keepalive).toContain('! -e "${RUN_OUT}/supervisor-run.json"');
        expect(keepalive).toContain("status == 78");
        expect(keepalive).not.toContain("for marker in");
        expect(supervisor).toMatch(/spawn\(\s*"setsid"/);
        expect(supervisor).toContain("v0_7_aligned_96h_v2_initial_launch_window");
        expect(supervisor).not.toContain("shell: true");
        expect(supervisor).toContain('envInteger("V07_ALIGNED_V2_RUNNER_PROGRESS_WATCHDOG_MS", 300_000, 1000)');
        expect(supervisor).toContain("await child.activate(ownerToken)");
        expect(guard).toContain("supervisor pipe closed");
        expect(guard).toContain("supervisor heartbeat watchdog expired");
        expect(guard).toContain("immutable deadline reached");
        expect(guard).toContain('"${activation}" != "activate:${owner_token}"');
        expect(guard).toContain("/proc/[0-9]*/stat");
        expect(guard).toContain('read -r -t "${watchdog_seconds}" -u 3 activation');
        expect(guard).toContain('kill -KILL -- "-$$"');
        expect(guard).toContain("trap stop_group EXIT TERM INT HUP");
    });
});
