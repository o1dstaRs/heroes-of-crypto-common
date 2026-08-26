/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

// SIDE-BOARD A/B battery: the axis-aware A19 v0.8 CANDIDATE vs the previous (shipped, axis-blind)
// A19 v0.8 CONTROL, both playing the NEW side-oriented ranked environment in the same games.
//
//   bun src/simulation/side_board_ab_battery.ts [--pairs 500] [--seed 91000001] [--concurrency 8] \
//       [--output sim-out/side_ab/report.json] [--leaf-file candidate_leaf.json] [--classic]
//
// One PAIR = the same seed/roster/map played twice with the seats swapped (even game: candidate is
// GREEN/LOWER, odd: candidate is RED/UPPER), so seat luck cancels exactly. The control seat is put on
// FightProperties.legacyAxisPolicyTeams, which keeps every shipped raw-Y heuristic (value features,
// Backstab preference, Castling gate, placement frontness) byte-faithful for that seat while the
// BOARD RULES (zones, engine Backstab geometry) stay side-oriented for both. --leaf-file injects a
// refit 60-dim value leaf for the CANDIDATE seat only (per-team seam V07_VALUE_WEIGHTS_V2_LOWER/_UPPER);
// the control always runs the shipped V08_A13_VALUE_LEAF.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

import type { PlacementPolicyVariant } from "../ai/setup/setup_ship";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Doctrine } from "../doctrines/doctrine_properties";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { buildRoster } from "./army";
import { runMatch, type IMatchResult } from "./battle_engine";

const LIVE_MAPS = [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER] as const;

interface ISideAbGameSpec {
    game: number;
    pair: number;
    seed: number;
    gridType: number;
    /** Which physical team the CANDIDATE holds this game. */
    candidateTeam: number;
    /** Candidate 60-dim leaf ({b, w}) or null = candidate runs the shipped leaf too. */
    candidateLeaf: { b: number; w: number[] } | null;
    /** Candidate wait-scorer weights or null = the current baked default. */
    candidateWait: { b: number; w: number[] } | null;
    /**
     * CONTROL-seat wait-scorer pin, or null = the current baked default. The deployed default moved to
     * the 2x1 refit, so measuring against the PREVIOUS v0.8 requires pinning its 2026-07-10 vector here.
     */
    controlWait: { b: number; w: number[] } | null;
    /**
     * Candidate-seat placement policy (e.g. "public-roster" = the live ranked reveal-conditioned
     * placement, policy-armed exactly like the server's placementContextForTeam). Control never gets one.
     */
    candidatePolicy: string | null;
    /** Candidate seat's strategy version (default v0.8; "v0.8s" = the measurement alias for scoped envs). */
    candidateVersion: string;
    /** Classic bottom/top board instead of the side board (sanity baseline). */
    classic: boolean;
}

interface ISideAbGameResult {
    game: number;
    pair: number;
    seed: number;
    gridType: number;
    candidateTeam: number;
    winner: IMatchResult["winner"];
    candidateWon: boolean;
    decisive: boolean;
    laps: number;
    endReason: IMatchResult["endReason"];
    rejectedCandidate: number;
    rejectedControl: number;
}

function mulberry(seedValue: number): () => number {
    let state = seedValue >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function playSideAbGame(spec: ISideAbGameSpec): ISideAbGameResult {
    const controlTeam = spec.candidateTeam === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    // Per-team candidate leaf (per-game env; the SearchDriver is constructed per match).
    delete process.env.V07_VALUE_WEIGHTS_V2_LOWER;
    delete process.env.V07_VALUE_WEIGHTS_V2_UPPER;
    delete process.env.V07_WAIT_WEIGHTS_LOWER;
    delete process.env.V07_WAIT_WEIGHTS_UPPER;
    const candidateSeatKey = spec.candidateTeam === PBTypes.TeamVals.LOWER ? "LOWER" : "UPPER";
    const controlSeatKey = spec.candidateTeam === PBTypes.TeamVals.LOWER ? "UPPER" : "LOWER";
    if (spec.candidateLeaf) {
        process.env[`V07_VALUE_WEIGHTS_V2_${candidateSeatKey}`] = JSON.stringify(spec.candidateLeaf);
    }
    if (spec.candidateWait) {
        process.env[`V07_WAIT_WEIGHTS_${candidateSeatKey}`] = JSON.stringify(spec.candidateWait);
    }
    if (spec.controlWait) {
        process.env[`V07_WAIT_WEIGHTS_${controlSeatKey}`] = JSON.stringify(spec.controlWait);
    }
    const roster = buildRoster(mulberry(spec.seed ^ 0x5f356495), undefined, undefined, undefined, "expBudget");
    const setup = { doctrine: Doctrine.SEE_NONE, augments: SETUP_POLICY_V0.pickAugments(7) };
    const result = runMatch({
        greenVersion: spec.candidateTeam === PBTypes.TeamVals.LOWER ? spec.candidateVersion : "v0.8",
        redVersion: spec.candidateTeam === PBTypes.TeamVals.LOWER ? "v0.8" : spec.candidateVersion,
        roster,
        seed: spec.seed,
        gridType: spec.gridType,
        sideOrientedPlacement: !spec.classic,
        legacyAxisPolicyTeams: [controlTeam],
        placementAugmentTiming: "setup-before-placement",
        greenDoctrine: setup.doctrine,
        redDoctrine: setup.doctrine,
        greenAugments: setup.augments,
        redAugments: setup.augments,
        ...(spec.candidatePolicy
            ? spec.candidateTeam === PBTypes.TeamVals.LOWER
                ? { greenSetupPlacementPolicy: spec.candidatePolicy as PlacementPolicyVariant }
                : { redSetupPlacementPolicy: spec.candidatePolicy as PlacementPolicyVariant }
            : {}),
    });
    const candidateSide = spec.candidateTeam === PBTypes.TeamVals.LOWER ? "green" : "red";
    return {
        game: spec.game,
        pair: spec.pair,
        seed: spec.seed,
        gridType: spec.gridType,
        candidateTeam: spec.candidateTeam,
        winner: result.winner,
        candidateWon: result.winner === candidateSide,
        decisive: result.winner !== "draw",
        laps: result.laps,
        endReason: result.endReason,
        rejectedCandidate: candidateSide === "green" ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
        rejectedControl: candidateSide === "green" ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
    };
}

if (!isMainThread) {
    parentPort!.on("message", (message: { type: "game"; spec: ISideAbGameSpec } | { type: "stop" }) => {
        if (message.type === "stop") {
            process.exit(0);
        }
        try {
            parentPort!.postMessage({ type: "result", result: playSideAbGame(message.spec) });
        } catch (error) {
            parentPort!.postMessage({
                type: "error",
                game: message.spec.game,
                message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
            });
        }
    });
    parentPort!.postMessage({ type: "ready" });
}

function wilson95(wins: number, games: number): { rate: number; lo: number; hi: number } {
    if (!games) return { rate: 0, lo: 0, hi: 0 };
    const z = 1.959963984540054;
    const rate = wins / games;
    const denominator = 1 + (z * z) / games;
    const centre = rate + (z * z) / (2 * games);
    const margin = z * Math.sqrt((rate * (1 - rate)) / games + (z * z) / (4 * games * games));
    return { rate, lo: (centre - margin) / denominator, hi: (centre + margin) / denominator };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const readArg = (flag: string): string | undefined => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const pairs = Number(readArg("--pairs") ?? 500);
    const baseSeed = Number(readArg("--seed") ?? 91000001);
    const concurrency = Number(readArg("--concurrency") ?? 8);
    const output = readArg("--output") ?? `sim-out/side_ab/side_ab_seed${baseSeed}_p${pairs}.json`;
    const leafFile = readArg("--leaf-file");
    const waitFile = readArg("--wait-file");
    const controlWaitFile = readArg("--control-wait-file");
    const candidatePolicy = readArg("--candidate-policy") ?? null;
    // The candidate seat's strategy version. "v0.8s" is the byte-identical measurement ALIAS of v0.8:
    // running the candidate under it lets any VERSION-SCOPED env lever (V06_RIDER_EV_VERSIONS,
    // V06_AREA_THROW_VERSIONS, ...) arm on the candidate seat only, while the control's "v0.8" stays
    // out of scope — per-seat A/B for levers whose env is otherwise process-global.
    const candidateVersion = readArg("--candidate-version") ?? "v0.8";
    const classic = args.includes("--classic");
    // --maps 4 or --maps 3,4 focuses the rotation on a subset of the live maps (grid type ints),
    // for per-map diagnostics; the default stays the full live rotation.
    const mapsArg = readArg("--maps");
    const maps = mapsArg
        ? mapsArg
              .split(",")
              .map((raw) => Number(raw.trim()))
              .filter((gridType) => (LIVE_MAPS as readonly number[]).includes(gridType))
        : [...LIVE_MAPS];
    if (!maps.length) {
        throw new Error(`--maps matched none of the live maps (${LIVE_MAPS.join(",")}): ${mapsArg}`);
    }
    const candidateLeaf = leafFile ? (JSON.parse(readFileSync(leafFile, "utf8")) as { b: number; w: number[] }) : null;
    const candidateWait = waitFile ? (JSON.parse(readFileSync(waitFile, "utf8")) as { b: number; w: number[] }) : null;
    const controlWait = controlWaitFile
        ? (JSON.parse(readFileSync(controlWaitFile, "utf8")) as { b: number; w: number[] })
        : null;

    const specs: ISideAbGameSpec[] = [];
    for (let pair = 0; pair < pairs; pair += 1) {
        const seed = (baseSeed + pair * 0x9e3779b1) >>> 0;
        const gridType = maps[pair % maps.length];
        for (const candidateTeam of [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER]) {
            specs.push({
                game: specs.length,
                pair,
                seed,
                gridType,
                candidateTeam,
                candidateLeaf,
                controlWait,
                candidatePolicy,
                candidateVersion,
                candidateWait,
                classic,
            });
        }
    }

    const results: ISideAbGameResult[] = [];
    const errors: { game: number; message: string }[] = [];
    let nextSpec = 0;
    const startedAt = Date.now();
    let lastReport = startedAt;

    await new Promise<void>((resolve, reject) => {
        let liveWorkers = 0;
        const spawnWorker = (): void => {
            const worker = new Worker(new URL(import.meta.url), {
                env: {
                    ...process.env,
                    LIVETWIN: "1",
                    SIM_NO_ACTIONS: "1",
                },
            });
            liveWorkers += 1;
            const dispatch = (): void => {
                if (nextSpec >= specs.length) {
                    worker.postMessage({ type: "stop" });
                    return;
                }
                worker.postMessage({ type: "game", spec: specs[nextSpec] });
                nextSpec += 1;
            };
            worker.on(
                "message",
                (message: { type: string; result?: ISideAbGameResult; game?: number; message?: string }) => {
                    if (message.type === "ready") {
                        dispatch();
                        return;
                    }
                    if (message.type === "result" && message.result) {
                        results.push(message.result);
                    } else if (message.type === "error") {
                        errors.push({ game: message.game ?? -1, message: message.message ?? "unknown" });
                    }
                    const now = Date.now();
                    if (now - lastReport > 15_000) {
                        lastReport = now;
                        const done = results.length + errors.length;
                        const rate = done / ((now - startedAt) / 1000);
                        console.log(
                            `[side-ab] ${done}/${specs.length} games (${rate.toFixed(2)}/s, ` +
                                `eta ${Math.round((specs.length - done) / Math.max(rate, 0.01) / 60)}m)`,
                        );
                    }
                    dispatch();
                },
            );
            worker.on("exit", () => {
                liveWorkers -= 1;
                if (liveWorkers === 0) {
                    resolve();
                }
            });
            worker.on("error", reject);
        };
        for (let index = 0; index < Math.max(1, concurrency); index += 1) {
            spawnWorker();
        }
    });

    const decisive = results.filter((game) => game.decisive);
    const candidateWins = decisive.filter((game) => game.candidateWon).length;
    const stats = wilson95(candidateWins, decisive.length);
    const rejected = results.reduce(
        (sum, game) => ({
            candidate: sum.candidate + game.rejectedCandidate,
            control: sum.control + game.rejectedControl,
        }),
        { candidate: 0, control: 0 },
    );
    const perMap = maps.map((gridType) => {
        const games = decisive.filter((game) => game.gridType === gridType);
        const wins = games.filter((game) => game.candidateWon).length;
        return { gridType, games: games.length, candidateWins: wins, ...wilson95(wins, games.length) };
    });
    const report = {
        kind: classic ? "classic-board-sanity" : "side-board-ab",
        pairs,
        baseSeed,
        games: results.length,
        errors: errors.length,
        draws: results.length - decisive.length,
        decisive: decisive.length,
        candidateWins,
        candidateWinRate: stats.rate,
        wilson95: { lo: stats.lo, hi: stats.hi },
        perMap,
        rejected,
        candidateLeaf: candidateLeaf ? "injected" : "shipped",
        candidateWait: candidateWait ? "injected" : "baked-default",
        controlWait: controlWait ? "pinned" : "baked-default",
        candidatePolicy: candidatePolicy ?? "none",
        candidateVersion,
        wallSeconds: Math.round((Date.now() - startedAt) / 1000),
        errorSamples: errors.slice(0, 5),
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

if (isMainThread) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
