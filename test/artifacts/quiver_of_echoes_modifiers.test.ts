import { afterEach, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getCreatureConfig, getEffectConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { Effect } from "../../src/effects/effect";
import { EffectFactory } from "../../src/effects/effect_factory";
import {
    applyAoeDamageTail,
    aoeAttackAbilityMultiplier,
    projectDoubleShotAttack,
} from "../../src/damage/ability_damage_projection";
import { projectAttackDamageBand } from "../../src/damage/damage_projection";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

function fireCreature(
    name: "Elf" | "Gargantuan",
    options: { tier1?: Tier1Artifact; divisor?: number; paralysis?: boolean; resist?: boolean; shield?: boolean } = {},
) {
    const { grid, unitsHolder, attackHandler } = createCombatTestContext();
    const effects = new EffectFactory();
    const shooter = Unit.createUnit(
        getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", name, "", 10),
        testGridSettings,
        PBTypes.TeamVals.LEFT,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
    const target = createTestUnit({
        name: "Target",
        team: PBTypes.TeamVals.RIGHT,
        armor: 15,
        maxHp: 100_000,
        amountAlive: 10,
        abilities: options.shield ? ["Water Shield"] : [],
    });
    const neighbor = createTestUnit({
        name: "Neighbor",
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 100_000,
        amountAlive: 10,
    });
    placeUnit(grid, unitsHolder, shooter, { x: 2, y: 2 });
    placeUnit(grid, unitsHolder, target, { x: 8, y: 2 });
    placeUnit(grid, unitsHolder, neighbor, { x: 8, y: 3 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
    if (options.tier1) fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, options.tier1);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();
    if (options.paralysis) shooter.applyEffect(new Effect({ ...getEffectConfig("Paralysis"), power: 50 }));
    if (options.resist) {
        target.applyBuff(
            new Spell({ spellProperties: { ...getSpellConfig("System", "Amulet of Resolve"), power: 25 }, amount: 1 }),
        );
    }
    target.trySeedWaterShield();
    const shotsBefore = shooter.getRangeShots();
    const damage = createVisibleDamage(target);
    setDeterministicRandomSource(() => 0);
    const area = name === "Gargantuan";
    const projectionInput = {
        attacker: shooter,
        target,
        attackType: PBTypes.AttackVals.RANGE,
        synergyAbilityPowerIncrease: fight.getAdditionalAbilityPowerPerTeam(shooter.getTeam()),
        divisor: options.divisor ?? 1,
    };
    const beforeProjection = JSON.stringify([shooter.getUnitProperties(), target.getUnitProperties()]);
    const ordinaryProjection = projectDoubleShotAttack(projectionInput);
    const projected = area
        ? [0, 1, 2].map((priorHits) => {
              const band = projectAttackDamageBand({
                  ...projectionInput,
                  priorHits,
                  abilityMultiplier: aoeAttackAbilityMultiplier(shooter, projectionInput.synergyAbilityPowerIncrease),
              });
              const charm = priorHits === 1 ? shooter.getBuff("Dual Strike Charm") : undefined;
              return applyAoeDamageTail({
                  attacker: shooter,
                  victim: target,
                  damage: band.min,
                  perUnitDamageFactor: charm ? 1 + charm.getPower() / 100 : 1,
              });
          })
        : [ordinaryProjection.first.min, ordinaryProjection.second.min, ordinaryProjection.bonus?.min];
    expect(JSON.stringify([shooter.getUnitProperties(), target.getUnitProperties()])).toBe(beforeProjection);
    const result = attackHandler.handleRangeAttack(
        unitsHolder,
        [options.divisor ?? 1],
        1,
        damage,
        shooter,
        [area ? [target, neighbor] : [target]],
        undefined,
        target.getPosition(),
        area,
    );
    expect(result.completed).toBe(true);
    expect(result.animationData).toHaveLength(3);
    expect(damage.rangedVolleyCount).toBe(3);
    expect(shooter.getRangeShots()).toBe(shotsBefore - 3);
    const hits = damage.splash?.filter((hit) => hit.unitId === target.getId()).map((hit) => hit.amount) ?? [];
    expect(hits).toHaveLength(3);
    if (area) expect(damage.splash?.filter((hit) => hit.unitId === neighbor.getId())).toHaveLength(3);
    expect(projected).toEqual(hits);
    return { hits, damage, target, shooter };
}

for (const name of ["Elf", "Gargantuan"] as const) {
    test(`${name}'s canonical abilities produce a full ordinary third volley`, () => {
        const { hits } = fireCreature(name);
        expect(hits.every((amount) => amount > 0)).toBe(true);
        expect(hits[2]).toBe(hits[0]);
    });

    test(`${name}'s echo retains ranged attack bonuses, falloff and Paralysis`, () => {
        const base = fireCreature(name).hits[2];
        expect(fireCreature(name, { tier1: Tier1Artifact.KEEN_BLADE }).hits[2]).toBeGreaterThan(base);
        const distant = fireCreature(name, { divisor: 2 }).hits[2];
        expect(distant).toBeGreaterThan(0);
        expect(distant).toBeLessThan(base);
        const paralyzed = fireCreature(name, { paralysis: true }).hits[2];
        expect(paralyzed).toBeGreaterThan(0);
        expect(paralyzed).toBeLessThan(base);
    });

    test(`${name}'s Dual Strike Charm enhances the native second volley only`, () => {
        const base = fireCreature(name).hits;
        const charm = fireCreature(name, { tier1: Tier1Artifact.DUAL_STRIKE_CHARM }).hits;
        expect(charm[0]).toBe(base[0]);
        expect(charm[1]).toBeGreaterThan(base[1]);
        expect(charm[2]).toBe(base[2]);
    });

    test(`${name}'s later volleys hit after the first spends Water Shield`, () => {
        const { hits } = fireCreature(name, { shield: true });
        expect(hits[0]).toBe(0);
        expect(hits[1]).toBeGreaterThan(0);
        expect(hits[2]).toBeGreaterThan(0);
    });

    test(`${name}'s Wounding Charm applies on all three landed volleys`, () => {
        const { hits, target, shooter, damage } = fireCreature(name, { tier1: Tier1Artifact.WOUNDING_CHARM });
        expect(shooter.hasAbilityActive("Deep Wounds Level 1")).toBe(true);
        expect(target.getEffect("Deep Wounds")?.getPower()).toBeGreaterThan(0);
        const wounds = damage.deepWounds?.filter((entry) => entry.unitId === target.getId()) ?? [];
        expect(wounds).toHaveLength(3);
        expect(target.getEffect("Deep Wounds")?.getPower()).toBe(wounds[2].power);
        expect(hits[2]).toBeGreaterThan(hits[0]);
    });

    test(`${name}'s absorbed first volley does not apply Wounding Charm`, () => {
        const { damage, target } = fireCreature(name, { tier1: Tier1Artifact.WOUNDING_CHARM, shield: true });
        expect(damage.deepWounds?.filter((entry) => entry.unitId === target.getId())).toHaveLength(2);
    });
}

test("Gargantuan's third splash retains the victim's physical area resistance", () => {
    const base = fireCreature("Gargantuan").hits[2];
    const resistant = fireCreature("Gargantuan", { resist: true }).hits[2];
    expect(resistant).toBeGreaterThan(0);
    expect(resistant).toBeLessThan(base);
});
