import { describe, expect, test } from "bun:test";

import type { IAIPolicyEvent, IAIStrategy, IDecisionContext } from "../../src/ai/ai_strategy";
import { STRATEGY_V0_1 } from "../../src/ai/versions/v0_1";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch, type IMatchResult, type ITurnExecutionObservation } from "../../src/simulation/battle_engine";
import { SearchDriver } from "../../src/simulation/search_driver";
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

    test("emits exactly once per decision with detached actions and explicit skip events", () => {
        // Seed re-pinned 25 -> 31 after the attack_handler engine change shifted the seeded trajectory so
        // seed 25 no longer produced a turn whose incumbent decided to skip (end_turn) within 5 laps.
        // Re-pinned 31 -> 10 -> 20 after enabling Abomination (41), then Champion/Frenzied Boar (42/43),
        // shifted roster draws the same way. Re-pinned 20 -> 35 after v0.1 stopped emitting illegal
        // forced-target melees, which changed the fight trajectory while retaining a genuine skip.
        const { decisions, turns } = runObservedMatch(35, 5);

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

    test("reports a deliberately rejected strategy action separately from defend recovery", () => {
        let injectedUnitId: string | undefined;
        const { result, turns } = runObservedMatchWithV01Transform(35, 5, (unit, _context, incumbent) => {
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
        expect(selectedThenAttacked!.strategyActions).toHaveLength(2);
        expect(selectedThenAttacked!.strategyActions[0]).toMatchObject({
            action: { type: "select_attack_type", attackType: PBTypes.AttackVals.MELEE_MAGIC },
            completed: false,
            rejectionReason: "attack_type_not_available",
        });
        expect(selectedThenAttacked!.strategyActions[1]).toMatchObject({
            action: { type: "melee_attack" },
            completed: true,
        });
        expect(selectedThenAttacked!.recoveryAttempts).toEqual([]);
        expect(selectedThenAttacked!.recovery).toEqual({ source: "none", completed: false, events: [] });
        expect(selectedThenAttacked!.events.map((event) => event.type)).toContain("unit_attacked");
        expect(selectedThenAttacked!.events.map((event) => event.type)).toContain("turn_completed");
    });
});
