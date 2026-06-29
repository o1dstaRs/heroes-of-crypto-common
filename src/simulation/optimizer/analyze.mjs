/*
 * -----------------------------------------------------------------------------
 * AI optimizer — loss analyzer.
 *
 * Reads a tournament .jsonl (one game per line) and reports WHERE the optimized
 * version (default v0.3) loses against the baseline (default v0.2), bucketed by the
 * mirror roster's composition (ranged / flying / caster heavy, average level), by
 * end reason, by game length, and by board side. The buckets are sorted worst-first
 * so the next code change can target the weakest matchup.
 *
 *   node analyze.mjs <games.jsonl> [optimizedVersion=v0.3] [baselineVersion=v0.2]
 *
 * Emits a human report to stdout and writes <jsonl>.analysis.json next to the input.
 * -----------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const creatures = require("../../configuration/creatures.json");

// creatureName -> { ranged, flying, caster, ... }
const FEAT = {};
for (const faction of Object.keys(creatures)) {
    if (faction === "version") continue;
    for (const name of Object.keys(creatures[faction])) {
        const u = creatures[faction][name];
        FEAT[name] = {
            ranged: u.attack_type === "RANGE",
            flying: u.movement_type === "FLY",
            caster: u.attack_type === "MAGIC" || (Array.isArray(u.spells) && u.spells.length > 0),
        };
    }
}

const [, , jsonlPath, optimized = "v0.3", baseline = "v0.2"] = process.argv;
if (!jsonlPath) {
    console.error("usage: node analyze.mjs <games.jsonl> [optimizedVersion=v0.3] [baselineVersion=v0.2]");
    process.exit(1);
}

const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);

const rosterFeatures = (roster) => {
    let ranged = 0;
    let flying = 0;
    let caster = 0;
    let levelSum = 0;
    for (const c of roster) {
        const f = FEAT[c.creatureName] ?? { ranged: false, flying: false, caster: false };
        if (f.ranged) ranged++;
        if (f.flying) flying++;
        if (f.caster) caster++;
        levelSum += c.level ?? 1;
    }
    return { ranged, flying, caster, avgLevel: roster.length ? levelSum / roster.length : 0, size: roster.length };
};

// A "bucket" = a named predicate over a game's composition / outcome.
const BUCKETS = [
    ["ranged-heavy (>=3 ranged)", (g) => g.feat.ranged >= 3],
    ["ranged-light (<=1 ranged)", (g) => g.feat.ranged <= 1],
    ["flying-heavy (>=3 flying)", (g) => g.feat.flying >= 3],
    ["flying-light (<=1 flying)", (g) => g.feat.flying <= 1],
    ["caster present (>=1)", (g) => g.feat.caster >= 1],
    ["no caster", (g) => g.feat.caster === 0],
    ["high level (avg>=2)", (g) => g.feat.avgLevel >= 2],
    ["low level (avg<2)", (g) => g.feat.avgLevel < 2],
    ["short game (<=5 laps)", (g) => g.laps <= 5],
    ["long game (>=9 laps)", (g) => g.laps >= 9],
    ["armageddon-decided", (g) => g.armageddon],
    ["as green", (g) => g.side === "green"],
    ["as red", (g) => g.side === "red"],
];

const games = [];
let optWins = 0;
let optLosses = 0;
let draws = 0;
const lossEndReasons = {};

for (const line of lines) {
    let o;
    try {
        o = JSON.parse(line);
    } catch {
        continue;
    }
    const r = o.result ?? {};
    const side = o.greenVersion === optimized ? "green" : o.redVersion === optimized ? "red" : undefined;
    if (!side) continue; // not a game involving the optimized version
    const winnerSide = r.winner; // "green" | "red" | undefined (draw)
    const optWon = winnerSide === side;
    const draw = winnerSide !== "green" && winnerSide !== "red";
    if (draw) {
        draws++;
        continue;
    }
    if (optWon) optWins++;
    else {
        optLosses++;
        lossEndReasons[r.endReason ?? "?"] = (lossEndReasons[r.endReason ?? "?"] ?? 0) + 1;
    }
    games.push({
        side,
        optWon,
        laps: r.laps ?? 0,
        armageddon: r.endReason === "armageddon" || (r.outcome && r.outcome.armageddon) || false,
        feat: rosterFeatures(r.roster ?? []),
    });
}

const decisive = optWins + optLosses;
const overallWinRate = decisive ? optWins / decisive : 0;

const bucketRows = BUCKETS.map(([label, pred]) => {
    const sub = games.filter(pred);
    const w = sub.filter((g) => g.optWon).length;
    const n = sub.length;
    return { label, n, wins: w, winRate: n ? w / n : 0, delta: n ? w / n - overallWinRate : 0 };
}).filter((b) => b.n >= 20); // ignore tiny buckets

// Worst matchups first = lowest win rate among meaningful buckets.
const worst = [...bucketRows].sort((a, b) => a.winRate - b.winRate);

const pct = (x) => (100 * x).toFixed(1) + "%";
const out = [];
out.push(`# v0.3 vs v0.2 loss analysis  (${decisive} decisive games, ${draws} draws)`);
out.push(``);
out.push(`Overall ${optimized} win rate (decisive): **${pct(overallWinRate)}**  (${optWins}W / ${optLosses}L)`);
out.push(`Loss end reasons: ${JSON.stringify(lossEndReasons)}`);
out.push(``);
out.push(`## Where ${optimized} is WEAKEST (worst win rate first, vs overall ${pct(overallWinRate)})`);
out.push(`| bucket | games | win rate | Δ vs overall |`);
out.push(`|---|---:|---:|---:|`);
for (const b of worst) {
    out.push(`| ${b.label} | ${b.n} | ${pct(b.winRate)} | ${b.delta >= 0 ? "+" : ""}${pct(b.delta)} |`);
}
const report = out.join("\n");
console.log(report);

const analysisPath = jsonlPath.replace(/\.jsonl$/, "") + ".analysis.json";
writeFileSync(
    analysisPath,
    JSON.stringify(
        { optimized, baseline, decisive, draws, optWins, optLosses, overallWinRate, lossEndReasons, buckets: worst },
        null,
        2,
    ),
);
console.error(`\nwrote ${analysisPath}`);
