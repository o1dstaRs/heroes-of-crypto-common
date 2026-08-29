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

import { describe, expect, it } from "bun:test";

import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

describe("Blacksmith balance", () => {
    it("loads Blacksmith with 10 base armor", () => {
        const blacksmith = getCreatureConfig(PBTypes.TeamVals.LEFT, "Life", "Blacksmith", "blacksmith_512", 1);

        expect(blacksmith.base_armor).toBe(10);
    });
});
