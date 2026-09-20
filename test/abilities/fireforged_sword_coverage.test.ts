/*
 * -----------------------------------------------------------------------------
 * The Fireforged Sword card promises "the ally's ATTACKS set the target alight",
 * with no exception for which kind of attack. It used to fire on three paths only
 * — the melee swing, the ranged shot and the second punch — so a buffed unit that
 * retaliated, counter-shot, threw an Area Throw, fired a Through Shot or swept
 * several enemies with a breath/spin/skewer set nobody alight (owner report
 * 2026-09-20, "I think it didn't even work properly").
 *
 * These pin the paths that were silent. The burn's own arithmetic lives in
 * test/spells/fireforged_sword.test.ts; what matters here is only that the blade
 * REACHES each victim of each kind of attack.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { processFireforgedSwordOnVictims } from "../../src/abilities/fireforged_sword_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

/** Nothing here is about dodge rolls, so pin the RNG: every blow lands and nothing misses. */
const pinRng = (): void => setDeterministicRandomSource(() => 0);

const giveSword = (unit: ReturnType<typeof createTestUnit>): void => {
    unit.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Fireforged Sword"), amount: 1 }));
    expect(unit.getBuff("Fireforged Sword")).toBeDefined();
};

const swordBurns = (secondary: ISecondaryDamage[] | undefined): ISecondaryDamage[] =>
    (secondary ?? []).filter((entry) => entry.source === "fireforged_sword");

describe("Fireforged Sword reaches every kind of attack", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    // The headline bug. Fire Shield — the sword's mirror image — already burned on this exact path, so a
    // buffed defender striking back was the one obvious asymmetry in the engine.
    it("burns on a melee RETALIATION, from the responder's own blade", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);

        const attacker = createTestUnit({
            name: "Attacker",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 500,
            amountAlive: 5,
            damageMin: 5,
            damageMax: 5,
        });
        const defender = createTestUnit({
            name: "Defender",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 500,
            amountAlive: 5,
            damageMin: 20,
            damageMax: 20,
        });
        giveSword(defender);

        placeUnit(grid, unitsHolder, defender, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });

        const damage = createVisibleDamage(defender);
        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            damage,
            undefined,
            attacker,
            defender,
            { x: 5, y: 3 },
        );

        expect(result.completed).toBe(true);
        // The retaliation set the ATTACKER alight — one burn, on the unit the counter-blow hit.
        const burns = swordBurns(damage.secondary);
        expect(burns).toHaveLength(1);
        expect(burns[0].unitId).toBe(attacker.getId());
        expect(burns[0].amount).toBeGreaterThan(0);
    });

    // A sweeping blow hits several units at once and reported only the primary victim's burn before.
    it("burns EVERY unit a sweeping melee attack damaged, not just the aimed one", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);

        const dragon = createTestUnit({
            name: "Black Dragon",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 500,
            amountAlive: 5,
            damageMin: 20,
            damageMax: 20,
            abilities: ["Fire Breath"],
        });
        giveSword(dragon);
        const front = createTestUnit({
            name: "Front",
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 400,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });
        const behind = createTestUnit({
            name: "Behind",
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 400,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });

        // The breath runs along the line the blow was aimed down, so the second enemy stands behind the first.
        placeUnit(grid, unitsHolder, dragon, { x: 3, y: 5 });
        placeUnit(grid, unitsHolder, front, { x: 4, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 5 });

        const damage = createVisibleDamage(front);
        const result = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, dragon, front, {
            x: 3,
            y: 5,
        });

        expect(result.completed).toBe(true);
        const breathed = (damage.secondary ?? []).filter((entry) => entry.source === "fire_breath");
        // Guard the fixture: if the breath never reached the unit behind, the assertion below proves nothing.
        expect(breathed.some((entry) => entry.unitId === behind.getId())).toBe(true);

        const burnedIds = new Set(swordBurns(damage.secondary).map((entry) => entry.unitId));
        expect(burnedIds.has(front.getId())).toBe(true);
        expect(burnedIds.has(behind.getId())).toBe(true);
    });

    it("leaves everything alone when the attacker carries no sword", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const attacker = createTestUnit({
            name: "Plain Attacker",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
            maxHp: 300,
        });
        const defender = createTestUnit({
            name: "Plain Defender",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 300,
            amountAlive: 5,
            damageMin: 5,
            damageMax: 5,
        });
        placeUnit(grid, unitsHolder, defender, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });

        const damage = createVisibleDamage(defender);
        attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, attacker, defender, {
            x: 5,
            y: 3,
        });

        expect(swordBurns(damage.secondary)).toHaveLength(0);
    });
});

/**
 * The multi-victim helper on its own. The volley paths (Area Throw, Through Shot) hand it the per-unit
 * damage their processors report, so its filtering rules are what keep those paths honest.
 */
describe("processFireforgedSwordOnVictims", () => {
    const world = () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wielder = createTestUnit({ name: "Wielder", team: PBTypes.TeamVals.LEFT, maxHp: 300, amountAlive: 5 });
        const first = createTestUnit({ name: "First", team: PBTypes.TeamVals.RIGHT, maxHp: 300, amountAlive: 5 });
        const second = createTestUnit({ name: "Second", team: PBTypes.TeamVals.RIGHT, maxHp: 300, amountAlive: 5 });
        placeUnit(grid, unitsHolder, wielder, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, first, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, second, { x: 5, y: 5 });
        return { unitsHolder, wielder, first, second };
    };

    it("burns each victim for its OWN damage, not all for the biggest", () => {
        const { unitsHolder, wielder, first, second } = world();
        giveSword(wielder);
        const secondary: ISecondaryDamage[] = [];

        processFireforgedSwordOnVictims(
            wielder,
            [
                { unitId: first.getId(), amount: 100 },
                { unitId: second.getId(), amount: 50 },
            ],
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        const burns = swordBurns(secondary);
        expect(burns).toHaveLength(2);
        const byId = new Map(burns.map((entry) => [entry.unitId, entry.amount]));
        // Twice the damage, twice the fire — whatever the configured share is.
        expect(byId.get(first.getId())).toBe(2 * (byId.get(second.getId()) ?? 0));
    });

    it("sets one victim alight once, however many pieces its damage was reported in", () => {
        const { unitsHolder, wielder, first } = world();
        giveSword(wielder);
        const secondary: ISecondaryDamage[] = [];

        processFireforgedSwordOnVictims(
            wielder,
            [
                { unitId: first.getId(), amount: 60 },
                { unitId: first.getId(), amount: 40 },
            ],
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        expect(swordBurns(secondary)).toHaveLength(1);
    });

    it("skips a victim that took nothing, an unknown id, and the wielder itself", () => {
        const { unitsHolder, wielder, first } = world();
        giveSword(wielder);
        const secondary: ISecondaryDamage[] = [];

        processFireforgedSwordOnVictims(
            wielder,
            [
                { unitId: first.getId(), amount: 0 },
                { unitId: "not-a-unit", amount: 100 },
                { unitId: wielder.getId(), amount: 100 },
            ],
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        expect(swordBurns(secondary)).toHaveLength(0);
    });

    it("does nothing at all without the buff", () => {
        const { unitsHolder, wielder, first } = world();
        const secondary: ISecondaryDamage[] = [];

        processFireforgedSwordOnVictims(
            wielder,
            [{ unitId: first.getId(), amount: 100 }],
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        expect(secondary).toHaveLength(0);
        expect(first.getCumulativeHp()).toBe(first.getCumulativeMaxHp());
    });
});
