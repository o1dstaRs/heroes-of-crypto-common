import { afterEach, describe, expect, test } from "bun:test";

import { EMBER_COVENANT_BLESSING as NAME } from "../../src/abilities/ember_covenant";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { IVisibleDamage } from "../../src/scene/animations";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

function dragonAttack(blessedTeam: number) {
    const f = createCombatTestContext();
    const dragon = createTestUnit({
        name: "Black Dragon",
        team: PBTypes.TeamVals.LEFT,
        abilities: getCreatureConfig(PBTypes.TeamVals.LEFT, "Chaos", "Black Dragon", "", 1).abilities,
        size: PBTypes.UnitSizeVals.LARGE,
        movementType: PBTypes.MovementVals.FLY,
        maxHp: 1000,
        damageMin: 20,
        damageMax: 20,
    });
    const target = createTestUnit({ team: PBTypes.TeamVals.RIGHT, maxHp: 1000, abilities: ["No Melee"] });
    const behind = createTestUnit({ team: blessedTeam, maxHp: 1000 });
    const hydra = createTestUnit({ team: blessedTeam, abilities: [NAME] });
    placeUnit(f.grid, f.unitsHolder, dragon, { x: 3, y: 5 });
    placeUnit(f.grid, f.unitsHolder, target, { x: 4, y: 5 });
    placeUnit(f.grid, f.unitsHolder, behind, { x: 5, y: 5 });
    placeUnit(f.grid, f.unitsHolder, hydra, { x: 9, y: 8 });
    f.unitsHolder.seedEmberCovenant();
    setDeterministicRandomSource(() => 0);
    const strike = () => {
        const damage: IVisibleDamage = { ...createVisibleDamage(target), hits: [] };
        const result = f.attackHandler.handleMeleeAttack(
            f.unitsHolder,
            new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
            damage,
            undefined,
            dragon,
            target,
            { x: 3, y: 5 },
        );
        expect(result.completed).toBe(true);
        return damage;
    };
    return { ...f, dragon, target, behind, hydra, strike };
}

describe("Black Dragon's physical hit and fire breath against Ember Covenant", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    test("the bite is absorbed and dissolves the covenant after the protected unit behind blocks the breath", () => {
        const f = dragonAttack(PBTypes.TeamVals.RIGHT);
        const targetHp = f.target.getCumulativeHp();
        const behindHp = f.behind.getCumulativeHp();
        const first = f.strike();
        expect(first.hits?.[0].amount).toBe(0);
        expect(
            first.secondary?.find((hit) => hit.source === "fire_breath" && hit.unitId === f.behind.getId())?.amount,
        ).toBe(0);
        expect(f.target.getCumulativeHp()).toBe(targetHp);
        expect(f.behind.getCumulativeHp()).toBe(behindHp);
        for (const unit of [f.target, f.behind, f.hydra]) expect(unit.hasBuffActive(NAME)).toBe(false);

        const second = f.strike();
        expect(second.hits?.[0].amount).toBeGreaterThan(0);
        expect(f.target.getCumulativeHp()).toBeLessThan(targetHp);
        expect(f.behind.getCumulativeHp()).toBeLessThan(behindHp);
    });

    test("breath alone cannot dissolve the covenant on a protected ally behind an unprotected enemy", () => {
        const f = dragonAttack(PBTypes.TeamVals.LEFT);
        const targetHp = f.target.getCumulativeHp();
        const behindHp = f.behind.getCumulativeHp();
        const damage = f.strike();
        expect(damage.hits?.[0].amount).toBeGreaterThan(0);
        expect(f.target.getCumulativeHp()).toBeLessThan(targetHp);
        expect(f.behind.getCumulativeHp()).toBe(behindHp);
        expect(
            damage.secondary?.find((hit) => hit.source === "fire_breath" && hit.unitId === f.behind.getId())?.amount,
        ).toBe(0);
        expect(f.behind.hasBuffActive(NAME)).toBe(true);
        expect(f.hydra.hasBuffActive(NAME)).toBe(true);
    });
});
