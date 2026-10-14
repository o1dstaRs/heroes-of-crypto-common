import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AI_META_COHORTS, AI_META_RECORDED_MAPS } from "./ai_meta_cohorts_core";
import type { BarrelFightRequest, BarrelFightResult } from "./measure_barrel_use_worker";
import { resolveAiMetaFightProfile, sanitizedAiMetaEnvironment } from "./measure_ai_meta_cohorts";
import { PersistentWorkerPool } from "./persistent_worker_pool";
import { fingerprintSourceTree } from "./source_tree_fingerprint";

type Experiment = NonNullable<BarrelFightRequest["experiment"]>;
const ownerships = ["both", "candidate", "opponent", "neither"] as const;

/** Four games per independent roster pair: control/treatment, each on both seats. */
export function barrelComparisonPlan(
    clusters: number,
    baseSeed: number,
    timing: Experiment["timing"],
): BarrelFightRequest[] {
    if (!Number.isSafeInteger(clusters) || clusters < 1) throw new RangeError("clusters must be a positive integer");
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError("seed must be an integer");
    return Array.from({ length: clusters }, (_, cluster) => {
        const cohort = AI_META_COHORTS[cluster % AI_META_COHORTS.length];
        const map = AI_META_RECORDED_MAPS[Math.floor(cluster / AI_META_COHORTS.length) % 4];
        const ownership = ownerships[Math.floor(cluster / (AI_META_COHORTS.length * 4)) % 4];
        return [true, false].flatMap((greenIsArmyA) =>
            // Counterbalance order for wall-clock runs (JIT warmup and changing host load).
            [(cluster + Number(greenIsArmyA)) % 2 === 0, (cluster + Number(greenIsArmyA)) % 2 !== 0].map(
                (treatment) => ({
                    cohort,
                    pair: cluster,
                    matchupGames: clusters * 2,
                    baseSeed,
                    greenIsArmyA,
                    experiment: {
                        id: `${cluster}:${Number(greenIsArmyA)}:${Number(treatment)}`,
                        cluster,
                        treatment,
                        ownership,
                        map,
                        timing,
                    },
                }),
            ),
        );
    }).flat();
}

/** Do not count the four correlated fights as four independent samples. */
export function summarizeBarrelComparison(results: readonly BarrelFightResult[]) {
    const clusters = new Map<number, BarrelFightResult[]>();
    const seen = new Set<string>();
    for (const result of results) {
        if (!result.experiment) throw new Error("Missing barrel experiment identity");
        if (seen.has(result.experiment.id)) throw new Error(`Duplicate result ${result.experiment.id}`);
        seen.add(result.experiment.id);
        const group = clusters.get(result.experiment.cluster) ?? [];
        group.push(result);
        clusters.set(result.experiment.cluster, group);
    }
    const complete = [...clusters.values()].filter((group) => group.length === 4);
    const tally = (groups: readonly BarrelFightResult[][]) => {
        const deltas = groups.map(
            (group) =>
                group.reduce((sum, game) => sum + game.candidateScore * (game.experiment!.treatment ? 1 : -1), 0) / 2,
        );
        const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
        const se =
            mean !== null && deltas.length > 1
                ? Math.sqrt(deltas.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (deltas.length - 1) / deltas.length)
                : null;
        const games = groups.flat();
        const arm = (treatment: boolean) => {
            const rows = games.filter((game) => game.experiment!.treatment === treatment);
            return {
                games: rows.length,
                score: rows.length ? rows.reduce((sum, game) => sum + game.candidateScore, 0) / rows.length : null,
                candidateOwnBarrelStrikes: rows.reduce(
                    (sum, game) => sum + game.ownBarrelStrikesBySide[game.candidateSide],
                    0,
                ),
                barrelRejections: rows.reduce((sum, game) => sum + game.barrelRejections, 0),
                engineRejections: rows.reduce((sum, game) => sum + game.engineRejections, 0),
                nonElimination: rows.filter((game) => game.endReason !== "elimination").length,
                elapsedMs: rows.reduce((sum, game) => sum + game.elapsedMs, 0),
                diagnosticGames: rows.filter((game) => game.diagnostics).length,
                ownClearsOpeningShot: rows.reduce(
                    (sum, game) => sum + (game.diagnostics?.ownClears[game.candidateSide].opensShot ?? 0),
                    0,
                ),
                ownClearsRemovingCover: rows.reduce(
                    (sum, game) => sum + (game.diagnostics?.ownClears[game.candidateSide].removesCover ?? 0),
                    0,
                ),
                ownClearsWithoutCurrentShotEffect: rows.reduce(
                    (sum, game) => sum + (game.diagnostics?.ownClears[game.candidateSide].neither ?? 0),
                    0,
                ),
                searchDecisions: rows.reduce(
                    (sum, game) => sum + (game.diagnostics?.searchTiming[game.candidateSide].decisions ?? 0),
                    0,
                ),
                searchDecisionsOver1000Ms: rows.reduce(
                    (sum, game) => sum + (game.diagnostics?.searchTiming[game.candidateSide].over1000Ms ?? 0),
                    0,
                ),
                maxSearchDecisionMs: Math.max(
                    0,
                    ...rows.map((game) => game.diagnostics?.searchTiming[game.candidateSide].maxMs ?? 0),
                ),
            };
        };
        return {
            clusters: groups.length,
            scoreDelta: mean,
            // Descriptive normal CI only; small/degenerate samples never qualify a policy for release.
            approximate95CI:
                mean !== null && se !== null && se > 0
                    ? [Math.max(-1, mean - 1.96 * se), Math.min(1, mean + 1.96 * se)]
                    : null,
            control: arm(false),
            treatment: arm(true),
        };
    };
    const by = (key: (game: BarrelFightResult) => string) =>
        Object.fromEntries(
            [...new Set(complete.map((group) => key(group[0])))]
                .sort()
                .map((label) => [label, tally(complete.filter((group) => key(group[0]) === label))]),
        );
    return {
        completedGames: results.length,
        incompleteClusters: clusters.size - complete.length,
        noBarrelTracePairsChecked:
            complete.filter(
                (group) =>
                    group[0].experiment!.ownership === "neither" &&
                    group[0].experiment!.timing === "work" &&
                    group.every((game) => game.diagnostics),
            ).length * 2,
        noBarrelTraceMismatches: complete
            .filter((group) => group[0].experiment!.ownership === "neither" && group[0].experiment!.timing === "work")
            .reduce(
                (sum, group) =>
                    sum +
                    (["green", "red"] as const).filter((side) => {
                        const rows = group.filter((game) => game.candidateSide === side);
                        return (
                            rows.every((game) => game.diagnostics) &&
                            rows[0].diagnostics!.actionSha256 !== rows[1].diagnostics!.actionSha256
                        );
                    }).length,
                0,
            ),
        overall: tally(complete),
        liveMaps: tally(complete.filter((group) => group[0].map !== 2)),
        historicalWater: tally(complete.filter((group) => group[0].map === 2)),
        byCohort: by((game) => game.cohort),
        byMap: by((game) => String(game.map)),
        byOwnership: by((game) => game.experiment!.ownership),
    };
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
}

export async function runBarrelPolicyComparison(argv: readonly string[]): Promise<void> {
    const clusters = Number(argv[0] ?? 112);
    const concurrency = Number(argv[1] ?? 12);
    const seed = Number(argv[2] ?? 1);
    const outDir = resolve(argv[3] ?? `sim-out/barrel-comparison-${clusters}-s${seed}`);
    const timing = argv[4] ?? "work";
    if (timing !== "work" && timing !== "live") throw new Error("timing must be work or live");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be positive");
    const requests = barrelComparisonPlan(clusters, seed, timing);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const fingerprint = () => fingerprintSourceTree(root, ["src"], ["package.json", "bun.lock"]);
    const manifest = {
        schema: 2,
        concurrency,
        host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
        clusters,
        seed,
        timing,
        runtime: process.versions.bun,
        sourceSha256: fingerprint(),
        policy: "SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION=1",
        schedule: "7 cohorts x 4 maps x 4 ownerships; four games/cluster; army A treated; order counterbalanced",
    };
    mkdirSync(outDir, { recursive: true });
    const manifestPath = join(outDir, "manifest.json");
    const checkpoint = join(outDir, "results.jsonl");
    if (existsSync(manifestPath)) {
        if (JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))) !== JSON.stringify(manifest))
            throw new Error("Refusing to mix different source, runtime, seed or experiment settings");
    } else {
        if (existsSync(checkpoint)) throw new Error("Checkpoint has no source manifest");
        writeJson(manifestPath, manifest);
    }
    const results: BarrelFightResult[] = [];
    if (existsSync(checkpoint)) {
        // A torn tail must be repaired explicitly; silently skipping a line could hide a corrupt result.
        for (const line of readFileSync(checkpoint, "utf8").split("\n").filter(Boolean)) results.push(JSON.parse(line));
    }
    const wanted = new Map(requests.map((request) => [request.experiment!.id, request]));
    const seen = new Set<string>();
    for (const result of results) {
        const id = result.experiment?.id;
        const request = id ? wanted.get(id) : undefined;
        if (
            !request ||
            seen.has(id!) ||
            JSON.stringify(request.experiment) !== JSON.stringify(result.experiment) ||
            result.cohort !== request.cohort ||
            result.pair !== request.pair ||
            result.map !== request.experiment!.map ||
            result.candidateSide !== (request.greenIsArmyA ? "green" : "red") ||
            !["green", "red", "draw"].includes(result.winner) ||
            result.candidateScore !==
                (result.winner === "draw" ? 0.5 : Number(result.winner === result.candidateSide)) ||
            !result.diagnostics
        )
            throw new Error("Invalid checkpoint result");
        seen.add(id!);
    }
    const pending = requests.filter((request) => !seen.has(request.experiment!.id));
    const environment = sanitizedAiMetaEnvironment(process.env, resolveAiMetaFightProfile("a19-work"));
    const started = Date.now();
    const snapshot = () => ({
        ...manifest,
        concurrency,
        elapsedSeconds: (Date.now() - started) / 1000,
        complete: results.length === requests.length,
        ...summarizeBarrelComparison(results),
    });
    console.log(
        `Barrel comparison: ${pending.length}/${requests.length} games remaining, ${concurrency} workers, ${timing} timing -> ${outDir}`,
    );
    if (pending.length) {
        const pool = new PersistentWorkerPool<BarrelFightRequest, BarrelFightResult>({
            concurrency,
            maxQueuedTasks: concurrency,
            workerUrl: new URL("./measure_barrel_use_worker.ts", import.meta.url),
            workerOptions: { env: environment },
        });
        let next = 0;
        try {
            await Promise.all(
                Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
                    while (next < pending.length) {
                        const result = await pool.run(pending[next++]);
                        appendFileSync(checkpoint, `${JSON.stringify(result)}\n`);
                        results.push(result);
                        if (results.length % 16 === 0) {
                            writeJson(join(outDir, "progress.json"), snapshot());
                            console.log(
                                `${results.length}/${requests.length} games; ${((Date.now() - started) / 1000).toFixed(0)}s`,
                            );
                        }
                    }
                }),
            );
            await pool.close();
        } catch (error) {
            await pool.terminate(error);
            throw error;
        }
    }
    if (fingerprint() !== manifest.sourceSha256)
        throw new Error("Source changed during experiment; use a frozen source directory before trusting results");
    const summary = snapshot();
    writeJson(join(outDir, "summary.json"), summary);
    console.log(JSON.stringify(summary.overall, null, 2));
}
