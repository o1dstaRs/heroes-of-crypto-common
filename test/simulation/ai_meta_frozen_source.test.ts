import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAiMetaFrozenSource } from "../../src/simulation/ai_meta_frozen_source";
import { fingerprintSourceTree } from "../../src/simulation/source_tree_fingerprint";

it("retains original dirty provenance and rejects modified source or lockfiles", () => {
    const root = mkdtempSync(join(tmpdir(), "hoc-frozen-origin-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "example.ts"), "export const x = 1;");
        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(join(root, "bun.lock"), "fixture-lock");
        const sha = fingerprintSourceTree(root, ["src"], ["package.json"]);
        expect(readAiMetaFrozenSource(root, sha)).toBeUndefined();
        const origin = {
            schema: "ai-meta-frozen-source-v1",
            purpose: "development-pilot",
            sourceSha256: sha,
            lockSha256: createHash("sha256").update("fixture-lock").digest("hex"),
            commonCommit: "a".repeat(40),
            commonDirty: true,
            commonStatus: [" M src/example.ts"],
            capturedAt: new Date().toISOString(),
        };
        writeFileSync(join(root, "ai-meta.source.json"), JSON.stringify(origin));
        expect(readAiMetaFrozenSource(root, sha)).toEqual(origin);
        expect(() => readAiMetaFrozenSource(root, "b".repeat(64))).toThrow("does not match");
        writeFileSync(join(root, "bun.lock"), "changed-lock");
        expect(() => readAiMetaFrozenSource(root, sha)).toThrow("does not match");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
