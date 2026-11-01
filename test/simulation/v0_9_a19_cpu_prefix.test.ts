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

// Recorded from the original unfactored CPU implementation before this optimization.
const golden = [
    {
        policy: [-0.02378597454046164],
        primary: [0.001052038814690074],
        valueLogit: -0.00939119203456345,
    },
    {
        policy: [
            -0.023787285269107748, -0.024005059692948007, -0.024401121399855605, -0.024376146574374733,
            -0.023855406024722883, -0.024356772968738078, -0.024235901904809707, -0.024467841935064717,
            -0.023590311649671236, -0.024179662572666412,
        ],
        primary: [
            0.0010479158990356046, 0.0019224553692270363, 0.0019131079939302025, 0.001740639714121826,
            0.0008171261905667517, 0.0021940617648062567, 0.001909306235456552, 0.0019572760566059547,
            0.0008033239834018233, 0.0017707985005880012,
        ],
        valueLogit: -0.009414084693727726,
    },
    {
        policy: [
            -0.023787470906350267, -0.024005144827524836, -0.024401683335504486, -0.024376411925657038,
            -0.023855544460188387, -0.024356339502568356, -0.024236236629818497, -0.02447145888647606,
            -0.023590657540221063, -0.0241798117831781, -0.02435238594601181, -0.0243997684385101, -0.02416927759470089,
            -0.024309102919890104, -0.024504012196012066,
        ],
        primary: [
            0.0010479425369961392, 0.0019225428817650268, 0.001913209152169653, 0.0017406570814081815,
            0.0008173592876497231, 0.0021923246971913314, 0.0019094831035035102, 0.001957768835552905,
            0.0008023894406578514, 0.0017705823603047133, 0.0020419444001132984, 0.00199379350114595,
            0.0009094391523729835, 0.0015655124779316086, 0.002170203121929036,
        ],
        valueLogit: -0.009414408929711366,
    },
    {
        policy: [
            -0.029946829046071946, -0.029519889211486322, -0.0292487477001129, -0.029682719888647877,
            -0.030214486941537774, -0.029550395306993958, -0.029341380186722332, -0.02969588736008002,
            -0.029822733329946047, -0.029811631842355586, -0.029404887424516038, -0.02948367751884227,
        ],
        primary: [
            -0.0032824261662609045, -0.0033059671028060717, -0.0031247933688133586, -0.0037218012243562283,
            -0.002873045777865106, -0.0033712444993587334, -0.0032065297247481283, -0.0036173082555441332,
            -0.003297024921036033, -0.0032386852420483465, -0.0032807829967050925, -0.0034563105055638284,
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
