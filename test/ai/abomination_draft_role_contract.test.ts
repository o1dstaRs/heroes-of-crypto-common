import { describe, expect, test } from "bun:test";

import {
    LEAGUE_ROUND1_DRAFT_SPEC,
    draftGenomeCreatureScore,
    parseDraftGenome,
    pickDraftGenomeCreature,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import {
    eligibleBacklineProtectorChoices,
    isBacklineProtectionBeneficiaryCreature,
} from "../../src/ai/setup/creature_score";
import { SetupPolicyV0 } from "../../src/ai/setup/setup_v0";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const CREATURES = PBTypes.CreatureVals;
const ABOMINATION = CREATURES.ABOMINATION;
const CHAMPION = CREATURES.CHAMPION;
const OFFER = [ABOMINATION, CHAMPION] as const;

describe("Abomination draft role contract", () => {
    const livePolicy = new SetupPolicyV0();
    const shippedGenome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));

    test("excludes Abomination when a pure-melee roster has an ordinary alternative", () => {
        const pureMeleeRoster = [CREATURES.SQUIRE, CREATURES.PIKEMAN, CREATURES.CRUSADER];

        expect(pureMeleeRoster.every((id) => !isBacklineProtectionBeneficiaryCreature(id))).toBe(true);
        expect(eligibleBacklineProtectorChoices(OFFER, pureMeleeRoster, [])).toEqual([CHAMPION]);
        expect(livePolicy.pickCreature(4, OFFER, pureMeleeRoster, [])).toBe(CHAMPION);
        expect(pickDraftGenomeCreature(shippedGenome, OFFER, pureMeleeRoster, [])).toBe(CHAMPION);
    });

    test("excludes Abomination for one opportunistic ward", () => {
        const ward = CREATURES.BATTLE_MAGE;
        expect(isBacklineProtectionBeneficiaryCreature(ward)).toBe(true);
        expect(eligibleBacklineProtectorChoices(OFFER, [ward], [])).toEqual([CHAMPION]);
        expect(livePolicy.pickCreature(4, OFFER, [ward], [])).toBe(CHAMPION);
        expect(pickDraftGenomeCreature(shippedGenome, OFFER, [ward], [])).toBe(CHAMPION);
    });

    test.each([
        ["two mages", [CREATURES.BATTLE_MAGE, CREATURES.MAGIC_DRAGON]],
        ["ranged plus mage", [CREATURES.ARBALESTER, CREATURES.BATTLE_MAGE]],
    ] as const)("selects Abomination for a %s army under both live and shipped scoring", (_name, wards) => {
        expect(wards.every((ward) => isBacklineProtectionBeneficiaryCreature(ward))).toBe(true);
        expect(eligibleBacklineProtectorChoices(OFFER, wards, [])).toEqual(OFFER);
        expect(draftGenomeCreatureScore(shippedGenome, ABOMINATION)).toBeGreaterThan(
            draftGenomeCreatureScore(shippedGenome, CHAMPION),
        );
        expect(livePolicy.pickCreature(4, OFFER, wards, [])).toBe(ABOMINATION);
        expect(pickDraftGenomeCreature(shippedGenome, OFFER, wards, [])).toBe(ABOMINATION);
    });
});
