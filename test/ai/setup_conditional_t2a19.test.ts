import { describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    CONDITIONAL_SETUP_RULES,
    TIER2_ARTIFACT_SCORE_A19_RANGED,
    TIER2_ARTIFACT_WINRATE_MELEE,
    conditionalArtifactT2,
    parseConditionalRules,
} from "../../src/ai/setup/setup_conditional";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { LIVE_TIER2_ARTIFACT_IDS } from "../../src/picks/pick_sim";

const allCreatureIds = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && !!creatureInfo(value),
);
const rangedIds = allCreatureIds.filter((id) => creatureInfo(id)!.ranged);
const meleeGroundIds = allCreatureIds.filter((id) => !creatureInfo(id)!.ranged && !creatureInfo(id)!.canFly);
const rosterWithRanged = (ranged: number): number[] => [
    ...rangedIds.slice(0, ranged),
    ...meleeGroundIds.slice(0, 6 - ranged),
];
/** The table's pick among `offered`: the highest score, the first offered on a tie. */
const best = (offered: readonly number[], table: Readonly<Record<number, number>>): number =>
    offered.reduce((chosen, artifact) => (table[artifact] > table[chosen] ? artifact : chosen));

describe("conditional setup rule t2a19", () => {
    test("is turned on only by name, so all/on and a bare conditional-v1 keep meaning sniper + t2", () => {
        for (const spec of ["all", "on", "1"]) {
            expect([...parseConditionalRules(spec)].sort()).toEqual([...CONDITIONAL_SETUP_RULES].sort());
            expect(parseConditionalRules(spec).has("t2a19")).toBe(false);
        }
        expect(resolveSetupPolicy("conditional-v1").spec).toBe("conditional-v1:sniper+t2");
        expect([...parseConditionalRules("sniper,t2a19")].sort()).toEqual(["sniper", "t2a19"]);
        const policy = resolveSetupPolicy("conditional-v1:sniper+t2a19");
        expect(policy.spec).toBe("conditional-v1:sniper+t2a19");
        expect(policy.rules).toEqual(["sniper", "t2a19"]);
        expect(resolveSetupPolicy(policy.spec).spec).toBe(policy.spec);
    });

    test("scores every live Tier-2 artifact, so none is unpickable", () => {
        for (const artifact of LIVE_TIER2_ARTIFACT_IDS) {
            expect(TIER2_ARTIFACT_SCORE_A19_RANGED[artifact]).toBeNumber();
        }
    });

    test("reads the a19 table on ranged-heavy armies and the v1 melee table otherwise", () => {
        const rules = parseConditionalRules("sniper,t2a19");
        const triples: number[][] = [];
        for (let a = 0; a < LIVE_TIER2_ARTIFACT_IDS.length; a += 1) {
            for (let b = a + 1; b < LIVE_TIER2_ARTIFACT_IDS.length; b += 1) {
                for (let c = b + 1; c < LIVE_TIER2_ARTIFACT_IDS.length; c += 1) {
                    triples.push([LIVE_TIER2_ARTIFACT_IDS[a], LIVE_TIER2_ARTIFACT_IDS[b], LIVE_TIER2_ARTIFACT_IDS[c]]);
                }
            }
        }
        for (const offered of triples) {
            for (const ranged of [2, 3, 4, 6]) {
                expect(conditionalArtifactT2(offered, rosterWithRanged(ranged), rules)).toBe(
                    best(offered, TIER2_ARTIFACT_SCORE_A19_RANGED),
                );
            }
            for (const ranged of [0, 1]) {
                expect(conditionalArtifactT2(offered, rosterWithRanged(ranged), rules)).toBe(
                    conditionalArtifactT2(offered, rosterWithRanged(ranged), parseConditionalRules("t2")),
                );
            }
        }
        const meleeOffer = [Tier2Artifact.TITAN_PLATE, Tier2Artifact.WARLORDS_EDGE, Tier2Artifact.RIME_CHARM];
        expect(conditionalArtifactT2(meleeOffer, rosterWithRanged(0), rules)).toBe(
            best(meleeOffer, TIER2_ARTIFACT_WINRATE_MELEE),
        );
    });
});
