import { expect, test } from "bun:test";

import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createScoutingResearchChoices } from "../../src/simulation/draft_scouting_research";
import { resolveRankedDraftPick } from "../../src/simulation/ranked_draft_eval";

const genome = parseDraftGenome("ranked-unit-strength-a19-side-v4-w16-r4");
const left = PBTypes.TeamVals.LEFT;
const right = PBTypes.TeamVals.RIGHT;

test("research choices receive immutable seat-visible inputs and cannot select hidden offers", () => {
    const base = createScoutingResearchChoices(genome);
    const seen: { map?: number; levels: readonly number[] }[] = [];
    const choices = {
        ...base,
        bundle: (
            bundles: Parameters<NonNullable<typeof base.bundle>>[0],
            context: Parameters<NonNullable<typeof base.bundle>>[1],
            preferred: number,
        ) => {
            expect(Object.isFrozen(context.ownCreatureIds)).toBe(true);
            expect(Object.isFrozen(context.scouting.bannedCreatureIds)).toBe(true);
            expect(context.knownOpponentCreatureIds).toEqual([]);
            seen.push({ map: context.scouting.map, levels: context.scouting.knownBanLevels });
            return base.bundle!(bundles, context, preferred);
        },
    };
    const state = resolveRankedDraftPick(
        260_104_001,
        genome,
        genome,
        { leftDoctrine: Doctrine.SEE_ALL, rightDoctrine: Doctrine.SEE_NONE },
        { liveDraftRules: true, gridType: 4, researchDraftChoicesByTeam: { [left]: choices, [right]: choices } },
    );
    expect(seen).toEqual([
        { map: 4, levels: [1, 2, 3, 4] },
        { map: undefined, levels: [] },
    ]);
    expect(state.left.creatures).toHaveLength(6);
    expect(state.right.creatures).toHaveLength(6);
    expect(new Set([...state.left.creatures, ...state.right.creatures]).size).toBe(12);
    expect(() =>
        resolveRankedDraftPick(
            1,
            genome,
            genome,
            {},
            { liveDraftRules: true, researchDraftChoicesByTeam: { [left]: { bundle: () => 999 } } },
        ),
    ).toThrow("seat's offers");
    expect(() =>
        resolveRankedDraftPick(
            1,
            genome,
            genome,
            {},
            { liveDraftRules: true, researchDraftChoicesByTeam: { [left]: { creature: () => 999 } } },
        ),
    ).toThrow("visible to the seat");
});

test("passing no scouting experiment preserves the existing draft exactly", () => {
    const before = resolveRankedDraftPick(260_104_002, genome, genome, {}, { liveDraftRules: true, gridType: 3 });
    const after = resolveRankedDraftPick(
        260_104_002,
        genome,
        genome,
        {},
        { liveDraftRules: true, gridType: 3, researchDraftChoicesByTeam: { [left]: {} } },
    );
    expect(after).toEqual(before);
});
