import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, spyOn, test } from "bun:test";

import packed from "../../src/ai/models/a19/placement_v2.json";
import { buildPlacementInput, finalizePlacement, type PlacementEnvelope } from "../../src/ai/placement/adapter";
import { chooseCandidate, predict, propose } from "../../src/ai/placement/layout";
import { getPlacementRelationModel } from "../../src/ai/placement/model";
import { A19_LEARNED_FINAL_PLACEMENT_POLICY, V09_LEARNED_FINAL_PLACEMENT_POLICY } from "../../src/ai/placement/policy";
import { relationFeatures } from "../../src/ai/placement/relations";
import * as creatureScore from "../../src/ai/setup/creature_score";
import fixture from "./fixtures/a19_final_placement_v2.json";
import float32Fixture from "./fixtures/a19_final_placement_v2_float32.json";

const featureHash = (features: readonly number[]) => {
    const bytes = Buffer.alloc(features.length * 4);
    features.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    return createHash("sha256").update(bytes).digest("hex");
};

test("v0.9 placement uses the unchanged independently confirmed float32 tensors", () => {
    const hash = createHash("sha256");
    for (const layer of packed.layers) {
        hash.update(Buffer.from(layer.weight, "base64"));
        hash.update(Buffer.from(layer.bias, "base64"));
    }
    expect(hash.digest("hex")).toBe("dc98a555fa6c219d3ecd04095fafea9f53f38a22289eb738f4e7b8a3b62f09c8");
    expect(packed.exportSha256).toBe(fixture.exportSha256);
    expect(getPlacementRelationModel()).toMatchObject({ id: "relations-v2-absolute-256", minimumGain: 0.03 });
    expect(A19_LEARNED_FINAL_PLACEMENT_POLICY).toBe(V09_LEARNED_FINAL_PLACEMENT_POLICY);
    expect(V09_LEARNED_FINAL_PLACEMENT_POLICY.registeredStrengthGatePassed).toBe(true);
    expect(V09_LEARNED_FINAL_PLACEMENT_POLICY.confirmationRegistrationSha256).toBe(fixture.registrationSha256);
});

test("margin and ties are evaluated against the deployed reference, which need not be option zero", () => {
    expect(chooseCandidate([0.2, 0, 0.19], 0.03, 2)).toBe(2);
    expect(chooseCandidate([0.2, 0, 0.15], 0.03, 2)).toBe(0);
    expect(chooseCandidate([0.2, 0.2, 0.15], 0.03, 2)).toBe(0);
    expect(chooseCandidate([0.03, 0, -1], 0.03, 1)).toBe(1);
    expect(() => chooseCandidate([0, 1], 0.03, 2)).toThrow();
    expect(() => chooseCandidate([0, NaN], 0.03, 0)).toThrow();
});

test("frozen fresh-bank inputs reproduce all features, scores and applied choices", () => {
    const model = getPlacementRelationModel();
    expect(
        createHash("sha256")
            .update(readFileSync(new URL("./fixtures/a19_final_placement_v2.json", import.meta.url)))
            .digest("hex"),
    ).toBe(float32Fixture.sourceFixtureSha256);
    expect(float32Fixture.cases.map((sample) => sample.family)).toEqual(fixture.cases.map((sample) => sample.family));
    expect(new Set(fixture.cases.map((c) => c.input.map))).toEqual(new Set([1, 3, 4]));
    expect(new Set(fixture.cases.map((c) => c.input.left))).toEqual(new Set([true, false]));
    for (const [index, sample] of fixture.cases.entries()) {
        const options = Array.from({ length: 8 }, (_, i) => propose(sample.input, sample.baseline, i));
        expect(options[sample.reference]).toEqual(sample.referencePositions);
        const features = options.map((p) => relationFeatures(sample.input, p, options[sample.reference]));
        // Math.log1p can differ by one binary64 ULP across hosts. Keep exact training-precision fingerprints.
        expect(features.map(featureHash)).toEqual(float32Fixture.cases[index].featureSha256);
        const scores = features.map((x) => predict(model, x));
        for (const [candidate, score] of scores.entries()) expect(score).toBeCloseTo(sample.scores[candidate], 14);
        expect(chooseCandidate(scores, model.minimumGain, sample.reference)).toBe(sample.chosen);
        expect(options[sample.chosen]).toEqual(sample.positions);
    }
});

test("the serving adapter applies the confirmed choice without modifying inputs or retaining match state", () => {
    for (const sample of [...fixture.cases, ...[...fixture.cases].reverse()]) {
        const units = sample.input.bodies.map((b) => ({
            getId: () => b.id,
            getName: () => b.name,
            getAmountAlive: () => b.amount,
            getFootprintWidth: () => b.width,
            getFootprintHeight: () => b.height,
        }));
        const context: PlacementEnvelope = {
            team: sample.input.left ? 2 : 1,
            gridType: sample.input.map,
            sideOrientedPlacement: true,
            legalCellHashes: new Set(sample.input.legal),
            publicOpponentCreatureIds: sample.input.enemyIds,
            artifacts: [sample.input.artifacts[0], sample.input.artifacts[1]],
            doctrine: sample.input.doctrine,
            augments: sample.input.augments,
        };
        const incumbent = new Map(sample.input.bodies.map((b, i) => [b.id, { ...sample.baseline[i] }]));
        const before = JSON.stringify([...incumbent]);
        // Confirmation fixtures use their recorded HP independently of later live balance changes.
        const recordedHp = new Map(sample.input.bodies.map((b) => [b.creature, b.hp]));
        const readCreatureInfo = creatureScore.creatureInfo;
        const catalog = spyOn(creatureScore, "creatureInfo").mockImplementation((id) => {
            const info = readCreatureInfo(id);
            const hp = recordedHp.get(id);
            return info && hp !== undefined ? { ...info, hp } : info;
        });
        try {
            expect(buildPlacementInput(units, context)).toEqual(sample.input);
            const selected = finalizePlacement(units, context, incumbent);
            expect(units.map((u) => selected.get(u.getId()))).toEqual(sample.positions);
            expect(JSON.stringify([...incumbent])).toBe(before);
            for (const [id, anchor] of selected) expect(anchor).not.toBe(incumbent.get(id));
        } finally {
            catalog.mockRestore();
        }
    }
});
