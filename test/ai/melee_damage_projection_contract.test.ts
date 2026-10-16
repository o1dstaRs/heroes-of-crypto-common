import { afterEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { estimatePrimaryMeleeDamage } from "../../src/ai/melee_damage_estimate";
import { getCreatureConfig, getEffectConfig, getSpellConfig } from "../../src/configuration/config_provider";
import CREATURES_JSON from "../../src/configuration/creatures.json";
import { Effect } from "../../src/effects/effect";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
    type TestUnitOptions,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const elements = [undefined, "Fire Element", "Water Element", "Wind Element", "Earth Element"] as const;

function catalogUnit(name: string, team: TeamType, amount: number): Unit {
    const faction = Object.entries(CREATURES_JSON).find(([, creatures]) => Object.hasOwn(creatures, name))![0];
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

function fixture(
    attackerOptions: TestUnitOptions = {},
    targetOptions: TestUnitOptions = {},
    catalogNames?: readonly [string, string],
) {
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const team = attackerOptions.team ?? LEFT;
    const attacker = catalogNames
        ? catalogUnit(catalogNames[0], team, 1)
        : createTestUnit({
              team,
              attack: 10,
              damageMin: 21,
              damageMax: 29,
              maxHp: 100_000,
              ...attackerOptions,
          });
    const target = catalogNames
        ? catalogUnit(catalogNames[1], team === LEFT ? RIGHT : LEFT, 1000)
        : createTestUnit({ team: team === LEFT ? RIGHT : LEFT, maxHp: 100_000, armor: 10, ...targetOptions });
    target.deleteBuff("Water Shield");
    const stand = { x: 8, y: 8 };
    placeUnit(combat.grid, combat.unitsHolder, attacker, stand);
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 8 + target.getFootprintWidth(), y: 8 });
    attacker.refreshPossibleAttackTypes(false);
    attacker.selectAttackType(MELEE);
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.addRepliedAttack(target.getId());
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(combat.grid.getSettings()),
        attackHandler: combat.attackHandler,
        fightProperties: fight,
    };
    const actions: GameAction[] = [
        { type: "melee_attack", attackerId: attacker.getId(), targetId: target.getId(), attackFrom: stand },
    ];
    const project = () => {
        const state = () =>
            JSON.stringify(
                [...combat.unitsHolder.getAllUnits().values()].map((u) => [u.getPosition(), u.getUnitProperties()]),
            );
        const before = state();
        setDeterministicRandomSource(() => {
            throw new Error("Melee projection must not consume combat randomness");
        });
        const result = estimatePrimaryMeleeDamage(attacker, target, context, stand, actions);
        expect(state()).toBe(before);
        return result;
    };
    const strike = (rolls: readonly number[] = [99, 0]) => {
        let draw = 0;
        setDeterministicRandomSource(() => {
            const roll = rolls[Math.floor(draw / 2)] ?? 99;
            return draw++ % 2 === 0 ? 0 : roll / 0x100000000;
        });
        const hp = target.getCumulativeHp();
        const result = combat.attackHandler.handleMeleeAttack(
            combat.unitsHolder,
            new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
            createVisibleDamage(target),
            undefined,
            attacker,
            target,
            stand,
        );
        expect(result.completed).toBe(true);
        return hp - target.getCumulativeHp();
    };
    return { ...combat, attacker, target, fight, context, stand, actions, project, strike };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("AI primary melee damage uses the combat projection", () => {
    for (const team of [LEFT, RIGHT] as const) {
        for (const element of elements) {
            test.each(elements)(`element=${element ?? "none"}, team=${team}, defender=%s`, (defenderElement) => {
                const options = { team, abilities: element ? [element] : [] };
                const target = { abilities: defenderElement ? [defenderElement] : [] };
                const estimate = fixture(options, target).project()!;
                const resolved = Array.from({ length: 8 }, (_, raw) => fixture(options, target).strike([99, raw]));
                const histogram = new Map<number, number>();
                for (const damage of resolved) histogram.set(damage, (histogram.get(damage) ?? 0) + 1 / 8);
                expect(
                    new Map(estimate.landedOutcomes.map((outcome) => [outcome.damage, outcome.probability])),
                ).toEqual(histogram);
                expect(estimate.expectedEffectiveDamage).toBe(resolved.reduce((sum, damage) => sum + damage, 0) / 8);
            });
        }
    }

    test.each([
        { footprintWidth: 1, footprintHeight: 2 },
        { footprintWidth: 2, footprintHeight: 1 },
        { size: PBTypes.UnitSizeVals.LARGE },
    ])("preserves elemental damage on rectangular and large defenders %j", (shape) => {
        const attacker = { abilities: ["Fire Element"] };
        const target = { ...shape, abilities: ["Water Element"] };
        const estimate = fixture(attacker, target).project()!;
        const actual = Array.from({ length: 8 }, (_, raw) => fixture(attacker, target).strike([99, raw]));
        expect(estimate.expectedEffectiveDamage).toBe(actual.reduce((a, b) => a + b, 0) / 8);
    });

    test.each([false, true])("keeps one floor for a ranged unit's melee hit, Handyman=%s", (handyman) => {
        const attacker = {
            attackType: RANGE,
            rangeShots: 6,
            abilities: ["Fire Element", ...(handyman ? ["Handyman"] : [])],
        };
        const target = { abilities: ["Water Element"] };
        const estimate = fixture(attacker, target).project()!;
        const actual = Array.from({ length: 8 }, (_, raw) => fixture(attacker, target).strike([99, raw]));
        expect(estimate.expectedEffectiveDamage).toBe(actual.reduce((a, b) => a + b, 0) / 8);
    });

    test("combines Paralysis, Deep Wounds and elemental affinity in the engine's flooring order", () => {
        const setup = () => {
            const f = fixture({ abilities: ["Fire Element", "Deep Wounds Level 1"] }, { abilities: ["Water Element"] });
            f.attacker.applyEffect(new Effect({ ...getEffectConfig("Paralysis"), power: 7 }));
            f.target.applyEffect(new Effect({ ...getEffectConfig("Deep Wounds"), power: 23 }));
            return f;
        };
        const estimate = setup().project()!;
        const actual = Array.from({ length: 8 }, (_, raw) => setup().strike([99, raw]));
        expect(estimate.expectedEffectiveDamage).toBe(actual.reduce((a, b) => a + b, 0) / 8);
    });

    test("Penetrating Bite is added after the elemental base hit", () => {
        const attacker = { abilities: ["Fire Element", "Penetrating Bite"] };
        const target = { abilities: ["Water Element"] };
        const estimate = fixture(attacker, target).project()!;
        const actual = Array.from({ length: 8 }, (_, raw) => fixture(attacker, target).strike([99, raw]));
        expect(estimate.expectedEffectiveDamage).toBe(actual.reduce((a, b) => a + b, 0) / 8);
    });

    test("fractional Lucky Strike chances match the integer engine roll", () => {
        const setup = () => {
            const f = fixture({ abilities: ["Lucky Strike"], damageMin: 40, damageMax: 40 });
            f.attacker.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Made of Fire"), amount: 1 }));
            return f;
        };
        const original = setup();
        expect(
            original.attacker.calculateAbilityApplyChance(original.attacker.getAbility("Lucky Strike")!, 0),
        ).toBeCloseTo(8.8, 8);
        const estimate = original.project()!;
        const actual = Array.from({ length: 100 }, (_, roll) => setup().strike([99, roll]));
        expect(estimate.expectedEffectiveDamage).toBeCloseTo(actual.reduce((a, b) => a + b, 0) / 100, 8);
    });

    test("caps expected elemental damage at the remaining stack HP and marks a certain kill", () => {
        const f = fixture(
            { abilities: ["Fire Element"], damageMin: 20, damageMax: 20 },
            { abilities: ["Water Element"], maxHp: 25 },
        );
        expect(f.project()).toMatchObject({ expectedEffectiveDamage: 25, secureKill: true });
        expect(f.strike()).toBe(25);
    });

    test.each([
        ["Efreet", "Mermaid"],
        ["Gargantuan", "Thunderbird"],
        ["Trent", "Thunderbird"],
    ] as const)("matches the native %s kit against %s", (attackerName, defenderName) => {
        const setup = () => fixture({}, {}, [attackerName, defenderName]);
        const original = setup();
        const estimate = original.project()!;
        expect(estimate).toBeDefined();
        expect(original.attacker.getElementalDamageMultiplier(original.target)).toBe(1.5);
        const min = original.attacker.calculateAttackDamageMin(
            original.attacker.getAttack(),
            original.target,
            false,
            0,
        );
        const max = original.attacker.calculateAttackDamageMax(
            original.attacker.getAttack(),
            original.target,
            false,
            0,
        );
        const actual = Array.from({ length: Math.max(1, max - min) }, (_, raw) => setup().strike([99, raw]));
        expect(estimate.expectedEffectiveDamage).toBeCloseTo(actual.reduce((a, b) => a + b, 0) / actual.length, 8);
    });
});
