import { afterEach, describe, expect, test } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { estimateLastFuseMeleeDamage } from "../../src/ai/last_fuse_estimate";
import { selectV08DirectCombatCandidate } from "../../src/ai/versions/v0_8";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getEffectConfig } from "../../src/configuration/config_provider";
import { Effect } from "../../src/effects/effect";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function board(
    options: {
        team?: TeamType;
        direction?: XY;
        target?: TestUnitOptions;
        attacker?: TestUnitOptions;
        neighbor?: TestUnitOptions;
        remainingHp?: number;
        fuse?: boolean;
        attackerCell?: XY;
        neighborCell?: XY;
    } = {},
) {
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const team = options.team ?? LEFT;
    const enemy = team === LEFT ? RIGHT : LEFT;
    const direction = options.direction ?? { x: 1, y: 0 };
    const attacker = createTestUnit({
        name: "Attacker",
        team,
        attack: 10,
        damageMin: 50,
        damageMax: 50,
        maxHp: 500,
        ...options.attacker,
    });
    const target = createTestUnit({ name: "Fuse", team: enemy, armor: 10, maxHp: 100, ...options.target });
    const neighbor = createTestUnit({ name: "Neighbor", team, maxHp: 500, ...options.neighbor });
    const far = createTestUnit({ name: "Far ally", team, maxHp: 500 });
    const sameTeam = createTestUnit({ name: "Corpse's ally", team: enemy, maxHp: 500 });
    const base = { x: 8, y: 8 };
    const targetCell = { x: 8 + direction.x, y: 8 + direction.y };
    placeUnit(combat.grid, combat.unitsHolder, attacker, options.attackerCell ?? base);
    placeUnit(combat.grid, combat.unitsHolder, target, targetCell);
    const forward = {
        x:
            direction.x > 0
                ? targetCell.x + 1
                : direction.x < 0
                  ? targetCell.x - target.getFootprintWidth()
                  : targetCell.x,
        y:
            direction.y > 0
                ? targetCell.y + 1
                : direction.y < 0
                  ? targetCell.y - target.getFootprintHeight()
                  : targetCell.y,
    };
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        neighbor,
        options.neighborCell ?? {
            x: forward.x - direction.y,
            y: forward.y + direction.x,
        },
    );
    placeUnit(combat.grid, combat.unitsHolder, far, { x: 2, y: 2 });
    placeUnit(combat.grid, combat.unitsHolder, sameTeam, {
        x: forward.x,
        y: forward.y,
    });
    if (options.remainingHp !== undefined)
        target.applyDamage(target.getCumulativeHp() - options.remainingHp, 0, new SceneLogMock(), false);
    const fight = FightStateManager.getInstance().getFightProperties();
    if (options.fuse !== false) {
        fight.setArtifactPerTeam(enemy, 2, Tier2Artifact.LAST_FUSE);
        combat.unitsHolder.applyArtifacts(fight);
    }
    for (const unit of [attacker, neighbor, target]) unit.trySeedWaterShield();
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
    const actions: GameAction[] = [
        { type: "melee_attack", attackerId: attacker.getId(), targetId: target.getId(), attackFrom: base },
    ];
    const project = (stand = base, sequence = actions) => {
        const before = JSON.stringify(
            [...combat.unitsHolder.getAllUnits().values()].map((unit) => [
                unit.getPosition(),
                unit.getUnitProperties(),
            ]),
        );
        setDeterministicRandomSource(() => {
            throw new Error("Last Fuse projection must not consume combat RNG");
        });
        const result = estimateLastFuseMeleeDamage(attacker, target, context, stand, sequence);
        expect(
            JSON.stringify(
                [...combat.unitsHolder.getAllUnits().values()].map((unit) => [
                    unit.getPosition(),
                    unit.getUnitProperties(),
                ]),
            ),
        ).toBe(before);
        return result;
    };
    const fire = (random: () => number = () => 0, sequence = actions) => {
        setDeterministicRandomSource(random);
        const engine = new GameActionEngine({
            ...combat,
            fightProperties: fight,
            moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => attacker.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400, 1500] }),
        });
        const results = sequence.map((action) => engine.apply(action));
        expect(results.every((result) => result.completed)).toBe(true);
        const result = results[results.length - 1];
        const blasts = result.events.filter((event) => event.type === "pyre_exploded");
        const alliedIds = new Set([attacker.getId(), neighbor.getId(), far.getId()]);
        return {
            result,
            blasts,
            friendlyDamage: blasts
                .flatMap((event) => event.hits)
                .filter((hit) => alliedIds.has(hit.unitId))
                .reduce((sum, hit) => sum + hit.amount, 0),
        };
    };
    return { ...combat, attacker, target, neighbor, far, sameTeam, fight, context, actions, base, project, fire };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("Last Fuse melee estimates", () => {
    for (const team of [LEFT, RIGHT] as const) {
        test.each([
            { x: 1, y: 0 },
            { x: -1, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: -1 },
        ])("prices direct and diagonal contact, team=" + team + " direction=%j", (direction) => {
            const f = board({ team, direction, remainingHp: 10 });
            const estimate = f.project()!;
            const blast = f.fire();
            expect(blast.blasts).toHaveLength(1);
            expect(estimate.expectedFriendlyDamage).toBe(blast.friendlyDamage);
            expect(estimate.expectedNetDamage).toBe(10 - blast.friendlyDamage);
            expect(f.far.getCumulativeHp()).toBe(500);
            expect(f.sameTeam.getCumulativeHp()).toBe(500);
        });
    }

    test.each([1, 2, 3, 4, 5])("uses the per-power minimum %i", (stackPower) => {
        const f = board({ target: { stackPower }, remainingHp: 1 });
        const estimate = f.project()!;
        expect(estimate.expectedFriendlyDamage).toBe(stackPower * 20 * 2);
        expect(f.fire().friendlyDamage).toBe(estimate.expectedFriendlyDamage);
    });

    test("uses the fatal hit's remaining HP after attrition when it exceeds the minimum", () => {
        const f = board({
            attacker: { damageMin: 2000, damageMax: 2000 },
            target: { maxHp: 100, amountAlive: 10 },
            remainingHp: 600,
        });
        const estimate = f.project()!;
        expect(estimate.expectedFriendlyDamage).toBe(240);
        expect(f.fire().friendlyDamage).toBe(240);
    });

    test.each([
        { footprintWidth: 1, footprintHeight: 2 },
        { footprintWidth: 2, footprintHeight: 1 },
        { size: PBTypes.UnitSizeVals.LARGE },
    ])("prices the whole corpse footprint %j", (target) => {
        const f = board({ target, direction: { x: -1, y: 0 }, remainingHp: 10 });
        const estimate = f.project()!;
        expect(f.fire().friendlyDamage).toBe(estimate.expectedFriendlyDamage);
    });

    test("flat blast damage ignores the allies' armor and magic resistance", () => {
        const f = board({ neighbor: { armor: 999, magicResist: 100 }, remainingHp: 10 });
        expect(f.project()!.expectedFriendlyDamage).toBe(40);
        expect(f.fire().friendlyDamage).toBe(40);
    });

    test.each(["attacker", "neighbor"] as const)(
        "accounts for Water Shield on the %s without spending it in the preview",
        (protectedUnit) => {
            const f = board({ [protectedUnit]: { abilities: ["Water Shield"] }, remainingHp: 10 });
            const estimate = f.project()!;
            expect(f[protectedUnit].hasBuffActive("Water Shield")).toBe(true);
            const expectedDamage = protectedUnit === "attacker" ? 40 : 20;
            expect(estimate.expectedFriendlyDamage).toBe(expectedDamage);
            expect(f.fire().friendlyDamage).toBe(expectedDamage);
            expect(f[protectedUnit].hasBuffActive("Water Shield")).toBe(false);
        },
    );

    test("a primary Water Shield prevents the killing blow and blast", () => {
        const f = board({ target: { abilities: ["Water Shield"] }, remainingHp: 10 });
        expect(f.project()).toMatchObject({
            expectedFriendlyDamage: 0,
            expectedNetDamage: 0,
            fatalChance: 0,
            secureKill: false,
        });
        expect(f.fire().blasts).toHaveLength(0);
    });

    test("a spent retaliation preserves the attacker's Water Shield for the blast", () => {
        const f = board({ attacker: { abilities: ["Water Shield"] }, remainingHp: 10 });
        f.target.setResponded(true);
        expect(f.project()!.expectedFriendlyDamage).toBe(20);
        expect(f.fire().friendlyDamage).toBe(20);
    });

    test("a fire counter leaves Water Shield available for the explosion", () => {
        const f = board({
            attacker: { abilities: ["Water Shield"] },
            target: { abilities: ["Fire Element"] },
            remainingHp: 10,
        });
        expect(f.project()!.expectedFriendlyDamage).toBe(20);
        expect(f.fire().friendlyDamage).toBe(20);
    });

    test("caps the attacker's blast loss after the ordinary counter", () => {
        const f = board({ attacker: { maxHp: 5 }, remainingHp: 10 });
        expect(f.project()!.expectedFriendlyDamage).toBe(24);
        expect(f.fire().friendlyDamage).toBe(24);
    });

    test("weights a counter's chance to spend Water Shield", () => {
        const setup = () => {
            const f = board({ attacker: { abilities: ["Water Shield"] }, remainingHp: 10 });
            f.target.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
            expect(f.target.calculateMissChance(f.attacker, 0)).toBe(50);
            return f;
        };
        const estimate = setup().project()!;
        let actual = 0;
        for (const counterRoll of [0, 99]) {
            const f = setup();
            let rawDraw = 0;
            actual += f.fire(() => {
                const roll = rawDraw >= 2 && rawDraw < 4 ? counterRoll : 0;
                return rawDraw++ % 2 === 0 ? 0 : roll / 0x100000000;
            }).friendlyDamage;
        }
        expect(estimate.expectedFriendlyDamage).toBe(30);
        expect(estimate.expectedFriendlyDamage).toBe(actual / 2);
    });

    test("ordinary movement uses the future attacking position", () => {
        const f = board({ attackerCell: { x: 5, y: 8 }, remainingHp: 10 });
        f.unitsHolder.refreshStackPowerForAllUnits();
        const candidates = enumerateCandidates(f.attacker, f.context, [
            { type: "end_turn", unitId: f.attacker.getId(), reason: "manual" },
        ]).candidates;
        const candidate = candidates.find(
            (c) =>
                c.kind === "melee" &&
                c.targetId === f.target.getId() &&
                c.standCell?.x === f.base.x &&
                c.standCell.y === f.base.y,
        )!;
        expect(candidate).toBeDefined();
        const estimate = f.project(f.base, candidate.actions)!;
        expect(candidate.features.expectedDamage).toBe(estimate.expectedNetDamage);
        expect(f.fire(() => 0, candidate.actions).friendlyDamage).toBe(estimate.expectedFriendlyDamage);
    });

    test("aura-dependent movement is left to the full combat simulation", () => {
        const f = board({ attackerCell: { x: 5, y: 8 }, neighbor: { abilities: ["Luck Aura"] }, remainingHp: 10 });
        expect(f.neighbor.getAuraEffects().length).toBeGreaterThan(0);
        const candidate = enumerateCandidates(f.attacker, f.context, [
            { type: "end_turn", unitId: f.attacker.getId(), reason: "manual" },
        ]).candidates.find(
            (c) =>
                c.kind === "melee" &&
                c.targetId === f.target.getId() &&
                c.standCell?.x === f.base.x &&
                c.standCell.y === f.base.y,
        )!;
        expect(candidate).toBeDefined();
        expect(f.project(f.base, candidate.actions)).toBeUndefined();
    });

    test("native resurrection prevents a burst and is not labeled a stack kill", () => {
        const f = board({ target: { abilities: ["Resurrection"], spells: ["System:Resurrection"] }, remainingHp: 10 });
        expect(f.target.canSelfResurrect()).toBe(true);
        expect(f.project()).toMatchObject({ expectedFriendlyDamage: 0, fatalChance: 0, secureKill: false });
        expect(f.fire().blasts).toHaveLength(0);
        expect(f.target.isDead()).toBe(false);
    });

    test("a spent Resurrection charge no longer prevents the explosion", () => {
        const f = board({ target: { abilities: ["Resurrection"], spells: ["System:Resurrection"] }, remainingHp: 10 });
        f.target.useSpell("Resurrection");
        expect(f.target.canSelfResurrect()).toBe(false);
        expect(f.project()!.fatalChance).toBe(1);
        expect(f.fire().friendlyDamage).toBe(40);
    });

    test("counts a large allied body once across all touching cells", () => {
        const f = board({
            neighbor: { size: PBTypes.UnitSizeVals.LARGE },
            neighborCell: { x: 11, y: 10 },
            remainingHp: 10,
        });
        expect(f.project()!.expectedFriendlyDamage).toBe(40);
        expect(f.fire().friendlyDamage).toBe(40);
    });

    test("a potentially lethal counter is evaluated by engine search", () => {
        const f = board({ attacker: { maxHp: 1 }, remainingHp: 10 });
        expect(f.project()).toBeUndefined();
    });

    test("a living stack has no explosion cost", () => {
        const f = board({ remainingHp: 100 });
        expect(f.project()).toMatchObject({ expectedFriendlyDamage: 0, fatalChance: 0, secureKill: false });
        expect(f.fire().blasts).toHaveLength(0);
    });

    test("charges only actual available allied HP", () => {
        const f = board({ neighbor: { maxHp: 5 }, remainingHp: 10 });
        expect(f.project()!.expectedFriendlyDamage).toBe(25);
        expect(f.fire().friendlyDamage).toBe(25);
    });

    test("includes the attacker's proposed position instead of its old cell", () => {
        const f = board({ remainingHp: 10 });
        f.attacker.setPosition(f.far.getPosition().x, f.far.getPosition().y);
        expect(f.project(f.base)!.expectedFriendlyDamage).toBe(40);
    });

    test("weights misses and fatal damage rolls against real resolved bursts", () => {
        const options = { remainingHp: 20, attacker: { damageMin: 10, damageMax: 30 } };
        const original = board(options);
        original.attacker.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
        expect(original.attacker.calculateMissChance(original.target, 0)).toBe(50);
        const estimate = original.project()!;
        let total = 0;
        for (const missRoll of [0, 99]) {
            for (let damageRoll = 0; damageRoll < 20; damageRoll++) {
                const f = board(options);
                f.attacker.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
                let rawDraw = 0;
                total += f.fire(() => {
                    const roll = rawDraw < 2 ? missRoll : rawDraw < 4 ? damageRoll : 0;
                    return rawDraw++ % 2 === 0 ? 0 : roll / 0x100000000;
                }).friendlyDamage;
            }
        }
        expect(estimate.expectedFriendlyDamage).toBeCloseTo(total / 40, 8);
    });

    test("keeps secondary chains and native repeat attacks with engine search", () => {
        const f = board({ neighbor: { maxHp: 5 }, remainingHp: 10 });
        f.fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.LAST_FUSE);
        f.unitsHolder.applyArtifacts(f.fight);
        expect(f.project()).toBeUndefined();
        expect(f.fire().blasts.length).toBeGreaterThan(1);
        const double = board({ attacker: { abilities: ["Double Punch"] }, remainingHp: 10 });
        expect(double.project()).toBeUndefined();
    });

    test("does not alter estimates for targets without Last Fuse", () => {
        const f = board({ fuse: false, remainingHp: 10 });
        expect(f.project()).toBeUndefined();
    });

    test("candidate selection avoids an execution whose blast hurts the army more", () => {
        const f = board({ remainingHp: 10 });
        const safe = createTestUnit({ name: "Safer target", team: RIGHT, maxHp: 1000, armor: 10 });
        placeUnit(f.grid, f.unitsHolder, safe, { x: 7, y: 8 });
        f.unitsHolder.applyArtifacts(f.fight);
        const candidates = enumerateCandidates(f.attacker, f.context, f.actions, {
            enrichIncumbentMetadata: true,
        }).candidates;
        const incumbent = candidates[0];
        expect(incumbent.features.expectedDamage).toBeLessThan(0);
        expect(selectV08DirectCombatCandidate(candidates)?.targetId).toBe(safe.getId());
    });

    test.each(["Rapid Charge", "Backstab"])("keeps position-dependent %s valuations separate", (ability) => {
        const f = board({
            attacker: { abilities: [ability], damageMin: 10, damageMax: 10, stackPower: 5 },
            remainingHp: 15,
        });
        const candidates = enumerateCandidates(f.attacker, f.context, [
            { type: "end_turn", unitId: f.attacker.getId(), reason: "manual" },
        ]).candidates.filter((c) => c.kind === "melee" && c.targetId === f.target.getId());
        const values = new Set<number>();
        for (const candidate of candidates) {
            const estimate = f.project(candidate.standCell!, candidate.actions);
            if (!estimate) continue;
            expect(candidate.features.expectedDamage).toBe(estimate.expectedNetDamage);
            values.add(candidate.features.expectedDamage);
        }
        expect(values.size).toBeGreaterThan(1);
    });
});
