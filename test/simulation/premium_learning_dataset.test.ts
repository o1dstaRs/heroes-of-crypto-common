import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { enumeratePremiumAugmentPlans, premiumAugmentPlanId } from "../../src/ai/setup/premium_augment_plans";
import { aiMetaChoiceEvidence } from "../../src/simulation/ai_meta_evidence";
import { sampleMetaFormation, type IMetaFormationInput } from "../../src/simulation/ai_meta_formation_learning";
import { exportPremiumTrainingDataset } from "../../src/simulation/export_premium_training";
import {
    PremiumEvidenceSnapshot,
    PREMIUM_SNAPSHOT_SCHEMA,
    PREMIUM_SNAPSHOT_SQL,
} from "../../src/simulation/premium_evidence_snapshot";
import { premiumLearningInput, premiumTrainingExample } from "../../src/simulation/premium_learning_dataset";
import {
    PREMIUM_LEARNING_DECISION_SCHEMA,
    type IPremiumLearningDecision,
} from "../../src/simulation/premium_learning_decisions";

const sourceSha = "a".repeat(64);
const variants = { Life: 1, Nature: 2, Chaos: 1, Might: 2 };
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function draft(): IPremiumLearningDecision {
    return {
        schema: PREMIUM_LEARNING_DECISION_SCHEMA,
        familyId: "audit-only-family",
        side: "a",
        kind: "draft",
        index: 4,
        physicalTeam: 0,
        observedScore: 0.5,
        labelScope: "seat-paired-army",
        executionContract: "headless-meta-ranked-sides-not-server-qualified",
        evidenceKind: "logged-policy-outcome-not-paired-alternative",
        selectedKey: "11",
        status: "collision",
        action: { type: "pick_creature", team: 2, creatureId: 11 },
        observation: {
            phaseSequence: 2,
            phase: 3,
            actors: [2],
            requiredCreatureLevel: 1,
            complete: false,
            creaturesBanned: [31],
            creaturesPicked: [22, 26],
            knownOpponentCreatures: [],
            doctrine: 3,
            bundles: [],
            tier2Offers: [],
            artifacts: [[1, 4]],
            availableCreatureIds: [1, 11],
            revealedOpponentSlots: [],
            revealedMap: null,
            synergyVariants: { ...variants },
        },
        distribution: aiMetaChoiceEvidence(
            [
                { key: "1", score: 1 },
                { key: "11", score: 0 },
            ],
            "1",
            "11",
            "explore",
            0.2,
        ),
    };
}
function setup(): IPremiumLearningDecision {
    const plans = enumeratePremiumAugmentPlans(5);
    const key = premiumAugmentPlanId(plans[0]);
    return {
        ...draft(),
        kind: "augment",
        index: 0,
        selectedKey: key,
        status: "accepted",
        action: { ...plans[0] },
        observation: {
            phase: "public-setup-before-spending",
            cohort: "ranked-draft",
            map: 1,
            ownCreatureIds: [1],
            ownRoster: [{ faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 100 }],
            knownOpponentCreatureIds: [13],
            opponentRosterVisibility: "complete",
            doctrine: 2,
            budget: 5,
            artifactT1: 1,
            artifactT2: 2,
            synergyVariants: { ...variants },
        },
        distribution: aiMetaChoiceEvidence(
            plans.map((plan) => ({ key: premiumAugmentPlanId(plan), score: 0 })),
            key,
            key,
            "exploit",
            0.2,
        ),
    };
}
function formation(): IPremiumLearningDecision {
    const geometry: IMetaFormationInput = {
        team: 2,
        gridType: 1,
        legalCells: Array.from({ length: 4 }, (_, x) => Array.from({ length: 4 }, (_, y) => ({ x, y }))).flat(),
        units: [
            {
                unitId: "opaque-seed-derived-id",
                creatureName: "Orc",
                amount: 100,
                width: 1,
                height: 1,
                cell: { x: 0, y: 0 },
            },
        ],
    };
    const choice = sampleMetaFormation(geometry, 4);
    const row = setup();
    return {
        ...row,
        kind: "formation",
        physicalTeam: 2,
        labelScope: "single-fight-army",
        observation: { ...row.observation, phase: "formation-after-spending", augments: [], geometry },
        selectedKey: choice.selectedKey,
        distribution: choice.choice,
        action: choice.proposals.find(({ key }) => key === choice.selectedKey)!,
        candidateActions: choice.proposals,
    };
}

describe("model input boundary", () => {
    it("keeps legal visibility and every alternative while excluding outcomes, sampled branch and identity", () => {
        const row = draft();
        const before = structuredClone(row);
        const example = premiumTrainingExample(row);
        expect(example.input.observation.knownOpponentCreatures).toEqual([]);
        expect(example.input.observation.revealedMap).toBeNull();
        expect(example.input.candidates).toEqual([
            { key: "1", action: { creatureId: 1 } },
            { key: "11", action: { creatureId: 11 } },
        ]);
        expect(example.logged.status).toBe("collision");
        expect(example.logged.probabilities).toEqual([
            { key: "1", probability: 0.9 },
            { key: "11", probability: 0.1 },
        ]);
        const changed = structuredClone(row);
        changed.familyId = "different-family";
        changed.observedScore = 1;
        changed.index = 22;
        changed.status = "accepted";
        changed.selectedKey = "1";
        changed.action = { type: "pick_creature", team: 2, creatureId: 1 };
        changed.distribution = aiMetaChoiceEvidence(
            [
                { key: "1", score: -10 },
                { key: "11", score: 50 },
            ],
            "11",
            "1",
            "explore",
            0.2,
        );
        expect(premiumLearningInput(changed)).toEqual(example.input);
        expect(row).toEqual(before);
        expect(JSON.stringify(example.input)).not.toMatch(/observedScore|selectedKey|probability|audit-only|status/);
    });

    it("resolves bundle indices to their offered tuples and retains uniform doctrine choice", () => {
        const row = draft();
        row.status = "accepted";
        row.observation.bundles = [
            [12, 53, 10],
            [22, 26, 4],
        ];
        row.action = { type: "select_bundle", team: 2, bundleIndex: 1 };
        row.selectedKey = "1";
        row.distribution = aiMetaChoiceEvidence(
            [
                { key: "0", score: 1 },
                { key: "1", score: 0 },
            ],
            "0",
            "1",
            "explore",
            0.2,
        );
        expect(premiumTrainingExample(row).input.candidates[1].action).toEqual({ bundleIndex: 1, bundle: [22, 26, 4] });
        row.action = { type: "select_tier2", team: 2, artifactId: 1 };
        row.observation.tier2Offers = [0, 1];
        expect(premiumTrainingExample(row).input.candidates[1].action).toEqual({ artifactId: 1 });
        row.action = { type: "select_doctrine", team: 2, doctrine: 1 };
        row.distribution = aiMetaChoiceEvidence(
            [1, 2, 3].map((id) => ({ key: String(id), score: 0 })),
            "1",
            "1",
            "explore",
            1,
        );
        expect(premiumTrainingExample(row).logged.probabilities.every(({ probability }) => probability === 1 / 3)).toBe(
            true,
        );
    });

    it("rejects unexpected nested/private fields and impossible alternatives", () => {
        for (const extra of ["outcome", "combatSeed", "opponentArtifacts", "hiddenRoster"]) {
            const row = draft();
            row.observation[extra] = 1;
            expect(() => premiumTrainingExample(row)).toThrow("observation fields");
        }
        const nested = draft();
        (nested.observation.synergyVariants as Record<string, number>).futureScore = 1;
        expect(() => premiumTrainingExample(nested)).toThrow("observation fields");
        const illegal = draft();
        illegal.observation.availableCreatureIds = [1];
        expect(() => premiumTrainingExample(illegal)).toThrow("Unknown creature offer");
        const privateSetup = setup();
        privateSetup.observation.opponentRosterVisibility = "partial";
        expect(() => premiumTrainingExample(privateSetup)).toThrow("visibility");
    });

    it("resolves funded plans without model inputs depending on cohort labels", () => {
        const row = setup();
        const input = premiumTrainingExample(row).input;
        expect(input.candidates.length).toBeGreaterThan(100);
        expect(input.candidates[0].action).toEqual(row.action);
        expect(input.observation).not.toHaveProperty("cohort");
        row.observation.cohort = "ranged-heavy";
        expect(premiumLearningInput(row)).toEqual(input);
    });

    it("remaps opaque stack IDs to stable slots and preserves all candidate geometry", () => {
        const row = formation();
        const before = structuredClone(row);
        const input = premiumTrainingExample(row).input;
        expect(input.candidates).toHaveLength(4);
        expect(JSON.stringify(input)).not.toContain("opaque-seed-derived-id");
        expect((input.observation.geometry as { units: unknown[] }).units).toEqual([
            { slot: 0, creatureName: "Orc", amount: 100, width: 1, height: 1, cell: { x: 0, y: 0 } },
        ]);
        const renamed = JSON.parse(JSON.stringify(row).replaceAll("opaque-seed-derived-id", "different-opaque-id"));
        expect(premiumTrainingExample(renamed).input).toEqual(input);
        expect(row).toEqual(before);
        const wrong = structuredClone(row);
        (wrong.candidateActions as { positions: { cell: { x: number } }[] }[])[1].positions[0].cell.x = 90;
        expect(() => premiumTrainingExample(wrong)).toThrow("Formation candidates");
    });

    it("rejects corrupt probabilities, labels and selected actions", () => {
        const badProbability = draft();
        badProbability.distribution.behaviorProbability = 0.5;
        expect(() => premiumTrainingExample(badProbability)).toThrow("probabilities");
        const duplicate = draft();
        duplicate.distribution.candidates[1].key = "1";
        expect(() => premiumTrainingExample(duplicate)).toThrow("probabilities");
        const label = draft();
        label.observedScore = Number.NaN;
        expect(() => premiumTrainingExample(label)).toThrow("label scope");
        const action = draft();
        action.action = { type: "pick_creature", team: 2, creatureId: 1 };
        expect(() => premiumTrainingExample(action)).toThrow("logged key");
        const augment = setup();
        (augment.action as Record<string, number>).empower = 99;
        expect(() => premiumTrainingExample(augment)).toThrow("logged key");
        const placement = formation();
        placement.action = placement.candidateActions!.find(
            (value) => (value as { key: string }).key !== placement.selectedKey,
        );
        expect(() => premiumTrainingExample(placement)).toThrow("logged key");
    });
});

function makeDatabase(path: string) {
    const db = new Database(path);
    db.exec(PREMIUM_SNAPSHOT_SQL);
    db.query("INSERT INTO metadata VALUES('manifest',?)").run(
        JSON.stringify({
            schema: PREMIUM_SNAPSHOT_SCHEMA,
            snapshotId: "synthetic",
            sourceSha256: sourceSha,
            studyProfile: "premium-ranked-v4",
            status: "development",
            capabilities: ["policy-learning-decisions-v1"],
            provenance: { synthetic: true },
        }),
    );
    db.query("INSERT INTO source VALUES(1,'synthetic','source-hash',4)").run();
    for (let family = 1; family <= 4; family++) {
        const id = `family-${family}`;
        const partition = family <= 2 ? "train" : family === 3 ? "validation" : "test";
        db.query("INSERT INTO family VALUES(?,'ranked-draft',?,1,?,1,?)").run(id, family, partition, family);
        db.query("INSERT INTO army VALUES(?,?,'a',0.5,3,1,1,'plan')").run(family, id);
        for (let index = 0; index < (family === 1 ? 3 : 1); index++) {
            const row = draft();
            row.familyId = id;
            row.index = index;
            // Held-out poison must never reach the projector, even for a coverage report.
            if (partition !== "train") row.observation.hiddenFuture = "held-out-only";
            db.query("INSERT INTO learning_decision VALUES(?,?,'draft',?,0,'11',0.1,?)").run(
                id,
                family,
                index,
                JSON.stringify(row),
            );
        }
    }
    db.close();
}

it("exports only training, preserves collisions, balances whole families and refuses mismatched/overwritten artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "hoc-learning-export-"));
    try {
        const path = join(root, "premium.sqlite");
        makeDatabase(path);
        const before = hash(path);
        const output = join(root, "export");
        const receipt = await exportPremiumTrainingDataset(path, sourceSha, before, output);
        expect(receipt.rows).toBe(4);
        expect(receipt.families).toBe(2);
        expect(receipt.heldOutRows).toBe(0);
        const rows = gunzipSync(readFileSync(join(output, "training.jsonl.gz")))
            .toString()
            .trim()
            .split("\n")
            .map((text) => JSON.parse(text));
        expect(rows.every((row) => row.audit.partition === "train" && row.logged.status === "collision")).toBe(true);
        for (const id of ["family-1", "family-2"])
            expect(
                rows
                    .filter((row) => row.audit.familyId === id)
                    .reduce((sum, row) => sum + row.weighting.familyStageWeight, 0),
            ).toBeCloseTo(1, 12);
        const pooled = receipt.coverage.find((entry) => entry.doctrineAtDecision === null)!;
        expect(pooled.collisions).toBe(4);
        expect(pooled.neverSelectedKeys).toBe(1);
        expect(pooled.actions.find((entry) => entry.key === "11")).toEqual({
            key: "11",
            offeredFamilies: 2,
            selectedFamilies: 2,
            selectedRows: 4,
        });
        expect(hash(path)).toBe(before);
        await expect(
            exportPremiumTrainingDataset(path, sourceSha, "f".repeat(64), join(root, "bad-hash")),
        ).rejects.toThrow("SHA256");
        await expect(
            exportPremiumTrainingDataset(path, "b".repeat(64), before, join(root, "bad-source")),
        ).rejects.toThrow("Incompatible");
        await expect(exportPremiumTrainingDataset(path, sourceSha, before, output)).rejects.toThrow();
        const db = new Database(path);
        db.exec(
            "UPDATE learning_decision SET payload=json_set(payload,'$.familyId','spoofed') WHERE family_id='family-1'",
        );
        db.close();
        const reader = new PremiumEvidenceSnapshot(path, sourceSha, { allowDevelopment: true });
        try {
            expect(() => [...reader.trainingDecisions("ranked-draft", "draft")]).toThrow("indexed family");
        } finally {
            reader.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
