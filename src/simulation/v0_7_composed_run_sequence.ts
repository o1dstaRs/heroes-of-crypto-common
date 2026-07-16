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

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    assertV07ComposedExecutionEnvironment,
    isV07ComposedBehaviorEnvironmentKey,
    readV07ComposedManifest,
    validateV07ComposedCellArtifact,
    validateV07ComposedFinalReport,
    V07_COMPOSED_MAX_CELL_ELAPSED_MS,
    type IV07ComposedCellCompletion,
    type IV07ComposedConcurrentGuardBinding,
    type IV07ComposedFinalReport,
} from "./v0_7_composed_ranked_ladder";
import {
    captureV07ComposedZincSnapshot,
    validateV07ComposedZincFinalSnapshot,
    validateV07ComposedZincSnapshot,
    type IV07ComposedZincGuardContract,
    type IV07ComposedZincGuardResult,
    type IV07ComposedZincSnapshot,
} from "./v0_7_composed_zinc_guard";
import {
    assertV07ComposedGuardContinuity,
    readV07ComposedPrelaunchLedger,
    V07_COMPOSED_GUARD_INTERVAL_MS,
    V07_COMPOSED_MAX_GUARD_GAP_MS,
} from "./v0_7_composed_zinc_monitor";

export {
    assertV07ComposedGuardContinuity,
    V07_COMPOSED_GUARD_INTERVAL_MS,
    V07_COMPOSED_MAX_GUARD_GAP_MS,
} from "./v0_7_composed_zinc_monitor";

const V07_COMPOSED_GUARD_CAPTURE_TARGET_MS = 45_000;

interface IV07ComposedGuardArtifact {
    phase: "initial" | "pre" | "periodic" | "post-cell" | "post-combat" | "post-assembly";
    result: IV07ComposedZincGuardResult;
    snapshot: IV07ComposedZincSnapshot;
}

interface IV07ComposedGuardLedgerEntry {
    sequence: number;
    phase: IV07ComposedGuardArtifact["phase"];
    path: string;
    sha256: string;
    checkedAt: string;
    snapshotSha256: string;
}

interface IV07ComposedSealedCellEvidence {
    cellId: string;
    completion: { path: string; sha256: string };
    raw: { path: string; sha256: string };
    audits: Array<{ path: string; sha256: string }>;
}

export interface IV07ComposedSealedRun {
    schemaVersion: 1;
    manifestId: string;
    manifestPath: "manifest.json";
    manifestSha256: string;
    guardContractPath: "zinc-guard/contract.json";
    guardContractSha256: string;
    initialSnapshotPath: "zinc-guard/initial-source.json";
    initialSnapshotSha256: string;
    prelaunchCheckpointPath: "zinc-guard/prelaunch/checkpoint.json";
    prelaunchCheckpointSha256: string;
    prelaunchLedgerPath: "zinc-guard/prelaunch/ledger-source.json";
    prelaunchLedgerSha256: string;
    prelaunchEntries: number;
    prelaunchFirstCapturedAt: string;
    prelaunchLastCapturedAt: string;
    guardIntervalMs: 60000;
    maxGuardGapMs: 90000;
    guardLedger: IV07ComposedGuardLedgerEntry[];
    guardLedgerSha256: string;
    finalReportPath: "final-report.json";
    finalReportSha256: string;
    cellEvidence: IV07ComposedSealedCellEvidence[];
    cellEvidenceSha256: string;
    qualificationVerdict: "PASS" | "FAIL";
    sealedAt: string;
    guardPassed: true;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function atomicWrite(path: string, contents: string): void {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
}

function sealedEvidencePath(runRoot: string, path: string): string {
    const absolute = resolve(runRoot, path);
    const fromRoot = relative(runRoot, absolute);
    if (!fromRoot || fromRoot.startsWith("..") || resolve(runRoot, fromRoot) !== absolute) {
        throw new Error(`Cell evidence path ${path} is outside the exact run root`);
    }
    return absolute;
}

function sealCellEvidence(
    runRoot: string,
    completions: readonly IV07ComposedCellCompletion[],
): { evidence: IV07ComposedSealedCellEvidence[]; sha256: string; completionEvidenceSha256: string } {
    const completionEvidenceHash = createHash("sha256");
    const evidence = completions.map((completion) => {
        const completionPath = `cells/${completion.cellId}/complete.json`;
        const completionBytes = readFileSync(sealedEvidencePath(runRoot, completionPath));
        const completionSha256 = sha256(completionBytes);
        completionEvidenceHash.update(completionPath);
        completionEvidenceHash.update("\0");
        completionEvidenceHash.update(completionBytes);
        completionEvidenceHash.update("\0");
        const rawSha256 = sha256(readFileSync(sealedEvidencePath(runRoot, completion.raw.path)));
        const audits = completion.audits.map((audit) => ({
            path: audit.path,
            sha256: sha256(readFileSync(sealedEvidencePath(runRoot, audit.path))),
        }));
        if (
            JSON.stringify(JSON.parse(completionBytes.toString("utf8"))) !== JSON.stringify(completion) ||
            rawSha256 !== completion.raw.sha256 ||
            audits.some((audit, index) => audit.sha256 !== completion.audits[index].sha256)
        ) {
            throw new Error(`${completion.cellId}: replay evidence changed after final artifact validation`);
        }
        return {
            cellId: completion.cellId,
            completion: { path: completionPath, sha256: completionSha256 },
            raw: { path: completion.raw.path, sha256: rawSha256 },
            audits,
        };
    });
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    return { evidence, sha256: sha256(bytes), completionEvidenceSha256: completionEvidenceHash.digest("hex") };
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (isV07ComposedBehaviorEnvironmentKey(key)) delete environment[key];
    }
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    environment.V07_COMPOSED_HOST_IDLE_ATTESTATION = "1";
    return environment;
}

interface IChildOutcome {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function waitForChild(child: ChildProcess): Promise<IChildOutcome> {
    return new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
}

function stopChild(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 10_000);
    force.unref();
}

interface ISequenceOptions {
    manifestPath: string;
    guardContractPath: string;
    initialSnapshotPath: string;
    prelaunchLedgerPath: string;
    identityFile: string;
    outputRoot: string;
    concurrency: 12;
}

function requireGuardBinding(manifest: unknown): IV07ComposedConcurrentGuardBinding {
    const binding = (
        manifest as {
            seedAudit?: { zinc?: { concurrentGuard?: IV07ComposedConcurrentGuardBinding } };
        }
    ).seedAudit?.zinc?.concurrentGuard;
    if (!binding) throw new Error("Composed-ranked manifest lacks the frozen Zinc concurrent-guard binding");
    return binding;
}

function parseCli(argv: string[], cwd = process.cwd()): ISequenceOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            manifest: {
                type: "string",
                default: join(cwd, "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json"),
            },
            "guard-contract": { type: "string" },
            "initial-snapshot": { type: "string" },
            "prelaunch-ledger": { type: "string" },
            identity: { type: "string", default: "~/.ssh/id_ed25519_agent-zinc" },
            output: { type: "string", default: join(dirname(cwd), "hoc-v07-composed-ranked-output") },
            concurrency: { type: "string", default: "12" },
        },
    });
    if (!parsed.values["guard-contract"] || !parsed.values["initial-snapshot"] || !parsed.values["prelaunch-ledger"]) {
        throw new Error("--guard-contract, --initial-snapshot, and --prelaunch-ledger are required");
    }
    if (parsed.values.concurrency !== "12") throw new Error("--concurrency must equal 12");
    return {
        manifestPath: resolve(parsed.values.manifest!),
        guardContractPath: resolve(parsed.values["guard-contract"]),
        initialSnapshotPath: resolve(parsed.values["initial-snapshot"]),
        prelaunchLedgerPath: resolve(parsed.values["prelaunch-ledger"]),
        identityFile: resolve(parsed.values.identity!.replace(/^~(?=\/)/, homedir())),
        outputRoot: resolve(parsed.values.output!),
        concurrency: 12,
    };
}

async function runSequence(options: ISequenceOptions): Promise<IV07ComposedSealedRun> {
    if (
        process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0" ||
        process.env.V07_COMPOSED_HOST_IDLE_ATTESTATION !== "1"
    ) {
        throw new Error(
            "Sequence parent requires BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 and V07_COMPOSED_HOST_IDLE_ATTESTATION=1",
        );
    }
    const loaded = readV07ComposedManifest(options.manifestPath);
    assertV07ComposedExecutionEnvironment(loaded.manifest, options.outputRoot);
    const manifestBytes = readFileSync(options.manifestPath, "utf8");
    if (sha256(manifestBytes) !== loaded.provenance.sha256) {
        throw new Error("Manifest bytes changed between validation and sequence binding");
    }
    const contractBytes = readFileSync(options.guardContractPath, "utf8");
    const contract = JSON.parse(contractBytes) as IV07ComposedZincGuardContract;
    const initialBytes = readFileSync(options.initialSnapshotPath, "utf8");
    const binding = requireGuardBinding(loaded.manifest);
    if (
        options.guardContractPath !== resolve(binding.contractPath) ||
        options.initialSnapshotPath !== resolve(binding.initialSnapshotPath) ||
        sha256(contractBytes) !== binding.contractSha256 ||
        sha256(initialBytes) !== binding.initialSnapshotSha256 ||
        contract.guardId !== binding.guardId ||
        JSON.stringify(contract.remote) !== JSON.stringify(binding.remote) ||
        contract.sealBefore !== binding.sealBefore ||
        contract.approvedReadOnlyScanner.cwd !== loaded.manifest.seedAudit.zinc.commonRoot ||
        contract.approvedReadOnlyScanner.sourcePath !== loaded.manifest.seedAudit.zinc.scannerSourcePath ||
        contract.approvedReadOnlyScanner.configPath !== loaded.manifest.seedAudit.zinc.scannerConfigPath ||
        contract.approvedReadOnlyScanner.cutoff !== loaded.manifest.seedAudit.zinc.cutoff ||
        contract.approvedReadOnlyScanner.seedSetOutput !== loaded.manifest.seedAudit.zinc.seedSetOutputPath ||
        contract.approvedReadOnlyScanner.summaryOutput !== loaded.manifest.seedAudit.zinc.scannerSummaryOutputPath ||
        JSON.stringify(contract.approvedReadOnlyScanner.excluded) !==
            JSON.stringify(loaded.manifest.seedAudit.zinc.excluded) ||
        JSON.stringify(contract.approvedReadOnlyScanner.excludedPathPrefixes) !==
            JSON.stringify(loaded.manifest.seedAudit.zinc.excludedPathPrefixes) ||
        JSON.stringify(contract.approvedReadOnlyScanner.excludedRelativeSuffixes) !==
            JSON.stringify(loaded.manifest.seedAudit.zinc.excludedRelativeSuffixes) ||
        contract.requiredFileSha256[contract.approvedReadOnlyScanner.sourcePath] !==
            loaded.manifest.seedAudit.zinc.scannerSourceSha256 ||
        contract.requiredFileSha256[contract.approvedReadOnlyScanner.configPath] !==
            loaded.manifest.seedAudit.zinc.scannerConfigSha256 ||
        binding.guardIntervalMs !== V07_COMPOSED_GUARD_INTERVAL_MS ||
        binding.maxGuardGapMs !== V07_COMPOSED_MAX_GUARD_GAP_MS ||
        binding.finalWindowMs !== 300_000
    ) {
        throw new Error("Sequence guard arguments or bytes differ from the exact manifest binding");
    }
    const zincAudit = loaded.manifest.seedAudit.zinc;
    const checkpoint = readV07ComposedPrelaunchLedger(
        binding.prelaunchCheckpoint.ledgerPath,
        contract,
        contractBytes,
        initialBytes,
        zincAudit.cutoff,
    );
    const prelaunch = readV07ComposedPrelaunchLedger(
        options.prelaunchLedgerPath,
        contract,
        contractBytes,
        initialBytes,
        zincAudit.cutoff,
    );
    if (
        resolve(binding.prelaunchCheckpoint.ledgerPath) !== binding.prelaunchCheckpoint.ledgerPath ||
        checkpoint.ledgerSha256 !== binding.prelaunchCheckpoint.ledgerSha256 ||
        checkpoint.artifacts.length !== binding.prelaunchCheckpoint.entries ||
        checkpoint.firstSnapshot.capturedAt !== binding.prelaunchCheckpoint.firstCapturedAt ||
        checkpoint.lastSnapshot.capturedAt !== binding.prelaunchCheckpoint.lastCapturedAt ||
        prelaunch.artifacts.length < checkpoint.artifacts.length ||
        JSON.stringify(prelaunch.ledger.entries.slice(0, checkpoint.artifacts.length)) !==
            JSON.stringify(checkpoint.ledger.entries)
    ) {
        throw new Error("Live prelaunch guard ledger does not extend the exact manifest-bound checkpoint");
    }
    const runRoot = resolve(options.outputRoot, loaded.manifest.manifestId);
    if (existsSync(runRoot)) throw new Error(`Refusing to resume or overwrite composed-ranked run ${runRoot}`);
    const guardRoot = join(runRoot, "zinc-guard");
    mkdirSync(guardRoot, { recursive: true });
    const prelaunchRoot = join(guardRoot, "prelaunch");
    mkdirSync(join(prelaunchRoot, "artifacts"), { recursive: true });
    atomicWrite(join(runRoot, "manifest.json"), manifestBytes);
    atomicWrite(join(guardRoot, "contract.json"), contractBytes);
    atomicWrite(join(guardRoot, "initial-source.json"), initialBytes);
    atomicWrite(join(prelaunchRoot, "checkpoint.json"), checkpoint.ledgerBytes);
    atomicWrite(join(prelaunchRoot, "ledger-source.json"), prelaunch.ledgerBytes);
    for (const observed of prelaunch.artifacts) {
        atomicWrite(join(prelaunchRoot, observed.entry.path), observed.bytes);
    }
    const guardLedger: IV07ComposedGuardLedgerEntry[] = prelaunch.artifacts.map(({ entry }) => ({
        sequence: entry.sequence,
        phase: entry.phase,
        path: `zinc-guard/prelaunch/${entry.path}`,
        sha256: entry.sha256,
        checkedAt: entry.checkedAt,
        snapshotSha256: entry.snapshotSha256,
    }));
    let sequence = guardLedger.length;
    let previousSnapshot = prelaunch.lastSnapshot;

    const persist = (artifact: IV07ComposedGuardArtifact): void => {
        const name = `${String(sequence).padStart(4, "0")}-${artifact.phase}.json`;
        const path = join(guardRoot, name);
        const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
        atomicWrite(path, bytes);
        guardLedger.push({
            sequence,
            phase: artifact.phase,
            path: `zinc-guard/${name}`,
            sha256: sha256(bytes),
            checkedAt: artifact.result.checkedAt,
            snapshotSha256: artifact.result.snapshotSha256,
        });
        sequence += 1;
    };
    const observe = (
        phase: Exclude<IV07ComposedGuardArtifact["phase"], "initial">,
        notBefore?: string,
    ): IV07ComposedZincGuardResult => {
        const snapshot = captureV07ComposedZincSnapshot(contract, options.identityFile);
        assertV07ComposedGuardContinuity(previousSnapshot, snapshot);
        const result = notBefore
            ? validateV07ComposedZincFinalSnapshot(contract, snapshot, notBefore, contractBytes)
            : validateV07ComposedZincSnapshot(contract, snapshot, contractBytes);
        previousSnapshot = snapshot;
        persist({ phase, result, snapshot });
        return result;
    };

    observe("pre");
    const runnerPath = resolve(import.meta.dir, "v0_7_composed_ranked_ladder.ts");
    const childEnvironment = cleanChildEnvironment();

    const runChildWithGuards = async (arguments_: string[], label: string): Promise<void> => {
        let periodicFailure: Error | undefined;
        const child = spawn(process.execPath, [runnerPath, ...arguments_], {
            cwd: process.cwd(),
            env: childEnvironment,
            stdio: "inherit",
        });
        const interval = setInterval(() => {
            try {
                observe("periodic");
            } catch (error) {
                periodicFailure = error instanceof Error ? error : new Error(String(error));
                stopChild(child);
            }
        }, V07_COMPOSED_GUARD_CAPTURE_TARGET_MS);
        const deadline = setTimeout(() => {
            periodicFailure = new Error(`${label} exceeded the external cell deadline`);
            stopChild(child);
        }, V07_COMPOSED_MAX_CELL_ELAPSED_MS + 60_000);
        interval.unref();
        deadline.unref();
        let outcome: IChildOutcome;
        try {
            outcome = await waitForChild(child);
        } finally {
            clearInterval(interval);
            clearTimeout(deadline);
        }
        if (periodicFailure) throw periodicFailure;
        if (outcome.code !== 0) {
            throw new Error(`${label} exited with code ${String(outcome.code)} signal ${String(outcome.signal)}`);
        }
    };

    for (const cell of loaded.manifest.cells) {
        await runChildWithGuards(
            [
                "--manifest",
                options.manifestPath,
                "--output",
                options.outputRoot,
                "--cell",
                cell.id,
                "--concurrency",
                String(options.concurrency),
            ],
            cell.id,
        );
        observe("post-cell");
    }

    const finalCell = loaded.manifest.cells.at(-1)!;
    const finalCompletion = validateV07ComposedCellArtifact(
        loaded.manifest,
        loaded.provenance,
        options.outputRoot,
        finalCell,
    );
    observe("post-combat", finalCompletion.completedAt);
    await runChildWithGuards(
        [
            "--manifest",
            options.manifestPath,
            "--output",
            options.outputRoot,
            "--assemble",
            "--concurrency",
            String(options.concurrency),
        ],
        "assembly",
    );
    const finalReportPath = join(runRoot, "final-report.json");
    const finalReportBytes = readFileSync(finalReportPath, "utf8");
    const finalReport = JSON.parse(finalReportBytes) as IV07ComposedFinalReport;
    const finalCompletions = loaded.manifest.cells.map((cell) =>
        validateV07ComposedCellArtifact(loaded.manifest, loaded.provenance, options.outputRoot, cell),
    );
    validateV07ComposedFinalReport(
        loaded.manifest,
        loaded.provenance,
        options.outputRoot,
        finalReport,
        finalCompletions,
    );
    observe("post-assembly", finalReport.assembledAt);
    if (readFileSync(finalReportPath, "utf8") !== finalReportBytes) {
        throw new Error("Final report changed during the post-assembly guard");
    }
    const sealedEvidence = sealCellEvidence(runRoot, finalCompletions);
    if (sealedEvidence.completionEvidenceSha256 !== finalReport.completionEvidence.sha256) {
        throw new Error("Completion marker bytes changed between final-report validation and sealing");
    }
    if (readFileSync(finalReportPath, "utf8") !== finalReportBytes) {
        throw new Error("Final report changed during evidence sealing");
    }

    const guardLedgerBytes = `${JSON.stringify(guardLedger, null, 2)}\n`;
    atomicWrite(join(guardRoot, "ledger.json"), guardLedgerBytes);
    const sealedAt = new Date().toISOString();
    const sealLag = Date.parse(sealedAt) - Date.parse(previousSnapshot.capturedAt);
    if (
        sealLag < 0 ||
        sealLag > V07_COMPOSED_MAX_GUARD_GAP_MS ||
        Date.parse(sealedAt) > Date.parse(contract.sealBefore)
    ) {
        throw new Error("Sealed-run write fell outside the final Zinc observation/deadline window");
    }
    const sealed: IV07ComposedSealedRun = {
        schemaVersion: 1,
        manifestId: loaded.manifest.manifestId,
        manifestPath: "manifest.json",
        manifestSha256: sha256(manifestBytes),
        guardContractPath: "zinc-guard/contract.json",
        guardContractSha256: sha256(contractBytes),
        initialSnapshotPath: "zinc-guard/initial-source.json",
        initialSnapshotSha256: sha256(initialBytes),
        prelaunchCheckpointPath: "zinc-guard/prelaunch/checkpoint.json",
        prelaunchCheckpointSha256: checkpoint.ledgerSha256,
        prelaunchLedgerPath: "zinc-guard/prelaunch/ledger-source.json",
        prelaunchLedgerSha256: prelaunch.ledgerSha256,
        prelaunchEntries: prelaunch.artifacts.length,
        prelaunchFirstCapturedAt: prelaunch.firstSnapshot.capturedAt,
        prelaunchLastCapturedAt: prelaunch.lastSnapshot.capturedAt,
        guardIntervalMs: V07_COMPOSED_GUARD_INTERVAL_MS,
        maxGuardGapMs: V07_COMPOSED_MAX_GUARD_GAP_MS,
        guardLedger,
        guardLedgerSha256: sha256(guardLedgerBytes),
        finalReportPath: "final-report.json",
        finalReportSha256: sha256(finalReportBytes),
        cellEvidence: sealedEvidence.evidence,
        cellEvidenceSha256: sealedEvidence.sha256,
        qualificationVerdict: finalReport.qualification.verdict,
        sealedAt,
        guardPassed: true,
    };
    atomicWrite(join(runRoot, "sealed-run.json"), `${JSON.stringify(sealed, null, 2)}\n`);
    return sealed;
}

if (import.meta.main) {
    const sealed = await runSequence(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ manifestId: sealed.manifestId, sealedAt: sealed.sealedAt })}\n`);
}
