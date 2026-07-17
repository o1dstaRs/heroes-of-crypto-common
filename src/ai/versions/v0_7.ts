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
import { normalizeMeleeMagicSelection } from "../melee_attack_type";
import {
    type CasterRouterSpell,
    type ICasterRouterPolicy,
    routeUniversalCasterWithPolicy,
    V07_CASTER_ROUTER_POLICY,
} from "./caster_router";
import { StrategyV0_4 } from "./v0_4";
import { StrategyV0_6 } from "./v0_6";
import { revealConditionedPlacement } from "./v0_7_placement_reveal";
import {
    applyWaitScorerWeights,
    applyWaitScorerWeightsV2,
    applyWaitScorerWeightsV3,
    v07BakedWaitWeights,
    v07WaitWeightsV2,
    v07WaitWeightsV3,
} from "./wait_scorer";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const SALVAGE_SPELLS = new Set(["Resurrection", "Wind Flow"]);
const V07_AURA_WIND_ROUTER_POLICY = Object.freeze({
    spells: Object.freeze(["windflow"] as const),
    resurrectionPreemptsCommitted: false,
}) satisfies ICasterRouterPolicy;

export const isAuraSaturatedArmy = (units: readonly Unit[]): boolean =>
    units.length > 0 && units.every((unit) => unit.getAuraRanges().some((range) => range > 0));

export const isDenseMeleeMagicArmy = (units: readonly Unit[]): boolean =>
    units.filter((unit) => unit.getAttackType() === MELEE_MAGIC).length >= 2;

export const isMeleeMagicAnchorArmy = (units: readonly Unit[]): boolean =>
    isDenseMeleeMagicArmy(units) &&
    !units.some((unit) => unit.getSpells().some((spell) => SALVAGE_SPELLS.has(spell.getName())));

const isPureRangedArmy = (units: readonly Unit[]): boolean =>
    units.length > 0 && units.every((unit) => unit.getAttackType() === RANGE);

export const shouldUseArchetypePlacementAnchor = (units: readonly Unit[], enemies: readonly Unit[]): boolean =>
    isAuraSaturatedArmy(units) ||
    (isPureRangedArmy(units) && enemies.some((unit) => !unit.isDead() && unit.hasAbilityActive("Area Throw")));

interface IV07ArmyProfile {
    auraSaturated: boolean;
    denseMeleeMagic: boolean;
    meleeMagicAnchor: boolean;
}

const denseMeleeMagicIsolationEnabled = (): boolean => process.env.V07_DENSE_MM_SALVAGE_ISOLATION === "1";

/**
 * W17 gaps #2/#3 (V07_CASTER_EXTRA, default OFF): extra caster-router tokens layered onto the shipped S3
 * salvage policy — "summonwolves" (Satyr Summon Wolves over a lower-EV self-buff), "reswait" (Angel
 * Resurrection may replace a wait) and "reswiden" (reswait + halved reserve bar), comma list, each
 * ablating independently. `V07_CASTER_EXTRA_VERSIONS`
 * (comma list) scopes by strategy version for seat-scoped A/B mirrors (the V06_MELEE_DIMS_VERSIONS pattern:
 * set "v0.7s" so a v0.7s-vs-v0.7 battery carries the tokens on exactly one seat); unset = every v0.7-family
 * caller, the eventual live-flip semantics. Gate unset, scope mismatch, or no recognized token returns the
 * exact shipped V07_CASTER_ROUTER_POLICY object — byte-identical shipped behavior.
 */
const EXTRA_CASTER_TOKENS: readonly CasterRouterSpell[] = ["summonwolves", "reswait", "reswiden"];

function casterPolicyWithExtras(version: string): ICasterRouterPolicy {
    const raw = process.env.V07_CASTER_EXTRA;
    if (!raw) {
        return V07_CASTER_ROUTER_POLICY;
    }
    const scope = process.env.V07_CASTER_EXTRA_VERSIONS;
    if (scope) {
        const allowed = scope
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
        if (!allowed.includes(version)) {
            return V07_CASTER_ROUTER_POLICY;
        }
    }
    const requested = new Set(raw.split(",").map((token) => token.trim().toLowerCase()));
    const extras = EXTRA_CASTER_TOKENS.filter((token) => requested.has(token));
    if (!extras.length) {
        return V07_CASTER_ROUTER_POLICY;
    }
    return {
        spells: [...V07_CASTER_ROUTER_POLICY.spells, ...extras],
        resurrectionPreemptsCommitted: V07_CASTER_ROUTER_POLICY.resurrectionPreemptsCommitted,
    };
}

function auraCasterRouterPolicy(): ICasterRouterPolicy | undefined {
    if (process.env.V07_AURA_CASTER_ROUTER !== "on") {
        return undefined;
    }
    const scope = process.env.V07_AURA_CASTER_SPELLS ?? "resurrection,windflow";
    if (scope === "windflow") {
        return V07_AURA_WIND_ROUTER_POLICY;
    }
    if (scope === "resurrection,windflow") {
        return V07_CASTER_ROUTER_POLICY;
    }
    // Unknown experiment scopes fail closed to the committed v0.4 aura policy.
    return undefined;
}

/**
 * v0.7 — the shipped v0.7 program on top of the full v0.6 chain:
 * - S1: the Q2 Gate-2 distilled act-vs-wait scorer is baked in for its supported melee-attack-type,
 *   non-cast decision domain in majority-melee armies;
 * - S3: only the measured Resurrection + Wind Flow caster salvage is baked in, without Resurrection
 *   pre-emption. Castling and Wild Regeneration remain experimental-only;
 * - fixed-cohort safety: aura-saturated armies use the proven v0.4 aura policy, pure-ranged combat
 *   stays on v0.6 while Area Throw matchups use v0.4 placement, and unsupported melee-mage-heavy
 *   armies preserve v0.6 decisions.
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
    private primeArmyProfile(holder: object, team: number, units: readonly Unit[]): IV07ArmyProfile {
        let byTeam = this.armyProfiles.get(holder);
        if (!byTeam) {
            byTeam = new Map();
            this.armyProfiles.set(holder, byTeam);
        }
        let profile = byTeam.get(team);
        if (!profile) {
            profile = {
                auraSaturated: isAuraSaturatedArmy(units),
                denseMeleeMagic: isDenseMeleeMagicArmy(units),
                meleeMagicAnchor: isMeleeMagicAnchorArmy(units),
            };
            byTeam.set(team, profile);
        }
        return profile;
    }
    private armyProfile(holder: object, team: number): IV07ArmyProfile | undefined {
        // A late AI takeover may first see the army after casualties. Do not infer a permanent initial-roster
        // profile from survivors; placement primes normal simulation and persistent-bot fights.
        return this.armyProfiles.get(holder)?.get(team);
    }
    /** v0.6's learned fight policy is out-of-distribution when every stack emits an aura. */
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const profile = this.armyProfile(context.unitsHolder, unit.getTeam());
        if (profile?.auraSaturated) {
            const incumbent = this.archetypeAnchor.decideTurn(unit, context);
            const policy = auraCasterRouterPolicy();
            const decision = policy ? routeUniversalCasterWithPolicy(unit, context, incumbent, policy) : incumbent;
            return normalizeMeleeMagicSelection(unit, decision);
        }
        return normalizeMeleeMagicSelection(unit, super.decideTurn(unit, context));
    }
    /**
     * Pure-ranged armies use the measured v0.4 placement anchor only against Area Throw; combat remains
     * v0.6. Keep v0.6 placement against Large Caliber: the fixed Tsar-Cannon cohort benefits from it.
     */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        // Ranked takeover can ask the strategy to place only the stacks that are still unplaced. Classify
        // and cache from the complete team in the holder so a partial request cannot become the army profile.
        const allies = context.unitsHolder.getAllAllies(context.team);
        this.primeArmyProfile(context.unitsHolder, context.team, allies);
        if (shouldUseArchetypePlacementAnchor(allies, context.unitsHolder.getAllEnemyUnits(context.team))) {
            return this.archetypeAnchor.placeArmy(units, context);
        }
        // Env-gated experiment (V07_PLACEMENT_REVEAL=on, default OFF): reveal-conditioned deployment
        // driven ONLY by context.revealedOpponentCreatures — what this seat legitimately learned during
        // picks. The measured archetype anchors above keep precedence; gate off / no reveals / no
        // relevant threat leaves today's placement byte-identical (see v0_7_placement_reveal.ts).
        const revealPlaced = revealConditionedPlacement(units, context);
        if (revealPlaced) {
            return revealPlaced;
        }
        return super.placeArmy(units, context);
    }
    /** S3: bake only the measured non-pre-empting Resurrection + Wind Flow salvage. W17's experimental
     * extra tokens (V07_CASTER_EXTRA, default OFF) layer onto that policy without touching it. */
    protected override routeCasterDecision(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
    ): GameAction[] {
        return routeUniversalCasterWithPolicy(unit, context, decision, casterPolicyWithExtras(this.version));
    }
    /** v0.6's final-stage seam: apply the committed scorer only inside its measured decision domain. */
    protected override finalizeDecision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        // Caster routing and inherited spellbooks have already compared the available spell with combat
        // alternatives. The wait model has no incumbent-action feature, so it cannot safely distinguish a
        // committed cast from a generic advance; preserve casts while leaving non-cast mage turns eligible.
        if (decision.some((action) => action.type === "cast_spell")) {
            return decision;
        }
        // The scorer fit contained roughly one melee-magic stack per six-stack army. At two or more without
        // Resurrection/Wind Flow, v0.7 has no supported improvement to contribute, so preserve v0.6 exactly.
        const profile = this.armyProfile(context.unitsHolder, unit.getTeam());
        // A late takeover has no trustworthy initial-roster classifier input. Keep the incumbent v0.6 action
        // rather than applying the scorer outside a known profile; guarded caster salvage ran before this seam.
        if (!profile || profile.meleeMagicAnchor || (profile.denseMeleeMagic && denseMeleeMagicIsolationEnabled())) {
            return decision;
        }
        // Action-aware V3 is research-only and initially owns RANGE actors only. Other classes continue
        // through the existing V2/V1 resolver, and absent/malformed/all-zero V3 is an exact no-op.
        const v3 = v07WaitWeightsV3();
        if (v3 && unit.getAttackType() === RANGE) {
            return applyWaitScorerWeightsV3(unit, context, decision, v3);
        }
        // Phase-B env candidate: V07_WAIT_WEIGHTS_V2 (valid, non-zero) swaps in the multi-cohort V2 scorer;
        // all-zero disables the wait stage entirely; absent/malformed keeps the baked v1 path byte-identical.
        const v2 = v07WaitWeightsV2();
        if (v2 === "disabled") {
            return decision;
        }
        if (v2) {
            return applyWaitScorerWeightsV2(unit, context, decision, v2);
        }
        return applyWaitScorerWeights(unit, context, decision, v07BakedWaitWeights());
    }
}

export const STRATEGY_V0_7: IAIStrategy = new StrategyV0_7();
