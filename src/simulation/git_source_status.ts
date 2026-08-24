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

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

export interface IGitSourceStatus {
    commit: string;
    /** Same line-oriented representation as `git status --short`, including its two-column XY prefix. */
    status: string;
}

function shortStatus(xy: string, submodule: string): string {
    const index = xy[0] === "." ? " " : xy[0]!;
    let worktree = xy[1] === "." ? " " : xy[1]!;
    if (submodule.startsWith("S")) {
        // Porcelain v2 separates the submodule detail from XY. Porcelain v1 reports it in the worktree
        // column, preferring a changed commit over modified content over untracked content.
        if (submodule[1] === "C") worktree = "M";
        else if (submodule[2] === "M") worktree = "m";
        else if (submodule[3] === "U") worktree = "?";
    }
    return `${index}${worktree}`;
}

function shortPath(path: string): string {
    // V2's fixed-field grammar leaves ordinary spaces literal. V1 quotes such paths because its compact
    // grammar would otherwise be ambiguous. Other control/non-ASCII escapes arrive already C-quoted.
    return path.startsWith('"') || !path.includes(" ") ? path : `"${path}"`;
}

/** Convert one `git status --porcelain=v2 --branch` response to the previous short-status contract. */
export function parseGitSourceStatus(output: string): IGitSourceStatus {
    let commit = "unknown";
    const status: string[] = [];
    for (const line of output.split("\n")) {
        if (!line) continue;
        if (line.startsWith("# branch.oid ")) {
            const oid = line.slice("# branch.oid ".length);
            if (/^[0-9a-f]{40,64}$/.test(oid)) commit = oid;
            continue;
        }
        if (line.startsWith("# ")) continue;

        const ordinary = /^1 (\S{2}) (\S{4}) \S+ \S+ \S+ \S+ \S+ (.+)$/.exec(line);
        if (ordinary) {
            status.push(`${shortStatus(ordinary[1]!, ordinary[2]!)} ${shortPath(ordinary[3]!)}`);
            continue;
        }
        const renamed = /^2 (\S{2}) (\S{4}) \S+ \S+ \S+ \S+ \S+ \S+ (.+)\t(.+)$/.exec(line);
        if (renamed) {
            status.push(
                `${shortStatus(renamed[1]!, renamed[2]!)} ${shortPath(renamed[4]!)} -> ${shortPath(renamed[3]!)}`,
            );
            continue;
        }
        const unmerged = /^u (\S{2}) (\S{4}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/.exec(line);
        if (unmerged) {
            status.push(`${shortStatus(unmerged[1]!, unmerged[2]!)} ${shortPath(unmerged[3]!)}`);
            continue;
        }
        if (line.startsWith("? ")) {
            status.push(`?? ${shortPath(line.slice(2))}`);
            continue;
        }
        if (line.startsWith("! ")) {
            status.push(`!! ${shortPath(line.slice(2))}`);
            continue;
        }
        throw new Error(`Unsupported git status porcelain-v2 record: ${line}`);
    }
    return { commit, status: status.join("\n").trim() };
}

// Hung-git protection, learned from a CI flake: a host git config with core.fsmonitor enabled makes
// `git status` spawn the fsmonitor daemon, which inherits our stdout pipe — execFileSync then waits
// forever for EOF (the test runner reported it as a 30s timeout plus a "dangling process"). Disable
// the daemon and optional locks per call, never allow a terminal prompt, and cap the wall time; every
// failure path below already degrades to "unknown and dirty".
const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false"] as const;
const GIT_SAFE_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
};

/** Capture HEAD and working-tree status in one Git process. */
export function captureGitSourceStatus(cwd: string = process.cwd()): IGitSourceStatus {
    try {
        return parseGitSourceStatus(
            execFileSync("git", [...GIT_SAFE_ARGS, "status", "--porcelain=v2", "--branch", "--no-ahead-behind"], {
                ...GIT_SAFE_OPTIONS,
                cwd,
            }),
        );
    } catch {
        // Preserve the old pair of best-effort Git calls: a missing repository/tool marks the source unknown
        // and dirty rather than allowing an evidence run to present incomplete provenance as clean.
        try {
            const commit = execFileSync("git", [...GIT_SAFE_ARGS, "rev-parse", "HEAD"], {
                ...GIT_SAFE_OPTIONS,
                cwd,
            }).trim();
            return { commit, status: "unknown" };
        } catch {
            return { commit: "unknown", status: "unknown" };
        }
    }
}
