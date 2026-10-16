import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { isSpellUsableByCaster } from "../../src/spells/spell_helper";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit } from "../helpers/combat";

function setupHealer() {
    const { grid, unitsHolder } = createCombatTestContext();
    const effects = new EffectFactory();
    const create = (amount: number) =>
        Unit.createUnit(
            getCreatureConfig(PBTypes.TeamVals.LEFT, "Life", "Healer", "", amount),
            grid.getSettings(),
            PBTypes.TeamVals.LEFT,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            false,
        );
    const healer = create(40);
    placeUnit(grid, unitsHolder, healer, { x: 2, y: 2 });
    const fight = FightStateManager.getInstance().getFightProperties();
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        canSplitUnit: () => true,
        createSplitUnit: (_source, amount) => create(amount),
    });
    const split = (amount: number) => {
        const result = engine.apply({ type: "split_unit", unitId: healer.getId(), amount });
        expect(result.completed).toBe(true);
        const event = result.events.find((event) => event.type === "unit_split");
        if (event?.type !== "unit_split") throw new Error("Expected split event");
        return unitsHolder.getAllUnits().get(event.newUnitId)!;
    };
    return { healer, split, engine, unitsHolder, fight };
}

describe("placement split removal preserves spell charges", () => {
    it("lets a lone Healer cast after repeatedly undoing and retrying its split", () => {
        const { healer, split, engine, unitsHolder } = setupHealer();
        const originalBook = [...healer.getUnitProperties().spells].sort();
        for (let attempt = 0; attempt < 5; attempt++) {
            const lone = split(1);
            lone.setStackPower(1);
            expect(lone.getUnitProperties().spells).toEqual(["Life:Heal", "Life:Spiritual Armor"]);
            expect(lone.getCanCastSpells()).toBe(true);
            expect(
                lone
                    .getSpells()
                    .filter((spell) => isSpellUsableByCaster(lone, spell))
                    .map((s) => s.getName()),
            ).toEqual(["Heal", "Spiritual Armor"]);

            expect(engine.apply({ type: "delete_unit", unitId: lone.getId() }).completed).toBe(true);
            expect(unitsHolder.getAllUnits().has(lone.getId())).toBe(false);
            expect(healer.getAmountAlive()).toBe(40);
            expect([...healer.getUnitProperties().spells].sort()).toEqual(originalBook);
        }
    });

    it("returns the remaining charges without restoring spent casts or duplicating the book", () => {
        const { healer, split, engine } = setupHealer();
        const half = split(20);
        half.useSpell("Heal");
        const expected = [...healer.getUnitProperties().spells, ...half.getUnitProperties().spells].sort();
        expect(engine.apply({ type: "delete_unit", unitId: half.getId() }).completed).toBe(true);
        expect([...healer.getUnitProperties().spells].sort()).toEqual(expected);
        expect(
            healer
                .getSpells()
                .find((spell) => spell.getName() === "Heal")
                ?.getAmount(),
        ).toBe(3);
        expect(engine.apply({ type: "delete_unit", unitId: half.getId() }).completed).toBe(false);
        expect([...healer.getUnitProperties().spells].sort()).toEqual(expected);
    });

    it("leaves both books intact when removal is rejected after fight start", () => {
        const { healer, split, engine, fight } = setupHealer();
        const lone = split(1);
        const mainBook = [...healer.getUnitProperties().spells];
        const splitBook = [...lone.getUnitProperties().spells];
        fight.startFight();
        expect(engine.apply({ type: "delete_unit", unitId: lone.getId() }).completed).toBe(false);
        expect(healer.getUnitProperties().spells).toEqual(mainBook);
        expect(lone.getUnitProperties().spells).toEqual(splitBook);
    });
});
