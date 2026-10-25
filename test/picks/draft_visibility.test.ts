import { describe, expect, test } from "bun:test";

import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getDraftScoutingContext, getVisibleDraftMap } from "../../src/picks/draft_visibility";
import { LIVE_PICK_PHASES } from "../../src/picks/pick_sim";
import { CreatureLevelList, CreatureLevelMap } from "../../src/units/unit_properties";

const phaseOrder = LIVE_PICK_PHASES.map((phase) => phase.phase);
const phaseLevels = LIVE_PICK_PHASES.map((phase) => phase.creatureLevel);
const phaseActors = LIVE_PICK_PHASES.map((phase) => phase.actors);
const bans = [1, 2, 3, 4].map((level) => CreatureLevelList[level][0]);

const context = (doctrine: Doctrine, phaseSequence: number, team: number = PBTypes.TeamVals.LEFT) =>
    getDraftScoutingContext({
        gridType: PBTypes.GridVals.LAVA_CENTER,
        bannedCreatureIds: bans,
        phaseOrder,
        phaseLevels,
        phaseActors,
        phaseSequence,
        doctrine,
        team,
    });

describe("doctrine draft information", () => {
    test("only Spymaster knows the map from bundles; every seat knows it from level 3", () => {
        for (const doctrine of [Doctrine.SEE_ALL, Doctrine.THREE_REVEALS, Doctrine.SEE_NONE, Doctrine.NO_DOCTRINE]) {
            for (let sequence = 0; sequence < phaseOrder.length; sequence++) {
                const visible = sequence >= 6 || (doctrine === Doctrine.SEE_ALL && sequence >= 1);
                expect(context(doctrine, sequence).map).toBe(visible ? PBTypes.GridVals.LAVA_CENTER : undefined);
            }
        }
    });

    test("advance bans and remaining levels are specific to the viewing seat", () => {
        expect(context(Doctrine.SEE_ALL, 1).bannedCreatureIds).toEqual(bans);
        expect(context(Doctrine.THREE_REVEALS, 1).bannedCreatureIds).toEqual(bans);
        expect(context(Doctrine.SEE_NONE, 1).bannedCreatureIds).toEqual([]);
        expect(context(Doctrine.SEE_NONE, 4).bannedCreatureIds).toEqual(bans.filter((id) => CreatureLevelMap[id] <= 2));
        expect(context(Doctrine.SEE_ALL, 1).remainingPickLevels).toEqual([1, 2, 3, 4]);
        expect(context(Doctrine.SEE_ALL, 3).remainingPickLevels).toEqual([2, 3, 4]);
        expect(context(Doctrine.SEE_ALL, 3, PBTypes.TeamVals.RIGHT).remainingPickLevels).toEqual([1, 2, 3, 4]);
        expect(context(Doctrine.SEE_ALL, 11).remainingPickLevels).toEqual([]);
    });

    test("hidden map and future bans cannot change a blind seat's context", () => {
        const input = {
            bannedCreatureIds: bans,
            phaseOrder,
            phaseLevels,
            phaseActors,
            phaseSequence: 2,
            doctrine: Doctrine.SEE_NONE,
            team: PBTypes.TeamVals.LEFT,
        };
        expect(getDraftScoutingContext({ ...input, gridType: PBTypes.GridVals.NORMAL })).toEqual(
            getDraftScoutingContext({
                ...input,
                gridType: PBTypes.GridVals.BLOCK_CENTER,
                bannedCreatureIds: [...bans.filter((id) => CreatureLevelMap[id] === 1), CreatureLevelList[4][1]],
            }),
        );
    });

    test("map reveal follows actual phase levels and invalid phases reveal nothing", () => {
        expect(getVisibleDraftMap(4, [1, 2, 3], [0, 0, 4], 1, Doctrine.SEE_NONE)).toBeUndefined();
        expect(getVisibleDraftMap(4, [1, 2, 3], [0, 0, 4], 2, Doctrine.SEE_NONE)).toBe(4);
        for (const sequence of [-1, 0.5, NaN, phaseOrder.length]) {
            expect(context(Doctrine.SEE_ALL, sequence)).toEqual({
                bannedCreatureIds: [],
                knownBanLevels: [],
                remainingPickLevels: [],
            });
        }
    });
});
