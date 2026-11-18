import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { FightStateManager } from "../fights/fight_state_manager";
import { getDeterministicRandomSource } from "../utils/lib";
import { aiMetaServerRoot } from "./ai_meta_authoritative_source";

/** Fail before any setup if native server imports would load a second, unseeded engine. */
export async function assertAuthoritativeMetaCommon(server = aiMetaServerRoot()): Promise<void> {
    const common = resolve(import.meta.dir, "../..");
    const nativePath = (file: string) => {
        const actual = Bun.resolveSync(`@heroesofcrypto/common/src/${file}`, server);
        assert.equal(
            realpathSync(actual),
            realpathSync(resolve(common, `src/${file}.ts`)),
            "Native common dependency must link to the collector's frozen common tree; see docs/ai_meta_current_collection.md",
        );
        return actual;
    };
    const [random, state] = await Promise.all([
        import(nativePath("utils/lib")),
        import(nativePath("fights/fight_state_manager")),
    ]);
    assert.equal(random.getDeterministicRandomSource, getDeterministicRandomSource, "Native RNG module mismatch");
    assert.equal(state.FightStateManager, FightStateManager, "Native fight-state module mismatch");
}
