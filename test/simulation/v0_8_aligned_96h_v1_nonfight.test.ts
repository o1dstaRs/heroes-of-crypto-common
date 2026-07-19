/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    LEAGUE_ROUND1_DRAFT_SPEC,
    parseDraftGenome,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import {
    SETUP_COHORTS,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_SPEC,
    resolveSetupPolicy,
    setupCohort,
    type SetupCohort,
} from "../../src/ai/setup/setup_ship";
import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getUpgradePoints } from "../../src/perks/perk_properties";
import { SERVER_PERSISTED_CREATURE_ORDER } from "../../src/picks/pick_sim";
import { LEAGUE_ANCHOR_GENOME, LEAGUE_GENOME_LAYOUT } from "../../src/simulation/league_genome";
import { runRankedConditionalPickGame, shippedLeagueGenome } from "../../src/simulation/measure_setup_conditional";
import { parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import { v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";
import {
    V08_ALIGNED_V1_NONFIGHT_BINDING,
    V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256,
    V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256,
    bindV08AlignedV1MatchConfig,
    cloneV08AlignedV1NonfightBinding,
    pickV08AlignedV1BoundArtifactT2,
    pickV08AlignedV1BoundAugments,
    pickV08AlignedV1BoundSynergies,
    runV08AlignedV1BoundRankedPick,
    validateV08AlignedV1NonfightBinding,
    type IV08AlignedV1NonfightBinding,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_nonfight";

const allCreatureIds = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && !!creatureInfo(value),
);
const ranged = allCreatureIds.filter((id) => creatureInfo(id)!.ranged);
const meleeOther = allCreatureIds.filter((id) => setupCohort([id]) === "melee-other");

function rosterForCohort(cohort: SetupCohort): number[] {
    const special = allCreatureIds.find((id) => setupCohort([id]) === cohort);
    const roster =
        cohort === "ranged-4plus"
            ? [...ranged.slice(0, 4), ...meleeOther.slice(0, 2)]
            : cohort === "ranged-2to3"
              ? [...ranged.slice(0, 2), ...meleeOther.slice(0, 4)]
              : cohort === "ranged-1"
                ? [...ranged.slice(0, 1), ...meleeOther.slice(0, 5)]
                : cohort === "melee-other"
                  ? meleeOther.slice(0, 6)
                  : [special!, ...meleeOther.filter((id) => id !== special).slice(0, 5)];
    expect(roster).toHaveLength(6);
    expect(setupCohort(roster)).toBe(cohort);
    return roster;
}

describe("v0.8 aligned deployed-v0.7 non-fight binding", () => {
    it("freezes the exact draft/setup identity and intrinsic-only shipping projection", () => {
        expect(V08_ALIGNED_V1_NONFIGHT_BINDING).toMatchObject({
            draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
            draftProjection: "ranked-intrinsic-only-zero-interaction-heads",
            projectedDraftGenomeSha256: V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256,
            setupSpec: V07_NONFIGHT_SETUP_SPEC,
            setupBehaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
            rankedCellMode: "full-ranked",
            fixedCellMode: "combat-template-no-artifacts",
            nonfightBindingSha256: V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256,
        });
        expect(validateV08AlignedV1NonfightBinding(cloneV08AlignedV1NonfightBinding())).toEqual(
            V08_ALIGNED_V1_NONFIGHT_BINDING,
        );

        const projected = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
        const intrinsic = LEAGUE_GENOME_LAYOUT.draftIntrinsic;
        expect(
            projected.weights
                .slice(
                    LEAGUE_GENOME_LAYOUT.draftInteractions.offset,
                    LEAGUE_GENOME_LAYOUT.draftInteractions.offset + LEAGUE_GENOME_LAYOUT.draftInteractions.length,
                )
                .every((weight) => weight === 0),
        ).toBe(true);
        expect(
            projected.weights.every(
                (weight, index) =>
                    (index >= intrinsic.offset && index < intrinsic.offset + intrinsic.length) ||
                    weight === LEAGUE_ANCHOR_GENOME[index],
            ),
        ).toBe(true);

        const tampered = cloneV08AlignedV1NonfightBinding();
        tampered.rankedCellMode = "combat-template-no-artifacts" as "full-ranked";
        expect(() => validateV08AlignedV1NonfightBinding(tampered)).toThrow("frozen deployed-v0.7 policy");
        const extra = { ...cloneV08AlignedV1NonfightBinding(), unboundPolicy: undefined };
        expect(() => validateV08AlignedV1NonfightBinding(extra)).toThrow("fields are not exact");
        const nestedExtra = cloneV08AlignedV1NonfightBinding() as IV08AlignedV1NonfightBinding & {
            fixedArtifacts: IV08AlignedV1NonfightBinding["fixedArtifacts"] & { tier3?: undefined };
        };
        nestedExtra.fixedArtifacts.tier3 = undefined;
        expect(() => validateV08AlignedV1NonfightBinding(nestedExtra)).toThrow("fields are not exact");
    });

    it("matches deployed Tier-2, augment, and synergy decisions in all seven cohorts", () => {
        const deployed = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);
        const perk = SETUP_POLICY_V0.pickPerk();
        const offers = [1, 4, 10];
        expect(SETUP_COHORTS).toHaveLength(7);
        for (const cohort of SETUP_COHORTS) {
            const creatureIds = rosterForCohort(cohort);
            expect(pickV08AlignedV1BoundArtifactT2(offers, creatureIds.slice(0, 5))).toBe(
                deployed.pickArtifactT2(offers, creatureIds.slice(0, 5)),
            );
            expect(pickV08AlignedV1BoundAugments(perk, creatureIds)).toEqual(
                deployed.pickAugments(getUpgradePoints(perk), creatureIds),
            );
            expect(pickV08AlignedV1BoundSynergies(creatureIds)).toEqual(deployed.pickSynergies(creatureIds));
        }
    });

    it("runs ranked picks with the shipped draft and complete deployed setup", () => {
        const deployed = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);
        for (const seed of [0, 1, 2, 4, 5]) {
            const expected = runRankedConditionalPickGame(
                seed,
                parseConditionalRules("all"),
                shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
                {
                    pickArtifactT2: (_team, offered, ownCreatureIdsAtTier2) =>
                        deployed.pickArtifactT2(offered, ownCreatureIdsAtTier2),
                    rankedCreatureOrder: SERVER_PERSISTED_CREATURE_ORDER,
                },
            );
            const actual = runV08AlignedV1BoundRankedPick(seed);
            for (const seat of ["lower", "upper"] as const) {
                expect(actual[seat].creatureIds).toEqual(expected[seat].creatureIds);
                expect(actual[seat].perk).toBe(expected[seat].perk);
                expect(actual[seat].tier1Artifact).toBe(expected[seat].tier1Artifact);
                expect(actual[seat].tier2Artifact).toBe(expected[seat].tier2Artifact);
                expect(actual[seat].augments).toEqual(
                    deployed.pickAugments(getUpgradePoints(actual[seat].perk), actual[seat].creatureIds),
                );
                expect(actual[seat].synergies).toEqual(deployed.pickSynergies(actual[seat].creatureIds));
            }
        }
    });

    it("binds both physical seats explicitly and keeps fixed templates artifact-free", () => {
        const lower = v07ArchetypeTemplate("mage_frontline").roster.map((unit) => ({ ...unit }));
        const upper = v07ArchetypeTemplate("ranged_control").roster.map((unit) => ({ ...unit }));
        const perk = SETUP_POLICY_V0.pickPerk();
        const base = {
            greenVersion: "v0.8s",
            redVersion: "v0.7",
            roster: lower,
            redRoster: upper,
            seed: 11,
            gridType: PBTypes.GridVals.NORMAL,
            greenPerk: perk,
            redPerk: perk,
            greenArtifactT1: 3,
            redArtifactT1: 4,
            greenArtifactT2: 5,
            redArtifactT2: 6,
        };
        for (const candidateIsGreen of [true, false]) {
            for (const placementReveal of [true, false]) {
                const bound = bindV08AlignedV1MatchConfig(base, {
                    candidateIsGreen,
                    placementReveal,
                    fixedTemplate: true,
                });
                const candidatePolicy = placementReveal ? "legitimate-reveal" : "baseline";
                expect(bound.greenSetupPlacementPolicy).toBe(candidateIsGreen ? candidatePolicy : "legitimate-reveal");
                expect(bound.redSetupPlacementPolicy).toBe(candidateIsGreen ? "legitimate-reveal" : candidatePolicy);
                expect(bound.placementAugmentTiming).toBe("setup-before-placement");
                expect([
                    bound.greenArtifactT1,
                    bound.redArtifactT1,
                    bound.greenArtifactT2,
                    bound.redArtifactT2,
                ]).toEqual([0, 0, 0, 0]);
            }
        }
        const ranked = bindV08AlignedV1MatchConfig(base, {
            candidateIsGreen: true,
            placementReveal: false,
            fixedTemplate: false,
        });
        expect([ranked.greenArtifactT1, ranked.redArtifactT1, ranked.greenArtifactT2, ranked.redArtifactT2]).toEqual([
            3, 4, 5, 6,
        ]);
    });
});
