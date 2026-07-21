import { describe, expect, test } from "bun:test";

import type { ITurnExecutionObservation } from "../../src/simulation/battle_engine";
import {
    auditV08Level4Turn,
    forceLevel4CoverageUnit,
    planV08Level4CoverageGame,
    V08_LEVEL4_CONTROL_UNIT,
    V08_LEVEL4_COVERAGE_LANES,
    V08_LEVEL4_COVERAGE_UNITS,
    type IV08Level4ActionAudit,
    type IV08Level4CoverageOptions,
} from "../../src/simulation/v0_8_l4_coverage";
import { buildRoster, makeRng } from "../../src/simulation/army";

const OPTIONS: IV08Level4CoverageOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    pairsPerLane: 1,
    baseSeed: 1234,
};

const emptyAudit = (): IV08Level4ActionAudit => ({
    appearances: 1,
    actingTurns: 0,
    completedActions: 0,
    completedStrategyActions: 0,
    completedRecoveryActions: 0,
    productiveActions: 0,
    turnsWithoutProductiveAction: 0,
    rawEndTurnDecisions: 0,
    actionTypes: {},
});

describe("v0.8 forced level-4 coverage", () => {
    test("defines candidate and opponent lanes for every new level-4 unit", () => {
        expect(V08_LEVEL4_COVERAGE_LANES).toHaveLength(V08_LEVEL4_COVERAGE_UNITS.length * 2);
        for (const unit of V08_LEVEL4_COVERAGE_UNITS) {
            expect(V08_LEVEL4_COVERAGE_LANES.filter((lane) => lane.unit === unit).map((lane) => lane.owner)).toEqual([
                "candidate",
                "opponent",
            ]);
        }
    });

    test("forces exactly one requested L4 while preserving all lower-level picks", () => {
        const base = buildRoster(makeRng(99), undefined, undefined, undefined, "expBudget");
        const units: readonly ((typeof V08_LEVEL4_COVERAGE_UNITS)[number] | typeof V08_LEVEL4_CONTROL_UNIT)[] = [
            ...V08_LEVEL4_COVERAGE_UNITS,
            V08_LEVEL4_CONTROL_UNIT,
        ];
        for (const unit of units) {
            const forced = forceLevel4CoverageUnit(base, unit);
            expect(forced.filter((spec) => spec.level === 4).map((spec) => spec.creatureName)).toEqual([unit]);
            expect(forced.filter((spec) => spec.level < 4)).toEqual(base.filter((spec) => spec.level < 4));
        }
    });

    test("uses adjacent deterministic seat swaps and puts the target on the lane owner", () => {
        for (let pair = 0; pair < V08_LEVEL4_COVERAGE_LANES.length; pair += 1) {
            const even = planV08Level4CoverageGame(OPTIONS, pair * 2);
            const odd = planV08Level4CoverageGame(OPTIONS, pair * 2 + 1);
            expect(odd.lane).toEqual(even.lane);
            expect(odd.seed).toBe(even.seed);
            expect(odd.mapType).toBe(even.mapType);
            expect(even.candidateSide).toBe("green");
            expect(odd.candidateSide).toBe("red");
            expect(odd.greenRoster).toEqual(even.redRoster);
            expect(odd.redRoster).toEqual(even.greenRoster);

            const targetRoster = even.targetSide === "green" ? even.greenRoster : even.redRoster;
            const otherRoster = even.targetSide === "green" ? even.redRoster : even.greenRoster;
            expect(targetRoster.filter((spec) => spec.creatureName === even.lane.unit)).toHaveLength(1);
            expect(otherRoster.filter((spec) => spec.creatureName === V08_LEVEL4_CONTROL_UNIT)).toHaveLength(1);
            expect(even.targetSide === even.candidateSide).toBe(even.lane.owner === "candidate");
        }
    });

    test("audits completed strategy/recovery actions and non-productive turns for only the target stack", () => {
        const audit = emptyAudit();
        const observation = {
            creatureName: "Champion",
            side: "green",
            rawIncumbent: [{ type: "end_turn", unitId: "u" }],
            strategyActions: [
                { action: { type: "move_unit", unitId: "u", path: [] }, completed: true, events: [] },
                { action: { type: "melee_attack", unitId: "u", targetId: "e" }, completed: false, events: [] },
            ],
            recoveryAttempts: [
                { source: "defend", action: { type: "defend_turn", unitId: "u" }, completed: true, events: [] },
            ],
        } as unknown as ITurnExecutionObservation;
        auditV08Level4Turn(audit, observation, "Champion", "green");
        auditV08Level4Turn(audit, observation, "Champion", "red");
        expect(audit).toMatchObject({
            appearances: 1,
            actingTurns: 1,
            completedActions: 2,
            completedStrategyActions: 1,
            completedRecoveryActions: 1,
            productiveActions: 1,
            turnsWithoutProductiveAction: 0,
            rawEndTurnDecisions: 1,
            actionTypes: { move_unit: 1, defend_turn: 1 },
        });
    });
});
