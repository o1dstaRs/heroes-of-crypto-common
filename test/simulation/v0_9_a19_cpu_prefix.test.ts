import { expect, test } from "bun:test";
import { V09A19CpuModel } from "../../src/simulation/v0_9/a19_inference";
import {
    V09_A19_OBSERVATION_CONTRACT as contract,
    V09_A19_OBSERVATION_SHA256,
    type IV09A19Observation,
} from "../../src/simulation/v0_9/a19_observation";

const identity = { manifestSha256: "a".repeat(64), sourceSha256: "b".repeat(64) };
function model(seed: number): V09A19CpuModel {
    const weights: Record<string, number[] | number[][]> = {};
    const layers: [string, number, number][] = [
        ["entity.0", contract.entities.length, 96],
        ["entity.2", 96, 96],
        ["terrain.0", 1280, 64],
        ["context.0", 96 * 5 + contract.globals.length + 64, 128],
        ["candidate.0", 128 + 96 + contract.candidates.length, 128],
        ["candidate.2", 128, 64],
        ["policy", 64, 1],
        ["primary", 64, 1],
        ["value.0", 128, 64],
        ["value.2", 64, 1],
    ];
    for (const [layer, [name, input, output]] of layers.entries()) {
        weights[`${name}.weight`] = Array.from({ length: output }, (_, row) =>
            Array.from(
                { length: input },
                (_, column) => (((row * 73 + column * 29 + seed * 19 + layer * 31) % 257) - 128) / 4096,
            ),
        );
        weights[`${name}.bias`] = Array.from(
            { length: output },
            (_, row) => (((row * 11 + seed * 7 + layer * 13) % 31) - 15) / 512,
        );
    }
    return new V09A19CpuModel(
        {
            schema: "hoc.ai.v0_9_a19_proposal_float.v2",
            promoted: false,
            ...identity,
            observationSha256: V09_A19_OBSERVATION_SHA256,
            weights,
        },
        identity,
    );
}
function observation(entities: number, candidates: number, phase = 0): IV09A19Observation {
    return {
        schema: contract.schema,
        contractSha256: V09_A19_OBSERVATION_SHA256,
        globals: contract.globals.map((_, i) => ((i * 13 + phase * 7) % 23) / 17),
        entities: Array.from({ length: entities }, (_, row) =>
            contract.entities.map((_, column) =>
                column === 0 ? Number(row % 2 === 0) : (((row * 17 + column * 11 + phase) % 37) - 12) / 31,
            ),
        ),
        entityIds: Array.from({ length: entities }, (_, i) => `unit-${i}`),
        actorIndex: 0,
        terrain: Array.from({ length: 256 }, (_, i) => (i + phase) % 5),
        candidates: Array.from({ length: candidates }, (_, i) => ({
            signature: `action-${i}`,
            targetIndex: i % 3 === 0 ? -1 : i % entities,
            features: contract.candidates.map((_, column) => (((i * 7 + column * 3 + phase * 11) % 29) - 14) / 19),
        })),
    };
}

// Recorded from the original unfactored CPU implementation (9491e45b^) with the current spell vocabulary.
const golden = [
    {
        policy: [-0.023780550113136036],
        primary: [0.001227878437640623],
        valueLogit: -0.00939119203456345,
    },
    {
        policy: [
            -0.023781598155416236, -0.02398756624688029, -0.024411875263429115, -0.024314206479355026,
            -0.02392828954796433, -0.024354945975194536, -0.024213119531788927, -0.024444311607877987,
            -0.023608613999331323, -0.024217081427100932,
        ],
        primary: [
            0.001224943380813916, 0.0019281452441977116, 0.001836607074943683, 0.001757122986646248,
            0.0008787042175707247, 0.002198982127789505, 0.0018635647587688172, 0.0020748188249872465,
            0.0008603687480914198, 0.0018567219204916477,
        ],
        valueLogit: -0.009414084693727726,
    },
    {
        policy: [
            -0.023781803906805125, -0.02398760771884376, -0.024412425099573188, -0.02431443192334942,
            -0.023928450967384628, -0.024353683980146344, -0.024213422771480426, -0.024446180094305922,
            -0.02360976075245698, -0.024217250434329488, -0.02430815318086949, -0.02447022539764611,
            -0.024323338828441135, -0.024296680995790486, -0.024502614074827157,
        ],
        primary: [
            0.0012249181100816746, 0.0019281468584275907, 0.0018367004770479267, 0.0017571792699945295,
            0.0008788255897008742, 0.0021986418313729096, 0.0018637395041808857, 0.0020756420678959848,
            0.0008609345700781328, 0.0018564814713322986, 0.001995405754802855, 0.00201494768948874,
            0.0009119535950062701, 0.0016214350017435199, 0.002135101636525509,
        ],
        valueLogit: -0.009414408929711366,
    },
    {
        policy: [
            -0.02979734531336773, -0.029427761044996774, -0.029283899564223337, -0.029672882327007596,
            -0.03006978173904877, -0.029421890705312027, -0.029299423506881757, -0.029675968938928043,
            -0.02977650875316407, -0.029602555541489127, -0.029374515863206035, -0.029462798261778587,
        ],
        primary: [
            -0.0033213964741196766, -0.0033739238895869983, -0.0031722358297985235, -0.0036473756258557513,
            -0.003008291110743692, -0.003381568945198021, -0.0032321929469178697, -0.003557076465519077,
            -0.003257774219787311, -0.003304879551832716, -0.0032812911285966416, -0.003420285992895504,
        ],
        valueLogit: -0.013451138357898967,
    },
];

test("candidate prefix reuse preserves complete unfactored predictions exactly", () => {
    const predictor = model(7);
    for (const [index, [entities, candidates]] of [
        [1, 1],
        [5, 10],
        [8, 15],
    ].entries())
        expect(predictor.predict(observation(entities, candidates))).toEqual(golden[index]);
});

test("repeated targets and candidate permutations preserve each policy and primary value", () => {
    const predictor = model(7),
        input = observation(5, 10),
        original = structuredClone(input);
    const reversed = predictor.predict({ ...input, candidates: [...input.candidates].reverse() });
    expect({
        policy: reversed.policy.reverse(),
        primary: reversed.primary.reverse(),
        valueLogit: reversed.valueLogit,
    }).toEqual(golden[1]);
    expect(input).toEqual(original);
});

test("prefix caches cannot leak across observations or independently initialized models", () => {
    const first = model(7),
        second = model(11),
        alternate = observation(6, 12, 2);
    first.predict(observation(8, 15));
    expect(second.predict(alternate)).toEqual(golden[3]);
    first.predict(alternate);
    expect(first.predict(observation(5, 10))).toEqual(golden[1]);
    expect(second.predict(alternate)).toEqual(golden[3]);
});

test("candidate validation still rejects malformed targets and non-finite feature values", () => {
    const predictor = model(7),
        input = observation(5, 10);
    expect(() => predictor.predict({ ...input, candidates: [{ ...input.candidates[0], targetIndex: -2 }] })).toThrow();
    const bad = structuredClone(input);
    bad.candidates[0].features[0] = NaN;
    expect(() => predictor.predict(bad)).toThrow();
});
