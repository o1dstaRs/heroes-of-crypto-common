import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { ArtifactTier, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const BUFF = "Farsight Quiver";

describe(BUFF, () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        it(`only gives allied shooters the buff and sidebar entry (team ${team})`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const fight = FightStateManager.getInstance().getFightProperties();
            const effects = new EffectFactory();
            const manticore = Unit.createUnit(
                getCreatureConfig(team, "Chaos", "Manticore", "manticore_512", 1),
                grid.getSettings(),
                team,
                PBTypes.UnitVals.CREATURE,
                new AbilityFactory(effects),
                effects,
                false,
            );
            const nonShooters = [
                manticore,
                createTestUnit({ team, attackType: PBTypes.AttackVals.MELEE }),
                createTestUnit({ team, attackType: PBTypes.AttackVals.MELEE_MAGIC }),
                createTestUnit({ team, attackType: PBTypes.AttackVals.MAGIC }),
            ];
            const archer = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 5 });
            const enemy = createTestUnit({
                team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 5,
            });
            [...nonShooters, archer, enemy].forEach((unit, i) =>
                placeUnit(grid, unitsHolder, unit, { x: 2 + i * 2, y: 2 }),
            );
            fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.FARSIGHT_QUIVER);
            for (let pass = 0; pass < 2; pass++) {
                unitsHolder.applyArtifacts(fight);
                expect(archer.hasBuffActive(BUFF)).toBe(true);
                expect(archer.getUnitProperties().applied_buffs.filter((name) => name === BUFF)).toHaveLength(1);
                for (const unit of [...nonShooters, enemy]) {
                    expect(unit.hasBuffActive(BUFF)).toBe(false);
                    expect(unit.getUnitProperties().applied_buffs).not.toContain(BUFF);
                }
            }
        });
    }

    it("keeps the artifact on archers while they fight in melee or run out of arrows", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const fight = FightStateManager.getInstance().getFightProperties();
        const archer = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 1 });
        placeUnit(grid, unitsHolder, archer, { x: 2, y: 2 });
        fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.FARSIGHT_QUIVER);
        archer.refreshPossibleAttackTypes(false);
        expect(archer.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
        unitsHolder.applyArtifacts(fight);
        expect(archer.hasBuffActive(BUFF)).toBe(true);
        archer.decreaseNumberOfShots();
        unitsHolder.applyArtifacts(fight);
        expect(archer.getRangeShots()).toBe(0);
        expect(archer.hasBuffActive(BUFF)).toBe(true);
    });

    it("clears a previously attached melee buff and removes the archer buff on deselection", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const fight = FightStateManager.getInstance().getFightProperties();
        const melee = createTestUnit({ team });
        const archer = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 5 });
        placeUnit(grid, unitsHolder, melee, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });
        melee.applyBuff(
            new Spell({ spellProperties: getSpellConfig("System", BUFF, NUMBER_OF_LAPS_TOTAL), amount: 1 }),
        );
        expect(melee.hasBuffActive(BUFF)).toBe(true);
        fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.FARSIGHT_QUIVER);
        unitsHolder.applyArtifacts(fight);
        expect(melee.hasBuffActive(BUFF)).toBe(false);
        expect(melee.getUnitProperties().applied_buffs).not.toContain(BUFF);
        expect(archer.hasBuffActive(BUFF)).toBe(true);
        fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.NO_ARTIFACT);
        unitsHolder.applyArtifacts(fight);
        expect(archer.hasBuffActive(BUFF)).toBe(false);
        expect(archer.getUnitProperties().applied_buffs).not.toContain(BUFF);
    });

    it("follows shooting gained and lost through Endless Quiver before the next stat refresh", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const fight = FightStateManager.getInstance().getFightProperties();
        const thief = createTestUnit({ name: "Arachna Queen", team, shotDistance: 0, rangeShots: 0 });
        placeUnit(grid, unitsHolder, thief, { x: 2, y: 2 });
        fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.FARSIGHT_QUIVER);
        unitsHolder.applyArtifacts(fight);
        expect(thief.hasBuffActive(BUFF)).toBe(false);

        thief.grantStolenAbility("Endless Quiver");
        unitsHolder.applyArtifacts(fight);
        thief.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(thief.getAttackType()).toBe(PBTypes.AttackVals.MELEE);
        expect(thief.isRangeCapable()).toBe(true);
        expect(thief.hasBuffActive(BUFF)).toBe(true);

        thief.disableAbilityAsStolen("Endless Quiver");
        unitsHolder.applyArtifacts(fight);
        thief.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(thief.isRangeCapable()).toBe(false);
        expect(thief.hasBuffActive(BUFF)).toBe(false);
        expect(thief.getUnitProperties().applied_buffs).not.toContain(BUFF);
    });
});
