import { describe, expect, test } from "bun:test";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getVisibleDraftBans } from "../../src/picks/ban_visibility";
import { createPickSimState, getPickTeamView, LIVE_PICK_PHASES } from "../../src/picks/pick_sim";
import { CreatureLevelList, CreatureLevelMap } from "../../src/units/unit_properties";

const levels = LIVE_PICK_PHASES.map(({ creatureLevel }) => creatureLevel);
const bans = [4, 1, 3, 2].map((level) => CreatureLevelList[level][0]);
const publicLevels = [0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 4];

describe("draft ban visibility", () => {
    for (const doctrine of [Doctrine.THREE_REVEALS, Doctrine.SEE_ALL])
        test(`scouting doctrine ${doctrine} sees every ban as soon as it is chosen`, () => {
            for (let sequence = 0; sequence < levels.length; sequence++) {
                expect(getVisibleDraftBans(bans, levels, sequence, doctrine)).toEqual(bans);
            }
        });

    for (const doctrine of [Doctrine.NO_DOCTRINE, Doctrine.SEE_NONE, 999])
        test(`doctrine ${doctrine} only sees bans for levels already opened`, () => {
            for (let sequence = 0; sequence < levels.length; sequence++) {
                expect(getVisibleDraftBans(bans, levels, sequence, doctrine)).toEqual(
                    bans.filter((id) => CreatureLevelMap[id] <= publicLevels[sequence]),
                );
            }
        });

    test("public viewers never inherit scouting privileges and keep earlier reveals at artifact/handoff steps", () => {
        expect(getVisibleDraftBans(bans, levels, 0)).toEqual([]);
        expect(getVisibleDraftBans(bans, levels, 1)).toEqual([]);
        expect(getVisibleDraftBans(bans, levels, 8)).toEqual(bans.filter((id) => CreatureLevelMap[id] <= 3));
        expect(getVisibleDraftBans(bans, levels, 11)).toEqual(bans);
    });

    test("uses actual level history rather than hard-coded phase indices", () => {
        const legacyLevels = [0, 2, 0, 4, 0];
        expect(getVisibleDraftBans(bans, legacyLevels, 0)).toEqual([]);
        expect(getVisibleDraftBans(bans, legacyLevels, 2)).toEqual(bans.filter((id) => CreatureLevelMap[id] <= 2));
        expect(getVisibleDraftBans(bans, legacyLevels, 4)).toEqual(bans);
    });

    test("malformed sequences fail closed, unknown creature ids stay out and returned arrays are independent", () => {
        for (const sequence of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, levels.length]) {
            expect(getVisibleDraftBans(bans, levels, sequence, Doctrine.SEE_ALL)).toEqual([]);
        }
        expect(getVisibleDraftBans([...bans, 0, 9999], levels, 0, Doctrine.SEE_ALL)).toEqual(bans);
        const visible = getVisibleDraftBans(bans, levels, 0, Doctrine.SEE_ALL);
        visible.length = 0;
        expect(bans).toHaveLength(4);
    });
});

describe("private reducer observations", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT])
        for (const doctrine of [Doctrine.SEE_NONE, Doctrine.THREE_REVEALS, Doctrine.SEE_ALL])
            test(`team ${team}, doctrine ${doctrine} receives the same ban policy as a live seat`, () => {
                const state = createPickSimState(() => 0);
                (team === PBTypes.TeamVals.LEFT ? state.left : state.right).doctrine = doctrine;
                const original = [...state.creaturesBanned];
                for (let sequence = 0; sequence < levels.length; sequence++) {
                    state.phaseSequence = sequence;
                    expect(getPickTeamView(state, team).creaturesBanned).toEqual(
                        doctrine === Doctrine.SEE_NONE
                            ? original.filter((id) => CreatureLevelMap[id] <= publicLevels[sequence])
                            : original,
                    );
                }
                expect(state.creaturesBanned).toEqual(original);
            });

    test("changing an unrevealed ban cannot change a Battle Trance observation", () => {
        const state = createPickSimState(() => 0);
        state.phaseSequence = 2;
        state.left.doctrine = Doctrine.SEE_NONE;
        const before = JSON.stringify(getPickTeamView(state, PBTypes.TeamVals.LEFT));
        state.creaturesBanned = state.creaturesBanned.map((id) =>
            CreatureLevelMap[id] === 4 ? CreatureLevelList[4].at(-1)! : id,
        );
        expect(JSON.stringify(getPickTeamView(state, PBTypes.TeamVals.LEFT))).toBe(before);
    });
});
