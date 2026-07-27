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

import { getCraftChances } from "../../src/abilities/craft_chances";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

// Craft's card carries FOUR computed odds, not one power. config_provider prints ability cards by
// substituting the ability's single `power` into every {}, and Blacksmith Tools is configured power 0 — so
// the card read "0%" four times and claimed the spell does nothing at all. It is the config layer that has
// to be right: this is the description a player reads before the fight starts and the one a ranked snapshot
// ships, long before any Unit exists to re-render it.
describe("Blacksmith Tools card", () => {
    it("prints the four Craft odds rather than the ability's power-0 default", () => {
        const blacksmith = getCreatureConfig(PBTypes.TeamVals.LOWER, "Life", "Blacksmith", "blacksmith_512", 50, 0);
        const index = blacksmith.abilities.indexOf("Blacksmith Tools");
        expect(index).toBeGreaterThanOrEqual(0);

        const card = blacksmith.abilities_descriptions[index];
        // The exact old rendering, with every placeholder collapsed to the ability's power of 0.
        expect(card).not.toContain("Double Attack 0%, Frozen weapon 0%, Stun 0%, nothing 0%");
        expect(card).not.toContain("{}");

        // The template is built before any unit exists, so luck is unknown and the card starts at the
        // luck-0 split. Each placeholder takes ITS OWN odd, in the order the sentence names them:
        // "Double Attack {}%, Frozen weapon {}%, Stun {}%, nothing {}%."
        const { stun, nothing, double, frozen } = getCraftChances(0);
        expect(card).toContain(
            `Double Attack ${double}%, Frozen weapon ${frozen}%, Stun ${stun}%, nothing ${nothing}%`,
        );
        // Pinned outright too, so a change to the odds has to be a deliberate edit here.
        expect(card).toContain("Double Attack 40%, Frozen weapon 10%, Stun 10%, nothing 40%");
        expect(stun + nothing + double + frozen).toBe(100);
    });
});
