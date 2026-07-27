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

import { randomUUID } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import type { IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import {
    readV09Checkpoint,
    sha256File,
    validateV09CampaignManifest,
    validateV09SeedLedger,
    type IV09CampaignManifest,
    type IV09SeedLedger,
} from "./campaign";
import { verifyV09ResearchArtifact } from "./parity";
import { fingerprintV09 } from "./protocol";
import { validateV09QualificationShardReceipt, type IV09QualificationShardReceipt } from "./qualify";
import { V09_SOURCE_IDENTITY_SCHEMA, type IV09SourceIdentityReceipt } from "./source_identity";

export const V09_PRODUCTION_HANDOFF_SCHEMA = "hoc.ai.v0_9_production_handoff.v1" as const;

const BUNDLE_FILES = [
    "checkpoint.json",
    "manifest.json",
    "research-artifact.json",
    "seed-ledger.json",
    "source-identity.json",
    "training-host/qualification-pairs.jsonl",
    "training-host/qualification-shard-receipt.json",
] as const;

export interface IV09ProductionHandoffFile {
    path: (typeof BUNDLE_FILES)[number];
    bytes: number;
    sha256: string;
}

export interface IV09ProductionHandoffManifest {
    schema: typeof V09_PRODUCTION_HANDOFF_SCHEMA;
    runFingerprint: string;
    manifestSha256: string;
    seedLedgerSha256: string;
    sourceIdentityReceiptSha256: string;
    modelSha256: string;
    researchArtifactSha256: string;
    trainingHostShardReceiptSha256: string;
    sourceCommit: string;
    originalCampaignOutputDirectory: string;
    files: IV09ProductionHandoffFile[];
    productionCommand: readonly string[];
    createdAt: string;
    bundleSha256: string;
}

export interface IV09VerifiedProductionHandoff {
    directory: string;
    bundle: IV09ProductionHandoffManifest;
    manifest: IV09CampaignManifest;
    ledger: IV09SeedLedger;
    sourceIdentity: IV09SourceIdentityReceipt;
    checkpointPath: string;
    artifactPath: string;
    artifact: IV09ModelArtifact;
    trainingHostShardDirectory: string;
    trainingHostReceipt: IV09QualificationShardReceipt;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function assertInside(root: string, path: string): void {
    const child = relative(root, path);
    if (!child || child.startsWith(`..${sep}`) || child === "..") {
        throw new Error(`v0.9 handoff path escapes its bundle: ${path}`);
    }
}

function regularFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name);
            assertInside(root, path);
            if (entry.isSymbolicLink()) throw new Error(`v0.9 handoff rejects symlink ${path}`);
            if (entry.isDirectory()) {
                visit(path);
            } else if (entry.isFile()) {
                files.push(relative(root, path).split(sep).join("/"));
            } else {
                throw new Error(`v0.9 handoff rejects non-regular entry ${path}`);
            }
        }
    };
    visit(root);
    return files.sort();
}

function validateSourceReceiptShape(receipt: IV09SourceIdentityReceipt): void {
    const { receiptSha256, ...unsigned } = receipt;
    if (
        receipt.schema !== V09_SOURCE_IDENTITY_SCHEMA ||
        receipt.sourceDirty !== false ||
        fingerprintV09(unsigned) !== receiptSha256
    ) {
        throw new Error("v0.9 handoff source identity receipt is invalid");
    }
}

export function validateV09ProductionHandoffBundle(directory: string): IV09VerifiedProductionHandoff {
    const root = resolve(directory);
    const bundlePath = resolve(root, "bundle-manifest.json");
    if (!existsSync(bundlePath)) throw new Error(`v0.9 handoff is missing ${bundlePath}`);
    const bundle = readJson<IV09ProductionHandoffManifest>(bundlePath);
    const { bundleSha256, ...unsigned } = bundle;
    if (
        bundle.schema !== V09_PRODUCTION_HANDOFF_SCHEMA ||
        fingerprintV09(unsigned) !== bundleSha256 ||
        bundle.files.map((file) => file.path).join("\n") !== [...BUNDLE_FILES].sort().join("\n")
    ) {
        throw new Error("v0.9 production handoff manifest identity/file set mismatch");
    }
    const actualFiles = regularFiles(root);
    const expectedFiles = ["bundle-manifest.json", ...BUNDLE_FILES].sort();
    if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
        throw new Error("v0.9 production handoff contains missing or unexpected files");
    }
    for (const file of bundle.files) {
        const path = resolve(root, file.path);
        assertInside(root, path);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size !== file.bytes || sha256File(path) !== file.sha256) {
            throw new Error(`v0.9 production handoff file hash/size mismatch: ${file.path}`);
        }
    }

    const manifest = readJson<IV09CampaignManifest>(resolve(root, "manifest.json"));
    const ledger = readJson<IV09SeedLedger>(resolve(root, "seed-ledger.json"));
    const sourceIdentity = readJson<IV09SourceIdentityReceipt>(resolve(root, "source-identity.json"));
    const artifactPath = resolve(root, "research-artifact.json");
    const artifact = readJson<IV09ModelArtifact>(artifactPath);
    const checkpointPath = resolve(root, "checkpoint.json");
    const checkpoint = readV09Checkpoint(checkpointPath, manifest);
    const trainingHostShardDirectory = resolve(root, "training-host");
    const trainingHostReceipt = readJson<IV09QualificationShardReceipt>(
        resolve(trainingHostShardDirectory, "qualification-shard-receipt.json"),
    );

    validateV09CampaignManifest(manifest);
    validateV09SeedLedger(ledger);
    validateSourceReceiptShape(sourceIdentity);
    verifyV09ResearchArtifact(artifact);
    validateV09QualificationShardReceipt(trainingHostReceipt);
    if (
        !checkpoint ||
        checkpoint.stage !== "quantize" ||
        checkpoint.completedUnits !== checkpoint.expectedUnits ||
        manifest.runFingerprint !== ledger.runFingerprint ||
        manifest.seedLedgerSha256 !== ledger.ledgerSha256 ||
        manifest.identity.sourceCommit !== sourceIdentity.sourceCommit ||
        manifest.identity.sourceStatusSha256 !== sourceIdentity.sourceStatusSha256 ||
        manifest.identity.rulesFingerprint !== sourceIdentity.rulesFingerprint ||
        manifest.identity.rosterFingerprint !== sourceIdentity.rosterFingerprint ||
        manifest.identity.anchorFingerprint !== sourceIdentity.anchorFingerprint ||
        artifact.modelSha256 !== bundle.modelSha256 ||
        checkpoint.artifacts.researchModel !== artifact.modelSha256 ||
        artifact.source.trainingRunId !== manifest.runFingerprint ||
        artifact.source.commonCommit !== manifest.identity.sourceCommit ||
        artifact.source.rulesSha256 !== manifest.identity.rulesFingerprint ||
        artifact.source.rosterSha256 !== manifest.identity.rosterFingerprint ||
        trainingHostReceipt.nodeRole !== "training_host" ||
        trainingHostReceipt.shardCount !== 2 ||
        trainingHostReceipt.shardIndex !== 0 ||
        trainingHostReceipt.runFingerprint !== manifest.runFingerprint ||
        trainingHostReceipt.modelSha256 !== artifact.modelSha256 ||
        trainingHostReceipt.researchArtifactSha256 !== sha256File(artifactPath) ||
        trainingHostReceipt.journalSha256 !==
            sha256File(resolve(trainingHostShardDirectory, "qualification-pairs.jsonl")) ||
        bundle.runFingerprint !== manifest.runFingerprint ||
        bundle.manifestSha256 !== manifest.manifestSha256 ||
        bundle.seedLedgerSha256 !== ledger.ledgerSha256 ||
        bundle.sourceIdentityReceiptSha256 !== sourceIdentity.receiptSha256 ||
        bundle.researchArtifactSha256 !== sha256File(artifactPath) ||
        bundle.trainingHostShardReceiptSha256 !== trainingHostReceipt.receiptSha256 ||
        bundle.sourceCommit !== manifest.identity.sourceCommit ||
        bundle.originalCampaignOutputDirectory !== manifest.outputDirectory
    ) {
        throw new Error("v0.9 production handoff evidence does not bind one exact research campaign/shard");
    }

    return {
        directory: root,
        bundle,
        manifest,
        ledger,
        sourceIdentity,
        checkpointPath,
        artifactPath,
        artifact,
        trainingHostShardDirectory,
        trainingHostReceipt,
    };
}

function immutableTree(root: string): void {
    for (const file of regularFiles(root)) chmodSync(resolve(root, file), 0o444);
    const directories: string[] = [root];
    for (const file of regularFiles(root)) {
        let directory = dirname(resolve(root, file));
        while (directory !== root) {
            if (!directories.includes(directory)) directories.push(directory);
            directory = dirname(directory);
        }
    }
    directories.sort((left, right) => right.length - left.length);
    for (const directory of directories) chmodSync(directory, 0o555);
}

export function createV09ProductionHandoffBundle(inputs: {
    destination: string;
    campaignDirectory: string;
    researchArtifactPath: string;
    trainingHostShardDirectory: string;
}): IV09VerifiedProductionHandoff {
    const destination = resolve(inputs.destination);
    if (existsSync(destination)) return validateV09ProductionHandoffBundle(destination);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp.${process.pid}.${randomUUID()}`;
    mkdirSync(resolve(temporary, "training-host"), { recursive: true });
    const copies: ReadonlyArray<readonly [string, (typeof BUNDLE_FILES)[number]]> = [
        [resolve(inputs.campaignDirectory, "checkpoint.json"), "checkpoint.json"],
        [resolve(inputs.campaignDirectory, "manifest.json"), "manifest.json"],
        [resolve(inputs.researchArtifactPath), "research-artifact.json"],
        [resolve(inputs.campaignDirectory, "seed-ledger.json"), "seed-ledger.json"],
        [resolve(inputs.campaignDirectory, "source-identity.json"), "source-identity.json"],
        [
            resolve(inputs.trainingHostShardDirectory, "qualification-pairs.jsonl"),
            "training-host/qualification-pairs.jsonl",
        ],
        [
            resolve(inputs.trainingHostShardDirectory, "qualification-shard-receipt.json"),
            "training-host/qualification-shard-receipt.json",
        ],
    ];
    for (const [source, relativePath] of copies) {
        if (!existsSync(source) || !lstatSync(source).isFile()) {
            throw new Error(`v0.9 handoff source file is missing: ${source}`);
        }
        copyFileSync(source, resolve(temporary, relativePath));
    }
    const manifest = readJson<IV09CampaignManifest>(resolve(temporary, "manifest.json"));
    const ledger = readJson<IV09SeedLedger>(resolve(temporary, "seed-ledger.json"));
    const sourceIdentity = readJson<IV09SourceIdentityReceipt>(resolve(temporary, "source-identity.json"));
    const artifact = readJson<IV09ModelArtifact>(resolve(temporary, "research-artifact.json"));
    const trainingHostReceipt = readJson<IV09QualificationShardReceipt>(
        resolve(temporary, "training-host/qualification-shard-receipt.json"),
    );
    const files: IV09ProductionHandoffFile[] = [...BUNDLE_FILES].sort().map((path) => {
        const absolute = resolve(temporary, path);
        return { path, bytes: lstatSync(absolute).size, sha256: sha256File(absolute) };
    });
    const unsigned: Omit<IV09ProductionHandoffManifest, "bundleSha256"> = {
        schema: V09_PRODUCTION_HANDOFF_SCHEMA,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        sourceIdentityReceiptSha256: sourceIdentity.receiptSha256,
        modelSha256: artifact.modelSha256!,
        researchArtifactSha256: sha256File(resolve(temporary, "research-artifact.json")),
        trainingHostShardReceiptSha256: trainingHostReceipt.receiptSha256,
        sourceCommit: manifest.identity.sourceCommit,
        originalCampaignOutputDirectory: manifest.outputDirectory,
        files,
        productionCommand: [
            "bun",
            "src/simulation/v0_9/orchestrator.ts",
            "qualification",
            "--bundle",
            "<verified-relocated-bundle-dir>",
            "--repository",
            "<isolated-clean-common-checkout>",
            "--out",
            "<fresh-production-qualification-output>",
            "--node-role",
            "production_cpu",
            "--workers",
            "1",
        ],
        createdAt: new Date().toISOString(),
    };
    writeFileSync(
        resolve(temporary, "bundle-manifest.json"),
        `${JSON.stringify({ ...unsigned, bundleSha256: fingerprintV09(unsigned) }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
    );
    validateV09ProductionHandoffBundle(temporary);
    renameSync(temporary, destination);
    immutableTree(destination);
    return validateV09ProductionHandoffBundle(destination);
}
