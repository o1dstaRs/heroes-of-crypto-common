import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { scanV07ComposedSeedCorpus } from "../../src/simulation/v0_7_composed_seed_scan";

const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

test("seed scan excludes only component-safe generated path prefixes and discloses them", async () => {
    const parent = mkdtempSync(join(tmpdir(), "v07-composed-prefix-exclusion-"));
    const excludedDirectory = join(parent, "cem", "eval_3550186_41");
    const adjacentNameDirectory = join(parent, "cem", "eval_35501860_41");
    const adjacentParentDirectory = join(parent, "cem-sibling", "eval_3550186_41");
    mkdirSync(excludedDirectory, { recursive: true });
    mkdirSync(adjacentNameDirectory, { recursive: true });
    mkdirSync(adjacentParentDirectory, { recursive: true });
    const excludedPath = join(excludedDirectory, "seeds.json");
    const adjacentNamePath = join(adjacentNameDirectory, "seeds.json");
    const adjacentParentPath = join(adjacentParentDirectory, "seeds.json");
    const excludedStampedPath = join(parent, "cem", "best-72.5.json");
    const adjacentStampedPath = join(parent, "cem", "bestish.json");
    writeFileSync(excludedPath, `${JSON.stringify({ seed: 111111 })}\n`);
    writeFileSync(adjacentNamePath, `${JSON.stringify({ seed: 222222 })}\n`);
    writeFileSync(adjacentParentPath, `${JSON.stringify({ seed: 333333 })}\n`);
    writeFileSync(excludedStampedPath, `${JSON.stringify({ seed: 444444 })}\n`);
    writeFileSync(adjacentStampedPath, `${JSON.stringify({ seed: 555555 })}\n`);
    const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
    for (const path of [excludedPath, adjacentNamePath, adjacentParentPath, excludedStampedPath, adjacentStampedPath]) {
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
    }
    const commonRoot = resolve(import.meta.dir, "../..");
    const corePath = resolve(commonRoot, "src/simulation/optimizer/v0_7_96h_core.ts");
    const prefix = join(parent, "cem", "eval_3550186_");
    const stampedPrefix = join(parent, "cem", "best-");
    const options = {
        cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
        commonRoot,
        priorManifestExpanderPath: corePath,
        priorManifestExpanderSha256: fileSha256(corePath),
        roots: [parent],
        excluded: [],
        excludedPathPrefixes: [prefix, stampedPrefix],
        excludedRelativeSuffixes: ["target.json"],
    };
    try {
        const result = await scanV07ComposedSeedCorpus(options);
        expect(result.seeds).not.toContain(111111);
        expect(result.seeds).toContain(222222);
        expect(result.seeds).toContain(333333);
        expect(result.seeds).not.toContain(444444);
        expect(result.seeds).toContain(555555);
        expect(result.summary).toMatchObject({
            files: 3,
            textFiles: 3,
            structuredFiles: 3,
            excludedPathPrefixes: [stampedPrefix, prefix].sort(),
        });
        await expect(
            scanV07ComposedSeedCorpus({
                ...options,
                excludedPathPrefixes: [join(parent, "cem", "eval_3550186")],
            }),
        ).rejects.toThrow("generated-entry prefixes ending in `_` or `-`");
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});
