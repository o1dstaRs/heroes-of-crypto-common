import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { draftMatchupFeatures } from "../ai/setup/draft_matchup_value";
import { AI_META_COHORTS } from "./ai_meta_cohorts_core";
import { PremiumEvidenceSnapshot } from "./premium_evidence_snapshot";

async function hashFile(path: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

/** Explicitly export all original training cohorts, preserving family grouping and source identity. */
export async function exportPremiumMatchups(
    path: string,
    sourceSha256: string,
    snapshotSha256: string,
    output: string,
) {
    if (!/^[a-f0-9]{64}$/.test(snapshotSha256) || (await hashFile(path)) !== snapshotSha256)
        throw new Error("Matchup snapshot SHA256 mismatch");
    const snapshot = new PremiumEvidenceSnapshot(path, sourceSha256, { allowDevelopment: true });
    try {
        mkdirSync(output);
        const rows = [...snapshot.trainingMatchups(AI_META_COHORTS)].map((row) => ({
            ...row,
            fold:
                parseInt(
                    createHash("sha256").update(`premium-matchup-fold-v1:${row.familyId}`).digest("hex").slice(0, 8),
                    16,
                ) % 5,
            armies: row.armies.map((army) => ({
                ...army,
                features: {
                    "unit-only": draftMatchupFeatures(army.input, false),
                    interactions: draftMatchupFeatures(army.input, true),
                },
            })),
        }));
        if (!rows.length) throw new Error("No training matchup families");
        const bytes = gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        writeFileSync(join(output, "training-matchups.jsonl.gz"), bytes, { flag: "wx" });
        if ((await hashFile(path)) !== snapshotSha256) throw new Error("Snapshot changed during matchup export");
        const receipt = {
            at: new Date().toISOString(),
            sourceSha256,
            snapshotSha256,
            snapshotId: snapshot.manifest.snapshotId,
            manifest: snapshot.manifest,
            trainingFamilies: rows.length,
            armyRows: rows.length * 2,
            trainingOnly: true,
            familyTotalWeight: 1,
            newGames: 0,
            fits: 0,
            foldSalt: "premium-matchup-fold-v1",
            folds: 5,
            outputSha256: createHash("sha256").update(bytes).digest("hex"),
            byCohort: Object.fromEntries(
                AI_META_COHORTS.map((cohort) => [cohort, rows.filter((row) => row.cohort === cohort).length]),
            ),
        };
        writeFileSync(join(output, "export-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
        return receipt;
    } finally {
        snapshot.close();
    }
}

if (import.meta.main) {
    const [path, source, snapshot, output] = process.argv.slice(2);
    if (!path || !source || !snapshot || !output)
        throw new Error(
            "Usage: export_premium_matchups.ts SNAPSHOT SOURCE_SHA256 SNAPSHOT_SHA256 NEW_OUTPUT_DIRECTORY",
        );
    console.log(JSON.stringify(await exportPremiumMatchups(path, source, snapshot, output)));
}
