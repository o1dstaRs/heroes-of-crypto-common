import { describe, expect, it } from "bun:test";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { aiMetaChoiceEvidence, AI_META_EVIDENCE_SCHEMA } from "../../src/simulation/ai_meta_evidence";
import { AI_META_COHORTS, prepareMetaPair, type IAiMetaRunOptions } from "../../src/simulation/ai_meta_cohorts_core";
import { playMetaPair } from "../../src/simulation/ai_meta_cohorts_pair";
import { AI_META_REGISTERED_VERSION_STRATEGY_PROFILE } from "../../src/simulation/ai_meta_strategy_profile";
import { runAiMetaWorkerPool, resolveAiMetaFightProfile } from "../../src/simulation/measure_ai_meta_cohorts";
import { validateAiMetaEvidence } from "../../src/simulation/ai_meta_evidence";
import type { IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";

const options: IAiMetaRunOptions = { cohort: "ranked-draft", games: 72, baseSeed: 85000717, collectEvidence: true };

function withoutEvidence(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutEvidence);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "evidence")
                .map(([key, entry]) => [key, withoutEvidence(entry)]),
        );
    return value;
}

describe("premium cohort evidence", () => {
    it("preserves sampled rosters, artifacts, augments and RNG draws in every cohort", () => {
        for (const cohort of AI_META_COHORTS)
            for (let pair = 0; pair < 12; pair += 1) {
                const withEvidence = prepareMetaPair({ ...options, cohort }, pair);
                const legacy = prepareMetaPair({ ...options, cohort, collectEvidence: false }, pair);
                expect(withoutEvidence(withEvidence)).toEqual(legacy);
                expect(withEvidence.evidence?.schema).toBe(AI_META_EVIDENCE_SCHEMA);
                expect(Object.keys(withEvidence.evidence!.synergyVariants)).toHaveLength(4);
                for (const army of [withEvidence.armyA, withEvidence.armyB]) {
                    for (const choice of [army.artifactT1, army.artifactT2, army.augment]) {
                        const evidence = choice.evidence!;
                        expect(evidence.candidates.reduce((total, item) => total + item.probability, 0)).toBeCloseTo(
                            1,
                            12,
                        );
                        const key = "id" in choice ? String(choice.id) : choice.planId;
                        expect(evidence.behaviorProbability).toBe(
                            evidence.candidates.find((item) => item.key === key)!.probability,
                        );
                    }
                }
            }
    });

    it("captures simultaneous offers before either commit and excludes hidden enemy picks", () => {
        const prepared = prepareMetaPair(options, 0);
        const draft = prepared.evidence!.rankedDraft!;
        expect(draft.outcomeContinuation).toBe("post-draft-artifact-and-augment-oracle");
        const bundles = draft.decisions.filter(({ action }) => action.type === "select_bundle");
        expect(bundles).toHaveLength(2);
        for (const decision of bundles) {
            expect(decision.observation.phaseSequence).toBe(1);
            expect(decision.observation.creaturesPicked).toEqual([]);
            expect(decision.observation.knownOpponentCreatures).toEqual([]);
            expect(decision.observation.bundles).toHaveLength(2);
            expect(decision.observation.revealedMap).toBeNull();
        }
        const artifactDecisions = draft.decisions.filter(({ action }) => action.type === "select_tier2");
        expect(artifactDecisions).toHaveLength(2);
        for (const decision of artifactDecisions) {
            expect(decision.observation.creaturesPicked).toHaveLength(5);
            expect(decision.observation.tier2Offers).toHaveLength(3);
        }
        for (const decision of draft.decisions) {
            expect(decision.observation).not.toHaveProperty("left");
            expect(decision.observation).not.toHaveProperty("right");
            if (decision.action.type === "pick_creature")
                expect(decision.observation.availableCreatureIds).toContain(decision.action.creatureId);
            expect(decision.observation.synergyVariants).toEqual(prepared.evidence!.synergyVariants);
        }
        expect(draft.transcript.length).toBe(draft.decisions.length);
    });

    it("keeps scenario partition stable across map interventions and records the actual revealed map", () => {
        const normal = prepareMetaPair(options, 1, PBTypes.GridVals.NORMAL);
        const lava = prepareMetaPair(options, 1, PBTypes.GridVals.LAVA_CENTER);
        expect(normal.evidence!.scenarioId).toBe(lava.evidence!.scenarioId);
        expect(normal.evidence!.partition).toBe(lava.evidence!.partition);
        for (const decision of normal.evidence!.rankedDraft!.decisions) {
            expect(decision.observation.revealedMap).toBe(
                decision.observation.phaseSequence >= 6 ? PBTypes.GridVals.NORMAL : null,
            );
        }
        expect(prepareMetaPair({ ...options, cohort: "uniform-mixed" }, 1).evidence!.rankedDraft).toBeNull();
    });

    it("counts both epsilon-greedy paths when exploration happens to draw the preferred action", () => {
        const candidates = [
            { key: "best", score: 5 },
            { key: "other", score: 1 },
        ];
        const evidence = aiMetaChoiceEvidence(candidates, "best", "best", "explore", 0.2);
        expect(evidence.behaviorProbability).toBeCloseTo(0.9);
        expect(evidence.branchProbability * evidence.conditionalProbability).toBeCloseTo(0.1);
        expect(aiMetaChoiceEvidence(candidates, "best", "other", "explore", 1).behaviorProbability).toBe(0.5);
        expect(() => aiMetaChoiceEvidence(candidates, "best", "other", "exploit", 0.2)).toThrow();
    });

    it("rejects evidence capture with a wall-clock search profile", () => {
        expect(() => playMetaPair(options, 0, AI_META_REGISTERED_VERSION_STRATEGY_PROFILE)).toThrow(
            "requires a19-work",
        );
    });

    it("captures real worker fights and formations without changing deterministic battle outcomes", async () => {
        const profile = resolveAiMetaFightProfile("a19-work");
        const run = async (collectEvidence: boolean): Promise<IAiMetaPairRecord> => {
            let captured: IAiMetaPairRecord | undefined;
            await runAiMetaWorkerPool(
                { ...options, collectEvidence },
                1,
                profile,
                (record) => {
                    captured = record;
                },
                { pairCount: 1 },
            );
            return captured!;
        };
        const captured = await run(true);
        const legacy = await run(false);
        expect(withoutEvidence(captured)).toEqual(legacy);
        validateAiMetaEvidence(captured);
        expect(captured.evidence!.fights![0].actions.length).toBeGreaterThan(0);
        expect(captured.evidence!.fights![1].formations.a.placements.length).toBeGreaterThan(0);
        const corrupted = structuredClone(captured);
        corrupted.evidence!.fights![0].formations.a.expandedRoster[0].amount += 1;
        expect(() => validateAiMetaEvidence(corrupted)).toThrow("conserve");
    }, 180_000);
});
