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
import { GRID_SIZE } from "../../grid/grid_constants";
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

/**
 * V2 RAW block (Phase-B multi-cohort refit): the 41 v1 features + an ARMY-COMPOSITION / acting-unit
 * block. The v1 fit had 0.19% RANGE rows and every army majority-melee, so the training-support guard
 * had to zero the scorer outside that support (guard-zero = ranged parity, no ranged tempo policy).
 * The v2 oracle dataset is generated ACROSS cohorts (melee/mixed drafts + forced ranged/hybrid/pure
 * mirrors) and these dims carry the context the class-conditional fit needs.
 */
export const WAIT_FEATURE_NAMES_V2_RAW: readonly string[] = [
    ...WAIT_FEATURE_NAMES,
    "ownRangedFrac", // own living RANGE stacks / own living
    "enemyRangedFrac",
    "ownMeleeFrac", // own living MELEE|MELEE_MAGIC stacks / own living (the guard's majority-melee signal)
    "enemyMeleeFrac",
    "ownFlyerFrac",
    "enemyFlyerFrac",
    "actShotsNorm", // acting unit's remaining range shots, min(shots/10, 1) — 0 for non-ranged
    "actNearEnemyDist", // acting unit's normalized Chebyshev distance to its nearest living enemy
] as const;

/**
 * V2 DEPLOYED structure: raw block + a FULL isRanged-interaction copy of it (xR_<name> = isRanged *
 * <name>). A single linear model over this basis expresses "shared weights + a ranged-only delta
 * block" — i.e. separate per-class weight blocks for the RANGE class — while staying one dot product
 * in deployment. A fit that finds no ranged-specific structure simply leaves the xR_ block ~0.
 */
export const WAIT_FEATURE_NAMES_V2: readonly string[] = [
    ...WAIT_FEATURE_NAMES_V2_RAW,
    ...WAIT_FEATURE_NAMES_V2_RAW.map((name) => `xR_${name}`),
] as const;

/**
 * Incumbent action families available to the action-aware V3 research scorer. `mine` is the engine's
 * obstacle attack, while `idle` is an empty/end-turn-only decision. Unknown or auxiliary-only action
 * lists fail into `other` instead of being mistaken for an idle turn.
 */
export const WAIT_INCUMBENT_KINDS = [
    "shot",
    "melee",
    "spell",
    "area_throw",
    "move",
    "defend",
    "mine",
    "idle",
    "other",
] as const;

export type WaitIncumbentKind = (typeof WAIT_INCUMBENT_KINDS)[number];

/**
 * V3 keeps the complete deployed V2 basis as an immutable prefix, then appends incumbent-kind one-hots
 * and RANGE/caster interaction copies. V1/V2 feature order and weight widths therefore remain unchanged.
 */
export const WAIT_FEATURE_NAMES_V3: readonly string[] = [
    ...WAIT_FEATURE_NAMES_V2,
    ...WAIT_INCUMBENT_KINDS.map((kind) => `incKind_${kind}`),
    ...WAIT_INCUMBENT_KINDS.map((kind) => `xR_incKind_${kind}`),
    ...WAIT_INCUMBENT_KINDS.map((kind) => `xC_incKind_${kind}`),
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
export function canWaitOnHourglassMirror(
    unit: Unit,
    fightProperties: FightProperties,
    allUnits: ReadonlyMap<string, Unit>,
): boolean {
    const team = unit.getTeam();
    const id = unit.getId();
    return (
        (team === LOWER || team === UPPER) &&
        fightProperties.hasUnactedTeammate(team, id, allUnits) &&
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
    if (!isCharge || !canWaitOnHourglassMirror(unit, fightProperties, unitsHolder.getAllUnits())) {
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

const IS_RANGED_IDX = WAIT_FEATURE_NAMES.indexOf("isRanged");
const IS_CASTER_IDX = WAIT_FEATURE_NAMES.indexOf("isCaster");

/** V2 raw features = the exact v1 vector + the composition/acting-unit block (WAIT_FEATURE_NAMES_V2_RAW). */
export function extractWaitFeaturesV2Raw(
    unit: Unit,
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    incumbent: readonly GameAction[],
): number[] {
    const f = extractWaitFeatures(unit, unitsHolder, fightProperties, incumbent);
    let ownCnt = 0;
    let enemyCnt = 0;
    let ownRanged = 0;
    let enemyRanged = 0;
    let ownMelee = 0;
    let enemyMelee = 0;
    let ownFly = 0;
    let enemyFly = 0;
    const cell = unit.getBaseCell();
    let nearest = Infinity;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead()) {
            continue;
        }
        const own = u.getTeam() === unit.getTeam();
        const attackType = u.getAttackType();
        const isRangedStack = attackType === RANGE ? 1 : 0;
        const isMeleeStack = attackType === MELEE || attackType === MELEE_MAGIC ? 1 : 0;
        const isFlyer = u.canFly() ? 1 : 0;
        if (own) {
            ownCnt += 1;
            ownRanged += isRangedStack;
            ownMelee += isMeleeStack;
            ownFly += isFlyer;
        } else {
            enemyCnt += 1;
            enemyRanged += isRangedStack;
            enemyMelee += isMeleeStack;
            enemyFly += isFlyer;
            const other = u.getBaseCell();
            const d = Math.max(Math.abs(cell.x - other.x), Math.abs(cell.y - other.y));
            if (d < nearest) {
                nearest = d;
            }
        }
    }
    f.push(
        ownCnt ? ownRanged / ownCnt : 0,
        enemyCnt ? enemyRanged / enemyCnt : 0,
        ownCnt ? ownMelee / ownCnt : 0,
        enemyCnt ? enemyMelee / enemyCnt : 0,
        ownCnt ? ownFly / ownCnt : 0,
        enemyCnt ? enemyFly / enemyCnt : 0,
        unit.getAttackType() === RANGE ? Math.min(unit.getRangeShots() / 10, 1) : 0,
        Number.isFinite(nearest) ? nearest / (GRID_SIZE - 1) : 0,
    );
    return f;
}

/** Deployed V2 basis: raw + xR_ interaction copy (raw[i] * isRanged). Pure column arithmetic. */
export function expandWaitFeaturesV2(raw: readonly number[]): number[] {
    const isRanged = raw[IS_RANGED_IDX];
    const out = raw.slice();
    for (const x of raw) {
        out.push(isRanged ? x * isRanged : 0);
    }
    return out;
}

export function extractWaitFeaturesV2(
    unit: Unit,
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    incumbent: readonly GameAction[],
): number[] {
    return expandWaitFeaturesV2(extractWaitFeaturesV2Raw(unit, unitsHolder, fightProperties, incumbent));
}

export function normalizeWaitIncumbentKind(kind: string): WaitIncumbentKind {
    return (WAIT_INCUMBENT_KINDS as readonly string[]).includes(kind) ? (kind as WaitIncumbentKind) : "other";
}

/** Classify the final incumbent action list using the same vocabulary recorded by the Phase-B driver. */
export function waitIncumbentKindOf(actions: readonly GameAction[]): WaitIncumbentKind | "wait" {
    for (const action of actions) {
        switch (action.type) {
            case "range_attack":
                return "shot";
            case "melee_attack":
                return "melee";
            case "cast_spell":
                return "spell";
            case "area_throw_attack":
                return "area_throw";
            case "defend_turn":
                return "defend";
            case "obstacle_attack":
                return "mine";
            case "wait_turn":
                return "wait";
            default:
                break;
        }
    }
    if (actions.some((action) => action.type === "move_unit")) {
        return "move";
    }
    if (!actions.length || actions.every((action) => action.type === "end_turn")) {
        return "idle";
    }
    return "other";
}

/** Expand a Phase-B raw V2 row plus its recorded incumbent kind into the deployed V3 basis. */
export function expandWaitFeaturesV3(raw: readonly number[], incumbentKind: string): number[] {
    const v2 = expandWaitFeaturesV2(raw);
    const kind = normalizeWaitIncumbentKind(incumbentKind);
    const oneHot = WAIT_INCUMBENT_KINDS.map((candidate) => (candidate === kind ? 1 : 0));
    const isRanged = raw[IS_RANGED_IDX] ?? 0;
    const isCaster = raw[IS_CASTER_IDX] ?? 0;
    return [...v2, ...oneHot, ...oneHot.map((value) => value * isRanged), ...oneHot.map((value) => value * isCaster)];
}

export function extractWaitFeaturesV3(
    unit: Unit,
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    incumbent: readonly GameAction[],
): number[] {
    return expandWaitFeaturesV3(
        extractWaitFeaturesV2Raw(unit, unitsHolder, fightProperties, incumbent),
        waitIncumbentKindOf(incumbent),
    );
}

/**
 * The Gate-2 SHIP-verdict weights (2026-07-10): the logistic distillation of the Gate-1 wait oracle,
 * fit on 74,315 scored wait-eligible points from 5,000 LIVETWIN oracle games (seed 917001; held-out
 * AUC 0.719 split by game). Verified fresh-seed A/B vs plain v0.6 (weights as-is, no CEM pass):
 *   - LIVETWIN melee (pre-registered primary, 12,000 games, seed 927001): +18.82pp ± 0.42
 *   - LIVETWIN mixed 50/50 (2,000, seed 927002): +16.21pp ± 1.07
 *   - LIVETWIN random rosters (2,000, seed 927003): +8.78pp ± 1.13
 *   - transitivity anchor: (v0.6 + scorer) vs v0.4 81.10% vs plain v0.6's 73.17% (4,000 each, seed 957001)
 * v0.6/v0.6s remain env-gated (the anchor pattern); v0.7's resolver below uses this as its built-in
 * guarded default. To arm it for a v0.6 experiment:
 *   V07_WAIT_SCORER=on V07_WAIT_WEIGHTS=$(json of this constant) V07_WAIT_VERSIONS=v0.6
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

/** Parse {b, w[WAIT_FEATURE_NAMES_V2.length]} — malformed/absent ⇒ null. */
export function parseWaitWeightsV2(raw: string | undefined): IWaitWeights | null {
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
            m.w.length === WAIT_FEATURE_NAMES_V2.length &&
            m.w.every((x: unknown) => typeof x === "number" && Number.isFinite(x))
        ) {
            return { b: m.b, w: m.w as number[] };
        }
    } catch {
        /* malformed -> null */
    }
    return null;
}

/**
 * V07_WAIT_WEIGHTS_V2 — the Phase-B ENV CANDIDATE (baked defaults untouched):
 *   - absent or malformed  -> null: v0.7 keeps its baked v1 scorer path exactly as shipped;
 *   - ALL-ZERO             -> "disabled": the whole wait stage is off (parity arm for A/Bs);
 *   - valid non-zero       -> the v2 weights: v0.7 runs the V2 scorer (v2 features, NO training-support
 *     guard — the v2 fit's dataset covers ranged/mixed/hybrid cohorts, so the guard's OOD rationale
 *     does not apply; eligibility mirror + policy-wait keep + cast/profile guards upstream all remain).
 */
const v2Slot: { raw: string | undefined | null; resolved: IWaitWeights | "disabled" | null } = {
    raw: null,
    resolved: null,
};
export function v07WaitWeightsV2(): IWaitWeights | "disabled" | null {
    const raw = process.env.V07_WAIT_WEIGHTS_V2;
    if (raw !== v2Slot.raw) {
        v2Slot.raw = raw;
        const parsed = parseWaitWeightsV2(raw);
        v2Slot.resolved = parsed ? (parsed.b === 0 && parsed.w.every((x) => x === 0) ? "disabled" : parsed) : null;
    }
    return v2Slot.resolved;
}

/** Parse {b, w[WAIT_FEATURE_NAMES_V3.length]} -- malformed/absent => null. */
export function parseWaitWeightsV3(raw: string | undefined): IWaitWeights | null {
    if (!raw) {
        return null;
    }
    try {
        const model = JSON.parse(raw);
        if (
            model &&
            typeof model.b === "number" &&
            Number.isFinite(model.b) &&
            Array.isArray(model.w) &&
            model.w.length === WAIT_FEATURE_NAMES_V3.length &&
            model.w.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
        ) {
            return { b: model.b, w: model.w as number[] };
        }
    } catch {
        /* malformed -> null */
    }
    return null;
}

/**
 * Research-only V3 resolver. There is deliberately no built-in fallback candidate: absent, malformed,
 * or all-zero input leaves the existing V2/V1 resolution untouched.
 */
const v3Slot: { raw: string | undefined | null; weights: IWaitWeights | null } = {
    raw: null,
    weights: null,
};
export function v07WaitWeightsV3(): IWaitWeights | null {
    const raw = process.env.V07_WAIT_WEIGHTS_V3;
    if (raw !== v3Slot.raw) {
        v3Slot.raw = raw;
        const parsed = parseWaitWeightsV3(raw);
        v3Slot.weights = parsed && (parsed.b !== 0 || parsed.w.some((value) => value !== 0)) ? parsed : null;
    }
    return v3Slot.weights;
}

/**
 * Phase-B MULTI-COHORT V2 wait-scorer CANDIDATE (2026-07-11, env-gated -- NOT a default): 98 coefficients
 * over WAIT_FEATURE_NAMES_V2, fit by optimizer/fit_wait_v2.mjs (logistic, class-conditional structure B)
 * on 195,736 scored act-vs-wait oracle points from 8,000 games across five cohorts (LIVETWIN melee drafts
 * 2k / mixed FMR=0.5 drafts 2k / forced ranged_max_sniper3 mirrors 2k / hybrid mirrors 1k / pure_ranged
 * mirrors 1k; seeds 79021710..79025710; oracle leaf: committed 20d on drafts+hybrid, material on
 * ranged/pure). Held-out (by game): pooled AUC 0.730 (v1 distilled 0.605 unguarded / 0.646 guarded);
 * RANGE-class AUC 0.656 -- real ranking signal, but the positive-delta RANGED tail is NOT linearly
 * separable: payoff-optimal threshold tuning on train captures ~0% of the oracle's ranged delta mass
 * (melee-class capture ~18%), so on RANGE units this model fires ~never (safe guard-zero behavior).
 * Fresh-seed A/B, v0.7(this, no guard) vs v0.6 against v0.7(baked v1+guard) vs v0.6, 2k paired
 * side-swap games per cell (seeds 80001710..80007710):
 *   melee_coevo mirror 72.88+-1.00 (v1 70.75) | hybrid mirror 64.23+-1.08 (62.44) | ranged_max mirror
 *   51.45+-1.16 (50.35) | pure_ranged exact 50.00 both | drafted melee 67.59+-1.05 (66.45) | drafted
 *   mixed FMR=0.5 65.71+-1.08 (64.75) | drafted random 65.19+-1.09 (63.74)
 * = +1.0..+2.1pp over the shipped scorer on every non-pure cell, no regressions; the ranged>=55% Phase-B
 * gate was NOT met (oracle upper bounds: ranged_max 65.3+-1.1, pure 59.4+-1.8 -- reaching them needs
 * per-point rollouts or richer features, not a linear scorer). Arm via V07_WAIT_WEIGHTS_V2=$(json of
 * this constant); the v1 training-support guard is intentionally NOT applied to the V2 path.
 */
export const MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11: IWaitWeights = {
    b: -0.28654,
    w: [
        -0.6117, -0.40903, -0.49845, 0.13824, -0.222, -0.49043, -0.33095, -0.20116, -0.20786, 0.00604, -0.0554,
        -0.06144, -0.00054, 0.27718, 0.01869, 0.10265, 0.19313, 0.37745, 0.03194, -0.03483, 0.20187, 0.09252, -0.03555,
        0.05559, -0.07458, -0.42362, -0.19021, -0.05769, -0.09447, -0.12186, -0.07189, -0.10536, -0.01328, -0.17237,
        0.12758, -0.17307, -0.12728, 0.01591, 0.03291, 0.08218, -0.14184, -0.28908, -0.3518, -0.00386, 0.08602, 0.10551,
        0.12969, -0.02397, 0.06282, 0.17775, 0.11891, 0.2764, 0.14776, 0.15794, 0.11798, -0.03078, -0.03055, 0.07899,
        -0.27104, -0.14432, 0.12672, -0.00047, 0.11349, -0.08967, -0.11255, 0.16564, 0.19213, -0.03737, -0.0268,
        -0.13853, 0.0389, -0.25159, 0.1521, -0.14184, -0.1915, 0.16519, 0.13959, 0.10756, 0, -0.07189, 0, 0.05824,
        -0.12599, -0.26121, 0.01972, 0.07014, 0, 0.09075, 0, -0.14184, -0.21837, -0.1854, 0.11104, 0.08141, 0.1038,
        0.0858, -0.02397, -0.06551,
    ],
};

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

/**
 * TRAINING-SUPPORT GUARD (2026-07-10 ranged-mirror collapse fix). The distilled weights were fit on
 * 74,315 points from 5,000 LIVETWIN MELEE-DRAFT oracle games: MELEE 82.8% + MELEE_MAGIC 17.0% of the fit
 * set, RANGE 0.19% (141 rows, a single creature) and pure MAGIC 0 rows — and every army was majority
 * melee. Outside that support the linear model EXTRAPOLATES: in forced ranged mirrors 100% of RANGE-unit
 * decision points sit outside the fit set's [p1,p99] envelope and the scorer converts 41% of them to
 * waits (mechanism: losing the isMelee penalty, fmExposure saturating in shootouts, nearEnemyDistOurs
 * OOD) — but waiting dodges nothing in a shootout and cedes first-volley focus-fire, collapsing v0.7 vs
 * v0.6 to 25.0%/2.1% on ranged mirrors (measure_mirror_cohorts.ts) while the zero-scorer arm is exact
 * 50.00% parity. The guard restricts the scorer to its training support; out-of-support decisions fall
 * back to the incumbent (the v0.5/v0.6 strategic-hourglass rule already ran upstream — RANGE units were
 * deliberately excluded from it, V05_HG_RANGED lineage).
 *
 * `V07_WAIT_GUARD` modes: "support" (default) = melee-attack-type acting unit AND majority
 * melee-attack-type own army; "class" = the unit-class clause only; "off" = unguarded pre-fix behavior
 * (for experiments — e.g. a future refit whose dataset actually covers ranged/mixed armies).
 */
export type WaitGuardMode = "support" | "class" | "off";

export function waitGuardMode(): WaitGuardMode {
    const raw = process.env.V07_WAIT_GUARD;
    return raw === "off" || raw === "class" ? raw : "support";
}

const isMeleeAttackType = (unit: Unit): boolean => {
    const attackType = unit.getAttackType();
    return attackType === MELEE || attackType === MELEE_MAGIC;
};

/** Is this decision point inside the distilled weights' training support (see guard doc above)? */
export function waitScorerInSupport(
    unit: Unit,
    unitsHolder: UnitsHolder,
    mode: WaitGuardMode = waitGuardMode(),
): boolean {
    if (mode === "off") {
        return true;
    }
    if (!isMeleeAttackType(unit)) {
        return false;
    }
    if (mode === "class") {
        return true;
    }
    let own = 0;
    let melee = 0;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead() || u.getTeam() !== unit.getTeam()) {
            continue;
        }
        own += 1;
        if (isMeleeAttackType(u)) {
            melee += 1;
        }
    }
    return melee * 2 > own;
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
 * the oracle's mirror predicate, the incumbent is not already a wait, the point is inside the
 * training-support guard, and z > 0 — in which case the turn becomes a lone hourglass wait (exactly the
 * oracle's override action).
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
    if (!canWaitOnHourglassMirror(unit, fightProperties, context.unitsHolder.getAllUnits())) {
        return incumbent; // not a wait-eligible decision point
    }
    if (!waitScorerInSupport(unit, context.unitsHolder)) {
        return incumbent; // outside the fit's training support — keep the incumbent hourglass behavior
    }
    const features = extractWaitFeatures(unit, context.unitsHolder, fightProperties, incumbent);
    const score = waitScore(weights, features);
    if (!Number.isFinite(score) || score <= 0) {
        return incumbent;
    }
    return [{ type: "wait_turn", unitId: unit.getId() }];
}

/**
 * The V2 scorer stage (env candidate, wired in versions/v0_7.ts when V07_WAIT_WEIGHTS_V2 resolves to
 * weights). Identical eligibility contract to the v1 stage EXCEPT the training-support guard: v2's fit
 * set spans melee/mixed drafts and forced ranged/hybrid/pure mirrors, so RANGE-unit and ranged-army
 * decisions are inside support and the class-conditional weights arbitrate them directly.
 */
export function applyWaitScorerWeightsV2(
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
    if (!canWaitOnHourglassMirror(unit, fightProperties, context.unitsHolder.getAllUnits())) {
        return incumbent; // not a wait-eligible decision point
    }
    const features = extractWaitFeaturesV2(unit, context.unitsHolder, fightProperties, incumbent);
    const score = waitScore(weights, features);
    if (!Number.isFinite(score) || score <= 0) {
        return incumbent;
    }
    return [{ type: "wait_turn", unitId: unit.getId() }];
}

const WAIT_V3_PROTECTED_KINDS: ReadonlySet<string> = new Set(["wait", "melee", "spell", "area_throw"]);

/** Whether the initial RANGE-only V3 runtime is allowed to replace this incumbent action family. */
export function waitV3CanReplaceIncumbentKind(kind: string): boolean {
    return !WAIT_V3_PROTECTED_KINDS.has(kind) && !WAIT_V3_PROTECTED_KINDS.has(normalizeWaitIncumbentKind(kind));
}

/**
 * Action-aware V3 research stage. Its initial deployment domain is deliberately RANGE-only; mage rows
 * have not earned a runtime gate yet. Committed casts, melee attacks, and Area Throw actions remain
 * protected even when the acting stack is ranged.
 */
export function applyWaitScorerWeightsV3(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    weights: IWaitWeights | null,
): GameAction[] {
    const fightProperties = context.fightProperties;
    if (!weights || !fightProperties || unit.getAttackType() !== RANGE) {
        return incumbent;
    }
    if (incumbent.some((action) => action.type === "wait_turn")) {
        return incumbent;
    }
    if (!waitV3CanReplaceIncumbentKind(waitIncumbentKindOf(incumbent))) {
        return incumbent;
    }
    if (!canWaitOnHourglassMirror(unit, fightProperties, context.unitsHolder.getAllUnits())) {
        return incumbent;
    }
    const features = extractWaitFeaturesV3(unit, context.unitsHolder, fightProperties, incumbent);
    const score = waitScore(weights, features);
    if (!Number.isFinite(score) || score <= 0) {
        return incumbent;
    }
    return [{ type: "wait_turn", unitId: unit.getId() }];
}
