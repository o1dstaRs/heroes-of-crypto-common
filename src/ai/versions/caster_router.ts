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

export type CasterRouterSpell = "resurrection" | "windflow" | "castling" | "wildregen";

export interface ICasterRouterPolicy {
    readonly spells: readonly CasterRouterSpell[];
    readonly resurrectionPreemptsCommitted: boolean;
}

const ALL_CASTER_ROUTER_SPELLS = ["resurrection", "windflow", "castling", "wildregen"] as const;

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
 * Resurrection is the only routed spell that a policy may allow to pre-empt an incumbent combat action.
 * It does so only when the recoverable allied HP strictly exceeds the Angel's own auto-resurrection reserve.
 * Candidate F4 explicitly marks whether the cast burns that shared charge; a future non-burning source
 * therefore has zero opportunity cost without another named-unit rule here.
 */
function bestResurrection(
    caster: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
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
        const opportunityCost = candidate.features.burnsResurrectionCharge ? resurrectionPassiveReserve(caster) : 0;
        const surplus = resurrectionRecovery(caster, target) - opportunityCost;
        if (surplus > bestSurplus) {
            best = candidate;
            bestSurplus = surplus;
        }
    }
    return best;
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
    const alliedCollateral = context.unitsHolder
        .getAllAllies(caster.getTeam())
        .filter((unit) => unit.getId() !== caster.getId() && affected(unit))
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
 * wildregen" (comma list, case-insensitive). Unset/empty = all four routed — the plain gate semantics
 * are unchanged. The 2026-07-10 cohort A/B measured the four TOGETHER at −9.2pp; v0.7 bakes only the
 * separately measured Resurrection + Wind Flow subset while this scope remains available for experiments.
 */
function environmentSpellScope(): readonly CasterRouterSpell[] {
    const raw = process.env.V06_CASTER_SPELLS;
    if (!raw) {
        return ALL_CASTER_ROUTER_SPELLS;
    }
    const requested = new Set(raw.split(",").map((spell) => spell.trim().toLowerCase()));
    return ALL_CASTER_ROUTER_SPELLS.filter((spell) => requested.has(spell));
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
    if (unit.getAttackType() !== MELEE_MAGIC) {
        return incumbent;
    }

    const spellRouted = (spell: CasterRouterSpell): boolean => policy.spells.includes(spell);
    const candidates = enumerate(unit, context, incumbent).candidates;
    if (spellRouted("resurrection") && (policy.resurrectionPreemptsCommitted || !incumbentCommitsTurn(incumbent))) {
        const resurrection = bestResurrection(unit, context, candidates);
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
