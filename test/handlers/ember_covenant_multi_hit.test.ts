import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { EMBER_COVENANT_BLESSING as NAME } from "../../src/abilities/ember_covenant";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { IVisibleDamage } from "../../src/scene/animations";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

function attack(ability: string, fire: boolean, missFirst = false, water = false) {
    const f = createCombatTestContext();
    const ranged = ability.includes("Shot");
    const attacker = createTestUnit({
        name: ranged ? "Shooter" : "Wolf",
        team: PBTypes.TeamVals.RIGHT,
        attackType: ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        maxHp: 1000,
        amountAlive: 5,
        damageMin: 5,
        damageMax: 5,
        rangeShots: 10,
        abilities: [ability, "Stun", ...(fire ? ["Fire Element"] : []), ...(water ? ["Water Element"] : [])],
    });
    const target = createTestUnit({
        team: PBTypes.TeamVals.LEFT,
        maxHp: 1000,
        abilities: ["No Melee"],
    });
    const hydra = createTestUnit({ team: PBTypes.TeamVals.LEFT, abilities: [NAME] });
    placeUnit(f.grid, f.unitsHolder, attacker, { x: 5, y: 3 });
    placeUnit(f.grid, f.unitsHolder, target, { x: ranged ? 9 : 4, y: 3 });
    placeUnit(f.grid, f.unitsHolder, hydra, { x: 3, y: 7 });
    f.unitsHolder.seedEmberCovenant();
    attacker.refreshPossibleAttackTypes(true);
    setDeterministicRandomSource(() => 0);
    const miss = missFirst
        ? spyOn(attacker, "calculateMissChance").mockReturnValueOnce(100).mockReturnValue(0)
        : undefined;
    const damage: IVisibleDamage & { hits: NonNullable<IVisibleDamage["hits"]> } = {
        ...createVisibleDamage(target),
        hits: [],
    };
    const hp = target.getCumulativeHp();
    try {
        const result = ranged
            ? f.attackHandler.handleRangeAttack(
                  f.unitsHolder,
                  [1],
                  1,
                  damage,
                  attacker,
                  [[target]],
                  undefined,
                  target.getPosition(),
              )
            : f.attackHandler.handleMeleeAttack(
                  f.unitsHolder,
                  new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
                  damage,
                  undefined,
                  attacker,
                  target,
                  { x: 5, y: 3 },
              );
        expect(result.completed).toBe(true);
    } finally {
        miss?.mockRestore();
    }
    return { ...f, target, hydra, damage, hpLost: hp - target.getCumulativeHp() };
}

describe("Ember Covenant absorbs individual hits of a double attack", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    for (const ability of ["Double Punch", "Crafted Double Punch", "Double Shot", "Crafted Double Shot"]) {
        test(`${ability}: absorbs the first ordinary hit, dissolves, then takes the second`, () => {
            const f = attack(ability, false);
            expect(f.damage.hits).toHaveLength(2);
            expect(f.damage.hits[0].amount).toBe(0);
            expect(f.damage.hits[1].amount).toBeGreaterThan(0);
            expect(f.hpLost).toBe(f.damage.hits[1].amount);
            expect(f.target.hasBuffActive(NAME)).toBe(false);
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
        });

        test(`${ability}: blocks both fire hits without dissolving`, () => {
            const f = attack(ability, true);
            expect(f.hpLost).toBe(0);
            expect(f.damage.hits).toHaveLength(2);
            expect(f.damage.hits.every((hit) => hit.amount === 0)).toBe(true);
            expect(f.target.hasBuffActive(NAME)).toBe(true);
            expect(f.hydra.hasBuffActive(NAME)).toBe(true);
            expect(f.target.hasEffectActive("Stun")).toBe(false);
        });

        test(`${ability}: a missed first hit leaves the covenant to absorb the second`, () => {
            const f = attack(ability, false, true);
            expect(f.hpLost).toBe(0);
            expect(f.damage.hits.every((hit) => hit.amount === 0)).toBe(true);
            expect(f.target.hasBuffActive(NAME)).toBe(false);
            expect(f.hydra.hasBuffActive(NAME)).toBe(false);
            expect(f.target.hasEffectActive("Stun")).toBe(false);
        });

        for (const fire of [false, true]) {
            test(`${ability}: water ${fire ? "with fire" : "alone"} bypasses the covenant on both hits`, () => {
                const f = attack(ability, fire, false, true);
                expect(f.damage.hits).toHaveLength(2);
                expect(f.damage.hits.every((hit) => hit.amount > 0)).toBe(true);
                expect(f.hpLost).toBe(f.damage.hits.reduce((total, hit) => total + hit.amount, 0));
                expect(f.target.hasBuffActive(NAME)).toBe(false);
                expect(f.hydra.hasBuffActive(NAME)).toBe(false);
            });
        }
    }
});
