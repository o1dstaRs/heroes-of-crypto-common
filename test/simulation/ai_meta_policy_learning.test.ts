import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
    metaFormationProposals,
    sampleMetaFormation,
    validateMetaFormationDecision,
    type IMetaFormationInput,
} from "../../src/simulation/ai_meta_formation_learning";
import { prepareMetaPair, AI_META_MAPS, type IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import { validateAiMetaEvidence } from "../../src/simulation/ai_meta_evidence";
import {
    PREMIUM_META_POLICY_LEARNING_STUDY,
    PREMIUM_META_POLICY_LEARNING_SCHEMA,
    PREMIUM_META_FULL_AUGMENTS_STUDY,
} from "../../src/simulation/ai_meta_study";
import { premiumLearningDecisions } from "../../src/simulation/premium_learning_decisions";
import { resolveAiMetaFightProfile, runAiMetaWorkerPool } from "../../src/simulation/measure_ai_meta_cohorts";
import { finalizeAiMetaOutputs } from "../../src/simulation/ai_meta_outputs";
import { PremiumEvidenceSnapshot } from "../../src/simulation/premium_evidence_snapshot";
import { auditPremiumEvidence } from "../../src/simulation/audit_premium_evidence";
import { aiMetaMatchConfig, capturePremiumFight } from "../../src/simulation/ai_meta_cohorts_pair";
import { AI_META_REGISTERED_VERSION_STRATEGY_PROFILE } from "../../src/simulation/ai_meta_strategy_profile";
import { AI_META_OFFLINE_SEARCH_ENVIRONMENT } from "../../src/simulation/ai_meta_search_budget";

const options = {
    cohort: "ranked-draft" as const,
    games: 6,
    baseSeed: 3092307116,
    collectEvidence: true,
    lockedV09Draft: true,
    studyProfile: PREMIUM_META_POLICY_LEARNING_STUDY,
};
const source = "a".repeat(64);
let folder: string;
let captured: IAiMetaPairRecord;
let summaryPath: string;

const formation = (): IMetaFormationInput => ({
    team: 1,
    gridType: 1,
    legalCells: Array.from({ length: 4 }, (_, x) => Array.from({ length: 16 }, (_, y) => ({ x, y }))).flat(),
    units: [
        { unitId: "wide", creatureName: "rectangle", amount: 2, width: 3, height: 2, cell: { x: 2, y: 4 } },
        { unitId: "small", creatureName: "small", amount: 100, width: 1, height: 1, cell: { x: 3, y: 12 } },
    ],
});

describe("prospective Premium learning capture", () => {
    it("explores all legal hybrid draft offers, preserves hidden-pick collisions and keeps old collections deterministic", () => {
        let alternatives = 0;
        let collisions = 0;
        for (let pair = 0; pair < 54; pair++) {
            const record = prepareMetaPair({ ...options, games: 108 }, pair);
            for (const decision of record.evidence!.rankedDraft!.decisions) {
                expect(decision.choice!.candidates.every((candidate) => candidate.probability > 0)).toBe(true);
                expect(
                    decision.choice!.candidates.reduce((sum, candidate) => sum + candidate.probability, 0),
                ).toBeCloseTo(1, 10);
                alternatives += Number(
                    decision.action.type !== "select_doctrine" && decision.choice!.behaviorProbability < 0.8,
                );
                collisions += Number(decision.status === "collision");
            }
            const legacy = prepareMetaPair(
                { ...options, games: 108, studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY },
                pair,
            );
            expect(
                legacy
                    .evidence!.rankedDraft!.decisions.filter((d) => d.action.type !== "select_doctrine")
                    .every((d) => d.behaviorProbability === 1),
            ).toBe(true);
        }
        expect(alternatives).toBeGreaterThan(30);
        expect(collisions).toBeGreaterThan(0);
    });

    it("reflects whole footprints, deduplicates exact actions, and never mutates its inputs", () => {
        const input = formation();
        const before = JSON.stringify(input);
        const proposals = metaFormationProposals(input);
        expect(proposals).toHaveLength(4);
        expect(proposals[1].positions[0].cell).toEqual({ x: 3, y: 4 });
        expect(proposals[2].positions[0].cell).toEqual({ x: 2, y: 12 });
        const choices = new Set<string>();
        for (let seed = 0; seed < 200; seed++) {
            const decision = sampleMetaFormation(input, seed);
            validateMetaFormationDecision(decision);
            choices.add(decision.selectedKey);
            expect(decision.choice.candidates.map((c) => c.probability)).toEqual([0.8 + 0.2 / 4, 0.05, 0.05, 0.05]);
        }
        expect(choices.size).toBe(4);
        expect(JSON.stringify(input)).toBe(before);
        const single = { ...input, legalCells: [{ x: 0, y: 0 }], units: [{ ...input.units[1], cell: { x: 0, y: 0 } }] };
        expect(metaFormationProposals(single)).toHaveLength(1);
        expect(sampleMetaFormation(single, 1).choice.behaviorProbability).toBe(1);
        const overlap = formation();
        overlap.units[1].cell = { ...overlap.units[0].cell };
        expect(() => metaFormationProposals(overlap)).toThrow("illegal");
        const altered = sampleMetaFormation(input, 1);
        altered.choice.candidates[0].probability = 1;
        expect(() => validateMetaFormationDecision(altered)).toThrow("probabilities");
        expect(() => metaFormationProposals({ ...input, hiddenEnemyPositions: [] } as IMetaFormationInput)).toThrow(
            "private inputs",
        );
    });
});

beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "hoc-policy-learning-"));
    await runAiMetaWorkerPool(
        options,
        1,
        resolveAiMetaFightProfile("v09-draft-a19-work"),
        (record) => {
            captured = record;
        },
        { pairCount: 1 },
    );
    const name = "ranked-draft.pairs.jsonl.gz";
    writeFileSync(join(folder, name), gzipSync(JSON.stringify(captured) + "\n"));
    summaryPath = join(folder, "ai-meta.captured-summary.json");
    writeFileSync(
        summaryPath,
        JSON.stringify({
            schemaVersion: 1,
            complete: true,
            provenance: {
                sourceSha256: source,
                baseSeed: options.baseSeed,
                commonDirty: true,
                maps: AI_META_MAPS,
                gamesPerCohort: 2,
                pairWindow: { start: 0, count: 1, fullPairCount: 1 },
                totalPairs: 1,
                totalGames: 2,
                fightProfile: {
                    studyProfile: PREMIUM_META_POLICY_LEARNING_STUDY,
                    evidenceSchema: PREMIUM_META_POLICY_LEARNING_SCHEMA,
                    searchBudget: "offline-deterministic-work",
                },
            },
            cohorts: [
                {
                    cohort: "ranked-draft",
                    rawPath: name,
                    pairs: 1,
                    games: 2,
                    rejectedActions: 0,
                    distinctRosterViolations: 0,
                    overlappingCreatureViolations: 0,
                    mapGames: { [captured.map]: 2 },
                },
            ],
        }),
    );
}, 180_000);
afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
});

it("the identity collection hook preserves actual placement, artifacts, actions, health and RNG", () => {
    const config = {
        ...aiMetaMatchConfig(
            captured.armyA,
            captured.armyB,
            captured.combatSeed,
            captured.map,
            AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
            captured.evidence!.synergyVariants,
            true,
        ),
        maxLaps: 2,
        searchOfflineDeterministicWork: true,
        headlessEvents: false,
        researchA19BaseSearchEnvironment: AI_META_OFFLINE_SEARCH_ENVIRONMENT,
    };
    const baseline = capturePremiumFight(config, true);
    let invocations = 0;
    const identity = capturePremiumFight(
        {
            ...config,
            researchFormationSelector: (input) => {
                invocations++;
                return new Map(input.units.map((unit) => [unit.unitId, unit.cell]));
            },
        },
        true,
    );
    expect(invocations).toBe(2);
    expect(identity.result.placements).toEqual(baseline.result.placements);
    expect(identity.result.outcome).toEqual(baseline.result.outcome);
    expect(identity.result.actions).toEqual(baseline.result.actions);
    expect(identity.firstDecisionState).toEqual(baseline.firstDecisionState);
    expect(identity.healthLedger).toEqual(baseline.healthLedger);
    expect(identity.executionTrace).toEqual(baseline.executionTrace);
}, 120_000);

it("checks exact applied choices, privacy, distributions, labels and non-promoted SQLite finalization", async () => {
    validateAiMetaEvidence(captured);
    const rows = premiumLearningDecisions(captured);
    expect(rows.filter((row) => row.kind === "formation")).toHaveLength(4);
    expect(rows.filter((row) => row.kind === "augment")).toHaveLength(2);
    for (const row of rows) {
        expect(row.observedScore).toBeGreaterThanOrEqual(0);
        expect(row.observedScore).toBeLessThanOrEqual(1);
        expect(row.observation).not.toHaveProperty("outcome");
        expect(row.observation).not.toHaveProperty("opponentArtifacts");
        expect(row.observation).not.toHaveProperty("combatSeed");
        expect(row.distribution.candidates.every((candidate) => candidate.probability > 0)).toBe(true);
    }
    const wrong = structuredClone(captured);
    wrong.evidence!.fights![0].formationChoices!.a.selectedKey = "not-played";
    expect(() => validateAiMetaEvidence(wrong)).toThrow();
    const leaked = structuredClone(captured);
    leaked.evidence!.rankedDraft!.decisions[2].observation.knownOpponentCreatures = [1, 2, 3, 4, 5, 6];
    expect(() => validateAiMetaEvidence(leaked)).toThrow("viewer-safe");
    const receipt = await finalizeAiMetaOutputs(summaryPath);
    expect(receipt.complete).toBe(true);
    expect(receipt.modelsPromoted).toBe(false);
    expect(receipt.snapshot.capabilities).toContain("policy-learning-decisions-v1");
    const path = join(folder, "premium.sqlite");
    const reader = new PremiumEvidenceSnapshot(path, source, { allowDevelopment: true });
    const expected = captured.evidence!.partition === "train" ? rows.filter((row) => row.kind === "augment") : [];
    expect([...reader.trainingDecisions("ranked-draft", "augment")]).toEqual(expected);
    expect(() => [...reader.trainingDecisions("unknown" as never, "augment")]).toThrow();
    reader.close();
    const db = new Database(path);
    db.exec("UPDATE family SET partition='test'");
    const hidden = new PremiumEvidenceSnapshot(path, source, { allowDevelopment: true });
    expect([...hidden.trainingDecisions("ranked-draft", "draft")]).toEqual([]);
    hidden.close();
    db.exec(
        "UPDATE family SET partition='train'; UPDATE learning_decision SET payload=json_set(payload,'$.observedScore',0.123456) WHERE kind='augment'",
    );
    db.close();
    await expect(auditPremiumEvidence(summaryPath, path)).rejects.toThrow("Learning index disagrees");
    expect(JSON.parse(readFileSync(join(folder, "ai-meta.outputs.json"), "utf8")).complete).toBe(true);
}, 180_000);
