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

import { describe, expect, test } from "bun:test";

import {
    DEFAULT_AI_VERSION,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_PROFILE,
    V08_A13_SEARCH,
    buildV08A13SearchEnvironment,
} from "../../src";
import {
    SearchDriver,
    V08_A13_SEARCH_OVERRIDE_ENV,
    createV08A13SearchDriver,
    shouldUseDefaultV08A13Search,
    withScopedAIEnvironment,
    type ILookaheadDeps,
    type ISearchMatchInfo,
} from "../../src/simulation";

describe("v0.8+a13 public exports", () => {
    test("the browser-safe root exposes the promoted profile identity", () => {
        expect(DEFAULT_AI_VERSION).toBe(V08_A13_PRODUCTION_VERSION);
        expect(V08_A13_PROFILE.productionVersion).toBe(DEFAULT_AI_VERSION);
        expect(V08_A13_PROFILE.search).toBe(V08_A13_SEARCH);
        expect(buildV08A13SearchEnvironment()["SEARCH_VERSIONS"]).toBe(DEFAULT_AI_VERSION);
    });

    test("the Node-only simulation entrypoint exposes the supported search surface", () => {
        const match: ISearchMatchInfo = { greenVersion: DEFAULT_AI_VERSION, redVersion: "v0.7", seed: 1 };
        const depsTypecheck = (deps: ILookaheadDeps): ILookaheadDeps => deps;

        expect(typeof SearchDriver).toBe("function");
        expect(typeof createV08A13SearchDriver).toBe("function");
        expect(typeof shouldUseDefaultV08A13Search).toBe("function");
        expect(typeof withScopedAIEnvironment).toBe("function");
        expect(V08_A13_SEARCH_OVERRIDE_ENV).toBe("V08_A13_SEARCH");
        expect(match.greenVersion).toBe(DEFAULT_AI_VERSION);
        expect(typeof depsTypecheck).toBe("function");
    });
});
