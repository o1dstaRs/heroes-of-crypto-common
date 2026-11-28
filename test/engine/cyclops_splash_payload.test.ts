import { afterEach, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { TRIUMPHANT_ROAR } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { amountForCreatureExperienceBudget, STACK_EXPERIENCE_BUDGET } from "../../src/simulation/army";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const previousFight = FightStateManager.getInstance().getFightProperties();
afterEach(() => {
    setDeterministicRandomSource(undefined);
    FightStateManager.getInstance().setFightProperties(previousFight);
});

function realUnit(faction: string, name: string, team: TeamType, amount = 1): Unit {
    const effects = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
}

test.each([false, true])("native Cyclops journals every direct splash kill, counter=%s", (counter) => {
    const combat = createCombatTestContext();
    setDeterministicRandomSource(() => 0.99);
    const left = PBTypes.TeamVals.LEFT;
    const right = PBTypes.TeamVals.RIGHT;
    const cyclops = realUnit("Might", "Cyclops", counter ? right : left, 100);
    const elf = realUnit("Nature", "Elf", counter ? left : right);
    const collateral = realUnit("Life", "Peasant", elf.getTeam());
    const ally = realUnit("Life", "Squire", cyclops.getTeam());
    const allyAttack = ally.getAttack();
    const attacker = counter ? elf : cyclops;
    const target = counter ? cyclops : elf;
    placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 3, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 12, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, collateral, { x: counter ? 3 : 12, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: counter ? 13 : 2, y: 10 });
    // Real roster abilities determine the splash and response. Fixed damage only removes roll variance.
    expect(cyclops.hasAbilityActive("Large Caliber")).toBe(true);
    expect(cyclops.hasAbilityActive("Area Throw")).toBe(false);
    cyclops.calculateAttackDamage = () => 100_000;
    elf.calculateAttackDamage = () => 1;
    attacker.refreshPossibleAttackTypes(true);
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.startFight();
    fight.setTeamUnitsAlive(left, 2);
    fight.setTeamUnitsAlive(right, 2);
    fight.startTurn(left, 1000);
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => attacker.getId(),
    });
    const result = engine.apply({ type: "range_attack", attackerId: attacker.getId(), targetId: target.getId() });
    expect(result.completed).toBe(true);
    const event = result.events.find((entry) => entry.type === "unit_attacked");
    if (!event || event.type !== "unit_attacked") throw new Error("Missing ranged attack journal");
    const recorded = JSON.parse(JSON.stringify(event)) as typeof event;
    for (const victim of [elf, collateral]) {
        expect(recorded.unitIdsDied).toContain(victim.getId());
        const hit = recorded.damage.splash?.find((entry) => entry.unitId === victim.getId());
        expect(hit?.unitsDied).toBe(1);
        expect(hit?.amount).toBeGreaterThan(0);
        expect(hit?.missed).not.toBe(true);
    }
    if (counter) {
        expect(recorded.damage.splash?.find((entry) => entry.unitId === cyclops.getId())?.amount).toBe(1);
    }
    expect(cyclops.getBuffPower(TRIUMPHANT_ROAR)).toBe(2);
    expect(ally.getBuffPower(TRIUMPHANT_ROAR)).toBe(2);
    expect(ally.getAttack()).toBe(allyAttack + 2);
    combat.unitsHolder.refreshStackPowerForAllUnits();
    expect(ally.getAttack()).toBe(allyAttack + 2);
    const rallied = result.events.flatMap((event) =>
        event.type === "effects_applied"
            ? event.applications.filter((application) => application.name === TRIUMPHANT_ROAR)
            : [],
    );
    expect(rallied.map((entry) => entry.unitId).sort()).toEqual(
        [cyclops.getId(), cyclops.getId(), ally.getId(), ally.getId()].sort(),
    );
});

test("Cyclops fields nine creatures at 20 Attack", () => {
    const amount = amountForCreatureExperienceBudget("Cyclops", STACK_EXPERIENCE_BUDGET, 0);
    const cyclops = realUnit("Might", "Cyclops", PBTypes.TeamVals.LEFT, amount);
    expect(cyclops.getAmountAlive()).toBe(9);
    expect(cyclops.getAttack()).toBe(20);
});

test("Triumphant Roar needs an enemy stack to be destroyed by an active holder", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const left = PBTypes.TeamVals.LEFT;
    const right = PBTypes.TeamVals.RIGHT;
    const cyclops = realUnit("Might", "Cyclops", left);
    const guard = realUnit("Life", "Squire", left);
    const friendly = realUnit("Life", "Peasant", left);
    const angel = realUnit("Life", "Angel", right);
    const enemy = realUnit("Life", "Peasant", right, 2);
    for (const [unit, x, y] of [
        [cyclops, 2, 4],
        [guard, 2, 6],
        [friendly, 2, 10],
        [angel, 12, 6],
        [enemy, 12, 10],
    ] as const) {
        placeUnit(grid, unitsHolder, unit, { x, y });
    }
    const log = new SceneLogMock();
    friendly.applyDamage(1000, 0, log, false, cyclops);
    expect(unitsHolder.deleteUnitById(friendly.getId(), true)).toBe(true);
    angel.applyDamage(1000, 0, log, false, cyclops);
    expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(false);
    enemy.applyDamage(enemy.getMaxHp(), 0, log, false, cyclops);
    expect(guard.getBuffPower(TRIUMPHANT_ROAR)).toBeUndefined();
    expect(enemy.isDead()).toBe(false);
    cyclops.deleteAbility(TRIUMPHANT_ROAR);
    enemy.applyDamage(1000, 0, log, false, cyclops);
    expect(unitsHolder.deleteUnitById(enemy.getId(), true)).toBe(true);
    expect(guard.getBuffPower(TRIUMPHANT_ROAR)).toBeUndefined();
});
