import { afterEach, describe, expect, it } from "bun:test";

import { ArtifactTier, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { projectAttackDamageBand } from "../../src/damage/damage_projection";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { Spell } from "../../src/spells/spell";
import { BattleRollbackJournal } from "../../src/simulation/battle_snapshot";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

const { LEFT, RIGHT } = PBTypes.TeamVals;
const { RANGE, MELEE, MELEE_MAGIC } = PBTypes.AttackVals;

function fixture(team = LEFT) {
    const context = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.WARLORDS_EDGE);
    const ranged = createTestUnit({
        team,
        attack: 10,
        attackType: RANGE,
        rangeShots: 4,
        damageMin: 100,
        damageMax: 100,
    });
    const melee = createTestUnit({ team, attack: 10 });
    const meleeMagic = createTestUnit({ team, attack: 10, attackType: MELEE_MAGIC });
    const opponent = createTestUnit({ team: team === LEFT ? RIGHT : LEFT, attack: 10 });
    for (const [index, unit] of [ranged, melee, meleeMagic, opponent].entries()) {
        placeUnit(context.grid, context.unitsHolder, unit, { x: index + 2, y: 2 });
        unit.refreshPossibleAttackTypes(true);
    }
    context.unitsHolder.applyArtifacts(fp);
    context.unitsHolder.refreshStackPowerForAllUnits();
    return { ...context, fp, ranged, melee, meleeMagic, opponent };
}

describe("Warlord's Edge", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    for (const team of [LEFT, RIGHT]) {
        it(`gives team ${team} +16% ranged and +12% melee attack without changing base attack or the opponent`, () => {
            const { ranged, melee, meleeMagic, opponent } = fixture(team);
            expect(ranged.getAttack()).toBe(11.6);
            expect(melee.getAttack()).toBe(11.2);
            expect(meleeMagic.getAttack()).toBe(11.2);
            expect(opponent.getAttack()).toBe(10);
            for (const unit of [ranged, melee, meleeMagic, opponent]) {
                expect(unit.getBaseAttack()).toBe(10);
            }
        });
    }

    it("switches a shooter to the melee percentage and back without stacking or reapplying its buff", () => {
        const { ranged, unitsHolder, fp } = fixture();
        for (let i = 0; i < 3; i += 1) {
            expect(ranged.selectAttackType(MELEE)).toBe(true);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ranged.getAttackTypeSelection()).toBe(MELEE);
            expect(ranged.getAttack()).toBe(11.2);
            expect(ranged.selectAttackType(RANGE)).toBe(true);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ranged.getAttack()).toBe(11.6);
            unitsHolder.applyArtifacts(fp);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ranged.getAttack()).toBe(11.6);
        }
        expect(ranged.getUnitProperties().applied_buffs.filter((name) => name === "Warlords Edge")).toHaveLength(1);
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_2, Tier2Artifact.NO_ARTIFACT);
        unitsHolder.applyArtifacts(fp);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ranged.getAttack()).toBe(10);
    });

    it("covers allies summoned after the artifact was first applied", () => {
        const { grid, unitsHolder, fp } = fixture();
        const summoned = createTestUnit({ team: LEFT, attack: 10, attackType: RANGE, rangeShots: 4, summoned: true });
        placeUnit(grid, unitsHolder, summoned, { x: 7, y: 2 });
        summoned.refreshPossibleAttackTypes(true);
        unitsHolder.applyArtifacts(fp);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(summoned.getAttack()).toBe(11.6);
    });

    it("uses 12% for melee retaliation and its preview while the shooter still has RANGE selected", () => {
        const { ranged, opponent } = fixture();
        for (const [attackType, expected] of [
            [RANGE, 116],
            [MELEE, 56],
        ] as const) {
            expect(ranged.calculateAttackDamage(opponent, attackType, 0, 1, 1, false)).toBe(expected);
            expect(
                projectAttackDamageBand({
                    attacker: ranged,
                    target: opponent,
                    attackType,
                    synergyAbilityPowerIncrease: 0,
                }),
            ).toEqual({ min: expected, max: expected });
        }
        expect(ranged.getAttackTypeSelection()).toBe(RANGE);
    });

    it("restores both damage percentages after an AI rollout switches attack mode", () => {
        const { ranged, opponent, unitsHolder, grid, fp } = fixture();
        const checkpoint = new BattleRollbackJournal(unitsHolder, grid, fp).checkpoint();
        ranged.selectAttackType(MELEE);
        unitsHolder.refreshStackPowerForAllUnits();
        checkpoint.rollback();
        expect(ranged.getAttackTypeSelection()).toBe(RANGE);
        expect(ranged.calculateAttackDamage(opponent, RANGE, 0, 1, 1, false)).toBe(116);
        expect(ranged.calculateAttackDamage(opponent, MELEE, 0, 1, 1, false)).toBe(56);
    });

    it("deals the melee percentage in a real shooter's retaliation", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setArtifactPerTeam(RIGHT, ArtifactTier.TIER_2, Tier2Artifact.WARLORDS_EDGE);
        const attacker = createTestUnit({ team: LEFT, maxHp: 1000 });
        const defender = createTestUnit({
            team: RIGHT,
            attack: 10,
            attackType: RANGE,
            rangeShots: 4,
            damageMin: 100,
            damageMax: 100,
            maxHp: 1000,
        });
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, defender, { x: 2, y: 1 });
        defender.refreshPossibleAttackTypes(true);
        unitsHolder.applyArtifacts(fp);
        unitsHolder.refreshStackPowerForAllUnits();
        setDeterministicRandomSource(() => 0);

        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            new MoveHandler(grid.getSettings(), grid, unitsHolder),
            createVisibleDamage(defender),
            undefined,
            attacker,
            defender,
            { x: 1, y: 1 },
        );

        expect(result.completed).toBe(true);
        expect(defender.getAttackTypeSelection()).toBe(RANGE);
        expect(attacker.getCumulativeHp()).toBe(944);
    });

    it("adds each percentage separately from Riot's attack bonus", () => {
        const { ranged, unitsHolder } = fixture();
        const riot = new Spell({ spellProperties: getSpellConfig("Chaos", "Riot", 15), amount: 1 });
        riot.setPower(50);
        ranged.applyBuff(riot);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ranged.getBaseAttack()).toBe(10);
        expect(ranged.getAttack()).toBe(16.6);
        ranged.selectAttackType(MELEE);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ranged.getAttack()).toBe(16.2);
    });

    it("keeps legacy single-value buffs valid in both attack modes", () => {
        const { ranged, unitsHolder } = fixture();
        ranged.deleteBuff("Warlords Edge");
        const legacy = new Spell({ spellProperties: getSpellConfig("System", "Warlords Edge", 15), amount: 1 });
        legacy.setPower(12);
        ranged.applyBuff(legacy, 12);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ranged.getAttack()).toBe(11.2);
        ranged.selectAttackType(MELEE);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ranged.getAttack()).toBe(11.2);
    });
});
