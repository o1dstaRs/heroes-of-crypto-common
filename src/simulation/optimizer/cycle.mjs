/*
 * -----------------------------------------------------------------------------
 * AI optimizer — one measure/gate cycle.
 *
 * Run AFTER an agent has made a change to src/ai/versions/v0_3.ts. This script does
 * the mechanical, deterministic part of a cycle:
 *
 *   1. Gate: `tsc --noEmit` and the AI tests must pass (else REVERT the change).
 *   2. Measure: run a <games>-game v0.3-vs-v0.2 tournament -> v0.3 decisive win rate.
 *   3. Decide: ACCEPT (>= baseline + 1.0 pp) -> git commit v0_3.ts on this branch and
 *      raise the baseline; otherwise REVERT (git checkout v0_3.ts).
 *   4. Record: append to optimizer/log.md, refresh optimizer/state.json, run analyze.mjs.
 *
 * It only ever touches src/ai/versions/v0_3.ts and commits LOCALLY (never pushes, never
 * touches v0.2 — the frozen benchmark). Reverting is always a clean `git checkout`.
 *
 *   node cycle.mjs "<one-line change summary>" [games=10000] [gainPP=1.0]
 * -----------------------------------------------------------------------------
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", ".."); // game/heroes-of-crypto-common
const V03 = "src/ai/versions/v0_3.ts";
const STATE_DIR = join(REPO, "sim-out", "optimizer");
const STATE = join(STATE_DIR, "state.json");
const LOG = join(STATE_DIR, "log.md");
const TOURN_OUT = join(REPO, "sim-out");

const summary = process.argv[2] ?? "(unspecified change)";
const games = Number(process.argv[3] ?? 10000);
const gainPP = Number(process.argv[4] ?? 1.0); // required improvement in PERCENTAGE POINTS

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: "pipe", ...opts });
const revert = () => sh(`git checkout -- ${V03}`);

mkdirSync(STATE_DIR, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { baselinePct: 0, cycle: 0, accepted: 0 };
state.cycle = (state.cycle ?? 0) + 1;

const record = (decision, pct, note) => {
    const line = `| ${state.cycle} | ${new Date().toISOString()} | ${decision} | ${pct == null ? "-" : pct.toFixed(2) + "%"} | baseline ${state.baselinePct.toFixed(2)}% | ${summary.replace(/\|/g, "/")} ${note ?? ""} |`;
    if (!existsSync(LOG)) {
        writeFileSync(LOG, `# v0.3 optimizer log\n\n| cycle | time | decision | v0.3 win% | baseline | change |\n|---|---|---|---|---|---|\n`);
    }
    appendFileSync(LOG, line + "\n");
    writeFileSync(STATE, JSON.stringify(state, null, 2));
};

// 1) Gate — typecheck + AI tests. Any failure reverts the change immediately.
try {
    sh("bunx tsc --noEmit");
} catch (e) {
    revert();
    record("REVERT(tsc)", null, "tsc failed");
    console.log("REVERT: tsc failed — change reverted.");
    process.exit(0);
}
try {
    sh("bun test test/ai/ test/simulation/ 2>&1");
} catch (e) {
    revert();
    record("REVERT(test)", null, "tests failed");
    console.log("REVERT: tests failed — change reverted.");
    process.exit(0);
}

// 2) Measure — v0.3 vs v0.2 tournament.
sh(`bun src/simulation/run_tournament.ts v0.3 v0.2 ${games} 1 ${JSON.stringify(TOURN_OUT)}`, { stdio: "ignore" });
const jsonls = readdirSync(TOURN_OUT)
    .filter((f) => f.startsWith("v0.3_vs_v0.2_") && f.endsWith(".summary.json"))
    .map((f) => join(TOURN_OUT, f))
    .sort();
const summaryPath = jsonls[jsonls.length - 1];
const sum = JSON.parse(readFileSync(summaryPath, "utf8"));
const decisive = sum.a.wins + sum.b.wins; // a = v0.3, b = v0.2
const pct = decisive ? (100 * sum.a.wins) / decisive : 0;
const jsonl = summaryPath.replace(/\.summary\.json$/, ".jsonl");

// HARD GATE: the AI must never issue an action the engine rejects (completed === false).
// Even a single rejection means the change destabilised behaviour — revert no matter the win rate.
let rejected = 0;
for (const l of readFileSync(jsonl, "utf8").split("\n")) {
    if (!l) continue;
    try {
        for (const a of JSON.parse(l).result.actions ?? []) {
            if (a.completed === false || a.rejectionReason) rejected++;
        }
    } catch {
        /* skip */
    }
}

// 3) Decide. Win rate must clear baseline + gainPP AND there must be zero rejected actions.
const improved = pct >= state.baselinePct + gainPP && rejected === 0;
if (rejected > 0 && pct >= state.baselinePct + gainPP) {
    revert();
    record("REVERT(rejections)", pct, `${rejected} rejected actions`);
    console.log(`REVERT: ${rejected} rejected actions — change destabilised the AI, reverted despite ${pct.toFixed(2)}%.`);
    process.exit(0);
}
if (improved) {
    sh(`git add ${V03}`);
    sh(`git commit -q -m "v0.3 optimizer: ${summary.replace(/"/g, "'")} (${pct.toFixed(2)}% vs ${state.baselinePct.toFixed(2)}%)"`);
    state.baselinePct = pct;
    state.accepted = (state.accepted ?? 0) + 1;
    record("ACCEPT", pct, `(+${(pct - (state.baselinePct - (pct - state.baselinePct))).toFixed(2)}pp)`);
    console.log(`ACCEPT: v0.3 ${pct.toFixed(2)}% — committed. New baseline ${pct.toFixed(2)}%.`);
} else {
    revert();
    record("REVERT", pct, `(<${gainPP}pp gain)`);
    console.log(`REVERT: v0.3 ${pct.toFixed(2)}% < baseline ${state.baselinePct.toFixed(2)}% + ${gainPP}pp — reverted.`);
}

// 4) Refresh the loss analysis for the next cycle to target.
try {
    const report = sh(`node src/simulation/optimizer/analyze.mjs ${JSON.stringify(jsonl)} v0.3 v0.2`);
    console.log("\n" + report);
} catch {
    /* analysis is best-effort */
}
