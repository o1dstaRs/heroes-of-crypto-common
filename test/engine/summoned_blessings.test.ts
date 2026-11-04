import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EMBER_COVENANT_BLESSING } from "../../src/abilities/ember_covenant";
import { STACK_BLESSINGS } from "../../src/abilities/stack_blessings";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { SpellElement } from "../../src/spells/spell_properties";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const wolfBlessings = [
    ...STACK_BLESSINGS.map(({ name }) => name),
    "Arcane Ward Blessing",
    "Warding Mane Blessing",
    "Arrows Wingshield Blessing",
    "Sharpened Weapons Blessing",
    EMBER_COVENANT_BLESSING,
];

function summonFight(team: TeamType, blessings: string[]) {
    const context = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const sceneLog = new SceneLogMock();
    const caster = createTestUnit({ team, name: "Summoner", spells: ["Nature:Summon Wolves"], amountAlive: 10 });
    const source = createTestUnit({ team, abilities: blessings, exp: 1, amountAlive: 100 });
    const enemy = createTestUnit({
        team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
    });
    placeUnit(context.grid, context.unitsHolder, source, { x: 1, y: 1 });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 12, y: 12 });
    const effects = new EffectFactory();
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        sceneLog,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        getCurrentActiveUnitId: () => caster.getId(),
        createSummonedUnit: ({ team: summonTeam, unitName, amount }) =>
            Unit.createUnit(
                getCreatureConfig(summonTeam, "Nature", unitName, "", amount),
                context.grid.getSettings(),
                summonTeam,
                PBTypes.UnitVals.CREATURE,
                new AbilityFactory(effects),
                effects,
                true,
            ),
    });
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(team, 1000);
    const cast = () => {
        const result = engine.apply({
            type: "cast_spell",
            casterId: caster.getId(),
            spellName: "Summon Wolves",
            targetCell: { x: 4, y: 4 },
        });
        expect(result.completed).toBe(true);
        const wolf = context.unitsHolder.getSummonedUnitByName(team, "Wolf")!;
        expect(wolf).toBeDefined();
        expect(wolf.isSummoned()).toBe(true);
        expect(wolf.getCells()).toHaveLength(2);
        return { result, wolf };
    };
    return { ...context, caster, source, enemy, sceneLog, cast };
}

describe("blessings on summoned wolves", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const blessing of wolfBlessings) {
            test(`team ${team} grants ${blessing} when Summon Wolves completes`, () => {
                const f = summonFight(team, [blessing]);
                const { wolf } = f.cast();
                expect(wolf.hasBuffActive(blessing)).toBe(true);
                expect(wolf.getBuff(blessing)?.getPower()).toBe(f.caster.getBuff(blessing)?.getPower());
                expect(f.enemy.hasBuffActive(blessing)).toBe(false);
                f.unitsHolder.refreshStackPowerForAllUnits();
                expect(wolf.getBuffs().filter((buff) => buff.getName() === blessing)).toHaveLength(1);
            });
        }

        test(`team ${team}'s summoned wolf shares fire protection and the army-wide first-hit absorption`, () => {
            const f = summonFight(team, [EMBER_COVENANT_BLESSING]);
            const { wolf } = f.cast();
            const hp = wolf.getCumulativeHp();
            expect(wolf.applyDamage(5, 0, f.sceneLog, false, f.enemy, undefined, SpellElement.FIRE)).toBe(0);
            expect(wolf.getCumulativeHp()).toBe(hp);
            expect(f.source.hasBuffActive(EMBER_COVENANT_BLESSING)).toBe(true);
            expect(wolf.applyDamage(5, 0, f.sceneLog, false, f.enemy)).toBe(0);
            for (const unit of [wolf, f.source, f.caster]) {
                expect(unit.hasBuffActive(EMBER_COVENANT_BLESSING)).toBe(false);
            }
            expect(wolf.applyDamage(5, 0, f.sceneLog, false, f.enemy)).toBe(5);
        });

        test(`team ${team}'s summon does not restore its already consumed covenant`, () => {
            const f = summonFight(team, [EMBER_COVENANT_BLESSING]);
            f.source.applyDamage(1, 0, f.sceneLog, false, f.enemy);
            const { wolf } = f.cast();
            expect(wolf.hasBuffActive(EMBER_COVENANT_BLESSING)).toBe(false);
            expect(wolf.applyDamage(5, 0, f.sceneLog, false, f.enemy)).toBe(5);
        });

        test(`team ${team}'s walking melee summon does not gain flying or shooter-only blessings`, () => {
            const f = summonFight(team, ["Angelic Host Blessing", "Rallying Volley Blessing"]);
            const { wolf } = f.cast();
            expect(wolf.hasBuffActive("Angelic Host Blessing")).toBe(false);
            expect(wolf.hasBuffActive("Rallying Volley Blessing")).toBe(false);
        });
    }
});
