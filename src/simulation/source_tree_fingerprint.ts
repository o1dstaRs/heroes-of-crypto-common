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

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface ISourceFileSnapshot {
    absolutePath: string;
    relativePath: string;
    metadata: string;
}

interface ISourceTreeFingerprintCacheEntry {
    files: ISourceFileSnapshot[];
    sha256: string;
}

const cache = new Map<string, ISourceTreeFingerprintCacheEntry>();

function fileSnapshot(root: string, relativePath: string): ISourceFileSnapshot {
    const absolutePath = resolve(root, relativePath);
    const stat = statSync(absolutePath, { bigint: true });
    if (!stat.isFile()) throw new Error(`Source fingerprint path is not a regular file: ${relativePath}`);
    return {
        absolutePath,
        relativePath,
        // ctime catches same-size rewrites even when a tool restores mtime. dev + ino catch atomic replacement.
        metadata: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
    };
}

function sourceFiles(root: string, directories: readonly string[], files: readonly string[]): ISourceFileSnapshot[] {
    const visit = (directory: string): ISourceFileSnapshot[] =>
        readdirSync(resolve(root, directory), { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .flatMap((entry) => {
                const path = join(directory, entry.name);
                return entry.isDirectory() ? visit(path) : entry.isFile() ? [fileSnapshot(root, path)] : [];
            });
    return [...directories.flatMap(visit), ...files.map((path) => fileSnapshot(root, path))];
}

function sameSnapshot(left: readonly ISourceFileSnapshot[], right: readonly ISourceFileSnapshot[]): boolean {
    return (
        left.length === right.length &&
        left.every(
            (file, index) =>
                file.relativePath === right[index]?.relativePath && file.metadata === right[index]?.metadata,
        )
    );
}

/**
 * Fingerprint ordered source paths and bytes, reusing the digest only while the complete file inventory and
 * dev/inode/mode/size/mtime/ctime metadata remain identical. Every call still walks and stats the source tree,
 * so writes, atomic replacements, additions, and removals invalidate the process-local cache automatically.
 */
export function fingerprintSourceTree(root: string, directories: readonly string[], files: readonly string[]): string {
    const absoluteRoot = resolve(root);
    const cacheKey = JSON.stringify([absoluteRoot, directories, files]);

    // Retry a concurrent edit once. Callers use this identity as an integrity guard, so a mixed snapshot must
    // never be cached even if a source editor happens to save while the initial read is in progress.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = sourceFiles(absoluteRoot, directories, files);
        const cached = cache.get(cacheKey);
        if (cached && sameSnapshot(before, cached.files)) return cached.sha256;

        const hash = createHash("sha256");
        for (const file of before) {
            hash.update(file.relativePath);
            hash.update(readFileSync(file.absolutePath));
        }
        const sha256 = hash.digest("hex");
        const after = sourceFiles(absoluteRoot, directories, files);
        if (sameSnapshot(before, after)) {
            cache.set(cacheKey, { files: after, sha256 });
            return sha256;
        }
    }
    throw new Error("Source tree changed while its fingerprint was being captured");
}

/** Explicit invalidation for tests and callers that deliberately manipulate filesystem timestamps/metadata. */
export function clearSourceTreeFingerprintCache(): void {
    cache.clear();
}
