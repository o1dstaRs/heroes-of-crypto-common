/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import {
    enumerateCandidates,
    getEnemiesCellsWithinMovementRange,
    type CandidateKind,
    type IEnumeratedCandidate,
} from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell, getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

interface LegalityHarness {
    combat: CombatTestContext;
    context: IDecisionContext;
    engine: GameActionEngine;
    fightProperties: ReturnType<FightStateManager["getFightProperties"]>;
}

function makeReal(team: number, faction: string, name: string): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function placeLarge(combat: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) {
        throw new Error("Invalid large-unit test placement");
    }
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function activate(combat: CombatTestContext, active: Unit): LegalityHarness {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(combat.grid.getGridType());
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(active.getTeam(), 1000);

    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
    };
    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => active.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(active, context),
    });

    return { combat, context, engine, fightProperties };
}

const incumbentFor = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];

function candidatesOfKinds(
    candidates: IEnumeratedCandidate[],
    kinds: readonly CandidateKind[],
): IEnumeratedCandidate[] {
    const selected = new Set<CandidateKind>(kinds);
    return candidates.filter((candidate) => selected.has(candidate.kind));
}

function expectCandidatesToApply(harness: LegalityHarness, candidates: IEnumeratedCandidate[]): void {
    const baseline = snapshotBattle(harness.combat.unitsHolder, harness.combat.grid, harness.fightProperties);
    const failures: string[] = [];

    for (const candidate of candidates) {
        try {
            for (const action of candidate.actions) {
                const result = harness.engine.apply(action);
                if (!result.completed) {
                    failures.push(
                        `${candidate.kind} ${JSON.stringify(candidate.actions)} rejected ${result.rejectionReason ?? "without a reason"}`,
                    );
                    break;
                }
            }
        } finally {
            restoreBattle(baseline, harness.combat.unitsHolder, harness.combat.grid, harness.fightProperties);
            harness.combat.damageStatisticHolder.clear();
        }
    }

    expect(failures).toEqual([]);
}

describe("enumerated candidate engine legality", () => {
    it("applies every emitted move and melee shape, including move-then-strike", () => {
        const combat = createCombatTestContext();
        const active = createTestUnit({
            team: LOWER,
            name: "Brawler",
            attackType: MELEE,
            speed: 4,
            amountAlive: 5,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Target", attackType: MELEE, amountAlive: 20 });
        placeUnit(combat.grid, combat.unitsHolder, active, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 8 });
        const harness = activate(combat, active);
        const { candidates } = enumerateCandidates(active, harness.context, incumbentFor(active));
        const applicable = candidatesOfKinds(candidates, ["move", "melee"]);

        expect(applicable.some((candidate) => candidate.kind === "move")).toBe(true);
        expect(
            applicable.some(
                (candidate) =>
                    candidate.kind === "melee" && candidate.actions.some((action) => action.type === "move_unit"),
            ),
        ).toBe(true);
        expectCandidatesToApply(harness, applicable);
    });

    it("applies every emitted ranged aim", () => {
        const combat = createCombatTestContext();
        const active = createTestUnit({
            team: LOWER,
            name: "Shooter",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            speed: 3,
            amountAlive: 5,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Target", attackType: MELEE, amountAlive: 20 });
        placeUnit(combat.grid, combat.unitsHolder, active, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 10, y: 10 });
        const harness = activate(combat, active);
        const { candidates } = enumerateCandidates(active, harness.context, incumbentFor(active));
        const shots = candidatesOfKinds(candidates, ["shot"]);

        expect(shots.length).toBeGreaterThan(0);
        expectCandidatesToApply(harness, shots);
    });

    it("applies every emitted Area Throw aim", () => {
        const combat = createCombatTestContext();
        const active = makeReal(LOWER, "Nature", "Gargantuan");
        const enemyA = createTestUnit({ team: UPPER, name: "Target A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: UPPER, name: "Target B", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, active, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 11 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 11, y: 10 });
        const harness = activate(combat, active);
        const { candidates } = enumerateCandidates(active, harness.context, incumbentFor(active));
        const throws = candidatesOfKinds(candidates, ["area_throw"]);

        expect(throws.length).toBeGreaterThan(0);
        expectCandidatesToApply(harness, throws);
    });

    it("applies an in-place mountain strike and deduplicates the same incumbent", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const active = createTestUnit({ team: LOWER, name: "Miner", attackType: MELEE, speed: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, active, { x: 4, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 14, y: 14 });
        const harness = activate(combat, active);

        expect(
            enumerateCandidates(active, harness.context, incumbentFor(active)).candidates.some(
                (candidate) => candidate.kind === "mine",
            ),
        ).toBe(false);
        const mine = enumerateCandidates(active, harness.context, incumbentFor(active), {
            includeMountainAttacks: true,
        }).candidates.filter((candidate) => candidate.kind === "mine");

        expect(mine).toHaveLength(1);
        expect(mine[0].standCell).toEqual(active.getBaseCell());
        expect(mine[0].targetCell).toEqual({ x: 5, y: 7 });
        expect(mine[0].actions).toEqual([
            {
                type: "obstacle_attack",
                attackerId: active.getId(),
                targetPosition: getPositionForCell(
                    { x: 5, y: 7 },
                    testGridSettings.getMinX(),
                    testGridSettings.getStep(),
                    testGridSettings.getHalfStep(),
                ),
                attackFrom: { x: 4, y: 7 },
                path: undefined,
                hasLavaCell: undefined,
                hasWaterCell: undefined,
            },
        ]);
        expectCandidatesToApply(harness, mine);

        const anchored = enumerateCandidates(active, harness.context, mine[0].actions, {
            includeMountainAttacks: true,
            enrichIncumbentMetadata: true,
        }).candidates;
        expect(
            anchored.filter((candidate) => candidate.actions.some((action) => action.type === "obstacle_attack")),
        ).toHaveLength(1);
        expect(anchored[0]).toMatchObject({
            kind: "incumbent",
            targetCell: { x: 5, y: 7 },
            standCell: { x: 4, y: 7 },
        });
    });

    it("applies a move-to-mine mountain strike with its authoritative route metadata", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const active = createTestUnit({ team: LOWER, name: "Miner", attackType: MELEE, speed: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, active, { x: 2, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 14, y: 14 });
        const harness = activate(combat, active);
        const mine = enumerateCandidates(active, harness.context, incumbentFor(active), {
            includeMountainAttacks: true,
        }).candidates.filter((candidate) => candidate.kind === "mine");

        expect(mine).toHaveLength(1);
        const action = mine[0].actions[0];
        expect(action.type).toBe("obstacle_attack");
        if (action.type === "obstacle_attack") {
            expect(action.path?.length).toBeGreaterThan(0);
            expect(action.path?.at(-1)).toEqual(action.attackFrom);
            expect(action.hasLavaCell).toBe(false);
            expect(action.hasWaterCell).toBe(false);
        }
        expectCandidatesToApply(harness, mine);
    });

    it("does not emit mountain challengers for unavailable or engine-rejected mining states", () => {
        const mineCount = (combat: CombatTestContext, active: Unit): number => {
            const harness = activate(combat, active);
            return enumerateCandidates(active, harness.context, incumbentFor(active), {
                includeMountainAttacks: true,
            }).candidates.filter((candidate) => candidate.kind === "mine").length;
        };

        const normal = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const normalMiner = createTestUnit({ team: LOWER, attackType: MELEE, speed: 3 });
        const normalEnemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(normal.grid, normal.unitsHolder, normalMiner, { x: 4, y: 7 });
        placeUnit(normal.grid, normal.unitsHolder, normalEnemy, { x: 14, y: 14 });
        expect(mineCount(normal, normalMiner)).toBe(0);

        const cleared = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const clearedMiner = createTestUnit({ team: LOWER, attackType: MELEE, speed: 3 });
        const clearedEnemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(cleared.grid, cleared.unitsHolder, clearedMiner, { x: 4, y: 7 });
        placeUnit(cleared.grid, cleared.unitsHolder, clearedEnemy, { x: 14, y: 14 });
        const clearedHarness = activate(cleared, clearedMiner);
        clearedHarness.fightProperties.setObstacleHitsLeft(0);
        expect(
            enumerateCandidates(clearedMiner, clearedHarness.context, incumbentFor(clearedMiner), {
                includeMountainAttacks: true,
            }).candidates.some((candidate) => candidate.kind === "mine"),
        ).toBe(false);

        const ranged = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const rangedMiner = createTestUnit({ team: LOWER, attackType: RANGE, rangeShots: 5, speed: 3 });
        const rangedEnemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(ranged.grid, ranged.unitsHolder, rangedMiner, { x: 4, y: 7 });
        placeUnit(ranged.grid, ranged.unitsHolder, rangedEnemy, { x: 14, y: 14 });
        expect(mineCount(ranged, rangedMiner)).toBe(0);

        const immobilized = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const immobilizedMiner = createTestUnit({ team: LOWER, attackType: MELEE, speed: 3 });
        const immobilizedEnemy = createTestUnit({ team: UPPER, attackType: MELEE });
        immobilizedMiner.applyEffect(new EffectFactory().makeEffect("Paralysis")!);
        placeUnit(immobilized.grid, immobilized.unitsHolder, immobilizedMiner, { x: 4, y: 7 });
        placeUnit(immobilized.grid, immobilized.unitsHolder, immobilizedEnemy, { x: 14, y: 14 });
        expect(mineCount(immobilized, immobilizedMiner)).toBe(0);

        const forced = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const forcedMiner = createTestUnit({ team: LOWER, attackType: MELEE, speed: 3 });
        const forcedEnemy = createTestUnit({ team: UPPER, attackType: MELEE });
        forcedMiner.setTarget(forcedEnemy.getId());
        placeUnit(forced.grid, forced.unitsHolder, forcedMiner, { x: 4, y: 7 });
        placeUnit(forced.grid, forced.unitsHolder, forcedEnemy, { x: 14, y: 14 });
        expect(mineCount(forced, forcedMiner)).toBe(0);
    });

    it("applies targeted, mass, and movement-range spell candidates, including Castling", () => {
        const castlingCombat = createCombatTestContext();
        const harpy = makeReal(LOWER, "Might", "Harpy");
        harpy.setStackPower(5);
        const nearEnemy = createTestUnit({ team: UPPER, name: "Near", attackType: MELEE, amountAlive: 5 });
        const farEnemy = createTestUnit({ team: UPPER, name: "Far", attackType: MELEE, amountAlive: 5 });
        placeUnit(castlingCombat.grid, castlingCombat.unitsHolder, harpy, { x: 2, y: 2 });
        placeUnit(castlingCombat.grid, castlingCombat.unitsHolder, nearEnemy, { x: 5, y: 5 });
        placeUnit(castlingCombat.grid, castlingCombat.unitsHolder, farEnemy, { x: 15, y: 15 });
        const castlingHarness = activate(castlingCombat, harpy);
        const castling = enumerateCandidates(harpy, castlingHarness.context, incumbentFor(harpy)).candidates.filter(
            (candidate) => candidate.kind === "spell" && candidate.spellName === "Castling",
        );

        expect(castling).toHaveLength(1);
        expect(castling[0].targetId).toBe(nearEnemy.getId());
        expectCandidatesToApply(castlingHarness, castling);

        const resurrectionCombat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const hurtAlly = createTestUnit({ team: LOWER, name: "Hurt", attackType: MELEE, amountAlive: 5, maxHp: 10 });
        const resurrectionEnemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE, amountAlive: 5 });
        placeLarge(resurrectionCombat, angel, { x: 4, y: 4 });
        placeUnit(resurrectionCombat.grid, resurrectionCombat.unitsHolder, hurtAlly, { x: 8, y: 4 });
        placeUnit(resurrectionCombat.grid, resurrectionCombat.unitsHolder, resurrectionEnemy, { x: 8, y: 12 });
        hurtAlly.applyDamage(25, 0, new SceneLogMock());
        const resurrectionHarness = activate(resurrectionCombat, angel);
        const resurrection = enumerateCandidates(
            angel,
            resurrectionHarness.context,
            incumbentFor(angel),
        ).candidates.filter((candidate) => candidate.kind === "spell" && candidate.spellName === "Resurrection");

        expect(resurrection).toHaveLength(1);
        expectCandidatesToApply(resurrectionHarness, resurrection);

        const massCombat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const flyer = createTestUnit({
            team: UPPER,
            name: "Flyer",
            attackType: MELEE,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(massCombat.grid, massCombat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(massCombat.grid, massCombat.unitsHolder, flyer, { x: 4, y: 12 });
        const massHarness = activate(massCombat, valkyrie);
        const windFlow = enumerateCandidates(valkyrie, massHarness.context, incumbentFor(valkyrie)).candidates.filter(
            (candidate) => candidate.kind === "spell" && candidate.spellName === "Wind Flow",
        );

        expect(windFlow).toHaveLength(1);
        expectCandidatesToApply(massHarness, windFlow);
    });
});
