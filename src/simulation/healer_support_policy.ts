/** Research-only Healer spell reranker. No production strategy imports this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../ai/candidates";
import { isMindlessAiUnit } from "../ai/unit_ai_overrides";
import { isV08DurableHealAnchor } from "../ai/versions/v0_8_support_roles";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Unit } from "../units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../utils/lib";
import { makeRng } from "./army";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";

export const HEALER_SUPPORT_POLICY_ID = "healer-real-effects-research-v1";
const SPELLS = new Set(["Heal", "Mass Heal", "Spiritual Armor", "Blessing"]);

export interface IHealerSupportProposal {
    actions: GameAction[];
    spellName: string;
    targetId?: string;
    failure: string | null;
    recoveredHp: number;
    recovery: Array<{ id: string; name: string; hp: number; weightedHp: number }>;
    physicalDamageGain: number;
    physicalDamagePrevented: number;
    value: number;
}

export interface IHealerSupportDecision {
    actions: GameAction[];
    reason: "ineligible" | "preserve-nonspell" | "keep-stock" | "support-value";
    incumbentValue?: number;
    selectedValue?: number;
    proposals: IHealerSupportProposal[];
}

const catalog = (unit: Unit, context: IDecisionContext, incumbent: GameAction[] = []) =>
    enumerateCandidates(
        unit,
        { ...context, matrix: context.grid.getMatrix(), decisionPathCatalog: undefined },
        incumbent,
        {
            maxMoveDestinations: 1,
            maxMeleePairs: 8,
            maxShotAims: 6,
            maxAreaThrowCells: 4,
            enrichIncumbentMetadata: true,
        },
    ).candidates;

/** One best currently legal physical attack per unit; retargeting and barrel interception are included. */
function physicalOpportunity(unit: Unit, context: IDecisionContext): number {
    if (unit.hasEffectActive("Stun") || unit.hasEffectActive("Blindness")) return 0;
    let best = 0;
    for (const candidate of catalog(unit, context)) {
        if (!candidate.actions.some((a) => ["melee_attack", "range_attack", "area_throw_attack"].includes(a.type)))
            continue;
        const targetId = candidate.pressureTargetId ?? candidate.targetId;
        const target = targetId ? context.unitsHolder.getAllUnits().get(targetId) : undefined;
        if (!target || target.getTeam() === unit.getTeam()) continue;
        best = Math.max(best, candidate.features.expectedDamage);
    }
    return best;
}

function opportunities(caster: Unit, context: IDecisionContext) {
    let friendly = 0;
    let enemy = 0;
    for (const unit of context.unitsHolder.getAllUnits().values()) {
        if (unit.isDead()) continue;
        if (unit.getTeam() === caster.getTeam()) friendly += physicalOpportunity(unit, context);
        else if (!unit.hasBuffActive("Hidden") && !unit.hasAbilityActive("Hidden"))
            enemy += physicalOpportunity(unit, context);
    }
    return { friendly, enemy };
}

/**
 * Fixed hypothesis: rerank only an incumbent Healer support spell. Real-engine HP recovery is weighted by
 * the existing durable-anchor taxonomy; actual post-buff physical attack estimates value Blessing and armor.
 * One activation, no repeated-turn multiplier, no new movement or attack override. This is not terminal value:
 * spell/AOE damage and later movement/initiative are not forecast. A fresh whole-policy bank is required.
 */
export function chooseHealerSupportDecision(
    caster: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    deps: ILookaheadDeps,
): IHealerSupportDecision {
    const result: IHealerSupportDecision = { actions: incumbent, reason: "ineligible", proposals: [] };
    if (
        caster.getName() !== "Healer" ||
        caster.isDead() ||
        isMindlessAiUnit(caster) ||
        context.decisionOrigin === "rollout"
    )
        return result;
    const cast = incumbent.find((a) => a.type === "cast_spell");
    if (
        !cast ||
        !SPELLS.has(cast.spellName) ||
        incumbent.some((a) => a.type !== "cast_spell" && a.type !== "select_attack_type")
    )
        return { ...result, reason: "preserve-nonspell" };
    const random = captureDeterministicRandomState();
    const snapshot = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
    const damage = deps.captureDamageStats();
    const active = deps.getActiveUnitId();
    const auxiliary = deps.captureAuxiliaryState?.();
    const restore = () => {
        restoreBattle(snapshot, deps.unitsHolder, deps.grid, deps.fightProperties);
        deps.restoreDamageStats(damage);
        auxiliary?.();
        deps.setActiveUnitId(active);
        FightStateManager.getInstance().setFightProperties(deps.fightProperties);
        restoreDeterministicRandomState(random);
    };
    try {
        setDeterministicRandomSource(makeRng(811_822_117));
        const choices = catalog(caster, context, incumbent).filter((c) => c.spellName && SPELLS.has(c.spellName));
        const before = opportunities(caster, context);
        const allies = context.unitsHolder.getAllAllies(caster.getTeam()).filter((u) => !u.isDead());
        const prior = allies.map((unit) => ({
            id: unit.getId(),
            name: unit.getName(),
            hp: unit.getCumulativeHp(),
            weight: isV08DurableHealAnchor(unit, context) ? 3 : 1,
        }));
        const project = (choice: IEnumeratedCandidate): IHealerSupportProposal => {
            restore();
            setDeterministicRandomSource(makeRng(811_822_117));
            const receipt: IHealerSupportProposal = {
                actions: choice.actions,
                spellName: choice.spellName!,
                targetId: choice.targetId,
                failure: null,
                recoveredHp: 0,
                recovery: [],
                physicalDamageGain: 0,
                physicalDamagePrevented: 0,
                value: 0,
            };
            try {
                let castApplied = false;
                for (const action of choice.actions) {
                    const applied = deps.engine.apply(action);
                    if (!applied.completed && action.type !== "select_attack_type") {
                        receipt.failure = applied.rejectionReason ?? "declined";
                        return receipt;
                    }
                    if (action.type === "cast_spell" && applied.completed) castApplied = true;
                    if (applied.events.some((e) => e.type === "turn_completed" || e.type === "fight_finished")) break;
                }
                if (!castApplied) {
                    receipt.failure = "no spell applied";
                    return receipt;
                }
                for (const ally of prior) {
                    const after = context.unitsHolder.getAllUnits().get(ally.id);
                    const restored = Math.max(0, (after?.getCumulativeHp() ?? 0) - ally.hp);
                    if (restored > 0) {
                        receipt.recoveredHp += restored;
                        receipt.recovery.push({
                            id: ally.id,
                            name: ally.name,
                            hp: restored,
                            weightedHp: restored * ally.weight,
                        });
                    }
                }
                const after = opportunities(caster, context);
                receipt.physicalDamageGain = after.friendly - before.friendly;
                receipt.physicalDamagePrevented = before.enemy - after.enemy;
                // Healing raises the damage cap on a wounded target. That is not extra enemy firepower:
                // do not subtract it from the recovery merely because an attack estimate caps at live HP.
                receipt.value =
                    receipt.recovery.reduce((sum, r) => sum + r.weightedHp, 0) +
                    (choice.spellName === "Blessing" ? receipt.physicalDamageGain : 0) +
                    (choice.spellName === "Spiritual Armor" ? receipt.physicalDamagePrevented : 0);
                return receipt;
            } finally {
                restore();
            }
        };
        result.reason = "keep-stock";
        result.proposals = choices.map(project);
        const native = result.proposals.find((p) => JSON.stringify(p.actions) === JSON.stringify(incumbent));
        if (!native || native.failure) return result;
        result.incumbentValue = native.value;
        result.selectedValue = native.value;
        let best = native;
        for (const proposal of result.proposals) if (!proposal.failure && proposal.value > best.value) best = proposal;
        const margin = Math.max(5, Math.abs(native.value) * 0.1);
        if (best.value > native.value + margin) {
            result.actions = best.actions;
            result.reason = "support-value";
            result.selectedValue = best.value;
        }
        return result;
    } finally {
        restore();
    }
}
