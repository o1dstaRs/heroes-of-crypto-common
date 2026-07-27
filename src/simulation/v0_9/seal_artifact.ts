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

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    serializeV09ModelHashPayload,
    validateV09ModelArtifact,
    type IV09ModelArtifact,
} from "../../ai/versions/v0_9_model";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Seal an exporter result using the exact JavaScript JSON serialization hashed by production. This avoids
 * Python-vs-ECMAScript floating-point JSON spelling differences. Sealing never promotes or installs a model.
 */
export function sealV09ResearchArtifact(value: unknown): IV09ModelArtifact {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("v0.9 exporter result must be an object");
    }
    const raw = value as IV09ModelArtifact;
    if (raw.schema !== "hoc.ai.v0_9_model.v1" || raw.status !== "trained") {
        throw new Error("v0.9 sealer accepts only trained v1 research artifacts");
    }
    if (raw.promoted !== false) throw new Error("v0.9 training output must remain promoted=false");
    if (raw.qualification !== null) throw new Error("v0.9 research output must carry qualification=null");
    if (raw.modelSha256 !== null) throw new Error("v0.9 training output must arrive unsealed with modelSha256=null");

    const provisional: IV09ModelArtifact = {
        ...raw,
        modelId: "v0.9-research-unsealed",
        modelSha256: "0".repeat(64),
    };
    const structuralErrors = validateV09ModelArtifact(provisional);
    if (structuralErrors.length) {
        throw new Error(`v0.9 research artifact is structurally invalid: ${structuralErrors.join("; ")}`);
    }
    const modelSha256 = sha256(serializeV09ModelHashPayload(provisional));
    const sealed: IV09ModelArtifact = {
        ...provisional,
        modelId: `v0.9-research-${modelSha256.slice(0, 12)}`,
        modelSha256,
    };
    const errors = validateV09ModelArtifact(sealed);
    if (errors.length) throw new Error(`sealed v0.9 research artifact is invalid: ${errors.join("; ")}`);
    if (sha256(serializeV09ModelHashPayload(sealed)) !== sealed.modelSha256) {
        throw new Error("sealed v0.9 model hash did not round-trip");
    }
    return sealed;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

function main(): void {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            input: { type: "string" },
            output: { type: "string" },
        },
        strict: true,
    });
    if (!values.input || !values.output) {
        throw new Error("usage: bun seal_artifact.ts --input <unsealed.json> --output <research.json>");
    }
    const input = resolve(values.input);
    const output = resolve(values.output);
    if (input === output) throw new Error("v0.9 sealer input and output must differ");
    if (extname(output).toLowerCase() !== ".json") {
        throw new Error("v0.9 sealer writes a research JSON artifact, never a committed TypeScript runtime artifact");
    }
    const artifact = sealV09ResearchArtifact(JSON.parse(readFileSync(input, "utf8")));
    atomicJson(output, artifact);
    process.stdout.write(`${JSON.stringify({ output, modelSha256: artifact.modelSha256 })}\n`);
}

if (import.meta.main) main();
