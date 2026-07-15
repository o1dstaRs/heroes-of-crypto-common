// IMITATION-LEARNING BASELINE FIT (docs/imitation_pipeline.md, step 3): a CONDITIONAL-LOGIT (multinomial
// logistic over the per-decision candidate set) imitator of the rollout search's choice, trained on
// extract_il.mjs rows. Per decision, each candidate gets z_i = w·phi(candidate_i); softmax over the
// decision's candidates; cross-entropy on the search's chosen index. Report: held-out top-1 accuracy
// (semantic-signature credit) pooled / per chosen-action class / per cohort / on the OVERRIDDEN subset,
// against the v0.7-policy-agreement baseline ("always pick the incumbent" — how often plain v0.7 already
// plays the search's choice, i.e. the imitation headroom).
//
// Two fits, house A/B style:
//   A: candidate-only features (isIncumbent + chosen-class one-hot + F4 economy/damage terms)
//   B: A + class-group x state interactions (a curated slice of the 41-dim wait-scorer state vector)
// NOTHING here ships: the printed weights are a report artifact; wiring a distilled policy into any
// strategy is a separate peer-coordinated change (see docs/imitation_pipeline.md).
//
// Usage: bun src/simulation/optimizer/fit_il.mjs rows=<rows.jsonl> [epochs=200] [lr=0.5] [l2=0.0001]
//        [heldout=0.15] [maxTrain=<n decisions>]
import { readFileSync } from "node:fs";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";

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
const numArg = (key, fallback) => {
    const raw = args.get(key);
    const v = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${key} must be finite`);
    return v;
};
const EPOCHS = Math.floor(numArg("epochs", 200));
const LR = numArg("lr", 0.5);
const L2 = numArg("l2", 0.0001);
const HELDOUT = numArg("heldout", 0.15);
const MAX_TRAIN = Math.floor(numArg("maxTrain", 0)); // 0 = all

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

// --- load ---------------------------------------------------------------------------------------
const decisions = [];
{
    const lines = readFileSync(rowsPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        const r = JSON.parse(line);
        if (!Array.isArray(r.cands) || r.cands.length < 2) throw new Error(`row ${i + 1}: bad cands`);
        const maxDamage = Math.max(...r.cands.map((cand) => Math.max(0, cand.cf[CF.expectedDamage])));
        decisions.push({
            c: r.c,
            s: r.s,
            cls: r.cls,
            chosen: r.chosen,
            agree: r.agree,
            sigs: r.cands.map((cand) => cand.sig),
            x: r.cands.map((cand, index) => phi(cand, index, maxDamage, r.wf)),
        });
    }
}
if (!decisions.length) throw new Error("no decisions loaded");
const cohorts = [...new Set(decisions.map((d) => d.c))];
console.log(`loaded ${decisions.length} decisions (${cohorts.join("/")}) from ${rowsPath}`);

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
console.log(`split by seed: train ${train.length} / test ${test.length} (heldout ${HELDOUT})`);

// --- conditional-logit fit --------------------------------------------------------------------------
function fit(set, dims) {
    const w = new Float64Array(dims);
    const g = new Float64Array(dims);
    const start = Date.now();
    for (let e = 0; e < EPOCHS; e += 1) {
        g.fill(0);
        let loss = 0;
        for (const d of set) {
            const n = d.x.length;
            const z = new Float64Array(n);
            let zMax = -Infinity;
            for (let i = 0; i < n; i += 1) {
                let s = 0;
                const x = d.x[i];
                for (let j = 0; j < dims; j += 1) s += w[j] * x[j];
                z[i] = s;
                if (s > zMax) zMax = s;
            }
            let denom = 0;
            for (let i = 0; i < n; i += 1) {
                z[i] = Math.exp(z[i] - zMax);
                denom += z[i];
            }
            loss += -Math.log(Math.max(1e-12, z[d.chosen] / denom));
            for (let i = 0; i < n; i += 1) {
                const err = z[i] / denom - (i === d.chosen ? 1 : 0);
                const x = d.x[i];
                for (let j = 0; j < dims; j += 1) g[j] += err * x[j];
            }
        }
        for (let j = 0; j < dims; j += 1) w[j] -= LR * (g[j] / set.length + L2 * w[j]);
        if ((e + 1) % 50 === 0 || e === 0) {
            console.log(
                `  epoch ${e + 1}/${EPOCHS} loss ${(loss / set.length).toFixed(4)} (${((Date.now() - start) / 1000).toFixed(0)}s)`,
            );
        }
    }
    return w;
}

// --- evaluation ---------------------------------------------------------------------------------
/** Top-1 with semantic-signature credit: predicting any candidate that plays the chosen turn counts. */
const predict = (d, w, dims) => {
    let best = 0;
    let bestZ = -Infinity;
    for (let i = 0; i < d.x.length; i += 1) {
        let s = 0;
        const x = d.x[i];
        for (let j = 0; j < dims; j += 1) s += w[j] * x[j];
        if (s > bestZ) {
            bestZ = s;
            best = i;
        }
    }
    return best;
};
const evalModel = (set, chooser) => {
    if (!set.length) return { n: 0 };
    let correct = 0;
    for (const d of set) {
        if (d.sigs[chooser(d)] === d.sigs[d.chosen]) correct += 1;
    }
    return { n: set.length, acc: `${((100 * correct) / set.length).toFixed(2)}%` };
};
const report = (label, chooser) => {
    console.log(`\n--- ${label} ---`);
    console.log("  POOLED:", JSON.stringify(evalModel(test, chooser)));
    console.log(
        "  OVERRIDDEN-only:",
        JSON.stringify(
            evalModel(
                test.filter((d) => d.chosen !== 0),
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

report("baseline: always-incumbent (v0.7 policy agreement — the imitation headroom)", () => 0);
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
    return best;
});
report(`A: conditional logit, candidate-only (${DA})`, (d) => predict(d, wA, DA));
report(`B: A + class-group x state (${DB})`, (d) => predict(d, wB, DB));

const round = (w) => [...w].map((x) => Number(x.toFixed(5)));
console.log("\nIL imitator weights (report artifact — NOT wired anywhere):");
console.log("A:", JSON.stringify({ names: NAMES_A, w: round(wA) }));
console.log("B:", JSON.stringify({ names: NAMES_B, w: round(wB) }));
