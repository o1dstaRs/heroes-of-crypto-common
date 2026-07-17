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

import type { ICandidateFeatures, IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import type { GameEvent } from "../../src/engine/events";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { Unit } from "../../src/units/unit";
import type {
    IDecisionObservation,
    IMatchConfig,
    IMatchResult,
    ITurnExecutionObservation,
} from "../../src/simulation/battle_engine";
import {
    V07_SELFPLAY_PASSIVE_AUDIT_GAMES_PER_TEMPLATE,
    V07_SELFPLAY_PASSIVE_AUDIT_TOTAL_GAMES,
    classifyV07PassiveDecisionIntent,
    createV07SelfplayPassiveAuditSeedSchedule,
    createV07SelfplayPassiveAuditTally,
    finalizeV07SelfplayPassiveAudit,
    mergeV07SelfplayPassiveAuditTallies,
    observeV07SelfplayPassiveDecision,
    observeV07SelfplayTurnExecution,
    playV07SelfplayPassiveAuditGame,
} from "../../src/simulation/v0_7_selfplay_passive_audit";
import { V07_ARCHETYPE_TEMPLATES, v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";

const features = (expectedDamage = 0, expectedKill: 0 | 1 = 0): ICandidateFeatures => ({
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 2,
    hourglassSpent: 0,
    spendsRangeShot: 0,
    spendsSpellCharge: 0,
    burnsResurrectionCharge: 0,
    expectedDamage,
    expectedKill,
});

const candidate = (
    kind: IEnumeratedCandidate["kind"],
    actions: GameAction[] = [],
    expectedDamage = 0,
    expectedKill: 0 | 1 = 0,
): IEnumeratedCandidate => ({ kind, actions, features: features(expectedDamage, expectedKill) });

const fakeUnit = (id = "actor", name = "Healer", team = PBTypes.TeamVals.LOWER): Unit =>
    ({
        getId: () => id,
        getName: () => name,
        getTeam: () => team,
    }) as Unit;

const decisionObservation = (
    incumbent: GameAction[],
    unit: Unit = fakeUnit(),
    version = "v0.7",
): IDecisionObservation =>
    ({
        unit,
        incumbent,
        strategyVersion: version,
        context: {
            fightProperties: { getCurrentLap: () => 2 },
        } as IDecisionObservation["context"],
    }) satisfies IDecisionObservation;

const executionObservation = (overrides: Partial<ITurnExecutionObservation> = {}): ITurnExecutionObservation => ({
    unitId: "actor",
    creatureName: "Healer",
    side: "green",
    strategyVersion: "v0.7",
    rawIncumbent: [],
    chosenDecision: [],
    strategyActions: [],
    recoveryAttempts: [],
    recovery: { source: "none", completed: false, events: [] },
    events: [],
    ...overrides,
});

const fakeResult = (config: IMatchConfig): IMatchResult => ({
    seed: config.seed,
    gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
    winner: "green",
    endReason: "elimination",
    laps: 2,
    totalActions: 1,
    roster: config.roster,
    redRoster: config.redRoster,
    placements: { green: [], red: [] },
    actions: [],
    outcome: {
        green: { version: "v0.7", unitsAlive: 1, creaturesAlive: 1, hpRemaining: 1 },
        red: { version: "v0.7", unitsAlive: 0, creaturesAlive: 0, hpRemaining: 0 },
    },
    attrition: {
        reachedArmageddon: false,
        armageddonWaves: 0,
        unitsKilledByArmageddon: 0,
        unitsKilledByNarrowing: 0,
        decidedByArmageddon: false,
    },
    rejectedGreen: 0,
    rejectedRed: 0,
});

describe("v0.7 self-play passive-turn audit", () => {
    it("pins 100k games and derives a deterministic unique uint32 schedule without a freshness claim", () => {
        expect(V07_SELFPLAY_PASSIVE_AUDIT_GAMES_PER_TEMPLATE).toBe(12_500);
        expect(V07_SELFPLAY_PASSIVE_AUDIT_TOTAL_GAMES).toBe(100_000);
        expect(V07_ARCHETYPE_TEMPLATES).toHaveLength(8);

        const first = createV07SelfplayPassiveAuditSeedSchedule({ gamesPerTemplate: 3, seedDomain: "test" });
        const second = createV07SelfplayPassiveAuditSeedSchedule({ gamesPerTemplate: 3, seedDomain: "test" });
        expect(first.specs).toEqual(second.specs);
        expect(first.specs).toHaveLength(24);
        expect(new Set(first.specs.map((spec) => spec.seed)).size).toBe(24);
        expect(first.specs.every((spec) => spec.seed >= 0 && spec.seed <= 0xffffffff)).toBe(true);
        expect(first.freshnessClaim).toBe("unique_within_run_only");
        expect(first.corpusLabel).toContain("no formal freshness claim");
    });

    it("classifies end/none as skip and gives spell precedence over a setup move", () => {
        expect(classifyV07PassiveDecisionIntent([])).toBe("skip");
        expect(classifyV07PassiveDecisionIntent([{ type: "end_turn", unitId: "u" }])).toBe("skip");
        expect(classifyV07PassiveDecisionIntent([{ type: "defend_turn", unitId: "u" }])).toBe("shield");
        expect(classifyV07PassiveDecisionIntent([{ type: "wait_turn", unitId: "u" }])).toBe("wait");
        expect(
            classifyV07PassiveDecisionIntent([
                { type: "move_unit", unitId: "u", path: [{ x: 1, y: 1 }] },
                { type: "cast_spell", casterId: "u", spellName: "Riot" },
            ]),
        ).toBe("spell");
    });

    it("enumerates only skip/shield turns and aggregates legal attacks, routes, and EV by every cohort axis", () => {
        const tally = createV07SelfplayPassiveAuditTally();
        let enumerations = 0;
        const enumerate = () => {
            enumerations += 1;
            return {
                candidates: [
                    candidate("incumbent"),
                    candidate(
                        "melee",
                        [{ type: "melee_attack", attackerId: "actor", targetId: "enemy", attackFrom: { x: 1, y: 1 } }],
                        12,
                    ),
                    candidate(
                        "melee",
                        [
                            { type: "move_unit", unitId: "actor", path: [{ x: 2, y: 2 }] },
                            {
                                type: "melee_attack",
                                attackerId: "actor",
                                targetId: "enemy",
                                attackFrom: { x: 2, y: 2 },
                            },
                        ],
                        25,
                        1,
                    ),
                    candidate("shot", [{ type: "range_attack", attackerId: "actor", targetId: "enemy" }], 15),
                    candidate(
                        "area_throw",
                        [{ type: "area_throw_attack", attackerId: "actor", targetCell: { x: 3, y: 3 } }],
                        -3,
                    ),
                    candidate("defend", [{ type: "defend_turn", unitId: "actor" }]),
                ],
                truncated: [],
            };
        };

        const scope = observeV07SelfplayPassiveDecision(
            tally,
            decisionObservation([{ type: "end_turn", unitId: "actor", reason: "skip" }]),
            "mage_frontline",
            enumerate,
            { game: 7, seed: 123 },
        );
        observeV07SelfplayPassiveDecision(
            tally,
            decisionObservation([{ type: "wait_turn", unitId: "actor" }]),
            "mage_frontline",
            enumerate,
        );

        expect(scope).toMatchObject({ game: 7, seed: 123, lap: 2, lapBand: "laps_2_3", intent: "skip" });
        expect(enumerations).toBe(1);
        expect(tally.global.decisions).toBe(2);
        expect(tally.global.skip).toMatchObject({
            passiveTurns: 1,
            alternativeCandidates: 5,
            turnsWithCandidate: 1,
            candidates: 4,
            turnsWithPositiveExpectedDamage: 1,
            positiveExpectedDamageCandidates: 3,
            turnsWithExpectedKill: 1,
            expectedKillCandidates: 1,
            maxExpectedDamage: 25,
        });
        expect(tally.global.skip.byMeleeRoute.direct.candidates).toBe(1);
        expect(tally.global.skip.byMeleeRoute.move_assisted.candidates).toBe(1);
        expect(tally.global.skip.byAttackKind.shot.maxExpectedDamage).toBe(15);
        expect(tally.byTemplate.mage_frontline?.skip.candidates).toBe(4);
        expect(tally.byArchetype.mage?.skip.candidates).toBe(4);
        expect(tally.bySide.green?.skip.candidates).toBe(4);
        expect(tally.byLapBand.laps_2_3?.skip.candidates).toBe(4);
        expect(tally.byCreature.Healer?.skip.candidates).toBe(4);
    });

    it("keeps policy ratios separate from execution and gates rejected/recovered turns with bounded repros", () => {
        const tally = createV07SelfplayPassiveAuditTally();
        const scope = observeV07SelfplayPassiveDecision(
            tally,
            decisionObservation([]),
            "mage_frontline",
            () => ({ candidates: [candidate("incumbent")], truncated: [] }),
            { game: 9, seed: 456 },
        )!;
        const rejectedAction: GameAction = { type: "range_attack", attackerId: "actor", targetId: "enemy" };
        const foreignSkip: GameEvent = {
            type: "unit_skipped",
            unitId: "other-unit",
            team: PBTypes.TeamVals.UPPER,
            reason: "effect",
        };
        observeV07SelfplayTurnExecution(
            tally,
            executionObservation({
                chosenDecision: [rejectedAction],
                strategyActions: [
                    {
                        action: rejectedAction,
                        completed: false,
                        rejectionReason: "range_attack_not_available",
                        events: [],
                    },
                ],
                recoveryAttempts: [
                    {
                        source: "advance",
                        completed: false,
                        action: { type: "move_unit", unitId: "actor", path: [{ x: 0, y: 0 }] },
                        rejectionReason: "cell_occupied",
                        events: [],
                    },
                    {
                        source: "defend",
                        completed: true,
                        action: { type: "defend_turn", unitId: "actor" },
                        events: [{ type: "unit_defended", unitId: "actor", team: PBTypes.TeamVals.LOWER }],
                    },
                ],
                recovery: {
                    source: "defend",
                    completed: true,
                    action: { type: "defend_turn", unitId: "actor" },
                    events: [{ type: "unit_defended", unitId: "actor", team: PBTypes.TeamVals.LOWER }],
                },
                events: [foreignSkip, { type: "unit_defended", unitId: "actor", team: PBTypes.TeamVals.LOWER }],
            }),
            scope,
        );

        expect(tally.global.intents.skip).toBe(1);
        expect(tally.global.execution).toMatchObject({
            actualUnitSkippedTurns: 0,
            explicitUnitDefendedTurns: 0,
            recoveryDefendTurns: 1,
            recoveryAdvanceTurns: 1,
            recoveryFailedTurns: 1,
            strategyNoOpTurns: 1,
            rejectedTurns: 1,
            rejectedActions: 1,
        });
        expect(tally.integrity).toMatchObject({ rejectedActions: 1, recoveryTurns: 1 });
        expect(tally.integrity.reproSamples).toHaveLength(2);
        expect(tally.integrity.reproSamples[0]).toMatchObject({
            template: "mage_frontline",
            game: 9,
            seed: 456,
            lap: 2,
            unitId: "actor",
        });
        expect(tally.integrity.reproSamples[1].recoveryAttempts).toEqual([
            expect.objectContaining({ source: "advance", completed: false, rejectionReason: "cell_occupied" }),
            expect.objectContaining({ source: "defend", completed: true }),
        ]);

        tally.games = 1;
        const report = finalizeV07SelfplayPassiveAudit({ gamesPerTemplate: 1 }, tally);
        expect(report.aggregate.skipShare).toBe(1);
        expect(report.aggregate.skipToShieldRatio).toBeNull();
        expect(report.integrity.smoothExecutionPass).toBe(false);
        expect(report.limitations.some((line) => line.includes("never normalized"))).toBe(true);
    });

    it("merges shard tallies and runs one symmetric fixed-roster LiveTwin game through injected dependencies", () => {
        const left = createV07SelfplayPassiveAuditTally();
        const right = createV07SelfplayPassiveAuditTally();
        left.games = 1;
        left.global.decisions = 2;
        right.games = 2;
        right.global.decisions = 3;
        right.integrity.rejectedActions = 1;
        mergeV07SelfplayPassiveAuditTallies(left, right);
        expect(left.games).toBe(3);
        expect(left.global.decisions).toBe(5);
        expect(left.integrity.rejectedActions).toBe(1);

        let captured: IMatchConfig | undefined;
        const unit = fakeUnit("actor", "Healer", PBTypes.TeamVals.LOWER);
        const result = playV07SelfplayPassiveAuditGame(
            { template: "mage_frontline", game: 0, seed: 789 },
            {
                enumerate: () => ({ candidates: [candidate("incumbent")], truncated: [] }),
                matchRunner: (config) => {
                    captured = config;
                    config.decisionObserver?.(decisionObservation([{ type: "defend_turn", unitId: "actor" }], unit));
                    config.turnExecutionObserver?.(
                        executionObservation({
                            rawIncumbent: [{ type: "defend_turn", unitId: "actor" }],
                            chosenDecision: [{ type: "defend_turn", unitId: "actor" }],
                            strategyActions: [
                                {
                                    action: { type: "defend_turn", unitId: "actor" },
                                    completed: true,
                                    events: [{ type: "unit_defended", unitId: "actor", team: PBTypes.TeamVals.LOWER }],
                                },
                            ],
                            events: [{ type: "unit_defended", unitId: "actor", team: PBTypes.TeamVals.LOWER }],
                        }),
                    );
                    return fakeResult(config);
                },
            },
        );
        const expectedRoster = v07ArchetypeTemplate("mage_frontline").roster;
        expect(captured?.greenVersion).toBe("v0.7");
        expect(captured?.redVersion).toBe("v0.7");
        expect(captured?.gridType).toBe(PBTypes.GridVals.NORMAL);
        expect(captured?.roster).toEqual([...expectedRoster]);
        expect(captured?.redRoster).toEqual([...expectedRoster]);
        expect(result.tally.games).toBe(1);
        expect(result.cluster).toMatchObject({
            template: "mage_frontline",
            shieldIntents: 1,
            explicitUnitDefendedTurns: 1,
            rejectedActions: 0,
        });
        expect(finalizeV07SelfplayPassiveAudit({ gamesPerTemplate: 1 }, result.tally).aggregate.skipToShieldRatio).toBe(
            0,
        );
    });
});
