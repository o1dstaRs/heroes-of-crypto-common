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
        policy: [-0.023790627009002304],
        primary: [0.0012005769122964626],
        valueLogit: -0.00939119203456345,
    },
    {
        policy: [
            -0.02379215513606309, -0.02398857639539216, -0.02442509251885326, -0.024489237599144162,
            -0.023949113617134473, -0.024407140625935485, -0.02431728015562715, -0.024630559720012206,
            -0.02358136417970638, -0.024232585825888425,
        ],
        primary: [
            0.0011963042287680924, 0.0020872416222594047, 0.0019381954593563045, 0.0017432326980604063,
            0.0008399429203285055, 0.0023085612566991257, 0.0019231963785182175, 0.0020261507800391986,
            0.0008600419186174878, 0.001994936649732609,
        ],
        valueLogit: -0.009414084693727726,
    },
    {
        policy: [
            -0.02379235164757587, -0.023988692356559267, -0.024425556224668597, -0.024489362407686118,
            -0.023949247000759323, -0.024405602755157695, -0.024317827973831075, -0.024633252247770368,
            -0.02358059433221831, -0.02423276691596031, -0.02425618949833512, -0.024359869154804828,
            -0.024287557552786356, -0.024279160011998528, -0.024384391649489037,
        ],
        primary: [
            0.0011962889188122485, 0.002087357087682849, 0.0019382630797549348, 0.0017433427968874438,
            0.0008400598027062564, 0.002308176760246184, 0.001923416174007124, 0.0020300636811329915,
            0.0008587672437341256, 0.0019946989158339374, 0.0020713694669835334, 0.0018655055203957304,
            0.0009710878928716125, 0.001785410569367614, 0.002230832447235708,
        ],
        valueLogit: -0.009414408929711366,
    },
    {
        policy: [
            -0.02984675713963623, -0.029493953357910854, -0.02930413821891349, -0.02966510464714379,
            -0.029994480990127543, -0.029454851303757204, -0.029255381937497025, -0.029669791371402368,
            -0.029868581156761994, -0.029711923487030112, -0.02938694181750728, -0.029634849450473268,
        ],
        primary: [
            -0.003303824756929284, -0.0033359264717968207, -0.0033205050390466774, -0.0035594380780472165,
            -0.00285928639983371, -0.003289445134408731, -0.0033300834828141716, -0.0035354868473889264,
            -0.0031435023871892952, -0.0032146587624246274, -0.0033295001049027154, -0.003440777844588763,
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
