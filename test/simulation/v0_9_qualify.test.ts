import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { V09_MODEL_ARTIFACT } from "../../src/ai/versions/v0_9_artifact";
import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import { createV09OfflineResearchStrategy } from "../../src/ai/versions/v0_9";
import type { IV09ModelArtifact } from "../../src/ai/versions/v0_9_model";
import { runMatch, type IV09ServerPreflightTimingObservation } from "../../src/simulation/battle_engine";
import { buildMirrorRoster } from "../../src/simulation/measure_mirror_cohorts";
import {
    buildV09CampaignManifest,
    buildV09SeedLedger,
    V09_RTX5090_GPU_UUID,
    v09CampaignRunFingerprint,
} from "../../src/simulation/v0_9/campaign";
import {
    aggregateV09Qualification,
    buildV09QualificationPlan,
    histogramQuantile,
    partitionV09QualificationPlan,
    recoverV09QualificationJournalTail,
    rebuildV09QualificationSummaryFromRawRecords,
    runV09QualificationPair,
    validateV09QualificationSummary,
    validateV09QualificationSummaryAgainstRawRecords,
    validateV09QualificationShardCoverage,
    verifyV09QualificationInputs,
    v09BaselineInvalidActionFailure,
    v09ProductionTurnLatencyFailure,
    v09WilsonLower95,
    V09_QUALIFICATION_PAIR_SCHEMA,
    V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
    type IV09QualificationPairRecord,
    type IV09QualificationPlanPair,
    type IV09QualificationShardReceipt,
    type IV09QualificationSummary,
} from "../../src/simulation/v0_9/qualify";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import { sealV09ResearchArtifact } from "../../src/simulation/v0_9/seal_artifact";
import { v09QualificationFailures, type IV09QualificationMetrics } from "../../src/simulation/v0_9/supervisor";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const identity = {
    sourceCommit: SHA_A,
    sourceStatusSha256: SHA_B,
    sourceDirty: false as const,
    rulesFingerprint: SHA_C,
    rosterFingerprint: SHA_D,
    anchorVersion: "v0.8" as const,
    anchorFingerprint: "e".repeat(64),
    gpuUuid: V09_RTX5090_GPU_UUID,
};

const counts = {
    wide_teacher_train: 2,
    wide_teacher_validation: 2,
    dagger_1_train: 2,
    dagger_1_validation: 2,
    dagger_2_train: 2,
    dagger_2_validation: 2,
    confirmation: 4,
    qualification: 4,
};

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "hoc-v09-qualify-"));
    const runFingerprint = v09CampaignRunFingerprint(identity);
    const ledger = buildV09SeedLedger(runFingerprint, [], counts);
    const manifest = buildV09CampaignManifest(identity, directory, ledger);
    const unsealed: IV09ModelArtifact = {
        ...V09_MODEL_ARTIFACT,
        status: "trained",
        promoted: false,
        modelId: "v0.9-research-unsealed",
        modelSha256: null,
        source: {
            commonCommit: identity.sourceCommit,
            rulesSha256: identity.rulesFingerprint,
            rosterSha256: identity.rosterFingerprint,
            trainingRunId: runFingerprint,
        },
        layers: [
            {
                inputSize: V09_MODEL_ARTIFACT.architecture.inputSize,
                outputSize: 1,
                activation: "linear",
                scaleShift: 8,
                weights: Array<number>(V09_MODEL_ARTIFACT.architecture.inputSize).fill(0),
                biases: [0],
            },
        ],
        notes: "qualification fixture",
    };
    const artifact = sealV09ResearchArtifact(unsealed);
    return { directory, ledger, manifest, artifact };
}

function pairRecord(
    id: string,
    purpose: "confirmation" | "qualification",
    winnerA: "v0.9" | "v0.8" | "draw",
    winnerB: "v0.9" | "v0.8" | "draw",
    options: {
        reachedArmageddonA?: boolean;
        decidedByArmageddonA?: boolean;
        controlReachedArmageddon?: boolean;
        controlDecidedByArmageddon?: boolean;
        decisions?: number;
        events?: number;
        telemetryMismatches?: number;
        rejectedV08?: number;
        rejectedV08Control?: number;
    } = {},
): IV09QualificationPairRecord {
    const score = (winner: typeof winnerA): 0 | 0.5 | 1 => (winner === "v0.9" ? 1 : winner === "draw" ? 0.5 : 0);
    const unsigned = {
        schema: V09_QUALIFICATION_PAIR_SCHEMA,
        runFingerprint: SHA_A,
        manifestSha256: SHA_B,
        modelSha256: SHA_C,
        id,
        purpose,
        pairIndex: 0,
        scenarioSeed: 1,
        combatSeed: 2,
        cohort: "mirror-anchor" as const,
        map: "normal" as const,
        games: [
            {
                v09Seat: "green" as const,
                winner: winnerA,
                scoreV09: score(winnerA),
                laps: 3,
                endReason: "elimination" as const,
                reachedArmageddon: options.reachedArmageddonA ?? false,
                armageddonDecided: options.decidedByArmageddonA ?? false,
                rejectedV09: 0,
                rejectedV08: options.rejectedV08 ?? 0,
            },
            {
                v09Seat: "red" as const,
                winner: winnerB,
                scoreV09: score(winnerB),
                laps: 4,
                endReason: "elimination" as const,
                reachedArmageddon: false,
                armageddonDecided: false,
                rejectedV09: 0,
                rejectedV08: 0,
            },
        ] as const,
        v08ControlGame: {
            winnerSide: "green" as const,
            laps: 3,
            endReason: "elimination" as const,
            reachedArmageddon: options.controlReachedArmageddon ?? false,
            armageddonDecided: options.controlDecidedByArmageddon ?? false,
            rejectedGreen: options.rejectedV08Control ?? 0,
            rejectedRed: 0,
        },
        v09PolicyDecisions: options.decisions ?? 10,
        v09PolicyEvents: options.events ?? 10,
        v09ServerPreflightTimings: options.decisions ?? 10,
        telemetryMismatches: options.telemetryMismatches ?? 0,
        invalidModelTelemetryEvents: 0,
        runtimeFallbacks: 0,
        instrumentationFailures: 0,
        avoidablePassiveActions: 0,
        turnLatencyMicros: [[1_000, 10]] as const,
    };
    return { ...unsigned, recordSha256: fingerprintV09(unsigned) };
}

function shardReceipt(
    plan: ReturnType<typeof buildV09QualificationPlan>,
    shardIndex: number,
    shardCount: number,
): IV09QualificationShardReceipt {
    const shardPlan = partitionV09QualificationPlan(plan, shardIndex, shardCount);
    const unsigned = {
        schema: V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
        promoted: false as const,
        status: "complete_nonpromoting_shard" as const,
        runFingerprint: SHA_A,
        manifestSha256: SHA_B,
        seedLedgerSha256: SHA_C,
        modelSha256: SHA_D,
        researchArtifactSha256: "e".repeat(64),
        planSha256: fingerprintV09(plan),
        shardPlanSha256: fingerprintV09(shardPlan),
        shardCount,
        shardIndex,
        expectedPairs: shardPlan.length,
        completedPairs: shardPlan.length,
        expectedSimulations: shardPlan.length * 3,
        completedSimulations: shardPlan.length * 3,
        journalSha256: "f".repeat(64),
        journalHeaderSha256: "0".repeat(64),
        runnerSourceSha256: "1".repeat(64),
        sourceIdentityReceiptSha256: "2".repeat(64),
        behaviorEnvironmentSha256: "3".repeat(64),
        executionFingerprint: "4".repeat(64),
        nodeRole: "training_host" as const,
        modelP99Ms: 1,
        turnP99Ms: 2,
        rssIncreaseMiB: 3,
        completedAt: "2026-07-26T00:00:00.000Z",
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

function evidencePairRecord(
    pair: IV09QualificationPlanPair,
    manifest: ReturnType<typeof buildV09CampaignManifest>,
    artifact: IV09ModelArtifact,
    reachedArmageddon = false,
): IV09QualificationPairRecord {
    const fixtureRecord = pairRecord(pair.id, pair.purpose, "v0.9", "v0.9", {
        reachedArmageddonA: reachedArmageddon,
    });
    const { recordSha256: _fixtureSha256, ...fixtureUnsigned } = fixtureRecord;
    const unsigned = {
        ...fixtureUnsigned,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        modelSha256: artifact.modelSha256!,
        id: pair.id,
        purpose: pair.purpose,
        pairIndex: pair.pairIndex,
        scenarioSeed: pair.scenarioSeed,
        combatSeed: pair.combatSeed,
        cohort: pair.cohort,
        map: pair.map,
    };
    return { ...unsigned, recordSha256: fingerprintV09(unsigned) };
}

function evidenceShardReceipt(
    plan: readonly IV09QualificationPlanPair[],
    manifest: ReturnType<typeof buildV09CampaignManifest>,
    ledger: ReturnType<typeof buildV09SeedLedger>,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    shardIndex: number,
    nodeRole: "training_host" | "production_cpu",
): IV09QualificationShardReceipt {
    const shardCount = 2;
    const shardPlan = partitionV09QualificationPlan(plan, shardIndex, shardCount);
    const unsigned = {
        schema: V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
        promoted: false as const,
        status: "complete_nonpromoting_shard" as const,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        modelSha256: artifact.modelSha256!,
        researchArtifactSha256: artifactFileSha256,
        planSha256: fingerprintV09(plan),
        shardPlanSha256: fingerprintV09(shardPlan),
        shardCount,
        shardIndex,
        expectedPairs: shardPlan.length,
        completedPairs: shardPlan.length,
        expectedSimulations: shardPlan.length * 3,
        completedSimulations: shardPlan.length * 3,
        journalSha256: `${shardIndex + 6}`.repeat(64),
        journalHeaderSha256: `${shardIndex + 4}`.repeat(64),
        runnerSourceSha256: "1".repeat(64),
        sourceIdentityReceiptSha256: "2".repeat(64),
        behaviorEnvironmentSha256: "3".repeat(64),
        executionFingerprint: `${shardIndex + 8}`.repeat(64),
        nodeRole,
        modelP99Ms: 1,
        turnP99Ms: 1,
        rssIncreaseMiB: 3,
        completedAt: `2026-07-26T00:00:0${shardIndex}.000Z`,
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

function selfRehashQualificationSummary(candidate: IV09QualificationSummary): IV09QualificationSummary {
    const failuresSha256 = fingerprintV09(candidate.failures);
    const receiptCandidate = {
        ...candidate.promotionReceiptInputs,
        metricsSha256: fingerprintV09(candidate.metrics),
        baselineMetricsSha256: fingerprintV09(candidate.baselineMetrics),
        productionCpuP99TurnMs: candidate.execution.productionCpuQualification.p99TurnMs,
        failures: candidate.failures,
        failuresSha256,
    };
    const { receiptInputsSha256: _oldReceiptSha256, ...receiptUnsigned } = receiptCandidate;
    const withoutSummaryHash = {
        ...candidate,
        failuresSha256,
        promotionReceiptInputs: {
            ...receiptUnsigned,
            receiptInputsSha256: fingerprintV09(receiptUnsigned),
        },
    };
    const { summarySha256: _oldSummarySha256, ...summaryUnsigned } = withoutSummaryHash;
    return { ...summaryUnsigned, summarySha256: fingerprintV09(summaryUnsigned) };
}

describe("v0.9 offline qualification", () => {
    it("uses every exact confirmation/qualification seed once and mirrors two games per adjacent pair", () => {
        const { ledger } = fixture();
        const plan = buildV09QualificationPlan(ledger);
        expect(plan).toHaveLength(4);
        const selected = ledger.streams
            .filter((stream) => stream.purpose === "confirmation" || stream.purpose === "qualification")
            .flatMap((stream) => stream.seeds);
        const consumed = plan.flatMap((pair) => [pair.scenarioSeed, pair.combatSeed]);
        expect(consumed).toEqual(selected);
        expect(new Set(consumed).size).toBe(consumed.length);
        expect(plan[0]?.cohort).toBe("ranked-draft");
        expect(plan[0]?.map).toBe("normal");
    });

    it("fails closed on artifact selection or campaign provenance drift", () => {
        const { directory, ledger, manifest, artifact } = fixture();
        expect(() =>
            verifyV09QualificationInputs(manifest, ledger, artifact, artifact.modelSha256!, directory),
        ).not.toThrow();
        const relocated = mkdtempSync(join(tmpdir(), "hoc-v09-relocated-campaign-"));
        expect(() =>
            verifyV09QualificationInputs(manifest, ledger, artifact, artifact.modelSha256!, relocated),
        ).not.toThrow();
        expect(() => verifyV09QualificationInputs(manifest, ledger, artifact, "f".repeat(64), directory)).toThrow(
            "selected-model identity mismatch",
        );
        expect(() =>
            verifyV09QualificationInputs(
                manifest,
                ledger,
                {
                    ...artifact,
                    source: { ...artifact.source, trainingRunId: "0".repeat(64) },
                },
                artifact.modelSha256!,
                directory,
            ),
        ).toThrow();
    });

    it("computes draw-aware score, Wilson lower bound, latency p99 and supervisor metrics", () => {
        const records = [
            pairRecord("confirmation:0", "confirmation", "v0.9", "draw"),
            pairRecord("qualification:0", "qualification", "v0.8", "v0.9"),
        ];
        const aggregate = aggregateV09Qualification(records, 2, 8);
        expect(aggregate.metrics.combinedGames).toBe(4);
        expect(aggregate.metrics.combinedScore).toBe(0.625);
        expect(aggregate.metrics.confirmationScore).toBe(0.75);
        expect(aggregate.metrics.qualificationScore).toBe(0.5);
        expect(aggregate.metrics.p99TurnMs).toBe(1);
        expect(aggregate.metrics.invalidActions).toBe(0);
        expect(aggregate.totals.v09Wins).toBe(2);
        expect(v09WilsonLower95(55_000, 0, 96_000)).toBeGreaterThan(0.54);
        expect(
            histogramQuantile(
                new Map([
                    [10, 99],
                    [20, 1],
                ]),
                0.99,
            ),
        ).toBe(10);
    });

    it("gates every Armageddon reach even when Armageddon damage did not decide the battle", () => {
        const records = [
            pairRecord("confirmation:0", "confirmation", "v0.8", "draw", {
                reachedArmageddonA: true,
                decidedByArmageddonA: false,
                controlReachedArmageddon: true,
                controlDecidedByArmageddon: false,
            }),
            pairRecord("qualification:0", "qualification", "v0.9", "v0.9"),
        ];
        const aggregate = aggregateV09Qualification(records, 2, 8);
        expect(aggregate.metrics.armageddonRate).toBe(0.25);
        expect(aggregate.metrics.v08ArmageddonRate).toBe(0.5);
        expect(aggregate.totals.armageddonWhenV09Green).toBe(1);
        expect(aggregate.totals.armageddonDecidedGames).toBe(0);
        expect(aggregate.totals.v08ControlGames).toBe(2);
        expect(aggregate.totals.v08ControlArmageddonDecidedGames).toBe(0);
    });

    it("does not let missing and duplicate telemetry cancel in aggregate", () => {
        const records = [
            pairRecord("confirmation:0", "confirmation", "v0.9", "v0.8", {
                decisions: 11,
                events: 10,
                telemetryMismatches: 1,
            }),
            pairRecord("qualification:0", "qualification", "v0.8", "v0.9", {
                decisions: 9,
                events: 10,
                telemetryMismatches: 1,
            }),
        ];
        const aggregate = aggregateV09Qualification(records, 2, 8);
        expect(aggregate.metrics.invalidActions).toBe(2);
        expect(aggregate.totals.telemetryMismatches).toBe(2);
    });

    it("tracks rejected v0.8 opponent and control actions as baseline-invalid", () => {
        const aggregate = aggregateV09Qualification(
            [
                pairRecord("confirmation:0", "confirmation", "v0.9", "v0.8", {
                    rejectedV08: 2,
                    rejectedV08Control: 3,
                }),
                pairRecord("qualification:0", "qualification", "v0.8", "v0.9"),
            ],
            2,
            8,
        );
        expect(aggregate.baselineMetrics.invalidActions).toBe(5);
        expect(aggregate.metrics.invalidActions).toBe(0);
        expect(v09BaselineInvalidActionFailure(5)).toContain("baseline/control");
        expect(v09BaselineInvalidActionFailure(0)).toBeNull();
    });

    it("repairs only a crash-torn final journal append", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-journal-tail-"));
        const path = join(directory, "pairs.jsonl");
        const header = JSON.stringify({ schema: "header" });
        writeFileSync(path, `${header}\n{\"partial\":`);
        expect(recoverV09QualificationJournalTail(path)).toEqual([header, ""]);
        expect(readFileSync(path, "utf8")).toBe(`${header}\n`);

        writeFileSync(path, `${header}\n${JSON.stringify({ complete: true })}`);
        expect(recoverV09QualificationJournalTail(path)).toEqual([header, JSON.stringify({ complete: true }), ""]);
        expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    });

    it("runs a real offline pair without forging promotion or invalid-model telemetry", () => {
        const { ledger, manifest, artifact } = fixture();
        const pair = buildV09QualificationPlan(ledger)[0]!;
        const configured = {
            ...buildV08A13SearchEnvironment("v0.8"),
            SIM_NO_ACTIONS: "1",
            LIVETWIN: "1",
            FIGHT_MELEE_ROSTERS: "0",
        };
        const prior = new Map(Object.keys(configured).map((key) => [key, process.env[key]]));
        for (const [key, value] of Object.entries(configured)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            const record = runV09QualificationPair(pair, artifact, manifest.runFingerprint, manifest.manifestSha256);
            expect(record.games.map((game) => game.v09Seat)).toEqual(["green", "red"]);
            expect(record.v08ControlGame).toBeDefined();
            expect(record.v09PolicyDecisions).toBeGreaterThan(0);
            expect(record.v09PolicyEvents).toBe(record.v09PolicyDecisions);
            expect(record.v09ServerPreflightTimings).toBe(record.v09PolicyDecisions);
            expect(record.turnLatencyMicros.reduce((sum, [, count]) => sum + count, 0)).toBe(record.v09PolicyDecisions);
            expect(record.telemetryMismatches).toBe(0);
            expect(record.invalidModelTelemetryEvents).toBe(0);
            expect(record.modelSha256).toBe(artifact.modelSha256!);
            expect(artifact.promoted).toBe(false);
            expect(artifact.qualification).toBeNull();
        } finally {
            for (const [key, value] of prior) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it("times decision plus common preflight rollback without changing the live match or RNG", () => {
        const { artifact } = fixture();
        const roster = buildMirrorRoster("anchor", 17, "expBudget");
        const base = {
            greenVersion: "v0.9",
            redVersion: "v0.8",
            seed: 917,
            maxLaps: 8,
            roster,
        } as const;
        const baseline = runMatch({
            ...base,
            greenStrategyOverride: createV09OfflineResearchStrategy(artifact),
        });
        const timings: IV09ServerPreflightTimingObservation[] = [];
        const measured = runMatch({
            ...base,
            greenStrategyOverride: createV09OfflineResearchStrategy(artifact),
            v09ServerPreflightObserver: (observation) => timings.push(observation),
        });
        expect(measured).toEqual(baseline);
        expect(timings.length).toBeGreaterThan(0);
        expect(timings.every((timing) => timing.failure === null)).toBe(true);
        expect(timings.every((timing) => timing.totalMicros >= timing.decisionMicros)).toBe(true);
        expect(timings.every((timing) => timing.totalMicros >= timing.preflightMicros)).toBe(true);
    });

    it("partitions exact ordinals and rejects tampered, duplicate, or missing shards", () => {
        const { ledger } = fixture();
        const plan = buildV09QualificationPlan(ledger);
        const receipts = [shardReceipt(plan, 0, 2), shardReceipt(plan, 1, 2)];
        expect(() => validateV09QualificationShardCoverage(plan, receipts)).not.toThrow();
        const ids = receipts.flatMap((receipt) =>
            partitionV09QualificationPlan(plan, receipt.shardIndex, receipt.shardCount).map((pair) => pair.id),
        );
        expect(new Set(ids).size).toBe(plan.length);
        expect(() => validateV09QualificationShardCoverage(plan, [receipts[0]!])).toThrow("exactly 2");
        expect(() => validateV09QualificationShardCoverage(plan, [receipts[0]!, receipts[0]!])).toThrow("overlap");
        expect(() =>
            validateV09QualificationShardCoverage(plan, [
                receipts[0]!,
                { ...receipts[1]!, expectedPairs: receipts[1]!.expectedPairs + 1 },
            ]),
        ).toThrow("identity/completion mismatch");
    });

    it("requires strict production-CPU turn-p99 headroom below 20ms", () => {
        expect(v09ProductionTurnLatencyFailure(19.999)).toBeNull();
        expect(v09ProductionTurnLatencyFailure(20)).toContain("not below 20ms");
        expect(v09ProductionTurnLatencyFailure(null)).toContain("production-CPU");
        expect(v09QualificationFailures({} as IV09QualificationMetrics)).toContain(
            "qualification metrics are missing, malformed, or internally inconsistent",
        );
    });

    it("rejects self-rehashed fake p99 and Armageddon summaries against raw records", () => {
        const { ledger, manifest, artifact } = fixture();
        const artifactFileSha256 = "9".repeat(64);
        const plan = buildV09QualificationPlan(ledger);
        const records = plan.map((pair, index) => evidencePairRecord(pair, manifest, artifact, index === 0));
        const shardReceipts = [
            evidenceShardReceipt(plan, manifest, ledger, artifact, artifactFileSha256, 0, "training_host"),
            evidenceShardReceipt(plan, manifest, ledger, artifact, artifactFileSha256, 1, "production_cpu"),
        ];
        const raw = {
            manifest,
            ledger,
            artifact,
            artifactFileSha256,
            shardReceipts,
            records,
            allowSmokeCoverage: true,
        } as const;
        const canonical = rebuildV09QualificationSummaryFromRawRecords(raw);
        expect(() => validateV09QualificationSummary(canonical)).not.toThrow();
        expect(() => validateV09QualificationSummaryAgainstRawRecords(canonical, raw)).not.toThrow();
        expect(() =>
            validateV09QualificationSummary({
                ...canonical,
                metrics: { ...canonical.metrics, p99TurnMs: undefined },
            } as unknown as IV09QualificationSummary),
        ).toThrow("must be finite");

        const fakeP99 = selfRehashQualificationSummary({
            ...canonical,
            metrics: { ...canonical.metrics, p99TurnMs: 0 },
            execution: {
                ...canonical.execution,
                p99TurnMs: 0,
                nodes: canonical.execution.nodes.map((node) =>
                    node.nodeRole === "production_cpu" ? { ...node, turnP99Ms: 0 } : node,
                ),
                productionCpuQualification: {
                    ...canonical.execution.productionCpuQualification,
                    p99TurnMs: 0,
                },
            },
        });
        expect(() => validateV09QualificationSummary(fakeP99)).not.toThrow();
        expect(() => validateV09QualificationSummaryAgainstRawRecords(fakeP99, raw)).toThrow(
            "recomputed from raw v2 journals",
        );

        const failures = canonical.failures.filter((failure) => failure !== "Armageddon non-inferiority failed");
        const fakeArmageddon = selfRehashQualificationSummary({
            ...canonical,
            metrics: { ...canonical.metrics, armageddonRate: 0 },
            failures,
            totals: {
                ...canonical.totals,
                armageddonGames: 0,
                armageddonWhenV09Green: 0,
                armageddonWhenV09Red: 0,
                armageddonDecidedGames: 0,
            },
            promotionReceiptInputs: {
                ...canonical.promotionReceiptInputs,
                failures,
            },
        });
        expect(() => validateV09QualificationSummary(fakeArmageddon)).not.toThrow();
        expect(() => validateV09QualificationSummaryAgainstRawRecords(fakeArmageddon, raw)).toThrow(
            "recomputed from raw v2 journals",
        );
    });
});
