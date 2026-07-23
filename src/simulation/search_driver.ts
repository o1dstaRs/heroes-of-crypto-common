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
    type CandidateKind,
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
import {
    isV08StrongerRangedPostureWait,
    selectV08DirectCombatCandidate,
    v08TeamRangedOutput,
} from "../ai/versions/v0_8";
import { isV08DirectCombatDecision, v08DominantFinishState } from "../ai/versions/v0_8_dominant_finish";
import {
    selectV08STargetPressureCandidate,
    V08S_URGENT_FINISH_START_LAP,
    V08_TARGET_PRESSURE_START_LAP,
} from "../ai/versions/v0_8s_finish";
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
import { rankPureRangedDeadlineFinisherCandidates } from "./pure_ranged_deadline_finisher";
import {
    isPureRangedJitNoMeleeFocusStationaryIncumbent,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
    pureRangedJitNoMeleeFocusActorEligible,
    pureRangedJitNoMeleeFocusLapEligible,
    rankPureRangedJitNoMeleeFocusCandidates,
} from "./pure_ranged_jit_no_melee_focus";
import {
    anyBoardParetoNoMeleeFocusActorAbility,
    DEFAULT_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE,
    isParetoNoMeleeFocusStationaryIncumbent,
    MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES,
    mixedSupportedParetoNoMeleeFocusContext,
    probeMixedSupportedParetoNoMeleeFocusFunnel,
    PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP,
    pureRangedParetoNoMeleeFocusLapEligible,
    pureRangedParetoNoMeleeFocusActorAbility,
    rankPureRangedParetoNoMeleeFocusCandidates,
    type MixedSupportedParetoNoMeleeFocusFunnelStage,
    type PureRangedParetoNoMeleeFocusScope,
} from "./pure_ranged_pareto_no_melee_focus";
import { rankPureRangedNoMeleePressureCandidates } from "./pure_ranged_no_melee_pressure";
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
 * Candidate 0 is always the incumbent policy decision (the anchor). For pre-v0.8 versions, plain MOVE
 * (kite/retreat-cell) candidates are EXCLUDED by default — that candidate class is ledger-dead twice (crude
 * hold and safe-frontier kiting both regressed). v0.8 always retains the nearest legal move for scored search
 * and hard-passive fallback; SEARCH_INCLUDE_MOVES=1 expands either policy to the configured move set.
 * SEARCH_ACTIVE_CHALLENGERS=1 is a research-only attrition probe: the incumbent anchor is always retained,
 * but generated wait/defend challengers are excluded so search cannot introduce a new passive action.
 * V08_AGGRESSIVE=1 is the a13 v0.8/v0.8s policy constraint. It preserves v0.8's hard exclusion of generated
 * Luck Shield/mountain challengers and its productive override for incumbent Luck Shield/mountain/no-op turns.
 * An incumbent strategic wait remains scored and is replaced only when an engine-valid attack, spell, or move
 * scores at least as well (a local zero gate). The explicit stronger-ranged posture wait keeps the normal rollout
 * gate so a numerical tie cannot make its melee screen abandon superior shooters. Late combat retains v0.8's
 * pre-Armageddon two-to-one-HP dominant-finish rule and forces an advance when no direct attack exists. The flag
 * is deliberately scoped to the two a13-compatible version names; historical versions are exact.
 * v0.8 goes further regardless of that probe: generated defend and mountain challengers are excluded. An
 * inherited defend/mountain remains candidate zero for fail-closed and observe-only semantics; normal active
 * search replaces it when an engine-valid productive challenger exists. Tactical wait remains a scored action.
 * The a13 policy (production v0.8 and its frozen-training v0.8s alias) adds target pressure at lap 6: an
 * inherited attack is retargeted to the
 * least-deadline-slack enemy. Ordinary/balanced stronger-ranged waits remain legal through lap 8; the inherited
 * >=2:1 dominant finish may press from lap 7. At lap 9 it universally forces a positive-damage attack and otherwise
 * the nearest advance. Coverage-preserving attack caps, shortlist, deadline, and circuit fallbacks all use the same
 * selector; historical decisions are unchanged.
 * SEARCH_OBSERVE_ONLY=1 is a research-only shadow mode: search still scores candidates but always returns
 * the exact incumbent action-array reference. SEARCH_INCUMBENT_KINDS limits which incumbent action classes
 * enter shadow search (the filter runs before enumeration), and SEARCH_CHALLENGER_KINDS limits the generated
 * challenger classes. SEARCH_VALIDATION_ROLLOUTS independently re-scores the incumbent and discovery-best
 * challenger under a domain-separated paired-seed bank and reports through SEARCH_AUDIT_TURNS; its leaf delta
 * is diagnostic, not terminal proof. Validation is rejected with SEARCH_IL_DATASET so v3 IL rows stay exact.
 * SEARCH_SHORTLIST=<K> is an opt-in research cost control: score every candidate once at the immediate
 * post-action leaf, then run the configured horizon only for the incumbent plus the best K-1 legal
 * challengers. K includes the incumbent and must be >=2. Unset keeps the original full-candidate search.
 * SEARCH_DECISION_DEADLINE_MS=<positive ms> is an opt-in fail-closed rollout-comparison deadline. It is checked
 * between candidates, rollout actions, and simulated turns; an incomplete comparison restores the battle.
 * Historical versions and ordinary v0.8 waits return the exact incumbent. A v0.8 hard passive or dominant-finish
 * turn first runs one bounded immediate-action validity probe and returns that prevalidated fallback when one
 * exists. The probe is outside the comparison deadline but inside the circuit timer. The deadline must be
 * strictly below the circuit breaker, leaving restore and call-site headroom.
 * SEARCH_LATE_RANGED_FINISH_WEIGHT=<0..16> is a default-zero research overlay on the leaf logit. It rewards
 * late damage to the enemy's original army in proportion to the post-setup board's HP-weighted rangedness,
 * ramping from zero through lap 3 to full strength at the first Armageddon lap. Summons are excluded.
 * SEARCH_PURE_RANGED_TERMINAL_WEIGHT=<0..16> is a default-zero leaf-logit overlay restricted to battles in
 * which every original stack on both teams is RANGE. It compares the two armies' capped pre-Armageddon ammo
 * and post-ammo melee budgets, plus the HP barrier of No Melee stacks. Summons are excluded.
 * SEARCH_PURE_RANGED_NO_MELEE_PRESSURE=1 is a default-off, version-scoped terminal-barrier intervention for
 * those same all-ranged original boards. From lap one, a No Melee shooter keeps a legal stationary ranged kill
 * first; otherwise it pressures a living enemy No Melee stack before both terminal barriers exhaust ammunition.
 * SEARCH_PURE_RANGED_DEADLINE_FINISHER=1 is a separate default-off, version-scoped deadline arm. On the same
 * all-ranged boards, an Endless Quiver shooter preserves its normal opening targets until the enemy No Melee
 * barrier needs every remaining pre-Armageddon activation, then takes an engine-valid stationary barrier shot.
 * SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS=1 is a separate default-off, version-scoped target-focus arm. Before
 * lap nine on the same all-ranged boards, an exact Through Shot or Large Caliber shooter may redirect a positive
 * stationary shot to a living original No Melee target only when the aimed-primary kill estimate, total enemy/net
 * damage, friendly fire, and shot spend clear the configured safeguards. The optional
 * SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR is restricted to 0.9..1 and defaults to exact Pareto at
 * one. Both measured seats receive the same catalog; the scoped candidate seat may select the engine-validated
 * redirect. SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE defaults to `pure_ranged`; `any_board` widens catalog
 * collection to mixed boards but requires exact Pareto, native/current actor and target cards, original stacks,
 * and production v0.8 selection. `mixed_supported` is the narrower fixed-cohort arm: it structurally excludes
 * pure boards, admits only native Cyclops/Large-Caliber or Tsar-Cannon/Through-Shot actors, requires every
 * reachable melee threat to be screened by an original native melee ally, and targets native Tsar Cannons only.
 * Each mixed-supported proposal emits a sparse v13 audit row even when SEARCH_AUDIT_TURNS is disabled.
 * SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS=1 is an independent default-off, version-scoped scheduler for ordinary
 * original shooters on those all-ranged boards. During laps 1..11 it locks an inherited stationary shot already
 * aimed at an armed original No Melee barrier, or redirects another stationary shot when the barrier has at most
 * one spare activation under the current-ammo optimistic upper bound (negative slack remains eligible). A
 * redirect preserves primary-target kill, at least 80% of enemy/net aggregate damage, and friendly-fire safety,
 * then passes the real engine probe. Both seats receive the same target-covered catalog; only the scoped
 * treatment seat may lock or redirect. This arm is mutually exclusive with every earlier pure-ranged
 * intervention, including the Pareto arm.
 * SEARCH_MAX_MOVE_SHOTS=<0..2> is a default-zero action-space probe. It adds at most one/two ordinary
 * move-then-range-shot challengers whose hypothetical origin crosses a damage band while preserving the exact
 * aimed target and interception. Sniper, piercing, AOE/throw, pinned destinations, and hazardous routes are
 * excluded; each surviving ordered action list is still applied through the real engine before it can win.
 * SEARCH_MOVE_SHOT_VERSIONS=<csv> scopes that probe to selected seats (for example `v0.8` while an identical
 * `v0.8s` seat remains the control). Unset defaults to SEARCH_VERSIONS; it is ignored while the max is zero.
 * SEARCH_CIRCUIT_BREAKER_MS=<positive ms> provides a lower-bound research emulation of the ranked server's
 * outer per-match circuit: the first over-budget result still applies, then historical versions and strategic
 * v0.8 waits retain each later incumbent. v0.8 still engine-validates a bounded fallback for no-ops, Luck Shields,
 * mountain attacks, and dominant-finish turns. The live wrapper adds call-site overhead outside this timer.
 * v0.8 additionally treats a legal direct attack as lexicographically stronger than every non-combat action from
 * lap 9 onward while its living, non-summoned army has at least twice the enemy's HP. This narrow dominant-finish
 * tier bypasses probability saturation but still uses normal rollouts to choose among legal attacks.
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
 * per searched turn. Every turn row carries a stable in-game identity (`seed`, `side`, `unitId`, `lap`,
 * `decisionOrdinal`) so replayed games can be deduplicated after a worker restart. Lines are buffered per
 * game and appended once; use search_audit_reducer.ts when multiple workers share an append-only path.
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
const MIXED_SUPPORTED_PARETO_AUDIT_SCHEMA = "hoc.search.pareto_focus.v13";

type SearchMode = "off" | "search" | "ablation" | "oracle";
type HorizonMode = "leaf" | "turns" | "reply" | "lap";
type IncumbentKind = "idle" | "defend" | "wait" | "move" | "melee" | "shot" | "area_throw" | "spell" | "mine";

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

const INCUMBENT_KINDS = new Set(["idle", "defend", "wait", "move", "melee", "shot", "area_throw", "spell", "mine"]);
const CHALLENGER_KINDS = new Set<CandidateKind>([
    "wait",
    "defend",
    "move",
    "melee",
    "shot",
    "area_throw",
    "spell",
    "mine",
]);
const V08_MOUNTAIN_CHALLENGER_VERSIONS = new Set(["v0.8", "v0.8s"]);
const V08_FORCE_PRODUCTIVE_INCUMBENT_KINDS = new Set<IncumbentKind>(["idle", "defend", "mine"]);
const V08_AGGRESSIVE_VERSIONS = new Set(["v0.8", "v0.8s"]);
// Production v0.8 bakes the v0.8s native policy used by a13, so both names must
// receive the same search-side target-pressure and urgent-finish semantics.
const V08_TARGET_PRESSURE_VERSIONS = new Set(["v0.8", "v0.8s"]);
const PARETO_ANY_BOARD_SELECTOR_VERSION = "v0.8";
const PRODUCTIVE_ACTION_KINDS = new Set<CandidateKind>(["move", "melee", "shot", "area_throw", "spell"]);
const PRODUCTIVE_ACTION_TYPES = new Set<GameAction["type"]>([
    "move_unit",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "cast_spell",
]);
const PASSIVE_ACTION_TYPES = new Set<GameAction["type"]>(["wait_turn", "defend_turn", "obstacle_attack"]);

/**
 * Classify whether a candidate completes real activity without also consuming the turn on a passive action.
 * Candidate zero needs action-based classification because its enumerator kind is always `incumbent`.
 */
function isProductiveCandidate(candidate: Pick<IEnumeratedCandidate, "kind" | "actions">): boolean {
    return candidate.kind === "incumbent"
        ? candidate.actions.some((action) => PRODUCTIVE_ACTION_TYPES.has(action.type)) &&
              !candidate.actions.some((action) => PASSIVE_ACTION_TYPES.has(action.type))
        : PRODUCTIVE_ACTION_KINDS.has(candidate.kind);
}

function isDirectCombatCandidate(candidate: Pick<IEnumeratedCandidate, "actions">): boolean {
    return isV08DirectCombatDecision(candidate.actions);
}

function isPositiveDirectCombatCandidate(candidate: Pick<IEnumeratedCandidate, "actions" | "features">): boolean {
    return (
        isDirectCombatCandidate(candidate) &&
        Number.isFinite(candidate.features?.expectedDamage) &&
        (candidate.features?.expectedDamage ?? 0) > 0
    );
}

function isPureMoveCandidate(candidate: Pick<IEnumeratedCandidate, "actions">): boolean {
    return candidate.actions.length > 0 && candidate.actions.every((action) => action.type === "move_unit");
}

function isDominantFinishCombatReplacement(
    prioritizeDominantFinish: boolean,
    selected: Pick<IEnumeratedCandidate, "actions"> | undefined,
    incumbent: readonly GameAction[],
): boolean {
    return (
        prioritizeDominantFinish &&
        selected !== undefined &&
        isDirectCombatCandidate(selected) &&
        !isV08DirectCombatDecision(incumbent)
    );
}

function parseKindFilter<T extends string>(
    name: string,
    raw: string | undefined,
    allowed: ReadonlySet<string>,
): ReadonlySet<T> | null {
    if (raw === undefined || raw === "") return null;
    const values = raw.split(",").map((value) => value.trim());
    if (
        !values.length ||
        values.some((value) => !value || !allowed.has(value)) ||
        new Set(values).size !== values.length
    ) {
        throw new Error(`${name} must be a comma-separated list of unique supported kinds`);
    }
    return new Set(values as T[]);
}

/** Classify an arbitrary decided action list into the candidate-kind vocabulary (for audit buckets). */
export function classifyActions(actions: readonly GameAction[]): IncumbentKind {
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
    /** Observe-only decisions where the normal gate would have replaced the incumbent. */
    shadowRecommendations: number;
    /** Searched decisions whose incumbent was rejected by the engine in simulation. */
    illegalIncumbent: number;
    /** Decisions skipped because only the incumbent existed after filtering. */
    singleCandidate: number;
    candidatesTotal: number;
    /** Candidates that reached the configured full rollout horizon after optional shortlisting. */
    scoredCandidatesTotal: number;
    /** Searches abandoned before every shortlisted candidate received a comparable full score. */
    deadlineFallbacks: number;
    /** v0.8 turns that entered the fixed late two-to-one-HP finish window. */
    dominantFinishTurns: number;
    /** Normal searched turns where the finish tier replaced a non-combat incumbent with direct combat. */
    dominantFinishCombatOverrides: number;
    /** Deadline/circuit fallbacks where the finish tier selected direct combat over a non-combat incumbent. */
    dominantFinishCombatFallbacks: number;
    /** Explicit v0.8 stronger-ranged initiative waits observed by the search wrapper. */
    strongerRangedPostureWaits: number;
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
    /** Endless Quiver decisions redirected by the pure-ranged deadline finisher. */
    pureRangedDeadlineFinisherDecisions: number;
    /** Deadline-finisher decisions that replaced the inherited action list. */
    pureRangedDeadlineFinisherOverrides: number;
    /** Earliest lap where the deadline finisher found an engine-valid delivery (zero means never). */
    pureRangedDeadlineFinisherStartLap: number;
    /** Sum of expected primary No Melee damage across deadline-finisher deliveries. */
    pureRangedDeadlineFinisherPrimaryDamage: number;
    /** Turns where the aggregate-Pareto filter proposed at least one No Melee redirect. */
    pureRangedParetoNoMeleeFocusProposals: number;
    /** Proposed turns whose authoritative engine probe accepted a redirect. */
    pureRangedParetoNoMeleeFocusValidOverrides: number;
    /** Proposed turns where every authoritative engine probe rejected. */
    pureRangedParetoNoMeleeFocusRejectedProbes: number;
    /** Sum of expected primary No Melee damage across accepted redirects. */
    pureRangedParetoNoMeleeFocusExpectedDamage: number;
    /** Selected turns whose best proposal also clears the strict 1.00 floor. */
    pureRangedParetoNoMeleeFocusStrictProposals: number;
    /** Selected turns that exist only because the configured floor is below one. */
    pureRangedParetoNoMeleeFocusRelaxedOnlyProposals: number;
    /** Engine-valid overrides that exist only because the configured floor is below one. */
    pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides: number;
    /** Sum of enemy-only aggregate damage deltas across accepted redirects. */
    pureRangedParetoNoMeleeFocusEnemyDamageDelta: number;
    /** Sum of net aggregate damage deltas across accepted redirects. */
    pureRangedParetoNoMeleeFocusNetDamageDelta: number;
    /** Lowest retained aggregate-damage ratio across accepted redirects. */
    pureRangedParetoNoMeleeFocusMinimumDamageRatio: number;
    pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio: number;
    pureRangedParetoNoMeleeFocusMinimumNetDamageRatio: number;
    /** Defensive invariant tripwire; must remain zero. */
    pureRangedParetoNoMeleeFocusBelowFloorViolations: number;
    pureRangedParetoNoMeleeFocusProposalsByActorAbility: Record<string, number>;
    pureRangedParetoNoMeleeFocusOverridesByActorAbility: Record<string, number>;
    pureRangedParetoNoMeleeFocusProposalsByActorName: Record<string, number>;
    pureRangedParetoNoMeleeFocusOverridesByActorName: Record<string, number>;
    /** In-scope production-selector decisions offered to the mixed-supported funnel. */
    mixedSupportedParetoNoMeleeFocusFunnelOpportunities: number;
    /** Production-selector decisions that cumulatively reached each mixed-supported funnel stage. */
    mixedSupportedParetoNoMeleeFocusFunnelCumulative: Record<MixedSupportedParetoNoMeleeFocusFunnelStage, number>;
    /** JIT turns whose inherited stationary shot proposes a lock on an armed original No Melee barrier. */
    pureRangedJitNoMeleeFocusIncumbentLockProposals: number;
    /** Proposed incumbent locks accepted by the authoritative engine probe. */
    pureRangedJitNoMeleeFocusIncumbentLocks: number;
    pureRangedJitNoMeleeFocusRejectedLockProbes: number;
    /** JIT turns where the hard filters proposed at least one different No Melee aim. */
    pureRangedJitNoMeleeFocusProposals: number;
    /** Proposed JIT redirects accepted by the authoritative engine probe. */
    pureRangedJitNoMeleeFocusValidOverrides: number;
    /** Proposed JIT turns where every authoritative engine probe rejected. */
    pureRangedJitNoMeleeFocusRejectedProbes: number;
    pureRangedJitNoMeleeFocusImmediateKillProposals: number;
    pureRangedJitNoMeleeFocusImmediateKillValidOverrides: number;
    pureRangedJitNoMeleeFocusNegativeSlackProposals: number;
    pureRangedJitNoMeleeFocusNegativeSlackValidOverrides: number;
    pureRangedJitNoMeleeFocusExactSlackProposals: number;
    pureRangedJitNoMeleeFocusExactSlackValidOverrides: number;
    pureRangedJitNoMeleeFocusOneBufferProposals: number;
    pureRangedJitNoMeleeFocusOneBufferValidOverrides: number;
    /** Every accepted causal selection: incumbent locks plus redirects. */
    pureRangedJitNoMeleeFocusSelections: number;
    pureRangedJitNoMeleeFocusFiniteAmmoSelections: number;
    pureRangedJitNoMeleeFocusEndlessQuiverSelections: number;
    pureRangedJitNoMeleeFocusNegativeSlackSelections: number;
    pureRangedJitNoMeleeFocusExactSlackSelections: number;
    pureRangedJitNoMeleeFocusOneBufferSelections: number;
    pureRangedJitNoMeleeFocusExpectedDamage: number;
    pureRangedJitNoMeleeFocusEnemyDamageDelta: number;
    pureRangedJitNoMeleeFocusNetDamageDelta: number;
    pureRangedJitNoMeleeFocusMinimumDeadlineSlack: number;
    pureRangedJitNoMeleeFocusMaximumDeadlineSlack: number;
    pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations: number;
    pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations: number;
    pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound: number;
    pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound: number;
    pureRangedJitNoMeleeFocusMinimumDamageRatio: number;
    pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio: number;
    pureRangedJitNoMeleeFocusMinimumNetDamageRatio: number;
    /** Defensive tripwires; all four must remain zero. */
    pureRangedJitNoMeleeFocusBelowFloorViolations: number;
    pureRangedJitNoMeleeFocusExpectedKillRegressionViolations: number;
    pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations: number;
    pureRangedJitNoMeleeFocusNonSingleActivationViolations: number;
    pureRangedJitNoMeleeFocusLocksByActorName: Record<string, number>;
    pureRangedJitNoMeleeFocusLocksByTargetName: Record<string, number>;
    pureRangedJitNoMeleeFocusLocksByLap: Record<string, number>;
    pureRangedJitNoMeleeFocusLocksBySlack: Record<string, number>;
    pureRangedJitNoMeleeFocusProposalsByActorName: Record<string, number>;
    pureRangedJitNoMeleeFocusOverridesByActorName: Record<string, number>;
    pureRangedJitNoMeleeFocusProposalsByTargetName: Record<string, number>;
    pureRangedJitNoMeleeFocusOverridesByTargetName: Record<string, number>;
    pureRangedJitNoMeleeFocusProposalsByLap: Record<string, number>;
    pureRangedJitNoMeleeFocusOverridesByLap: Record<string, number>;
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

const emptyMixedSupportedParetoNoMeleeFocusFunnel = (): Record<MixedSupportedParetoNoMeleeFocusFunnelStage, number> => {
    const counts = {} as Record<MixedSupportedParetoNoMeleeFocusFunnelStage, number>;
    for (const stage of MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES) {
        counts[stage] = 0;
    }
    return counts;
};

const emptyCounters = (): ISearchCounters => ({
    decisions: 0,
    searched: 0,
    overrides: 0,
    shadowRecommendations: 0,
    illegalIncumbent: 0,
    singleCandidate: 0,
    candidatesTotal: 0,
    scoredCandidatesTotal: 0,
    deadlineFallbacks: 0,
    dominantFinishTurns: 0,
    dominantFinishCombatOverrides: 0,
    dominantFinishCombatFallbacks: 0,
    strongerRangedPostureWaits: 0,
    finishPressureLeaves: 0,
    finishPressureNonzeroLeaves: 0,
    finishPressureLogitSum: 0,
    pureRangedTerminalLeaves: 0,
    pureRangedTerminalNonzeroLeaves: 0,
    pureRangedTerminalLogitSum: 0,
    pureRangedDeadlineFinisherDecisions: 0,
    pureRangedDeadlineFinisherOverrides: 0,
    pureRangedDeadlineFinisherStartLap: 0,
    pureRangedDeadlineFinisherPrimaryDamage: 0,
    pureRangedParetoNoMeleeFocusProposals: 0,
    pureRangedParetoNoMeleeFocusValidOverrides: 0,
    pureRangedParetoNoMeleeFocusRejectedProbes: 0,
    pureRangedParetoNoMeleeFocusExpectedDamage: 0,
    pureRangedParetoNoMeleeFocusStrictProposals: 0,
    pureRangedParetoNoMeleeFocusRelaxedOnlyProposals: 0,
    pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides: 0,
    pureRangedParetoNoMeleeFocusEnemyDamageDelta: 0,
    pureRangedParetoNoMeleeFocusNetDamageDelta: 0,
    pureRangedParetoNoMeleeFocusMinimumDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedParetoNoMeleeFocusMinimumNetDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedParetoNoMeleeFocusBelowFloorViolations: 0,
    pureRangedParetoNoMeleeFocusProposalsByActorAbility: {},
    pureRangedParetoNoMeleeFocusOverridesByActorAbility: {},
    pureRangedParetoNoMeleeFocusProposalsByActorName: {},
    pureRangedParetoNoMeleeFocusOverridesByActorName: {},
    mixedSupportedParetoNoMeleeFocusFunnelOpportunities: 0,
    mixedSupportedParetoNoMeleeFocusFunnelCumulative: emptyMixedSupportedParetoNoMeleeFocusFunnel(),
    pureRangedJitNoMeleeFocusIncumbentLockProposals: 0,
    pureRangedJitNoMeleeFocusIncumbentLocks: 0,
    pureRangedJitNoMeleeFocusRejectedLockProbes: 0,
    pureRangedJitNoMeleeFocusProposals: 0,
    pureRangedJitNoMeleeFocusValidOverrides: 0,
    pureRangedJitNoMeleeFocusRejectedProbes: 0,
    pureRangedJitNoMeleeFocusImmediateKillProposals: 0,
    pureRangedJitNoMeleeFocusImmediateKillValidOverrides: 0,
    pureRangedJitNoMeleeFocusNegativeSlackProposals: 0,
    pureRangedJitNoMeleeFocusNegativeSlackValidOverrides: 0,
    pureRangedJitNoMeleeFocusExactSlackProposals: 0,
    pureRangedJitNoMeleeFocusExactSlackValidOverrides: 0,
    pureRangedJitNoMeleeFocusOneBufferProposals: 0,
    pureRangedJitNoMeleeFocusOneBufferValidOverrides: 0,
    pureRangedJitNoMeleeFocusSelections: 0,
    pureRangedJitNoMeleeFocusFiniteAmmoSelections: 0,
    pureRangedJitNoMeleeFocusEndlessQuiverSelections: 0,
    pureRangedJitNoMeleeFocusNegativeSlackSelections: 0,
    pureRangedJitNoMeleeFocusExactSlackSelections: 0,
    pureRangedJitNoMeleeFocusOneBufferSelections: 0,
    pureRangedJitNoMeleeFocusExpectedDamage: 0,
    pureRangedJitNoMeleeFocusEnemyDamageDelta: 0,
    pureRangedJitNoMeleeFocusNetDamageDelta: 0,
    pureRangedJitNoMeleeFocusMinimumDeadlineSlack: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusMaximumDeadlineSlack: Number.NEGATIVE_INFINITY,
    pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations: Number.NEGATIVE_INFINITY,
    pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound: Number.NEGATIVE_INFINITY,
    pureRangedJitNoMeleeFocusMinimumDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusMinimumNetDamageRatio: Number.POSITIVE_INFINITY,
    pureRangedJitNoMeleeFocusBelowFloorViolations: 0,
    pureRangedJitNoMeleeFocusExpectedKillRegressionViolations: 0,
    pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations: 0,
    pureRangedJitNoMeleeFocusNonSingleActivationViolations: 0,
    pureRangedJitNoMeleeFocusLocksByActorName: {},
    pureRangedJitNoMeleeFocusLocksByTargetName: {},
    pureRangedJitNoMeleeFocusLocksByLap: {},
    pureRangedJitNoMeleeFocusLocksBySlack: {},
    pureRangedJitNoMeleeFocusProposalsByActorName: {},
    pureRangedJitNoMeleeFocusOverridesByActorName: {},
    pureRangedJitNoMeleeFocusProposalsByTargetName: {},
    pureRangedJitNoMeleeFocusOverridesByTargetName: {},
    pureRangedJitNoMeleeFocusProposalsByLap: {},
    pureRangedJitNoMeleeFocusOverridesByLap: {},
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
    private readonly maxMoveShotComposites: number;
    private readonly moveShotVersions: ReadonlySet<string>;
    private readonly activeChallengers: boolean;
    private readonly aggressiveV08: boolean;
    private readonly observeOnly: boolean;
    private readonly incumbentKinds: ReadonlySet<IncumbentKind> | null;
    private readonly challengerKinds: ReadonlySet<CandidateKind> | null;
    private readonly validationRollouts: number | null;
    private readonly shortlist: number | null;
    private readonly decisionDeadlineMs: number | null;
    private readonly lateRangedFinishWeight: number;
    private readonly pureRangedTerminalWeight: number;
    private readonly pureRangedNoMeleePressure: boolean;
    private readonly pureRangedNoMeleePressureVersions: ReadonlySet<string>;
    private readonly pureRangedDeadlineFinisher: boolean;
    private readonly pureRangedDeadlineFinisherVersions: ReadonlySet<string>;
    private readonly pureRangedParetoNoMeleeFocus: boolean;
    private readonly pureRangedParetoNoMeleeFocusVersions: ReadonlySet<string>;
    private readonly pureRangedParetoNoMeleeFocusDamageFloor: number;
    private readonly pureRangedParetoNoMeleeFocusScope: PureRangedParetoNoMeleeFocusScope;
    private readonly pureRangedJitNoMeleeFocus: boolean;
    private readonly pureRangedJitNoMeleeFocusVersions: ReadonlySet<string>;
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
        const rawMaxMoveShots = process.env.SEARCH_MAX_MOVE_SHOTS;
        if (this.mode !== "search" || rawMaxMoveShots === undefined || rawMaxMoveShots === "") {
            this.maxMoveShotComposites = 0;
        } else {
            const maxMoveShots = Number(rawMaxMoveShots);
            if (!Number.isSafeInteger(maxMoveShots) || maxMoveShots < 0 || maxMoveShots > 2) {
                throw new Error("SEARCH_MAX_MOVE_SHOTS must be an integer between 0 and 2");
            }
            this.maxMoveShotComposites = maxMoveShots;
        }
        const rawMoveShotVersions = process.env.SEARCH_MOVE_SHOT_VERSIONS;
        if (this.maxMoveShotComposites === 0) {
            this.moveShotVersions = new Set();
        } else if (rawMoveShotVersions === undefined) {
            this.moveShotVersions = new Set(this.versions);
        } else {
            const moveShotVersions = rawMoveShotVersions.split(",").map((version) => version.trim());
            if (
                !moveShotVersions.length ||
                moveShotVersions.some((version) => !version) ||
                new Set(moveShotVersions).size !== moveShotVersions.length
            ) {
                throw new Error("SEARCH_MOVE_SHOT_VERSIONS must be a comma-separated list of unique versions");
            }
            this.moveShotVersions = new Set(moveShotVersions);
        }
        this.activeChallengers = this.mode === "search" && process.env.SEARCH_ACTIVE_CHALLENGERS === "1";
        this.aggressiveV08 = this.mode === "search" && process.env.V08_AGGRESSIVE === "1";
        const rawObserveOnly = process.env.SEARCH_OBSERVE_ONLY;
        if (rawObserveOnly !== undefined && rawObserveOnly !== "" && rawObserveOnly !== "0" && rawObserveOnly !== "1") {
            throw new Error("SEARCH_OBSERVE_ONLY must be 0 or 1");
        }
        this.observeOnly = rawObserveOnly === "1";
        this.incumbentKinds = parseKindFilter<IncumbentKind>(
            "SEARCH_INCUMBENT_KINDS",
            process.env.SEARCH_INCUMBENT_KINDS,
            INCUMBENT_KINDS,
        );
        this.challengerKinds = parseKindFilter<CandidateKind>(
            "SEARCH_CHALLENGER_KINDS",
            process.env.SEARCH_CHALLENGER_KINDS,
            CHALLENGER_KINDS,
        );
        const rawValidationRollouts = process.env.SEARCH_VALIDATION_ROLLOUTS;
        if (rawValidationRollouts === undefined || rawValidationRollouts === "") {
            this.validationRollouts = null;
        } else {
            const validationRollouts = Number(rawValidationRollouts);
            if (!Number.isSafeInteger(validationRollouts) || validationRollouts <= 0) {
                throw new Error("SEARCH_VALIDATION_ROLLOUTS must be a positive integer");
            }
            this.validationRollouts = validationRollouts;
        }
        if (this.observeOnly && this.mode !== "search") {
            throw new Error("SEARCH_OBSERVE_ONLY requires V07_SEARCH=1");
        }
        if ((this.incumbentKinds || this.challengerKinds || this.validationRollouts !== null) && !this.observeOnly) {
            throw new Error(
                "SEARCH_INCUMBENT_KINDS, SEARCH_CHALLENGER_KINDS, and SEARCH_VALIDATION_ROLLOUTS require SEARCH_OBSERVE_ONLY=1",
            );
        }
        if (this.validationRollouts !== null && process.env.SEARCH_IL_DATASET) {
            throw new Error(
                "SEARCH_VALIDATION_ROLLOUTS cannot be combined with SEARCH_IL_DATASET; use SEARCH_AUDIT_TURNS",
            );
        }
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
        const rawPureRangedNoMeleePressure = process.env.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE;
        if (
            this.mode === "search" &&
            rawPureRangedNoMeleePressure !== undefined &&
            rawPureRangedNoMeleePressure !== "" &&
            rawPureRangedNoMeleePressure !== "0" &&
            rawPureRangedNoMeleePressure !== "1"
        ) {
            throw new Error("SEARCH_PURE_RANGED_NO_MELEE_PRESSURE must be 0 or 1");
        }
        this.pureRangedNoMeleePressure = this.mode === "search" && rawPureRangedNoMeleePressure === "1";
        const rawPureRangedNoMeleePressureVersions = process.env.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS;
        if (!this.pureRangedNoMeleePressure) {
            this.pureRangedNoMeleePressureVersions = new Set();
        } else if (rawPureRangedNoMeleePressureVersions === undefined) {
            this.pureRangedNoMeleePressureVersions = new Set(this.versions);
        } else {
            const versions = rawPureRangedNoMeleePressureVersions.split(",").map((version) => version.trim());
            if (
                !versions.length ||
                versions.some((version) => !version) ||
                new Set(versions).size !== versions.length
            ) {
                throw new Error(
                    "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS must be a comma-separated list of unique versions",
                );
            }
            this.pureRangedNoMeleePressureVersions = new Set(versions);
        }
        const rawPureRangedDeadlineFinisher = process.env.SEARCH_PURE_RANGED_DEADLINE_FINISHER;
        if (
            this.mode === "search" &&
            rawPureRangedDeadlineFinisher !== undefined &&
            rawPureRangedDeadlineFinisher !== "" &&
            rawPureRangedDeadlineFinisher !== "0" &&
            rawPureRangedDeadlineFinisher !== "1"
        ) {
            throw new Error("SEARCH_PURE_RANGED_DEADLINE_FINISHER must be 0 or 1");
        }
        this.pureRangedDeadlineFinisher = this.mode === "search" && rawPureRangedDeadlineFinisher === "1";
        const rawPureRangedDeadlineFinisherVersions = process.env.SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS;
        if (!this.pureRangedDeadlineFinisher) {
            this.pureRangedDeadlineFinisherVersions = new Set();
        } else if (rawPureRangedDeadlineFinisherVersions === undefined) {
            this.pureRangedDeadlineFinisherVersions = new Set(this.versions);
        } else {
            const versions = rawPureRangedDeadlineFinisherVersions.split(",").map((version) => version.trim());
            if (
                !versions.length ||
                versions.some((version) => !version) ||
                new Set(versions).size !== versions.length
            ) {
                throw new Error(
                    "SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS must be a comma-separated list of unique versions",
                );
            }
            this.pureRangedDeadlineFinisherVersions = new Set(versions);
        }
        const rawPureRangedParetoNoMeleeFocus = process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS;
        if (
            this.mode === "search" &&
            rawPureRangedParetoNoMeleeFocus !== undefined &&
            rawPureRangedParetoNoMeleeFocus !== "" &&
            rawPureRangedParetoNoMeleeFocus !== "0" &&
            rawPureRangedParetoNoMeleeFocus !== "1"
        ) {
            throw new Error("SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS must be 0 or 1");
        }
        this.pureRangedParetoNoMeleeFocus = this.mode === "search" && rawPureRangedParetoNoMeleeFocus === "1";
        const rawPureRangedParetoNoMeleeFocusScope = process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE;
        if (
            !this.pureRangedParetoNoMeleeFocus ||
            rawPureRangedParetoNoMeleeFocusScope === undefined ||
            rawPureRangedParetoNoMeleeFocusScope === ""
        ) {
            this.pureRangedParetoNoMeleeFocusScope = DEFAULT_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE;
        } else if (
            rawPureRangedParetoNoMeleeFocusScope === "pure_ranged" ||
            rawPureRangedParetoNoMeleeFocusScope === "any_board" ||
            rawPureRangedParetoNoMeleeFocusScope === "mixed_supported"
        ) {
            this.pureRangedParetoNoMeleeFocusScope = rawPureRangedParetoNoMeleeFocusScope;
        } else {
            throw new Error(
                "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE must be pure_ranged, any_board, or mixed_supported",
            );
        }
        const rawPureRangedParetoNoMeleeFocusVersions = process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS;
        if (!this.pureRangedParetoNoMeleeFocus) {
            this.pureRangedParetoNoMeleeFocusVersions = new Set();
        } else if (rawPureRangedParetoNoMeleeFocusVersions === undefined) {
            this.pureRangedParetoNoMeleeFocusVersions = new Set(this.versions);
        } else {
            const versions = rawPureRangedParetoNoMeleeFocusVersions.split(",").map((version) => version.trim());
            if (
                !versions.length ||
                versions.some((version) => !version) ||
                new Set(versions).size !== versions.length
            ) {
                throw new Error(
                    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS must be a comma-separated list of unique versions",
                );
            }
            this.pureRangedParetoNoMeleeFocusVersions = new Set(versions);
        }
        const rawPureRangedParetoNoMeleeFocusDamageFloor =
            process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR;
        if (!this.pureRangedParetoNoMeleeFocus) {
            this.pureRangedParetoNoMeleeFocusDamageFloor = 1;
        } else if (
            rawPureRangedParetoNoMeleeFocusDamageFloor === undefined ||
            rawPureRangedParetoNoMeleeFocusDamageFloor === ""
        ) {
            this.pureRangedParetoNoMeleeFocusDamageFloor = 1;
        } else {
            const damageFloor = Number(rawPureRangedParetoNoMeleeFocusDamageFloor);
            if (!Number.isFinite(damageFloor) || damageFloor < 0.9 || damageFloor > 1) {
                throw new Error("SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR must be between 0.9 and 1");
            }
            this.pureRangedParetoNoMeleeFocusDamageFloor = damageFloor;
        }
        if (
            this.pureRangedParetoNoMeleeFocusScope !== "pure_ranged" &&
            this.pureRangedParetoNoMeleeFocusDamageFloor !== 1
        ) {
            throw new Error(
                `SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE=${this.pureRangedParetoNoMeleeFocusScope} ` +
                    "requires damage floor 1",
            );
        }
        const rawPureRangedJitNoMeleeFocus = process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS;
        if (
            this.mode === "search" &&
            rawPureRangedJitNoMeleeFocus !== undefined &&
            rawPureRangedJitNoMeleeFocus !== "" &&
            rawPureRangedJitNoMeleeFocus !== "0" &&
            rawPureRangedJitNoMeleeFocus !== "1"
        ) {
            throw new Error("SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS must be 0 or 1");
        }
        this.pureRangedJitNoMeleeFocus = this.mode === "search" && rawPureRangedJitNoMeleeFocus === "1";
        const rawPureRangedJitNoMeleeFocusVersions = process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS;
        if (!this.pureRangedJitNoMeleeFocus) {
            this.pureRangedJitNoMeleeFocusVersions = new Set();
        } else if (rawPureRangedJitNoMeleeFocusVersions === undefined) {
            this.pureRangedJitNoMeleeFocusVersions = new Set(this.versions);
        } else {
            const versions = rawPureRangedJitNoMeleeFocusVersions.split(",").map((version) => version.trim());
            if (
                !versions.length ||
                versions.some((version) => !version) ||
                new Set(versions).size !== versions.length
            ) {
                throw new Error(
                    "SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS must be a comma-separated list of unique versions",
                );
            }
            this.pureRangedJitNoMeleeFocusVersions = new Set(versions);
        }
        if (
            [
                this.pureRangedNoMeleePressure,
                this.pureRangedDeadlineFinisher,
                this.pureRangedParetoNoMeleeFocus,
                this.pureRangedJitNoMeleeFocus,
            ].filter(Boolean).length > 1
        ) {
            throw new Error(
                "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE, SEARCH_PURE_RANGED_DEADLINE_FINISHER, and " +
                    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS, and SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS " +
                    "are mutually exclusive",
            );
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
    /** Seat-local action-space switch; lets one searched version remain an otherwise identical control. */
    private moveShotCapForVersion(version: string): number {
        return this.moveShotVersions.has(version) ? this.maxMoveShotComposites : 0;
    }
    /** Capture the immutable post-setup armies before either side takes a combat turn. */
    public onFightReady(): void {
        if (this.lateRangedFinishWeight > 0 && this.finishPressureState === null) {
            this.finishPressureState = captureFinishPressureState(this.deps.unitsHolder);
        }
        if (
            (this.pureRangedTerminalWeight > 0 ||
                this.pureRangedNoMeleePressure ||
                this.pureRangedDeadlineFinisher ||
                this.pureRangedParetoNoMeleeFocus ||
                this.pureRangedJitNoMeleeFocus) &&
            this.pureRangedTerminalState === null
        ) {
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
        const incumbentKind = classifyActions(incumbent);
        const isV08Search = this.mode === "search" && V08_MOUNTAIN_CHALLENGER_VERSIONS.has(version);
        const isAggressiveV08 = this.aggressiveV08 && V08_AGGRESSIVE_VERSIONS.has(version);
        if (this.incumbentKinds && !this.incumbentKinds.has(incumbentKind)) {
            return incumbent;
        }
        const currentLap = this.deps.fightProperties.getCurrentLap();
        const isV08TargetPressurePolicy = isV08Search && V08_TARGET_PRESSURE_VERSIONS.has(version);
        const pureRangedNoMeleePressureSeat =
            this.pureRangedNoMeleePressure && this.pureRangedNoMeleePressureVersions.has(version);
        const pureRangedDeadlineFinisherSeat =
            this.pureRangedDeadlineFinisher && this.pureRangedDeadlineFinisherVersions.has(version);
        const pureRangedParetoNoMeleeFocusSeat =
            this.pureRangedParetoNoMeleeFocus &&
            this.pureRangedParetoNoMeleeFocusVersions.has(version) &&
            (this.pureRangedParetoNoMeleeFocusScope === "pure_ranged" || version === PARETO_ANY_BOARD_SELECTOR_VERSION);
        const mixedSupportedParetoNoMeleeFocusFunnelSeat =
            pureRangedParetoNoMeleeFocusSeat &&
            this.pureRangedParetoNoMeleeFocusScope === "mixed_supported" &&
            !this.observeOnly &&
            !this.circuitOpen;
        const pureRangedJitNoMeleeFocusSeat =
            this.pureRangedJitNoMeleeFocus && this.pureRangedJitNoMeleeFocusVersions.has(version);
        // A wait is an initiative action, not a skipped turn: it normally reactivates the unit later in the same
        // lap. Only hard passive/no-op incumbents get the lexicographic productive tier. The research aggressive
        // arm scores a wait normally but uses a zero gate against engine-valid productive actions. The separate
        // two-to-one-HP dominant-finish tier may still force immediate combat late.
        const prioritizeProductiveActions = isV08Search && V08_FORCE_PRODUCTIVE_INCUMBENT_KINDS.has(incumbentKind);
        const strongerRangedPostureWait =
            incumbentKind === "wait" &&
            isV08StrongerRangedPostureWait(unit, this.deps.unitsHolder, currentLap, incumbent);
        if (strongerRangedPostureWait) {
            this.counters.strongerRangedPostureWaits += 1;
        }
        const aggressiveWaitComparison = isAggressiveV08 && incumbentKind === "wait" && !strongerRangedPostureWait;
        const prioritizeDominantFinish =
            isV08Search && v08DominantFinishState(this.deps.unitsHolder, unit.getTeam(), currentLap).dominant;
        const prioritizeV08SUrgency =
            isV08TargetPressurePolicy && Number.isFinite(currentLap) && currentLap >= V08S_URGENT_FINISH_START_LAP;
        const v08sHasStrongerRangedOutput =
            isV08TargetPressurePolicy &&
            v08TeamRangedOutput(unit.getTeam(), this.deps.unitsHolder) >
                v08TeamRangedOutput(otherTeam(unit.getTeam()), this.deps.unitsHolder);
        const prioritizeV08STargetPressure =
            isV08TargetPressurePolicy &&
            Number.isFinite(currentLap) &&
            (prioritizeV08SUrgency ||
                (isV08DirectCombatDecision(incumbent) &&
                    (!v08sHasStrongerRangedOutput || currentLap >= V08_TARGET_PRESSURE_START_LAP)));
        const useProductiveFallback =
            (prioritizeProductiveActions || prioritizeDominantFinish || prioritizeV08SUrgency) && !this.observeOnly;
        if (prioritizeDominantFinish) {
            this.counters.dominantFinishTurns += 1;
        }
        if (
            this.lateRangedFinishWeight > 0 ||
            this.pureRangedTerminalWeight > 0 ||
            pureRangedNoMeleePressureSeat ||
            pureRangedDeadlineFinisherSeat ||
            this.pureRangedParetoNoMeleeFocus ||
            this.pureRangedJitNoMeleeFocus
        ) {
            this.onFightReady();
        }
        const pureRangedNoMeleePressureBoard =
            pureRangedNoMeleePressureSeat && this.pureRangedTerminalState?.eligible === true;
        const pureRangedDeadlineFinisherBoard =
            pureRangedDeadlineFinisherSeat &&
            this.pureRangedTerminalState?.eligible === true &&
            unit.hasAbilityActive("Endless Quiver");
        const mixedSupportedParetoFunnelProbe = mixedSupportedParetoNoMeleeFocusFunnelSeat
            ? probeMixedSupportedParetoNoMeleeFocusFunnel(
                  unit,
                  this.deps.unitsHolder,
                  this.pureRangedTerminalState,
                  currentLap,
                  incumbent,
              )
            : undefined;
        if (mixedSupportedParetoFunnelProbe) {
            this.counters.mixedSupportedParetoNoMeleeFocusFunnelOpportunities += 1;
            for (const stage of mixedSupportedParetoFunnelProbe.passedStages) {
                this.counters.mixedSupportedParetoNoMeleeFocusFunnelCumulative[stage] += 1;
            }
        }
        const mixedSupportedParetoContext =
            this.pureRangedParetoNoMeleeFocus && this.pureRangedParetoNoMeleeFocusScope === "mixed_supported"
                ? mixedSupportedParetoFunnelProbe
                    ? mixedSupportedParetoFunnelProbe.context
                    : mixedSupportedParetoNoMeleeFocusContext(unit, this.deps.unitsHolder, this.pureRangedTerminalState)
                : undefined;
        const incumbentRangedTargetId = incumbent.find((action) => action.type === "range_attack")?.targetId;
        // Catalog expansion is global rather than version-scoped: both experiment seats enumerate the exact same
        // target-covered catalog, while only the scoped candidate seat may select the Pareto redirect below.
        const pureRangedParetoNoMeleeFocusCatalogBoard =
            this.pureRangedParetoNoMeleeFocusScope === "pure_ranged"
                ? this.pureRangedParetoNoMeleeFocus &&
                  this.pureRangedTerminalState?.eligible === true &&
                  incumbentKind === "shot" &&
                  pureRangedParetoNoMeleeFocusActorAbility(unit) !== undefined &&
                  Number.isFinite(currentLap) &&
                  currentLap >= 1 &&
                  currentLap < PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP
                : this.pureRangedParetoNoMeleeFocusScope === "any_board"
                  ? this.pureRangedParetoNoMeleeFocus &&
                    incumbentKind === "shot" &&
                    anyBoardParetoNoMeleeFocusActorAbility(unit, this.pureRangedTerminalState) !== undefined &&
                    pureRangedParetoNoMeleeFocusLapEligible(currentLap) &&
                    isParetoNoMeleeFocusStationaryIncumbent(unit, incumbent)
                  : this.pureRangedParetoNoMeleeFocus &&
                    incumbentKind === "shot" &&
                    mixedSupportedParetoContext !== undefined &&
                    !mixedSupportedParetoContext.noMeleeTargetIds.includes(incumbentRangedTargetId ?? "") &&
                    pureRangedParetoNoMeleeFocusLapEligible(currentLap) &&
                    isParetoNoMeleeFocusStationaryIncumbent(unit, incumbent);
        // Catalog expansion is also global for the JIT arm. Its stricter pre-enumeration guards ensure that
        // move-shots and all other action classes retain their stock a13 catalogs exactly.
        const pureRangedJitNoMeleeFocusCatalogBoard =
            this.pureRangedJitNoMeleeFocus &&
            this.pureRangedTerminalState?.eligible === true &&
            incumbentKind === "shot" &&
            pureRangedJitNoMeleeFocusActorEligible(unit, this.pureRangedTerminalState) &&
            pureRangedJitNoMeleeFocusLapEligible(currentLap) &&
            isPureRangedJitNoMeleeFocusStationaryIncumbent(unit, incumbent);
        const pureRangedDirectInterventionBoard = pureRangedNoMeleePressureBoard || pureRangedDeadlineFinisherBoard;
        // Historical, observe-only, and ordinary-wait searches preserve the exact fail-closed incumbent after a
        // circuit opens. Hard v0.8 passives and dominant-finish turns still probe an engine-valid fallback.
        if (this.circuitOpen && !useProductiveFallback && !pureRangedDirectInterventionBoard) {
            this.counters.circuitSkipped += 1;
            return incumbent;
        }
        const t0 = performance.now();
        const savedSource = getDeterministicRandomSource();
        const savedActive = this.deps.getActiveUnitId();
        const seedBase = this.simSeed(unit);
        // Swap the tournament's seeded RNG to a PRIVATE stream around the WHOLE search (enumeration
        // included) and restore the exact source reference in `finally` — identical hygiene to
        // lookahead.ts, so V07_SEARCH off/on stay individually reproducible and paired A/Bs stay paired.
        setDeterministicRandomSource(makeRng(seedBase));
        try {
            if (this.mode === "oracle") {
                this.counters.decisions += 1;
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
            const preserveBaselineAttackTargetCoverage =
                prioritizeV08STargetPressure ||
                prioritizeV08SUrgency ||
                pureRangedParetoNoMeleeFocusCatalogBoard ||
                pureRangedJitNoMeleeFocusCatalogBoard;
            const enumerationOptions = {
                ...this.caps,
                maxMoveShotComposites: this.moveShotCapForVersion(version),
                includeMountainAttacks: isV08Search,
                enrichIncumbentMetadata: isV08Search || this.ilPath !== undefined,
                preserveMovePostureDiversity:
                    isV08TargetPressurePolicy &&
                    v08sHasStrongerRangedOutput &&
                    !prioritizeDominantFinish &&
                    !prioritizeV08SUrgency,
                preserveAttackTargetCoverage: preserveBaselineAttackTargetCoverage,
            };
            const keepCandidate = (candidate: IEnumeratedCandidate): boolean => {
                if (candidate.kind === "incumbent") return true;
                if (this.challengerKinds && !this.challengerKinds.has(candidate.kind)) return false;
                // Search may compare a strategic wait, but it must never introduce a new Luck Shield or mountain
                // hit. Retaining candidate zero above still permits either action as a fail-closed/true fallback.
                if (isV08Search && (candidate.kind === "defend" || candidate.kind === "mine")) {
                    return false;
                }
                // Every v0.8 search keeps the enumerator's nearest legal move even when the catalog arm does not
                // enable the broader move experiment. Otherwise a unit with no attack can still choose wait,
                // defend, or a mountain hit while a real reposition is available. SEARCH_INCLUDE_MOVES continues
                // to control the wider, multi-destination move set and all pre-v0.8 behavior.
                if (!this.includeMoves && candidate.kind === "move" && !isV08Search) {
                    return false;
                }
                return !this.activeChallengers || (candidate.kind !== "wait" && candidate.kind !== "defend");
            };
            const candidates = enumerateCandidates(unit, context, incumbent, enumerationOptions).candidates.filter(
                keepCandidate,
            );
            if (mixedSupportedParetoFunnelProbe?.failedStage === null) {
                if (pureRangedParetoNoMeleeFocusCatalogBoard) {
                    this.counters.mixedSupportedParetoNoMeleeFocusFunnelCumulative.catalog_expansion += 1;
                }
            }
            // The normal capped catalog remains untouched if a terminal intervention finds no engine-valid shot.
            // Private target-coverage re-enumeration prevents the No Melee target from disappearing behind the
            // generic shot cap, but none of its extra candidates can leak into the fallback search.
            const terminalCandidateSource =
                pureRangedDirectInterventionBoard && !preserveBaselineAttackTargetCoverage
                    ? enumerateCandidates(unit, context, incumbent, {
                          ...enumerationOptions,
                          preserveAttackTargetCoverage: true,
                      }).candidates.filter(keepCandidate)
                    : candidates;
            const mixedSupportedParetoFocusCandidates =
                mixedSupportedParetoFunnelProbe?.failedStage === null && pureRangedParetoNoMeleeFocusCatalogBoard
                    ? rankPureRangedParetoNoMeleeFocusCandidates(
                          unit,
                          this.deps.unitsHolder,
                          candidates,
                          this.pureRangedTerminalState,
                          currentLap,
                          this.pureRangedParetoNoMeleeFocusDamageFloor,
                          this.pureRangedParetoNoMeleeFocusScope,
                      )
                    : undefined;
            if (mixedSupportedParetoFocusCandidates?.length) {
                this.counters.mixedSupportedParetoNoMeleeFocusFunnelCumulative.exact_pareto_proposal += 1;
            }
            if (
                pureRangedJitNoMeleeFocusSeat &&
                pureRangedJitNoMeleeFocusCatalogBoard &&
                !this.circuitOpen &&
                !this.observeOnly
            ) {
                const focusCandidates = rankPureRangedJitNoMeleeFocusCandidates(
                    unit,
                    this.deps.unitsHolder,
                    candidates,
                    this.pureRangedTerminalState,
                    currentLap,
                );
                const incumbentLockProposal = focusCandidates.find((candidate) => candidate.incumbentLocked);
                const redirectProposal = focusCandidates.find((candidate) => !candidate.incumbentLocked);
                if (incumbentLockProposal) {
                    this.counters.pureRangedJitNoMeleeFocusIncumbentLockProposals += 1;
                }
                if (redirectProposal) {
                    const proposal = redirectProposal;
                    this.counters.pureRangedJitNoMeleeFocusProposals += 1;
                    if (proposal.immediateKill) this.counters.pureRangedJitNoMeleeFocusImmediateKillProposals += 1;
                    if (proposal.deadlineSlack < 0) {
                        this.counters.pureRangedJitNoMeleeFocusNegativeSlackProposals += 1;
                    } else if (proposal.deadlineSlack === 0) {
                        this.counters.pureRangedJitNoMeleeFocusExactSlackProposals += 1;
                    } else if (proposal.deadlineSlack === 1) {
                        this.counters.pureRangedJitNoMeleeFocusOneBufferProposals += 1;
                    }
                    bump(this.counters.pureRangedJitNoMeleeFocusProposalsByActorName, unit.getName());
                    bump(this.counters.pureRangedJitNoMeleeFocusProposalsByTargetName, proposal.noMeleeTargetName);
                    bump(this.counters.pureRangedJitNoMeleeFocusProposalsByLap, String(currentLap));
                }
                let focusCandidate: IEnumeratedCandidate | undefined;
                let focusProbeCompleted = true;
                try {
                    focusCandidate = this.firstEngineValidCandidate(
                        unit,
                        focusCandidates.map(({ candidate }) => candidate),
                        seedBase,
                        this.decisionDeadlineMs === null ? null : t0 + this.decisionDeadlineMs,
                    );
                } catch (error) {
                    if (!(error instanceof SearchDecisionDeadlineExceeded)) throw error;
                    focusProbeCompleted = false;
                }
                const focus = focusCandidates.find(({ candidate }) => candidate === focusCandidate);
                if (focusCandidate && focus) {
                    this.counters.pureRangedJitNoMeleeFocusSelections += 1;
                    if (focus.activeEndlessQuiver) {
                        this.counters.pureRangedJitNoMeleeFocusEndlessQuiverSelections += 1;
                    } else {
                        this.counters.pureRangedJitNoMeleeFocusFiniteAmmoSelections += 1;
                    }
                    if (focus.deadlineSlack < 0) {
                        this.counters.pureRangedJitNoMeleeFocusNegativeSlackSelections += 1;
                    } else if (focus.deadlineSlack === 0) {
                        this.counters.pureRangedJitNoMeleeFocusExactSlackSelections += 1;
                    } else if (focus.deadlineSlack === 1) {
                        this.counters.pureRangedJitNoMeleeFocusOneBufferSelections += 1;
                    }
                    this.counters.pureRangedJitNoMeleeFocusMinimumDeadlineSlack = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumDeadlineSlack,
                        focus.deadlineSlack,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMaximumDeadlineSlack = Math.max(
                        this.counters.pureRangedJitNoMeleeFocusMaximumDeadlineSlack,
                        focus.deadlineSlack,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations,
                        focus.estimatedRequiredActivations,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations = Math.max(
                        this.counters.pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations,
                        focus.estimatedRequiredActivations,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound,
                        focus.availableFullDamageActivationsUpperBound,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound = Math.max(
                        this.counters.pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound,
                        focus.availableFullDamageActivationsUpperBound,
                    );
                }
                if (focusCandidate && focus?.incumbentLocked) {
                    this.counters.decisions += 1;
                    this.counters.pureRangedJitNoMeleeFocusIncumbentLocks += 1;
                    bump(this.counters.pureRangedJitNoMeleeFocusLocksByActorName, unit.getName());
                    bump(this.counters.pureRangedJitNoMeleeFocusLocksByTargetName, focus.noMeleeTargetName);
                    bump(this.counters.pureRangedJitNoMeleeFocusLocksByLap, String(currentLap));
                    bump(this.counters.pureRangedJitNoMeleeFocusLocksBySlack, String(focus.deadlineSlack));
                    this.counters.msTotal += performance.now() - t0;
                    // Keep the caller's exact action-array identity. Candidate-zero metadata is enriched only for
                    // engine validation and must never make a lock look like an override.
                    return incumbent;
                }
                if (focusCandidate && focus) {
                    this.counters.decisions += 1;
                    this.counters.pureRangedJitNoMeleeFocusValidOverrides += 1;
                    if (focus.immediateKill) {
                        this.counters.pureRangedJitNoMeleeFocusImmediateKillValidOverrides += 1;
                    }
                    if (focus.deadlineSlack < 0) {
                        this.counters.pureRangedJitNoMeleeFocusNegativeSlackValidOverrides += 1;
                    } else if (focus.deadlineSlack === 0) {
                        this.counters.pureRangedJitNoMeleeFocusExactSlackValidOverrides += 1;
                    } else if (focus.deadlineSlack === 1) {
                        this.counters.pureRangedJitNoMeleeFocusOneBufferValidOverrides += 1;
                    }
                    this.counters.pureRangedJitNoMeleeFocusExpectedDamage += focus.expectedNoMeleeDamage;
                    this.counters.pureRangedJitNoMeleeFocusEnemyDamageDelta += focus.expectedEnemyDamageDelta;
                    this.counters.pureRangedJitNoMeleeFocusNetDamageDelta += focus.expectedNetDamageDelta;
                    this.counters.pureRangedJitNoMeleeFocusMinimumDamageRatio = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumDamageRatio,
                        focus.minimumDamageRatio,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio,
                        focus.enemyDamageRatio,
                    );
                    this.counters.pureRangedJitNoMeleeFocusMinimumNetDamageRatio = Math.min(
                        this.counters.pureRangedJitNoMeleeFocusMinimumNetDamageRatio,
                        focus.netDamageRatio,
                    );
                    if (
                        focus.enemyDamageRatio < PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR ||
                        focus.netDamageRatio < PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR
                    ) {
                        this.counters.pureRangedJitNoMeleeFocusBelowFloorViolations += 1;
                    }
                    if (focus.expectedKillDelta < 0) {
                        this.counters.pureRangedJitNoMeleeFocusExpectedKillRegressionViolations += 1;
                    }
                    if (focus.friendlyFireDamageDelta > 0) {
                        this.counters.pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations += 1;
                    }
                    if (
                        focusCandidate.features.spendsRangeShot !== 1 ||
                        focusCandidate.actions.filter((action) => action.type === "range_attack").length !== 1 ||
                        focusCandidate.actions.some(
                            (action) => action.type !== "select_attack_type" && action.type !== "range_attack",
                        )
                    ) {
                        this.counters.pureRangedJitNoMeleeFocusNonSingleActivationViolations += 1;
                    }
                    bump(this.counters.pureRangedJitNoMeleeFocusOverridesByActorName, unit.getName());
                    bump(this.counters.pureRangedJitNoMeleeFocusOverridesByTargetName, focus.noMeleeTargetName);
                    bump(this.counters.pureRangedJitNoMeleeFocusOverridesByLap, String(currentLap));
                    this.counters.msTotal += performance.now() - t0;
                    if (focusCandidate.actions !== incumbent) {
                        this.counters.overrides += 1;
                        bump(this.counters.overridesByIncumbentKind, incumbentKind);
                        bump(this.counters.overridesToKind, focusCandidate.kind);
                    }
                    return focusCandidate.actions;
                }
                if (!focusCandidate && incumbentLockProposal && focusProbeCompleted) {
                    this.counters.pureRangedJitNoMeleeFocusRejectedLockProbes += 1;
                }
                if (!focusCandidate && redirectProposal && focusProbeCompleted) {
                    this.counters.pureRangedJitNoMeleeFocusRejectedProbes += 1;
                }
            }
            if (
                pureRangedParetoNoMeleeFocusSeat &&
                pureRangedParetoNoMeleeFocusCatalogBoard &&
                !this.circuitOpen &&
                !this.observeOnly
            ) {
                const focusCandidates =
                    mixedSupportedParetoFocusCandidates ??
                    rankPureRangedParetoNoMeleeFocusCandidates(
                        unit,
                        this.deps.unitsHolder,
                        candidates,
                        this.pureRangedTerminalState,
                        currentLap,
                        this.pureRangedParetoNoMeleeFocusDamageFloor,
                        this.pureRangedParetoNoMeleeFocusScope,
                    );
                const proposalDecisionOrdinal = this.counters.decisions;
                if (focusCandidates.length) {
                    const proposal = focusCandidates[0];
                    this.counters.pureRangedParetoNoMeleeFocusProposals += 1;
                    if (proposal.minimumDamageRatio >= 1) {
                        this.counters.pureRangedParetoNoMeleeFocusStrictProposals += 1;
                    } else {
                        this.counters.pureRangedParetoNoMeleeFocusRelaxedOnlyProposals += 1;
                    }
                    bump(this.counters.pureRangedParetoNoMeleeFocusProposalsByActorAbility, proposal.actorAbility);
                    bump(this.counters.pureRangedParetoNoMeleeFocusProposalsByActorName, unit.getName());
                }
                let focusCandidate: IEnumeratedCandidate | undefined;
                let focusProbeCompleted = true;
                try {
                    focusCandidate = this.firstEngineValidCandidate(
                        unit,
                        focusCandidates.map(({ candidate }) => candidate),
                        seedBase,
                        this.decisionDeadlineMs === null ? null : t0 + this.decisionDeadlineMs,
                    );
                } catch (error) {
                    if (!(error instanceof SearchDecisionDeadlineExceeded)) throw error;
                    // Preserve ordinary a13 deadline/fallback accounting and selection semantics. The normal
                    // search below will observe the same expired deadline and use its established fallback path.
                    focusProbeCompleted = false;
                }
                const focus = focusCandidates.find(({ candidate }) => candidate === focusCandidate);
                const proposal = focusCandidates[0];
                if (proposal && this.pureRangedParetoNoMeleeFocusScope === "mixed_supported" && this.auditPath) {
                    const auditedProposal = focus ?? proposal;
                    const incumbentCandidate = candidates[0];
                    const incumbentTarget = incumbentCandidate.targetId
                        ? this.deps.unitsHolder.getAllUnits().get(incumbentCandidate.targetId)
                        : undefined;
                    const proposedTarget = this.deps.unitsHolder.getAllUnits().get(auditedProposal.noMeleeTargetId);
                    this.turnRows.push(
                        JSON.stringify({
                            schema: MIXED_SUPPORTED_PARETO_AUDIT_SCHEMA,
                            t: "pareto_focus",
                            seed: this.match.seed,
                            green: this.match.greenVersion,
                            red: this.match.redVersion,
                            side: unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red",
                            unitId: unit.getId(),
                            decisionOrdinal: proposalDecisionOrdinal,
                            lap: currentLap,
                            scope: this.pureRangedParetoNoMeleeFocusScope,
                            status: focus
                                ? "valid_override"
                                : focusProbeCompleted
                                  ? "rejected_probe"
                                  : "deadline_fallback",
                            actor: {
                                name: unit.getName(),
                                ability: auditedProposal.actorAbility,
                            },
                            support: auditedProposal.support,
                            proposalCount: focusCandidates.length,
                            incumbent: {
                                targetId: incumbentCandidate.targetId ?? null,
                                targetName: incumbentTarget?.getName() ?? null,
                                actions: incumbentCandidate.actions,
                                expectedKill: incumbentCandidate.features.expectedKill,
                                expectedNetDamage: incumbentCandidate.features.expectedDamage,
                                enemyDamage: incumbentCandidate.shotFeatures?.enemyDamage ?? null,
                                friendlyFireDamage: incumbentCandidate.shotFeatures?.friendlyFireDamage ?? null,
                                primaryTargetDamage: incumbentCandidate.shotFeatures?.primaryTargetDamage ?? null,
                            },
                            proposal: {
                                targetId: auditedProposal.noMeleeTargetId,
                                targetName: proposedTarget?.getName() ?? null,
                                actions: auditedProposal.candidate.actions,
                                expectedKill: auditedProposal.candidate.features.expectedKill,
                                expectedNetDamage: auditedProposal.candidate.features.expectedDamage,
                                enemyDamage: auditedProposal.candidate.shotFeatures?.enemyDamage ?? null,
                                friendlyFireDamage: auditedProposal.candidate.shotFeatures?.friendlyFireDamage ?? null,
                                primaryTargetDamage:
                                    auditedProposal.candidate.shotFeatures?.primaryTargetDamage ?? null,
                                expectedNoMeleeDamage: auditedProposal.expectedNoMeleeDamage,
                                expectedEnemyDamageDelta: auditedProposal.expectedEnemyDamageDelta,
                                expectedNetDamageDelta: auditedProposal.expectedNetDamageDelta,
                                enemyDamageRatio: auditedProposal.enemyDamageRatio,
                                netDamageRatio: auditedProposal.netDamageRatio,
                                minimumDamageRatio: auditedProposal.minimumDamageRatio,
                            },
                        }),
                    );
                }
                if (focusCandidate && focus) {
                    this.counters.decisions += 1;
                    this.counters.pureRangedParetoNoMeleeFocusValidOverrides += 1;
                    if (mixedSupportedParetoFocusCandidates) {
                        this.counters.mixedSupportedParetoNoMeleeFocusFunnelCumulative.valid_override += 1;
                    }
                    this.counters.pureRangedParetoNoMeleeFocusExpectedDamage += focus.expectedNoMeleeDamage;
                    if (focus.minimumDamageRatio < 1) {
                        this.counters.pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides += 1;
                    }
                    this.counters.pureRangedParetoNoMeleeFocusEnemyDamageDelta += focus.expectedEnemyDamageDelta;
                    this.counters.pureRangedParetoNoMeleeFocusNetDamageDelta += focus.expectedNetDamageDelta;
                    this.counters.pureRangedParetoNoMeleeFocusMinimumDamageRatio = Math.min(
                        this.counters.pureRangedParetoNoMeleeFocusMinimumDamageRatio,
                        focus.minimumDamageRatio,
                    );
                    this.counters.pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio = Math.min(
                        this.counters.pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio,
                        focus.enemyDamageRatio,
                    );
                    this.counters.pureRangedParetoNoMeleeFocusMinimumNetDamageRatio = Math.min(
                        this.counters.pureRangedParetoNoMeleeFocusMinimumNetDamageRatio,
                        focus.netDamageRatio,
                    );
                    if (
                        focus.enemyDamageRatio < this.pureRangedParetoNoMeleeFocusDamageFloor ||
                        focus.netDamageRatio < this.pureRangedParetoNoMeleeFocusDamageFloor
                    ) {
                        this.counters.pureRangedParetoNoMeleeFocusBelowFloorViolations += 1;
                    }
                    bump(this.counters.pureRangedParetoNoMeleeFocusOverridesByActorAbility, focus.actorAbility);
                    bump(this.counters.pureRangedParetoNoMeleeFocusOverridesByActorName, unit.getName());
                    this.counters.msTotal += performance.now() - t0;
                    if (focusCandidate.actions !== incumbent) {
                        this.counters.overrides += 1;
                        bump(this.counters.overridesByIncumbentKind, incumbentKind);
                        bump(this.counters.overridesToKind, focusCandidate.kind);
                    }
                    return focusCandidate.actions;
                }
                if (focusCandidates.length && focusProbeCompleted) {
                    this.counters.pureRangedParetoNoMeleeFocusRejectedProbes += 1;
                }
            }
            if (pureRangedDeadlineFinisherBoard && !this.observeOnly) {
                const deadlineCandidates = rankPureRangedDeadlineFinisherCandidates(
                    unit,
                    this.deps.unitsHolder,
                    terminalCandidateSource,
                    this.pureRangedTerminalState,
                    currentLap,
                );
                const deadlineCandidate = this.firstEngineValidCandidate(unit, deadlineCandidates, seedBase);
                if (deadlineCandidate) {
                    this.counters.decisions += 1;
                    this.counters.pureRangedDeadlineFinisherDecisions += 1;
                    this.counters.pureRangedDeadlineFinisherPrimaryDamage +=
                        deadlineCandidate.shotFeatures?.primaryTargetDamage ?? 0;
                    if (
                        this.counters.pureRangedDeadlineFinisherStartLap === 0 ||
                        currentLap < this.counters.pureRangedDeadlineFinisherStartLap
                    ) {
                        this.counters.pureRangedDeadlineFinisherStartLap = currentLap;
                    }
                    this.counters.msTotal += performance.now() - t0;
                    if (deadlineCandidate.actions !== incumbent) {
                        this.counters.overrides += 1;
                        this.counters.pureRangedDeadlineFinisherOverrides += 1;
                        bump(this.counters.overridesByIncumbentKind, incumbentKind);
                        bump(this.counters.overridesToKind, deadlineCandidate.kind);
                    }
                    return deadlineCandidate.actions;
                }
            }
            if (pureRangedNoMeleePressureBoard && !this.observeOnly) {
                const pressureCandidates = rankPureRangedNoMeleePressureCandidates(
                    unit,
                    this.deps.unitsHolder,
                    terminalCandidateSource,
                    this.pureRangedTerminalState,
                );
                const pressureCandidate = this.firstEngineValidCandidate(unit, pressureCandidates, seedBase);
                if (pressureCandidate) {
                    this.counters.decisions += 1;
                    this.counters.msTotal += performance.now() - t0;
                    if (pressureCandidate.actions !== incumbent) {
                        this.counters.overrides += 1;
                        bump(this.counters.overridesByIncumbentKind, incumbentKind);
                        bump(this.counters.overridesToKind, pressureCandidate.kind);
                    }
                    return pressureCandidate.actions;
                }
            }
            // Prepare a bounded, deterministic fallback before an expensive rollout can exhaust its deadline.
            // The probe uses the real engine and full battle snapshot/restore, so "productive" means the action
            // actually completes rather than merely passing the enumerator's legality mirror. A circuit-open
            // decision also probes here because it intentionally skips the expensive comparison below.
            const productiveFallback =
                useProductiveFallback && (this.decisionDeadlineMs !== null || this.circuitOpen)
                    ? this.firstEngineValidProductiveCandidate(
                          unit,
                          candidates,
                          seedBase,
                          prioritizeDominantFinish,
                          prioritizeV08STargetPressure,
                          prioritizeV08SUrgency,
                      )
                    : undefined;
            if (this.circuitOpen) {
                this.counters.circuitSkipped += 1;
                this.counters.msTotal += performance.now() - t0;
                if (isDominantFinishCombatReplacement(prioritizeDominantFinish, productiveFallback, incumbent)) {
                    this.counters.dominantFinishCombatFallbacks += 1;
                }
                return productiveFallback?.actions ?? incumbent;
            }
            this.counters.decisions += 1;
            if (this.mode === "ablation") {
                return this.ablate(unit, candidates, incumbent, seedBase, t0);
            }
            if (candidates.length <= 1) {
                this.counters.singleCandidate += 1;
                return productiveFallback?.actions ?? incumbent;
            }
            return this.search(
                unit,
                candidates,
                incumbent,
                seedBase,
                t0,
                prioritizeProductiveActions,
                productiveFallback,
                prioritizeDominantFinish,
                aggressiveWaitComparison,
                prioritizeV08STargetPressure,
                prioritizeV08SUrgency,
            );
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
        if (!this.enabled || !this.auditPath) {
            return;
        }
        const c = this.counters;
        const mixedSupportedParetoNoMeleeFocusFunnelFailures = emptyMixedSupportedParetoNoMeleeFocusFunnel();
        let mixedSupportedParetoPreviousStage = c.mixedSupportedParetoNoMeleeFocusFunnelOpportunities;
        for (const stage of MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES) {
            const cumulative = c.mixedSupportedParetoNoMeleeFocusFunnelCumulative[stage];
            mixedSupportedParetoNoMeleeFocusFunnelFailures[stage] = mixedSupportedParetoPreviousStage - cumulative;
            mixedSupportedParetoPreviousStage = cumulative;
        }
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
            aggressiveV08: this.aggressiveV08,
            maxMoveShotComposites: this.maxMoveShotComposites,
            moveShotVersions: [...this.moveShotVersions],
            ...(this.oppModel ? { oppModel: this.oppModel.version } : {}),
            decisions: c.decisions,
            searched: c.searched,
            overrides: c.overrides,
            ...(this.observeOnly
                ? {
                      observeOnly: true,
                      shadowRecommendations: c.shadowRecommendations,
                      incumbentKinds: this.incumbentKinds ? [...this.incumbentKinds] : null,
                      challengerKinds: this.challengerKinds ? [...this.challengerKinds] : null,
                      validationRollouts: this.validationRollouts,
                  }
                : {}),
            illegalIncumbent: c.illegalIncumbent,
            singleCandidate: c.singleCandidate,
            candidatesTotal: c.candidatesTotal,
            scoredCandidatesTotal: c.scoredCandidatesTotal,
            shortlist: this.shortlist,
            decisionDeadlineMs: this.decisionDeadlineMs,
            deadlineFallbacks: c.deadlineFallbacks,
            dominantFinishTurns: c.dominantFinishTurns,
            dominantFinishCombatOverrides: c.dominantFinishCombatOverrides,
            dominantFinishCombatFallbacks: c.dominantFinishCombatFallbacks,
            strongerRangedPostureWaits: c.strongerRangedPostureWaits,
            lateRangedFinishWeight: this.lateRangedFinishWeight,
            initialBoardRangedness: this.finishPressureState?.initialBoardRangedness ?? 0,
            finishPressureLeaves: c.finishPressureLeaves,
            finishPressureNonzeroLeaves: c.finishPressureNonzeroLeaves,
            finishPressureLogitSum: Number(c.finishPressureLogitSum.toFixed(6)),
            pureRangedTerminalWeight: this.pureRangedTerminalWeight,
            pureRangedNoMeleePressure: this.pureRangedNoMeleePressure,
            pureRangedNoMeleePressureVersions: [...this.pureRangedNoMeleePressureVersions],
            pureRangedDeadlineFinisher: this.pureRangedDeadlineFinisher,
            pureRangedDeadlineFinisherVersions: [...this.pureRangedDeadlineFinisherVersions],
            pureRangedDeadlineFinisherDecisions: c.pureRangedDeadlineFinisherDecisions,
            pureRangedDeadlineFinisherOverrides: c.pureRangedDeadlineFinisherOverrides,
            pureRangedDeadlineFinisherStartLap: c.pureRangedDeadlineFinisherStartLap,
            pureRangedDeadlineFinisherPrimaryDamage: Number(c.pureRangedDeadlineFinisherPrimaryDamage.toFixed(3)),
            pureRangedParetoNoMeleeFocus: this.pureRangedParetoNoMeleeFocus,
            pureRangedParetoNoMeleeFocusVersions: [...this.pureRangedParetoNoMeleeFocusVersions],
            pureRangedParetoNoMeleeFocusDamageFloor: this.pureRangedParetoNoMeleeFocusDamageFloor,
            ...(this.pureRangedParetoNoMeleeFocusScope !== "pure_ranged"
                ? { pureRangedParetoNoMeleeFocusScope: this.pureRangedParetoNoMeleeFocusScope }
                : {}),
            ...(this.pureRangedParetoNoMeleeFocusScope === "mixed_supported"
                ? {
                      mixedSupportedParetoNoMeleeFocusFunnel: {
                          countingDomain: "production_v0.8_selector_decisions",
                          stages: [...MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES],
                          opportunities: c.mixedSupportedParetoNoMeleeFocusFunnelOpportunities,
                          cumulative: c.mixedSupportedParetoNoMeleeFocusFunnelCumulative,
                          failures: mixedSupportedParetoNoMeleeFocusFunnelFailures,
                      },
                  }
                : {}),
            pureRangedParetoNoMeleeFocusProposals: c.pureRangedParetoNoMeleeFocusProposals,
            pureRangedParetoNoMeleeFocusValidOverrides: c.pureRangedParetoNoMeleeFocusValidOverrides,
            pureRangedParetoNoMeleeFocusRejectedProbes: c.pureRangedParetoNoMeleeFocusRejectedProbes,
            pureRangedParetoNoMeleeFocusExpectedDamage: Number(c.pureRangedParetoNoMeleeFocusExpectedDamage.toFixed(3)),
            pureRangedParetoNoMeleeFocusStrictProposals: c.pureRangedParetoNoMeleeFocusStrictProposals,
            pureRangedParetoNoMeleeFocusRelaxedOnlyProposals: c.pureRangedParetoNoMeleeFocusRelaxedOnlyProposals,
            pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides:
                c.pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides,
            pureRangedParetoNoMeleeFocusEnemyDamageDelta: Number(
                c.pureRangedParetoNoMeleeFocusEnemyDamageDelta.toFixed(3),
            ),
            pureRangedParetoNoMeleeFocusNetDamageDelta: Number(c.pureRangedParetoNoMeleeFocusNetDamageDelta.toFixed(3)),
            pureRangedParetoNoMeleeFocusMinimumDamageRatio:
                c.pureRangedParetoNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedParetoNoMeleeFocusMinimumDamageRatio.toFixed(6))
                    : null,
            pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio:
                c.pureRangedParetoNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedParetoNoMeleeFocusMinimumEnemyDamageRatio.toFixed(6))
                    : null,
            pureRangedParetoNoMeleeFocusMinimumNetDamageRatio:
                c.pureRangedParetoNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedParetoNoMeleeFocusMinimumNetDamageRatio.toFixed(6))
                    : null,
            pureRangedParetoNoMeleeFocusBelowFloorViolations: c.pureRangedParetoNoMeleeFocusBelowFloorViolations,
            pureRangedParetoNoMeleeFocusProposalsByActorAbility: c.pureRangedParetoNoMeleeFocusProposalsByActorAbility,
            pureRangedParetoNoMeleeFocusOverridesByActorAbility: c.pureRangedParetoNoMeleeFocusOverridesByActorAbility,
            pureRangedParetoNoMeleeFocusProposalsByActorName: c.pureRangedParetoNoMeleeFocusProposalsByActorName,
            pureRangedParetoNoMeleeFocusOverridesByActorName: c.pureRangedParetoNoMeleeFocusOverridesByActorName,
            pureRangedJitNoMeleeFocus: this.pureRangedJitNoMeleeFocus,
            pureRangedJitNoMeleeFocusVersions: [...this.pureRangedJitNoMeleeFocusVersions],
            pureRangedJitNoMeleeFocusStartLap: PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
            pureRangedJitNoMeleeFocusLastLap: PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP,
            pureRangedJitNoMeleeFocusEndLapExclusive: PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP,
            pureRangedJitNoMeleeFocusActivationBuffer: PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER,
            pureRangedJitNoMeleeFocusDamageFloor: PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
            pureRangedJitNoMeleeFocusIncumbentLockProposals: c.pureRangedJitNoMeleeFocusIncumbentLockProposals,
            pureRangedJitNoMeleeFocusIncumbentLocks: c.pureRangedJitNoMeleeFocusIncumbentLocks,
            pureRangedJitNoMeleeFocusRejectedLockProbes: c.pureRangedJitNoMeleeFocusRejectedLockProbes,
            pureRangedJitNoMeleeFocusProposals: c.pureRangedJitNoMeleeFocusProposals,
            pureRangedJitNoMeleeFocusValidOverrides: c.pureRangedJitNoMeleeFocusValidOverrides,
            pureRangedJitNoMeleeFocusRejectedProbes: c.pureRangedJitNoMeleeFocusRejectedProbes,
            pureRangedJitNoMeleeFocusImmediateKillProposals: c.pureRangedJitNoMeleeFocusImmediateKillProposals,
            pureRangedJitNoMeleeFocusImmediateKillValidOverrides:
                c.pureRangedJitNoMeleeFocusImmediateKillValidOverrides,
            pureRangedJitNoMeleeFocusNegativeSlackProposals: c.pureRangedJitNoMeleeFocusNegativeSlackProposals,
            pureRangedJitNoMeleeFocusNegativeSlackValidOverrides:
                c.pureRangedJitNoMeleeFocusNegativeSlackValidOverrides,
            pureRangedJitNoMeleeFocusExactSlackProposals: c.pureRangedJitNoMeleeFocusExactSlackProposals,
            pureRangedJitNoMeleeFocusExactSlackValidOverrides: c.pureRangedJitNoMeleeFocusExactSlackValidOverrides,
            pureRangedJitNoMeleeFocusOneBufferProposals: c.pureRangedJitNoMeleeFocusOneBufferProposals,
            pureRangedJitNoMeleeFocusOneBufferValidOverrides: c.pureRangedJitNoMeleeFocusOneBufferValidOverrides,
            pureRangedJitNoMeleeFocusSelections: c.pureRangedJitNoMeleeFocusSelections,
            pureRangedJitNoMeleeFocusFiniteAmmoSelections: c.pureRangedJitNoMeleeFocusFiniteAmmoSelections,
            pureRangedJitNoMeleeFocusEndlessQuiverSelections: c.pureRangedJitNoMeleeFocusEndlessQuiverSelections,
            pureRangedJitNoMeleeFocusNegativeSlackSelections: c.pureRangedJitNoMeleeFocusNegativeSlackSelections,
            pureRangedJitNoMeleeFocusExactSlackSelections: c.pureRangedJitNoMeleeFocusExactSlackSelections,
            pureRangedJitNoMeleeFocusOneBufferSelections: c.pureRangedJitNoMeleeFocusOneBufferSelections,
            pureRangedJitNoMeleeFocusExpectedDamage: Number(c.pureRangedJitNoMeleeFocusExpectedDamage.toFixed(3)),
            pureRangedJitNoMeleeFocusEnemyDamageDelta: Number(c.pureRangedJitNoMeleeFocusEnemyDamageDelta.toFixed(3)),
            pureRangedJitNoMeleeFocusNetDamageDelta: Number(c.pureRangedJitNoMeleeFocusNetDamageDelta.toFixed(3)),
            pureRangedJitNoMeleeFocusMinimumDeadlineSlack:
                c.pureRangedJitNoMeleeFocusSelections > 0 ? c.pureRangedJitNoMeleeFocusMinimumDeadlineSlack : null,
            pureRangedJitNoMeleeFocusMaximumDeadlineSlack:
                c.pureRangedJitNoMeleeFocusSelections > 0 ? c.pureRangedJitNoMeleeFocusMaximumDeadlineSlack : null,
            pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations:
                c.pureRangedJitNoMeleeFocusSelections > 0
                    ? c.pureRangedJitNoMeleeFocusMinimumEstimatedRequiredActivations
                    : null,
            pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations:
                c.pureRangedJitNoMeleeFocusSelections > 0
                    ? c.pureRangedJitNoMeleeFocusMaximumEstimatedRequiredActivations
                    : null,
            pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound:
                c.pureRangedJitNoMeleeFocusSelections > 0
                    ? c.pureRangedJitNoMeleeFocusMinimumAvailableActivationUpperBound
                    : null,
            pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound:
                c.pureRangedJitNoMeleeFocusSelections > 0
                    ? c.pureRangedJitNoMeleeFocusMaximumAvailableActivationUpperBound
                    : null,
            pureRangedJitNoMeleeFocusMinimumDamageRatio:
                c.pureRangedJitNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedJitNoMeleeFocusMinimumDamageRatio.toFixed(6))
                    : null,
            pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio:
                c.pureRangedJitNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedJitNoMeleeFocusMinimumEnemyDamageRatio.toFixed(6))
                    : null,
            pureRangedJitNoMeleeFocusMinimumNetDamageRatio:
                c.pureRangedJitNoMeleeFocusValidOverrides > 0
                    ? Number(c.pureRangedJitNoMeleeFocusMinimumNetDamageRatio.toFixed(6))
                    : null,
            pureRangedJitNoMeleeFocusBelowFloorViolations: c.pureRangedJitNoMeleeFocusBelowFloorViolations,
            pureRangedJitNoMeleeFocusExpectedKillRegressionViolations:
                c.pureRangedJitNoMeleeFocusExpectedKillRegressionViolations,
            pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations:
                c.pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations,
            pureRangedJitNoMeleeFocusNonSingleActivationViolations:
                c.pureRangedJitNoMeleeFocusNonSingleActivationViolations,
            pureRangedJitNoMeleeFocusLocksByActorName: c.pureRangedJitNoMeleeFocusLocksByActorName,
            pureRangedJitNoMeleeFocusLocksByTargetName: c.pureRangedJitNoMeleeFocusLocksByTargetName,
            pureRangedJitNoMeleeFocusLocksByLap: c.pureRangedJitNoMeleeFocusLocksByLap,
            pureRangedJitNoMeleeFocusLocksBySlack: c.pureRangedJitNoMeleeFocusLocksBySlack,
            pureRangedJitNoMeleeFocusProposalsByActorName: c.pureRangedJitNoMeleeFocusProposalsByActorName,
            pureRangedJitNoMeleeFocusOverridesByActorName: c.pureRangedJitNoMeleeFocusOverridesByActorName,
            pureRangedJitNoMeleeFocusProposalsByTargetName: c.pureRangedJitNoMeleeFocusProposalsByTargetName,
            pureRangedJitNoMeleeFocusOverridesByTargetName: c.pureRangedJitNoMeleeFocusOverridesByTargetName,
            pureRangedJitNoMeleeFocusProposalsByLap: c.pureRangedJitNoMeleeFocusProposalsByLap,
            pureRangedJitNoMeleeFocusOverridesByLap: c.pureRangedJitNoMeleeFocusOverridesByLap,
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
    private auditTurnIdentity(unit: Unit): {
        side: "green" | "red";
        unitId: string;
        decisionOrdinal: number;
    } {
        const decisionOrdinal = this.counters.decisions - 1;
        if (decisionOrdinal < 0) {
            throw new Error("Search audit turn identity requires an active decision");
        }
        return {
            side: unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red",
            unitId: unit.getId(),
            decisionOrdinal,
        };
    }
    private search(
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        incumbent: GameAction[],
        seedBase: number,
        t0: number,
        prioritizeProductiveActions = false,
        productiveFallback?: IEnumeratedCandidate,
        prioritizeDominantFinish = false,
        aggressiveWaitComparison = false,
        prioritizeV08STargetPressure = false,
        prioritizeV08SUrgency = false,
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
        let bestIdx = 0;
        let bestChallengerIdx = -1;
        let hasPreferredV08STarget = false;
        let validationMeans: number[] | null = null;
        try {
            scoredCandidates = this.shortlistCandidates(
                unit,
                candidates,
                seedBase,
                deadlineAt,
                prioritizeProductiveActions,
                prioritizeDominantFinish,
                prioritizeV08STargetPressure,
                prioritizeV08SUrgency,
            );
            means = this.scoreCandidates(unit, scoredCandidates, seedBase, "turns", this.rollouts, deadlineAt);
            this.counters.scoredCandidatesTotal += scoredCandidates.length;
            const legalProductiveIndices = scoredCandidates
                .map((candidate, index) => ({ candidate, index }))
                .filter(({ candidate, index }) => means[index] !== -Infinity && isProductiveCandidate(candidate))
                .map(({ index }) => index);
            const legalDirectCombatIndices = legalProductiveIndices.filter((index) =>
                isDirectCombatCandidate(scoredCandidates[index]),
            );
            const legalAdvanceIndices = legalProductiveIndices.filter((index) =>
                isPureMoveCandidate(scoredCandidates[index]),
            );
            const preferredFinishingAttack = selectV08DirectCombatCandidate(
                legalDirectCombatIndices.map((index) => scoredCandidates[index]),
            );
            const preferredFinishingAttackIndex = preferredFinishingAttack
                ? scoredCandidates.indexOf(preferredFinishingAttack)
                : -1;
            const preferredV08STarget = selectV08STargetPressureCandidate(
                unit,
                this.deps.unitsHolder,
                legalDirectCombatIndices.map((index) => scoredCandidates[index]),
                this.deps.fightProperties.getCurrentLap(),
            );
            const preferredV08STargetIndex = preferredV08STarget ? scoredCandidates.indexOf(preferredV08STarget) : -1;
            hasPreferredV08STarget = preferredV08STargetIndex >= 0;
            const dominantFinishIndices =
                preferredFinishingAttackIndex >= 0
                    ? [preferredFinishingAttackIndex]
                    : legalAdvanceIndices.length
                      ? legalAdvanceIndices
                      : legalProductiveIndices;
            const selectionIndices =
                prioritizeV08STargetPressure && preferredV08STargetIndex >= 0
                    ? prioritizeV08SUrgency
                        ? [preferredV08STargetIndex]
                        : preferredV08STargetIndex === 0
                          ? [0]
                          : [0, preferredV08STargetIndex]
                    : prioritizeV08SUrgency
                      ? legalAdvanceIndices.length
                          ? legalAdvanceIndices
                          : [0]
                      : prioritizeDominantFinish && dominantFinishIndices.length
                        ? dominantFinishIndices
                        : prioritizeProductiveActions && legalProductiveIndices.length
                          ? legalProductiveIndices
                          : aggressiveWaitComparison
                            ? [0, ...legalProductiveIndices.filter((index) => index > 0)]
                            : scoredCandidates.map((_candidate, index) => index);
            bestIdx = selectionIndices[0];
            for (const index of selectionIndices) {
                if (
                    means[index] > means[bestIdx] ||
                    (prioritizeV08STargetPressure &&
                        !prioritizeV08SUrgency &&
                        bestIdx === 0 &&
                        index > 0 &&
                        means[index] !== -Infinity &&
                        means[index] === means[bestIdx]) ||
                    (aggressiveWaitComparison &&
                        bestIdx === 0 &&
                        index > 0 &&
                        means[index] !== -Infinity &&
                        means[index] === means[bestIdx])
                ) {
                    bestIdx = index;
                }
                if (index > 0 && (bestChallengerIdx === -1 || means[index] > means[bestChallengerIdx])) {
                    bestChallengerIdx = index;
                }
            }
            if (this.validationRollouts !== null && bestChallengerIdx !== -1) {
                const validationSeedBase = hashSimulationParts("search-validation-v1", seedBase);
                validationMeans = this.scoreCandidates(
                    unit,
                    [scoredCandidates[0], scoredCandidates[bestChallengerIdx]],
                    validationSeedBase,
                    "turns",
                    this.validationRollouts,
                    deadlineAt,
                );
            }
        } catch (error) {
            if (!(error instanceof SearchDecisionDeadlineExceeded)) throw error;
            this.counters.deadlineFallbacks += 1;
            const fallbackActions = productiveFallback?.actions ?? incumbent;
            if (isDominantFinishCombatReplacement(prioritizeDominantFinish, productiveFallback, incumbent)) {
                this.counters.dominantFinishCombatFallbacks += 1;
            }
            const fallbackKind =
                productiveFallback?.kind === "incumbent" ? incumbentKind : (productiveFallback?.kind ?? incumbentKind);
            const ms = performance.now() - t0;
            this.counters.msTotal += ms;
            if (this.auditPath && this.auditTurns) {
                this.turnRows.push(
                    JSON.stringify({
                        t: "turn",
                        seed: this.match.seed,
                        green: this.match.greenVersion,
                        red: this.match.redVersion,
                        ...this.auditTurnIdentity(unit),
                        lap: this.deps.fightProperties.getCurrentLap(),
                        unit: unit.getName(),
                        nc: candidates.length,
                        ns: 0,
                        inc: incumbentKind,
                        chosen: fallbackKind,
                        ov: Number(fallbackActions !== incumbent),
                        d: null,
                        ms: Math.round(ms * 10) / 10,
                        deadlineFallback: 1,
                        productiveFallback: Number(productiveFallback !== undefined),
                        ...(this.observeOnly
                            ? {
                                  observeOnly: 1,
                                  validationRollouts: this.validationRollouts,
                                  validationDelta: null,
                                  selectedKind: null,
                                  selectedSignature: null,
                              }
                            : {}),
                    }),
                );
            }
            return fallbackActions;
        }
        const incumbentIllegal = means[0] === -Infinity;
        if (incumbentIllegal) {
            this.counters.illegalIncumbent += 1;
        }
        // The GATE: trust the policy unless a challenger clearly beats it on mean rollout value. An
        // incumbent that is illegal in sim is always replaced by the best legal candidate.
        const wouldOverride =
            bestIdx !== 0 &&
            means[bestIdx] !== -Infinity &&
            (incumbentIllegal ||
                (prioritizeProductiveActions &&
                    isProductiveCandidate(scoredCandidates[bestIdx]) &&
                    !isProductiveCandidate(scoredCandidates[0])) ||
                (prioritizeV08STargetPressure && hasPreferredV08STarget) ||
                (prioritizeV08SUrgency && isProductiveCandidate(scoredCandidates[bestIdx])) ||
                (prioritizeDominantFinish && isProductiveCandidate(scoredCandidates[bestIdx])) ||
                (aggressiveWaitComparison &&
                    isProductiveCandidate(scoredCandidates[bestIdx]) &&
                    means[bestIdx] >= means[0]) ||
                means[bestIdx] - means[0] >= this.gate);
        const overridden = wouldOverride && !this.observeOnly;
        if (wouldOverride && this.observeOnly) {
            this.counters.shadowRecommendations += 1;
        }
        if (overridden) {
            this.counters.overrides += 1;
            if (isDominantFinishCombatReplacement(prioritizeDominantFinish, scoredCandidates[bestIdx], incumbent)) {
                this.counters.dominantFinishCombatOverrides += 1;
            }
            bump(this.counters.overridesByIncumbentKind, incumbentKind);
            bump(this.counters.overridesToKind, scoredCandidates[bestIdx].kind);
        }
        const selectedChallenger = bestChallengerIdx === -1 ? null : scoredCandidates[bestChallengerIdx];
        const discoveryDelta =
            bestChallengerIdx === -1 || means[0] === -Infinity || means[bestChallengerIdx] === -Infinity
                ? null
                : means[bestChallengerIdx] - means[0];
        const validationDelta =
            validationMeans === null || validationMeans[0] === -Infinity || validationMeans[1] === -Infinity
                ? null
                : validationMeans[1] - validationMeans[0];
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
                    ...this.auditTurnIdentity(unit),
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
                    ...(this.observeOnly
                        ? {
                              observeOnly: 1,
                              wouldOverride: wouldOverride ? 1 : 0,
                              selectedKind: selectedChallenger?.kind ?? null,
                              selectedSignature: selectedChallenger
                                  ? ilActionSignature(selectedChallenger.actions)
                                  : null,
                              discoveryDelta: discoveryDelta === null ? null : Number(discoveryDelta.toFixed(4)),
                              validationRollouts: this.validationRollouts,
                              validationDelta: validationDelta === null ? null : Number(validationDelta.toFixed(4)),
                          }
                        : {}),
                }),
            );
        }
        return overridden ? scoredCandidates[bestIdx].actions : incumbent;
    }
    /**
     * Return the first productive candidate that completes through the real action engine. The immediate-leaf
     * probe has no rollout horizon and no decision deadline; it exists specifically so a deadline/circuit fallback
     * is already known-valid. Candidate zero is reclassified for strict challenger semantics: any rejected
     * meaningful action invalidates the probe instead of inheriting the incumbent's permissive recovery behavior.
     */
    private firstEngineValidProductiveCandidate(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        prioritizeDominantFinish = false,
        prioritizeV08STargetPressure = false,
        prioritizeV08SUrgency = false,
    ): IEnumeratedCandidate | undefined {
        const productiveCandidates = candidates.filter(isProductiveCandidate);
        const directCombatCandidates = productiveCandidates.filter(isDirectCombatCandidate);
        const forceTierDirectCombatCandidates = directCombatCandidates.filter(isPositiveDirectCombatCandidate);
        const preferredV08STarget = selectV08STargetPressureCandidate(
            unit,
            this.deps.unitsHolder,
            forceTierDirectCombatCandidates,
            this.deps.fightProperties.getCurrentLap(),
        );
        const preferredFinishingAttack = selectV08DirectCombatCandidate(forceTierDirectCombatCandidates);
        const orderedDirectCombat = preferredFinishingAttack
            ? [
                  preferredFinishingAttack,
                  ...forceTierDirectCombatCandidates.filter((candidate) => candidate !== preferredFinishingAttack),
              ]
            : forceTierDirectCombatCandidates;
        const orderedV08SDirectCombat = preferredV08STarget
            ? [
                  preferredV08STarget,
                  ...forceTierDirectCombatCandidates.filter((candidate) => candidate !== preferredV08STarget),
              ]
            : forceTierDirectCombatCandidates;
        const orderedCandidates = prioritizeV08STargetPressure
            ? prioritizeV08SUrgency
                ? [
                      ...orderedV08SDirectCombat,
                      ...productiveCandidates.filter(
                          (candidate) => !isDirectCombatCandidate(candidate) && isPureMoveCandidate(candidate),
                      ),
                  ]
                : orderedV08SDirectCombat
            : prioritizeDominantFinish
              ? [
                    ...orderedDirectCombat,
                    ...productiveCandidates.filter(
                        (candidate) => !isDirectCombatCandidate(candidate) && isPureMoveCandidate(candidate),
                    ),
                    ...productiveCandidates.filter(
                        (candidate) => !isDirectCombatCandidate(candidate) && !isPureMoveCandidate(candidate),
                    ),
                ]
              : productiveCandidates;
        for (const candidate of orderedCandidates) {
            const strictCandidate: ISearchCandidate =
                candidate.kind === "incumbent"
                    ? {
                          kind: classifyActions(candidate.actions) as CandidateKind,
                          actions: candidate.actions,
                      }
                    : candidate;
            const [score] = this.scoreCandidates(unit, [strictCandidate], seedBase, "leaf", 1, null);
            if (score !== -Infinity) return candidate;
        }
        return undefined;
    }
    /** Engine-validate an already-ranked narrow intervention without opening a rollout comparison. */
    private firstEngineValidCandidate(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        deadlineAt: number | null = null,
    ): IEnumeratedCandidate | undefined {
        for (const candidate of candidates) {
            const strictCandidate: ISearchCandidate =
                candidate.kind === "incumbent"
                    ? {
                          kind: classifyActions(candidate.actions) as CandidateKind,
                          actions: candidate.actions,
                      }
                    : candidate;
            const [score] = this.scoreCandidates(unit, [strictCandidate], seedBase, "leaf", 1, deadlineAt);
            if (score !== -Infinity) return candidate;
        }
        return undefined;
    }
    /** Immediate-leaf pre-pass used only when SEARCH_SHORTLIST is explicitly configured. */
    private shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        deadlineAt: number | null,
        prioritizeProductiveActions = false,
        prioritizeDominantFinish = false,
        prioritizeV08STargetPressure = false,
        prioritizeV08SUrgency = false,
    ): readonly IEnumeratedCandidate[] {
        if (this.shortlist === null || candidates.length <= this.shortlist) {
            return candidates;
        }
        const scores = this.scoreCandidates(unit, candidates, seedBase, "leaf", 1, deadlineAt);
        const rankedChallengers = scores
            .map((score, index) => ({ score, index }))
            .slice(1)
            .filter(({ score }) => score !== -Infinity)
            .sort((left, right) => right.score - left.score || left.index - right.index);
        const directCombat = prioritizeDominantFinish
            ? rankedChallengers.filter(({ index }) => isPositiveDirectCombatCandidate(candidates[index]))
            : [];
        const v08sDirectCombat = prioritizeV08STargetPressure
            ? rankedChallengers.filter(({ index }) => isPositiveDirectCombatCandidate(candidates[index]))
            : [];
        const preferredV08STarget = selectV08STargetPressureCandidate(
            unit,
            this.deps.unitsHolder,
            v08sDirectCombat.map(({ index }) => candidates[index]),
            this.deps.fightProperties.getCurrentLap(),
        );
        if (preferredV08STarget) {
            v08sDirectCombat.sort((left, right) => {
                const leftPreferred = candidates[left.index] === preferredV08STarget;
                const rightPreferred = candidates[right.index] === preferredV08STarget;
                return leftPreferred === rightPreferred ? 0 : leftPreferred ? -1 : 1;
            });
        }
        const preferredFinishingAttack = selectV08DirectCombatCandidate(
            directCombat.map(({ index }) => candidates[index]),
        );
        if (preferredFinishingAttack) {
            directCombat.sort((left, right) => {
                const leftPreferred = candidates[left.index] === preferredFinishingAttack;
                const rightPreferred = candidates[right.index] === preferredFinishingAttack;
                return leftPreferred === rightPreferred ? 0 : leftPreferred ? -1 : 1;
            });
        }
        const advances = prioritizeDominantFinish
            ? rankedChallengers.filter(({ index }) => isPureMoveCandidate(candidates[index]))
            : [];
        const v08sAdvances = prioritizeV08SUrgency
            ? rankedChallengers.filter(({ index }) => isPureMoveCandidate(candidates[index]))
            : [];
        const productive =
            prioritizeProductiveActions || prioritizeDominantFinish
                ? rankedChallengers.filter(({ index }) => isProductiveCandidate(candidates[index]))
                : [];
        const ordered = v08sDirectCombat.length
            ? [
                  ...v08sDirectCombat,
                  ...rankedChallengers.filter(({ index }) => !isDirectCombatCandidate(candidates[index])),
              ]
            : v08sAdvances.length
              ? [...v08sAdvances, ...rankedChallengers.filter(({ index }) => !isPureMoveCandidate(candidates[index]))]
              : directCombat.length
                ? [
                      ...directCombat,
                      ...rankedChallengers.filter(({ index }) => !isDirectCombatCandidate(candidates[index])),
                  ]
                : advances.length
                  ? [...advances, ...rankedChallengers.filter(({ index }) => !isPureMoveCandidate(candidates[index]))]
                  : productive.length
                    ? [
                          ...productive,
                          ...rankedChallengers.filter(({ index }) => !isProductiveCandidate(candidates[index])),
                      ]
                    : rankedChallengers;
        const challengers = ordered.slice(0, this.shortlist - 1).map(({ index }) => candidates[index]);
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
                    ...this.auditTurnIdentity(unit),
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
            maxMoveShotComposites: this.maxMoveShotComposites,
            moveShotVersions: [...this.moveShotVersions],
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
                    ...this.auditTurnIdentity(unit),
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
                decisionOrigin: "rollout",
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
