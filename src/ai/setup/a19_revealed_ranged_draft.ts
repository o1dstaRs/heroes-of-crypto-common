import { creatureInfo } from "./creature_score";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "./doctrine_draft_policy";
import { draftSynergyEffects } from "./draft_battlefield_context";
import { draftCreatureCoherenceAffinity } from "./draft_coherence";
import { draftGenomeCreatureScore, parseDraftGenome, projectDraftGenomeForShipping } from "./draft_ship";
import type { IContextualDraftContext } from "../../simulation/contextual_draft_research";

export { A19_REVEALED_RANGED_DRAFT_POLICY } from "./a19_revealed_ranged_identity";
export const A19_REVEALED_RANGED_DRAFT_SOURCE_SHA256 =
    "5ebab7a04e5b5d94279e2bcc2862e2eb01532f09c22eac1ad8d5dfb0d7ed715b";
const genome = projectDraftGenomeForShipping(parseDraftGenome(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC));

export function isA19DeliveryMelee(creatureId: number): boolean {
    const unit = creatureInfo(creatureId);
    return (
        !!unit &&
        unit.melee &&
        !unit.ranged &&
        !unit.rangedSpellDamage &&
        !unit.castsCraft &&
        !unit.castsAmplifiableBuff
    );
}

export function hasA19RevealedRangedThreat(creatureIds: readonly number[]): boolean {
    const units = [...new Set(creatureIds)].flatMap((id) => creatureInfo(id) ?? []);
    const threats = [...units.filter((unit) => unit.ranged), ...units.filter((unit) => unit.rangedSpellDamage)];
    return threats.length >= 2 || threats.some((unit) => unit.level >= 3);
}

/** Apply after V3 and contextual drafting; consumption is independent and includes hidden-pick collisions. */
export function a19RevealedRangedDraftPool(
    current: number,
    available: readonly number[],
    context: Readonly<IContextualDraftContext>,
    consumed: boolean,
): number[] {
    const unit = creatureInfo(current);
    if (
        !unit ||
        consumed ||
        context.ownCreatureIds.length < 3 ||
        !hasA19RevealedRangedThreat(context.knownOpponentCreatureIds) ||
        !isA19DeliveryMelee(current) ||
        unit.canFly ||
        !context.synergyVariants ||
        ["Flesh Shield", "Sanctuary", "Range Null Field", "No Fly"].some((ability) => unit.abilities.includes(ability))
    )
        return [];
    const own = context.ownCreatureIds;
    if (!own.some(isA19DeliveryMelee)) return [];
    const noFly = context.knownOpponentCreatureIds.some((id) => creatureInfo(id)?.abilities.includes("No Fly"));
    const intrinsic = draftGenomeCreatureScore(genome, current);
    const coherence = draftCreatureCoherenceAffinity(current, context);
    const nativeSteps = draftSynergyEffects([...own, current], context.synergyVariants).movement;
    return available.filter(
        (id) =>
            id !== current &&
            isA19DeliveryMelee(id) &&
            ((!noFly && creatureInfo(id)!.canFly) ||
                draftSynergyEffects([...own, id], context.synergyVariants!).movement > nativeSteps) &&
            draftGenomeCreatureScore(genome, id) >= intrinsic - 0.05 * Math.max(1, Math.abs(intrinsic)) &&
            draftCreatureCoherenceAffinity(id, context) >= coherence - 0.1,
    );
}
