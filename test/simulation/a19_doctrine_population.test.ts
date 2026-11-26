import { expect, test } from "bun:test";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { GREEN_TEAM, type IMatchConfig } from "../../src/simulation/battle_engine";
import {
    assertV09DoctrineSetup,
    v09DoctrineBoard,
    v09DoctrineBoardCount,
} from "../../src/simulation/doctrine_draft/a19_doctrine_population";

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
