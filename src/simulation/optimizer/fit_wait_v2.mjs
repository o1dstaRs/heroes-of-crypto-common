// Phase-B MULTI-COHORT refit of the WAIT-SCORER (Q2 Gate-2 v2): distills the Gate-1 act-vs-wait
// lap-rollout oracle into V07_WAIT_WEIGHTS_V2/V3 with class- and incumbent-action-aware structures.
//
// The v1 distilled weights were fit on LIVETWIN MELEE-draft oracle games (RANGE 0.19% of rows) and had
// to be guarded to melee support (guard-zero = ranged parity, no ranged tempo policy). This trainer
// consumes self-describing Q2_DATASET_V2=1 dumps (search_driver oracle mode; rows carry a shared run
// fingerprint and WAIT_FEATURE_NAMES_V2_RAW, 49 dims) generated ACROSS cohorts, and fits four structures:
//   A: linear over the 49 raw dims (padded to the 98-dim deployed basis with a zero xR_ block)
//   B: the full 98-dim deployed basis (raw + isRanged interaction copy = shared + ranged-delta blocks)
//   C: delta regression over the 98-dim basis (experimental tail-discrimination candidate)
//   D: action-aware V3 delta regression (V2 + incumbent-kind, RANGE-kind, and caster-kind blocks)
// Held-out split is BY GAME SEED within each cohort. Reports per-cohort AND per-unit-class held-out
// acc/AUC vs baselines (always-act, incumbent rule, the v1 distilled weights, v1+deployed-guard).
// Prints V2 JSON for numerically stable fits and V3 JSON only after the held-out RANGE release gates pass.
//
// Usage: bun fit_wait_v2.mjs fingerprint=<64hex> melee=q2d.jsonl mixed=... [...] epochs=400 lr=0.5 l2=0.0001
// `lr` applies to logistic A/B. Ridge C/D use `epochs` as a fail-closed PCG iteration cap.
import { readFileSync } from "node:fs";

import {
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    WAIT_FEATURE_NAMES,
    WAIT_FEATURE_NAMES_V2,
    WAIT_FEATURE_NAMES_V2_RAW,
    WAIT_FEATURE_NAMES_V3,
    expandWaitFeaturesV2,
    expandWaitFeaturesV3,
    waitV3CanReplaceIncumbentKind,
} from "../../ai/versions/wait_scorer";
import { parsePhaseBFitterArgs, parsePhaseBQ2Row } from "../phase_b_dataset";
import { phaseBModelStabilityIssue } from "./model_stability";
import { fitStableRidge } from "./ridge_regression";
import { evaluateWaitV3HeldoutGates } from "./wait_v3_gates";

const parsedArgs = parsePhaseBFitterArgs(process.argv.slice(2), {
    epochs: 400,
    learningRate: 0.5,
    l2: 0.0001,
});
const { runFingerprint, files, epochs: EPOCHS, learningRate: LR, l2: L2 } = parsedArgs;

const RAW = [...WAIT_FEATURE_NAMES_V2_RAW];
const D_RAW = RAW.length; // 49
const D1 = WAIT_FEATURE_NAMES.length; // 41
const D2 = WAIT_FEATURE_NAMES_V2.length; // 98
const D3 = WAIT_FEATURE_NAMES_V3.length; // 125
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

/** Rows retain raw49, V2/V3 expansions, and incumbent kind; the fit excludes all degenerate candidates. */
const rows = [];
let kept = 0;
let illegal = 0;
let rejected = 0;
for (const { cohort, path } of files) {
    let n = 0;
    const lines = readFileSync(path, "utf8").split("\n");
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber].trim();
        if (!line) continue;
        const r = parsePhaseBQ2Row(JSON.parse(line), D_RAW, runFingerprint, `${cohort}:${lineNumber + 1}`);
        if (r.incumbentWait === 1) {
            kept += 1;
            continue;
        }
        if (r.incumbentIllegal === 1) illegal += 1;
        if (r.waitRejected === 1) rejected += 1;
        if (r.incumbentIllegal === 1 || r.waitRejected === 1) {
            continue;
        }
        if (r.delta === null) {
            throw new Error(`${cohort}:${lineNumber + 1}: scored row is missing its oracle delta`);
        }
        rows.push({
            f: r.features,
            x: expandWaitFeaturesV2(r.features),
            x3: expandWaitFeaturesV3(r.features, r.incumbentKind),
            y: r.label,
            d: r.delta,
            s: r.seed,
            cohort,
            incumbentKind: r.incumbentKind,
        });
        n += 1;
    }
    if (!n) {
        throw new Error(`${cohort}: dataset has no nondegenerate scored rows`);
    }
    console.log(`${cohort}: ${n} scored rows from ${path}`);
}
if (!rows.length) {
    throw new Error("No Phase-B Q2 rows were loaded");
}
console.log(
    `total scored rows: ${rows.length} (kept incumbent wait: ${kept}, illegal incumbent: ${illegal}, rejected wait: ${rejected})`,
);
console.log(`run fingerprint: ${runFingerprint}`);
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
if (!train.length || !test.length) {
    throw new Error(`split by seed produced an empty ${train.length ? "test" : "train"} partition`);
}
const cohorts = files.map((file) => file.cohort);
for (const cohort of cohorts) {
    const trainRows = train.filter((row) => row.cohort === cohort).length;
    const testRows = test.filter((row) => row.cohort === cohort).length;
    if (!trainRows || !testRows) {
        throw new Error(`${cohort}: split must contain nonempty train and test rows; got ${trainRows}/${testRows}`);
    }
}
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

const evalScores = (set, rawScore) => {
    if (!set.length) return { n: 0 };
    // Evaluate exactly once per row. Invalid scores are experiment failures, not values to clamp into a
    // plausible-looking report; starting the tie scan at i+1 also guarantees progress for every input.
    const scored = set.map((r, index) => {
        const s = rawScore(r);
        if (!Number.isFinite(s)) {
            throw new Error(`evaluation row ${index} produced a non-finite score`);
        }
        return { r, s, p: Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(s))) };
    });
    let ll = 0;
    let correct = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { r, p } of scored) {
        ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
        const pred = p >= 0.5 ? 1 : 0;
        if (pred === r.y) correct++;
        if (pred === 1 && r.y === 1) tp++;
        if (pred === 1 && r.y === 0) fp++;
        if (pred === 0 && r.y === 1) fn++;
    }
    const ranked = [...scored].sort((a, c) => a.s - c.s);
    let i = 0;
    let rankSumPos = 0;
    let nPos = 0;
    while (i < ranked.length) {
        let j = i + 1;
        while (j < ranked.length && ranked[j].s === ranked[i].s) j++;
        const avgRank = (i + j + 1) / 2;
        for (let k = i; k < j; k++) {
            if (ranked[k].r.y === 1) {
                rankSumPos += avgRank;
                nPos++;
            }
        }
        i = j;
    }
    const nNeg = scored.length - nPos;
    const auc = nPos && nNeg ? (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
    let dWait = 0;
    let nWait = 0;
    let oracleSum = 0;
    for (const { r, p } of scored) {
        if (r.y === 1 && r.d > 0) oracleSum += r.d; // the oracle's own captured delta mass (upper bound)
        if (p >= 0.5) {
            dWait += r.d;
            nWait++;
        }
    }
    return {
        n: scored.length,
        acc: ((100 * correct) / scored.length).toFixed(2),
        logloss: (ll / scored.length).toFixed(4),
        auc: Number.isNaN(auc) ? "n/a" : auc.toFixed(4),
        waitRate: ((100 * (tp + fp)) / scored.length).toFixed(1),
        precision: tp + fp ? ((100 * tp) / (tp + fp)).toFixed(1) : "n/a",
        recall: tp + fn ? ((100 * tp) / (tp + fn)).toFixed(1) : "n/a",
        meanDeltaPredWait: nWait ? (dWait / nWait).toFixed(5) : "n/a",
        // TAIL-CAPTURE: total wait-minus-act leaf value the fired set banks vs the oracle's own take.
        sumDeltaFired: dWait.toFixed(3),
        captureVsOracle: oracleSum > 0 ? `${((100 * dWait) / oracleSum).toFixed(1)}%` : "n/a",
    };
};

/**
 * Variant C — the TAIL-DISCRIMINATION distillation: ridge REGRESSION of the oracle's rollout delta d on
 * the deployed 98-dim basis. The deployed scorer fires at z > 0, i.e. exactly when the model predicts a
 * POSITIVE wait-minus-act value — the payoff-optimal operating point — whereas the logistic variants
 * calibrate to the OVERRIDE FREQUENCY and, on low-wait-share cohorts (ranged 17%, pure 8%), end up
 * firing on ~0% of points at z>0 (guard-zero behavior with extra steps).
 */
// Target scaled x10 (deltas are ~1e-2) to keep its gradient closer to the logistic fits. Deployment only
// tests sign(z), so the scale is free; the explicit stability gate below rejects a divergent run.
for (const r of rows) r.dc = typeof r.d === "number" ? 10 * Math.max(-0.3, Math.min(0.3, r.d)) : 0;
const trainD = train.filter((r) => typeof r.d === "number");

console.log(
    `\nfitting A (linear ${D_RAW}), B (class-conditional ${D2}), C (delta regression ${D2}), D (action-aware V3 ${D3})...`,
);
const t0 = Date.now();
const fitA = fitLogistic(train, D_RAW, (r) => r.f, EPOCHS, LR, L2);
console.log(`A done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const t1 = Date.now();
const fitB = fitLogistic(train, D2, (r) => r.x, EPOCHS, LR, L2);
console.log(`B done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
const t2 = Date.now();
const fitC = fitStableRidge(
    trainD,
    D2,
    (r) => r.x,
    (r) => r.dc,
    EPOCHS,
    L2,
);
console.log(`C done in ${((Date.now() - t2) / 1000).toFixed(0)}s`);
const t3 = Date.now();
const fitD = fitStableRidge(
    trainD,
    D3,
    (r) => r.x3,
    (r) => r.dc,
    EPOCHS,
    L2,
);
console.log(`D done in ${((Date.now() - t3) / 1000).toFixed(0)}s`);
for (const [tag, model] of [
    ["fit A", fitA],
    ["fit B", fitB],
]) {
    const issue = phaseBModelStabilityIssue(tag, model);
    if (issue) throw new Error(issue);
}
// Preserve the peer experiment's sign-equivalent x100 emission, but assess the actual candidate that
// would be copied into V07_WAIT_WEIGHTS_V2. C is optional, so its divergence must not hide valid A/B output.
const fitC100 = { b: fitC.b * 100, w: fitC.w.map((x) => x * 100) };
let cRejection = phaseBModelStabilityIssue("fit C x100", fitC100);
if (cRejection) console.log(`C REJECTED before evaluation: ${cRejection}`);
const fitD100 = { b: fitD.b * 100, w: fitD.w.map((x) => x * 100) };
const roundedModel = (model) => ({
    b: Number(model.b.toFixed(5)),
    w: model.w.map((value) => Number(value.toFixed(5))),
});
const fitDDeployed = roundedModel(fitD100);
let dRejection = phaseBModelStabilityIssue("fit D x100", fitD100);
if (!dRejection && fitDDeployed.b === 0 && fitDDeployed.w.every((value) => value === 0)) {
    dRejection = "fit D rounds to an all-zero deployment anchor";
}
if (dRejection) console.log(`D REJECTED before evaluation: ${dRejection}`);

const BIG = 50;
const v1 = DISTILLED_WAIT_WEIGHTS_2026_07_10;
const scoreV1 = (r) => {
    let z = v1.b;
    for (let i = 0; i < D1; i++) z += v1.w[i] * r.f[i];
    return z;
};
// v1 + the DEPLOYED training-support guard (support mode): out-of-support => act.
const scoreV1Guarded = (r) => (r.f[IS_MELEE] >= 0.5 && r.f[OWN_MELEE_FRAC] > 0.5 ? scoreV1(r) : -BIG);
const scoreA = (r) => {
    let z = fitA.b;
    for (let i = 0; i < D_RAW; i++) z += fitA.w[i] * r.f[i];
    return z;
};
const scoreB = (r) => {
    let z = fitB.b;
    for (let i = 0; i < D2; i++) z += fitB.w[i] * r.x[i];
    return z;
};
const scoreC = (r) => {
    let z = fitC.b;
    for (let i = 0; i < D2; i++) z += fitC.w[i] * r.x[i];
    return z;
};
const scoreD = (r) => {
    let z = fitDDeployed.b;
    for (let i = 0; i < D3; i++) z += fitDDeployed.w[i] * r.x3[i];
    return z;
};
const models = [
    ["baseline: always-act", () => -BIG],
    ["baseline: incumbent v0.5 rule", (r) => (r.f[INC_RULE] >= 0.5 ? BIG : -BIG)],
    ["baseline: fm>=0.67", (r) => (r.f[FM] >= 0.67 ? BIG : -BIG)],
    ["v1 distilled (unguarded)", scoreV1],
    ["v1 distilled + deployed guard", scoreV1Guarded],
    ["A: linear49", scoreA],
    ["B: class-conditional 98", scoreB],
];
const C_LABEL = "C: delta regression 98";
if (!cRejection) models.push([C_LABEL, scoreC]);
const D_LABEL = "D: action-aware V3 delta regression 125";
if (!dRejection) models.push([D_LABEL, scoreD]);

const classes = [
    ["MELEE-class", (r) => r.f[IS_MELEE] >= 0.5],
    ["RANGE-class", (r) => r.f[IS_RANGED] >= 0.5],
    ["OTHER-class", (r) => r.f[IS_MELEE] < 0.5 && r.f[IS_RANGED] < 0.5],
];
console.log("\n=== held-out test (split by game seed) ===");
for (const [label, score] of models) {
    try {
        const pooled = evalScores(test, score);
        const byCohort = cohorts.map((cohort) => [
            cohort,
            evalScores(
                test.filter((r) => r.cohort === cohort),
                score,
            ),
        ]);
        const byClass = classes.map(([classLabel, predicate]) => [
            classLabel,
            evalScores(test.filter(predicate), score),
        ]);
        console.log(`\n--- ${label} ---`);
        console.log("  POOLED:", JSON.stringify(pooled));
        for (const [cohort, result] of byCohort) console.log(`  cohort ${cohort}:`, JSON.stringify(result));
        for (const [classLabel, result] of byClass) console.log(`  ${classLabel}:`, JSON.stringify(result));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (label === C_LABEL) {
            cRejection = `fit C held-out evaluation failed: ${message}`;
        } else if (label === D_LABEL) {
            dRejection = `fit D held-out evaluation failed: ${message}`;
        } else {
            throw error;
        }
        console.log(`\n--- ${label} ---`);
        console.log(`  REJECTED: ${label === C_LABEL ? cRejection : dRejection}`);
    }
}

console.log("\n=== V3 held-out RANGE research gates ===");
if (!dRejection) {
    const gate = evaluateWaitV3HeldoutGates(
        test.map((r) => ({
            seed: r.s,
            incumbentKind: r.incumbentKind,
            isRanged: r.f[IS_RANGED] >= 0.5,
            delta: r.d,
            fired: waitV3CanReplaceIncumbentKind(r.incumbentKind) && scoreD(r) > 0,
        })),
    );
    console.log(
        JSON.stringify({
            rangeRows: gate.rangeRows,
            rangeSeeds: gate.rangeSeeds,
            positiveDeltaCapture:
                gate.rangePositiveDeltaCapture === null
                    ? null
                    : `${(100 * gate.rangePositiveDeltaCapture).toFixed(2)}%`,
            firedRows: gate.rangeFiredRows,
            firedSeeds: gate.rangeFiredSeeds,
            firedDelta: Number(gate.rangeFiredDelta.toFixed(6)),
            firedMeanDelta: gate.rangeFiredMeanDelta === null ? null : Number(gate.rangeFiredMeanDelta.toFixed(6)),
            actionBuckets: gate.actionBuckets
                .filter((bucket) => bucket.firedRows > 0)
                .map((bucket) => ({
                    kind: bucket.kind,
                    firedRows: bucket.firedRows,
                    firedDelta: Number(bucket.firedDelta.toFixed(6)),
                })),
        }),
    );
    if (!gate.pass) {
        dRejection = gate.reasons.join("; ");
        console.log(`V3 GATE: REJECTED - ${dRejection}`);
    } else {
        console.log("V3 GATE: PASS");
    }
} else {
    console.log(`V3 GATE: REJECTED - ${dRejection}`);
}

// Deployed-basis JSON for both: A padded with a zero xR_ block to the 98-dim basis.
const padA = { b: fitA.b, w: [...fitA.w, ...new Array(D2 - D_RAW).fill(0)] };
const round = (model) => JSON.stringify(roundedModel(model));
console.log("\nV07_WAIT_WEIGHTS_V2 JSON (A, linear49 padded):", round(padA));
console.log("\nV07_WAIT_WEIGHTS_V2 JSON (B, class-conditional 98):", round(fitB));
if (cRejection) {
    console.log("\nV07_WAIT_WEIGHTS_V2 JSON (C): REJECTED -", cRejection);
} else {
    console.log("\nV07_WAIT_WEIGHTS_V2 JSON (C, delta regression 98, x100):", round(fitC100));
}
if (dRejection) {
    console.log("\nV07_WAIT_WEIGHTS_V3 JSON (D): REJECTED -", dRejection);
} else {
    console.log(
        "\nV07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100):",
        JSON.stringify(fitDDeployed),
    );
}
console.log("\n=== B weights by name ===");
console.log("bias:", fitB.b.toFixed(4));
WAIT_FEATURE_NAMES_V2.forEach((n, i) => {
    if (Math.abs(fitB.w[i]) >= 0.05) console.log(`  ${n}: ${fitB.w[i].toFixed(4)}`);
});
if (!dRejection) {
    console.log("\n=== D weights by name ===");
    console.log("bias:", fitDDeployed.b.toFixed(4));
    WAIT_FEATURE_NAMES_V3.forEach((name, index) => {
        if (Math.abs(fitDDeployed.w[index]) >= 0.05) console.log(`  ${name}: ${fitDDeployed.w[index].toFixed(4)}`);
    });
}
