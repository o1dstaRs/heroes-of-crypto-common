import { expect, it } from "bun:test";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGzip, gunzipSync } from "node:zlib";
import { preserveAiMetaRawCapture } from "../../src/simulation/measure_ai_meta_cohorts";

it("finishes every completed raw record before propagating a worker failure", async () => {
    const folder = mkdtempSync(join(tmpdir(), "hoc-meta-failed-capture-"));
    try {
        const path = join(folder, "pairs.jsonl.gz");
        const output = createWriteStream(path);
        const gzip = createGzip();
        gzip.pipe(output);
        const failure = new Error("the next worker case failed");
        const lines = [
            { pair: 0, completed: true },
            { pair: 1, completed: true },
        ].map((x) => JSON.stringify(x) + "\n");
        await expect(
            preserveAiMetaRawCapture(gzip, output, async () => {
                for (const line of lines) gzip.write(line);
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(gunzipSync(readFileSync(path)).toString()).toBe(lines.join(""));
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
