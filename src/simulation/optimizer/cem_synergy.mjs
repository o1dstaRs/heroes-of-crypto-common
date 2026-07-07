/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Cross-Entropy Method trainer for the SITUATIONAL synergy weight vector (11-dim, creature_score.DRAFT_FEATURE_NAMES).
 * Mirrors cem_setup.mjs, but the mean STARTS at the anchor (DRAFT_ANCHOR_W reproduces the scoreCreature
 * heuristic) instead of zeros, and sigma is PER-DIMENSION (relative to each weight's magnitude, since the
 * anchor weights span 0.125..95). Fitness = the weighted draft policy's decisive win rate vs the frozen
 * anchor in a `cemDraft` self-play tournament (cem_synergy_eval.ts), fanned out as parallel subprocesses.
 *
 *   CEM_POP=12 CEM_GENS=12 CEM_GAMES=4000 CEM_CONC=4 bun src/simulation/optimizer/cem_draft.mjs
 * Tunables: CEM_POP, CEM_ELITE, CEM_GENS, CEM_GAMES, CEM_VAL_GAMES, CEM_CONC, CEM_REL_SIGMA, CEM_SIGMA_DECAY,
 *           CEM_SEED. (DIM is fixed at 11 by the anchor.)
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, "..", "cem_synergy_eval.ts"); // src/simulation/cem_synergy_eval.ts

// Must stay in sync with creature_score.DRAFT_ANCHOR_W (scoreCreature's coefficients).
const ANCHOR = [1,0, 0,0, 1,0, 0,0, 0,0, 1,0, 0,0, 1,0]; // SYNERGY_ANCHOR_W (fixed BEST_SYNERGY_BY_FACTION)
const DIM = ANCHOR.length;

const POP = Number(process.env.CEM_POP || 12);
const ELITE = Number(process.env.CEM_ELITE || 3);
const GENS = Number(process.env.CEM_GENS || 12);
const GAMES = Number(process.env.CEM_GAMES || 4000);
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES || 8000);
const CONC = Number(process.env.CEM_CONC || 4);
const REL_SIGMA = Number(process.env.CEM_REL_SIGMA || 0.4); // per-dim sigma = REL_SIGMA * (|anchor|+eps)
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY || 0.9);
// CO-EVOLUTION (CEM_COEVOLVE=1): each pass finds the best RESPONSE to the current frozen opponent, then that
// response becomes the next frozen opponent (iterated best-response / fictitious self-play). Prevents the
// reward-hack of hard-countering ONE fixed anchor — drives toward a draft robust across opponents. Each pass's
// champion is appended to champions.jsonl for a later round-robin (win rates aren't comparable across passes).
const COEVOLVE = process.env.CEM_COEVOLVE === "1";
const BASE_SEED = Number(process.env.CEM_SEED || 1);
const VAL_SEED = BASE_SEED ^ 0x5f356495;
const HOURS = Number(process.env.CEM_HOURS || 0);
const DEADLINE = HOURS > 0 ? Date.now() + HOURS * 3600 * 1000 : 0;

// Per-dimension search scale + floor, proportional to each anchor weight (so tiny weights aren't swamped and
// large ones aren't frozen). eps keeps a zero anchor weight searchable.
const scale = ANCHOR.map((a) => REL_SIGMA * (Math.abs(a) + 0.5));
const sigmaFloor = scale.map((s) => 0.25 * s);

const OUT = join(process.cwd(), "sim-out", "cem_synergy");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "trace.log");
const log = (m) => {
    console.log(m);
    appendFileSync(LOG, m + "\n");
};

let rngState = (BASE_SEED >>> 0) || 1;
const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
};
const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// The current frozen opponent (co-evolution updates it each pass; otherwise stays the anchor via default).
let frozen = ANCHOR.slice();

/** Evaluate one weight vector as a subprocess → decisive win rate of the weighted draft policy vs `frozen`. */
const evaluate = (weights, games, seed) =>
    new Promise((resolve) => {
        const child = spawn("bun", [EVAL, String(games), String(seed), String(CONC)], {
            env: {
                ...process.env,
                V05_SYNERGY_WEIGHTS: JSON.stringify(weights),
                V05_DRAFT_FROZEN_WEIGHTS: JSON.stringify(frozen),
            },
            cwd: process.cwd(),
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => process.stderr.write(d));
        child.on("close", () => {
            try {
                resolve(JSON.parse(out.trim().split("\n").pop()).winRate);
            } catch {
                resolve(0);
            }
        });
    });

const mean = ANCHOR.slice();
let sigma = scale.slice();

async function main() {
    writeFileSync(LOG, "");
    log(
        `CEM synergy: DIM=${DIM} POP=${POP} ELITE=${ELITE} GENS=${GENS} GAMES=${GAMES} CONC=${CONC} ` +
            `relSigma=${REL_SIGMA} seed=${BASE_SEED} hours=${HOURS} anchor=[${ANCHOR.join(",")}] -> ${OUT}`,
    );
    let bestVal = -1;
    let bestVec = mean.slice();
    let pass = 0;

    do {
        for (let gen = 0; gen < GENS; gen += 1) {
            const genSeed = (BASE_SEED + pass * 1_000_003 + gen * 0x9e3779b1) >>> 0;
            // Candidate 0 is the current mean (starts at anchor → incumbency: elite never drops below heuristic).
            const cands = [mean.slice()];
            for (let i = 1; i < POP; i += 1) {
                cands.push(mean.map((m, d) => m + sigma[d] * gauss()));
            }
            const scores = await Promise.all(cands.map((w) => evaluate(w, GAMES, genSeed)));
            const ranked = cands.map((w, i) => ({ w, s: scores[i] })).sort((a, b) => b.s - a.s);
            const elite = ranked.slice(0, ELITE);
            for (let d = 0; d < DIM; d += 1) {
                const vals = elite.map((e) => e.w[d]);
                const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
                const varr = vals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / vals.length;
                mean[d] = mu;
                sigma[d] = Math.max(sigmaFloor[d], Math.max(Math.sqrt(varr), sigma[d] * SIGMA_DECAY));
            }
            const genBest = ranked[0];
            log(
                `pass ${pass} gen ${gen}: best=${(genBest.s * 100).toFixed(2)}% ` +
                    `mean=${((ranked.reduce((a, r) => a + r.s, 0) / POP) * 100).toFixed(2)}% ` +
                    `elite=[${elite.map((e) => (e.s * 100).toFixed(1)).join(",")}] ` +
                    `w*=[${genBest.w.map((x) => x.toFixed(2)).join(",")}]`,
            );
            if (genBest.s > bestVal) {
                bestVal = genBest.s;
                bestVec = genBest.w.slice();
            }
            writeFileSync(
                join(OUT, "best.json"),
                JSON.stringify({ weights: bestVec, trainWinRate: bestVal, pass, gen }, null, 2),
            );
        }
        if (COEVOLVE) {
            // Iterated best-response: this pass's champion becomes the next frozen opponent. Log it (win rate is
            // vs the PREVIOUS frozen, not comparable across passes), then reset the search to best-respond anew.
            appendFileSync(
                join(OUT, "champions.jsonl"),
                JSON.stringify({ pass, winVsPrevFrozen: bestVal, vec: bestVec, prevFrozen: frozen }) + "\n",
            );
            log(`pass ${pass} champion beats prev-frozen ${(bestVal * 100).toFixed(2)}% -> becomes next frozen`);
            frozen = bestVec.slice();
            for (let d = 0; d < DIM; d += 1) {
                mean[d] = frozen[d];
                sigma[d] = scale[d];
            }
            bestVal = -1;
            bestVec = frozen.slice();
        } else if (DEADLINE && Date.now() < DEADLINE) {
            // Long-run exploration: re-inflate sigma and restart from the best-so-far.
            for (let d = 0; d < DIM; d += 1) {
                mean[d] = bestVec[d];
                sigma[d] = scale[d];
            }
        }
        pass += 1;
    } while (DEADLINE && Date.now() < DEADLINE);

    const valWin = await evaluate(bestVec, VAL_GAMES, VAL_SEED);
    log(`VALIDATION best on held-out seed: ${(valWin * 100).toFixed(2)}% (train ${(bestVal * 100).toFixed(2)}%)`);
    writeFileSync(
        join(OUT, "best.json"),
        JSON.stringify({ weights: bestVec, trainWinRate: bestVal, valWinRate: valWin, anchor: ANCHOR }, null, 2),
    );
    log(`DONE. best.json -> ${join(OUT, "best.json")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
