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

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

import { fingerprintV09 } from "./protocol";

export const V09_SOURCE_IDENTITY_SCHEMA = "hoc.ai.v0_9_source_identity.v1" as const;

interface ITrackedGitInput {
    path: string;
    mode: string;
    blob: string;
}

export interface IV09SourceIdentityReceipt {
    schema: typeof V09_SOURCE_IDENTITY_SCHEMA;
    sourceCommit: string;
    sourceTree: string;
    sourceStatusSha256: string;
    sourceDirty: false;
    rulesFingerprint: string;
    rosterFingerprint: string;
    anchorVersion: "v0.8";
    anchorFingerprint: string;
    trackedInputs: {
        rules: ITrackedGitInput[];
        roster: ITrackedGitInput[];
        anchor: ITrackedGitInput[];
    };
    receiptSha256: string;
}

const runGit = (repositoryRoot: string, args: readonly string[]): string => {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
};

function trackedInputs(repositoryRoot: string): ITrackedGitInput[] {
    return runGit(repositoryRoot, ["ls-files", "-s", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
            const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/.exec(entry);
            if (!match || match[3] !== "0") throw new Error(`unsupported staged Git entry: ${entry}`);
            return { mode: match[1]!, blob: match[2]!, path: match[4]! };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
}

const rulesInput = (path: string): boolean =>
    path.startsWith("src/") ||
    path === "package.json" ||
    path === "bun.lock" ||
    path.startsWith("tsconfig") ||
    path === "build.ts";

const rosterInput = (path: string): boolean =>
    [
        "src/abilities/",
        "src/artifacts/",
        "src/augments/",
        "src/configuration/",
        "src/factions/",
        "src/doctrines/",
        "src/spells/",
        "src/synergies/",
        "src/units/",
    ].some((prefix) => path.startsWith(prefix)) ||
    path === "src/simulation/army.ts" ||
    path === "src/simulation/ai_meta_cohorts_core.ts";

const anchorInput = (path: string): boolean =>
    (path.startsWith("src/") && !path.startsWith("src/simulation/v0_9/") && !path.startsWith("src/ai/versions/v0_9")) ||
    path === "package.json" ||
    path === "bun.lock";

const inputFingerprint = (role: "rules" | "roster" | "anchor", inputs: readonly ITrackedGitInput[]): string =>
    fingerprintV09({ schema: "hoc.ai.v0_9_tracked_inputs.v1", role, inputs });

export function computeV09SourceIdentity(repositoryRoot: string): IV09SourceIdentityReceipt {
    const root = resolve(repositoryRoot);
    const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    if (status.length) {
        throw new Error(`v0.9 source identity requires a clean HEAD:\n${status.trimEnd()}`);
    }
    const sourceCommit = runGit(root, ["rev-parse", "HEAD"]).trim().toLowerCase();
    const sourceTree = runGit(root, ["rev-parse", "HEAD^{tree}"]).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sourceCommit) || !/^[0-9a-f]{40,64}$/.test(sourceTree)) {
        throw new Error("v0.9 source identity received an invalid Git object id");
    }
    const all = trackedInputs(root);
    const rules = all.filter(({ path }) => rulesInput(path));
    const roster = all.filter(({ path }) => rosterInput(path));
    const anchor = all.filter(({ path }) => anchorInput(path));
    if (!rules.length || !roster.length || !anchor.length) {
        throw new Error("v0.9 source identity input allowlists unexpectedly resolved empty");
    }
    const unsigned = {
        schema: V09_SOURCE_IDENTITY_SCHEMA,
        sourceCommit,
        sourceTree,
        sourceStatusSha256: fingerprintV09({
            schema: "hoc.ai.v0_9_clean_source_status.v1",
            sourceCommit,
            sourceTree,
            index: all,
            status: "",
        }),
        sourceDirty: false as const,
        rulesFingerprint: inputFingerprint("rules", rules),
        rosterFingerprint: inputFingerprint("roster", roster),
        anchorVersion: "v0.8" as const,
        anchorFingerprint: inputFingerprint("anchor", anchor),
        trackedInputs: { rules, roster, anchor },
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

export function verifyV09SourceIdentity(
    receipt: IV09SourceIdentityReceipt,
    repositoryRoot: string,
): IV09SourceIdentityReceipt {
    const { receiptSha256, ...unsigned } = receipt;
    if (
        receipt.schema !== V09_SOURCE_IDENTITY_SCHEMA ||
        receipt.sourceDirty !== false ||
        fingerprintV09(unsigned) !== receiptSha256
    ) {
        throw new Error("v0.9 source identity receipt hash mismatch");
    }
    const current = computeV09SourceIdentity(repositoryRoot);
    if (fingerprintV09(current) !== fingerprintV09(receipt)) {
        throw new Error("v0.9 source identity receipt does not match the current clean HEAD");
    }
    return receipt;
}

export function writeV09SourceIdentity(path: string, receipt: IV09SourceIdentityReceipt): void {
    const { receiptSha256, ...unsigned } = receipt;
    if (fingerprintV09(unsigned) !== receiptSha256) throw new Error("refusing invalid v0.9 source identity receipt");
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

function main(): void {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            repository: { type: "string", default: process.cwd() },
            out: { type: "string" },
            verify: { type: "string" },
        },
        strict: true,
    });
    if (values.verify) {
        const receipt = JSON.parse(readFileSync(values.verify, "utf8")) as IV09SourceIdentityReceipt;
        verifyV09SourceIdentity(receipt, values.repository);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
        return;
    }
    const receipt = computeV09SourceIdentity(values.repository);
    if (values.out) writeV09SourceIdentity(resolve(values.out), receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.main) main();
