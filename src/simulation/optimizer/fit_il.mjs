// SEARCH-IMITATION v2 baseline fit. Candidate logits are aggregated into duplicate-neutral semantic groups;
// training, prediction and evaluation all use the same group identity. Gate-adjusted rollout margin weights
// downweight boundary/noisy teacher decisions. Report artifact only: nothing here changes a live strategy.
//
// Two fits, house A/B style:
//   A: candidate-only features (isIncumbent + chosen-class one-hot + F4 economy/damage terms)
//   B: A + class-group x state interactions (a curated slice of the 41-dim wait-scorer state vector)
// NOTHING here ships: the printed weights are a report artifact; wiring a distilled policy into any
// strategy is a separate peer-coordinated change (see docs/imitation_pipeline.md).
//
// Usage: bun src/simulation/optimizer/fit_il.mjs rows=<rows.jsonl> fingerprint=<64hex>
//        [epochs=200] [lr=0.5] [l2=0.0001]
//        [heldout=0.15] [maxTrain=<n decisions>]
import { readFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";
import { IL_CANDIDATE_FEATURE_NAMES, requireIlRunFingerprint } from "../il_dataset";
import { deriveTeacherConfidence, groupedSemanticLossAndGradient, predictSemanticGroup } from "./il_fit_core.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) throw new Error(`Arguments must be key=value; got ${arg}`);
    const key = arg.slice(0, eq);
    if (args.has(key)) throw new Error(`Duplicate argument: ${key}`);
    args.set(key, arg.slice(eq + 1));
}
const rowsPath = args.get("rows");
if (!rowsPath) throw new Error("rows=<rows.jsonl> is required");
const runFingerprint = requireIlRunFingerprint(args.get("fingerprint"), "fingerprint");
const allowedArgs = new Set(["rows", "fingerprint", "epochs", "lr", "l2", "heldout", "maxTrain"]);
for (const key of args.keys()) if (!allowedArgs.has(key)) throw new Error(`Unknown argument: ${key}`);
const numArg = (key, fallback) => {
    const raw = args.get(key);
    const v = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${key} must be finite`);
    return v;
};
const EPOCHS = numArg("epochs", 200);
const LR = numArg("lr", 0.5);
const L2 = numArg("l2", 0.0001);
const HELDOUT = numArg("heldout", 0.15);
const MAX_TRAIN = numArg("maxTrain", 0); // 0 = all
if (!Number.isInteger(EPOCHS) || EPOCHS < 1) throw new Error("epochs must be a positive integer");
if (LR <= 0) throw new Error("lr must be positive");
if (L2 < 0) throw new Error("l2 must be non-negative");
if (HELDOUT <= 0 || HELDOUT >= 1) throw new Error("heldout must be between 0 and 1");
if (!Number.isInteger(MAX_TRAIN) || MAX_TRAIN < 0) throw new Error("maxTrain must be a non-negative integer");

// --- featurization (versioned by these printed names; keep extract_il.mjs cf order in sync) ----------
const CLS = ["melee", "shot", "area_throw", "spell", "wait", "defend", "move", "mine", "idle"];
const CF = {
    moraleDelta: 0,
    luckDelta: 1,
    enemiesNotYetActedFrac: 2,
    alliesNotYetActedFrac: 3,
    lap: 4,
    hourglassSpent: 5,
    spendsRangeShot: 6,
    spendsSpellCharge: 7,
    burnsResurrectionCharge: 8,
    expectedDamage: 9,
    expectedKill: 10,
};
// Candidate class GROUPS for the state interactions (finer than nothing, coarser than 9 classes).
const GROUPS = [
    ["gAttack", (ck) => ck === "melee" || ck === "shot" || ck === "area_throw" || ck === "mine"],
    ["gSpell", (ck) => ck === "spell"],
    ["gWait", (ck) => ck === "wait"],
    ["gDefend", (ck) => ck === "defend"],
    ["gMoveIdle", (ck) => ck === "move" || ck === "idle"],
];
const stateIdx = (name) => {
    const i = WAIT_FEATURE_NAMES.indexOf(name);
    if (i < 0) throw new Error(`state feature ${name} missing`);
    return i;
};
const STATE_SLICE = ["hpAdv", "rangedAdv", "lapNorm", "enemyExposed", "fmExposure", "nearEnemyDistOurs"].map((name) => [
    name,
    stateIdx(name),
]);

const NAMES_A = [
    "isIncumbent",
    ...CLS.map((c) => `cls_${c}`),
    "moraleDelta3",
    "luckDelta3",
    "enemiesNotYetActedFrac",
    "alliesNotYetActedFrac",
    "hourglassSpent",
    "spendsRangeShot",
    "spendsSpellCharge",
    "burnsResurrectionCharge",
    "expectedKill",
    "dmgNorm", // expectedDamage / max expectedDamage within the decision
    "dmgLog", // log1p(expectedDamage)/10
];
const NAMES_B = [...NAMES_A, ...GROUPS.flatMap(([group]) => STATE_SLICE.map(([name]) => `${group}_x_${name}`))];
const DA = NAMES_A.length;
const DB = NAMES_B.length;

/** Per-candidate feature vector (width DB; model A reads the first DA dims). */
function phi(cand, index, maxDamage, wf) {
    const cf = cand.cf;
    const v = new Float64Array(DB);
    let k = 0;
    v[k++] = index === 0 ? 1 : 0;
    for (const cls of CLS) v[k++] = cand.ck === cls ? 1 : 0;
    v[k++] = cf[CF.moraleDelta] / 3;
    v[k++] = cf[CF.luckDelta] / 3;
    v[k++] = cf[CF.enemiesNotYetActedFrac];
    v[k++] = cf[CF.alliesNotYetActedFrac];
    v[k++] = cf[CF.hourglassSpent];
    v[k++] = cf[CF.spendsRangeShot];
    v[k++] = cf[CF.spendsSpellCharge];
    v[k++] = cf[CF.burnsResurrectionCharge];
    v[k++] = cf[CF.expectedKill];
    const dmg = Math.max(0, cf[CF.expectedDamage]);
    v[k++] = maxDamage > 0 ? dmg / maxDamage : 0;
    v[k++] = Math.log1p(dmg) / 10;
    for (const [, isGroup] of GROUPS) {
        const g = isGroup(cand.ck) ? 1 : 0;
        for (const [, idx] of STATE_SLICE) v[k++] = g ? wf[idx] : 0;
    }
    return v;
}

// --- strict load ---------------------------------------------------------------------------------
const nonempty = (value, label) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: expected a non-empty string`);
    return value;
};
const finite = (value, label) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}: expected a finite number`);
    return value;
};
const finiteVector = (value, width, label) => {
    if (!Array.isArray(value) || value.length !== width) throw new Error(`${label}: expected width ${width}`);
    return value.map((entry, index) => finite(entry, `${label}[${index}]`));
};
const rawLines = readFileSync(rowsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
if (rawLines.length < 2) throw new Error("fit input is missing decisions or its completion footer");
const parsedLines = rawLines.map((line, index) => {
    try {
        return JSON.parse(line);
    } catch {
        throw new Error(`row ${index + 1}: invalid JSON`);
    }
});
const completion = parsedLines.at(-1);
if (completion?.t !== "ilx_complete" || completion.v !== 2) {
    throw new Error("fit input must end with an ilx_complete v2 footer");
}
if (requireIlRunFingerprint(completion.runFingerprint, "completion.runFingerprint") !== runFingerprint) {
    throw new Error("completion run fingerprint mismatch");
}
if (!Number.isSafeInteger(completion.decisions) || completion.decisions < 1) {
    throw new Error("completion decision count must be positive");
}
if (completion.decisions !== parsedLines.length - 1) throw new Error("completion decision count mismatch");
if (!completion.config || typeof completion.config !== "object") throw new Error("completion config is required");
const teacherGate = finite(completion.config.gate, "completion.config.gate");
if (teacherGate < 0) throw new Error("completion.config.gate must be non-negative");
if (!completion.gamesByCohort || typeof completion.gamesByCohort !== "object") {
    throw new Error("completion gamesByCohort is required");
}

const decisions = [];
for (let index = 0; index < parsedLines.length - 1; index += 1) {
    const rowNumber = index + 1;
    const r = parsedLines[index];
    if (r?.t !== "ilx" || r.v !== 2) throw new Error(`row ${rowNumber}: expected ilx v2`);
    if (requireIlRunFingerprint(r.runFingerprint, `row ${rowNumber}.runFingerprint`) !== runFingerprint) {
        throw new Error(`row ${rowNumber}: run fingerprint mismatch`);
    }
    const cohort = nonempty(r.c, `row ${rowNumber}.c`);
    if (!Number.isSafeInteger(r.s) || r.s < -0x80000000 || r.s > 0xffffffff) {
        throw new Error(`row ${rowNumber}.s: expected a signed int32 or uint32 seed`);
    }
    if (!Array.isArray(r.cands) || r.cands.length < 2) throw new Error(`row ${rowNumber}: bad cands`);
    const cands = r.cands.map((cand, candidateIndex) => ({
        ck: nonempty(cand?.ck, `row ${rowNumber}.cands[${candidateIndex}].ck`),
        sig: nonempty(cand?.sig, `row ${rowNumber}.cands[${candidateIndex}].sig`),
        cf: finiteVector(cand?.cf, IL_CANDIDATE_FEATURE_NAMES.length, `row ${rowNumber}.cands[${candidateIndex}].cf`),
    }));
    if (!Number.isInteger(r.chosen) || r.chosen < 0 || r.chosen >= cands.length) {
        throw new Error(`row ${rowNumber}.chosen: invalid candidate index`);
    }
    if (r.agree !== 0 && r.agree !== 1) throw new Error(`row ${rowNumber}.agree: expected 0 or 1`);
    if (r.teacherForced !== 0 && r.teacherForced !== 1) {
        throw new Error(`row ${rowNumber}.teacherForced: expected 0 or 1`);
    }
    const wf = finiteVector(r.wf, WAIT_FEATURE_NAMES.length, `row ${rowNumber}.wf`);
    if (!Array.isArray(r.m) || r.m.length !== cands.length) throw new Error(`row ${rowNumber}.m: width mismatch`);
    const means = r.m.map((mean, candidateIndex) =>
        mean === null ? null : finite(mean, `row ${rowNumber}.m[${candidateIndex}]`),
    );
    const teacher = deriveTeacherConfidence(
        means,
        cands.map((cand) => cand.sig),
        r.chosen,
        teacherGate,
    );
    if (r.targetSig !== teacher.targetSignature) throw new Error(`row ${rowNumber}: target signature mismatch`);
    if (r.teacherForced !== (teacher.forced ? 1 : 0)) throw new Error(`row ${rowNumber}: forced marker mismatch`);
    if (finite(r.teacherWeight, `row ${rowNumber}.teacherWeight`) !== teacher.weight) {
        throw new Error(`row ${rowNumber}: teacher weight mismatch`);
    }
    if (r.teacherMargin !== teacher.margin) throw new Error(`row ${rowNumber}: teacher margin mismatch`);
    const maxDamage = Math.max(...cands.map((cand) => Math.max(0, cand.cf[CF.expectedDamage])));
    decisions.push({
        c: cohort,
        s: r.s >>> 0,
        cls: nonempty(r.cls, `row ${rowNumber}.cls`),
        agree: r.agree,
        targetSig: teacher.targetSignature,
        weight: teacher.weight,
        sigs: cands.map((cand) => cand.sig),
        x: cands.map((cand, candidateIndex) => phi(cand, candidateIndex, maxDamage, wf)),
    });
}
if (!decisions.length) throw new Error("no decisions loaded");
const cohorts = [...new Set(decisions.map((d) => d.c))];
for (const cohort of cohorts) {
    if (!Number.isSafeInteger(completion.gamesByCohort[cohort]) || completion.gamesByCohort[cohort] < 1) {
        throw new Error(`completion is missing a positive game count for cohort ${cohort}`);
    }
}
if (Object.keys(completion.gamesByCohort).some((cohort) => !cohorts.includes(cohort))) {
    throw new Error("completion contains a cohort with no decisions");
}
console.log(
    `loaded ${decisions.length} complete decisions (${cohorts.join("/")}) from ${rowsPath}` +
        ` | fingerprint ${runFingerprint}`,
);

// --- split by GAME SEED (fit_wait_v2 house hash) ---------------------------------------------------
const hash = (n) => {
    let x = n >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
};
let train = decisions.filter((d) => hash(d.s) >= HELDOUT);
const test = decisions.filter((d) => hash(d.s) < HELDOUT);
if (!train.length || !test.length) throw new Error("empty train/test split");
if (MAX_TRAIN > 0 && train.length > MAX_TRAIN) {
    // Deterministic thinning by a second-order hash so reruns are reproducible.
    train = train
        .map((d, i) => ({ d, h: hash((d.s ^ 0x85ebca6b) + i) }))
        .sort((a, b) => a.h - b.h)
        .slice(0, MAX_TRAIN)
        .map(({ d }) => d);
}
for (const cohort of cohorts) {
    if (!train.some((decision) => decision.c === cohort) || !test.some((decision) => decision.c === cohort)) {
        throw new Error(`cohort ${cohort} must have nonempty train and held-out partitions`);
    }
}
console.log(`split by seed: train ${train.length} / test ${test.length} (heldout ${HELDOUT})`);

// --- confidence-weighted semantic-group conditional-logit fit ---------------------------------------
function fit(set, dims) {
    const w = new Float64Array(dims);
    const g = new Float64Array(dims);
    const totalWeight = set.reduce((sum, decision) => sum + decision.weight, 0);
    if (!(totalWeight > 0)) throw new Error("training partition has zero teacher confidence weight");
    const start = Date.now();
    for (let e = 0; e < EPOCHS; e += 1) {
        g.fill(0);
        let loss = 0;
        for (const d of set) {
            const n = d.x.length;
            const logits = new Array(n).fill(0);
            for (let i = 0; i < n; i += 1) {
                let logit = 0;
                const x = d.x[i];
                for (let j = 0; j < dims; j += 1) logit += w[j] * x[j];
                logits[i] = logit;
            }
            const objective = groupedSemanticLossAndGradient(logits, d.sigs, d.targetSig);
            loss += d.weight * objective.loss;
            for (let i = 0; i < n; i += 1) {
                const x = d.x[i];
                const error = d.weight * objective.gradient[i];
                for (let j = 0; j < dims; j += 1) g[j] += error * x[j];
            }
        }
        for (let j = 0; j < dims; j += 1) w[j] -= LR * (g[j] / totalWeight + L2 * w[j]);
        if ((e + 1) % 50 === 0 || e === 0) {
            console.log(
                `  epoch ${e + 1}/${EPOCHS} weighted loss ${(loss / totalWeight).toFixed(4)}` +
                    ` (${((Date.now() - start) / 1000).toFixed(0)}s)`,
            );
        }
    }
    return w;
}

// --- evaluation ---------------------------------------------------------------------------------
/** Semantic-group prediction using the exact group score optimized above. */
const predict = (d, w, dims) => {
    const logits = new Array(d.x.length).fill(0);
    for (let i = 0; i < d.x.length; i += 1) {
        const x = d.x[i];
        for (let j = 0; j < dims; j += 1) logits[i] += w[j] * x[j];
    }
    return predictSemanticGroup(logits, d.sigs).signature;
};
const evalModel = (set, chooser) => {
    if (!set.length) return { n: 0 };
    let correct = 0;
    let correctWeight = 0;
    let totalWeight = 0;
    for (const d of set) {
        const hit = chooser(d) === d.targetSig;
        if (hit) {
            correct += 1;
            correctWeight += d.weight;
        }
        totalWeight += d.weight;
    }
    return {
        n: set.length,
        weight: Number(totalWeight.toFixed(2)),
        acc: `${((100 * correct) / set.length).toFixed(2)}%`,
        weightedAcc: totalWeight ? `${((100 * correctWeight) / totalWeight).toFixed(2)}%` : "n/a",
    };
};
const report = (label, chooser) => {
    console.log(`\n--- ${label} ---`);
    console.log("  POOLED:", JSON.stringify(evalModel(test, chooser)));
    console.log(
        "  OVERRIDDEN-only:",
        JSON.stringify(
            evalModel(
                test.filter((d) => d.targetSig !== d.sigs[0]),
                chooser,
            ),
        ),
    );
    for (const cohort of cohorts) {
        console.log(
            `  cohort ${cohort}:`,
            JSON.stringify(
                evalModel(
                    test.filter((d) => d.c === cohort),
                    chooser,
                ),
            ),
        );
    }
    const classes = [...new Set(test.map((d) => d.cls))].sort();
    for (const cls of classes) {
        console.log(
            `  chosen=${cls}:`,
            JSON.stringify(
                evalModel(
                    test.filter((d) => d.cls === cls),
                    chooser,
                ),
            ),
        );
    }
};

console.log(`\nfitting A (candidate-only, ${DA} dims) ...`);
const wA = fit(train, DA);
console.log(`fitting B (A + class-group x state, ${DB} dims) ...`);
const wB = fit(train, DB);

report("baseline: always-incumbent (v0.7 policy agreement — the imitation headroom)", (decision) => decision.sigs[0]);
report("baseline: max expectedDamage (tie -> incumbent)", (d) => {
    let best = 0;
    let bestDmg = 0;
    for (let i = 0; i < d.x.length; i += 1) {
        // dmgNorm is the last-but-one A dim; recover raw ordering from it (max-normalized within decision).
        const dmg = d.x[i][DA - 2];
        if (dmg > bestDmg) {
            bestDmg = dmg;
            best = i;
        }
    }
    return d.sigs[best];
});
report(`A: conditional logit, candidate-only (${DA})`, (d) => predict(d, wA, DA));
report(`B: A + class-group x state (${DB})`, (d) => predict(d, wB, DB));

const round = (w) => [...w].map((x) => Number(x.toFixed(5)));
console.log("\nIL imitator weights (report artifact — NOT wired anywhere):");
const metadata = {
    schemaVersion: 2,
    runFingerprint,
    objective: "confidence-weighted-semantic-logmeanexp-cross-entropy",
    hyperparameters: { epochs: EPOCHS, learningRate: LR, l2: L2, heldout: HELDOUT, maxTrain: MAX_TRAIN },
};
console.log("A:", JSON.stringify({ ...metadata, names: NAMES_A, w: round(wA) }));
console.log("B:", JSON.stringify({ ...metadata, names: NAMES_B, w: round(wB) }));
