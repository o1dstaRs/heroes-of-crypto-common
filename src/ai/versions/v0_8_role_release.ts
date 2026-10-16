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

import { assertNoLegacySeatEnv, seatEnvName } from "../seat_env";

/**
 * Research seam for paired A/Bs of v0.8's hand-written unit role routers. `V08_ROLE_RELEASE_<LEFT|RIGHT>` is a
 * comma list of roles; a listed role's router returns the incoming decision unchanged for that seat, so the
 * search keeps its own choice. Default off; unknown roles and the pre-rename seat names throw.
 */
export const V08_ROLE_RELEASE_ENV = "V08_ROLE_RELEASE";

export const V08_RELEASABLE_ROLES = ["blacksmith_craft", "healer_sustain", "wandering_mage_smoke"] as const;
export type V08ReleasableRole = (typeof V08_RELEASABLE_ROLES)[number];

export const v08RoleReleasedForTeam = (role: V08ReleasableRole, team: number): boolean => {
    assertNoLegacySeatEnv(V08_ROLE_RELEASE_ENV);
    const raw = process.env[seatEnvName(V08_ROLE_RELEASE_ENV, team)];
    if (!raw) return false;
    const released = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const unknown = released.filter((entry) => !V08_RELEASABLE_ROLES.includes(entry as V08ReleasableRole));
    if (unknown.length) {
        throw new Error(`${V08_ROLE_RELEASE_ENV} lists unknown roles: ${unknown.join(", ")}`);
    }
    return released.includes(role);
};
