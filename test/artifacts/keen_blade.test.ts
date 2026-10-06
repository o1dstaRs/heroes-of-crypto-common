import { beforeEach, describe, expect, it } from "bun:test";

import {
    ArtifactTier,
    formatArtifactDescription,
    getTier1ArtifactProperties,
    Tier1Artifact,
} from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

describe("Keen Blade", () => {
    beforeEach(() => FightStateManager.getInstance().reset());

    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        it(`gives team ${team} +1 ranged attack and +0.7 melee attack without helping the opponent`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.setArtifactPerTeam(team, ArtifactTier.TIER_1, Tier1Artifact.KEEN_BLADE);
            const ranged = createTestUnit({ team, attack: 10, attackType: PBTypes.AttackVals.RANGE, rangeShots: 3 });
            const melee = createTestUnit({ team, attack: 10 });
            const meleeMagic = createTestUnit({ team, attack: 10, attackType: PBTypes.AttackVals.MELEE_MAGIC });
            const opponent = createTestUnit({
                team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                attack: 10,
            });
            for (const [index, unit] of [ranged, melee, meleeMagic, opponent].entries()) {
                placeUnit(grid, unitsHolder, unit, { x: 2 + index, y: 2 });
                unit.refreshPossibleAttackTypes(true);
            }

            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();

            expect(ranged.getBaseAttack()).toBe(11);
            expect(melee.getBaseAttack()).toBe(10.7);
            expect(meleeMagic.getBaseAttack()).toBe(10.7);
            expect(opponent.getBaseAttack()).toBe(10);
            expect(ranged.getUnitProperties().applied_buffs_descriptions.join("\n")).toContain(
                "Artifact. Increases this unit's base attack by 1.",
            );
            expect(melee.getUnitProperties().applied_buffs_descriptions.join("\n")).toContain(
                "Artifact. Increases this unit's base attack by 0.7.",
            );
        });
    }

    it("keeps a ranged unit's bonus when it fights in melee and does not accumulate on refresh", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.KEEN_BLADE);
        const unit = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attack: 10,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
        unit.refreshPossibleAttackTypes(true);
        unitsHolder.applyArtifacts(fightProperties);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(unit.getBaseAttack()).toBe(11);

        for (let i = 0; i < 3; i += 1) {
            expect(unit.selectAttackType(PBTypes.AttackVals.MELEE)).toBe(true);
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(unit.getBaseAttack()).toBe(11);
            expect(unit.selectAttackType(PBTypes.AttackVals.RANGE)).toBe(true);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(unit.getBaseAttack()).toBe(11);
        }

        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.NO_ARTIFACT);
        unitsHolder.applyArtifacts(fightProperties);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(unit.getBaseAttack()).toBe(10);
        expect(unit.getBuff("Keen Blade")).toBeUndefined();
    });

    it("states both bonuses on the artifact card", () => {
        expect(formatArtifactDescription(getTier1ArtifactProperties(Tier1Artifact.KEEN_BLADE))).toBe(
            "Increases ranged units' base attack by 1 and melee units' base attack by 0.7.",
        );
    });

    it("preserves a legacy single-value buff without producing invalid melee attack", () => {
        const unit = createTestUnit({ attack: 10 });
        const buff = new Spell({ spellProperties: getSpellConfig("System", "Keen Blade", 15), amount: 1 });
        buff.setPower(0.7);
        unit.applyBuff(buff, 0.7);

        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);

        expect(unit.getBaseAttack()).toBe(10.7);
    });
});
