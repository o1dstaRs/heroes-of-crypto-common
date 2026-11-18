import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    aiMetaAuthoritativeSource,
    freezeAiMetaAuthoritativeSource,
} from "../../src/simulation/ai_meta_authoritative_source";

test("frozen server transport retains and seals dependency patches required by its lockfile", () => {
    const scratch = resolve(import.meta.dir, "../../tmp");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(resolve(scratch, "meta-server-patch-"));
    const source = resolve(root, "server");
    const destination = resolve(root, "frozen");
    const previous = process.env.HOC_SERVER_LOC;
    try {
        for (const directory of ["src", "configuration", "generated", "schema", "protobuf", "patches"])
            mkdirSync(resolve(source, directory), { recursive: true });
        for (const file of ["package.json", "bun.lock", "tsconfig.json", "AGENTS.md"])
            writeFileSync(resolve(source, file), "{}\n");
        const patch = "patches/example.patch";
        writeFileSync(resolve(source, patch), "original dependency patch\n");
        process.env.HOC_SERVER_LOC = source;
        const origin = freezeAiMetaAuthoritativeSource(destination);
        expect(readFileSync(resolve(destination, patch), "utf8")).toBe("original dependency patch\n");
        process.env.HOC_SERVER_LOC = destination;
        expect(aiMetaAuthoritativeSource().serverSha256).toBe(origin.serverSha256);
        writeFileSync(resolve(destination, patch), "changed dependency patch\n");
        expect(() => aiMetaAuthoritativeSource()).toThrow("differs from its receipt");
    } finally {
        if (previous === undefined) delete process.env.HOC_SERVER_LOC;
        else process.env.HOC_SERVER_LOC = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
