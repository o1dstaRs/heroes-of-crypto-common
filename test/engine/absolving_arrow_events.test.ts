import { afterEach, describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

const setup = (stackPower = 5, counter = false) => {
    const context = createCombatTestContext();
    const monk = createTestUnit({
        name: "Monk",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Absolving Arrow"],
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 10,
        shotDistance: 16,
        stackPower,
        damageMin: 5,
        damageMax: 5,
    });
    const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LEFT });
    const enemy = createTestUnit({
        name: "Enemy",
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 10000,
        amountAlive: 5,
        attackType: counter ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        abilities: counter ? ["Absolving Arrow"] : [],
        rangeShots: 10,
        stackPower: 5,
    });
    placeUnit(context.grid, context.unitsHolder, monk, { x: 5, y: 2 });
    placeUnit(context.grid, context.unitsHolder, ally, { x: 5, y: 5 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 5, y: 8 });
    const damage = createVisibleDamage(enemy);
    const fire = () =>
        context.attackHandler.handleRangeAttack(
            context.unitsHolder,
            [1],
            1,
            damage,
            monk,
            [[enemy]],
            undefined,
            enemy.getPosition(),
        );
    return { ...context, monk, ally, enemy, damage, fire };
};

describe("Absolving Arrow replay results", () => {
    test("records the actual removed effects, recipient position, and owning shot", () => {
        const { monk, ally, damage, fire } = setup();
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        ally.applyEffect(new EffectFactory().makeEffect("Break")!);
        setDeterministicRandomSource(() => 0);
        expect(fire().completed).toBe(true);
        expect(damage.absolutions).toEqual([
            {
                sourceUnitId: monk.getId(),
                unitId: ally.getId(),
                position: ally.getPosition(),
                liftedNames: ["Stun", "Break"],
                response: false,
                hitIndex: 0,
            },
        ]);
        expect(ally.hasEffectActive("Stun")).toBe(false);
        expect(ally.hasEffectActive("Break")).toBe(false);
    });

    test("does not report a cleanse when the ally is clean or the removal roll fails", () => {
        const clean = setup();
        setDeterministicRandomSource(() => 0);
        expect(clean.fire().completed).toBe(true);
        expect(clean.damage.absolutions).toBeUndefined();

        const failed = setup(1);
        failed.ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        let draw = 0;
        setDeterministicRandomSource(() => (draw++ % 2 === 0 ? 0 : 99 / 0x100000000));
        expect(failed.fire().completed).toBe(true);
        expect(failed.damage.absolutions).toBeUndefined();
        expect(failed.ally.hasEffectActive("Stun")).toBe(true);
    });

    test("keeps a successful cleanse when the arrow misses its enemy", () => {
        const { ally, monk, damage, fire } = setup();
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        monk.calculateMissChance = () => 100;
        setDeterministicRandomSource(() => 0);
        expect(fire().completed).toBe(true);
        expect(damage.missed).toBe(true);
        expect(damage.absolutions?.[0].liftedNames).toEqual(["Stun"]);
    });

    test("assigns an artifact echo's cleanse to the extra projectile", () => {
        const { ally, unitsHolder, monk, damage, fire } = setup(1);
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
        unitsHolder.applyArtifacts(fight);
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        const draws = [0, 99 / 0x100000000];
        setDeterministicRandomSource(() => draws.shift() ?? 0);
        expect(fire().completed).toBe(true);
        expect(damage.rangedVolleyCount).toBe(2);
        expect(damage.absolutions).toHaveLength(1);
        expect(damage.absolutions?.[0]).toMatchObject({ sourceUnitId: monk.getId(), response: false, hitIndex: 1 });
    });

    test("records a counter-shot cleanse under the responding Monk", () => {
        const { grid, unitsHolder, attackHandler, monk, enemy, damage } = setup(5, true);
        const counterAlly = createTestUnit({ name: "Counter ally", team: PBTypes.TeamVals.RIGHT });
        placeUnit(grid, unitsHolder, counterAlly, { x: 5, y: 6 });
        counterAlly.applyEffect(new EffectFactory().makeEffect("Stun")!);
        setDeterministicRandomSource(() => 0);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            damage,
            monk,
            [[enemy]],
            [monk],
            enemy.getPosition(),
        );
        expect(result.completed).toBe(true);
        expect(damage.absolutions).toHaveLength(1);
        expect(damage.absolutions?.[0]).toMatchObject({
            sourceUnitId: enemy.getId(),
            unitId: counterAlly.getId(),
            liftedNames: ["Stun"],
            response: true,
            hitIndex: 0,
        });
    });

    test("includes successful cleanses in authoritative action events and JSON journals", () => {
        const { grid, unitsHolder, attackHandler, monk, ally, enemy } = setup();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 2);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
        monk.refreshPossibleAttackTypes(true);
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        setDeterministicRandomSource(() => 0);
        const engine = new GameActionEngine({
            fightProperties,
            grid,
            unitsHolder,
            attackHandler,
            moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => monk.getId(),
        });
        const result = engine.apply({ type: "range_attack", attackerId: monk.getId(), targetId: enemy.getId() });
        expect(result.completed).toBe(true);
        const attack = result.events.find((event) => event.type === "unit_attacked");
        expect(attack?.type).toBe("unit_attacked");
        if (attack?.type !== "unit_attacked") throw new Error("Missing attack event");
        expect(attack.damage.absolutions?.[0]).toMatchObject({ unitId: ally.getId(), liftedNames: ["Stun"] });
        expect(JSON.parse(JSON.stringify(attack)).damage.absolutions).toEqual(attack.damage.absolutions);
    });
});
