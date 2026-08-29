// B2 — fit the WAIT-CANCELLATION classifier: a logistic model over the same 41-dim wait-scorer basis,
// trained on the B2 oracle's counterfactual-labeled POLICY-WAIT points (search_driver.ts, cf:1 rows:
// the deployed scorer created a wait and the oracle scored {standing wait, the exact action it
// replaced} to the end-of-lap paired-seed horizon).
//
// Label here is CANCEL = 1 iff the oracle judged the wait a mistake (row y=0: acting beat the wait by
// more than the gate). The fit set is clean counterfactuals only (cf=1, rej=0, ii=0, finite d);
// held-out split is BY GAME SEED, never by decision.
//
// Deployment shape: a second linear gate INSIDE the scorer stage — wait iff z > 0 AND cancel-score <= 0
// — so no runtime side channels are needed: the cancel model refines the same decision boundary with
// the same features at the same point.
//
// Usage: bun fit_b2_cancel.mjs <dataset.jsonl> [epochs=400] [lr=0.5] [l2=0.0001] [out.json]
import { readFileSync, writeFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";

const FILE = process.argv[2];
const EPOCHS = Number(process.argv[3] ?? 400);
const LR = Number(process.argv[4] ?? 0.5);
const L2 = Number(process.argv[5] ?? 0.0001);
const OUT = process.argv[6];
if (!FILE) {
    console.error("usage: bun fit_b2_cancel.mjs <dataset.jsonl> [epochs] [lr] [l2] [out.json]");
    process.exit(1);
}

const NAMES = [...WAIT_FEATURE_NAMES];
const D = NAMES.length;

const all = readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.t === "q2d");
const cf = all.filter((r) => r.cf === 1 && r.rej === 0 && (r.ii ?? 0) === 0 && typeof r.d === "number");
for (const r of cf) {
    if (!Array.isArray(r.f) || r.f.length !== D) {
        throw new Error(`row feature width ${r.f?.length} != WAIT_FEATURE_NAMES ${D} — regenerate the dataset`);
    }
    // CANCEL label: oracle y=1 means the wait STANDS; the classifier predicts the mistake class.
    r.yc = r.y === 0 ? 1 : 0;
}
console.log(`rows: total=${all.length} counterfactual fit set=${cf.length}`);
console.log(`cancellation share: ${((100 * cf.reduce((a, r) => a + r.yc, 0)) / cf.length).toFixed(2)}%`);

const seeds = [...new Set(cf.map((r) => r.s))].sort((a, b) => a - b);
const hash = (n) => {
    let x = n >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
};
const testSeeds = new Set(seeds.filter((s) => hash(s) < 0.15));
const train = cf.filter((r) => !testSeeds.has(r.s));
const test = cf.filter((r) => testSeeds.has(r.s));
console.log(`split by seed: ${seeds.length} seeds -> train ${train.length} / test ${test.length}`);

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
        const err = sigmoid(z) - r.yc;
        for (let i = 0; i < D; i++) gw[i] += err * f[i];
        gb += err;
    }
    for (let i = 0; i < D; i++) w[i] -= LR * (gw[i] / train.length + L2 * w[i]);
    b -= (LR * gb) / train.length;
}

const modelZ = (r) => {
    let z = b;
    for (let i = 0; i < D; i++) z += w[i] * r.f[i];
    return z;
};
const evalSet = (set, score, label) => {
    let ll = 0;
    let correct = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of set) {
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(score(r))));
        ll += -(r.yc * Math.log(p) + (1 - r.yc) * Math.log(1 - p));
        const pred = p >= 0.5 ? 1 : 0;
        if (pred === r.yc) correct++;
        if (pred === 1 && r.yc === 1) tp++;
        if (pred === 1 && r.yc === 0) fp++;
        if (pred === 0 && r.yc === 1) fn++;
    }
    const scored = set.map((r) => ({ s: score(r), y: r.yc })).sort((a, c) => a.s - c.s);
    let i = 0;
    let rankSumPos = 0;
    let nPos = 0;
    while (i < scored.length) {
        let j = i;
        while (j < scored.length && scored[j].s === scored[i].s) j++;
        const avgRank = (i + j + 1) / 2;
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
    // Tail capture in DELTA terms: rows the model cancels should carry the NEGATIVE wait-minus-act mass.
    let dCancel = 0;
    let nCancel = 0;
    let dKeep = 0;
    let nKeep = 0;
    for (const r of set) {
        if (sigmoid(score(r)) >= 0.5) {
            dCancel += r.d;
            nCancel++;
        } else {
            dKeep += r.d;
            nKeep++;
        }
    }
    return {
        label,
        acc: ((100 * correct) / set.length).toFixed(2),
        logloss: (ll / set.length).toFixed(4),
        auc: Number.isNaN(auc) ? "n/a" : auc.toFixed(4),
        cancelRate: ((100 * (tp + fp)) / set.length).toFixed(1),
        precision: tp + fp ? ((100 * tp) / (tp + fp)).toFixed(1) : "n/a",
        recall: tp + fn ? ((100 * tp) / (tp + fn)).toFixed(1) : "n/a",
        meanDeltaCancelled: nCancel ? (dCancel / nCancel).toFixed(5) : "n/a",
        meanDeltaKept: nKeep ? (dKeep / nKeep).toFixed(5) : "n/a",
    };
};

const BIG = 50;
console.log("\n=== held-out test (split by game seed) ===");
console.log(JSON.stringify(evalSet(test, modelZ, "LEARNED cancel classifier")));
console.log(JSON.stringify(evalSet(test, () => -BIG, "baseline: never-cancel (deployed behavior)")));
console.log(JSON.stringify(evalSet(test, () => BIG, "baseline: always-cancel")));

if (OUT) {
    writeFileSync(OUT, JSON.stringify({ b, w }));
    console.log(`\nweights written to ${OUT}`);
}
