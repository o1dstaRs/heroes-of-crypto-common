import { expect, test } from "bun:test";
import { EMPOWER_CONTEXT_FEATURES, predictContextualEmpower } from "../../src/ai/setup/empower_context";
import { protectedAxisEmpowerPlan } from "../../src/ai/setup/empower_protected_axis";
import { inspectContextualEmpowerInput } from "../../src/simulation/empower_context_research";
import { contextualEmpowerExamples, fitContextualEmpower } from "../../src/simulation/empower_context_training";
import type { ContextualEmpowerRow } from "../../src/simulation/empower_context_worker";
import registration from "../../docs/evidence/empower_setup_registration_20261114.json";

function syntheticPairs(): ContextualEmpowerRow[] {
    return registration.banks.train.slice(0, 3).flatMap(([board, seed]) =>
        [0, 1, 2, 3].flatMap((game) => {
            const inspected = inspectContextualEmpowerInput({ board, seed, game, level: 0 });
            return [0, 1].map((requestedLevel) => {
                const level = inspected.features ? requestedLevel : 0;
                return {
                    ...inspected,
                    board,
                    seed,
                    game,
                    requestedLevel,
                    level,
                    plan: protectedAxisEmpowerPlan(inspected.budget, inspected.own, level),
                    baseline: protectedAxisEmpowerPlan(inspected.budget, inspected.own, 0),
                    formationSha256: `${board}:${game}`,
                    traceSha256: level ? "candidate" : "control",
                    score: level ? 1 : 0.5,
                    laps: 1,
                    rejected: 0,
                    elapsedMs: 0,
                    registrationSha256: "test-only-synthetic-outcomes",
                };
            });
        }),
    );
}

test("training averages paired physical seats and rejects missing or mismatched interventions", () => {
    const rows = syntheticPairs();
    const examples = contextualEmpowerExamples(rows);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((row) => row.gain === 0.5)).toBe(true);
    expect(() => contextualEmpowerExamples(rows.slice(1))).toThrow();
    const corrupt = structuredClone(rows);
    corrupt[1].formationSha256 = "different-formation";
    expect(() => contextualEmpowerExamples(corrupt)).toThrow();
    expect(() => contextualEmpowerExamples([...rows, rows[0]])).toThrow();
});

test("the effect forest learns a conditional gain from both input features", () => {
    const features = (a: number, b: number) =>
        EMPOWER_CONTEXT_FEATURES.map((_, i) => (i === 10 ? a : i === 11 ? b : 0));
    const examples = Array.from({ length: 128 }, (_, i) => {
        const a = Number(i % 4 >= 2),
            b = i % 2;
        return {
            board: Math.floor(i / 2),
            seed: i + 1,
            game: i % 2,
            budget: 7,
            map: 1,
            features: features(a, b),
            gain: a && b ? 0.4 : -0.1,
        };
    });
    const model = fitContextualEmpower(
        examples,
        {
            kind: "forest",
            depth: 3,
            minimumLeaf: 12,
            trees: 8,
            featureFraction: 1,
            boardSampleFraction: 0.8,
            leafShrinkage: 0,
            seed: 42,
        },
        0.03,
    );
    expect(predictContextualEmpower(model, features(1, 1))).toBeCloseTo(0.4, 10);
    for (const [a, b] of [
        [0, 0],
        [0, 1],
        [1, 0],
    ])
        expect(predictContextualEmpower(model, features(a, b))).toBeCloseTo(-0.1, 10);
});
