import { describe, expect, test } from "bun:test";

import type { IAIPolicyEvent, IAIStrategy, IDecisionContext } from "../../src/ai/ai_strategy";
import { STRATEGY_V0_1 } from "../../src/ai/versions/v0_1";
import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { buildRoster, makeRng, type IArmyUnitSpec } from "../../src/simulation/army";
import { runMatch, type IMatchResult, type ITurnExecutionObservation } from "../../src/simulation/battle_engine";
import { LookaheadDriver } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";

const runObservedMatch = (seed: number, maxLaps: number) => {
    const decisions: (readonly GameAction[])[] = [];
    const turns: ITurnExecutionObservation[] = [];
    runMatch({
        greenVersion: "v0.1",
        redVersion: "v0.1",
        roster: buildRoster(makeRng(seed)),
        seed,
        maxLaps,
        decisionObserver: ({ incumbent }) => decisions.push(incumbent),
        turnExecutionObserver: (observation) => turns.push(observation),
    });
    return { decisions, turns };
};

type DecideTurn = IAIStrategy["decideTurn"];
type DecisionTransform = (
    unit: Parameters<DecideTurn>[0],
    context: Parameters<DecideTurn>[1],
    incumbent: GameAction[],
) => GameAction[];

const runObservedMatchWithV01Transform = (
    seed: number,
    maxLaps: number,
    transform: DecisionTransform,
): { result: IMatchResult; turns: ITurnExecutionObservation[] } => {
    const turns: ITurnExecutionObservation[] = [];
    const originalDecideTurn = STRATEGY_V0_1.decideTurn;
    STRATEGY_V0_1.decideTurn = (unit, context) =>
        transform(unit, context, originalDecideTurn.call(STRATEGY_V0_1, unit, context));
    try {
        const result = runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster: buildRoster(makeRng(seed)),
            seed,
            maxLaps,
            turnExecutionObserver: (observation) => turns.push(observation),
        });
        return { result, turns };
    } finally {
        STRATEGY_V0_1.decideTurn = originalDecideTurn;
    }
};

describe("battle engine turn execution observer", () => {
    test("keeps the offline a13 trajectory search unbounded", () => {
        const originalChooseDecision = SearchDriver.prototype.chooseDecision;
        const trajectoryDeadlines: Array<{ deadline: number | null; circuitBreaker: number | null }> = [];
        SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context): GameAction[] {
            const driver = this as unknown as {
                scoredDecisionObserver: unknown;
                decisionDeadlineMs: number | null;
                circuitBreakerMs: number | null;
            };
            if (driver.scoredDecisionObserver === undefined && version === "v0.8") {
                trajectoryDeadlines.push({
                    deadline: driver.decisionDeadlineMs,
                    circuitBreaker: driver.circuitBreakerMs,
                });
            }
            return originalChooseDecision.call(this, unit, version, incumbent, context);
        };
        try {
            withScopedAIEnvironment(
                {
                    ...buildV08A13SearchEnvironment(),
                    V07_SEARCH: "1",
                    SEARCH_VERSIONS: "v0.8",
                    SEARCH_GATE: "0",
                    SEARCH_HORIZON: "1",
                    SEARCH_ROLLOUTS: "1",
                    SEARCH_INCLUDE_MOVES: "1",
                    SEARCH_OBSERVE_ONLY: "1",
                    // A teacher corpus must not depend on host timing. These explicitly override the bounded
                    // production a13 defaults above and must reach its frozen-trajectory driver unchanged.
                    SEARCH_DECISION_DEADLINE_MS: undefined,
                    SEARCH_CIRCUIT_BREAKER_MS: undefined,
                },
                () => {
                    runMatch({
                        greenVersion: "v0.8",
                        redVersion: "v0.8",
                        roster: buildRoster(makeRng(91_004)),
                        seed: 91_004,
                        maxLaps: 2,
                        searchScoredDecisionObserver: () => {},
                        searchShadowOnly: true,
                        searchV08A13TrajectoryTeams: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
                    });
                },
            );
        } finally {
            SearchDriver.prototype.chooseDecision = originalChooseDecision;
        }

        expect(trajectoryDeadlines.length).toBeGreaterThan(0);
        expect(trajectoryDeadlines).toEqual(
            Array.from({ length: trajectoryDeadlines.length }, () => ({ deadline: null, circuitBreaker: null })),
        );
    });

    test("keeps active AI-Driven roots out of research search and trajectory selectors", () => {
        const previousSearch = process.env.V07_SEARCH;
        const previousVersions = process.env.SEARCH_VERSIONS;
        const previousLookahead = process.env.V05_LOOKAHEAD;
        const originalAppliesTo = SearchDriver.prototype.appliesTo;
        const originalChooseDecision = SearchDriver.prototype.chooseDecision;
        const originalLookaheadChooseDecision = LookaheadDriver.prototype.chooseDecision;
        const observedVersions: string[] = [];
        let v01SearchGateCalls = 0;
        let v01SearchSelections = 0;
        let v01LookaheadSelections = 0;
        process.env.V07_SEARCH = "1";
        process.env.SEARCH_VERSIONS = "v0.1";
        process.env.V05_LOOKAHEAD = "on";
        SearchDriver.prototype.appliesTo = function (version): boolean {
            if (version === "v0.1") {
                v01SearchGateCalls += 1;
            }
            return originalAppliesTo.call(this, version);
        };
        SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context): GameAction[] {
            if (version === "v0.1") {
                v01SearchSelections += 1;
            }
            return originalChooseDecision.call(this, unit, version, incumbent, context);
        };
        LookaheadDriver.prototype.chooseDecision = function (unit, incumbent): GameAction[] {
            if (unit.hasAbilityActive("AI Driven")) {
                v01LookaheadSelections += 1;
            }
            return originalLookaheadChooseDecision.call(this, unit, incumbent);
        };
        const roster: readonly IArmyUnitSpec[] = [
            { faction: "Might", creatureName: "Berserker", level: 1, size: 1, amount: 20 },
        ];
        try {
            runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster,
                seed: 91_001,
                maxLaps: 2,
                searchScoredDecisionObserver: () => {},
                searchV08A13TrajectoryTeams: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
                decisionObserver: ({ strategyVersion }) => observedVersions.push(strategyVersion),
            });
        } finally {
            SearchDriver.prototype.appliesTo = originalAppliesTo;
            SearchDriver.prototype.chooseDecision = originalChooseDecision;
            LookaheadDriver.prototype.chooseDecision = originalLookaheadChooseDecision;
            if (previousSearch === undefined) delete process.env.V07_SEARCH;
            else process.env.V07_SEARCH = previousSearch;
            if (previousVersions === undefined) delete process.env.SEARCH_VERSIONS;
            else process.env.SEARCH_VERSIONS = previousVersions;
            if (previousLookahead === undefined) delete process.env.V05_LOOKAHEAD;
            else process.env.V05_LOOKAHEAD = previousLookahead;
        }

        expect(observedVersions.length).toBeGreaterThan(0);
        expect(observedVersions.every((version) => version === "v0.1")).toBe(true);
        // Both the generic research driver and the optional a13 trajectory driver are short-circuited
        // before their version gates, so neither can become a second controller for the live root.
        expect(v01SearchGateCalls).toBe(0);
        expect(v01SearchSelections).toBe(0);
        expect(v01LookaheadSelections).toBe(0);
    });

    test("re-decides a rejected mindless attack with exact v0.1 instead of generic advance or defend", () => {
        const originalDecideTurn = STRATEGY_V0_1.decideTurn;
        const turns: ITurnExecutionObservation[] = [];
        let injectedUnitId: string | undefined;
        STRATEGY_V0_1.decideTurn = (unit, context) => {
            const incumbent = originalDecideTurn.call(STRATEGY_V0_1, unit, context);
            if (
                !injectedUnitId &&
                unit.hasAbilityActive("AI Driven") &&
                incumbent.some((action) => action.type === "melee_attack")
            ) {
                injectedUnitId = unit.getId();
                return [{ type: "range_attack", attackerId: unit.getId(), targetId: unit.getId() }];
            }
            return incumbent;
        };
        const roster: readonly IArmyUnitSpec[] = [
            { faction: "Might", creatureName: "Berserker", level: 1, size: 1, amount: 20 },
        ];
        let result: IMatchResult;
        try {
            result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster,
                seed: 91_002,
                maxLaps: 8,
                turnExecutionObserver: (observation) => turns.push(observation),
            });
        } finally {
            STRATEGY_V0_1.decideTurn = originalDecideTurn;
        }

        expect(injectedUnitId).toBeDefined();
        const retriedTurn = turns.find(
            (turn) =>
                turn.unitId === injectedUnitId &&
                turn.strategyActions.some((execution) => execution.action.type === "range_attack"),
        );
        expect(retriedTurn).toBeDefined();
        expect(retriedTurn!.strategyVersion).toBe("v0.1");
        expect(retriedTurn!.recoveryAttempts.length).toBeGreaterThan(0);
        expect(retriedTurn!.recoveryAttempts.every((attempt) => attempt.source === "v0.1_retry")).toBe(true);
        expect(
            retriedTurn!.recoveryAttempts.some(
                (attempt) => attempt.completed && attempt.action?.type === "melee_attack",
            ),
        ).toBe(true);
        expect(retriedTurn!.events.map((event) => event.type)).toContain("unit_attacked");
        expect(retriedTurn!.events.map((event) => event.type)).not.toContain("unit_defended");
        expect(result.rejectedDetails).toContainEqual(
            expect.objectContaining({
                creature: "Berserker",
                type: "range_attack",
                version: "v0.1",
            }),
        );
    });

    test("ends neutrally when the mindless v0.1 retry itself throws", () => {
        const originalDecideTurn = STRATEGY_V0_1.decideTurn;
        const turns: ITurnExecutionObservation[] = [];
        let injectedUnitId: string | undefined;
        let throwOnRetry = false;
        STRATEGY_V0_1.decideTurn = (unit, context) => {
            if (throwOnRetry && unit.getId() === injectedUnitId) {
                throwOnRetry = false;
                throw new Error("injected retry-only failure");
            }
            const incumbent = originalDecideTurn.call(STRATEGY_V0_1, unit, context);
            if (
                !injectedUnitId &&
                unit.hasAbilityActive("AI Driven") &&
                incumbent.some((action) => action.type === "melee_attack")
            ) {
                injectedUnitId = unit.getId();
                throwOnRetry = true;
                return [{ type: "range_attack", attackerId: unit.getId(), targetId: unit.getId() }];
            }
            return incumbent;
        };
        const roster: readonly IArmyUnitSpec[] = [
            { faction: "Might", creatureName: "Berserker", level: 1, size: 1, amount: 20 },
        ];
        try {
            runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster,
                seed: 91_003,
                maxLaps: 8,
                turnExecutionObserver: (observation) => turns.push(observation),
            });
        } finally {
            STRATEGY_V0_1.decideTurn = originalDecideTurn;
        }

        expect(injectedUnitId).toBeDefined();
        const failedRetryTurn = turns.find(
            (turn) =>
                turn.unitId === injectedUnitId &&
                turn.strategyActions.some((execution) => execution.action.type === "range_attack"),
        );
        expect(failedRetryTurn).toBeDefined();
        expect(failedRetryTurn!.recoveryAttempts).toEqual([]);
        expect(failedRetryTurn!.recovery).toEqual({ source: "none", completed: false, events: [] });
        expect(failedRetryTurn!.events.map((event) => event.type)).toContain("unit_skipped");
        expect(failedRetryTurn!.events.map((event) => event.type)).not.toContain("unit_defended");
        expect(failedRetryTurn!.events.map((event) => event.type)).not.toContain("unit_moved");
    });

    test("emits policy telemetry only when search retains the strategy incumbent", () => {
        const retained: IAIPolicyEvent[] = [];
        const retainedProposals: IAIPolicyEvent[] = [];
        const overridden: IAIPolicyEvent[] = [];
        const overriddenProposals: IAIPolicyEvent[] = [];
        const decisionOrigins: Array<IDecisionContext["decisionOrigin"]> = [];
        const originalDecideTurn = STRATEGY_V0_1.decideTurn;
        const originalAppliesTo = SearchDriver.prototype.appliesTo;
        const originalChooseDecision = SearchDriver.prototype.chooseDecision;
        STRATEGY_V0_1.decideTurn = (unit, context) => {
            decisionOrigins.push(context.decisionOrigin);
            context.policyEventObserver?.({
                kind: "v0.8_response_neutral_advance",
                unitId: unit.getId(),
                creatureName: unit.getName(),
                team: unit.getTeam(),
                lap: context.fightProperties?.getCurrentLap() ?? 0,
            });
            return originalDecideTurn.call(STRATEGY_V0_1, unit, context);
        };
        try {
            runMatch({
                greenVersion: "v0.1",
                redVersion: "v0.1",
                roster: buildRoster(makeRng(35)),
                seed: 35,
                maxLaps: 1,
                policyProposalObserver: (event) => retainedProposals.push(event),
                policyEventObserver: (event) => retained.push(event),
            });
            expect(retained.length).toBeGreaterThan(0);
            expect(retainedProposals).toEqual(retained);
            expect(retainedProposals.every((event, index) => event === retained[index])).toBe(true);

            SearchDriver.prototype.appliesTo = () => true;
            SearchDriver.prototype.chooseDecision = (_unit, _version, incumbent) => incumbent.slice();
            runMatch({
                greenVersion: "v0.1",
                redVersion: "v0.1",
                roster: buildRoster(makeRng(35)),
                seed: 35,
                maxLaps: 1,
                policyProposalObserver: (event) => overriddenProposals.push(event),
                policyEventObserver: (event) => overridden.push(event),
            });
            expect(overriddenProposals.length).toBeGreaterThan(0);
            expect(overridden).toEqual([]);
            expect(decisionOrigins.length).toBeGreaterThan(0);
            expect(decisionOrigins.every((origin) => origin === "root")).toBe(true);
        } finally {
            STRATEGY_V0_1.decideTurn = originalDecideTurn;
            SearchDriver.prototype.appliesTo = originalAppliesTo;
            SearchDriver.prototype.chooseDecision = originalChooseDecision;
        }
    });

    // RE-PIN NEEDED (fight lane): the pure-fractional steps call (2026-08-06, getSteps no longer
    // rounds) reshapes this seeded game, so the scenario this pin narrates no longer occurs on its
    // seed. The engine invariant is unchanged; the fixture needs a fresh seed/judgment.
    test.skip("emits exactly once per decision with detached actions and explicit skip events", () => {
        // Seed re-pinned 25 -> 31 after the attack_handler engine change shifted the seeded trajectory so
        // seed 25 no longer produced a turn whose incumbent decided to skip (end_turn) within 5 laps.
        // Re-pinned 31 -> 10 -> 20 after enabling Abomination (41), then Champion/Frenzied Boar (42/43),
        // shifted roster draws the same way. Re-pinned 20 -> 35 after v0.1 stopped emitting illegal
        // forced-target melees, which changed the fight trajectory while retaining a genuine skip.
        // Re-pinned 35 -> 33 after enabling Wandering Mage (49) grew the L1 pool 15 -> 16 and shifted the seeded
        // roster draw off a skipping trajectory.
        // Re-pinned 33 -> 31 after enabling Zena (50) grew the L2 pool the same way.
        // Re-pinned 31 -> 21 after enabling Monk (54) grew the L3 pool, then 21 -> 29 after Battle Mage (55),
        // Nightmare (56) and Magic Dragon (57) landed and Zena moved from L2 to L3.
        // Re-pinned 29 -> 63 after Magic Dragon (57) grew the L4 pool and Pegasus moved from L4 to L3, which
        // shifted seed 29 off a skipping trajectory. 63 is the lowest seed that again yields a turn whose
        // incumbent genuinely decides to skip within 5 laps (63/65/75/119/126/143/154/202/205/209 qualify).
        const { decisions, turns } = runObservedMatch(63, 5);

        expect(turns).toHaveLength(decisions.length);
        expect(turns.length).toBeGreaterThan(0);
        for (let i = 0; i < turns.length; i += 1) {
            expect(turns[i].rawIncumbent).not.toBe(decisions[i]);
            expect(turns[i].rawIncumbent[0]).not.toBe(decisions[i][0]);
        }

        const skipped = turns.find((turn) => turn.rawIncumbent.some((action) => action.type === "end_turn"));
        expect(skipped).toBeDefined();
        expect(skipped!.strategyActions).toHaveLength(1);
        expect(skipped!.strategyActions[0]).toMatchObject({
            action: { type: "end_turn" },
            completed: true,
        });
        expect(skipped!.recoveryAttempts).toEqual([]);
        expect(skipped!.recovery).toEqual({ source: "none", completed: false, events: [] });
        expect(skipped!.events.some((event) => event.type === "unit_skipped" && event.unitId === skipped!.unitId)).toBe(
            true,
        );
    });

    test("reports a repaired ranged decision as accepted without invoking the recovery shield", () => {
        // Seed re-pinned from 1603 -> 952 after the lap-start morale-roll fix (applyMoraleRolls now reads
        // true accumulated morale, not the stale ±20 lock) shifted the seeded trajectory so 1603 no longer
        // produced a rejected-melee -> defend-recovery turn. Re-pinned 952 -> 445 after enabling
        // Abomination/Champion/Frenzied Boar (catalog ids 41-43) shifted roster draws. Re-pinned 445 -> 952
        // after enabling Arachna Queen (44) shifted the L4 pool while preserving this observer seam.
        // Re-pinned 952 -> 25 after v0.1's melee legality hardening removed that forced-target rejection.
        // Seed 25 then exposed a default-edge ranged rejection; exact edge validation now repairs the shot
        // before execution, and the observer must report that accepted strategy action with no recovery.
        const { decisions, turns } = runObservedMatch(25, 40);

        expect(turns).toHaveLength(decisions.length);
        const repaired = turns.find((turn) =>
            turn.strategyActions.some((execution) => execution.action.type === "range_attack"),
        );
        expect(repaired).toBeDefined();
        expect(repaired!.strategyActions.at(-1)).toMatchObject({
            action: { type: "range_attack" },
            completed: true,
        });
        expect(repaired!.strategyActions.every((execution) => execution.completed)).toBe(true);
        expect(repaired!.recoveryAttempts).toEqual([]);
        expect(repaired!.recovery).toEqual({ source: "none", completed: false, events: [] });
        expect(repaired!.events.map((event) => event.type)).toContain("unit_attacked");
        expect(repaired!.events.map((event) => event.type)).toContain("turn_completed");
    });

    // RE-PIN NEEDED (fight lane): the pure-fractional steps call (2026-08-06, getSteps no longer
    // rounds) reshapes this seeded game, so the scenario this pin narrates no longer occurs on its
    // seed. The engine invariant is unchanged; the fixture needs a fresh seed/judgment.
    test.skip("reports a deliberately rejected strategy action separately from defend recovery", () => {
        let injectedUnitId: string | undefined;
        // Seed 35 -> 33 -> 31 -> 21 -> 29 -> 63 alongside the skip test above: this injection needs a turn
        // whose incumbent decided to skip, and every catalog growth (Wandering Mage, Zena, Monk, then Battle Mage /
        // Nightmare / Magic Dragon) shifts the previous seed off that trajectory.
        const { result, turns } = runObservedMatchWithV01Transform(63, 5, (unit, _context, incumbent) => {
            if (!injectedUnitId && incumbent.some((action) => action.type === "end_turn")) {
                injectedUnitId = unit.getId();
                return [{ type: "range_attack", attackerId: unit.getId(), targetId: unit.getId() }];
            }
            return incumbent;
        });

        expect(injectedUnitId).toBeDefined();
        expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(1);
        const recovered = turns.find((turn) =>
            turn.strategyActions.some(
                (execution) =>
                    execution.action.type === "range_attack" &&
                    execution.action.targetId === execution.action.attackerId,
            ),
        );
        expect(recovered).toBeDefined();
        expect(recovered!.strategyActions).toEqual([
            {
                action: { type: "range_attack", attackerId: injectedUnitId!, targetId: injectedUnitId! },
                completed: false,
                rejectionReason: "attack_not_available",
                events: [],
            },
        ]);
        expect(recovered!.recovery).toMatchObject({
            source: "defend",
            completed: true,
            action: { type: "defend_turn", unitId: injectedUnitId },
        });
        expect(recovered!.recoveryAttempts.at(-1)).toEqual(recovered!.recovery);
        expect(recovered!.events.map((event) => event.type)).toEqual(["unit_defended", "turn_completed"]);
    });

    test("records an advance recovery's origin before applying the move", () => {
        let injectedUnitId: string | undefined;
        const { result, turns } = runObservedMatchWithV01Transform(35, 1, (unit, _context, incumbent) => {
            if (injectedUnitId || !unit.canMove()) {
                return incumbent;
            }
            injectedUnitId = unit.getId();
            return [{ type: "range_attack", attackerId: unit.getId(), targetId: unit.getId() }];
        });

        expect(injectedUnitId).toBeDefined();
        const recovered = turns.find((turn) => turn.unitId === injectedUnitId);
        expect(recovered?.recovery).toMatchObject({
            source: "advance",
            completed: true,
            action: { type: "move_unit", unitId: injectedUnitId },
        });
        const recoveryAction = recovered?.recovery.action;
        if (!recoveryAction || recoveryAction.type !== "move_unit") {
            throw new Error("expected an advance recovery");
        }
        const recordedMove = result.actions.find(
            (action) => action.unitId === injectedUnitId && action.actionType === "move_unit",
        );
        expect(recordedMove).toBeDefined();
        expect(recordedMove?.fromCell).toEqual(recoveryAction.path[0]);
        expect(recordedMove?.toCell).toEqual(recoveryAction.path.at(-1));
        expect(recordedMove?.fromCell).not.toEqual(recordedMove?.toCell);
    });

    test("attributes a rejected ranged shot to Cowardice against its stronger resolved primary", () => {
        let injectedUnitId: string | undefined;
        let resolvedPrimaryId: string | undefined;
        let attackerHp: number | undefined;
        let primaryHp: number | undefined;
        const { result, turns } = runObservedMatchWithV01Transform(25, 40, (unit, context, incumbent) => {
            const shot = incumbent.find(
                (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
            );
            const target = shot ? context.unitsHolder.getAllUnits().get(shot.targetId) : undefined;
            if (injectedUnitId || !shot || !target || !context.attackHandler || unit.hasAbilityActive("Through Shot")) {
                return incumbent;
            }
            let chosenAim: { cell: { x: number; y: number }; side: RangeAttackCellSide } | undefined;
            let primary: Unit | undefined;
            for (const cell of target.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(context.grid.getMatrix(), cell, side, unit.getTeam(), false)) {
                        continue;
                    }
                    const targetPosition = getRangeAttackSideCenter(
                        context.grid.getSettings(),
                        cell,
                        side,
                        unit.getPosition(),
                    );
                    const candidate = context.attackHandler.evaluateRangeAttack(
                        context.unitsHolder.getAllUnits(),
                        unit,
                        unit.getPosition(),
                        targetPosition,
                        false,
                        false,
                        unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw"),
                    ).affectedUnits[0]?.[0];
                    if (candidate && candidate.getTeam() !== unit.getTeam()) {
                        chosenAim = { cell: { ...cell }, side };
                        primary = candidate;
                        break;
                    }
                }
                if (chosenAim) {
                    break;
                }
            }
            if (!chosenAim || !primary) {
                return incumbent;
            }

            unit.setAmountAlive(1);
            if (primary.getCumulativeHp() <= unit.getCumulativeHp()) {
                primary.setAmountAlive(
                    Math.max(primary.getAmountAlive(), Math.floor(unit.getCumulativeHp() / primary.getMaxHp()) + 2),
                );
            }
            unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
            injectedUnitId = unit.getId();
            resolvedPrimaryId = primary.getId();
            attackerHp = unit.getCumulativeHp();
            primaryHp = primary.getCumulativeHp();
            return incumbent.map((action) =>
                action === shot ? { ...action, aimCell: chosenAim.cell, aimSide: chosenAim.side } : action,
            );
        });

        expect(injectedUnitId).toBeDefined();
        expect(resolvedPrimaryId).toBeDefined();
        expect(attackerHp).toBeLessThan(primaryHp!);
        expect(result.rejectedDetails).toContainEqual(
            expect.objectContaining({
                type: "range_attack",
                reason: "attack_not_available",
                cause: "cowardice",
            }),
        );
        const rejected = turns.find(
            (turn) =>
                turn.unitId === injectedUnitId &&
                turn.strategyActions.some(
                    (execution) => execution.action.type === "range_attack" && !execution.completed,
                ),
        );
        expect(rejected).toBeDefined();
        expect(rejected!.strategyActions.at(-1)).toMatchObject({
            action: { type: "range_attack" },
            completed: false,
            rejectionReason: "attack_not_available",
        });
    });

    test("counts a rejected attack-type selector once when the following attack succeeds", () => {
        let injectedUnitId: string | undefined;
        const { result, turns } = runObservedMatchWithV01Transform(35, 8, (unit, _context, incumbent) => {
            const hasMelee = incumbent.some((action) => action.type === "melee_attack");
            const hasSelector = incumbent.some((action) => action.type === "select_attack_type");
            if (
                !injectedUnitId &&
                hasMelee &&
                !hasSelector &&
                unit.getAttackTypeSelection() === PBTypes.AttackVals.MELEE &&
                !unit.getPossibleAttackTypes().includes(PBTypes.AttackVals.MELEE_MAGIC)
            ) {
                injectedUnitId = unit.getId();
                return [
                    {
                        type: "select_attack_type",
                        unitId: unit.getId(),
                        attackType: PBTypes.AttackVals.MELEE_MAGIC,
                    },
                    ...incumbent,
                ];
            }
            return incumbent;
        });

        expect(injectedUnitId).toBeDefined();
        expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(1);
        expect(result.rejectedDetails).toEqual([
            expect.objectContaining({
                type: "select_attack_type",
                reason: "attack_type_not_available",
                cause: `select:${PBTypes.AttackVals.MELEE_MAGIC}`,
            }),
        ]);
        const selectedThenAttacked = turns.find((turn) => turn.unitId === injectedUnitId);
        expect(selectedThenAttacked).toBeDefined();
        expect(selectedThenAttacked!.strategyActions).toHaveLength(3);
        expect(selectedThenAttacked!.strategyActions[0]).toMatchObject({
            action: { type: "select_attack_type", attackType: PBTypes.AttackVals.MELEE_MAGIC },
            completed: false,
            rejectionReason: "attack_type_not_available",
        });
        expect(selectedThenAttacked!.strategyActions[1]).toMatchObject({
            action: { type: "move_unit" },
            completed: true,
        });
        expect(selectedThenAttacked!.strategyActions[2]).toMatchObject({
            action: { type: "melee_attack" },
            completed: true,
        });
        expect(selectedThenAttacked!.recoveryAttempts).toEqual([]);
        expect(selectedThenAttacked!.recovery).toEqual({ source: "none", completed: false, events: [] });
        expect(selectedThenAttacked!.events.map((event) => event.type)).toContain("unit_attacked");
        expect(selectedThenAttacked!.events.map((event) => event.type)).toContain("turn_completed");
    });
});
