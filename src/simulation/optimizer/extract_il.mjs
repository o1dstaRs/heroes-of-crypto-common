// SEARCH_IL_DATASET v3 dumps -> complete, provenance-bound extraction rows.
//
// Usage: bun src/simulation/optimizer/extract_il.mjs out=<rows.jsonl> fingerprint=<64hex> versions=<teacher>,<student>
//        <cohort>=<dump.ild.jsonl> games.<cohort>=<n> base.<cohort>=<seed> [...]
import { readFileSync, writeFileSync } from "node:fs";

import {
    IL_FEATURE_FINGERPRINTS,
    IL_MODEL_INPUT_CONTRACT,
    requireIlRunFingerprint,
    validateIlCorpus,
} from "../il_dataset";
import { deriveTeacherConfidence } from "./il_fit_core.mjs";

const paths = new Map();
const expectedGames = new Map();
const baseSeeds = new Map();
let outPath = null;
let runFingerprint = null;
let versions = null;
const put = (map, key, value, label) => {
    if (!key || map.has(key)) throw new Error(`Duplicate or empty ${label}: ${key}`);
    map.set(key, value);
};
for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) throw new Error(`Arguments must be key=value; got ${arg}`);
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (!value) throw new Error(`Argument ${key} requires a value`);
    if (key === "out") {
        if (outPath) throw new Error("Duplicate out=");
        outPath = value;
    } else if (key === "fingerprint") {
        if (runFingerprint) throw new Error("Duplicate fingerprint=");
        runFingerprint = requireIlRunFingerprint(value, "fingerprint");
    } else if (key === "versions") {
        if (versions) throw new Error("Duplicate versions=");
        const parsed = value.split(",").map((version) => version.trim());
        if (parsed.length !== 2 || parsed.some((version) => !version) || parsed[0] === parsed[1]) {
            throw new Error("versions= requires exactly two distinct comma-separated strategy versions");
        }
        versions = parsed;
    } else if (key.startsWith("games.")) {
        put(expectedGames, key.slice("games.".length), Number(value), "games cohort");
    } else if (key.startsWith("base.")) {
        put(baseSeeds, key.slice("base.".length), Number(value), "base cohort");
    } else {
        put(paths, key, value, "dataset cohort");
    }
}
if (!outPath || !runFingerprint || !versions || !paths.size) {
    throw new Error(
        "Usage: extract_il.mjs out=<rows.jsonl> fingerprint=<64hex> versions=<teacher>,<student> " +
            "<cohort>=<dump> games.<cohort>=<n> base.<cohort>=<seed> [...]",
    );
}
for (const cohort of paths.keys()) {
    if (!expectedGames.has(cohort) || !baseSeeds.has(cohort)) {
        throw new Error(`${cohort}: games.${cohort}= and base.${cohort}= are required`);
    }
}
for (const cohort of [...expectedGames.keys(), ...baseSeeds.keys()]) {
    if (!paths.has(cohort)) throw new Error(`${cohort}: count/seed metadata has no dataset path`);
}

const quantile = (sorted, q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : "n/a");
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

const outLines = [];
const gamesByCohort = {};
const pooled = {
    decisions: 0,
    agree: 0,
    weight: 0,
    forced: 0,
    byClass: new Map(),
    agreeByClass: new Map(),
    byIncClass: new Map(),
};
let sharedConfig = null;
console.log(`extract_il v3: fingerprint=${runFingerprint} schema=${IL_FEATURE_FINGERPRINTS.schema}`);
for (const [cohort, path] of paths) {
    const corpus = validateIlCorpus(readFileSync(path, "utf8").split("\n"), {
        runFingerprint,
        cohort,
        expectedGames: expectedGames.get(cohort),
        baseSeed: baseSeeds.get(cohort),
        versions,
    });
    const config = JSON.stringify(corpus.config);
    if (sharedConfig !== null && sharedConfig !== config) throw new Error(`${cohort}: search configuration drifted`);
    sharedConfig = config;
    gamesByCohort[cohort] = corpus.games.length;
    const nCands = [];
    let overrides = 0;
    let agree = 0;
    let weight = 0;
    let forced = 0;
    for (const row of corpus.decisions) {
        nCands.push(row.cands.length);
        if (row.ov === 1) overrides += 1;
        const cls = row.cands[row.chosen].ck;
        const agreed = row.cands[row.chosen].sig === row.cands[0].sig ? 1 : 0;
        const teacher = deriveTeacherConfidence(
            row.cands.map((candidate) => candidate.m),
            row.cands.map((candidate) => candidate.sig),
            row.chosen,
            row.cfg.gate,
        );
        agree += agreed;
        weight += teacher.weight;
        if (teacher.forced) forced += 1;
        pooled.decisions += 1;
        pooled.agree += agreed;
        pooled.weight += teacher.weight;
        if (teacher.forced) pooled.forced += 1;
        bump(pooled.byClass, cls);
        if (agreed) bump(pooled.agreeByClass, cls);
        bump(pooled.byIncClass, row.k);
        outLines.push(
            JSON.stringify({
                t: "ilx",
                v: 3,
                runFingerprint,
                featureFingerprints: IL_FEATURE_FINGERPRINTS,
                c: cohort,
                s: row.seed,
                side: row.side,
                lap: row.lap,
                unit: row.unit,
                cls,
                chosen: row.chosen,
                targetSig: teacher.targetSignature,
                agree: agreed,
                teacherMargin: teacher.margin,
                teacherWeight: teacher.weight,
                teacherForced: teacher.forced ? 1 : 0,
                wf: row.wf,
                vf: row.vf,
                cands: row.cands.map((candidate) => ({
                    ck: candidate.ck,
                    sig: candidate.sig,
                    cf: candidate.cf,
                    am: candidate.am,
                    af: candidate.af,
                })),
                m: row.cands.map((candidate) => candidate.m),
            }),
        );
    }
    if (!corpus.decisions.length) throw new Error(`${cohort}: complete corpus has no scored decisions`);
    nCands.sort((left, right) => left - right);
    const meanCands = nCands.reduce((sum, count) => sum + count, 0) / nCands.length;
    console.log(
        `${cohort}: ${corpus.decisions.length} decisions / ${corpus.games.length} complete games (${path})` +
            ` | overrides ${pct(overrides, corpus.decisions.length)} | agreement ${pct(agree, corpus.decisions.length)}` +
            ` | teacher weight ${(weight / corpus.decisions.length).toFixed(3)} | forced ${forced}` +
            ` | candidates mean ${meanCands.toFixed(1)} p50 ${quantile(nCands, 0.5)}` +
            ` p95 ${quantile(nCands, 0.95)} max ${nCands[nCands.length - 1]}`,
    );
}

const completion = JSON.stringify({
    t: "ilx_complete",
    v: 3,
    runFingerprint,
    featureFingerprints: IL_FEATURE_FINGERPRINTS,
    modelInputContract: IL_MODEL_INPUT_CONTRACT,
    versions,
    decisions: outLines.length,
    gamesByCohort,
    config: JSON.parse(sharedConfig),
});
writeFileSync(outPath, `${[...outLines, completion].join("\n")}\n`);
console.log(`\nwrote ${outLines.length} training rows plus completion footer -> ${outPath}`);
console.log(`pooled policy agreement: ${pct(pooled.agree, pooled.decisions)}`);
console.log(
    `mean teacher weight: ${(pooled.weight / pooled.decisions).toFixed(3)} | forced-only rows: ${pooled.forced}`,
);
console.log("class balance of the search's chosen action with per-class agreement:");
for (const [cls, count] of [...pooled.byClass.entries()].sort((left, right) => right[1] - left[1])) {
    console.log(
        `  ${cls.padEnd(12)} ${String(count).padStart(8)}  (${pct(count, pooled.decisions)} of decisions,` +
            ` agreement ${pct(pooled.agreeByClass.get(cls) ?? 0, count)})`,
    );
}
console.log("class balance of the incumbent decision:");
for (const [cls, count] of [...pooled.byIncClass.entries()].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${cls.padEnd(12)} ${String(count).padStart(8)}  (${pct(count, pooled.decisions)})`);
}
