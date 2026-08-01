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
import type { TeamType } from "../../generated/protobuf/v1/types_gen";
import { isOffensiveSpellMultiplier } from "../../spells/spell_damage";
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { enumerateCandidates, type CandidateKind, type IEnumeratedCandidate } from "../candidates";
import { otherTeam } from "./v0_1";
import { type ICasterRouterPolicy, routeUniversalCasterWithPolicy, V07_CASTER_ROUTER_POLICY } from "./caster_router";
import { strategyVersionMatchesExperimentScope } from "./experiment_scope";
import { casterPolicyWithExtras, StrategyV0_7 } from "./v0_7";
import {
    buildV08BacklineWardIntent,
    preservesV08BacklineWardIntent,
    prioritizeV08BacklineProtector,
    v08BacklineProtectorPlacement,
} from "./v0_8_backline_protector";
import { prioritizeV08BlacksmithCraft, v08BlacksmithCraftPlacement } from "./v0_8_blacksmith";
import { isV08DirectCombatDecision, v08DominantFinishState } from "./v0_8_dominant_finish";
import { prioritizeV08RangedPositioning } from "./v0_8_ranged_positioning";
import {
    prioritizeV08AshMothSmoke,
    prioritizeV08HealerSustain,
    prioritizeV08NightmareFireWall,
} from "./v0_8_support_roles";
import { prioritizeV08A13FinishDecision } from "./v0_8s_finish";

const MELEE = PBTypes.AttackVals.MELEE;
const V08_DIRECT_COMBAT_KINDS = new Set<CandidateKind>(["melee", "shot", "area_throw"]);
const V08_PASSIVE_ACTION_TYPES = new Set<GameAction["type"]>(["defend_turn", "obstacle_attack", "end_turn"]);
const V08_POSTURE_PROTECTED_ACTION_TYPES = new Set<GameAction["type"]>([
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);
const V08_VINE_THROW_SPELL = "Vine Throw";
const V08_VINE_THROW_PROTECTED_ACTION_TYPES = new Set<GameAction["type"]>([
    "wait_turn",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "cast_spell",
]);

/** v0.8 closes deterministic Harpy Castling and Satyr Summon Wolves omissions without changing frozen v0.7 behavior. */
export const V08_CASTER_ROUTER_POLICY = Object.freeze({
    spells: Object.freeze([...V07_CASTER_ROUTER_POLICY.spells, "castling", "summonwolves"] as const),
    resurrectionPreemptsCommitted: V07_CASTER_ROUTER_POLICY.resurrectionPreemptsCommitted,
}) satisfies ICasterRouterPolicy;

/**
 * Optional exact-version scope for paired ablations. Absent means every v0.8-family caller; explicitly empty
 * disables the v0.8 Castling addition while retaining the inherited v0.7 policy.
 */
export const V08_CASTLING_ROUTER_VERSIONS_ENV = "V08_CASTLING_ROUTER_VERSIONS";
/** Exact-version A/B scope for Blacksmith's multi-target Craft routing and no-AOE opening cluster. */
export const V08_BLACKSMITH_ROLE_VERSIONS_ENV = "V08_BLACKSMITH_ROLE_VERSIONS";
/** Exact-version A/B scope for Nightmare's threat-weighted Fire Wall roadblock router. */
export const V08_NIGHTMARE_ROLE_VERSIONS_ENV = "V08_NIGHTMARE_ROLE_VERSIONS";
/** Exact-version A/B scope for the Ash Moth/Healer role routers; absent enables every v0.8-family seat. */
export const V08_SUPPORT_ROLE_VERSIONS_ENV = "V08_SUPPORT_ROLE_VERSIONS";

const nonnegativeFinite = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** Remaining native/runtime ranged output: shots × per-creature maximum damage × living stack amount. */
export function v08TeamRangedOutput(team: TeamType, unitsHolder: UnitsHolder): number {
    let output = 0;
    for (const unit of unitsHolder.getAllAllies(team)) {
        if (unit.isDead() || !unit.isRangeCapable()) continue;
        const stackOutput =
            nonnegativeFinite(unit.getRangeShots()) *
            nonnegativeFinite(unit.getAttackDamageMax()) *
            nonnegativeFinite(unit.getAmountAlive());
        output = Math.min(Number.MAX_SAFE_INTEGER, output + stackOutput);
    }
    return output;
}

/**
 * True when an idle movable melee screen should defer its first activation to the stronger allied shooters.
 * The immutable action input is the inherited pre-frontMove decision, so real attacks/casts always win. Late
 * dominant/urgent finish windows disable the posture entirely and keep v0.8 pressing toward elimination.
 */
export function v08HasStrongerRangedPosture(
    unit: Unit,
    unitsHolder: UnitsHolder,
    currentLap: number,
    decision: readonly GameAction[],
): boolean {
    if (
        unit.getAttackType() !== MELEE ||
        unit.isRangeCapable() ||
        !unit.canMove() ||
        decision.some((action) => V08_POSTURE_PROTECTED_ACTION_TYPES.has(action.type)) ||
        v08DominantFinishState(unitsHolder, unit.getTeam(), currentLap).active
    ) {
        return false;
    }
    return (
        v08TeamRangedOutput(unit.getTeam(), unitsHolder) > v08TeamRangedOutput(otherTeam(unit.getTeam()), unitsHolder)
    );
}

/** Search-side recognition of the explicit v0.8 ranged-posture wait. */
export function isV08StrongerRangedPostureWait(
    unit: Unit,
    unitsHolder: UnitsHolder,
    currentLap: number,
    decision: readonly GameAction[],
): boolean {
    return (
        decision.some((action) => action.type === "wait_turn") &&
        v08HasStrongerRangedPosture(unit, unitsHolder, currentLap, decision)
    );
}

const isV08PureAdvanceDecision = (decision: readonly GameAction[]): boolean =>
    decision.some((action) => action.type === "move_unit") &&
    decision.every((action) => action.type === "move_unit" || action.type === "select_attack_type");

/**
 * Replace a terminal policy no-op with an explicit engine-valid action. Search still owns the stronger priority:
 * whenever v0.8 has a legal attack, spell, or move, that productive candidate overrides this last-resort defend.
 */
export function ensureExplicitV08Action(unitId: string, decision: GameAction[]): GameAction[] {
    const hasMeaningfulAction = decision.some(
        (action) => action.type !== "select_attack_type" && action.type !== "end_turn",
    );
    return hasMeaningfulAction ? decision : [{ type: "defend_turn", unitId }];
}

/** Prefer a finishing enemy attack, then the nearest legal move, then a legal spell over a passive turn. */
export function selectV08ProductiveCandidate(
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    return (
        selectV08DirectCombatCandidate(candidates) ??
        candidates.find((candidate) => candidate.kind === "move") ??
        candidates.find((candidate) => candidate.kind === "spell")
    );
}

/** Prefer a stack kill first, then maximum immediate damage, then an attack that does not spend movement. */
export function selectV08DirectCombatCandidate(
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    for (const candidate of candidates) {
        if (!V08_DIRECT_COMBAT_KINDS.has(candidate.kind) || !isV08DirectCombatDecision(candidate.actions)) continue;
        if (!Number.isFinite(candidate.features?.expectedDamage) || candidate.features.expectedDamage <= 0) continue;
        const candidateMoves = candidate.actions.some((action) => action.type === "move_unit");
        const bestMoves = best?.actions.some((action) => action.type === "move_unit") ?? false;
        if (
            !best ||
            candidate.features.expectedKill > best.features.expectedKill ||
            (candidate.features.expectedKill === best.features.expectedKill &&
                (candidate.features.expectedDamage > best.features.expectedDamage ||
                    (candidate.features.expectedDamage === best.features.expectedDamage &&
                        bestMoves &&
                        !candidateMoves)))
        ) {
            best = candidate;
        }
    }
    return best;
}

const immediateDamagePrecedes = (
    candidate: Readonly<IEnumeratedCandidate>,
    incumbent: Readonly<IEnumeratedCandidate>,
): boolean =>
    candidate.features.expectedKill > incumbent.features.expectedKill ||
    (candidate.features.expectedKill === incumbent.features.expectedKill &&
        candidate.features.expectedDamage > incumbent.features.expectedDamage);

/**
 * Select the strongest engine-legal, immediately damaging spell. A guaranteed stack kill comes first, then
 * aggregate effective damage (AOE values already cap overkill and subtract Ring of Fire friendly fire).
 * Stable candidate order resolves exact ties, preserving deterministic target/anchor selection.
 */
export function selectV08DamageSpellCandidate(
    unit: Unit,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    for (const candidate of candidates) {
        const cast = candidate.actions.find((action) => action.type === "cast_spell");
        if (!cast || !Number.isFinite(candidate.features.expectedDamage) || candidate.features.expectedDamage <= 0) {
            continue;
        }
        const spell = unit.getSpells().find((entry) => entry.getName() === cast.spellName);
        if (!spell || !isSpellUsableByCaster(unit, spell) || !isOffensiveSpellMultiplier(spell.getMultiplierType())) {
            continue;
        }
        if (!best || immediateDamagePrecedes(candidate, best)) {
            best = candidate;
        }
    }
    return best;
}

const v08VineTargetPressure = (target: Unit): number =>
    nonnegativeFinite(target.getAmountAlive()) *
    nonnegativeFinite(target.getAttackDamageMax()) *
    nonnegativeFinite(target.getSteps());

/**
 * Pick one Vine Throw for full consideration. Mobility-weighted live stack output is the primary signal:
 * snaring a fast, dangerous stack buys more than spending the only charge on a nearly-dead low-output target.
 * Grounded targets win exact ties because they also have to cross the laid terrain; lower resistance and stable
 * candidate order finish the deterministic ordering.
 */
export function selectV08VineThrowCandidate(
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    let bestTarget: Unit | undefined;
    for (const candidate of candidates) {
        if (candidate.kind !== "spell" || candidate.spellName !== V08_VINE_THROW_SPELL || !candidate.targetId) {
            continue;
        }
        const target = unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target || target.isDead()) {
            continue;
        }
        if (!best || !bestTarget) {
            best = candidate;
            bestTarget = target;
            continue;
        }
        const pressureDelta = v08VineTargetPressure(target) - v08VineTargetPressure(bestTarget);
        const groundedDelta = Number(!target.canFly()) - Number(!bestTarget.canFly());
        const resistanceDelta = bestTarget.getMagicResist() - target.getMagicResist();
        if (
            pressureDelta > 0 ||
            (pressureDelta === 0 && (groundedDelta > 0 || (groundedDelta === 0 && resistanceDelta > 0)))
        ) {
            best = candidate;
            bestTarget = target;
        }
    }
    return best;
}

/**
 * MELEE_MAGIC spellbooks historically bypass v0.2's pure-MAGIC caster branch, so Battle Mage and Magic Dragon
 * could walk toward a target while legal long-range damage sat unused. Pick the best legal spell, then compare it
 * with the physical hit the policy ACTUALLY selected: a strictly better spell replaces that hit, while an equal
 * or stronger hit conserves the finite charge. A passive/move decision has no damage threshold and cannot hide
 * behind an unselected attack candidate. Non-damaging spells remain owned by their specialized routers.
 */
export function prioritizeV08DamageSpell(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    if (
        !unit
            .getSpells()
            .some(
                (spell) => isSpellUsableByCaster(unit, spell) && isOffensiveSpellMultiplier(spell.getMultiplierType()),
            )
    ) {
        return decision;
    }

    const candidates = enumerateV08BoundaryCandidates(unit, context, decision);
    const bestSpell = selectV08DamageSpellCandidate(unit, candidates);
    if (!bestSpell) {
        return decision;
    }

    // Candidate zero is the exact supplied decision and enrichIncumbentMetadata prices it when the generator can
    // reproduce its attack. Comparing against some OTHER unselected direct candidate and then returning a passive
    // decision would be internally inconsistent: neither of the two damage options would be taken.
    const incumbent = candidates[0];
    const incumbentIsPricedDirect =
        !!incumbent &&
        isV08DirectCombatDecision(incumbent.actions) &&
        Number.isFinite(incumbent.features.expectedDamage) &&
        incumbent.features.expectedDamage > 0;
    return !incumbentIsPricedDirect || immediateDamagePrecedes(bestSpell, incumbent) ? bestSpell.actions : decision;
}

function enumerateV08BoundaryCandidates(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): readonly IEnumeratedCandidate[] {
    return enumerateCandidates(unit, context, decision, {
        // Bound the direct-policy repair to the same practical candidate census used by live search.
        maxMoveDestinations: 1,
        maxMeleePairs: 8,
        maxShotAims: 6,
        maxAreaThrowCells: 4,
        // A rediscovered incumbent attack needs the same kill/damage metadata as generated alternatives so the
        // late finish comparator can improve target selection even when v0.7 already chose to attack.
        enrichIncumbentMetadata: true,
    }).candidates;
}

/**
 * Trent is a MELEE creature, so the historical MAGIC/MELEE_MAGIC routers never inspect its castable ability.
 * On an ordinary advance/no-op turn, make the best engine-legal Vine Throw the native v0.8 proposal. Preserve
 * immediate combat, another cast, and tactical hourglass; a13 can then compare the cast with its best challenger,
 * while the browser's searchless v0.8 path still knows how to use the ability.
 */
export function prioritizeV08VineThrow(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    if (
        !unit
            .getSpells()
            .some((spell) => spell.getName() === V08_VINE_THROW_SPELL && isSpellUsableByCaster(unit, spell)) ||
        decision.some((action) => V08_VINE_THROW_PROTECTED_ACTION_TYPES.has(action.type)) ||
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), context.fightProperties?.getCurrentLap() ?? 0)
            .active
    ) {
        return decision;
    }
    const vine = selectV08VineThrowCandidate(
        context.unitsHolder,
        enumerateV08BoundaryCandidates(unit, context, decision),
    );
    return vine?.actions ?? decision;
}

const attacksForbiddenTarget = (unit: Unit, decision: readonly GameAction[]): boolean =>
    decision.some(
        (action) =>
            (action.type === "melee_attack" || action.type === "range_attack") &&
            unit.cannotAttackUnitId(action.targetId),
    );

/**
 * Late-finish and learned overlays must not resurrect the target forbidden by Terrifying Gaze after the
 * inherited strategy has checked it. Re-enumerate from a neutral incumbent and choose only engine-legal work.
 */
export function repairV08ForbiddenTargetDecision(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    if (!attacksForbiddenTarget(unit, decision)) return decision;
    const candidates = enumerateV08BoundaryCandidates(unit, context, [
        { type: "end_turn", unitId: unit.getId(), reason: "manual" },
    ]).filter((candidate) => !attacksForbiddenTarget(unit, candidate.actions));
    return (
        selectV08ProductiveCandidate(candidates)?.actions ??
        candidates.find((candidate) => candidate.kind === "wait")?.actions ??
        candidates.find((candidate) => candidate.kind === "defend")?.actions ?? [
            { type: "end_turn", unitId: unit.getId(), reason: "manual" },
        ]
    );
}

const bestV08WardSpell = (candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate | undefined =>
    candidates
        .filter((candidate) => candidate.kind === "spell")
        .sort(
            (left, right) =>
                right.features.expectedKill - left.features.expectedKill ||
                right.features.expectedDamage - left.features.expectedDamage ||
                (left.spellName ?? "").localeCompare(right.spellName ?? ""),
        )[0];

/**
 * Keep a still-productive ranged/caster ward inside its assigned Abomination/Queen screen. When an inherited
 * melee line would leave protection, prefer a legal stationary attack, then a cast, then a non-rushing hold.
 */
export function repairV08BacklineWardDecision(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    const intent = buildV08BacklineWardIntent(unit, context);
    if (!intent || preservesV08BacklineWardIntent(intent, unit, context, decision)) return decision;
    const candidates = enumerateV08BoundaryCandidates(unit, context, decision).filter(
        (candidate) =>
            !attacksForbiddenTarget(unit, candidate.actions) &&
            preservesV08BacklineWardIntent(intent, unit, context, candidate.actions),
    );
    return (
        selectV08DirectCombatCandidate(candidates)?.actions ??
        bestV08WardSpell(candidates)?.actions ??
        candidates.find((candidate) => candidate.kind === "wait")?.actions ??
        candidates.find((candidate) => candidate.kind === "defend")?.actions ??
        candidates.find((candidate) => candidate.kind === "move")?.actions ?? [
            { type: "end_turn", unitId: unit.getId(), reason: "manual" },
        ]
    );
}

/**
 * Keep direct v0.8 from spending a turn on Luck Shield, an end-turn no-op, or a mountain while it can attack or
 * advance. Hourglass wait is deliberately different: it reactivates the unit later in the lap, and a 6,000-game
 * ablation showed that blindly removing it collapses decisive win rate. Search may replace a wait only after a
 * paired rollout proves an active action at least as good. If no productive action exists, preserve the incumbent.
 */
export function prioritizeV08ProductiveAction(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    // A mountain decision may be encoded as move-then-obstacle-attack. The setup move does not make the consumed
    // obstacle turn productive. Likewise, an end-turn marker does not make an otherwise active attack passive.
    const consumesTurnPassively = decision.some((action) => V08_PASSIVE_ACTION_TYPES.has(action.type));
    const alreadyProductive = decision.some(
        (action) =>
            action.type === "move_unit" ||
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "cast_spell",
    );
    if (
        !consumesTurnPassively ||
        (alreadyProductive && !decision.some((action) => action.type === "obstacle_attack"))
    ) {
        return decision;
    }

    const replacement = selectV08ProductiveCandidate(enumerateV08BoundaryCandidates(unit, context, decision));
    return replacement?.actions ?? decision;
}

/**
 * During early dominant-finish or the universal final sprint, deal enemy damage now whenever possible and otherwise
 * advance toward the enemy. At every lap, repair a passive incumbent when an attack or advance is legal.
 */
export function prioritizeV08Decision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    const finish = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    );
    if (finish.active) {
        const candidates = enumerateV08BoundaryCandidates(unit, context, decision);
        const directCombat = selectV08DirectCombatCandidate(candidates);
        // In balanced/losing terminal fights, only an immediate stack kill bypasses normal rollout policy. A
        // commanding army may also retarget to higher damage so a saturated value estimate cannot coast to waves.
        if (
            directCombat &&
            directCombat.actions !== decision &&
            (finish.dominant || directCombat.features.expectedKill === 1)
        ) {
            return directCombat.actions;
        }
        // An incumbent attack whose exact generated twin cannot be enriched is still combat; never downgrade it
        // to move-only merely because its cheap expected-damage metadata is unavailable.
        if (isV08DirectCombatDecision(decision)) {
            return decision;
        }
        const advance = finish.dominant ? candidates.find((candidate) => candidate.kind === "move") : undefined;
        if (advance) {
            return advance.actions;
        }
    }

    return prioritizeV08ProductiveAction(unit, context, decision);
}

/** v0.8 starts from v0.7 and makes attack/advance lexicographically stronger than avoidable passive turns. */
export class StrategyV0_8 extends StrategyV0_7 {
    public override readonly version: string = "v0.8";
    /** Plain v0.8 shots name and aim at the stack that the authoritative trajectory actually hits first. */
    protected override requireResolvedPrimaryRangeTarget(): boolean {
        return true;
    }
    /** Default-off native screen-pressure A/B; other AI versions cannot opt in through this environment key. */
    protected override visibleEdgeScreenPressureEnabled(context: IDecisionContext): boolean {
        return (
            process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE === "1" &&
            strategyVersionMatchesExperimentScope(
                this.version,
                process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE_VERSIONS ?? "v0.8",
            ) &&
            context.grid.getGridType() === PBTypes.GridVals.NORMAL
        );
    }
    /**
     * Harpy otherwise spends every legal Castling turn moving, waiting, or walking into melee. Reuse the
     * conservative universal rule: only a forward SMALL ranged/magic target, only with nearby allied support,
     * and never over a committed attack, wait, defend, or cast. The optional scope supports a true v0.8s/v0.8
     * paired ablation; production leaves it absent and therefore enabled for both aliases.
     */
    protected override routeCasterDecision(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
    ): GameAction[] {
        const basePolicy = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_CASTLING_ROUTER_VERSIONS_ENV],
        )
            ? V08_CASTER_ROUTER_POLICY
            : V07_CASTER_ROUTER_POLICY;
        return routeUniversalCasterWithPolicy(
            unit,
            context,
            decision,
            casterPolicyWithExtras(this.version, basePolicy),
        );
    }
    /** a13 uses living-stack ranged output, not the historical per-creature proxy. */
    protected override rangedOutput(team: number, unitsHolder: UnitsHolder): number {
        return v08TeamRangedOutput(team as TeamType, unitsHolder);
    }
    /** Bake a13's trained preference for pinning enemy shooters into this version. */
    protected override applyMeleeDims(): void {
        this.w[56] = 0;
        this.w[57] = 2;
    }
    /** Bake a13's reveal-conditioned placement when the caller did not select an explicit setup policy. */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const productionContext: IPlacementContext = {
            ...context,
            // Ranked exposes the completed draft before deployment. v0.8 may use those public identities
            // (never positions, stack state, or hidden pick-time information) to arm Queen's anti-fly screen.
            setupPlacementPolicy: context.setupPlacementPolicy ?? "public-roster",
        };
        // Run the inherited path first so v0.7 primes its immutable initial-army profile even when the
        // role-aware layout below overrides the returned cells.
        const inherited = super.placeArmy(units, productionContext);
        const protectedLayout = v08BacklineProtectorPlacement(units, productionContext) ?? inherited;
        return strategyVersionMatchesExperimentScope(this.version, process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV])
            ? v08BlacksmithCraftPlacement(units, productionContext, protectedLayout)
            : protectedLayout;
    }
    protected override frontMove(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const strongerRangedPosture = v08HasStrongerRangedPosture(
            unit,
            context.unitsHolder,
            context.fightProperties?.getCurrentLap() ?? 0,
            decision,
        );
        if (strongerRangedPosture && this.canHourglass(unit, context)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        const inherited = super.frontMove(unit, context, decision);
        // v0.4's >=3-shooter hold uses a historical per-creature proxy that ignores living stack amount. If
        // that proxy turns an actual weaker-side ADVANCE into a wait, retain the original advance. Do not touch
        // an inherited tactical wait or a weaker-side FRONT_TANK lead move; only the legacy-generated wait is
        // neutralized, and v0.1-v0.7 continue to use the historical branch unchanged.
        if (
            !strongerRangedPosture &&
            isV08PureAdvanceDecision(decision) &&
            inherited.some((action) => action.type === "wait_turn")
        ) {
            return decision;
        }
        return inherited;
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const explicit = ensureExplicitV08Action(unit.getId(), super.decideTurn(unit, context));
        const prioritized = prioritizeV08Decision(unit, context, explicit);
        const onlyForcedFallback =
            prioritized.some((action) => action.type === "defend_turn") &&
            !prioritized.some(
                (action) =>
                    action.type === "move_unit" ||
                    action.type === "melee_attack" ||
                    action.type === "range_attack" ||
                    action.type === "area_throw_attack" ||
                    action.type === "cast_spell",
            );
        // Luck Shield is a last-resort engine action, not useful tempo. If the unit still owns its one legal
        // initiative defer, hourglass it and let it try again later in the lap; retain defend only when neither
        // a productive action nor hourglass is actually available.
        const active: GameAction[] =
            onlyForcedFallback && this.canHourglass(unit, context)
                ? [{ type: "wait_turn", unitId: unit.getId() }]
                : prioritized;
        const finished = prioritizeV08A13FinishDecision(unit, context, active);
        const positioned = prioritizeV08RangedPositioning(unit, context, finished, this.version);
        const legalDecision = repairV08ForbiddenTargetDecision(unit, context, positioned);
        const spellDecision = prioritizeV08DamageSpell(unit, context, legalDecision);
        const vineDecision = prioritizeV08VineThrow(unit, context, spellDecision);
        const supportRolesEnabled = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_SUPPORT_ROLE_VERSIONS_ENV],
        );
        const smokeDecision = supportRolesEnabled
            ? prioritizeV08AshMothSmoke(unit, context, vineDecision)
            : vineDecision;
        const nightmareRolesEnabled = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV],
        );
        const nightmareDecision = nightmareRolesEnabled
            ? prioritizeV08NightmareFireWall(unit, context, smokeDecision)
            : smokeDecision;
        const supportDecision = supportRolesEnabled
            ? prioritizeV08HealerSustain(unit, context, nightmareDecision)
            : nightmareDecision;
        const craftDecision = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV],
        )
            ? prioritizeV08BlacksmithCraft(unit, context, supportDecision)
            : supportDecision;
        const protectedDecision = prioritizeV08BacklineProtector(
            unit,
            context,
            craftDecision,
            this.canHourglass(unit, context),
        );
        return repairV08BacklineWardDecision(unit, context, protectedDecision);
    }
}

export const STRATEGY_V0_8: IAIStrategy = new StrategyV0_8();
