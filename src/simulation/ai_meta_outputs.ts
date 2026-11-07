import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPremiumMetaStudy, PREMIUM_META_FULL_AUGMENTS_STUDY } from "./ai_meta_study";
import { auditPremiumEvidence } from "./audit_premium_evidence";
import { buildPremiumEvidenceSnapshot } from "./build_premium_evidence_snapshot";
import { PremiumEvidenceSnapshot } from "./premium_evidence_snapshot";

/** CLI defaults only. Programmatic, registered experiments keep their explicit run options. */
export function aiMetaOutputContract(profile: string, environment: NodeJS.ProcessEnv) {
    const mode = environment.AI_META_OUTPUT_MODE ?? "premium";
    if (mode !== "premium" && mode !== "legacy-oracle")
        throw new Error("AI_META_OUTPUT_MODE must be premium or explicitly legacy-oracle");
    if (mode === "legacy-oracle") {
        if (environment.AI_META_STUDY_PROFILE)
            throw new Error("legacy-oracle conflicts with AI_META_STUDY_PROFILE; do not silently change a study");
        return { mode, studyProfile: undefined, collectEvidence: environment.AI_META_COLLECT_EVIDENCE === "1" };
    }
    if (!["a19-work", "v09-draft-a19-work"].includes(profile))
        throw new Error(
            "Automatic Premium snapshots require a19-work or v09-draft-a19-work; " +
                "use AI_META_OUTPUT_MODE=legacy-oracle explicitly for outcome-only research",
        );
    if (environment.AI_META_COLLECT_EVIDENCE !== undefined && environment.AI_META_COLLECT_EVIDENCE !== "1")
        throw new Error("Premium batches require evidence capture; unset AI_META_COLLECT_EVIDENCE or set it to 1");
    if (environment.AI_META_ARTIFACT_UNIFORM === "1")
        throw new Error("Premium study fixes exploration; unset AI_META_ARTIFACT_UNIFORM");
    const studyProfile = environment.AI_META_STUDY_PROFILE ?? PREMIUM_META_FULL_AUGMENTS_STUDY;
    if (!isPremiumMetaStudy(studyProfile)) throw new Error(`Unknown AI_META_STUDY_PROFILE: ${studyProfile}`);
    return { mode, studyProfile, collectEvidence: true };
}

function atomicWrite(path: string, text: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, text, { flag: "wx" });
        renameSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
async function fileHash(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

/** No fights, fitting or publication. Safe to retry after an interrupted artifact build. */
export async function finalizeAiMetaOutputs(
    capturedSummaryPath: string,
    options: { publishSummaryPath?: string } = {},
) {
    const input = resolve(capturedSummaryPath);
    const directory = dirname(input);
    const text = readFileSync(input, "utf8");
    const summary = JSON.parse(text);
    if (!summary.complete || !isPremiumMetaStudy(summary.provenance?.fightProfile?.studyProfile))
        throw new Error("Finalization requires a fully captured Premium study, not a partial shard or legacy run");
    const snapshotPath = join(directory, "premium.sqlite");
    const auditPath = join(directory, "premium-readiness.json");
    const receiptPath = join(directory, "ai-meta.outputs.json");
    const summarySha256 = hashText(text);
    if (existsSync(receiptPath) && JSON.parse(readFileSync(receiptPath, "utf8")).summarySha256 !== summarySha256)
        throw new Error("Existing output receipt belongs to a different summary; preserve it");
    const publishPath = options.publishSummaryPath ? resolve(options.publishSummaryPath) : undefined;
    if (publishPath && dirname(publishPath) !== directory)
        throw new Error("Published summary must stay beside its raw archives and snapshot");
    if (publishPath && existsSync(publishPath)) {
        const previousText = readFileSync(publishPath, "utf8");
        if (previousText !== text && JSON.parse(previousText).complete)
            throw new Error("Refusing to replace a different completed summary");
    }
    const identity = {
        schema: "ai-meta-outputs-v1",
        summarySha256,
        sourceSha256: summary.provenance.sourceSha256,
        mode: "premium",
        modelsPromoted: false,
        published: false,
    };
    atomicWrite(receiptPath, jsonText({ ...identity, state: "building", complete: false }));
    try {
        if (!existsSync(snapshotPath)) await buildPremiumEvidenceSnapshot(input, snapshotPath, { development: true });
        const snapshot = new PremiumEvidenceSnapshot(snapshotPath, summary.provenance.sourceSha256, {
            allowDevelopment: true,
        });
        const manifest = snapshot.manifest;
        snapshot.close();
        if (
            manifest.status !== "development" ||
            JSON.stringify(manifest.provenance) !== JSON.stringify(summary.provenance)
        )
            throw new Error("Existing snapshot belongs to another run or status; preserve it");
        const db = new Database(snapshotPath, { readonly: true });
        try {
            if (
                db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
                db.query("PRAGMA foreign_key_check").all().length
            )
                throw new Error("Snapshot failed SQLite integrity checks");
        } finally {
            db.close();
        }
        const audit = await auditPremiumEvidence(input, snapshotPath);
        if (audit.failures.length || audit.rejectedActions)
            throw new Error(`Premium audit failed: ${audit.rejectedActions} rejects; ${audit.failures.join(", ")}`);
        if (readFileSync(input, "utf8") !== text) throw new Error("Summary changed during finalization");
        const auditText = jsonText(audit);
        atomicWrite(auditPath, auditText);
        const receipt = {
            ...identity,
            state: "complete",
            complete: true,
            completedAt: new Date().toISOString(),
            families: manifest.families,
            fights: manifest.fights,
            snapshot: {
                path: "premium.sqlite",
                sha256: await fileHash(snapshotPath),
                snapshotId: manifest.snapshotId,
                status: manifest.status,
                capabilities: manifest.capabilities,
            },
            audit: { path: "premium-readiness.json", sha256: hashText(auditText) },
            sources: manifest.sources,
        };
        atomicWrite(receiptPath, jsonText(receipt));
        // Readers see complete:true only after SQLite and the raw-evidence audit succeeded.
        if (publishPath && publishPath !== input) atomicWrite(publishPath, text);
        return receipt;
    } catch (error) {
        atomicWrite(receiptPath, jsonText({ ...identity, state: "failed", complete: false, error: String(error) }));
        throw error;
    }
}

if (import.meta.main) {
    const [input, publish, ...extra] = process.argv.slice(2);
    if (!input || extra.length || (input === "--preflight" && !publish))
        throw new Error(
            "Usage: bun src/simulation/ai_meta_outputs.ts <captured-summary.json> [published-summary.json]",
        );
    console.log(
        JSON.stringify(
            input === "--preflight"
                ? aiMetaOutputContract(publish!, process.env)
                : await finalizeAiMetaOutputs(input, { publishSummaryPath: publish }),
            null,
            2,
        ),
    );
}
