import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA =
    "heroes-of-crypto/a13-stat-rounding-near-grid-source-manifest/type-tagged-src-relative-v1" as const;
export const A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE = "paths-relative-to-src-root" as const;
export const A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR = "utf16-code-unit-less-than-greater-than" as const;

export interface A13NearGridSourceManifestEntry {
    bytes: number;
    kind: "file" | "symlink";
    path: string;
    sha256: string;
}

export interface A13NearGridSourceManifestSeal {
    schema: typeof A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA;
    pathScope: typeof A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE;
    comparator: typeof A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR;
    root: string;
    realRoot: string;
    sourceRoot: string;
    realSourceRoot: string;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
}

export interface A13NearGridSourceManifestIdentity {
    schema: typeof A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA;
    pathScope: typeof A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE;
    comparator: typeof A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
}

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const normalizedPath = (path: string): string => path.split(sep).join("/");

function collectEntries(directory: string, root: string, entries: A13NearGridSourceManifestEntry[]): void {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        compareStrings(left.name, right.name),
    );
    for (const child of children) {
        const path = join(directory, child.name);
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectEntries(path, root, entries);
            continue;
        }
        const relativePath = normalizedPath(relative(root, path));
        if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                bytes: Buffer.byteLength(target),
                kind: "symlink",
                path: relativePath,
                sha256: sha256(target),
            });
            continue;
        }
        if (!stats.isFile()) throw new Error(`Unsupported source-manifest entry: ${path}`);
        const bytes = readFileSync(path);
        entries.push({
            bytes: bytes.byteLength,
            kind: "file",
            path: relativePath,
            sha256: sha256(bytes),
        });
    }
}

export function digestA13NearGridSourceManifestEntries(
    entriesInput: readonly A13NearGridSourceManifestEntry[],
): string {
    const entries = entriesInput
        .map((entry) => ({ ...entry }))
        .sort((left, right) => compareStrings(left.path, right.path));
    for (const [index, entry] of entries.entries()) {
        const pathSegments = entry.path.split("/");
        if (
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            (entry.kind !== "file" && entry.kind !== "symlink") ||
            !entry.path ||
            entry.path.startsWith("/") ||
            entry.path.includes("\\") ||
            entry.path.includes("\0") ||
            pathSegments.some((segment) => !segment || segment === "." || segment === "..") ||
            !/^[0-9a-f]{64}$/.test(entry.sha256) ||
            (index > 0 && entries[index - 1].path === entry.path)
        ) {
            throw new Error(`Invalid source-manifest entry at index ${index}`);
        }
    }
    const encoded = [
        "array",
        0,
        entries.map((entry, index) => [
            "object",
            index + 1,
            [
                ["bytes", ["number", entry.bytes]],
                ["kind", ["string", entry.kind]],
                ["path", ["string", entry.path]],
                ["sha256", ["string", entry.sha256]],
            ],
        ]),
        [],
    ];
    return sha256(JSON.stringify(encoded));
}

export function sealA13NearGridSourceManifest(commonRootInput: string): A13NearGridSourceManifestSeal {
    const root = resolve(commonRootInput);
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error(`Source-manifest root must be a regular directory: ${root}`);
    }
    const realRoot = realpathSync(root);
    if (realRoot !== root) throw new Error(`Source-manifest root must be canonical: ${root} -> ${realRoot}`);
    const sourceRoot = join(root, "src");
    const sourceStats = lstatSync(sourceRoot);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error(`Source-manifest src must be a regular directory: ${sourceRoot}`);
    }
    const realSourceRoot = realpathSync(sourceRoot);
    if (realSourceRoot !== sourceRoot) {
        throw new Error(`Source-manifest src must be canonical: ${sourceRoot} -> ${realSourceRoot}`);
    }
    const entries: A13NearGridSourceManifestEntry[] = [];
    collectEntries(sourceRoot, sourceRoot, entries);
    entries.sort((left, right) => compareStrings(left.path, right.path));
    return {
        schema: A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA,
        pathScope: A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE,
        comparator: A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR,
        root,
        realRoot,
        sourceRoot,
        realSourceRoot,
        entryCount: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        manifestSha256: digestA13NearGridSourceManifestEntries(entries),
    };
}

export function a13NearGridSourceManifestIdentity(
    seal: A13NearGridSourceManifestSeal,
): A13NearGridSourceManifestIdentity {
    return {
        schema: seal.schema,
        pathScope: seal.pathScope,
        comparator: seal.comparator,
        entryCount: seal.entryCount,
        bytes: seal.bytes,
        manifestSha256: seal.manifestSha256,
    };
}

export function assertA13NearGridSourceManifestIdentity(
    actual: A13NearGridSourceManifestIdentity,
    expected: A13NearGridSourceManifestIdentity,
    label: string,
): void {
    if (
        actual.schema !== expected.schema ||
        actual.pathScope !== expected.pathScope ||
        actual.comparator !== expected.comparator ||
        actual.entryCount !== expected.entryCount ||
        actual.bytes !== expected.bytes ||
        actual.manifestSha256 !== expected.manifestSha256
    ) {
        throw new Error(`${label} mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
}
