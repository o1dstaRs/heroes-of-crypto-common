import { afterEach, expect, test } from "bun:test";

import { EMBER_COVENANT_BLESSING as NAME } from "../../src/abilities/ember_covenant";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { SpellElement } from "../../src/spells/spell_properties";
import {
    beginEffectApplicationCapture,
    endEffectApplicationCapture,
    endEmberCovenantAbsorbCapture,
} from "../../src/units/effect_application_capture";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => {
    setDeterministicRandomSource(undefined);
    endEffectApplicationCapture();
    endEmberCovenantAbsorbCapture();
});

function battle(water = false) {
    const f = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Wolf",
        team: PBTypes.TeamVals.LEFT,
        maxHp: 1000,
        damageMin: 10,
        damageMax: 10,
        abilities: ["Double Punch", ...(water ? ["Water Element"] : [])],
    });
    const target = createTestUnit({ name: "Orc", team: PBTypes.TeamVals.RIGHT, maxHp: 1000, abilities: ["No Melee"] });
    const hydra = createTestUnit({ name: "Hydra", team: PBTypes.TeamVals.RIGHT, abilities: [NAME] });
    placeUnit(f.grid, f.unitsHolder, attacker, { x: 3, y: 3 });
    placeUnit(f.grid, f.unitsHolder, target, { x: 4, y: 3 });
    placeUnit(f.grid, f.unitsHolder, hydra, { x: 9, y: 8 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const engine = new GameActionEngine({
        ...f,
        fightProperties,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
    });
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
    setDeterministicRandomSource(() => 0);
    return { ...f, engine, target, attacker, hydra };
}

test.each([false, true])("only real absorbs carry an amount to the struck unit (water bypass: %s)", (water) => {
    const f = battle(water);
    const result = f.engine.apply({
        type: "melee_attack",
        attackerId: f.attacker.getId(),
        targetId: f.target.getId(),
        attackFrom: { x: 3, y: 3 },
    });
    expect(result.completed).toBe(true);
    const event = result.events.find((event) => event.type === "unit_attacked");
    expect(event?.type).toBe("unit_attacked");
    if (event?.type !== "unit_attacked") return;
    const absorbs = event.damage.secondary?.filter((entry) => entry.source === "ember_covenant") ?? [];
    expect(absorbs).toHaveLength(water ? 0 : 1);
    if (!water) {
        expect(absorbs[0].unitId).toBe(f.target.getId());
        expect(absorbs[0].amount).toBeGreaterThan(0);
        expect(absorbs[0].unitsDied).toBe(0);
        expect(event.damage.hits?.[0].amount).toBe(0);
    }
    expect(event.damage.hits?.[1].amount).toBeGreaterThan(0);
    expect(f.hydra.hasBuffActive(NAME)).toBe(false);
    expect(f.target.hasBuffActive(NAME)).toBe(false);
    expect(endEmberCovenantAbsorbCapture()).toEqual([]);
});

test("fire blocks can flash again without consuming the blessing; zero damage stays silent", () => {
    const f = battle();
    beginEffectApplicationCapture();
    for (const amount of [0, 37, 51])
        f.target.applyDamage(amount, 0, new SceneLogMock(), false, f.attacker, undefined, SpellElement.FIRE);
    endEffectApplicationCapture();
    expect(endEmberCovenantAbsorbCapture()).toEqual([
        { unitId: f.target.getId(), amount: 37 },
        { unitId: f.target.getId(), amount: 51 },
    ]);
    expect(f.hydra.hasBuffActive(NAME)).toBe(true);
    expect(f.target.hasBuffActive(NAME)).toBe(true);
});
