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
    planV08BlockCenterActionGame,
    runV08BlockCenterActionPanelGame,
    summarizeV08BlockCenterActionPanel,
    V08BlockCenterActionAuditor,
    v08BlockCenterActionSignature,
    v08BlockCenterArtifactPrefix,
    withV08BlockCenterCandidateEnvironment,
    v08BlockCenterFootprintDistance,
    V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
    type IV08BlockCenterActionPanelOptions,
    type IV08BlockCenterActionRecord,
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

const DEEP_PANEL_OPTIONS: IV08BlockCenterActionPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 50_000,
    baseSeed: 2_607_280_041,
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
        laps: 5,
        endReason: "elimination",
        candidateEngineRejections: 0,
        metrics: emptyV08BlockCenterMetrics(),
        byCreature: {},
        mountainStates: {
            both_intact: 1,
            left_only: 1,
            right_only: 1,
            cleared: 1,
        },
        failureSamples: [],
    };
};

describe("v0.8 BLOCK_CENTER action oracle panel", () => {
    test("keeps deep game 1069 free of the pinned Berserker direct-action drought", () => {
        const record = runV08BlockCenterActionPanelGame(DEEP_PANEL_OPTIONS, 1_069);

        expect(record).toMatchObject({
            game: 1_069,
            pair: 534,
            seed: 2_736_768_735,
            candidateSide: "red",
            candidateRoster: ["Berserker", "Berserker", "Valkyrie", "Trent", "Cyclops", "Tsar Cannon"],
            opponentRoster: ["Peasant", "Blacksmith", "Valkyrie", "Elf", "Crusader", "Frenzied Boar"],
            candidateEngineRejections: 0,
        });
        expect(record.metrics).toMatchObject({
            urgentCatalogMisses: 0,
            urgentMountainAdjacentMisses: 0,
            urgentRepeatedNonProgressWithDirectOption: 0,
            urgentCombatDroughts: 0,
            lateDirectActionMisses: 0,
        });
    });

    test("keeps deep game 1589 free of the Tsar Cannon mountain action stall", () => {
        const record = runV08BlockCenterActionPanelGame(DEEP_PANEL_OPTIONS, 1_589);

        expect(record).toMatchObject({
            game: 1_589,
            pair: 794,
            seed: 1_400_331_939,
            candidateSide: "red",
            candidateRoster: ["Fairy", "Troglodyte", "Harpy", "Pikeman", "Efreet", "Tsar Cannon"],
            opponentRoster: ["Leprechaun", "Centaur", "Pikeman", "Trent", "Cyclops", "Gargantuan"],
            candidateEngineRejections: 0,
        });
        expect(record.metrics).toMatchObject({
            urgentCatalogMisses: 0,
            urgentMountainAdjacentMisses: 0,
            urgentRepeatedNonProgressWithDirectOption: 0,
            urgentCombatDroughts: 0,
            lateDirectActionMisses: 0,
        });
    });

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
            speed: 1,
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
                recovery: { source: "none", completed: false },
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
            ]),
        );
    });

    test("classifies enemy-distance progress and A-B-A movement independently of AI scores", () => {
        const enemy = [{ x: 10, y: 7 }];
        expect(v08BlockCenterFootprintDistance([{ x: 4, y: 7 }], enemy)).toBe(6);
        expect(isV08BlockCenterNonProgressMove([{ x: 4, y: 7 }], [{ x: 5, y: 7 }], enemy)).toBe(false);
        expect(isV08BlockCenterNonProgressMove([{ x: 4, y: 7 }], [{ x: 4, y: 8 }], enemy)).toBe(true);
        expect(isV08BlockCenterABAOscillation(["4,7", "4,8"], "4,7")).toBe(true);
        expect(isV08BlockCenterABAOscillation(["4,7", "4,8"], "5,8")).toBe(false);
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

        records[0]!.metrics.catalogMissedEngineValidCombat = 1;
        records[0]!.metrics.noncombatWithDirectOptionTurns = 1;
        records[0]!.metrics.mountainAdjacentMissedAttacks = 1;
        records[0]!.metrics.nonProgressMoves = 1;
        records[0]!.metrics.abaOscillations = 1;
        records[0]!.metrics.eligibleCombatDroughts = 1;
        expect(summarizeV08BlockCenterActionPanel(OPTIONS, records).gates.pass).toBe(true);

        records[0]!.metrics.urgentCatalogMisses = 1;
        records[0]!.metrics.lateDirectActionMisses = 1;
        records[0]!.metrics.urgentMountainAdjacentMisses = 1;
        records[0]!.metrics.urgentRepeatedNonProgressWithDirectOption = 1;
        records[0]!.metrics.urgentCombatDroughts = 1;
        records[0]!.metrics.sharedCatalogEnumerationTruncations = 1;
        const failing = summarizeV08BlockCenterActionPanel(
            { ...OPTIONS, sourceDirty: true },
            records.map((record) => ({ ...record, sourceDirty: true })),
        );
        expect(failing.gates.failed).toEqual(
            expect.arrayContaining([
                "source_commit_bound",
                "shared_catalog_enumeration_not_truncated",
                "urgent_catalog_misses_zero",
                "urgent_direct_action_misses_zero",
                "urgent_mountain_adjacent_misses_zero",
                "urgent_repeated_non_progress_with_direct_option_zero",
                "urgent_combat_droughts_zero",
            ]),
        );
    });
});
