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

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { runMatch, type IMatchResult } from "./battle_engine";
import {
    playV07ArchetypeGame,
    v07ArchetypeTemplate,
    type IV07ArchetypeCellSpec,
    type V07ArchetypeTemplateName,
} from "./v0_7_archetype_battery";
import { DEFAULT_V07_VALUE_WEIGHTS } from "./v0_7_value_weights";

export const PURE_RANGED_TERMINAL_MANIFEST_PATH = fileURLToPath(
    new URL("./manifests/v0_7_pure_ranged_terminal_20260716.json", import.meta.url),
);
export const PURE_RANGED_TERMINAL_PAIR_SEED_STEP = 0x9e3779b1;
export const PURE_RANGED_TERMINAL_SCOUT_WEIGHTS = [0, 0.5, 1] as const;
export const PURE_RANGED_TERMINAL_TEMPLATE = "ranged_precision" as const;
export const PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES = [
    "mage_frontline",
    "mage_fireline",
    "melee_magic_utility",
    "melee_magic_brawler",
    "aura_support",
    "aura_offense",
] as const;

export type PureRangedTerminalWeight = (typeof PURE_RANGED_TERMINAL_SCOUT_WEIGHTS)[number];
export type PureRangedTerminalPhase = "scout" | "confirmation";
export type PureRangedTerminalIdentityTemplate = (typeof PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES)[number];

interface IPureRangedTerminalSeedPanel {
    baseSeed: number;
    gamesPerArm: number;
    pairSeeds: number;
}

export interface IPureRangedTerminalManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    status: "preregistered_research_only_no_bake";
    candidate: "v0.7";
    opponent: "v0.6";
    panelScope: string;
    pairing: string;
    pairSeedStep: number;
    scenarioReservation: {
        uniqueScenarioSeeds: number;
        armExecutionsExcludedFromUniqueCount: true;
        scout: IPureRangedTerminalSeedPanel;
        confirmation: IPureRangedTerminalSeedPanel & {
            identityPairOffset: number;
            identityPairSeeds: Record<PureRangedTerminalIdentityTemplate, number>;
            identityGamesPerTemplatePerArm: number;
        };
    };
    arms: {
        scoutWeights: number[];
        confirmationWeights: string;
        selectionOrder: string;
    };
    mechanismPanel: {
        template: typeof PURE_RANGED_TERMINAL_TEMPLATE;
        roster: string[];
        amountMode: "expBudget";
        setup: string;
        grid: "NORMAL";
        originalStacksMustAllBeRange: true;
    };
    searchEnvelope: {
        mode: "search";
        versions: "v0.7";
        gate: number;
        horizon: number;
        rollouts: number;
        shortlist: number;
        includeMoves: false;
        maxMoves: number;
        maxMelee: number;
        maxShots: number;
        maxThrows: number;
        activeChallengers: false;
        decisionDeadlineMs: number;
        circuitBreakerMs: number;
        lateRangedFinishWeight: number;
        opponentModel: null;
        valueLeaf: "committed_default_20d";
        valueLeafSha256: string;
    };
    identityControlEnvelope: {
        inheritsSearchPolicy: true;
        decisionDeadlineMs: null;
        circuitBreakerMs: null;
        reason: string;
    };
    scoutGates: {
        pairedDrawHalfScoreGainMin: number;
        pairedDrawHalfScoreGain95LcbExclusiveMin: number;
        drawOrArmageddonDeltaMax: number;
        drawOrArmageddonDelta95UcbExclusiveMax: number;
        candidateAndOpponentRejections: number;
        eligibleGamesMin: number;
        eligibleLeavesMin: number;
        nonzeroEligibleLeavesMin: number;
        causalCandidateActionHashChangedGamesMin: number;
        deadlineFallbacks: number;
        circuitOpenGameRateMax: number;
        searchedTurnLatencyP95MsMax: number;
    };
    confirmationGates: {
        repeatEveryScoutGate: true;
        selectedDecisiveWinRate95LcbExclusiveMin: number;
        selectedDrawOrArmageddonRateMax: number;
        eligibleRangedCausalActionHashChangedGamesMin: number;
        ineligibleTemplateActionHashIdentity: string;
        ineligibleTemplates: PureRangedTerminalIdentityTemplate[];
    };
    completion: {
        scoutRawMarker: string;
        scoutAnalysisMarker: string;
        scoutPassLine: string;
        confirmationRawMarker: string;
        confirmationAnalysisMarker: string;
        confirmationPassLine: string;
        rawAndAuditExactCompleteness: true;
        hashEverySealedArtifact: true;
        automaticBake: false;
        automaticDeploy: false;
    };
    freshSeedAudit: {
        auditedAt: string;
        plannedUniqueScenarioSeeds: number;
        internalCollisions: number;
        localNumericTokens: number;
        localCollisions: number;
        zincNumericTokens: number;
        zincCollisions: number;
        localRoots: string[];
        zincRoots: string[];
        declaration: string;
    };
    authority: {
        defaultWeight: 0;
        bake: false;
        deploy: false;
        instruction: "NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY_FROM_THIS_HARNESS";
    };
}

export interface IPureRangedTerminalManifestProvenance {
    path: string;
    sha256: string;
}

export interface IPureRangedTerminalRevision {
    commit: string;
    commitDate: string;
    branch: "main";
    originMain: string;
    trackedClean: true;
    remote: string | null;
}

export interface IPureRangedTerminalSeedAudit {
    roots: string[];
    numericTokens: number;
    collisions: number[];
}

interface IPureRangedTerminalRunManifest {
    schemaVersion: 1;
    kind: "v0.7_pure_ranged_terminal_run";
    createdAt: string;
    runFingerprint: string;
    protocol: IPureRangedTerminalManifestProvenance;
    revision: IPureRangedTerminalRevision;
    sourceHashes: Record<string, string>;
    seedAudit: IPureRangedTerminalSeedAudit;
    qualification: "RESEARCH_ONLY_NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY";
}

interface IPureRangedTerminalArm {
    id: string;
    phase: PureRangedTerminalPhase;
    weight: number;
    template: V07ArchetypeTemplateName;
    games: number;
    baseSeed: number;
    timingEnvelope: "ranged_performance" | "deterministic_identity";
}

export interface IPureRangedTerminalGameArtifact {
    schemaVersion: 1;
    runFingerprint: string;
    phase: PureRangedTerminalPhase;
    armId: string;
    weight: number;
    template: V07ArchetypeTemplateName;
    game: number;
    seed: number;
    candidateIsGreen: boolean;
    greenVersion: string;
    redVersion: string;
    winner: IMatchResult["winner"];
    endReason: IMatchResult["endReason"];
    laps: number;
    score: 0 | 0.5 | 1;
    drawOrArmageddon: boolean;
    candidateRejections: number | null;
    opponentRejections: number | null;
    actions: number;
    candidateActions: number;
    actionsSha256: string;
    candidateActionsSha256: string;
}

interface IPureRangedTerminalAuditDiagnostics {
    auditRows: number;
    searchedTurns: number;
    deadlineFallbacks: number;
    circuitOpened: boolean;
    terminalEligible: boolean;
    terminalLeaves: number;
    terminalNonzeroLeaves: number;
    turnLatencyMs: number[];
}

export interface IPureRangedTerminalArmMetrics {
    armId: string;
    weight: number;
    games: number;
    pairClusters: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    scoreRate: number;
    decisiveWinRate: number;
    decisiveConfidence95: { low: number; high: number } | null;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
    eligibleGames: number;
    terminalLeaves: number;
    terminalNonzeroLeaves: number;
    deadlineFallbacks: number;
    circuitOpenGames: number;
    circuitOpenGameRate: number;
    searchedTurns: number;
    searchedTurnLatencyP95Ms: number | null;
}

export interface IPureRangedTerminalEstimate {
    clusters: number;
    mean: number;
    standardError: number | null;
    confidence95: { low: number; high: number } | null;
}

export interface IPureRangedTerminalComparison {
    weight: number;
    control: IPureRangedTerminalArmMetrics;
    candidate: IPureRangedTerminalArmMetrics;
    pairedScoreGain: IPureRangedTerminalEstimate;
    pairedDrawOrArmageddonDelta: IPureRangedTerminalEstimate;
    /** Any changed candidate action stream, including changes on timing-contaminated games. */
    candidateActionHashChangedGames: number;
    /** Changed candidate action streams on same-game nonzero leaf exposure with no timing fallback/circuit. */
    causalCandidateActionHashChangedGames: number;
    gates: Record<string, boolean>;
    passed: boolean;
}

export interface IPureRangedTerminalRawArmIdentity {
    id: string;
    phase: PureRangedTerminalPhase;
    weight: number;
    template: V07ArchetypeTemplateName;
    games: number;
    timingEnvelope: IPureRangedTerminalArm["timingEnvelope"];
}

interface IPureRangedTerminalRawArmReport extends IPureRangedTerminalRawArmIdentity {
    gamesPath: string;
    gamesBytes: number;
    gamesSha256: string;
    auditPath: string;
    auditBytes: number;
    auditSha256: string;
}

interface IPureRangedTerminalRawReport {
    schemaVersion: 1;
    kind: "v0.7_pure_ranged_terminal_raw";
    phase: PureRangedTerminalPhase;
    generatedAt: string;
    runFingerprint: string;
    protocolSha256: string;
    games: number;
    arms: IPureRangedTerminalRawArmReport[];
    verdict: "PASS";
}

interface IPureRangedTerminalScoutReport {
    schemaVersion: 1;
    kind: "v0.7_pure_ranged_terminal_scout";
    generatedAt: string;
    runFingerprint: string;
    protocolSha256: string;
    rawReportSha256: string;
    comparisons: IPureRangedTerminalComparison[];
    selectedWeight: number | null;
    gateLine: string;
    verdict: "PASS" | "FAIL";
    authority: IPureRangedTerminalManifest["authority"];
}

interface IPureRangedTerminalIdentityCheck {
    template: PureRangedTerminalIdentityTemplate;
    games: number;
    exactActions: boolean;
    exactCandidateActions: boolean;
    exactOutcomes: boolean;
    selectedEligibleGames: number;
    selectedTerminalLeaves: number;
}

interface IPureRangedTerminalConfirmationReport {
    schemaVersion: 1;
    kind: "v0.7_pure_ranged_terminal_confirmation";
    generatedAt: string;
    runFingerprint: string;
    protocolSha256: string;
    rawReportSha256: string;
    selectedWeight: number;
    comparison: IPureRangedTerminalComparison;
    identityChecks: IPureRangedTerminalIdentityCheck[];
    gates: Record<string, boolean>;
    gateLine: string;
    verdict: "PASS" | "FAIL";
    authority: IPureRangedTerminalManifest["authority"];
}

interface IPureRangedTerminalValidatedGame {
    artifact: IPureRangedTerminalGameArtifact;
    audit: IPureRangedTerminalAuditDiagnostics;
    auditText: string;
}

interface IPureRangedTerminalValidatedRawEvidence {
    report: IPureRangedTerminalRawReport;
    rowsByArm: ReadonlyMap<string, readonly IPureRangedTerminalValidatedGame[]>;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNED_PROTOCOL_BASENAMES = new Set([
    basename(PURE_RANGED_TERMINAL_MANIFEST_PATH),
    basename(fileURLToPath(import.meta.url)),
    "v0_7_pure_ranged_terminal_trial.test.ts",
]);
const BEHAVIOR_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_EXACT = new Set([
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LIVETWIN",
    "ROSTER_CASTER_MAX",
    "ROSTER_CASTER_MIN",
    "ROSTER_FLYER_MAX",
    "ROSTER_FLYER_MIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "SIM_NO_ACTIONS",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);
const Z95 = 1.959963984540054;

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function atomicWriteText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
}

function atomicWriteJson(path: string, value: unknown): void {
    atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function isBehaviorKey(key: string): boolean {
    return BEHAVIOR_EXACT.has(key) || BEHAVIOR_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function exactRosterNames(): string[] {
    return v07ArchetypeTemplate(PURE_RANGED_TERMINAL_TEMPLATE).roster.map(({ creatureName }) => creatureName);
}

function expectedIdentitySeeds(baseSeed: number, offset: number): Record<PureRangedTerminalIdentityTemplate, number> {
    return Object.fromEntries(
        PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES.map((template, index) => [
            template,
            (baseSeed + Math.imul(offset + index, PURE_RANGED_TERMINAL_PAIR_SEED_STEP)) >>> 0,
        ]),
    ) as Record<PureRangedTerminalIdentityTemplate, number>;
}

export function readPureRangedTerminalManifest(path: string = PURE_RANGED_TERMINAL_MANIFEST_PATH): {
    manifest: IPureRangedTerminalManifest;
    provenance: IPureRangedTerminalManifestProvenance;
} {
    const sourcePath = resolve(path);
    const raw = readFileSync(sourcePath, "utf8");
    const manifest = JSON.parse(raw) as IPureRangedTerminalManifest;
    validatePureRangedTerminalManifest(manifest);
    return { manifest, provenance: { path: sourcePath, sha256: sha256(raw) } };
}

export function validatePureRangedTerminalManifest(manifest: IPureRangedTerminalManifest): void {
    if (
        manifest.schemaVersion !== 1 ||
        manifest.manifestId !== "v0.7-pure-ranged-terminal-20260716" ||
        !Number.isFinite(Date.parse(manifest.createdAt)) ||
        manifest.status !== "preregistered_research_only_no_bake" ||
        manifest.candidate !== "v0.7" ||
        manifest.opponent !== "v0.6"
    ) {
        throw new Error("Invalid pure-ranged terminal manifest identity");
    }
    if (
        !manifest.panelScope.includes("not current-ranked setup evidence") ||
        !manifest.pairing.includes("shared") ||
        manifest.pairSeedStep !== PURE_RANGED_TERMINAL_PAIR_SEED_STEP ||
        !manifest.scenarioReservation.armExecutionsExcludedFromUniqueCount ||
        manifest.scenarioReservation.scout.baseSeed !== 87_113_710 ||
        manifest.scenarioReservation.scout.gamesPerArm !== 512 ||
        manifest.scenarioReservation.scout.pairSeeds !== 256 ||
        manifest.scenarioReservation.confirmation.baseSeed !== 87_123_710 ||
        manifest.scenarioReservation.confirmation.gamesPerArm !== 4_000 ||
        manifest.scenarioReservation.confirmation.pairSeeds !== 2_000 ||
        manifest.scenarioReservation.confirmation.identityPairOffset !== 2_000 ||
        manifest.scenarioReservation.confirmation.identityGamesPerTemplatePerArm !== 2 ||
        stableJson(manifest.scenarioReservation.confirmation.identityPairSeeds) !==
            stableJson(expectedIdentitySeeds(87_123_710, 2_000)) ||
        stableJson(manifest.arms.scoutWeights) !== stableJson(PURE_RANGED_TERMINAL_SCOUT_WEIGHTS)
    ) {
        throw new Error("Pure-ranged terminal scenario reservation drifted");
    }
    if (
        manifest.mechanismPanel.template !== PURE_RANGED_TERMINAL_TEMPLATE ||
        stableJson(manifest.mechanismPanel.roster) !== stableJson(exactRosterNames()) ||
        manifest.mechanismPanel.amountMode !== "expBudget" ||
        manifest.mechanismPanel.grid !== "NORMAL" ||
        !manifest.mechanismPanel.originalStacksMustAllBeRange
    ) {
        throw new Error("Pure-ranged terminal historical mechanism panel drifted");
    }
    const envelope = manifest.searchEnvelope;
    const expectedLeafHash = sha256(JSON.stringify(DEFAULT_V07_VALUE_WEIGHTS));
    if (
        envelope.mode !== "search" ||
        envelope.versions !== "v0.7" ||
        envelope.gate !== 0.01 ||
        envelope.horizon !== 4 ||
        envelope.rollouts !== 1 ||
        envelope.shortlist !== 3 ||
        envelope.includeMoves ||
        envelope.maxMoves !== 1 ||
        envelope.maxMelee !== 4 ||
        envelope.maxShots !== 6 ||
        envelope.maxThrows !== 2 ||
        envelope.activeChallengers ||
        envelope.decisionDeadlineMs !== 200 ||
        envelope.circuitBreakerMs !== 275 ||
        envelope.lateRangedFinishWeight !== 0 ||
        envelope.opponentModel !== null ||
        envelope.valueLeaf !== "committed_default_20d" ||
        envelope.valueLeafSha256 !== expectedLeafHash ||
        !manifest.identityControlEnvelope.inheritsSearchPolicy ||
        manifest.identityControlEnvelope.decisionDeadlineMs !== null ||
        manifest.identityControlEnvelope.circuitBreakerMs !== null
    ) {
        throw new Error("Pure-ranged terminal search envelope drifted");
    }
    const scout = manifest.scoutGates;
    if (
        scout.pairedDrawHalfScoreGainMin !== 0.03 ||
        scout.pairedDrawHalfScoreGain95LcbExclusiveMin !== 0 ||
        scout.drawOrArmageddonDeltaMax !== -0.05 ||
        scout.drawOrArmageddonDelta95UcbExclusiveMax !== 0 ||
        scout.candidateAndOpponentRejections !== 0 ||
        scout.eligibleGamesMin !== 1 ||
        scout.eligibleLeavesMin !== 1 ||
        scout.nonzeroEligibleLeavesMin !== 1 ||
        scout.causalCandidateActionHashChangedGamesMin !== 1 ||
        scout.deadlineFallbacks !== 0 ||
        scout.circuitOpenGameRateMax !== 0 ||
        scout.searchedTurnLatencyP95MsMax !== 200
    ) {
        throw new Error("Pure-ranged terminal scout gates drifted");
    }
    const confirmation = manifest.confirmationGates;
    if (
        !confirmation.repeatEveryScoutGate ||
        confirmation.selectedDecisiveWinRate95LcbExclusiveMin !== 0.5 ||
        confirmation.selectedDrawOrArmageddonRateMax !== 0.9 ||
        confirmation.eligibleRangedCausalActionHashChangedGamesMin !== 1 ||
        stableJson(confirmation.ineligibleTemplates) !== stableJson(PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES)
    ) {
        throw new Error("Pure-ranged terminal confirmation gates drifted");
    }
    const completion = manifest.completion;
    if (
        completion.scoutRawMarker !== "SCOUT_RAW_COMPLETE" ||
        completion.scoutAnalysisMarker !== "SCOUT_ANALYSIS_COMPLETE" ||
        completion.scoutPassLine !== "PURE RANGED TERMINAL SCOUT GATE: PASS" ||
        completion.confirmationRawMarker !== "CONFIRMATION_RAW_COMPLETE" ||
        completion.confirmationAnalysisMarker !== "CONFIRMATION_ANALYSIS_COMPLETE" ||
        completion.confirmationPassLine !== "PURE RANGED TERMINAL CONFIRMATION GATE: PASS" ||
        !completion.rawAndAuditExactCompleteness ||
        !completion.hashEverySealedArtifact ||
        completion.automaticBake ||
        completion.automaticDeploy
    ) {
        throw new Error("Pure-ranged terminal completion policy drifted");
    }
    const planned = plannedPureRangedTerminalSeeds(manifest);
    if (
        planned.size !== 2_262 ||
        manifest.scenarioReservation.uniqueScenarioSeeds !== planned.size ||
        manifest.freshSeedAudit.plannedUniqueScenarioSeeds !== planned.size ||
        manifest.freshSeedAudit.internalCollisions !== 0 ||
        manifest.freshSeedAudit.localCollisions !== 0 ||
        manifest.freshSeedAudit.zincCollisions !== 0 ||
        manifest.authority.defaultWeight !== 0 ||
        manifest.authority.bake ||
        manifest.authority.deploy ||
        manifest.authority.instruction !== "NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY_FROM_THIS_HARNESS"
    ) {
        throw new Error("Pure-ranged terminal seed or authority declaration drifted");
    }
}

function addSeedStream(target: Set<number>, baseSeed: number, pairs: number, label: string): void {
    for (let pair = 0; pair < pairs; pair += 1) {
        const seed = (baseSeed + Math.imul(pair, PURE_RANGED_TERMINAL_PAIR_SEED_STEP)) >>> 0;
        if (target.has(seed)) throw new Error(`Pure-ranged terminal internal seed collision at ${seed} (${label})`);
        target.add(seed);
    }
}

export function plannedPureRangedTerminalSeeds(manifest: IPureRangedTerminalManifest): Set<number> {
    const seeds = new Set<number>();
    addSeedStream(
        seeds,
        manifest.scenarioReservation.scout.baseSeed,
        manifest.scenarioReservation.scout.pairSeeds,
        "scout",
    );
    addSeedStream(
        seeds,
        manifest.scenarioReservation.confirmation.baseSeed,
        manifest.scenarioReservation.confirmation.pairSeeds,
        "confirmation",
    );
    for (const template of PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES) {
        const seed = manifest.scenarioReservation.confirmation.identityPairSeeds[template];
        if (seeds.has(seed)) throw new Error(`Pure-ranged terminal identity seed collision at ${seed} (${template})`);
        seeds.add(seed);
    }
    return seeds;
}

export function expectedPureRangedTerminalSeed(arm: IPureRangedTerminalArm, game: number): number {
    if (!Number.isSafeInteger(game) || game < 0 || game >= arm.games) {
        throw new Error(`${arm.id} game index out of range: ${game}`);
    }
    return (arm.baseSeed + Math.imul(Math.floor(game / 2), PURE_RANGED_TERMINAL_PAIR_SEED_STEP)) >>> 0;
}

export function findPureRangedTerminalSeedCollisions(
    manifest: IPureRangedTerminalManifest,
    numericTokens: Iterable<number>,
): number[] {
    const planned = plannedPureRangedTerminalSeeds(manifest);
    return [...new Set([...numericTokens].filter((token) => planned.has(token)))].sort((left, right) => left - right);
}

export function auditPureRangedTerminalSeedRoots(
    manifest: IPureRangedTerminalManifest,
    roots: readonly string[],
): IPureRangedTerminalSeedAudit {
    const existingRoots = roots.map((root) => resolve(root)).filter(existsSync);
    if (!existingRoots.length) throw new Error("Pure-ranged terminal seed audit has no existing roots");
    const args = ["-o", "--no-filename", "--hidden"];
    for (const pattern of ["!**/.git/**", "!**/node_modules/**", "!**/dist/**"]) args.push("--glob", pattern);
    for (const name of OWNED_PROTOCOL_BASENAMES) args.push("--glob", `!**/${name}`);
    args.push("[0-9]{7,10}", ...existingRoots);
    const result = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`Pure-ranged terminal seed audit failed (${result.status}): ${result.stderr}`);
    }
    const tokens = result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
    const collisions = findPureRangedTerminalSeedCollisions(manifest, tokens);
    if (collisions.length) {
        throw new Error(`Pure-ranged terminal fresh-seed collision(s): ${collisions.slice(0, 20).join(", ")}`);
    }
    return { roots: existingRoots, numericTokens: new Set(tokens).size, collisions };
}

export function pureRangedTerminalEnvironment(
    manifest: IPureRangedTerminalManifest,
    weight: number,
    timingEnvelope: IPureRangedTerminalArm["timingEnvelope"],
    source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    if (!PURE_RANGED_TERMINAL_SCOUT_WEIGHTS.includes(weight as PureRangedTerminalWeight)) {
        throw new Error(`Unregistered pure-ranged terminal weight ${weight}`);
    }
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (!isBehaviorKey(key) && value !== undefined) environment[key] = value;
    }
    const envelope = manifest.searchEnvelope;
    Object.assign(environment, {
        LIVETWIN: "1",
        FIGHT_MELEE_ROSTERS: "0",
        V07_SEARCH: "1",
        SEARCH_VERSIONS: envelope.versions,
        SEARCH_GATE: String(envelope.gate),
        SEARCH_HORIZON: String(envelope.horizon),
        SEARCH_ROLLOUTS: String(envelope.rollouts),
        SEARCH_SHORTLIST: String(envelope.shortlist),
        SEARCH_INCLUDE_MOVES: "0",
        SEARCH_MAX_MOVES: String(envelope.maxMoves),
        SEARCH_MAX_MELEE: String(envelope.maxMelee),
        SEARCH_MAX_SHOTS: String(envelope.maxShots),
        SEARCH_MAX_THROWS: String(envelope.maxThrows),
        SEARCH_ACTIVE_CHALLENGERS: "0",
        SEARCH_DECISION_DEADLINE_MS: timingEnvelope === "ranged_performance" ? String(envelope.decisionDeadlineMs) : "",
        SEARCH_CIRCUIT_BREAKER_MS: timingEnvelope === "ranged_performance" ? String(envelope.circuitBreakerMs) : "",
        SEARCH_LATE_RANGED_FINISH_WEIGHT: "0",
        SEARCH_PURE_RANGED_TERMINAL_WEIGHT: String(weight),
        SEARCH_OPP_MODEL: "",
        SEARCH_AUDIT_TURNS: "1",
        V07_VALUE_WEIGHTS: "",
        V07_VALUE_WEIGHTS_V2: "",
        Q2_ORACLE: "0",
        Q2_WAIT_ABLATION: "0",
    });
    delete environment.SIM_NO_ACTIONS;
    return environment;
}

function gitText(args: string[]): string {
    return execFileSync("git", ["-C", PROJECT_ROOT, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function readCleanMainRevision(): IPureRangedTerminalRevision {
    const branch = gitText(["branch", "--show-current"]);
    const commit = gitText(["rev-parse", "HEAD"]);
    const originMain = gitText(["rev-parse", "origin/main"]);
    const trackedStatus = gitText(["status", "--porcelain", "--untracked-files=no"]);
    if (branch !== "main" || commit !== originMain || trackedStatus) {
        throw new Error("Pure-ranged terminal execution requires tracked-clean pushed main");
    }
    let remote: string | null = null;
    try {
        remote = gitText(["remote", "get-url", "origin"]);
    } catch {
        remote = null;
    }
    return {
        commit,
        commitDate: gitText(["show", "-s", "--format=%cI", "HEAD"]),
        branch: "main",
        originMain,
        trackedClean: true,
        remote,
    };
}

function sourceHashes(): Record<string, string> {
    const sources = [
        fileURLToPath(import.meta.url),
        PURE_RANGED_TERMINAL_MANIFEST_PATH,
        join(PROJECT_ROOT, "src/simulation/search_driver.ts"),
        join(PROJECT_ROOT, "src/simulation/v0_7_pure_ranged_terminal.ts"),
        join(PROJECT_ROOT, "src/simulation/v0_7_archetype_battery.ts"),
        join(PROJECT_ROOT, "src/simulation/battle_engine.ts"),
    ];
    return Object.fromEntries(sources.map((path) => [relative(PROJECT_ROOT, path), sha256(readFileSync(path))]));
}

function initializeRun(
    runDir: string,
    protocol: IPureRangedTerminalManifestProvenance,
    revision: IPureRangedTerminalRevision,
    manifest: IPureRangedTerminalManifest,
): IPureRangedTerminalRunManifest {
    const path = join(runDir, "run.json");
    if (existsSync(path)) return validateRun(runDir, protocol, revision);
    const seedAudit = auditPureRangedTerminalSeedRoots(manifest, manifest.freshSeedAudit.localRoots);
    const hashes = sourceHashes();
    const identity = { protocol, revision, sourceHashes: hashes, seedAudit };
    const run: IPureRangedTerminalRunManifest = {
        schemaVersion: 1,
        kind: "v0.7_pure_ranged_terminal_run",
        createdAt: new Date().toISOString(),
        runFingerprint: sha256(stableJson(identity)),
        protocol,
        revision,
        sourceHashes: hashes,
        seedAudit,
        qualification: "RESEARCH_ONLY_NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY",
    };
    atomicWriteJson(path, run);
    return run;
}

function validateRun(
    runDir: string,
    protocol: IPureRangedTerminalManifestProvenance,
    revision: IPureRangedTerminalRevision,
): IPureRangedTerminalRunManifest {
    const path = join(runDir, "run.json");
    const run = requireRecord(readJson(path), path) as unknown as IPureRangedTerminalRunManifest;
    const hashes = sourceHashes();
    if (
        run.schemaVersion !== 1 ||
        run.kind !== "v0.7_pure_ranged_terminal_run" ||
        run.protocol.sha256 !== protocol.sha256 ||
        run.revision.commit !== revision.commit ||
        run.revision.originMain !== revision.originMain ||
        stableJson(run.sourceHashes) !== stableJson(hashes) ||
        run.runFingerprint !==
            sha256(
                stableJson({
                    protocol: run.protocol,
                    revision: run.revision,
                    sourceHashes: run.sourceHashes,
                    seedAudit: run.seedAudit,
                }),
            ) ||
        run.qualification !== "RESEARCH_ONLY_NO_BAKE_NO_DEFAULT_CHANGE_NO_DEPLOY"
    ) {
        throw new Error("Pure-ranged terminal run provenance drifted");
    }
    return run;
}

function weightId(weight: number): string {
    return `weight-${String(weight).replace(".", "p")}`;
}

function scoutArms(manifest: IPureRangedTerminalManifest): IPureRangedTerminalArm[] {
    return PURE_RANGED_TERMINAL_SCOUT_WEIGHTS.map((weight) => ({
        id: weightId(weight),
        phase: "scout",
        weight,
        template: PURE_RANGED_TERMINAL_TEMPLATE,
        games: manifest.scenarioReservation.scout.gamesPerArm,
        baseSeed: manifest.scenarioReservation.scout.baseSeed,
        timingEnvelope: "ranged_performance",
    }));
}

function confirmationArms(manifest: IPureRangedTerminalManifest, selectedWeight: number): IPureRangedTerminalArm[] {
    const panel = manifest.scenarioReservation.confirmation;
    const pure = [0, selectedWeight].map((weight) => ({
        id: weightId(weight),
        phase: "confirmation" as const,
        weight,
        template: PURE_RANGED_TERMINAL_TEMPLATE,
        games: panel.gamesPerArm,
        baseSeed: panel.baseSeed,
        timingEnvelope: "ranged_performance" as const,
    }));
    const identity = [0, selectedWeight].flatMap((weight) =>
        PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES.map((template) => ({
            id: `${weightId(weight)}__${template}`,
            phase: "confirmation" as const,
            weight,
            template,
            games: panel.identityGamesPerTemplatePerArm,
            baseSeed: panel.identityPairSeeds[template],
            timingEnvelope: "deterministic_identity" as const,
        })),
    );
    return [...pure, ...identity];
}

function gamePaths(runDir: string, arm: IPureRangedTerminalArm, game: number): { result: string; audit: string } {
    const stem = game.toString().padStart(5, "0");
    const root = join(runDir, "raw", arm.phase, arm.id);
    return { result: join(root, "games", `${stem}.json`), audit: join(root, "audit", `${stem}.jsonl`) };
}

function playTrialGame(
    arm: IPureRangedTerminalArm,
    game: number,
    runFingerprint: string,
): IPureRangedTerminalGameArtifact {
    const template = v07ArchetypeTemplate(arm.template);
    const spec: IV07ArchetypeCellSpec = {
        archetype: template.archetype,
        template: arm.template,
        candidate: "v0.7",
        opponent: "v0.6",
        baseSeed: arm.baseSeed,
        games: arm.games,
    };
    let match: IMatchResult | null = null;
    const record = playV07ArchetypeGame(spec, game, {
        matchRunner: (config) => {
            match = runMatch(config);
            return match;
        },
    });
    if (!match) throw new Error(`${arm.id}/${game}: match runner returned no result`);
    const result = match as IMatchResult;
    const candidateSide = record.candidateIsGreen ? "green" : "red";
    const candidateActions = result.actions.filter(({ side }) => side === candidateSide);
    const won = record.winner === candidateSide;
    const score = record.winner === "draw" ? 0.5 : won ? 1 : 0;
    return {
        schemaVersion: 1,
        runFingerprint,
        phase: arm.phase,
        armId: arm.id,
        weight: arm.weight,
        template: arm.template,
        game,
        seed: record.seed,
        candidateIsGreen: record.candidateIsGreen,
        greenVersion: record.greenVersion,
        redVersion: record.redVersion,
        winner: record.winner,
        endReason: record.endReason,
        laps: record.laps,
        score,
        drawOrArmageddon: record.winner === "draw" || record.decidedByArmageddon,
        candidateRejections:
            record.rejectedGreen === undefined || record.rejectedRed === undefined
                ? null
                : record.candidateIsGreen
                  ? record.rejectedGreen
                  : record.rejectedRed,
        opponentRejections:
            record.rejectedGreen === undefined || record.rejectedRed === undefined
                ? null
                : record.candidateIsGreen
                  ? record.rejectedRed
                  : record.rejectedGreen,
        actions: result.actions.length,
        candidateActions: candidateActions.length,
        actionsSha256: sha256(stableJson(result.actions)),
        candidateActionsSha256: sha256(stableJson(candidateActions)),
    };
}

interface IPureRangedTerminalWorkerEnvelope {
    marker: "v0.7-pure-ranged-terminal-worker";
    arm: IPureRangedTerminalArm;
    runDir: string;
    runFingerprint: string;
    environment: Record<string, string>;
}

interface IPureRangedTerminalWorkerEnvironmentProbe {
    marker: "v0.7-pure-ranged-terminal-worker-environment-probe";
    environment: Record<string, string>;
}

export interface IPureRangedTerminalWorkerEnvironmentEvidence {
    importTimeBehaviorEnvironment: Record<string, string>;
    runtimeBehaviorEnvironment: Record<string, string>;
}

function effectiveBehaviorEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment)
            .filter((entry): entry is [string, string] => isBehaviorKey(entry[0]) && entry[1] !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}

// WorkerOptions.env is installed by the runtime before this entry module and all of its static policy imports.
const IMPORT_TIME_BEHAVIOR_ENVIRONMENT = effectiveBehaviorEnvironment(process.env);

if (!isMainThread && parentPort) {
    const envelope = workerData as IPureRangedTerminalWorkerEnvelope | IPureRangedTerminalWorkerEnvironmentProbe;
    if (envelope.marker === "v0.7-pure-ranged-terminal-worker-environment-probe") {
        parentPort.postMessage({
            importTimeBehaviorEnvironment: IMPORT_TIME_BEHAVIOR_ENVIRONMENT,
            runtimeBehaviorEnvironment: effectiveBehaviorEnvironment(process.env),
        } satisfies IPureRangedTerminalWorkerEnvironmentEvidence);
        parentPort.close();
    }
    if (envelope.marker === "v0.7-pure-ranged-terminal-worker") {
        for (const key of Object.keys(process.env)) {
            if (isBehaviorKey(key)) delete process.env[key];
        }
        Object.assign(process.env, envelope.environment);
        const port = parentPort;
        port.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
            if (message.type === "stop") {
                port.close();
                return;
            }
            const paths = gamePaths(envelope.runDir, envelope.arm, message.game);
            try {
                mkdirSync(dirname(paths.audit), { recursive: true });
                if (existsSync(paths.audit)) unlinkSync(paths.audit);
                process.env.SEARCH_AUDIT = paths.audit;
                const artifact = playTrialGame(envelope.arm, message.game, envelope.runFingerprint);
                port.postMessage({ type: "result", artifact });
            } catch (error) {
                port.postMessage({
                    type: "error",
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            }
        });
        port.postMessage({ type: "ready" });
    }
}

/** Prove that a worker starts with the frozen profile before this module's static policy imports execute. */
export async function probePureRangedTerminalWorkerEnvironment(
    manifest: IPureRangedTerminalManifest,
    weight: number,
    timingEnvelope: IPureRangedTerminalArm["timingEnvelope"],
    source: NodeJS.ProcessEnv,
): Promise<IPureRangedTerminalWorkerEnvironmentEvidence> {
    const environment = stringEnvironment(pureRangedTerminalEnvironment(manifest, weight, timingEnvelope, source));
    return new Promise<IPureRangedTerminalWorkerEnvironmentEvidence>((resolvePromise, rejectPromise) => {
        const worker = new Worker(new URL(import.meta.url), {
            workerData: {
                marker: "v0.7-pure-ranged-terminal-worker-environment-probe",
                environment,
            } satisfies IPureRangedTerminalWorkerEnvironmentProbe,
            env: environment,
        });
        worker.once("message", (message: IPureRangedTerminalWorkerEnvironmentEvidence) => {
            resolvePromise(message);
            void worker.terminate();
        });
        worker.once("error", rejectPromise);
        worker.once("exit", (code) => {
            if (code !== 0) rejectPromise(new Error(`Pure-ranged terminal environment probe exited ${code}`));
        });
    });
}

function parseAudit(
    path: string,
    artifact: IPureRangedTerminalGameArtifact,
    arm: IPureRangedTerminalArm,
    manifest: IPureRangedTerminalManifest,
): IPureRangedTerminalAuditDiagnostics {
    if (!existsSync(path)) throw new Error(`${arm.id}/${artifact.game}: missing search audit`);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const rows = lines.map((line, index) => requireRecord(JSON.parse(line), `${path}:${index + 1}`));
    if (!rows.length || rows.at(-1)?.t !== "game" || rows.slice(0, -1).some(({ t }) => t !== "turn")) {
        throw new Error(`${arm.id}/${artifact.game}: audit must contain turn rows followed by one game row`);
    }
    const game = rows.at(-1)!;
    const turns = rows.slice(0, -1);
    const envelope = manifest.searchEnvelope;
    const expectedCircuit = arm.timingEnvelope === "ranged_performance" ? envelope.circuitBreakerMs : null;
    const expectedDeadline = arm.timingEnvelope === "ranged_performance" ? envelope.decisionDeadlineMs : null;
    if (
        game.mode !== "search" ||
        game.seed !== artifact.seed ||
        game.green !== artifact.greenVersion ||
        game.red !== artifact.redVersion ||
        game.winner !== artifact.winner ||
        game.endReason !== artifact.endReason ||
        game.gate !== envelope.gate ||
        game.horizon !== envelope.horizon ||
        game.rollouts !== envelope.rollouts ||
        game.leaf !== "learned" ||
        game.shortlist !== envelope.shortlist ||
        game.decisionDeadlineMs !== expectedDeadline ||
        game.circuitBreakerMs !== expectedCircuit ||
        game.lateRangedFinishWeight !== 0 ||
        game.pureRangedTerminalWeight !== arm.weight ||
        !Number.isSafeInteger(game.searched) ||
        game.searched !== turns.length ||
        !Number.isSafeInteger(game.deadlineFallbacks) ||
        (game.deadlineFallbacks as number) < 0 ||
        typeof game.circuitOpened !== "boolean" ||
        !Number.isSafeInteger(game.pureRangedTerminalLeaves) ||
        (game.pureRangedTerminalLeaves as number) < 0 ||
        !Number.isSafeInteger(game.pureRangedTerminalNonzeroLeaves) ||
        (game.pureRangedTerminalNonzeroLeaves as number) < 0 ||
        (game.pureRangedTerminalNonzeroLeaves as number) > (game.pureRangedTerminalLeaves as number) ||
        typeof game.pureRangedTerminalEligible !== "boolean"
    ) {
        throw new Error(`${arm.id}/${artifact.game}: search audit identity or envelope mismatch`);
    }
    const latency: number[] = [];
    let deadlineFallbacks = 0;
    for (const [index, turn] of turns.entries()) {
        if (
            turn.seed !== artifact.seed ||
            turn.green !== artifact.greenVersion ||
            turn.red !== artifact.redVersion ||
            typeof turn.ms !== "number" ||
            !Number.isFinite(turn.ms) ||
            (turn.ms as number) < 0 ||
            (turn.deadlineFallback !== undefined && turn.deadlineFallback !== 1)
        ) {
            throw new Error(`${arm.id}/${artifact.game}: invalid audit turn ${index}`);
        }
        latency.push(turn.ms as number);
        deadlineFallbacks += Number(turn.deadlineFallback === 1);
    }
    if (deadlineFallbacks !== game.deadlineFallbacks) {
        throw new Error(`${arm.id}/${artifact.game}: deadline fallback accounting mismatch`);
    }
    const eligible = game.pureRangedTerminalEligible as boolean;
    const leaves = game.pureRangedTerminalLeaves as number;
    const nonzeroLeaves = game.pureRangedTerminalNonzeroLeaves as number;
    if (
        (arm.weight === 0 && (eligible || leaves !== 0 || nonzeroLeaves !== 0)) ||
        (arm.weight > 0 && arm.template !== PURE_RANGED_TERMINAL_TEMPLATE && (eligible || leaves !== 0)) ||
        (arm.weight > 0 && arm.template === PURE_RANGED_TERMINAL_TEMPLATE && !eligible) ||
        (arm.timingEnvelope === "deterministic_identity" && (game.circuitOpened || deadlineFallbacks !== 0))
    ) {
        throw new Error(`${arm.id}/${artifact.game}: terminal eligibility or deterministic-control tripwire failed`);
    }
    return {
        auditRows: rows.length,
        searchedTurns: turns.length,
        deadlineFallbacks,
        circuitOpened: game.circuitOpened as boolean,
        terminalEligible: eligible,
        terminalLeaves: leaves,
        terminalNonzeroLeaves: nonzeroLeaves,
        turnLatencyMs: latency,
    };
}

function validateGameArtifact(
    runDir: string,
    arm: IPureRangedTerminalArm,
    game: number,
    runFingerprint: string,
    manifest: IPureRangedTerminalManifest,
): IPureRangedTerminalValidatedGame {
    const paths = gamePaths(runDir, arm, game);
    if (!existsSync(paths.result)) throw new Error(`${arm.id}/${game}: missing game result`);
    const artifact = requireRecord(readJson(paths.result), paths.result) as unknown as IPureRangedTerminalGameArtifact;
    const candidateIsGreen = game % 2 === 0;
    const expectedSeed = expectedPureRangedTerminalSeed(arm, game);
    if (
        artifact.schemaVersion !== 1 ||
        artifact.runFingerprint !== runFingerprint ||
        artifact.phase !== arm.phase ||
        artifact.armId !== arm.id ||
        artifact.weight !== arm.weight ||
        artifact.template !== arm.template ||
        artifact.game !== game ||
        artifact.seed !== expectedSeed ||
        artifact.candidateIsGreen !== candidateIsGreen ||
        artifact.greenVersion !== (candidateIsGreen ? manifest.candidate : manifest.opponent) ||
        artifact.redVersion !== (candidateIsGreen ? manifest.opponent : manifest.candidate) ||
        !["green", "red", "draw"].includes(artifact.winner) ||
        !["elimination", "turn_cap", "stuck"].includes(artifact.endReason) ||
        ![0, 0.5, 1].includes(artifact.score) ||
        typeof artifact.drawOrArmageddon !== "boolean" ||
        artifact.candidateRejections === null ||
        artifact.opponentRejections === null ||
        !Number.isSafeInteger(artifact.candidateRejections) ||
        artifact.candidateRejections < 0 ||
        !Number.isSafeInteger(artifact.opponentRejections) ||
        artifact.opponentRejections < 0 ||
        !Number.isSafeInteger(artifact.actions) ||
        artifact.actions < 0 ||
        !Number.isSafeInteger(artifact.candidateActions) ||
        artifact.candidateActions < 0 ||
        !/^[a-f0-9]{64}$/.test(artifact.actionsSha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.candidateActionsSha256)
    ) {
        throw new Error(`${arm.id}/${game}: game artifact identity or shape mismatch`);
    }
    const auditText = readFileSync(paths.audit, "utf8");
    return { artifact, audit: parseAudit(paths.audit, artifact, arm, manifest), auditText };
}

function exactFileSet(path: string, games: number, suffix: string): void {
    const expected = new Set(
        Array.from({ length: games }, (_, game) => `${game.toString().padStart(5, "0")}${suffix}`),
    );
    const actual = existsSync(path) ? readdirSync(path).filter((name) => !name.startsWith(".")) : [];
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
        throw new Error(`${path}: expected exactly ${expected.size} ${suffix} files; got ${actual.length}`);
    }
}

function exactNamedEntries(path: string, expectedNames: readonly string[]): void {
    const expected = new Set(expectedNames);
    const actual = existsSync(path) ? readdirSync(path).filter((name) => !name.startsWith(".")) : [];
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
        throw new Error(
            `${path}: expected exactly [${[...expected].sort().join(", ")}]; got [${actual.sort().join(", ")}]`,
        );
    }
}

function rawArmIdentity(arm: IPureRangedTerminalRawArmIdentity): IPureRangedTerminalRawArmIdentity {
    return {
        id: arm.id,
        phase: arm.phase,
        weight: arm.weight,
        template: arm.template,
        games: arm.games,
        timingEnvelope: arm.timingEnvelope,
    };
}

/** Reject a raw report whose registered arms, ordering, or total execution count differ from the phase plan. */
export function validatePureRangedTerminalRawArmSet(
    actual: readonly IPureRangedTerminalRawArmIdentity[],
    expected: readonly IPureRangedTerminalRawArmIdentity[],
    reportedGames: number,
): void {
    if (
        stableJson(actual.map(rawArmIdentity)) !== stableJson(expected.map(rawArmIdentity)) ||
        reportedGames !== expected.reduce((sum, arm) => sum + arm.games, 0)
    ) {
        throw new Error("Pure-ranged terminal raw report arm set/order/count drifted");
    }
}

/** Reconstructed mutable raw evidence must be byte-identical to the hash-bound sealed concatenation. */
export function assertPureRangedTerminalRawMatchesSealed(
    label: string,
    reconstructed: string,
    sealed: string,
    expectedBytes: number,
    expectedSha256: string,
): void {
    if (reconstructed !== sealed || Buffer.byteLength(sealed) !== expectedBytes || sha256(sealed) !== expectedSha256) {
        throw new Error(`${label}: mutable raw evidence does not match sealed bytes/hash`);
    }
}

async function executeArm(
    runDir: string,
    arm: IPureRangedTerminalArm,
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
    concurrency: number,
): Promise<void> {
    const pending: number[] = [];
    for (let game = 0; game < arm.games; game += 1) {
        const paths = gamePaths(runDir, arm, game);
        if (existsSync(paths.result)) {
            validateGameArtifact(runDir, arm, game, run.runFingerprint, manifest);
            continue;
        }
        if (existsSync(paths.audit)) unlinkSync(paths.audit);
        pending.push(game);
    }
    if (!pending.length) return;
    const environment = pureRangedTerminalEnvironment(manifest, arm.weight, arm.timingEnvelope);
    const workerEnvironment = stringEnvironment(environment);
    const workerCount = Math.min(concurrency, pending.length);
    let cursor = 0;
    let completed = arm.games - pending.length;
    const workers = new Set<Worker>();
    await new Promise<void>((resolvePromise, rejectPromise) => {
        let stopped = false;
        const fail = (error: unknown): void => {
            if (stopped) return;
            stopped = true;
            for (const worker of workers) void worker.terminate();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const next = (worker: Worker): void => {
            if (cursor >= pending.length) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: pending[cursor++] });
        };
        for (let index = 0; index < workerCount; index += 1) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: {
                    marker: "v0.7-pure-ranged-terminal-worker",
                    arm,
                    runDir,
                    runFingerprint: run.runFingerprint,
                    environment: workerEnvironment,
                } satisfies IPureRangedTerminalWorkerEnvelope,
                // Unlike a worker-body cleanup, this is installed before static battle/strategy imports.
                env: workerEnvironment,
            });
            workers.add(worker);
            worker.on(
                "message",
                (message: { type: string; artifact?: IPureRangedTerminalGameArtifact; error?: string }) => {
                    if (message.type === "ready") {
                        next(worker);
                        return;
                    }
                    if (message.type === "error") {
                        fail(new Error(message.error ?? `${arm.id}: worker failed`));
                        return;
                    }
                    if (message.type !== "result" || !message.artifact) {
                        fail(new Error(`${arm.id}: unexpected worker message`));
                        return;
                    }
                    try {
                        const artifact = message.artifact;
                        const paths = gamePaths(runDir, arm, artifact.game);
                        atomicWriteJson(paths.result, artifact);
                        validateGameArtifact(runDir, arm, artifact.game, run.runFingerprint, manifest);
                        completed += 1;
                        if (completed % 64 === 0 || completed === arm.games) {
                            console.log(`${arm.phase}/${arm.id}: ${completed}/${arm.games}`);
                        }
                        if (completed === arm.games) {
                            stopped = true;
                            for (const active of workers) active.postMessage({ type: "stop" });
                            resolvePromise();
                        } else {
                            next(worker);
                        }
                    } catch (error) {
                        fail(error);
                    }
                },
            );
            worker.on("error", fail);
            worker.on("exit", (code) => {
                workers.delete(worker);
                if (!stopped && code !== 0) fail(new Error(`${arm.id}: worker exited ${code}`));
            });
        }
    });
}

function markerPath(manifest: IPureRangedTerminalManifest, runDir: string, phase: PureRangedTerminalPhase): string {
    return join(
        runDir,
        phase === "scout" ? manifest.completion.scoutRawMarker : manifest.completion.confirmationRawMarker,
    );
}

function analysisMarkerPath(
    manifest: IPureRangedTerminalManifest,
    runDir: string,
    phase: PureRangedTerminalPhase,
): string {
    return join(
        runDir,
        phase === "scout" ? manifest.completion.scoutAnalysisMarker : manifest.completion.confirmationAnalysisMarker,
    );
}

function sealRawPhase(
    runDir: string,
    arms: readonly IPureRangedTerminalArm[],
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
): IPureRangedTerminalRawReport {
    const reports: IPureRangedTerminalRawArmReport[] = [];
    for (const arm of arms) {
        const root = join(runDir, "raw", arm.phase, arm.id);
        exactFileSet(join(root, "games"), arm.games, ".json");
        exactFileSet(join(root, "audit"), arm.games, ".jsonl");
        let gamesText = "";
        let auditText = "";
        for (let game = 0; game < arm.games; game += 1) {
            const validated = validateGameArtifact(runDir, arm, game, run.runFingerprint, manifest);
            gamesText += `${JSON.stringify(validated.artifact)}\n`;
            auditText += validated.auditText.endsWith("\n") ? validated.auditText : `${validated.auditText}\n`;
        }
        const sealedRoot = join(runDir, "sealed", arm.phase);
        const gamesPath = join(sealedRoot, `${arm.id}.games.jsonl`);
        const auditPath = join(sealedRoot, `${arm.id}.audit.jsonl`);
        atomicWriteText(gamesPath, gamesText);
        atomicWriteText(auditPath, auditText);
        const gamesRaw = readFileSync(gamesPath);
        const auditRaw = readFileSync(auditPath);
        reports.push({
            id: arm.id,
            phase: arm.phase,
            weight: arm.weight,
            template: arm.template,
            games: arm.games,
            timingEnvelope: arm.timingEnvelope,
            gamesPath: relative(runDir, gamesPath),
            gamesBytes: gamesRaw.length,
            gamesSha256: sha256(gamesRaw),
            auditPath: relative(runDir, auditPath),
            auditBytes: auditRaw.length,
            auditSha256: sha256(auditRaw),
        });
    }
    const phase = arms[0]?.phase;
    if (!phase || arms.some((arm) => arm.phase !== phase)) throw new Error("Cannot seal a mixed trial phase");
    const report: IPureRangedTerminalRawReport = {
        schemaVersion: 1,
        kind: "v0.7_pure_ranged_terminal_raw",
        phase,
        generatedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        protocolSha256: run.protocol.sha256,
        games: arms.reduce((sum, arm) => sum + arm.games, 0),
        arms: reports,
        verdict: "PASS",
    };
    const reportPath = join(runDir, `${phase}-raw-report.json`);
    atomicWriteJson(reportPath, report);
    atomicWriteJson(markerPath(manifest, runDir, phase), {
        schemaVersion: 1,
        kind: `v0.7_pure_ranged_terminal_${phase}_raw_complete`,
        completedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        report: relative(runDir, reportPath),
        reportSha256: sha256(readFileSync(reportPath)),
        sealedArmsSha256: sha256(stableJson(reports)),
    });
    return report;
}

function validateRawMarker(
    runDir: string,
    phase: PureRangedTerminalPhase,
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
    expectedArms: readonly IPureRangedTerminalArm[],
): IPureRangedTerminalValidatedRawEvidence {
    const path = markerPath(manifest, runDir, phase);
    const marker = requireRecord(readJson(path), path);
    const reportPath = join(runDir, `${phase}-raw-report.json`);
    const report = requireRecord(readJson(reportPath), reportPath) as unknown as IPureRangedTerminalRawReport;
    if (
        marker.schemaVersion !== 1 ||
        marker.kind !== `v0.7_pure_ranged_terminal_${phase}_raw_complete` ||
        marker.runFingerprint !== run.runFingerprint ||
        marker.report !== relative(runDir, reportPath) ||
        marker.reportSha256 !== sha256(readFileSync(reportPath)) ||
        report.schemaVersion !== 1 ||
        report.kind !== "v0.7_pure_ranged_terminal_raw" ||
        report.phase !== phase ||
        report.runFingerprint !== run.runFingerprint ||
        report.protocolSha256 !== run.protocol.sha256 ||
        report.verdict !== "PASS" ||
        !Array.isArray(report.arms) ||
        marker.sealedArmsSha256 !== sha256(stableJson(report.arms))
    ) {
        throw new Error(`${phase} raw completion marker failed validation`);
    }
    validatePureRangedTerminalRawArmSet(report.arms, expectedArms, report.games);
    exactNamedEntries(
        join(runDir, "raw", phase),
        expectedArms.map(({ id }) => id),
    );
    exactNamedEntries(
        join(runDir, "sealed", phase),
        expectedArms.flatMap(({ id }) => [`${id}.games.jsonl`, `${id}.audit.jsonl`]),
    );

    const rowsByArm = new Map<string, readonly IPureRangedTerminalValidatedGame[]>();
    for (let index = 0; index < expectedArms.length; index += 1) {
        const expected = expectedArms[index];
        const reported = report.arms[index];
        const rawRoot = join(runDir, "raw", phase, expected.id);
        const gamesPath = join(runDir, "sealed", phase, `${expected.id}.games.jsonl`);
        const auditPath = join(runDir, "sealed", phase, `${expected.id}.audit.jsonl`);
        if (reported.gamesPath !== relative(runDir, gamesPath) || reported.auditPath !== relative(runDir, auditPath)) {
            throw new Error(`${phase}/${expected.id}: sealed artifact path drifted`);
        }
        exactNamedEntries(rawRoot, ["games", "audit"]);
        exactFileSet(join(rawRoot, "games"), expected.games, ".json");
        exactFileSet(join(rawRoot, "audit"), expected.games, ".jsonl");

        let reconstructedGames = "";
        let reconstructedAudit = "";
        const rows: IPureRangedTerminalValidatedGame[] = [];
        for (let game = 0; game < expected.games; game += 1) {
            const validated = validateGameArtifact(runDir, expected, game, run.runFingerprint, manifest);
            rows.push(validated);
            reconstructedGames += `${JSON.stringify(validated.artifact)}\n`;
            reconstructedAudit += validated.auditText.endsWith("\n") ? validated.auditText : `${validated.auditText}\n`;
        }
        assertPureRangedTerminalRawMatchesSealed(
            `${phase}/${expected.id}/games`,
            reconstructedGames,
            readFileSync(gamesPath, "utf8"),
            reported.gamesBytes,
            reported.gamesSha256,
        );
        assertPureRangedTerminalRawMatchesSealed(
            `${phase}/${expected.id}/audit`,
            reconstructedAudit,
            readFileSync(auditPath, "utf8"),
            reported.auditBytes,
            reported.auditSha256,
        );
        rowsByArm.set(expected.id, rows);
    }
    if (rowsByArm.size !== expectedArms.length) {
        throw new Error(`${phase}: validated raw evidence arm count mismatch`);
    }
    for (const arm of report.arms) {
        const games = readFileSync(resolve(runDir, arm.gamesPath));
        const audit = readFileSync(resolve(runDir, arm.auditPath));
        if (
            games.length !== arm.gamesBytes ||
            sha256(games) !== arm.gamesSha256 ||
            audit.length !== arm.auditBytes ||
            sha256(audit) !== arm.auditSha256
        ) {
            throw new Error(`${phase}/${arm.id}: sealed artifact hash mismatch`);
        }
    }
    return { report, rowsByArm };
}

/** Hash the exact pretty-printed report bytes bound by the raw completion marker. */
export function pureRangedTerminalRawReportSha256(runDir: string, phase: PureRangedTerminalPhase): string {
    return sha256(readFileSync(join(runDir, `${phase}-raw-report.json`)));
}

function quantile(values: readonly number[], probability: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1)];
}

export function estimatePureRangedTerminalDelta(values: readonly number[]): IPureRangedTerminalEstimate {
    const clusters = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, clusters);
    if (clusters < 2) return { clusters, mean, standardError: null, confidence95: null };
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clusters - 1);
    const standardError = Math.sqrt(variance / clusters);
    return {
        clusters,
        mean,
        standardError,
        confidence95: { low: mean - Z95 * standardError, high: mean + Z95 * standardError },
    };
}

function pairMeans(
    rows: readonly IPureRangedTerminalValidatedGame[],
    value: (row: IPureRangedTerminalGameArtifact) => number,
): number[] {
    const values: number[] = [];
    for (let game = 0; game < rows.length; game += 2) {
        values.push((value(rows[game].artifact) + value(rows[game + 1].artifact)) / 2);
    }
    return values;
}

function decisiveStats(rows: readonly IPureRangedTerminalValidatedGame[]): {
    candidateWins: number;
    opponentWins: number;
    draws: number;
    rate: number;
    confidence95: { low: number; high: number } | null;
} {
    const candidateWins = rows.filter(({ artifact }) => artifact.score === 1).length;
    const opponentWins = rows.filter(({ artifact }) => artifact.score === 0).length;
    const draws = rows.length - candidateWins - opponentWins;
    const decisive = candidateWins + opponentWins;
    const rate = decisive ? candidateWins / decisive : 0.5;
    if (rows.length < 4 || decisive === 0) {
        return { candidateWins, opponentWins, draws, rate, confidence95: null };
    }
    let residualSquares = 0;
    for (let game = 0; game < rows.length; game += 2) {
        const pair = rows.slice(game, game + 2).map(({ artifact }) => artifact);
        const wins = pair.filter(({ score }) => score === 1).length;
        const pairDecisive = pair.filter(({ score }) => score !== 0.5).length;
        residualSquares += (wins - rate * pairDecisive) ** 2;
    }
    const clusters = rows.length / 2;
    const finiteSample = clusters / (clusters - 1);
    const standardError = Math.sqrt((finiteSample * residualSquares) / (decisive * decisive));
    return {
        candidateWins,
        opponentWins,
        draws,
        rate,
        confidence95: {
            low: Math.max(0, rate - Z95 * standardError),
            high: Math.min(1, rate + Z95 * standardError),
        },
    };
}

function armMetrics(
    arm: IPureRangedTerminalArm,
    rows: readonly IPureRangedTerminalValidatedGame[],
): IPureRangedTerminalArmMetrics {
    if (rows.length !== arm.games)
        throw new Error(`${arm.id}: expected ${arm.games} validated games; got ${rows.length}`);
    const decisive = decisiveStats(rows);
    const latencies = rows.flatMap(({ audit }) => audit.turnLatencyMs);
    return {
        armId: arm.id,
        weight: arm.weight,
        games: rows.length,
        pairClusters: rows.length / 2,
        candidateWins: decisive.candidateWins,
        opponentWins: decisive.opponentWins,
        draws: decisive.draws,
        scoreRate: rows.reduce((sum, { artifact }) => sum + artifact.score, 0) / rows.length,
        decisiveWinRate: decisive.rate,
        decisiveConfidence95: decisive.confidence95,
        drawOrArmageddonRate: rows.filter(({ artifact }) => artifact.drawOrArmageddon).length / rows.length,
        candidateRejections: rows.reduce((sum, { artifact }) => sum + (artifact.candidateRejections ?? 0), 0),
        opponentRejections: rows.reduce((sum, { artifact }) => sum + (artifact.opponentRejections ?? 0), 0),
        eligibleGames: rows.filter(({ audit }) => audit.terminalEligible).length,
        terminalLeaves: rows.reduce((sum, { audit }) => sum + audit.terminalLeaves, 0),
        terminalNonzeroLeaves: rows.reduce((sum, { audit }) => sum + audit.terminalNonzeroLeaves, 0),
        deadlineFallbacks: rows.reduce((sum, { audit }) => sum + audit.deadlineFallbacks, 0),
        circuitOpenGames: rows.filter(({ audit }) => audit.circuitOpened).length,
        circuitOpenGameRate: rows.filter(({ audit }) => audit.circuitOpened).length / rows.length,
        searchedTurns: rows.reduce((sum, { audit }) => sum + audit.searchedTurns, 0),
        searchedTurnLatencyP95Ms: quantile(latencies, 0.95),
    };
}

function evidenceArmRows(
    evidence: IPureRangedTerminalValidatedRawEvidence,
    arm: IPureRangedTerminalArm,
): IPureRangedTerminalValidatedGame[] {
    const rows = evidence.rowsByArm.get(arm.id);
    if (!rows || rows.length !== arm.games) throw new Error(`${arm.id}: validated evidence rows are missing`);
    return [...rows];
}

export interface IPureRangedTerminalCausalActionEvidence {
    candidateActionsSha256: string;
    terminalNonzeroLeaves: number;
    deadlineFallbacks: number;
    circuitOpened: boolean;
}

/** A hash change is causal evidence only on the same game where the leaf fired and timing stayed clean. */
export function isPureRangedTerminalCausalActionChange(
    control: IPureRangedTerminalCausalActionEvidence,
    candidate: IPureRangedTerminalCausalActionEvidence,
): boolean {
    return (
        candidate.candidateActionsSha256 !== control.candidateActionsSha256 &&
        candidate.terminalNonzeroLeaves > 0 &&
        control.deadlineFallbacks === 0 &&
        candidate.deadlineFallbacks === 0 &&
        !control.circuitOpened &&
        !candidate.circuitOpened
    );
}

export function assessPureRangedTerminalComparison(
    manifest: IPureRangedTerminalManifest,
    controlRows: readonly IPureRangedTerminalValidatedGame[],
    candidateRows: readonly IPureRangedTerminalValidatedGame[],
    controlArm: IPureRangedTerminalArm,
    candidateArm: IPureRangedTerminalArm,
): IPureRangedTerminalComparison {
    if (
        controlArm.weight !== 0 ||
        candidateArm.weight <= 0 ||
        controlRows.length !== candidateRows.length ||
        controlRows.length !== controlArm.games ||
        candidateRows.length !== candidateArm.games
    ) {
        throw new Error("Pure-ranged terminal comparison arm shape mismatch");
    }
    for (let game = 0; game < controlRows.length; game += 1) {
        if (controlRows[game].artifact.seed !== candidateRows[game].artifact.seed) {
            throw new Error(`Pure-ranged terminal comparison seed mismatch at game ${game}`);
        }
    }
    const controlScore = pairMeans(controlRows, ({ score }) => score);
    const candidateScore = pairMeans(candidateRows, ({ score }) => score);
    const controlAttrition = pairMeans(controlRows, ({ drawOrArmageddon }) => Number(drawOrArmageddon));
    const candidateAttrition = pairMeans(candidateRows, ({ drawOrArmageddon }) => Number(drawOrArmageddon));
    const pairedScoreGain = estimatePureRangedTerminalDelta(
        candidateScore.map((value, index) => value - controlScore[index]),
    );
    const pairedDrawOrArmageddonDelta = estimatePureRangedTerminalDelta(
        candidateAttrition.map((value, index) => value - controlAttrition[index]),
    );
    const candidateActionHashChangedGames = candidateRows.filter(
        ({ artifact }, index) => artifact.candidateActionsSha256 !== controlRows[index].artifact.candidateActionsSha256,
    ).length;
    const causalCandidateActionHashChangedGames = candidateRows.filter(({ artifact, audit }, index) => {
        const control = controlRows[index];
        return isPureRangedTerminalCausalActionChange(
            {
                candidateActionsSha256: control.artifact.candidateActionsSha256,
                terminalNonzeroLeaves: control.audit.terminalNonzeroLeaves,
                deadlineFallbacks: control.audit.deadlineFallbacks,
                circuitOpened: control.audit.circuitOpened,
            },
            {
                candidateActionsSha256: artifact.candidateActionsSha256,
                terminalNonzeroLeaves: audit.terminalNonzeroLeaves,
                deadlineFallbacks: audit.deadlineFallbacks,
                circuitOpened: audit.circuitOpened,
            },
        );
    }).length;
    const control = armMetrics(controlArm, controlRows);
    const candidate = armMetrics(candidateArm, candidateRows);
    const gate = manifest.scoutGates;
    const gates = {
        pairedScorePoint: pairedScoreGain.mean >= gate.pairedDrawHalfScoreGainMin,
        pairedScoreConfidence:
            (pairedScoreGain.confidence95?.low ?? Number.NEGATIVE_INFINITY) >
            gate.pairedDrawHalfScoreGain95LcbExclusiveMin,
        attritionPoint: pairedDrawOrArmageddonDelta.mean <= gate.drawOrArmageddonDeltaMax,
        attritionConfidence:
            (pairedDrawOrArmageddonDelta.confidence95?.high ?? Number.POSITIVE_INFINITY) <
            gate.drawOrArmageddonDelta95UcbExclusiveMax,
        zeroRejections:
            control.candidateRejections === gate.candidateAndOpponentRejections &&
            control.opponentRejections === gate.candidateAndOpponentRejections &&
            candidate.candidateRejections === gate.candidateAndOpponentRejections &&
            candidate.opponentRejections === gate.candidateAndOpponentRejections,
        eligibleGames: candidate.eligibleGames >= gate.eligibleGamesMin,
        eligibleLeaves: candidate.terminalLeaves >= gate.eligibleLeavesMin,
        nonzeroEligibleLeaves: candidate.terminalNonzeroLeaves >= gate.nonzeroEligibleLeavesMin,
        changedCandidateActionHash:
            causalCandidateActionHashChangedGames >= gate.causalCandidateActionHashChangedGamesMin,
        zeroDeadlineFallbacks:
            control.deadlineFallbacks === gate.deadlineFallbacks &&
            candidate.deadlineFallbacks === gate.deadlineFallbacks,
        circuitHeadroom:
            control.circuitOpenGameRate <= gate.circuitOpenGameRateMax &&
            candidate.circuitOpenGameRate <= gate.circuitOpenGameRateMax,
        latencyHeadroom:
            (control.searchedTurnLatencyP95Ms ?? Number.POSITIVE_INFINITY) <= gate.searchedTurnLatencyP95MsMax &&
            (candidate.searchedTurnLatencyP95Ms ?? Number.POSITIVE_INFINITY) <= gate.searchedTurnLatencyP95MsMax,
    };
    return {
        weight: candidateArm.weight,
        control,
        candidate,
        pairedScoreGain,
        pairedDrawOrArmageddonDelta,
        candidateActionHashChangedGames,
        causalCandidateActionHashChangedGames,
        gates,
        passed: Object.values(gates).every(Boolean),
    };
}

export function selectPureRangedTerminalWeight(comparisons: readonly IPureRangedTerminalComparison[]): number | null {
    const passing = comparisons.filter(({ passed }) => passed);
    if (!passing.length) return null;
    return [...passing].sort(
        (left, right) => right.pairedScoreGain.mean - left.pairedScoreGain.mean || left.weight - right.weight,
    )[0].weight;
}

function writeAnalysisMarker(
    path: string,
    run: IPureRangedTerminalRunManifest,
    reportPath: string,
    report: IPureRangedTerminalScoutReport | IPureRangedTerminalConfirmationReport,
): void {
    atomicWriteJson(path, {
        schemaVersion: 1,
        kind: `${report.kind}_analysis_complete`,
        completedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        report: relative(dirname(path), reportPath),
        reportSha256: sha256(readFileSync(reportPath)),
        gateLine: report.gateLine,
        verdict: report.verdict,
    });
}

function analyzeScout(
    runDir: string,
    arms: readonly IPureRangedTerminalArm[],
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
    evidence: IPureRangedTerminalValidatedRawEvidence,
): IPureRangedTerminalScoutReport {
    const controlArm = arms.find(({ weight }) => weight === 0)!;
    const control = evidenceArmRows(evidence, controlArm);
    const comparisons = arms
        .filter(({ weight }) => weight > 0)
        .map((arm) =>
            assessPureRangedTerminalComparison(manifest, control, evidenceArmRows(evidence, arm), controlArm, arm),
        );
    const selectedWeight = selectPureRangedTerminalWeight(comparisons);
    const verdict = selectedWeight === null ? "FAIL" : "PASS";
    const report: IPureRangedTerminalScoutReport = {
        schemaVersion: 1,
        kind: "v0.7_pure_ranged_terminal_scout",
        generatedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        protocolSha256: run.protocol.sha256,
        rawReportSha256: pureRangedTerminalRawReportSha256(runDir, "scout"),
        comparisons,
        selectedWeight,
        gateLine: verdict === "PASS" ? manifest.completion.scoutPassLine : "PURE RANGED TERMINAL SCOUT GATE: FAIL",
        verdict,
        authority: manifest.authority,
    };
    const reportPath = join(runDir, "scout-analysis.json");
    atomicWriteJson(reportPath, report);
    writeAnalysisMarker(analysisMarkerPath(manifest, runDir, "scout"), run, reportPath, report);
    return report;
}

function readScoutSelection(
    runDir: string,
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
): number {
    const markerPath = analysisMarkerPath(manifest, runDir, "scout");
    if (!existsSync(markerPath)) throw new Error("Confirmation requires a completed scout analysis marker");
    const marker = requireRecord(readJson(markerPath), markerPath);
    const reportPath = resolve(dirname(markerPath), String(marker.report));
    const report = requireRecord(readJson(reportPath), reportPath) as unknown as IPureRangedTerminalScoutReport;
    if (
        marker.runFingerprint !== run.runFingerprint ||
        marker.reportSha256 !== sha256(readFileSync(reportPath)) ||
        marker.gateLine !== manifest.completion.scoutPassLine ||
        marker.verdict !== "PASS" ||
        report.verdict !== "PASS" ||
        report.gateLine !== manifest.completion.scoutPassLine ||
        report.selectedWeight === null ||
        ![0.5, 1].includes(report.selectedWeight)
    ) {
        throw new Error("Confirmation requires a hash-valid literal scout PASS and selected weight");
    }
    return report.selectedWeight;
}

function identityChecks(
    arms: readonly IPureRangedTerminalArm[],
    selectedWeight: number,
    evidence: IPureRangedTerminalValidatedRawEvidence,
): IPureRangedTerminalIdentityCheck[] {
    return PURE_RANGED_TERMINAL_IDENTITY_TEMPLATES.map((template) => {
        const controlArm = arms.find(({ weight, template: candidate }) => weight === 0 && candidate === template)!;
        const selectedArm = arms.find(
            ({ weight, template: candidate }) => weight === selectedWeight && candidate === template,
        )!;
        const control = evidenceArmRows(evidence, controlArm);
        const selected = evidenceArmRows(evidence, selectedArm);
        return {
            template,
            games: selected.length,
            exactActions: selected.every(
                ({ artifact }, game) => artifact.actionsSha256 === control[game].artifact.actionsSha256,
            ),
            exactCandidateActions: selected.every(
                ({ artifact }, game) =>
                    artifact.candidateActionsSha256 === control[game].artifact.candidateActionsSha256,
            ),
            exactOutcomes: selected.every(
                ({ artifact }, game) =>
                    artifact.winner === control[game].artifact.winner &&
                    artifact.endReason === control[game].artifact.endReason &&
                    artifact.laps === control[game].artifact.laps,
            ),
            selectedEligibleGames: selected.filter(({ audit }) => audit.terminalEligible).length,
            selectedTerminalLeaves: selected.reduce((sum, { audit }) => sum + audit.terminalLeaves, 0),
        };
    });
}

function analyzeConfirmation(
    runDir: string,
    arms: readonly IPureRangedTerminalArm[],
    run: IPureRangedTerminalRunManifest,
    manifest: IPureRangedTerminalManifest,
    selectedWeight: number,
    evidence: IPureRangedTerminalValidatedRawEvidence,
): IPureRangedTerminalConfirmationReport {
    const controlArm = arms.find(({ weight, template }) => weight === 0 && template === PURE_RANGED_TERMINAL_TEMPLATE)!;
    const selectedArm = arms.find(
        ({ weight, template }) => weight === selectedWeight && template === PURE_RANGED_TERMINAL_TEMPLATE,
    )!;
    const comparison = assessPureRangedTerminalComparison(
        manifest,
        evidenceArmRows(evidence, controlArm),
        evidenceArmRows(evidence, selectedArm),
        controlArm,
        selectedArm,
    );
    const identities = identityChecks(arms, selectedWeight, evidence);
    const gate = manifest.confirmationGates;
    const gates = {
        repeatedScoutGate: comparison.passed,
        selectedDecisiveConfidence:
            (comparison.candidate.decisiveConfidence95?.low ?? Number.NEGATIVE_INFINITY) >
            gate.selectedDecisiveWinRate95LcbExclusiveMin,
        selectedAttritionCeiling: comparison.candidate.drawOrArmageddonRate <= gate.selectedDrawOrArmageddonRateMax,
        rangedActionChanged:
            comparison.causalCandidateActionHashChangedGames >= gate.eligibleRangedCausalActionHashChangedGamesMin,
        ineligibleActionIdentity: identities.every(
            ({ exactActions, exactCandidateActions, exactOutcomes }) =>
                exactActions && exactCandidateActions && exactOutcomes,
        ),
        ineligibleNeverEligible: identities.every(
            ({ selectedEligibleGames, selectedTerminalLeaves }) =>
                selectedEligibleGames === 0 && selectedTerminalLeaves === 0,
        ),
    };
    const verdict = Object.values(gates).every(Boolean) ? "PASS" : "FAIL";
    const report: IPureRangedTerminalConfirmationReport = {
        schemaVersion: 1,
        kind: "v0.7_pure_ranged_terminal_confirmation",
        generatedAt: new Date().toISOString(),
        runFingerprint: run.runFingerprint,
        protocolSha256: run.protocol.sha256,
        rawReportSha256: pureRangedTerminalRawReportSha256(runDir, "confirmation"),
        selectedWeight,
        comparison,
        identityChecks: identities,
        gates,
        gateLine:
            verdict === "PASS"
                ? manifest.completion.confirmationPassLine
                : "PURE RANGED TERMINAL CONFIRMATION GATE: FAIL",
        verdict,
        authority: manifest.authority,
    };
    const reportPath = join(runDir, "confirmation-analysis.json");
    atomicWriteJson(reportPath, report);
    writeAnalysisMarker(analysisMarkerPath(manifest, runDir, "confirmation"), run, reportPath, report);
    return report;
}

async function executePhase(
    runDir: string,
    phase: PureRangedTerminalPhase,
    concurrency: number,
    manifest: IPureRangedTerminalManifest,
    protocol: IPureRangedTerminalManifestProvenance,
): Promise<void> {
    const revision = readCleanMainRevision();
    const run = initializeRun(runDir, protocol, revision, manifest);
    const selectedWeight = phase === "confirmation" ? readScoutSelection(runDir, run, manifest) : null;
    const arms = phase === "scout" ? scoutArms(manifest) : confirmationArms(manifest, selectedWeight as number);
    if (!existsSync(markerPath(manifest, runDir, phase))) {
        for (const arm of arms) await executeArm(runDir, arm, run, manifest, concurrency);
        sealRawPhase(runDir, arms, run, manifest);
    }
    const evidence = validateRawMarker(runDir, phase, run, manifest, arms);
    const finalRevision = readCleanMainRevision();
    if (finalRevision.commit !== run.revision.commit) throw new Error("Source revision changed during trial phase");
    const report =
        phase === "scout"
            ? analyzeScout(runDir, arms, run, manifest, evidence)
            : analyzeConfirmation(runDir, arms, run, manifest, selectedWeight as number, evidence);
    console.log(report.gateLine);
    console.log(`Research only: ${manifest.authority.instruction}`);
}

async function main(): Promise<void> {
    const parsed = parseArgs({
        options: {
            phase: { type: "string" },
            out: { type: "string" },
            concurrency: { type: "string", default: String(Math.min(12, availableParallelism())) },
        },
        allowPositionals: false,
    });
    const phase = parsed.values.phase;
    if (phase !== "scout" && phase !== "confirmation") {
        throw new Error("--phase must be scout or confirmation");
    }
    if (!parsed.values.out) throw new Error("--out is required");
    const concurrency = Number(parsed.values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
        throw new Error("--concurrency must be an integer in [1,64]");
    }
    const { manifest, provenance } = readPureRangedTerminalManifest();
    await executePhase(resolve(parsed.values.out), phase, concurrency, manifest, provenance);
}

if (isMainThread && import.meta.main) {
    void main().catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exitCode = 1;
    });
}
