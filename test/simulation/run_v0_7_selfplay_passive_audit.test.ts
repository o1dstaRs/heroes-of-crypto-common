/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    assertV07SelfplayPassiveAuditEnvironment,
    assertV07SelfplayPassiveAuditFormalGitAttestation,
    bootstrapV07SelfplayPassiveAuditClusters,
    buildV07SelfplayPassiveAuditSeedPlan,
    buildV07SelfplayPassiveAuditShardSpecs,
    fingerprintV07SelfplayPassiveAudit,
    loadV07SelfplayPassiveAuditCheckpoint,
    readV07SelfplayPassiveAuditFormalGitAttestation,
    resolveV07SelfplayPassiveAuditEnvironment,
    runV07SelfplayPassiveAudit,
    saveV07SelfplayPassiveAuditCheckpoint,
    V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL,
    v07SelfplayPassiveAuditRunFingerprint,
} from "../../src/simulation/run_v0_7_selfplay_passive_audit";
import { v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v0.7 self-play passive-audit seed and shard plan", () => {
    it("derives the same globally unique plan and hashes for the same key", () => {
        const first = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 257, seedKey: "unit-test-key" });
        const replay = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 257, seedKey: "unit-test-key" });
        const changed = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 257, seedKey: "other-key" });
        const seeds = first.templates.flatMap(({ seeds: templateSeeds }) => templateSeeds);

        expect(replay).toEqual(first);
        expect(changed.planSha256).not.toBe(first.planSha256);
        expect(seeds).toHaveLength(257 * V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.templates.length);
        expect(new Set(seeds).size).toBe(seeds.length);
        expect(first.collisionAudit.acceptedSeeds).toBe(seeds.length);
        expect(first.collisionAudit.candidatesExamined).toBe(
            first.collisionAudit.acceptedSeeds + first.collisionAudit.rejectedCandidates,
        );
        expect(first.collisionAudit.withinPlanCollisions).toBe(first.collisionAudit.rejectedCandidates);
        expect(first.freshness).toEqual({
            internalUniqueness: true,
            priorCorpusScanned: false,
            claim: "NOT_CLAIMED_PRIOR_CORPORA_NOT_SCANNED",
        });
        expect(first.planSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(first.sortedSeedSetSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("builds the default 100k panel as 25 complete 500-game shards per template", () => {
        const plan = buildV07SelfplayPassiveAuditSeedPlan();
        const shards = buildV07SelfplayPassiveAuditShardSpecs(plan);
        const allShardSeeds = shards.flatMap(({ seeds }) => seeds);

        expect(plan.totalGames).toBe(100_000);
        expect(shards).toHaveLength(200);
        expect(allShardSeeds).toHaveLength(100_000);
        expect(new Set(allShardSeeds).size).toBe(100_000);
        for (const template of V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.templates) {
            const templateShards = shards.filter((shard) => shard.template === template);
            expect(templateShards).toHaveLength(25);
            expect(templateShards.every((shard) => shard.seeds.length === 500)).toBe(true);
        }
    });

    it("rejects behavior-changing AI environment variables", () => {
        expect(() => assertV07SelfplayPassiveAuditEnvironment({ PATH: "/bin" })).not.toThrow();
        expect(() =>
            assertV07SelfplayPassiveAuditEnvironment({
                PATH: "/bin",
                V07_WAIT_WEIGHTS: "{}",
                SEARCH_GATE: "1",
                Q2_ORACLE: "v0.7",
                CEM_MEAN: "candidate.json",
                VALUE_DATA: "turns.jsonl",
            }),
        ).toThrow("CEM_MEAN, Q2_ORACLE, SEARCH_GATE, V07_WAIT_WEIGHTS, VALUE_DATA");
    });

    it("binds a narrowly validated observe-only shadow environment into the run fingerprint", () => {
        const shadowEnvironment = {
            V07_SEARCH: "1",
            SEARCH_ACTIVE_CHALLENGERS: "1",
            SEARCH_AUDIT: join(tmpdir(), "v07-passive-shadow.jsonl"),
            SEARCH_AUDIT_TURNS: "1",
            SEARCH_CHALLENGER_KINDS: "melee,shot,area_throw",
            SEARCH_INCUMBENT_KINDS: "idle,defend",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_ROLLOUTS: "3",
            SEARCH_VALIDATION_ROLLOUTS: "16",
            SEARCH_VERSIONS: "v0.7",
        };
        const first = resolveV07SelfplayPassiveAuditEnvironment("observational-shadow", shadowEnvironment);
        const changed = resolveV07SelfplayPassiveAuditEnvironment("observational-shadow", {
            ...shadowEnvironment,
            SEARCH_VALIDATION_ROLLOUTS: "17",
        });
        const revision = {
            commit: "a".repeat(40),
            commitDate: "2026-07-16T00:00:00Z",
            branch: "main",
            remote: "git@example.test:heroes-of-crypto-common.git",
            trackedClean: true,
            trackedDiffSha256: null,
        };
        const fingerprintInput = {
            planSha256: "b".repeat(64),
            shardGames: 4,
            maxLaps: null,
            revision,
            sourceSha256: "c".repeat(64),
        };

        expect(first.mode).toBe("observational-shadow");
        expect(changed.environmentSha256).not.toBe(first.environmentSha256);
        expect(v07SelfplayPassiveAuditRunFingerprint({ ...fingerprintInput, environment: changed })).not.toBe(
            v07SelfplayPassiveAuditRunFingerprint({ ...fingerprintInput, environment: first }),
        );
        expect(() =>
            resolveV07SelfplayPassiveAuditEnvironment("observational-shadow", {
                ...shadowEnvironment,
                SEARCH_OBSERVE_ONLY: "0",
            }),
        ).toThrow("SEARCH_OBSERVE_ONLY=1");
        expect(() =>
            resolveV07SelfplayPassiveAuditEnvironment("observational-shadow", {
                ...shadowEnvironment,
                V07_WAIT_WEIGHTS: "{}",
            }),
        ).toThrow("V07_WAIT_WEIGHTS");
    });

    it("attests an explicit common repository root and fails closed off clean live main", () => {
        const commit = "d".repeat(40);
        const calls: Array<{ repositoryRoot: string; command: string }> = [];
        const readGit = (repositoryRoot: string, args: readonly string[]): string => {
            const command = args.join(" ");
            calls.push({ repositoryRoot, command });
            const values: Record<string, string> = {
                "rev-parse HEAD": commit,
                "diff --binary HEAD": "",
                "remote get-url origin": "git@example.test:heroes-of-crypto-common.git",
                "show -s --format=%cI HEAD": "2026-07-16T00:00:00Z",
                "rev-parse --abbrev-ref HEAD": "main",
                "status --porcelain=v1 --untracked-files=all": "",
                "rev-parse origin/main": commit,
                "ls-remote --exit-code origin refs/heads/main": `${commit}\trefs/heads/main`,
            };
            const value = values[command];
            if (value === undefined) throw new Error(`Unexpected git command: ${command}`);
            return value;
        };
        const attestation = readV07SelfplayPassiveAuditFormalGitAttestation("/tmp/explicit-common", readGit);

        expect(attestation.repositoryRoot).toBe("/tmp/explicit-common");
        expect(calls.every(({ repositoryRoot }) => repositoryRoot === "/tmp/explicit-common")).toBe(true);
        expect(attestation.revision.commit).toBe(commit);
        expect(attestation.liveOriginMain).toBe(commit);
        expect(() =>
            assertV07SelfplayPassiveAuditFormalGitAttestation({
                ...attestation,
                cleanIncludingUntracked: false,
                statusPorcelainSha256: "e".repeat(64),
            }),
        ).toThrow("including untracked files");
        expect(() =>
            assertV07SelfplayPassiveAuditFormalGitAttestation({
                ...attestation,
                liveOriginMain: "f".repeat(40),
            }),
        ).toThrow("HEAD == live origin/main");
    });

    it("bootstraps complete games deterministically for aggregate, archetype, and template cohorts", () => {
        const clusters = V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.templates.map((template, game) => ({
            template,
            archetype: v07ArchetypeTemplate(template).archetype,
            game,
            seed: 1000 + game,
            winner: game % 2 ? ("red" as const) : ("green" as const),
            laps: 4,
            endReason: "elimination" as const,
            decisions: 20 + game,
            skipIntents: game,
            shieldIntents: 2,
            passiveTurnsWithAttackCandidate: Math.min(game + 2, 3),
            passiveTurnsWithPositiveExpectedDamage: Math.min(game + 2, 2),
            actualUnitSkippedTurns: game,
            explicitUnitDefendedTurns: 2,
            recoveryTurns: 0,
            recoveryDefendTurns: 0,
            recoveryAdvanceTurns: 0,
            recoveryFailedTurns: 0,
            rejectedTurns: 0,
            rejectedActions: 0,
        }));
        const first = bootstrapV07SelfplayPassiveAuditClusters(clusters, 50, "a".repeat(64));
        const replay = bootstrapV07SelfplayPassiveAuditClusters(clusters, 50, "a".repeat(64));

        expect(replay).toEqual(first);
        expect(first.aggregate.games).toBe(8);
        expect(first.byArchetypeCohort.map(({ key, games }) => [key, games])).toEqual([
            ["mage", 2],
            ["meleeMage", 2],
            ["aura", 2],
            ["ranged", 2],
        ]);
        expect(first.byTemplate).toHaveLength(8);
        expect(first.aggregate.metrics.skipShare.confidence95).not.toBeNull();
    });
});

describe("v0.7 self-play passive-audit checkpoint resume", () => {
    it("rejects ambient behavior overrides at the programmatic API boundary before creating checkpoints", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-passive-audit-env-"));
        temporaryDirectories.push(directory);
        const previous = process.env.V07_WAIT_WEIGHTS;
        process.env.V07_WAIT_WEIGHTS = "{}";
        try {
            await expect(
                runV07SelfplayPassiveAudit({
                    plan: buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 1, seedKey: "env-test" }),
                    checkpointDir: directory,
                    shardGames: 1,
                    concurrency: 1,
                    maxLaps: 1,
                    bootstrapReplicates: 1,
                }),
            ).rejects.toThrow("V07_WAIT_WEIGHTS");
            expect(readdirSync(directory)).toEqual([]);
        } finally {
            if (previous === undefined) delete process.env.V07_WAIT_WEIGHTS;
            else process.env.V07_WAIT_WEIGHTS = previous;
        }
    });

    it("round-trips an exact shard and fails closed on template/range or payload corruption", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-passive-audit-"));
        temporaryDirectories.push(directory);
        const plan = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 8, seedKey: "checkpoint-test" });
        const spec = buildV07SelfplayPassiveAuditShardSpecs(plan, 4)[0];
        const fingerprint = v07SelfplayPassiveAuditRunFingerprint({
            planSha256: plan.planSha256,
            shardGames: 4,
            maxLaps: null,
        });
        const payload = {
            games: 4,
            clusters: spec.seeds.map((seed) => ({ seed, decisions: 3, policySkips: 1, policyShields: 0 })),
        };
        const path = join(directory, `${spec.id}.json`);

        saveV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint, payload);
        expect(loadV07SelfplayPassiveAuditCheckpoint<typeof payload>(directory, spec, fingerprint)).toEqual(payload);
        expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);

        const recoveryPayload = {
            ...payload,
            reproSamples: [
                {
                    kind: "recovery",
                    recoveryAttempts: [{ source: "defend", completed: true, rejectionReason: undefined }],
                },
            ],
        };
        saveV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint, recoveryPayload);
        expect(loadV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint)).toEqual(
            JSON.parse(JSON.stringify(recoveryPayload)),
        );

        const wrongFingerprint = fingerprintV07SelfplayPassiveAudit("wrong run");
        expect(() => loadV07SelfplayPassiveAuditCheckpoint(directory, spec, wrongFingerprint)).toThrow(
            "run fingerprint mismatch",
        );

        const rangeCorruption = JSON.parse(readFileSync(path, "utf8")) as {
            shard: { gameEndExclusive: number };
        };
        rangeCorruption.shard.gameEndExclusive += 1;
        writeFileSync(path, `${JSON.stringify(rangeCorruption)}\n`);
        expect(() => loadV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint)).toThrow(
            "template, range, seeds, or shard fingerprint mismatch",
        );

        saveV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint, payload);
        const payloadCorruption = JSON.parse(readFileSync(path, "utf8")) as {
            payload: { games: number };
        };
        payloadCorruption.payload.games += 1;
        writeFileSync(path, `${JSON.stringify(payloadCorruption)}\n`);
        expect(() => loadV07SelfplayPassiveAuditCheckpoint(directory, spec, fingerprint)).toThrow(
            "payload fingerprint mismatch",
        );
    });

    it("runs one real game per template through workers and resumes every exact shard", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-passive-audit-workers-"));
        temporaryDirectories.push(directory);
        const plan = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate: 1, seedKey: "worker-resume-test" });
        const options = {
            plan,
            checkpointDir: directory,
            shardGames: 1,
            concurrency: 2,
            maxLaps: 1,
            bootstrapReplicates: 10,
        };

        const first = await runV07SelfplayPassiveAudit(options);
        const resumed = await runV07SelfplayPassiveAudit(options);

        expect(first.coverage).toMatchObject({
            expectedGames: 8,
            reducedGames: 8,
            uniqueSeeds: 8,
            duplicateSeeds: 0,
        });
        expect(first.checkpoints).toMatchObject({ shards: 8, resumedShards: 0, computedShards: 8 });
        expect(resumed.checkpoints).toMatchObject({ shards: 8, resumedShards: 8, computedShards: 0 });
        expect(resumed.runFingerprint).toBe(first.runFingerprint);
        expect(resumed.diagnostic).toEqual(first.diagnostic);
        expect(first.gameClusterBootstrap.byArchetypeCohort).toHaveLength(4);
    });
});
