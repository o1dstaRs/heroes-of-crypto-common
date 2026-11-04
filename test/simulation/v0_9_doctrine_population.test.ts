import { expect, test } from "bun:test";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { GREEN_TEAM, type IMatchConfig } from "../../src/simulation/battle_engine";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import {
    assertV09DoctrineSetup,
    v09DoctrineBoard,
    v09DoctrineBoardCount,
} from "../../src/simulation/v0_9/a19_doctrine_population";
import {
    buildV09A19PilotManifest,
    validateV09A19PilotManifest,
    v09DoctrineStatistics,
} from "../../src/simulation/v0_9/a19_pilot_protocol";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

const population = "balanced-doctrines-v1" as const;

test("every complete population covers all map/doctrine pairs equally, with exact A/A controls", () => {
    const cells = new Set<string>();
    for (let board = 0; board < 27; board++) {
        const cell = v09DoctrineBoard(board, population);
        cells.add(JSON.stringify([board % 3, cell]));
        const control = v09DoctrineBoard(board, population, true);
        expect(control.opponentDoctrinePolicy).toBe(control.candidateDoctrinePolicy);
        expect(v09DoctrineBoard(board)).toEqual({
            candidateDoctrinePolicy: "see-none",
            opponentDoctrinePolicy: "see-none",
        });
    }
    expect(cells.size).toBe(27);
    expect(v09DoctrineBoardCount(510, population)).toBe(513);
    expect(v09DoctrineBoardCount(96, population)).toBe(108);
    expect(v09DoctrineBoardCount(1500, population)).toBe(1512);
    expect(v09DoctrineBoardCount(192)).toBe(192);
    expect(() => v09DoctrineBoard(-1, population)).toThrow();
});

test("the manifest binds the population and reserves enough independent seed channels", () => {
    const legacy = buildV09A19PilotManifest({
        source: { files: {}, sha256: fingerprintV09({}) },
        profile: {
            revision: "fixture",
            draft: "fixture",
            setup: "fixture",
            environment: buildV08A19SearchEnvironment(),
            overrides: {},
            sourceSha256: {},
        },
        seed: 2026110409,
        sourceCommit: "a".repeat(40),
        runtime: Bun.version,
        protectedV08Roots: ["/protected-v08"],
        teacherPreset: "precise-r8",
    });
    expect(Object.hasOwn(legacy, "doctrinePopulation")).toBe(false);
    const mixed = buildV09A19PilotManifest({ ...legacy, doctrinePopulation: population });
    expect(mixed.manifestSha256).not.toBe(legacy.manifestSha256);
    expect(() => validateV09A19PilotManifest(JSON.parse(JSON.stringify(mixed)))).not.toThrow();
    const channels = Object.values(mixed.stages)
        .flat()
        .flatMap((seed) => [seed, seed + 1, seed + 2]);
    expect(new Set(channels).size).toBe(channels.length);
    for (const seeds of Object.values(mixed.stages)) expect(seeds.length % 27).toBe(0);
    const { manifestSha256: _hash, ...changed } = { ...mixed, doctrinePopulation: undefined };
    expect(() => validateV09A19PilotManifest({ ...changed, manifestSha256: fingerprintV09(changed) })).toThrow();
});

test("the actual engine setup must use the scheduled doctrine and all of its points in either battle seat", () => {
    const config = {
        searchEnvOverrideTeams: [GREEN_TEAM],
        greenDoctrine: Doctrine.THREE_REVEALS,
        redDoctrine: Doctrine.SEE_ALL,
        greenAugments: [
            { kind: "Might", value: 3 },
            { kind: "Armor", value: 3 },
        ],
        redAugments: [
            { kind: "Might", value: 3 },
            { kind: "Armor", value: 2 },
        ],
    } as IMatchConfig;
    expect(() => assertV09DoctrineSetup(config, 3)).not.toThrow();
    expect(() => assertV09DoctrineSetup({ ...config, redDoctrine: Doctrine.SEE_NONE }, 3)).toThrow();
    expect(() => assertV09DoctrineSetup({ ...config, greenAugments: config.redAugments }, 3)).toThrow();
    expect(() =>
        assertV09DoctrineSetup(
            {
                ...config,
                searchEnvOverrideTeams: [GREEN_TEAM === 1 ? 2 : 1],
                greenDoctrine: config.redDoctrine,
                redDoctrine: config.greenDoctrine,
                greenAugments: config.redAugments,
                redAugments: config.greenAugments,
            },
            3,
        ),
    ).not.toThrow();
});

test("doctrine reporting cannot hide a weak five-point cohort behind a stronger seven-point cohort", () => {
    const scores = Array.from({ length: 54 }, (_, board) => [0.25, 0.5, 0.75][Math.floor(board / 3) % 3]);
    const stats = v09DoctrineStatistics(scores, 1);
    expect(stats["see-all"].score).toBe(0.25);
    expect(stats["three-reveals"].score).toBe(0.5);
    expect(stats["see-none"].score).toBe(0.75);
    for (const value of Object.values(stats)) expect(value.games).toBe(72);
    expect(() => v09DoctrineStatistics(scores.slice(1), 1)).toThrow();
});
