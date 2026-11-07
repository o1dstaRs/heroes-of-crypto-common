import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const DEBUFFS = ["Curse", "Sadness", "Quagmire", "Weakening Beam", "Weakness", "Rangebane", "Cowardice"];
const SHOOTERS = {
    Elf: "Nature",
    Gargantuan: "Nature",
    "Tsar Cannon": "Life",
    Beholder: "Chaos",
    Medusa: "Chaos",
} as const;
type Shooter = keyof typeof SHOOTERS;
type Rider = "Stun" | "Freeze" | "Quagmire";

afterEach(() => {
    setDeterministicRandomSource(undefined);
    mock.restore();
});

/** One specified integer per RNG call; fixed damage avoids unrelated damage-band draws. */
function rolls(values: number[]): () => void {
    let draws = 0;
    setDeterministicRandomSource(() => {
        const index = Math.floor(draws / 2);
        if (index >= values.length) throw new Error(`Unexpected RNG call after ${values.length} planned rolls`);
        return draws++ % 2 === 0 ? 0 : values[index] / 0x100000000;
    });
    return () => expect(draws).toBe(values.length * 2);
}

function fixture(
    name: Shooter,
    options: {
        rider?: Rider;
        double?: boolean;
        dodge?: boolean;
        shield?: boolean;
        immune?: boolean;
        broken?: boolean;
    } = {},
) {
    const context = createCombatTestContext();
    const effects = new EffectFactory();
    // Preserve canonical abilities, luck and stack power, but make the base hit deterministic and nonlethal.
    const shooter = Unit.createUnit(
        { ...getCreatureConfig(LEFT, SHOOTERS[name], name, "", 10), attack_damage_min: 10, attack_damage_max: 10 },
        testGridSettings,
        LEFT,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
    if (options.double) shooter.grantAbility("Crafted Double Shot");
    if (options.rider === "Stun") shooter.grantAbility("Stun");
    if (options.rider === "Freeze") shooter.grantAbility("Crafted Frozen Bow");
    const target = createTestUnit({
        name: "Target",
        team: RIGHT,
        attackType: PBTypes.AttackVals.RANGE,
        maxHp: 100_000,
        amountAlive: 10,
        armor: 10,
        abilities: [
            ...(options.dodge ? ["Dodge"] : []),
            ...(options.shield ? ["Water Shield"] : []),
            ...(options.immune ? ["Enchanted Skin", "Mechanism"] : []),
        ],
    });
    placeUnit(context.grid, context.unitsHolder, shooter, { x: 2, y: 2 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 8, y: 2 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
    if (options.rider === "Quagmire") fight.setArtifactPerTeam(LEFT, 1, Tier1Artifact.RIME_CHARM);
    context.unitsHolder.applyArtifacts(fight);
    context.unitsHolder.refreshStackPowerForAllUnits();
    target.trySeedWaterShield();
    if (options.broken) shooter.applyEffect(effects.makeEffect("Break")!);

    let hit = 0;
    const applications: { name: string; hit: number }[] = [];
    const applyDamage = target.applyDamage.bind(target);
    spyOn(target, "applyDamage").mockImplementation((...args) => {
        const result = applyDamage(...args);
        if (args[4] === shooter) hit++;
        return result;
    });
    const applyEffect = target.applyEffect.bind(target);
    spyOn(target, "applyEffect").mockImplementation((effect) => {
        const applied = applyEffect(effect);
        if (applied) applications.push({ name: effect.getName(), hit });
        return applied;
    });
    const applyDebuff = target.applyDebuff.bind(target);
    spyOn(target, "applyDebuff").mockImplementation((...args) => {
        const result = applyDebuff(...args);
        if (target.hasDebuffActive(args[0].getName())) applications.push({ name: args[0].getName(), hit });
        return result;
    });
    const fire = () => {
        const damage = createVisibleDamage(target);
        const result = context.attackHandler.handleRangeAttack(
            context.unitsHolder,
            [1],
            1,
            damage,
            shooter,
            [[target]],
            undefined,
            target.getPosition(),
            name === "Gargantuan",
        );
        expect(result.completed).toBe(true);
        return { result, damage };
    };
    return { shooter, target, applications, fire };
}

for (const name of ["Elf", "Gargantuan", "Tsar Cannon"] as const) {
    for (const rider of ["Stun", "Freeze", "Quagmire"] as const) {
        for (const successfulHit of [2, 3]) {
            test(`${name}: ${rider} can first proc on landed volley ${successfulHit}`, () => {
                const f = fixture(name, { rider, double: name === "Tsar Cannon" });
                const missRolls = name === "Gargantuan" ? [0, 0] : [0];
                const finishRolls = rolls([
                    ...missRolls,
                    99,
                    ...missRolls,
                    successfulHit === 2 ? 0 : 99,
                    0, // Quiver's independent proc roll.
                    ...missRolls,
                    successfulHit === 3 ? 0 : 99,
                ]);
                const { result } = f.fire();
                finishRolls();
                expect(result.animationData).toHaveLength(3);
                expect(f.applications).toEqual([{ name: rider, hit: successfulHit }]);
                expect(rider === "Quagmire" ? f.target.hasDebuffActive(rider) : f.target.hasEffectActive(rider)).toBe(
                    true,
                );
            });
        }

        test(`${name}: a shielded echo after two misses cannot apply ${rider}`, () => {
            const f = fixture(name, { rider, double: name === "Tsar Cannon", dodge: true, shield: true });
            const finishRolls = rolls(name === "Gargantuan" ? [0, 0, 0, 0, 99, 99] : [0, 0, 0, 99]);
            const { result, damage } = f.fire();
            finishRolls();
            expect(result.animationData).toHaveLength(3);
            expect(f.target.hasBuffActive("Water Shield")).toBe(false);
            expect(f.applications).toEqual([]);
            expect(damage.splash?.every((entry) => entry.amount === 0)).toBe(true);
        });
    }
}

test.each([false, true])(
    "Beholder's echo gets fresh Spit Ball rolls after earlier debuffs failed, crafted double=%s",
    (double) => {
        const f = fixture("Beholder", { double });
        const failedVolley = [0, ...DEBUFFS.map(() => 99)];
        const finishRolls = rolls([
            ...failedVolley,
            ...(double ? failedVolley : []),
            0,
            0,
            ...DEBUFFS.flatMap(() => [0, 0, 0]),
        ]);
        const { result } = f.fire();
        finishRolls();
        expect(result.animationData).toHaveLength(double ? 3 : 2);
        expect(f.applications).toEqual(DEBUFFS.map((name) => ({ name, hit: double ? 3 : 2 })));
    },
);

test("Beholder's echo can add new debuffs without stacking a debuff already applied by the first hit", () => {
    const f = fixture("Beholder");
    const remaining = DEBUFFS.slice(1);
    const finishRolls = rolls([0, 0, 0, 0, ...remaining.map(() => 99), 0, 0, ...remaining.flatMap(() => [0, 0, 0])]);
    f.fire();
    finishRolls();
    expect(f.applications).toEqual([{ name: "Curse", hit: 1 }, ...remaining.map((name) => ({ name, hit: 2 }))]);
});

for (const double of [false, true]) {
    test(`Medusa can first petrify on the echo, crafted double=${double}`, () => {
        const f = fixture("Medusa", { double });
        const finishRolls = rolls([0, 0, 99, ...(double ? [0, 0, 99] : []), 0, 0, 0, 0]);
        const { result, damage } = f.fire();
        finishRolls();
        expect(result.animationData).toHaveLength(double ? 3 : 2);
        expect(damage.secondary?.filter((entry) => entry.source === "petrifying_gaze")).toEqual([
            expect.objectContaining({ unitId: f.target.getId(), unitsDied: 1 }),
        ]);
        expect(f.target.getAmountAlive()).toBe(9);
    });
}

for (const name of ["Beholder", "Medusa"] as const) {
    test(`${name}'s missed echo cannot apply its native on-hit ability`, () => {
        const f = fixture(name, { dodge: true });
        const finishRolls = rolls([0, 0, 0]);
        const { result, damage } = f.fire();
        finishRolls();
        expect(result.animationData).toHaveLength(2);
        expect(f.applications).toEqual([]);
        expect(damage.secondary ?? []).toEqual([]);
        expect(f.target.getCumulativeHp()).toBe(1_000_000);
    });

    test(`${name}'s shielded echo cannot apply its native on-hit ability`, () => {
        const f = fixture(name, { dodge: true, shield: true });
        const finishRolls = rolls([0, 0, 99]);
        const { result, damage } = f.fire();
        finishRolls();
        expect(result.animationData).toHaveLength(2);
        expect(f.target.hasBuffActive("Water Shield")).toBe(false);
        expect(f.applications).toEqual([]);
        expect(damage.secondary ?? []).toEqual([]);
        expect(f.target.getAmountAlive()).toBe(10);
    });

    for (const state of ["immune", "broken"] as const) {
        test(`${name}'s echo respects ${state === "immune" ? "target immunity" : "Break disabling its ability"}`, () => {
            const f = fixture(name, { [state]: true });
            setDeterministicRandomSource(() => 0);
            const { result, damage } = f.fire();
            expect(result.animationData).toHaveLength(2);
            expect(f.applications).toEqual([]);
            expect(damage.secondary ?? []).toEqual([]);
            expect(f.target.getAmountAlive()).toBe(10);
        });
    }
}

test.each(["Stun", "Freeze", "Quagmire"] as const)(
    "repeated successful rolls do not duplicate an active %s",
    (rider) => {
        const f = fixture("Elf", { rider });
        setDeterministicRandomSource(() => 0);
        expect(f.fire().result.animationData).toHaveLength(3);
        expect(f.applications).toEqual([{ name: rider, hit: 1 }]);
    },
);

test("Medusa stops shooting when the first Petrifying Gaze kills the last target creature", () => {
    const f = fixture("Medusa", { double: true });
    f.target.getUnitProperties().amount_alive = 1;
    setDeterministicRandomSource(() => 0);
    const { result, damage } = f.fire();
    expect(f.target.isDead()).toBe(true);
    expect(result.animationData).toHaveLength(1);
    expect(damage.secondary?.filter((entry) => entry.source === "petrifying_gaze")).toHaveLength(1);
    expect(result.unitIdsDied).toContain(f.target.getId());
});
