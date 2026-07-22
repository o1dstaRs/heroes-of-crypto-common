/*
 * External runner for the temporary exact-trace patch. It imports one immutable
 * archive by absolute path, hashes every canonical boundary immediately, and
 * writes only hashes/metadata (never the large cloned battle states).
 *
 * Example:
 *   bun docs/evidence/tools/a13_exact_trace_runner.ts \
 *     --archive=/tmp/hoc-ray-f02e-baseline.E0bh28 --variant=baseline \
 *     --mode=unbounded --seeds=1-20 --repeat-seed=1 --output=/tmp/baseline.json
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    result: {
        winner: string;
        endReason: string;
        laps: number;
        totalActions: number;
        rejectedGreen: number;
        rejectedRed: number;
        rejectedActionRecords: number;
    };
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

function parseSeeds(value: string): number[] {
    const seeds: number[] = [];
    for (const token of value.split(",")) {
        const range = /^(\d+)-(\d+)$/.exec(token.trim());
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) {
                throw new Error(`invalid seed range ${token}`);
            }
            for (let seed = first; seed <= last; seed += 1) seeds.push(seed);
            continue;
        }
        const seed = Number(token);
        if (!Number.isSafeInteger(seed)) throw new Error(`invalid seed ${token}`);
        seeds.push(seed);
    }
    if (!seeds.length || new Set(seeds).size !== seeds.length) {
        throw new Error("seed list must be non-empty and unique");
    }
    return seeds;
}

function count(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1;
}

function plainNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function eventObjects(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter((event): event is Record<string, unknown> => !!event && typeof event === "object")
        : [];
}

function fileSha256(path: string): string {
    return sha256(readFileSync(path));
}

async function main(): Promise<void> {
    const args = parseArgs();
    if (!args.archive || !args.variant?.trim() || !args.output) {
        throw new Error("--archive, --variant, and --output are required");
    }
    const archive = resolve(args.archive);
    const variant = args.variant.trim();
    const mode = args.mode;
    const output = resolve(args.output);
    if (mode !== "unbounded" && mode !== "bounded") {
        throw new Error("--mode must be unbounded or bounded");
    }
    const seeds = parseSeeds(args.seeds ?? "1-20");
    const repeatSeed = args["repeat-seed"] === undefined ? undefined : Number(args["repeat-seed"]);
    if (repeatSeed !== undefined && !Number.isSafeInteger(repeatSeed)) {
        throw new Error("--repeat-seed must be an integer");
    }

    const moduleUrl = (relative: string): string =>
        pathToFileURL(resolve(archive, relative)).href + `?exact-trace=${encodeURIComponent(variant)}-${mode}`;
    const army = (await import(moduleUrl("src/simulation/army.ts"))) as {
        buildRoster(rng: () => number): unknown[];
        makeRng(seed: number): () => number;
    };
    const battle = (await import(moduleUrl("src/simulation/battle_engine.ts"))) as {
        runMatch(config: Record<string, unknown>): Record<string, unknown>;
    };
    const hooks = (await import(moduleUrl("src/simulation/exact_trace_hooks.ts"))) as {
        installExactTraceObserver(observer: (boundary: Record<string, unknown>) => void): void;
        clearExactTraceObserver(): void;
    };

    const runSeed = (seed: number): IRunRecord => {
        const traceHash = createHash("sha256");
        const boundaries: IBoundaryRow[] = [];
        const eventTypes: Record<string, number> = {};
        const boundaryKinds: Record<string, number> = {};
        let eventCount = 0;
        let recoveryActions = 0;
        const recoveryBySource: Record<string, number> = {};
        let incompleteBoundaryActions = 0;
        let finalSearch: Record<string, unknown> = {};

        hooks.installExactTraceObserver((boundary) => {
            const canonical = JSON.stringify(boundary);
            const eventsCanonical = JSON.stringify(boundary.events);
            const detailCanonical = JSON.stringify(boundary.detail);
            const stateCanonical = JSON.stringify(boundary.state);
            const events = eventObjects(boundary.events);
            const types = events.map((event) => String(event.type ?? "<missing>"));
            for (const type of types) count(eventTypes, type);
            eventCount += events.length;
            const kind = String(boundary.kind);
            count(boundaryKinds, kind);
            const detail = boundary.detail as Record<string, unknown> | undefined;
            if (kind === "recovery_action") {
                recoveryActions += 1;
                count(recoveryBySource, String(detail?.source ?? "<missing>"));
            }
            if (
                (kind === "placement_action" ||
                    kind === "strategy_action" ||
                    kind === "recovery_action" ||
                    kind === "end_turn") &&
                detail?.completed === false
            ) {
                incompleteBoundaryActions += 1;
            }
            const state = boundary.state as Record<string, unknown> | undefined;
            finalSearch = (state?.search as Record<string, unknown> | undefined) ?? finalSearch;
            const framed = `${Buffer.byteLength(canonical)}:`;
            traceHash.update(framed).update(canonical);
            boundaries.push({
                index: boundaries.length,
                kind,
                sha256: sha256(canonical),
                eventsSha256: sha256(eventsCanonical),
                detailSha256: sha256(detailCanonical),
                stateSha256: sha256(stateCanonical),
                eventCount: events.length,
                eventTypes: types,
            });
        });

        const savedMode = process.env.HOC_EXACT_TRACE_MODE;
        process.env.HOC_EXACT_TRACE_MODE = mode;
        let result: Record<string, unknown>;
        try {
            const roster = army.buildRoster(army.makeRng(seed));
            result = battle.runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster,
                seed,
                maxLaps: 60,
            });
        } finally {
            hooks.clearExactTraceObserver();
            if (savedMode === undefined) delete process.env.HOC_EXACT_TRACE_MODE;
            else process.env.HOC_EXACT_TRACE_MODE = savedMode;
        }

        const counters = (finalSearch.counters as Record<string, unknown> | undefined) ?? {};
        const actions = Array.isArray(result.actions) ? (result.actions as Record<string, unknown>[]) : [];
        return {
            seed,
            traceSha256: traceHash.digest("hex"),
            resultSha256: sha256(JSON.stringify(result)),
            boundaryCount: boundaries.length,
            eventCount,
            eventTypes,
            boundaryKinds,
            boundaries,
            result: {
                winner: String(result.winner),
                endReason: String(result.endReason),
                laps: plainNumber(result.laps),
                totalActions: plainNumber(result.totalActions),
                rejectedGreen: plainNumber(result.rejectedGreen),
                rejectedRed: plainNumber(result.rejectedRed),
                rejectedActionRecords: actions.filter((action) => action.completed === false).length,
            },
            execution: {
                recoveryActions,
                recoveryBySource,
                incompleteBoundaryActions,
            },
            search: {
                circuitOpen: finalSearch.circuitOpen === true,
                circuitSkipped: plainNumber(counters.circuitSkipped),
                deadlineFallbacks: plainNumber(counters.deadlineFallbacks),
                decisions: plainNumber(counters.decisions),
                searched: plainNumber(counters.searched),
                overrides: plainNumber(counters.overrides),
                illegalIncumbent: plainNumber(counters.illegalIncumbent),
                singleCandidate: plainNumber(counters.singleCandidate),
            },
        };
    };

    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const repeat = repeatSeed === undefined ? undefined : { first: runSeed(repeatSeed), second: runSeed(repeatSeed) };
    const records = seeds.map(runSeed);
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    const report = {
        schema: "hoc.a13_exact_boundary_trace.variant.v1",
        generatedAt: new Date().toISOString(),
        startedAt,
        archive,
        variant,
        mode,
        matchConfig: {
            versions: ["v0.8", "v0.8"],
            roster: "buildRoster(makeRng(seed)); historical level-table amounts",
            grid: "NORMAL (default)",
            maxLaps: 60,
            seeds,
        },
        source: {
            attackHandlerSha256: fileSha256(resolve(archive, "src/handlers/attack_handler.ts")),
            rayTraversalSha256: (() => {
                try {
                    return fileSha256(resolve(archive, "src/grid/ray_traversal.ts"));
                } catch {
                    return null;
                }
            })(),
            instrumentedBattleEngineSha256: fileSha256(resolve(archive, "src/simulation/battle_engine.ts")),
            exactTraceHooksSha256: fileSha256(resolve(archive, "src/simulation/exact_trace_hooks.ts")),
            instrumentedA13SearchSha256: fileSha256(resolve(archive, "src/simulation/v0_8_a13_search.ts")),
        },
        elapsedMs,
        repeat,
        records,
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        JSON.stringify({
            output,
            variant,
            mode,
            elapsedMs,
            repeatDeterministic:
                repeat === undefined ||
                (repeat.first.traceSha256 === repeat.second.traceSha256 &&
                    repeat.first.resultSha256 === repeat.second.resultSha256),
            matches: records.length,
            boundaries: records.reduce((sum, record) => sum + record.boundaryCount, 0),
            events: records.reduce((sum, record) => sum + record.eventCount, 0),
        }),
    );
}

await main();
