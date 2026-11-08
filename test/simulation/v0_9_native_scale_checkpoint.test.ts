import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { DEFAULT_AI_VERSION } from "../../src/ai";
import { V09_MODEL_ARTIFACT } from "../../src/ai/versions/v0_9_artifact";
import { scoreV09FixedPoint } from "../../src/ai/versions/v0_9_model";
import {
    loadNativeV09ScaleResearchModel,
    nativeV09ScaleCheckpoint,
    nativeV09ScaleCheckpointBytes,
    nativeV09ScaleNumericalReferences,
    NATIVE_V09_SCALE_MODEL_SHA256,
} from "../../src/simulation/v0_9/native_scale_checkpoint";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

test("native scale reference preserves original model bytes and stays separate from the live defaults", () => {
    const checkpoint = nativeV09ScaleCheckpoint();
    const bytes = nativeV09ScaleCheckpointBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checkpoint.sourceArtifactRawSha256);
    const model = loadNativeV09ScaleResearchModel();
    expect(model.modelSha256).toBe(NATIVE_V09_SCALE_MODEL_SHA256);
    expect(model.status).toBe("trained");
    expect(model.promoted).toBe(false);
    expect(model.qualification).toBeNull();
    expect(model.architecture.hiddenSizes).toEqual([96, 48]);
    expect(model.layers.reduce((sum, layer) => sum + layer.weights.length, 0)).toBe(20_592);
    expect(DEFAULT_AI_VERSION).toBe("v0.8");
    expect(V09_MODEL_ARTIFACT.status).toBe("anchor_only");
    expect(V09_MODEL_ARTIFACT.promoted).toBe(false);
    expect(checkpoint.result.stockA19ScoreTargetPassed).toBe(false);
    expect(checkpoint.productionTimingQualified).toBe(false);
    expect(checkpoint.productionActivation).toBe(false);
});

test("every checkpoint load and byte export is independent", () => {
    const model = loadNativeV09ScaleResearchModel();
    const originalWeight = model.layers[0]!.weights[0];
    (model.layers[0]!.weights as number[])[0] = 127;
    expect(loadNativeV09ScaleResearchModel().layers[0]!.weights[0]).toBe(originalWeight);
    const bytes = nativeV09ScaleCheckpointBytes();
    bytes.fill(0);
    expect(nativeV09ScaleCheckpointBytes()[0]).toBe("{".charCodeAt(0));
    const checkpoint = nativeV09ScaleCheckpoint();
    checkpoint.result.score = 1;
    expect(nativeV09ScaleCheckpoint().result.score).toBeLessThan(0.52);
});

test("compact evidence reconstructs all 12096 battles and keeps every native reserved bank excluded", () => {
    const checkpoint = nativeV09ScaleCheckpoint();
    const evidence = JSON.parse(
        readFileSync(new URL("../../docs/evidence/v0_9_native_scale_20261108.json", import.meta.url), "utf8"),
    ) as {
        boards: number[][];
        additionalReservedBaseSeeds: number[];
        result: { meanDecisionCostRatio: number; totalNativeDecisionTimeRatio: number };
    };
    expect(fingerprintV09(evidence)).toBe(checkpoint.evidenceSha256);
    expect(evidence.boards).toHaveLength(1512);
    const reserved = new Set(evidence.additionalReservedBaseSeeds);
    expect(reserved.size).toBe(evidence.additionalReservedBaseSeeds.length);
    const candidate = [0, 0, 0];
    const reference = [0, 0, 0];
    for (const row of evidence.boards) {
        expect(row).toHaveLength(10);
        expect(reserved.has(row[0]!)).toBe(true);
        expect([1, 3, 4]).toContain(row[1]!);
        for (const score of row.slice(2, 6)) {
            expect([0, 1, 2]).toContain(score);
            candidate[score]! += 1;
        }
        for (const score of row.slice(6, 10)) {
            expect([0, 1, 2]).toContain(score);
            reference[score]! += 1;
        }
    }
    expect(candidate).toEqual([4452, 64, 1532]);
    expect(reference).toEqual([4526, 61, 1461]);
    expect((candidate[2]! + candidate[1]! / 2) / 6048).toBe(checkpoint.result.score);
    expect((reference[2]! + reference[1]! / 2) / 6048).toBe(checkpoint.result.referenceScore);
    expect(((candidate[2]! - reference[2]!) * 2 + candidate[1]! - reference[1]!) / 12096).toBe(
        checkpoint.result.pairedGain,
    );
    expect(checkpoint.result.pairedGain95[0]).toBeGreaterThan(0);
    expect(checkpoint.result.independentPairedGain95[0]).toBeGreaterThan(0);
    expect(evidence.result.meanDecisionCostRatio).toBeLessThan(1.1);
    expect(evidence.result.totalNativeDecisionTimeRatio).toBeLessThan(1.1);
});

test("the fixed native weights reproduce signed, clipped and patterned numerical references", () => {
    const model = loadNativeV09ScaleResearchModel();
    for (const reference of nativeV09ScaleNumericalReferences()) {
        const recipe = reference as { kind: string; value?: number; seed?: number; expectedScore: number };
        const raw = model.normalization.offsets.map((offset, index) => {
            const normalized =
                recipe.kind === "constant"
                    ? recipe.value!
                    : recipe.kind === "alternating"
                      ? index % 2
                          ? -recipe.value!
                          : recipe.value!
                      : ((((index + 3) * (recipe.seed! + 11) * 17) % 129) - 64) / 8;
            return offset + normalized / model.normalization.scales[index]!;
        });
        const score = scoreV09FixedPoint(model, raw);
        expect(score === 0 ? 0 : score).toBe(recipe.expectedScore === 0 ? 0 : recipe.expectedScore);
    }
});
