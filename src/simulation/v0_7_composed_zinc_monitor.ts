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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type PathLike } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    captureV07ComposedZincSnapshot,
    validateV07ComposedZincInitialSnapshot,
    validateV07ComposedZincSnapshot,
    type IV07ComposedZincGuardContract,
    type IV07ComposedZincGuardResult,
    type IV07ComposedZincSnapshot,
} from "./v0_7_composed_zinc_guard";

export const V07_COMPOSED_GUARD_INTERVAL_MS = 60_000;
export const V07_COMPOSED_MAX_GUARD_GAP_MS = 90_000;
const V07_COMPOSED_GUARD_CAPTURE_TARGET_MS = 45_000;

export interface IV07ComposedPrelaunchGuardArtifact {
    phase: "initial" | "periodic";
    result: IV07ComposedZincGuardResult;
    snapshot: IV07ComposedZincSnapshot;
}

export interface IV07ComposedPrelaunchLedgerEntry {
    sequence: number;
    phase: IV07ComposedPrelaunchGuardArtifact["phase"];
    path: string;
    sha256: string;
    checkedAt: string;
    snapshotSha256: string;
}

export interface IV07ComposedPrelaunchLedger {
    schemaVersion: 1;
    guardId: string;
    contractSha256: string;
    initialSnapshotSha256: string;
    guardIntervalMs: 60000;
    maxGuardGapMs: 90000;
    startedAt: string;
    updatedAt: string;
    status: "monitoring" | "stopped" | "failed";
    entries: IV07ComposedPrelaunchLedgerEntry[];
    stoppedAt?: string;
    failurePath?: "failure.json";
}

export interface IV07ComposedValidatedPrelaunchLedger {
    ledger: IV07ComposedPrelaunchLedger;
    ledgerBytes: string;
    ledgerSha256: string;
    artifacts: Array<{
        entry: IV07ComposedPrelaunchLedgerEntry;
        artifact: IV07ComposedPrelaunchGuardArtifact;
        bytes: string;
    }>;
    firstSnapshot: IV07ComposedZincSnapshot;
    lastSnapshot: IV07ComposedZincSnapshot;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalSnapshotArtifact(value: unknown): IV07ComposedZincSnapshot {
    if (value !== null && typeof value === "object" && "snapshot" in value) {
        return (value as { snapshot: IV07ComposedZincSnapshot }).snapshot;
    }
    return value as IV07ComposedZincSnapshot;
}

function canonicalInstant(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value;
}

function atomicWrite(path: PathLike, contents: string): void {
    const resolved = resolve(String(path));
    const temporary = `${resolved}.tmp-${process.pid}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, resolved);
}

function artifactRelativePath(sequence: number, phase: IV07ComposedPrelaunchGuardArtifact["phase"]): string {
    return `artifacts/${String(sequence).padStart(4, "0")}-${phase}.json`;
}

export function assertV07ComposedGuardContinuity(
    previous: IV07ComposedZincSnapshot,
    current: IV07ComposedZincSnapshot,
): number {
    const previousAt = Date.parse(previous.capturedAt);
    const currentAt = Date.parse(current.capturedAt);
    const gap = currentAt - previousAt;
    if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt) || gap < 0) {
        throw new Error("Zinc guard observations are not in chronological order");
    }
    if (gap > V07_COMPOSED_MAX_GUARD_GAP_MS) {
        throw new Error(`Zinc guard observation gap ${gap}ms exceeds ${V07_COMPOSED_MAX_GUARD_GAP_MS}ms`);
    }
    if (!current.logText.startsWith(previous.logText)) {
        throw new Error("Zinc concurrent-job log was truncated, replaced, or changed between guard observations");
    }
    return gap;
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function readV07ComposedPrelaunchLedger(
    ledgerPath: string,
    contract: IV07ComposedZincGuardContract,
    contractBytes: string,
    initialSnapshotBytes: string,
    zincCutoff: string,
): IV07ComposedValidatedPrelaunchLedger {
    const resolvedLedgerPath = resolve(ledgerPath);
    const ledgerRoot = dirname(resolvedLedgerPath);
    const ledgerBytes = readFileSync(resolvedLedgerPath, "utf8");
    const ledger = JSON.parse(ledgerBytes) as IV07ComposedPrelaunchLedger;
    const initialSnapshot = canonicalSnapshotArtifact(JSON.parse(initialSnapshotBytes) as unknown);
    if (
        ledger.schemaVersion !== 1 ||
        ledger.guardId !== contract.guardId ||
        ledger.contractSha256 !== sha256(contractBytes) ||
        ledger.initialSnapshotSha256 !== sha256(initialSnapshotBytes) ||
        ledger.guardIntervalMs !== V07_COMPOSED_GUARD_INTERVAL_MS ||
        ledger.maxGuardGapMs !== V07_COMPOSED_MAX_GUARD_GAP_MS ||
        !canonicalInstant(ledger.startedAt) ||
        !canonicalInstant(ledger.updatedAt) ||
        (ledger.status !== "monitoring" && ledger.status !== "stopped") ||
        ledger.failurePath !== undefined ||
        existsSync(join(ledgerRoot, "failure.json")) ||
        !Array.isArray(ledger.entries) ||
        ledger.entries.length < 2
    ) {
        throw new Error("Prelaunch Zinc guard ledger is incomplete, failed, or bound to different inputs");
    }
    if (!canonicalInstant(zincCutoff)) throw new Error("Zinc seed-audit cutoff is not canonical");

    const artifacts: IV07ComposedValidatedPrelaunchLedger["artifacts"] = [];
    let previousSnapshot: IV07ComposedZincSnapshot | undefined;
    for (const [index, entry] of ledger.entries.entries()) {
        const expectedPhase = index === 0 ? "initial" : "periodic";
        const expectedPath = artifactRelativePath(index, expectedPhase);
        if (
            entry.sequence !== index ||
            entry.phase !== expectedPhase ||
            entry.path !== expectedPath ||
            !/^[0-9a-f]{64}$/.test(entry.sha256) ||
            !/^[0-9a-f]{64}$/.test(entry.snapshotSha256)
        ) {
            throw new Error(`Prelaunch Zinc guard ledger entry ${index} is non-canonical`);
        }
        const artifactPath = resolve(ledgerRoot, entry.path);
        if (relative(ledgerRoot, artifactPath).startsWith("..")) {
            throw new Error(`Prelaunch Zinc guard artifact ${entry.path} escapes its ledger root`);
        }
        const bytes = readFileSync(artifactPath, "utf8");
        if (sha256(bytes) !== entry.sha256) {
            throw new Error(`Prelaunch Zinc guard artifact ${entry.path} changed after registration`);
        }
        const artifact = JSON.parse(bytes) as IV07ComposedPrelaunchGuardArtifact;
        if (artifact.phase !== expectedPhase) {
            throw new Error(`Prelaunch Zinc guard artifact ${entry.path} has the wrong phase`);
        }
        const result =
            index === 0
                ? validateV07ComposedZincInitialSnapshot(contract, artifact.snapshot, contractBytes)
                : validateV07ComposedZincSnapshot(contract, artifact.snapshot, contractBytes);
        if (
            !sameJson(result, artifact.result) ||
            result.checkedAt !== entry.checkedAt ||
            result.snapshotSha256 !== entry.snapshotSha256
        ) {
            throw new Error(`Prelaunch Zinc guard artifact ${entry.path} result differs from validation`);
        }
        if (index === 0) {
            if (!sameJson(artifact.snapshot, initialSnapshot) || ledger.startedAt !== artifact.snapshot.capturedAt) {
                throw new Error("Prelaunch Zinc guard ledger does not begin at the frozen initial snapshot");
            }
        } else {
            assertV07ComposedGuardContinuity(previousSnapshot!, artifact.snapshot);
        }
        previousSnapshot = artifact.snapshot;
        artifacts.push({ entry, artifact, bytes });
    }

    const firstSnapshot = artifacts[0].artifact.snapshot;
    const lastSnapshot = artifacts.at(-1)!.artifact.snapshot;
    const firstAt = Date.parse(firstSnapshot.capturedAt);
    const cutoffAt = Date.parse(zincCutoff);
    const lastAt = Date.parse(lastSnapshot.capturedAt);
    if (
        firstAt > cutoffAt ||
        cutoffAt > lastAt ||
        ledger.updatedAt !== lastSnapshot.capturedAt ||
        (ledger.status === "monitoring" && ledger.stoppedAt !== undefined) ||
        (ledger.status === "stopped" &&
            (!ledger.stoppedAt ||
                !canonicalInstant(ledger.stoppedAt) ||
                Date.parse(ledger.stoppedAt) < lastAt ||
                Date.parse(ledger.stoppedAt) - lastAt > V07_COMPOSED_MAX_GUARD_GAP_MS))
    ) {
        throw new Error("Prelaunch Zinc guard ledger does not continuously cover the seed-audit cutoff");
    }
    return {
        ledger,
        ledgerBytes,
        ledgerSha256: sha256(ledgerBytes),
        artifacts,
        firstSnapshot,
        lastSnapshot,
    };
}

interface IMonitorOptions {
    contractPath: string;
    initialSnapshotPath: string;
    identityFile: string;
    outputRoot: string;
}

function parseCli(argv: string[]): IMonitorOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            contract: { type: "string" },
            "initial-snapshot": { type: "string" },
            identity: { type: "string", default: "~/.ssh/id_ed25519_agent-zinc" },
            output: { type: "string" },
        },
    });
    if (!parsed.values.contract || !parsed.values["initial-snapshot"] || !parsed.values.output) {
        throw new Error("--contract, --initial-snapshot, and --output are required");
    }
    return {
        contractPath: resolve(parsed.values.contract),
        initialSnapshotPath: resolve(parsed.values["initial-snapshot"]),
        identityFile: resolve(parsed.values.identity!.replace(/^~(?=\/)/, homedir())),
        outputRoot: resolve(parsed.values.output),
    };
}

async function waitUntil(target: number, shouldStop: () => boolean): Promise<void> {
    while (!shouldStop() && Date.now() < target) {
        await new Promise<void>((resolvePromise) =>
            setTimeout(resolvePromise, Math.min(1_000, Math.max(0, target - Date.now()))),
        );
    }
}

async function runMonitor(options: IMonitorOptions): Promise<void> {
    if (existsSync(options.outputRoot)) {
        throw new Error(`Refusing to resume or overwrite prelaunch monitor ${options.outputRoot}`);
    }
    const contractBytes = readFileSync(options.contractPath, "utf8");
    const contract = JSON.parse(contractBytes) as IV07ComposedZincGuardContract;
    const initialSnapshotBytes = readFileSync(options.initialSnapshotPath, "utf8");
    const initialSnapshot = canonicalSnapshotArtifact(JSON.parse(initialSnapshotBytes) as unknown);
    const initialResult = validateV07ComposedZincInitialSnapshot(contract, initialSnapshot, contractBytes);
    mkdirSync(join(options.outputRoot, "artifacts"), { recursive: true });
    atomicWrite(join(options.outputRoot, "contract.json"), contractBytes);
    atomicWrite(join(options.outputRoot, "initial-source.json"), initialSnapshotBytes);

    const ledger: IV07ComposedPrelaunchLedger = {
        schemaVersion: 1,
        guardId: contract.guardId,
        contractSha256: sha256(contractBytes),
        initialSnapshotSha256: sha256(initialSnapshotBytes),
        guardIntervalMs: V07_COMPOSED_GUARD_INTERVAL_MS,
        maxGuardGapMs: V07_COMPOSED_MAX_GUARD_GAP_MS,
        startedAt: initialSnapshot.capturedAt,
        updatedAt: initialSnapshot.capturedAt,
        status: "monitoring",
        entries: [],
    };
    let previousSnapshot = initialSnapshot;

    const persist = (artifact: IV07ComposedPrelaunchGuardArtifact): void => {
        const sequence = ledger.entries.length;
        const path = artifactRelativePath(sequence, artifact.phase);
        const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
        atomicWrite(join(options.outputRoot, path), bytes);
        ledger.entries.push({
            sequence,
            phase: artifact.phase,
            path,
            sha256: sha256(bytes),
            checkedAt: artifact.result.checkedAt,
            snapshotSha256: artifact.result.snapshotSha256,
        });
        ledger.updatedAt = artifact.snapshot.capturedAt;
        atomicWrite(join(options.outputRoot, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(ledger.entries.at(-1))}\n`);
    };
    persist({ phase: "initial", result: initialResult, snapshot: initialSnapshot });

    let stopping = false;
    const requestStop = (): void => {
        stopping = true;
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    try {
        while (!stopping) {
            // Leave enough transport margin for the frozen three-attempt SSH retry policy.
            const target = Date.parse(previousSnapshot.capturedAt) + V07_COMPOSED_GUARD_CAPTURE_TARGET_MS;
            await waitUntil(target, () => stopping);
            if (stopping) break;
            const snapshot = captureV07ComposedZincSnapshot(contract, options.identityFile);
            assertV07ComposedGuardContinuity(previousSnapshot, snapshot);
            const result = validateV07ComposedZincSnapshot(contract, snapshot, contractBytes);
            previousSnapshot = snapshot;
            persist({ phase: "periodic", result, snapshot });
        }
        ledger.status = "stopped";
        ledger.stoppedAt = new Date().toISOString().replace(".000Z", "Z");
        atomicWrite(join(options.outputRoot, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
    } catch (error) {
        const failedAt = new Date().toISOString().replace(".000Z", "Z");
        atomicWrite(
            join(options.outputRoot, "failure.json"),
            `${JSON.stringify({ schemaVersion: 1, failedAt, error: String(error) }, null, 2)}\n`,
        );
        ledger.status = "failed";
        ledger.failurePath = "failure.json";
        atomicWrite(join(options.outputRoot, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
        throw error;
    }
}

if (import.meta.main) await runMonitor(parseCli(process.argv.slice(2)));
