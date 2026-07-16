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
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../ai_strategy";
import {
    enumerateCandidates,
    type ICandidateSet,
    type IEnumeratedCandidate,
    type IEnumerateOptions,
} from "../candidates";

type CandidateEnumerator = (
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options?: IEnumerateOptions,
) => ICandidateSet;

export type CasterRouterSpell =
    "resurrection" | "windflow" | "castling" | "wildregen" | "summonwolves" | "reswait" | "reswiden";

export interface ICasterRouterPolicy {
    readonly spells: readonly CasterRouterSpell[];
    readonly resurrectionPreemptsCommitted: boolean;
}

/**
 * The four spells of the original 2026-07-10 M1 experiment. `V06_CASTER_ROUTER=on` with no explicit
 * V06_CASTER_SPELLS scope keeps routing EXACTLY these, so pre-W17 experiment runs stay reproducible.
 * The W17 tokens ("summonwolves" gap #2, "reswait"/"reswiden" gap #3) activate only when explicitly listed.
 */
const LEGACY_CASTER_ROUTER_SPELLS = ["resurrection", "windflow", "castling", "wildregen"] as const;

const KNOWN_CASTER_ROUTER_SPELLS = [...LEGACY_CASTER_ROUTER_SPELLS, "summonwolves", "reswait", "reswiden"] as const;

/** v0.7's measured M1 salvage: only Resurrection + Wind Flow, with Resurrection pre-emption disabled. */
export const V07_CASTER_ROUTER_POLICY = Object.freeze({
    spells: Object.freeze(["resurrection", "windflow"] as const),
    resurrectionPreemptsCommitted: false,
}) satisfies ICasterRouterPolicy;

const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const MAGIC = PBTypes.AttackVals.MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LOWER = PBTypes.TeamVals.LOWER;

const isSpell = (candidate: IEnumeratedCandidate, spellName: string): boolean =>
    candidate.kind === "spell" && candidate.spellName === spellName;

/** A deliberate incumbent action that a speculative utility cast must not replace. */
function incumbentCommitsTurn(actions: readonly GameAction[]): boolean {
    return actions.some(
        (action) =>
            action.type === "wait_turn" ||
            action.type === "defend_turn" ||
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "obstacle_attack" ||
            action.type === "cast_spell",
    );
}

/**
 * W17 gap #3 ("reswait"/"reswiden"): the widened Resurrection trigger treats a WAIT incumbent as
 * replaceable. The W15 EV census (kit_ev_87020710, 200 priced games) found the shipped non-pre-empting
 * trigger leaves 45 of 68 legal Resurrection turns uncast at a forgone +4.87pp±3.61 each; the
 * wait-incumbent cell of that residual was the cleanest (n=15, +3.69pp mean, 86.7% positive).
 * "reswait" adds ONLY this wait-replacement (full-reserve bar); "reswiden" additionally halves the
 * reserve bar (see WIDENED_RESERVE_DISCOUNT), so the two mechanisms ablate independently. Real combat
 * actions (attack/defend/cast) stay committed under both — melee pre-emption re-litigates the
 * measured-off V06_RES_PREEMPT experiment and is deliberately NOT part of the widening.
 */
function incumbentCommitsTurnAgainstResurrection(actions: readonly GameAction[], widened: boolean): boolean {
    return actions.some(
        (action) =>
            (!widened && action.type === "wait_turn") ||
            action.type === "defend_turn" ||
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "obstacle_attack" ||
            action.type === "cast_spell",
    );
}

/** Effective HP this cast would restore, matching AttackHandler.applyResurrection's power cap. */
function resurrectionRecovery(caster: Unit, target: Unit): number {
    const holyCross = caster.getBuff("Holy Cross");
    const powerFactor = holyCross ? 1 + holyCross.getPower() / 100 : 1;
    const castPower = Math.floor(caster.getCumulativeMaxHp() * powerFactor);
    const targetMissingHp =
        target.getAmountDied() * target.getMaxHp() + Math.max(0, target.getMaxHp() - target.getHp());
    return Math.min(castPower, targetMissingHp);
}

/** HP the Angel's existing on-death passive would restore if its shared charge is kept. */
function resurrectionPassiveReserve(caster: Unit): number {
    const totalCreatures = caster.getAmountAlive() + caster.getAmountDied();
    return Math.floor(totalCreatures / 2) * caster.getMaxHp();
}

/**
 * W17 gap #3 ("reswiden"): the shipped surplus test prices the kept charge at the passive's FULL payout,
 * but that payout is only realized when the entire Angel stack is later destroyed while the fight still
 * matters — half the time the fight ends first and the charge expires unused. The widened trigger
 * probability-weights the reserve at 50%, lowering the damaged-ally bar the census showed skipping
 * EV-positive casts (every non-committal omission in the residual, 6/6, had failed the full-reserve bar).
 */
const WIDENED_RESERVE_DISCOUNT = 0.5;

/**
 * Resurrection is the only routed spell that a policy may allow to pre-empt an incumbent combat action.
 * It does so only when the recoverable allied HP strictly exceeds the Angel's own auto-resurrection reserve
 * (discounted under the widened W17 trigger; see WIDENED_RESERVE_DISCOUNT).
 * Candidate F4 explicitly marks whether the cast burns that shared charge; a future non-burning source
 * therefore has zero opportunity cost without another named-unit rule here.
 */
function bestResurrection(
    caster: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
    reserveWeight: number,
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    let bestSurplus = 0;
    for (const candidate of candidates) {
        if (!isSpell(candidate, "Resurrection") || !candidate.targetId) {
            continue;
        }
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target) {
            continue;
        }
        const opportunityCost = candidate.features.burnsResurrectionCharge
            ? Math.ceil(resurrectionPassiveReserve(caster) * reserveWeight)
            : 0;
        const surplus = resurrectionRecovery(caster, target) - opportunityCost;
        if (surplus > bestSurplus) {
            best = candidate;
            bestSurplus = surplus;
        }
    }
    return best;
}

/**
 * W17 gap #2 ("summonwolves"): the incumbents a routed Summon Wolves cast may replace. The W15 EV census
 * priced Satyr's omitted casts at +7.49pp±4.36 each (74% positive, n=74) and EVERY omission chose another
 * self-buff instead (Courage x41 at +9.02pp, Helping Hand x33 at +5.59pp) — v0.2's decideSpellTurn values
 * a mass buff above bodies-on-the-board unless our ranged army out-guns theirs. So: another cast (that is
 * not itself a summon) is replaceable, a non-committal move/idle is replaceable, and every real combat
 * action, wait, or defend is kept — the census saw zero omissions with those incumbents.
 */
function summonWolvesMayReplace(actions: readonly GameAction[]): boolean {
    const cast = actions.find((action) => action.type === "cast_spell");
    if (cast && cast.type === "cast_spell") {
        return cast.spellName !== "Summon Wolves";
    }
    return !incumbentCommitsTurn(actions);
}

/** Approximate how much flying mobility is exposed to Wind Flow's four-step reduction. */
function flyingPressure(unit: Unit): number {
    return Math.max(1, unit.getAmountAlive()) * Math.max(1, unit.getAttackDamageMax()) * Math.max(1, unit.getSteps());
}

function shouldCastWindFlow(caster: Unit, context: IDecisionContext): boolean {
    const affected = (unit: Unit): boolean =>
        !unit.isDead() && unit.canFly() && unit.getMagicResist() !== 100 && !unit.hasBuffActive("Wind Flow");
    const enemyPressure = context.unitsHolder
        .getAllEnemyUnits(caster.getTeam())
        .filter(affected)
        .reduce((sum, unit) => sum + flyingPressure(unit), 0);
    // Wind Flow also slows a flying caster; excluding it makes symmetric Valkyrie armies cast for no gain.
    const alliedCollateral = context.unitsHolder
        .getAllAllies(caster.getTeam())
        .filter(affected)
        .reduce((sum, unit) => sum + flyingPressure(unit), 0);
    return enemyPressure > alliedCollateral;
}

function bestCastling(
    caster: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    const current = caster.getBaseCell();
    const direction = caster.getTeam() === LOWER ? 1 : -1;
    const hasLocalSupport = context.unitsHolder
        .getAllAllies(caster.getTeam())
        .some(
            (ally) =>
                ally.getId() !== caster.getId() &&
                !ally.isDead() &&
                ally
                    .getCells()
                    .some((cell) => Math.max(Math.abs(cell.x - current.x), Math.abs(cell.y - current.y)) <= 2),
        );
    if (!hasLocalSupport) {
        return undefined;
    }

    let best: IEnumeratedCandidate | undefined;
    let bestValue = -Infinity;
    for (const candidate of candidates) {
        if (!isSpell(candidate, "Castling") || !candidate.targetId) {
            continue;
        }
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target || (target.getAttackType() !== RANGE && target.getAttackType() !== MAGIC)) {
            continue;
        }
        const forwardDelta = (target.getBaseCell().y - current.y) * direction;
        if (forwardDelta < 2) {
            continue;
        }
        // Pull the most valuable exposed backliner into our supported cell. F4 already enforces SMALL,
        // movement-range, hidden-target and spell checks; this layer only decides whether the swap is useful.
        const value = target.getCumulativeHp() + target.getAmountAlive() * target.getAttackDamageMax();
        if (value > bestValue) {
            best = candidate;
            bestValue = value;
        }
    }
    return best;
}

function bestWildRegeneration(
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    let bestValue = -Infinity;
    for (const candidate of candidates) {
        if (!isSpell(candidate, "Wild Regeneration") || !candidate.targetId) {
            continue;
        }
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target) {
            continue;
        }
        const value = target.getCumulativeMaxHp();
        if (value > bestValue) {
            best = candidate;
            bestValue = value;
        }
    }
    return best;
}

/**
 * Q1/M1: v0.6's evidence-gated wrapper for the MELEE_MAGIC caster gap.
 *
 * `V06_CASTER_ROUTER=on` remains required for v0.6 experiments. Gate-off and non-MELEE_MAGIC calls return
 * the exact incumbent array without enumerating, preserving frozen v0.6 and all existing MAGIC behavior.
 * v0.7 uses the typed policy core below instead of consulting this gate. Every routed action is an unmodified
 * F4 candidate, so spell target and engine legality remain centralized in candidates.ts.
 *
 * A/B seat scoping: both seats of a sim game share process env, so a plain on/off can never produce the
 * routed-vs-unrouted pairing the LiveTwin A/B needs. `V06_CASTER_ROUTER=green` routes ONLY the LOWER
 * team's casters and `=red` only the UPPER team's ("both" == "on"); the paired runner flips the value
 * between the two side-swapped games of a seed so seat luck cancels. Any other value keeps the gate off.
 */
function casterRouterGateOn(unit: Unit): boolean {
    const gate = process.env.V06_CASTER_ROUTER;
    if (gate === "on" || gate === "both") {
        return true;
    }
    if (gate === "green" || gate === "red") {
        return gate === (unit.getTeam() === LOWER ? "green" : "red");
    }
    return false;
}

/**
 * Optional per-spell ablation scope for the A/B: V06_CASTER_SPELLS="resurrection,windflow,castling,
 * wildregen,summonwolves,reswiden" (comma list, case-insensitive). Unset/empty = the LEGACY four routed —
 * the plain gate semantics are unchanged and the W17 tokens stay off unless explicitly requested.
 * The 2026-07-10 cohort A/B measured the legacy four TOGETHER at −9.2pp; v0.7 bakes only the separately
 * measured Resurrection + Wind Flow subset while this scope remains available for experiments.
 */
function environmentSpellScope(): readonly CasterRouterSpell[] {
    const raw = process.env.V06_CASTER_SPELLS;
    if (!raw) {
        return LEGACY_CASTER_ROUTER_SPELLS;
    }
    const requested = new Set(raw.split(",").map((spell) => spell.trim().toLowerCase()));
    return KNOWN_CASTER_ROUTER_SPELLS.filter((spell) => requested.has(spell));
}

/**
 * Environment-independent caster routing core. Strategy versions can bake a measured policy directly
 * without temporarily mutating the v0.6 experiment environment.
 */
export function routeUniversalCasterWithPolicy(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    policy: ICasterRouterPolicy,
    enumerate: CandidateEnumerator = enumerateCandidates,
): GameAction[] {
    const spellRouted = (spell: CasterRouterSpell): boolean => policy.spells.includes(spell);

    // W17 gap #2: a MAGIC caster (Satyr — the only Summon Wolves owner) is routed for exactly one rule.
    // A policy without "summonwolves" returns the incumbent without enumerating, so every pre-W17 policy
    // (including shipped v0.7) keeps its MAGIC behavior byte-identical.
    if (unit.getAttackType() === MAGIC) {
        if (!spellRouted("summonwolves") || !summonWolvesMayReplace(incumbent)) {
            return incumbent;
        }
        const summon = enumerate(unit, context, incumbent).candidates.find((candidate) =>
            isSpell(candidate, "Summon Wolves"),
        );
        return summon ? summon.actions : incumbent;
    }

    if (unit.getAttackType() !== MELEE_MAGIC) {
        return incumbent;
    }

    const candidates = enumerate(unit, context, incumbent).candidates;
    const widenedWait = spellRouted("reswait") || spellRouted("reswiden");
    if (
        (spellRouted("resurrection") || widenedWait) &&
        (policy.resurrectionPreemptsCommitted || !incumbentCommitsTurnAgainstResurrection(incumbent, widenedWait))
    ) {
        const resurrection = bestResurrection(
            unit,
            context,
            candidates,
            spellRouted("reswiden") ? WIDENED_RESERVE_DISCOUNT : 1,
        );
        if (resurrection) {
            return resurrection.actions;
        }
    }

    // Preserve v0.4's Troll wait/cast sequencing, Ogre/Behemoth openers, strategic hourglass, and every
    // immediate attack. Utility spells below only replace a move/end-turn fallback.
    if (incumbentCommitsTurn(incumbent)) {
        return incumbent;
    }

    if (spellRouted("windflow")) {
        const windFlow = candidates.find((candidate) => isSpell(candidate, "Wind Flow"));
        if (windFlow && shouldCastWindFlow(unit, context)) {
            return windFlow.actions;
        }
    }

    if (spellRouted("castling")) {
        const castling = bestCastling(unit, context, candidates);
        if (castling) {
            return castling.actions;
        }
    }

    if (spellRouted("wildregen")) {
        return bestWildRegeneration(context, candidates)?.actions ?? incumbent;
    }
    return incumbent;
}

export function routeUniversalCaster(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    enumerate: CandidateEnumerator = enumerateCandidates,
): GameAction[] {
    if (!casterRouterGateOn(unit)) {
        return incumbent;
    }
    // V06_RES_PREEMPT=off demotes Resurrection to the same "never replace a committed combat/wait turn"
    // bar as the utility spells. Every other value preserves the original pre-empting experiment behavior.
    return routeUniversalCasterWithPolicy(
        unit,
        context,
        incumbent,
        {
            spells: environmentSpellScope(),
            resurrectionPreemptsCommitted: process.env.V06_RES_PREEMPT !== "off",
        },
        enumerate,
    );
}
