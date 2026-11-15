/** Offline hypothesis only. No serving policy imports this module. */
import { creatureInfo } from "../ai/setup/creature_score";
import type { IPlacementSetupDecisionContext } from "../ai/setup/setup_strategy";
import { chaosTypes, isRushMelee, type RushAugment } from "./chaos_rush_research";

export const OFFENSE_PRESERVING_MOBILITY_RECIPES = [
    { id: "current", movement: 0, requireChaos: false },
    { id: "physical-m1", movement: 1, requireChaos: false },
    { id: "physical-m2", movement: 2, requireChaos: false },
    { id: "chaos-physical-m1", movement: 1, requireChaos: true },
    { id: "chaos-physical-m2", movement: 2, requireChaos: true },
] as const;
export type OffensePreservingMobilityRecipe = (typeof OFFENSE_PRESERVING_MOBILITY_RECIPES)[number];

/** Preserve every offensive point, Placement and its split capacity. Pay only with existing Armor.
 * Native deployment is reconstructed normally; hidden enemy setup/positions are never inputs.
 */
export function offensePreservingMobilityPlan(
    recipe: OffensePreservingMobilityRecipe,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    base: readonly RushAugment[],
): readonly RushAugment[] {
    if (
        !recipe.movement ||
        !context ||
        context.decisionPhase !== "placement" ||
        context.opponentRosterVisibility !== "complete" ||
        ![5, 6, 7].includes(budget)
    )
        return base;
    const kinds = new Set(base.map((a) => a.kind));
    if (
        kinds.size !== base.length ||
        base.some(
            (a) =>
                !["Placement", "Movement", "Armor", "Might", "Sniper", "Empower"].includes(a.kind) ||
                !Number.isInteger(a.value) ||
                a.value < 0 ||
                a.value > (a.kind === "Placement" || a.kind === "Movement" ? 2 : 3),
        ) ||
        base.reduce((sum, a) => sum + a.value, 0) !== budget
    )
        return base;
    const enemies = [...new Set(context.publicOpponentCreatureIds)];
    const shooters = enemies.filter((id) => creatureInfo(id)?.ranged).length;
    const damageCasters = enemies.filter((id) => creatureInfo(id)?.rangedSpellDamage).length;
    if (
        shooters < 2 ||
        shooters <= damageCasters ||
        [...new Set(own)].filter(isRushMelee).length < 2 ||
        (recipe.requireChaos && (context.synergyVariants?.Chaos !== 1 || chaosTypes(own) < 2))
    )
        return base;
    const movement = base.find((a) => a.kind === "Movement")?.value ?? 0;
    const armor = base.find((a) => a.kind === "Armor")?.value ?? 0;
    const price = recipe.movement - movement;
    if (price <= 0 || armor < price) return base;
    const funded = base.map((a) => ({
        ...a,
        value: a.kind === "Movement" ? recipe.movement : a.kind === "Armor" ? a.value - price : a.value,
    }));
    if (!kinds.has("Movement")) funded.push({ kind: "Movement", value: recipe.movement });
    return funded;
}
