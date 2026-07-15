/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { arch, cpus, platform, release } from "node:os";

export interface IV07OvernightExecutionHost {
    platform: NodeJS.Platform;
    arch: string;
    osRelease: string;
    logicalCpuCount: number;
    cpuModel: string;
}

export interface IV07OvernightEvidence {
    profileId: string;
    circuit: {
        circuitOpenGameRate: number;
        turnLatencyMs: { p95: number | null };
    };
    summary: {
        circuitQualified: boolean;
        integrityQualified: boolean;
        integrityUtility: number;
        utilityDecisiveWinRate: number;
        minimumTemplateRate: number;
        maximumDrawOrArmageddonRate: number;
    };
}

export interface IV07OvernightLatencySummary {
    count: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
}

export interface IV07OvernightCircuitMetric {
    auditGames: number;
    turnRows: number;
    overBudgetTurns: number;
    overBudgetTurnRate: number;
    overBudgetGames: number;
    circuitOpenGames: number;
    circuitOpenGameRate: number;
    circuitSkipped: number;
    turnLatencyMs: IV07OvernightLatencySummary;
}

export interface IV07OvernightCircuitDiagnostics extends IV07OvernightCircuitMetric {
    byTemplate: Record<string, IV07OvernightCircuitMetric>;
}

interface IV07OvernightCircuitAccumulator {
    gameKeys: Set<string>;
    currentOverBudget: Set<string>;
    overBudgetGames: Set<string>;
    turnRows: number;
    overBudgetTurns: number;
    circuitOpenGames: number;
    circuitSkipped: number;
    turnLatencyMs: number[];
}

function circuitAccumulator(): IV07OvernightCircuitAccumulator {
    return {
        gameKeys: new Set(),
        currentOverBudget: new Set(),
        overBudgetGames: new Set(),
        turnRows: 0,
        overBudgetTurns: 0,
        circuitOpenGames: 0,
        circuitSkipped: 0,
        turnLatencyMs: [],
    };
}

function latencySummary(samples: readonly number[]): IV07OvernightLatencySummary {
    const sorted = [...samples].sort((left, right) => left - right);
    const quantile = (probability: number): number | null =>
        sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1)] : null;
    return {
        count: sorted.length,
        p50: quantile(0.5),
        p95: quantile(0.95),
        p99: quantile(0.99),
        max: quantile(1),
    };
}

function circuitMetric(accumulator: IV07OvernightCircuitAccumulator): IV07OvernightCircuitMetric {
    return {
        auditGames: accumulator.gameKeys.size,
        turnRows: accumulator.turnRows,
        overBudgetTurns: accumulator.overBudgetTurns,
        overBudgetTurnRate: accumulator.turnRows ? accumulator.overBudgetTurns / accumulator.turnRows : 0,
        overBudgetGames: accumulator.overBudgetGames.size,
        circuitOpenGames: accumulator.circuitOpenGames,
        circuitOpenGameRate: accumulator.gameKeys.size ? accumulator.circuitOpenGames / accumulator.gameKeys.size : 0,
        circuitSkipped: accumulator.circuitSkipped,
        turnLatencyMs: latencySummary(accumulator.turnLatencyMs),
    };
}

function auditRowKey(row: Record<string, unknown>): string {
    if (
        !Number.isSafeInteger(row.seed) ||
        (row.seed as number) < 0 ||
        (row.seed as number) > 0xffff_ffff ||
        typeof row.green !== "string" ||
        typeof row.red !== "string"
    ) {
        throw new Error("Invalid overnight audit game identity");
    }
    return `${String(row.seed)}|${String(row.green)}|${String(row.red)}`;
}

/** Reduce validated audit rows into aggregate and cohort-local circuit evidence. */
export function summarizeV07OvernightCircuitAuditRows(
    rows: readonly unknown[],
    expectedTemplateByGameKey: ReadonlyMap<string, string>,
    circuitBreakerMs: number,
): IV07OvernightCircuitDiagnostics {
    if (!Number.isFinite(circuitBreakerMs) || circuitBreakerMs <= 0) {
        throw new Error("Overnight circuit breaker must be positive");
    }
    if (!expectedTemplateByGameKey.size) throw new Error("Overnight circuit audit must expect at least one game");

    const aggregate = circuitAccumulator();
    const templateAccumulators = new Map<string, IV07OvernightCircuitAccumulator>();
    const turnRowsByGameKey = new Map<string, number>();
    for (const template of [...new Set(expectedTemplateByGameKey.values())].sort()) {
        templateAccumulators.set(template, circuitAccumulator());
    }

    for (const value of rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Invalid overnight audit row");
        }
        const row = value as Record<string, unknown>;
        if (row.t !== "turn" && row.t !== "game") {
            throw new Error(`Unsupported overnight audit row type: ${String(row.t)}`);
        }
        const key = auditRowKey(row);
        const template = expectedTemplateByGameKey.get(key);
        if (!template) throw new Error(`Unexpected overnight audit game key: ${key}`);
        const cohort = templateAccumulators.get(template);
        if (!cohort) throw new Error(`Missing overnight audit accumulator for template ${template}`);

        if (row.t === "turn") {
            if (aggregate.gameKeys.has(key)) throw new Error(`Overnight turn row follows its game summary: ${key}`);
            if (typeof row.ms !== "number" || !Number.isFinite(row.ms) || row.ms < 0) {
                throw new Error(`Invalid overnight turn latency for ${key}`);
            }
            turnRowsByGameKey.set(key, (turnRowsByGameKey.get(key) ?? 0) + 1);
            for (const accumulator of [aggregate, cohort]) {
                accumulator.turnRows += 1;
                accumulator.turnLatencyMs.push(row.ms);
                if (row.ms > circuitBreakerMs) {
                    accumulator.overBudgetTurns += 1;
                    accumulator.currentOverBudget.add(key);
                }
            }
        } else if (row.t === "game") {
            if (aggregate.gameKeys.has(key)) throw new Error(`Duplicate overnight audit game key: ${key}`);
            if (
                row.mode !== "search" ||
                !Number.isSafeInteger(row.searched) ||
                (row.searched as number) < 0 ||
                row.circuitBreakerMs !== circuitBreakerMs ||
                typeof row.circuitOpened !== "boolean" ||
                !Number.isSafeInteger(row.circuitSkipped) ||
                (row.circuitSkipped as number) < 0
            ) {
                throw new Error(`Invalid overnight circuit summary for ${key}`);
            }
            const observedTurns = turnRowsByGameKey.get(key) ?? 0;
            if (observedTurns !== row.searched) {
                throw new Error(
                    `Overnight searched-turn count mismatch for ${key}: observed ${observedTurns}, summary ${String(row.searched)}`,
                );
            }
            if (aggregate.currentOverBudget.has(key) && !row.circuitOpened) {
                throw new Error(`Overnight over-budget game did not open its circuit: ${key}`);
            }
            for (const accumulator of [aggregate, cohort]) {
                accumulator.gameKeys.add(key);
                if (accumulator.currentOverBudget.has(key)) accumulator.overBudgetGames.add(key);
                if (row.circuitOpened) accumulator.circuitOpenGames += 1;
                accumulator.circuitSkipped += row.circuitSkipped as number;
            }
        }
    }

    const missingKeys = [...expectedTemplateByGameKey.keys()].filter((key) => !aggregate.gameKeys.has(key));
    if (missingKeys.length) throw new Error(`Overnight audit has ${missingKeys.length} missing expected games`);

    return {
        ...circuitMetric(aggregate),
        byTemplate: Object.fromEntries(
            [...templateAccumulators.entries()].map(([template, accumulator]) => [
                template,
                circuitMetric(accumulator),
            ]),
        ),
    };
}

/** Every requested cohort must independently retain circuit headroom. */
export function qualifiesV07OvernightCircuit(
    circuit: IV07OvernightCircuitDiagnostics,
    maximumCircuitOpenGameRate: number,
    circuitBreakerMs: number,
): boolean {
    if (
        !Number.isFinite(maximumCircuitOpenGameRate) ||
        maximumCircuitOpenGameRate < 0 ||
        maximumCircuitOpenGameRate > 1 ||
        !Number.isFinite(circuitBreakerMs) ||
        circuitBreakerMs <= 0
    ) {
        throw new Error("Invalid overnight circuit qualification threshold");
    }
    const cohorts = Object.values(circuit.byTemplate);
    return (
        cohorts.length > 0 &&
        cohorts.every(
            (cohort) =>
                cohort.circuitOpenGameRate <= maximumCircuitOpenGameRate &&
                (cohort.turnLatencyMs.p95 ?? Infinity) <= circuitBreakerMs,
        )
    );
}

export function captureV07OvernightExecutionHost(): IV07OvernightExecutionHost {
    const processors = cpus();
    if (!processors.length) throw new Error("Overnight execution host has no visible logical CPUs");
    const models = [
        ...new Set(processors.map(({ model }) => model.trim().replace(/\s+/g, " ")).filter(Boolean)),
    ].sort();
    if (models.length !== 1) {
        throw new Error(
            `Overnight execution host must expose one stable CPU model; got ${models.join(", ") || "none"}`,
        );
    }
    return {
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        logicalCpuCount: processors.length,
        cpuModel: models[0],
    };
}

function latencyP95(evidence: IV07OvernightEvidence): number {
    return evidence.circuit.turnLatencyMs.p95 ?? Infinity;
}

function compareV07OvernightQualification(left: IV07OvernightEvidence, right: IV07OvernightEvidence): number {
    return (
        Number(right.summary.circuitQualified) - Number(left.summary.circuitQualified) ||
        Number(right.summary.integrityQualified) - Number(left.summary.integrityQualified)
    );
}

/** Hard qualification gates precede continuous research fitness; remaining ties are fully deterministic. */
export function compareV07OvernightEvidence(left: IV07OvernightEvidence, right: IV07OvernightEvidence): number {
    return (
        compareV07OvernightQualification(left, right) ||
        right.summary.integrityUtility - left.summary.integrityUtility ||
        right.summary.utilityDecisiveWinRate - left.summary.utilityDecisiveWinRate ||
        left.circuit.circuitOpenGameRate - right.circuit.circuitOpenGameRate ||
        right.summary.minimumTemplateRate - left.summary.minimumTemplateRate ||
        left.summary.maximumDrawOrArmageddonRate - right.summary.maximumDrawOrArmageddonRate ||
        latencyP95(left) - latencyP95(right) ||
        left.profileId.localeCompare(right.profileId)
    );
}

/** Choose a circuit representative within the best available qualification stratum. */
export function compareV07OvernightCircuitEvidence(left: IV07OvernightEvidence, right: IV07OvernightEvidence): number {
    return (
        compareV07OvernightQualification(left, right) ||
        left.circuit.circuitOpenGameRate - right.circuit.circuitOpenGameRate ||
        latencyP95(left) - latencyP95(right) ||
        compareV07OvernightEvidence(left, right)
    );
}

export function chooseV07OvernightDeepEvidence<T extends IV07OvernightEvidence>(
    evidence: readonly T[],
    keep: number,
): T[] {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("Overnight deep keep must be a positive integer");
    if (!evidence.length) return [];
    const ranked = [...evidence].sort(compareV07OvernightEvidence);
    const selected: T[] = [];
    const add = (entry: T | undefined): void => {
        if (entry && !selected.some((candidate) => candidate.profileId === entry.profileId)) selected.push(entry);
    };
    add(ranked[0]);
    add(
        [...evidence].sort(
            (left, right) =>
                compareV07OvernightQualification(left, right) ||
                right.summary.utilityDecisiveWinRate - left.summary.utilityDecisiveWinRate ||
                compareV07OvernightEvidence(left, right),
        )[0],
    );
    add([...evidence].sort(compareV07OvernightCircuitEvidence)[0]);
    for (const entry of ranked) add(entry);
    return selected.slice(0, keep);
}
