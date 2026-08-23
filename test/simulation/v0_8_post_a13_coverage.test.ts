import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { buildRoster, creaturesByLevel, makeRng } from "../../src/simulation/army";
import {
    GREEN_TEAM,
    type IDecisionObservation,
    type ITurnExecutionObservation,
} from "../../src/simulation/battle_engine";
import {
    auditV08PostA13Decision,
    auditV08PostA13Turn,
    createV08PostA13ActionAudit,
    fingerprintV08PostA13CoveragePlan,
    forceV08PostA13CoverageUnit,
    getV08PostA13CoverageGameCount,
    getV08PostA13CoverageLanes,
    planV08PostA13CoverageGame,
    summarizeV08PostA13Coverage,
    V08_POST_A13_COVERAGE_LANES,
    V08_POST_A13_COVERAGE_SCHEMA,
    V08_POST_A13_COVERAGE_TARGETS,
    V08_POST_A13_COVERAGE_UNITS,
    V08_POST_A13_LIVE_MAPS,
    type IV08PostA13CoverageOptions,
} from "../../src/simulation/v0_8_post_a13_coverage";

const OPTIONS: IV08PostA13CoverageOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    pairsPerLane: 4,
    baseSeed: 1234,
};

const EXPECTED_TARGETS = [
    { unit: "Mermaid", level: 1, controlUnit: "Peasant" },
    { unit: "Dryad", level: 1, controlUnit: "Peasant" },
    { unit: "Blacksmith", level: 1, controlUnit: "Peasant" },
    { unit: "Ash Moth", level: 1, controlUnit: "Peasant" },
    { unit: "Zena", level: 3, controlUnit: "Crusader" },
    { unit: "Wyvern", level: 2, controlUnit: "Pikeman" },
    { unit: "Trent", level: 2, controlUnit: "Pikeman" },
    { unit: "Manticore", level: 2, controlUnit: "Pikeman" },
    { unit: "Monk", level: 3, controlUnit: "Crusader" },
    { unit: "Battle Mage", level: 2, controlUnit: "Pikeman" },
    { unit: "Nightmare", level: 3, controlUnit: "Crusader" },
    { unit: "Magic Dragon", level: 4, controlUnit: "Black Dragon" },
] as const;

describe("v0.8 forced post-A13 creature coverage", () => {
    test("freezes the exact 12-unit source-boundary set with valid same-level pre-A13 controls", () => {
        expect(V08_POST_A13_COVERAGE_TARGETS).toEqual(EXPECTED_TARGETS);
        expect(V08_POST_A13_COVERAGE_UNITS).toEqual(EXPECTED_TARGETS.map(({ unit }) => unit));
        expect(Object.isFrozen(V08_POST_A13_COVERAGE_TARGETS)).toBe(true);
        expect(V08_POST_A13_COVERAGE_TARGETS.every((target) => Object.isFrozen(target))).toBe(true);
        for (const target of V08_POST_A13_COVERAGE_TARGETS) {
            expect(creaturesByLevel(target.level).some(({ creatureName }) => creatureName === target.unit)).toBe(true);
            expect(creaturesByLevel(target.level).some(({ creatureName }) => creatureName === target.controlUnit)).toBe(
                true,
            );
        }
        expect(V08_POST_A13_LIVE_MAPS).toEqual([
            PBTypes.GridVals.NORMAL,
            PBTypes.GridVals.LAVA_CENTER,
            PBTypes.GridVals.BLOCK_CENTER,
        ]);
    });

    test("defines candidate and opponent ownership lanes for every target", () => {
        expect(V08_POST_A13_COVERAGE_LANES).toHaveLength(EXPECTED_TARGETS.length * 2);
        for (const target of EXPECTED_TARGETS) {
            expect(
                V08_POST_A13_COVERAGE_LANES.filter((lane) => lane.unit === target.unit).map(({ owner }) => owner),
            ).toEqual(["candidate", "opponent"]);
        }
    });

    test("narrows a run to exact requested units without changing pair geometry", () => {
        const nightmareOnly: IV08PostA13CoverageOptions = { ...OPTIONS, targetUnits: ["Nightmare"] };
        const lanes = getV08PostA13CoverageLanes(nightmareOnly);

        expect(lanes).toEqual(V08_POST_A13_COVERAGE_LANES.filter((lane) => lane.unit === "Nightmare"));
        expect(getV08PostA13CoverageGameCount(nightmareOnly)).toBe(16);
        const candidatePair = planV08PostA13CoverageGame(nightmareOnly, 0);
        const opponentPair = planV08PostA13CoverageGame(nightmareOnly, 2);
        expect(candidatePair.lane).toMatchObject({ unit: "Nightmare", owner: "candidate" });
        expect(opponentPair.lane).toMatchObject({ unit: "Nightmare", owner: "opponent" });
        expect(planV08PostA13CoverageGame(nightmareOnly, 1)).toMatchObject({
            seed: candidatePair.seed,
            mapType: candidatePair.mapType,
            candidateSide: "red",
        });
        expect(() => getV08PostA13CoverageLanes({ ...OPTIONS, targetUnits: [] })).toThrow("at least one");
        expect(() => getV08PostA13CoverageLanes({ ...OPTIONS, targetUnits: ["Nightmare", "Nightmare"] })).toThrow(
            "must not repeat",
        );
    });

    test("creates a one-variable target/control pair and removes every incidental post-A13 pick", () => {
        const base = buildRoster(makeRng(99), undefined, undefined, undefined, "expBudget");
        const postA13 = new Set<string>(V08_POST_A13_COVERAGE_UNITS);
        for (const target of V08_POST_A13_COVERAGE_TARGETS) {
            const forced = forceV08PostA13CoverageUnit(base, target.unit);
            const present = [...forced.targetRoster, ...forced.controlRoster].filter((spec) =>
                postA13.has(spec.creatureName),
            );
            expect(present.map(({ creatureName }) => creatureName)).toEqual([target.unit]);
            expect(forced.targetRoster[forced.targetIndex]).toMatchObject({
                creatureName: target.unit,
                level: target.level,
            });
            expect(forced.controlRoster[forced.targetIndex]).toMatchObject({
                creatureName: target.controlUnit,
                level: target.level,
            });
            for (let index = 0; index < forced.targetRoster.length; index += 1) {
                if (index !== forced.targetIndex) {
                    expect(forced.targetRoster[index]).toEqual(forced.controlRoster[index]);
                }
            }
        }
    });

    test("uses adjacent seat swaps, exact ownership, and deterministic NORMAL/LAVA/BLOCK rotation", () => {
        for (let pair = 0; pair < V08_POST_A13_COVERAGE_LANES.length; pair += 1) {
            const even = planV08PostA13CoverageGame(OPTIONS, pair * 2);
            const odd = planV08PostA13CoverageGame(OPTIONS, pair * 2 + 1);
            expect(odd.lane).toEqual(even.lane);
            expect(odd.seed).toBe(even.seed);
            expect(odd.mapType).toBe(even.mapType);
            expect(even.candidateSide).toBe("green");
            expect(odd.candidateSide).toBe("red");
            expect(odd.greenRoster).toEqual(even.redRoster);
            expect(odd.redRoster).toEqual(even.greenRoster);

            const targetRoster = even.targetSide === "green" ? even.greenRoster : even.redRoster;
            const controlRoster = even.targetSide === "green" ? even.redRoster : even.greenRoster;
            expect(targetRoster[even.targetIndex].creatureName).toBe(even.lane.unit);
            expect(controlRoster[even.targetIndex].creatureName).toBe(even.lane.controlUnit);
            expect(even.targetSide === even.candidateSide).toBe(even.lane.owner === "candidate");
        }

        const gamesPerCycle = V08_POST_A13_COVERAGE_LANES.length * 2;
        expect(planV08PostA13CoverageGame(OPTIONS, 0).mapType).toBe(PBTypes.GridVals.NORMAL);
        expect(planV08PostA13CoverageGame(OPTIONS, gamesPerCycle).mapType).toBe(PBTypes.GridVals.LAVA_CENTER);
        expect(planV08PostA13CoverageGame(OPTIONS, gamesPerCycle * 2).mapType).toBe(PBTypes.GridVals.BLOCK_CENTER);
        expect(planV08PostA13CoverageGame(OPTIONS, gamesPerCycle * 3).mapType).toBe(PBTypes.GridVals.NORMAL);
    });

    test("commits the exact schedule and preserves per-lane map/physical-seat census", () => {
        const records = Array.from({ length: getV08PostA13CoverageGameCount(OPTIONS) }, (_, game) => {
            const plan = planV08PostA13CoverageGame(OPTIONS, game);
            return {
                schema: V08_POST_A13_COVERAGE_SCHEMA,
                game,
                cycle: plan.cycle,
                seed: plan.seed,
                mapType: plan.mapType,
                lane: plan.lane,
                candidateVersion: OPTIONS.candidateVersion,
                opponentVersion: OPTIONS.opponentVersion,
                candidateSide: plan.candidateSide,
                targetSide: plan.targetSide,
                winner: "draw" as const,
                laps: 1,
                endReason: "turn_cap" as const,
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                target: { ...createV08PostA13ActionAudit(), appearances: 1, actingTurns: 1, spellDecisionTurns: 1 },
                armageddon: { reached: false, waves: 0, decided: false, unitsKilled: 0 },
            };
        });
        const summary = summarizeV08PostA13Coverage(OPTIONS, records);

        expect(summary.planSha256).toBe(fingerprintV08PostA13CoveragePlan(OPTIONS));
        expect(summary.lanes).toHaveLength(24);
        for (const lane of summary.lanes) {
            expect(lane.games).toBe(8);
            expect(lane.candidateGreenGames).toBe(4);
            expect(lane.candidateRedGames).toBe(4);
            expect(lane.mapCensus).toEqual([
                { mapType: PBTypes.GridVals.NORMAL, games: 4, candidateGreenGames: 2, candidateRedGames: 2 },
                { mapType: PBTypes.GridVals.LAVA_CENTER, games: 2, candidateGreenGames: 1, candidateRedGames: 1 },
                { mapType: PBTypes.GridVals.BLOCK_CENTER, games: 2, candidateGreenGames: 1, candidateRedGames: 1 },
            ]);
        }
        expect(() =>
            summarizeV08PostA13Coverage(OPTIONS, [
                { ...records[0]!, mapType: PBTypes.GridVals.WATER_CENTER },
                ...records.slice(1),
            ]),
        ).toThrow("deterministic plan");
        expect(() => fingerprintV08PostA13CoveragePlan({ ...OPTIONS, baseSeed: -1 })).toThrow("uint32");
    });

    test("audits target action rejections, completed casts, and only remaining spell charges", () => {
        const audit = createV08PostA13ActionAudit();
        audit.appearances = 1;
        const decision = {
            unit: {
                getName: () => "Magic Dragon",
                getTeam: () => GREEN_TEAM,
                getSpells: () => [
                    { getName: () => "Fire Strike", getAmount: () => 2, isRemaining: () => true },
                    { getName: () => "Lightning Strike", getAmount: () => 0, isRemaining: () => false },
                ],
            },
        } as unknown as IDecisionObservation;
        auditV08PostA13Decision(audit, decision, "Magic Dragon", "green");
        auditV08PostA13Decision(audit, decision, "Magic Dragon", "red");

        const turn = {
            creatureName: "Magic Dragon",
            side: "green",
            rawIncumbent: [{ type: "end_turn", unitId: "u" }],
            strategyActions: [
                { action: { type: "move_unit", unitId: "u", path: [] }, completed: true, events: [] },
                {
                    action: { type: "melee_attack", attackerId: "u", targetId: "e", attackFrom: { x: 0, y: 0 } },
                    completed: false,
                    rejectionReason: "blocked",
                    events: [],
                },
                {
                    action: { type: "cast_spell", casterId: "u", spellName: "Fire Strike" },
                    completed: true,
                    events: [],
                },
            ],
            recoveryAttempts: [
                {
                    source: "defend",
                    action: { type: "defend_turn", unitId: "u" },
                    completed: false,
                    rejectionReason: "turn_closed",
                    events: [],
                },
            ],
        } as unknown as ITurnExecutionObservation;
        auditV08PostA13Turn(audit, turn, "Magic Dragon", "green");
        auditV08PostA13Turn(audit, turn, "Magic Dragon", "red");

        expect(audit).toMatchObject({
            appearances: 1,
            actingTurns: 1,
            completedActions: 2,
            completedStrategyActions: 2,
            completedRecoveryActions: 0,
            rejectedStrategyActions: 1,
            rejectedRecoveryActions: 1,
            productiveActions: 2,
            turnsWithoutProductiveAction: 0,
            rawEndTurnDecisions: 1,
            actionTypes: { move_unit: 1, cast_spell: 1 },
            rejectionReasons: { blocked: 1, turn_closed: 1 },
            spellDecisionTurns: 1,
            activeSpellTurns: 1,
            activeSpellChargesObserved: 2,
            activeSpellsObserved: { "Fire Strike": 1 },
            activeSpellChargesByName: { "Fire Strike": 2 },
            spellCasts: { "Fire Strike": 1 },
        });
    });
});
