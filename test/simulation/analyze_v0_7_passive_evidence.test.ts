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

import { describe, expect, it } from "bun:test";

import {
    analyzeV07PassiveEvidence,
    bootstrapV07PassiveShadowGames,
    type IV07PassiveEvidenceInput,
    type IV07PassiveShadowGameCluster,
} from "../../src/simulation/analyze_v0_7_passive_evidence";
import {
    buildV07SelfplayPassiveAuditSeedPlan,
    buildV07SelfplayPassiveAuditShardSpecs,
    fingerprintV07SelfplayPassiveAudit,
    V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY,
    v07SelfplayPassiveAuditRunFingerprint,
    type IV07SelfplayPassiveAuditSeedPlan,
} from "../../src/simulation/run_v0_7_selfplay_passive_audit";
import { V07_ARCHETYPE_TEMPLATE_NAMES } from "../../src/simulation/v0_7_archetype_battery";

const revision = {
    commit: "a".repeat(40),
    commitDate: "2026-07-16T20:01:22-07:00",
    branch: "main",
    remote: "git@example.invalid:heroes-of-crypto-common.git",
    trackedClean: true,
    trackedDiffSha256: null,
};

const integrityGate = {
    status: "pass",
    rejectedActions: 0,
    recoveryTurns: 0,
    recoveryDefendTurns: 0,
    recoveryAdvanceTurns: 0,
    recoveryFailedTurns: 0,
    reproSamples: [],
};

function summarySeedPlan(gamesPerTemplate: number) {
    const plan = buildV07SelfplayPassiveAuditSeedPlan({
        gamesPerTemplate,
        seedKey: V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY,
    });
    return {
        plan,
        summary: {
            construction: plan.construction,
            domain: plan.domain,
            seedKey: plan.seedKey,
            seedKeySha256: plan.seedKeySha256,
            gamesPerTemplate: plan.gamesPerTemplate,
            totalGames: plan.totalGames,
            collisionAudit: plan.collisionAudit,
            sortedSeedSetSha256: plan.sortedSeedSetSha256,
            freshness: plan.freshness,
            planSha256: plan.planSha256,
            templates: plan.templates.map(({ template, seeds, seedsSha256 }) => ({
                template,
                games: seeds.length,
                seedsSha256,
            })),
        },
    };
}

function coverage(gamesPerTemplate: number) {
    const total = gamesPerTemplate * V07_ARCHETYPE_TEMPLATE_NAMES.length;
    return {
        expectedGames: total,
        reducedGames: total,
        uniqueSeeds: total,
        duplicateSeeds: 0,
        templates: Object.fromEntries(V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, gamesPerTemplate])),
    };
}

function dimension(key: string) {
    const passive = {
        passiveTurns: 0,
        turnsWithCandidate: 0,
        turnsWithPositiveExpectedDamage: 0,
        turnsWithExpectedKill: 0,
        truncatedTurns: 0,
        truncatedClasses: {},
        byMeleeRoute: {
            direct: { turnsWithCandidate: 0 },
            move_assisted: { turnsWithCandidate: 0 },
        },
    };
    return {
        key,
        decisions: key === "aggregate" ? 8 : 1,
        intents: { skip: 0, shield: 0 },
        skip: passive,
        shield: passive,
    };
}

function checkpoints(plan: IV07SelfplayPassiveAuditSeedPlan, shardGames: number) {
    const specs = buildV07SelfplayPassiveAuditShardSpecs(plan, shardGames);
    const index = specs.map((spec) => ({
        id: spec.id,
        template: spec.template,
        gameStart: spec.gameStart,
        gameEndExclusive: spec.gameEndExclusive,
        seedsSha256: spec.seedsSha256,
        shardSha256: spec.shardSha256,
        payloadSha256: "e".repeat(64),
    }));
    return {
        shardGames,
        shards: specs.length,
        resumedShards: 0,
        computedShards: specs.length,
        indexSha256: fingerprintV07SelfplayPassiveAudit(index),
        index,
    };
}

function fixture(): IV07PassiveEvidenceInput {
    const censusPlan = summarySeedPlan(12_500);
    const shadowPlan = summarySeedPlan(500);
    const strictEnvironment = { schemaVersion: 1, mode: "strict", variables: {} } as const;
    const shadowVariables = {
        SEARCH_ACTIVE_CHALLENGERS: "1",
        SEARCH_AUDIT: "/tmp/search.jsonl",
        SEARCH_AUDIT_TURNS: "1",
        SEARCH_CHALLENGER_KINDS: "melee,shot,area_throw",
        SEARCH_GATE: "0.01",
        SEARCH_HORIZON: "12",
        SEARCH_INCUMBENT_KINDS: "idle,defend",
        SEARCH_OBSERVE_ONLY: "1",
        SEARCH_ROLLOUTS: "3",
        SEARCH_VALIDATION_ROLLOUTS: "16",
        SEARCH_VERSIONS: "v0.7",
        V07_SEARCH: "1",
    };
    const shadowEnvironment = {
        schemaVersion: 1,
        mode: "observational-shadow",
        variables: shadowVariables,
    } as const;
    const common = {
        schemaVersion: 1,
        status: "v0.7_selfplay_passive_audit_complete",
        sourceSha256: "b".repeat(64),
        revision,
        integrityGate,
    };
    const formalGitAttestation = {
        schemaVersion: 1 as const,
        repositoryRoot: "/tmp/common",
        revision,
        originMain: revision.commit,
        liveOriginMain: revision.commit,
        cleanIncludingUntracked: true,
        statusPorcelainSha256: null,
    };
    const censusEnvironment = {
        ...strictEnvironment,
        environmentSha256: fingerprintV07SelfplayPassiveAudit(strictEnvironment),
    };
    const censusSummary: Record<string, unknown> = {
        ...common,
        environment: censusEnvironment,
        formalGitAttestation,
        coverage: coverage(12_500),
        seedPlan: censusPlan.summary,
        checkpoints: checkpoints(censusPlan.plan, 500),
        diagnostic: {
            games: 100_000,
            aggregate: dimension("aggregate"),
            byTemplate: V07_ARCHETYPE_TEMPLATE_NAMES.map(dimension),
        },
    };
    censusSummary.runFingerprint = v07SelfplayPassiveAuditRunFingerprint({
        planSha256: censusPlan.plan.planSha256,
        shardGames: 500,
        maxLaps: null,
        revision,
        sourceSha256: common.sourceSha256,
        environment: censusEnvironment,
        formalGitAttestation,
    });
    const boundShadowEnvironment = {
        ...shadowEnvironment,
        environmentSha256: fingerprintV07SelfplayPassiveAudit(shadowEnvironment),
    };
    const shadowSummary: Record<string, unknown> = {
        ...common,
        environment: boundShadowEnvironment,
        formalGitAttestation: null,
        coverage: coverage(500),
        seedPlan: shadowPlan.summary,
        checkpoints: checkpoints(shadowPlan.plan, 50),
    };
    shadowSummary.runFingerprint = v07SelfplayPassiveAuditRunFingerprint({
        planSha256: shadowPlan.plan.planSha256,
        shardGames: 50,
        maxLaps: null,
        revision,
        sourceSha256: common.sourceSha256,
        environment: boundShadowEnvironment,
        formalGitAttestation: null,
    });
    const firstSeed = shadowPlan.plan.templates[0].seeds[0];
    const rows: Record<string, unknown>[] = [
        {
            t: "turn",
            seed: firstSeed,
            side: "green",
            unitId: "unit-1",
            lap: 1,
            decisionOrdinal: 2,
            inc: "idle",
            chosen: "idle",
            ov: 0,
            observeOnly: 1,
            wouldOverride: 1,
            selectedKind: "melee",
            selectedSignature: "mv:1,1|ml:target@1,1",
            discoveryDelta: 0.02,
            validationRollouts: 16,
            validationDelta: 0.03,
        },
    ];
    for (const seed of shadowPlan.plan.templates.flatMap((entry) => entry.seeds)) {
        rows.push({
            t: "game",
            seed,
            mode: "search",
            green: "v0.7",
            red: "v0.7",
            gate: 0.01,
            horizon: 12,
            rollouts: 3,
            leaf: "learned",
            observeOnly: true,
            validationRollouts: 16,
            illegalIncumbent: 0,
            deadlineFallbacks: 0,
            circuitOpened: false,
            incumbentKinds: ["idle", "defend"],
            challengerKinds: ["melee", "shot", "area_throw"],
            searched: seed === firstSeed ? 1 : 0,
        });
    }
    const shadowAuditJsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    return {
        censusSummary,
        censusSummaryText: JSON.stringify(censusSummary),
        censusPath: "/tmp/census.json",
        shadowSummary,
        shadowSummaryText: JSON.stringify(shadowSummary),
        shadowSummaryPath: "/tmp/shadow-summary.json",
        shadowAuditJsonl,
        shadowAuditPath: "/tmp/search.jsonl",
        bootstrapReplicates: 10,
    };
}

describe("v0.7 passive evidence analyzer", () => {
    it("bootstraps whole games deterministically and preserves no-comparison cohorts as null", () => {
        const clusters: IV07PassiveShadowGameCluster[] = V07_ARCHETYPE_TEMPLATE_NAMES.flatMap((template, index) => [
            { template, seed: index * 10 + 1, validationDeltas: index ? [] : [0.02, -0.01] },
            { template, seed: index * 10 + 2, validationDeltas: index ? [] : [0.03] },
        ]);
        const first = bootstrapV07PassiveShadowGames(clusters, 50, "fixture");
        const replay = bootstrapV07PassiveShadowGames(clusters, 50, "fixture");

        expect(replay).toEqual(first);
        expect(first.aggregate.comparisons).toBe(3);
        expect(first.aggregate.metrics.validationPositiveRate.point).toBe(2 / 3);
        expect(first.byTemplate[0].metrics.meanValidationDelta.confidence95).not.toBeNull();
        expect(first.byTemplate[1].metrics.validationPositiveRate).toEqual({ point: null, confidence95: null });
    });

    it("binds the exact plans, integrity gates, reducer coverage, and observe-only rows", () => {
        const input = fixture();
        const report = analyzeV07PassiveEvidence(input);

        expect(report.coverage).toMatchObject({ censusGames: 100_000, shadowGames: 4_000, shadowComparisons: 1 });
        expect(report.modelBasedRolloutShadow.bootstrap.aggregate.metrics.validationAtLeastPoint01Rate.point).toBe(1);
        expect(report.modelBasedRolloutShadow.selectedMeleeRoutes.move_assisted).toBe(1);

        const brokenIntegrity = structuredClone(input);
        (
            brokenIntegrity.shadowSummary as { integrityGate: { rejectedActions: number } }
        ).integrityGate.rejectedActions = 1;
        expect(() => analyzeV07PassiveEvidence(brokenIntegrity)).toThrow("integrity gate");

        const incompleteAudit = {
            ...input,
            shadowAuditJsonl: input.shadowAuditJsonl.split("\n").slice(0, -2).join("\n"),
        };
        expect(() => analyzeV07PassiveEvidence(incompleteAudit)).toThrow("missing 1 planned game");
    });
});
