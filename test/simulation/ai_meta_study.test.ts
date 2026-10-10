import { validateAiMetaGamesPerCohort } from "../../src/simulation/measure_ai_meta_cohorts";
import { describe, expect, it } from "bun:test";
import { getUpgradePoints } from "../../src/doctrines/doctrine_properties";
import { augmentPlanCost } from "../../src/ai/setup/setup_ship";
import { pickRankedLiveDraftCreature, parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { scatteredMountainsForSeed } from "../../src/grid/scattered_mountains";
import { AI_META_COHORTS, prepareMetaPair } from "../../src/simulation/ai_meta_cohorts_core";
import {
    PREMIUM_META_STUDY,
    PREMIUM_META_PRIVATE_SETUP_STUDY,
    PREMIUM_META_DRAFT_SPEC,
    premiumStudyChoice,
} from "../../src/simulation/ai_meta_study";

describe("Premium ranked collection profile", () => {
    it("accepts exact even pilot budgets only in Premium studies", () => {
        expect(() => validateAiMetaGamesPerCohort(500, true)).not.toThrow();
        expect(() => validateAiMetaGamesPerCohort(500)).toThrow();
        expect(() => validateAiMetaGamesPerCohort(501, true)).toThrow();
    });
    const options = {
        cohort: "ranked-draft" as const,
        games: 144,
        baseSeed: 85000717,
        collectEvidence: true,
        studyProfile: PREMIUM_META_STUDY,
    };

    it("retains live artifacts, obeys doctrine budgets, and samples only viewer-visible draft attempts", () => {
        const doctrines = new Set<number>();
        const genome = parseDraftGenome(PREMIUM_META_DRAFT_SPEC, "test");
        let collisions = 0;
        let setupPlanChanges = 0;
        for (let pair = 0; pair < 36; pair++) {
            const record = prepareMetaPair(options, pair);
            const privateRecord = prepareMetaPair({ ...options, studyProfile: PREMIUM_META_PRIVATE_SETUP_STUDY }, pair);
            setupPlanChanges +=
                Number(record.armyA.augment.planId !== privateRecord.armyA.augment.planId) +
                Number(record.armyB.augment.planId !== privateRecord.armyB.augment.planId);
            const evidence = record.evidence!;
            const draft = evidence.rankedDraft!;
            for (const [side, army] of [
                ["a", record.armyA],
                ["b", record.armyB],
            ] as const) {
                doctrines.add(army.doctrine);
                expect(army.artifactT1.id).toBe(draft.draftedArtifacts[side].tier1);
                expect(army.artifactT2.id).toBe(draft.draftedArtifacts[side].tier2);
                expect(army.artifactT1.source).toBe("draft-retained");
                expect(augmentPlanCost(army.augment.plan)).toBe(getUpgradePoints(army.doctrine));
                expect(evidence.setupObservations![side].knownOpponentCreatureIds).toEqual(
                    side === "a" ? record.armyB.creatureIds : record.armyA.creatureIds,
                );
                expect(evidence.setupObservations![side].opponentRosterVisibility).toBe("complete");
                for (const candidate of army.augment.evidence!.candidates)
                    expect(candidate.probability).toBeGreaterThan(0);
            }
            expect(evidence.geometry.orientation).toBe("ranked-sides");
            if (record.map === PBTypes.GridVals.BLOCK_CENTER)
                expect(evidence.geometry.mountainCells).toEqual(
                    scatteredMountainsForSeed(`sim-${record.combatSeed}`).map((stone) => stone.cell),
                );
            for (const decision of draft.decisions) {
                expect(
                    decision.choice!.candidates.reduce((sum, candidate) => sum + candidate.probability, 0),
                ).toBeCloseTo(1, 10);
                expect(decision.observation).not.toHaveProperty("right");
                if (decision.action.type !== "pick_creature") continue;
                collisions += Number(decision.status === "collision");
                const view = decision.observation;
                expect(decision.choice!.candidates.map(({ key }) => Number(key))).toEqual(view.availableCreatureIds);
                const preferred = pickRankedLiveDraftCreature(
                    genome,
                    view.availableCreatureIds,
                    view.creaturesPicked,
                    view.knownOpponentCreatures,
                    view.artifacts.find(([tier]) => tier === 1)?.[1],
                    view.revealedMap ?? undefined,
                    view.synergyVariants,
                );
                expect(Number(decision.choice!.candidates.find(({ score }) => score === 1)!.key)).toBe(preferred!);
            }
        }
        expect([...doctrines].sort()).toEqual([1, 2, 3]);
        expect(collisions).toBeGreaterThan(0);
        expect(setupPlanChanges).toBeGreaterThan(0);
    });

    it("keeps synthetic cohorts explicit and artifacts private while setup sees public identities", () => {
        for (const cohort of AI_META_COHORTS.filter((id) => id !== "ranked-draft")) {
            const first = prepareMetaPair({ ...options, cohort }, 2);
            expect(first).toEqual(prepareMetaPair({ ...options, cohort }, 2));
            expect(first.evidence!.rankedDraft).toBeNull();
            expect(first.evidence!.setupObservations!.a.knownOpponentCreatureIds).toEqual(first.armyB.creatureIds);
            const privateStudy = prepareMetaPair(
                { ...options, cohort, studyProfile: PREMIUM_META_PRIVATE_SETUP_STUDY },
                2,
            );
            expect(first.armyA.artifactT1).toEqual(privateStudy.armyA.artifactT1);
            expect(first.armyA.artifactT2).toEqual(privateStudy.armyA.artifactT2);
            expect(first.armyA.artifactT1.source).toBeUndefined();
        }
        expect(() => prepareMetaPair({ ...options, collectEvidence: false }, 0)).toThrow("requires evidence");
    });

    it("keeps historical private setup readable without changing draft-time visibility", () => {
        const legacy = prepareMetaPair({ ...options, studyProfile: PREMIUM_META_PRIVATE_SETUP_STUDY }, 0);
        const current = prepareMetaPair(options, 0);
        expect(current.evidence!.rankedDraft!.decisions).toEqual(legacy.evidence!.rankedDraft!.decisions);
        expect(legacy.evidence!.setupObservations!.a.knownOpponentCreatureIds).toEqual(
            legacy.evidence!.rankedDraft!.knownOpponentCreatureIds!.a,
        );
        expect(legacy.evidence!.setupVisibility).toBe("draft-reveals-only");
        expect(current.evidence!.setupVisibility).toBe("post-draft-public-roster");
        expect(Object.keys(current.evidence!.setupObservations!.a).sort()).toEqual([
            "knownOpponentCreatureIds",
            "opponentRosterVisibility",
        ]);
    });

    it("records full epsilon-greedy probabilities without consuming the offer stream", () => {
        for (let seed = 0; seed < 20; seed++) {
            const choice = premiumStudyChoice([3, 5, 7], 5, seed);
            expect(choice).toEqual(premiumStudyChoice([3, 5, 7], 5, seed));
            expect(choice.evidence.behaviorProbability).toBeCloseTo(choice.selected === 5 ? 0.8 + 0.2 / 3 : 0.2 / 3);
        }
    });
});
