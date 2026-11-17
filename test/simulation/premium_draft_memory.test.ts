import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createDraftOpponentMemory, type IDraftMemoryInput } from "../../src/ai/setup/draft_opponent_memory";
import { createHistoricalDraftObserver } from "../../src/ai/setup/draft_opponent_view";
import {
    createFeasibleDraftOpponentMemory,
    projectDraftOccupancy,
    publicDraftOccupiedOfferCount,
} from "../../src/ai/setup/draft_opponent_occupancy";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    createPickSimState,
    getCurrentPickPhase,
    getPickScoutingContext,
    getPickTeamView,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionServerPersistedPickSim,
    type PickAction,
} from "../../src/picks/pick_sim";
import { aiMetaChoiceEvidence } from "../../src/simulation/ai_meta_evidence";
import { exportPremiumDraftMemory } from "../../src/simulation/export_premium_draft_memory";
import {
    premiumDraftOpponentExamples,
    type IPremiumDraftHistoryRow,
} from "../../src/simulation/premium_draft_memory_dataset";
import {
    draftMemoryFold,
    draftMemoryInput,
    fitPremiumDraftMemory,
    validatePremiumDraftMemory,
} from "../../src/simulation/premium_draft_memory_fit";
import {
    PremiumEvidenceSnapshot,
    PREMIUM_SNAPSHOT_SCHEMA,
    PREMIUM_SNAPSHOT_SQL,
} from "../../src/simulation/premium_evidence_snapshot";

const sourceSha256 = "a".repeat(64);
const snapshotSha256 = "b".repeat(64);
const provenance = { sourceSha256, snapshotSha256 };

/** Native draft transitions only. No battle engine, outcomes or hidden-info policy. */
function history(seed: number, doctrine: Doctrine = Doctrine.SEE_NONE): IPremiumDraftHistoryRow[] {
    let random = seed;
    const rng = (max: number) => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0) % max;
    let state = createPickSimState(rng);
    const rows: IPremiumDraftHistoryRow[] = [];
    while (!isPickSimComplete(state)) {
        const phase = getCurrentPickPhase(state);
        const team = phase.actors.find((actor) => {
            const own = actor === PBTypes.TeamVals.LEFT ? state.left : state.right;
            return state.phaseSequence === 0
                ? !own.doctrine
                : state.phaseSequence === 1
                  ? own.selectedBundleIndex === undefined
                  : state.phaseSequence === 8
                    ? own.tier2Artifact === undefined
                    : true;
        })!;
        const own = team === PBTypes.TeamVals.LEFT ? state.left : state.right;
        const available = getVisibleCreatureChoices(state, team);
        let action: PickAction;
        let candidates: number[];
        let selected: number;
        if (state.phaseSequence === 0) {
            selected = doctrine;
            candidates = [1, 2, 3];
            action = { type: "select_doctrine", team, doctrine };
        } else if (state.phaseSequence === 1) {
            selected = 0;
            candidates = [0, 1];
            action = { type: "select_bundle", team, bundleIndex: selected };
        } else if (state.phaseSequence === 8) {
            selected = own.tier2Offers[0];
            candidates = [...own.tier2Offers];
            action = { type: "select_tier2", team, artifactId: selected };
        } else {
            selected = available[0];
            candidates = available;
            action = { type: "pick_creature", team, creatureId: selected };
        }
        const observation = {
            ...getPickTeamView(state, team),
            availableCreatureIds: available,
            revealedOpponentSlots: [...own.revealedOpponentSlots],
            revealedMap: getPickScoutingContext(state, team, 1).map ?? null,
            synergyVariants: { Life: 1, Nature: 1, Chaos: 1, Might: 1 },
        };
        const transition = transitionServerPersistedPickSim(state, action, rng);
        if (transition.status === "rejected") throw new Error(`Synthetic draft rejected: ${transition.reason}`);
        rows.push({
            familyId: `family-${seed}`,
            side: team === PBTypes.TeamVals.LEFT ? "a" : "b",
            partition: "train",
            snapshotId: "fixture",
            decision: {
                index: rows.length,
                observation,
                action,
                status: transition.status,
                behaviorProbability: 1,
                choice: aiMetaChoiceEvidence(
                    candidates.map((id) => ({ key: String(id), score: 0 })),
                    String(selected),
                    String(selected),
                    "exploit",
                    0,
                ),
            },
        });
        state = transition.state;
        if (rows.length > 100) throw new Error("Draft did not terminate");
    }
    return rows;
}

describe("historical draft memory preparation", () => {
    it("routes the pinned memory through the actual public draft view without changing choices or using private extras", () => {
        const histories = Array.from({ length: 12 }, (_, i) => history(i + 1500));
        const model = fitPremiumDraftMemory(histories.flatMap(premiumDraftOpponentExamples), provenance);
        const observe = createHistoricalDraftObserver(model);
        const offline = createFeasibleDraftOpponentMemory(model);
        const sameBeliefs = (actual: ReturnType<typeof observe>, expected: ReturnType<typeof offline>) => {
            expect(actual).not.toBeNull();
            expect(actual!.revision).toBe(expected!.revision);
            expect(actual!.occupiedOffers).toBe(expected!.occupiedOffers);
            expect(actual!.beliefs.length).toBe(expected!.beliefs.length);
            for (let i = 0; i < actual!.beliefs.length; i++) {
                const a = actual!.beliefs[i],
                    b = expected!.beliefs[i];
                expect([a.creatureId, a.families, a.contextFamilies, a.exact]).toEqual([
                    b.creatureId,
                    b.families,
                    b.contextFamilies,
                    b.exact,
                ]);
                for (const key of [
                    "priorProbability",
                    "occupiedProbability",
                    "unconstrainedProbability",
                    "feasiblePriorProbability",
                ] as const)
                    expect(a[key]).toBeCloseTo(b[key], 12);
            }
        };
        for (const doctrine of [Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE]) {
            const rows = history(1701, doctrine);
            const before = structuredClone(rows);
            for (const example of premiumDraftOpponentExamples(rows)) {
                const row = rows[example.audit.index];
                const view = row.decision.observation;
                const expected = offline(draftMemoryInput(example.input), view.creaturesBanned);
                sameBeliefs(observe(view, row.decision.action.team), expected);
                const extras = { ...view, hiddenEnemyRoster: [1, 2, 3], outcome: 1, combatSeed: 99 };
                sameBeliefs(observe(extras, row.decision.action.team), expected);
                if (doctrine !== Doctrine.SEE_ALL && view.phaseSequence < 6)
                    sameBeliefs(observe({ ...extras, revealedMap: 4 }, row.decision.action.team), expected);
                if (view.phaseSequence >= 6) {
                    const changedInput = draftMemoryInput(example.input);
                    changedInput.map = 4;
                    sameBeliefs(
                        observe({ ...view, revealedMap: 4 }, row.decision.action.team),
                        offline(changedInput, view.creaturesBanned),
                    );
                }
                expect(observe({ ...view, complete: true }, row.decision.action.team)).toBeNull();
            }
            expect(rows).toEqual(before);
        }
    });
    it("derives exact occupancy from public order including collisions, reversed actors and all doctrines", () => {
        for (const doctrine of [Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE])
            for (let seed = 0; seed < 32; seed++)
                for (const example of premiumDraftOpponentExamples(history(seed + 800, doctrine))) {
                    const input = draftMemoryInput(example.input);
                    const bans = example.input.observation.creaturesBanned as number[];
                    expect(publicDraftOccupiedOfferCount(input, bans)).toBe(
                        example.target.currentlyOccupiedOfferedCreatures.length,
                    );
                    expect(
                        publicDraftOccupiedOfferCount({ ...input, ownTeam: input.ownTeam === 1 ? 2 : 1 }, bans),
                    ).toBeNull();
                    expect(
                        publicDraftOccupiedOfferCount(
                            { ...input, availableCreatureIds: input.availableCreatureIds.slice(1) },
                            bans,
                        ),
                    ).toBeNull();
                }
    });

    it("projects onto exact public counts without making any compatible binary target's squared error worse", () => {
        const p = [0.04, 0.8, 0.2, 0.1];
        for (let occupied = 0; occupied <= p.length; occupied++) {
            const q = projectDraftOccupancy(p, occupied);
            expect(Math.abs(q.reduce((a, b) => a + b, 0) - occupied)).toBeLessThan(1e-12);
            for (let mask = 0; mask < 1 << p.length; mask++) {
                const y = p.map((_, index) => (mask >> index) & 1);
                if (y.reduce((a, b) => a + b, 0) !== occupied) continue;
                expect(q.reduce((sum, v, i) => sum + (v - y[i]) ** 2, 0)).toBeLessThanOrEqual(
                    p.reduce((sum, v, i) => sum + (v - y[i]) ** 2, 0) + 1e-12,
                );
            }
        }
        expect(() => projectDraftOccupancy([NaN], 1)).toThrow();
        expect(() => projectDraftOccupancy(p, 5)).toThrow();
        const examples = Array.from({ length: 12 }, (_, i) => history(i + 200)).flatMap(premiumDraftOpponentExamples);
        const predict = createFeasibleDraftOpponentMemory(fitPremiumDraftMemory(examples, provenance));
        for (const example of examples) {
            const input = draftMemoryInput(example.input);
            const result = predict(input, example.input.observation.creaturesBanned as number[])!;
            expect(result.occupiedOffers).toBe(example.target.currentlyOccupiedOfferedCreatures.length);
            expect(
                Math.abs(
                    result.beliefs.reduce((sum, belief) => sum + belief.occupiedProbability, 0) - result.occupiedOffers,
                ),
            ).toBeLessThan(1e-12);
        }
    });
    it("reconstructs native sorted rosters, hidden collisions and future picks without changing public inputs", () => {
        let collisions = 0;
        for (const doctrine of [Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE]) {
            const rows = history(1307, doctrine);
            const before = structuredClone(rows);
            const examples = premiumDraftOpponentExamples(rows);
            expect(rows).toEqual(before);
            expect(examples.length).toBeGreaterThanOrEqual(8);
            for (const example of examples) {
                const input = draftMemoryInput(example.input);
                expect(example.audit.partition).toBe("train");
                expect(example.target.opponentFinalRoster).toHaveLength(6);
                expect(
                    example.target.hiddenAlreadyPicked.every((id) => !input.knownOpponentCreatureIds.includes(id)),
                ).toBe(true);
                expect(JSON.stringify(example.input)).not.toMatch(
                    /snapshotId|familyId|hiddenAlreadyPicked|currentlyOccupied|observedScore/,
                );
                expect(
                    example.target.currentlyOccupiedOfferedCreatures.includes(Number(example.logged.selectedKey)),
                ).toBe(example.logged.status === "collision");
                if (doctrine === Doctrine.SEE_ALL) expect(example.target.hiddenAlreadyPicked).toEqual([]);
                collisions += Number(example.logged.status === "collision");
            }
        }
        expect(collisions).toBeGreaterThan(0);
    });

    it("rejects incomplete histories, duplicate indices, held-out rows and future enemy leaks", () => {
        const rows = history(19);
        expect(() => premiumDraftOpponentExamples(rows.slice(0, -2))).toThrow();
        expect(() => premiumDraftOpponentExamples([...rows, rows[0]])).toThrow();
        const heldOut = structuredClone(rows);
        (heldOut[0] as unknown as { partition: string }).partition = "test";
        expect(() => premiumDraftOpponentExamples(heldOut)).toThrow();
        const leaky = structuredClone(rows);
        leaky[0].decision.observation.knownOpponentCreatures = [999];
        expect(() => premiumDraftOpponentExamples(leaky)).toThrow("pre-action roster");
        const wrong = structuredClone(rows);
        const collided = wrong.find((row) => row.decision.status === "collision")!;
        expect(collided).toBeDefined();
        collided.decision.status = "accepted";
        expect(() => premiumDraftOpponentExamples(wrong)).toThrow("Collision");
    });

    it("fits distinct families, excludes entire fold families, and never reads battle labels", () => {
        const examples = Array.from({ length: 30 }, (_, i) => history(i + 100)).flatMap(premiumDraftOpponentExamples);
        const model = fitPremiumDraftMemory(examples, provenance);
        expect(model.trainingFamilies).toBe(30);
        expect(Object.values(model.tables).every((count) => count[1] <= 30)).toBe(true);
        expect(() => fitPremiumDraftMemory([...examples, examples[0]], provenance)).toThrow("duplicate");
        const mixed = structuredClone(examples);
        mixed[0].audit.snapshotId = "another-study";
        expect(() => fitPremiumDraftMemory(mixed, provenance)).toThrow("separate");
        const check = validatePremiumDraftMemory(examples, provenance);
        expect(check.folds.reduce((sum, fold) => sum + fold.validationFamilies, 0)).toBe(30);
        for (const fold of check.folds) expect(fold.trainingFamilies + fold.validationFamilies).toBe(30);
        expect(check.policyWinRateMeasured).toBe(false);
        expect(check.optimizerSteps).toBe(0);
        expect(
            new Set(
                examples
                    .filter((row) => row.audit.familyId === examples[0].audit.familyId)
                    .map((row) => draftMemoryFold(row.audit.familyId)),
            ).size,
        ).toBe(1);
    });

    it("keeps the compiled model immutable, respects exact Spymaster visibility and rejects private input", () => {
        const examples = Array.from({ length: 12 }, (_, i) => history(i + 200)).flatMap(premiumDraftOpponentExamples);
        const model = fitPremiumDraftMemory(examples, provenance);
        const predict = createDraftOpponentMemory(model);
        const input = draftMemoryInput(examples[0].input);
        const before = predict(input);
        model.tables = {};
        expect(predict(input)).toEqual(before);
        expect(before!.every((row) => row.occupiedProbability >= 0 && row.occupiedProbability <= 1)).toBe(true);
        expect(predict({ ...input, hiddenEnemy: [1] } as IDraftMemoryInput)).toBeNull();
        const spy = premiumDraftOpponentExamples(history(30, Doctrine.SEE_ALL))[0];
        expect(predict(draftMemoryInput(spy.input))!.every((row) => row.exact && row.occupiedProbability === 0)).toBe(
            true,
        );
        const injected = structuredClone(examples[0].input);
        injected.observation.hiddenRoster = [1];
        expect(() => draftMemoryInput(injected)).toThrow("Unexpected");
        const inputBefore = structuredClone(input);
        predict(input);
        expect(input).toEqual(inputBefore);
    });

    it("routes a read-only snapshot through export, fixed fits and hashes while skipping poisoned held-out payloads", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hoc-draft-memory-"));
        try {
            const path = join(dir, "snapshot.sqlite");
            const db = new Database(path);
            db.exec(PREMIUM_SNAPSHOT_SQL);
            db.query("INSERT INTO metadata VALUES ('manifest',?)").run(
                JSON.stringify({
                    schema: PREMIUM_SNAPSHOT_SCHEMA,
                    snapshotId: "fixture",
                    sourceSha256,
                    studyProfile: "premium-ranked-v3",
                    status: "development",
                    capabilities: ["draft-observations"],
                    provenance: {},
                }),
            );
            db.query("INSERT INTO source VALUES (1,'fixture',?,32)").run(sourceSha256);
            for (let family = 0; family < 32; family++) {
                const rows = history(family + 500);
                const partition = family === 30 ? "validation" : family === 31 ? "test" : "train";
                db.query("INSERT INTO family VALUES (?,?,?,?,?,?,?)").run(
                    rows[0].familyId,
                    "ranked-draft",
                    family,
                    1,
                    partition,
                    1,
                    family,
                );
                for (const side of ["a", "b"])
                    db.query("INSERT INTO army VALUES (?,?,?,?,?,?,?,?)").run(
                        family * 2 + (side === "a" ? 1 : 2),
                        rows[0].familyId,
                        side,
                        family % 2,
                        3,
                        0,
                        0,
                        "fixture",
                    );
                for (const row of rows) {
                    const d = row.decision;
                    const a = d.action;
                    const key =
                        "creatureId" in a
                            ? a.creatureId
                            : "doctrine" in a
                              ? a.doctrine
                              : "bundleIndex" in a
                                ? a.bundleIndex
                                : a.artifactId;
                    db.query("INSERT INTO decision VALUES (?,?,?,?,?,?,?,?,?)").run(
                        row.familyId,
                        d.index,
                        family * 2 + (row.side === "a" ? 1 : 2),
                        d.observation.phaseSequence,
                        a.type,
                        key,
                        d.status,
                        d.behaviorProbability,
                        partition === "train" ? JSON.stringify(d) : JSON.stringify({ poisoned: true }),
                    );
                }
            }
            db.close();
            const snapshotHash = createHash("sha256").update(readFileSync(path)).digest("hex");
            const reader = new PremiumEvidenceSnapshot(path, sourceSha256, { allowDevelopment: true });
            expect(new Set([...reader.trainingDraftHistory()].map((row) => row.familyId)).size).toBe(30);
            reader.close();
            const output = join(dir, "prepared");
            const receipt = await exportPremiumDraftMemory(path, sourceSha256, snapshotHash, output);
            expect(receipt.families).toBe(30);
            expect(receipt.fits).toBe(6);
            expect(receipt.heldOutSnapshotRows).toBe(0);
            expect(receipt.defaultsChanged).toBe(false);
            expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(snapshotHash);
            const exported = gunzipSync(readFileSync(join(output, "opponent-targets.jsonl.gz"))).toString();
            expect(exported).not.toContain("poisoned");
            expect(exported).not.toContain("observedScore");
            await expect(exportPremiumDraftMemory(path, sourceSha256, snapshotHash, output)).rejects.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
