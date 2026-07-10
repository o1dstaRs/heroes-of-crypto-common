// Fit a logistic-regression VALUE FUNCTION on self-play position data (from battle_engine's VALUE_DATA dump).
// Each input row is [f0..f8, label] (9 features from value_features.ts + did-acting-team-win). Reports held-out
// log-loss + accuracy, compares to a MATERIAL-ONLY baseline (hpAdv sign), and prints the learned weights for
// wiring into lookahead's leaf eval. Usage: bun fit_value.mjs <data.jsonl> [epochs] [lr]
import { readFileSync } from "node:fs";

const FILE = process.argv[2] ?? "/tmp/vdata.jsonl";
const EPOCHS = Number(process.argv[3] ?? 200);
const LR = Number(process.argv[4] ?? 0.5);
// Known feature names (must match value_features.ts VALUE_FEATURE_NAMES order); padded with f<i> if the data
// carries more. D is derived from the DATA row width so the trainer never needs re-syncing when features change.
const KNOWN = ["hpAdv", "cntAdv", "atkAdv", "rangedAdv", "woundedOurs", "woundedEnemy", "advOurs", "advEnemy",
    "lapNorm", "seatAdv", "enemyExposed", "ourExposed", "hourglassFrac", "upNextFrac",
    // v0.7 B2 spatial block (value_features.ts)
    "nearEnemyDistOurs", "nearEnemyDistEnemy", "spreadOurs", "spreadEnemy", "centerDistOurs", "centerDistEnemy"];

const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`rows=${rows.length}`);
const D = rows[0].length - 1; // features = row width minus the trailing label
const NAMES = Array.from({ length: D }, (_, i) => KNOWN[i] ?? `f${i}`);
// Shuffle deterministically, 85/15 train/test split.
let s = 12345;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let i = rows.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [rows[i], rows[j]] = [rows[j], rows[i]]; }
const cut = Math.floor(rows.length * 0.85);
const train = rows.slice(0, cut), test = rows.slice(cut);

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const w = new Array(D).fill(0);
let b = 0;
for (let e = 0; e < EPOCHS; e++) {
    const gw = new Array(D).fill(0); let gb = 0;
    for (const r of train) {
        const p = sigmoid(w.reduce((a, wi, i) => a + wi * r[i], b));
        const err = p - r[D];
        for (let i = 0; i < D; i++) gw[i] += err * r[i];
        gb += err;
    }
    for (let i = 0; i < D; i++) w[i] -= (LR * gw[i]) / train.length;
    b -= (LR * gb) / train.length;
}
const evalSet = (set, predict) => {
    let ll = 0, correct = 0;
    for (const r of set) {
        const p = Math.min(1 - 1e-9, Math.max(1e-9, predict(r)));
        ll += -(r[D] * Math.log(p) + (1 - r[D]) * Math.log(1 - p));
        if ((p >= 0.5 ? 1 : 0) === r[D]) correct++;
    }
    return { logloss: (ll / set.length).toFixed(4), acc: ((100 * correct) / set.length).toFixed(1) };
};
const modelP = (r) => sigmoid(w.reduce((a, wi, i) => a + wi * r[i], b));
const materialP = (r) => sigmoid(6 * r[0]); // baseline: hpAdv only (scaled), the current leaf eval's essence

console.log("\n=== held-out test ===");
console.log("LEARNED model :", evalSet(test, modelP));
console.log("MATERIAL (hpAdv):", evalSet(test, materialP));
console.log("\n=== learned weights (for lookahead leaf eval) ===");
console.log("bias:", b.toFixed(4));
NAMES.forEach((n, i) => console.log(`  ${n}: ${w[i].toFixed(4)}`));
console.log("\nJSON:", JSON.stringify({ b: Number(b.toFixed(5)), w: w.map((x) => Number(x.toFixed(5))) }));
