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
        policy: [-0.02377725228923806],
        primary: [0.0011611738149605638],
        valueLogit: -0.00939119203456345,
    },
    {
        policy: [
            -0.023778780416298828, -0.023969064109753562, -0.024330043253526487, -0.024497375791487558,
            -0.023949113617134473, -0.024351427620312067, -0.024281022927110568, -0.024672604388990355,
            -0.02358647649426772, -0.024222176716060084,
        ],
        primary: [
            0.001156901131432193, 0.001994144588636436, 0.001955654346669784, 0.0017445298004319075,
            0.0008399429203285055, 0.002237345792454642, 0.0019254104406635619, 0.0019924433460268448,
            0.0008711661670594288, 0.0018843944645130194,
        ],
        valueLogit: -0.009414084693727726,
    },
    {
        policy: [
            -0.023778976927811626, -0.023969161628291942, -0.024330636746744485, -0.024497533702197604,
            -0.023949247000759323, -0.02435010207611224, -0.024281338579314762, -0.02467356961015013,
            -0.023585706646779656, -0.024222365307396004, -0.02422545517023358, -0.024419811184110733,
            -0.024330042782890825, -0.02430456940772809, -0.024431888429886476,
        ],
        primary: [
            0.0011568858214763488, 0.001994154416027234, 0.0019558807572328998, 0.0017445905292388503,
            0.0008400598027062564, 0.0022370771067464243, 0.0019256272481153972, 0.001995168084441913,
            0.0008698914921760658, 0.0018841224265917717, 0.0020167790605209466, 0.001965934485281164,
            0.000979045345311735, 0.0016584657072783152, 0.002150531109223111,
        ],
        valueLogit: -0.009414408929711366,
    },
    {
        policy: [
            -0.029828366975143055, -0.029505606850322916, -0.029318737765783424, -0.02971838112098325,
            -0.030042747381415644, -0.029454851303757204, -0.02931614761756468, -0.029642198197396188,
            -0.029858337766960293, -0.02970630925434733, -0.029373280070630066, -0.029606494028832864,
        ],
        primary: [
            -0.0032564873455083547, -0.0033374330377187616, -0.0032787808027739535, -0.0035598540382473934,
            -0.0028580332109173815, -0.003289445134408731, -0.003286374752268627, -0.003588505348075238,
            -0.0031708456356648543, -0.0032148109266663363, -0.0033188513453246415, -0.003454715018275512,
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
