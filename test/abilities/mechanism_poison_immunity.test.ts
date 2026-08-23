/*
 * -----------------------------------------------------------------------------
 * Mechanism constructs (the Tsar Cannon) cannot be poisoned. The ability text has
 * always promised "Invulnerable to Mind attacks and spells, poison and vampirism",
 * but nothing enforced the poison half: a Wyvern's Venom Cloud tick corroded a
 * siege engine exactly as if it were flesh.
 *
 * The guard sits in applyPoisonEffect, the single chokepoint every route funnels
 * through, so these pin both a direct application and the aura route.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { applyPoisonEffect } from "../../src/abilities/poison_ability";
import { processPoisonAuraAbility } from "../../src/abilities/poison_aura_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const silentSceneLog = () => {
    const lines: string[] = [];
    return {
        lines,
        log: {
            getLog: () => lines.join("\n"),
            updateLog: (line?: string) => {
                if (line) lines.push(line);
            },
            hasBeenUpdated: () => lines.length > 0,
        },
    };
};

const makeCannon = () =>
    createTestUnit({
        name: "Tsar Cannon",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 200,
        abilities: ["Mechanism"],
    });

describe("Mechanism poison immunity", () => {
    it("reports itself unpoisonable, unlike flesh-and-blood units", () => {
        createCombatTestContext();
        expect(makeCannon().canBePoisoned()).toBe(false);
        expect(createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.UPPER }).canBePoisoned()).toBe(true);
    });

    it("takes no Poison from a direct application, and logs nothing", () => {
        createCombatTestContext();
        const cannon = makeCannon();
        const { log, lines } = silentSceneLog();

        applyPoisonEffect(cannon, 40, log);

        expect(cannon.getEffect("Poison")).toBeUndefined();
        expect(lines).toEqual([]);
    });

    it("stays clean under a Venom Cloud ally's hit that would poison anything else", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const wyvern = createTestUnit({
            name: "Wyvern",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
            abilities: ["Venom Cloud Aura"],
            auraEffects: ["Venom Cloud"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LOWER, attack: 10 });
        const cannon = makeCannon();
        const flesh = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 200 });

        placeUnit(grid, unitsHolder, wyvern, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, ally, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, cannon, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, flesh, { x: 3, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();

        processPoisonAuraAbility(ally, cannon, 100, silentSceneLog().log);
        processPoisonAuraAbility(ally, flesh, 100, silentSceneLog().log);

        // Same aura, same ally, same hit — only the construct shrugs it off.
        expect(cannon.getEffect("Poison")).toBeUndefined();
        expect(flesh.getEffect("Poison")?.getPower()).toBeGreaterThan(0);
    });

    it("cannot be stacked onto even after repeated poisonings", () => {
        createCombatTestContext();
        const cannon = makeCannon();
        const { log } = silentSceneLog();

        for (let i = 0; i < 5; i++) {
            applyPoisonEffect(cannon, 40, log);
        }

        expect(cannon.getEffect("Poison")).toBeUndefined();
    });
});
