/*
 * -----------------------------------------------------------------------------
 * Fireball (Wandering Mage / Book of Chaos), added 2026-09-20 on the owner's
 * call: "basically like fire arrow, but with AOE around the target effect (like
 * cyclops attack basically). Minimal stack will be 3."
 *
 * So it is Fire Strike's throw — arced over the caster's own troops, intercepted
 * by a screening enemy rather than refused by it — carrying Ring of Fire's blast,
 * except that it burns the creature at the centre instead of sparing it. These
 * pin both halves, and the seam between them.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { SpellElement, SpellMultiplierType, SpellTargetType } from "../../src/spells/spell_properties";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const CONFIG = getSpellConfig("Chaos", "Fireball");

/** A capturing log, for the lines the blast writes. */
class CapturingSceneLog extends SceneLogMock {
    public readonly lines: string[] = [];
    public override updateLog(newLog?: string): void {
        if (newLog) {
            this.lines.push(newLog);
        }
    }
}

const setup = (opts: { casterStackPower?: number; casterAmount?: number } = {}) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const mage = createTestUnit({
        name: "Wandering Mage",
        team: PBTypes.TeamVals.LEFT,
        spells: ["Chaos:Fireball"],
        // Fireball's minimal_caster_stack_power is 3.
        stackPower: opts.casterStackPower ?? 3,
        amountAlive: opts.casterAmount ?? 10,
        maxHp: 100,
        // Nothing here is about the mage's own swing.
        damageMin: 0,
        damageMax: 0,
    });
    placeUnit(context.grid, context.unitsHolder, mage, { x: 2, y: 8 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const sceneLog = new CapturingSceneLog();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog,
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => mage.getId(),
    });

    const addUnit = (name: string, team: number, cell: { x: number; y: number }) => {
        const unit = createTestUnit({ name, team, maxHp: 1000, amountAlive: 5, damageMin: 0, damageMax: 0 });
        placeUnit(context.grid, context.unitsHolder, unit, cell);
        return unit;
    };

    const cast = (targetId: string) =>
        engine.apply({ type: "cast_spell", casterId: mage.getId(), spellName: "Fireball", targetId });

    return { ...context, fightProperties, mage, engine, sceneLog, addUnit, cast };
};

describe("Fireball", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("is configured as the owner asked: a level-1 Chaos fire spell needing a stack of 3", () => {
        expect(CONFIG.minimal_caster_stack_power).toBe(3);
        // 2 damage per creature in the caster's stack, which is what "2 attack points per one unit" means
        // once UNIT_AMOUNT_DAMAGE multiplies it by the head count.
        expect(CONFIG.power).toBe(2);
        expect(CONFIG.element).toBe(SpellElement.FIRE);
        expect(CONFIG.spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        expect(CONFIG.multiplier_type).toBe(SpellMultiplierType.UNIT_AMOUNT_DAMAGE);
    });

    // The half that makes it a fireball rather than a fire arrow.
    it("burns the target AND everything touching it, friend or foe, for the same amount", () => {
        const s = setup({ casterAmount: 10 });
        const target = s.addUnit("Target", PBTypes.TeamVals.RIGHT, { x: 8, y: 8 });
        const neighbourEnemy = s.addUnit("Neighbour Enemy", PBTypes.TeamVals.RIGHT, { x: 9, y: 8 });
        // Diagonally touching still counts — the blast is the ring of cells around the target.
        const neighbourAlly = s.addUnit("Neighbour Ally", PBTypes.TeamVals.LEFT, { x: 9, y: 9 });
        const bystander = s.addUnit("Bystander", PBTypes.TeamVals.RIGHT, { x: 12, y: 12 });

        const before = [target, neighbourEnemy, neighbourAlly, bystander].map((u) => u.getCumulativeHp());
        const result = s.cast(target.getId());

        expect(result.completed).toBe(true);
        // 10 casters x 2 per caster; none of these fixtures resists or is an element.
        const expected = 10 * CONFIG.power;
        expect(before[0] - target.getCumulativeHp()).toBe(expected);
        expect(before[1] - neighbourEnemy.getCumulativeHp()).toBe(expected);
        expect(before[2] - neighbourAlly.getCumulativeHp()).toBe(expected);
        // Two cells away is outside the blast.
        expect(bystander.getCumulativeHp()).toBe(before[3]);
    });

    it("never burns the caster, even standing right beside the blast", () => {
        const s = setup();
        const target = s.addUnit("Target", PBTypes.TeamVals.RIGHT, { x: 3, y: 8 });
        const mageHpBefore = s.mage.getCumulativeHp();

        expect(s.cast(target.getId()).completed).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());
        expect(s.mage.getCumulativeHp()).toBe(mageHpBefore);
    });

    // Unlike Ring of Fire, which needs somebody in its ring because it spares the middle.
    it("still burns a lone target with nothing around it", () => {
        const s = setup();
        const target = s.addUnit("Lonely", PBTypes.TeamVals.RIGHT, { x: 10, y: 8 });

        expect(s.cast(target.getId()).completed).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());
    });

    // The "like fire arrow" half: a body in the lane takes the throw instead of the aimed target, and the
    // blast goes off around the unit it actually hit.
    it("is intercepted by a screening enemy, and bursts on the interceptor instead", () => {
        const s = setup();
        const screen = s.addUnit("Screen", PBTypes.TeamVals.RIGHT, { x: 5, y: 8 });
        const aimed = s.addUnit("Aimed", PBTypes.TeamVals.RIGHT, { x: 10, y: 8 });
        const besideScreen = s.addUnit("Beside Screen", PBTypes.TeamVals.RIGHT, { x: 5, y: 9 });

        const result = s.cast(aimed.getId());

        expect(result.completed).toBe(true);
        expect(screen.getCumulativeHp()).toBeLessThan(screen.getCumulativeMaxHp());
        expect(besideScreen.getCumulativeHp()).toBeLessThan(besideScreen.getCumulativeMaxHp());
        // The aimed unit is far away from where the throw actually burst.
        expect(aimed.getCumulativeHp()).toBe(aimed.getCumulativeMaxHp());
        expect(s.sceneLog.lines.some((line) => line.includes("intercepted Fireball aimed at Aimed"))).toBe(true);
        // The event names the unit it burst on, so the client centres the explosion there.
        const castEvent = result.events.find((event) => event.type === "spell_cast");
        expect(castEvent).toMatchObject({ spellName: "Fireball", targetId: screen.getId() });
    });

    it("flies over the caster's own troops rather than bursting on them", () => {
        const s = setup();
        const ownFrontLine = s.addUnit("Front Line", PBTypes.TeamVals.LEFT, { x: 5, y: 8 });
        const target = s.addUnit("Target", PBTypes.TeamVals.RIGHT, { x: 10, y: 8 });

        expect(s.cast(target.getId()).completed).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());
        expect(ownFrontLine.getCumulativeHp()).toBe(ownFrontLine.getCumulativeMaxHp());
    });

    // Owner report 2026-09-20: "my allies also can block". The pre-dispatch gate applied the visible-edge
    // rule with the caster's own troops as opaque, so an enemy the front line had closed in on could not be
    // aimed at at all — the cast was refused before fireballCast ever got to fly over them.
    it("can be aimed at an enemy the caster's own troops have surrounded", () => {
        const s = setup();
        const target = s.addUnit("Surrounded", PBTypes.TeamVals.RIGHT, { x: 10, y: 8 });
        const ring: { x: number; y: number }[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx || dy) {
                    ring.push({ x: 10 + dx, y: 8 + dy });
                }
            }
        }
        const allies = ring.map((cell, index) => s.addUnit(`Own ${index}`, PBTypes.TeamVals.LEFT, cell));

        expect(s.cast(target.getId()).completed).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());
        // The blast still catches everyone touching the target — the owner's own ring included.
        expect(allies.every((ally) => ally.getCumulativeHp() < ally.getCumulativeMaxHp())).toBe(true);
    });

    // One summed number told the player nothing about who took what: a blast prices every victim
    // separately (owner report 2026-09-20, reading "burst a Fireball on Centaur, catching 2 more (984)").
    it("logs the damage per victim, not as one total", () => {
        const s = setup({ casterAmount: 10 });
        const target = s.addUnit("Centaur", PBTypes.TeamVals.RIGHT, { x: 8, y: 8 });
        s.addUnit("Peasant", PBTypes.TeamVals.RIGHT, { x: 9, y: 8 });
        s.addUnit("Wolf", PBTypes.TeamVals.RIGHT, { x: 9, y: 9 });

        expect(s.cast(target.getId()).completed).toBe(true);

        const each = 10 * CONFIG.power;
        // A headline saying WHERE it burst, then one line per creature with its own number.
        expect(s.sceneLog.lines).toContain("Wandering Mage burst a Fireball on Centaur");
        for (const name of ["Centaur", "Peasant", "Wolf"]) {
            expect(s.sceneLog.lines).toContain(`${name} burned for (${each}) by Fireball`);
        }
        // ...and no summed line anywhere.
        expect(s.sceneLog.lines.some((line) => line.includes(String(each * 3)))).toBe(false);
    });

    it("refuses the cast below a stack of 3, keeping the charge and the turn", () => {
        const s = setup({ casterStackPower: 2 });
        const target = s.addUnit("Target", PBTypes.TeamVals.RIGHT, { x: 8, y: 8 });

        const result = s.cast(target.getId());

        expect(result.completed).toBe(false);
        expect(target.getCumulativeHp()).toBe(target.getCumulativeMaxHp());
        expect(s.mage.hasSpellRemaining("Fireball")).toBe(true);
        expect(s.fightProperties.hasAlreadyMadeTurn(s.mage.getId())).toBe(false);
    });

    it("spends the charge and the turn on a cast that lands", () => {
        const s = setup();
        const target = s.addUnit("Target", PBTypes.TeamVals.RIGHT, { x: 8, y: 8 });

        expect(s.cast(target.getId()).completed).toBe(true);
        // One charge is all the live Wandering Mage carries either (owner 2026-09-20), so it is now spent.
        expect(s.mage.hasSpellRemaining("Fireball")).toBe(false);
        expect(s.fightProperties.hasAlreadyMadeTurn(s.mage.getId())).toBe(true);
    });
});
