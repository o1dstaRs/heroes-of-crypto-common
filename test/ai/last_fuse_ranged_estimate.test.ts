import { afterEach, describe, expect, test } from "bun:test";

import { hasDoubleShotAbility } from "../../src/abilities/ability_helper";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import {
    enumerateCandidates,
    evaluateRangeCandidateDamage,
    findBestLegalStationaryRangeAttack,
} from "../../src/ai/candidates";
import { estimateLastFuseRangedDamage } from "../../src/ai/last_fuse_estimate";
import { selectV08DirectCombatCandidate } from "../../src/ai/versions/v0_8";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getEffectConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { Effect } from "../../src/effects/effect";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { RangeAttackCellSide } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const RANGE = PBTypes.AttackVals.RANGE;

function board(
    options: {
        team?: TeamType;
        direction?: XY;
        shooter?: TestUnitOptions;
        target?: TestUnitOptions;
        neighbor?: TestUnitOptions;
        safe?: TestUnitOptions;
        neighborCell?: XY;
        remainingHp?: number;
        echo?: boolean;
        fuse?: boolean;
    } = {},
) {
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const team = options.team ?? LEFT;
    const enemy = team === LEFT ? RIGHT : LEFT;
    const direction = options.direction ?? { x: 1, y: 0 };
    const shooter = createTestUnit({
        name: "Shooter",
        team,
        attackType: RANGE,
        attack: 10,
        damageMin: 40,
        damageMax: 40,
        maxHp: 500,
        rangeShots: 6,
        ...options.shooter,
    });
    const target = createTestUnit({ name: "Fuse", team: enemy, armor: 10, maxHp: 100, ...options.target });
    const neighbor = createTestUnit({ name: "Neighbor", team, maxHp: 500, ...options.neighbor });
    const far = createTestUnit({ name: "Far ally", team, maxHp: 500 });
    const safe = createTestUnit({ name: "Safe target", team: enemy, armor: 10, maxHp: 1000, ...options.safe });
    const targetCell = { x: 8, y: 8 };
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 8 - 4 * direction.x, y: 8 - 4 * direction.y });
    placeUnit(combat.grid, combat.unitsHolder, target, targetCell);
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        neighbor,
        options.neighborCell ?? {
            x: 8 + direction.x - direction.y,
            y: 8 + direction.y + direction.x,
        },
    );
    placeUnit(combat.grid, combat.unitsHolder, far, { x: 2, y: 13 });
    placeUnit(combat.grid, combat.unitsHolder, safe, { x: 2, y: 2 });
    if (options.remainingHp !== undefined)
        target.applyDamage(target.getCumulativeHp() - options.remainingHp, 0, new SceneLogMock(), false);
    const fight = FightStateManager.getInstance().getFightProperties();
    if (options.fuse !== false) fight.setArtifactPerTeam(enemy, 2, Tier2Artifact.LAST_FUSE);
    if (options.echo) fight.setArtifactPerTeam(team, 2, Tier2Artifact.QUIVER_OF_ECHOES);
    combat.unitsHolder.applyArtifacts(fight);
    for (const unit of [shooter, target, neighbor]) unit.trySeedWaterShield();
    shooter.refreshPossibleAttackTypes(true);
    fight.startFight();
    fight.setTeamUnitsAlive(team, 3);
    fight.setTeamUnitsAlive(enemy, 2);
    fight.startTurn(team, 1000);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(combat.grid.getSettings()),
        attackHandler: combat.attackHandler,
        fightProperties: fight,
    };
    const evaluation = combat.attackHandler.evaluateRangeAttack(
        combat.unitsHolder.getAllUnits(),
        shooter,
        shooter.getPosition(),
        target.getPosition(),
        false,
        false,
        false,
    );
    const actions: GameAction[] = [
        {
            type: "range_attack",
            attackerId: shooter.getId(),
            targetId: target.getId(),
            aimCell: targetCell,
            aimSide:
                direction.x > 0
                    ? RangeAttackCellSide.LEFT
                    : direction.x < 0
                      ? RangeAttackCellSide.RIGHT
                      : direction.y > 0
                        ? RangeAttackCellSide.DOWN
                        : RangeAttackCellSide.UP,
        },
    ];
    const project = () => {
        const state = () =>
            JSON.stringify(
                [...combat.unitsHolder.getAllUnits().values()].map((u) => [
                    u.getPosition(),
                    u.getUnitProperties(),
                    u.getResponded(),
                ]),
            );
        const before = state();
        setDeterministicRandomSource(() => {
            throw new Error("Projection must not consume combat RNG");
        });
        const fuse = estimateLastFuseRangedDamage(shooter, target, context, evaluation.rangeAttackDivisors[0] ?? 1);
        const range = evaluateRangeCandidateDamage(
            shooter,
            context,
            evaluation,
            target.getId(),
            hasDoubleShotAbility(shooter) ? 2 : 1,
            false,
        );
        expect(state()).toBe(before);
        return { fuse, range };
    };
    const fire = (random: () => number = () => 0, sequence = actions) => {
        setDeterministicRandomSource(random);
        const hpBefore = target.getCumulativeHp();
        const engine = new GameActionEngine({
            ...combat,
            fightProperties: fight,
            moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => shooter.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400, 1500] }),
        });
        const results = sequence.map((action) => engine.apply(action));
        expect(results.every((result) => result.completed)).toBe(true);
        const result = results[results.length - 1];
        const blasts = result.events.filter((event) => event.type === "pyre_exploded");
        const alliedIds = new Set([shooter.getId(), neighbor.getId(), far.getId()]);
        const friendlyDamage = blasts
            .flatMap((event) => event.hits)
            .filter((hit) => alliedIds.has(hit.unitId))
            .reduce((sum, hit) => sum + hit.amount, 0);
        return { result, blasts, friendlyDamage, netDamage: hpBefore - target.getCumulativeHp() - friendlyDamage };
    };
    return { ...combat, shooter, target, neighbor, far, safe, fight, context, evaluation, actions, project, fire };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("Last Fuse ranged estimates", () => {
    for (const team of [LEFT, RIGHT] as const) {
        test.each([
            { x: 1, y: 0 },
            { x: -1, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: -1 },
        ])("prices diagonal collateral, team=" + team + " direction=%j", (direction) => {
            const f = board({ team, direction, remainingHp: 10 });
            expect(f.evaluation.affectedUnits).toEqual([[f.target]]);
            const { fuse, range } = f.project();
            const actual = f.fire();
            expect(actual.blasts).toHaveLength(1);
            expect(fuse!.expectedFriendlyDamage).toBe(actual.friendlyDamage);
            expect(range.value).toBe(actual.netDamage);
            expect(range.friendlyFireDamage).toBe(20);
            expect(range.enemyDamage).toBe(10);
            expect(range.primaryTargetDamage).toBe(10);
            expect(range.aimTargetDamage).toBe(10);
            expect(f.shooter.getCumulativeHp()).toBe(500);
            expect(f.far.getCumulativeHp()).toBe(500);
        });
    }

    test.each([1, 2, 3, 4, 5])("prices the stack-power floor %i", (stackPower) => {
        const f = board({ target: { stackPower }, remainingHp: 1 });
        const { fuse, range } = f.project();
        expect(fuse!.expectedFriendlyDamage).toBe(20 * stackPower);
        expect(f.fire().netDamage).toBe(range.value);
    });

    test("uses the fatal hit's remaining HP above the floor", () => {
        const f = board({
            shooter: { damageMin: 2000, damageMax: 2000 },
            target: { amountAlive: 10 },
            remainingHp: 600,
        });
        const { fuse, range } = f.project();
        expect(fuse!.expectedFriendlyDamage).toBe(120);
        expect(f.fire().netDamage).toBe(range.value);
    });

    test.each([
        { footprintWidth: 1, footprintHeight: 2 },
        { footprintWidth: 2, footprintHeight: 1 },
        { size: PBTypes.UnitSizeVals.LARGE },
    ])("uses the whole corpse ring %j", (target) => {
        const width = target.footprintWidth ?? (target.size === PBTypes.UnitSizeVals.LARGE ? 2 : 1);
        const f = board({ target, remainingHp: 10, direction: { x: -1, y: 0 }, neighborCell: { x: 8 - width, y: 9 } });
        const { fuse, range } = f.project();
        expect(fuse!.expectedFriendlyDamage).toBe(20);
        expect(f.fire().netDamage).toBe(range.value);
    });

    test("counts a large ally once", () => {
        const f = board({
            neighbor: { size: PBTypes.UnitSizeVals.LARGE },
            neighborCell: { x: 10, y: 10 },
            remainingHp: 10,
        });
        const { fuse } = f.project();
        expect(fuse!.expectedFriendlyDamage).toBe(20);
        expect(f.fire().friendlyDamage).toBe(20);
    });

    test.each([{ maxHp: 5 }, { armor: 999, magicResist: 100 }])(
        "caps flat collateral at actual ally health %j",
        (neighbor) => {
            const f = board({ neighbor, remainingHp: 10 });
            const { range } = f.project();
            expect(range.friendlyFireDamage).toBe(Math.min(20, neighbor.maxHp ?? 500));
            expect(f.fire().netDamage).toBe(range.value);
        },
    );

    test("a neighboring Water Shield absorbs the blast without being spent by projection", () => {
        const f = board({ neighbor: { abilities: ["Water Shield"] }, remainingHp: 10 });
        expect(f.project().range.friendlyFireDamage).toBe(0);
        expect(f.neighbor.hasBuffActive("Water Shield")).toBe(true);
        expect(f.fire().friendlyDamage).toBe(0);
        expect(f.neighbor.hasBuffActive("Water Shield")).toBe(false);
    });

    test("a shield on the primary prevents both damage and explosion", () => {
        const f = board({ target: { abilities: ["Water Shield"] }, remainingHp: 10 });
        expect(f.project().range).toMatchObject({ value: 0, kill: 0, enemyDamage: 0, friendlyFireDamage: 0 });
        expect(f.fire().blasts).toHaveLength(0);
    });

    test("a fire shot uses elemental damage and bypasses the primary's Water Shield", () => {
        const f = board({
            shooter: { damageMin: 20, damageMax: 20, abilities: ["Fire Element"] },
            target: { abilities: ["Water Element", "Water Shield"] },
            remainingHp: 25,
        });
        const { fuse, range } = f.project();
        expect(fuse!.secureKill).toBe(true);
        expect(range).toMatchObject({ value: 5, kill: 1, enemyDamage: 25, friendlyFireDamage: 20 });
        expect(f.fire().netDamage).toBe(range.value);
    });

    test("a living stack has no blast cost", () => {
        const f = board();
        const { fuse, range } = f.project();
        expect(fuse).toMatchObject({ fatalChance: 0, expectedFriendlyDamage: 0 });
        expect(range.value).toBe(40);
        expect(f.fire().blasts).toHaveLength(0);
    });

    test("native Resurrection prevents an explosion and a secure-kill label", () => {
        const f = board({ target: { abilities: ["Resurrection"], spells: ["System:Resurrection"] }, remainingHp: 10 });
        expect(f.target.canSelfResurrect()).toBe(true);
        expect(f.project().range).toMatchObject({ kill: 0, friendlyFireDamage: 0 });
        expect(f.fire().blasts).toHaveLength(0);
        expect(f.target.isDead()).toBe(false);
    });

    test("a spent Resurrection charge allows the burst", () => {
        const f = board({ target: { abilities: ["Resurrection"], spells: ["System:Resurrection"] }, remainingHp: 10 });
        f.target.useSpell("Resurrection");
        const { range } = f.project();
        expect(range).toMatchObject({ kill: 1, friendlyFireDamage: 20 });
        expect(f.fire().netDamage).toBe(range.value);
    });

    test("weights actual misses and exclusive damage rolls", () => {
        const setup = () => {
            const f = board({ shooter: { damageMin: 10, damageMax: 30 }, remainingHp: 20 });
            f.shooter.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
            expect(f.shooter.calculateMissChance(f.target, 0)).toBe(50);
            return f;
        };
        const { range, fuse } = setup().project();
        let net = 0,
            collateral = 0;
        for (const missRoll of [0, 99]) {
            for (let damageRoll = 0; damageRoll < 20; damageRoll++) {
                const f = setup();
                let rawDraw = 0;
                const actual = f.fire(() => {
                    const roll = rawDraw < 2 ? missRoll : rawDraw < 4 ? damageRoll : 0;
                    return rawDraw++ % 2 === 0 ? 0 : roll / 0x100000000;
                });
                net += actual.netDamage;
                collateral += actual.friendlyDamage;
            }
        }
        expect(fuse!.fatalChance).toBeCloseTo(0.25, 8);
        expect(range.value).toBeCloseTo(net / 40, 8);
        expect(range.friendlyFireDamage).toBeCloseTo(collateral / 40, 8);
    });

    test("does not invent the unreachable upper-end killing roll", () => {
        const f = board({ shooter: { damageMin: 10, damageMax: 30 }, remainingHp: 30 });
        expect(f.project().range).toMatchObject({ value: 19.5, kill: 0, friendlyFireDamage: 0 });
    });

    test("Lucky Strike weights damage and collateral independently", () => {
        const options = { shooter: { damageMin: 40, damageMax: 40, abilities: ["Lucky Strike"] }, remainingHp: 42 };
        const original = board(options);
        const ability = original.shooter.getAbility("Lucky Strike")!;
        const chance = original.shooter.calculateAbilityApplyChance(ability, 0) / 100;
        const { range } = original.project();
        const resolve = (roll: number) => {
            const f = board(options);
            let rawDraw = 0;
            return f.fire(() => {
                const value = rawDraw < 2 ? 99 : rawDraw < 4 ? roll : 0;
                return rawDraw++ % 2 === 0 ? 0 : value / 0x100000000;
            });
        };
        const ordinary = resolve(99),
            lucky = resolve(0);
        expect(ordinary.blasts).toHaveLength(0);
        expect(lucky.blasts).toHaveLength(1);
        expect(range.value).toBeCloseTo((1 - chance) * ordinary.netDamage + chance * lucky.netDamage, 8);
    });

    test("fractional Lucky Strike chances match the integer engine roll", () => {
        const setup = () => {
            const f = board({
                shooter: { damageMin: 40, damageMax: 40, abilities: ["Lucky Strike"] },
                remainingHp: 42,
            });
            f.shooter.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Made of Fire"), amount: 1 }));
            return f;
        };
        const original = setup();
        const chance = original.shooter.calculateAbilityApplyChance(original.shooter.getAbility("Lucky Strike")!, 0);
        expect(chance).toBeCloseTo(8.8, 8);
        const { range, fuse } = original.project();
        let net = 0,
            bursts = 0;
        for (let roll = 0; roll < 100; roll++) {
            const f = setup();
            let rawDraw = 0;
            const actual = f.fire(() => {
                const value = rawDraw < 2 ? 99 : rawDraw < 4 ? roll : 0;
                return rawDraw++ % 2 === 0 ? 0 : value / 0x100000000;
            });
            net += actual.netDamage;
            bursts += actual.blasts.length;
        }
        expect(bursts).toBe(9);
        expect(fuse!.fatalChance).toBe(0.09);
        expect(range.value).toBeCloseTo(net / 100, 8);
    });

    test.each(["Double Shot", "Crafted Double Shot"])(
        "prices a guaranteed first-hit kill with %s and Echo",
        (ability) => {
            const f = board({ shooter: { abilities: [ability] }, echo: true, remainingHp: 10 });
            expect(f.shooter.getBonusRangedAttackChance()).toBeGreaterThan(0);
            const { range } = f.project();
            expect(range).toMatchObject({ kill: 1, value: -10, friendlyFireDamage: 20 });
            expect(f.fire().netDamage).toBe(range.value);
        },
    );

    test("a certain hit using the last arrow cannot fire a later damaging volley", () => {
        const f = board({ shooter: { abilities: ["Double Shot"], rangeShots: 1 }, echo: true, remainingHp: 70 });
        const { range, fuse } = f.project();
        expect(fuse).toBeDefined();
        expect(range.value).toBe(40);
        expect(f.fire().netDamage).toBe(40);
    });

    test.each([{ shooter: { abilities: ["Double Shot"] } }, { echo: true }])(
        "defers a possible later fatal volley %j",
        (options) => {
            const f = board({ ...options, remainingHp: 70 });
            expect(f.project().fuse).toBeUndefined();
        },
    );

    test("defers native retries after a missed first shot", () => {
        const f = board({ shooter: { abilities: ["Double Shot"], rangeShots: 1 }, remainingHp: 10 });
        f.shooter.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
        expect(f.project().fuse).toBeUndefined();
    });

    test("defers a possible ranged counter", () => {
        const f = board({ target: { attackType: RANGE, rangeShots: 6 }, remainingHp: 10 });
        expect(f.project().fuse).toBeUndefined();
    });

    test("a spent ranged response leaves the one-impact projection available", () => {
        const f = board({ target: { attackType: RANGE, rangeShots: 6 }, remainingHp: 10 });
        f.fight.addRepliedAttack(f.target.getId());
        const { range, fuse } = f.project();
        expect(fuse).toBeDefined();
        expect(f.fire().netDamage).toBe(range.value);
    });

    test("a last-arrow shielded hit cannot become a native or Echo kill", () => {
        const f = board({
            shooter: { abilities: ["Double Shot"], rangeShots: 1 },
            target: { abilities: ["Water Shield"] },
            echo: true,
            remainingHp: 10,
        });
        expect(f.project().range).toMatchObject({ value: 0, kill: 0, friendlyFireDamage: 0 });
        expect(f.fire().blasts).toHaveLength(0);
    });

    test("Dense Flesh's primary cost prevents an unaffordable later hit", () => {
        const f = board({
            shooter: { abilities: ["Double Shot"], rangeShots: 2 },
            target: { abilities: ["Dense Flesh"] },
            echo: true,
            remainingHp: 70,
        });
        expect(f.shooter.projectRangeShotsAfterVolleys(f.target)).toBe(0);
        expect(f.project().range.value).toBe(40);
        expect(f.fire().netDamage).toBe(40);
    });

    test("keeps a secondary Last Fuse chain in engine search", () => {
        const f = board({ neighbor: { maxHp: 5 }, remainingHp: 10 });
        f.fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.LAST_FUSE);
        f.unitsHolder.applyArtifacts(f.fight);
        expect(f.project().fuse).toBeUndefined();
        expect(f.fire().blasts.length).toBeGreaterThan(1);
    });

    test.each([
        "Through Shot",
        "Area Throw",
        "Large Caliber",
        "Chakram",
        "Petrifying Gaze",
        "Borrowed Grace",
        "Absolving Arrow",
    ])("defers replacement or secondary ability %s", (ability) => {
        const f = board({ shooter: { abilities: [ability] }, remainingHp: 10 });
        expect(f.project().fuse).toBeUndefined();
    });

    test("preserves historical metadata for targets without the artifact", () => {
        const f = board({ fuse: false, remainingHp: 10 });
        expect(f.project().fuse).toBeUndefined();
        expect(f.project().range).toMatchObject({ value: 10, kill: 1, friendlyFireDamage: 0 });
    });

    test("does not project a stationary blast for an explicit post-move stack override", () => {
        const f = board({ remainingHp: 10 });
        const future = evaluateRangeCandidateDamage(
            f.shooter,
            f.context,
            f.evaluation,
            f.target.getId(),
            1,
            false,
            f.target.getId(),
            f.shooter.getAmountAlive(),
        );
        expect(future.friendlyFireDamage).toBe(0);
        expect(f.project().range.friendlyFireDamage).toBe(20);
    });

    test("does not attribute primary damage or a kill to a different aim identity", () => {
        const f = board({ remainingHp: 10 });
        const range = evaluateRangeCandidateDamage(
            f.shooter,
            f.context,
            f.evaluation,
            f.safe.getId(),
            1,
            false,
            f.safe.getId(),
        );
        expect(range).toMatchObject({ value: -10, kill: 0, primaryTargetDamage: 0, aimTargetDamage: 0 });
    });

    test("enriches the incumbent and selects a safer ranged target", () => {
        const f = board({ remainingHp: 10 });
        const candidates = enumerateCandidates(f.shooter, f.context, f.actions, {
            enrichIncumbentMetadata: true,
        }).candidates;
        expect(candidates[0].features.expectedDamage).toBe(-10);
        const chosen = selectV08DirectCombatCandidate(candidates)!;
        expect(chosen.targetId).toBe(f.safe.getId());
        expect(chosen.actions.some((action) => action.type === "range_attack")).toBe(true);
        expect(f.fire(() => 0, chosen.actions).blasts).toHaveLength(0);
        expect(f.neighbor.getCumulativeHp()).toBe(500);
    });

    test("stationary shot qualification also subtracts collateral when comparing targets", () => {
        const f = board({ shooter: { damageMin: 600, damageMax: 600 }, target: { maxHp: 500 }, safe: { armor: 14 } });
        const best = findBestLegalStationaryRangeAttack(f.shooter, f.context)!;
        expect(f.project().range.value).toBe(400);
        expect(best.primaryTargetId).toBe(f.safe.getId());
        expect(best.expectedDamage).toBe(429);
    });
});
