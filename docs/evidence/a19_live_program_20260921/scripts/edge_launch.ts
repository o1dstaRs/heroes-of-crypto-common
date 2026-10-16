// Launches the edge-of-reach paired shards with the ranked draft harness's worker environment.
// usage: COMMON_ROOT=<common checkout> bun edge_launch.ts <shards> <seed> <wanted> <cohort> [outdir]
const ROOT = process.env.COMMON_ROOT;
if (!ROOT) throw new Error("COMMON_ROOT required");
const { sanitizedRankedDraftEnvironment } = await import(`${ROOT}/src/simulation/ranked_draft_eval`);
const shards = Number(process.argv[2] ?? 8);
const seed = process.argv[3] ?? "99010001";
const wanted = process.argv[4] ?? "450";
const cohort = process.argv[5] ?? "mirror";
const outDir = process.argv[6];
if (!outDir)
    throw new Error("usage: COMMON_ROOT=<common> bun edge_launch.ts <shards> <seed> <wanted> <cohort> <outdir>");
// The harness's a19 settings carry V07_SEARCH=1, which stops battle_engine from building the override driver;
// V08_A19_SEARCH=1 forces the promoted factory in both arms (baseline digests are unchanged).
const env = {
    ...sanitizedRankedDraftEnvironment(process.env, "a19"),
    LIVETWIN: "1",
    V08_A19_SEARCH: "1",
    COMMON_ROOT: ROOT,
    MAX_GAMES_PER_PROCESS: process.env.MAX_GAMES_PER_PROCESS ?? "40",
    ...(process.env.EDGE_OVERRIDE_JSON ? { EDGE_OVERRIDE_JSON: process.env.EDGE_OVERRIDE_JSON } : {}),
    ...(process.env.SEARCH_A19_EDGE_OF_REACH_DEBUG
        ? { SEARCH_A19_EDGE_OF_REACH_DEBUG: process.env.SEARCH_A19_EDGE_OF_REACH_DEBUG }
        : {}),
    ...(process.env.EDGE_LABEL ? { EDGE_LABEL: process.env.EDGE_LABEL } : {}),
    ...(process.env.EDGE_DRAFT_POLICY ? { EDGE_DRAFT_POLICY: process.env.EDGE_DRAFT_POLICY } : {}),
} as Record<string, string>;
const child = new URL("./edge_child.ts", import.meta.url).pathname;
const runShard = async (shard: number): Promise<void> => {
    for (let pass = 0; ; pass += 1) {
        const proc = Bun.spawn(
            ["nice", "-n", "5", "bun", child, String(shard), String(shards), seed, wanted, cohort, outDir],
            {
                env,
                cwd: ROOT,
                stdout: "pipe",
                stderr: "inherit",
            },
        );
        const out = await new Response(proc.stdout).text();
        process.stdout.write(out);
        const code = await proc.exited;
        if (code !== 0) throw new Error(`shard ${shard} pass ${pass} exited ${code}`);
        const summary = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
        if (!summary.capped) return;
    }
};
await Promise.all(Array.from({ length: shards }, (_, shard) => runShard(shard)));
console.log(`edge run done: cohort ${cohort} seed ${seed}`);
process.exit(0);
