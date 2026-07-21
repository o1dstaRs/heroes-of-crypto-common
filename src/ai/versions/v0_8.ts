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
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { enumerateCandidates, type CandidateKind, type IEnumeratedCandidate } from "../candidates";
import { otherTeam } from "./v0_1";
import { StrategyV0_7 } from "./v0_7";
import { isV08DirectCombatDecision, v08DominantFinishState } from "./v0_8_dominant_finish";
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

/** Prefer a finishing enemy attack, then the enumerator's nearest-to-enemy legal move. */
export function selectV08ProductiveCandidate(
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    return selectV08DirectCombatCandidate(candidates) ?? candidates.find((candidate) => candidate.kind === "move");
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
            setupPlacementPolicy: context.setupPlacementPolicy ?? "legitimate-reveal",
        };
        return super.placeArmy(units, productionContext);
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
        return prioritizeV08A13FinishDecision(unit, context, active);
    }
}

export const STRATEGY_V0_8: IAIStrategy = new StrategyV0_8();
