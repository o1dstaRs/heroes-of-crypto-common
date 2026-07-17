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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import { parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { hashSimulationParts } from "../../src/simulation/army";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import { creatureIdForName } from "../../src/simulation/draft";
import {
    runConditionalPickGame,
    runRankedConditionalPickGame,
    shippedLeagueGenome,
    type IConditionalArmy,
} from "../../src/simulation/measure_setup_conditional";
import {
    v07ArchetypeTemplate,
    V07_ARCHETYPES,
    V07_ARCHETYPE_TAXONOMY,
    V07_ARCHETYPE_TEMPLATE_NAMES,
} from "../../src/simulation/v0_7_archetype_battery";
import {
    acquireV07ComposedHostLock,
    assertV07ComposedPriorStageIntegrity,
    assertV07ComposedUniformExecutionEnvelope,
    environmentFingerprint,
    gitProvenance,
    normalizeV07ComposedOriginIdentity,
    playV07ComposedGame,
    preregisteredV07ComposedBaseSeed,
    readV07ComposedManifest,
    replayV07ComposedTaxonomyRecords,
    scenarioSeed,
    summarizeV07ComposedCell,
    validateV07ComposedFinalReport,
    validateV07ComposedManifest,
    V07_COMPOSED_CELL_IDS,
    V07_COMPOSED_COLLIDING_MAIN_ORDINALS,
    V07_COMPOSED_FORMAL_Z,
    V07_COMPOSED_MAIN_LOGICAL_SLOTS,
    V07_COMPOSED_SEED_SCAN_EXCLUDED_RELATIVE_PATHS,
    V07_COMPOSED_ZINC_CORPUS_EXCLUSIONS,
    V07_COMPOSED_TAXONOMY_CELL_IDS,
    V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS,
    v07ComposedCombatSeed,
    v07ComposedReservedSeedEnvelope,
    v07ComposedReservedSeedSlots,
    v07ComposedSetupSeed,
    v07ComposedWilsonInterval,
    v07ComposedCompletionEvidenceRoot,
    verifyV07ComposedTaxonomyCellPlan,
    type IV07ComposedAuditRow,
    type IV07ComposedCell,
    type IV07ComposedCellCompletion,
    type IV07ComposedCellReport,
    type IV07ComposedFinalReport,
    type IV07ComposedGameRecord,
    type IV07ComposedManifest,
} from "../../src/simulation/v0_7_composed_ranked_ladder";
import {
    expandV07ComposedDerivedProtocolSchedules,
    expandV07ComposedDerivedTournamentSchedules,
    expandV07ComposedTournamentSeedSeries,
    fingerprintV07ComposedSeedSet,
    fingerprintV07ComposedDerivedTournamentSchedules,
    scanV07ComposedSeedCorpus,
    type IV07ComposedDerivedProtocolSchedule,
} from "../../src/simulation/v0_7_composed_seed_scan";

const frozenManifestPath = join(
    import.meta.dir,
    "../../src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
);
const frozenLoaded = readV07ComposedManifest(frozenManifestPath);
const frozen = frozenLoaded.manifest;
const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixedCell(games = 2, qualification = false): IV07ComposedCell {
    const id = "mage_frontline_conservative200_275";
    return {
        id,
        stage: 3,
        distribution: "fixed_template",
        scenarioProtocol: "fixed_physical_side_swap",
        archetype: "mage",
        template: "mage_frontline",
        profile: "conservative_200_275",
        candidate: "v0.7s",
        opponent: "v0.6",
        games,
        pairScenarios: games / 2,
        baseSeed: preregisteredV07ComposedBaseSeed(id),
        qualification,
        purpose: "test fixed cell",
    };
}

function taxonomyCell(): IV07ComposedCell {
    const id = V07_COMPOSED_TAXONOMY_CELL_IDS.mage;
    return {
        id,
        stage: 2,
        distribution: "ranked_taxonomy",
        scenarioProtocol: "independent_seat_conditioned",
        archetype: "mage",
        profile: "conservative_200_275",
        candidate: "v0.7s",
        opponent: "v0.6",
        games: 2,
        pairScenarios: 1,
        baseSeed: preregisteredV07ComposedBaseSeed(id),
        qualification: true,
        purpose: "test taxonomy cell",
    };
}

function fakeResult(config: IMatchConfig, winner: "green" | "red" | "draw" = "green"): IMatchResult {
    return {
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner,
        endReason: "elimination",
        laps: 4,
        totalActions: 0,
        roster: config.roster,
        redRoster: config.redRoster,
        placements: { green: [], red: [] },
        actions: [],
        outcome: {
            green: {
                version: config.greenVersion,
                unitsAlive: winner === "red" ? 0 : 6,
                creaturesAlive: winner === "red" ? 0 : 6,
                hpRemaining: winner === "red" ? 0 : 100,
            },
            red: {
                version: config.redVersion,
                unitsAlive: winner === "green" ? 0 : 6,
                creaturesAlive: winner === "green" ? 0 : 6,
                hpRemaining: winner === "green" ? 0 : 100,
            },
        },
        attrition: {
            reachedArmageddon: false,
            armageddonWaves: 0,
            unitsKilledByArmageddon: 0,
            unitsKilledByNarrowing: 0,
            decidedByArmageddon: false,
        },
        rejectedGreen: 0,
        rejectedRed: 0,
        rejectedDetails: [],
        greenArtifactT1: config.greenArtifactT1 ?? 0,
        redArtifactT1: config.redArtifactT1 ?? 0,
        greenArtifactT2: config.greenArtifactT2 ?? 0,
        redArtifactT2: config.redArtifactT2 ?? 0,
    };
}

function noAuditManifest(manifestId: string): IV07ComposedManifest {
    const manifest = structuredClone(frozen);
    manifest.manifestId = manifestId;
    manifest.searchProfiles.conservative_200_275.search = false;
    return manifest;
}

function audit(record: IV07ComposedGameRecord): IV07ComposedAuditRow {
    const profile = frozen.searchProfiles.conservative_200_275;
    return {
        t: "game",
        mode: "search",
        seed: record.combatSeed,
        green: record.greenVersion,
        red: record.redVersion,
        winner: record.winner,
        endReason: record.endReason,
        gate: profile.gate,
        horizon: profile.horizon,
        rollouts: profile.rollouts,
        leaf: profile.leaf,
        decisions: 4,
        searched: 3,
        overrides: 1,
        illegalIncumbent: 0,
        shortlist: null,
        decisionDeadlineMs: profile.decisionDeadlineMs,
        deadlineFallbacks: 0,
        lateRangedFinishWeight: 0,
        pureRangedTerminalWeight: 0,
        msTotal: 125,
        circuitBreakerMs: profile.circuitBreakerMs,
        circuitOpened: false,
        circuitSkipped: 0,
    };
}

function pickWithMage(base: { lower: IConditionalArmy; upper: IConditionalArmy }, lower: boolean, upper: boolean) {
    const pick = structuredClone(base);
    for (const unit of [...pick.lower.roster, ...pick.upper.roster]) {
        if (V07_ARCHETYPE_TAXONOMY.mage.includes(unit.creatureName)) unit.creatureName = "Peasant";
    }
    pick.lower.roster[0].creatureName = lower ? V07_ARCHETYPE_TAXONOMY.mage[0] : "Peasant";
    pick.upper.roster[0].creatureName = upper ? V07_ARCHETYPE_TAXONOMY.mage[0] : "Peasant";
    return pick;
}

describe("composed-ranked preregistration", () => {
    it("freezes sixteen cells, thirteen formal cells, and twenty-six seat hypotheses", () => {
        expect(frozen.cells.map((cell) => cell.id)).toEqual([...V07_COMPOSED_CELL_IDS]);
        expect(frozen.cells).toHaveLength(16);
        expect(frozen.cells.filter((cell) => cell.qualification)).toHaveLength(13);
        expect(frozen.execution).toMatchObject({
            pairScenarios: 19000,
            games: 38000,
            searchGames: 36000,
            offControlGames: 2000,
            requiredConcurrency: 12,
        });
        expect(frozen.gates).toMatchObject({
            formalCellCount: 13,
            formalHypotheses: 26,
            nominalFamilywiseConfidence: 0.95,
            formalZ: V07_COMPOSED_FORMAL_Z,
            minimumSeatDecisiveFraction: 0.9,
            qualificationSeatWilsonLow: 0.9,
            maxSeatDrawOrArmageddonFraction: 0.1,
            coverageCaveat: "wilson_bonferroni_is_nominal_not_exact_finite_sample_coverage",
        });
        expect(frozen.runtimeProvenance.bunLockPolicy).toBe("intentionally_absent_bind_exact_installed_manifests");
        expect(Object.keys(frozen.serverReference.sourceSha256).sort()).toEqual(
            [
                "src/api/game/v1/bot_search.ts",
                "src/api/game/v1/draft_policy.ts",
                "src/api/game/v1/play_session.ts",
                "src/api/game/v1/setup_policy.ts",
            ].sort(),
        );
        expect(frozen.seedAudit.zinc.derivedTournamentSchedulesSha256).toBe(
            "dc496f82d8866b7f3b5d0dbe527cf6883afcf9e99aa438199f5dd73e63c1dde5",
        );
        expect(fingerprintV07ComposedDerivedTournamentSchedules(frozen.seedAudit.zinc.derivedTournamentSchedules)).toBe(
            frozen.seedAudit.zinc.derivedTournamentSchedulesSha256,
        );
    });

    it("reserves one injective full-cap seed envelope and excludes only the target declaration", () => {
        const envelope = v07ComposedReservedSeedEnvelope(frozen);
        expect(envelope).toEqual({
            tokens: 1081000,
            protectedTokens: 42000,
            setupProposalTokens: 1039000,
            internalCollisions: 0,
            sha256: frozen.seedAudit.reservedEnvelopeSha256,
        });
        expect(V07_COMPOSED_MAIN_LOGICAL_SLOTS).toBe(1081000);
        expect(V07_COMPOSED_SEED_SCAN_EXCLUDED_RELATIVE_PATHS).toEqual([
            "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
            "src/simulation/v0_7_composed_ranked_ladder.ts",
        ]);
        const slots = [...v07ComposedReservedSeedSlots(frozen)];
        const seeds = new Set(slots.map((slot) => slot.seed));
        expect(seeds.size).toBe(envelope.tokens);
        const remapped = slots.filter((slot) => slot.ordinal !== slot.mainOrdinal);
        expect(remapped.map((slot) => slot.mainOrdinal)).toEqual([...V07_COMPOSED_COLLIDING_MAIN_ORDINALS]);
        expect(remapped).toHaveLength(frozen.seedAudit.collisionResolutions.length);
        const actualOrdinals = new Set(slots.map((slot) => slot.ordinal));
        for (const [index, slot] of remapped.entries()) {
            expect(actualOrdinals.has(slot.mainOrdinal)).toBe(false);
            expect(frozen.seedAudit.collisionResolutions[index]).toMatchObject({
                label: slot.label,
                kind: slot.kind,
                mainOrdinal: slot.mainOrdinal,
                remapOrdinal: slot.ordinal,
                remappedSeed: slot.seed,
            });
        }
    });

    it("requires the exact sorted Zinc corpus exclusion set", () => {
        expect(frozen.seedAudit.zinc.excluded).toEqual([...V07_COMPOSED_ZINC_CORPUS_EXCLUSIONS]);

        const missing = structuredClone(frozen);
        missing.seedAudit.zinc.excluded.pop();
        expect(() => validateV07ComposedManifest(missing)).toThrow("seed-audit totals are inconsistent");

        const injected = structuredClone(frozen);
        injected.seedAudit.zinc.excluded.push("/home/agent-zinc/hoc-common/sim-out/cem/unbound.json");
        expect(() => validateV07ComposedManifest(injected)).toThrow("seed-audit totals are inconsistent");
        // 15s was not enough on CI's 2-core runner (15.15s observed); raise to match the heavy-test convention.
    }, 60_000);

    it("separates setup and combat while retaining shared seeds only for fixed side swaps", () => {
        const fixed = fixedCell();
        expect(v07ComposedSetupSeed(fixed, 0, "candidate_green", 0)).toBe(
            v07ComposedSetupSeed(fixed, 0, "candidate_red", 0),
        );
        expect(v07ComposedCombatSeed(fixed, 0, "candidate_green")).toBe(
            v07ComposedCombatSeed(fixed, 0, "candidate_red"),
        );
        expect(v07ComposedSetupSeed(fixed, 0, "candidate_green", 0)).not.toBe(
            v07ComposedCombatSeed(fixed, 0, "candidate_green"),
        );

        const taxonomy = taxonomyCell();
        expect(v07ComposedSetupSeed(taxonomy, 0, "candidate_green", 0)).not.toBe(
            v07ComposedSetupSeed(taxonomy, 0, "candidate_red", 0),
        );
        expect(v07ComposedCombatSeed(taxonomy, 0, "candidate_green")).not.toBe(
            v07ComposedCombatSeed(taxonomy, 0, "candidate_red"),
        );
        expect(scenarioSeed(taxonomy, 0)).not.toBe(v07ComposedCombatSeed(taxonomy, 0, "candidate_green"));
    });
});

describe("composed-ranked worker bootstrap", () => {
    it("attests the same code-unit-sorted environment fingerprint as the parent", async () => {
        const directory = mkdtempSync(join(tmpdir(), "v07-composed-worker-env-"));
        const auditPath = join(directory, "worker.jsonl");
        const environment = {
            V07_Z_LAST: "3",
            V07_A_FIRST: "1",
            V07__PUNCTUATION: "2",
        };
        const inheritedEnvironment = Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        inheritedEnvironment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
        for (const key of [
            "BUN_CONFIG",
            "BUN_OPTIONS",
            "BUN_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "NODE_PATH",
            "TS_NODE_PROJECT",
            "TS_NODE_TRANSPILE_ONLY",
        ]) {
            delete inheritedEnvironment[key];
        }
        const worker = new Worker(
            new URL("../../src/simulation/v0_7_composed_ranked_ladder_worker.ts", import.meta.url),
            {
                env: inheritedEnvironment,
                workerData: {
                    manifestId: "worker-bootstrap-test",
                    cell: { id: "worker-bootstrap-test", games: 1 },
                    worker: 0,
                    environment,
                    environmentSha256: environmentFingerprint(environment),
                    auditPath,
                },
            },
        );
        try {
            const attestation = await new Promise<{ environmentSha256: string }>((resolvePromise, rejectPromise) => {
                const timeout = setTimeout(() => rejectPromise(new Error("worker-ready timeout")), 30_000);
                worker.once("error", rejectPromise);
                worker.on("message", (message: { type?: string; attestation?: { environmentSha256: string } }) => {
                    if (message.type !== "ready" || !message.attestation) return;
                    clearTimeout(timeout);
                    resolvePromise(message.attestation);
                });
            });
            expect(attestation.environmentSha256).toBe(environmentFingerprint(environment));
            expect(readFileSync(auditPath, "utf8")).toBe("");
        } finally {
            await worker.terminate();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe("composed-ranked prior-seed scanner", () => {
    it("treats aligned-v2 panels as generic structured evidence", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-aligned-v2-definition-"));
        const path = join(parent, "definition.json");
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        writeFileSync(
            path,
            `${JSON.stringify({
                schemaVersion: 1,
                artifactKind: "v0_7_aligned_96h_v2_definition",
                panels: {
                    train: { panelId: "train", mode: "train" },
                    confirm: { panelId: "confirm", mode: "confirm" },
                    finalCommitment: { panelId: "final-commitment", mode: "final" },
                },
                historicalSeedContextDeliberatelyBeyondTextWindow: { value: 87113710 },
            })}\n`,
        );
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            const result = await scanV07ComposedSeedCorpus({
                cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                commonRoot: resolve(import.meta.dir, "../.."),
                priorManifestExpanderPath: corePath,
                priorManifestExpanderSha256: fileSha256(corePath),
                roots: [path],
                excluded: [],
                excludedRelativeSuffixes: ["target.json"],
            });
            expect(result.seeds).toEqual([87113710]);
            expect(result.summary).toMatchObject({
                matchedSeedTokens: 1,
                expandedManifests: 0,
            });
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("fails closed for malformed panels carrying any legacy 96-hour marker", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-malformed-legacy-panels-"));
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        const fixtures = [
            { pairSeedStep: 0x9e3779b1, panels: { train: {} } },
            { allocatedDerivedScenarioSeeds: 1, panels: { train: {} } },
            { panels: { train: { id: null } } },
            { panels: { train: { gamesPerTemplate: null } } },
            { panels: { train: { seeds: null } } },
        ];
        try {
            for (const [index, fixture] of fixtures.entries()) {
                const path = join(parent, `fixture-${index}.json`);
                writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, ...fixture })}\n`);
                utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
                await expect(
                    scanV07ComposedSeedCorpus({
                        cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                        commonRoot: resolve(import.meta.dir, "../.."),
                        priorManifestExpanderPath: corePath,
                        priorManifestExpanderSha256: fileSha256(corePath),
                        roots: [path],
                        excluded: [],
                        excludedRelativeSuffixes: ["target.json"],
                    }),
                ).rejects.toThrow("Recognized prior-seed manifest failed authoritative expansion");
            }
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("recurses past new directory mtimes and expands structured prior panels", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-scan-"));
        const discovered = join(parent, "hoc-common-synthetic");
        const nested = join(discovered, "history");
        mkdirSync(nested, { recursive: true });
        const path = join(nested, "corpus.json");
        writeFileSync(
            path,
            `${JSON.stringify({
                seedBag: { "123456": "789012", nested: [345678] },
                pairSeedStep: 0x9e3779b1,
                seedSeries: [{ id: "compact-96h", baseSeed: 900000, streams: 1, streamStride: 0, gamesPerStream: 4 }],
                inlinePanel: { baseSeed: 700000, games: 4 },
                compactArmPanel: { baseSeed: 710000, gamesPerArm: 4, pairSeeds: 2 },
                leaguePanel: { baseSeed: 720000, gamesPerOpponent: 8 },
                poweredWaitPanel: { gamesPerArm: 4, cells: [{ baseSeed: 730000 }] },
                recoveredLedger: {
                    streamCount: 2,
                    streams: [
                        { family: "powered-league", baseSeed: 740000, boards: 2 },
                        { family: "legacy-cem-draft", baseSeed: 750000, boards: 2 },
                    ],
                },
            })}\n`,
        );
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        utimesSync(discovered, new Date(cutoffMs + 10_000), new Date(cutoffMs + 10_000));
        try {
            const result = await scanV07ComposedSeedCorpus({
                cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                commonRoot: resolve(import.meta.dir, "../.."),
                priorManifestExpanderPath: resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts"),
                priorManifestExpanderSha256: fileSha256(
                    resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts"),
                ),
                roots: [path],
                rootDiscovery: [{ parent, namePrefix: "hoc-common" }],
                excluded: [],
                excludedRelativeSuffixes: ["target.json"],
            });
            for (const seed of [
                123456,
                789012,
                345678,
                700000,
                (700000 + 0x9e3779b1) >>> 0,
                900000,
                (900000 + 0x9e3779b1) >>> 0,
                710000,
                (710000 + 0x9e3779b1) >>> 0,
                720000,
                hashSimulationParts("league-pick", 720000),
                hashSimulationParts("league-battle", 720000, 0),
                hashSimulationParts("league-battle", 720000, 1),
                730000,
                (730000 + 0x9e3779b1) >>> 0,
                740000,
                hashSimulationParts("league-pick", 740000),
                hashSimulationParts("league-battle", 740000, 0),
                hashSimulationParts("league-battle", 740000, 1),
                750000,
                (750000 + 0x9e3779b1) >>> 0,
            ]) {
                expect(result.seeds).toContain(seed);
            }
            expect(result.summary).toMatchObject({
                files: 1,
                textFiles: 1,
                structuredFiles: 1,
                expandedManifests: 1,
                expandedInlineTournamentPanels: 3,
                expandedInlineLeaguePanels: 1,
                expandedInlineLeagueSeeds: 8,
                expandedRecoveredLedgerStreams: 2,
                expandedRecoveredLedgerSeeds: 10,
            });
            expect(result.summary.roots).toContain(discovered);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("fails closed when a declared corpus root is missing", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-missing-root-"));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            await expect(
                scanV07ComposedSeedCorpus({
                    cutoff: "2026-07-16T07:00:35Z",
                    commonRoot: resolve(import.meta.dir, "../.."),
                    priorManifestExpanderPath: corePath,
                    priorManifestExpanderSha256: fileSha256(corePath),
                    roots: [join(parent, "deleted-seed-manifest.json")],
                    excluded: [],
                    excludedRelativeSuffixes: ["target.json"],
                }),
            ).rejects.toThrow("Required seed-scan root does not exist");
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("streams JSONL rows and preserves seed matches across line boundaries", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-streamed-jsonl-"));
        const path = join(parent, "corpus.jsonl");
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        writeFileSync(
            path,
            `${JSON.stringify({
                seedBag: [810000],
                panel: { baseSeed: 820000, games: 4 },
                pairSeedStep: 0x9e3779b1,
                seedSeries: [
                    { id: "streamed-compact", baseSeed: 840000, streams: 1, streamStride: 0, gamesPerStream: 4 },
                ],
                historicalLeaguePanel: { heldOutSeed: -1056826073, gamesPerOpponent: 4 },
                multiSeedLeaguePanel: { baseSeeds: [850000, 860000], gamesPerOpponentPerSeed: 4 },
            })}\n` +
                "reserved scenarioRoot\n" +
                "\n" +
                " 830000\n",
        );
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            const result = await scanV07ComposedSeedCorpus({
                cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                commonRoot: resolve(import.meta.dir, "../.."),
                priorManifestExpanderPath: corePath,
                priorManifestExpanderSha256: fileSha256(corePath),
                roots: [path],
                excluded: [],
                excludedRelativeSuffixes: ["target.json"],
            });
            expect(result.seeds).toContain(810000);
            expect(result.seeds).toContain(820000);
            expect(result.seeds).toContain((820000 + 0x9e3779b1) >>> 0);
            expect(result.seeds).toContain(830000);
            expect(result.seeds).toContain(840000);
            expect(result.seeds).toContain((840000 + 0x9e3779b1) >>> 0);
            expect(result.seeds).toContain(3238141223);
            expect(result.seeds).not.toContain(1056826073);
            expect(result.seeds).toContain(hashSimulationParts("league-pick", 850000));
            expect(result.seeds).toContain(hashSimulationParts("league-pick", 860000));
            expect(result.summary).toMatchObject({
                files: 1,
                textFiles: 1,
                structuredFiles: 1,
                expandedManifests: 1,
                expandedInlineTournamentPanels: 1,
                expandedInlineLeaguePanels: 3,
                expandedInlineLeagueSeeds: 12,
            });
            expect(result.summary.corpusFileSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("rejects ambiguous multi-seed league aliases with path-qualified evidence", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-ambiguous-league-"));
        const path = join(parent, "ambiguous.json");
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        writeFileSync(
            path,
            `${JSON.stringify({
                gamesPerOpponentPerSeed: 4,
                seeds: [850000],
                baseSeeds: [850000],
            })}\n`,
        );
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            await expect(
                scanV07ComposedSeedCorpus({
                    cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                    commonRoot: resolve(import.meta.dir, "../.."),
                    priorManifestExpanderPath: corePath,
                    priorManifestExpanderSha256: fileSha256(corePath),
                    roots: [path],
                    excluded: [],
                    excludedRelativeSuffixes: ["target.json"],
                }),
            ).rejects.toThrow(`Structured seed expansion failed for ${path}: Inline multi-seed league panel`);
            writeFileSync(path, `${JSON.stringify({ gamesPerOpponentPerSeed: 4, baseSeeds: [] })}\n`);
            utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
            await expect(
                scanV07ComposedSeedCorpus({
                    cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                    commonRoot: resolve(import.meta.dir, "../.."),
                    priorManifestExpanderPath: corePath,
                    priorManifestExpanderSha256: fileSha256(corePath),
                    roots: [path],
                    excluded: [],
                    excludedRelativeSuffixes: ["target.json"],
                }),
            ).rejects.toThrow("Inline multi-seed league panel is incomplete");
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("normalizes signed historical text seeds once without accepting numeric prefixes", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-signed-text-"));
        const path = join(parent, "corpus.txt");
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        writeFileSync(path, "heldOutSeed: -1056826073\nseed: 12345678901\n");
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            const result = await scanV07ComposedSeedCorpus({
                cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                commonRoot: resolve(import.meta.dir, "../.."),
                priorManifestExpanderPath: corePath,
                priorManifestExpanderSha256: fileSha256(corePath),
                roots: [path],
                excluded: [],
                excludedRelativeSuffixes: ["target.json"],
            });
            expect(result.seeds).toEqual([3238141223]);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("fails closed on an unknown recovered-ledger protocol family", async () => {
        const parent = mkdtempSync(join(tmpdir(), "v07-composed-bad-ledger-"));
        const path = join(parent, "ledger.json");
        const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
        writeFileSync(
            path,
            `${JSON.stringify({
                recoveredLedger: {
                    streamCount: 1,
                    streams: [{ family: "powered-leage", baseSeed: 123, boards: 2 }],
                },
            })}\n`,
        );
        utimesSync(path, new Date(cutoffMs - 10_000), new Date(cutoffMs - 10_000));
        const corePath = resolve(import.meta.dir, "../../src/simulation/optimizer/v0_7_96h_core.ts");
        try {
            await expect(
                scanV07ComposedSeedCorpus({
                    cutoff: new Date(cutoffMs).toISOString().replace(".000Z", "Z"),
                    commonRoot: resolve(import.meta.dir, "../.."),
                    priorManifestExpanderPath: corePath,
                    priorManifestExpanderSha256: fileSha256(corePath),
                    roots: [parent],
                    excluded: [],
                    excludedRelativeSuffixes: ["target.json"],
                }),
            ).rejects.toThrow("exact supported family");
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("expands the exact 100k panel and validates derived optimizer formulas", () => {
        const tournament = expandV07ComposedTournamentSeedSeries([
            {
                id: "reported-100k",
                baseSeed: 100000,
                streams: 4,
                streamStride: 1000000,
                gamesPerStream: 25000,
                pairSeedStep: 0x9e3779b1,
            },
        ]);
        expect(tournament).toHaveLength(50000);
        expect(new Set(tournament).size).toBe(50000);
        expect(tournament[0]).toBe(100000);
        expect(tournament[12500]).toBe(1100000);

        const derived = expandV07ComposedDerivedTournamentSchedules([
            {
                id: "formula-check",
                sourceEvidence: [{ path: "/evidence/formula.ts", sha256: "a".repeat(64) }],
                seed0s: [970911],
                passes: 1,
                generations: 1,
                passStart: 1,
                generationStart: 1,
                passStep: 1000003,
                generationStep: 7919,
                trainingGames: 4,
                validation: { derivation: "offsets", values: [11] },
                validationGames: 2,
            },
        ]);
        const trainingBase = (970911 + 1000003 + 7919) >>> 0;
        expect(derived).toEqual(
            [trainingBase, (trainingBase + 0x9e3779b1) >>> 0, 970922].sort((left, right) => left - right),
        );
        expect(() =>
            expandV07ComposedDerivedTournamentSchedules([
                {
                    id: "bad-derivation",
                    sourceEvidence: [{ path: "/evidence/formula.ts", sha256: "a".repeat(64) }],
                    seed0s: [1],
                    passes: 1,
                    generations: 1,
                    passStart: 0,
                    generationStart: 0,
                    passStep: 1,
                    generationStep: 1,
                    trainingGames: 2,
                    validation: { derivation: "invalid", values: [1] } as never,
                    validationGames: 2,
                },
            ]),
        ).toThrow("validation derivation");
    });

    it("reproduces the independently audited W13 census and distribution seed union", () => {
        const sourceEvidence = [{ path: "/evidence/formula.ts", sha256: "a".repeat(64) }];
        const schedules: IV07ComposedDerivedProtocolSchedule[] = [
            {
                id: "w13-heuristic-smoke",
                derivation: "unpaired_game_identity_xor",
                baseSeeds: [1],
                gamesPerBase: 100,
                rootStep: 0x9e3779b1,
                xorMask: 0x85ebca6b,
                sourceEvidence,
            },
            {
                id: "w13-heuristic-full",
                derivation: "unpaired_game_identity_xor",
                baseSeeds: [86007710, 86009710],
                gamesPerBase: 2000,
                rootStep: 0x9e3779b1,
                xorMask: 0x85ebca6b,
                sourceEvidence,
            },
            {
                id: "w13-round1-smoke",
                derivation: "unpaired_game_round1_census",
                baseSeeds: [1],
                gamesPerBase: 200,
                rootStep: 0x9e3779b1,
                pickLabel: "round1-census-pick",
                battleLabel: "round1-census-battle",
                sourceEvidence,
            },
            {
                id: "w13-round1-full-including-superseded",
                derivation: "unpaired_game_round1_census",
                baseSeeds: [86006710, 86008710, 86031710],
                gamesPerBase: 2000,
                rootStep: 0x9e3779b1,
                pickLabel: "round1-census-pick",
                battleLabel: "round1-census-battle",
                sourceEvidence,
            },
            {
                id: "w13-distribution-including-superseded",
                derivation: "unpaired_game_identity_xor",
                baseSeeds: [86004710, 86030710],
                gamesPerBase: 2000,
                rootStep: 0x9e3779b1,
                xorMask: 0x85ebca6b,
                sourceEvidence,
            },
        ];
        const expanded = expandV07ComposedDerivedProtocolSchedules(schedules);
        expect(expanded).toHaveLength(34700);
        expect(fingerprintV07ComposedSeedSet(expanded)).toBe(
            "83c6534ec7469cf8e3ad71dbb324a9f5ea72de4b25c19e90efcfaf50b70d71b7",
        );
    });

    it("re-derives the recovered deleted smoke schedule before denylisting it", () => {
        const evidencePath = join(
            import.meta.dir,
            "../../docs/evidence/v0_7_deleted_smoke3_seed_recovery_20260716.json",
        );
        const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
            schedule: {
                runId: string;
                panelIds: string[];
                templates: string[];
                nonce: number;
                gamesPerTemplate: number;
                pairSeedStep: number;
                baseSeedsPanelMajorTemplateMinor: number[];
                uniqueSeeds: number;
                sortedSeedSetSha256: string;
            };
        };
        expect(fileSha256(evidencePath)).toBe("3c6dc096e2b760a4cd0e3dcc411ea2b67f50de8817b9ad26bf162d7591639e8a");
        const { schedule } = evidence;
        const derived = schedule.panelIds.flatMap((panelId) =>
            schedule.templates.map((template) =>
                createHash("sha256")
                    .update(`${schedule.runId}|${panelId}|${template}|${schedule.nonce}`)
                    .digest()
                    .readUInt32BE(0),
            ),
        );
        expect(derived).toEqual(schedule.baseSeedsPanelMajorTemplateMinor);
        expect(derived).toHaveLength(72);
        expect(new Set(derived).size).toBe(schedule.uniqueSeeds);
        expect(fingerprintV07ComposedSeedSet(derived)).toBe(schedule.sortedSeedSetSha256);

        const expanded = expandV07ComposedDerivedProtocolSchedules([
            {
                id: "recovered-deleted-smoke3",
                derivation: "paired_tournament_roots",
                baseSeeds: schedule.baseSeedsPanelMajorTemplateMinor,
                gamesPerBase: schedule.gamesPerTemplate,
                rootStep: schedule.pairSeedStep,
                sourceEvidence: [{ path: evidencePath, sha256: fileSha256(evidencePath) }],
            },
        ]);
        expect(expanded).toHaveLength(schedule.uniqueSeeds);
        expect(expanded.every((seed) => derived.includes(seed))).toBe(true);
        expect(derived.every((seed) => expanded.includes(seed))).toBe(true);
        expect(fingerprintV07ComposedSeedSet(expanded)).toBe(schedule.sortedSeedSetSha256);
    });
});

describe("composed-ranked setup semantics", () => {
    it("preserves persisted pick order only on the ranked-composed path", () => {
        const genome = shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC);
        const rules = parseConditionalRules("all");
        const historical = runConditionalPickGame(0x12345678, "league", undefined, rules, genome);
        const ranked = runRankedConditionalPickGame(0x12345678, rules, genome);
        expect(ranked.lower.roster.map((unit) => creatureIdForName(unit.creatureName))).toEqual(
            ranked.lower.creatureIds,
        );
        expect(historical.lower.roster.map((unit) => creatureIdForName(unit.creatureName))).not.toEqual(
            historical.lower.creatureIds,
        );
    });

    it("fixes setup and combat inside ordinary side swaps", () => {
        const cell = fixedCell();
        const records = [0, 1].map((game) =>
            playV07ComposedGame("fixed-test", cell, game, { matchRunner: (config) => fakeResult(config) }),
        );
        expect(records[0].scenarioRoot).toBe(records[1].scenarioRoot);
        expect(records[0].setupSeed).toBe(records[1].setupSeed);
        expect(records[0].combatSeed).toBe(records[1].combatSeed);
        expect(records[0].physicalSetupSha256).toBe(records[1].physicalSetupSha256);
        expect(records.map((record) => record.candidateSeatStream)).toEqual(["candidate_green", "candidate_red"]);
    });

    it("rejects an opposite-seat-only trait hit and takes the deterministic first candidate-seat hit", () => {
        const cell = taxonomyCell();
        const base = runRankedConditionalPickGame(
            123,
            parseConditionalRules("all"),
            shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
        );
        const greenTarget = v07ComposedSetupSeed(cell, 0, "candidate_green", 1);
        const redTarget = v07ComposedSetupSeed(cell, 0, "candidate_red", 1);
        const picker = (seed: number) => {
            if (seed === greenTarget) return pickWithMage(base, true, false);
            if (seed === redTarget) return pickWithMage(base, false, true);
            const greenStreamAttemptZero = seed === v07ComposedSetupSeed(cell, 0, "candidate_green", 0);
            return pickWithMage(base, !greenStreamAttemptZero, greenStreamAttemptZero);
        };
        const green = playV07ComposedGame("taxonomy-test", cell, 0, {
            pickRunner: picker,
            matchRunner: (config) => fakeResult(config),
        });
        const red = playV07ComposedGame("taxonomy-test", cell, 1, {
            pickRunner: picker,
            matchRunner: (config) => fakeResult(config),
        });
        expect(green.setupAttempt).toBe(1);
        expect(red.setupAttempt).toBe(1);
        expect(green.taxonomyTraitCounts).toMatchObject({ candidate: 1, opponent: 0 });
        expect(red.taxonomyTraitCounts).toMatchObject({ candidate: 1, opponent: 0 });
        expect(green.setupSeed).not.toBe(red.setupSeed);
        expect(green.combatSeed).not.toBe(red.combatSeed);
        const repeat = playV07ComposedGame("taxonomy-test", cell, 0, {
            pickRunner: picker,
            matchRunner: (config) => fakeResult(config),
        });
        expect(repeat).toEqual(green);
        expect(() => replayV07ComposedTaxonomyRecords(cell, [green], picker)).not.toThrow();
        for (const tampered of [
            { ...green, setupAttempt: green.setupAttempt + 1 },
            { ...green, setupSeed: green.setupSeed ^ 1 },
            { ...green, lowerRoster: `${green.lowerRoster}-tampered` },
            { ...green, taxonomyTraitCounts: { ...green.taxonomyTraitCounts!, candidate: 99 } },
        ]) {
            expect(() => replayV07ComposedTaxonomyRecords(cell, [tampered], picker)).toThrow(
                "differs from first-hit setup replay",
            );
        }
    });

    it("fails closed at the exact taxonomy setup cap before combat", () => {
        const cell = taxonomyCell();
        const base = runRankedConditionalPickGame(
            456,
            parseConditionalRules("all"),
            shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
        );
        let calls = 0;
        expect(() =>
            verifyV07ComposedTaxonomyCellPlan(cell, () => {
                calls += 1;
                return pickWithMage(base, false, false);
            }),
        ).toThrow(`within ${V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS} attempts`);
        expect(calls).toBe(V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS);
    });
});

describe("composed-ranked formal inference", () => {
    it("uses boundary-safe Wilson intervals on decisive games", () => {
        expect(v07ComposedWilsonInterval(1, 0)?.low).toBeCloseTo(0.094148245587644, 14);
        expect(v07ComposedWilsonInterval(1000, 0)?.low).toBeCloseTo(0.990470145109551, 14);
        expect(v07ComposedWilsonInterval(929, 71)?.low).toBeCloseTo(0.899509055401437, 14);
        expect(v07ComposedWilsonInterval(930, 70)?.low).toBeCloseTo(0.900659622382523, 14);
        expect(v07ComposedWilsonInterval(0, 0)).toBeNull();
    });

    it("rejects one win plus 1,999 draws instead of degenerating to a perfect lower bound", () => {
        const cell = fixedCell(2000, true);
        const manifest = noAuditManifest("boundary-test");
        const records = Array.from({ length: cell.games }, (_, game) =>
            playV07ComposedGame("boundary-test", cell, game, {
                matchRunner: (config) => fakeResult(config, game === 0 ? "green" : "draw"),
            }),
        );
        const report = summarizeV07ComposedCell(manifest, cell, records, []);
        expect(report.formalSeatEvidence.candidate_green).toMatchObject({
            decisive: 1,
            wins: 1,
            draws: 999,
            decisiveFraction: 0.001,
            decisiveFractionPassed: false,
            wilsonLowPassed: false,
        });
        expect(report.formalSeatEvidence.candidate_green.wilson?.low).toBeCloseTo(0.094148245587644, 14);
        expect(report.formalSeatEvidence.candidate_red.wilson).toBeNull();
        expect(report.gate.outcomePassed).toBe(false);
    });

    it("keeps the all-win Wilson bound finite and evaluates both seats", () => {
        const cell = fixedCell(2000, true);
        const manifest = noAuditManifest("all-win-test");
        const records = Array.from({ length: cell.games }, (_, game) =>
            playV07ComposedGame("all-win-test", cell, game, {
                matchRunner: (config) => fakeResult(config, game % 2 === 0 ? "green" : "red"),
            }),
        );
        const report = summarizeV07ComposedCell(manifest, cell, records, []);
        for (const seat of Object.values(report.formalSeatEvidence)) {
            expect(seat.wilson?.low).toBeCloseTo(0.990470145109551, 14);
            expect(seat.decisiveFraction).toBe(1);
            expect(seat.passed).toBe(true);
        }
        expect(report.gate.outcomePassed).toBe(true);
    });

    it("fails qualification when games reach Armageddon even if every game is decisive", () => {
        const cell = fixedCell(2000, true);
        const manifest = noAuditManifest("armageddon-test");
        const records = Array.from({ length: cell.games }, (_, game) => {
            const record = playV07ComposedGame("armageddon-test", cell, game, {
                matchRunner: (config) => fakeResult(config, game % 2 === 0 ? "green" : "red"),
            });
            return { ...record, reachedArmageddon: true, decidedByArmageddon: false };
        });
        const report = summarizeV07ComposedCell(manifest, cell, records, []);
        expect(report.gate.outcomePassed).toBe(false);
        expect(report.gate.everySeatDrawOrArmageddonPassed).toBe(false);
        expect(report.formalSeatEvidence.candidate_green.drawOrArmageddonFraction).toBe(1);
        expect(report.gate.passed).toBe(false);
        expect(() =>
            summarizeV07ComposedCell(
                manifest,
                cell,
                [{ ...records[0], decidedByArmageddon: true, reachedArmageddon: false }, ...records.slice(1)],
                [],
            ),
        ).toThrow("malformed outcome/integrity fields");
    });
});

describe("composed-ranked audit and provenance integrity", () => {
    it("joins search audit by combat seed and rejects circuit-skips without an opened circuit", () => {
        const cell = fixedCell();
        const records = [0, 1].map((game) =>
            playV07ComposedGame(frozen.manifestId, cell, game, {
                matchRunner: (config) => fakeResult(config, game % 2 === 0 ? "green" : "red"),
            }),
        );
        const audits = records.map(audit);
        const report = summarizeV07ComposedCell(frozen, cell, records, audits);
        expect(report.integrity.auditJoinedExactly).toBe(true);
        expect(() =>
            summarizeV07ComposedCell(frozen, cell, records, [{ ...audits[0], seed: audits[0].seed ^ 1 }, audits[1]]),
        ).toThrow("no exact search-audit join");
        expect(() =>
            summarizeV07ComposedCell(frozen, cell, records, [{ ...audits[0], circuitSkipped: 1 }, audits[1]]),
        ).toThrow("without opening");
    });

    it("requires pushed main and treats ordinary untracked files as dirty", () => {
        const root = mkdtempSync(join(tmpdir(), "v07-composed-git-"));
        const bare = `${root}-origin.git`;
        try {
            const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
            git(root, "init", "-b", "main");
            git(root, "config", "user.email", "test@example.com");
            git(root, "config", "user.name", "Test");
            writeFileSync(join(root, "tracked.txt"), "one\n");
            git(root, "add", "tracked.txt");
            git(root, "commit", "-m", "initial");
            execFileSync("git", ["init", "--bare", bare]);
            git(root, "remote", "add", "origin", bare);
            git(root, "push", "-u", "origin", "main");
            const base = git(root, "rev-parse", "HEAD");
            expect(gitProvenance(root, base, bare)).toMatchObject({
                commit: base,
                originMain: base,
                remoteOriginMain: base,
                originUrl: bare,
                originIdentity: bare,
                branch: "main",
                cleanIncludingUntracked: true,
                preregisteredBaseIsAncestor: true,
            });
            writeFileSync(join(root, "ordinary-untracked.txt"), "dirty\n");
            expect(gitProvenance(root, base, bare).cleanIncludingUntracked).toBe(false);
            git(root, "add", "ordinary-untracked.txt");
            git(root, "commit", "-m", "local ahead");
            expect(() => gitProvenance(root, base, bare)).toThrow("requires pushed main");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(bare, { recursive: true, force: true });
        }
    });

    it("normalizes the frozen GitHub origin identity", () => {
        const expected = "github.com/o1dstars/heroes-of-crypto-common";
        expect(normalizeV07ComposedOriginIdentity("git@github.com:o1dstaRs/heroes-of-crypto-common.git")).toBe(
            expected,
        );
        expect(normalizeV07ComposedOriginIdentity("https://github.com/o1dstaRs/heroes-of-crypto-common")).toBe(
            expected,
        );
        expect(normalizeV07ComposedOriginIdentity("git@github.com:someone/other.git")).not.toBe(expected);
    });

    it("rejects mixed host, runtime, or concurrency envelopes", () => {
        const host: IV07ComposedCellCompletion["host"] = {
            hostname: "m4",
            platform: "darwin",
            arch: "arm64",
            cpuModel: "Apple M4 Max",
            availableParallelism: 16,
            bunVersion: "1.3.14",
            bunRevision: "a".repeat(40),
            bunExecutableSha256: "b".repeat(64),
        };
        const first = { cellId: "a", host, concurrency: { requested: 12, workers: 12 } };
        const second = { cellId: "b", host: { ...host }, concurrency: { requested: 12, workers: 12 } };
        expect(() => assertV07ComposedUniformExecutionEnvelope([first, second])).not.toThrow();
        expect(() =>
            assertV07ComposedUniformExecutionEnvelope([first, { ...second, host: { ...host, hostname: "zinc" } }]),
        ).toThrow("mixed host/runtime/concurrency");
        expect(() =>
            assertV07ComposedUniformExecutionEnvelope([
                first,
                { ...second, concurrency: { requested: 12, workers: 11 } },
            ]),
        ).toThrow("mixed host/runtime/concurrency");
    });

    it("holds an exclusive host lock and never auto-clears it", () => {
        const root = mkdtempSync(join(tmpdir(), "v07-composed-lock-"));
        const lockPath = join(root, "host.lock");
        const binding = {
            manifestId: "lock-test",
            manifestSha256: "a".repeat(64),
            gitCommit: "b".repeat(40),
            mode: "cell" as const,
            cellId: "cell-a",
            outputRoot: join(root, "output"),
        };
        const first = acquireV07ComposedHostLock(binding, lockPath);
        try {
            expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
                schemaVersion: 1,
                protocol: "v0.7-composed-ranked",
                manifestId: "lock-test",
                pid: process.pid,
            });
            expect(() => acquireV07ComposedHostLock(binding, lockPath)).toThrow("never auto-clear stale locks");
        } finally {
            first.release();
        }
        const second = acquireV07ComposedHostLock(binding, lockPath);
        second.release();
        rmSync(root, { recursive: true, force: true });
    });

    it("continues after outcome failure but blocks prior integrity failure", () => {
        const cell = fixedCell(2, true);
        const manifest = noAuditManifest("fixed-battery-test");
        const records = [0, 1].map((game) =>
            playV07ComposedGame("fixed-battery-test", cell, game, {
                matchRunner: (config) => fakeResult(config, game === 0 ? "green" : "red"),
            }),
        );
        const report = summarizeV07ComposedCell(manifest, cell, records, []);
        report.gate.outcomePassed = false;
        expect(() => assertV07ComposedPriorStageIntegrity([{ cellId: cell.id, report }])).not.toThrow();
        const corrupt = structuredClone(report);
        corrupt.integrity.complete = false;
        expect(() => assertV07ComposedPriorStageIntegrity([{ cellId: cell.id, report: corrupt }])).toThrow(
            "integrity/control failure blocks",
        );
    });

    it("rejects canonical-report authority, integrity, aggregate, host-lock, and completion-root mutations", () => {
        const root = mkdtempSync(join(tmpdir(), "v07-composed-final-report-"));
        const outputRoot = join(root, "output");
        const runRoot = join(outputRoot, frozen.manifestId);
        const startedAt = "2026-07-16T08:00:00.000Z";
        const completedAt = "2026-07-16T08:00:01.000Z";
        const acquiredAt = "2026-07-16T08:00:02.000Z";
        const assembledAt = "2026-07-16T08:00:03.000Z";
        const git = {
            commit: "a".repeat(40),
            originMain: "a".repeat(40),
            remoteOriginMain: "a".repeat(40),
            originUrl: "git@github.com:o1dstaRs/heroes-of-crypto-common.git",
            originIdentity: "github.com/o1dstars/heroes-of-crypto-common",
            branch: "main",
            cleanIncludingUntracked: true,
            statusPorcelainSha256: null,
            preregisteredBaseCommit: frozen.sourceProvenance.preregisteredCommonBaseCommit,
            preregisteredBaseIsAncestor: true,
        };
        const host: IV07ComposedCellCompletion["host"] = {
            hostname: "m4",
            platform: "darwin",
            arch: "arm64",
            cpuModel: "Apple M4 Max",
            availableParallelism: 16,
            bunVersion: "1.3.14",
            bunRevision: "b".repeat(40),
            bunExecutableSha256: "c".repeat(64),
        };
        const reports = frozen.cells.map(
            (cell) =>
                ({
                    cell,
                    pairScenarios: cell.pairScenarios,
                    candidateWins: 1,
                    opponentWins: 1,
                    draws: 0,
                    candidateWinRate: 0.5,
                    integrity: {
                        complete: true,
                        fixedPhysicalSideSwapExact: cell.scenarioProtocol === "fixed_physical_side_swap" ? true : null,
                        independentSeatStreamsExact: cell.scenarioProtocol === "fixed_physical_side_swap" ? null : true,
                        seatConditioningExact: cell.scenarioProtocol === "fixed_physical_side_swap" ? null : true,
                        auditJoinedExactly: true,
                        offControlExact: true,
                        zeroEngineRejections: true,
                        zeroIllegalIncumbents: true,
                    },
                    gate: {
                        everySeatDecisiveFractionPassed: true,
                        everySeatWilsonLowPassed: true,
                        everySeatDrawOrArmageddonPassed: true,
                        latencyAttritionPassed: true,
                    },
                }) as unknown as IV07ComposedCellReport,
        );
        const completions = frozen.cells.map(
            (cell, index) =>
                ({
                    cellId: cell.id,
                    startedAt,
                    completedAt,
                    git,
                    host,
                    concurrency: { requested: 12, workers: 12 },
                    report: reports[index],
                }) as IV07ComposedCellCompletion,
        );
        const byId = new Map(reports.map((report) => [report.cell.id, report]));
        const required = (id: string): IV07ComposedCellReport => {
            const report = byId.get(id);
            if (!report) throw new Error(`missing fixture report ${id}`);
            return report;
        };
        const taxonomyCells = Object.fromEntries(
            V07_ARCHETYPES.map((archetype) => [archetype, required(V07_COMPOSED_TAXONOMY_CELL_IDS[archetype])]),
        ) as IV07ComposedFinalReport["qualification"]["taxonomyCells"];
        const templateCells = Object.fromEntries(
            V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, required(`${template}_conservative200_275`)]),
        ) as IV07ComposedFinalReport["qualification"]["templateCells"];
        const fixedByArchetype = (archetype: (typeof V07_ARCHETYPES)[number]): IV07ComposedCellReport[] =>
            Object.values(templateCells).filter(
                (report) => report.cell.template && v07ArchetypeTemplate(report.cell.template).archetype === archetype,
            );
        const aggregate = (
            selected: IV07ComposedCellReport[],
        ): IV07ComposedFinalReport["aggregateCohortEvidence"]["ranked"] => ({
            cells: selected.map((report) => report.cell.id),
            scenarioProtocols: [...new Set(selected.map((report) => report.cell.scenarioProtocol))],
            games: selected.length * 2,
            pairScenarios: selected.reduce((sum, report) => sum + report.pairScenarios, 0),
            candidateWins: selected.length,
            opponentWins: selected.length,
            draws: 0,
            candidateWinRate: 0.5,
            policy: "EQUAL_GAME_POOLED_DIAGNOSTIC_NOT_A_FORMAL_GATE",
        });
        try {
            for (const cell of frozen.cells) {
                const path = join(runRoot, "cells", cell.id, "complete.json");
                mkdirSync(resolve(path, ".."), { recursive: true });
                writeFileSync(path, `${JSON.stringify({ cellId: cell.id })}\n`);
            }
            const rankedCell = required("round1_search_conservative200_275");
            const qualificationReports = reports.filter((report) => report.cell.qualification);
            const report: IV07ComposedFinalReport = {
                schemaVersion: 1,
                manifestId: frozen.manifestId,
                manifestSha256: frozenLoaded.provenance.sha256,
                assembledAt,
                authority: "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL",
                git,
                hostLock: {
                    schemaVersion: 1,
                    protocol: "v0.7-composed-ranked",
                    manifestId: frozen.manifestId,
                    manifestSha256: frozenLoaded.provenance.sha256,
                    gitCommit: git.commit,
                    hostname: host.hostname,
                    pid: 123,
                    mode: "assemble",
                    outputRoot: resolve(outputRoot),
                    acquiredAt,
                },
                allCellsComplete: true,
                completionEvidence: v07ComposedCompletionEvidenceRoot(frozen, outputRoot),
                cells: reports,
                executionWindow: {
                    startedAt,
                    assembledAt,
                    elapsedMs: 3000,
                    maxRunElapsedMs: frozen.execution.maxRunElapsedMs,
                },
                executionProvenance: Object.fromEntries(
                    completions.map((completion) => [
                        completion.cellId,
                        {
                            startedAt: completion.startedAt,
                            completedAt: completion.completedAt,
                            git: completion.git,
                            host: completion.host,
                            concurrency: completion.concurrency,
                        },
                    ]),
                ),
                qualification: {
                    cells: qualificationReports.length,
                    hypotheses: frozen.gates.formalHypotheses,
                    method: frozen.gates.formalMethod,
                    nominalFamilywiseConfidence: frozen.gates.nominalFamilywiseConfidence,
                    rankedCell,
                    taxonomyCells,
                    templateCells,
                    allSeatDecisiveFractionsAtLeast90: true,
                    allSeatWilsonLowsAtLeast90: true,
                    allSeatDrawOrArmageddonAtMost10: true,
                    allLatencyAttritionPassed: true,
                    allIntegrityGatesPassed: true,
                    verdict: "PASS",
                },
                aggregateCohortEvidence: {
                    ranked: aggregate([rankedCell]),
                    mage: aggregate([taxonomyCells.mage, ...fixedByArchetype("mage")]),
                    meleeMage: aggregate([taxonomyCells.meleeMage, ...fixedByArchetype("meleeMage")]),
                    aura: aggregate([taxonomyCells.aura, ...fixedByArchetype("aura")]),
                    ranged: aggregate([taxonomyCells.ranged, ...fixedByArchetype("ranged")]),
                },
                diagnostics: {
                    uncapped: required("round1_search_uncapped"),
                    server300LowerBoundEmulation: required("round1_search_server300"),
                    offSymmetry: required("round1_search_off_symmetry"),
                },
                releaseInstruction: "NO_AUTOMATIC_BAKE_OR_DEPLOY",
            };
            const validate = (candidate: IV07ComposedFinalReport): void =>
                validateV07ComposedFinalReport(frozen, frozenLoaded.provenance, outputRoot, candidate, completions);
            expect(() => validate(report)).not.toThrow();

            const authority = structuredClone(report);
            (authority as unknown as { authority: string }).authority = "SEALED";
            expect(() => validate(authority)).toThrow("canonical assembly");
            const integrity = structuredClone(report);
            integrity.diagnostics.uncapped.integrity.complete = false;
            expect(() => validate(integrity)).toThrow("canonical assembly");
            const aggregateMutation = structuredClone(report);
            aggregateMutation.aggregateCohortEvidence.mage.candidateWins += 1;
            expect(() => validate(aggregateMutation)).toThrow("canonical assembly");
            const extraHostLock = structuredClone(report) as IV07ComposedFinalReport & {
                hostLock: IV07ComposedFinalReport["hostLock"] & { unexpected?: true };
            };
            extraHostLock.hostLock.unexpected = true;
            expect(() => validate(extraHostLock)).toThrow("canonical assembly");

            const firstMarker = join(runRoot, "cells", frozen.cells[0].id, "complete.json");
            writeFileSync(firstMarker, `${JSON.stringify({ cellId: frozen.cells[0].id, changed: true })}\n`);
            expect(() => validate(report)).toThrow("canonical assembly");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
