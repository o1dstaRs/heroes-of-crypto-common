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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    serializeV09ModelHashPayload,
    serializeV09QualificationReceiptPayload,
    validateV09ModelArtifact,
    V09_EMPTY_FAILURES_SHA256,
    V09_QUALIFICATION_RECEIPT_SCHEMA,
    type IV09ModelArtifact,
    type IV09QualificationReceipt,
} from "../../ai/versions/v0_9_model";
import {
    validateV09CampaignManifest,
    validateV09SeedLedger,
    type IV09CampaignManifest,
    type IV09SeedLedger,
} from "./campaign";
import { verifyV09ResearchArtifact } from "./parity";
import {
    validateV09QualificationEvidence,
    validateV09QualificationSummary,
    type IV09QualificationSummary,
} from "./qualify";
import { verifyV09SourceIdentity, type IV09SourceIdentityReceipt } from "./source_identity";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function atomicImmutableJson(path: string, value: unknown): void {
    if (existsSync(path)) throw new Error(`refusing to overwrite promoted v0.9 artifact ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
    renameSync(temporary, path);
}

export interface IV09PromotionInputs {
    researchArtifactPath: string;
    qualificationSummaryPath: string;
    qualificationShardDirectories: readonly string[];
    campaignDirectory: string;
    repositoryRoot: string;
}

/**
 * Build a promoted JSON artifact only from a complete, production-CPU qualification receipt. This does not
 * install or commit the artifact; deployment remains a separate reviewed operation.
 */
export function promoteV09ResearchArtifact(inputs: IV09PromotionInputs): IV09ModelArtifact {
    const campaignDirectory = resolve(inputs.campaignDirectory);
    const researchBytes = readFileSync(resolve(inputs.researchArtifactPath));
    const researchArtifactSha256 = sha256(researchBytes);
    const research = JSON.parse(researchBytes.toString("utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(research);
    if (research.qualification !== null) throw new Error("promotion input must be an unqualified research artifact");

    const summary = readJson<IV09QualificationSummary>(resolve(inputs.qualificationSummaryPath));
    validateV09QualificationSummary(summary);
    if (
        summary.status !== "qualified_offline" ||
        summary.failures.length !== 0 ||
        summary.failuresSha256 !== V09_EMPTY_FAILURES_SHA256 ||
        summary.combinedGames !== 96_000 ||
        summary.confirmationGames !== 48_000 ||
        summary.qualificationGames !== 48_000 ||
        !summary.execution.productionCpuQualification.satisfied ||
        summary.execution.productionCpuQualification.p99TurnMs === null ||
        summary.execution.productionCpuQualification.p99TurnMs >= 20 ||
        !summary.execution.nodes.some((node) => node.nodeRole === "production_cpu") ||
        !summary.qualifiedAt
    ) {
        throw new Error("v0.9 promotion requires a clean 48k+48k production-CPU qualification");
    }

    const manifest = readJson<IV09CampaignManifest>(resolve(campaignDirectory, "manifest.json"));
    const ledger = readJson<IV09SeedLedger>(resolve(campaignDirectory, "seed-ledger.json"));
    validateV09CampaignManifest(manifest, campaignDirectory);
    validateV09SeedLedger(ledger);
    const sourceReceipt = readJson<IV09SourceIdentityReceipt>(resolve(campaignDirectory, "source-identity.json"));
    verifyV09SourceIdentity(sourceReceipt, inputs.repositoryRoot);
    validateV09QualificationEvidence({
        summary,
        shardDirectories: inputs.qualificationShardDirectories,
        manifest,
        ledger,
        artifact: research,
        artifactFileSha256: researchArtifactSha256,
        sourceIdentityReceiptSha256: sourceReceipt.receiptSha256,
    });
    const journalSha256 = summary.journalSha256;

    if (
        summary.modelId !== research.modelId ||
        summary.modelSha256 !== research.modelSha256 ||
        summary.researchArtifactSha256 !== researchArtifactSha256 ||
        summary.manifestSha256 !== manifest.manifestSha256 ||
        summary.seedLedgerSha256 !== ledger.ledgerSha256 ||
        summary.journalSha256 !== journalSha256 ||
        summary.runFingerprint !== manifest.runFingerprint ||
        summary.trainingRunId !== research.source.trainingRunId ||
        summary.commonCommit !== research.source.commonCommit ||
        summary.rulesSha256 !== research.source.rulesSha256 ||
        summary.rosterSha256 !== research.source.rosterSha256 ||
        summary.promotionReceiptInputs.sourceIdentityReceiptSha256 !== sourceReceipt.receiptSha256
    ) {
        throw new Error("v0.9 qualification evidence does not match the exact research/campaign inputs");
    }

    const provisionalReceipt: IV09QualificationReceipt = {
        schema: V09_QUALIFICATION_RECEIPT_SCHEMA,
        qualificationSummarySchema: summary.schema,
        armageddonMetric: "reached_armageddon_lap",
        summarySha256: summary.summarySha256,
        journalSha256,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        researchArtifactSha256,
        modelSha256: research.modelSha256!,
        modelId: research.modelId,
        trainingRunId: research.source.trainingRunId!,
        commonCommit: research.source.commonCommit!,
        rulesSha256: research.source.rulesSha256!,
        rosterSha256: research.source.rosterSha256!,
        runFingerprint: manifest.runFingerprint,
        combinedGames: 96_000,
        confirmationGames: 48_000,
        qualificationGames: 48_000,
        failuresSha256: V09_EMPTY_FAILURES_SHA256,
        qualifiedAt: summary.qualifiedAt,
        receiptSha256: "0".repeat(64),
    };
    const receipt: IV09QualificationReceipt = {
        ...provisionalReceipt,
        receiptSha256: sha256(serializeV09QualificationReceiptPayload(provisionalReceipt)),
    };
    const promoted: IV09ModelArtifact = {
        ...research,
        promoted: true,
        qualification: receipt,
        notes: `${research.notes} Qualified offline on the production CPU; receipt ${receipt.receiptSha256}.`,
    };
    const errors = validateV09ModelArtifact(promoted);
    if (errors.length) throw new Error(`promoted v0.9 artifact is invalid: ${errors.join("; ")}`);
    if (sha256(serializeV09ModelHashPayload(promoted)) !== research.modelSha256) {
        throw new Error("promotion changed the sealed v0.9 inference function");
    }
    return promoted;
}

function main(): void {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            research: { type: "string" },
            summary: { type: "string" },
            "shard-dir": { type: "string", multiple: true },
            campaign: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            out: { type: "string" },
        },
        strict: true,
    });
    if (!values.research || !values.summary || !values["shard-dir"]?.length || !values.campaign || !values.out) {
        throw new Error(
            "usage: bun promote.ts --research <json> --summary <qualification-summary.json> " +
                "--shard-dir <qualification-shard-dir> ... --campaign <dir> " +
                "--repository <common> --out <json>",
        );
    }
    const promoted = promoteV09ResearchArtifact({
        researchArtifactPath: values.research,
        qualificationSummaryPath: values.summary,
        qualificationShardDirectories: values["shard-dir"],
        campaignDirectory: values.campaign,
        repositoryRoot: values.repository,
    });
    const output = resolve(values.out);
    atomicImmutableJson(output, promoted);
    process.stdout.write(
        `${JSON.stringify({
            output,
            modelSha256: promoted.modelSha256,
            qualificationReceiptSha256: promoted.qualification!.receiptSha256,
        })}\n`,
    );
}

if (import.meta.main) main();
