import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    ArtifactTier,
    formatArtifactDescription,
    getArtifactProperties,
    Tier2Artifact,
    TIER2_ARTIFACT_LIST,
    ToTier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { evaluateRangeCandidateDamage } from "../../src/ai/candidates";
import { projectDoubleShotAttack } from "../../src/damage/ability_damage_projection";
import { GameActionEngine } from "../../src/engine/action_engine";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());
afterEach(() => setDeterministicRandomSource(undefined));
const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
function fixture(
    abilities: string[] = [],
    shots = 20,
    luck = 0,
    direction?: { x: number; y: number },
    rangedTarget = false,
) {
    const context = createCombatTestContext();
    const shooter = createTestUnit({
        name: "Shooter",
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        abilities,
        rangeShots: shots,
        luck,
        damageMin: 10,
        damageMax: 10,
        amountAlive: 10,
    });
    const target = createTestUnit({
        name: "Target",
        team: RIGHT,
        maxHp: 10000,
        amountAlive: 10,
        attackType: rangedTarget ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: 20,
    });
    const ally = createTestUnit({ name: "Melee ally", team: LEFT });
    placeUnit(context.grid, context.unitsHolder, shooter, direction ? { x: 8, y: 8 } : { x: 2, y: 2 });
    placeUnit(
        context.grid,
        context.unitsHolder,
        target,
        direction ? { x: 8 + direction.x * 4, y: 8 + direction.y * 4 } : { x: 8, y: 2 },
    );
    placeUnit(context.grid, context.unitsHolder, ally, { x: 2, y: 6 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
    context.unitsHolder.applyArtifacts(fight);
    context.unitsHolder.refreshStackPowerForAllUnits();
    const fire = (isAOE = false, response = false) => {
        const damage = createVisibleDamage(target);
        const result = context.attackHandler.handleRangeAttack(
            context.unitsHolder,
            [1],
            1,
            damage,
            shooter,
            [[target]],
            response ? [shooter] : undefined,
            target.getPosition(),
            isAOE,
        );
        return { result, damage };
    };
    return { ...context, shooter, target, ally, fight, fire };
}
test("is draftable with a new wire id and honest base description", () => {
    expect(ToTier2Artifact["15"]).toBe(Tier2Artifact.QUIVER_OF_ECHOES);
    expect(TIER2_ARTIFACT_LIST.some((item) => item.id === Tier2Artifact.QUIVER_OF_ECHOES)).toBe(true);
    expect(
        formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.QUIVER_OF_ECHOES)),
    ).toContain("40% chance to make one extra attack");
});
test("buffs allied ranged units only, recomputes once, and clears on deselection", () => {
    const { shooter, target, ally, fight, unitsHolder } = fixture();
    expect(shooter.getBonusRangedAttackChance()).toBe(40);
    expect(target.getBuff("Quiver of Echoes")).toBeUndefined();
    expect(ally.getBuff("Quiver of Echoes")).toBeUndefined();
    unitsHolder.applyArtifacts(fight);
    expect(shooter.getUnitProperties().applied_buffs.filter((name) => name === "Quiver of Echoes")).toHaveLength(1);
    fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.NO_ARTIFACT);
    unitsHolder.applyArtifacts(fight);
    expect(shooter.getBonusRangedAttackChance()).toBe(0);
});
test("uses current positive or negative luck and displays the actual chance", () => {
    const { shooter, unitsHolder } = fixture();
    const props = shooter.getUnitProperties();
    props.luck_authoritative = true;
    for (const luck of [7, -5, 0]) {
        props.luck = luck;
        props.luck_mod = 0;
        unitsHolder.refreshStackPowerForAllUnits();
        expect(shooter.getBonusRangedAttackChance()).toBe(40 + luck);
        expect(props.applied_buffs_descriptions[props.applied_buffs.indexOf("Quiver of Echoes")]).toContain(
            `a ${40 + luck}% chance`,
        );
        expect(props.applied_buffs_descriptions[props.applied_buffs.indexOf("Quiver of Echoes")]).not.toContain("luck");
    }
});
test("fires exactly one extra ordinary attack on success and spends ammunition", () => {
    const { shooter, fire } = fixture();
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(result.completed).toBe(true);
    expect(result.animationData).toHaveLength(2);
    expect(damage.rangedVolleyCount).toBe(2);
    expect(damage.hits).toHaveLength(2);
    expect(shooter.getRangeShots()).toBe(18);
});
test("does not proc when the roll is outside the chance", () => {
    const { shooter, fire } = fixture();
    let draw = 0;
    setDeterministicRandomSource(() => (draw++ % 2 === 0 ? 0 : 99 / 0x100000000));
    const { result, damage } = fire();
    expect(result.animationData).toHaveLength(1);
    expect(damage.rangedVolleyCount).toBeUndefined();
    expect(shooter.getRangeShots()).toBe(19);
});
test("does not fire without ammunition after the primary shot", () => {
    const { shooter, fire } = fixture([], 1);
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(result.animationData).toHaveLength(1);
    expect(damage.rangedVolleyCount).toBeUndefined();
    expect(shooter.getRangeShots()).toBe(0);
});
test("stacks with Crafted Double Shot for three projectiles, never four", () => {
    const { fire } = fixture(["Crafted Double Shot"]);
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(result.animationData).toHaveLength(3);
    expect(damage.rangedVolleyCount).toBe(3);
    expect(damage.hits).toHaveLength(3);
});
test("Gargantuan Double Throw gains a third area volley", () => {
    const { fire, target } = fixture(["Area Throw", "Double Throw"]);
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire(true);
    expect(result.animationData).toHaveLength(3);
    expect(damage.rangedVolleyCount).toBe(3);
    expect(damage.splash?.filter((hit) => hit.unitId === target.getId())).toHaveLength(3);
});
test("piercing attacks gain one additional piercing volley", () => {
    const { fire, target } = fixture(["Through Shot", "Crafted Double Shot"]);
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(result.animationData).toHaveLength(3);
    expect(damage.rangedVolleyCount).toBe(3);
    expect(damage.splash?.filter((hit) => hit.unitId === target.getId())).toHaveLength(3);
});

test("AI values the probabilistic volley without promising a guaranteed hit", () => {
    const { shooter, target, fight } = fixture();
    const context = { fightProperties: fight } as Parameters<typeof evaluateRangeCandidateDamage>[1];
    const evaluate = () =>
        evaluateRangeCandidateDamage(
            shooter,
            context,
            { affectedUnits: [[target]], rangeAttackDivisors: [1] },
            target.getId(),
            1,
            false,
        );
    const echo = evaluate();
    shooter.deleteBuff("Quiver of Echoes");
    const ordinary = evaluate();
    expect(echo.value).toBeCloseTo(ordinary.value * 1.4, 6);
    expect(echo.kill).toBe(0);
});

test("hover damage includes the possible extra attack only at its upper bound and respects ammunition", () => {
    const { shooter, target } = fixture();
    const input = { attacker: shooter, target, synergyAbilityPowerIncrease: 0, divisor: 1 };
    const projection = projectDoubleShotAttack(input);
    expect(projection.bonusChance).toBe(40);
    expect(projection.total.min).toBe(projection.first.min);
    expect(projection.total.max).toBe(projection.first.max * 2);
    shooter.getUnitProperties().range_shots = 1;
    const lastArrow = projectDoubleShotAttack(input);
    expect(lastArrow.bonus).toBeUndefined();
    expect(lastArrow.total.max).toBe(lastArrow.first.max);
});

test("stops when the first attack kills the only target", () => {
    const { target, fire } = fixture();
    target.getUnitProperties().amount_alive = 1;
    target.getUnitProperties().hp = 1;
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(target.isDead()).toBe(true);
    expect(result.animationData).toHaveLength(1);
    expect(damage.rangedVolleyCount).toBeUndefined();
});

for (const [x, y] of [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
]) {
    test(`resolves the extra ranged attack in direction ${x},${y}`, () => {
        const { shooter, target, attackHandler, unitsHolder } = fixture([], 20, 0, { x, y });
        setDeterministicRandomSource(() => 0);
        const evaluation = attackHandler.evaluateRangeAttack(
            unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            target.getPosition(),
            false,
            false,
            false,
        );
        const damage = createVisibleDamage(target);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            evaluation.rangeAttackDivisors,
            1,
            damage,
            shooter,
            evaluation.affectedUnits,
            undefined,
            target.getPosition(),
        );
        expect(result.completed).toBe(true);
        expect(damage.rangedVolleyCount).toBe(2);
        expect(damage.hits).toHaveLength(2);
    });
}

test("authoritative area actions record three projectiles for replay and finish exactly one turn", () => {
    const context = fixture(["Area Throw", "Double Throw"]);
    const { shooter, target, fight, grid, unitsHolder, attackHandler } = context;
    fight.startFight();
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid,
        unitsHolder,
        attackHandler,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => shooter.getId(),
    });
    setDeterministicRandomSource(() => 0);
    const result = engine.apply({
        type: "area_throw_attack",
        attackerId: shooter.getId(),
        targetCell: { x: target.getBaseCell()!.x, y: target.getBaseCell()!.y + 1 },
    });
    expect(result.completed).toBe(true);
    const attack = result.events.find((event) => event.type === "area_attacked");
    expect(attack?.type).toBe("area_attacked");
    if (attack?.type !== "area_attacked") throw new Error("Missing area event");
    expect(attack.damage.rangedVolleyCount).toBe(3);
    expect(attack.damage.extraRangedAttackChance).toBeGreaterThan(0);
    expect(attack.animations).toHaveLength(3);
    expect(result.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
});

test("a crafted double attack cannot echo after exhausting its two arrows", () => {
    const { fire, shooter } = fixture(["Crafted Double Shot"], 2);
    setDeterministicRandomSource(() => 0);
    const { result, damage } = fire();
    expect(result.animationData).toHaveLength(2);
    expect(damage.rangedVolleyCount).toBeUndefined();
    expect(shooter.getRangeShots()).toBe(0);
});

for (const [roll, count] of [
    [46, 2],
    [47, 1],
]) {
    test(`a +7 luck shooter uses the exact 47% boundary at roll ${roll}`, () => {
        const { fire } = fixture([], 20, 7);
        let draw = 0;
        setDeterministicRandomSource(() => (draw++ % 2 === 0 ? 0 : roll / 0x100000000));
        expect(fire().result.animationData).toHaveLength(count);
    });
}

test("the artifact volley does not grant a second ranged counterattack", () => {
    const { shooter, target, fire } = fixture([], 20, 0, undefined, true);
    setDeterministicRandomSource(() => 0);
    const { result } = fire(false, true);
    expect(shooter.isDead()).toBe(false);
    expect(
        result.animationData?.filter((animation) => animation.fromPosition?.x === target.getPosition().x),
    ).toHaveLength(1);
    expect(
        result.animationData?.filter((animation) => animation.fromPosition?.x === shooter.getPosition().x),
    ).toHaveLength(2);
});

test("an authoritative ranged obstacle strike records and spends the extra shot", () => {
    const { grid, unitsHolder, attackHandler } = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    const shooter = createTestUnit({
        name: "Shooter",
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 20,
        luck: 0,
    });
    placeUnit(grid, unitsHolder, shooter, { x: 2, y: 2 });
    fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();
    fight.startFight();
    const cell = grid.getCenterCells()[0];
    const targetPosition = getPositionForCell(
        cell,
        grid.getSettings().getMinX(),
        grid.getSettings().getStep(),
        grid.getSettings().getHalfStep(),
    );
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid,
        unitsHolder,
        attackHandler,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => shooter.getId(),
    });
    setDeterministicRandomSource(() => 0);
    const result = engine.apply({ type: "obstacle_attack", attackerId: shooter.getId(), targetPosition });
    expect(result.completed).toBe(true);
    const attack = result.events.find((event) => event.type === "obstacle_attacked");
    if (attack?.type !== "obstacle_attacked") throw new Error("Missing obstacle event");
    expect(attack.animations).toHaveLength(2);
    expect(attack.damage?.rangedVolleyCount).toBe(2);
    expect(attack.hitsAfter).toBe(attack.hitsBefore - 2);
    expect(shooter.getRangeShots()).toBe(18);
});
