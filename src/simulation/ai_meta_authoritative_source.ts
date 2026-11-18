import { resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fingerprintSourceTree } from "./source_tree_fingerprint";
import { captureGitSourceStatus } from "./git_source_status";

export const aiMetaServerRoot = () =>
    resolve(process.env.HOC_SERVER_LOC ?? resolve(import.meta.dir, "../../../../../heroes-of-crypto-server"));
export function aiMetaAuthoritativeSource() {
    const root = aiMetaServerRoot();
    const source = captureGitSourceStatus(root);
    const actual = fingerprintSourceTree(
        root,
        ["src", "configuration", "generated", "schema", "protobuf"],
        ["package.json", "bun.lock"],
    );
    const current = {
        schema: "ai-meta-authoritative-source-v1",
        serverCommit: source.commit,
        serverDirty: Boolean(source.status),
        serverStatus: source.status.split("\n").filter(Boolean),
        serverSha256: actual,
        commonResolution: "single-workspace-source-instance",
        draft: "authoritative-default-decider",
        setup: "native-commitBotSetupForTeam",
        placement: "native-rePlaceTeam-final-formation-and-barrels",
        combat: "full-A19-deterministic-work",
    } as const;
    const manifest = resolve(root, "ai-meta.server-source.json");
    if (!existsSync(manifest)) return current;
    const frozen = JSON.parse(readFileSync(manifest, "utf8")) as typeof current;
    if (
        frozen.schema !== current.schema ||
        frozen.serverSha256 !== actual ||
        !/^[a-f0-9]{40,64}$/.test(frozen.serverCommit) ||
        !Array.isArray(frozen.serverStatus) ||
        typeof frozen.serverDirty !== "boolean"
    )
        throw new Error("Frozen authoritative server source differs from its receipt");
    return frozen;
}

/** Development copy only: preserves explicit dirty provenance without touching a peer's checkout. */
export function freezeAiMetaAuthoritativeSource(destination: string) {
    const root = aiMetaServerRoot(),
        before = aiMetaAuthoritativeSource();
    if (existsSync(destination)) throw new Error("Server source destination already exists");
    mkdirSync(destination, { recursive: true });
    for (const name of [
        "src",
        "configuration",
        "generated",
        "schema",
        "protobuf",
        "package.json",
        "bun.lock",
        "tsconfig.json",
        "AGENTS.md",
    ])
        cpSync(resolve(root, name), resolve(destination, name), { recursive: true, force: false, errorOnExist: true });
    if (
        JSON.stringify(aiMetaAuthoritativeSource()) !== JSON.stringify(before) ||
        fingerprintSourceTree(
            destination,
            ["src", "configuration", "generated", "schema", "protobuf"],
            ["package.json", "bun.lock"],
        ) !== before.serverSha256
    )
        throw new Error("Server changed during source freeze; preserve the partial copy");
    writeFileSync(resolve(destination, "ai-meta.server-source.json"), JSON.stringify(before, null, 2) + "\n", {
        flag: "wx",
    });
    return before;
}
