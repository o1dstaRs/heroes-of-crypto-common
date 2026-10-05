import { describe, expect, it } from "bun:test";
import { prepareV08A19RoleCandidate, withV08A19RoleCandidate } from "../../src/simulation/v0_8_a19_role_candidate";
import { buildV08A19SearchEnvironment, V08_A19_SEARCH_RULES } from "../../src/ai/versions/v0_8_a19_profile";
import type { IMatchConfig } from "../../src/simulation/battle_engine";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { creatureInfo, creatureIdForName } from "../../src/ai/setup/creature_score";
import { ToFactionName } from "../../src/factions/faction_type";
const fixture = (): IMatchConfig => ({
    greenVersion: "v0.8",
    redVersion: "v0.7",
    seed: 42,
    gridType: PBTypes.GridVals.NORMAL,
    roster: [
        { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 100 },
        { faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 30 },
        { faction: "Might", creatureName: "Berserker", level: 1, size: 1, amount: 50 },
        { faction: "Chaos", creatureName: "Beholder", level: 2, size: 1, amount: 20 },
        { faction: "Might", creatureName: "Cyclops", level: 3, size: 1, amount: 8 },
        { faction: "Life", creatureName: "Angel", level: 4, size: 2, amount: 2 },
    ],
    redRoster: [{ faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 }],
    greenAugments: [
        { kind: "Sniper", value: 3 },
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 1 },
    ],
    redAugments: [
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 2 },
    ],
    greenDoctrine: 3,
    redDoctrine: 2,
    greenArtifactT1: 5,
    redArtifactT1: 8,
    greenArtifactT2: 6,
    redArtifactT2: 10,
    greenSynergies: [],
    redSynergies: [],
    greenTacticalSplitStacks: [],
    redTacticalSplitStacks: [],
});
describe("A19 opt-in complete ranked simulation candidate", () => {
    it("protects a Blocked caster-heavy army with a legal armor plan while preserving its models and the opponent", () => {
        const names = ["Wandering Mage", "Wyvern", "Berserker", "Battle Mage", "Zena", "Magic Dragon"];
        for (const side of ["green", "red"] as const)
            for (const gridType of [
                PBTypes.GridVals.NORMAL,
                PBTypes.GridVals.LAVA_CENTER,
                PBTypes.GridVals.BLOCK_CENTER,
            ]) {
                const c = fixture(),
                    rosterKey = side === "green" ? "roster" : "redRoster";
                c.gridType = gridType;
                c[rosterKey] = names.map((creatureName) => {
                    const info = creatureInfo(creatureIdForName(creatureName)!)!;
                    return {
                        faction: ToFactionName[info.faction],
                        creatureName,
                        level: info.level,
                        size: info.footprintWidth,
                        amount: 12,
                    };
                });
                c[`${side}Augments`] = [
                    { kind: "Sniper", value: 2 },
                    { kind: "Armor", value: 2 },
                    { kind: "Empower", value: 3 },
                ];
                const before = structuredClone(c),
                    environment = prepareV08A19RoleCandidate(c, side);
                expect(c[`${side}Augments`]).toEqual(
                    gridType === PBTypes.GridVals.BLOCK_CENTER
                        ? [
                              { kind: "Sniper", value: 1 },
                              { kind: "Armor", value: 3 },
                              { kind: "Empower", value: 3 },
                          ]
                        : before[`${side}Augments`],
                );
                expect(c[`${side}Augments`]!.reduce((sum, augment) => sum + augment.value, 0)).toBe(7);
                expect(c[rosterKey]).toEqual(before[rosterKey]);
                expect(c[`${side}TacticalSplitStacks`]).toEqual(before[`${side}TacticalSplitStacks`]);
                const enemy = side === "green" ? "red" : "green";
                for (const field of [
                    "Augments",
                    "Doctrine",
                    "ArtifactT1",
                    "ArtifactT2",
                    "Synergies",
                    "TacticalSplitStacks",
                ] as const)
                    expect(c[`${enemy}${field}`]).toEqual(before[`${enemy}${field}`]);
                expect(c[enemy === "green" ? "roster" : "redRoster"]).toEqual(
                    before[enemy === "green" ? "roster" : "redRoster"],
                );
                expect(environment.SEARCH_A19_HEALER_OPENING_COHESION).toBe("1");
            }
    });
    it("empowers a Lava hybrid healer only when its complete army fits the ranked stack capacity", () => {
        for (const side of ["green", "red"] as const)
            for (const gridType of [
                PBTypes.GridVals.NORMAL,
                PBTypes.GridVals.LAVA_CENTER,
                PBTypes.GridVals.BLOCK_CENTER,
            ])
                for (const extraStack of [false, true]) {
                    const c = fixture();
                    c.gridType = gridType;
                    const rosterKey = side === "green" ? "roster" : "redRoster";
                    c[rosterKey] = ["Arbalester", "Battle Mage", "Wandering Mage", "Medusa", "Cyclops", "Angel"].map(
                        (creatureName) => {
                            const info = creatureInfo(creatureIdForName(creatureName)!)!;
                            return {
                                faction: ToFactionName[info.faction],
                                creatureName,
                                level: info.level,
                                size: info.footprintWidth,
                                amount: 12,
                            };
                        },
                    );
                    if (extraStack) c[rosterKey].push({ ...c[rosterKey][0], amount: 1 });
                    c[`${side}Augments`] = [
                        { kind: "Sniper", value: 3 },
                        { kind: "Armor", value: 3 },
                        { kind: extraStack ? "Placement" : "Might", value: 1 },
                    ];
                    const before = structuredClone(c);
                    const environment = prepareV08A19RoleCandidate(c, side);
                    if (gridType === PBTypes.GridVals.LAVA_CENTER && !extraStack)
                        expect(c[`${side}Augments`]).toEqual([
                            { kind: "Sniper", value: 1 },
                            { kind: "Armor", value: 3 },
                            { kind: "Empower", value: 3 },
                        ]);
                    else if (extraStack) expect(c[`${side}Augments`]).toEqual(before[`${side}Augments`]);
                    else expect(c[`${side}Augments`]?.find((augment) => augment.kind === "Empower")?.value).toBe(1);
                    expect(c[`${side}Augments`]!.reduce((sum, augment) => sum + augment.value, 0)).toBe(7);
                    expect(c[rosterKey]).toEqual(before[rosterKey]);
                    expect(c[`${side}TacticalSplitStacks`]).toEqual(before[`${side}TacticalSplitStacks`]);
                    const enemy = side === "green" ? "red" : "green";
                    for (const field of [
                        "Augments",
                        "Doctrine",
                        "ArtifactT1",
                        "ArtifactT2",
                        "Synergies",
                        "TacticalSplitStacks",
                    ] as const)
                        expect(c[`${enemy}${field}`]).toEqual(before[`${enemy}${field}`]);
                    expect(c[enemy === "green" ? "roster" : "redRoster"]).toEqual(
                        before[enemy === "green" ? "roster" : "redRoster"],
                    );
                    expect(environment.SEARCH_A19_HEALER_OPENING_COHESION).toBe("1");
                }
    });
    it("gives a blocked regenerative volley battery its legal damage plan on either seat", () => {
        for (const side of ["green", "red"] as const) {
            const c = fixture();
            c.gridType = PBTypes.GridVals.BLOCK_CENTER;
            const names = ["Berserker", "Battle Mage", "Orc", "Troll", "Zena", "Tsar Cannon"];
            c[side === "green" ? "roster" : "redRoster"] = names.map((creatureName) => {
                const info = creatureInfo(creatureIdForName(creatureName)!)!;
                return {
                    faction: ToFactionName[info.faction],
                    creatureName,
                    level: info.level,
                    size: info.footprintWidth,
                    amount: 12,
                };
            });
            const before = structuredClone(c);
            prepareV08A19RoleCandidate(c, side);
            expect(c[`${side}Augments`]).toEqual([
                { kind: "Sniper", value: 3 },
                { kind: "Armor", value: 1 },
                { kind: "Might", value: 3 },
            ]);
            expect(c[side === "green" ? "roster" : "redRoster"]).toEqual(
                before[side === "green" ? "roster" : "redRoster"],
            );
            expect(c[`${side}TacticalSplitStacks`]).toEqual(before[`${side}TacticalSplitStacks`]);
            const enemy = side === "green" ? "red" : "green";
            expect(c[`${enemy}Augments`]).toEqual(before[`${enemy}Augments`]);
            expect(c[enemy === "green" ? "roster" : "redRoster"]).toEqual(
                before[enemy === "green" ? "roster" : "redRoster"],
            );
        }
    });
    it("prepares the candidate's legal7-pointphysicalhealer plan and leaves the opponent setup untouched", () => {
        const c = fixture(),
            before = structuredClone(c);
        const env = prepareV08A19RoleCandidate(c, "green");
        expect(c.greenAugments).toEqual(before.greenAugments);
        expect(c.greenAugments!.reduce((s, a) => s + a.value, 0)).toBe(7);
        for (const key of [
            "redRoster",
            "redAugments",
            "redDoctrine",
            "redArtifactT1",
            "redArtifactT2",
            "redSynergies",
            "redTacticalSplitStacks",
        ] as const)
            expect(c[key]).toEqual(before[key]);
        expect(c.searchEnvOverrideTeams).toEqual([PBTypes.TeamVals.LEFT]);
        expect(env.SEARCH_A19_HEALER_OPENING_COHESION).toBe("1");
    });
    it("preserves all eight A19 advancements in the scoped candidate environment", () => {
        withV08A19RoleCandidate(fixture(), "green", () => {
            const e = buildV08A19SearchEnvironment();
            for (const [k, v] of Object.entries(V08_A19_SEARCH_RULES)) expect(e[k]).toBe(v);
            expect(e.SEARCH_A19_MATERIAL_ARBITRATION).toBe("sample-relative");
        });
    });
    it("restores ambient research controls after normal completion and after an exception", () => {
        const previous = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
        expect(withV08A19RoleCandidate(fixture(), "green", () => 123)).toBe(123);
        expect(process.env.V08_A19_SEARCH_ENV_OVERRIDES).toBe(previous);
        expect(() =>
            withV08A19RoleCandidate(fixture(), "green", () => {
                throw new Error("fixture failure");
            }),
        ).toThrow("fixture failure");
        expect(process.env.V08_A19_SEARCH_ENV_OVERRIDES).toBe(previous);
    });
});
