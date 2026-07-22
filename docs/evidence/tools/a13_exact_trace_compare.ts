/* Compare two variant reports from a13_exact_trace_runner.ts and fail closed. */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface IBoundaryRow {
    index: number;
    kind: string;
    sha256: string;
    eventsSha256: string;
    detailSha256: string;
    stateSha256: string;
    eventCount: number;
    eventTypes: string[];
}

interface IRunRecord {
    seed: number;
    traceSha256: string;
    resultSha256: string;
    boundaryCount: number;
    eventCount: number;
    eventTypes: Record<string, number>;
    boundaryKinds: Record<string, number>;
    boundaries: IBoundaryRow[];
    result: Record<string, string | number>;
    execution: {
        recoveryActions: number;
        recoveryBySource: Record<string, number>;
        incompleteBoundaryActions: number;
    };
    search: {
        circuitOpen: boolean;
        circuitSkipped: number;
        deadlineFallbacks: number;
        decisions: number;
        searched: number;
        overrides: number;
        illegalIncumbent: number;
        singleCandidate: number;
    };
}

interface IVariantReport {
    schema: string;
    generatedAt: string;
    archive: string;
    variant: string;
    mode: string;
    matchConfig: Record<string, unknown>;
    source: Record<string, string | null>;
    repeat?: { first: IRunRecord; second: IRunRecord };
    records: IRunRecord[];
}

interface IMismatch {
    seed?: number;
    boundaryIndex?: number;
    field: string;
    baseline: unknown;
    candidate: unknown;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function parseArgs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const arg of process.argv.slice(2)) {
        if (!arg.startsWith("--") || !arg.includes("=")) {
            throw new Error(`invalid argument ${arg}; expected --name=value`);
        }
        const separator = arg.indexOf("=");
        out[arg.slice(2, separator)] = arg.slice(separator + 1);
    }
    return out;
}

function readReport(path: string): IVariantReport {
    return JSON.parse(readFileSync(path, "utf8")) as IVariantReport;
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function firstRunMismatch(baseline: IRunRecord, candidate: IRunRecord): IMismatch | undefined {
    for (const field of ["seed", "traceSha256", "resultSha256", "boundaryCount", "eventCount"] as const) {
        if (baseline[field] !== candidate[field]) {
            return { seed: baseline.seed, field, baseline: baseline[field], candidate: candidate[field] };
        }
    }
    if (!sameJson(baseline.eventTypes, candidate.eventTypes)) {
        return {
            seed: baseline.seed,
            field: "eventTypes",
            baseline: baseline.eventTypes,
            candidate: candidate.eventTypes,
        };
    }
    if (!sameJson(baseline.boundaryKinds, candidate.boundaryKinds)) {
        return {
            seed: baseline.seed,
            field: "boundaryKinds",
            baseline: baseline.boundaryKinds,
            candidate: candidate.boundaryKinds,
        };
    }
    const count = Math.max(baseline.boundaries.length, candidate.boundaries.length);
    for (let index = 0; index < count; index += 1) {
        const left = baseline.boundaries[index];
        const right = candidate.boundaries[index];
        if (!left || !right) {
            return {
                seed: baseline.seed,
                boundaryIndex: index,
                field: "boundaryPresence",
                baseline: left,
                candidate: right,
            };
        }
        for (const field of [
            "index",
            "kind",
            "sha256",
            "eventsSha256",
            "detailSha256",
            "stateSha256",
            "eventCount",
        ] as const) {
            if (left[field] !== right[field]) {
                return {
                    seed: baseline.seed,
                    boundaryIndex: index,
                    field,
                    baseline: left[field],
                    candidate: right[field],
                };
            }
        }
        if (!sameJson(left.eventTypes, right.eventTypes)) {
            return {
                seed: baseline.seed,
                boundaryIndex: index,
                field: "eventTypes",
                baseline: left.eventTypes,
                candidate: right.eventTypes,
            };
        }
    }
    return undefined;
}

function deterministicRepeat(report: IVariantReport): {
    checked: boolean;
    status: "not_run" | "passed" | "failed";
    passed: boolean | null;
    mismatch?: IMismatch;
} {
    if (!report.repeat) return { checked: false, status: "not_run", passed: null };
    const mismatch = firstRunMismatch(report.repeat.first, report.repeat.second);
    return mismatch
        ? { checked: true, status: "failed", passed: false, mismatch }
        : { checked: true, status: "passed", passed: true };
}

function sum(records: readonly IRunRecord[], select: (record: IRunRecord) => number): number {
    return records.reduce((total, record) => total + select(record), 0);
}

function summarize(records: readonly IRunRecord[]) {
    const orderedTraceHash = createHash("sha256");
    const orderedResultHash = createHash("sha256");
    const eventTypes: Record<string, number> = {};
    const recoveryBySource: Record<string, number> = {};
    for (const record of records) {
        orderedTraceHash.update(`${record.seed}:${record.traceSha256}\n`);
        orderedResultHash.update(`${record.seed}:${record.resultSha256}\n`);
        for (const [type, amount] of Object.entries(record.eventTypes)) {
            eventTypes[type] = (eventTypes[type] ?? 0) + amount;
        }
        for (const [source, amount] of Object.entries(record.execution.recoveryBySource)) {
            recoveryBySource[source] = (recoveryBySource[source] ?? 0) + amount;
        }
    }
    return {
        matches: records.length,
        orderedTraceSha256: orderedTraceHash.digest("hex"),
        orderedResultSha256: orderedResultHash.digest("hex"),
        boundaries: sum(records, (record) => record.boundaryCount),
        events: sum(records, (record) => record.eventCount),
        actions: sum(records, (record) => Number(record.result.totalActions)),
        rejectedGreen: sum(records, (record) => Number(record.result.rejectedGreen)),
        rejectedRed: sum(records, (record) => Number(record.result.rejectedRed)),
        rejectedActionRecords: sum(records, (record) => Number(record.result.rejectedActionRecords)),
        incompleteBoundaryActions: sum(records, (record) => record.execution.incompleteBoundaryActions),
        recoveryActions: sum(records, (record) => record.execution.recoveryActions),
        recoveryBySource,
        search: {
            decisions: sum(records, (record) => record.search.decisions),
            searched: sum(records, (record) => record.search.searched),
            overrides: sum(records, (record) => record.search.overrides),
            illegalIncumbent: sum(records, (record) => record.search.illegalIncumbent),
            singleCandidate: sum(records, (record) => record.search.singleCandidate),
            deadlineFallbacks: sum(records, (record) => record.search.deadlineFallbacks),
            circuitSkipped: sum(records, (record) => record.search.circuitSkipped),
            matchesOpeningCircuit: records.filter((record) => record.search.circuitOpen).length,
        },
        eventTypes,
    };
}

function main(): void {
    const args = parseArgs();
    if (!args.baseline || !args.candidate || !args.output || !args.overlay) {
        throw new Error("--baseline, --candidate, --overlay, and --output are required");
    }
    const baselinePath = resolve(args.baseline);
    const candidatePath = resolve(args.candidate);
    const outputPath = resolve(args.output);
    const overlayPath = resolve(args.overlay);
    const baseline = readReport(baselinePath);
    const candidate = readReport(candidatePath);
    const failures: IMismatch[] = [];

    if (baseline.schema !== "hoc.a13_exact_boundary_trace.variant.v1" || candidate.schema !== baseline.schema) {
        failures.push({ field: "schema", baseline: baseline.schema, candidate: candidate.schema });
    }
    if (baseline.mode !== candidate.mode) {
        failures.push({ field: "mode", baseline: baseline.mode, candidate: candidate.mode });
    }
    if (!sameJson(baseline.matchConfig, candidate.matchConfig)) {
        failures.push({ field: "matchConfig", baseline: baseline.matchConfig, candidate: candidate.matchConfig });
    }
    for (const field of ["instrumentedBattleEngineSha256", "exactTraceHooksSha256", "instrumentedA13SearchSha256"]) {
        if (baseline.source[field] !== candidate.source[field]) {
            failures.push({
                field: `source.${field}`,
                baseline: baseline.source[field],
                candidate: candidate.source[field],
            });
        }
    }

    const baselineRepeat = deterministicRepeat(baseline);
    const candidateRepeat = deterministicRepeat(candidate);
    if (baseline.repeat && !baselineRepeat.passed) {
        failures.push({ field: "baselineRepeat", baseline: baselineRepeat.mismatch, candidate: "repeat mismatch" });
    }
    if (candidate.repeat && !candidateRepeat.passed) {
        failures.push({ field: "candidateRepeat", baseline: candidateRepeat.mismatch, candidate: "repeat mismatch" });
    }

    const candidateBySeed = new Map(candidate.records.map((record) => [record.seed, record]));
    const perSeed = baseline.records.map((left) => {
        const right = candidateBySeed.get(left.seed);
        const mismatch = right
            ? firstRunMismatch(left, right)
            : ({
                  seed: left.seed,
                  field: "candidateSeedPresence",
                  baseline: true,
                  candidate: false,
              } satisfies IMismatch);
        if (mismatch) failures.push(mismatch);
        return {
            seed: left.seed,
            exact: mismatch === undefined,
            traceSha256: left.traceSha256,
            resultSha256: left.resultSha256,
            boundaries: left.boundaryCount,
            events: left.eventCount,
            actions: left.result.totalActions,
            winner: left.result.winner,
            endReason: left.result.endReason,
            laps: left.result.laps,
            rejectedGreen: left.result.rejectedGreen,
            rejectedRed: left.result.rejectedRed,
            recoveryActions: left.execution.recoveryActions,
            search: left.search,
            ...(mismatch ? { mismatch } : {}),
        };
    });
    for (const right of candidate.records) {
        if (!baseline.records.some((left) => left.seed === right.seed)) {
            failures.push({ seed: right.seed, field: "baselineSeedPresence", baseline: false, candidate: true });
        }
    }

    const baselineSummary = summarize(baseline.records);
    const candidateSummary = summarize(candidate.records);
    const toolDirectory = resolve("docs/evidence/tools");
    const runnerPath = resolve(toolDirectory, "a13_exact_trace_runner.ts");
    const comparatorPath = resolve(toolDirectory, "a13_exact_trace_compare.ts");
    const repeatArgument = baseline.repeat ? " --repeat-seed=1" : "";
    const report = {
        schema: "hoc.a13_exact_boundary_trace.comparison.v1",
        generatedAt: new Date().toISOString(),
        mode: baseline.mode,
        inputs: {
            baseline: { path: baselinePath, sha256: sha256(readFileSync(baselinePath)), archive: baseline.archive },
            candidate: { path: candidatePath, sha256: sha256(readFileSync(candidatePath)), archive: candidate.archive },
        },
        productionSources: {
            baselineAttackHandlerSha256: baseline.source.attackHandlerSha256,
            candidateAttackHandlerSha256: candidate.source.attackHandlerSha256,
            baselineRayTraversalSha256: baseline.source.rayTraversalSha256,
            candidateRayTraversalSha256: candidate.source.rayTraversalSha256,
        },
        instrumentation: {
            battleEngineSha256: baseline.source.instrumentedBattleEngineSha256,
            exactTraceHooksSha256: baseline.source.exactTraceHooksSha256,
            a13SearchSha256: baseline.source.instrumentedA13SearchSha256,
            overlayPatch: { path: overlayPath, sha256: sha256(readFileSync(overlayPath)) },
            identicalAcrossArchives:
                baseline.source.instrumentedBattleEngineSha256 === candidate.source.instrumentedBattleEngineSha256 &&
                baseline.source.exactTraceHooksSha256 === candidate.source.exactTraceHooksSha256 &&
                baseline.source.instrumentedA13SearchSha256 === candidate.source.instrumentedA13SearchSha256,
        },
        reproduction: {
            baseCommit: "7950492f1e5ca81d5e071c377bb2956c8c01832a",
            baseBattleEngineSha256: "106d11abf1df06547f68cc921ad8d98ce1bf573c3a0886e0b97cf9dfbe0a3139",
            baseA13SearchSha256: "6dd6d7a23beac7b26f10b1a93116aff2b0436f520d9860242b7b6cddc298f59a",
            tools: {
                overlay: { path: overlayPath, sha256: sha256(readFileSync(overlayPath)) },
                runner: { path: runnerPath, sha256: sha256(readFileSync(runnerPath)) },
                comparator: { path: comparatorPath, sha256: sha256(readFileSync(comparatorPath)) },
            },
            commands: [
                "patch -p1 < docs/evidence/tools/a13_exact_trace_overlay.patch",
                `bun docs/evidence/tools/a13_exact_trace_runner.ts --archive=<baseline> --variant=baseline --mode=${baseline.mode} --seeds=1-20${repeatArgument} --output=/tmp/a13-trace-baseline-${baseline.mode}.json`,
                `bun docs/evidence/tools/a13_exact_trace_runner.ts --archive=<candidate> --variant=candidate --mode=${baseline.mode} --seeds=1-20${repeatArgument} --output=/tmp/a13-trace-candidate-${baseline.mode}.json`,
                `bun docs/evidence/tools/a13_exact_trace_compare.ts --baseline=/tmp/a13-trace-baseline-${baseline.mode}.json --candidate=/tmp/a13-trace-candidate-${baseline.mode}.json --overlay=docs/evidence/tools/a13_exact_trace_overlay.patch --output=<summary.json>`,
            ],
        },
        repeatDeterminism: { baseline: baselineRepeat, candidate: candidateRepeat },
        parity: {
            passed: failures.length === 0,
            seedsCompared: perSeed.length,
            exactSeeds: perSeed.filter((row) => row.exact).length,
            boundaryRecordsCompared: baselineSummary.boundaries,
            eventRecordsCompared: baselineSummary.events,
            firstMismatch: failures[0] ?? null,
            mismatchCount: failures.length,
        },
        aggregate: { baseline: baselineSummary, candidate: candidateSummary },
        perSeed,
        traceContract: {
            boundaries: [
                "armies_created",
                "placement_action (side-tagged, including rejected attempts)",
                "setup_complete",
                "start_fight",
                "turn_advance",
                "force_stalled_lap",
                "dead_active_abandoned",
                "pre_decision",
                "post_incumbent",
                "post_search",
                "strategy_action",
                "recovery_action",
                "end_turn",
                "turn_complete",
                "match_result",
                "search_match_end",
            ],
            state: [
                "snapshotBattle units/grid/fight/holder/AI target memory",
                "damage statistics",
                "current active unit",
                "authoritative combat RNG draw cursor",
                "stable SearchDriver mutable state and counters",
                "outer loop action length/cap, finished/endReason, attrition, rejections, summon sequence",
            ],
            excludedAsNonsemanticWallClock: [
                "FightProperties.id",
                "FightProperties.currentTurnStart",
                "FightProperties.currentTurnEnd",
                "FightProperties.currentLapTotalTimePerTeam",
                "SearchDriver.counters.msTotal",
            ],
        },
        limitations: [
            "The trace covers the authoritative match and pre/post-search restored states; speculative rollout event batches are not separately persisted.",
            "The roster panel is deterministic v0.8 mirror self-play on NORMAL with historical level-table amounts; ranked setup/map coverage is a separate gate.",
            "Bounded mode contains real wall-clock deadline/circuit decisions and therefore may be host-load sensitive; unbounded mode is the semantic equivalence proof.",
        ],
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 4)}\n`);
    console.log(JSON.stringify({ output: outputPath, mode: baseline.mode, ...report.parity }));
    if (failures.length) process.exitCode = 1;
}

main();
