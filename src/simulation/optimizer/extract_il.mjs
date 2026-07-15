// IMITATION-LEARNING EXTRACTION (docs/imitation_pipeline.md, step 2): SEARCH_IL_DATASET dumps ->
// fit-ready training rows + dataset stats. One input file per cohort; one output line per SEARCHED
// decision: {c: cohort, s: seed, side, lap, unit, cls: search's chosen action class, chosen: index,
// agree: 1 iff the incumbent v0.7 policy already played the search's choice (semantic-signature
// equality, so a serialization twin of the incumbent counts as agreement), wf: the 41-dim wait-scorer
// state vector, cands: [{ck, sig, cf}] (F4 enumeration-time candidate features, IL_CANDIDATE_FEATURE_NAMES
// order), m: per-candidate mean rollout leaf values (null = illegal in simulation).
// The 60-dim value basis stays in the raw dump only — reread it there if a fit ever needs it.
//
// Usage: bun src/simulation/optimizer/extract_il.mjs out=<rows.jsonl> <cohort>=<dump.ild.jsonl> [...]
import { readFileSync, writeFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";
import { parseIlRow } from "../il_dataset";
import { VALUE_FEATURE_NAMES_V2 } from "../value_features";

const files = [];
let outPath = null;
for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) throw new Error(`Arguments must be key=value; got ${arg}`);
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (key === "out") {
        if (outPath) throw new Error("Duplicate out=");
        outPath = value;
        continue;
    }
    if (!key || !value) throw new Error(`Dataset arguments must be <cohort>=<path>; got ${arg}`);
    if (files.some((f) => f.cohort === key)) throw new Error(`Duplicate cohort: ${key}`);
    files.push({ cohort: key, path: value });
}
if (!outPath || !files.length) {
    throw new Error("Usage: extract_il.mjs out=<rows.jsonl> <cohort>=<dump.ild.jsonl> [...]");
}

const WF = WAIT_FEATURE_NAMES.length; // 41
const VF = VALUE_FEATURE_NAMES_V2.length; // 60

const quantile = (sorted, q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : "n/a");

const outLines = [];
const pooled = { decisions: 0, agree: 0, byClass: new Map(), agreeByClass: new Map(), byIncClass: new Map() };
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

console.log(`extract_il: wf=${WF} dims, vf=${VF} dims (validated per row)`);
for (const { cohort, path } of files) {
    const seeds = new Set();
    const nCands = [];
    let decisions = 0;
    let overrides = 0;
    let agree = 0;
    let badLines = 0;
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let row;
        try {
            row = parseIlRow(JSON.parse(line), WF, VF, `${cohort}:${i + 1}`);
        } catch (error) {
            // A concurrency-torn or truncated line is dropped and counted, never silently kept.
            badLines += 1;
            if (badLines <= 3) console.error(`  DROP ${cohort}:${i + 1}: ${error.message ?? error}`);
            continue;
        }
        seeds.add(row.seed);
        nCands.push(row.cands.length);
        decisions += 1;
        if (row.ov === 1) overrides += 1;
        const cls = row.cands[row.chosen].ck;
        const agreed = row.cands[row.chosen].sig === row.cands[0].sig ? 1 : 0;
        agree += agreed;
        pooled.decisions += 1;
        pooled.agree += agreed;
        bump(pooled.byClass, cls);
        if (agreed) bump(pooled.agreeByClass, cls);
        bump(pooled.byIncClass, row.k);
        outLines.push(
            JSON.stringify({
                c: cohort,
                s: row.seed,
                side: row.side,
                lap: row.lap,
                unit: row.unit,
                cls,
                chosen: row.chosen,
                agree: agreed,
                wf: row.wf,
                cands: row.cands.map((cand) => ({ ck: cand.ck, sig: cand.sig, cf: cand.cf })),
                m: row.cands.map((cand) => cand.m),
            }),
        );
    }
    if (!decisions) throw new Error(`${cohort}: no valid decisions in ${path}`);
    nCands.sort((a, b) => a - b);
    const meanCands = nCands.reduce((a, b) => a + b, 0) / nCands.length;
    console.log(
        `${cohort}: ${decisions} decisions from ${seeds.size} games (${path})` +
            ` | overrides ${pct(overrides, decisions)} | v0.7-agreement ${pct(agree, decisions)}` +
            ` | candidates mean ${meanCands.toFixed(1)} p50 ${quantile(nCands, 0.5)} p95 ${quantile(nCands, 0.95)}` +
            ` max ${nCands[nCands.length - 1]} | dropped lines ${badLines}`,
    );
}

writeFileSync(outPath, `${outLines.join("\n")}\n`);
console.log(`\nwrote ${outLines.length} training rows -> ${outPath}`);
console.log(`pooled v0.7-policy agreement (imitation headroom baseline): ${pct(pooled.agree, pooled.decisions)}`);
console.log("class balance of the search's CHOSEN action (cls) with per-class agreement:");
for (const [cls, n] of [...pooled.byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
        `  ${cls.padEnd(12)} ${String(n).padStart(8)}  (${pct(n, pooled.decisions)} of decisions,` +
            ` agreement ${pct(pooled.agreeByClass.get(cls) ?? 0, n)})`,
    );
}
console.log("class balance of the INCUMBENT v0.7 decision (k):");
for (const [cls, n] of [...pooled.byIncClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(12)} ${String(n).padStart(8)}  (${pct(n, pooled.decisions)})`);
}
