import { afterEach, expect, spyOn, test } from "bun:test";

import { EMBER_COVENANT_BLESSING } from "../../src/abilities/ember_covenant";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

type Shield = "ember_covenant" | "water_shield";
const shields: Shield[] = ["ember_covenant", "water_shield"];
afterEach(() => setDeterministicRandomSource(undefined));

function battle(shield: Shield, response = false, bounceWater = false, stacked = false, lethal = false) {
    const context = createCombatTestContext();
    const shieldName = shield === "ember_covenant" ? EMBER_COVENANT_BLESSING : "Water Shield";
    const thunderbird = createTestUnit({
        name: "Thunderbird",
        team: response ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
        abilities: ["Chain Lightning", "Wind Element", "Stun"],
        attack: 20,
        damageMin: 20,
        damageMax: 20,
        armor: 0,
        maxHp: 5000,
        amountAlive: 1,
        stackPower: 5,
        luck: 40,
    });
    const protectedUnit = createTestUnit({
        name: shield === "ember_covenant" ? "Hydra" : "Mermaid",
        team: response ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT,
        abilities: [shieldName, ...(!response ? ["No Melee"] : []), ...(stacked ? ["Water Shield"] : [])],
        armor: 0,
        damageMin: 1,
        damageMax: 1,
        maxHp: lethal ? 1 : 5000,
        amountAlive: 1,
    });
    const bounce = createTestUnit({
        name: "Adjacent enemy",
        team: protectedUnit.getTeam(),
        abilities: bounceWater ? ["Water Shield"] : [],
        armor: 0,
        maxHp: 5000,
        amountAlive: 1,
    });
    const attacker = response ? protectedUnit : thunderbird;
    const target = response ? thunderbird : protectedUnit;
    placeUnit(context.grid, context.unitsHolder, attacker, { x: 4, y: 3 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 5, y: 3 });
    placeUnit(context.grid, context.unitsHolder, bounce, { x: response ? 3 : 6, y: 3 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
    });
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(attacker.getTeam(), 1000);
    setDeterministicRandomSource(() => 0);
    expect(protectedUnit.hasBuffActive(shieldName)).toBe(true);
    const before = protectedUnit.getCumulativeHp();
    const bounceBefore = bounce.getCumulativeHp();
    const attack = () => {
        const result = engine.apply({
            type: "melee_attack",
            attackerId: attacker.getId(),
            targetId: target.getId(),
            attackFrom: attacker.getBaseCell(),
        });
        expect(result.completed).toBe(true);
        const event = result.events.find((entry) => entry.type === "unit_attacked");
        expect(event).toBeDefined();
        return { result, event: event! };
    };
    return { thunderbird, protectedUnit, bounce, before, bounceBefore, shieldName, attack };
}

test.each(shields.flatMap((shield) => [false, true].map((response) => ({ shield, response }))))(
    "$shield absorbs the physical blow but the Thunderbird lightning still lands (response=$response)",
    ({ shield, response }) => {
        const f = battle(shield, response);
        const { event } = f.attack();
        const lightning = event.damage.secondary?.filter((entry) => entry.source === "chain_lightning") ?? [];
        expect(lightning.map((entry) => entry.unitId)).toEqual([f.protectedUnit.getId(), f.bounce.getId()]);
        expect(lightning.every((entry) => entry.amount > 0)).toBe(true);
        expect(f.before - f.protectedUnit.getCumulativeHp()).toBe(lightning[0].amount);
        expect(f.bounceBefore - f.bounce.getCumulativeHp()).toBe(lightning[1].amount);
        expect(event.damage.secondary?.some((entry) => entry.source === shield && entry.amount > 0)).toBe(true);
        if (!response) expect(event.damage.hits?.[0].amount).toBe(0);
        expect(f.protectedUnit.hasBuffActive(f.shieldName)).toBe(false);
        expect(f.protectedUnit.hasEffectActive("Stun")).toBe(false);
    },
);

test.each(shields)("%s stays intact when Thunderbird misses, with no lightning", (shield) => {
    const f = battle(shield);
    const miss = spyOn(f.thunderbird, "calculateMissChance").mockReturnValue(100);
    try {
        const { event } = f.attack();
        expect(event.damage.missed).toBe(true);
        expect(event.damage.secondary?.filter((entry) => entry.source === "chain_lightning") ?? []).toEqual([]);
        expect(f.protectedUnit.getCumulativeHp()).toBe(f.before);
        expect(f.bounce.getCumulativeHp()).toBe(f.bounceBefore);
        expect(f.protectedUnit.hasBuffActive(f.shieldName)).toBe(true);
    } finally {
        miss.mockRestore();
    }
});

test.each(shields)("after %s breaks, an intact Water Shield on the bounce still absorbs its lightning", (shield) => {
    const f = battle(shield, false, true);
    const { event } = f.attack();
    const lightning = event.damage.secondary?.filter((entry) => entry.source === "chain_lightning") ?? [];
    expect(lightning).toHaveLength(2);
    expect(lightning[0].amount).toBeGreaterThan(0);
    expect(lightning[1].unitId).toBe(f.bounce.getId());
    expect(lightning[1].amount).toBe(0);
    expect(f.bounce.getCumulativeHp()).toBe(f.bounceBefore);
    expect(f.bounce.hasBuffActive("Water Shield")).toBe(false);
});

test("Ember Covenant absorbs the physical blow and a separate Water Shield absorbs the lightning", () => {
    const f = battle("ember_covenant", false, false, true);
    const { event } = f.attack();
    const primaryLightning = event.damage.secondary?.find(
        (entry) => entry.source === "chain_lightning" && entry.unitId === f.protectedUnit.getId(),
    );
    expect(event.damage.hits?.[0].amount).toBe(0);
    expect(primaryLightning?.amount).toBe(0);
    expect(f.protectedUnit.getCumulativeHp()).toBe(f.before);
    expect(f.protectedUnit.hasBuffActive(EMBER_COVENANT_BLESSING)).toBe(false);
    expect(f.protectedUnit.hasBuffActive("Water Shield")).toBe(false);
});

test.each(shields)("lightning can kill the target after %s absorbs the physical blow", (shield) => {
    const f = battle(shield, false, false, false, true);
    const { result, event } = f.attack();
    expect(event.damage.hits?.[0].amount).toBe(0);
    expect(event.damage.secondary?.some((entry) => entry.source === "chain_lightning" && entry.unitsDied === 1)).toBe(
        true,
    );
    expect(event.unitIdsDied).toContain(f.protectedUnit.getId());
    expect(
        result.events.some((entry) => entry.type === "unit_destroyed" && entry.unitId === f.protectedUnit.getId()),
    ).toBe(true);
});

test.each([
    { faction: "Chaos", name: "Hydra", shield: "ember_covenant" },
    { faction: "Might", name: "Mermaid", shield: "water_shield" },
])("native Thunderbird lightning hits $name after $shield absorbs its strike", ({ faction, name, shield }) => {
    const context = createCombatTestContext();
    const [thunderbird, target] = (
        [
            ["Might", "Thunderbird", PBTypes.TeamVals.LEFT],
            [faction, name, PBTypes.TeamVals.RIGHT],
        ] as const
    ).map(([unitFaction, unitName, team]) => {
        const effects = new EffectFactory();
        return Unit.createUnit(
            getCreatureConfig(team, unitFaction, unitName, "test_512", 10),
            context.grid.getSettings(),
            team,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            false,
        );
    });
    placeUnit(context.grid, context.unitsHolder, thunderbird, { x: 4, y: 4 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 4 + target.getFootprintWidth(), y: 4 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
    });
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
    setDeterministicRandomSource(() => 0);
    const before = target.getCumulativeHp();
    const result = engine.apply({
        type: "melee_attack",
        attackerId: thunderbird.getId(),
        targetId: target.getId(),
        attackFrom: thunderbird.getBaseCell(),
    });
    expect(result.completed).toBe(true);
    const event = result.events.find((entry) => entry.type === "unit_attacked");
    expect(event?.damage.hits?.[0].amount).toBe(0);
    const lightning = event?.damage.secondary?.find(
        (entry) => entry.source === "chain_lightning" && entry.unitId === target.getId(),
    );
    expect(lightning?.amount).toBeGreaterThan(0);
    expect(before - target.getCumulativeHp()).toBe(lightning!.amount);
    expect(event?.damage.secondary?.some((entry) => entry.source === shield)).toBe(true);
});
