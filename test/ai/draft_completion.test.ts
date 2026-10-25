import { describe, expect, test } from "bun:test";

import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    draftCreatureContinuation,
    draftFactionCompletion,
    draftFactionContinuations,
    draftFutureSlots,
} from "../../src/ai/setup/draft_continuations";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IDraftScoutingContext } from "../../src/picks/draft_visibility";
import { CreatureLevelList } from "../../src/units/unit_properties";

const C = PBTypes.CreatureVals;
const nature = creatureInfo(C.ELF)!.faction;
const life = creatureInfo(C.PEASANT)!.faction;
const context: IDraftScoutingContext = {
    bannedCreatureIds: [],
    knownBanLevels: [1, 2, 3, 4],
    remainingPickLevels: [4],
};

describe("draft completion under visible information", () => {
    test("two individually possible routes cannot share the same last pick", () => {
        const own = [C.ELF, C.PEASANT];
        expect(draftFactionContinuations(own, [], context).every((path) => path.reachable)).toBe(true);
        expect(
            draftFactionCompletion(own, [], context, [
                { faction: nature, count: 2 },
                { faction: life, count: 2 },
            ]),
        ).toEqual({ reachable: false, creatureIds: [], uncertain: false });
    });

    test("backtracks to leave a scarce level available for the faction that needs it", () => {
        const own = [C.ELF, C.PEASANT];
        const scouting = {
            ...context,
            remainingPickLevels: [3, 4],
            bannedCreatureIds: CreatureLevelList[4].filter((id) => creatureInfo(id)?.faction === life),
        };
        const result = draftFactionCompletion(own, [], scouting, [
            { faction: nature, count: 2 },
            { faction: life, count: 2 },
        ]);
        expect(result.reachable).toBe(true);
        expect(result.creatureIds).toHaveLength(2);
        expect(
            result.creatureIds.some((id) => creatureInfo(id)?.faction === life && creatureInfo(id)?.level === 3),
        ).toBe(true);
        expect(
            result.creatureIds.some((id) => creatureInfo(id)?.faction === nature && creatureInfo(id)?.level === 4),
        ).toBe(true);
    });

    test("counts each identity once, including repeated slots at the same level", () => {
        const scouting = {
            ...context,
            remainingPickLevels: [1, 1],
            bannedCreatureIds: CreatureLevelList[1].filter((id) => id !== C.ORC),
        };
        const result = draftCreatureContinuation([], [], scouting, (unit) => unit.ranged);
        expect(result.maximumCount).toBe(1);
        expect(result.creatureIds).toEqual([C.ORC]);
        expect(
            draftFactionCompletion([], [], scouting, [{ faction: creatureInfo(C.ORC)!.faction, count: 2 }]).reachable,
        ).toBe(false);
    });

    test("does not include owned, revealed opposing or banned identities as targets", () => {
        const scouting = { ...context, remainingPickLevels: [1, 2, 4], bannedCreatureIds: [C.GARGANTUAN] };
        const pool = draftFutureSlots([C.ORC], [C.ELF], scouting).flatMap((slot) => slot.creatureIds);
        expect(pool).not.toContain(C.ORC);
        expect(pool).not.toContain(C.ELF);
        expect(pool).not.toContain(C.GARGANTUAN);
        expect(
            draftCreatureContinuation(
                [C.ORC, C.ORC, 0],
                [],
                { ...context, remainingPickLevels: [] },
                (unit) => unit.ranged,
            ).count,
        ).toBe(1);
    });

    test("marks a witness using unopened bans as conditional", () => {
        const result = draftFactionCompletion([C.ELF], [], { ...context, knownBanLevels: [1] }, [
            { faction: nature, count: 2 },
        ]);
        expect(result.reachable).toBe(true);
        expect(result.uncertain).toBe(true);
        expect(
            draftFactionCompletion([C.ELF, C.GARGANTUAN], [], context, [
                { faction: nature, count: 2 },
                { faction: nature, count: 1 },
            ]),
        ).toEqual({ reachable: true, creatureIds: [], uncertain: false });
    });

    test("ignores non-creature phase levels and rejects unbounded goals", () => {
        expect(draftFutureSlots([], [], { ...context, remainingPickLevels: [0, 5, -1] })).toEqual([]);
        expect(() => draftFactionCompletion([], [], context, [{ faction: nature, count: 1000000 }])).toThrow(
            RangeError,
        );
    });
});
