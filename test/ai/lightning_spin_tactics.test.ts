import { afterEach, expect, test } from "bun:test";

import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { estimateLightningSpinPotential } from "../../src/ai/lightning_spin_tactics";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));

function board(options: TestUnitOptions = {}, enemyOptions: TestUnitOptions = {}) {
    const combat = createCombatTestContext();
    const hydra = createTestUnit({
        name: "Hydra",
        team: LEFT,
        maxHp: 190,
        stackPower: 100,
        damageMin: 100,
        damageMax: 100,
        abilities: ["Lightning Spin", "Devour Essence", "Ember Covenant Blessing"],
        ...options,
    });
    const a = createTestUnit({ name: "First", team: RIGHT, maxHp: 1000, ...enemyOptions });
    const b = createTestUnit({ name: "Second", team: RIGHT, maxHp: 1000, ...enemyOptions });
    const stand = { x: 5, y: 5 };
    placeUnit(combat.grid, combat.unitsHolder, hydra, stand);
    placeUnit(combat.grid, combat.unitsHolder, a, { x: 6, y: 5 });
    placeUnit(combat.grid, combat.unitsHolder, b, { x: 5, y: 6 });
    const fight = FightStateManager.getInstance().getFightProperties();
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fight,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const estimate = () => estimateLightningSpinPotential(hydra, context, stand, []);
    return { ...combat, context, fight, hydra, a, b, stand, estimate };
}

test("spin ranks the whole footprint without RNG, HP or shield mutation", () => {
    const f = board({ size: PBTypes.UnitSizeVals.LARGE });
    let draws = 0;
    setDeterministicRandomSource(() => {
        draws++;
        return 0;
    });
    const result = f.estimate()!;
    expect(result.expectedDirectDamage).toBe(200);
    expect(result.secureKill).toBe(false);
    expect(result.healingPotential).toBe(0);
    expect(f.a.getCumulativeHp()).toBe(1000);
    expect(f.hydra.getHp()).toBe(190);
    expect(draws).toBe(0);
});

test("one shared Covenant absorbs one spin impact, not every enemy independently", () => {
    const f = board({}, { abilities: ["Ember Covenant Blessing"] });
    f.unitsHolder.seedEmberCovenant();
    expect(f.estimate()!.expectedDirectDamage).toBe(100);
    expect(f.a.hasStatusBuffApplied("Ember Covenant Blessing")).toBe(true);
    expect(f.b.hasStatusBuffApplied("Ember Covenant Blessing")).toBe(true);
});

test("personal Water Shields remain separate from the shared Covenant", () => {
    const f = board({}, { abilities: ["Ember Covenant Blessing", "Water Shield"] });
    f.unitsHolder.seedEmberCovenant();
    f.a.trySeedWaterShield();
    f.b.trySeedWaterShield();
    expect(f.estimate()!.expectedDirectDamage).toBe(0);
    expect(f.a.willWaterShieldAbsorb(f.hydra)).toBe(true);
});

test("water bypasses Covenant while physical Fire Element attacks still consume its shared hit", () => {
    for (const element of ["Water Element", "Fire Element"]) {
        const f = board({ abilities: ["Lightning Spin", element] }, { abilities: ["Ember Covenant Blessing"] });
        f.unitsHolder.seedEmberCovenant();
        expect(f.estimate()!.expectedDirectDamage).toBe(element === "Water Element" ? 200 : 100);
    }
});

test("Devour values only the wounded front creature, once even for multiple stack kills", () => {
    const f = board({ amountAlive: 2 }, { maxHp: 10 });
    f.hydra.applyDamage(250, 0, new SceneLogMock(), false);
    expect(f.hydra.getAmountAlive()).toBe(1);
    const before = f.hydra.getHp();
    expect(f.estimate()!.secureKill).toBe(true);
    expect(f.estimate()!.healingPotential).toBe(190 - before);
    expect(f.hydra.getAmountAlive()).toBe(1);
    expect(f.hydra.getHp()).toBe(before);
});

test("self-resurrection does not advertise a Devour heal", () => {
    const f = board({}, { maxHp: 10, spells: ["Resurrection"] });
    // A plain spellbook is not necessarily self-resurrection; use the engine's eligibility predicate.
    f.a.canSelfResurrect = () => true;
    f.b.canSelfResurrect = () => true;
    f.hydra.applyDamage(80, 0, new SceneLogMock(), false);
    expect(f.estimate()!.healingPotential).toBe(0);
});

test("historical catalogs stay unchanged; spin-aware catalogs remove duplicate primaries per stand", () => {
    const f = board();
    const incumbent = [{ type: "defend_turn" as const, unitId: f.hydra.getId() }];
    const old = enumerateCandidates(f.hydra, f.context, incumbent, {}).candidates.filter((c) => c.kind === "melee");
    const improved = enumerateCandidates(f.hydra, f.context, incumbent, {
        includeLightningSpinCoverage: true,
    }).candidates.filter((c) => c.kind === "melee");
    expect(old.filter((c) => c.standCell?.x === 5 && c.standCell.y === 5)).toHaveLength(2);
    expect(improved.filter((c) => c.standCell?.x === 5 && c.standCell.y === 5)).toHaveLength(1);
    expect(improved.find((c) => c.standCell?.x === 5 && c.standCell.y === 5)!.features.expectedDamage).toBe(200);
});

test("the capped catalog retains a stronger real-engine spin than primary-target ranking", () => {
    const f = board({ size: PBTypes.UnitSizeVals.LARGE }, { maxHp: 10 });
    f.hydra.getSteps = () => 6.1;
    const strong = createTestUnit({ team: RIGHT, maxHp: 1000, abilities: ["Water Shield"] });
    strong.trySeedWaterShield();
    placeUnit(f.grid, f.unitsHolder, strong, { x: 8, y: 5 });
    f.grid.cleanupAll(f.a.getId(), f.a.getAttackRange(), f.a.isSmallSize());
    f.grid.cleanupAll(f.b.getId(), f.b.getAttackRange(), f.b.isSmallSize());
    placeUnit(f.grid, f.unitsHolder, f.a, { x: 4, y: 6 });
    placeUnit(f.grid, f.unitsHolder, f.b, { x: 4, y: 3 });
    f.context.matrix = f.grid.getMatrix();
    const incumbent = [{ type: "defend_turn" as const, unitId: f.hydra.getId() }];
    const first = (enabled: boolean) =>
        enumerateCandidates(f.hydra, f.context, incumbent, {
            maxMeleePairs: 1,
            includeLightningSpinCoverage: enabled,
        }).candidates.find((c) => c.kind === "melee")!;
    const old = first(false);
    const improved = first(true);
    const observe = (stand: { x: number; y: number }) => {
        const hp = f.a.getCumulativeHp() + f.b.getCumulativeHp() + strong.getCumulativeHp();
        setDeterministicRandomSource(() => 0);
        processLightningSpinAbility(f.hydra, new SceneLogMock(), f.unitsHolder, 1, f.damageStatisticHolder, stand);
        return hp - f.a.getCumulativeHp() - f.b.getCumulativeHp() - strong.getCumulativeHp();
    };
    // The historical catalog spends its only slot on a fully shielded high-HP primary. Observe the
    // actual combat processor, rather than grading the new estimator with its own arithmetic.
    expect(observe(old.standCell!)).toBe(0);
    expect(observe(improved.standCell!)).toBe(20);
});

test("direct spin estimates agree with combat across shields, elements and both board sides", () => {
    for (const team of [LEFT, RIGHT])
        for (const element of [undefined, "Water Element", "Fire Element"]) {
            for (const defenses of [
                [],
                ["Water Shield"],
                ["Ember Covenant Blessing"],
                ["Water Shield", "Ember Covenant Blessing"],
            ]) {
                const f = board(
                    {
                        team,
                        size: PBTypes.UnitSizeVals.LARGE,
                        abilities: ["Lightning Spin", ...(element ? [element] : [])],
                    },
                    { team: team === LEFT ? RIGHT : LEFT, abilities: defenses },
                );
                f.unitsHolder.seedEmberCovenant();
                f.a.trySeedWaterShield();
                f.b.trySeedWaterShield();
                const estimated = f.estimate()!.expectedDirectDamage;
                const hp = f.a.getCumulativeHp() + f.b.getCumulativeHp();
                setDeterministicRandomSource(() => 0);
                processLightningSpinAbility(
                    f.hydra,
                    new SceneLogMock(),
                    f.unitsHolder,
                    1,
                    f.damageStatisticHolder,
                    f.stand,
                );
                expect(hp - f.a.getCumulativeHp() - f.b.getCumulativeHp()).toBeCloseTo(estimated, 10);
            }
        }
});

test("misses and zero damage do not incorrectly spend a shared shield", () => {
    const f = board({}, { abilities: ["Ember Covenant Blessing"] });
    f.unitsHolder.seedEmberCovenant();
    const first = f.unitsHolder.allEnemiesAroundUnit(f.hydra, true, f.stand)[0];
    f.hydra.calculateMissChance = (target) => (target === first ? 100 : 0);
    expect(f.estimate()!.expectedDirectDamage).toBe(0);
    f.hydra.calculateMissChance = () => 0;
    first.getPhysicalAoeDamageMultiplier = () => 0;
    expect(f.estimate()!.expectedDirectDamage).toBe(0);
    f.hydra.calculateMissChance = () => 100;
    expect(f.estimate()!.expectedDirectDamage).toBe(0);
    expect(f.estimate()!.secureKill).toBe(false);
});
