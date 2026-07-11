// Phase-B MULTI-COHORT refit of the WAIT-SCORER (Q2 Gate-2 v2): distills the Gate-1 act-vs-wait
// lap-rollout oracle into V07_WAIT_WEIGHTS_V2 with UNIT-CLASS-CONDITIONAL structure.
//
// The v1 distilled weights were fit on LIVETWIN MELEE-draft oracle games (RANGE 0.19% of rows) and had
// to be guarded to melee support (guard-zero = ranged parity, no ranged tempo policy). This trainer
// consumes Q2_DATASET_V2=1 dumps (search_driver oracle mode; rows carry WAIT_FEATURE_NAMES_V2_RAW, 49
// dims) generated ACROSS cohorts, and fits two candidate structures:
//   A: linear over the 49 raw dims (padded to the 98-dim deployed basis with a zero xR_ block)
//   B: the full 98-dim deployed basis (raw + isRanged interaction copy = shared + ranged-delta blocks)
// Held-out split is BY GAME SEED within each cohort. Reports per-cohort AND per-unit-class held-out
// acc/AUC vs baselines (always-act, incumbent rule, the v1 distilled weights, v1+deployed-guard).
// Prints V07_WAIT_WEIGHTS_V2 JSON (98 dims) for BOTH structures; ship the better held-out one.
//
// Usage: bun fit_wait_v2.mjs melee=q2d.jsonl mixed=... ranged=... [...] [epochs=400] [lr=0.5] [l2=0.0001]
import { readFileSync } from "node:fs";

import {
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    WAIT_FEATURE_NAMES,
    WAIT_FEATURE_NAMES_V2,
    WAIT_FEATURE_NAMES_V2_RAW,
    expandWaitFeaturesV2,
} from "../../ai/versions/wait_scorer";

const args = process.argv.slice(2);
const fileArgs = args.filter((a) => a.includes("="));
const numArgs = args.filter((a) => !a.includes("=")).map(Number);
const EPOCHS = numArgs[0] ?? 400;
const LR = numArgs[1] ?? 0.5;
const L2 = numArgs[2] ?? 0.0001;
if (!fileArgs.length) {
    console.error("usage: bun fit_wait_v2.mjs <cohort>=<q2d.jsonl> [...] [epochs] [lr] [l2]");
    process.exit(1);
}

const RAW = [...WAIT_FEATURE_NAMES_V2_RAW];
const D_RAW = RAW.length; // 49
const D1 = WAIT_FEATURE_NAMES.length; // 41
const D2 = WAIT_FEATURE_NAMES_V2.length; // 98
const idx = (name) => {
    const i = RAW.indexOf(name);
    if (i < 0) throw new Error(`feature ${name} missing`);
    return i;
};
const FM = idx("fmExposure");
const INC_RULE = idx("incRuleWait");
const IS_MELEE = idx("isMelee");
const IS_RANGED = idx("isRanged");
const OWN_MELEE_FRAC = idx("ownMeleeFrac");

/** rows: { f: raw49, x: expanded98, y, d, s, cohort } (fit set: iw=0 rej=0 only). */
const rows = [];
let kept = 0;
let rejected = 0;
for (const arg of fileArgs) {
    const eq = arg.indexOf("=");
    const cohort = arg.slice(0, eq);
    const path = arg.slice(eq + 1);
    let n = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const r = JSON.parse(line);
        if (r.t !== "q2d") continue;
        if (r.iw === 1) {
            kept += 1;
            continue;
        }
        if (r.rej === 1) {
            rejected += 1;
            continue;
        }
        if (!Array.isArray(r.f) || r.f.length !== D_RAW) {
            throw new Error(`${cohort}: row width ${r.f?.length} != ${D_RAW} — regenerate with Q2_DATASET_V2=1`);
        }
        rows.push({ f: r.f, x: expandWaitFeaturesV2(r.f), y: r.y, d: r.d, s: r.s, cohort });
        n += 1;
    }
    console.log(`${cohort}: ${n} scored rows from ${path}`);
}
console.log(`total scored rows: ${rows.length} (keptWait iw=1: ${kept}, rejected: ${rejected})`);
console.log(`oracle wait share: ${((100 * rows.reduce((a, r) => a + r.y, 0)) / rows.length).toFixed(2)}%`);

// --- split BY GAME SEED, 15% held-out ---
const hash = (n) => {
    let x = n >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
};
const train = rows.filter((r) => hash(r.s) >= 0.15);
const test = rows.filter((r) => hash(r.s) < 0.15);
console.log(`split by seed: train ${train.length} / test ${test.length}`);

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function fitLogistic(set, dims, featOf, epochs, lr, l2) {
    const w = new Array(dims).fill(0);
    let b = 0;
    for (let e = 0; e < epochs; e++) {
        const gw = new Array(dims).fill(0);
        let gb = 0;
        for (const r of set) {
            const f = featOf(r);
            let z = b;
            for (let i = 0; i < dims; i++) z += w[i] * f[i];
            const err = sigmoid(z) - r.y;
            for (let i = 0; i < dims; i++) gw[i] += err * f[i];
            gb += err;
        }
        for (let i = 0; i < dims; i++) w[i] -= lr * (gw[i] / set.length + l2 * w[i]);
        b -= (lr * gb) / set.length;
    }
    return { b, w };
}

const evalScores = (set, score) => {
    if (!set.length) return { n: 0 };
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
    const scored = set.map((r) => ({ s: score(r), y: r.y })).sort((a, c) => a.s - c.s);
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
    let dWait = 0;
    let nWait = 0;
    for (const r of set) {
        if (typeof r.d !== "number") continue;
        if (sigmoid(score(r)) >= 0.5) {
            dWait += r.d;
            nWait++;
        }
    }
    return {
        n: set.length,
        acc: ((100 * correct) / set.length).toFixed(2),
        logloss: (ll / set.length).toFixed(4),
        auc: Number.isNaN(auc) ? "n/a" : auc.toFixed(4),
        waitRate: ((100 * (tp + fp)) / set.length).toFixed(1),
        precision: tp + fp ? ((100 * tp) / (tp + fp)).toFixed(1) : "n/a",
        recall: tp + fn ? ((100 * tp) / (tp + fn)).toFixed(1) : "n/a",
        meanDeltaPredWait: nWait ? (dWait / nWait).toFixed(5) : "n/a",
    };
};

console.log(`\nfitting A (linear ${D_RAW}) and B (class-conditional ${D2})...`);
const t0 = Date.now();
const fitA = fitLogistic(train, D_RAW, (r) => r.f, EPOCHS, LR, L2);
console.log(`A done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const t1 = Date.now();
const fitB = fitLogistic(train, D2, (r) => r.x, EPOCHS, LR, L2);
console.log(`B done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

const BIG = 50;
const v1 = DISTILLED_WAIT_WEIGHTS_2026_07_10;
const scoreV1 = (r) => {
    let z = v1.b;
    for (let i = 0; i < D1; i++) z += v1.w[i] * r.f[i];
    return z;
};
// v1 + the DEPLOYED training-support guard (support mode): out-of-support => act.
const scoreV1Guarded = (r) => (r.f[IS_MELEE] >= 0.5 && r.f[OWN_MELEE_FRAC] > 0.5 ? scoreV1(r) : -BIG);
const models = [
    ["baseline: always-act", () => -BIG],
    ["baseline: incumbent v0.5 rule", (r) => (r.f[INC_RULE] >= 0.5 ? BIG : -BIG)],
    ["baseline: fm>=0.67", (r) => (r.f[FM] >= 0.67 ? BIG : -BIG)],
    ["v1 distilled (unguarded)", scoreV1],
    ["v1 distilled + deployed guard", scoreV1Guarded],
    [
        "A: linear49",
        (r) => {
            let z = fitA.b;
            for (let i = 0; i < D_RAW; i++) z += fitA.w[i] * r.f[i];
            return z;
        },
    ],
    [
        "B: class-conditional 98",
        (r) => {
            let z = fitB.b;
            for (let i = 0; i < D2; i++) z += fitB.w[i] * r.x[i];
            return z;
        },
    ],
];

const cohorts = [...new Set(rows.map((r) => r.cohort))];
const classes = [
    ["MELEE-class", (r) => r.f[IS_MELEE] >= 0.5],
    ["RANGE-class", (r) => r.f[IS_RANGED] >= 0.5],
    ["OTHER-class", (r) => r.f[IS_MELEE] < 0.5 && r.f[IS_RANGED] < 0.5],
];
console.log("\n=== held-out test (split by game seed) ===");
for (const [label, score] of models) {
    console.log(`\n--- ${label} ---`);
    console.log("  POOLED:", JSON.stringify(evalScores(test, score)));
    for (const c of cohorts) {
        console.log(
            `  cohort ${c}:`,
            JSON.stringify(
                evalScores(
                    test.filter((r) => r.cohort === c),
                    score,
                ),
            ),
        );
    }
    for (const [cls, pred] of classes) {
        console.log(`  ${cls}:`, JSON.stringify(evalScores(test.filter(pred), score)));
    }
}

// Deployed-basis JSON for both: A padded with a zero xR_ block to the 98-dim basis.
const padA = { b: fitA.b, w: [...fitA.w, ...new Array(D2 - D_RAW).fill(0)] };
const round = (m) => JSON.stringify({ b: Number(m.b.toFixed(5)), w: m.w.map((x) => Number(x.toFixed(5))) });
console.log("\nV07_WAIT_WEIGHTS_V2 JSON (A, linear49 padded):", round(padA));
console.log("\nV07_WAIT_WEIGHTS_V2 JSON (B, class-conditional 98):", round(fitB));
console.log("\n=== B weights by name ===");
console.log("bias:", fitB.b.toFixed(4));
WAIT_FEATURE_NAMES_V2.forEach((n, i) => {
    if (Math.abs(fitB.w[i]) >= 0.05) console.log(`  ${n}: ${fitB.w[i].toFixed(4)}`);
});
