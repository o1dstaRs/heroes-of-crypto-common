/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { V07_ALIGNED_96H_V2_SEATS } from "./v0_7_aligned_96h_v2_core";
import {
    validateV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorReplayResolvers,
    type IV07AlignedV2SeedArtifactRef,
    type V07AlignedV2EvidenceResolver,
} from "./v0_7_aligned_96h_v2_orchestrator";
import { loadV07AlignedV2PersistedPanelShard } from "./v0_7_aligned_96h_v2_persistence";
import {
    bindV07AlignedV2SeedPlan,
    canonicalV07AlignedV2Json,
    validateV07AlignedV2CheckpointPanelBinding,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2CheckpointPanelBinding,
    type IV07AlignedV2InjectedSeedPlan,
} from "./v0_7_aligned_96h_v2_protocol";
import {
    resolveV07AlignedV2SeedPlans,
    validateV07AlignedV2SeedAllocationCommitment,
    type IV07AlignedV2FinalSeedReveal,
    type IV07AlignedV2SeedAllocationCommitment,
} from "./v0_7_aligned_96h_v2_seed_allocator";

function canonicalJsonFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
    let decoded: string;
    try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8`);
    return decoded;
}

function safeArtifactPath(root: string, relativePath: string, label: string): string {
    const segments = relativePath.split("/");
    if (
        !relativePath ||
        isAbsolute(relativePath) ||
        relativePath.includes("\\") ||
        segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
        throw new Error(`${label} must be a safe artifact-root-relative path`);
    }
    let candidate = root;
    for (const segment of segments) {
        candidate = resolve(candidate, segment);
        if (lstatSync(candidate).isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
    }
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
        throw new Error(`${label} escapes the sealed artifact root`);
    }
    return real;
}

function readCanonicalArtifact<T>(
    root: string,
    relativePath: string,
    label: string,
): { value: T; bytesSha256: string } {
    const path = safeArtifactPath(root, relativePath, label);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
    const bytes = readFileSync(path);
    const contents = decodeUtf8Exact(bytes, label);
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    let parsed: T;
    try {
        parsed = JSON.parse(contents) as T;
    } catch (error) {
        throw new Error(`${label} is malformed JSON (${String(error)})`);
    }
    if (contents !== canonicalJsonFile(parsed)) throw new Error(`${label} is not canonical JSON`);
    return { value: parsed, bytesSha256: createHash("sha256").update(bytes).digest("hex") };
}

function samePanel(left: IV07AlignedV2CheckpointPanelBinding, right: IV07AlignedV2CheckpointPanelBinding): boolean {
    return canonicalV07AlignedV2Json(left) === canonicalV07AlignedV2Json(right);
}

function bindingForGenome(
    definition: IV07AlignedV2OrchestratorDefinition,
    genomeSha256: string,
): IV07AlignedV2CandidateBinding {
    const matches = [...definition.candidates, definition.incumbent].filter(
        (candidate) => candidate.genomeSha256 === genomeSha256,
    );
    if (matches.length !== 1) throw new Error("aligned v2 evidence genome does not resolve uniquely in the catalog");
    return matches[0];
}

export interface IV07AlignedV2FilesystemResolverOptions {
    artifactRoot: string;
    definition: IV07AlignedV2OrchestratorDefinition;
    onEvidenceShardVerified?: (progress: IV07AlignedV2EvidenceShardVerificationProgress) => void;
}

export interface IV07AlignedV2EvidenceShardVerificationProgress {
    evidenceSha256: string;
    artifactIndex: number;
    artifactCount: number;
    directory: string;
    manifestSha256: string;
    shardIndex: number;
    shardCount: number;
}

export interface IV07AlignedV2FilesystemEvidenceResolverOptions extends IV07AlignedV2FilesystemResolverOptions {
    resolveSeedPlan(panel: IV07AlignedV2CheckpointPanelBinding): IV07AlignedV2InjectedSeedPlan;
}

function validatedArtifactRoot(path: string): string {
    const rootStat = lstatSync(path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error("aligned v2 artifactRoot must be a regular non-symlink directory");
    }
    return realpathSync(path);
}

function buildFilesystemEvidenceResolver(
    artifactRoot: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    resolveSeedPlan: (panel: IV07AlignedV2CheckpointPanelBinding) => IV07AlignedV2InjectedSeedPlan,
    onEvidenceShardVerified?: (progress: IV07AlignedV2EvidenceShardVerificationProgress) => void,
): V07AlignedV2EvidenceResolver {
    return (summary) => {
        const binding = bindingForGenome(definition, summary.genomeSha256);
        const seedPlan = resolveSeedPlan(summary.panel);
        if (!samePanel(bindV07AlignedV2SeedPlan(seedPlan), summary.panel)) {
            throw new Error("aligned v2 filesystem evidence resolver returned a different seed panel");
        }
        const shards = summary.artifacts.map((artifact, artifactIndex) => {
            const directory = safeArtifactPath(artifactRoot, artifact.directory, "aligned v2 evidence shard directory");
            const persisted = loadV07AlignedV2PersistedPanelShard(directory, {
                runFingerprint: definition.definitionSha256,
                binding,
                seedPlan,
                manifestSha256: artifact.manifestSha256,
            });
            if (!samePanel(persisted.evaluation.shard.panel, summary.panel)) {
                throw new Error("aligned v2 evidence shard belongs to a different committed panel");
            }
            onEvidenceShardVerified?.({
                evidenceSha256: summary.evidenceSha256,
                artifactIndex,
                artifactCount: summary.artifacts.length,
                directory: artifact.directory,
                manifestSha256: artifact.manifestSha256,
                shardIndex: persisted.evaluation.shard.shardIndex,
                shardCount: persisted.evaluation.shard.shardCount,
            });
            return persisted;
        });
        shards.sort((left, right) => left.evaluation.shard.shardIndex - right.evaluation.shard.shardIndex);
        if (!shards.length) throw new Error("aligned v2 evidence resolver received no persisted shards");
        const { shardCount, maxScenarioPairsPerShard } = shards[0].evaluation.shard;
        if (shards.length !== shardCount) {
            throw new Error("aligned v2 evidence artifact set does not contain the exact complete shard count");
        }
        let pairCursor = 0;
        for (const [index, persisted] of shards.entries()) {
            const shard = persisted.evaluation.shard;
            if (
                shard.shardIndex !== index ||
                shard.shardCount !== shardCount ||
                shard.maxScenarioPairsPerShard !== maxScenarioPairsPerShard ||
                shard.pairStart !== pairCursor
            ) {
                throw new Error("aligned v2 evidence artifact set mixes, forks, or gaps shard partitions");
            }
            pairCursor = shard.pairEndExclusive;
        }
        if (pairCursor !== seedPlan.pairs.length) {
            throw new Error("aligned v2 evidence artifact set does not cover the exact committed panel");
        }
        return shards.flatMap((persisted) => persisted.evaluation.checkpoint.observations);
    };
}

export function createV07AlignedV2FilesystemEvidenceResolver(
    options: IV07AlignedV2FilesystemEvidenceResolverOptions,
): V07AlignedV2EvidenceResolver {
    return buildFilesystemEvidenceResolver(
        validatedArtifactRoot(options.artifactRoot),
        validateV07AlignedV2OrchestratorDefinition(options.definition),
        options.resolveSeedPlan,
        options.onEvidenceShardVerified,
    );
}

/** Build strict replay resolvers rooted below one sealed output directory. */
export function createV07AlignedV2FilesystemReplayResolvers(
    options: IV07AlignedV2FilesystemResolverOptions,
): IV07AlignedV2OrchestratorReplayResolvers {
    const artifactRoot = validatedArtifactRoot(options.artifactRoot);
    const definition = validateV07AlignedV2OrchestratorDefinition(options.definition);
    const commitmentCache = new Map<string, { bytesSha256: string; value: IV07AlignedV2SeedAllocationCommitment }>();
    const revealCache = new Map<string, { bytesSha256: string; value: IV07AlignedV2FinalSeedReveal }>();
    let resolvedFinalPlan: IV07AlignedV2InjectedSeedPlan | null = null;

    const loadCommitment = (artifact: IV07AlignedV2SeedArtifactRef): IV07AlignedV2SeedAllocationCommitment => {
        const key = canonicalV07AlignedV2Json(artifact);
        const snapshot = readCanonicalArtifact<unknown>(artifactRoot, artifact.path, "aligned v2 seed commitment");
        const cached = commitmentCache.get(key);
        if (cached?.bytesSha256 === snapshot.bytesSha256) return cached.value;
        const commitment = validateV07AlignedV2SeedAllocationCommitment(snapshot.value);
        if (snapshot.bytesSha256 !== artifact.bytesSha256 || commitment.commitmentSha256 !== artifact.artifactSha256) {
            throw new Error("aligned v2 seed commitment reference hashes do not match its canonical artifact");
        }
        commitmentCache.set(key, { bytesSha256: snapshot.bytesSha256, value: commitment });
        return commitment;
    };

    const seedCommitment: NonNullable<IV07AlignedV2OrchestratorReplayResolvers["seedCommitment"]> = (artifact) => {
        const commitment = loadCommitment(artifact);
        return {
            train: commitment.trainPlan,
            confirm: commitment.confirmPlan,
            final: {
                panelId: commitment.finalPlanDescriptor.panelId,
                purpose: "final",
                scenariosPerCell: commitment.finalPlanDescriptor.scenariosPerCell,
                denysetSha256: commitment.denysetSha256,
                panelFingerprint: commitment.finalPlanSha256,
                taskCount:
                    V07_ALIGNED_V2_EVALUATOR_CELLS.length *
                    V07_ALIGNED_96H_V2_SEATS.length *
                    commitment.finalPlanDescriptor.scenariosPerCell,
                tasksSha256: commitment.finalTasksSha256,
            },
        };
    };

    const seedPlans: NonNullable<IV07AlignedV2OrchestratorReplayResolvers["seedPlans"]> = (artifacts, frozen) => {
        const commitment = loadCommitment(artifacts.commitment);
        const revealKey = canonicalV07AlignedV2Json(artifacts.finalReveal);
        const snapshot = readCanonicalArtifact<IV07AlignedV2FinalSeedReveal>(
            artifactRoot,
            artifacts.finalReveal.path,
            "aligned v2 final seed reveal",
        );
        const cached = revealCache.get(revealKey);
        const reveal = cached?.bytesSha256 === snapshot.bytesSha256 ? cached.value : snapshot.value;
        if (!cached || cached.bytesSha256 !== snapshot.bytesSha256) {
            if (
                snapshot.bytesSha256 !== artifacts.finalReveal.bytesSha256 ||
                reveal.finalPlanRevealSha256 !== artifacts.finalReveal.artifactSha256
            ) {
                throw new Error("aligned v2 final seed reveal reference hashes do not match its canonical artifact");
            }
            revealCache.set(revealKey, { bytesSha256: snapshot.bytesSha256, value: reveal });
        }
        const plans = resolveV07AlignedV2SeedPlans(commitment, reveal, {
            genomeSha256: frozen.genomeSha256,
            freezeArtifactSha256: frozen.freezeArtifactSha256,
        });
        resolvedFinalPlan = plans.final;
        return plans;
    };

    const planForSummary = (panel: IV07AlignedV2CheckpointPanelBinding): IV07AlignedV2InjectedSeedPlan => {
        validateV07AlignedV2CheckpointPanelBinding(panel);
        const commitment = loadCommitment(definition.seedCommitment);
        if (samePanel(panel, bindV07AlignedV2SeedPlan(commitment.trainPlan))) return commitment.trainPlan;
        if (samePanel(panel, bindV07AlignedV2SeedPlan(commitment.confirmPlan))) return commitment.confirmPlan;
        if (samePanel(panel, definition.panels.finalCommitment) && resolvedFinalPlan) return resolvedFinalPlan;
        throw new Error("aligned v2 persisted evidence panel has no currently revealed committed seed plan");
    };

    const evidence = buildFilesystemEvidenceResolver(
        artifactRoot,
        definition,
        planForSummary,
        options.onEvidenceShardVerified,
    );

    return { evidence, seedCommitment, seedPlans };
}
