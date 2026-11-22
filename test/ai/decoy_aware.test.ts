import { afterEach, describe, expect, test } from "bun:test";

import {
    a19DecoyAwareEnabled,
    isOneModelDecoy,
    strikesOneModelDecoy,
    strikesRealStack,
} from "../../src/ai/decoy_aware";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import type { GameAction } from "../../src/engine/actions";

const unit = (id: string, team: number, name: string, amount: number, dead = false) => ({
    getId: () => id,
    getTeam: () => team,
    getName: () => name,
    getAmountAlive: () => amount,
    isDead: () => dead,
});
const context = (units: ReturnType<typeof unit>[]): IDecisionContext =>
    ({ unitsHolder: { getAllUnits: () => new Map(units.map((u) => [u.getId(), u])) } }) as unknown as IDecisionContext;
const strike = (targetId: string): GameAction[] =>
    [{ type: "melee_attack", attackerId: "a", targetId, attackFrom: { x: 0, y: 0 } }] as unknown as GameAction[];

describe("a19-decoy-aware-v1", () => {
    const saved = { left: process.env.A19_DECOY_AWARE_LEFT, right: process.env.A19_DECOY_AWARE_RIGHT };
    afterEach(() => {
        for (const [name, value] of [
            ["A19_DECOY_AWARE_LEFT", saved.left],
            ["A19_DECOY_AWARE_RIGHT", saved.right],
        ] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    test("the owner's wall: a one-creature Fairy split is a decoy while the big Fairy stack lives", () => {
        const ctx = context([unit("big", 2, "Fairy", 134), unit("d1", 2, "Fairy", 1), unit("elf", 2, "Elf", 26)]);
        expect(isOneModelDecoy(ctx, "d1")).toBe(true);
        expect(isOneModelDecoy(ctx, "big")).toBe(false);
        expect(isOneModelDecoy(ctx, "elf")).toBe(false);
        expect(strikesOneModelDecoy(ctx, strike("d1"))).toBe(true);
        expect(strikesRealStack(ctx, strike("elf"))).toBe(true);
    });

    test("a lone one-creature stack without a bigger sibling is a real target", () => {
        const ctx = context([
            unit("angel", 2, "Angel", 1),
            unit("big", 2, "Fairy", 0, true),
            unit("d1", 2, "Fairy", 1),
        ]);
        expect(isOneModelDecoy(ctx, "angel")).toBe(false);
        // The big stack is dead, so the last Fairy is no longer a decoy.
        expect(isOneModelDecoy(ctx, "d1")).toBe(false);
    });

    test("per-seat switch: on unless 0", () => {
        delete process.env.A19_DECOY_AWARE_LEFT;
        delete process.env.A19_DECOY_AWARE_RIGHT;
        expect(a19DecoyAwareEnabled(1)).toBe(true);
        process.env.A19_DECOY_AWARE_LEFT = "0";
        expect(a19DecoyAwareEnabled(2)).toBe(false);
        expect(a19DecoyAwareEnabled(1)).toBe(true);
    });
});
