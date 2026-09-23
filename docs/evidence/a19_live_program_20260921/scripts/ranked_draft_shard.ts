// Run one shard of a ranked_draft_eval panel: the same tasks the CLI would run, filtered to index % shards === shard.
// usage: bun ranked_draft_shard.ts --common <root> --shard k --shards K --records <out.jsonl> <ranked_draft_eval flags>
// Records come back in the harness's canonical order; merge with ranked_draft_merge.ts to get the single-run report.
const argv = process.argv.slice(2);
const take = (key: string): string | undefined => {
    const index = argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    argv.splice(index, 2);
    return value;
};
const root = take("common");
const shard = Number(take("shard"));
const shards = Number(take("shards"));
const recordsPath = take("records");
if (!root || !recordsPath || !Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shard >= shards) {
    throw new Error("usage: --common <root> --shard k --shards K --records <out.jsonl> <eval flags>");
}
const { writeFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
const ev = await import(`${root}/src/simulation/ranked_draft_eval`);
const { parseDraftGenome } = await import(`${root}/src/ai/setup/draft_ship`);
const values = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) values.set(argv[i].replace(/^--/, ""), argv[i + 1]);
const flag = (key: string): boolean => values.get(key) === "true" || values.get(key) === "1";
const candidate = ev.normalizeRankedDraftGenome(parseDraftGenome(values.get("candidate")!, "ranked-draft-candidate"));
const pool = ev.loadRankedDraftPool(values.get("pool"));
const options = {
    gamesPerOpponent: Number(values.get("games")),
    baseSeed: Number(values.get("seed")),
    concurrency: Number(values.get("concurrency") ?? 8),
    mapTypes: (values.get("maps") ?? ev.RANKED_DRAFT_LIVE_MAP_TYPES.join(",")).split(",").map(Number),
    ...(values.get("fight-profile") ? { fightProfile: values.get("fight-profile") } : {}),
    ...(values.get("candidate-setup") ? { candidateSetupPolicySpec: values.get("candidate-setup") } : {}),
    ...(values.get("opponent-setup") ? { opponentSetupPolicySpec: values.get("opponent-setup") } : {}),
    ...(values.get("candidate-doctrine") ? { candidateDoctrinePolicy: values.get("candidate-doctrine") } : {}),
    ...(values.get("opponent-doctrine") ? { opponentDoctrinePolicy: values.get("opponent-doctrine") } : {}),
    ...(values.get("candidate-t2") ? { candidateTier2Override: Number(values.get("candidate-t2")) } : {}),
    ...(values.get("candidate-synergy")
        ? { candidateSynergyOverride: ev.parseRankedDraftSynergyOverride(values.get("candidate-synergy")!) }
        : {}),
    liveDraftRules: flag("live-draft-rules"),
    sideBoard: flag("side-board"),
    deterministicSearch: flag("deterministic-search"),
    explorationRate: Number(values.get("exploration") ?? 0),
    recordArmies: flag("record-armies"),
};
const all = Array.from({ length: options.gamesPerOpponent * pool.length }, (_, index) => ({
    opponentIndex: Math.floor(index / options.gamesPerOpponent),
    game: index % options.gamesPerOpponent,
}));
const mine = all.filter((_, index) => index % shards === shard);
const startedAt = Date.now();
let last = startedAt;
const records = await ev.evaluateRankedDraftTasks(candidate, pool, options, mine, (done: number, total: number) => {
    const now = Date.now();
    if (done !== total && now - last < 30_000) return;
    last = now;
    const rate = done / Math.max(1, (now - startedAt) / 1000);
    process.stderr.write(
        `[shard ${shard}/${shards}] ${done}/${total} games (${rate.toFixed(2)}/s, eta ${Math.round((total - done) / Math.max(rate, 1e-9) / 60)}m)\n`,
    );
});
mkdirSync(dirname(recordsPath), { recursive: true });
writeFileSync(recordsPath, `${records.map((record: unknown) => JSON.stringify(record)).join("\n")}\n`);
console.log(JSON.stringify({ shard, shards, games: records.length }));
process.exit(0);
