// Phase-B MULTI-COHORT refit of the learned VALUE LEAF (search_driver leaf eval).
//
// The committed 20-dim leaf (v0_7_value_weights.ts, 75.1% held-out) was fit on LIVETWIN MELEE drafts
// only — OOD on ranged/mixed boards. This trainer consumes VALUE_DATA_FEATURES=v2 dumps (battle_engine:
// [f0..f29, label, seed] rows, extractValueFeaturesV2 = base 20 + class/composition block) generated
// across cohorts, splits held-out BY GAME SEED, and reports per-cohort held-out accuracy/log-loss for:
//   - MATERIAL baseline (sigmoid(6*hpAdv))
//   - the COMMITTED 20-dim leaf (DEFAULT_V07_VALUE_WEIGHTS)
//   - a REFIT of the 20 base dims on the multi-cohort data (does the data alone fix it?)
//   - the full 30-dim V2 fit (do the composition dims earn their keep?)
// Prints V07_VALUE_WEIGHTS_V2 JSON for the 30-dim fit (and the 20-dim refit for reference).
//
// Usage: bun fit_value_v2.mjs melee=path.jsonl mixed=path.jsonl ranged=path.jsonl ... [epochs=300] [lr=0.5] [l2=0.0001]
import { readFileSync } from "node:fs";

import { DEFAULT_V07_VALUE_WEIGHTS } from "../v0_7_value_weights";
import {
    expandValueFeaturesV2,
    VALUE_FEATURE_NAMES,
    VALUE_FEATURE_NAMES_V2,
    VALUE_FEATURE_NAMES_V2_RAW,
} from "../value_features";

const args = process.argv.slice(2);
const fileArgs = args.filter((a) => a.includes("="));
const numArgs = args.filter((a) => !a.includes("=")).map(Number);
const EPOCHS = numArgs[0] ?? 300;
const LR = numArgs[1] ?? 0.5;
const L2 = numArgs[2] ?? 0.0001;
if (!fileArgs.length) {
    console.error("usage: bun fit_value_v2.mjs <cohort>=<data.jsonl> [...] [epochs] [lr] [l2]");
    process.exit(1);
}

const D2 = VALUE_FEATURE_NAMES_V2_RAW.length; // 30 (the dumped raw width)
const D1 = VALUE_FEATURE_NAMES.length; // 20
const ROW_W = D2 + 2; // raw features + label + seed

/** rows: { f: number[D2], y: 0|1, s: seed, cohort } */
const rows = [];
for (const arg of fileArgs) {
    const eq = arg.indexOf("=");
    const cohort = arg.slice(0, eq);
    const path = arg.slice(eq + 1);
    let n = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const r = JSON.parse(line);
        if (!Array.isArray(r) || r.length !== ROW_W) {
            throw new Error(`${cohort}: row width ${r.length} != ${ROW_W} — dump with VALUE_DATA_FEATURES=v2`);
        }
        rows.push({ f: r.slice(0, D2), y: r[D2], s: r[D2 + 1], cohort });
        n += 1;
    }
    console.log(`${cohort}: ${n} rows from ${path}`);
}
console.log(`total rows: ${rows.length}`);

// --- held-out split BY GAME SEED (deterministic hash, 15%) ---
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
/** Logistic fit; `prior` (optional {b, w}) turns L2 into SHRINKAGE TOWARD that point instead of zero. */
function fitLogisticOn(set, dims, featOf, epochs, lr, l2, prior) {
    const w0 = prior ? prior.w : new Array(dims).fill(0);
    const b0 = prior ? prior.b : 0;
    const w = w0.slice();
    let b = b0;
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
        for (let i = 0; i < dims; i++) w[i] -= lr * (gw[i] / set.length + l2 * (w[i] - w0[i]));
        b -= lr * (gb / set.length + l2 * (b - b0));
    }
    return { b, w };
}
const fitLogistic = (set, dims, epochs, lr, l2) => fitLogisticOn(set, dims, (r) => r.f, epochs, lr, l2);

const scoreOf = (model, dims) => (r) => {
    let z = model.b;
    for (let i = 0; i < dims; i++) z += model.w[i] * r.f[i];
    return z;
};
const evalSet = (set, score) => {
    let ll = 0;
    let correct = 0;
    for (const r of set) {
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(score(r))));
        ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
        if ((p >= 0.5 ? 1 : 0) === r.y) correct++;
    }
    return { n: set.length, acc: ((100 * correct) / set.length).toFixed(2), logloss: (ll / set.length).toFixed(4) };
};

// The DEPLOYED basis (VALUE_FEATURE_NAMES_V2): raw 30 + rangedness-interaction copy, expanded with the
// SAME shared function the search_driver leaf uses, so fitted weights wire into V07_VALUE_WEIGHTS_V2.
for (const r of rows) r.x = expandValueFeaturesV2(r.f);
const DX = VALUE_FEATURE_NAMES_V2.length;

console.log("fitting refit-20d, v2-30d, v2x-60d and v2xs-60d/shrunk (pooled multi-cohort train set)...");
const refit20 = fitLogistic(train, D1, EPOCHS, LR, L2);
const fit30 = fitLogistic(train, D2, EPOCHS, LR, L2);
const fitX = fitLogisticOn(train, DX, (r) => r.x, EPOCHS, LR, L2);
// Shrinkage-to-committed prior on the shared first-20 block: protects the melee-strong committed leaf
// while letting the composition + rangedness-delta dims fix the ranged/pure OOD. L2 here is the pull
// strength toward the prior, so use a visibly larger one than the plain fits' anti-overfit epsilon.
const priorX = {
    b: DEFAULT_V07_VALUE_WEIGHTS.b,
    w: [...DEFAULT_V07_VALUE_WEIGHTS.w, ...new Array(DX - D1).fill(0)],
};
const fitXS = fitLogisticOn(train, DX, (r) => r.x, EPOCHS, LR, Math.max(L2, 0.003), priorX);

const models = [
    ["MATERIAL (6*hpAdv)", (r) => 6 * r.f[0]],
    ["COMMITTED 20d leaf", scoreOf(DEFAULT_V07_VALUE_WEIGHTS, D1)],
    ["REFIT 20d (multi-cohort)", scoreOf(refit20, D1)],
    ["V2 30d (multi-cohort)", scoreOf(fit30, D2)],
    [
        "V2X 60d (rangedness-conditional)",
        (r) => {
            let z = fitX.b;
            for (let i = 0; i < DX; i++) z += fitX.w[i] * r.x[i];
            return z;
        },
    ],
    [
        "V2XS 60d (shrunk to committed)",
        (r) => {
            let z = fitXS.b;
            for (let i = 0; i < DX; i++) z += fitXS.w[i] * r.x[i];
            return z;
        },
    ],
];

const cohorts = [...new Set(rows.map((r) => r.cohort))];
console.log("\n=== held-out test accuracy / logloss (split by game seed) ===");
for (const [label, score] of models) {
    const per = cohorts.map((c) => {
        const e = evalSet(
            test.filter((r) => r.cohort === c),
            score,
        );
        return `${c}=${e.acc}%/${e.logloss}(n=${e.n})`;
    });
    const pooled = evalSet(test, score);
    console.log(`${label}: POOLED=${pooled.acc}%/${pooled.logloss} | ${per.join(" ")}`);
}

console.log("\n=== V2 raw-30d weights ===");
VALUE_FEATURE_NAMES_V2_RAW.forEach((n, i) => console.log(`  ${n}: ${fit30.w[i].toFixed(4)}`));
const round = (m) => JSON.stringify({ b: Number(m.b.toFixed(5)), w: m.w.map((x) => Number(x.toFixed(5))) });
const pad30 = { b: fit30.b, w: [...fit30.w, ...new Array(DX - D2).fill(0)] };
console.log("\nAll candidate JSONs are in the DEPLOYED V07_VALUE_WEIGHTS_V2 basis (width", DX, "):");
console.log("\nV07_VALUE_WEIGHTS_V2 JSON (raw-30d, zero xRg_ block):", round(pad30));
console.log("\nV07_VALUE_WEIGHTS_V2 JSON (V2X rangedness-conditional):", round(fitX));
console.log("\nV07_VALUE_WEIGHTS_V2 JSON (V2XS shrunk-to-committed):", round(fitXS));
console.log("\nREFIT-20d JSON (V07_VALUE_WEIGHTS width, reference only):", round(refit20));
