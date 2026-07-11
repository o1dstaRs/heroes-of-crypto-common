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
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { routeUniversalCasterWithPolicy, V07_CASTER_ROUTER_POLICY } from "./caster_router";
import { StrategyV0_4 } from "./v0_4";
import { StrategyV0_6 } from "./v0_6";
import { applyWaitScorerWeights, v07BakedWaitWeights } from "./wait_scorer";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const SALVAGE_SPELLS = new Set(["Resurrection", "Wind Flow"]);

export const isAuraSaturatedArmy = (units: readonly Unit[]): boolean =>
    units.length > 0 && units.every((unit) => unit.getAuraRanges().some((range) => range > 0));

export const isMeleeMagicAnchorArmy = (units: readonly Unit[]): boolean =>
    units.filter((unit) => unit.getAttackType() === MELEE_MAGIC).length >= 4 &&
    !units.some((unit) => unit.getSpells().some((spell) => SALVAGE_SPELLS.has(spell.getName())));

const isPureRangedArmy = (units: readonly Unit[]): boolean =>
    units.length > 0 && units.every((unit) => unit.getAttackType() === RANGE);

export const shouldUseArchetypePlacementAnchor = (units: readonly Unit[], enemies: readonly Unit[]): boolean =>
    isAuraSaturatedArmy(units) ||
    (isPureRangedArmy(units) && enemies.some((unit) => !unit.isDead() && unit.hasAbilityActive("Area Throw")));

interface IV07ArmyProfile {
    auraSaturated: boolean;
    meleeMagicAnchor: boolean;
}

/**
 * v0.7 — the shipped v0.7 program on top of the full v0.6 chain:
 * - S1: the Q2 Gate-2 distilled act-vs-wait scorer is baked in for its supported non-ranged,
 *   non-cast decision domain;
 * - S3: only the measured Resurrection + Wind Flow caster salvage is baked in, without Resurrection
 *   pre-emption. Castling and Wild Regeneration remain experimental-only;
 * - fixed-cohort safety: aura-saturated armies use the proven v0.4 aura policy, pure ranged armies
 *   keep v0.6 except for the Area Throw dispersion failure, and unsupported melee-mage-heavy armies
 *   preserve v0.6 decisions.
 *
 * Weight resolution (wait_scorer.ts v07BakedWaitWeights): committed defaults, still overridable via
 * V07_WAIT_WEIGHTS for experiments; an ALL-ZERO override disables only the baked scorer. v0.6/v0.6s
 * behavior is untouched: their environment-gated caster/scorer stages and every experiment knob keep
 * working exactly as before.
 */
export class StrategyV0_7 extends StrategyV0_6 {
    public override readonly version: string = "v0.7";
    private readonly archetypeAnchor = new StrategyV0_4();
    private readonly armyProfiles = new WeakMap<object, Map<number, IV07ArmyProfile>>();
    private armyProfile(holder: object, team: number, units: readonly Unit[]): IV07ArmyProfile {
        let byTeam = this.armyProfiles.get(holder);
        if (!byTeam) {
            byTeam = new Map();
            this.armyProfiles.set(holder, byTeam);
        }
        let profile = byTeam.get(team);
        if (!profile) {
            profile = {
                auraSaturated: isAuraSaturatedArmy(units),
                meleeMagicAnchor: isMeleeMagicAnchorArmy(units),
            };
            byTeam.set(team, profile);
        }
        return profile;
    }
    /** v0.6's learned fight policy is out-of-distribution when every stack emits an aura. */
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const profile = this.armyProfile(
            context.unitsHolder,
            unit.getTeam(),
            context.unitsHolder.getAllAllies(unit.getTeam()),
        );
        if (profile.auraSaturated) {
            return this.archetypeAnchor.decideTurn(unit, context);
        }
        return super.decideTurn(unit, context);
    }
    /**
     * Pure ranged Area Throw mirrors need v0.4's cohesive formation. Keep v0.6 dispersion against
     * Large Caliber: the fixed Tsar-Cannon cohort strongly benefits from it.
     */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        this.armyProfile(context.unitsHolder, context.team, units);
        if (shouldUseArchetypePlacementAnchor(units, context.unitsHolder.getAllEnemyUnits(context.team))) {
            return this.archetypeAnchor.placeArmy(units, context);
        }
        return super.placeArmy(units, context);
    }
    /** S3: bake only the measured non-pre-empting Resurrection + Wind Flow salvage. */
    protected override routeCasterDecision(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
    ): GameAction[] {
        return routeUniversalCasterWithPolicy(unit, context, decision, V07_CASTER_ROUTER_POLICY);
    }
    /** v0.6's final-stage seam: apply the committed scorer only inside its measured decision domain. */
    protected override finalizeDecision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        // The distilled scorer was trained on melee-drafted/random armies, not the held-out range-specialist
        // cohort. On that cohort, allowing it to delay ranged actors regressed 47.1% vs v0.6; anchoring only
        // ranged actors then scored 58.9% on a fresh 6,000-game panel while retaining teammate wait gains.
        if (unit.getAttackType() === RANGE) {
            return decision;
        }
        // Caster routing and inherited spellbooks have already compared the available spell with combat
        // alternatives. The wait model has no incumbent-action feature, so it cannot safely distinguish a
        // committed cast from a generic advance; preserve casts while leaving non-cast mage turns eligible.
        if (decision.some((action) => action.type === "cast_spell")) {
            return decision;
        }
        // In a melee-magic-heavy army without Resurrection/Wind Flow, v0.7 has no supported caster
        // improvement to contribute. The fixed brawler cohort attributes its regression entirely to
        // scorer-added waits, so preserve the full v0.6 formation policy for every actor in that army.
        if (
            this.armyProfile(context.unitsHolder, unit.getTeam(), context.unitsHolder.getAllAllies(unit.getTeam()))
                .meleeMagicAnchor
        ) {
            return decision;
        }
        return applyWaitScorerWeights(unit, context, decision, v07BakedWaitWeights());
    }
}

export const STRATEGY_V0_7: IAIStrategy = new StrategyV0_7();
