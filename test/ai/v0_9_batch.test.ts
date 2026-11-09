import { expect, test } from "bun:test";

import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { enumerateV09Candidates, selectV09RankedCandidate } from "../../src/ai/versions/v0_9";
import { v09CandidateFeatureVector, v09DecisionFeatureVectors } from "../../src/ai/versions/v0_9_features";
import {
    scoreV09FixedPoint,
    scoreV09FixedPointBatch,
    validateV09ModelArtifact,
    type IV09ModelArtifact,
} from "../../src/ai/versions/v0_9_model";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { loadNativeV09ScaleResearchModel } from "../../src/simulation/v0_9/native_scale_checkpoint";
import { captureV09NativeTeacherFrame } from "../../src/simulation/v0_9/native_teacher_frame";
import { fuseV09NativeResearchModels } from "../../src/simulation/v0_9/native_fusion";
import { sealV09ResearchArtifact } from "../../src/simulation/v0_9/seal_artifact";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function vectors(model: IV09ModelArtifact, count: number, pattern: number): number[][] {
    return Array.from({ length: count }, (_, row) =>
        model.normalization.offsets.map((offset, column) => {
            // Mix noncontiguous equal columns, tiny raw differences that quantize equally, signed half
            // boundaries and input clipping. Pattern 2 deliberately shares no raw board-state prefix.
            const id = pattern === 0 || (pattern === 1 && (column < 60 || column % 3 === 0)) ? 0 : row;
            const value = ((((id + 3) * (column + 11) * 17) % 257) - 128) / 8;
            const normalized = column % 17 === 0 ? value * 1000 : value;
            return offset + normalized / model.normalization.scales[column]! + (column % 7 === 0 ? row * 1e-12 : 0);
        }),
    );
}

test("batched native scores and guarded selections exactly match scalar scoring for every candidate", () => {
    const model = loadNativeV09ScaleResearchModel();
    const fused = sealV09ResearchArtifact(
        fuseV09NativeResearchModels([model, model], {
            trainingRunId: "9".repeat(64),
            minOverrideMargin: model.minOverrideMargin,
        }).artifact,
    );
    for (const artifact of [model, fused]) {
        expect(validateV09ModelArtifact(artifact)).toEqual([]);
        for (const count of [0, 1, 2, 3, 8, 96]) {
            for (const pattern of [0, 1, 2]) {
                const input = vectors(artifact, count, pattern);
                const scalar = input.map((features) => scoreV09FixedPoint(artifact, features));
                const batched = scoreV09FixedPointBatch(artifact, input);
                expect(batched).toEqual(scalar);
                if (!count) continue;
                for (const margin of [0, 1, 512, 0x7fffffff]) {
                    for (const guard of [0, 1, 2]) {
                        const eligible = batched.map((_, index) => guard === 0 || (guard === 1 && index % 3 === 1));
                        expect(selectV09RankedCandidate(batched, eligible, margin)).toEqual(
                            selectV09RankedCandidate(scalar, eligible, margin),
                        );
                    }
                }
            }
        }
    }
});

test("integer reassociation preserves ReLU, saturation, signed halves and accumulator boundaries", () => {
    const base = loadNativeV09ScaleResearchModel();
    const model: IV09ModelArtifact = {
        ...base,
        normalization: { offsets: Array(166).fill(0), scales: Array(166).fill(1) },
        architecture: { ...base.architecture, hiddenSizes: [4] },
        layers: [
            {
                inputSize: 166,
                outputSize: 4,
                activation: "relu",
                scaleShift: 0,
                weights: Array.from({ length: 166 * 4 }, (_, i) => (i % 3) - 1),
                biases: [50_000, -50_000, 1, -1],
            },
            { inputSize: 4, outputSize: 1, activation: "linear", scaleShift: 1, weights: [2, -3, 4, -5], biases: [1] },
        ],
    };
    expect(validateV09ModelArtifact(model)).toEqual([]);
    const input = vectors(model, 19, 1);
    expect(scoreV09FixedPointBatch(model, input)).toEqual(input.map((row) => scoreV09FixedPoint(model, row)));
    for (const sign of [-1, 1]) {
        const bounded: IV09ModelArtifact = {
            ...model,
            architecture: { ...base.architecture, hiddenSizes: [] },
            layers: [
                {
                    inputSize: 166,
                    outputSize: 1,
                    activation: "linear",
                    scaleShift: 0,
                    weights: [1, -1, ...Array<number>(164).fill(0)],
                    biases: [sign * (0x7fffffff - 65_534)],
                },
            ],
        };
        expect(validateV09ModelArtifact(bounded)).toEqual([]);
        expect(scoreV09FixedPointBatch(bounded, input)).toEqual(input.map((row) => scoreV09FixedPoint(bounded, row)));
        const half = {
            ...bounded,
            layers: [{ ...bounded.layers[0]!, weights: Array<number>(166).fill(0), biases: [sign], scaleShift: 1 }],
        };
        expect(scoreV09FixedPointBatch(half, input)).toEqual(input.map(() => sign));
    }
});

test("batch inference rejects malformed inputs and never retains values between decisions", () => {
    const model = loadNativeV09ScaleResearchModel();
    for (const bad of [NaN, Infinity, -Infinity]) {
        const input = vectors(model, 3, 1);
        input[2]![0] = bad;
        expect(() => scoreV09FixedPointBatch(model, input)).toThrow("not finite");
    }
    const short = vectors(model, 3, 1);
    short[1]!.pop();
    expect(() => scoreV09FixedPointBatch(model, short)).toThrow("expected 166 features");
    const input = vectors(model, 4, 0);
    const before = structuredClone(input);
    const result = scoreV09FixedPointBatch(model, input);
    result.fill(0);
    expect(input).toEqual(before);
    input[1]![65] = 9000;
    expect(scoreV09FixedPointBatch(model, input)).toEqual(input.map((row) => scoreV09FixedPoint(model, row)));
    expect(scoreV09FixedPointBatch(model, before)).toEqual(before.map((row) => scoreV09FixedPoint(model, row)));
});

test("decision feature batches and teacher capture reproduce individual vectors after board changes", () => {
    const combat = createCombatTestContext();
    const melee = createTestUnit({ team: PBTypes.TeamVals.LEFT, name: "Batch Melee" });
    const ranged = createTestUnit({
        team: PBTypes.TeamVals.LEFT,
        name: "Batch Shooter",
        attackType: PBTypes.AttackVals.RANGE,
    });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT, name: "Batch Enemy" });
    placeUnit(combat.grid, combat.unitsHolder, melee, { x: 2, y: 2 });
    placeUnit(combat.grid, combat.unitsHolder, ranged, { x: 3, y: 2 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 8 });
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
    for (const actor of [melee, ranged]) {
        const anchor = new StrategyV0_8().decideTurn(actor, context);
        const candidates = enumerateV09Candidates(actor, context, anchor);
        const individual = candidates.map((candidate) =>
            v09CandidateFeatureVector(candidate, actor, context, candidates),
        );
        const batch = v09DecisionFeatureVectors(candidates, actor, context);
        expect(batch).toEqual(individual);
        expect(captureV09NativeTeacherFrame(actor, context, anchor).features).toEqual(individual);
        if (batch.length > 1) {
            batch[0]![0] = 9000;
            expect(batch[1]![0]).toBe(individual[1]![0]!);
        }
        actor.setAmountAlive(1);
        const changed = candidates.map((candidate) => v09CandidateFeatureVector(candidate, actor, context, candidates));
        expect(v09DecisionFeatureVectors(candidates, actor, context)).toEqual(changed);
    }
    expect(() => v09DecisionFeatureVectors([], melee, { ...context, fightProperties: undefined })).toThrow(
        "fightProperties",
    );
});
