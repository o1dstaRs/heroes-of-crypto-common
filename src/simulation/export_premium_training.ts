import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { AI_META_COHORTS } from "./ai_meta_cohorts_core";
import { PremiumEvidenceSnapshot } from "./premium_evidence_snapshot";
import { premiumTrainingExample, PREMIUM_TRAINING_EXAMPLE_SCHEMA } from "./premium_learning_dataset";

async function fileHash(path: string) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest("hex");
}

interface Support {
    cohort: string;
    stage: string;
    doctrine: number | null;
    rows: number;
    families: Set<string>;
    collisions: number;
    nonModalSelections: number;
    minSelectedProbability: number;
    maxCandidates: number;
    actions: Map<string, { offered: Set<string>; selected: Set<string>; rows: number }>;
}

/** Existing data only. Requires the independently audited immutable snapshot's file and source hashes. */
export async function exportPremiumTrainingDataset(
    snapshotPath: string,
    expectedSourceSha256: string,
    expectedSnapshotSha256: string,
    outputDirectory: string,
) {
    if (!/^[a-f0-9]{64}$/.test(expectedSnapshotSha256) || (await fileHash(snapshotPath)) !== expectedSnapshotSha256)
        throw new Error("Snapshot file does not match the audited SHA256");
    const snapshot = new PremiumEvidenceSnapshot(snapshotPath, expectedSourceSha256, { allowDevelopment: true });
    const output = resolve(outputDirectory);
    try {
        // Deliberately no recursive/existing-directory option: never overwrite an earlier artifact.
        mkdirSync(output);
        const supports = new Map<string, Support>();
        const rowCounts = new Map<string, number>();
        const allFamilies = new Set<string>();
        let totalRows = 0;
        function* rows() {
            for (const cohort of AI_META_COHORTS)
                for (const kind of ["draft", "augment", "formation"] as const)
                    for (const raw of snapshot.trainingDecisions(cohort, kind))
                        yield { cohort, example: premiumTrainingExample(raw) };
        }
        for (const { cohort, example } of rows()) {
            const { input, logged, audit } = example;
            const group = JSON.stringify([cohort, input.stage, audit.familyId]);
            rowCounts.set(group, (rowCounts.get(group) ?? 0) + 1);
            allFamilies.add(audit.familyId);
            totalRows++;
            // Doctrine at the decision, not the future selected doctrine. Zero means not selected yet.
            for (const doctrine of [null, Number(input.observation.doctrine)]) {
                const key = JSON.stringify([cohort, input.stage, doctrine]);
                let support = supports.get(key);
                if (!support) {
                    support = {
                        cohort,
                        stage: input.stage,
                        doctrine,
                        rows: 0,
                        families: new Set(),
                        collisions: 0,
                        nonModalSelections: 0,
                        minSelectedProbability: 1,
                        maxCandidates: 0,
                        actions: new Map(),
                    };
                    supports.set(key, support);
                }
                support.rows++;
                support.families.add(audit.familyId);
                support.collisions += Number(logged.status === "collision");
                const selected = logged.probabilities.find(({ key }) => key === logged.selectedKey)!;
                const maximum = Math.max(...logged.probabilities.map(({ probability }) => probability));
                support.nonModalSelections += Number(selected.probability < maximum - 1e-12);
                support.minSelectedProbability = Math.min(support.minSelectedProbability, selected.probability);
                support.maxCandidates = Math.max(support.maxCandidates, input.candidates.length);
                for (const { key } of input.candidates) {
                    let action = support.actions.get(key);
                    if (!action) {
                        action = { offered: new Set(), selected: new Set(), rows: 0 };
                        support.actions.set(key, action);
                    }
                    action.offered.add(audit.familyId);
                    if (key === logged.selectedKey) {
                        action.selected.add(audit.familyId);
                        action.rows++;
                    }
                }
            }
        }
        if (!totalRows) throw new Error("No training decisions available; cannot export a learning dataset");
        const trainingPath = join(output, "training.jsonl.gz");
        const encoded = function* () {
            for (const { cohort, example } of rows()) {
                const count = rowCounts.get(JSON.stringify([cohort, example.input.stage, example.audit.familyId]))!;
                yield JSON.stringify({
                    ...example,
                    audit: { ...example.audit, cohort, partition: "train" },
                    weighting: {
                        familyStageWeight: 1 / count,
                        scope: "one-total-weight-per-family-cohort-stage",
                        propensityWeightsApplied: false,
                    },
                }) + "\n";
            }
        };
        await pipeline(Readable.from(encoded()), createGzip(), createWriteStream(trainingPath, { flags: "wx" }));
        if ((await fileHash(snapshotPath)) !== expectedSnapshotSha256)
            throw new Error("Snapshot changed during export");
        const coverage = [...supports.values()].map((support) => {
            const actions = [...support.actions.entries()].map(([key, action]) => ({
                key,
                offeredFamilies: action.offered.size,
                selectedFamilies: action.selected.size,
                selectedRows: action.rows,
            }));
            return {
                cohort: support.cohort,
                stage: support.stage,
                doctrineAtDecision: support.doctrine,
                rows: support.rows,
                families: support.families.size,
                collisions: support.collisions,
                nonModalSelections: support.nonModalSelections,
                minSelectedProbability: support.minSelectedProbability,
                largestInverseSelectedProbability: 1 / support.minSelectedProbability,
                maximumCandidateCount: support.maxCandidates,
                actionKeys: actions.length,
                neverSelectedKeys: actions.filter((a) => a.selectedRows === 0).length,
                keysSelectedInFewerThanFiveFamilies: actions.filter((a) => a.selectedFamilies < 5).length,
                actions,
            };
        });
        const receipt = {
            schema: "premium-training-export-v1",
            exampleSchema: PREMIUM_TRAINING_EXAMPLE_SCHEMA,
            complete: true,
            snapshotId: snapshot.manifest.snapshotId,
            snapshotSha256: expectedSnapshotSha256,
            sourceSha256: expectedSourceSha256,
            sourceProvenance: snapshot.manifest.provenance,
            rows: totalRows,
            families: allFamilies.size,
            partition: "train",
            heldOutRows: 0,
            training: { path: "training.jsonl.gz", sha256: await fileHash(trainingPath) },
            coverage,
            modelsFitted: 0,
            simulationsRun: 0,
            promoted: false,
            limitations: [
                "Supply only input to a model. logged, target, audit and weighting are separate training bookkeeping.",
                "Cohorts stay separate; only ranked-draft exercises drafting. Doctrine choice remains uniform.",
                "Coverage counts use training only and do not inspect held-out labels.",
                "Action keys can be context-local (bundle indices); support is descriptive, not action efficacy.",
                "Five-family support is a sparsity diagnostic, not a strength or readiness gate.",
                "Logged outcomes are not paired alternative outcomes or an off-policy value estimate.",
                "Marginal probabilities are not trajectory probabilities; no inverse weighting is applied.",
                "Headless setup is not server-qualified. No learned policy has been fitted or served.",
            ],
        };
        writeFileSync(join(output, "readiness.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
        return receipt;
    } finally {
        snapshot.close();
    }
}

if (import.meta.main) {
    const [snapshot, sourceSha, snapshotSha, output, ...extra] = process.argv.slice(2);
    if (!snapshot || !sourceSha || !snapshotSha || !output || extra.length)
        throw new Error(
            "Usage: bun src/simulation/export_premium_training.ts SNAPSHOT SOURCE_SHA256 SNAPSHOT_SHA256 NEW_OUTPUT_DIRECTORY",
        );
    const receipt = await exportPremiumTrainingDataset(snapshot, sourceSha, snapshotSha, output);
    console.log(
        JSON.stringify({
            complete: receipt.complete,
            rows: receipt.rows,
            families: receipt.families,
            heldOutRows: receipt.heldOutRows,
            output: resolve(output),
        }),
    );
}
