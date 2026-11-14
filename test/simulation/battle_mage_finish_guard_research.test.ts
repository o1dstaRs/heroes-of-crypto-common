import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    preservePredictedFinishes,
    PROTECTED_EFFECTS,
    lockedBattleMageMonotoneBytes,
    lockedBattleMageFinishGuardCheckpoint,
    chooseBattleMageFinishGuardResearchCast,
    BATTLE_MAGE_MONOTONE_MODEL_SHA256,
} from "../../src/simulation/battle_mage_finish_guard_research";
import references from "./fixtures/battle_mage_finish_guard_20261114.json";

const names = ["hpRemoved", ...PROTECTED_EFFECTS];
const row = (hp: number, effects: number[]) => ({ features: [hp, ...effects] });

describe("public-effect finish guard", () => {
    test.each(PROTECTED_EFFECTS)("more HP cannot buy away %s", (feature) => {
        const baseline = [0, 0, 0, 0],
            chosen = [0, 0, 0, 0];
        baseline[PROTECTED_EFFECTS.indexOf(feature)] = 1;
        const decision = preservePredictedFinishes(names, [row(1, baseline), row(1000, chosen)], 1);
        expect(decision.choice).toBe(0);
        expect(decision.blockedBy).toEqual([feature]);
    });

    test("retains the proposal when all protected effects are preserved", () => {
        const decision = preservePredictedFinishes(names, [row(1, [1, 1, 0, 0]), row(10, [1, 1, 1, 0])], 1);
        expect(decision).toEqual({ choice: 1, proposedChoice: 1, valid: true, blockedBy: [] });
    });

    test("does not substitute a different alternative after rejecting the learned choice", () => {
        const candidates = [row(1, [1, 1, 0, 0]), row(100, [0, 0, 0, 0]), row(200, [2, 2, 0, 0])];
        expect(preservePredictedFinishes(names, candidates, 1).choice).toBe(0);
        expect(preservePredictedFinishes(names, candidates, 0).choice).toBe(0);
    });

    test("missing, malformed or ambiguous schemas retain the original action", () => {
        const candidates = [row(1, [1, 1, 0, 0]), row(2, [1, 1, 0, 0])];
        for (const proposal of [-1, 2, 0.5, Number.NaN])
            expect(preservePredictedFinishes(names, candidates, proposal).valid).toBe(false);
        expect(preservePredictedFinishes(names.slice(1), candidates, 1).valid).toBe(false);
        expect(preservePredictedFinishes([...names, names[0]], candidates, 1).valid).toBe(false);
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])
            expect(preservePredictedFinishes(names, [candidates[0], row(100, [bad, 1, 0, 0])], 1).choice).toBe(0);
    });

    test("does not mutate the candidates or pretend to preserve target identities", () => {
        const candidates = Object.freeze([
            Object.freeze({ features: Object.freeze([1, 1, 1, 0, 0]) }),
            Object.freeze({ features: Object.freeze([2, 1, 1, 0, 0]) }),
        ]);
        const before = JSON.stringify(candidates);
        expect(preservePredictedFinishes(names, candidates, 1).choice).toBe(1);
        expect(JSON.stringify(candidates)).toBe(before);
    });
});

test("saved bytes and metadata preserve the failed independent gate and separate posthoc guard", () => {
    const bytes = lockedBattleMageMonotoneBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(BATTLE_MAGE_MONOTONE_MODEL_SHA256);
    bytes.fill(0);
    expect(createHash("sha256").update(lockedBattleMageMonotoneBytes()).digest("hex")).toBe(
        BATTLE_MAGE_MONOTONE_MODEL_SHA256,
    );
    const checkpoint = lockedBattleMageFinishGuardCheckpoint();
    expect(checkpoint.originalConfirmation.games).toBe(5184);
    expect(checkpoint.originalConfirmation.families).toBe(864);
    expect(checkpoint.originalConfirmation.gate).toBe(false);
    expect(checkpoint.guardDiscovery.newIndependentGames).toBe(0);
    expect(checkpoint.guardDiscovery.freshGateEvaluated).toBe(false);
    expect(checkpoint.productionActivation).toBe(false);
    checkpoint.productionActivation = true;
    expect(lockedBattleMageFinishGuardCheckpoint().productionActivation).toBe(false);
});

test("frozen learned choices and finish guards reproduce stored numerical references", () => {
    for (const reference of references)
        expect(chooseBattleMageFinishGuardResearchCast(reference.candidates)).toEqual(reference.expected);
});

test("invalid learned inputs retain A19 instead of manufacturing a new choice", () => {
    expect(chooseBattleMageFinishGuardResearchCast([]).valid).toBe(false);
    const candidates = structuredClone(references[0].candidates);
    candidates[1].features[0] = Number.NaN;
    expect(chooseBattleMageFinishGuardResearchCast(candidates)).toEqual({
        choice: 0,
        proposedChoice: 0,
        valid: false,
        blockedBy: ["invalid-input"],
    });
});
