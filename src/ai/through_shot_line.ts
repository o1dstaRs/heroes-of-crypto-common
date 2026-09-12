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

import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";

/**
 * Kill-switch and seat scope for the v0.8 Through Shot LINE policy: the shot that pierces the most
 * valuable set of enemies, whether that line runs through a visible edge or through a free world point.
 *
 * Unset (production) = on for both seats. `off` disables it; `green` / `red` enable it for that seat
 * only, which is how a paired A/B isolates the policy's own effect (the `V06_AREA_THROW` seat pattern).
 * Read live rather than snapshotted so a research scope set around a match is honoured by every rollout.
 */
export const V08_THROUGH_SHOT_LINE_ENV = "V08_THROUGH_SHOT_LINE" as const;

export function throughShotLineEnabled(unit: Pick<Unit, "getTeam">): boolean {
    const gate = process.env[V08_THROUGH_SHOT_LINE_ENV];
    if (gate === "off") {
        return false;
    }
    if (gate === "green" || gate === "red") {
        return gate === (unit.getTeam() === PBTypes.TeamVals.LEFT ? "green" : "red");
    }
    return true;
}
