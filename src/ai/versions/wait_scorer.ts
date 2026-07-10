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

import type { GameAction } from "../../engine/actions";
import type { FightProperties } from "../../fights/fight_properties";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { extractValueFeatures, VALUE_FEATURE_NAMES } from "../../simulation/value_features";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { IDecisionContext } from "../ai_strategy";

/**
 * Q2 Gate-2 — the ANCHORED WAIT-SCORER: the shippable distillation of the Gate-1 act-vs-wait lap-rollout
 * oracle (+30.2pp ± 0.36 upper bound, LIVETWIN 12k, seed 907101).
 *
 * Gate-1's key nuance: the oracle's mean wait-minus-act delta ≈ 0 — its value is TAIL DISCRIMINATION
 * (waiting is only better at a selective minority of points), so the distilled policy must be a
 * per-decision classifier, not a blanket wait-more rule (pre-refuted at −5pp historically).
 *
 * WHAT IT DOES (mirroring the oracle's domain exactly): at the END of v0.6's decideTurn, when the chosen
 * turn is NOT already a wait and the engine would accept a hourglass wait for the acting unit, score the
 * decision point with a linear model over WAIT_FEATURE_NAMES and REPLACE the action with a wait iff
 * z = b + w·f > 0. Policy waits (the incumbent strategic-hourglass rule's own output) are always kept —
 * re-litigating them is B2's job, and Gate-1 collected no oracle labels for that direction.
 *
 * ANCHOR PATTERN (caster_router.ts lineage): `V07_WAIT_SCORER=on` is required, weights come from
 * `V07_WAIT_WEIGHTS={"b":...,"w":[...]}` and version scoping from `V07_WAIT_VERSIONS` (default "v0.6s",
 * the A/B alias — `run_tournament v0.6s v0.6` measures exactly "v0.6 + wait-scorer vs plain v0.6").
 * Gate off, versions mismatch, absent/malformed/ALL-ZERO weights ⇒ the exact incumbent array reference is
 * returned: byte-identical incumbent hourglass behavior. The feature vector carries the incumbent rule's
 * counterfactual verdict (`incRuleWait`) so a freeze-CEM pass over only these dims can retreat to the
 * anchor (drive `b` negative and lean on `incRuleWait`).
 */

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const MAGIC = PBTypes.AttackVals.MAGIC;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

/** The incumbent v0.5 strategic-hourglass threshold (v0_5.ts hourglassByPolicy) — a FIXED constant here so
 * the `incRuleWait` feature means the same thing in the dataset, the fit, and the deployed scorer. */
const INCUMBENT_FM_THRESHOLD = 0.67;

/** Count normalizer for stack counts (armies field ≤ ~8 stacks; clamped so the feature stays in [0,1]). */
const STACKS_NORM = 8;

export const WAIT_FEATURE_NAMES: readonly string[] = [
    // --- the 20 LiveTwin value features (value_features.ts), acting team's perspective ---------------
    ...VALUE_FEATURE_NAMES,
    // --- tempo / hourglass context (Q2 Gate-2) -------------------------------------------------------
    "fmExposure", // v0.5 hourglass's measure: living enemies with !hasAlreadyMadeTurn / living enemies
    "ownYetCnt", // own stacks yet to act this lap (!madeTurn && !alreadyHourglass), /8 clamped
    "enemyYetCnt", // enemy stacks yet to act this lap, /8 clamped
    "ownYetFrac", // own yet-to-act / own alive (per-side fraction)
    "enemyYetFrac", // enemy yet-to-act / enemy alive
    "posInLap", // alreadyMadeTurnSize / total living stacks — how deep into the lap we are
    "lapCapped", // min(lap, 8)/8 — raw lap number (lapNorm above is min(lap/10,1); this is finer early)
    "initAdvMax", // norm(max own yet-to-act speed, max enemy yet-to-act speed) — who wins the next pick
    "initAdvMean", // norm(mean own yet-to-act speed, mean enemy yet-to-act speed) — remaining-queue quality
    "isMelee", // acting unit class flags (MELEE or MELEE_MAGIC)
    "isRanged", // RANGE
    "isCaster", // MAGIC or MELEE_MAGIC
    "isFlyer", // canFly
    "aliveOwn", // own living stacks /8 clamped
    "aliveEnemy", // enemy living stacks /8 clamped
    "narrowLaps", // board-narrowing progress: lapsNarrowed / lapsTillNarrowing, clamped to [0,1]
    "narrowCyclePos", // position inside the current narrowing cycle: ((lap-1) mod L)/L
    "incRuleWait", // the INCUMBENCY feature: 1 if v0.5's hourglass rule would wait on THIS decision
    // --- fixed crosses (kept linear-in-features so the fit stays anchored dims) ----------------------
    "xFmLap", // fmExposure * lapCapped
    "xEnemyYetMelee", // enemyYetFrac * isMelee
    "xEnemyYetRanged", // enemyYetFrac * isRanged
] as const;

export interface IWaitWeights {
    b: number;
    w: number[];
}

/**
 * Driver-side mirror of GameActionEngine.canWaitOnHourglass — the SAME predicate the Gate-1 oracle used
 * to define wait-eligibility (search_driver.ts), so the scorer's applicability domain matches the
 * distribution its training labels came from. Every scored wait the engine would then reject anyway is
 * the alreadyHourglass desync seam (ranked-skip-rejections); Gate-1 measured 0 across 14k games.
 */
export function canWaitOnHourglassMirror(unit: Unit, fightProperties: FightProperties): boolean {
    const team = unit.getTeam();
    const id = unit.getId();
    return (
        (team === LOWER || team === UPPER) &&
        fightProperties.getTeamUnitsAlive(team) > 1 &&
        !fightProperties.hourglassIncludes(id) &&
        !fightProperties.hasAlreadyMadeTurn(id) &&
        !fightProperties.hasAlreadyHourglass(id)
    );
}

/**
 * The incumbent v0.5 strategic-hourglass rule's counterfactual verdict on `incumbent` (default config:
 * V05_HOURGLASS on, ranged excluded, fm ≥ 0.67): would it wait here? On most scorer-visible points this
 * is 0 by construction (the rule already ran upstream and converted its waits), but post-hourglass stages
 * (takeAdjacentAttack, the rider-EV router) can re-introduce charge shapes the rule never saw — and the
 * dim gives freeze-CEM the anchor-retreat handle.
 */
export function incumbentRuleWaits(
    unit: Unit,
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    incumbent: readonly GameAction[],
): boolean {
    if (unit.getAttackType() === RANGE) {
        return false; // hourglass is a melee-unit tool in the incumbent rule (V05_HG_RANGED default)
    }
    const isCharge = incumbent.some((a) => a.type === "melee_attack" && Array.isArray(a.path) && a.path.length > 0);
    if (!isCharge || !canWaitOnHourglassMirror(unit, fightProperties)) {
        return false;
    }
    return fmExposureOf(unit, unitsHolder, fightProperties) >= INCUMBENT_FM_THRESHOLD;
}

/** v0.5's fmExposure: fraction of LIVING enemies that haven't made their turn this lap (hourglassed
 * enemies count as yet-to-act — exactly v0_5.ts's definition, which the 0.67 threshold was tuned on). */
function fmExposureOf(unit: Unit, unitsHolder: UnitsHolder, fightProperties: FightProperties): number {
    let enemies = 0;
    let yetToAct = 0;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead() || u.getTeam() === unit.getTeam()) {
            continue;
        }
        enemies += 1;
        if (!fightProperties.hasAlreadyMadeTurn(u.getId())) {
            yetToAct += 1;
        }
    }
    return enemies ? yetToAct / enemies : 0;
}

/**
 * The Gate-2 per-decision feature vector (aligned with WAIT_FEATURE_NAMES). Pure — no RNG, no state
 * mutation — so the dataset dump (search_driver Q2_DATASET), the fit (optimizer/fit_wait.mjs) and the
 * deployed scorer all see the identical featurization.
 */
export function extractWaitFeatures(
    unit: Unit,
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    incumbent: readonly GameAction[],
): number[] {
    const f = extractValueFeatures(unitsHolder, fightProperties, unit.getTeam());

    let ownAlive = 0;
    let enemyAlive = 0;
    let ownYet = 0;
    let enemyYet = 0;
    let ownYetSpeedSum = 0;
    let enemyYetSpeedSum = 0;
    let ownYetSpeedMax = 0;
    let enemyYetSpeedMax = 0;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead()) {
            continue;
        }
        const own = u.getTeam() === unit.getTeam();
        const yet = !fightProperties.hasAlreadyMadeTurn(u.getId()) && !fightProperties.hasAlreadyHourglass(u.getId());
        if (own) {
            ownAlive += 1;
        } else {
            enemyAlive += 1;
        }
        if (!yet) {
            continue;
        }
        const speed = u.getSpeed();
        if (own) {
            ownYet += 1;
            ownYetSpeedSum += speed;
            ownYetSpeedMax = Math.max(ownYetSpeedMax, speed);
        } else {
            enemyYet += 1;
            enemyYetSpeedSum += speed;
            enemyYetSpeedMax = Math.max(enemyYetSpeedMax, speed);
        }
    }
    const norm = (a: number, b: number): number => (a - b) / (a + b + 1);
    const clampCnt = (n: number): number => Math.min(n / STACKS_NORM, 1);
    const lap = fightProperties.getCurrentLap();
    const lapsTillNarrowing = Math.max(1, fightProperties.getNumberOfLapsTillNarrowing());
    const attackType = unit.getAttackType();
    const fm = fmExposureOf(unit, unitsHolder, fightProperties);
    const enemyYetFrac = enemyAlive ? enemyYet / enemyAlive : 0;
    const lapCapped = Math.min(lap, 8) / 8;
    const isMelee = attackType === MELEE || attackType === MELEE_MAGIC ? 1 : 0;
    const isRanged = attackType === RANGE ? 1 : 0;

    f.push(
        fm,
        clampCnt(ownYet),
        clampCnt(enemyYet),
        ownAlive ? ownYet / ownAlive : 0,
        enemyYetFrac,
        ownAlive + enemyAlive > 0 ? fightProperties.getAlreadyMadeTurnSize() / (ownAlive + enemyAlive) : 0,
        lapCapped,
        norm(ownYetSpeedMax, enemyYetSpeedMax),
        norm(ownYet ? ownYetSpeedSum / ownYet : 0, enemyYet ? enemyYetSpeedSum / enemyYet : 0),
        isMelee,
        isRanged,
        attackType === MAGIC || attackType === MELEE_MAGIC ? 1 : 0,
        unit.canFly() ? 1 : 0,
        clampCnt(ownAlive),
        clampCnt(enemyAlive),
        Math.min(fightProperties.getLapsNarrowed() / lapsTillNarrowing, 1),
        ((lap - 1) % lapsTillNarrowing) / lapsTillNarrowing,
        incumbentRuleWaits(unit, unitsHolder, fightProperties, incumbent) ? 1 : 0,
        fm * lapCapped,
        enemyYetFrac * isMelee,
        enemyYetFrac * isRanged,
    );
    return f;
}

/**
 * The Gate-2 SHIP-verdict weights (2026-07-10): the logistic distillation of the Gate-1 wait oracle,
 * fit on 74,315 scored wait-eligible points from 5,000 LIVETWIN oracle games (seed 917001; held-out
 * AUC 0.719 split by game). Verified fresh-seed A/B vs plain v0.6 (weights as-is, no CEM pass):
 *   - LIVETWIN melee (pre-registered primary, 12,000 games, seed 927001): +18.82pp ± 0.42
 *   - LIVETWIN mixed 50/50 (2,000, seed 927002): +16.21pp ± 1.07
 *   - LIVETWIN random rosters (2,000, seed 927003): +8.78pp ± 1.13
 *   - transitivity anchor: (v0.6 + scorer) vs v0.4 81.10% vs plain v0.6's 73.17% (4,000 each, seed 957001)
 * NOT wired as a default — the scorer stays env-gated OFF (the anchor pattern). To arm it:
 *   V07_WAIT_SCORER=on V07_WAIT_WEIGHTS=$(json of this constant) [V07_WAIT_VERSIONS=v0.6]
 * Committed so a future bake/freeze-CEM starts from the verified artifact instead of a scratchpad file.
 */
export const DISTILLED_WAIT_WEIGHTS_2026_07_10: IWaitWeights = {
    b: -0.61904,
    w: [
        -1.05018, -1.70154, -0.00408, -0.02473, 0.05777, -1.13469, -0.40734, -0.06348, -0.03023, -0.32258, -0.44617,
        -0.12358, 0, -0.32372, 0.73015, -0.1288, 0.73438, 0.62633, -0.40413, -0.19118, 0.92768, 0.96246, 0.05013,
        -0.02312, -0.09702, 0.05079, -0.03375, 0.56183, -0.45781, -0.35882, -0.19441, 0.00517, 0.01446, -0.47843,
        0.76528, -0.06198, 0.1818, -0.08579, -0.43219, -0.03901, -0.05801,
    ],
};

/** Parse {b, w[WAIT_FEATURE_NAMES.length]} — malformed/absent ⇒ null (anchor: scorer never fires). */
export function parseWaitWeights(raw: string | undefined): IWaitWeights | null {
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
            m.w.length === WAIT_FEATURE_NAMES.length &&
            m.w.every((x: unknown) => typeof x === "number" && Number.isFinite(x))
        ) {
            return { b: m.b, w: m.w as number[] };
        }
    } catch {
        /* malformed -> anchor */
    }
    return null;
}

/** Memoized env reads (one slot per weights env var — decideTurn runs per unit-turn). */
const weightsCache: Record<string, { raw: string | undefined | null; weights: IWaitWeights | null }> = {};
function loadWaitWeightsFrom(envVar: string): IWaitWeights | null {
    const slot = (weightsCache[envVar] ??= { raw: null, weights: null });
    const raw = process.env[envVar];
    if (raw !== slot.raw) {
        slot.raw = raw;
        const parsed = parseWaitWeights(raw);
        // ALL-ZERO weights are the explicit anchor: byte-identical incumbent hourglass behavior.
        slot.weights = parsed && (parsed.b !== 0 || parsed.w.some((x) => x !== 0)) ? parsed : null;
    }
    return slot.weights;
}

/**
 * v0.7 BAKED weight resolution (S1 sign-off): the committed DISTILLED_WAIT_WEIGHTS_2026_07_10 are the
 * BUILT-IN DEFAULT — no V07_WAIT_SCORER gate, no version scope: v0.7's scorer is always armed. An explicit
 * V07_WAIT_WEIGHTS env still overrides for experiments, and the scorer anchor is preserved: an ALL-ZERO
 * override resolves to null, disabling this stage while retaining v0.7's other baked policy stages. An absent
 * or MALFORMED env falls back to the committed defaults — a bad env can never crash or silently de-bake live
 * play (loadV06Weights lineage). v0.6/v0.6s keep the env-gated waitWeightsForVersion path below untouched.
 */
const bakedSlot: { raw: string | undefined | null; weights: IWaitWeights | null } = {
    raw: null,
    weights: DISTILLED_WAIT_WEIGHTS_2026_07_10,
};
export function v07BakedWaitWeights(): IWaitWeights | null {
    const raw = process.env.V07_WAIT_WEIGHTS;
    if (raw !== bakedSlot.raw) {
        bakedSlot.raw = raw;
        const parsed = parseWaitWeights(raw);
        if (!parsed) {
            bakedSlot.weights = DISTILLED_WAIT_WEIGHTS_2026_07_10;
        } else if (parsed.b === 0 && parsed.w.every((x) => x === 0)) {
            bakedSlot.weights = null;
        } else {
            bakedSlot.weights = parsed;
        }
    }
    return bakedSlot.weights;
}

/** Is `version` listed in the comma-separated env var (or its fallback default)? */
function inVersionScope(version: string, envVar: string, fallback?: string): boolean {
    const raw = process.env[envVar] ?? fallback;
    if (!raw) {
        return false;
    }
    return raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .includes(version);
}

/**
 * Version-scoped weight resolution. `V07_WAIT_SCORER=on` is required; then a version listed in
 * `V07_WAIT_VERSIONS` (default "v0.6s") uses `V07_WAIT_WEIGHTS`, and a version listed in
 * `V07_WAIT_VERSIONS_B` (default: NONE — the second scope is inert unless explicitly set) uses
 * `V07_WAIT_WEIGHTS_B`. The primary scope wins on overlap. The B scope exists for weight-vs-weight
 * head-to-heads (Wave-5 headroom: CEM candidate on v0.6s vs the distilled incumbent on v0.6 in ONE
 * paired tournament) — with a single global weights var two seats could never carry different fits.
 */
function waitWeightsForVersion(version: string): IWaitWeights | null {
    const gate = process.env.V07_WAIT_SCORER;
    if (gate !== "on" && gate !== "1") {
        return null;
    }
    if (inVersionScope(version, "V07_WAIT_VERSIONS", "v0.6s")) {
        return loadWaitWeightsFrom("V07_WAIT_WEIGHTS");
    }
    if (inVersionScope(version, "V07_WAIT_VERSIONS_B")) {
        return loadWaitWeightsFrom("V07_WAIT_WEIGHTS_B");
    }
    return null;
}

/** z = b + w·f for a decision point (exported for tests and the fit's sanity cross-check). */
export function waitScore(weights: IWaitWeights, features: readonly number[]): number {
    let z = weights.b;
    for (let i = 0; i < features.length; i += 1) {
        z += weights.w[i] * features[i];
    }
    return z;
}

/**
 * The deployed Gate-2 scorer stage (wired at the end of StrategyV0_6.decideTurn). Returns the exact
 * `incumbent` reference unless the gate is on, weights are non-anchor, the point is wait-eligible under
 * the oracle's mirror predicate, the incumbent is not already a wait, and z > 0 — in which case the turn
 * becomes a lone hourglass wait (exactly the oracle's override action).
 */
export function applyWaitScorer(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    version: string,
): GameAction[] {
    return applyWaitScorerWeights(unit, context, incumbent, waitWeightsForVersion(version));
}

/**
 * The scorer stage with EXPLICIT weights — the shared core of the env-gated stage above and v0.7's baked
 * stage (versions/v0_7.ts finalizeDecision with v07BakedWaitWeights()). `weights` null is the anchor: the
 * exact `incumbent` reference is returned, byte-identical incumbent hourglass behavior.
 */
export function applyWaitScorerWeights(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    weights: IWaitWeights | null,
): GameAction[] {
    const fightProperties = context.fightProperties;
    if (!weights || !fightProperties) {
        return incumbent;
    }
    if (incumbent.some((a) => a.type === "wait_turn")) {
        return incumbent; // keep policy waits — the oracle's degenerate {wait, wait} handling
    }
    if (!canWaitOnHourglassMirror(unit, fightProperties)) {
        return incumbent; // not a wait-eligible decision point
    }
    const features = extractWaitFeatures(unit, context.unitsHolder, fightProperties, incumbent);
    const score = waitScore(weights, features);
    if (!Number.isFinite(score) || score <= 0) {
        return incumbent;
    }
    return [{ type: "wait_turn", unitId: unit.getId() }];
}
