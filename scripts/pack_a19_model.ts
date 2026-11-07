import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, expectedSha256] = Bun.argv.slice(2);
if (!input || !output || !/^[0-9a-f]{64}$/.test(expectedSha256 ?? ""))
    throw new Error("Usage: bun scripts/pack_a19_model.ts <export.json> <packed.json> <export-sha256>");
const bytes = readFileSync(input);
if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
    throw new Error("Original model export hash differs");
const { weights, ...metadata } = JSON.parse(bytes.toString("utf8"));
const packed: Record<string, { shape: number[]; data: string }> = {};
const weightHash = createHash("sha256");
for (const name of Object.keys(weights).sort()) {
    const value = weights[name] as number[] | number[][];
    const matrix = Array.isArray(value[0]);
    const shape = matrix ? [value.length, (value[0] as number[]).length] : [value.length];
    const flat = value.flat();
    if (
        flat.length !== shape.reduce((a, b) => a * b, 1) ||
        flat.some((x) => !Number.isFinite(x) || Math.fround(x) !== x)
    )
        throw new Error("Packing must preserve every original float32 weight exactly");
    const buffer = Buffer.alloc(flat.length * 4);
    flat.forEach((x, i) => buffer.writeFloatLE(x, i * 4));
    weightHash.update(name).update(buffer);
    packed[name] = { shape, data: buffer.toString("base64") };
}
writeFileSync(
    output,
    JSON.stringify(
        {
            schema: "hoc.ai.a19.packed-float32.v1",
            exportSha256: expectedSha256,
            weightsSha256: weightHash.digest("hex"),
            metadata,
            weights: packed,
        },
        null,
        4,
    ) + "\n",
    { flag: "wx" },
);
