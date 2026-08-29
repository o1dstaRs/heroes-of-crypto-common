// CEM refit of an A19 v0.8 linear vector FOR THE SIDE-ORIENTED BOARD.
//
//   CEM_HOURS=10 bun src/simulation/optimizer/side_cem.mjs                      # value leaf (60d)
//   CEM_TARGET=wait CEM_BASE_LEAF=path/to/leaf.json bun ...side_cem.mjs         # wait scorer (42d)
//
// CEM_TARGET picks what evolves: "leaf" (default) perturbs the SHIPPED V08_A13_VALUE_LEAF;
// "wait" perturbs the SHIPPED DISTILLED_WAIT_WEIGHTS_2026_07_10 and, when CEM_BASE_LEAF is set,
// rides every evaluation (anchor included) on that frozen leaf so the fitness is the DEPLOYMENT
// BUNDLE's rate. Candidates are evaluated by side_board_ab_battery.ts (candidate seat runs the
// vector(s) via the per-team seams, the control seat is the shipped axis-blind v0.8), so fitness IS
// the deployment metric: decisive win rate vs the previous v0.8 on the new board. Generation bests
// are re-scored on a held-out seed panel before they can become the global best (anti-overfit, same
// discipline as cem.mjs). State persists under sim-out/side_cem[_wait]/ for resume.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const TARGET =
    process.env.CEM_TARGET === "wait" ? "wait" : process.env.CEM_TARGET === "joint" ? "joint" : "leaf";
// The frozen value leaf every WAIT evaluation rides on (absent = shipped leaf both seats).
const BASE_LEAF = process.env.CEM_BASE_LEAF ?? "";
const outDir = join(
    repoRoot,
    "sim-out",
    TARGET === "wait" ? "side_cem_wait" : TARGET === "joint" ? "side_cem_joint" : "side_cem",
);
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

// The shipped vector = the CEM mean seed. Imported straight from the source module so the anchor
// can never drift from what production actually runs (bun loads the TS module from .mjs directly).
const EXPECTED_DIMS = TARGET === "wait" ? 41 : TARGET === "joint" ? 103 : 60;
// Wait/joint modes seed from the DEPLOYED wait default (the 2x1 refit), not the retired 2026-07-10
// distillation: the point of a further refit is to climb from what live play already runs.
const waitModule = await import(join(repoRoot, "src", "ai", "versions", "wait_scorer.ts"));
const leafModule = await import(join(repoRoot, "src", "ai", "versions", "v0_8_a13_profile.ts"));
const deployedWait = waitModule.SIDE_2X1_WAIT_WEIGHTS_2026_08_26;
const shippedLeaf = leafModule.V08_A13_VALUE_LEAF;
// JOINT layout: [leaf.b, ...leaf.w(60), wait.b, ...wait.w(41)] — one flat 103-dim vector so the CEM
// machinery stays untouched; evaluateLeaf splits it back into the two battery files. The top-level
// b is unused ballast (kept zero-mean) so the shape matches the other modes.
const shippedSource =
    TARGET === "wait"
        ? deployedWait
        : TARGET === "joint"
          ? { b: 0, w: [shippedLeaf.b, ...shippedLeaf.w, deployedWait.b, ...deployedWait.w] }
          : shippedLeaf;
const shipped = { b: shippedSource.b, w: [...shippedSource.w] };
if (shipped.w.length !== EXPECTED_DIMS || shipped.w.some((weight) => !Number.isFinite(weight))) {
    throw new Error(`Parsed ${TARGET} vector malformed: ${shipped.w.length} dims`);
}
log(`shipped ${TARGET} vector parsed: b=${shipped.b}, dims=${shipped.w.length}${BASE_LEAF ? `, base leaf ${BASE_LEAF}` : ""}`);

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
          shippedVal: null, // shipped leaf's rate on the held-out panel — the crowning anchor
          evaluations: 0,
      };

function evaluateLeaf(leaf, pairs, seed, label) {
    const leafFile = join(outDir, `cand_${label}.json`);
    const reportFile = join(outDir, `report_${label}.json`);
    writeFileSync(leafFile, JSON.stringify(leaf));
    let vectorArgs;
    if (TARGET === "joint") {
        const leafPart = { b: leaf.w[0], w: leaf.w.slice(1, 61) };
        const waitPart = { b: leaf.w[61], w: leaf.w.slice(62) };
        const leafPartFile = join(outDir, `cand_${label}_leaf.json`);
        const waitPartFile = join(outDir, `cand_${label}_wait.json`);
        writeFileSync(leafPartFile, JSON.stringify(leafPart));
        writeFileSync(waitPartFile, JSON.stringify(waitPart));
        vectorArgs = ["--leaf-file", leafPartFile, "--wait-file", waitPartFile];
    } else if (TARGET === "wait") {
        vectorArgs = [...(BASE_LEAF ? ["--leaf-file", BASE_LEAF] : []), "--wait-file", leafFile];
    } else {
        vectorArgs = ["--leaf-file", leafFile];
    }
    // Free-form battery args (e.g. "--candidate-policy public-roster --control-wait-file pin.json") so a
    // refit can run inside a COMPOSED candidate environment and against a pinned control.
    const extraArgs = (process.env.CEM_EXTRA_BATTERY_ARGS ?? "").split(" ").filter(Boolean);
    execFileSync(
        "bun",
        [
            join(repoRoot, "src", "simulation", "side_board_ab_battery.ts"),
            "--pairs", String(pairs),
            "--seed", String(seed),
            "--concurrency", String(CONC),
            "--output", reportFile,
            ...vectorArgs,
            ...extraArgs,
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

// The null anchor: the SHIPPED leaf on the held-out panel. Winner's-curse discipline — a
// generation winner is only crowned when its held-out rate beats what the shipped leaf scores on
// the very same panel, not merely the best-so-far (which starts at nothing).
if (state.shippedVal === null) {
    const anchor = evaluateLeaf({ b: shipped.b, w: [...shipped.w] }, VAL_PAIRS, VAL_SEED, "shipped_val");
    state.shippedVal = anchor.rate;
    log(`shipped-leaf VAL anchor: ${(anchor.rate * 100).toFixed(2)}% (lo=${(anchor.lo * 100).toFixed(2)}%)`);
    persist();
}

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
    // Winner's-curse guard: re-screen the top slice on a SECOND fresh panel and rank by the
    // average, so one lucky panel cannot pick the elites or the generation winner.
    const rescreenSeed = (SCREEN_SEED + generation * 7919 + 3571) >>> 0;
    const topSlice = scored.slice(0, Math.min(ELITE, scored.length));
    for (let index = 0; index < topSlice.length; index += 1) {
        if (Date.now() > deadline) break;
        const second = evaluateLeaf(topSlice[index].leaf, SCREEN_PAIRS, rescreenSeed, `g${generation}_r${index}`);
        topSlice[index].rate = (topSlice[index].rate + second.rate) / 2;
        log(`g${generation} r${index}: rescreen -> avg ${(topSlice[index].rate * 100).toFixed(2)}%`);
    }
    topSlice.sort((left, right) => right.rate - left.rate);
    const elites = topSlice;
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
    const genBest = topSlice[0];
    const validation = evaluateLeaf(genBest.leaf, VAL_PAIRS, VAL_SEED, `g${generation}_val`);
    log(
        `g${generation} BEST screen=${(genBest.rate * 100).toFixed(2)}% ` +
            `val=${(validation.rate * 100).toFixed(2)}% (lo=${(validation.lo * 100).toFixed(2)}%)`,
    );
    const beatsShipped = state.shippedVal === null || validation.rate > state.shippedVal;
    if (beatsShipped && (!state.globalBest || validation.rate > state.globalBest.valRate)) {
        state.globalBest = { leaf: genBest.leaf, screenRate: genBest.rate, valRate: validation.rate, valLo: validation.lo, generation };
        writeFileSync(bestPath, JSON.stringify(state.globalBest, null, 2));
        log(`NEW GLOBAL BEST: val ${(validation.rate * 100).toFixed(2)}%`);
    }
    state.generation += 1;
    persist();
}
log(`CEM loop done: ${state.generation} generations, ${state.evaluations} evaluations`);
