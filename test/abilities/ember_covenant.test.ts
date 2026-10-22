import { describe, expect, test } from "bun:test";

import { EMBER_COVENANT_BLESSING as NAME } from "../../src/abilities/ember_covenant";
import { isEquipmentOrMarkerSpellName } from "../../src/abilities/ability_helper";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { projectAttackDamage } from "../../src/damage/damage_projection";
import { GameActionEngine } from "../../src/engine/action_engine";
import { fireWallBurnTargetOf } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { BattleRollbackJournal, restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { fireWallBurnDamage } from "../../src/spells/fire_walls";
import { Spell } from "../../src/spells/spell";
import { projectSpellDamageAgainstUnit } from "../../src/spells/spell_cast_projection";
import { SpellElement } from "../../src/spells/spell_properties";
import { UnitsHolder } from "../../src/units/units_holder";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const log = new SceneLogMock();

function battle(bothSides = false) {
    const f = createCombatTestContext();
    const hydra = createTestUnit({ name: "Hydra", team: PBTypes.TeamVals.LEFT, abilities: [NAME] });
    const ally = createTestUnit({ team: PBTypes.TeamVals.LEFT, maxHp: 200, amountAlive: 5 });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT, abilities: bothSides ? [NAME] : [] });
    placeUnit(f.grid, f.unitsHolder, hydra, { x: 3, y: 4 });
    placeUnit(f.grid, f.unitsHolder, ally, { x: 4, y: 4 });
    placeUnit(f.grid, f.unitsHolder, enemy, { x: 8, y: 4 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const engine = new GameActionEngine({
        ...f,
        fightProperties,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: log,
    });
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    return { ...f, hydra, ally, enemy, engine };
}

describe("Ember Covenant Blessing", () => {
    test("Hydra carries a once-per-battle army blessing with a permanent, non-copyable status", () => {
        expect(getCreatureConfig(PBTypes.TeamVals.LEFT, "Chaos", "Hydra", "", 1).abilities).toContain(NAME);
        expect(isEquipmentOrMarkerSpellName(NAME)).toBe(true);
        const f = battle();
        expect(f.hydra.hasBuffActive(NAME)).toBe(true);
        expect(f.ally.getBuff(NAME)?.getLaps()).toBe(NUMBER_OF_LAPS_TOTAL);
        for (let i = 0; i < 30; i++) f.ally.getBuff(NAME)!.minusLap();
        expect(f.ally.getBuff(NAME)?.getLaps()).toBe(NUMBER_OF_LAPS_TOTAL);
        expect(f.enemy.hasBuffActive(NAME)).toBe(false);
    });

    for (const element of [SpellElement.FIRE, undefined])
        test(`fire ${element === undefined ? "elemental weapon hits" : "magic"} is blocked without breaking any ring`, () => {
            const f = battle();
            const attacker = createTestUnit({ abilities: element === undefined ? ["Fire Element"] : [] });
            const hp = f.ally.getCumulativeHp();
            expect(f.ally.willAbsorbIncomingHit(attacker, element)).toBe(true);
            expect(f.ally.applyDamage(99, 100, log, false, attacker, undefined, element)).toBe(0);
            expect(f.ally.getCumulativeHp()).toBe(hp);
            expect(f.ally.hasEffectActive("Break")).toBe(false);
            expect(f.hydra.hasBuffActive(NAME)).toBe(true);
            expect(f.ally.hasBuffActive(NAME)).toBe(true);
        });

    for (const element of [SpellElement.WATER, undefined])
        test(`the first ${element === undefined ? "ordinary" : "water"} damaging hit breaks the whole army's rings`, () => {
            const f = battle(true);
            const attacker = createTestUnit({ abilities: element === SpellElement.WATER ? ["Water Element"] : [] });
            expect(f.ally.applyDamage(9, 0, log, false, attacker, undefined, element)).toBe(9);
            expect(f.ally.hasBuffActive(NAME)).toBe(false);
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
            expect(f.enemy.hasBuffActive(NAME)).toBe(true);
            expect(f.ally.applyDamage(11, 0, log, false, attacker, undefined, SpellElement.FIRE)).toBe(11);
            f.unitsHolder.refreshStackPowerForAllUnits();
            f.unitsHolder.seedEmberCovenant();
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
            expect(f.ally.hasBuffActive(NAME)).toBe(false);
        });

    test("a Water Element attacker's hit passes through even if it also owns fire", () => {
        const f = battle();
        const attacker = createTestUnit({ abilities: ["Water Element", "Fire Element"] });
        expect(f.ally.willEmberCovenantBlock(attacker)).toBe(false);
        expect(f.ally.applyDamage(15, 0, log, false, attacker)).toBe(15);
        expect(f.hydra.hasBuffActive(NAME)).toBe(false);
    });

    test("zero damage, healing, and another shield's absorption leave the army covenant intact", () => {
        const f = battle();
        f.ally.applyDamage(0, 100, log);
        f.ally.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        expect(f.ally.applyDamage(20, 0, log, false, f.enemy)).toBe(0);
        expect(f.ally.hasBuffActive("Water Shield")).toBe(false);
        expect(f.ally.hasBuffActive(NAME)).toBe(true);
        expect(f.hydra.hasBuffActive(NAME)).toBe(true);
    });

    test("a lethal hit on Hydra removes the blessing before any later hit resolves", () => {
        const f = battle();
        f.hydra.applyDamage(f.hydra.getCumulativeHp(), 0, log, false, f.enemy);
        expect(f.hydra.isDead()).toBe(true);
        expect(f.ally.hasBuffActive(NAME)).toBe(false);
    });

    test("duplicate bearers grant a single covenant and cannot restore a broken one", () => {
        const f = createCombatTestContext();
        const hydras = [0, 1].map(() => createTestUnit({ team: PBTypes.TeamVals.LEFT, abilities: [NAME] }));
        hydras.forEach((unit, index) => placeUnit(f.grid, f.unitsHolder, unit, { x: 3 + index, y: 4 }));
        f.unitsHolder.seedEmberCovenant();
        expect(hydras[0].getBuffs().filter((buff) => buff.getName() === NAME)).toHaveLength(1);
        hydras[0].applyDamage(1, 0, log);
        f.unitsHolder.seedEmberCovenant();
        expect(hydras.every((unit) => !unit.hasBuffActive(NAME))).toBe(true);
    });

    test("restoring an active army registers the shared break without re-seeding it", () => {
        const f = battle();
        const restored = new UnitsHolder(f.grid);
        restored.addUnit(f.hydra);
        restored.addUnit(f.ally);
        f.ally.applyDamage(5, 0, log);
        expect(f.hydra.hasBuffActive(NAME)).toBe(false);
        expect(f.ally.hasBuffActive(NAME)).toBe(false);
    });

    for (const mode of ["snapshot", "journal"])
        test(`${mode} rollback restores the whole shared covenant after a speculative hit`, () => {
            const f = battle();
            const fight = FightStateManager.getInstance().getFightProperties();
            const snapshot = mode === "snapshot" ? snapshotBattle(f.unitsHolder, f.grid, fight) : undefined;
            const checkpoint =
                mode === "journal" ? new BattleRollbackJournal(f.unitsHolder, f.grid, fight).checkpoint() : undefined;
            f.ally.applyDamage(5, 0, log);
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
            if (snapshot) restoreBattle(snapshot, f.unitsHolder, f.grid, fight);
            else checkpoint!.rollback();
            expect(f.hydra.hasBuffActive(NAME)).toBe(true);
            expect(f.ally.hasBuffActive(NAME)).toBe(true);
            f.ally.applyDamage(5, 0, log);
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
        });

    test("a newly added ally's first damage also ends the original army's rings", () => {
        const f = battle();
        const summoned = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(f.grid, f.unitsHolder, summoned, { x: 5, y: 4 });
        expect(summoned.hasBuffActive(NAME)).toBe(false);
        summoned.applyDamage(1, 0, log);
        expect(f.ally.hasBuffActive(NAME)).toBe(false);
    });

    test("fire attack and spell projections agree with the zero-damage resolution", () => {
        const f = battle();
        const attacker = createTestUnit({ abilities: ["Fire Element"], amountAlive: 5 });
        expect(
            projectAttackDamage({
                attacker,
                target: f.ally,
                attackType: PBTypes.AttackVals.MELEE,
                synergyAbilityPowerIncrease: 0,
            }),
        ).toEqual({ min: 0, max: 0, killsMin: 0, killsMax: 0 });
        const spell = new Spell({ spellProperties: getSpellConfig("Life", "Fire Strike"), amount: 1 });
        expect(projectSpellDamageAgainstUnit({ spell, caster: attacker, target: f.ally, rawDamage: 100 }).damage).toBe(
            0,
        );
        expect(f.ally.hasBuffActive(NAME)).toBe(true);
    });

    test("Fire Wall burn and its move projection cannot consume the covenant", () => {
        const f = battle();
        expect(fireWallBurnDamage(f.ally.getCumulativeMaxHp(), 25, fireWallBurnTargetOf(f.ally))).toBe(0);
        expect(f.ally.hasBuffActive(NAME)).toBe(true);
    });
});
