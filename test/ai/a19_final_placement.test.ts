import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { buildPlacementInput, finalizePlacement, type PlacementEnvelope } from "../../src/ai/placement/adapter";
import { chooseCandidate, encode, predict, propose, type PublicInput, type Point } from "../../src/ai/placement/layout";
import { getPlacementModel } from "../../src/ai/placement/model";
import { A19_LEARNED_FINAL_PLACEMENT_V1_POLICY } from "../../src/ai/placement/policy";
import packed from "../../src/ai/models/a19/placement_v1.json";
import fixture from "./fixtures/a19_final_placement.json";

type FrozenCase = { input: PublicInput; baseline: Point[]; positions: Point[]; chosen: number };
const parts = (sample: FrozenCase) => ({
    units: sample.input.bodies.map((b) => ({
        getId: () => b.id,
        getName: () => b.name,
        getAmountAlive: () => b.amount,
        getFootprintWidth: () => b.width,
        getFootprintHeight: () => b.height,
    })),
    context: {
        team: sample.input.left ? 2 : 1,
        gridType: sample.input.map,
        sideOrientedPlacement: true,
        legalCellHashes: new Set(sample.input.legal),
        publicOpponentCreatureIds: sample.input.enemyIds,
        artifacts: [sample.input.artifacts[0], sample.input.artifacts[1]],
        doctrine: sample.input.doctrine,
        augments: sample.input.augments,
    } satisfies PlacementEnvelope,
    incumbent: new Map(sample.input.bodies.map((b, i) => [b.id, sample.baseline[i]])),
});

test("fixed exported tensors and conservative adoption identity stay pinned", () => {
    const hash = createHash("sha256");
    for (const layer of packed.layers) {
        hash.update(Buffer.from(layer.weight, "base64"));
        hash.update(Buffer.from(layer.bias, "base64"));
    }
    expect(hash.digest("hex")).toBe("98832e09c012077cf2167bfd9d82509cf405416d4b0d4ea1c701cb4f406628e2");
    expect(getPlacementModel()).toMatchObject({ id: "free-placement-fit-0", minimumGain: 0.03 });
    expect(packed.exportSha256).toBe(A19_LEARNED_FINAL_PLACEMENT_V1_POLICY.exportSha256);
    expect(A19_LEARNED_FINAL_PLACEMENT_V1_POLICY.registeredStrengthGatePassed).toBe(false);
});

test("max score wins only above the unchanged margin, with first-index ties", () => {
    expect(chooseCandidate([0, 0.1, -0.8, 0.05], 0.03)).toBe(1);
    expect(chooseCandidate([0, 0.03, -1], 0.03)).toBe(0);
    expect(chooseCandidate([0, 0.04, 0.04], 0.03)).toBe(1);
    expect(() => chooseCandidate([0, NaN], 0.03)).toThrow();
});

test("the retained v1 reference reproduces frozen authoritative formations on both sides and all maps", () => {
    for (const sample of fixture.cases) {
        const { units, context, incumbent } = parts(sample);
        const before = JSON.stringify([...incumbent]);
        expect(buildPlacementInput(units, context)).toBeDefined();
        const input = buildPlacementInput(units, context)!;
        const model = getPlacementModel();
        const options = Array.from({ length: 8 }, (_, i) => propose(input, sample.baseline, i));
        const scores = options.map((p) => predict(model, encode(input, p)));
        expect(options[chooseCandidate(scores, model.minimumGain)]).toEqual(sample.positions);
        expect(JSON.stringify([...incumbent])).toBe(before);
    }
});

test("unsupported setup and incomplete armies preserve a detached incumbent", () => {
    const { units, context, incumbent } = parts(fixture.cases[0]);
    for (const replacement of [
        { doctrine: 1 },
        { sideOrientedPlacement: false },
        { publicOpponentCreatureIds: [] },
        {
            augments: [
                { kind: "Placement", value: 2 },
                { kind: "Armor", value: 3 },
                { kind: "Sniper", value: 2 },
            ],
        },
    ]) {
        expect(buildPlacementInput(units, { ...context, ...replacement })).toBeUndefined();
        const result = finalizePlacement(units, { ...context, ...replacement }, incumbent);
        expect(result).toEqual(incumbent);
        expect(result).not.toBe(incumbent);
        expect(result.values().next().value).not.toBe(incumbent.values().next().value);
    }
    expect(finalizePlacement(units.slice(1), context, incumbent)).toEqual(incumbent);
    const partial = new Map(incumbent);
    partial.delete(units[0].getId());
    expect(finalizePlacement(units, context, partial)).toEqual(partial);
});
