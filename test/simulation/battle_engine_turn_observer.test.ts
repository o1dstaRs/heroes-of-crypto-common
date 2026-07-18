import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch, type ITurnExecutionObservation } from "../../src/simulation/battle_engine";

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

describe("battle engine turn execution observer", () => {
    test("emits exactly once per decision with detached actions and explicit skip events", () => {
        // Seed re-pinned 25 -> 31 after the attack_handler engine change shifted the seeded trajectory so
        // seed 25 no longer produced a turn whose incumbent decided to skip (end_turn) within 5 laps. 31
        // reproduces that exact skip scenario.
        const { decisions, turns } = runObservedMatch(31, 5);

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

    test("reports a rejected strategy action separately from the recovery shield", () => {
        // Seed re-pinned from 1603 -> 952 after the lap-start morale-roll fix (applyMoraleRolls now reads
        // true accumulated morale, not the stale ±20 lock) shifted the seeded trajectory so 1603 no longer
        // produced a rejected-melee -> defend-recovery turn. 952 reproduces the exact scenario.
        const { decisions, turns } = runObservedMatch(952, 40);

        expect(turns).toHaveLength(decisions.length);
        const recovered = turns.find((turn) => turn.recovery.source === "defend");
        expect(recovered).toBeDefined();
        expect(recovered!.strategyActions).toHaveLength(1);
        expect(recovered!.strategyActions[0]).toMatchObject({
            action: { type: "melee_attack" },
            completed: false,
            rejectionReason: "attack_not_available",
        });
        expect(recovered!.recovery).toMatchObject({
            source: "defend",
            completed: true,
            action: { type: "defend_turn" },
        });
        expect(recovered!.recoveryAttempts).toEqual([recovered!.recovery]);
        expect(
            recovered!.recovery.events.some(
                (event) => event.type === "unit_defended" && event.unitId === recovered!.unitId,
            ),
        ).toBe(true);
        expect(recovered!.events.map((event) => event.type)).toEqual(["unit_defended", "turn_completed"]);
    });
});
