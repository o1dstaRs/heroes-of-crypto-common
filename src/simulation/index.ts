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

/**
 * Node-only public entrypoint for rollout-search consumers.
 *
 * SearchDriver writes optional audit/dataset output through `node:fs`, so this
 * module deliberately is not re-exported from the browser-safe package root.
 * Server and headless consumers should import from
 * `@heroesofcrypto/common/src/simulation` instead of implementation files.
 */
export type { ILookaheadDeps } from "./lookahead";
export { SearchDriver } from "./search_driver";
export type { ISearchMatchInfo } from "./search_driver";
export {
    createV08A13SearchDriver,
    shouldUseDefaultV08A13Search,
    V08_A13_SEARCH_OVERRIDE_ENV,
    withScopedAIEnvironment,
} from "./v0_8_a13_search";
