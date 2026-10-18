import { getCraftChances } from "../../abilities/craft_chances";
import { DOUBLE_PUNCH_ABILITY_NAMES, DOUBLE_SHOT_ABILITY_NAMES } from "../../abilities/double_shot_names";
import { ARTIFACT_POWER } from "../../artifacts/artifact_properties";
import type { ICreatureInfo } from "./creature_score";

const CRAFT_DOUBLE_CHANCE = getCraftChances(0).double / 100;
const NATIVE_DRAFT_AFFINITY = 1.2;
// Public identities do not reveal a future Craft area. Forecast two recipients, not the entire army.
const FORECAST_CRAFT_RECIPIENTS = 2;

export const hasNativeSecondAttack = (unit: ICreatureInfo): boolean =>
    unit.maxDamage > 0 &&
    (unit.ranged
        ? unit.shots >= 2 && DOUBLE_SHOT_ABILITY_NAMES.some((name) => unit.abilities.includes(name))
        : unit.melee && DOUBLE_PUNCH_ABILITY_NAMES.some((name) => unit.abilities.includes(name)));

const canGainCraftedSecondAttack = (unit: ICreatureInfo): boolean =>
    unit.maxDamage > 0 && (unit.ranged ? unit.shots >= 2 : unit.melee) && !hasNativeSecondAttack(unit);

const uniqueRoster = (units: readonly ICreatureInfo[]): ICreatureInfo[] => [
    ...new Map(units.map((unit) => [unit.id, unit])).values(),
];

/** Forecast fractional physical-output gain; this is a mechanic-based feature, not a win-rate estimate. */
export function dualStrikeRelativeDamageGain(unit: ICreatureInfo, own: readonly ICreatureInfo[]): number {
    const bonus = ARTIFACT_POWER.DUAL_STRIKE_SECOND_ATTACK_PERCENT / 100;
    if (hasNativeSecondAttack(unit)) return bonus / 2;
    const roster = uniqueRoster([...own, unit]);
    if (!canGainCraftedSecondAttack(unit) || !roster.some((ally) => ally.castsCraft)) return 0;
    const eligible = roster.filter(canGainCraftedSecondAttack).length;
    const chance = CRAFT_DOUBLE_CHANCE * Math.min(1, FORECAST_CRAFT_RECIPIENTS / eligible);
    return (bonus * chance) / (1 + chance);
}

/** Only known own picks enter the forecast; native doubles cannot gain a third strike from Craft. */
export function dualStrikeDraftAffinity(unit: ICreatureInfo, own: readonly ICreatureInfo[]): number {
    if (hasNativeSecondAttack(unit)) return NATIVE_DRAFT_AFFINITY;
    const roster = uniqueRoster([...own, unit]);
    const eligible = roster.filter(canGainCraftedSecondAttack).length;
    if (unit.castsCraft) {
        return NATIVE_DRAFT_AFFINITY * CRAFT_DOUBLE_CHANCE * Math.min(FORECAST_CRAFT_RECIPIENTS, eligible);
    }
    return canGainCraftedSecondAttack(unit) && own.some((ally) => ally.castsCraft)
        ? NATIVE_DRAFT_AFFINITY * CRAFT_DOUBLE_CHANCE * Math.min(1, FORECAST_CRAFT_RECIPIENTS / eligible)
        : 0;
}
