// Q2 Gate-2 — fit the WAIT-SCORER: a logistic classifier distilling the Gate-1 act-vs-wait lap-rollout
// oracle (search_driver.ts Q2_ORACLE + Q2_DATASET) into V07_WAIT_WEIGHTS for ai/versions/wait_scorer.ts.
//
// Input rows (JSONL, one per wait-eligible decision point on the oracle side):
//   {t:"q2d", s: seed, g, r, lap, u, k, iw, rej, y, d, f:[WAIT_FEATURE_NAMES...]}
// The FIT SET is scored points only (iw=0, rej=0): the incumbent acted and the oracle arbitrated; label
// y = 1 iff the oracle overrode to wait. Held-out split is BY GAME SEED (both side-swap games of a pair
// share the seed), never by decision — decisions within a game are heavily correlated.
//
// Reports held-out accuracy / log-loss / AUC vs the trivial baselines (always-act; the incumbent v0.5
// hourglass rule's verdict = the incRuleWait feature; fm>=0.67 alone) plus tail-capture diagnostics
// (mean rollout delta of predicted waits — Gate-1's value was TAIL discrimination, meanDelta ~ 0).
//
// Usage: bun fit_wait.mjs <dataset.jsonl> [epochs=400] [lr=0.5] [l2=0.0001]
import { readFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";

const FILE = process.argv[2];
const EPOCHS = Number(process.argv[3] ?? 400);
const LR = Number(process.argv[4] ?? 0.5);
const L2 = Number(process.argv[5] ?? 0.0001);
if (!FILE) {
    console.error("usage: bun fit_wait.mjs <dataset.jsonl> [epochs] [lr] [l2]");
    process.exit(1);
}

const NAMES = [...WAIT_FEATURE_NAMES];
const D = NAMES.length;
const idx = (name) => {
    const i = NAMES.indexOf(name);
    if (i < 0) throw new Error(`feature ${name} missing from WAIT_FEATURE_NAMES`);
    return i;
};
const FM = idx("fmExposure");
const INC_RULE = idx("incRuleWait");

const all = readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.t === "q2d");
const kept = all.filter((r) => r.iw === 1);
const rows = all.filter((r) => r.iw === 0 && r.rej === 0);
for (const r of rows) {
    if (!Array.isArray(r.f) || r.f.length !== D) {
        throw new Error(`row feature width ${r.f?.length} != WAIT_FEATURE_NAMES ${D} — regenerate the dataset`);
    }
}
console.log(`rows: total=${all.length} keptWait(iw=1)=${kept.length} scored(fit set)=${rows.length}`);
console.log(
    `scored wait share (oracle overrides): ${((100 * rows.reduce((a, r) => a + r.y, 0)) / rows.length).toFixed(2)}%`,
);

// --- split BY GAME SEED (deterministic hash), 85/15 ---
const seeds = [...new Set(rows.map((r) => r.s))].sort((a, b) => a - b);
const hash = (n) => {
    let x = n >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
};
const testSeeds = new Set(seeds.filter((s) => hash(s) < 0.15));
const train = rows.filter((r) => !testSeeds.has(r.s));
const test = rows.filter((r) => testSeeds.has(r.s));
console.log(
    `split by seed: ${seeds.length} seeds -> train ${train.length} rows / test ${test.length} rows (${testSeeds.size} test seeds)`,
);

// --- logistic regression (batch GD + L2, features are already ~[-1,1] normalized) ---
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const w = new Array(D).fill(0);
let b = 0;
for (let e = 0; e < EPOCHS; e++) {
    const gw = new Array(D).fill(0);
    let gb = 0;
    for (const r of train) {
        const f = r.f;
        let z = b;
        for (let i = 0; i < D; i++) z += w[i] * f[i];
        const err = sigmoid(z) - r.y;
        for (let i = 0; i < D; i++) gw[i] += err * f[i];
        gb += err;
    }
    for (let i = 0; i < D; i++) w[i] -= LR * (gw[i] / train.length + L2 * w[i]);
    b -= (LR * gb) / train.length;
}

// --- evaluation ---
const modelZ = (r) => {
    let z = b;
    for (let i = 0; i < D; i++) z += w[i] * r.f[i];
    return z;
};
const evalScores = (set, score, label) => {
    let ll = 0;
    let correct = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of set) {
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(score(r))));
        ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
        const pred = p >= 0.5 ? 1 : 0;
        if (pred === r.y) correct++;
        if (pred === 1 && r.y === 1) tp++;
        if (pred === 1 && r.y === 0) fp++;
        if (pred === 0 && r.y === 1) fn++;
    }
    // rank AUC with average ranks for ties
    const scored = set.map((r) => ({ s: score(r), y: r.y })).sort((a, c) => a.s - c.s);
    let i = 0;
    let rankSumPos = 0;
    let nPos = 0;
    while (i < scored.length) {
        let j = i;
        while (j < scored.length && scored[j].s === scored[i].s) j++;
        const avgRank = (i + j + 1) / 2; // 1-based average rank of the tie block
        for (let k = i; k < j; k++) {
            if (scored[k].y === 1) {
                rankSumPos += avgRank;
                nPos++;
            }
        }
        i = j;
    }
    const nNeg = set.length - nPos;
    const auc = nPos && nNeg ? (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
    // tail capture: does the predicted-wait set carry the positive rollout-delta mass?
    let dWait = 0;
    let nWait = 0;
    let dAct = 0;
    let nAct = 0;
    for (const r of set) {
        if (typeof r.d !== "number") continue;
        if (sigmoid(score(r)) >= 0.5) {
            dWait += r.d;
            nWait++;
        } else {
            dAct += r.d;
            nAct++;
        }
    }
    return {
        label,
        acc: ((100 * correct) / set.length).toFixed(2),
        logloss: (ll / set.length).toFixed(4),
        auc: Number.isNaN(auc) ? "n/a" : auc.toFixed(4),
        waitRate: ((100 * (tp + fp)) / set.length).toFixed(1),
        precision: tp + fp ? ((100 * tp) / (tp + fp)).toFixed(1) : "n/a",
        recall: tp + fn ? ((100 * tp) / (tp + fn)).toFixed(1) : "n/a",
        meanDeltaPredWait: nWait ? (dWait / nWait).toFixed(5) : "n/a",
        meanDeltaPredAct: nAct ? (dAct / nAct).toFixed(5) : "n/a",
    };
};

const BIG = 50; // pushes sigmoid to ~0/1 for the hard-rule baselines
const baselineAlwaysAct = () => -BIG;
const baselineIncRule = (r) => (r.f[INC_RULE] >= 0.5 ? BIG : -BIG);
const baselineFm = (r) => (r.f[FM] >= 0.67 ? BIG : -BIG);

console.log("\n=== held-out test (split by game seed) ===");
for (const [score, label] of [
    [modelZ, "LEARNED wait-scorer"],
    [baselineAlwaysAct, "baseline: always-act"],
    [baselineIncRule, "baseline: incumbent v0.5 rule (incRuleWait)"],
    [baselineFm, "baseline: fm>=0.67 alone"],
]) {
    console.log(JSON.stringify(evalScores(test, score, label)));
}
console.log("train (sanity):", JSON.stringify(evalScores(train, modelZ, "LEARNED on train")));

console.log("\n=== learned weights ===");
console.log("bias:", b.toFixed(4));
NAMES.forEach((n, i) => console.log(`  ${n}: ${w[i].toFixed(4)}`));
console.log(
    "\nV07_WAIT_WEIGHTS JSON:",
    JSON.stringify({ b: Number(b.toFixed(5)), w: w.map((x) => Number(x.toFixed(5))) }),
);
