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

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearSourceTreeFingerprintCache, fingerprintSourceTree } from "../../src/simulation/source_tree_fingerprint";

const directories: readonly string[] = ["src"];
const files: readonly string[] = ["package.json"];
const temporaryDirectories: string[] = [];

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "hoc-source-fingerprint-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    return root;
}

function uncachedFingerprint(root: string): string {
    const hash = createHash("sha256");
    for (const relativePath of ["src/a.ts", "src/nested/b.ts", "package.json"]) {
        hash.update(relativePath);
        hash.update(readFileSync(join(root, relativePath)));
    }
    return hash.digest("hex");
}

afterEach(() => {
    clearSourceTreeFingerprintCache();
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("preserves the established ordered path-and-byte fingerprint", () => {
    const root = fixture();
    const expected = uncachedFingerprint(root);

    expect(fingerprintSourceTree(root, directories, files)).toBe(expected);
    expect(fingerprintSourceTree(root, directories, files)).toBe(expected);
});

test("invalidates a cached fingerprint after a same-size rewrite with restored mtime", () => {
    const root = fixture();
    const path = join(root, "src", "a.ts");
    const timestamp = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(path, timestamp, timestamp);
    const originalStat = statSync(path, { bigint: true });
    const initial = fingerprintSourceTree(root, directories, files);

    writeFileSync(path, "export const a = 9;\n");
    utimesSync(path, timestamp, timestamp);
    const rewrittenStat = statSync(path, { bigint: true });

    expect(rewrittenStat.size).toBe(originalStat.size);
    expect(rewrittenStat.mtimeNs).toBe(originalStat.mtimeNs);
    const changed = fingerprintSourceTree(root, directories, files);
    expect(changed).not.toBe(initial);
    expect(changed).toBe(uncachedFingerprint(root));
});

test("invalidates the inventory for added, removed, and atomically replaced files", () => {
    const root = fixture();
    const initial = fingerprintSourceTree(root, directories, files);
    const added = join(root, "src", "c.ts");

    writeFileSync(added, "export const c = 3;\n");
    const afterAddition = fingerprintSourceTree(root, directories, files);
    expect(afterAddition).not.toBe(initial);

    rmSync(added);
    expect(fingerprintSourceTree(root, directories, files)).toBe(initial);

    const packagePath = join(root, "package.json");
    const replacement = join(root, "package.next.json");
    writeFileSync(replacement, '{"name":"changed"}\n');
    // renameSync models the atomic-save behavior used by editors.
    renameSync(replacement, packagePath);
    expect(fingerprintSourceTree(root, directories, files)).not.toBe(initial);
});
