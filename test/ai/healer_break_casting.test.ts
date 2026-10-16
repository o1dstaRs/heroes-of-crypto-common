import { describe, expect, test } from "bun:test";

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function massHealFixture(team: PBTypes.TeamVals, broken: boolean) {
    const combat = createCombatTestContext();
    const healer = createTestUnit({
        team,
        name: "Healer",
        amountAlive: 40,
        stackPower: 5,
        attackType: PBTypes.AttackVals.MAGIC,
        spells: ["Life:Heal", "Life:Mass Heal", "Life:Spiritual Armor", "Life:Blessing"],
    });
    placeUnit(combat.grid, combat.unitsHolder, healer, { x: 2, y: 3 });
    for (const [name, y] of [
        ["Abomination", 5],
        ["Frenzied Boar", 7],
    ] as const) {
        const ally = createTestUnit({
            team,
            name,
            amountAlive: 1,
            maxHp: 500,
            level: PBTypes.UnitLevelVals.FOURTH,
        });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 2, y });
        ally.applyDamage(400, 0, new SceneLogMock());
    }
    const enemy = createTestUnit({
        team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
        amountAlive: 100,
        maxHp: 100,
    });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 8 });
    if (broken) healer.applyEffect(new EffectFactory().makeEffect("Break"));
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
    return { healer, context };
}

describe("Healer mass healing obeys the caster's Break effect", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        test(`team ${team}: the unbroken inherited policy can Mass Heal two critical allies`, () => {
            const { healer, context } = massHealFixture(team, false);
            expect(getAIStrategy("v0.4").decideTurn(healer, context)).toContainEqual({
                type: "cast_spell",
                casterId: healer.getId(),
                spellName: "Mass Heal",
            });
        });
        for (const version of ["v0.2", "v0.3", "v0.4", "v0.5", "v0.6", "v0.6s", "v0.8"]) {
            test(`team ${team}: ${version} never casts through Break with two critical allies`, () => {
                const { healer, context } = massHealFixture(team, true);
                expect(healer.hasEffectActive("Break")).toBe(true);
                const decision = getAIStrategy(version).decideTurn(healer, context);
                expect(decision.length).toBeGreaterThan(0);
                expect(decision.some((action) => action.type === "cast_spell")).toBe(false);
            });
        }
    }
});

describe("Shared native spell eligibility covers summons and mass openers", () => {
    for (const [name, faction, spell, attackType] of [
        ["Satyr", "Nature", "Summon Wolves", PBTypes.AttackVals.MAGIC],
        ["Ogre Mage", "Chaos", "Mass Riot", PBTypes.AttackVals.MELEE_MAGIC],
        ["Behemoth", "System", "Battle Roar", PBTypes.AttackVals.MELEE_MAGIC],
    ] as const) {
        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
            for (const version of ["v0.2", "v0.8"]) {
                test(`team ${team}: ${version} cannot cast ${spell} through Break`, () => {
                    const { context } = massHealFixture(team, false);
                    const caster = createTestUnit({
                        team,
                        name,
                        amountAlive: 40,
                        stackPower: 5,
                        attackType,
                        spells: [`${faction}:${spell}`],
                    });
                    placeUnit(context.grid, context.unitsHolder, caster, { x: 5, y: 3 });
                    expect(getAIStrategy("v0.2").decideTurn(caster, context)).toContainEqual(
                        expect.objectContaining({ type: "cast_spell", spellName: spell }),
                    );
                    caster.applyEffect(new EffectFactory().makeEffect("Break"));
                    expect(
                        getAIStrategy(version)
                            .decideTurn(caster, context)
                            .some((a) => a.type === "cast_spell"),
                    ).toBe(false);
                });
            }
        }
    }
});
