import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { V09_MODEL_ARTIFACT } from "../../src/ai/versions/v0_9_artifact";
import {
    serializeV09ModelHashPayload,
    validateV09ModelArtifact,
    type IV09ModelArtifact,
} from "../../src/ai/versions/v0_9_model";
import { V09_FEATURE_SCHEMA_SHA256, V09_INPUT_FEATURE_NAMES } from "../../src/ai/versions/v0_9_features";
import {
    buildV09CampaignManifest,
    buildV09Checkpoint,
    buildV09DevelopmentActorPhysicalCorePolicy,
    buildV09SeedLedger,
    initializeV09Campaign,
    readV09Checkpoint,
    sha256File,
    v09CampaignRunFingerprint,
    validateV09SeedLedger,
    writeV09Checkpoint,
    V09_RTX5090_GPU_UUID,
} from "../../src/simulation/v0_9/campaign";
import {
    createV09ProductionHandoffBundle,
    validateV09ProductionHandoffBundle,
} from "../../src/simulation/v0_9/handoff";
import {
    buildV09ParityCorpus,
    scoreV09ParityVectors,
    verifyV09ResearchArtifact,
    type IV09ParityVector,
} from "../../src/simulation/v0_9/parity";
import {
    v09InitialArchitectureCheckpointProgress,
    v09LearnerRejectionFingerprintPayload,
} from "../../src/simulation/v0_9/orchestrator";
import {
    parseV09Corpus,
    parseV09DecisionRow,
    V09_FEATURE_FINGERPRINTS,
    V09_FULL_FEATURE_NAMES,
    V09_IL_SCHEMA,
    V09_RICH_FEATURE_NAMES,
    v09CandidateInputVector,
    fingerprintV09,
} from "../../src/simulation/v0_9/protocol";
import {
    V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
    type IV09QualificationShardReceipt,
} from "../../src/simulation/v0_9/qualify";
import { V09GameRecorder, validateV09GameShard } from "../../src/simulation/v0_9/recorder";
import { sealV09ResearchArtifact } from "../../src/simulation/v0_9/seal_artifact";
import {
    assessV09LearnerHardwareEvidence,
    assertV09OutputIsolation,
    buildV09LearnerLaunch,
    verifyV09V08ProtectionReceipt,
    v09QualificationFailures,
    V09_PYTHON_ENVIRONMENT,
    writeV09V08ProtectionReceipt,
} from "../../src/simulation/v0_9/supervisor";
import { IL_ACTION_FEATURE_NAMES } from "../../src/simulation/il_action_features";
import { IL_CANDIDATE_FEATURE_NAMES } from "../../src/simulation/il_dataset";
import { VALUE_FEATURE_NAMES_V2 } from "../../src/simulation/value_features";
import { runV09TeacherActor } from "../../src/simulation/v0_9/teacher_actor";
import { v09TeacherFirstHitUnitId } from "../../src/simulation/v0_9/teacher_observer";
import { V09_SOURCE_IDENTITY_SCHEMA, type IV09SourceIdentityReceipt } from "../../src/simulation/v0_9/source_identity";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const RUN = "e".repeat(64);

const candidate = {
    kind: "wait",
    signature: "wait_turn",
    actions: [{ type: "wait_turn" as const, unitId: "actor" }],
    candidateFeatures: Array<number>(IL_CANDIDATE_FEATURE_NAMES.length).fill(0),
    actionFeatures: Array<number>(IL_ACTION_FEATURE_NAMES.length).fill(0),
    richFeatures: Array<number>(V09_RICH_FEATURE_NAMES.length).fill(0),
    metadata: {
        declaredUnitId: null,
        firstHitUnitId: null,
        aimUnitId: null,
        aimCell: null,
        aimSide: null,
        spellName: null,
        spellTargetMode: null,
    },
    flags: {
        productive: 0 as const,
        waitEligible: 1 as const,
        luckShield: 0 as const,
        mountainAttack: 0 as const,
        urgentFinish: 0 as const,
        dominantFinish: 0 as const,
        aimVisibleEdge: 0 as const,
        trajectoryIntercepted: 0 as const,
    },
    teacherMean: 0.5,
    teacherStdErr: null,
    teacherVisits: 8,
};

const common = {
    sourceCommit: SHA_A,
    rulesFingerprint: SHA_B,
    anchorFingerprint: SHA_C,
    phase: "wide_teacher" as const,
    split: "train" as const,
    cohort: "ranged",
    map: "normal" as const,
    seed: 7,
    gameId: "wide_teacher:ranged:normal:7:green",
};

const rawDecision = () => ({
    t: "v09_il_decision",
    v: 4,
    schema: V09_IL_SCHEMA,
    runFingerprint: RUN,
    featureFingerprints: V09_FEATURE_FINGERPRINTS,
    ...common,
    decision: 0,
    seat: "green",
    lap: 2,
    actorUnitName: "Archer",
    valueFeatures: Array<number>(VALUE_FEATURE_NAMES_V2.length).fill(0),
    incumbentIndex: 0,
    teacherIndex: 0,
    candidates: [candidate],
});

describe("v0.9 training protocol", () => {
    it("counts accepted and quality-rejected architectures as a completed initial sweep", () => {
        expect(v09InitialArchitectureCheckpointProgress(1, 2)).toEqual({
            completedUnits: 3,
            expectedUnits: 3,
        });
        expect(() => v09InitialArchitectureCheckpointProgress(3, 1)).toThrow(
            "initial architecture progress exceeds the preregistered sweep",
        );
    });

    it("verifies a Python-sealed learner rejection without hashing unstable float spellings", () => {
        const python = Bun.spawnSync({
            cmd: [
                "python3",
                "-c",
                [
                    "from learner_receipt import LEARNER_REJECTION_SCHEMA, canonical_json, seal_learner_rejection",
                    "unsigned = {",
                    "  'schema': LEARNER_REJECTION_SCHEMA, 'reason': 'fixed_accuracy_drop',",
                    "  'message': 'fixture', 'runFingerprint': 'a' * 64, 'sourceCommit': 'b' * 40,",
                    "  'corpusSha256': 'c' * 64, 'hidden': [64, 32],",
                    "  'minimumQatFixedAgreement': 0.99, 'maximumFixedAccuracyDrop': 0.01,",
                    "  'selectedQatEpoch': 25, 'selectedQatStage': 'entry',",
                    "  'fixedValidation': {'decisions': 524288.0, 'top1Accuracy': 0.33},",
                    "  'qatReferenceValidation': {'top1Accuracy': 0.35},",
                    "  'fidelityAccuracyDrop': 0.019999999999999962, 'metricsSha256': 'd' * 64,",
                    "}",
                    "print(canonical_json(seal_learner_rejection(unsigned)))",
                ].join("\n"),
            ],
            cwd: join(import.meta.dir, "../../src/simulation/v0_9/python"),
            env: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
        });
        expect(python.exitCode).toBe(0);
        const rejection = JSON.parse(python.stdout.toString()) as Parameters<
            typeof v09LearnerRejectionFingerprintPayload
        >[0] & { rejectionSha256: string };
        expect(rejection.rejectionSha256).toBe(fingerprintV09(v09LearnerRejectionFingerprintPayload(rejection)));
    });

    it("reshuffles shards per epoch while reproducing the same worker partitions on resume", () => {
        const python = Bun.spawnSync({
            cmd: [
                "python3",
                "-c",
                [
                    "from pathlib import Path",
                    "from shard_order import ordered_worker_paths, training_epoch_order_sha256, training_epoch_seed",
                    "paths = [Path(f'/immutable/shard-{i}.jsonl') for i in range(17)]",
                    "seed0 = training_epoch_seed(7, 0)",
                    "assert seed0 == training_epoch_seed(7, 0)",
                    "assert seed0 != training_epoch_seed(7, 1)",
                    "order = ordered_worker_paths(paths, seed0)",
                    "assert order[5:] == ordered_worker_paths(paths, seed0)[5:]",
                    "parts = [ordered_worker_paths(paths, seed0, worker, 4) for worker in range(4)]",
                    "flat = [path for part in parts for path in part]",
                    "assert len(flat) == len(set(flat)) and set(flat) == set(paths)",
                    "assert training_epoch_order_sha256(paths, 7, 0) != training_epoch_order_sha256(paths, 7, 1)",
                    "print('ok')",
                ].join("; "),
            ],
            cwd: join(import.meta.dir, "../../src/simulation/v0_9/python"),
            env: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
        });
        expect(python.exitCode).toBe(0);
        expect(python.stdout.toString().trim()).toBe("ok");
        const learnerSource = readFileSync(
            join(import.meta.dir, "../../src/simulation/v0_9/python/learner.py"),
            "utf8",
        );
        expect(learnerSource).toMatch(/\nimport random\n/);
        expect(learnerSource).toContain('fixed_device = torch.device("cpu")');
    });

    it("pins the exact runtime feature basis without changing IL-v3", () => {
        expect(V09_FULL_FEATURE_NAMES).toHaveLength(166);
        expect(V09_INPUT_FEATURE_NAMES).toEqual([...V09_FULL_FEATURE_NAMES]);
        expect(V09_FEATURE_FINGERPRINTS.full).toBe(V09_FEATURE_SCHEMA_SHA256);
        expect(V09_FEATURE_SCHEMA_SHA256).toBe("01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e");
        const parsed = parseV09DecisionRow(rawDecision());
        expect(v09CandidateInputVector(parsed, parsed.candidates[0]!)).toHaveLength(166);
        expect(() =>
            parseV09DecisionRow({
                ...rawDecision(),
                candidates: [{ ...candidate, richFeatures: candidate.richFeatures.slice(1) }],
            }),
        ).toThrow("feature vector width 45");
    });

    it("records an authoritative aimed no-hit as null instead of inventing the declared target", () => {
        expect(v09TeacherFirstHitUnitId({ hasAim: true, firstHitTargetId: undefined }, "candidate", "declared")).toBe(
            null,
        );
        expect(v09TeacherFirstHitUnitId({ hasAim: false, firstHitTargetId: undefined }, "candidate", "declared")).toBe(
            "candidate",
        );
    });

    it("records one game as an atomic, chained, resumable shard", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-recorder-"));
        const path = join(directory, "game.jsonl");
        const recorder = new V09GameRecorder(
            {
                runFingerprint: RUN,
                sourceCommit: SHA_A,
                rulesFingerprint: SHA_B,
                anchorFingerprint: SHA_C,
            },
            {
                ...common,
                greenVersion: "v0.8",
                redVersion: "v0.8",
                winner: "green",
                endReason: "elimination",
            },
        );
        recorder.record({
            ...common,
            decision: 0,
            seat: "green",
            lap: 2,
            actorUnitName: "Archer",
            valueFeatures: Array<number>(VALUE_FEATURE_NAMES_V2.length).fill(0),
            incumbentIndex: 0,
            teacherIndex: 0,
            candidates: [candidate],
        });
        const footer = recorder.finalize(path);
        expect(footer.decisions).toBe(1);
        const corpus = parseV09Corpus(readFileSync(path, "utf8").split(/\r?\n/));
        expect(corpus.decisions).toHaveLength(1);
        expect(corpus.games).toHaveLength(1);
    });

    it("allocates disjoint provenance-bound seeds and resumes only matching manifests", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-campaign-"));
        const identity = {
            sourceCommit: SHA_A,
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const counts = {
            wide_teacher_train: 2,
            wide_teacher_validation: 2,
            dagger_1_train: 2,
            dagger_1_validation: 2,
            dagger_2_train: 2,
            dagger_2_validation: 2,
            confirmation: 2,
            qualification: 2,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [1, 2, 3], counts);
        validateV09SeedLedger(ledger);
        const seeds = ledger.streams.flatMap((stream) => stream.seeds);
        expect(new Set(seeds).size).toBe(seeds.length);
        expect(seeds.some((seed) => seed <= 3)).toBe(false);

        const manifest = buildV09CampaignManifest(
            identity,
            directory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        const learnerLaunch = buildV09LearnerLaunch(manifest, directory, [join(directory, "il/*.jsonl")]);
        expect(learnerLaunch.environment).toEqual({
            CUDA_VISIBLE_DEVICES: V09_RTX5090_GPU_UUID,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONUNBUFFERED: "1",
            V09_RUN_FINGERPRINT: manifest.runFingerprint,
        });
        const fixedGateIndex = learnerLaunch.argv.indexOf("--minimum-qat-fixed-agreement");
        expect(learnerLaunch.argv.slice(fixedGateIndex, fixedGateIndex + 4)).toEqual([
            "--minimum-qat-fixed-agreement",
            "0.99",
            "--maximum-fixed-accuracy-drop",
            "0.01",
        ]);
        const smokeLaunch = buildV09LearnerLaunch(manifest, directory, [join(directory, "il-smoke/*.jsonl")], {
            allowPartialCorpus: true,
            minimumQatFixedAgreement: 0,
            maximumFixedAccuracyDrop: 1,
        });
        const smokeFixedGateIndex = smokeLaunch.argv.indexOf("--minimum-qat-fixed-agreement");
        expect(smokeLaunch.argv.slice(smokeFixedGateIndex, smokeFixedGateIndex + 4)).toEqual([
            "--minimum-qat-fixed-agreement",
            "0",
            "--maximum-fixed-accuracy-drop",
            "1",
        ]);
        expect(smokeLaunch.argv).toContain("--allow-partial-corpus");
        expect(() =>
            buildV09LearnerLaunch(manifest, directory, [join(directory, "il/*.jsonl")], {
                minimumQatFixedAgreement: Number.NaN,
            }),
        ).toThrow("finite ratios");
        initializeV09Campaign(directory, manifest, ledger);
        initializeV09Campaign(directory, manifest, ledger);
        expect(
            JSON.parse(readFileSync(join(directory, "feature-contract.json"), "utf8")).inputFeatureNames,
        ).toHaveLength(166);
        const checkpoint = buildV09Checkpoint(manifest, "wide_teacher", 1, 2);
        writeV09Checkpoint(join(directory, "checkpoint.json"), checkpoint);
        expect(readV09Checkpoint(join(directory, "checkpoint.json"), manifest)).toEqual(checkpoint);
    });

    it("cross-validates raw scientific-notation row chains and rejects tampering/truncation before learning", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-corpus-"));
        const identity = {
            sourceCommit: "1".repeat(40),
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const counts = {
            wide_teacher_train: 1,
            wide_teacher_validation: 1,
            dagger_1_train: 1,
            dagger_1_validation: 1,
            dagger_2_train: 1,
            dagger_2_validation: 1,
            confirmation: 1,
            qualification: 1,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [], counts);
        const manifest = buildV09CampaignManifest(
            identity,
            directory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        initializeV09Campaign(directory, manifest, ledger);
        const paths: string[] = [];
        for (const [purpose, split] of [
            ["wide_teacher_train", "train"],
            ["wide_teacher_validation", "validation"],
        ] as const) {
            const seed = ledger.streams.find((stream) => stream.purpose === purpose)!.seeds[0]!;
            const gameId = `${purpose}:0:${seed}:v0.8-a13:anchor-mirror`;
            const game = {
                sourceCommit: identity.sourceCommit,
                rulesFingerprint: identity.rulesFingerprint,
                anchorFingerprint: identity.anchorFingerprint,
                phase: "wide_teacher" as const,
                split,
                cohort: "ranked-draft",
                map: "normal" as const,
                seed,
                gameId,
            };
            const recorder = new V09GameRecorder(
                {
                    runFingerprint: manifest.runFingerprint,
                    sourceCommit: identity.sourceCommit,
                    rulesFingerprint: identity.rulesFingerprint,
                    anchorFingerprint: identity.anchorFingerprint,
                },
                {
                    ...game,
                    greenVersion: "v0.8+a13",
                    redVersion: "v0.8+a13",
                    winner: "green",
                    endReason: "elimination",
                },
            );
            const values = Array<number>(VALUE_FEATURE_NAMES_V2.length).fill(0);
            values[0] = 1e-7;
            recorder.record({
                ...game,
                decision: 0,
                seat: "green",
                lap: 1,
                actorUnitName: "Archer",
                valueFeatures: values,
                incumbentIndex: 0,
                teacherIndex: 0,
                candidates: [candidate],
            });
            const path = join(directory, "il", purpose, "v0.8-a13", `000000-${seed}.jsonl`);
            recorder.finalize(path);
            paths.push(path);
        }
        const validate = () =>
            Bun.spawnSync({
                cmd: [
                    "python3",
                    join(import.meta.dir, "../../src/simulation/v0_9/python/corpus.py"),
                    "--campaign-manifest",
                    join(directory, "manifest.json"),
                    "--data",
                    join(directory, "il/**/*.jsonl"),
                ],
                env: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
            });
        const valid = validate();
        expect(`${valid.exitCode}:${valid.stderr.toString()}`).toBe("0:");

        const original = readFileSync(paths[0]!, "utf8");
        expect(original).toContain("1e-7");
        writeFileSync(paths[0]!, original.replace("1e-7", "2e-7"));
        expect(validate().exitCode).not.toBe(0);
        writeFileSync(paths[0]!, original);
        writeFileSync(paths[0]!, original.split("\n")[0]! + "\n");
        expect(validate().exitCode).not.toBe(0);
    });

    it("runs and resumes a complete shadow-teacher shard over genuine v0.8+a13 trajectories", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-actor-smoke-"));
        const identity = {
            sourceCommit: SHA_A,
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const counts = {
            wide_teacher_train: 1,
            wide_teacher_validation: 1,
            dagger_1_train: 1,
            dagger_1_validation: 1,
            dagger_2_train: 1,
            dagger_2_validation: 1,
            confirmation: 2,
            qualification: 2,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [], counts);
        const manifest = buildV09CampaignManifest(
            identity,
            directory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        initializeV09Campaign(directory, manifest, ledger);
        const priorHorizon = process.env.SEARCH_HORIZON;
        process.env.SEARCH_HORIZON = "777";
        try {
            const args = {
                campaignDirectory: directory,
                purpose: "wide_teacher_train" as const,
                workerIndex: 0,
                workers: 1,
                limit: 1,
                studentArtifact: null,
                smoke: true,
            };
            const first = runV09TeacherActor(args);
            expect(first.completed).toBe(1);
            expect(first.decisions).toBeGreaterThan(0);
            const second = runV09TeacherActor(args);
            expect(second).toEqual({ completed: 0, resumed: 1, decisions: first.decisions });
            expect(process.env.SEARCH_HORIZON).toBe("777");
            const shardDirectory = join(directory, "il-smoke", "wide_teacher_train", "v0.8-a13");
            const files = readdirSync(shardDirectory).filter((name) => name.endsWith(".jsonl"));
            expect(files).toHaveLength(1);
            const footer = validateV09GameShard(join(shardDirectory, files[0]!));
            expect([footer.greenVersion, footer.redVersion]).toEqual(["v0.8+a13", "v0.8+a13"]);
        } finally {
            if (priorHorizon === undefined) delete process.env.SEARCH_HORIZON;
            else process.env.SEARCH_HORIZON = priorHorizon;
        }
    });

    it("runs DAgger with the offline student active and a frozen a13 opponent", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-dagger-smoke-"));
        const identity = {
            sourceCommit: SHA_A,
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const counts = {
            wide_teacher_train: 1,
            wide_teacher_validation: 1,
            dagger_1_train: 1,
            dagger_1_validation: 1,
            dagger_2_train: 1,
            dagger_2_validation: 1,
            confirmation: 2,
            qualification: 2,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [], counts);
        const manifest = buildV09CampaignManifest(
            identity,
            directory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        initializeV09Campaign(directory, manifest, ledger);
        const artifact = sealV09ResearchArtifact({
            ...V09_MODEL_ARTIFACT,
            status: "trained",
            promoted: false,
            qualification: null,
            modelId: "v0.9-research-unsealed",
            modelSha256: null,
            source: {
                commonCommit: identity.sourceCommit,
                rulesSha256: identity.rulesFingerprint,
                rosterSha256: identity.rosterFingerprint,
                trainingRunId: manifest.runFingerprint,
            },
            notes: "offline DAgger activation fixture",
        });
        const artifactPath = join(directory, "student.json");
        writeFileSync(artifactPath, JSON.stringify(artifact));
        const result = runV09TeacherActor({
            campaignDirectory: directory,
            purpose: "dagger_1_train",
            workerIndex: 0,
            workers: 1,
            limit: 1,
            studentArtifact: artifactPath,
            smoke: true,
        });
        expect(result.completed).toBe(1);
        expect(result.decisions).toBeGreaterThan(0);
        const shardDirectory = join(directory, "il-smoke", "dagger_1_train", artifact.modelSha256!);
        const footer = validateV09GameShard(join(shardDirectory, readdirSync(shardDirectory)[0]!));
        expect(footer.greenVersion).toBe(`v0.9-research:${artifact.modelSha256}`);
        expect(footer.redVersion).toBe("v0.8+a13");
    });

    it("seals but never promotes a research artifact and matches Python fixed-point inference", () => {
        const unsealed: IV09ModelArtifact = {
            ...V09_MODEL_ARTIFACT,
            status: "trained",
            promoted: false,
            modelId: "v0.9-research-unsealed",
            modelSha256: null,
            source: {
                commonCommit: SHA_A,
                rulesSha256: SHA_B,
                rosterSha256: SHA_C,
                trainingRunId: RUN,
            },
            layers: [
                {
                    inputSize: 166,
                    outputSize: 1,
                    activation: "linear",
                    scaleShift: 8,
                    weights: Array<number>(166).fill(0),
                    biases: [128],
                },
            ],
            notes: "UNPROMOTED research fixture.",
        };
        const artifact = sealV09ResearchArtifact(unsealed);
        expect(artifact.promoted).toBe(false);
        expect(artifact.modelSha256).toHaveLength(64);
        expect(validateV09ModelArtifact(artifact)).toEqual([]);
        expect(serializeV09ModelHashPayload(artifact)).toContain('"minOverrideMargin":1');
        verifyV09ResearchArtifact(artifact);
        expect(scoreV09ParityVectors(artifact, [{ id: "half-away", features: Array(166).fill(0) }])).toEqual([
            { id: "half-away", score: 1 },
        ]);
        const corpus = buildV09ParityCorpus(artifact);
        expect(corpus.length).toBeGreaterThan(64);
        expect(corpus.map((vector) => vector.id)).toContain("boundary-input-round-half-negative");
        expect(corpus.map((vector) => vector.id)).toContain("boundary-input-clip-positive");
        expect(corpus.map((vector) => vector.id)).toContain("boundary-int32-accumulator-pressure-row-0");

        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-parity-"));
        const artifactPath = join(directory, "artifact.json");
        const vectorsPath = join(directory, "vectors.jsonl");
        writeFileSync(artifactPath, JSON.stringify(artifact));
        writeFileSync(vectorsPath, `${JSON.stringify({ id: "half-away", features: Array(166).fill(0) })}\n`);
        const python = Bun.spawnSync({
            cmd: [
                "python3",
                join(import.meta.dir, "../../src/simulation/v0_9/python/parity.py"),
                "--artifact",
                artifactPath,
                "--vectors",
                vectorsPath,
            ],
            env: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
        });
        expect(python.exitCode).toBe(0);
        expect(python.stdout.toString().trim()).toBe('{"id":"half-away","score":1}');
    });

    it("matches Python at input saturation, both rounding ties, and signed-int32 accumulator boundaries", () => {
        const weights = (first: number): number[] => [first, ...Array<number>(165).fill(0)];
        const seal = (
            layer: IV09ModelArtifact["layers"][number],
            fixedPoint: IV09ModelArtifact["fixedPoint"] = V09_MODEL_ARTIFACT.fixedPoint,
        ): IV09ModelArtifact =>
            sealV09ResearchArtifact({
                ...V09_MODEL_ARTIFACT,
                status: "trained",
                promoted: false,
                qualification: null,
                modelId: "v0.9-research-unsealed",
                modelSha256: null,
                source: {
                    commonCommit: SHA_A,
                    rulesSha256: SHA_B,
                    rosterSha256: SHA_C,
                    trainingRunId: RUN,
                },
                fixedPoint,
                layers: [layer],
                notes: "fixed-point parity boundary fixture",
            });
        const assertPythonParity = (artifact: IV09ModelArtifact, vectors: IV09ParityVector[]): void => {
            const expected = scoreV09ParityVectors(artifact, vectors);
            const directory = mkdtempSync(join(tmpdir(), "hoc-v09-parity-boundary-"));
            const artifactPath = join(directory, "artifact.json");
            const vectorsPath = join(directory, "vectors.jsonl");
            writeFileSync(artifactPath, JSON.stringify(artifact));
            writeFileSync(
                vectorsPath,
                `${vectors
                    .map((vector, index) => JSON.stringify({ ...vector, expectedScore: expected[index]!.score }))
                    .join("\n")}\n`,
            );
            const python = Bun.spawnSync({
                cmd: [
                    "python3",
                    join(import.meta.dir, "../../src/simulation/v0_9/python/parity.py"),
                    "--artifact",
                    artifactPath,
                    "--vectors",
                    vectorsPath,
                ],
                env: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
            });
            expect(python.exitCode).toBe(0);
            expect(
                python.stdout
                    .toString()
                    .trim()
                    .split(/\r?\n/)
                    .map((line) => JSON.parse(line)),
            ).toEqual(expected);
        };

        const inputRounding = seal({
            inputSize: 166,
            outputSize: 1,
            activation: "linear",
            scaleShift: 0,
            weights: weights(1),
            biases: [0],
        });
        assertPythonParity(inputRounding, [
            { id: "input-half-positive", features: [0.5 / 256, ...Array<number>(165).fill(0)] },
            { id: "input-half-negative", features: [-0.5 / 256, ...Array<number>(165).fill(0)] },
        ]);

        const saturated = seal(
            {
                inputSize: 166,
                outputSize: 1,
                activation: "linear",
                scaleShift: 0,
                weights: weights(1),
                biases: [0],
            },
            { ...V09_MODEL_ARTIFACT.fixedPoint, inputClip: 256 },
        );
        assertPythonParity(saturated, [
            { id: "symmetric-int16-positive", features: [1_000, ...Array<number>(165).fill(0)] },
            { id: "symmetric-int16-negative", features: [-1_000, ...Array<number>(165).fill(0)] },
        ]);

        for (const bias of [128, -128]) {
            const postAccumulatorRounding = seal({
                inputSize: 166,
                outputSize: 1,
                activation: "linear",
                scaleShift: 8,
                weights: Array<number>(166).fill(0),
                biases: [bias],
            });
            assertPythonParity(postAccumulatorRounding, [
                {
                    id: bias > 0 ? "accumulator-half-positive" : "accumulator-half-negative",
                    features: Array(166).fill(0),
                },
            ]);
        }

        const allMaxWeights = Array<number>(166).fill(127);
        const productBound = 166 * 32_767 * 127;
        for (const [id, bias, feature] of [
            ["int32-positive-boundary", 0x7fffffff - productBound, 1_000],
            ["int32-negative-boundary", -0x7fffffff + productBound, -1_000],
        ] as const) {
            const boundary = seal(
                {
                    inputSize: 166,
                    outputSize: 1,
                    activation: "linear",
                    scaleShift: 0,
                    weights: allMaxWeights,
                    biases: [bias],
                },
                { ...V09_MODEL_ARTIFACT.fixedPoint, inputClip: 256 },
            );
            assertPythonParity(boundary, [{ id, features: Array<number>(166).fill(feature) }]);
        }
    });

    it("builds a relocatable, exact-file production handoff and rejects byte tampering", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v09-handoff-"));
        const campaignDirectory = join(root, "campaign");
        const identity = {
            sourceCommit: SHA_A,
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const counts = {
            wide_teacher_train: 2,
            wide_teacher_validation: 2,
            dagger_1_train: 2,
            dagger_1_validation: 2,
            dagger_2_train: 2,
            dagger_2_validation: 2,
            confirmation: 2,
            qualification: 2,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [], counts);
        const manifest = buildV09CampaignManifest(
            identity,
            campaignDirectory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        initializeV09Campaign(campaignDirectory, manifest, ledger);
        const artifact = sealV09ResearchArtifact({
            ...V09_MODEL_ARTIFACT,
            status: "trained",
            promoted: false,
            qualification: null,
            modelId: "v0.9-research-unsealed",
            modelSha256: null,
            source: {
                commonCommit: identity.sourceCommit,
                rulesSha256: identity.rulesFingerprint,
                rosterSha256: identity.rosterFingerprint,
                trainingRunId: manifest.runFingerprint,
            },
            notes: "production handoff fixture",
        });
        const artifactPath = join(campaignDirectory, "research.json");
        writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`);
        writeV09Checkpoint(
            join(campaignDirectory, "checkpoint.json"),
            buildV09Checkpoint(manifest, "quantize", 1, 1, { researchModel: artifact.modelSha256! }),
        );
        const sourceUnsigned: Omit<IV09SourceIdentityReceipt, "receiptSha256"> = {
            schema: V09_SOURCE_IDENTITY_SCHEMA,
            sourceCommit: identity.sourceCommit,
            sourceTree: "1".repeat(40),
            sourceStatusSha256: identity.sourceStatusSha256,
            sourceDirty: false,
            rulesFingerprint: identity.rulesFingerprint,
            rosterFingerprint: identity.rosterFingerprint,
            anchorVersion: "v0.8",
            anchorFingerprint: identity.anchorFingerprint,
            trackedInputs: { rules: [], roster: [], anchor: [] },
        };
        const sourceReceipt = { ...sourceUnsigned, receiptSha256: fingerprintV09(sourceUnsigned) };
        writeFileSync(join(campaignDirectory, "source-identity.json"), `${JSON.stringify(sourceReceipt)}\n`);
        const trainingHostDirectory = join(campaignDirectory, "qualification", "training-host-s0of2");
        mkdirSync(trainingHostDirectory, { recursive: true });
        const journalPath = join(trainingHostDirectory, "qualification-pairs.jsonl");
        writeFileSync(journalPath, `${JSON.stringify({ fixture: "immutable raw evidence" })}\n`);
        const receiptUnsigned: Omit<IV09QualificationShardReceipt, "receiptSha256"> = {
            schema: V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
            promoted: false,
            status: "complete_nonpromoting_shard",
            runFingerprint: manifest.runFingerprint,
            manifestSha256: manifest.manifestSha256,
            seedLedgerSha256: ledger.ledgerSha256,
            modelSha256: artifact.modelSha256!,
            researchArtifactSha256: sha256File(artifactPath),
            planSha256: "2".repeat(64),
            shardPlanSha256: "3".repeat(64),
            shardCount: 2,
            shardIndex: 0,
            expectedPairs: 1,
            completedPairs: 1,
            expectedSimulations: 3,
            completedSimulations: 3,
            journalSha256: sha256File(journalPath),
            journalHeaderSha256: "4".repeat(64),
            runnerSourceSha256: "5".repeat(64),
            sourceIdentityReceiptSha256: sourceReceipt.receiptSha256,
            behaviorEnvironmentSha256: "6".repeat(64),
            executionFingerprint: "7".repeat(64),
            nodeRole: "training_host",
            modelP99Ms: 1,
            turnP99Ms: 2,
            rssIncreaseMiB: 3,
            completedAt: "2026-07-26T00:00:00.000Z",
        };
        const receipt = { ...receiptUnsigned, receiptSha256: fingerprintV09(receiptUnsigned) };
        writeFileSync(join(trainingHostDirectory, "qualification-shard-receipt.json"), `${JSON.stringify(receipt)}\n`);

        writeV09Checkpoint(
            join(campaignDirectory, "checkpoint.json"),
            buildV09Checkpoint(manifest, "quantize", 1, 1, { researchModel: "9".repeat(64) }),
        );
        expect(() =>
            createV09ProductionHandoffBundle({
                destination: join(root, "mismatched-handoff"),
                campaignDirectory,
                researchArtifactPath: artifactPath,
                trainingHostShardDirectory: trainingHostDirectory,
            }),
        ).toThrow("does not bind one exact research campaign/shard");
        writeV09Checkpoint(
            join(campaignDirectory, "checkpoint.json"),
            buildV09Checkpoint(manifest, "quantize", 1, 1, { researchModel: artifact.modelSha256! }),
        );

        const bundleDirectory = join(root, "handoff");
        const created = createV09ProductionHandoffBundle({
            destination: bundleDirectory,
            campaignDirectory,
            researchArtifactPath: artifactPath,
            trainingHostShardDirectory: trainingHostDirectory,
        });
        expect(created.bundle.productionCommand).toContain("<verified-relocated-bundle-dir>");
        const relocated = join(root, "relocated", "handoff");
        mkdirSync(join(root, "relocated"), { recursive: true });
        cpSync(bundleDirectory, relocated, { recursive: true });
        expect(validateV09ProductionHandoffBundle(relocated).bundle.bundleSha256).toBe(created.bundle.bundleSha256);

        const copiedArtifact = join(relocated, "research-artifact.json");
        chmodSync(copiedArtifact, 0o644);
        writeFileSync(copiedArtifact, `${readFileSync(copiedArtifact, "utf8")} `);
        expect(() => validateV09ProductionHandoffBundle(relocated)).toThrow("file hash/size mismatch");
    });

    it("requires a self-bound v0.8 path-isolation receipt and enforces the qualification gates", () => {
        expect(() => assertV09OutputIsolation("/runs/v0.8/current/v0.9", ["/runs/v0.8/current"])).toThrow(
            "overlaps protected",
        );
        const root = mkdtempSync(join(tmpdir(), "hoc-v09-protection-"));
        const campaignDirectory = join(root, "v0.9");
        const protectedRoot = join(root, "v0.8");
        const identity = {
            sourceCommit: SHA_A,
            sourceStatusSha256: SHA_B,
            sourceDirty: false as const,
            rulesFingerprint: SHA_C,
            rosterFingerprint: SHA_D,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: "f".repeat(64),
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), []);
        const manifest = buildV09CampaignManifest(
            identity,
            campaignDirectory,
            ledger,
            buildV09DevelopmentActorPhysicalCorePolicy(),
        );
        initializeV09Campaign(campaignDirectory, manifest, ledger);
        expect(() => writeV09V08ProtectionReceipt(campaignDirectory, manifest, [])).toThrow(
            "at least one --protect-v08-root",
        );
        expect(() => writeV09V08ProtectionReceipt(campaignDirectory, manifest, [protectedRoot])).toThrow(
            "does not exist",
        );
        mkdirSync(protectedRoot);
        const protectedFile = join(root, "v0.8-file");
        writeFileSync(protectedFile, "not a directory");
        expect(() => writeV09V08ProtectionReceipt(campaignDirectory, manifest, [protectedFile])).toThrow(
            "not a directory",
        );
        const protectedLink = join(root, "v0.8-link");
        symlinkSync(protectedRoot, protectedLink, "dir");
        expect(() => writeV09V08ProtectionReceipt(campaignDirectory, manifest, [protectedLink])).toThrow(
            "must not be a symlink",
        );
        const protection = writeV09V08ProtectionReceipt(campaignDirectory, manifest, [protectedRoot]);
        expect(verifyV09V08ProtectionReceipt(campaignDirectory, manifest)).toEqual(protection);
        expect(writeV09V08ProtectionReceipt(campaignDirectory, manifest, [protectedRoot])).toEqual(protection);
        const otherProtectedRoot = join(root, "v0.8-other");
        mkdirSync(otherProtectedRoot);
        expect(() => writeV09V08ProtectionReceipt(campaignDirectory, manifest, [otherProtectedRoot])).toThrow(
            "not the exact requested protection",
        );
        const burstyGpu = Array.from({ length: 24 }, (_, index) => ({
            at: `2026-07-26T00:00:${String(index).padStart(2, "0")}.000Z`,
            utilization: index % 5 === 0 ? 65 : 2,
            memoryMiB: 640,
            temperatureC: 50,
        }));
        const hardware = assessV09LearnerHardwareEvidence(burstyGpu, [100, 105, 98, 102, 101]);
        expect(hardware.medianUtilization).toBeLessThan(50);
        expect(hardware.satisfied).toBe(true);
        expect(
            assessV09LearnerHardwareEvidence(
                burstyGpu.map((sample) => ({ ...sample, utilization: 0, memoryMiB: 0 })),
                [100, 0, 0, 0, 0],
            ).satisfied,
        ).toBe(false);
        expect(
            v09QualificationFailures({
                combinedGames: 96_000,
                confirmationGames: 48_000,
                qualificationGames: 48_000,
                combinedScore: 0.56,
                confirmationScore: 0.55,
                qualificationScore: 0.55,
                lower95: 0.546,
                minimumCellScore: 0.49,
                armageddonRate: 0,
                v08ArmageddonRate: 0,
                invalidActions: 0,
                avoidablePassiveActions: 0,
                p99ModelMs: 2,
                p99TurnMs: 50,
                rssIncreaseMiB: 8,
            }),
        ).toEqual([]);
    });
});
