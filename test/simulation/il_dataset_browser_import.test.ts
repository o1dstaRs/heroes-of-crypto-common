import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("browser search can import IL action helpers without invoking Node crypto", async () => {
    const result = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../../src/simulation/il_dataset.ts", import.meta.url))],
        target: "browser",
        write: false,
        plugins: [
            {
                name: "browser-crypto-unavailable",
                setup(build) {
                    build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "crypto", namespace: "browser" }));
                    build.onLoad({ filter: /.*/, namespace: "browser" }, () => ({
                        contents: 'export function createHash() { throw new Error("offline hashing must stay lazy"); }',
                        loader: "js",
                    }));
                },
            },
        ],
    });
    expect(result.success).toBe(true);
    const source = await result.outputs[0].text();
    const dataset = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    expect(dataset.ilActionSignature([])).toBe("");
    expect(Object.keys(dataset.IL_FEATURE_FINGERPRINTS)).toEqual(["wf", "vf", "cf", "af", "schema"]);
    expect(() => dataset.IL_FEATURE_FINGERPRINTS.wf).toThrow("offline hashing must stay lazy");
});
