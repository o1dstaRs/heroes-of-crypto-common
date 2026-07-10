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

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
    enumerateCandidates,
    getAIStrategy,
    type IAIStrategy,
    type IDecisionContext,
    type IEnumeratedCandidate,
} from "../ai";
import type { GameAction } from "../engine/actions";
import type { GameEvent } from "../engine/events";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../utils/lib";
import { hashSimulationParts, makeRng } from "./army";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";
import { advanceTowardEnemyAction, forceStalledLap } from "./turn_recovery";
import { extractValueFeatures, VALUE_FEATURE_NAMES } from "./value_features";

/**
 * B2 / RAWS — the WIDE-CANDIDATE ROLLOUT SEARCH driver (v0.7 roadmap).
 *
 * Generalizes lookahead.ts (2-ply, <=5 melee-only candidates, single-sample scoring) into a SearchDriver
 * over the F4 enumerated candidate generator (ai/candidates.ts): alternative melee (target x stand-cell)
 * pairs, alternative shot aims, area throws, every castable spell, defend and wait — for EVERY unit type.
 * Candidate 0 is always the incumbent policy decision (the anchor). Plain MOVE (kite/retreat-cell)
 * candidates are EXCLUDED by default — that candidate class is ledger-dead twice (crude hold and
 * safe-frontier kiting both regressed); SEARCH_INCLUDE_MOVES=1 re-includes them for experiments only.
 *
 * SCORING: each candidate is played through the REAL engine on the live battle state (battle_snapshot
 * save/restore around every rollout), then the game rolls forward — both sides playing their real
 * policies — to a fixed horizon of SEARCH_HORIZON unit-turns (default 12, roughly one lap). The leaf is
 * the LEARNED VALUE function (fit_value.mjs logistic weights over value_features.ts, via
 * V07_VALUE_WEIGHTS={b,w:[...]}) expressed as P(win) for the acting team; without weights it falls back
 * to a normalized-material probability. Each candidate is scored by SEARCH_ROLLOUTS (default 3)
 * PAIRED-SEED rollouts: rollout r uses the same private RNG seed for every candidate, so candidates are
 * compared on identical luck and the tournament's seeded stream is never advanced (same RNG hygiene as
 * lookahead.ts — source swapped around the whole search and restored in `finally`).
 *
 * OVERRIDE GATE: the incumbent is only overridden when the best challenger's MEAN leaf value exceeds the
 * incumbent's mean by at least SEARCH_GATE (default 0.01, i.e. one point of win probability). An
 * incumbent that is ILLEGAL in simulation (the engine rejects every real action — the case battle_engine
 * papers over with its advance/defend recovery) is always overridden by the best legal candidate.
 *
 * MODES (all default OFF -> byte-identical default behaviour):
 *   V07_SEARCH=1        — the search mode above, applied to strategy versions in SEARCH_VERSIONS
 *                         (default "v0.6s", the registered search-alias of v0.6 — so `run_tournament
 *                         v0.6s v0.6` measures exactly "v0.6 + search vs v0.6").
 *   Q2_WAIT_ABLATION=1  — the Q2 Tempo-Commander GATE-0 ablation (observational; never overrides): at
 *                         every decision point where the hourglass WAIT is available, score the same
 *                         candidate set under (a) a FIRST-ENEMY-REPLY horizon (what the shelved 2-ply
 *                         lookahead saw) and (b) a FULL-LAP horizon (rolls through hourglass-queue
 *                         resolution, so the wait branch actually sees its payoff), and log whether the
 *                         wait-vs-act choice FLIPS between horizons. Default SEARCH_VERSIONS "v0.6"
 *                         (both sides of a v0.6 mirror contribute on-policy decision points).
 *   Q2_ORACLE=1         — the Q2 Tempo-Commander GATE-1 act-vs-wait ORACLE (overriding): at every
 *                         decision point where the hourglass wait is engine-legal for the acting unit,
 *                         score ONLY {incumbent action, wait} — each by SEARCH_ROLLOUTS paired-seed
 *                         rollouts to the END-OF-LAP horizon (rolled THROUGH hourglass-queue
 *                         resolution, so the wait branch sees its second-mover payoff; a first-reply
 *                         horizon structurally undervalues wait — Gate-0 measured 40.5% verdict flips
 *                         between the two) — and take the wait when it beats the incumbent's mean by
 *                         SEARCH_GATE. NO other candidate class is generated or scored: this isolates
 *                         the tempo axis from B2's full wide-candidate search. An incumbent that
 *                         already waits is a degenerate {wait, wait} point and is kept unchanged (the
 *                         oracle only arbitrates act->wait; re-litigating policy waits is B2's job).
 *                         Default SEARCH_VERSIONS "v0.6s" (so `run_tournament v0.6s v0.6` measures
 *                         exactly "v0.6 + wait-oracle vs plain v0.6"). SEARCH_HORIZON is ignored — the
 *                         horizon is always the lap boundary (capped at MAX_LAP_HORIZON_TURNS).
 *
 * AUDIT (SEARCH_AUDIT=<jsonl path, or "1" for ./search_audit.jsonl>): one summary line per game with the
 * override/flip counters, per-class distributions and wall-clock cost; SEARCH_AUDIT_TURNS=1 adds one line
 * per searched turn. Lines are buffered per game and appended once (atomic enough across worker threads).
 *
 * OPPONENT-MODEL MISMATCH (SEARCH_OPP_MODEL=<version>, experiment-only): inside rollouts, the ENEMY of the
 * searched unit is simulated with this strategy instead of its true one (the acting side keeps its real
 * policy, and the LIVE opponent still plays its true policy — only the search's internal model changes).
 * Quantifies how much of the search gain is perfect-opponent-model knowledge that live opponents won't
 * grant. Unknown version strings throw at construction — a silently ignored knob would fake the A/B.
 */

const MAX_LAP_HORIZON_TURNS = 64;
const MAX_REPLY_HORIZON_TURNS = 12;

type SearchMode = "off" | "search" | "ablation" | "oracle";
type HorizonMode = "turns" | "reply" | "lap";

/** The slice of a candidate the rollout scorer actually consumes (lets the oracle skip enumeration). */
type ISearchCandidate = Pick<IEnumeratedCandidate, "kind" | "actions">;

/** Learned leaf weights (fit_value.mjs output) aligned to VALUE_FEATURE_NAMES. */
interface ILearnedValue {
    b: number;
    w: number[];
}

function parseLearnedValue(raw: string | undefined): ILearnedValue | null {
    if (!raw) {
        return null;
    }
    try {
        const m = JSON.parse(raw);
        if (
            m &&
            typeof m.b === "number" &&
            Number.isFinite(m.b) &&
            Array.isArray(m.w) &&
            m.w.length === VALUE_FEATURE_NAMES.length &&
            m.w.every((x: unknown) => typeof x === "number" && Number.isFinite(x))
        ) {
            return { b: m.b, w: m.w as number[] };
        }
    } catch {
        /* malformed -> material fallback */
    }
    return null;
}

const envNum = (name: string, fallback: number, min: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= min ? v : fallback;
};

/** Classify an arbitrary decided action list into the candidate-kind vocabulary (for audit buckets). */
export function classifyActions(actions: readonly GameAction[]): string {
    for (const a of actions) {
        switch (a.type) {
            case "melee_attack":
                return "melee";
            case "range_attack":
                return "shot";
            case "area_throw_attack":
                return "area_throw";
            case "cast_spell":
                return "spell";
            case "wait_turn":
                return "wait";
            case "defend_turn":
                return "defend";
            case "obstacle_attack":
                return "mine";
            default:
                break;
        }
    }
    if (actions.some((a) => a.type === "move_unit")) {
        return "move";
    }
    return "idle";
}

interface ISearchCounters {
    /** Turns the driver ran on (enabled + version matched + unit alive). */
    decisions: number;
    /** Decisions actually searched (>= 2 candidates after class filtering). */
    searched: number;
    /** Decisions where the gate fired and the incumbent was replaced. */
    overrides: number;
    /** Searched decisions whose incumbent was rejected by the engine in simulation. */
    illegalIncumbent: number;
    /** Decisions skipped because only the incumbent existed after filtering. */
    singleCandidate: number;
    candidatesTotal: number;
    rolloutTurnsTotal: number;
    msTotal: number;
    searchedByIncumbentKind: Record<string, number>;
    overridesByIncumbentKind: Record<string, number>;
    overridesToKind: Record<string, number>;
    // --- Q2 ablation ---
    q2Points: number;
    q2Flips: number;
    q2ReplyWaitBest: number;
    q2LapWaitBest: number;
    q2IncumbentWait: number;
    q2ReplyAgreesIncumbent: number;
    q2LapAgreesIncumbent: number;
    // --- Q2 gate-1 oracle ---
    /** Wait-eligible decision points seen (degenerate incumbent-wait points included). */
    q2oPoints: number;
    /** Points where both {incumbent, wait} were actually rollout-scored. */
    q2oScored: number;
    /** Points whose incumbent already waits (degenerate — kept, never scored). */
    q2oIncumbentWait: number;
    /** Scored points the oracle overrode to wait. */
    q2oWaits: number;
    /** Engine rejected a wait the driver-side canWaitOnHourglass mirror allowed (desync tripwire; expect 0). */
    q2oWaitRejected: number;
    /** Sum/count of (wait - incumbent) mean-leaf deltas over points where both were legal. */
    q2oDeltaSum: number;
    q2oDeltaCount: number;
}

const emptyCounters = (): ISearchCounters => ({
    decisions: 0,
    searched: 0,
    overrides: 0,
    illegalIncumbent: 0,
    singleCandidate: 0,
    candidatesTotal: 0,
    rolloutTurnsTotal: 0,
    msTotal: 0,
    searchedByIncumbentKind: {},
    overridesByIncumbentKind: {},
    overridesToKind: {},
    q2Points: 0,
    q2Flips: 0,
    q2ReplyWaitBest: 0,
    q2LapWaitBest: 0,
    q2IncumbentWait: 0,
    q2ReplyAgreesIncumbent: 0,
    q2LapAgreesIncumbent: 0,
    q2oPoints: 0,
    q2oScored: 0,
    q2oIncumbentWait: 0,
    q2oWaits: 0,
    q2oWaitRejected: 0,
    q2oDeltaSum: 0,
    q2oDeltaCount: 0,
});

const bump = (rec: Record<string, number>, key: string): void => {
    rec[key] = (rec[key] ?? 0) + 1;
};

export interface ISearchMatchInfo {
    seed?: number;
    greenVersion?: string;
    redVersion?: string;
}

export class SearchDriver {
    public readonly enabled: boolean;
    private readonly mode: SearchMode;
    private readonly deps: ILookaheadDeps;
    private readonly match: ISearchMatchInfo;
    private readonly versions: ReadonlySet<string>;
    private readonly gate: number;
    private readonly horizon: number;
    private readonly rollouts: number;
    private readonly includeMoves: boolean;
    private readonly learned: ILearnedValue | null;
    /** SEARCH_OPP_MODEL — rollouts simulate the searched unit's ENEMY with this strategy (null = true policy). */
    private readonly oppModel: IAIStrategy | null;
    /** The enemy team of the rollout in flight (only meaningful while a rollout runs; null otherwise). */
    private rolloutEnemyTeam: TeamType | null = null;
    private readonly auditPath: string | undefined;
    private readonly auditTurns: boolean;
    private readonly caps: {
        maxMoveDestinations: number;
        maxMeleePairs: number;
        maxShotAims: number;
        maxAreaThrowCells: number;
    };
    private readonly counters = emptyCounters();
    private readonly turnRows: string[] = [];
    private finishedSim = false;
    public constructor(deps: ILookaheadDeps, match: ISearchMatchInfo = {}) {
        this.deps = deps;
        this.match = match;
        this.mode =
            process.env.Q2_WAIT_ABLATION === "1"
                ? "ablation"
                : process.env.Q2_ORACLE === "1"
                  ? "oracle"
                  : process.env.V07_SEARCH === "1"
                    ? "search"
                    : "off";
        this.enabled = this.mode !== "off";
        this.versions = new Set(
            (process.env.SEARCH_VERSIONS ?? (this.mode === "ablation" ? "v0.6" : "v0.6s"))
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
        );
        this.gate = envNum("SEARCH_GATE", 0.01, 0);
        this.horizon = Math.floor(envNum("SEARCH_HORIZON", 12, 1));
        this.rollouts = Math.floor(envNum("SEARCH_ROLLOUTS", 3, 1));
        this.includeMoves = process.env.SEARCH_INCLUDE_MOVES === "1";
        this.learned = parseLearnedValue(process.env.V07_VALUE_WEIGHTS);
        const rawOppModel = this.enabled ? process.env.SEARCH_OPP_MODEL?.trim() : undefined;
        this.oppModel = rawOppModel ? getAIStrategy(rawOppModel) : null; // throws on an unknown version
        const rawAudit = process.env.SEARCH_AUDIT;
        this.auditPath =
            !rawAudit || rawAudit === "0"
                ? undefined
                : rawAudit === "1"
                  ? join(process.cwd(), "search_audit.jsonl")
                  : rawAudit;
        this.auditTurns = process.env.SEARCH_AUDIT_TURNS === "1";
        this.caps = {
            // Moves are class-filtered out below (kite/retreat is ledger-dead); cap the enumeration to 1 so
            // the generator does no wasted per-destination work when they are excluded anyway.
            maxMoveDestinations: this.includeMoves ? Math.floor(envNum("SEARCH_MAX_MOVES", 6, 1)) : 1,
            maxMeleePairs: Math.floor(envNum("SEARCH_MAX_MELEE", 8, 1)),
            maxShotAims: Math.floor(envNum("SEARCH_MAX_SHOTS", 6, 1)),
            maxAreaThrowCells: Math.floor(envNum("SEARCH_MAX_THROWS", 4, 1)),
        };
    }
    /** Whether this driver re-decides turns for the given strategy version. */
    public appliesTo(version: string): boolean {
        return this.enabled && this.versions.has(version);
    }
    /**
     * Replace the strategy's single decision with the best-by-rollout candidate (search mode), arbitrate
     * act-vs-wait by lap rollout (oracle mode), or log the Q2 wait-horizon ablation and return the
     * incumbent unchanged (ablation mode).
     */
    public chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[] {
        if (!this.appliesTo(version)) {
            return incumbent;
        }
        const t0 = performance.now();
        this.counters.decisions += 1;
        const savedSource = getDeterministicRandomSource();
        const savedActive = this.deps.getActiveUnitId();
        const seedBase = this.simSeed(unit);
        // Swap the tournament's seeded RNG to a PRIVATE stream around the WHOLE search (enumeration
        // included) and restore the exact source reference in `finally` — identical hygiene to
        // lookahead.ts, so V07_SEARCH off/on stay individually reproducible and paired A/Bs stay paired.
        setDeterministicRandomSource(makeRng(seedBase));
        try {
            if (this.mode === "oracle") {
                // Gate-1 never enumerates: the candidate pair is {incumbent, wait} by construction.
                return this.oracle(unit, incumbent, seedBase, t0);
            }
            const context: IDecisionContext = {
                grid: this.deps.grid,
                matrix: this.deps.grid.getMatrix(),
                unitsHolder: this.deps.unitsHolder,
                pathHelper: this.deps.pathHelper,
                attackHandler: this.deps.attackHandler,
                fightProperties: this.deps.fightProperties,
            };
            const set = enumerateCandidates(unit, context, incumbent, this.caps);
            const candidates = set.candidates.filter(
                (c) => c.kind === "incumbent" || this.includeMoves || c.kind !== "move",
            );
            if (this.mode === "ablation") {
                return this.ablate(unit, candidates, incumbent, seedBase, t0);
            }
            if (candidates.length <= 1) {
                this.counters.singleCandidate += 1;
                return incumbent;
            }
            return this.search(unit, candidates, incumbent, seedBase, t0);
        } finally {
            setDeterministicRandomSource(savedSource);
            this.deps.setActiveUnitId(savedActive);
            this.finishedSim = false;
            this.rolloutEnemyTeam = null;
        }
    }
    /** Flush the per-game audit summary (one JSONL line + any buffered per-turn rows). */
    public onMatchEnd(winner?: string, endReason?: string): void {
        if (!this.enabled || !this.auditPath || this.counters.decisions === 0) {
            return;
        }
        const c = this.counters;
        const summary = {
            t: "game",
            mode: this.mode,
            seed: this.match.seed,
            green: this.match.greenVersion,
            red: this.match.redVersion,
            winner,
            endReason,
            gate: this.gate,
            horizon: this.mode === "oracle" ? "lap" : this.horizon,
            rollouts: this.rollouts,
            leaf: this.learned ? "learned" : "material",
            ...(this.oppModel ? { oppModel: this.oppModel.version } : {}),
            decisions: c.decisions,
            searched: c.searched,
            overrides: c.overrides,
            illegalIncumbent: c.illegalIncumbent,
            singleCandidate: c.singleCandidate,
            candidatesTotal: c.candidatesTotal,
            rolloutTurnsTotal: c.rolloutTurnsTotal,
            msTotal: Math.round(c.msTotal * 10) / 10,
            searchedByIncumbentKind: c.searchedByIncumbentKind,
            overridesByIncumbentKind: c.overridesByIncumbentKind,
            overridesToKind: c.overridesToKind,
            ...(this.mode === "ablation"
                ? {
                      q2Points: c.q2Points,
                      q2Flips: c.q2Flips,
                      q2ReplyWaitBest: c.q2ReplyWaitBest,
                      q2LapWaitBest: c.q2LapWaitBest,
                      q2IncumbentWait: c.q2IncumbentWait,
                      q2ReplyAgreesIncumbent: c.q2ReplyAgreesIncumbent,
                      q2LapAgreesIncumbent: c.q2LapAgreesIncumbent,
                  }
                : {}),
            ...(this.mode === "oracle"
                ? {
                      q2oPoints: c.q2oPoints,
                      q2oScored: c.q2oScored,
                      q2oIncumbentWait: c.q2oIncumbentWait,
                      q2oWaits: c.q2oWaits,
                      q2oWaitRejected: c.q2oWaitRejected,
                      q2oDeltaCount: c.q2oDeltaCount,
                      q2oDeltaSum: Number(c.q2oDeltaSum.toFixed(6)),
                  }
                : {}),
        };
        try {
            appendFileSync(this.auditPath, `${[...this.turnRows, JSON.stringify(summary)].join("\n")}\n`);
        } catch {
            /* best-effort audit */
        }
        this.turnRows.length = 0;
    }
    // ---- search mode ----------------------------------------------------------------------------
    private search(
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        incumbent: GameAction[],
        seedBase: number,
        t0: number,
    ): GameAction[] {
        const incumbentKind = classifyActions(incumbent);
        this.counters.searched += 1;
        this.counters.candidatesTotal += candidates.length;
        bump(this.counters.searchedByIncumbentKind, incumbentKind);

        const means = this.scoreCandidates(unit, candidates, seedBase, "turns");
        let bestIdx = 0;
        for (let i = 1; i < means.length; i += 1) {
            if (means[i] > means[bestIdx]) {
                bestIdx = i;
            }
        }
        const incumbentIllegal = means[0] === -Infinity;
        if (incumbentIllegal) {
            this.counters.illegalIncumbent += 1;
        }
        // The GATE: trust the policy unless a challenger clearly beats it on mean rollout value. An
        // incumbent that is illegal in sim is always replaced by the best legal candidate.
        const overridden =
            bestIdx !== 0 &&
            means[bestIdx] !== -Infinity &&
            (incumbentIllegal || means[bestIdx] - means[0] >= this.gate);
        if (overridden) {
            this.counters.overrides += 1;
            bump(this.counters.overridesByIncumbentKind, incumbentKind);
            bump(this.counters.overridesToKind, candidates[bestIdx].kind);
        }
        const ms = performance.now() - t0;
        this.counters.msTotal += ms;
        if (this.auditPath && this.auditTurns) {
            this.turnRows.push(
                JSON.stringify({
                    t: "turn",
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    nc: candidates.length,
                    inc: incumbentKind,
                    chosen: overridden ? candidates[bestIdx].kind : incumbentKind,
                    ov: overridden ? 1 : 0,
                    d:
                        means[bestIdx] === -Infinity || means[0] === -Infinity
                            ? null
                            : Number((means[bestIdx] - means[0]).toFixed(4)),
                    ms: Math.round(ms * 10) / 10,
                }),
            );
        }
        return overridden ? candidates[bestIdx].actions : incumbent;
    }
    // ---- Q2 gate-0 ablation ---------------------------------------------------------------------
    private static isWaitCandidate(c: IEnumeratedCandidate): boolean {
        return c.kind === "wait" || (c.kind === "incumbent" && c.actions.some((a) => a.type === "wait_turn"));
    }
    /**
     * OBSERVATIONAL: at a decision point where the hourglass wait is available, ask both horizons which
     * candidate they'd pick and log whether the wait-vs-act verdict flips. Always returns the incumbent,
     * so the game itself stays pure v0.6-vs-v0.6 (on-policy decision points).
     */
    private ablate(
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        incumbent: GameAction[],
        seedBase: number,
        t0: number,
    ): GameAction[] {
        if (candidates.length <= 1 || !candidates.some((c) => SearchDriver.isWaitCandidate(c))) {
            return incumbent;
        }
        const reply = this.scoreCandidates(unit, candidates, seedBase, "reply");
        const lap = this.scoreCandidates(unit, candidates, seedBase, "lap");
        const argmax = (m: number[]): number => {
            let best = 0;
            for (let i = 1; i < m.length; i += 1) {
                if (m[i] > m[best]) {
                    best = i;
                }
            }
            return best;
        };
        const replyBest = argmax(reply);
        const lapBest = argmax(lap);
        const replyWait = SearchDriver.isWaitCandidate(candidates[replyBest]);
        const lapWait = SearchDriver.isWaitCandidate(candidates[lapBest]);
        const incumbentWait = incumbent.some((a) => a.type === "wait_turn");
        const flip = replyWait !== lapWait;

        const c = this.counters;
        c.q2Points += 1;
        c.candidatesTotal += candidates.length;
        if (flip) {
            c.q2Flips += 1;
        }
        if (replyWait) {
            c.q2ReplyWaitBest += 1;
        }
        if (lapWait) {
            c.q2LapWaitBest += 1;
        }
        if (incumbentWait) {
            c.q2IncumbentWait += 1;
        }
        if (replyWait === incumbentWait) {
            c.q2ReplyAgreesIncumbent += 1;
        }
        if (lapWait === incumbentWait) {
            c.q2LapAgreesIncumbent += 1;
        }
        const ms = performance.now() - t0;
        c.msTotal += ms;
        if (this.auditPath && this.auditTurns) {
            this.turnRows.push(
                JSON.stringify({
                    t: "q2",
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    nc: candidates.length,
                    incWait: incumbentWait ? 1 : 0,
                    replyWait: replyWait ? 1 : 0,
                    lapWait: lapWait ? 1 : 0,
                    flip: flip ? 1 : 0,
                    ms: Math.round(ms * 10) / 10,
                }),
            );
        }
        return incumbent;
    }
    // ---- Q2 gate-1 act-vs-wait oracle -------------------------------------------------------------
    /**
     * Driver-side mirror of GameActionEngine.canWaitOnHourglass (private there; ai/candidates.addWait
     * keeps the same copy). Every scored wait the engine then REJECTS anyway is counted in
     * q2oWaitRejected — the alreadyHourglass state-desync tripwire (see ranked-skip-rejections): in a
     * healthy sim this predicate and the engine agree 100%, so the counter must stay 0.
     */
    private canHourglass(unit: Unit): boolean {
        const fp = this.deps.fightProperties;
        const team = unit.getTeam();
        const id = unit.getId();
        return (
            (team === PBTypes.TeamVals.LOWER || team === PBTypes.TeamVals.UPPER) &&
            fp.getTeamUnitsAlive(team) > 1 &&
            !fp.hourglassIncludes(id) &&
            !fp.hasAlreadyMadeTurn(id) &&
            !fp.hasAlreadyHourglass(id)
        );
    }
    /**
     * GATE-1 (the tempo-axis falsifier): if the acting unit can hourglass, score ONLY {incumbent, wait}
     * — each by SEARCH_ROLLOUTS paired-seed rollouts to the END-OF-LAP horizon (through hourglass-queue
     * resolution, so the wait branch sees its second-mover payoff) — and take the wait when its mean
     * leaf beats the incumbent's by SEARCH_GATE. The set is deliberately this narrow: it measures the
     * act-vs-wait tempo axis in isolation from B2's full wide-candidate search. An incumbent that is
     * illegal in sim (nothing lands) is always replaced by a legal wait, mirroring search mode.
     */
    private oracle(unit: Unit, incumbent: GameAction[], seedBase: number, t0: number): GameAction[] {
        const c = this.counters;
        if (incumbent.some((a) => a.type === "wait_turn")) {
            // Degenerate {wait, wait} point: the policy already waits; there is no "act" branch to score.
            c.q2oPoints += 1;
            c.q2oIncumbentWait += 1;
            return incumbent;
        }
        if (!this.canHourglass(unit)) {
            return incumbent; // not a wait-eligible decision point
        }
        c.q2oPoints += 1;
        c.q2oScored += 1;
        c.searched += 1;
        c.candidatesTotal += 2;
        const incumbentKind = classifyActions(incumbent);
        bump(c.searchedByIncumbentKind, incumbentKind);
        const candidates: ISearchCandidate[] = [
            { kind: "incumbent", actions: incumbent },
            { kind: "wait", actions: [{ type: "wait_turn", unitId: unit.getId() }] },
        ];
        const means = this.scoreCandidates(unit, candidates, seedBase, "lap");
        const incumbentIllegal = means[0] === -Infinity;
        const waitRejected = means[1] === -Infinity;
        if (incumbentIllegal) {
            c.illegalIncumbent += 1;
        }
        if (waitRejected) {
            c.q2oWaitRejected += 1; // pre-registered desync tripwire — investigate any nonzero total
        }
        if (!incumbentIllegal && !waitRejected) {
            c.q2oDeltaSum += means[1] - means[0];
            c.q2oDeltaCount += 1;
        }
        const overridden = !waitRejected && (incumbentIllegal || means[1] - means[0] >= this.gate);
        if (overridden) {
            c.overrides += 1;
            c.q2oWaits += 1;
            bump(c.overridesByIncumbentKind, incumbentKind);
            bump(c.overridesToKind, "wait");
        }
        const ms = performance.now() - t0;
        c.msTotal += ms;
        if (this.auditPath && this.auditTurns) {
            this.turnRows.push(
                JSON.stringify({
                    t: "q2o",
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    inc: incumbentKind,
                    ov: overridden ? 1 : 0,
                    rej: waitRejected ? 1 : 0,
                    d: incumbentIllegal || waitRejected ? null : Number((means[1] - means[0]).toFixed(4)),
                    ms: Math.round(ms * 10) / 10,
                }),
            );
        }
        return overridden ? candidates[1].actions : incumbent;
    }
    // ---- rollout scoring --------------------------------------------------------------------------
    /** Mean leaf value per candidate over SEARCH_ROLLOUTS paired-seed rollouts (-Infinity = illegal). */
    private scoreCandidates(
        unit: Unit,
        candidates: readonly ISearchCandidate[],
        seedBase: number,
        horizonMode: HorizonMode,
    ): number[] {
        const snapshot = snapshotBattle(this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties);
        const savedStats = this.deps.captureDamageStats();
        const means: number[] = [];
        for (const cand of candidates) {
            let sum = 0;
            let illegal = false;
            for (let r = 0; r < this.rollouts; r += 1) {
                let score: number;
                try {
                    score = this.rollout(unit, cand, seedBase, r, horizonMode);
                } finally {
                    restoreBattle(snapshot, this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties);
                    this.deps.restoreDamageStats(savedStats);
                }
                if (score === -Infinity) {
                    illegal = true;
                    break;
                }
                sum += score;
            }
            means.push(illegal ? -Infinity : sum / this.rollouts);
        }
        return means;
    }
    /**
     * One rollout: apply the candidate through the real engine, close the turn, then let BOTH sides play
     * their real policies forward to the horizon; return the leaf P(win) for the acting team.
     * Paired seeds: rollout r reseeds the private stream identically for every candidate.
     */
    private rollout(unit: Unit, cand: ISearchCandidate, seedBase: number, r: number, horizonMode: HorizonMode): number {
        setDeterministicRandomSource(makeRng((seedBase + r * 0x9e3779b1) >>> 0));
        this.finishedSim = false;
        this.deps.setActiveUnitId(unit.getId());
        const actingTeam = unit.getTeam();
        this.rolloutEnemyTeam = otherTeam(actingTeam);
        const startLap = this.deps.fightProperties.getCurrentLap();
        const isIncumbent = cand.kind === "incumbent";

        // ply 0 — the candidate itself.
        let didSomething = false;
        for (const a of cand.actions) {
            if (this.finishedSim) {
                break;
            }
            const result = this.deps.engine.apply(a);
            if (!result.completed && a.type !== "select_attack_type") {
                if (!isIncumbent) {
                    return -Infinity; // enumerated candidates are legal by construction; a rejection is a bug
                }
                continue; // the real loop applies the incumbent's remaining actions past a rejection — mirror it
            }
            if (result.completed && a.type !== "select_attack_type") {
                didSomething = true;
            }
            this.processEvents(result.events);
        }
        if (isIncumbent && !didSomething) {
            return -Infinity; // nothing landed: battle_engine's recovery would replace this turn anyway
        }
        if (!this.finishedSim && this.deps.getActiveUnitId() === unit.getId()) {
            if (!didSomething) {
                this.processEvents(this.deps.engine.apply({ type: "defend_turn", unitId: unit.getId() }).events);
            }
            if (this.deps.getActiveUnitId() === unit.getId()) {
                const end = this.deps.engine.apply({ type: "end_turn", unitId: unit.getId(), reason: "manual" });
                this.processEvents(end.events);
                if (!end.completed) {
                    this.deps.setActiveUnitId("");
                }
            }
        }

        // roll forward — both sides play their real policies.
        const enemyTeam = otherTeam(actingTeam);
        const cap =
            horizonMode === "lap"
                ? MAX_LAP_HORIZON_TURNS
                : horizonMode === "reply"
                  ? MAX_REPLY_HORIZON_TURNS
                  : this.horizon;
        let turns = 0;
        while (!this.finishedSim && turns < cap) {
            if (horizonMode === "lap" && this.deps.fightProperties.getCurrentLap() > startLap) {
                break; // the lap flipped — the hourglass queue has fully resolved
            }
            if (!this.deps.getActiveUnitId()) {
                this.simAdvance();
                if (this.finishedSim || !this.deps.getActiveUnitId()) {
                    break;
                }
            }
            const activeId = this.deps.getActiveUnitId();
            const au = this.deps.unitsHolder.getAllUnits().get(activeId);
            if (!au || au.isDead()) {
                this.deps.setActiveUnitId("");
                continue;
            }
            this.simPlayTurn(au);
            turns += 1;
            this.counters.rolloutTurnsTotal += 1;
            if (horizonMode === "reply" && au.getTeam() === enemyTeam) {
                break; // the opponent has replied once — the shelved lookahead's horizon
            }
        }
        return this.leafValue(actingTeam);
    }
    /** Leaf eval as P(win) for `team`: learned logistic value when configured, else normalized material. */
    private leafValue(team: TeamType): number {
        if (this.learned) {
            const f = extractValueFeatures(this.deps.unitsHolder, this.deps.fightProperties, team);
            let z = this.learned.b;
            for (let i = 0; i < f.length; i += 1) {
                z += this.learned.w[i] * f[i];
            }
            return 1 / (1 + Math.exp(-z));
        }
        let ours = 0;
        let enemy = 0;
        for (const u of this.deps.unitsHolder.getAllUnits().values()) {
            if (u.isDead()) {
                continue;
            }
            if (u.getTeam() === team) {
                ours += u.getCumulativeHp();
            } else {
                enemy += u.getCumulativeHp();
            }
        }
        return 0.5 * (1 + (ours - enemy) / (ours + enemy + 1));
    }
    // ---- simulated turn plumbing (mirrors lookahead.ts / battle_engine's loop, minus recording) ----
    private simPlayTurn(unit: Unit): void {
        // SEARCH_OPP_MODEL: the searched side keeps its true self-model; only the enemy is re-modelled.
        const strat =
            this.oppModel && unit.getTeam() === this.rolloutEnemyTeam
                ? this.oppModel
                : this.deps.strategyForTeam(unit.getTeam());
        const id = unit.getId();
        let decided: GameAction[];
        try {
            decided = strat.decideTurn(unit, {
                grid: this.deps.grid,
                matrix: this.deps.grid.getMatrix(),
                unitsHolder: this.deps.unitsHolder,
                pathHelper: this.deps.pathHelper,
                attackHandler: this.deps.attackHandler,
                fightProperties: this.deps.fightProperties,
            });
        } catch {
            decided = [];
        }
        let didSomething = false;
        for (const a of decided) {
            if (this.finishedSim) {
                break;
            }
            const r = this.deps.engine.apply(a);
            if (r.completed && a.type !== "select_attack_type") {
                didSomething = true;
            }
            this.processEvents(r.events);
        }
        if (!this.finishedSim && this.deps.getActiveUnitId() === id && !didSomething) {
            this.recoverNoopTurn(unit);
        }
        if (!this.finishedSim && this.deps.getActiveUnitId() === id) {
            const end = this.deps.engine.apply({ type: "end_turn", unitId: id, reason: "manual" });
            this.processEvents(end.events);
            if (!end.completed) {
                this.deps.setActiveUnitId("");
            }
        }
    }
    private simAdvance(): void {
        this.advanceQueue();
        if (
            !this.finishedSim &&
            !this.deps.getActiveUnitId() &&
            forceStalledLap(this.deps.fightProperties, this.deps.unitsHolder)
        ) {
            this.advanceQueue();
        }
    }
    private advanceQueue(): void {
        const holder = this.deps.unitsHolder;
        const maxAttempts = holder.getAllUnits().size + 2;
        for (let i = 0; i < maxAttempts && !this.finishedSim && !this.deps.getActiveUnitId(); i += 1) {
            const result = this.deps.turnEngine.advanceAfterNoActiveUnit({
                damageDealtThisLap: this.deps.damageDealtThisLap(),
            });
            this.processEvents(result.events);
            if (result.fightFinished) {
                this.finishedSim = true;
                return;
            }
            if (this.deps.getActiveUnitId()) {
                return;
            }
            if (!result.events.length && this.deps.fightProperties.getUpNextQueueSize() === 0) {
                break;
            }
        }
    }
    private recoverNoopTurn(unit: Unit): void {
        const id = unit.getId();
        const advance = advanceTowardEnemyAction(unit, this.deps.grid, this.deps.unitsHolder, this.deps.pathHelper);
        let advanced = false;
        if (advance && !this.finishedSim && this.deps.getActiveUnitId() === id) {
            const result = this.deps.engine.apply(advance);
            advanced = result.completed;
            this.processEvents(result.events);
        }
        if (!advanced && !this.finishedSim && this.deps.getActiveUnitId() === id) {
            this.processEvents(this.deps.engine.apply({ type: "defend_turn", unitId: id }).events);
        }
    }
    private processEvents(events: GameEvent[]): void {
        for (const event of events) {
            if (event.type === "turn_completed") {
                if (this.deps.getActiveUnitId() === event.unitId) {
                    this.deps.setActiveUnitId("");
                }
            } else if (event.type === "next_unit_selected") {
                this.deps.setActiveUnitId(event.unitId);
            } else if (event.type === "fight_finished") {
                this.deps.setActiveUnitId("");
                this.finishedSim = true;
            } else if (event.type === "unit_destroyed") {
                if (this.deps.getActiveUnitId() === event.unitId) {
                    this.deps.setActiveUnitId("");
                }
            }
        }
    }
    /** Stable per-decision seed from match + semantic battle state, never from crypto-generated identities. */
    private simSeed(unit: Unit): number {
        const unitState = (candidate: Unit): string => {
            const cell = candidate.getBaseCell();
            return [
                candidate.getTeam(),
                candidate.getName(),
                cell.x,
                cell.y,
                candidate.getHp(),
                candidate.getAmountAlive(),
                candidate.getAmountDied(),
                candidate.getRangeShots(),
                candidate.getAttackTypeSelection(),
                candidate.getResponded() ? 1 : 0,
                candidate.isOnHourglass() ? 1 : 0,
                candidate.hasMovedThisTurn() ? 1 : 0,
            ].join(":");
        };
        const allUnits = [...this.deps.unitsHolder.getAllUnits().values()].map(unitState).sort();
        const fight = this.deps.fightProperties;
        return hashSimulationParts(
            "search-decision",
            this.match.seed ?? 0,
            fight.getCurrentLap(),
            fight.getGridType(),
            fight.getPreviousTurnTeam(),
            fight.getAlreadyMadeTurnSize(),
            fight.getHourglassQueueSize(),
            fight.getMoralePlusQueueSize(),
            fight.getMoraleMinusQueueSize(),
            fight.getUpNextQueueSize(),
            unitState(unit),
            ...allUnits,
        );
    }
}

const otherTeam = (team: TeamType): TeamType =>
    team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
