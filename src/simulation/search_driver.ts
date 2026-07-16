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
import {
    canWaitOnHourglassMirror,
    extractWaitFeatures,
    extractWaitFeaturesV2Raw,
    waitIncumbentKindOf,
} from "../ai/versions/wait_scorer";
import type { GameAction } from "../engine/actions";
import type { GameEvent } from "../engine/events";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../utils/lib";
import { hashSimulationParts, makeRng } from "./army";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import {
    IL_DATASET_VERSION,
    IL_FEATURE_FINGERPRINTS,
    IL_GAME_ROW_TYPE,
    IL_ROW_TYPE,
    ilActionSignature,
    ilCandidateFeatureVector,
    requireIlRunFingerprint,
    type IIlSearchConfig,
} from "./il_dataset";
import { ilCandidateActionEncoding } from "./il_action_features";
import type { ILookaheadDeps } from "./lookahead";
import {
    canonicalPhaseBSeed,
    PHASE_B_DATASET_VERSION,
    PHASE_B_Q2_ROW_TYPE,
    type PhaseBLeafKind,
    requirePhaseBRunFingerprint,
} from "./phase_b_dataset";
import { advanceTowardEnemyAction, forceStalledLap } from "./turn_recovery";
import {
    captureFinishPressureState,
    finishPressureForSide,
    finishPressureProximity,
    type FinishPressureState,
} from "./v0_7_finish_pressure";
import {
    capturePureRangedTerminalState,
    pureRangedTerminalAdvantage,
    type PureRangedTerminalState,
} from "./v0_7_pure_ranged_terminal";
import { DEFAULT_V07_VALUE_WEIGHTS } from "./v0_7_value_weights";
import {
    extractValueFeatures,
    extractValueFeaturesV2,
    VALUE_FEATURE_NAMES,
    VALUE_FEATURE_NAMES_V2,
} from "./value_features";

/**
 * B2 / RAWS — the WIDE-CANDIDATE ROLLOUT SEARCH driver (v0.7 roadmap).
 *
 * Generalizes lookahead.ts (2-ply, <=5 melee-only candidates, single-sample scoring) into a SearchDriver
 * over the F4 enumerated candidate generator (ai/candidates.ts): alternative melee (target x stand-cell)
 * pairs, alternative shot aims, area throws, every castable spell, defend and wait — for EVERY unit type.
 * Candidate 0 is always the incumbent policy decision (the anchor). Plain MOVE (kite/retreat-cell)
 * candidates are EXCLUDED by default — that candidate class is ledger-dead twice (crude hold and
 * safe-frontier kiting both regressed); SEARCH_INCLUDE_MOVES=1 re-includes them for experiments only.
 * SEARCH_ACTIVE_CHALLENGERS=1 is a research-only attrition probe: the incumbent anchor is always retained,
 * but generated wait/defend challengers are excluded so search cannot introduce a new passive action.
 * SEARCH_SHORTLIST=<K> is an opt-in research cost control: score every candidate once at the immediate
 * post-action leaf, then run the configured horizon only for the incumbent plus the best K-1 legal
 * challengers. K includes the incumbent and must be >=2. Unset keeps the original full-candidate search.
 * SEARCH_DECISION_DEADLINE_MS=<positive ms> is an opt-in fail-closed work deadline. It is checked between
 * candidates, rollout actions, and simulated turns; an incomplete comparison restores the battle and returns
 * the exact incumbent. When combined with the circuit breaker it must be strictly lower, leaving restore and
 * call-site headroom.
 * SEARCH_LATE_RANGED_FINISH_WEIGHT=<0..16> is a default-zero research overlay on the leaf logit. It rewards
 * late damage to the enemy's original army in proportion to the post-setup board's HP-weighted rangedness,
 * ramping from zero through lap 3 to full strength at the first Armageddon lap. Summons are excluded.
 * SEARCH_PURE_RANGED_TERMINAL_WEIGHT=<0..16> is a default-zero leaf-logit overlay restricted to battles in
 * which every original stack on both teams is RANGE. It compares the two armies' capped pre-Armageddon ammo
 * and post-ammo melee budgets, plus the HP barrier of No Melee stacks. Summons are excluded.
 * SEARCH_CIRCUIT_BREAKER_MS=<positive ms> provides a lower-bound research emulation of the ranked server's
 * outer per-match circuit: the first over-budget result still applies, then this match's driver returns each
 * later incumbent unchanged. The live wrapper also includes call-site overhead outside this internal timer.
 *
 * SCORING: each candidate is played through the REAL engine on the live battle state (battle_snapshot
 * save/restore around every rollout), then the game rolls forward — both sides playing their real
 * policies — to a fixed horizon of SEARCH_HORIZON unit-turns (default 12, roughly one lap). The leaf is
 * the LEARNED VALUE function (fit_value.mjs logistic weights over value_features.ts; the committed
 * LiveTwin fit is the default, V07_VALUE_WEIGHTS={b,w:[...]} overrides it, and `material` selects the
 * normalized-material fallback) expressed as P(win) for the acting team. Each candidate is scored by
 * SEARCH_ROLLOUTS (default 3)
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
 * IMITATION-LEARNING DATASET (SEARCH_IL_DATASET=<jsonl path>, search mode only, default OFF): one line
 * per SEARCHED decision with the state feature vectors already computed elsewhere in the pipeline (the
 * 41-dim wait-scorer vector + the 60-dim deployed V2 value basis), the full scored candidate set (kind,
 * action class, semantic signature, F4 enumeration-time features, canonical action metadata/features,
 * mean rollout leaf value),
 * the index the search finally chose (0 = incumbent kept) and the chosen action list verbatim. Row
 * schema and the validation/extraction consumer (optimizer/extract_il.mjs) live in ./il_dataset.ts;
 * v3 deliberately does not invoke or update the legacy fitter. Rows are buffered per game and appended
 * once in onMatchEnd, like the audit. Decisions abandoned by SEARCH_DECISION_DEADLINE_MS produce no row.
 *
 * Q2 GATE-2 DATASET (Q2_DATASET=<jsonl path>, oracle mode only): one line per wait-eligible decision
 * point with the FULL wait-scorer feature vector (ai/versions/wait_scorer.ts WAIT_FEATURE_NAMES — the 20
 * LiveTwin value features + tempo/hourglass context + unit-class flags + fmExposure + narrowing phase +
 * the incumbent rule's verdict + fixed crosses), the oracle's decision (y: 1 = wait) and the rollout
 * value delta (d, null on degenerate/rejected points). Rows: {t:"q2d", s: seed, g/r: versions, lap, u,
 * k: incumbent kind, iw: incumbent-already-waits, rej: engine-rejected-wait, y, d, f: [...]}. Buffered
 * per game and appended once in onMatchEnd, like the audit. Features are extracted with the SAME pure
 * extractor the deployed scorer uses, so fit weights wire into V07_WAIT_WEIGHTS unchanged.
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
type HorizonMode = "leaf" | "turns" | "reply" | "lap";

/** The slice of a candidate the rollout scorer actually consumes (lets the oracle skip enumeration). */
type ISearchCandidate = Pick<IEnumeratedCandidate, "kind" | "actions">;

class SearchDecisionDeadlineExceeded extends Error {
    public constructor() {
        super("Search decision deadline exceeded");
    }
}

/** Learned leaf weights (fit_value.mjs output) aligned to VALUE_FEATURE_NAMES. */
interface ILearnedValue {
    b: number;
    w: number[];
}

function parseLearnedValueWidth(raw: string | undefined, width: number): ILearnedValue | null {
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
            m.w.length === width &&
            m.w.every((x: unknown) => typeof x === "number" && Number.isFinite(x))
        ) {
            return { b: m.b, w: m.w as number[] };
        }
    } catch {
        /* malformed -> material fallback */
    }
    return null;
}

function parseLearnedValue(raw: string | undefined): ILearnedValue | null {
    return parseLearnedValueWidth(raw, VALUE_FEATURE_NAMES.length);
}

const envNum = (name: string, fallback: number, min: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= min ? v : fallback;
};

/** Classify an arbitrary decided action list into the candidate-kind vocabulary (for audit buckets). */
export function classifyActions(actions: readonly GameAction[]): string {
    for (const action of actions) {
        switch (action.type) {
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
    if (actions.some((action) => action.type === "move_unit")) {
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
    /** Candidates that reached the configured full rollout horizon after optional shortlisting. */
    scoredCandidatesTotal: number;
    /** Searches abandoned before every shortlisted candidate received a comparable full score. */
    deadlineFallbacks: number;
    /** Leaf evaluations that reached the eligible late ranged finish calculation. */
    finishPressureLeaves: number;
    /** Enabled leaf evaluations whose bounded finish-pressure feature was positive. */
    finishPressureNonzeroLeaves: number;
    /** Sum of the finish-pressure logit adjustment over enabled leaf evaluations. */
    finishPressureLogitSum: number;
    /** Eligible pure-ranged leaves evaluated by the terminal-budget overlay. */
    pureRangedTerminalLeaves: number;
    /** Eligible leaves whose perspective-relative terminal advantage was non-zero. */
    pureRangedTerminalNonzeroLeaves: number;
    /** Signed sum of the pure-ranged terminal logit adjustment. */
    pureRangedTerminalLogitSum: number;
    rolloutTurnsTotal: number;
    msTotal: number;
    circuitSkipped: number;
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
    scoredCandidatesTotal: 0,
    deadlineFallbacks: 0,
    finishPressureLeaves: 0,
    finishPressureNonzeroLeaves: 0,
    finishPressureLogitSum: 0,
    pureRangedTerminalLeaves: 0,
    pureRangedTerminalNonzeroLeaves: 0,
    pureRangedTerminalLogitSum: 0,
    rolloutTurnsTotal: 0,
    msTotal: 0,
    circuitSkipped: 0,
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
    private readonly activeChallengers: boolean;
    private readonly shortlist: number | null;
    private readonly decisionDeadlineMs: number | null;
    private readonly lateRangedFinishWeight: number;
    private readonly pureRangedTerminalWeight: number;
    private readonly circuitBreakerMs: number | null;
    private readonly learned: ILearnedValue | null;
    /** V07_VALUE_WEIGHTS_V2 (Phase-B env candidate): leaf over the deployed VALUE_FEATURE_NAMES_V2 basis
     * (raw 30 + rangedness-interaction block); a valid vector wins over the v1/default 20-dim leaf. */
    private readonly learnedV2: ILearnedValue | null;
    /** SEARCH_OPP_MODEL — rollouts simulate the searched unit's ENEMY with this strategy (null = true policy). */
    private readonly oppModel: IAIStrategy | null;
    /** The enemy team of the rollout in flight (only meaningful while a rollout runs; null otherwise). */
    private rolloutEnemyTeam: TeamType | null = null;
    private readonly auditPath: string | undefined;
    private readonly auditTurns: boolean;
    /** Q2_DATASET (oracle mode only): per-decision wait-scorer feature/label rows for Gate-2's fit. */
    private readonly datasetPath: string | undefined;
    /** Q2_DATASET_V2=1 — dump WAIT_FEATURE_NAMES_V2_RAW rows (49 dims, marker v:2) for the Phase-B refit. */
    private readonly datasetV2: boolean;
    private readonly datasetFingerprint: string | null;
    private readonly datasetSeed: number | null;
    private readonly datasetRows: string[] = [];
    /** SEARCH_IL_DATASET (search mode only): per-decision imitation-learning rows (see ./il_dataset.ts). */
    private readonly ilPath: string | undefined;
    private readonly ilRunFingerprint: string | null;
    private readonly ilCohort: string | null;
    private readonly ilRows: string[] = [];
    private readonly caps: {
        maxMoveDestinations: number;
        maxMeleePairs: number;
        maxShotAims: number;
        maxAreaThrowCells: number;
    };
    private readonly counters = emptyCounters();
    private readonly turnRows: string[] = [];
    private finishPressureState: FinishPressureState | null = null;
    private pureRangedTerminalState: PureRangedTerminalState | null = null;
    private finishedSim = false;
    private circuitOpen = false;
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
        this.activeChallengers = this.mode === "search" && process.env.SEARCH_ACTIVE_CHALLENGERS === "1";
        const rawShortlist = process.env.SEARCH_SHORTLIST;
        if (this.mode !== "search" || rawShortlist === undefined || rawShortlist === "") {
            this.shortlist = null;
        } else {
            const shortlist = Number(rawShortlist);
            if (!Number.isSafeInteger(shortlist) || shortlist < 2) {
                throw new Error("SEARCH_SHORTLIST must be an integer >= 2");
            }
            this.shortlist = shortlist;
        }
        const rawDecisionDeadline = process.env.SEARCH_DECISION_DEADLINE_MS;
        if (this.mode !== "search" || rawDecisionDeadline === undefined || rawDecisionDeadline === "") {
            this.decisionDeadlineMs = null;
        } else {
            const decisionDeadlineMs = Number(rawDecisionDeadline);
            if (!Number.isFinite(decisionDeadlineMs) || decisionDeadlineMs <= 0) {
                throw new Error("SEARCH_DECISION_DEADLINE_MS must be positive");
            }
            this.decisionDeadlineMs = decisionDeadlineMs;
        }
        const circuitBreakerMs = Number(process.env.SEARCH_CIRCUIT_BREAKER_MS);
        this.circuitBreakerMs =
            this.mode === "search" && Number.isFinite(circuitBreakerMs) && circuitBreakerMs > 0
                ? circuitBreakerMs
                : null;
        if (
            this.decisionDeadlineMs !== null &&
            this.circuitBreakerMs !== null &&
            this.decisionDeadlineMs >= this.circuitBreakerMs
        ) {
            throw new Error("SEARCH_DECISION_DEADLINE_MS must be below SEARCH_CIRCUIT_BREAKER_MS");
        }
        const rawFinishWeight = process.env.SEARCH_LATE_RANGED_FINISH_WEIGHT;
        if (this.mode !== "search" || rawFinishWeight === undefined || rawFinishWeight === "") {
            this.lateRangedFinishWeight = 0;
        } else {
            const finishWeight = Number(rawFinishWeight);
            if (!Number.isFinite(finishWeight) || finishWeight < 0 || finishWeight > 16) {
                throw new Error("SEARCH_LATE_RANGED_FINISH_WEIGHT must be between 0 and 16");
            }
            this.lateRangedFinishWeight = finishWeight;
        }
        const rawPureRangedTerminalWeight = process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT;
        if (this.mode !== "search" || rawPureRangedTerminalWeight === undefined || rawPureRangedTerminalWeight === "") {
            this.pureRangedTerminalWeight = 0;
        } else {
            const terminalWeight = Number(rawPureRangedTerminalWeight);
            if (!Number.isFinite(terminalWeight) || terminalWeight < 0 || terminalWeight > 16) {
                throw new Error("SEARCH_PURE_RANGED_TERMINAL_WEIGHT must be between 0 and 16");
            }
            this.pureRangedTerminalWeight = terminalWeight;
        }
        const rawValueWeights = process.env.V07_VALUE_WEIGHTS;
        this.learned =
            rawValueWeights === "material"
                ? null
                : rawValueWeights
                  ? parseLearnedValue(rawValueWeights)
                  : { b: DEFAULT_V07_VALUE_WEIGHTS.b, w: [...DEFAULT_V07_VALUE_WEIGHTS.w] };
        // V2 leaf candidate: absent, malformed, or all-zero falls back to the prior leaf. Two explicit leaf
        // selectors are ambiguous experiment provenance, so reject the combination instead of guessing.
        const parsedV2 = parseLearnedValueWidth(process.env.V07_VALUE_WEIGHTS_V2, VALUE_FEATURE_NAMES_V2.length);
        this.learnedV2 = parsedV2 && (parsedV2.b !== 0 || parsedV2.w.some((weight) => weight !== 0)) ? parsedV2 : null;
        if (this.learnedV2 && rawValueWeights !== undefined) {
            throw new Error("V07_VALUE_WEIGHTS_V2 cannot be combined with explicit V07_VALUE_WEIGHTS");
        }
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
        this.datasetPath = this.mode === "oracle" ? process.env.Q2_DATASET || undefined : undefined;
        this.datasetV2 = process.env.Q2_DATASET_V2 === "1";
        this.ilPath = this.mode === "search" ? process.env.SEARCH_IL_DATASET || undefined : undefined;
        if (this.ilPath) {
            this.ilRunFingerprint = requireIlRunFingerprint(process.env.SEARCH_IL_RUN_FINGERPRINT);
            this.ilCohort = process.env.SEARCH_IL_COHORT?.trim() || null;
            if (!this.ilCohort) {
                throw new Error("SEARCH_IL_COHORT is required with SEARCH_IL_DATASET");
            }
            if (
                !Number.isSafeInteger(this.match.seed) ||
                this.match.seed! < -0x80000000 ||
                this.match.seed! > 0xffffffff
            ) {
                throw new Error("SEARCH_IL_DATASET requires a signed int32 or uint32 match seed");
            }
            if (!this.match.greenVersion?.trim() || !this.match.redVersion?.trim()) {
                throw new Error("SEARCH_IL_DATASET requires green and red strategy versions");
            }
        } else {
            this.ilRunFingerprint = null;
            this.ilCohort = null;
        }
        if (this.datasetPath && this.datasetV2) {
            this.datasetFingerprint = requirePhaseBRunFingerprint(process.env.PHASE_B_RUN_FINGERPRINT);
            this.datasetSeed = canonicalPhaseBSeed(this.match.seed, "Q2 dataset seed");
            if (!this.match.greenVersion || !this.match.redVersion) {
                throw new Error("Phase-B Q2 dataset rows require green and red strategy versions");
            }
        } else {
            this.datasetFingerprint = null;
            this.datasetSeed = null;
        }
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
    /** Capture the immutable post-setup armies before either side takes a combat turn. */
    public onFightReady(): void {
        if (this.lateRangedFinishWeight > 0 && this.finishPressureState === null) {
            this.finishPressureState = captureFinishPressureState(this.deps.unitsHolder);
        }
        if (this.pureRangedTerminalWeight > 0 && this.pureRangedTerminalState === null) {
            this.pureRangedTerminalState = capturePureRangedTerminalState(
                this.deps.unitsHolder,
                this.deps.fightProperties.getCurrentLap(),
            );
        }
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
        if (this.lateRangedFinishWeight > 0 || this.pureRangedTerminalWeight > 0) {
            this.onFightReady();
        }
        if (this.circuitOpen) {
            this.counters.circuitSkipped += 1;
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
            const set = enumerateCandidates(unit, context, incumbent, {
                ...this.caps,
                enrichIncumbentMetadata: this.ilPath !== undefined,
            });
            const candidates = set.candidates.filter((candidate) => {
                if (candidate.kind === "incumbent") return true;
                if (!this.includeMoves && candidate.kind === "move") return false;
                return !this.activeChallengers || (candidate.kind !== "wait" && candidate.kind !== "defend");
            });
            if (this.mode === "ablation") {
                return this.ablate(unit, candidates, incumbent, seedBase, t0);
            }
            if (candidates.length <= 1) {
                this.counters.singleCandidate += 1;
                return incumbent;
            }
            return this.search(unit, candidates, incumbent, seedBase, t0);
        } finally {
            if (this.circuitBreakerMs !== null && performance.now() - t0 > this.circuitBreakerMs) {
                this.circuitOpen = true;
            }
            setDeterministicRandomSource(savedSource);
            this.deps.setActiveUnitId(savedActive);
            this.finishedSim = false;
            this.rolloutEnemyTeam = null;
        }
    }
    /** Flush the per-game audit summary (one JSONL line + any buffered per-turn rows) and the datasets. */
    public onMatchEnd(winner?: string, endReason?: string): void {
        if (this.ilPath) {
            if (winner !== "green" && winner !== "red" && winner !== "draw") {
                throw new Error("SEARCH_IL_DATASET requires a valid match winner");
            }
            if (endReason !== "elimination" && endReason !== "turn_cap" && endReason !== "stuck") {
                throw new Error("SEARCH_IL_DATASET requires a valid match end reason");
            }
            const c = this.counters;
            const footer = JSON.stringify({
                t: IL_GAME_ROW_TYPE,
                v: IL_DATASET_VERSION,
                runFingerprint: this.ilRunFingerprint!,
                featureFingerprints: IL_FEATURE_FINGERPRINTS,
                cohort: this.ilCohort!,
                seed: this.match.seed!,
                green: this.match.greenVersion!,
                red: this.match.redVersion!,
                winner,
                endReason,
                rows: this.ilRows.length,
                decisions: c.decisions,
                searched: c.searched,
                singleCandidate: c.singleCandidate,
                deadlineFallbacks: c.deadlineFallbacks,
                circuitOpened: this.circuitOpen ? 1 : 0,
                circuitSkipped: c.circuitSkipped,
                cfg: this.ilConfig(),
            });
            appendFileSync(this.ilPath, `${[...this.ilRows, footer].join("\n")}\n`);
            this.ilRows.length = 0;
        }
        if (this.datasetPath && this.datasetRows.length) {
            try {
                appendFileSync(this.datasetPath, `${this.datasetRows.join("\n")}\n`);
            } catch {
                /* best-effort dump */
            }
            this.datasetRows.length = 0;
        }
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
            leaf: this.learnedV2 ? "learned_v2" : this.learned ? "learned" : "material",
            ...(this.oppModel ? { oppModel: this.oppModel.version } : {}),
            decisions: c.decisions,
            searched: c.searched,
            overrides: c.overrides,
            illegalIncumbent: c.illegalIncumbent,
            singleCandidate: c.singleCandidate,
            candidatesTotal: c.candidatesTotal,
            scoredCandidatesTotal: c.scoredCandidatesTotal,
            shortlist: this.shortlist,
            decisionDeadlineMs: this.decisionDeadlineMs,
            deadlineFallbacks: c.deadlineFallbacks,
            lateRangedFinishWeight: this.lateRangedFinishWeight,
            initialBoardRangedness: this.finishPressureState?.initialBoardRangedness ?? 0,
            finishPressureLeaves: c.finishPressureLeaves,
            finishPressureNonzeroLeaves: c.finishPressureNonzeroLeaves,
            finishPressureLogitSum: Number(c.finishPressureLogitSum.toFixed(6)),
            pureRangedTerminalWeight: this.pureRangedTerminalWeight,
            pureRangedTerminalEligible: this.pureRangedTerminalState?.eligible ?? false,
            pureRangedTerminalInitialScale: this.pureRangedTerminalState?.initialScale ?? 0,
            pureRangedTerminalLeaves: c.pureRangedTerminalLeaves,
            pureRangedTerminalNonzeroLeaves: c.pureRangedTerminalNonzeroLeaves,
            pureRangedTerminalLogitSum: Number(c.pureRangedTerminalLogitSum.toFixed(6)),
            rolloutTurnsTotal: c.rolloutTurnsTotal,
            msTotal: Math.round(c.msTotal * 10) / 10,
            circuitBreakerMs: this.circuitBreakerMs,
            circuitOpened: this.circuitOpen,
            circuitSkipped: c.circuitSkipped,
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

        // IL dataset state features are extracted on the LIVE pre-rollout state (scoreCandidates
        // snapshot/restores around every rollout, so ordering is belt-and-braces — the same contract as
        // the oracle's Q2 dump).
        const ilState = this.ilPath
            ? {
                  wf: extractWaitFeatures(unit, this.deps.unitsHolder, this.deps.fightProperties, incumbent),
                  vf: extractValueFeaturesV2(this.deps.unitsHolder, this.deps.fightProperties, unit.getTeam()),
              }
            : undefined;

        const deadlineAt = this.decisionDeadlineMs === null ? null : t0 + this.decisionDeadlineMs;
        let scoredCandidates: readonly IEnumeratedCandidate[];
        let means: number[];
        try {
            scoredCandidates = this.shortlistCandidates(unit, candidates, seedBase, deadlineAt);
            means = this.scoreCandidates(unit, scoredCandidates, seedBase, "turns", this.rollouts, deadlineAt);
            this.counters.scoredCandidatesTotal += scoredCandidates.length;
        } catch (error) {
            if (!(error instanceof SearchDecisionDeadlineExceeded)) throw error;
            this.counters.deadlineFallbacks += 1;
            const ms = performance.now() - t0;
            this.counters.msTotal += ms;
            if (this.auditPath && this.auditTurns) {
                this.turnRows.push(
                    JSON.stringify({
                        t: "turn",
                        seed: this.match.seed,
                        green: this.match.greenVersion,
                        red: this.match.redVersion,
                        lap: this.deps.fightProperties.getCurrentLap(),
                        unit: unit.getName(),
                        nc: candidates.length,
                        ns: 0,
                        inc: incumbentKind,
                        chosen: incumbentKind,
                        ov: 0,
                        d: null,
                        ms: Math.round(ms * 10) / 10,
                        deadlineFallback: 1,
                    }),
                );
            }
            return incumbent;
        }
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
            bump(this.counters.overridesToKind, scoredCandidates[bestIdx].kind);
        }
        if (ilState) {
            const chosenIdx = overridden ? bestIdx : 0;
            this.ilRows.push(
                JSON.stringify({
                    t: IL_ROW_TYPE,
                    v: IL_DATASET_VERSION,
                    runFingerprint: this.ilRunFingerprint!,
                    cohort: this.ilCohort!,
                    decision: this.ilRows.length,
                    seed: this.match.seed!,
                    green: this.match.greenVersion!,
                    red: this.match.redVersion!,
                    side: unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red",
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    k: incumbentKind,
                    ov: overridden ? 1 : 0,
                    chosen: chosenIdx,
                    nc: candidates.length,
                    act: scoredCandidates[chosenIdx].actions,
                    wf: ilState.wf.map((x) => Number(x.toFixed(5))),
                    vf: ilState.vf.map((x) => Number(x.toFixed(5))),
                    featureFingerprints: IL_FEATURE_FINGERPRINTS,
                    cands: scoredCandidates.map((cand, i) => {
                        const encoding = ilCandidateActionEncoding(cand, unit.getTeam());
                        return {
                            kind: cand.kind,
                            ck: classifyActions(cand.actions),
                            sig: ilActionSignature(cand.actions),
                            act: cand.actions,
                            cf: ilCandidateFeatureVector(cand.features).map((x) => Number(x.toFixed(4))),
                            am: encoding.metadata,
                            af: encoding.features,
                            m: means[i] === -Infinity ? null : Number(means[i].toFixed(5)),
                        };
                    }),
                    cfg: this.ilConfig(),
                }),
            );
        }
        const ms = performance.now() - t0;
        this.counters.msTotal += ms;
        if (this.auditPath && this.auditTurns) {
            this.turnRows.push(
                JSON.stringify({
                    t: "turn",
                    seed: this.match.seed,
                    green: this.match.greenVersion,
                    red: this.match.redVersion,
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    nc: candidates.length,
                    ns: scoredCandidates.length,
                    inc: incumbentKind,
                    chosen: overridden ? scoredCandidates[bestIdx].kind : incumbentKind,
                    ov: overridden ? 1 : 0,
                    d:
                        means[bestIdx] === -Infinity || means[0] === -Infinity
                            ? null
                            : Number((means[bestIdx] - means[0]).toFixed(4)),
                    ms: Math.round(ms * 10) / 10,
                }),
            );
        }
        return overridden ? scoredCandidates[bestIdx].actions : incumbent;
    }
    /** Immediate-leaf pre-pass used only when SEARCH_SHORTLIST is explicitly configured. */
    private shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        deadlineAt: number | null,
    ): readonly IEnumeratedCandidate[] {
        if (this.shortlist === null || candidates.length <= this.shortlist) {
            return candidates;
        }
        const scores = this.scoreCandidates(unit, candidates, seedBase, "leaf", 1, deadlineAt);
        const challengers = scores
            .map((score, index) => ({ score, index }))
            .slice(1)
            .filter(({ score }) => score !== -Infinity)
            .sort((left, right) => right.score - left.score || left.index - right.index)
            .slice(0, this.shortlist - 1)
            .map(({ index }) => candidates[index]);
        return [candidates[0], ...challengers];
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
                    seed: this.match.seed,
                    green: this.match.greenVersion,
                    red: this.match.redVersion,
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
     * Shared with the Gate-2 wait-scorer (ai/versions/wait_scorer.ts) so the deployed scorer's
     * applicability domain is EXACTLY the domain the oracle's training labels came from.
     */
    private canHourglass(unit: Unit): boolean {
        return canWaitOnHourglassMirror(unit, this.deps.fightProperties);
    }
    /** The dataset featurization: v1 (41 dims) by default, WAIT_FEATURE_NAMES_V2_RAW (49) under Q2_DATASET_V2=1. */
    private datasetFeaturesOf(unit: Unit, incumbent: readonly GameAction[]): number[] {
        return this.datasetV2
            ? extractWaitFeaturesV2Raw(unit, this.deps.unitsHolder, this.deps.fightProperties, incumbent)
            : extractWaitFeatures(unit, this.deps.unitsHolder, this.deps.fightProperties, incumbent);
    }
    private leafKind(): PhaseBLeafKind {
        return this.learnedV2 ? "learned_v2" : this.learned ? "learned" : "material";
    }
    private ilConfig(): IIlSearchConfig {
        return {
            gate: this.gate,
            horizon: this.horizon,
            rollouts: this.rollouts,
            leaf: this.leafKind(),
            shortlist: this.shortlist,
            includeMoves: this.includeMoves ? 1 : 0,
            activeChallengers: this.activeChallengers ? 1 : 0,
            oppModel: this.oppModel?.version ?? null,
            decisionDeadlineMs: this.decisionDeadlineMs,
            circuitBreakerMs: this.circuitBreakerMs,
            caps: { ...this.caps },
        };
    }
    /** Buffer one Q2 Gate-2 dataset row (Q2_DATASET, oracle mode) for this decision point. */
    private pushDatasetRow(
        unit: Unit,
        incumbent: readonly GameAction[],
        features: number[],
        row: { iw: 0 | 1; ii: 0 | 1; rej: 0 | 1; y: 0 | 1; d: number | null },
    ): void {
        if (this.datasetV2) {
            this.datasetRows.push(
                JSON.stringify({
                    t: PHASE_B_Q2_ROW_TYPE,
                    v: PHASE_B_DATASET_VERSION,
                    runFingerprint: this.datasetFingerprint!,
                    seed: this.datasetSeed!,
                    greenVersion: this.match.greenVersion!,
                    redVersion: this.match.redVersion!,
                    lap: this.deps.fightProperties.getCurrentLap(),
                    unit: unit.getName(),
                    incumbentKind: waitIncumbentKindOf(incumbent),
                    incumbentWait: row.iw,
                    incumbentIllegal: row.ii,
                    waitRejected: row.rej,
                    label: row.y,
                    delta: row.d === null ? null : Number(row.d.toFixed(5)),
                    features: features.map((feature) => Number(feature.toFixed(5))),
                    oracle: {
                        gate: this.gate,
                        rollouts: this.rollouts,
                        horizon: "lap",
                        leaf: this.leafKind(),
                        opponentModel: this.oppModel?.version ?? null,
                    },
                }),
            );
            return;
        }
        this.datasetRows.push(
            JSON.stringify({
                t: "q2d",
                s: this.match.seed,
                g: this.match.greenVersion,
                r: this.match.redVersion,
                lap: this.deps.fightProperties.getCurrentLap(),
                u: unit.getName(),
                k: classifyActions(incumbent),
                iw: row.iw,
                rej: row.rej,
                y: row.y,
                d: row.d === null ? null : Number(row.d.toFixed(5)),
                f: features.map((x) => Number(x.toFixed(5))),
            }),
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
            if (this.datasetPath) {
                // Kept-wait row (iw=1): no oracle arbitration happened — excluded from the Gate-2 fit's
                // scored set, dumped so the class balance and the incumbent rule's domain stay auditable.
                this.pushDatasetRow(unit, incumbent, this.datasetFeaturesOf(unit, incumbent), {
                    iw: 1,
                    ii: 0,
                    rej: 0,
                    y: 1,
                    d: null,
                });
            }
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
        // Features are extracted on the LIVE pre-rollout state (scoreCandidates snapshot/restores around
        // every rollout, so ordering is belt-and-braces) with the SAME extractor the deployed scorer uses.
        const datasetFeatures = this.datasetPath ? this.datasetFeaturesOf(unit, incumbent) : undefined;
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
        if (datasetFeatures) {
            this.pushDatasetRow(unit, incumbent, datasetFeatures, {
                iw: 0,
                ii: incumbentIllegal ? 1 : 0,
                rej: waitRejected ? 1 : 0,
                y: overridden ? 1 : 0,
                d: incumbentIllegal || waitRejected ? null : means[1] - means[0],
            });
        }
        const ms = performance.now() - t0;
        c.msTotal += ms;
        if (this.auditPath && this.auditTurns) {
            this.turnRows.push(
                JSON.stringify({
                    t: "q2o",
                    seed: this.match.seed,
                    green: this.match.greenVersion,
                    red: this.match.redVersion,
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
        rolloutCount = this.rollouts,
        deadlineAt: number | null = null,
    ): number[] {
        this.assertBeforeDecisionDeadline(deadlineAt);
        const snapshot = snapshotBattle(this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties);
        const savedStats = this.deps.captureDamageStats();
        this.assertBeforeDecisionDeadline(deadlineAt);
        const means: number[] = [];
        for (const cand of candidates) {
            this.assertBeforeDecisionDeadline(deadlineAt);
            let sum = 0;
            let illegal = false;
            for (let r = 0; r < rolloutCount; r += 1) {
                this.assertBeforeDecisionDeadline(deadlineAt);
                let score: number;
                try {
                    score = this.rollout(unit, cand, seedBase, r, horizonMode, deadlineAt);
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
            means.push(illegal ? -Infinity : sum / rolloutCount);
        }
        return means;
    }
    private assertBeforeDecisionDeadline(deadlineAt: number | null): void {
        if (deadlineAt !== null && performance.now() >= deadlineAt) {
            throw new SearchDecisionDeadlineExceeded();
        }
    }
    /**
     * One rollout: apply the candidate through the real engine, close the turn, then let BOTH sides play
     * their real policies forward to the horizon; return the leaf P(win) for the acting team.
     * Paired seeds: rollout r reseeds the private stream identically for every candidate.
     */
    private rollout(
        unit: Unit,
        cand: ISearchCandidate,
        seedBase: number,
        r: number,
        horizonMode: HorizonMode,
        deadlineAt: number | null = null,
    ): number {
        this.assertBeforeDecisionDeadline(deadlineAt);
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
            this.assertBeforeDecisionDeadline(deadlineAt);
            if (this.finishedSim) {
                break;
            }
            const result = this.deps.engine.apply(a);
            this.assertBeforeDecisionDeadline(deadlineAt);
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
            this.assertBeforeDecisionDeadline(deadlineAt);
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
            horizonMode === "leaf"
                ? 0
                : horizonMode === "lap"
                  ? MAX_LAP_HORIZON_TURNS
                  : horizonMode === "reply"
                    ? MAX_REPLY_HORIZON_TURNS
                    : this.horizon;
        let turns = 0;
        while (!this.finishedSim && turns < cap) {
            this.assertBeforeDecisionDeadline(deadlineAt);
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
        this.assertBeforeDecisionDeadline(deadlineAt);
        const value = this.leafValue(actingTeam);
        this.assertBeforeDecisionDeadline(deadlineAt);
        return value;
    }
    /** Leaf eval as P(win) for `team`: learned logistic value when configured, else normalized material. */
    private leafValue(team: TeamType): number {
        const model = this.learnedV2 ?? this.learned;
        if (model) {
            const f = this.learnedV2
                ? extractValueFeaturesV2(this.deps.unitsHolder, this.deps.fightProperties, team)
                : extractValueFeatures(this.deps.unitsHolder, this.deps.fightProperties, team);
            let z = model.b;
            for (let i = 0; i < f.length; i += 1) {
                z += model.w[i] * f[i];
            }
            if (this.lateRangedFinishWeight > 0 || this.pureRangedTerminalWeight > 0) {
                z += this.researchLeafLogitAdjustment(team);
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
        const material = 0.5 * (1 + (ours - enemy) / (ours + enemy + 1));
        if (this.lateRangedFinishWeight === 0 && this.pureRangedTerminalWeight === 0) {
            return material;
        }
        const z = Math.log(material / (1 - material)) + this.researchLeafLogitAdjustment(team);
        return 1 / (1 + Math.exp(-z));
    }
    private researchLeafLogitAdjustment(team: TeamType): number {
        return this.finishPressureLogitAdjustment(team) + this.pureRangedTerminalLogitAdjustment(team);
    }
    private finishPressureLogitAdjustment(team: TeamType): number {
        if (this.lateRangedFinishWeight === 0) {
            return 0;
        }
        this.onFightReady();
        const state = this.finishPressureState;
        const currentLap = this.deps.fightProperties.getCurrentLap();
        if (!state || state.initialBoardRangedness === 0 || finishPressureProximity(currentLap) === 0) {
            return 0;
        }
        const feature = finishPressureForSide(state, this.deps.unitsHolder, team, currentLap);
        const adjustment = this.lateRangedFinishWeight * feature;
        this.counters.finishPressureLeaves += 1;
        if (feature > 0) {
            this.counters.finishPressureNonzeroLeaves += 1;
        }
        this.counters.finishPressureLogitSum += adjustment;
        return adjustment;
    }
    private pureRangedTerminalLogitAdjustment(team: TeamType): number {
        if (this.pureRangedTerminalWeight === 0) {
            return 0;
        }
        this.onFightReady();
        const state = this.pureRangedTerminalState;
        if (!state?.eligible) {
            return 0;
        }
        const feature = pureRangedTerminalAdvantage(
            state,
            this.deps.unitsHolder,
            team,
            this.deps.fightProperties.getCurrentLap(),
        );
        const adjustment = this.pureRangedTerminalWeight * feature;
        this.counters.pureRangedTerminalLeaves += 1;
        if (feature !== 0) {
            this.counters.pureRangedTerminalNonzeroLeaves += 1;
        }
        this.counters.pureRangedTerminalLogitSum += adjustment;
        return adjustment;
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
