import { describe, expect, it } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { parseDraftGenome, pickRankedLiveDraftCreature } from "../../src/ai/setup/draft_ship";
import {
    applyRankedDraftRangedFloor,
    RANKED_DRAFT_RANGED_FLOOR,
    RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS,
    rankedDraftRangedFloor,
    rankedDraftStrengthScore,
} from "../../src/ai/setup/draft_strength_prior";

const ids = Array.from({ length: 200 }, (_, id) => id).filter((id) => creatureInfo(id)?.name);
const ranged = ids.filter((id) => creatureInfo(id)?.ranged);
const melee = ids.filter((id) => !creatureInfo(id)?.ranged);
const byLevel = (level: number, pool: number[]) => pool.filter((id) => creatureInfo(id)?.level === level);

describe("ranked draft shooter floor", () => {
    it("registers the floored ids at the staging weight and leaves every other policy at floor 0", () => {
        expect(RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS["ranked-unit-strength-a19-side-v1-w4-r2"]).toBe(4);
        expect(RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS["ranked-unit-strength-a19-side-v1-w4-r3"]).toBe(4);
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2")).toBe(2);
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r4")).toBe(4);
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4")).toBe(0);
        expect(rankedDraftRangedFloor(undefined)).toBe(0);
        for (const policy of Object.keys(
            RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS,
        ) as (keyof typeof RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS)[]) {
            if (!(policy in RANKED_DRAFT_RANGED_FLOOR)) expect(rankedDraftRangedFloor(policy)).toBe(0);
        }
        // The floored id scores exactly like w4 on every creature: the floor is a filter, not a score.
        for (const id of ids) {
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v1-w4-r2")).toBe(
                rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v1-w4"),
            );
        }
    });

    it("narrows the offers only when the remaining picks could no longer reach the floor", () => {
        const offers = [melee[0], ranged[0], melee[1], ranged[1]];
        // Two creatures drafted, none ranged, four picks left (this one + 3): floor 2 is still reachable -> untouched.
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2", offers, [melee[2], melee[3]]),
        ).toBe(offers);
        // Four drafted, none ranged, two picks left: both must be ranged -> narrowed to the ranged offers.
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2", offers, [
                melee[2],
                melee[3],
                melee[4],
                melee[5],
            ]),
        ).toEqual([ranged[0], ranged[1]]);
        // Four drafted with one ranged, two picks left: one more needed, two picks left -> untouched.
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2", offers, [
                melee[2],
                melee[3],
                melee[4],
                ranged[2],
            ]),
        ).toBe(offers);
        // Five drafted with one ranged, last pick: must be ranged.
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2", offers, [
                melee[2],
                melee[3],
                melee[4],
                melee[5],
                ranged[2],
            ]),
        ).toEqual([ranged[0], ranged[1]]);
        // No ranged offer exists: the floor cannot be met on this pick and the offers stay untouched.
        const meleeOnly = [melee[0], melee[1]];
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4-r2", meleeOnly, [
                melee[2],
                melee[3],
                melee[4],
                melee[5],
            ]),
        ).toBe(meleeOnly);
        // Un-floored policies never narrow.
        expect(
            applyRankedDraftRangedFloor("ranked-unit-strength-a19-side-v1-w4", offers, [
                melee[2],
                melee[3],
                melee[4],
                melee[5],
            ]),
        ).toBe(offers);
        expect(applyRankedDraftRangedFloor(undefined, offers, [melee[2], melee[3], melee[4], melee[5]])).toBe(offers);
    });

    it("the live pick rule under the floored policy picks a shooter at a forced pick and matches w4 otherwise", () => {
        const w4 = parseDraftGenome("ranked-unit-strength-a19-side-v1-w4");
        const r2 = parseDraftGenome("ranked-unit-strength-a19-side-v1-w4-r2");
        const level4 = byLevel(4, ids);
        const level4Ranged = level4.filter((id) => creatureInfo(id)?.ranged);
        expect(level4Ranged.length).toBeGreaterThan(0);
        const own = [
            byLevel(1, melee)[0],
            byLevel(1, melee)[1],
            byLevel(2, melee)[0],
            byLevel(2, melee)[1],
            byLevel(3, melee)[0],
        ];
        // Last pick, no shooters yet: the floored policy must take a ranged level-4 offer whenever one is offered.
        const offers = [...level4.filter((id) => !creatureInfo(id)?.ranged).slice(0, 2), level4Ranged[0]];
        const pick = pickRankedLiveDraftCreature(r2, offers, own, []);
        expect(pick).toBe(level4Ranged[0]);
        // Early pick, floor reachable: identical decision to w4 on the same offers.
        const earlyOwn = [byLevel(1, melee)[0], byLevel(2, melee)[0]];
        const earlyOffers = byLevel(1, ids).slice(0, 4);
        expect(pickRankedLiveDraftCreature(r2, earlyOffers, earlyOwn, [])).toBe(
            pickRankedLiveDraftCreature(w4, earlyOffers, earlyOwn, []),
        );
    });
});
