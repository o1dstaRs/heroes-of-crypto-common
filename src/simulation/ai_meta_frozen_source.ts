import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { captureGitSourceStatus } from "./git_source_status";
import { fingerprintSourceTree } from "./source_tree_fingerprint";

export const AI_META_FROZEN_SOURCE_SCHEMA = "ai-meta-frozen-source-v1";
const ORIGIN_FILE = "ai-meta.source.json";
export interface IAiMetaFrozenSource {
    schema: typeof AI_META_FROZEN_SOURCE_SCHEMA;
    sourceSha256: string;
    lockSha256: string;
    commonCommit: string;
    commonDirty: boolean;
    commonStatus: string[];
    capturedAt: string;
    purpose: "development-pilot";
}
const lockHash = (root: string): string =>
    createHash("sha256")
        .update(readFileSync(join(root, "bun.lock")))
        .digest("hex");

export function readAiMetaFrozenSource(root: string, actualSha256: string): IAiMetaFrozenSource | undefined {
    const path = join(root, ORIGIN_FILE);
    if (!existsSync(path)) return undefined;
    const origin = JSON.parse(readFileSync(path, "utf8")) as IAiMetaFrozenSource;
    if (
        origin.schema !== AI_META_FROZEN_SOURCE_SCHEMA ||
        origin.purpose !== "development-pilot" ||
        origin.sourceSha256 !== actualSha256 ||
        origin.lockSha256 !== lockHash(root) ||
        !/^[a-f0-9]{40,64}$/.test(origin.commonCommit) ||
        typeof origin.commonDirty !== "boolean" ||
        !Array.isArray(origin.commonStatus) ||
        origin.commonStatus.some((line) => typeof line !== "string")
    ) {
        throw new Error("Frozen AI meta source or lockfile does not match its origin manifest");
    }
    return origin;
}

/** Copy a measured development tree without committing or altering shared-main work. */
export function freezeAiMetaSource(root: string, destination: string): IAiMetaFrozenSource {
    if (existsSync(destination)) throw new Error("Frozen source destination already exists");
    const before = fingerprintSourceTree(root, ["src"], ["package.json"]);
    const git = captureGitSourceStatus(root);
    const origin: IAiMetaFrozenSource = {
        schema: AI_META_FROZEN_SOURCE_SCHEMA,
        sourceSha256: before,
        lockSha256: lockHash(root),
        commonCommit: git.commit,
        commonDirty: Boolean(git.status),
        commonStatus: git.status.split("\n").filter(Boolean),
        capturedAt: new Date().toISOString(),
        purpose: "development-pilot",
    };
    mkdirSync(destination, { recursive: true });
    for (const name of [
        "src",
        "test",
        "scripts",
        "package.json",
        "bun.lock",
        "tsconfig.json",
        "tsconfig.build.json",
        "LICENSE",
        "README.md",
        "AGENTS.md",
    ])
        if (existsSync(join(root, name)))
            cpSync(join(root, name), join(destination, name), { recursive: true, errorOnExist: true, force: false });
    if (
        before !== fingerprintSourceTree(root, ["src"], ["package.json"]) ||
        before !== fingerprintSourceTree(destination, ["src"], ["package.json"]) ||
        origin.lockSha256 !== lockHash(destination)
    )
        throw new Error("Source changed while freezing; partial copy preserved for diagnosis");
    writeFileSync(join(destination, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`, { flag: "wx" });
    readAiMetaFrozenSource(destination, before);
    return origin;
}

if (import.meta.main) {
    const [destination] = process.argv.slice(2);
    if (!destination) throw new Error("Usage: bun src/simulation/ai_meta_frozen_source.ts <fresh-local-directory>");
    console.log(JSON.stringify(freezeAiMetaSource(process.cwd(), resolve(destination)), null, 2));
}
