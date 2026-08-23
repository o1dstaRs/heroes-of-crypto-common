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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureGitSourceStatus } from "../../src/simulation/git_source_status";

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "hoc-git-source-status-"));
    temporaryDirectories.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@heroesofcrypto.io");
    git(root, "config", "user.name", "Heroes Test");
    return root;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("captures HEAD and preserves short status for modifications, renames, and unusual untracked paths", () => {
    const root = repository();
    writeFileSync(join(root, "ordinary.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "rename source.ts"), "rename me\n");
    writeFileSync(join(root, "staged.ts"), "staged = false\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "--message=fixture");

    writeFileSync(join(root, "ordinary.ts"), "export const value = 2;\n");
    writeFileSync(join(root, "staged.ts"), "staged = true\n");
    git(root, "add", "staged.ts");
    git(root, "mv", "rename source.ts", "rename target.ts");
    writeFileSync(join(root, "untracked -> space.ts"), "untracked\n");
    writeFileSync(join(root, "untracked\nnewline.ts"), "untracked\n");
    git(root, "config", "core.quotePath", "false");
    writeFileSync(join(root, "unicode\u00a0space.ts"), "untracked\n");

    const expectedCommit = git(root, "rev-parse", "HEAD");
    const expectedStatus = git(root, "status", "--short");
    expect(captureGitSourceStatus(root)).toEqual({ commit: expectedCommit, status: expectedStatus });

    git(root, "checkout", "--quiet", "--detach");
    expect(captureGitSourceStatus(root)).toEqual({ commit: expectedCommit, status: expectedStatus });
});

test("preserves dirty untracked state in an unborn repository", () => {
    const root = repository();
    writeFileSync(join(root, "first file.ts"), "untracked\n");

    expect(captureGitSourceStatus(root)).toEqual({
        commit: "unknown",
        status: git(root, "status", "--short"),
    });
});

test("treats an unavailable repository as unknown and dirty", () => {
    const root = mkdtempSync(join(tmpdir(), "hoc-no-git-source-status-"));
    temporaryDirectories.push(root);

    expect(captureGitSourceStatus(root)).toEqual({ commit: "unknown", status: "unknown" });
});
