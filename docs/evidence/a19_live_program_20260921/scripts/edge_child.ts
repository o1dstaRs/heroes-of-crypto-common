// Paired A/B of the a19 edge-of-reach move candidate (SEARCH_A19_EDGE_OF_REACH_MOVE) on live-drafted side boards.
// usage: COMMON_ROOT=<common checkout> bun edge_child.ts <shard> <shards> <seed> <wanted> <cohort> <outdir>
//   cohort: mirror     = both armies drafted by the current staging draft (v1-w4)
//           vsranged   = treated army v1-w4, opponent army the untrained heuristic (a ranged stack)
//           vsmelee    = treated army v1-w4, opponent army the league round-3 exploiter (melee tanks)
// Both seats are a19 at deterministic search work; only the TREATED seat gets the env override, mirrors swap seats.
// Rows are appended as each game finishes; a restart skips games already on disk (seeded games replay exactly).
const ROOT = process.env.COMMON_ROOT;
if (!ROOT) throw new Error("COMMON_ROOT required");
const C = `${ROOT}/src`;
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const { runMatch } = await import(`${C}/simulation/battle_engine`);
const { V07_NONFIGHT_SETUP_SPEC } = await import(`${C}/ai/setup/setup_ship`);
const { PBTypes } = await import(`${C}/generated/protobuf/v1/types`);
const evalHarness = await import(`${C}/simulation/ranked_draft_eval`);
const driverModule = await import(`${C}/simulation/search_driver`);
const EDGE_STATS: { searchedDecisions: number; retained: number; chosen: number } | null =
    driverModule.EDGE_OF_REACH_STATS ?? null;
const WAIT_STATS: { searchedDecisions: number; offered: number; chosen: number } | null =
    driverModule.WAIT_CHALLENGER_STATS ?? null;

const shard = Number(process.argv[2]);
const shards = Number(process.argv[3]);
const seed = Number(process.argv[4]);
const wanted = Number(process.argv[5] ?? 450);
const cohort = process.argv[6] ?? "mirror";
const outDir = process.argv[7];
if (!outDir)
    throw new Error("usage: COMMON_ROOT=<common> bun edge_child.ts <shard> <shards> <seed> <wanted> <cohort> <outdir>");
const MAX_GAMES_PER_PROCESS = Number(process.env.MAX_GAMES_PER_PROCESS ?? Infinity);
const OVERRIDE = process.env.EDGE_OVERRIDE_JSON ?? JSON.stringify({ SEARCH_A19_EDGE_OF_REACH_MOVE: "1" });
if (process.env.V08_A19_SEARCH !== "1") throw new Error("launch with V08_A19_SEARCH=1 (see edge_launch.ts)");
mkdirSync(outDir, { recursive: true });
const LABEL = process.env.EDGE_LABEL ?? "edge";
const OUT = `${outDir}/${LABEL}_${cohort}_seed${seed}_shard${shard}.jsonl`;

const done = new Set<string>();
if (existsSync(OUT)) {
    const kept: string[] = [];
    for (const line of readFileSync(OUT, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            done.add(`${row.board}:${row.mirror}:${row.arm}`);
            kept.push(line);
        } catch {
            // half-written last line
        }
    }
    writeFileSync(OUT, kept.length ? `${kept.join("\n")}\n` : "");
}

const maps = [...evalHarness.RANKED_DRAFT_LIVE_MAP_TYPES];
const DRAFT = process.env.EDGE_DRAFT_POLICY ?? "ranked-unit-strength-a19-side-v1-w4";
const treated = evalHarness.rankedDraftStrengthCandidate(DRAFT);
const pool = evalHarness.defaultRankedDraftPool();
const byId = (id: string) => {
    const entry = pool.find((e: any) => e.id === id);
    if (!entry) throw new Error(`pool entry ${id} missing`);
    return entry;
};
const opponent =
    cohort === "mirror"
        ? { ...treated, id: `${DRAFT}-control`, prior: 1 }
        : cohort === "vsranged"
          ? byId("untrained-heuristic")
          : cohort === "vsmelee"
            ? byId("league-round3-exploiter")
            : (() => {
                  throw new Error(`unknown cohort ${cohort}`);
              })();
const options = {
    gamesPerOpponent: wanted * 4 + 8,
    baseSeed: seed,
    concurrency: 1,
    mapTypes: maps,
    fightProfile: "a19",
    candidateSetupPolicySpec: V07_NONFIGHT_SETUP_SPEC,
    opponentSetupPolicySpec: V07_NONFIGHT_SETUP_SPEC,
    liveDraftRules: true,
    sideBoard: true,
    deterministicSearch: true,
    recordArmies: true,
};
const mine = Array.from({ length: wanted }, (_, board) => board).filter((_, index) => index % shards === shard);
let played = 0;
for (const board of mine) {
    for (const mirror of [0, 1]) {
        // Game 4b drafts LEFT = candidate (treated). Mirror 0 fights it as LEFT, mirror 1 as RIGHT.
        const treatedTeam = mirror === 0 ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
        for (const arm of ["baseline", "treatment"] as const) {
            if (done.has(`${board}:${mirror}:${arm}`)) continue;
            const cpu0 = process.cpuUsage();
            const t0 = performance.now();
            const stats0 = EDGE_STATS ? { ...EDGE_STATS } : null;
            const wstats0 = WAIT_STATS ? { ...WAIT_STATS } : null;
            const record = evalHarness.playRankedDraftGame(treated, opponent, options, board * 4 + mirror, 0, {
                matchRunner: (config: any) => {
                    delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
                    if (arm === "baseline") return runMatch(config);
                    process.env.V08_A19_SEARCH_ENV_OVERRIDES = OVERRIDE;
                    try {
                        return runMatch({ ...config, searchEnvOverrideTeams: [treatedTeam] });
                    } finally {
                        delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
                    }
                },
            });
            const cpu = process.cpuUsage(cpu0);
            appendFileSync(
                OUT,
                `${JSON.stringify({
                    board,
                    mirror,
                    arm,
                    cohort,
                    gridType: record.gridType,
                    result: record.candidateResult,
                    laps: record.laps,
                    rejections: record.rejectedCandidate,
                    opponentRejections: record.rejectedOpponent,
                    digest: record.behaviorTraceSha256,
                    armies: record.armies ?? null,
                    cpuSeconds: (cpu.user + cpu.system) / 1e6,
                    wallSeconds: (performance.now() - t0) / 1000,
                    ...(EDGE_STATS && stats0
                        ? {
                              edgeSearched: EDGE_STATS.searchedDecisions - stats0.searchedDecisions,
                              edgeRetained: EDGE_STATS.retained - stats0.retained,
                              edgeChosen: EDGE_STATS.chosen - stats0.chosen,
                          }
                        : {}),
                    ...(WAIT_STATS && wstats0
                        ? {
                              waitSearched: WAIT_STATS.searchedDecisions - wstats0.searchedDecisions,
                              waitOffered: WAIT_STATS.offered - wstats0.offered,
                              waitChosen: WAIT_STATS.chosen - wstats0.chosen,
                          }
                        : {}),
                    rssMb: Math.round(process.memoryUsage().rss / 1e6),
                })}\n`,
            );
            played += 1;
            if (played >= MAX_GAMES_PER_PROCESS) {
                console.log(
                    JSON.stringify({ shard, cohort, resumedGames: done.size, playedGames: played, capped: true }),
                );
                process.exit(0);
            }
        }
    }
}
console.log(JSON.stringify({ shard, cohort, boards: mine.length, resumedGames: done.size, playedGames: played }));
process.exit(0);
