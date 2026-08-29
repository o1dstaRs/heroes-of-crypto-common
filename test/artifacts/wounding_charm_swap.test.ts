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

import { beforeEach, describe, expect, it } from "bun:test";

import { ArtifactTier, Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const DEEP_WOUNDS_1 = "Deep Wounds Level 1";

/** Equip a Tier 1 artifact for LEFT and run the recompute the sandbox runs on every pick. */
const equipTier1 = (context: ReturnType<typeof createCombatTestContext>, artifact: Tier1Artifact) => {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, artifact);
    context.unitsHolder.applyArtifacts(fightProperties);
    context.unitsHolder.refreshStackPowerForAllUnits();
};

describe("Wounding Charm — the lent ability comes off with the artifact", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("grants Deep Wounds while equipped and takes it back on a same-tier swap", () => {
        const context = createCombatTestContext();
        const unit = createTestUnit({ name: "Plain", team: LEFT });
        placeUnit(context.grid, context.unitsHolder, unit, { x: 2, y: 2 });

        expect(unit.hasAbilityActive(DEEP_WOUNDS_1)).toBe(false);

        equipTier1(context, Tier1Artifact.WOUNDING_CHARM);
        expect(unit.hasAbilityActive(DEEP_WOUNDS_1)).toBe(true);

        // The reported bug: picking another Tier 1 left the army permanently inflicting Deep Wounds
        // while the sidebar showed a different artifact's benefit.
        equipTier1(context, Tier1Artifact.KEEN_BLADE);
        expect(unit.hasAbilityActive(DEEP_WOUNDS_1)).toBe(false);
    });

    it("takes it back when the slot is cleared outright", () => {
        const context = createCombatTestContext();
        const unit = createTestUnit({ name: "Plain", team: LEFT });
        placeUnit(context.grid, context.unitsHolder, unit, { x: 2, y: 2 });

        equipTier1(context, Tier1Artifact.WOUNDING_CHARM);
        expect(unit.hasAbilityActive(DEEP_WOUNDS_1)).toBe(true);

        equipTier1(context, Tier1Artifact.NO_ARTIFACT);
        expect(unit.hasAbilityActive(DEEP_WOUNDS_1)).toBe(false);
    });

    // The reason the revoke is tracked per-grant rather than "delete Deep Wounds Level 1 from everyone":
    // the Wolf owns that card natively, and a blind cleanup would confiscate it.
    it("never confiscates a card the creature owns natively", () => {
        const context = createCombatTestContext();
        const native = createTestUnit({ name: "Wolfish", team: LEFT, abilities: [DEEP_WOUNDS_1] });
        placeUnit(context.grid, context.unitsHolder, native, { x: 2, y: 2 });

        expect(native.hasAbilityActive(DEEP_WOUNDS_1)).toBe(true);

        equipTier1(context, Tier1Artifact.WOUNDING_CHARM);
        expect(native.hasAbilityActive(DEEP_WOUNDS_1)).toBe(true);

        equipTier1(context, Tier1Artifact.KEEN_BLADE);
        expect(native.hasAbilityActive(DEEP_WOUNDS_1)).toBe(true);
    });

    it("survives repeated recomputes without stacking duplicates", () => {
        const context = createCombatTestContext();
        const unit = createTestUnit({ name: "Plain", team: LEFT });
        placeUnit(context.grid, context.unitsHolder, unit, { x: 2, y: 2 });

        for (let i = 0; i < 4; i += 1) {
            equipTier1(context, Tier1Artifact.WOUNDING_CHARM);
        }
        const cards = unit.getUnitProperties().abilities.filter((name) => name === DEEP_WOUNDS_1);
        expect(cards).toEqual([DEEP_WOUNDS_1]);

        equipTier1(context, Tier1Artifact.KEEN_BLADE);
        expect(unit.getUnitProperties().abilities.includes(DEEP_WOUNDS_1)).toBe(false);
    });
});
