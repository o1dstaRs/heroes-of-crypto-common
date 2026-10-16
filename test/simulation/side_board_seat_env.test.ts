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
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resetLegacySeatEnvChecksForTests, seatEnvName } from "../../src/ai/seat_env";
import { DISTILLED_WAIT_WEIGHTS_2026_07_10, v07WaitWeightsForTeam } from "../../src/ai/versions/wait_scorer";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

// Per-seat research overrides travel from the side-board battery to the policy code through env vars. On
// 2026-08-29 the LEFT/RIGHT team rename rewrote the battery's seat literals while every reader kept the old
// LOWER/UPPER names, so --leaf-file / --wait-file / --control-wait-file / --cancel-file wrote variables nothing
// read, and every A/B through them silently measured the baked defaults against themselves.
const SEAT_ENV = [
    "V07_WAIT_WEIGHTS_LEFT",
    "V07_WAIT_WEIGHTS_RIGHT",
    "V07_WAIT_WEIGHTS_LOWER",
    "V07_WAIT_WEIGHTS_UPPER",
] as const;

afterEach(() => {
    for (const key of SEAT_ENV) delete process.env[key];
    resetLegacySeatEnvChecksForTests();
});

describe("per-seat research env namespace", () => {
    test("seat names follow the LEFT/RIGHT team system", () => {
        expect(seatEnvName("V07_WAIT_WEIGHTS", PBTypes.TeamVals.LEFT)).toBe("V07_WAIT_WEIGHTS_LEFT");
        expect(seatEnvName("V07_WAIT_WEIGHTS", PBTypes.TeamVals.RIGHT)).toBe("V07_WAIT_WEIGHTS_RIGHT");
    });

    test("the wait scorer reads a seat override from its LEFT/RIGHT name", () => {
        process.env.V07_WAIT_WEIGHTS_LEFT = JSON.stringify(DISTILLED_WAIT_WEIGHTS_2026_07_10);

        expect(v07WaitWeightsForTeam(PBTypes.TeamVals.LEFT)?.w).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10.w);
        expect(v07WaitWeightsForTeam(PBTypes.TeamVals.RIGHT)).toBeUndefined();
    });

    test("a pre-rename LOWER/UPPER override fails loudly on every call instead of reaching no seat", () => {
        process.env.V07_WAIT_WEIGHTS_LOWER = JSON.stringify(DISTILLED_WAIT_WEIGHTS_2026_07_10);

        expect(() => v07WaitWeightsForTeam(PBTypes.TeamVals.LEFT)).toThrow("set V07_WAIT_WEIGHTS_LEFT instead");
        expect(() => v07WaitWeightsForTeam(PBTypes.TeamVals.RIGHT)).toThrow("set V07_WAIT_WEIGHTS_LEFT instead");
    });

    test("the writer and both readers build seat names through the shared helper", () => {
        for (const file of [
            "../../src/simulation/side_board_ab_battery.ts",
            "../../src/ai/versions/wait_scorer.ts",
            "../../src/simulation/search_driver.ts",
        ]) {
            const source = readFileSync(join(import.meta.dir, file), "utf8");
            expect({ file, usesHelper: source.includes("seatEnvName(") }).toEqual({ file, usesHelper: true });
            expect({
                file,
                handWrittenSeatLiteral:
                    /(V07_WAIT_WEIGHTS|V07_VALUE_WEIGHTS_V2|V08_WAIT_CANCEL)_(LOWER|UPPER|LEFT|RIGHT)\b/.test(source),
            }).toEqual({ file, handWrittenSeatLiteral: false });
        }
    });
});
