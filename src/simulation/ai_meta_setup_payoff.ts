import { PBTypes } from "../generated/protobuf/v1/types";
import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";
import { aiMetaSynergyLevel } from "./ai_meta_cohorts_core";
import { premiumDraftedCombatMetrics, summarizePremiumCombatMetrics } from "./ai_meta_combat_metrics";
import { summarizePremiumParticipation } from "./ai_meta_participation";

/** Observations of practical use. These do not isolate the causal contribution of an upgrade or synergy. */
export function aiMetaSetupPayoff(record: IAiMetaPairRecord, fightIndex: number, side: "a" | "b") {
    const fight = record.evidence!.fights![fightIndex];
    const army = side === "a" ? record.armyA : record.armyB;
    const team = (side === "a") === fight.aIsGreen ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const participation = fight.participation ?? summarizePremiumParticipation(fight);
    const metrics = fight.combatMetrics ?? summarizePremiumCombatMetrics(fight);
    const draftedIds = new Set(fight.formations[side].unitIdsByStack);
    return {
        schema: "premium-setup-payoff-v1",
        scope: "observed-use-not-causal-synergy-or-upgrade-effect",
        openingStage: "first-decision-after-start",
        activeSynergies: army.synergies.map((choice) => ({
            ...choice,
            level: aiMetaSynergyLevel(army.creatureIds, choice.faction),
        })),
        stacks: (fight.firstDecisionState?.units ?? [])
            .filter(({ properties: p }) => p.team === team && draftedIds.has(p.id))
            .map(({ properties: p, cells }) => ({
                unitId: p.id,
                creatureId:
                    fight.formations[side].draftedCreatureIdsByStack[
                        fight.formations[side].unitIdsByStack.indexOf(p.id)
                    ],
                name: p.name,
                faction: p.faction,
                amount: p.amount_alive,
                maxHp: p.max_hp,
                stackPower: p.stack_power,
                steps: p.steps,
                stepsModifier: p.steps_mod,
                rangeShots: p.range_shots,
                rangeShotsModifier: p.range_shots_mod,
                spellEntries: [...p.spells],
                auraEffects: [...p.aura_effects],
                cells,
            })),
        combatByCreature: premiumDraftedCombatMetrics(metrics, participation).filter((row) => row.army === side),
        limitations: [
            "First-decision stats include startup effects.",
            "Spell entries are serialized charges, not a claim all spells have legal targets.",
            "Adjacency is not aura benefit; reported damage attribution is incomplete.",
            "Composition, artifacts and paid upgrades confound synergy associations.",
        ],
    };
}
