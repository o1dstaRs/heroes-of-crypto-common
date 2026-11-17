import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DRAFT_OPPONENT_MEMORY_RECIPE } from "../ai/setup/draft_opponent_memory";
import { PremiumEvidenceSnapshot } from "./premium_evidence_snapshot";
import { premiumDraftOpponentExamples, type IPremiumDraftHistoryRow } from "./premium_draft_memory_dataset";
import { fitPremiumDraftMemory, validatePremiumDraftMemory } from "./premium_draft_memory_fit";

async function fileHash(path: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}
const jsonHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function summarizeDraftMemoryValidation(validation: ReturnType<typeof validatePremiumDraftMemory>) {
    const summarize = (doctrine: number | null) => {
        const groups = new Map<
            string,
            {
                labels: number;
                positives: number;
                priorBrier: number;
                memoryBrier: number;
                priorLogLoss: number;
                memoryLogLoss: number;
            }
        >();
        for (const row of validation.scores) {
            if (doctrine === null ? row.doctrine === 2 : row.doctrine !== doctrine) continue;
            const sum = groups.get(row.familyId) ?? {
                labels: 0,
                positives: 0,
                priorBrier: 0,
                memoryBrier: 0,
                priorLogLoss: 0,
                memoryLogLoss: 0,
            };
            for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += row[key];
            groups.set(row.familyId, sum);
        }
        const rows = [...groups.values()];
        const mean = (key: "priorBrier" | "memoryBrier" | "priorLogLoss" | "memoryLogLoss") =>
            rows.length ? rows.reduce((sum, row) => sum + row[key] / row.labels, 0) / rows.length : null;
        const deltas = rows.map((row) => (row.priorBrier - row.memoryBrier) / row.labels);
        const boot = [];
        let state = 0x735b3b71;
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 4294967296;
        };
        if (rows.length)
            for (let iteration = 0; iteration < 10000; iteration++) {
                let total = 0;
                for (let i = 0; i < rows.length; i++) total += deltas[Math.floor(random() * deltas.length)];
                boot.push(total / rows.length);
            }
        boot.sort((a, b) => a - b);
        return {
            doctrine,
            families: rows.length,
            offeredLabels: rows.reduce((sum, row) => sum + row.labels, 0),
            occupiedLabels: rows.reduce((sum, row) => sum + row.positives, 0),
            priorBrier: mean("priorBrier"),
            memoryBrier: mean("memoryBrier"),
            priorLogLoss: mean("priorLogLoss"),
            memoryLogLoss: mean("memoryLogLoss"),
            brierImprovement: rows.length ? deltas.reduce((a, b) => a + b, 0) / rows.length : null,
            brierImprovementInterval95: boot.length ? [boot[249], boot[9749]] : null,
        };
    };
    const primary = summarize(null);
    const byDoctrine = [1, 2, 3].map(summarize);
    return {
        primary,
        byDoctrine,
        contextualBeliefScreenPassed:
            !!primary.brierImprovementInterval95 &&
            primary.brierImprovementInterval95[0] > 0 &&
            primary.memoryLogLoss! < primary.priorLogLoss! &&
            byDoctrine
                .filter((row) => row.doctrine !== 2)
                .every((row) => row.families > 0 && row.brierImprovement! >= 0),
        uncertainty: "descriptive-whole-family-bootstrap-of-fixed-out-of-fold-predictions",
        inferenceScope:
            "Training-source occupancy prediction only; overlapping fold fits are not independent fresh qualification.",
        policyWinRateMeasured: false,
    };
}

/** Reusable snapshot -> training targets -> frozen-recipe CV -> compact inference artifact. No games. */
export async function exportPremiumDraftMemory(
    snapshotPath: string,
    expectedSourceSha256: string,
    expectedSnapshotSha256: string,
    outputDirectory: string,
) {
    if (!/^[a-f0-9]{64}$/.test(expectedSnapshotSha256) || (await fileHash(snapshotPath)) !== expectedSnapshotSha256)
        throw new Error("Snapshot differs from the audited SHA256");
    const snapshot = new PremiumEvidenceSnapshot(snapshotPath, expectedSourceSha256, { allowDevelopment: true });
    const output = resolve(outputDirectory);
    try {
        mkdirSync(output);
        const save = (name: string, value: unknown) =>
            writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        const provenance = { sourceSha256: expectedSourceSha256, snapshotSha256: expectedSnapshotSha256 };
        save("registration.json", {
            at: new Date().toISOString(),
            snapshotId: snapshot.manifest.snapshotId,
            ...provenance,
            recipe: DRAFT_OPPONENT_MEMORY_RECIPE,
            folds: 5,
            foldSalt: "draft-memory-family-fold-v1",
            task: "Predict pre-action occupancy of offered units; no policy-value or win-rate label",
            primary:
                "Family-weighted out-of-fold Brier improvement over same stage/doctrine/unit prior, Scout and Battle Trance",
            screen: "Positive descriptive family-bootstrap Brier lower bound, better mean log loss, nonnegative Brier gain in each concealed-information doctrine",
            finalRefit:
                "Always preserve the frozen recipe on all original training families; never automatically enable it",
            maximumFits: 6,
            optimizerSteps: 0,
            newGames: 0,
            heldOutSnapshotRows: 0,
            promote: false,
        });
        const examples: ReturnType<typeof premiumDraftOpponentExamples> = [];
        let pending: IPremiumDraftHistoryRow[] = [];
        for (const row of snapshot.trainingDraftHistory()) {
            if (pending.length && pending[0].familyId !== row.familyId) {
                examples.push(...premiumDraftOpponentExamples(pending));
                pending = [];
            }
            pending.push(row);
        }
        if (pending.length) examples.push(...premiumDraftOpponentExamples(pending));
        if (!examples.length) throw new Error("No ranked training draft histories");
        const bytes = gzipSync(examples.map((row) => JSON.stringify(row) + "\n").join(""));
        writeFileSync(join(output, "opponent-targets.jsonl.gz"), bytes, { flag: "wx" });
        const validation = validatePremiumDraftMemory(examples, provenance);
        save("cross-validation.json", validation);
        const summary = summarizeDraftMemoryValidation(validation);
        save("validation-summary.json", summary);
        const model = fitPremiumDraftMemory(examples, provenance);
        save("model.json", model);
        if ((await fileHash(snapshotPath)) !== expectedSnapshotSha256)
            throw new Error("Snapshot changed during draft-memory preparation");
        const receipt = {
            complete: true,
            snapshotId: snapshot.manifest.snapshotId,
            ...provenance,
            sourceProvenance: snapshot.manifest.provenance,
            families: model.trainingFamilies,
            pickContexts: examples.length,
            offeredLabels: examples.reduce((sum, row) => sum + row.input.candidates.length, 0),
            targetsSha256: createHash("sha256").update(bytes).digest("hex"),
            modelCanonicalSha256: jsonHash(model),
            modelFileSha256: await fileHash(join(output, "model.json")),
            contextualBeliefScreenPassed: summary.contextualBeliefScreenPassed,
            fits: 6,
            optimizerSteps: 0,
            newSimulations: 0,
            heldOutSnapshotRows: 0,
            hiddenIdentityModelInputs: 0,
            policyWinRateMeasured: false,
            productionQualified: false,
            defaultsChanged: false,
            premiumSnapshotReplaced: false,
        };
        save("readiness.json", receipt);
        return receipt;
    } finally {
        snapshot.close();
    }
}

if (import.meta.main) {
    const [snapshot, sourceSha, snapshotSha, output, ...extra] = process.argv.slice(2);
    if (!snapshot || !sourceSha || !snapshotSha || !output || extra.length)
        throw new Error(
            "Usage: bun src/simulation/export_premium_draft_memory.ts SNAPSHOT SOURCE_SHA256 SNAPSHOT_SHA256 NEW_OUTPUT_DIRECTORY",
        );
    console.log(JSON.stringify(await exportPremiumDraftMemory(snapshot, sourceSha, snapshotSha, output)));
}
