/*
 * -----------------------------------------------------------------------------
 * The Fireforged Sword card promises that melee and ranged attacks, area attacks
 * included, set every unit they damage alight. It used to fire on three paths only
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
import { fireforgedSwordDamage } from "../../src/spells/spell_damage";
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

/** 20% of one landed hit, the number the blade owes that creature. */
const burnFor = (damageDealt: number): number =>
    fireforgedSwordDamage({
        damageDealt,
        swordPercentage: 20,
        targetMagicResist: 0,
        targetIsFireElement: false,
        targetIsWaterElement: false,
    });

/** Every physical hit in `hits` has its own fire, for 20% of that hit and no one else's. */
const expectEachHitBurned = (
    hits: readonly { unitId: string; amount: number }[],
    burns: readonly ISecondaryDamage[],
): void => {
    const landed = hits.filter((hit) => hit.amount > 0);
    expect(landed.length).toBeGreaterThan(1);
    expect(burns.map((burn) => burn.amount).sort((a, b) => a - b)).toEqual(
        landed.map((hit) => burnFor(hit.amount)).sort((a, b) => a - b),
    );
    expect(new Set(burns.map((burn) => burn.unitId))).toEqual(new Set(landed.map((hit) => hit.unitId)));
};

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

    it("burns the creature a Pikeman's Skewer Strike pierces, for that pierce's own damage", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const pikeman = createTestUnit({
            name: "Pikeman",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            abilities: ["Skewer Strike"],
            damageMin: 20,
            damageMax: 20,
            maxHp: 200,
            amountAlive: 3,
        });
        const front = createTestUnit({
            name: "Front",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 400,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });
        const behind = createTestUnit({
            name: "Behind",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 400,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });
        giveSword(pikeman);
        placeUnit(grid, unitsHolder, pikeman, { x: 5, y: 4 });
        placeUnit(grid, unitsHolder, front, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 6 });

        const damage = createVisibleDamage(front);
        const result = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, pikeman, front, {
            x: 5,
            y: 4,
        });

        expect(result.completed).toBe(true);
        const pierced = (damage.secondary ?? []).find(
            (entry) => entry.source === "skewer_strike" && entry.unitId === behind.getId(),
        );
        expect(pierced?.amount).toBeGreaterThan(0);
        const burns = swordBurns(damage.secondary);
        expect(burns.find((burn) => burn.unitId === front.getId())?.amount).toBe(burnFor(damage.amount));
        expect(burns.find((burn) => burn.unitId === behind.getId())?.amount).toBe(burnFor(pierced?.amount ?? 0));
    });

    it("burns every enemy a Hydra's Lightning Spin reaches, each for its own spin", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const hydra = createTestUnit({
            name: "Hydra",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            abilities: ["Lightning Spin"],
            damageMin: 20,
            damageMax: 20,
            maxHp: 300,
            amountAlive: 3,
        });
        const aimed = createTestUnit({
            name: "Aimed",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 500,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });
        const beside = createTestUnit({
            name: "Beside",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 500,
            amountAlive: 5,
            damageMin: 0,
            damageMax: 0,
        });
        giveSword(hydra);
        placeUnit(grid, unitsHolder, hydra, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, aimed, { x: 5, y: 4 });
        placeUnit(grid, unitsHolder, beside, { x: 4, y: 5 });

        const damage = createVisibleDamage(aimed);
        const result = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, hydra, aimed, {
            x: 4,
            y: 4,
        });

        expect(result.completed).toBe(true);
        const spins = (damage.secondary ?? []).filter((entry) => entry.source === "lightning_spin");
        expect(spins.map((entry) => entry.unitId).sort()).toEqual([aimed.getId(), beside.getId()].sort());
        // The spin replaces the swing, so the fire on each creature is 20% of that creature's spin.
        expectEachHitBurned(spins, swordBurns(damage.secondary));
    });

    it("burns every creature a Gargantuan's Area Throw splashes, each for its own share", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const gargantuan = createTestUnit({
            name: "Gargantuan",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Area Throw", "Double Throw"],
            damageMin: 30,
            damageMax: 30,
            rangeShots: 4,
            stackPower: 5,
            armor: 0,
            maxHp: 300,
            amountAlive: 2,
        });
        const first = createTestUnit({
            name: "First",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 800,
            amountAlive: 6,
        });
        const second = createTestUnit({
            name: "Second",
            team: PBTypes.TeamVals.RIGHT,
            armor: 0,
            magicResist: 0,
            maxHp: 800,
            amountAlive: 6,
        });
        giveSword(gargantuan);
        placeUnit(grid, unitsHolder, gargantuan, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, first, { x: 8, y: 2 });
        placeUnit(grid, unitsHolder, second, { x: 8, y: 3 });

        const damage = createVisibleDamage(first);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            damage,
            gargantuan,
            [[first, second]],
            undefined,
            first.getPosition(),
            true,
        );

        expect(result.completed).toBe(true);
        expectEachHitBurned(damage.splash ?? [], swordBurns(damage.secondary));
    });

    it("burns every creature a Tsar Cannon's Through Shot pierces, each for its own share", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const cannon = createTestUnit({
            name: "Tsar Cannon",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Through Shot", "No Melee"],
            damageMin: 40,
            damageMax: 40,
            rangeShots: 4,
            armor: 0,
            maxHp: 300,
            amountAlive: 2,
        });
        const enemies = [0, 1, 2].map((index) =>
            createTestUnit({
                name: `Enemy${index}`,
                team: PBTypes.TeamVals.RIGHT,
                armor: 0,
                magicResist: 0,
                maxHp: 800,
                amountAlive: 6,
            }),
        );
        giveSword(cannon);
        placeUnit(grid, unitsHolder, cannon, { x: 2, y: 4 });
        enemies.forEach((enemy, index) => placeUnit(grid, unitsHolder, enemy, { x: 6 + index, y: 4 }));

        const damage = createVisibleDamage(enemies[0]);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1, 1, 1],
            1,
            damage,
            cannon,
            enemies.map((enemy) => [enemy]),
            undefined,
            enemies[0].getPosition(),
        );

        expect(result.completed).toBe(true);
        expectEachHitBurned(damage.splash ?? [], swordBurns(damage.secondary));
    });

    it("burns every creature a Zena's Chakram hits, including each bounce", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Chakram"],
            damageMin: 20,
            damageMax: 20,
            rangeShots: 4,
            stackPower: 5,
            armor: 0,
            maxHp: 200,
            amountAlive: 1,
        });
        const victims = (["Primary", "First", "Second"] as const).map((name, index) => {
            const unit = createTestUnit({
                name,
                team: PBTypes.TeamVals.RIGHT,
                armor: 0,
                magicResist: 0,
                maxHp: 400,
                amountAlive: 4,
            });
            // One open cell between each hop, the separation a chakram can curve through.
            placeUnit(grid, unitsHolder, unit, { x: 8 + index * 2, y: 8 + index * 2 });
            return unit;
        });
        giveSword(zena);
        placeUnit(grid, unitsHolder, zena, { x: 8, y: 2 });

        const damage = createVisibleDamage(victims[0]);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            damage,
            zena,
            [[victims[0]]],
            undefined,
            victims[0].getPosition(),
        );

        expect(result.completed).toBe(true);
        const struck = (damage.splash ?? []).filter((hit) => !hit.missed && hit.amount > 0);
        expect(struck.map((hit) => hit.unitId).sort()).toEqual(victims.map((unit) => unit.getId()).sort());
        expectEachHitBurned(struck, swordBurns(damage.secondary));
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
