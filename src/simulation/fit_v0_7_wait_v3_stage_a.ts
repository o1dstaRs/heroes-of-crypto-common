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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseWaitWeightsV3, WAIT_FEATURE_NAMES_V3 } from "../ai/versions/wait_scorer";
import {
    readCleanMainRevision,
    readWaitV3StageAManifest,
    type IWaitV3StageAManifest,
    type IWaitV3StageARawReport,
    type IWaitV3StageARunManifest,
} from "./v0_7_wait_v3_stage_a";

export interface IWaitV3StageAFitReport {
    schemaVersion: 1;
    kind: "v0.7_wait_v3_stage_a_fit";
    verdict: "PASS";
    generatedAt: string;
    runFingerprint: string;
    revision: IWaitV3StageARunManifest["identity"]["revision"];
    protocolSha256: string;
    runManifestSha256: string;
    rawCompleteSha256: string;
    rawReportSha256: string;
    rawArtifacts: Array<{
        cohort: string;
        q2Sha256: string;
        auditSha256: string;
        gamesSha256: string;
    }>;
    fitterSourceSha256: string;
    fitWrapperSourceSha256: string;
    gateSourceSha256: string;
    command: string[];
    literalGate: "V3 GATE: PASS";
    fitterStdoutSha256: string;
    fitterStderrSha256: string;
    modelPath: string;
    modelSha256: string;
    modelWidth: 125;
    modelNonzero: true;
    releaseInstruction: "RESEARCH_ONLY_NO_BAKE";
}

export interface IWaitV3StageARawHashes {
    rawCompleteSha256: string;
    rawReportSha256: string;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FITTER_SOURCE = join(PROJECT_ROOT, "src/simulation/optimizer/fit_wait_v2.mjs");
const FIT_WRAPPER_SOURCE = fileURLToPath(import.meta.url);
const GATE_SOURCE = join(PROJECT_ROOT, "src/simulation/optimizer/wait_v3_gates.ts");
const MODEL_PREFIX = "V07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100): ";

export function parseWaitV3StageAFitterOutput(stdout: string, literalGate = "V3 GATE: PASS") {
    const lines = stdout.split("\n");
    const literalPasses = lines.filter((line) => line === literalGate);
    if (literalPasses.length !== 1) {
        throw new Error(`Fitter must emit exactly one literal '${literalGate}'; got ${literalPasses.length}`);
    }
    const modelLines = lines.filter((line) => line.startsWith(MODEL_PREFIX));
    if (modelLines.length !== 1) throw new Error(`Fitter must emit exactly one V3 model; got ${modelLines.length}`);
    const parsed = parseWaitWeightsV3(modelLines[0].slice(MODEL_PREFIX.length));
    if (!parsed || parsed.w.length !== WAIT_FEATURE_NAMES_V3.length || WAIT_FEATURE_NAMES_V3.length !== 125) {
        throw new Error("Fitter V3 model is not a valid finite 125-vector");
    }
    if (parsed.b === 0 && parsed.w.every((weight) => weight === 0)) {
        throw new Error("Fitter V3 model is all zero");
    }
    return parsed;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function fileSha256(path: string): string {
    return sha256(readFileSync(path));
}

function atomicWriteText(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, value);
    renameSync(temporary, path);
}

function atomicWriteJson(path: string, value: unknown): void {
    atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string): T {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
        throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function requireFileHash(path: string, expected: string, role: string): void {
    if (!existsSync(path)) throw new Error(`Missing ${role}: ${path}`);
    const actual = fileSha256(path);
    if (actual !== expected) throw new Error(`${role} hash mismatch: expected ${expected}; got ${actual}`);
}

export function assertWaitV3StageAFitRawBinding(
    report: Pick<IWaitV3StageAFitReport, "rawCompleteSha256" | "rawReportSha256">,
    rawHashes: IWaitV3StageARawHashes,
): void {
    if (
        report.rawCompleteSha256 !== rawHashes.rawCompleteSha256 ||
        report.rawReportSha256 !== rawHashes.rawReportSha256
    ) {
        throw new Error("Completed fit report is not bound to the current sealed raw evidence");
    }
}

export function validateWaitV3StageARawShape(manifest: IWaitV3StageAManifest, raw: IWaitV3StageARawReport): void {
    const expectedGames = manifest.cohorts.reduce((sum, cohort) => sum + cohort.games, 0);
    if (raw.games !== expectedGames || raw.cohorts.length !== manifest.cohorts.length) {
        throw new Error(
            `Raw cohort envelope must contain exactly ${manifest.cohorts.length} cohorts/${expectedGames} games`,
        );
    }
    const seen = new Set<string>();
    let games = 0;
    let q2Rows = 0;
    for (const expected of manifest.cohorts) {
        const matches = raw.cohorts.filter((cohort) => cohort.id === expected.id);
        if (matches.length !== 1) throw new Error(`Raw cohort ${expected.id} must appear exactly once`);
        const cohort = matches[0];
        if (seen.has(cohort.id)) throw new Error(`Duplicate raw cohort ${cohort.id}`);
        seen.add(cohort.id);
        if (cohort.games !== expected.games) {
            throw new Error(`Raw cohort ${cohort.id} games ${cohort.games} != frozen ${expected.games}`);
        }
        if (!Number.isSafeInteger(cohort.q2Rows) || cohort.q2Rows < 1) {
            throw new Error(`Raw cohort ${cohort.id} has no complete Q2 rows`);
        }
        games += cohort.games;
        q2Rows += cohort.q2Rows;
    }
    if (games !== expectedGames || raw.q2Rows !== q2Rows) {
        throw new Error(`Raw claimed totals ${raw.games}/${raw.q2Rows} differ from cohort sums ${games}/${q2Rows}`);
    }
    if (raw.cohorts.some((cohort) => !manifest.cohorts.some((expected) => expected.id === cohort.id))) {
        throw new Error("Raw envelope contains an unknown cohort");
    }
}

function validateRawEnvelope(
    runDir: string,
    run: IWaitV3StageARunManifest,
    raw: IWaitV3StageARawReport,
): IWaitV3StageARawHashes {
    const rawReportPath = join(runDir, "raw-report.json");
    const rawCompletePath = join(runDir, "RAW_COMPLETE");
    if (!existsSync(rawCompletePath)) throw new Error(`Missing atomic RAW_COMPLETE marker: ${rawCompletePath}`);
    const marker = readJson<Record<string, unknown>>(rawCompletePath);
    if (
        marker.schemaVersion !== 1 ||
        marker.kind !== "v0.7_wait_v3_stage_a_raw_complete" ||
        !Number.isFinite(Date.parse(String(marker.completedAt))) ||
        marker.runFingerprint !== run.runFingerprint ||
        marker.report !== "raw-report.json" ||
        typeof marker.reportSha256 !== "string" ||
        typeof marker.artifactsSha256 !== "string"
    ) {
        throw new Error("Invalid RAW_COMPLETE identity");
    }
    requireFileHash(rawReportPath, marker.reportSha256, "raw report");
    if (
        raw.schemaVersion !== 1 ||
        raw.kind !== "v0.7_wait_v3_stage_a_raw" ||
        raw.verdict !== "PASS" ||
        !Number.isFinite(Date.parse(raw.generatedAt)) ||
        raw.runFingerprint !== run.runFingerprint ||
        raw.protocolSha256 !== run.identity.protocol.sha256 ||
        raw.runManifestSha256 !== fileSha256(join(runDir, "run.json")) ||
        raw.games !== 12_000
    ) {
        throw new Error("Raw report does not satisfy the frozen Stage-A completion contract");
    }
    const { manifest } = readWaitV3StageAManifest();
    validateWaitV3StageARawShape(manifest, raw);
    if (marker.artifactsSha256 !== sha256(stableJson(raw.cohorts))) {
        throw new Error("RAW_COMPLETE artifact envelope hash mismatch");
    }
    for (const cohort of raw.cohorts) {
        const q2Path = join(runDir, cohort.q2Path);
        const auditPath = join(runDir, cohort.auditPath);
        const gamesPath = join(runDir, cohort.gamesPath);
        requireFileHash(q2Path, cohort.q2Sha256, `${cohort.id} Q2 dataset`);
        requireFileHash(auditPath, cohort.auditSha256, `${cohort.id} audit dataset`);
        requireFileHash(gamesPath, cohort.gamesSha256, `${cohort.id} game dataset`);
        const q2 = readFileSync(q2Path);
        const audit = readFileSync(auditPath);
        const games = readFileSync(gamesPath);
        if (
            q2.length !== cohort.q2Bytes ||
            audit.length !== cohort.auditBytes ||
            games.length !== cohort.gamesBytes ||
            q2.toString("utf8").split("\n").filter(Boolean).length !== cohort.q2Rows ||
            audit.toString("utf8").split("\n").filter(Boolean).length !== cohort.games ||
            games.toString("utf8").split("\n").filter(Boolean).length !== cohort.games ||
            cohort.games < 1 ||
            cohort.q2Rows < 1 ||
            cohort.q2ScoredRows < 1 ||
            cohort.q2WaitRejected !== 0
        ) {
            throw new Error(`${cohort.id}: raw artifact size/completeness mismatch`);
        }
    }
    return { rawCompleteSha256: fileSha256(rawCompletePath), rawReportSha256: fileSha256(rawReportPath) };
}

function validateExistingFit(
    runDir: string,
    run: IWaitV3StageARunManifest,
    raw: IWaitV3StageARawReport,
    rawHashes: IWaitV3StageARawHashes,
    manifest: IWaitV3StageAManifest,
): IWaitV3StageAFitReport | null {
    const markerPath = join(runDir, "FIT_COMPLETE");
    if (!existsSync(markerPath)) return null;
    const marker = readJson<Record<string, unknown>>(markerPath);
    if (
        marker.schemaVersion !== 1 ||
        marker.kind !== "v0.7_wait_v3_stage_a_fit_complete" ||
        !Number.isFinite(Date.parse(String(marker.completedAt))) ||
        marker.runFingerprint !== run.runFingerprint ||
        marker.report !== "fit/report.json" ||
        marker.model !== "fit/model.json" ||
        marker.releaseInstruction !== "RESEARCH_ONLY_NO_BAKE" ||
        typeof marker.reportSha256 !== "string" ||
        typeof marker.modelSha256 !== "string"
    ) {
        throw new Error("Invalid FIT_COMPLETE marker");
    }
    const reportPath = join(runDir, "fit/report.json");
    const modelPath = join(runDir, "fit/model.json");
    requireFileHash(reportPath, marker.reportSha256, "fit report");
    requireFileHash(modelPath, marker.modelSha256, "fit model");
    const report = readJson<IWaitV3StageAFitReport>(reportPath);
    const expectedRawArtifacts = raw.cohorts.map((cohort) => ({
        cohort: cohort.id,
        q2Sha256: cohort.q2Sha256,
        auditSha256: cohort.auditSha256,
        gamesSha256: cohort.gamesSha256,
    }));
    if (
        report.schemaVersion !== 1 ||
        report.kind !== "v0.7_wait_v3_stage_a_fit" ||
        report.verdict !== "PASS" ||
        !Number.isFinite(Date.parse(report.generatedAt)) ||
        report.runFingerprint !== run.runFingerprint ||
        stableJson(report.revision) !== stableJson(run.identity.revision) ||
        report.protocolSha256 !== run.identity.protocol.sha256 ||
        report.runManifestSha256 !== fileSha256(join(runDir, "run.json")) ||
        stableJson(report.rawArtifacts) !== stableJson(expectedRawArtifacts) ||
        report.fitterSourceSha256 !== fileSha256(FITTER_SOURCE) ||
        report.fitWrapperSourceSha256 !== fileSha256(FIT_WRAPPER_SOURCE) ||
        report.gateSourceSha256 !== fileSha256(GATE_SOURCE) ||
        report.literalGate !== manifest.completion.requireLiteralFitterLine ||
        report.modelPath !== "fit/model.json" ||
        report.modelSha256 !== marker.modelSha256 ||
        report.modelWidth !== manifest.completion.modelWidth ||
        !report.modelNonzero ||
        report.releaseInstruction !== "RESEARCH_ONLY_NO_BAKE"
    ) {
        throw new Error("Completed fit report identity mismatch");
    }
    assertWaitV3StageAFitRawBinding(report, rawHashes);
    requireFileHash(join(runDir, "fit/fitter.stdout.txt"), report.fitterStdoutSha256, "fitter stdout");
    requireFileHash(join(runDir, "fit/fitter.stderr.txt"), report.fitterStderrSha256, "fitter stderr");
    const model = parseWaitWeightsV3(readFileSync(modelPath, "utf8"));
    if (!model || model.w.length !== 125 || (model.b === 0 && model.w.every((weight) => weight === 0))) {
        throw new Error("Completed fit model does not satisfy the frozen nonzero 125-vector contract");
    }
    return report;
}

export function runWaitV3StageAFit(runDirInput: string): IWaitV3StageAFitReport {
    const runDir = resolve(runDirInput);
    const { manifest, provenance } = readWaitV3StageAManifest();
    const runPath = join(runDir, "run.json");
    if (!existsSync(runPath)) throw new Error(`Missing Stage-A run manifest: ${runPath}`);
    const run = readJson<IWaitV3StageARunManifest>(runPath);
    if (
        run.schemaVersion !== 1 ||
        run.identity.protocol.sha256 !== provenance.sha256 ||
        run.identity.v2WeightsSha256 !== manifest.incumbent.v2WeightsSha256 ||
        run.identity.v3SentinelSha256 !== manifest.incumbent.v3SentinelSha256
    ) {
        throw new Error("Stage-A run manifest is not bound to the current frozen protocol");
    }
    const revision = readCleanMainRevision();
    if (revision.commit !== run.identity.revision.commit) {
        throw new Error(`Fit revision ${revision.commit} differs from raw revision ${run.identity.revision.commit}`);
    }
    requireFileHash(FITTER_SOURCE, run.identity.fitterSourceSha256, "fitter source");
    requireFileHash(FIT_WRAPPER_SOURCE, run.identity.fitWrapperSourceSha256, "fit-wrapper source");
    requireFileHash(GATE_SOURCE, run.identity.gateSourceSha256, "V3 gate source");
    const rawPath = join(runDir, "raw-report.json");
    if (!existsSync(rawPath)) throw new Error(`Missing Stage-A raw report: ${rawPath}`);
    const raw = readJson<IWaitV3StageARawReport>(rawPath);
    const rawHashes = validateRawEnvelope(runDir, run, raw);
    const existing = validateExistingFit(runDir, run, raw, rawHashes, manifest);
    if (existing) return existing;
    const command = [
        process.execPath,
        FITTER_SOURCE,
        `fingerprint=${run.runFingerprint}`,
        ...manifest.cohorts.map((cohort) => {
            const artifact = raw.cohorts.find((entry) => entry.id === cohort.id);
            if (!artifact) throw new Error(`Raw report is missing cohort ${cohort.id}`);
            return `${cohort.id}=${join(runDir, artifact.q2Path)}`;
        }),
        "epochs=400",
        "lr=0.5",
        "l2=0.0001",
    ];
    const fit = Bun.spawnSync({
        cmd: command,
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(fit.stdout);
    const stderr = new TextDecoder().decode(fit.stderr);
    const stdoutPath = join(runDir, "fit/fitter.stdout.txt");
    const stderrPath = join(runDir, "fit/fitter.stderr.txt");
    atomicWriteText(stdoutPath, stdout);
    atomicWriteText(stderrPath, stderr);
    if (fit.exitCode !== 0) {
        throw new Error(`Wait V3 fitter exited ${fit.exitCode}: ${stderr.trim() || stdout.trim()}`);
    }
    const parsed = parseWaitV3StageAFitterOutput(stdout, manifest.completion.requireLiteralFitterLine);
    const modelPath = join(runDir, "fit/model.json");
    atomicWriteJson(modelPath, parsed);
    const report: IWaitV3StageAFitReport = {
        schemaVersion: 1,
        kind: "v0.7_wait_v3_stage_a_fit",
        verdict: "PASS",
        generatedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        revision,
        protocolSha256: provenance.sha256,
        runManifestSha256: fileSha256(runPath),
        rawCompleteSha256: rawHashes.rawCompleteSha256,
        rawReportSha256: rawHashes.rawReportSha256,
        rawArtifacts: raw.cohorts.map((cohort) => ({
            cohort: cohort.id,
            q2Sha256: cohort.q2Sha256,
            auditSha256: cohort.auditSha256,
            gamesSha256: cohort.gamesSha256,
        })),
        fitterSourceSha256: fileSha256(FITTER_SOURCE),
        fitWrapperSourceSha256: fileSha256(FIT_WRAPPER_SOURCE),
        gateSourceSha256: fileSha256(GATE_SOURCE),
        command,
        literalGate: "V3 GATE: PASS",
        fitterStdoutSha256: fileSha256(stdoutPath),
        fitterStderrSha256: fileSha256(stderrPath),
        modelPath: relative(runDir, modelPath),
        modelSha256: fileSha256(modelPath),
        modelWidth: 125,
        modelNonzero: true,
        releaseInstruction: "RESEARCH_ONLY_NO_BAKE",
    };
    const reportPath = join(runDir, "fit/report.json");
    atomicWriteJson(reportPath, report);
    atomicWriteJson(join(runDir, manifest.completion.fitMarker), {
        schemaVersion: 1,
        kind: "v0.7_wait_v3_stage_a_fit_complete",
        completedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        report: relative(runDir, reportPath),
        reportSha256: fileSha256(reportPath),
        model: relative(runDir, modelPath),
        modelSha256: fileSha256(modelPath),
        releaseInstruction: "RESEARCH_ONLY_NO_BAKE",
    });
    return report;
}

function main(): void {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: { "run-dir": { type: "string" } },
        strict: true,
        allowPositionals: false,
    });
    if (!parsed.values["run-dir"]) {
        throw new Error("usage: bun src/simulation/fit_v0_7_wait_v3_stage_a.ts --run-dir <completed-stage-a-run>");
    }
    const report = runWaitV3StageAFit(parsed.values["run-dir"]);
    console.log(`Wait V3 Stage-A fit ${report.verdict}: ${report.modelPath} ${report.modelSha256}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    try {
        main();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
