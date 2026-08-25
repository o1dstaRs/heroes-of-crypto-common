// CEM refit of the A19 v0.8 60-dim value leaf FOR THE SIDE-ORIENTED BOARD.
//
//   CEM_HOURS=10 bun src/simulation/optimizer/side_cem.mjs
//
// Mean starts at the SHIPPED V08_A13_VALUE_LEAF; each candidate leaf is evaluated by
// side_board_ab_battery.ts (candidate seat runs the leaf via the per-team seam, the control seat is
// the shipped axis-blind v0.8), so fitness IS the deployment metric: decisive win rate vs the
// previous v0.8 on the new board. Generation bests are re-scored on a held-out seed panel before
// they can become the global best (anti-overfit, same discipline as cem.mjs). State persists under
// sim-out/side_cem/ for resume.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "sim-out", "side_cem");
mkdirSync(outDir, { recursive: true });
const statePath = join(outDir, "state.json");
const bestPath = join(outDir, "best.json");
const logPath = join(outDir, "log.md");

const HOURS = Number(process.env.CEM_HOURS ?? 10);
const POP = Number(process.env.CEM_POP ?? 20);
const ELITE = Number(process.env.CEM_ELITE ?? 5);
const SCREEN_PAIRS = Number(process.env.CEM_SCREEN_PAIRS ?? 72);
const VAL_PAIRS = Number(process.env.CEM_VAL_PAIRS ?? 250);
const CONC = Number(process.env.CEM_CONC ?? 10);
const SIGMA_SCALE = Number(process.env.CEM_SIGMA_SCALE ?? 0.5);
const SIGMA_FLOOR = Number(process.env.CEM_SIGMA_FLOOR ?? 0.02);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY ?? 0.92);
const SCREEN_SEED = Number(process.env.CEM_SCREEN_SEED ?? 92000001);
const VAL_SEED = Number(process.env.CEM_VAL_SEED ?? 97000001); // held out — never used for screening

const deadline = Date.now() + HOURS * 3600 * 1000;
const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    writeFileSync(logPath, `${stamped}\n`, { flag: "a" });
};

// The shipped leaf = the CEM mean seed. Read it from the profile source so the anchor can never
// drift from what production actually runs.
const profileSource = readFileSync(join(repoRoot, "src", "ai", "versions", "v0_8_a13_profile.ts"), "utf8");
const leafMatch = profileSource.match(/V08_A13_VALUE_LEAF[^{]*\{\s*b:\s*(-?[0-9.e-]+),\s*w:\s*\[([^\]]+)\]/s);
if (!leafMatch) throw new Error("Could not parse V08_A13_VALUE_LEAF from v0_8_a13_profile.ts");
const shipped = { b: Number(leafMatch[1]), w: leafMatch[2].split(",").map((value) => Number(value.trim())) };
if (shipped.w.length !== 60 || shipped.w.some((weight) => !Number.isFinite(weight))) {
    throw new Error(`Parsed leaf malformed: ${shipped.w.length} dims`);
}
log(`shipped leaf parsed: b=${shipped.b}, dims=${shipped.w.length}`);

let rngState = Number(process.env.CEM_SEED ?? 1234567) >>> 0;
const rand = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

const initialSigma = shipped.w.map((weight) => Math.max(SIGMA_FLOOR, SIGMA_SCALE * Math.abs(weight)));
const initialSigmaB = Math.max(SIGMA_FLOOR, SIGMA_SCALE * Math.abs(shipped.b));

let state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {
          generation: 0,
          mean: { b: shipped.b, w: [...shipped.w] },
          sigma: { b: initialSigmaB, w: initialSigma },
          globalBest: null, // {leaf, screenRate, valRate}
          evaluations: 0,
      };

function evaluateLeaf(leaf, pairs, seed, label) {
    const leafFile = join(outDir, `cand_${label}.json`);
    const reportFile = join(outDir, `report_${label}.json`);
    writeFileSync(leafFile, JSON.stringify(leaf));
    execFileSync(
        "bun",
        [
            join(repoRoot, "src", "simulation", "side_board_ab_battery.ts"),
            "--pairs", String(pairs),
            "--seed", String(seed),
            "--concurrency", String(CONC),
            "--output", reportFile,
            "--leaf-file", leafFile,
        ],
        { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"], timeout: 3 * 3600 * 1000 },
    );
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    state.evaluations += 1;
    if (report.errors > report.games * 0.02) {
        throw new Error(`evaluation ${label}: ${report.errors}/${report.games} errored games`);
    }
    return { rate: report.candidateWinRate, decisive: report.decisive, lo: report.wilson95.lo };
}

const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

while (Date.now() < deadline) {
    const generation = state.generation;
    // Fresh screening seed base per generation — never the validation base.
    const screenSeed = (SCREEN_SEED + generation * 7919) >>> 0;
    const candidates = [];
    for (let index = 0; index < POP; index += 1) {
        // First slot of gen 0 is the pure shipped leaf, so the log always carries the null result.
        const leaf =
            generation === 0 && index === 0
                ? { b: shipped.b, w: [...shipped.w] }
                : {
                      b: state.mean.b + state.sigma.b * gauss(),
                      w: state.mean.w.map((weight, dim) => weight + state.sigma.w[dim] * gauss()),
                  };
        candidates.push(leaf);
    }
    const scored = [];
    for (let index = 0; index < candidates.length; index += 1) {
        if (Date.now() > deadline) break;
        const result = evaluateLeaf(candidates[index], SCREEN_PAIRS, screenSeed, `g${generation}_c${index}`);
        scored.push({ leaf: candidates[index], ...result });
        log(`g${generation} c${index}: ${(result.rate * 100).toFixed(2)}% (${result.decisive} decisive)`);
        persist();
    }
    if (!scored.length) break;
    scored.sort((left, right) => right.rate - left.rate);
    const elites = scored.slice(0, Math.min(ELITE, scored.length));
    // Elite mean/sigma update.
    state.mean = {
        b: elites.reduce((sum, elite) => sum + elite.leaf.b, 0) / elites.length,
        w: shipped.w.map((_, dim) => elites.reduce((sum, elite) => sum + elite.leaf.w[dim], 0) / elites.length),
    };
    state.sigma = {
        b: Math.max(SIGMA_FLOOR, state.sigma.b * SIGMA_DECAY),
        w: state.sigma.w.map((sigma) => Math.max(SIGMA_FLOOR, sigma * SIGMA_DECAY)),
    };
    // Held-out validation for the generation winner before it may take the crown.
    const genBest = scored[0];
    const validation = evaluateLeaf(genBest.leaf, VAL_PAIRS, VAL_SEED, `g${generation}_val`);
    log(
        `g${generation} BEST screen=${(genBest.rate * 100).toFixed(2)}% ` +
            `val=${(validation.rate * 100).toFixed(2)}% (lo=${(validation.lo * 100).toFixed(2)}%)`,
    );
    if (!state.globalBest || validation.rate > state.globalBest.valRate) {
        state.globalBest = { leaf: genBest.leaf, screenRate: genBest.rate, valRate: validation.rate, valLo: validation.lo, generation };
        writeFileSync(bestPath, JSON.stringify(state.globalBest, null, 2));
        log(`NEW GLOBAL BEST: val ${(validation.rate * 100).toFixed(2)}%`);
    }
    state.generation += 1;
    persist();
}
log(`CEM loop done: ${state.generation} generations, ${state.evaluations} evaluations`);
