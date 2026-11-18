import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const common = resolve(import.meta.dir, "../..");
const script = `
    import assert from "node:assert/strict";
    import { assertAuthoritativeMetaCommon } from "./src/simulation/ai_meta_authoritative_resolution";
    import * as local from "./src/utils/lib";
    import { FightStateManager } from "./src/fights/fight_state_manager";
    const server = process.argv[1];
    await assertAuthoritativeMetaCommon(server);
    const native = await import(Bun.resolveSync("@heroesofcrypto/common/src/utils/lib", server));
    const state = await import(Bun.resolveSync("@heroesofcrypto/common/src/fights/fight_state_manager", server));
    const source = () => .25;
    local.setDeterministicRandomSource(source);
    assert.equal(native.getDeterministicRandomSource(), source);
    const first = native.createSecureUuid();
    const second = local.createSecureUuid();
    assert.notEqual(first, second);
    assert.equal(local.captureDeterministicRandomState().uuidSequence, 2);
    native.setDeterministicRandomSource(undefined);
    native.setDeterministicRandomSource(source);
    assert.equal(local.createSecureUuid(), first);
    assert.equal(native.createSecureUuid(), second);
    assert.equal(state.FightStateManager.getInstance(), FightStateManager.getInstance());
    native.setDeterministicRandomSource(undefined);
    assert.equal(local.getDeterministicRandomSource(), undefined);
`;

for (const linked of [true, false])
    test(`native server ${linked ? "shares seeded RNG, UUID and fight state" : "rejects a separate installed engine before setup"}`, () => {
        mkdirSync(resolve(common, "tmp"), { recursive: true });
        const root = mkdtempSync(resolve(common, "tmp/meta-native-resolution-"));
        const modules = resolve(root, "node_modules/@heroesofcrypto");
        mkdirSync(modules, { recursive: true });
        try {
            if (linked) symlinkSync(common, resolve(modules, "common"), "dir");
            else {
                mkdirSync(resolve(modules, "common/src/utils"), { recursive: true });
                writeFileSync(resolve(modules, "common/package.json"), '{"name":"@heroesofcrypto/common"}');
                writeFileSync(resolve(modules, "common/src/utils/lib.ts"), "export const separateEngine = true;\n");
            }
            const result = Bun.spawnSync([process.execPath, "--eval", script, root], {
                cwd: common,
                stdout: "pipe",
                stderr: "pipe",
            });
            if (linked)
                expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: "" });
            else {
                expect(result.exitCode).not.toBe(0);
                expect(result.stderr.toString()).toContain("Native common dependency must link");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
