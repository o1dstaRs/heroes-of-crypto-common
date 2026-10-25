import { describe, expect, test } from "bun:test";

import { creatureInfo } from "../../src/ai/setup/creature_score";
import { draftContextAfterCreature, draftFactionContinuations } from "../../src/ai/setup/draft_continuations";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IDraftScoutingContext } from "../../src/picks/draft_visibility";
import { CreatureLevelList } from "../../src/units/unit_properties";

const Creature = PBTypes.CreatureVals;
const chaos = creatureInfo(Creature.ORC)!.faction;
const context: IDraftScoutingContext = {
    bannedCreatureIds: [],
    knownBanLevels: [1, 2, 3, 4],
    remainingPickLevels: [2, 3, 4],
};
const chaosFuture = context.remainingPickLevels.flatMap((level) =>
    CreatureLevelList[level].filter((id) => creatureInfo(id)?.faction === chaos),
);

describe("visible draft continuations", () => {
    test("never promises a synergy when bans remove every remaining matching creature", () => {
        const [path] = draftFactionContinuations([Creature.ORC], [], { ...context, bannedCreatureIds: chaosFuture });
        expect(path).toMatchObject({ count: 1, nextThreshold: 2, maximumCount: 1, reachable: false, uncertain: false });
        expect(path.creatureIds).toEqual([]);
    });

    test("respects fixed levels, distinct creature identities and revealed opposing picks", () => {
        const available = { ...context, remainingPickLevels: [4] };
        const [before] = draftFactionContinuations([Creature.ORC, Creature.ORC], [], available);
        expect(before.count).toBe(1);
        expect(before.maximumCount).toBe(2);
        expect(before.creatureIds.every((id) => creatureInfo(id)?.level === 4)).toBe(true);
        const [after] = draftFactionContinuations([Creature.ORC], before.creatureIds, available);
        expect(after.reachable).toBe(false);
    });

    test("unopened bans make remaining paths conditional rather than revealing hidden bans", () => {
        const [path] = draftFactionContinuations([Creature.ORC], [], { ...context, knownBanLevels: [1] });
        expect(path.reachable).toBe(true);
        expect(path.uncertain).toBe(true);
    });

    test("consumes the current pick exactly once without changing the supplied context", () => {
        const current = { ...context, remainingPickLevels: [1, 2, 3, 4] };
        expect(draftContextAfterCreature(current, Creature.ORC).remainingPickLevels).toEqual([2, 3, 4]);
        expect(current.remainingPickLevels).toEqual([1, 2, 3, 4]);
        expect(draftContextAfterCreature(context, Creature.ORC)).toEqual(context);
    });
});
