import { describe, expect, test } from "bun:test";

import {
    parseDraftGenome,
    pickRankedLiveDraftBundle,
    pickRankedLiveDraftCreature,
} from "../../src/ai/setup/draft_ship";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { applyRankedDraftRangedFloor } from "../../src/ai/setup/draft_strength_prior";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getDraftScoutingContext } from "../../src/picks/draft_visibility";
import { LIVE_PICK_PHASES } from "../../src/picks/pick_sim";
import { resolveRankedDraftPick } from "../../src/simulation/ranked_draft_eval";
import { CreatureLevelList } from "../../src/units/unit_properties";

const C = PBTypes.CreatureVals;
const policy = "ranked-unit-strength-a19-side-v4-w16-r4";
const genome = parseDraftGenome(policy);
const setup = "artifact-fit-v6:conditional-v1:sniper+t2a19";
const phaseOrder = LIVE_PICK_PHASES.map((phase) => phase.phase);
const phaseLevels = LIVE_PICK_PHASES.map((phase) => phase.creatureLevel);
const phaseActors = LIVE_PICK_PHASES.map((phase) => phase.actors);

describe("ranked AI uses scouting to draft", () => {
    test("Spymaster's early map and both scouting doctrines' early bans change an opening build", () => {
        for (const doctrine of [Doctrine.SEE_ALL, Doctrine.THREE_REVEALS]) {
            let checked = false;
            resolveRankedDraftPick(
                291,
                genome,
                genome,
                { left: setup, right: setup, leftDoctrine: doctrine },
                {
                    liveDraftRules: true,
                    gridType: PBTypes.GridVals.NORMAL,
                    researchDraftChoicesByTeam: {
                        [PBTypes.TeamVals.LEFT]: {
                            bundle: (bundles, context, chosen) => {
                                checked = true;
                                const choose = (scouting: typeof context.scouting) =>
                                    pickRankedLiveDraftBundle(genome, bundles, undefined, 6, scouting);
                                expect(context.scouting.bannedCreatureIds).toHaveLength(20);
                                expect(choose(context.scouting)).toBe(chosen);
                                expect(choose({ ...context.scouting, bannedCreatureIds: [] })).not.toBe(chosen);
                                if (doctrine === Doctrine.SEE_ALL) {
                                    expect(
                                        choose({ ...context.scouting, map: PBTypes.GridVals.BLOCK_CENTER }),
                                    ).not.toBe(chosen);
                                } else {
                                    expect(context.scouting.map).toBeUndefined();
                                }
                                return chosen;
                            },
                        },
                    },
                },
            );
            expect(checked).toBe(true);
        }
    });

    test("known future bans make the AI secure shooters before their remaining levels run out", () => {
        const own = [C.ORC, C.MEDUSA];
        const available = [C.BERSERKER, C.DRYAD];
        const bannedCreatureIds = [3, 4].flatMap((level) =>
            CreatureLevelList[level].filter((id) => creatureInfo(id)?.ranged),
        );
        const scouting = { bannedCreatureIds, knownBanLevels: [1, 2, 3, 4], remainingPickLevels: [1, 2, 3, 4] };
        expect(applyRankedDraftRangedFloor(policy, available, own, { ...scouting, bannedCreatureIds: [] })).toEqual(
            available,
        );
        expect(applyRankedDraftRangedFloor(policy, available, own, scouting)).toEqual([C.DRYAD]);
    });

    test("unrevealed maps and future bans cannot change a blind seat's opening or first pick", () => {
        const bundles = [
            [C.ORC, C.MEDUSA, 1],
            [C.BERSERKER, C.WOLF_RIDER, 2],
        ] as const;
        const choose = (map: number, futureBan: number) => {
            const visibility = {
                gridType: map,
                bannedCreatureIds: [futureBan],
                phaseOrder,
                phaseLevels,
                phaseActors,
                doctrine: Doctrine.SEE_NONE,
                team: PBTypes.TeamVals.LEFT,
            };
            const bundle = pickRankedLiveDraftBundle(
                genome,
                bundles,
                undefined,
                6,
                getDraftScoutingContext({ ...visibility, phaseSequence: 1 }),
            );
            const scouting = getDraftScoutingContext({ ...visibility, phaseSequence: 2 });
            const creature = pickRankedLiveDraftCreature(
                genome,
                [C.DRYAD, C.BERSERKER],
                [C.ORC, C.MEDUSA],
                [],
                1,
                scouting.map,
                undefined,
                undefined,
                6,
                scouting,
            );
            return { bundle, creature };
        };
        expect(choose(PBTypes.GridVals.NORMAL, C.BLACK_DRAGON)).toEqual(
            choose(PBTypes.GridVals.BLOCK_CENTER, C.TSAR_CANNON),
        );
    });
});
