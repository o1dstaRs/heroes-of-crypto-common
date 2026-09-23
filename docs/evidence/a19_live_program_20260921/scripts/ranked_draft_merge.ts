// Merge ranked_draft_shard.ts outputs into the exact records + report a single ranked_draft_eval run would write.
// usage: bun ranked_draft_merge.ts --common <root> --out <prefix> --shard-glob '<dir>/<name>.shard*.jsonl' <eval flags>
const argv = process.argv.slice(2);
const take = (key: string): string | undefined => {
    const index = argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    argv.splice(index, 2);
    return value;
};
const root = take("common")!;
const out = take("out")!;
const shardGlob = take("shard-glob")!;
const { readFileSync, writeFileSync } = await import("node:fs");
const { Glob } = await import("bun");
const ev = await import(`${root}/src/simulation/ranked_draft_eval`);
const { parseDraftGenome } = await import(`${root}/src/ai/setup/draft_ship`);
const { resolveSetupPolicy } = await import(`${root}/src/ai/setup/setup_ship`);
const values = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) values.set(argv[i].replace(/^--/, ""), argv[i + 1]);
const flag = (key: string): boolean => values.get(key) === "true" || values.get(key) === "1";
const candidate = ev.normalizeRankedDraftGenome(parseDraftGenome(values.get("candidate")!, "ranked-draft-candidate"));
const pool = ev.loadRankedDraftPool(values.get("pool"));
const records: any[] = [];
const files = [...new Glob(shardGlob).scanSync()].sort();
for (const file of files)
    for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) records.push(JSON.parse(line));
records.sort((l, r) => l.opponentId.localeCompare(r.opponentId) || l.pairSeed - r.pairSeed || l.game - r.game);
const games = Number(values.get("games"));
const total = games * pool.length;
if (records.length !== total)
    throw new Error(`expected ${total} records from ${files.length} shards, got ${records.length}`);
// Mirror of ranked_draft_eval's (unexported) normalizeOptions for these flags.
const setupSpec = (spec: string | undefined) =>
    resolveSetupPolicy(spec ?? ev.RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC).spec;
const options = {
    gamesPerOpponent: games,
    baseSeed: Number(values.get("seed")) >>> 0,
    concurrency: Math.min(Number(values.get("concurrency") ?? 8), total),
    mapTypes: (values.get("maps") ?? ev.RANKED_DRAFT_LIVE_MAP_TYPES.join(",")).split(",").map(Number),
    maxLaps: 60,
    fightProfile: values.get("fight-profile") ?? "v0.7",
    candidateSetupPolicySpec: setupSpec(values.get("candidate-setup")),
    opponentSetupPolicySpec: setupSpec(values.get("opponent-setup")),
    liveDraftRules: flag("live-draft-rules"),
    sideBoard: flag("side-board"),
    deterministicSearch: flag("deterministic-search"),
    explorationRate: Number(values.get("exploration") ?? 0),
    recordArmies: flag("record-armies"),
};
const report = ev.summarizeRankedDraftRecords(candidate, pool, options, records);
writeFileSync(`${out}.jsonl`, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ shards: files.length, records: records.length, out }));
