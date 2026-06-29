/*
 * -----------------------------------------------------------------------------
 * AI optimizer — one measure/gate cycle.
 *
 * Run AFTER an agent has made a change to the OPT version's file (src/ai/versions/v0_4.ts by default).
 * This script does the mechanical, deterministic part of a cycle:
 *
 *   1. Gate: `tsc --noEmit` and the AI tests must pass (else REVERT the change).
 *   2. Measure: run a <games>-game OPT-vs-BASE tournament -> OPT decisive win rate.
 *   3. Decide: ACCEPT (>= baseline + gainPP) -> git commit the OPT file on this branch and
 *      raise the baseline; otherwise REVERT (git checkout the OPT file).
 *   4. Record: append to optimizer/log.md, refresh optimizer/state.json, run analyze.mjs.
 *
 * It only ever touches the OPT file and commits LOCALLY (never pushes, never touches BASE — the
 * frozen benchmark). Reverting is always a clean `git checkout`. OPT/BASE default to v0.4 over v0.3
 * and are overridable via OPT_VERSION / BASE_VERSION env vars.
 *
 *   node cycle.mjs "<one-line change summary>" [games=12000] [gainPP=0.2]
 * -----------------------------------------------------------------------------
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", ".."); // game/heroes-of-crypto-common
// Versions: OPT = the version being optimized (its file is edited/committed/reverted HERE), BASE = the
// frozen benchmark it is measured against. Defaults to the current loop (v0.4 over the champion v0.3);
// override via OPT_VERSION / BASE_VERSION env for the next generation (v0.5 over v0.4, …).
const OPT = process.env.OPT_VERSION ?? "v0.4";
const BASE = process.env.BASE_VERSION ?? "v0.3";
const OPT_FILE = `src/ai/versions/${OPT.replace(".", "_")}.ts`;
const STATE_DIR = join(REPO, "sim-out", "optimizer");
// State + log are namespaced by the OPT version so each generation's loop starts from its OWN baseline
// (~50% when OPT is a fresh copy of BASE). Sharing one state.json would make a fresh v0.4 inherit v0.3's
// 66.5% baseline and revert every change forever. (Legacy un-namespaced files from the v0.3 run remain as
// state.json / log.md for history.)
const STATE = join(STATE_DIR, `state.${OPT}.json`);
const LOG = join(STATE_DIR, `log.${OPT}.md`);
const TOURN_OUT = join(REPO, "sim-out");

const summary = process.argv[2] ?? "(unspecified change)";
// Combat randomness is now SEEDED in simulation (battle_engine installs a deterministic source per match),
// so a (versions, seed) run reproduces EXACTLY — there is no run-to-run measurement noise at a fixed
// concurrency. That lets the gate be both faster (fewer games) and far more sensitive (tighter pp gate)
// than the old noisy 30k/0.6 regime. 12k games at a fixed baseSeed samples rosters well; +0.2pp on the
// SAME fixed scenario set is a real, repeatable gain. (Re-validate a kept change on a 2nd baseSeed
// occasionally to guard against overfitting one seed set — see PROTOCOL.md.)
const games = Number(process.argv[3] ?? 12000);
const gainPP = Number(process.argv[4] ?? 0.2); // required improvement in PERCENTAGE POINTS (noise-free now)
// Sample ALL board layouts by default (MAPS=off to disable) so map-specific tactics (mountain/lava/water)
// are measured in the SAME run — no separate map runs needed. Rosters stay MIRRORED by default for a clean
// skill signal (RANDOM=on enables the other agent's asymmetric-roster matchups when you want realism).
const MAPS = process.env.MAPS !== "off";
const RANDOM = process.env.RANDOM === "on";
const tournFlags = `${MAPS ? " --maps" : ""}${RANDOM ? " --random" : ""}`;

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: "pipe", ...opts });
const revert = () => sh(`git checkout -- ${OPT_FILE}`);

mkdirSync(STATE_DIR, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { baselinePct: 0, cycle: 0, accepted: 0 };
state.cycle = (state.cycle ?? 0) + 1;

const record = (decision, pct, note) => {
    const line = `| ${state.cycle} | ${new Date().toISOString()} | ${decision} | ${pct == null ? "-" : pct.toFixed(2) + "%"} | baseline ${state.baselinePct.toFixed(2)}% | ${summary.replace(/\|/g, "/")} ${note ?? ""} |`;
    if (!existsSync(LOG)) {
        writeFileSync(LOG, `# ${OPT} optimizer log\n\n| cycle | time | decision | ${OPT} win% | baseline | change |\n|---|---|---|---|---|---|\n`);
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

// 2) Measure — OPT vs BASE tournament. A crash here must not strand a half-applied change.
let summaryPath;
let sum;
try {
    const before = new Set(readdirSync(TOURN_OUT).filter((f) => f.endsWith(".summary.json")));
    sh(`bun src/simulation/run_tournament.ts ${OPT} ${BASE} ${games} 1 ${JSON.stringify(TOURN_OUT)}${tournFlags}`, {
        stdio: "ignore",
    });
    const after = readdirSync(TOURN_OUT)
        .filter((f) => f.startsWith(`${OPT}_vs_${BASE}_`) && f.endsWith(".summary.json") && !before.has(f))
        .map((f) => join(TOURN_OUT, f))
        .sort();
    summaryPath = after[after.length - 1];
    sum = JSON.parse(readFileSync(summaryPath, "utf8"));
} catch (e) {
    revert();
    record("REVERT(measure)", null, "tournament crashed");
    console.log("REVERT: tournament/measure crashed — change reverted. " + String(e).slice(0, 200));
    process.exit(0);
}
const decisive = sum.a.wins + sum.b.wins; // a = OPT, b = BASE
const pct = decisive ? (100 * sum.a.wins) / decisive : 0;
const jsonl = summaryPath.replace(/\.summary\.json$/, ".jsonl");

// HARD GATE: a change must never make the AI propose MORE engine-rejected actions. Rejections are recorded
// in result.rejectedDetails ({type, reason, version}) — NOT in result.actions (which only holds completed
// commands), so they must be read from there. We count rejections attributed to the OPT version (the side
// we're changing); the BASE version's count is its own inherited floor. There is a non-zero inherited floor
// today (the core findTarget->GameAction mapping in v0.1/v0.2 sometimes proposes attack_not_available), so
// the gate is "no increase vs the recorded baseline" rather than "exactly zero".
let rejected = 0;
const rejByFlavor = {};
for (const l of readFileSync(jsonl, "utf8").split("\n")) {
    if (!l) continue;
    try {
        for (const d of JSON.parse(l).result.rejectedDetails ?? []) {
            if (d.version !== OPT) continue;
            rejected += 1;
            const k = `${d.type} :: ${d.reason ?? "?"}`;
            rejByFlavor[k] = (rejByFlavor[k] ?? 0) + 1;
        }
    } catch {
        /* skip */
    }
}
const flavorStr = Object.entries(rejByFlavor)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
// First measured cycle seeds the rejection baseline; later cycles must not exceed it.
if (state.baselineRejected == null) {
    state.baselineRejected = rejected;
}
const rejectionsOk = rejected <= state.baselineRejected;
console.log(`${OPT} rejected actions: ${rejected} (baseline ${state.baselineRejected})${flavorStr ? " — " + flavorStr : ""}`);

// 3) Decide. Win rate must clear baseline + gainPP AND rejections must not increase over the floor.
const improved = pct >= state.baselinePct + gainPP && rejectionsOk;
if (!rejectionsOk && pct >= state.baselinePct + gainPP) {
    revert();
    record("REVERT(rejections)", pct, `${rejected} rejected > floor ${state.baselineRejected} (${flavorStr})`);
    console.log(`REVERT: rejections rose to ${rejected} (floor ${state.baselineRejected}) — reverted despite ${pct.toFixed(2)}%.`);
    process.exit(0);
}
if (improved) {
    sh(`git add ${OPT_FILE}`);
    sh(`git commit -q -m "${OPT} optimizer: ${summary.replace(/"/g, "'")} (${pct.toFixed(2)}% vs ${state.baselinePct.toFixed(2)}%)"`);
    state.baselinePct = pct;
    state.baselineRejected = Math.min(state.baselineRejected, rejected); // ratchet the floor down, never up
    state.accepted = (state.accepted ?? 0) + 1;
    record("ACCEPT", pct, `(+${(pct - (state.baselinePct - (pct - state.baselinePct))).toFixed(2)}pp, rej ${rejected})`);
    console.log(`ACCEPT: ${OPT} ${pct.toFixed(2)}% — committed. New baseline ${pct.toFixed(2)}%, rejection floor ${state.baselineRejected}.`);
} else {
    revert();
    record("REVERT", pct, `(<${gainPP}pp gain)`);
    console.log(`REVERT: ${OPT} ${pct.toFixed(2)}% < baseline ${state.baselinePct.toFixed(2)}% + ${gainPP}pp — reverted.`);
}

// 4) Refresh the loss analysis for the next cycle to target.
try {
    const report = sh(`node src/simulation/optimizer/analyze.mjs ${JSON.stringify(jsonl)} ${OPT} ${BASE}`);
    console.log("\n" + report);
} catch {
    /* analysis is best-effort */
}
