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

import { describe, expect, spyOn, test } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import type { DecisionPathCatalog, IDecisionPathCatalogStats } from "../../src/ai/decision_path_catalog";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { XY } from "../../src/utils/math";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { liveTwinSetup } from "../../src/simulation/livetwin";
import { runMatch, type ITurnExecutionObservation } from "../../src/simulation/battle_engine";
import {
    emptyV08BlockCenterMetrics,
    findIndependentV08BlockCenterDirectOption,
    fingerprintV08BlockCenterActionPlan,
    isV08BlockCenterABAOscillation,
    isV08BlockCenterNonDamagingSpellTurnExempt,
    isV08BlockCenterNonProgressMove,
    isV08BlockCenterTerminalNonProgressMove,
    isV08BlockCenterUrgentMountainABAOscillation,
    isV08BlockCenterUrgentMountainTerminalJitter,
    planV08BlockCenterActionGame,
    summarizeV08BlockCenterActionPanel,
    V08BlockCenterActionAuditor,
    v08BlockCenterActionSignature,
    v08BlockCenterArtifactPrefix,
    v08BlockCenterFootprintManhattanDistance,
    withV08BlockCenterCandidateEnvironment,
    v08BlockCenterFootprintDistance,
    V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
    type IV08BlockCenterActionPanelOptions,
    type IV08BlockCenterActionRecord,
    type IV08BlockCenterMetrics,
    type V08BlockCenterIssue,
} from "../../src/simulation/v0_8_block_center_action_panel";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const OPTIONS: IV08BlockCenterActionPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 4,
    baseSeed: 0x1234_5678,
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
};

const activatedActionEngine = (
    combat: ReturnType<typeof createCombatTestContext>,
    actor: ReturnType<typeof createTestUnit>,
): { context: IDecisionContext; engine: GameActionEngine } => {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(combat.grid.getGridType());
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(
        PBTypes.TeamVals.LOWER,
        combat.unitsHolder
            .getAllUnits()
            .values()
            .filter((unit) => unit.getTeam() === PBTypes.TeamVals.LOWER).length,
    );
    fightProperties.setTeamUnitsAlive(
        PBTypes.TeamVals.UPPER,
        combat.unitsHolder
            .getAllUnits()
            .values()
            .filter((unit) => unit.getTeam() === PBTypes.TeamVals.UPPER && !unit.isDead()).length,
    );
    fightProperties.startTurn(actor.getTeam(), 1_000);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
        decisionOrigin: "root",
    };
    return {
        context,
        engine: new GameActionEngine({
            fightProperties,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: combat.attackHandler,
            getCurrentActiveUnitId: () => actor.getId(),
        }),
    };
};

const recordFor = (game: number): IV08BlockCenterActionRecord => {
    const plan = planV08BlockCenterActionGame(OPTIONS, game);
    const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
    const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
    const metrics = emptyV08BlockCenterMetrics();
    metrics.observedTurns = 4;
    metrics.oracleDirectEligibleTurns = 1;
    metrics.mountainAdjacentTurns = 1;
    metrics.mountainAdjacentDirectEligibleTurns = 1;
    metrics.lateDirectEligibleTurns = 1;
    const fixtureCreatureMetrics = { ...metrics };
    return {
        schema: V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
        sourceCommit: OPTIONS.sourceCommit ?? null,
        sourceDirty: false,
        game,
        pair: plan.pair,
        seed: plan.seed,
        mapType: PBTypes.GridVals.BLOCK_CENTER,
        candidateVersion: OPTIONS.candidateVersion,
        opponentVersion: OPTIONS.opponentVersion,
        inheritCandidateEnvironment: false,
        candidateSide: plan.candidateSide,
        candidateRoster: candidateRoster.map(({ creatureName }) => creatureName),
        opponentRoster: opponentRoster.map(({ creatureName }) => creatureName),
        winner: "candidate",
        laps: 9,
        endReason: "elimination",
        candidateEngineRejections: 0,
        metrics,
        byCreature: { "Fixture Creature": fixtureCreatureMetrics },
        mountainStates: {
            both_intact: 1,
            left_only: 1,
            right_only: 1,
            cleared: 1,
        },
        failureSamples: [],
    };
};

const setRecordMetric = (
    record: IV08BlockCenterActionRecord,
    key: keyof IV08BlockCenterMetrics,
    value: number,
): void => {
    record.metrics[key] = value;
    const creatureMetrics = Object.values(record.byCreature);
    if (creatureMetrics.length !== 1) throw new Error("Fixture record must have exactly one creature bucket");
    creatureMetrics[0]![key] = value;
};

const failureSampleFor = (
    record: IV08BlockCenterActionRecord,
    issue: V08BlockCenterIssue,
    lap = 9,
): IV08BlockCenterActionRecord["failureSamples"][number] => ({
    issue,
    game: record.game,
    pair: record.pair,
    seed: record.seed,
    candidateSide: record.candidateSide,
    unitId: "fixture-unit",
    creatureName: "Fixture Creature",
    lap,
    mountainState: "both_intact",
    actorCells: [{ x: 1, y: 1 }],
    enemyCells: [{ x: 10, y: 10 }],
    chosenDecision: [],
    stateSha256: "f".repeat(64),
    detail: "fixture failure sample",
});

describe("v0.8 BLOCK_CENTER action oracle panel", () => {
    test("uses deterministic random rosters and exact adjacent seat swaps on BLOCK_CENTER", () => {
        const fingerprint = fingerprintV08BlockCenterActionPlan(OPTIONS);
        expect(fingerprint).toHaveLength(64);
        expect(fingerprintV08BlockCenterActionPlan(OPTIONS)).toBe(fingerprint);
        expect(fingerprintV08BlockCenterActionPlan({ ...OPTIONS, inheritCandidateEnvironment: true })).not.toBe(
            fingerprint,
        );
        for (let pair = 0; pair < OPTIONS.games / 2; pair += 1) {
            const even = planV08BlockCenterActionGame(OPTIONS, pair * 2);
            const odd = planV08BlockCenterActionGame(OPTIONS, pair * 2 + 1);
            expect(even.mapType).toBe(PBTypes.GridVals.BLOCK_CENTER);
            expect(odd.mapType).toBe(PBTypes.GridVals.BLOCK_CENTER);
            expect(odd.seed).toBe(even.seed);
            expect(odd.greenRoster).toEqual(even.greenRoster);
            expect(odd.redRoster).toEqual(even.redRoster);
            expect(even.candidateSide).toBe("green");
            expect(odd.candidateSide).toBe("red");
        }
    });

    test("inherits a campaign environment only when explicitly requested and otherwise seals exact a13", () => {
        const key = "SEARCH_MAX_MOVE_SHOTS";
        const dynamicKey = "V08_VISIBLE_EDGE_SCREEN_PRESSURE";
        const versionsKey = "V08_VISIBLE_EDGE_SCREEN_PRESSURE_VERSIONS";
        const previous = new Map(
            [key, dynamicKey, versionsKey].map(
                (environmentKey) => [environmentKey, process.env[environmentKey]] as const,
            ),
        );
        process.env[key] = "campaign-sentinel";
        process.env[dynamicKey] = "1";
        process.env[versionsKey] = "hostile";
        try {
            const inherited = withV08BlockCenterCandidateEnvironment(
                { candidateVersion: "v0.8s", inheritCandidateEnvironment: true },
                () => ({
                    cap: process.env[key],
                    dynamic: process.env[dynamicKey],
                    versions: process.env[versionsKey],
                }),
            );
            expect(inherited).toEqual({ cap: "campaign-sentinel", dynamic: "1", versions: "hostile" });

            for (const candidateVersion of ["v0.8", "v0.8s"] as const) {
                const sealed = withV08BlockCenterCandidateEnvironment(
                    { candidateVersion, inheritCandidateEnvironment: false },
                    () => ({
                        cap: process.env[key],
                        dynamic: process.env[dynamicKey],
                        versions: process.env[versionsKey],
                    }),
                );
                expect(sealed).toEqual({ cap: "0", dynamic: undefined, versions: undefined });
                expect(process.env[key]).toBe("campaign-sentinel");
                expect(process.env[dynamicKey]).toBe("1");
                expect(process.env[versionsKey]).toBe("hostile");
            }
        } finally {
            for (const [environmentKey, value] of previous) {
                if (value === undefined) delete process.env[environmentKey];
                else process.env[environmentKey] = value;
            }
        }
    });

    test("independently proves a mountain-adjacent stationary melee hit without candidate enumeration", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
            damageMax: 5,
            name: "Knight",
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Orc",
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 4, y: 8 });
        actor.refreshPossibleAttackTypes(
            combat.attackHandler.canLandRangeAttack(actor, combat.grid.getEnemyAggrMatrixByUnitId(actor.getId())),
        );
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
            decisionOrigin: "root",
        };

        const option = findIndependentV08BlockCenterDirectOption(actor, context);

        expect(option).toMatchObject({
            kind: "melee",
            targetId: target.getId(),
            standCell: { x: 4, y: 7 },
        });
        expect(option?.actions.at(-1)).toMatchObject({
            type: "melee_attack",
            attackerId: actor.getId(),
            targetId: target.getId(),
            attackFrom: { x: 4, y: 7 },
        });
    });

    test("uses target-team ability power when Dodge and Small Specie make a physical hit impossible", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Large attacker",
            attackType: PBTypes.AttackVals.MELEE,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Synergy dodger",
            abilities: ["Dodge", "Small Specie"],
            stackPower: 5,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 4, y: 8 });
        actor.refreshPossibleAttackTypes(
            combat.attackHandler.canLandRangeAttack(actor, combat.grid.getEnemyAggrMatrixByUnitId(actor.getId())),
        );
        const { context } = activatedActionEngine(combat, actor);

        expect(actor.calculateMissChance(target, 0)).toBeLessThan(100);
        expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeDefined();

        // A deliberately high sentinel makes the availability boundary exact: target-team ability power lifts
        // Small Specie to 100%, so the authoritative attack path cannot deal damage. Production obtains this
        // value from the selected Might stack-ability-power synergy through the same FightProperties method.
        const abilityPower = spyOn(context.fightProperties!, "getAdditionalAbilityPowerPerTeam").mockImplementation(
            (team) => (team === PBTypes.TeamVals.UPPER ? 50 : 0),
        );
        try {
            expect(actor.calculateMissChance(target, 50)).toBe(100);
            expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeUndefined();
        } finally {
            abilityPower.mockRestore();
        }
    });

    test("matches native-shooter melee flooring and the Handyman boundary", () => {
        const setup = (abilities: string[] = []) => {
            const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
            const shooter = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                name: abilities.length ? "Handyman shooter" : "Spent shooter",
                attackType: PBTypes.AttackVals.RANGE,
                attack: 1,
                damageMin: 1,
                damageMax: 1,
                amountAlive: 1,
                rangeShots: 0,
                abilities,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                name: "Armored neighbour",
                attackType: PBTypes.AttackVals.MELEE,
                armor: 100,
            });
            placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 4, y: 7 });
            placeUnit(combat.grid, combat.unitsHolder, target, { x: 4, y: 8 });
            shooter.refreshPossibleAttackTypes(false);
            return { shooter, target, ...activatedActionEngine(combat, shooter) };
        };

        const penalized = setup();
        expect(
            penalized.shooter.calculateAttackDamageMax(penalized.shooter.getAttack(), penalized.target, false, 0),
        ).toBe(1);
        expect(penalized.shooter.calculateAttackDamage(penalized.target, PBTypes.AttackVals.MELEE, 0)).toBe(0);
        expect(findIndependentV08BlockCenterDirectOption(penalized.shooter, penalized.context)).toBeUndefined();
        const penalizedTargetHp = penalized.target.getCumulativeHp();
        expect(
            penalized.engine.apply({
                type: "melee_attack",
                attackerId: penalized.shooter.getId(),
                targetId: penalized.target.getId(),
                attackFrom: penalized.shooter.getBaseCell(),
            }).completed,
        ).toBe(true);
        expect(penalized.target.getCumulativeHp()).toBe(penalizedTargetHp);

        const handyman = setup(["Handyman"]);
        expect(handyman.shooter.calculateAttackDamage(handyman.target, PBTypes.AttackVals.MELEE, 0)).toBe(1);
        expect(findIndependentV08BlockCenterDirectOption(handyman.shooter, handyman.context)).toBeDefined();
    });

    test("authoritative probes reject impossible direct attacks and restore the live match exactly", () => {
        const seed = 0x510c_0a11;
        const roster = buildRoster(makeRng(seed));
        const config = {
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster,
            seed,
            maxLaps: 3,
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        } as const;
        const baseline = runMatch(config);
        let probed = false;
        const observed = runMatch({
            ...config,
            decisionObserver: (observation) => {
                if (probed) return;
                const target = observation.context.unitsHolder
                    .getAllEnemyUnits(observation.unit.getTeam())
                    .find((enemy) => !enemy.isDead());
                expect(target).toBeDefined();
                expect(observation.probeActions).toBeDefined();
                const result = observation.probeActions!([
                    {
                        type: "melee_attack",
                        attackerId: observation.unit.getId(),
                        targetId: target!.getId(),
                        attackFrom: observation.unit.getBaseCell(),
                    },
                ]);
                expect(result.failure?.startsWith("proposal_declined:melee_attack:")).toBe(true);
                expect(result.completedActionTypes).toEqual([]);
                probed = true;
            },
        });

        expect(probed).toBe(true);
        expect(observed).toEqual(baseline);
    });

    test("releases a dead forced target and emits an attack accepted by the authoritative engine", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Released attacker",
            amountAlive: 5,
            damageMin: 5,
            damageMax: 5,
        });
        const deadForced = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Dead forced target" });
        const liveTarget = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Live target" });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, deadForced, { x: 13, y: 13 });
        placeUnit(combat.grid, combat.unitsHolder, liveTarget, { x: 4, y: 8 });
        deadForced.applyDamage(deadForced.getCumulativeHp(), 0, new SceneLogMock());
        actor.setTarget(deadForced.getId());
        const { context, engine } = activatedActionEngine(combat, actor);

        const option = findIndependentV08BlockCenterDirectOption(actor, context);

        expect(option).toMatchObject({ kind: "melee", targetId: liveTarget.getId() });
        expect(option!.actions.every((action) => engine.apply(action).completed)).toBe(true);
    });

    test("rejects a move-melee suffix when Fire Wall leaves Cowardice below the target's HP", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Cowardly mover",
            initiative: 1,
            amountAlive: 10,
            maxHp: 10,
            damageMin: 5,
            damageMax: 5,
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Stronger after burn",
            amountAlive: 6,
            maxHp: 10,
        });
        const upperBlocker = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Upper route blocker" });
        const lowerBlocker = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Lower route blocker" });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, upperBlocker, { x: 4, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, lowerBlocker, { x: 4, y: 4 });
        actor.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
        const { context, engine } = activatedActionEngine(combat, actor);
        context.fightProperties!.getFireWalls().add({ x: 4, y: 3 }, 3, 60);

        expect(actor.getCumulativeHp()).toBe(100);
        expect(target.getCumulativeHp()).toBe(60);
        expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeUndefined();

        const move: GameAction = {
            type: "move_unit",
            unitId: actor.getId(),
            path: [
                { x: 3, y: 3 },
                { x: 4, y: 3 },
            ],
            targetCells: [{ x: 4, y: 3 }],
            hasLavaCell: false,
            hasWaterCell: false,
        };
        expect(engine.apply(move).completed).toBe(true);
        expect(actor.getCumulativeHp()).toBe(40);
        expect(
            engine.apply({
                type: "melee_attack",
                attackerId: actor.getId(),
                targetId: target.getId(),
                attackFrom: { x: 4, y: 3 },
            }).completed,
        ).toBe(false);
    });

    test("rejects an Area Throw whose authoritative primary is barred by Terrifying Gaze", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Gaze-barred thrower",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            shotDistance: 30,
            abilities: ["Area Throw"],
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Forbidden primary",
            amountAlive: 5,
            maxHp: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 10, y: 7 });
        actor.refreshPossibleAttackTypes(true);
        actor.setForbiddenTarget(target.getId());
        const { context, engine } = activatedActionEngine(combat, actor);

        expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeUndefined();
        expect(
            engine.apply({
                type: "area_throw_attack",
                attackerId: actor.getId(),
                targetCell: { x: 10, y: 6 },
            }).completed,
        ).toBe(false);
    });

    test("does not advertise an Area Throw when allied splash outweighs its enemy damage", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Harmful area thrower",
            attackType: PBTypes.AttackVals.RANGE,
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 50,
            rangeShots: 5,
            shotDistance: 30,
            abilities: ["Area Throw"],
        });
        const tinyEnemy = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Tiny splash enemy",
            amountAlive: 1,
            maxHp: 1,
        });
        const largeAlly = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Large splash ally",
            amountAlive: 100,
            maxHp: 1_000,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, tinyEnemy, { x: 10, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, largeAlly, { x: 10, y: 9 });
        actor.refreshPossibleAttackTypes(true);
        const { context } = activatedActionEngine(combat, actor);
        const rangeEvaluation = spyOn(combat.attackHandler, "evaluateRangeAttack").mockReturnValue({
            affectedUnits: [[tinyEnemy, largeAlly]],
            affectedCells: [[tinyEnemy.getBaseCell(), largeAlly.getBaseCell()]],
            rangeAttackDivisors: [1],
        });
        const areaProjection = spyOn(combat.attackHandler, "projectAreaThrowTargetCell").mockReturnValue({
            x: 10,
            y: 10,
        });
        try {
            const candidates = enumerateCandidates(
                actor,
                context,
                [{ type: "end_turn", unitId: actor.getId(), reason: "manual" }],
                { preserveAttackTargetCoverage: true },
            ).candidates;
            const throws = candidates.filter((candidate) => candidate.kind === "area_throw");
            expect(throws.length).toBeGreaterThan(0);
            expect(throws.every((candidate) => candidate.features.expectedDamage < 0)).toBe(true);
            expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeUndefined();
            expect(areaProjection).toHaveBeenCalled();
        } finally {
            areaProjection.mockRestore();
            rangeEvaluation.mockRestore();
        }
    });

    test("does not advertise a Ring of Fire whose allied damage exceeds its enemy damage", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const caster = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Careful fire caster",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            amountAlive: 1,
            stackPower: 4,
            initiative: 1,
            spells: ["Nature:Ring of Fire"],
        });
        const aimTarget = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Ring aim",
            amountAlive: 100,
            maxHp: 100,
        });
        const tinyEnemy = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Tiny ring enemy",
            amountAlive: 1,
            maxHp: 1,
        });
        tinyEnemy.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Hidden"), amount: 1 }));
        const largeAlly = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Large ring ally",
            amountAlive: 100,
            maxHp: 1_000,
        });
        placeUnit(combat.grid, combat.unitsHolder, caster, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, aimTarget, { x: 10, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, tinyEnemy, { x: 10, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, largeAlly, { x: 10, y: 1 });
        caster.refreshPossibleAttackTypes(false);
        const { context, engine } = activatedActionEngine(combat, caster);

        expect(findIndependentV08BlockCenterDirectOption(caster, context)).toBeUndefined();

        const enemyHpBefore = tinyEnemy.getCumulativeHp();
        const allyHpBefore = largeAlly.getCumulativeHp();
        expect(
            engine.apply({
                type: "cast_spell",
                casterId: caster.getId(),
                spellName: "Ring of Fire",
                targetId: aimTarget.getId(),
            }).completed,
        ).toBe(true);
        const enemyDamage = enemyHpBefore - tinyEnemy.getCumulativeHp();
        const alliedDamage = allyHpBefore - largeAlly.getCumulativeHp();
        expect(enemyDamage).toBeGreaterThan(0);
        expect(alliedDamage).toBeGreaterThan(enemyDamage);
    });

    test("treats display-only Rangebane as a hard ranged-action gate", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Display-rangebaned shooter",
            attackType: PBTypes.AttackVals.RANGE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            rangeShots: 5,
            shotDistance: 30,
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Range target",
            amountAlive: 100,
            maxHp: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 10, y: 2 });
        actor.refreshPossibleAttackTypes(true);
        const { context, engine } = activatedActionEngine(combat, actor);
        const available = findIndependentV08BlockCenterDirectOption(actor, context);
        expect(available).toMatchObject({ kind: "shot", targetId: target.getId() });

        actor.getUnitProperties().applied_debuffs.push("Rangebane");
        expect(actor.hasDebuffActive("Rangebane")).toBe(false);
        expect(actor.hasStatusApplied("Rangebane")).toBe(true);
        expect(findIndependentV08BlockCenterDirectOption(actor, context)).toBeUndefined();
        expect(available!.actions.map((action) => engine.apply(action).completed).at(-1)).toBe(false);
    });

    test("keeps positive-scored Smoke out of direct and urgent catalog eligibility", () => {
        const plan = planV08BlockCenterActionGame(OPTIONS, 0);
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const caster = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Smoke caster",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            stackPower: 4,
            initiative: 1,
            spells: ["Chaos:Smoke"],
        });
        const ally = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Smoke ally",
            amountAlive: 10,
        });
        const enemyRanger = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Enemy ranger",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, caster, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemyRanger, { x: 12, y: 2 });
        caster.refreshPossibleAttackTypes(false);
        const { context } = activatedActionEngine(combat, caster);
        while (context.fightProperties!.getCurrentLap() < 9) context.fightProperties!.flipLap();
        const smokeCandidate = enumerateCandidates(
            caster,
            context,
            [{ type: "end_turn", unitId: caster.getId(), reason: "manual" }],
            { enrichIncumbentMetadata: true },
        ).candidates.find((candidate) =>
            candidate.actions.some((action) => action.type === "cast_spell" && action.spellName === "Smoke"),
        );
        expect(smokeCandidate).toBeDefined();
        expect(smokeCandidate!.features.expectedDamage).toBeGreaterThan(0);

        const auditor = new V08BlockCenterActionAuditor(plan);
        auditor.observeDecision({
            unit: caster,
            context,
            incumbent: smokeCandidate!.actions,
            strategyVersion: "v0.8",
            probeActions: (actions) => ({
                failure: null,
                completedActionTypes: actions
                    .filter((action) => action.type !== "select_attack_type")
                    .map((action) => action.type),
            }),
        });
        auditor.observeExecution({
            unitId: caster.getId(),
            creatureName: caster.getName(),
            side: "green",
            strategyVersion: "v0.8",
            rawIncumbent: smokeCandidate!.actions,
            chosenDecision: smokeCandidate!.actions,
            strategyActions: smokeCandidate!.actions.map((action) => ({
                action,
                completed: true,
                events: [],
            })),
            recoveryAttempts: [],
            recovery: { source: "none", completed: false, events: [] },
            events: [],
        });
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 1,
            oracleDirectEligibleTurns: 0,
            sharedCatalogDirectEligibleTurns: 0,
            catalogMissedEngineValidCombat: 0,
            urgentCatalogMisses: 0,
            noncombatWithDirectOptionTurns: 0,
            lateDirectActionMisses: 0,
        });
    });

    test("keeps BLOCK_CENTER diagnostics out of the live path catalog and chosen actions", () => {
        const plan = planV08BlockCenterActionGame(OPTIONS, 0);
        const setup = liveTwinSetup();
        const run = (diagnostics: boolean) => {
            const auditor = diagnostics ? new V08BlockCenterActionAuditor(plan) : undefined;
            const catalogs: DecisionPathCatalog[] = [];
            const callbackStats: Array<{
                before: IDecisionPathCatalogStats;
                after: IDecisionPathCatalogStats;
            }> = [];
            const turns: Array<{
                unitId: string;
                side: ITurnExecutionObservation["side"];
                actions: GameAction[];
            }> = [];
            const result = withV08BlockCenterCandidateEnvironment(OPTIONS, () =>
                runMatch({
                    greenVersion: plan.candidateSide === "green" ? OPTIONS.candidateVersion : OPTIONS.opponentVersion,
                    redVersion: plan.candidateSide === "green" ? OPTIONS.opponentVersion : OPTIONS.candidateVersion,
                    roster: plan.greenRoster,
                    redRoster: plan.redRoster,
                    seed: plan.seed,
                    gridType: plan.mapType,
                    maxLaps: 3,
                    greenPerk: setup.perk,
                    redPerk: setup.perk,
                    greenAugments: setup.augments,
                    redAugments: setup.augments,
                    placementAugmentTiming: "setup-before-placement",
                    // Observer invariance must not depend on host-speed watchdog timing.
                    searchOfflineDeterministicWork: true,
                    decisionObserver: (observation) => {
                        const catalog = observation.context.decisionPathCatalog;
                        if (!catalog) {
                            auditor?.observeDecision(observation);
                            return;
                        }
                        const before = catalog.getStats();
                        auditor?.observeDecision(observation);
                        const after = catalog.getStats();
                        catalogs.push(catalog);
                        callbackStats.push({ before, after });
                    },
                    turnExecutionObserver: (observation) => {
                        turns.push({
                            unitId: observation.unitId,
                            side: observation.side,
                            actions: structuredClone([...observation.chosenDecision]),
                        });
                        auditor?.observeExecution(observation);
                    },
                }),
            );
            auditor?.finish();
            return {
                result,
                turns,
                callbackStats,
                finalCatalogStats: catalogs.map((catalog) => catalog.getStats()),
            };
        };

        const control = run(false);
        const observed = run(true);

        expect(observed.callbackStats.length).toBeGreaterThan(0);
        expect(
            observed.callbackStats.every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after)),
        ).toBe(true);
        expect(observed.result).toEqual(control.result);
        expect(observed.turns).toEqual(control.turns);
        expect(observed.finalCatalogStats).toEqual(control.finalCatalogStats);
    });

    test("audits candidate-side mindless turns under pinned v0.1 and feeds every urgent stall gate", () => {
        const plan = planV08BlockCenterActionGame(OPTIONS, 0);
        expect(plan.candidateSide).toBe("green");
        const auditPinnedMindlessUnit = (creatureName: "Berserker" | "Frenzied Boar") => {
            const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
            const actor = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                name: creatureName,
                attackType: PBTypes.AttackVals.MELEE,
                damageMin: 5,
                damageMax: 5,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                name: "Adjacent target",
            });
            placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 7 });
            placeUnit(combat.grid, combat.unitsHolder, target, { x: 4, y: 8 });
            actor.refreshPossibleAttackTypes(
                combat.attackHandler.canLandRangeAttack(actor, combat.grid.getEnemyAggrMatrixByUnitId(actor.getId())),
            );
            const { context } = activatedActionEngine(combat, actor);
            while (context.fightProperties!.getCurrentLap() < 9) context.fightProperties!.flipLap();

            const move: GameAction = {
                type: "move_unit",
                unitId: actor.getId(),
                path: [
                    { x: 4, y: 7 },
                    { x: 3, y: 7 },
                ],
                targetCells: [{ x: 3, y: 7 }],
            };
            const execution = (): ITurnExecutionObservation => ({
                unitId: actor.getId(),
                creatureName: actor.getName(),
                side: "green",
                strategyVersion: "v0.1",
                rawIncumbent: [move],
                chosenDecision: [move],
                strategyActions: [{ action: move, completed: true, events: [] }],
                recoveryAttempts: [],
                recovery: { source: "none", completed: false, events: [] },
                events: [
                    {
                        type: "unit_moved",
                        unitId: actor.getId(),
                        from: { x: 4, y: 7 },
                        to: { x: 3, y: 7 },
                        path: move.path,
                        targetCells: [{ x: 3, y: 7 }],
                    },
                ],
            });
            const auditor = new V08BlockCenterActionAuditor(plan);
            const observePinnedDecision = (): void =>
                auditor.observeDecision({
                    unit: actor,
                    context,
                    incumbent: [move],
                    strategyVersion: "v0.1",
                    probeActions: (actions) => ({
                        failure: null,
                        completedActionTypes: actions
                            .filter((action) => action.type !== "select_attack_type")
                            .map((action) => action.type),
                    }),
                });

            observePinnedDecision();
            auditor.observeExecution(execution());
            observePinnedDecision();
            auditor.observeExecution(execution());
            auditor.finish();
            return auditor;
        };
        const auditors = [auditPinnedMindlessUnit("Berserker"), auditPinnedMindlessUnit("Frenzied Boar")];
        for (const [index, creatureName] of ["Berserker", "Frenzied Boar"].entries()) {
            expect(auditors[index]!.byCreature[creatureName]).toMatchObject({
                observedTurns: 2,
                oracleDirectEligibleTurns: 2,
                noncombatWithDirectOptionTurns: 2,
                mountainAdjacentDirectEligibleTurns: 2,
                urgentMountainAdjacentMisses: 2,
                nonProgressMoves: 2,
                urgentRepeatedNonProgressWithDirectOption: 1,
                urgentMountainTerminalJitter: 1,
                lateDirectActionMisses: 2,
                observerPairingFaults: 0,
            });
        }

        const records = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        for (const [index, auditor] of auditors.entries()) {
            records[index]!.metrics = auditor.metrics;
            records[index]!.byCreature = auditor.byCreature;
        }
        const summary = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(summary.gates.failed).toEqual(
            expect.arrayContaining([
                "urgent_direct_action_misses_zero",
                "urgent_mountain_adjacent_misses_zero",
                "urgent_repeated_non_progress_with_direct_option_zero",
                "urgent_mountain_terminal_jitter_zero",
            ]),
        );
    });

    test("gates repeated urgent mountain jitter without requiring a direct action", () => {
        const plan = planV08BlockCenterActionGame(OPTIONS, 0);
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Blocked Walker",
            attackType: PBTypes.AttackVals.MELEE,
            initiative: 1,
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Distant target",
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 13, y: 7 });
        const { context } = activatedActionEngine(combat, actor);
        while (context.fightProperties!.getCurrentLap() < 9) context.fightProperties!.flipLap();

        const move: GameAction = {
            type: "move_unit",
            unitId: actor.getId(),
            path: [
                { x: 4, y: 7 },
                { x: 4, y: 8 },
            ],
            targetCells: [{ x: 4, y: 8 }],
        };
        const auditor = new V08BlockCenterActionAuditor(plan);
        const observeDecision = (): void =>
            auditor.observeDecision({
                unit: actor,
                context,
                incumbent: [move],
                strategyVersion: "v0.8",
                probeActions: (actions) => ({
                    failure: null,
                    completedActionTypes: actions
                        .filter((action) => action.type !== "select_attack_type")
                        .map((action) => action.type),
                }),
            });
        const observeExecution = (): void =>
            auditor.observeExecution({
                unitId: actor.getId(),
                creatureName: actor.getName(),
                side: "green",
                strategyVersion: "v0.8",
                rawIncumbent: [move],
                chosenDecision: [move],
                strategyActions: [{ action: move, completed: true, events: [] }],
                recoveryAttempts: [],
                recovery: { source: "none", completed: false, events: [] },
                events: [
                    {
                        type: "unit_moved",
                        unitId: actor.getId(),
                        from: { x: 4, y: 7 },
                        to: { x: 4, y: 8 },
                        path: move.path,
                        targetCells: [{ x: 4, y: 8 }],
                    },
                ],
            });

        observeDecision();
        observeExecution();
        observeDecision();
        observeExecution();
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 2,
            oracleDirectEligibleTurns: 0,
            nonProgressMoves: 2,
            urgentRepeatedNonProgressWithDirectOption: 0,
            urgentMountainTerminalJitter: 1,
        });
        expect(auditor.failureSamples.some(({ issue }) => issue === "urgent_mountain_terminal_jitter")).toBe(true);
    });

    test("gates a terminal melee A-B-A return against a stable enemy even when its closing leg makes progress", () => {
        const plan = planV08BlockCenterActionGame(OPTIONS, 0);
        const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Oscillating walker",
            attackType: PBTypes.AttackVals.MELEE,
            initiative: 1,
        });
        const target = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Distant target",
        });
        const a = { x: 1, y: 7 };
        const b = { x: 1, y: 8 };
        placeUnit(combat.grid, combat.unitsHolder, actor, a);
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 13, y: 7 });
        const { context } = activatedActionEngine(combat, actor);
        while (context.fightProperties!.getCurrentLap() < 9) context.fightProperties!.flipLap();
        let auditor = new V08BlockCenterActionAuditor(plan);
        const relocate = (cell: XY): void => {
            combat.grid.cleanupAll(actor.getId(), actor.getAttackRange(), actor.isSmallSize());
            placeUnit(combat.grid, combat.unitsHolder, actor, cell);
        };
        const relocateTarget = (cell: XY): void => {
            combat.grid.cleanupAll(target.getId(), target.getAttackRange(), target.isSmallSize());
            placeUnit(combat.grid, combat.unitsHolder, target, cell);
        };
        const observeMove = (from: XY, to: XY): void => {
            const move: GameAction = {
                type: "move_unit",
                unitId: actor.getId(),
                path: [from, to],
                targetCells: [to],
            };
            auditor.observeDecision({
                unit: actor,
                context,
                incumbent: [move],
                strategyVersion: "v0.8",
                probeActions: (actions) => ({
                    failure: null,
                    completedActionTypes: actions
                        .filter((action) => action.type !== "select_attack_type")
                        .map((action) => action.type),
                }),
            });
            auditor.observeExecution({
                unitId: actor.getId(),
                creatureName: actor.getName(),
                side: "green",
                strategyVersion: "v0.8",
                rawIncumbent: [move],
                chosenDecision: [move],
                strategyActions: [{ action: move, completed: true, events: [] }],
                recoveryAttempts: [],
                recovery: { source: "none", completed: false, events: [] },
                events: [
                    {
                        type: "unit_moved",
                        unitId: actor.getId(),
                        from,
                        to,
                        path: move.path,
                        targetCells: [to],
                    },
                ],
            });
        };

        observeMove(a, b);
        relocate(b);
        observeMove(b, a);
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 2,
            abaOscillations: 1,
            urgentMountainTerminalJitter: 1,
        });
        expect(
            auditor.failureSamples.some(
                ({ issue, detail }) => issue === "urgent_mountain_terminal_jitter" && detail.includes("A-B-A"),
            ),
        ).toBe(true);

        // The same physical return is diagnostic, not a hard stall, when the enemy crosses the board and makes
        // the old footprint newly closer. Game 7845 follows this exact pursuit pattern.
        auditor = new V08BlockCenterActionAuditor(plan);
        relocate(a);
        relocateTarget({ x: 13, y: 7 });
        observeMove(a, b);
        relocate(b);
        relocateTarget({ x: 1, y: 5 });
        observeMove(b, a);
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 2,
            abaOscillations: 1,
            urgentMountainTerminalJitter: 0,
        });
        expect(auditor.failureSamples.some(({ issue }) => issue === "urgent_mountain_terminal_jitter")).toBe(false);

        // A changed target board does not excuse a return that still fails to close current enemy distance.
        auditor = new V08BlockCenterActionAuditor(plan);
        relocate(a);
        relocateTarget({ x: 13, y: 7 });
        observeMove(a, b);
        relocate(b);
        relocateTarget({ x: 13, y: 8 });
        observeMove(b, a);
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 2,
            abaOscillations: 1,
            urgentMountainTerminalJitter: 1,
        });

        // A completed productive turn is a history boundary. Returning after mining is not a consecutive
        // movement loop and must not inherit the earlier A footprint.
        auditor = new V08BlockCenterActionAuditor(plan);
        relocate(a);
        relocateTarget({ x: 13, y: 7 });
        observeMove(a, b);
        relocate(b);
        const mine: GameAction = {
            type: "obstacle_attack",
            attackerId: actor.getId(),
            targetPosition: { x: 7, y: 7 },
        };
        auditor.observeDecision({
            unit: actor,
            context,
            incumbent: [mine],
            strategyVersion: "v0.8",
            probeActions: (actions) => ({
                failure: null,
                completedActionTypes: actions
                    .filter((action) => action.type !== "select_attack_type")
                    .map((action) => action.type),
            }),
        });
        auditor.observeExecution({
            unitId: actor.getId(),
            creatureName: actor.getName(),
            side: "green",
            strategyVersion: "v0.8",
            rawIncumbent: [mine],
            chosenDecision: [mine],
            strategyActions: [{ action: mine, completed: true, events: [] }],
            recoveryAttempts: [],
            recovery: { source: "none", completed: false, events: [] },
            events: [],
        });
        observeMove(b, a);
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 3,
            abaOscillations: 0,
            urgentMountainTerminalJitter: 0,
        });

        // Enemy identity participates in the tactical-state key, so replacing a stack in the same footprint
        // cannot masquerade as an unchanged board.
        auditor = new V08BlockCenterActionAuditor(plan);
        relocate(a);
        relocateTarget({ x: 1, y: 5 });
        observeMove(a, b);
        relocate(b);
        combat.grid.cleanupAll(target.getId(), target.getAttackRange(), target.isSmallSize());
        combat.unitsHolder.deleteUnitById(target.getId());
        const replacement = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Replacement target",
        });
        placeUnit(combat.grid, combat.unitsHolder, replacement, { x: 1, y: 5 });
        observeMove(b, a);
        auditor.finish();

        expect(auditor.metrics).toMatchObject({
            observedTurns: 2,
            abaOscillations: 1,
            urgentMountainTerminalJitter: 0,
        });
    });

    test("classifies enemy-distance progress and A-B-A movement independently of AI scores", () => {
        const enemy = [{ x: 10, y: 7 }];
        expect(v08BlockCenterFootprintDistance([{ x: 4, y: 7 }], enemy)).toBe(6);
        expect(v08BlockCenterFootprintManhattanDistance([{ x: 4, y: 7 }], enemy)).toBe(6);
        expect(isV08BlockCenterNonProgressMove([{ x: 4, y: 7 }], [{ x: 5, y: 7 }], enemy)).toBe(false);
        expect(isV08BlockCenterNonProgressMove([{ x: 4, y: 7 }], [{ x: 4, y: 8 }], enemy)).toBe(true);
        expect(
            isV08BlockCenterTerminalNonProgressMove([{ x: 2, y: 4 }], [{ x: 2, y: 5 }], [{ x: 7, y: 7 }], false),
        ).toBe(false);
        expect(
            isV08BlockCenterTerminalNonProgressMove([{ x: 2, y: 4 }], [{ x: 2, y: 5 }], [{ x: 7, y: 7 }], true),
        ).toBe(true);
        expect(isV08BlockCenterTerminalNonProgressMove([{ x: 4, y: 7 }], [{ x: 4, y: 8 }], enemy, false)).toBe(true);
        expect(isV08BlockCenterABAOscillation(["4,7", "4,8"], "4,7")).toBe(true);
        expect(isV08BlockCenterABAOscillation(["4,7", "4,8"], "5,8")).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "both_intact", true, false, true, 1)).toBe(true);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(8, "both_intact", true, false, true, 1)).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "cleared", true, false, true, 1)).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "both_intact", false, false, true, 1)).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "both_intact", true, true, true, 1)).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "both_intact", true, false, false, 1)).toBe(false);
        expect(isV08BlockCenterUrgentMountainTerminalJitter(9, "both_intact", true, false, true, 0)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", true, false, true)).toBe(true);
        expect(isV08BlockCenterUrgentMountainABAOscillation(8, "both_intact", true, false, true)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "cleared", true, false, true)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", false, false, true)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", true, true, true)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", true, false, false)).toBe(false);
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", true, false, true, true, true)).toBe(
            false,
        );
        expect(isV08BlockCenterUrgentMountainABAOscillation(9, "both_intact", true, false, true, true, false)).toBe(
            true,
        );
        expect(isV08BlockCenterNonDamagingSpellTurnExempt(8)).toBe(true);
        expect(isV08BlockCenterNonDamagingSpellTurnExempt(9)).toBe(false);
    });

    test("uses stable action and artifact identities", () => {
        expect(
            v08BlockCenterActionSignature([
                {
                    type: "move_unit",
                    unitId: "u",
                    path: [
                        { x: 4, y: 7 },
                        { x: 5, y: 7 },
                    ],
                    targetCells: [{ x: 5, y: 7 }],
                },
                {
                    type: "melee_attack",
                    attackerId: "u",
                    targetId: "e",
                    attackFrom: { x: 5, y: 7 },
                },
            ]),
        ).toBe("move:5,7:5,7|melee:e@5,7");
        expect(v08BlockCenterArtifactPrefix("v0.8s", "v0.7", 50_000, "2026:07")).toBe(
            "v08_block_center_v0.8s_vs_v0.7_50000_2026_07",
        );
    });

    test("keeps broad tactical diagnostics informational and gates only urgent policy defects", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        const passing = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(passing.gates.pass).toBe(true);
        expect(passing.candidateSeats).toEqual({ green: 2, red: 2 });
        expect(passing.maps).toEqual({ [PBTypes.GridVals.BLOCK_CENTER]: 4 });

        setRecordMetric(records[0]!, "catalogMissedEngineValidCombat", 1);
        setRecordMetric(records[0]!, "noncombatWithDirectOptionTurns", 1);
        setRecordMetric(records[0]!, "eligibleCombatMisses", 1);
        setRecordMetric(records[0]!, "mountainAdjacentMissedAttacks", 1);
        setRecordMetric(records[0]!, "pureMoveTurns", 1);
        setRecordMetric(records[0]!, "nonProgressMoves", 1);
        setRecordMetric(records[0]!, "abaOscillations", 1);
        setRecordMetric(records[0]!, "eligibleCombatDroughts", 1);
        expect(summarizeV08BlockCenterActionPanel(OPTIONS, records).gates.pass).toBe(true);

        setRecordMetric(records[0]!, "urgentCatalogMisses", 1);
        setRecordMetric(records[0]!, "lateDirectActionMisses", 1);
        setRecordMetric(records[0]!, "urgentMountainAdjacentMisses", 1);
        setRecordMetric(records[0]!, "urgentRepeatedNonProgressWithDirectOption", 1);
        setRecordMetric(records[0]!, "urgentMountainTerminalJitter", 1);
        setRecordMetric(records[0]!, "urgentCombatDroughts", 1);
        setRecordMetric(records[0]!, "sharedCatalogEnumerationTruncations", 1);
        setRecordMetric(records[0]!, "recoveryTurns", 1);
        const failing = summarizeV08BlockCenterActionPanel(
            { ...OPTIONS, sourceDirty: true },
            records.map((record) => ({ ...record, sourceDirty: true })),
        );
        expect(failing.gates.failed).toEqual(
            expect.arrayContaining([
                "source_commit_bound",
                "shared_catalog_enumeration_not_truncated",
                "recovery_turns_zero",
                "urgent_catalog_misses_zero",
                "urgent_direct_action_misses_zero",
                "urgent_mountain_adjacent_misses_zero",
                "urgent_repeated_non_progress_with_direct_option_zero",
                "urgent_mountain_terminal_jitter_zero",
                "urgent_combat_droughts_zero",
            ]),
        );
    });

    test("fails closed when records silently omit decision observations or qualification exposure", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        records[0]!.metrics.observedTurns = 0;
        records[0]!.byCreature = {};
        records[0]!.mountainStates = {
            both_intact: 0,
            left_only: 0,
            right_only: 0,
            cleared: 0,
        };
        const missingRecord = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(missingRecord.gates.failed).toContain("every_record_has_observations");
        expect(missingRecord.gates.checks.mountain_state_turn_integrity.pass).toBe(true);
        expect(missingRecord.gates.checks.creature_turn_integrity.pass).toBe(true);

        for (const record of records) {
            record.metrics = emptyV08BlockCenterMetrics();
            record.byCreature = {};
            record.mountainStates = {
                both_intact: 0,
                left_only: 0,
                right_only: 0,
                cleared: 0,
            };
        }
        const silentPanel = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(silentPanel.gates.failed).toEqual(
            expect.arrayContaining([
                "observed_turns_positive",
                "every_record_has_observations",
                "mountain_state_coverage",
                "oracle_direct_exposure_positive",
                "mountain_adjacent_direct_exposure_positive",
                "late_direct_exposure_positive",
            ]),
        );
    });

    test("fails closed when mountain-state or by-creature observation totals are inconsistent", () => {
        const mountainRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        mountainRecords[0]!.mountainStates.both_intact += 1;
        const mountainMismatch = summarizeV08BlockCenterActionPanel(OPTIONS, mountainRecords);
        expect(mountainMismatch.gates.checks.mountain_state_turn_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; 17/16 total",
        });

        const creatureRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        creatureRecords[1]!.byCreature["Fixture Creature"]!.observedTurns += 1;
        const creatureMismatch = summarizeV08BlockCenterActionPanel(OPTIONS, creatureRecords);
        expect(creatureMismatch.gates.checks.creature_turn_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; 17/16 total",
        });

        const metricRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        metricRecords[0]!.byCreature["Fixture Creature"]!.urgentMountainTerminalJitter = 1;
        const metricMismatch = summarizeV08BlockCenterActionPanel(OPTIONS, metricRecords);
        expect(metricMismatch.gates.pass).toBe(false);
        expect(metricMismatch.gates.checks.urgent_mountain_terminal_jitter_zero.pass).toBe(true);
        expect(metricMismatch.gates.checks.creature_metric_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; aggregate mismatches: urgentMountainTerminalJitter",
        });
    });

    test("fails closed when signed or overflowing counters cancel in aggregate", () => {
        const metricRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        setRecordMetric(metricRecords[0]!, "recoveryTurns", 1);
        setRecordMetric(metricRecords[1]!, "recoveryTurns", -1);
        const metricCancellation = summarizeV08BlockCenterActionPanel(OPTIONS, metricRecords);
        expect(metricCancellation.metrics.recoveryTurns).toBe(0);
        expect(metricCancellation.gates.checks.creature_metric_integrity.pass).toBe(true);
        expect(metricCancellation.gates.checks.recovery_turns_zero.pass).toBe(true);
        expect(metricCancellation.gates.checks.counter_domain_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; aggregate valid",
        });

        const rejectionRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        rejectionRecords[0]!.candidateEngineRejections = 1;
        rejectionRecords[1]!.candidateEngineRejections = -1;
        const rejectionCancellation = summarizeV08BlockCenterActionPanel(OPTIONS, rejectionRecords);
        expect(rejectionCancellation.candidateEngineRejections).toBe(0);
        expect(rejectionCancellation.gates.checks.engine_rejections_zero.pass).toBe(true);
        expect(rejectionCancellation.gates.checks.counter_domain_integrity.pass).toBe(false);

        const mountainRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        mountainRecords[0]!.mountainStates.both_intact = -1;
        mountainRecords[0]!.mountainStates.left_only = 3;
        const mountainCancellation = summarizeV08BlockCenterActionPanel(OPTIONS, mountainRecords);
        expect(mountainCancellation.gates.checks.mountain_state_turn_integrity.pass).toBe(true);
        expect(mountainCancellation.gates.checks.counter_domain_integrity.pass).toBe(false);

        const extraMountainStateRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        (extraMountainStateRecords[0]!.mountainStates as Record<string, number>).bogus = 1;
        (extraMountainStateRecords[1]!.mountainStates as Record<string, number>).bogus = -1;
        const extraMountainStateCancellation = summarizeV08BlockCenterActionPanel(OPTIONS, extraMountainStateRecords);
        expect(extraMountainStateCancellation.gates.checks.mountain_state_turn_integrity.pass).toBe(true);
        expect(extraMountainStateCancellation.gates.checks.counter_domain_integrity).toMatchObject({
            pass: false,
            actual: "2/4 records; aggregate valid",
        });

        const overflowRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        for (const record of overflowRecords) record.candidateEngineRejections = Number.MAX_SAFE_INTEGER;
        expect(
            summarizeV08BlockCenterActionPanel(OPTIONS, overflowRecords).gates.checks.counter_domain_integrity,
        ).toMatchObject({
            pass: false,
            actual: "4/4 records; aggregate invalid",
        });
    });

    test("requires every game to end by elimination and rejects an unknown terminal label", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        records[0]!.endReason = "mystery" as IV08BlockCenterActionRecord["endReason"];
        const summary = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(summary.gates.checks.crashes_zero.pass).toBe(true);
        expect(summary.gates.checks.stuck_zero.pass).toBe(true);
        expect(summary.gates.checks.turn_caps_zero.pass).toBe(true);
        expect(summary.gates.checks.eliminations_only).toMatchObject({
            pass: false,
            actual: '{"mystery":1,"elimination":3}',
        });
        expect(summary.gates.pass).toBe(false);
    });

    test("binds every failure sample to its record and a matching nonzero counter", () => {
        const hiddenFailureRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        hiddenFailureRecords[0]!.failureSamples.push(
            failureSampleFor(hiddenFailureRecords[0]!, "urgent_mountain_terminal_jitter"),
        );
        const hiddenFailure = summarizeV08BlockCenterActionPanel(OPTIONS, hiddenFailureRecords);
        expect(hiddenFailure.gates.checks.urgent_mountain_terminal_jitter_zero.pass).toBe(true);
        expect(hiddenFailure.gates.checks.failure_sample_integrity).toMatchObject({
            pass: false,
            actual: 3,
        });

        const missingDerivedCounterRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        setRecordMetric(missingDerivedCounterRecords[0]!, "catalogMissedEngineValidCombat", 1);
        missingDerivedCounterRecords[0]!.failureSamples.push(
            failureSampleFor(missingDerivedCounterRecords[0]!, "catalog_missed_engine_valid_combat"),
        );
        expect(
            summarizeV08BlockCenterActionPanel(OPTIONS, missingDerivedCounterRecords).gates.checks
                .failure_sample_integrity.pass,
        ).toBe(false);

        const informationalRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        setRecordMetric(informationalRecords[0]!, "pureMoveTurns", 1);
        setRecordMetric(informationalRecords[0]!, "nonProgressMoves", 1);
        informationalRecords[0]!.failureSamples.push(failureSampleFor(informationalRecords[0]!, "non_progress_move"));
        const informational = summarizeV08BlockCenterActionPanel(OPTIONS, informationalRecords);
        expect(informational.gates.checks.failure_sample_integrity.pass).toBe(true);
        expect(informational.gates.pass).toBe(true);
    });

    test("requires zero strategy rejections and exact observer-to-engine rejection parity", () => {
        const observerOnlyRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        setRecordMetric(observerOnlyRecords[0]!, "strategyRejectedActions", 1);
        const observerOnly = summarizeV08BlockCenterActionPanel(OPTIONS, observerOnlyRecords);
        expect(observerOnly.gates.checks.engine_rejections_zero.pass).toBe(true);
        expect(observerOnly.gates.checks.strategy_rejections_zero.pass).toBe(false);
        expect(observerOnly.gates.checks.strategy_engine_rejection_parity).toMatchObject({
            pass: false,
            actual: "3/4 records; 1/0 aggregate",
        });

        const matchingRecords = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        setRecordMetric(matchingRecords[0]!, "strategyRejectedActions", 1);
        matchingRecords[0]!.candidateEngineRejections = 1;
        const matching = summarizeV08BlockCenterActionPanel(OPTIONS, matchingRecords);
        expect(matching.gates.checks.strategy_engine_rejection_parity.pass).toBe(true);
        expect(matching.gates.checks.engine_rejections_zero.pass).toBe(false);
        expect(matching.gates.checks.strategy_rejections_zero.pass).toBe(false);
    });

    test("rejects invalid laps, winner labels, and crash fields on elimination records", () => {
        const badLaps = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        badLaps[0]!.laps = -7;
        expect(summarizeV08BlockCenterActionPanel(OPTIONS, badLaps).gates.checks.record_result_integrity.pass).toBe(
            false,
        );

        const badWinner = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        badWinner[0]!.winner = "mystery" as IV08BlockCenterActionRecord["winner"];
        expect(summarizeV08BlockCenterActionPanel(OPTIONS, badWinner).gates.checks.record_result_integrity.pass).toBe(
            false,
        );

        const hiddenCrash = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        hiddenCrash[0]!.crash = "fatal engine exception";
        const hiddenCrashSummary = summarizeV08BlockCenterActionPanel(OPTIONS, hiddenCrash);
        expect(hiddenCrashSummary.gates.checks.eliminations_only.pass).toBe(true);
        expect(hiddenCrashSummary.gates.checks.record_result_integrity).toMatchObject({
            pass: false,
            actual: 3,
        });
    });

    test("rejects impossible metric subsets and late counters before lap nine", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        records[0]!.laps = 1;
        setRecordMetric(records[0]!, "mountainAdjacentTurns", 0);
        const summary = summarizeV08BlockCenterActionPanel(OPTIONS, records);
        expect(summary.gates.checks.counter_domain_integrity.pass).toBe(true);
        expect(summary.gates.checks.creature_metric_integrity.pass).toBe(true);
        expect(summary.gates.checks.metric_semantic_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; aggregate invalid",
        });

        const splitExposure = Array.from({ length: OPTIONS.games }, (_, game) => recordFor(game));
        splitExposure[0]!.laps = 1;
        setRecordMetric(splitExposure[0]!, "lateDirectEligibleTurns", 0);
        setRecordMetric(splitExposure[1]!, "oracleDirectEligibleTurns", 0);
        setRecordMetric(splitExposure[1]!, "mountainAdjacentDirectEligibleTurns", 0);
        const splitSummary = summarizeV08BlockCenterActionPanel(OPTIONS, splitExposure);
        expect(splitSummary.gates.checks.oracle_direct_exposure_positive.pass).toBe(true);
        expect(splitSummary.gates.checks.late_direct_exposure_positive.pass).toBe(true);
        expect(splitSummary.gates.checks.metric_semantic_integrity).toMatchObject({
            pass: false,
            actual: "3/4 records; aggregate valid",
        });
    });

    test("requires the exact zero-based game schedule, not merely a unique equal-size substitute", () => {
        const shiftedRecords = Array.from({ length: OPTIONS.games }, (_, game) => ({
            ...recordFor(game),
            game: OPTIONS.games + game,
        }));
        expect(() => summarizeV08BlockCenterActionPanel(OPTIONS, shiftedRecords)).toThrow(
            "Invalid BLOCK_CENTER action panel game 4",
        );
    });
});
