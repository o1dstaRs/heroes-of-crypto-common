// B2 — NONLINEAR probe over the banked cancellation dataset: gradient-boosted depth-2 trees
// (logistic loss, quantile-binned features) on the same cf:1 fit set as fit_b2_cancel.mjs. The linear
// fit's AUC was 0.582 and its top-20% veto failed replication; this answers whether the tail is
// capturable at all with interactions, or whether the wait-cancellation axis closes for good.
//
// Usage: bun fit_b2_boost.mjs <dataset.jsonl> [rounds=300] [lr=0.1] [bins=32]
import { readFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";

const FILE = process.argv[2];
const ROUNDS = Number(process.argv[3] ?? 300);
const LR = Number(process.argv[4] ?? 0.1);
const BINS = Number(process.argv[5] ?? 32);
const D = WAIT_FEATURE_NAMES.length;

const all = readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.t === "q2d" && r.cf === 1 && r.rej === 0 && (r.ii ?? 0) === 0 && typeof r.d === "number");
for (const r of all) r.yc = r.y === 0 ? 1 : 0;
console.log(`fit set: ${all.length} rows, cancel share ${((100 * all.reduce((a, r) => a + r.yc, 0)) / all.length).toFixed(2)}%`);

const seeds = [...new Set(all.map((r) => r.s))].sort((a, b) => a - b);
const hash = (n) => {
    let x = n >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
};
const testSeeds = new Set(seeds.filter((s) => hash(s) < 0.15));
const train = all.filter((r) => !testSeeds.has(r.s));
const test = all.filter((r) => testSeeds.has(r.s));
console.log(`split: train ${train.length} / test ${test.length}`);

// --- quantile binning per feature (fit on train) ---
const edges = [];
for (let f = 0; f < D; f++) {
    const values = train.map((r) => r.f[f]).sort((a, b) => a - b);
    const e = [];
    for (let b = 1; b < BINS; b++) e.push(values[Math.floor((values.length * b) / BINS)]);
    edges.push(e);
}
const binOf = (x, e) => {
    let lo = 0;
    let hi = e.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x <= e[mid]) hi = mid;
        else lo = mid + 1;
    }
    return lo;
};
const binned = (set) => set.map((r) => ({ b: r.f.map((x, f) => binOf(x, edges[f])), yc: r.yc, d: r.d }));
const trainB = binned(train);
const testB = binned(test);

// --- gradient boosting, depth-2 trees, logistic loss ---
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const base = Math.log(train.reduce((a, r) => a + r.yc, 0) / train.filter((r) => !r.yc).length);
const scoreTrain = new Float64Array(trainB.length).fill(base);
const scoreTest = new Float64Array(testB.length).fill(base);
const trees = [];
const bestSplit = (rows, grad, hess, indices) => {
    let best = null;
    for (let f = 0; f < D; f++) {
        const gBin = new Float64Array(BINS);
        const hBin = new Float64Array(BINS);
        for (const i of indices) {
            gBin[rows[i].b[f]] += grad[i];
            hBin[rows[i].b[f]] += hess[i];
        }
        let gTot = 0;
        let hTot = 0;
        for (let b = 0; b < BINS; b++) {
            gTot += gBin[b];
            hTot += hBin[b];
        }
        let gL = 0;
        let hL = 0;
        for (let b = 0; b < BINS - 1; b++) {
            gL += gBin[b];
            hL += hBin[b];
            const hR = hTot - hL;
            if (hL < 50 || hR < 50) continue;
            const gain = (gL * gL) / (hL + 1) + ((gTot - gL) * (gTot - gL)) / (hR + 1) - (gTot * gTot) / (hTot + 1);
            if (!best || gain > best.gain) best = { gain, f, bin: b, gL, hL, gR: gTot - gL, hR };
        }
    }
    return best;
};
for (let round = 0; round < ROUNDS; round++) {
    const grad = new Float64Array(trainB.length);
    const hess = new Float64Array(trainB.length);
    for (let i = 0; i < trainB.length; i++) {
        const p = sigmoid(scoreTrain[i]);
        grad[i] = trainB[i].yc - p;
        hess[i] = p * (1 - p);
    }
    const allIdx = trainB.map((_, i) => i);
    const root = bestSplit(trainB, grad, hess, allIdx);
    if (!root) break;
    const leftIdx = [];
    const rightIdx = [];
    for (const i of allIdx) (trainB[i].b[root.f] <= root.bin ? leftIdx : rightIdx).push(i);
    const leftSplit = bestSplit(trainB, grad, hess, leftIdx);
    const rightSplit = bestSplit(trainB, grad, hess, rightIdx);
    const leafValue = (g, h) => (LR * g) / (h + 1);
    const tree = { f: root.f, bin: root.bin, left: null, right: null };
    for (const [side, idx, split] of [["left", leftIdx, leftSplit], ["right", rightIdx, rightSplit]]) {
        if (split) {
            let gLL = 0, hLL = 0, gLR = 0, hLR = 0;
            for (const i of idx) {
                if (trainB[i].b[split.f] <= split.bin) { gLL += grad[i]; hLL += hess[i]; }
                else { gLR += grad[i]; hLR += hess[i]; }
            }
            tree[side] = { f: split.f, bin: split.bin, l: leafValue(gLL, hLL), r: leafValue(gLR, hLR) };
        } else {
            let g = 0, h = 0;
            for (const i of idx) { g += grad[i]; h += hess[i]; }
            tree[side] = { l: leafValue(g, h), r: leafValue(g, h), f: 0, bin: -1 };
        }
    }
    trees.push(tree);
    const apply = (rowsSet, scores) => {
        for (let i = 0; i < rowsSet.length; i++) {
            const node = rowsSet[i].b[tree.f] <= tree.bin ? tree.left : tree.right;
            scores[i] += rowsSet[i].b[node.f] <= node.bin ? node.l : node.r;
        }
    };
    apply(trainB, scoreTrain);
    apply(testB, scoreTest);
}

// --- evaluation ---
const auc = (scores, rowsSet) => {
    const sorted = rowsSet.map((r, i) => ({ s: scores[i], y: r.yc })).sort((a, b) => a.s - b.s);
    let i = 0, rankSum = 0, nPos = 0;
    while (i < sorted.length) {
        let j = i;
        while (j < sorted.length && sorted[j].s === sorted[i].s) j++;
        const avg = (i + j + 1) / 2;
        for (let k = i; k < j; k++) if (sorted[k].y === 1) { rankSum += avg; nPos++; }
        i = j;
    }
    const nNeg = sorted.length - nPos;
    return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
};
console.log(`rounds used: ${trees.length}`);
console.log(`train AUC: ${auc(scoreTrain, trainB).toFixed(4)}`);
console.log(`TEST  AUC: ${auc(scoreTest, testB).toFixed(4)}`);
const order = testB.map((r, i) => ({ s: scoreTest[i], d: r.d, yc: r.yc })).sort((a, b) => b.s - a.s);
for (const pct of [5, 10, 20, 30]) {
    const k = Math.floor(order.length * pct / 100);
    const top = order.slice(0, k);
    const mass = top.reduce((a, r) => a + r.d, 0);
    const prec = top.reduce((a, r) => a + r.yc, 0) / k;
    console.log(`top ${pct}%: n=${k} precision=${(100 * prec).toFixed(1)}% meanDelta=${(mass / k).toFixed(4)}`);
}
