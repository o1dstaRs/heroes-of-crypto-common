/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Research-only evaluator for one v0.7 + RAWS configuration on the exact fixed
 * archetype templates. This deliberately does not call the official evidence
 * harness: behavior-changing environment flags are allowed and recorded here.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { AI_VERSIONS } from "../../ai";
import {
    V07_ARCHETYPES,
    aggregateV07ArchetypeCells,
    runV07ArchetypeCell,
    v07ArchetypeTemplate,
    type IV07ArchetypeCellReport,
    type IV07ArchetypeCellSpec,
    type V07Archetype,
    type V07ArchetypeTemplateName,
} from "../v0_7_archetype_battery";
import {
    V07_96H_BONFERRONI_8_ONE_SIDED_Z,
    V07_96H_TEMPLATES,
    deriveV0796hSeed,
    type IV0796hTemplateMetric,
    type V0796hTemplate,
} from "./v0_7_96h_core";

const PAIRED_SCENARIO_SEED_STEP = 0x9e3779b1;
const UINT32_MAX = 0xffffffff;

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_ENV_EXACT = new Set([
    "FIGHT_MELEE_ROSTERS",
    "LIVETWIN",
    "SIM_NO_ACTIONS",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);

export interface IV07SearchTrialOptions {
    candidate: string;
    opponent: string;
    templates: V0796hTemplate[];
    gamesPerTemplate: number;
    runId: string;
    panelId: string;
    /** Legacy CLI provenance; converted to deterministic run/panel ids during parsing. */
    baseSeed: number | null;
    /** Immutable manifest seeds. When present, these take precedence over run/panel derivation. */
    seeds: Partial<Record<V0796hTemplate, number>> | null;
    concurrency: number;
    outputPath: string;
    auditPath: string | null;
    auditTurns: boolean;
    checkpointDir: string | null;
    checkpointGames: number;
}

export interface IV07SearchTrialGitRevision {
    commit: string | null;
    commitDate: string | null;
    branch: string | null;
    remote: string | null;
    trackedClean: boolean | null;
    trackedDiffSha256: string | null;
    worktreeClean: boolean | null;
    statusPorcelainSha256: string | null;
    untrackedPaths: string[];
}

export interface IV07SearchTrialMetrics {
    cells: number;
    games: number;
    pairClusters: number;
    decisiveGames: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    decisiveWinRate: number;
    winPlusHalfDrawScore: number;
    standardErrorPp: number | null;
    confidence95: { low: number; high: number } | null;
    candidateRejections: number;
    opponentRejections: number;
    recordsMissingRejectionCounts: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
}

export interface IV07SearchTrialTemplateSummary {
    template: V07ArchetypeTemplateName;
    archetype: V07Archetype;
    seed: number;
    metrics: IV07SearchTrialMetrics;
}

export interface IV07SearchTrialArchetypeSummary {
    archetype: V07Archetype;
    templates: V07ArchetypeTemplateName[];
    metrics: IV07SearchTrialMetrics | null;
    equalTemplate: {
        decisiveWinRate: number;
        standardErrorPp: number | null;
    } | null;
}

export interface IQuantileSummary {
    count: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
}

export interface IV07SearchAuditSummary {
    enabled: boolean;
    path: string | null;
    validRows: number;
    invalidJsonLines: number;
    auditGames: number;
    searchedTurns: number;
    searchedTurnLatencyMs: IQuantileSummary;
    matchSearchLatencyMs: IQuantileSummary;
    overridesPerGame: IQuantileSummary;
    overridesTotal: number;
    overridesPerSearchedTurn: number | null;
    overridesToKind: Record<string, number>;
    modeCounts: Record<string, number>;
}

export interface IV07SearchTrialReport {
    schemaVersion: 1;
    status: "research_only";
    qualification: string;
    generatedAt: string;
    completedAt: string;
    elapsedSeconds: number;
    requested: Omit<IV07SearchTrialOptions, "outputPath">;
    behaviorEnvironment: Record<string, string>;
    provenance: {
        command: string[];
        cwd: string;
        revision: IV07SearchTrialGitRevision;
        revisionAtCompletion: IV07SearchTrialGitRevision;
        revisionStable: boolean;
    };
    completeEightTemplatePanel: boolean;
    cells: IV07ArchetypeCellReport[];
    templateMetrics: IV0796hTemplateMetric[];
    templates: IV07SearchTrialTemplateSummary[];
    archetypes: IV07SearchTrialArchetypeSummary[];
    allTemplates: IV07SearchTrialMetrics;
    limitingTemplate: { template: V07ArchetypeTemplateName; decisiveWinRate: number };
    limitingArchetype: { archetype: V07Archetype; decisiveWinRate: number };
    targetDiagnostics: {
        observed90AllArchetypes: boolean;
        certified90AllArchetypes: boolean;
        strict90AllTemplates: boolean;
        simultaneousArchetypeLowerBounds: Partial<Record<V07Archetype, number>>;
    };
    searchAudit: IV07SearchAuditSummary;
    releaseInstruction: "NO_BAKE_NO_COMMIT_NO_DEPLOY_FROM_THIS_REPORT";
}

export interface IV07SearchTrialReportContext {
    generatedAt: Date;
    completedAt: Date;
    behaviorEnvironment: Record<string, string>;
    command: string[];
    cwd: string;
    revision: IV07SearchTrialGitRevision;
    revisionAtCompletion: IV07SearchTrialGitRevision;
    searchAudit: IV07SearchAuditSummary;
}

export interface IV07SearchTrialDependencies {
    now: () => Date;
    revision: () => IV07SearchTrialGitRevision;
    runCell: (spec: IV07ArchetypeCellSpec, concurrency: number) => Promise<IV07ArchetypeCellReport>;
    command: () => string[];
    cwd: () => string;
}

const DEFAULT_DEPENDENCIES: IV07SearchTrialDependencies = {
    now: () => new Date(),
    revision: readV07SearchTrialGitRevision,
    runCell: runV07ArchetypeCell,
    command: () => [process.execPath, ...process.argv.slice(1)],
    cwd: () => process.cwd(),
};

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

function validateUint32(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
        throw new Error(`${name} must be a uint32; got ${value}`);
    }
}

/** Stable per-template base seed. Template order cannot affect the generated panel. */
export function deriveV07SearchTrialSeed(baseSeed: number, template: V07ArchetypeTemplateName): number {
    validateUint32("baseSeed", baseSeed);
    return deriveV0796hSeed(`base-seed:${baseSeed}`, "search-trial", template as V0796hTemplate);
}

export function deriveV07SearchTrialPanelSeed(runId: string, panelId: string, template: V0796hTemplate): number {
    if (!runId.trim() || !panelId.trim()) throw new Error("runId and panelId must not be empty");
    return deriveV0796hSeed(runId, panelId, template);
}

export function validateV07SearchTrialOptions(options: IV07SearchTrialOptions): void {
    if (!AI_VERSIONS.includes(options.candidate)) {
        throw new Error(`Unknown candidate ${options.candidate}; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    if (!AI_VERSIONS.includes(options.opponent)) {
        throw new Error(`Unknown opponent ${options.opponent}; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    if (options.candidate === options.opponent) throw new Error("Candidate and opponent must differ");
    if (!options.templates.length) throw new Error("At least one fixed archetype template is required");
    if (new Set(options.templates).size !== options.templates.length) throw new Error("Templates must be unique");
    for (const template of options.templates) {
        if (!V07_96H_TEMPLATES.some((entry) => entry.template === template)) {
            throw new Error(`Unknown fixed archetype template ${template}`);
        }
    }
    if (
        !Number.isSafeInteger(options.gamesPerTemplate) ||
        options.gamesPerTemplate < 2 ||
        options.gamesPerTemplate % 2
    ) {
        throw new Error("games must be an even integer >= 2 for paired side swaps");
    }
    if (!options.runId.trim() || !options.panelId.trim()) throw new Error("runId and panelId must not be empty");
    if (options.baseSeed !== null) validateUint32("baseSeed", options.baseSeed);
    if (options.seeds) {
        const keys = Object.keys(options.seeds);
        if (
            keys.length !== options.templates.length ||
            !options.templates.every((template) => Object.hasOwn(options.seeds!, template))
        ) {
            throw new Error("seedsJson must define exactly every requested template");
        }
        for (const [template, seed] of Object.entries(options.seeds)) {
            if (!V07_96H_TEMPLATES.some((entry) => entry.template === template)) {
                throw new Error(`seedsJson contains unknown template ${template}`);
            }
            validateUint32(`seedsJson.${template}`, seed!);
        }
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
    if (options.auditPath && resolve(options.auditPath) === resolve(options.outputPath)) {
        throw new Error("audit and output paths must differ");
    }
    if (options.checkpointDir && resolve(options.checkpointDir) === resolve(options.outputPath)) {
        throw new Error("checkpoint directory and output path must differ");
    }
    if (
        !Number.isSafeInteger(options.checkpointGames) ||
        options.checkpointGames < 2 ||
        options.checkpointGames % 2 !== 0
    ) {
        throw new Error("checkpoint-games must be an even integer >= 2");
    }
    if (options.auditTurns && options.checkpointDir) {
        throw new Error("audit-turns cannot be combined with checkpoint-dir because turn rows have no cell identity");
    }

    const derived = new Map<number, string>();
    for (const template of options.templates) {
        const seed =
            options.seeds?.[template] ?? deriveV07SearchTrialPanelSeed(options.runId, options.panelId, template);
        for (let pair = 0; pair < options.gamesPerTemplate / 2; pair += 1) {
            const scenarioSeed = (seed + Math.imul(pair, PAIRED_SCENARIO_SEED_STEP)) >>> 0;
            const previous = derived.get(scenarioSeed);
            if (previous) {
                throw new Error(`Derived scenario seed ${scenarioSeed} overlaps between ${previous} and ${template}`);
            }
            derived.set(scenarioSeed, template);
        }
    }
}

export function buildV07SearchTrialCellSpecs(options: IV07SearchTrialOptions): IV07ArchetypeCellSpec[] {
    validateV07SearchTrialOptions(options);
    return options.templates.map((template) => ({
        archetype: v07ArchetypeTemplate(template).archetype,
        template,
        candidate: options.candidate,
        opponent: options.opponent,
        baseSeed: options.seeds?.[template] ?? deriveV07SearchTrialPanelSeed(options.runId, options.panelId, template),
        games: options.gamesPerTemplate,
    }));
}

function metricsOf(cells: readonly IV07ArchetypeCellReport[]): IV07SearchTrialMetrics {
    const aggregate = aggregateV07ArchetypeCells(cells);
    const outcomes = aggregate.outcomes;
    const integrity = aggregate.integrity;
    return {
        cells: aggregate.cells,
        games: outcomes.games,
        pairClusters: outcomes.pairClusters,
        decisiveGames: outcomes.decisiveGames,
        candidateWins: outcomes.candidateWins,
        opponentWins: outcomes.opponentWins,
        draws: outcomes.draws,
        decisiveWinRate: outcomes.candidateWinRate,
        winPlusHalfDrawScore: outcomes.games ? (outcomes.candidateWins + outcomes.draws * 0.5) / outcomes.games : 0.5,
        standardErrorPp: outcomes.standardErrorPp,
        confidence95: outcomes.confidence95,
        candidateRejections: integrity.candidateRejections,
        opponentRejections: integrity.opponentRejections,
        recordsMissingRejectionCounts: integrity.recordsMissingRejectionCounts,
        drawOrArmageddon: integrity.drawOrArmageddon,
        drawOrArmageddonRate: integrity.drawOrArmageddonRate,
    };
}

function validateCells(options: IV07SearchTrialOptions, cells: readonly IV07ArchetypeCellReport[]): void {
    const expected = buildV07SearchTrialCellSpecs(options);
    if (cells.length !== expected.length) throw new Error(`Collected ${cells.length}/${expected.length} trial cells`);
    const byTemplate = new Map(cells.map((cell) => [cell.spec.template, cell]));
    if (byTemplate.size !== cells.length) throw new Error("Trial cells contain duplicate templates");
    for (const spec of expected) {
        const cell = byTemplate.get(spec.template);
        if (!cell || JSON.stringify(cell.spec) !== JSON.stringify(spec)) {
            throw new Error(`Missing or incompatible trial cell for ${spec.template}`);
        }
        if (cell.outcomes.games !== spec.games || cell.integrity.games !== spec.games) {
            throw new Error(
                `${spec.template} reports ${cell.outcomes.games}/${cell.integrity.games} games, expected ${spec.games}`,
            );
        }
    }
}

function revisionsEqual(left: IV07SearchTrialGitRevision, right: IV07SearchTrialGitRevision): boolean {
    return (
        left.commit === right.commit &&
        left.trackedClean === right.trackedClean &&
        left.trackedDiffSha256 === right.trackedDiffSha256 &&
        left.statusPorcelainSha256 === right.statusPorcelainSha256
    );
}

export function buildV07SearchTrialReport(
    options: IV07SearchTrialOptions,
    cells: readonly IV07ArchetypeCellReport[],
    context: IV07SearchTrialReportContext,
): IV07SearchTrialReport {
    validateCells(options, cells);
    const templates = options.templates.map((template): IV07SearchTrialTemplateSummary => {
        const cell = cells.find((candidate) => candidate.spec.template === template)!;
        return {
            template,
            archetype: cell.spec.archetype,
            seed: cell.spec.baseSeed,
            metrics: metricsOf([cell]),
        };
    });
    const archetypes = V07_ARCHETYPES.map((archetype): IV07SearchTrialArchetypeSummary => {
        const memberCells = cells.filter((cell) => cell.spec.archetype === archetype);
        const members = templates.filter((template) => template.archetype === archetype);
        const standardErrors = members.map(({ metrics }) => metrics.standardErrorPp);
        return {
            archetype,
            templates: members.map(({ template }) => template),
            metrics: memberCells.length ? metricsOf(memberCells) : null,
            equalTemplate: members.length
                ? {
                      decisiveWinRate:
                          members.reduce((sum, member) => sum + member.metrics.decisiveWinRate, 0) / members.length,
                      standardErrorPp: standardErrors.every((value) => value !== null)
                          ? Math.sqrt(standardErrors.reduce((sum, value) => sum + value! * value!, 0)) / members.length
                          : null,
                  }
                : null,
        };
    });
    const populatedArchetypes = archetypes.filter(
        (
            summary,
        ): summary is IV07SearchTrialArchetypeSummary & {
            metrics: IV07SearchTrialMetrics;
            equalTemplate: NonNullable<IV07SearchTrialArchetypeSummary["equalTemplate"]>;
        } => summary.metrics !== null && summary.equalTemplate !== null,
    );
    const limitingTemplate = templates.reduce((left, right) =>
        right.metrics.decisiveWinRate < left.metrics.decisiveWinRate ? right : left,
    );
    const limitingArchetype = populatedArchetypes.reduce((left, right) =>
        right.equalTemplate.decisiveWinRate < left.equalTemplate.decisiveWinRate ? right : left,
    );
    const completeEightTemplatePanel =
        options.templates.length === V07_96H_TEMPLATES.length &&
        V07_96H_TEMPLATES.every(({ template }) => options.templates.includes(template));
    const completeFourArchetypes = populatedArchetypes.length === V07_ARCHETYPES.length;
    // The core's eight-claim one-sided Bonferroni z is conservative for these four aggregate claims.
    const simultaneousArchetypeLowerBounds = Object.fromEntries(
        populatedArchetypes.map(({ archetype, equalTemplate }) => [
            archetype,
            Math.max(
                0,
                equalTemplate.decisiveWinRate -
                    V07_96H_BONFERRONI_8_ONE_SIDED_Z * ((equalTemplate.standardErrorPp ?? Infinity) / 100),
            ),
        ]),
    ) as Partial<Record<V07Archetype, number>>;
    return {
        schemaVersion: 1,
        status: "research_only",
        qualification:
            "Experimental fixed-template evaluation with behavior-changing environment permitted and recorded; " +
            "not official v0.7 evidence, acceptance, bake, or release authorization.",
        generatedAt: context.generatedAt.toISOString(),
        completedAt: context.completedAt.toISOString(),
        elapsedSeconds: Math.max(0, (context.completedAt.getTime() - context.generatedAt.getTime()) / 1000),
        requested: {
            candidate: options.candidate,
            opponent: options.opponent,
            templates: [...options.templates],
            gamesPerTemplate: options.gamesPerTemplate,
            runId: options.runId,
            panelId: options.panelId,
            baseSeed: options.baseSeed,
            seeds: options.seeds ? { ...options.seeds } : null,
            concurrency: options.concurrency,
            auditPath: options.auditPath,
            auditTurns: options.auditTurns,
            checkpointDir: options.checkpointDir,
            checkpointGames: options.checkpointGames,
        },
        behaviorEnvironment: { ...context.behaviorEnvironment },
        provenance: {
            command: [...context.command],
            cwd: context.cwd,
            revision: context.revision,
            revisionAtCompletion: context.revisionAtCompletion,
            revisionStable: revisionsEqual(context.revision, context.revisionAtCompletion),
        },
        completeEightTemplatePanel,
        cells: [...cells],
        templateMetrics: templates.map(({ template, archetype, metrics }) => ({
            template: template as V0796hTemplate,
            archetype,
            games: metrics.games,
            decisiveWinRate: metrics.decisiveWinRate,
            confidence95Low: metrics.confidence95?.low ?? 0,
            standardErrorPp: metrics.standardErrorPp ?? 50,
            scoreRate: metrics.winPlusHalfDrawScore,
            drawOrArmageddonRate: metrics.drawOrArmageddonRate,
            candidateRejections: metrics.candidateRejections,
            missingRejectionCounts: metrics.recordsMissingRejectionCounts,
        })),
        templates,
        archetypes,
        allTemplates: metricsOf(cells),
        limitingTemplate: {
            template: limitingTemplate.template,
            decisiveWinRate: limitingTemplate.metrics.decisiveWinRate,
        },
        limitingArchetype: {
            archetype: limitingArchetype.archetype,
            decisiveWinRate: limitingArchetype.equalTemplate.decisiveWinRate,
        },
        targetDiagnostics: {
            observed90AllArchetypes:
                completeEightTemplatePanel &&
                completeFourArchetypes &&
                populatedArchetypes.every((summary) => summary.equalTemplate.decisiveWinRate >= 0.9),
            certified90AllArchetypes:
                completeEightTemplatePanel &&
                completeFourArchetypes &&
                V07_ARCHETYPES.every((archetype) => (simultaneousArchetypeLowerBounds[archetype] ?? -Infinity) >= 0.9),
            strict90AllTemplates:
                completeEightTemplatePanel && templates.every((summary) => summary.metrics.decisiveWinRate >= 0.9),
            simultaneousArchetypeLowerBounds,
        },
        searchAudit: context.searchAudit,
        releaseInstruction: "NO_BAKE_NO_COMMIT_NO_DEPLOY_FROM_THIS_REPORT",
    };
}

function quantiles(values: readonly number[]): IQuantileSummary {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    const at = (probability: number): number | null =>
        sorted.length ? sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)] : null;
    return {
        count: sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted.at(-1) ?? null,
    };
}

function increment(record: Record<string, number>, key: string, amount: number = 1): void {
    record[key] = (record[key] ?? 0) + amount;
}

export function summarizeV07SearchAuditRows(
    rows: readonly unknown[],
    path: string | null = null,
    invalidJsonLines: number = 0,
): IV07SearchAuditSummary {
    const turnLatency: number[] = [];
    const matchLatency: number[] = [];
    const overridesPerGame: number[] = [];
    const overridesToKind: Record<string, number> = {};
    const modeCounts: Record<string, number> = {};
    let auditGames = 0;
    let searchedTurns = 0;
    let overridesTotal = 0;
    let validRows = 0;
    const seenGames = new Set<string>();
    for (const value of rows) {
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        if (typeof row.t !== "string") continue;
        validRows += 1;
        if ((row.t === "turn" || row.t === "q2") && typeof row.ms === "number" && Number.isFinite(row.ms)) {
            turnLatency.push(row.ms);
            continue;
        }
        if (row.t !== "game") continue;
        if (row.seed !== undefined && row.green !== undefined && row.red !== undefined && row.mode !== undefined) {
            const gameKey = `${String(row.seed)}|${String(row.green)}|${String(row.red)}|${String(row.mode)}`;
            if (seenGames.has(gameKey)) continue;
            seenGames.add(gameKey);
        }
        auditGames += 1;
        if (typeof row.mode === "string") increment(modeCounts, row.mode);
        if (typeof row.msTotal === "number" && Number.isFinite(row.msTotal)) matchLatency.push(row.msTotal);
        const searched = typeof row.searched === "number" && Number.isFinite(row.searched) ? row.searched : 0;
        const overrides = typeof row.overrides === "number" && Number.isFinite(row.overrides) ? row.overrides : 0;
        searchedTurns += searched;
        overridesTotal += overrides;
        overridesPerGame.push(overrides);
        if (row.overridesToKind && typeof row.overridesToKind === "object") {
            for (const [kind, count] of Object.entries(row.overridesToKind as Record<string, unknown>)) {
                if (typeof count === "number" && Number.isFinite(count)) increment(overridesToKind, kind, count);
            }
        }
    }
    return {
        enabled: path !== null,
        path,
        validRows,
        invalidJsonLines,
        auditGames,
        searchedTurns,
        searchedTurnLatencyMs: quantiles(turnLatency),
        matchSearchLatencyMs: quantiles(matchLatency),
        overridesPerGame: quantiles(overridesPerGame),
        overridesTotal,
        overridesPerSearchedTurn: searchedTurns ? overridesTotal / searchedTurns : null,
        overridesToKind,
        modeCounts,
    };
}

export function readV07SearchAudit(path: string | null): IV07SearchAuditSummary {
    if (!path || !existsSync(path)) return summarizeV07SearchAuditRows([], path);
    const rows: unknown[] = [];
    let invalidJsonLines = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            rows.push(JSON.parse(line));
        } catch {
            invalidJsonLines += 1;
        }
    }
    return summarizeV07SearchAuditRows(rows, path, invalidJsonLines);
}

export function snapshotV07SearchBehaviorEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return Object.fromEntries(
        Object.entries(source)
            .filter(
                ([key, value]) =>
                    value !== undefined &&
                    (BEHAVIOR_ENV_EXACT.has(key) || BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
            )
            .sort(([left], [right]) => left.localeCompare(right)) as [string, string][],
    );
}

function gitText(args: string[]): string | null {
    try {
        return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

export function readV07SearchTrialGitRevision(): IV07SearchTrialGitRevision {
    const commit = gitText(["rev-parse", "HEAD"]);
    if (!commit) {
        return {
            commit: null,
            commitDate: null,
            branch: null,
            remote: null,
            trackedClean: null,
            trackedDiffSha256: null,
            worktreeClean: null,
            statusPorcelainSha256: null,
            untrackedPaths: [],
        };
    }
    const diff = gitText(["diff", "--binary", "HEAD"]);
    const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
    const untracked = gitText(["ls-files", "--others", "--exclude-standard"]);
    const untrackedPaths = untracked ? untracked.split("\n").filter(Boolean) : [];
    const trackedClean = diff === "";
    return {
        commit,
        commitDate: gitText(["show", "-s", "--format=%cI", "HEAD"]),
        branch: gitText(["branch", "--show-current"]) || "HEAD",
        remote: gitText(["remote", "get-url", "origin"]),
        trackedClean,
        trackedDiffSha256: trackedClean || diff === null ? null : sha256(diff),
        worktreeClean: trackedClean && untrackedPaths.length === 0,
        statusPorcelainSha256: status === null ? null : sha256(status),
        untrackedPaths,
    };
}

export function writeV07SearchTrialReportAtomic(report: IV07SearchTrialReport, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temporary, outputPath);
}

function parseTemplates(raw: string): V0796hTemplate[] {
    if (raw.trim().toLowerCase() === "all") return V07_96H_TEMPLATES.map(({ template }) => template);
    return raw
        .split(",")
        .map((template) => template.trim())
        .filter(Boolean) as V0796hTemplate[];
}

function parseSeedsJson(raw: string | undefined): Partial<Record<V0796hTemplate, number>> | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("--seeds-json must be a JSON object of template to uint32 seed");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("--seeds-json must be a JSON object of template to uint32 seed");
    }
    return { ...(value as Partial<Record<V0796hTemplate, number>>) };
}

export function parseV07SearchTrialArgs(argv: string[], cwd: string = process.cwd()): IV07SearchTrialOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            candidate: { type: "string", default: "v0.7" },
            opponent: { type: "string", default: "v0.6" },
            templates: { type: "string", default: "all" },
            games: { type: "string", default: "200" },
            "run-id": { type: "string" },
            "panel-id": { type: "string" },
            "base-seed": { type: "string" },
            "seeds-json": { type: "string" },
            concurrency: {
                type: "string",
                default: String(Math.min(12, Math.max(1, availableParallelism()))),
            },
            output: { type: "string" },
            audit: { type: "string" },
            "audit-turns": { type: "boolean", default: false },
            "checkpoint-dir": { type: "string" },
            "checkpoint-games": { type: "string", default: "200" },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (parsed.values.help) {
        throw new Error(
            "usage: bun src/simulation/optimizer/v0_7_search_trial.ts " +
                "[--candidate=v0.7] [--opponent=v0.6] [--templates=all|a,b] [--games=200] " +
                "[--run-id=id --panel-id=id | --base-seed=1] [--concurrency=12] " +
                "[--seeds-json='{\"template\":123,...}'] [--output=report.json] [--audit=audit.jsonl] " +
                "[--audit-turns] [--checkpoint-dir=dir] [--checkpoint-games=200]",
        );
    }
    const hasFlag = (name: string): boolean =>
        argv.some((argument) => argument === name || argument.startsWith(`${name}=`));
    const hasRunId = hasFlag("--run-id");
    const hasPanelId = hasFlag("--panel-id");
    const hasBaseSeed = hasFlag("--base-seed");
    if (hasRunId !== hasPanelId) throw new Error("--run-id and --panel-id must be supplied together");
    if (hasRunId && hasBaseSeed) throw new Error("--base-seed cannot be combined with --run-id/--panel-id");
    const baseSeed = hasRunId ? null : Number(parsed.values["base-seed"] ?? "1");
    const runId = hasRunId ? parsed.values["run-id"]! : `base-seed:${baseSeed}`;
    const panelId = hasPanelId ? parsed.values["panel-id"]! : "search-trial";
    const outputKey = sha256(`${runId}|${panelId}`).slice(0, 16);
    const outputPath = resolve(
        cwd,
        parsed.values.output ?? join("sim-out", "v0_7_search_trial", `trial-${outputKey}.json`),
    );
    const options: IV07SearchTrialOptions = {
        candidate: parsed.values.candidate!,
        opponent: parsed.values.opponent!,
        templates: parseTemplates(parsed.values.templates!),
        gamesPerTemplate: Number(parsed.values.games),
        runId,
        panelId,
        baseSeed,
        seeds: parseSeedsJson(parsed.values["seeds-json"]),
        concurrency: Number(parsed.values.concurrency),
        outputPath,
        auditPath: parsed.values.audit ? resolve(cwd, parsed.values.audit) : null,
        auditTurns: parsed.values["audit-turns"],
        checkpointDir: parsed.values["checkpoint-dir"] ? resolve(cwd, parsed.values["checkpoint-dir"]) : null,
        checkpointGames: Number(parsed.values["checkpoint-games"]),
    };
    validateV07SearchTrialOptions(options);
    return options;
}

async function withAuditEnvironment<T>(
    auditPath: string | null,
    auditTurns: boolean,
    resume: boolean,
    run: () => Promise<T>,
): Promise<T> {
    if (!auditPath) return run();
    mkdirSync(dirname(auditPath), { recursive: true });
    if (!resume || !existsSync(auditPath)) writeFileSync(auditPath, "");
    const previousAudit = process.env.SEARCH_AUDIT;
    const previousTurns = process.env.SEARCH_AUDIT_TURNS;
    process.env.SEARCH_AUDIT = auditPath;
    if (auditTurns) process.env.SEARCH_AUDIT_TURNS = "1";
    else delete process.env.SEARCH_AUDIT_TURNS;
    try {
        return await run();
    } finally {
        if (previousAudit === undefined) delete process.env.SEARCH_AUDIT;
        else process.env.SEARCH_AUDIT = previousAudit;
        if (previousTurns === undefined) delete process.env.SEARCH_AUDIT_TURNS;
        else process.env.SEARCH_AUDIT_TURNS = previousTurns;
    }
}

async function mapLimit<T, R>(
    values: readonly T[],
    limit: number,
    callback: (value: T, index: number, slot: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let next = 0;
    const worker = async (slot: number): Promise<void> => {
        while (next < values.length) {
            const index = next++;
            results[index] = await callback(values[index], index, slot);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, (_, slot) => worker(slot)));
    return results;
}

/** Cap template fan-out so expensive ranged cells receive enough workers to finish inside the final reserve. */
export function v07SearchTrialParallelCells(totalWorkers: number, templateCount: number): number {
    if (!Number.isSafeInteger(totalWorkers) || totalWorkers < 1) throw new Error("totalWorkers must be positive");
    if (!Number.isSafeInteger(templateCount) || templateCount < 1) throw new Error("templateCount must be positive");
    return Math.min(templateCount, 4, totalWorkers === 1 ? 1 : Math.max(1, Math.floor(totalWorkers / 2)));
}

export function v07SearchTrialCellConcurrency(totalWorkers: number, templateCount: number, index: number): number {
    if (!Number.isSafeInteger(totalWorkers) || totalWorkers < 1) throw new Error("totalWorkers must be positive");
    if (!Number.isSafeInteger(templateCount) || templateCount < 1) throw new Error("templateCount must be positive");
    if (!Number.isSafeInteger(index) || index < 0 || index >= templateCount)
        throw new Error("template index is invalid");
    const parallelCells = v07SearchTrialParallelCells(totalWorkers, templateCount);
    // Every dynamic mapLimit slot gets the same fixed allocation. Any remainder stays idle, so a fast slot
    // can never pick up a larger task and temporarily exceed the process-wide worker budget.
    return Math.max(1, Math.floor(totalWorkers / parallelCells));
}

export interface IV07SearchTrialCellShard {
    id: string;
    gameStart: number;
    spec: IV07ArchetypeCellSpec;
}

/** Split only at pair boundaries; each shard's game zero remains the green/red side-swap pair start. */
export function buildV07SearchTrialCellShards(
    options: IV07SearchTrialOptions,
    spec: IV07ArchetypeCellSpec,
): IV07SearchTrialCellShard[] {
    const shardGames = options.checkpointDir ? Math.min(options.checkpointGames, spec.games) : spec.games;
    const shards: IV07SearchTrialCellShard[] = [];
    for (let gameStart = 0; gameStart < spec.games; gameStart += shardGames) {
        const games = Math.min(shardGames, spec.games - gameStart);
        const pairStart = gameStart / 2;
        const baseSeed = (spec.baseSeed + Math.imul(pairStart, PAIRED_SCENARIO_SEED_STEP)) >>> 0;
        shards.push({
            id: `${spec.template}:${gameStart}:${games}`,
            gameStart,
            spec: { ...spec, baseSeed, games },
        });
    }
    return shards;
}

interface IV07SearchTrialCellCheckpoint {
    schemaVersion: 2;
    runId: string;
    panelId: string;
    behaviorEnvironmentFingerprint: string;
    revisionCommit: string | null;
    specFingerprint: string;
    cellSha256: string;
    auditFragmentSha256: string | null;
    auditGames: number;
    cell: IV07ArchetypeCellReport;
}

interface IV07SearchTrialCellCheckpointBundle {
    cell: IV07ArchetypeCellReport;
    auditFragment: string | null;
}

function shardStem(shard: IV07SearchTrialCellShard): string {
    const start = String(shard.gameStart).padStart(6, "0");
    const end = String(shard.gameStart + shard.spec.games).padStart(6, "0");
    return `games-${start}-${end}`;
}

function checkpointPath(options: IV07SearchTrialOptions, shard: IV07SearchTrialCellShard): string | null {
    return options.checkpointDir ? join(options.checkpointDir, shard.spec.template, `${shardStem(shard)}.json`) : null;
}

function auditFragmentPath(options: IV07SearchTrialOptions, shard: IV07SearchTrialCellShard): string | null {
    return options.checkpointDir
        ? join(options.checkpointDir, shard.spec.template, `${shardStem(shard)}.audit.jsonl`)
        : null;
}

function writeAtomicText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temporary, content);
    const descriptor = openSync(temporary, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, path);
}

function auditAppliesTo(spec: IV07ArchetypeCellSpec): boolean {
    const mode =
        process.env.Q2_WAIT_ABLATION === "1"
            ? "ablation"
            : process.env.Q2_ORACLE === "1"
              ? "oracle"
              : process.env.V07_SEARCH === "1"
                ? "search"
                : "off";
    if (mode === "off") return false;
    const versions = new Set(
        (process.env.SEARCH_VERSIONS ?? (mode === "ablation" ? "v0.6" : "v0.6s"))
            .split(",")
            .map((version) => version.trim())
            .filter(Boolean),
    );
    return versions.has(spec.candidate) || versions.has(spec.opponent);
}

function auditGameKey(seed: unknown, green: unknown, red: unknown): string {
    return `${String(seed)}|${String(green)}|${String(red)}`;
}

function expectedAuditGames(spec: IV07ArchetypeCellSpec): { key: string; game: number }[] {
    if (!auditAppliesTo(spec)) return [];
    return Array.from({ length: spec.games }, (_, game) => {
        const seed = (spec.baseSeed + Math.floor(game / 2) * PAIRED_SCENARIO_SEED_STEP) >>> 0;
        const candidateIsGreen = game % 2 === 0;
        return {
            key: auditGameKey(
                seed,
                candidateIsGreen ? spec.candidate : spec.opponent,
                candidateIsGreen ? spec.opponent : spec.candidate,
            ),
            game,
        };
    });
}

function canonicalAuditFragment(
    content: string,
    spec: IV07ArchetypeCellSpec,
    rejectInvalidLines = false,
): { content: string; games: number } {
    const expected = expectedAuditGames(spec);
    if (!expected.length) return { content: "", games: 0 };
    const expectedKeys = new Set(expected.map(({ key }) => key));
    const rows = new Map<string, Record<string, unknown>>();
    let invalidLines = 0;
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            invalidLines += 1;
            continue;
        }
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        if (row.t !== "game") continue;
        const key = auditGameKey(row.seed, row.green, row.red);
        if (expectedKeys.has(key) && !rows.has(key)) rows.set(key, row);
    }
    const missing = expected.filter(({ key }) => !rows.has(key));
    if ((rejectInvalidLines && invalidLines) || missing.length) {
        throw new Error(
            `${spec.template} shard audit is incomplete: ${missing.length} missing games, ${invalidLines} invalid lines`,
        );
    }
    const lines = expected.map(({ key }) => JSON.stringify(rows.get(key)));
    return { content: `${lines.join("\n")}\n`, games: lines.length };
}

let quarantineSequence = 0;
function quarantineCheckpoint(options: IV07SearchTrialOptions, shard: IV07SearchTrialCellShard, reason: unknown): void {
    const suffix = `.invalid-${Date.now()}-${process.pid}-${quarantineSequence++}`;
    for (const path of [checkpointPath(options, shard), auditFragmentPath(options, shard)]) {
        if (path && existsSync(path)) renameSync(path, `${path}${suffix}`);
    }
    process.stderr.write(`[checkpoint reset] ${shard.id}: ${String(reason).slice(0, 300)}\n`);
}

function loadCellCheckpoint(
    options: IV07SearchTrialOptions,
    shard: IV07SearchTrialCellShard,
    behaviorEnvironmentFingerprint: string,
    revisionCommit: string | null,
): IV07SearchTrialCellCheckpointBundle | null {
    const path = checkpointPath(options, shard);
    if (!path || !existsSync(path)) return null;
    try {
        const checkpoint = JSON.parse(readFileSync(path, "utf8")) as IV07SearchTrialCellCheckpoint;
        const specFingerprint = sha256(canonicalJson(shard.spec));
        if (
            checkpoint.schemaVersion !== 2 ||
            checkpoint.runId !== options.runId ||
            checkpoint.panelId !== options.panelId ||
            checkpoint.behaviorEnvironmentFingerprint !== behaviorEnvironmentFingerprint ||
            checkpoint.revisionCommit !== revisionCommit ||
            checkpoint.specFingerprint !== specFingerprint ||
            canonicalJson(checkpoint.cell?.spec) !== canonicalJson(shard.spec) ||
            sha256(canonicalJson(checkpoint.cell)) !== checkpoint.cellSha256
        ) {
            throw new Error("checkpoint identity or cell hash mismatch");
        }
        let auditFragment: string | null = null;
        if (options.auditPath) {
            const fragmentPath = auditFragmentPath(options, shard)!;
            if (!existsSync(fragmentPath)) throw new Error("checkpoint audit fragment is missing");
            auditFragment = readFileSync(fragmentPath, "utf8");
            if (sha256(auditFragment) !== checkpoint.auditFragmentSha256) {
                throw new Error("checkpoint audit fragment hash mismatch");
            }
            const canonical = canonicalAuditFragment(auditFragment, shard.spec, true);
            if (canonical.content !== auditFragment || canonical.games !== checkpoint.auditGames) {
                throw new Error("checkpoint audit fragment content mismatch");
            }
        } else if (checkpoint.auditFragmentSha256 !== null || checkpoint.auditGames !== 0) {
            throw new Error("checkpoint unexpectedly contains an audit fragment");
        }
        return { cell: checkpoint.cell, auditFragment };
    } catch (error) {
        quarantineCheckpoint(options, shard, error);
        return null;
    }
}

function saveCellCheckpoint(
    options: IV07SearchTrialOptions,
    shard: IV07SearchTrialCellShard,
    behaviorEnvironmentFingerprint: string,
    revisionCommit: string | null,
    cell: IV07ArchetypeCellReport,
): IV07SearchTrialCellCheckpointBundle {
    const path = checkpointPath(options, shard);
    if (
        canonicalJson(cell.spec) !== canonicalJson(shard.spec) ||
        cell.outcomes.games !== shard.spec.games ||
        cell.integrity.games !== shard.spec.games
    ) {
        throw new Error(`Evaluator returned an incompatible shard cell for ${shard.id}`);
    }
    let auditFragment: string | null = null;
    let auditGames = 0;
    if (options.auditPath) {
        const aggregateAudit = existsSync(options.auditPath) ? readFileSync(options.auditPath, "utf8") : "";
        const canonical = canonicalAuditFragment(aggregateAudit, shard.spec);
        auditFragment = canonical.content;
        auditGames = canonical.games;
    }
    if (!path) return { cell, auditFragment };
    const fragmentPath = auditFragmentPath(options, shard);
    if (fragmentPath && auditFragment !== null) writeAtomicText(fragmentPath, auditFragment);
    const checkpoint: IV07SearchTrialCellCheckpoint = {
        schemaVersion: 2,
        runId: options.runId,
        panelId: options.panelId,
        behaviorEnvironmentFingerprint,
        revisionCommit,
        specFingerprint: sha256(canonicalJson(shard.spec)),
        cellSha256: sha256(canonicalJson(cell)),
        auditFragmentSha256: auditFragment === null ? null : sha256(auditFragment),
        auditGames,
        cell,
    };
    writeAtomicText(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return { cell, auditFragment };
}

function rebuildAggregateAudit(
    options: IV07SearchTrialOptions,
    shards: readonly IV07SearchTrialCellShard[],
    checkpoints: ReadonlyMap<string, IV07SearchTrialCellCheckpointBundle>,
): void {
    if (!options.auditPath || !options.checkpointDir) return;
    const content = shards.map((shard) => checkpoints.get(shard.id)?.auditFragment ?? "").join("");
    writeAtomicText(options.auditPath, content);
}

function aggregateShardCells(
    spec: IV07ArchetypeCellSpec,
    shards: readonly IV07ArchetypeCellReport[],
): IV07ArchetypeCellReport {
    const aggregate = aggregateV07ArchetypeCells(shards);
    return {
        spec,
        outcomes: aggregate.outcomes,
        integrity: aggregate.integrity,
        telemetry: aggregate.telemetry,
    };
}

export async function runV07SearchTrial(
    options: IV07SearchTrialOptions,
    dependencies: Partial<IV07SearchTrialDependencies> = {},
): Promise<IV07SearchTrialReport> {
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const specs = buildV07SearchTrialCellSpecs(options);
    const generatedAt = deps.now();
    const revision = deps.revision();
    let behaviorEnvironment: Record<string, string> = {};
    const cells = await withAuditEnvironment(
        options.auditPath,
        options.auditTurns,
        !!options.checkpointDir,
        async () => {
            behaviorEnvironment = snapshotV07SearchBehaviorEnvironment();
            const behaviorEnvironmentFingerprint = sha256(canonicalJson(behaviorEnvironment));
            const shardsByTemplate = new Map(
                specs.map((spec) => [spec.template, buildV07SearchTrialCellShards(options, spec)]),
            );
            const allShards = specs.flatMap((spec) => shardsByTemplate.get(spec.template)!);
            const checkpoints = new Map<string, IV07SearchTrialCellCheckpointBundle>();
            for (const shard of allShards) {
                const checkpoint = loadCellCheckpoint(options, shard, behaviorEnvironmentFingerprint, revision.commit);
                if (checkpoint) checkpoints.set(shard.id, checkpoint);
            }
            // The aggregate is derived state. Rebuilding it discards partial writes from an interrupted shard
            // and guarantees that every retained audit row belongs to an atomically checkpointed result.
            rebuildAggregateAudit(options, allShards, checkpoints);
            let completed = 0;
            const parallelCells = v07SearchTrialParallelCells(options.concurrency, specs.length);
            const cells = await mapLimit(specs, parallelCells, async (spec, index) => {
                const cellWorkers = v07SearchTrialCellConcurrency(options.concurrency, specs.length, index);
                const shards = shardsByTemplate.get(spec.template)!;
                const shardCells: IV07ArchetypeCellReport[] = [];
                let resumedShards = 0;
                for (const [shardIndex, shard] of shards.entries()) {
                    let checkpoint = checkpoints.get(shard.id);
                    const resumed = checkpoint !== undefined;
                    if (resumed) {
                        resumedShards += 1;
                    } else {
                        const cell = await deps.runCell(shard.spec, Math.min(cellWorkers, shard.spec.games));
                        checkpoint = saveCellCheckpoint(
                            options,
                            shard,
                            behaviorEnvironmentFingerprint,
                            revision.commit,
                            cell,
                        );
                        checkpoints.set(shard.id, checkpoint);
                    }
                    shardCells.push(checkpoint.cell);
                    process.stdout.write(
                        `[${spec.template}] shard=${shardIndex + 1}/${shards.length}` +
                            `${resumed ? " [resumed]" : ""} ` +
                            `games=${shard.spec.games} workers=${cellWorkers}\n`,
                    );
                }
                const cell = aggregateShardCells(spec, shardCells);
                completed += 1;
                process.stdout.write(
                    `[${completed}/${specs.length}]${resumedShards === shards.length ? " [resumed]" : ""} ${spec.template} ` +
                        `seed=${spec.baseSeed} workers=${cellWorkers} ` +
                        `${(cell.outcomes.candidateWinRate * 100).toFixed(2)}%\n`,
                );
                return cell;
            });
            rebuildAggregateAudit(options, allShards, checkpoints);
            return cells;
        },
    );
    const revisionAtCompletion = deps.revision();
    const completedAt = deps.now();
    return buildV07SearchTrialReport(options, cells, {
        generatedAt,
        completedAt,
        behaviorEnvironment,
        command: deps.command(),
        cwd: deps.cwd(),
        revision,
        revisionAtCompletion,
        searchAudit: readV07SearchAudit(options.auditPath),
    });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const options = parseV07SearchTrialArgs(argv);
    const report = await runV07SearchTrial(options);
    writeV07SearchTrialReportAtomic(report, options.outputPath);
    console.log(`status=${report.status}; officialEvidence=false`);
    console.log(`summary -> ${options.outputPath}`);
    if (options.auditPath) console.log(`audit -> ${options.auditPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
