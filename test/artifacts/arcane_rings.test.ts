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

import {
    ARTIFACT_POWER,
    ArtifactTier,
    formatArtifactDescription,
    getArtifactProperties,
    TIER1_ARTIFACT_LIST,
    TIER2_ARTIFACT_LIST,
    Tier1Artifact,
    Tier2Artifact,
    ToTier1Artifact,
    ToTier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { EmpowerAugment, getEmpowerPower } from "../../src/augments/augment_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { LIVE_TIER1_ARTIFACT_COUNT, LIVE_TIER2_ARTIFACT_COUNT } from "../../src/picks/pick_sim";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const MAGE = ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT;
const ARCHMAGE = ARTIFACT_POWER.ARCHMAGES_RING_MAGIC_PERCENT;

/**
 * The arcane rings are the first artifacts to raise MAGIC damage, and they carry no stat of their own — all
 * they do is feed Unit.getMagicDamageBonusPercentage(), the single place the engine's casts, the AI's damage
 * estimates and the sidebar card all read. So these tests go through that one number rather than poking at
 * base stats: if it is right, every consumer downstream is right by construction.
 */
const armRings = (options: { tier1?: Tier1Artifact; tier2?: Tier2Artifact; empower?: EmpowerAugment } = {}) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    if (options.tier1 !== undefined) {
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, options.tier1);
    }
    if (options.tier2 !== undefined) {
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, options.tier2);
    }
    if (options.empower !== undefined) {
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, { type: "Empower", value: options.empower });
    }

    const ally = createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.LEFT });
    const enemy = createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.RIGHT });
    placeUnit(grid, unitsHolder, ally, { x: 2, y: 2 });
    placeUnit(grid, unitsHolder, enemy, { x: 4, y: 4 });

    unitsHolder.applyArtifacts(fightProperties);
    unitsHolder.applyAugments(fightProperties);
    unitsHolder.refreshStackPowerForAllUnits();
    return { ally, enemy, fightProperties, unitsHolder };
};

describe("Arcane rings", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("gives the army the Tier-1 ring's magic damage and nothing else", () => {
        const { ally } = armRings({ tier1: Tier1Artifact.MAGES_RING });

        expect(ally.getMagicDamageBonusPercentage()).toBe(MAGE);
        expect(ally.getBuff("Mages Ring")).toBeDefined();
    });

    it("gives the army the Tier-2 ring's magic damage", () => {
        const { ally } = armRings({ tier2: Tier2Artifact.ARCHMAGES_RING });

        expect(ally.getMagicDamageBonusPercentage()).toBe(ARCHMAGE);
        expect(ally.getBuff("Archmages Ring")).toBeDefined();
    });

    // A team holds one artifact per tier, so both rings at once is a legal draft — and the whole point of
    // assembling the bonus in one place is that two sources read as a plain sum, not a product.
    it("adds the two rings together rather than compounding them", () => {
        const { ally } = armRings({
            tier1: Tier1Artifact.MAGES_RING,
            tier2: Tier2Artifact.ARCHMAGES_RING,
        });

        expect(ally.getMagicDamageBonusPercentage()).toBe(MAGE + ARCHMAGE);
    });

    it("stacks additively with the Empower augment", () => {
        const { ally } = armRings({
            tier1: Tier1Artifact.MAGES_RING,
            tier2: Tier2Artifact.ARCHMAGES_RING,
            empower: EmpowerAugment.LEVEL_2,
        });

        expect(ally.getMagicDamageBonusPercentage()).toBe(MAGE + ARCHMAGE + getEmpowerPower(EmpowerAugment.LEVEL_2));
    });

    it("arms only the team that drafted it", () => {
        const { enemy } = armRings({
            tier1: Tier1Artifact.MAGES_RING,
            tier2: Tier2Artifact.ARCHMAGES_RING,
        });

        expect(enemy.getMagicDamageBonusPercentage()).toBe(0);
        expect(enemy.getBuff("Mages Ring")).toBeUndefined();
        expect(enemy.getBuff("Archmages Ring")).toBeUndefined();
    });

    // Every ranked snapshot recomputes the artifacts, so a second pass must not stack a second ring — the
    // same trap Cursed Ward's morale and the Winged Boots' armour both fell into.
    it("applies once however many times the artifacts are recomputed", () => {
        const { ally, fightProperties, unitsHolder } = armRings({
            tier1: Tier1Artifact.MAGES_RING,
            tier2: Tier2Artifact.ARCHMAGES_RING,
        });

        const seen: number[] = [];
        for (let i = 0; i < 4; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
            seen.push(ally.getMagicDamageBonusPercentage());
        }

        expect(seen).toEqual(new Array(4).fill(MAGE + ARCHMAGE));
        expect(ally.getUnitProperties().applied_buffs.filter((n) => n === "Mages Ring")).toHaveLength(1);
        expect(ally.getUnitProperties().applied_buffs.filter((n) => n === "Archmages Ring")).toHaveLength(1);
    });

    it("drops off when the pick is cleared", () => {
        const { ally, fightProperties, unitsHolder } = armRings({
            tier1: Tier1Artifact.MAGES_RING,
            tier2: Tier2Artifact.ARCHMAGES_RING,
        });
        expect(ally.getMagicDamageBonusPercentage()).toBe(MAGE + ARCHMAGE);

        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, Tier1Artifact.NO_ARTIFACT);
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.NO_ARTIFACT);
        unitsHolder.applyArtifacts(fightProperties);
        unitsHolder.refreshStackPowerForAllUnits();

        expect(ally.getMagicDamageBonusPercentage()).toBe(0);
    });

    it("states the real percentage on both cards", () => {
        const tier1 = formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_1, Tier1Artifact.MAGES_RING));
        const tier2 = formatArtifactDescription(
            getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.ARCHMAGES_RING),
        );

        expect(tier1).toContain(`${MAGE}%`);
        expect(tier2).toContain(`${ARCHMAGE}%`);
        for (const description of [tier1, tier2]) {
            expect(description).not.toContain("{}");
            expect(description).not.toContain("[]");
        }
    });
});

describe("Arcane rings — draft pool", () => {
    it("is offered by the live pick, both tiers", () => {
        expect(LIVE_TIER1_ARTIFACT_COUNT).toBe(Tier1Artifact.MAGES_RING);
        expect(LIVE_TIER2_ARTIFACT_COUNT).toBe(Tier2Artifact.ARCHMAGES_RING);
    });

    it("shows up in the selection lists the pick UI builds", () => {
        expect(TIER1_ARTIFACT_LIST.map((a) => a.slug)).toContain("mages_ring");
        expect(TIER2_ARTIFACT_LIST.map((a) => a.slug)).toContain("archmages_ring");
    });

    // Wire ids arrive as strings from the pick document, so the string converters must know the new ids or a
    // legitimately drafted ring would silently decode to NO_ARTIFACT.
    it("decodes from its wire id", () => {
        expect(ToTier1Artifact["13"]).toBe(Tier1Artifact.MAGES_RING);
        expect(ToTier2Artifact["13"]).toBe(Tier2Artifact.ARCHMAGES_RING);
    });

    it("carries an image key and a buff name like every other artifact", () => {
        const tier1 = getArtifactProperties(ArtifactTier.TIER_1, Tier1Artifact.MAGES_RING);
        const tier2 = getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.ARCHMAGES_RING);

        expect(tier1.imageKey).toBe("artifact_t1_mages_ring_256");
        expect(tier2.imageKey).toBe("artifact_t2_archmages_ring_256");
        expect(tier1.buffName).toBe("Mages Ring");
        expect(tier2.buffName).toBe("Archmages Ring");
    });
});
