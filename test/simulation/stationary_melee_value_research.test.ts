import { afterEach, describe, expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { stationaryMeleeValue } from "../../src/simulation/stationary_melee_value_research";
import { Spell } from "../../src/spells/spell";
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
function fixture(attacker: TestUnitOptions = {}, victim: TestUnitOptions = {}, responseSpent = true) {
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const unit = createTestUnit({ team: LEFT, attack: 10, damageMin: 21, damageMax: 29, ...attacker });
    const target = createTestUnit({ team: RIGHT, armor: 10, maxHp: 1000, ...victim });
    const stand = { x: 8, y: 8 };
    placeUnit(combat.grid, combat.unitsHolder, unit, stand);
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 9, y: 8 });
    unit.refreshPossibleAttackTypes(false);
    unit.selectAttackType(PBTypes.AttackVals.MELEE);
    const fight = FightStateManager.getInstance().getFightProperties();
    if (responseSpent) fight.addRepliedAttack(target.getId());
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        attackHandler: combat.attackHandler,
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: fight,
        decisionOrigin: "root",
    };
    const actions: GameAction[] = [
        { type: "melee_attack", attackerId: unit.getId(), targetId: target.getId(), attackFrom: stand },
    ];
    const estimate = () => stationaryMeleeValue(unit, target, context, stand, actions);
    const strike = (missRoll: number, damageRoll: number) => {
        let draws = 0;
        setDeterministicRandomSource(() => {
            const value = [missRoll, damageRoll][Math.floor(draws / 2)] ?? 99;
            return draws++ % 2 === 0 ? 0 : value / 0x100000000;
        });
        const hp = target.getCumulativeHp();
        const result = combat.attackHandler.handleMeleeAttack(
            combat.unitsHolder,
            new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
            createVisibleDamage(target),
            undefined,
            unit,
            target,
            stand,
        );
        expect(result.completed).toBe(true);
        return hp - target.getCumulativeHp();
    };
    return { ...combat, unit, target, context, stand, actions, estimate, strike };
}
afterEach(() => setDeterministicRandomSource(undefined));

describe("stationary melee value research", () => {
    test("matches all engine damage rolls with affinity and the ranged melee penalty", () => {
        const attacker = { attackType: PBTypes.AttackVals.RANGE, rangeShots: 6, abilities: ["Fire Element"] };
        const victim = { abilities: ["Water Element"] };
        const projected = fixture(attacker, victim).estimate()!;
        const actual = Array.from({ length: 8 }, (_, raw) => fixture(attacker, victim).strike(99, raw));
        expect(projected.effective).toBe(actual.reduce((sum, value) => sum + value, 0) / actual.length);
        expect(projected.kill).toBe(0);
    });

    test("prices the integer miss roll and caps each outcome before taking its mean", () => {
        const make = () => {
            const f = fixture({}, { maxHp: 25 });
            f.unit.calculateMissChance = () => 20.5;
            return f;
        };
        const projected = make().estimate()!;
        let total = 0;
        for (let miss = 0; miss < 100; miss++)
            for (let damage = 0; damage < 8; damage++) total += make().strike(miss, damage);
        expect(projected.effective).toBeCloseTo(total / 800, 10);
        expect(projected.kill).toBe(0);
        const f = make();
        const legacy = enumerateCandidates(f.unit, f.context, f.actions, { enrichIncumbentMetadata: true });
        expect(legacy.candidates[0].features.expectedDamage).toBeGreaterThan(projected.effective);
        expect(legacy.candidates[0].features.expectedKill).toBe(1);
    });

    test("requires every landed outcome to kill and preserves an intact absorb shield", () => {
        expect(fixture({}, { maxHp: 20 }).estimate()).toEqual({ effective: 20, kill: 1 });
        const f = fixture({}, { maxHp: 20 });
        f.target.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        expect(f.estimate()).toEqual({ effective: 0, kill: 0 });
        expect(f.target.hasBuffActive("Water Shield")).toBe(true);
        expect(f.strike(99, 0)).toBe(0);
    });

    test("does not change engine state, candidates or combat randomness", () => {
        const f = fixture();
        const state = () => JSON.stringify([...f.unitsHolder.getAllUnits().values()].map((u) => u.getUnitProperties()));
        const before = state();
        const actions = JSON.stringify(f.actions);
        setDeterministicRandomSource(() => {
            throw new Error("Research projection consumed RNG");
        });
        expect(f.estimate()).toBeDefined();
        expect(state()).toBe(before);
        expect(JSON.stringify(f.actions)).toBe(actions);
    });

    test("leaves responses, movement, rollout contexts and missing fight state unsupported", () => {
        expect(fixture({}, {}, false).estimate()).toBeUndefined();
        const f = fixture();
        const moved: GameAction[] = [{ type: "move_unit", unitId: f.unit.getId(), path: [f.stand] }, ...f.actions];
        expect(stationaryMeleeValue(f.unit, f.target, f.context, f.stand, moved)).toBeUndefined();
        expect(
            stationaryMeleeValue(f.unit, f.target, { ...f.context, decisionOrigin: "rollout" }, f.stand, f.actions),
        ).toBeUndefined();
        expect(
            stationaryMeleeValue(f.unit, f.target, { ...f.context, fightProperties: undefined }, f.stand, f.actions),
        ).toBeUndefined();
    });

    test.each(["Double Punch", "Lightning Spin", "Fire Breath", "Skewer Strike", "Petrifying Gaze"])(
        "keeps the existing %s sequence estimate",
        (ability) => expect(fixture({ abilities: [ability] }).estimate()).toBeUndefined(),
    );
});
