import { expect, test } from "bun:test";

import { creatureInfo } from "../../src/ai/setup/creature_score";
import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    createCapacityResearchChoices,
    draftRangedCapacityChoices,
} from "../../src/simulation/draft_capacity_research";
import { resolveRankedDraftPick, type IRankedDraftResearchContext } from "../../src/simulation/ranked_draft_eval";
import { CreatureLevelList } from "../../src/units/unit_properties";

const C = PBTypes.CreatureVals;
const genome = parseDraftGenome("ranked-unit-strength-a19-side-v4-w16-r4");
const context: IRankedDraftResearchContext = {
    ownCreatureIds: [C.ORC, C.ELF],
    knownOpponentCreatureIds: [],
    artifactFitVersion: 6,
    scouting: { bannedCreatureIds: [], knownBanLevels: [1, 2, 3, 4], remainingPickLevels: [1, 2, 3, 4] },
};
const level4Shooters = CreatureLevelList[4].filter((id) => creatureInfo(id)?.ranged);

test("uses revealed future bans to secure a shooter before its last opportunity", () => {
    const view = {
        ...context,
        scouting: { ...context.scouting, remainingPickLevels: [2, 3, 4], bannedCreatureIds: level4Shooters },
    };
    expect(draftRangedCapacityChoices([C.MEDUSA, C.TROLL], view, 4)).toEqual([C.MEDUSA]);
    expect(
        draftRangedCapacityChoices(
            [C.MEDUSA, C.TROLL],
            { ...view, scouting: { ...view.scouting, bannedCreatureIds: [] } },
            4,
        ),
    ).toEqual([C.MEDUSA, C.TROLL]);
});

test("does not double-count the current shooter in a repeated future level", () => {
    const view = {
        ...context,
        ownCreatureIds: [],
        scouting: {
            ...context.scouting,
            remainingPickLevels: [1, 1],
            bannedCreatureIds: CreatureLevelList[1].filter((id) => ![C.ORC, C.PEASANT].includes(id)),
        },
    };
    expect(draftRangedCapacityChoices([C.ORC, C.PEASANT], view, 2)).toEqual([C.ORC, C.PEASANT]);
});

test("keeps the incumbent choice when it can reach the target and when no shooter is offered", () => {
    const choices = createCapacityResearchChoices(genome);
    expect(choices.creature!([C.ORC, C.PEASANT], context, C.PEASANT)).toBe(C.PEASANT);
    expect(choices.creature!([C.TROLL, C.HARPY], context, C.HARPY)).toBe(C.HARPY);
    expect(draftRangedCapacityChoices([], context, 4)).toEqual([]);
});

test("frozen research choices remain legal across all doctrines and mirrors", () => {
    for (const doctrine of [Doctrine.SEE_NONE, Doctrine.THREE_REVEALS, Doctrine.SEE_ALL]) {
        for (let seed = 260414001; seed < 260414025; seed++) {
            const result = resolveRankedDraftPick(
                seed,
                genome,
                genome,
                { leftDoctrine: doctrine, rightDoctrine: doctrine },
                {
                    liveDraftRules: true,
                    gridType: 4,
                    researchDraftChoicesByTeam: { [PBTypes.TeamVals.LEFT]: createCapacityResearchChoices(genome) },
                },
            );
            const armies = [result.left.creatures, result.right.creatures];
            for (const army of armies) {
                expect(
                    [1, 2, 3, 4].map((level) => army.filter((id) => creatureInfo(id)?.level === level).length),
                ).toEqual([2, 2, 1, 1]);
            }
            expect(new Set(armies.flat()).size).toBe(12);
        }
    }
});
