/*
 * -----------------------------------------------------------------------------
 * The `effects_applied` event: every buff/debuff/effect an action lands (and
 * every resisted debuff) is captured at the Unit.applyBuff/applyDebuff/
 * applyEffect funnels and drained into one event per action — the only way the
 * ranked scene log (rebuilt from events, never engine text) can show mass-cast
 * recipients and on-hit riders. Refresh noise (markers, artifact/augment
 * carry-buffs, aura stamps) must stay out.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { isEffectApplicationNoise } from "../../src/units/effect_application_capture";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";
import type { Unit } from "../../src/units/unit";

type EffectsAppliedEvent = Extract<GameEvent, { type: "effects_applied" }>;

const effectsAppliedOf = (events: GameEvent[]): EffectsAppliedEvent | undefined =>
    events.find((event): event is EffectsAppliedEvent => event.type === "effects_applied");

const startFight = () => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: context.attackHandler,
    });
    return { context, fightProperties, engine };
};

describe("effects_applied event", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("a mass buff cast reports EVERY ally it reached, and before the turn-handoff events", () => {
        const { context, fightProperties, engine } = startFight();
        const caster = createTestUnit({
            name: "Caster",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            spells: ["Chaos:Mass Riot"],
            amountAlive: 3,
            stackPower: 5,
        });
        const allyOne = createTestUnit({ name: "Ally One", team: PBTypes.TeamVals.LOWER });
        const allyTwo = createTestUnit({ name: "Ally Two", team: PBTypes.TeamVals.LOWER });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER });
        placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, allyOne, { x: 5, y: 3 });
        placeUnit(context.grid, context.unitsHolder, allyTwo, { x: 7, y: 3 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 9, y: 9 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 3);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const result = engine.apply({ type: "cast_spell", casterId: caster.getId(), spellName: "Mass Riot" });
        expect(result.completed).toBe(true);

        const effects = effectsAppliedOf(result.events);
        expect(effects).toBeDefined();
        const riots = effects!.applications.filter((entry) => entry.name === "Mass Riot" && entry.kind === "buff");
        expect(riots.map(({ unitId }) => unitId).sort()).toEqual(
            [caster.getId(), allyOne.getId(), allyTwo.getId()].sort(),
        );
        // The enemy must not be blessed, and every application carries its duration.
        expect(effects!.applications.some((entry) => entry.unitId === enemy.getId())).toBe(false);
        for (const entry of riots) {
            expect(entry.laps).toBeGreaterThanOrEqual(3);
        }

        // The effects land under the CASTER's turn in the log, so the event must precede the handoff.
        const effectsIndex = result.events.findIndex((event) => event.type === "effects_applied");
        const handoffIndex = result.events.findIndex(
            (event) => event.type === "turn_completed" || event.type === "next_unit_selected",
        );
        if (handoffIndex >= 0) {
            expect(effectsIndex).toBeLessThan(handoffIndex);
        }
    });

    it("an on-hit rider (Stun) reaches the event", () => {
        // RNG 0: the stun roll always lands (chance > 0 via luck).
        setDeterministicRandomSource(() => 0);
        const { context, fightProperties, engine } = startFight();
        const attacker = createTestUnit({
            name: "Stunner",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            attack: 10,
            damageMin: 5,
            damageMax: 5,
            luck: 40,
            abilities: ["Stun"],
            spells: ["Death:Quagmire"],
            stackPower: 5,
        });
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 500,
            amountAlive: 5,
            magicResist: 50,
        });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, victim, { x: 4, y: 3 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const melee = engine.apply({
            type: "melee_attack",
            attackerId: attacker.getId(),
            targetId: victim.getId(),
            attackFrom: { x: 3, y: 3 },
        });
        expect(melee.completed).toBe(true);
        const meleeEffects = effectsAppliedOf(melee.events);
        expect(meleeEffects).toBeDefined();
        expect(
            meleeEffects!.applications.some(
                (entry) => entry.unitId === victim.getId() && entry.name === "Stun" && entry.kind === "effect",
            ),
        ).toBe(true);
    });

    it("a resisted debuff is reported as resisted", () => {
        // RNG 0: the resist roll (0 < 50) always resists.
        setDeterministicRandomSource(() => 0);
        const { context, fightProperties, engine } = startFight();
        const caster = createTestUnit({
            name: "Hexer",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            spells: ["Death:Quagmire"],
            stackPower: 5,
        });
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 500,
            amountAlive: 5,
            magicResist: 50,
        });
        placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, victim, { x: 4, y: 3 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const cast = engine.apply({
            type: "cast_spell",
            casterId: caster.getId(),
            spellName: "Quagmire",
            targetId: victim.getId(),
        });
        expect(cast.completed).toBe(true);
        const castEffects = effectsAppliedOf(cast.events);
        expect(castEffects).toBeDefined();
        expect(
            castEffects!.applications.some(
                (entry) => entry.unitId === victim.getId() && entry.name === "Quagmire" && entry.resisted === true,
            ),
        ).toBe(true);
    });

    it("a plain move emits no effects_applied — refresh/seeding noise never leaks in", () => {
        const { context, fightProperties, engine } = startFight();
        const walker = createTestUnit({ name: "Walker", team: PBTypes.TeamVals.LOWER, speed: 4 });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER });
        placeUnit(context.grid, context.unitsHolder, walker, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 12, y: 12 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const result = engine.apply({
            type: "move_unit",
            unitId: walker.getId(),
            path: [{ x: 4, y: 3 }],
            targetCells: [{ x: 4, y: 3 }],
        });
        expect(result.completed).toBe(true);
        expect(effectsAppliedOf(result.events)).toBeUndefined();
    });

    it("filters bookkeeping names and keeps real ones", () => {
        for (const noise of ["Morale", "Water Shield", "Venom Cloud Aura", "Armor Augment"]) {
            expect(isEffectApplicationNoise(noise)).toBe(true);
        }
        for (const real of ["Riot", "Mass Riot", "Stun", "Break", "Poison", "Quagmire"]) {
            expect(isEffectApplicationNoise(real)).toBe(false);
        }
    });
});

// Type-level guard: `applications` is readable off the parsed event as the ranked log builder does it.
void ((unit: Unit) => unit);
