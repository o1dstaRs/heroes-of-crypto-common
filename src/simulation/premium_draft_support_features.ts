import { creatureInfo } from "../ai/setup/creature_score";
import { getAbilityConfig, getCreatureConfig, getSpellConfig } from "../configuration/config_provider";
import { AbilityPowerType } from "../abilities/ability_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import { ToFactionName } from "../factions/faction_type";
import { SpellPowerType, SpellTargetType } from "../spells/spell_properties";
import { isOffensiveSpellMultiplier } from "../spells/spell_damage";

/** Research-only printed capabilities. No observed setup, future outcome or trained weights. */
export const PREMIUM_SUPPORT_FEATURE_NAMES = [
    "hpPerExperience",
    "damagePerExperience",
    "bodyHp",
    "armor",
    "initiative",
    "movement",
    "flyers",
    "melee",
    "shooters",
    "casters",
    "resurrectionSources",
    "resurrectionHpPerExperience",
    "resurrectableAllyHpPerExperience",
    "resurrectableShooterHpPerExperience",
    "resurrectableCasterHpPerExperience",
    "healingCharges",
    "massHealingCharges",
    "healingPowerPerExperience",
    "healRecipientBodyHp",
    "healRecipientFrontlineBodyHp",
    "buffCharges",
    "controlCharges",
    "damageSpellCharges",
    "enemyShooterResurrectionHp",
    "enemyCasterResurrectionHp",
    "enemyMeleeHealingCapacity",
    "enemyMovementResurrectionHp",
    "shooterScreenHp",
] as const;

export interface IPremiumDraftSupportProfile {
    featureNames: typeof PREMIUM_SUPPORT_FEATURE_NAMES;
    values: number[];
}

function unitKit(id: number) {
    const info = creatureInfo(id);
    if (!info || !Number.isFinite(info.exp) || info.exp <= 0) throw new Error("Unsupported draft creature");
    const unit = getCreatureConfig(PBTypes.TeamVals.LEFT, ToFactionName[info.faction], info.name, "", 1);
    const native = unit.spells.map((entry) => {
        const colon = entry.indexOf(":");
        if (colon < 1) throw new Error("Malformed native spell entry");
        return getSpellConfig(entry.slice(0, colon), entry.slice(colon + 1));
    });
    const castable = unit.abilities
        .filter((name) => getAbilityConfig(name).can_be_cast)
        .map((name) => getSpellConfig("System", name));
    const spells = [...native, ...castable];
    const resurrection = unit.abilities.some(
        (name) =>
            getAbilityConfig(name).can_be_cast && getAbilityConfig(name).power_type === AbilityPowerType.RESURRECTION,
    );
    const healing = spells.filter((s) => s.power_type === SpellPowerType.HEAL && !s.is_giftable);
    return {
        info,
        resurrection,
        mechanism: unit.abilities.includes("Mechanism"),
        healing,
        // These are nominal base capabilities per experience, not promised HP restoration or paid-Setup quantities.
        hpPerExperience: info.hp / info.exp,
        healPowerPerExperience: healing.reduce((sum, s) => sum + s.power, 0) / info.exp,
        buffCharges: spells.filter(
            (s) => s.is_buff && s.power_type !== SpellPowerType.HEAL && s.power_type !== SpellPowerType.RESURRECT,
        ).length,
        controlCharges: spells.filter(
            (s) =>
                !s.is_buff &&
                !isOffensiveSpellMultiplier(s.multiplier_type) &&
                [SpellTargetType.ANY_ENEMY, SpellTargetType.ALL_ENEMIES].includes(s.spell_target_type),
        ).length,
        damageSpellCharges: spells.filter((s) => !s.is_buff && isOffensiveSpellMultiplier(s.multiplier_type)).length,
    };
}

/**
 * Both lists must already be legally public complete rosters. Supply, splits, aura reach, casualties,
 * initiative timing and actual spell legality are deliberately not guessed. Healing restores a front
 * creature, whereas resurrection can restore casualties; their opportunity descriptors stay separate.
 */
export function premiumDraftSupportProfile(
    ownCreatureIds: readonly number[],
    publicOpponentCreatureIds: readonly number[],
): IPremiumDraftSupportProfile {
    if (
        ownCreatureIds.length !== 6 ||
        publicOpponentCreatureIds.length !== 6 ||
        new Set([...ownCreatureIds, ...publicOpponentCreatureIds]).size !== 12
    )
        throw new Error("Support profile requires complete, distinct public rosters");
    // Stable accumulation makes roster order irrelevant even at floating-point precision.
    const own = [...ownCreatureIds].sort((a, b) => a - b).map(unitKit);
    const enemy = [...publicOpponentCreatureIds].sort((a, b) => a - b).map(unitKit);
    const sum = (f: (unit: ReturnType<typeof unitKit>) => number) => own.reduce((total, u) => total + f(u), 0);
    const resSources = sum((u) => Number(u.resurrection));
    const resHp = sum((u) => (u.resurrection ? u.hpPerExperience : 0));
    const healPower = sum((u) => u.healPowerPerExperience);
    const recipients = own.filter((u) => !u.mechanism);
    const healRecipients = own.filter((u) => !u.mechanism && !u.info.magicImmune);
    const recipientHp = (predicate: (u: ReturnType<typeof unitKit>) => boolean) =>
        recipients.filter(predicate).reduce((total, u) => total + u.hpPerExperience, 0);
    const enemyFraction = (predicate: (u: ReturnType<typeof unitKit>) => boolean) => enemy.filter(predicate).length / 6;
    const values: Record<(typeof PREMIUM_SUPPORT_FEATURE_NAMES)[number], number> = {
        hpPerExperience: sum((u) => u.hpPerExperience) / 6,
        damagePerExperience: sum((u) => u.info.maxDamage / u.info.exp) / 6,
        bodyHp: sum((u) => u.info.hp) / 600,
        armor: sum((u) => u.info.armor) / 300,
        initiative: sum((u) => u.info.initiative) / 60,
        movement: sum((u) => u.info.movementSteps ?? 0) / 60,
        flyers: sum((u) => Number(u.info.canFly)) / 6,
        melee: sum((u) => Number(u.info.melee)) / 6,
        shooters: sum((u) => Number(u.info.ranged)) / 6,
        casters: sum((u) => Number(u.info.caster)) / 6,
        resurrectionSources: resSources,
        resurrectionHpPerExperience: resHp,
        resurrectableAllyHpPerExperience: (resSources * recipientHp(() => true)) / 6,
        resurrectableShooterHpPerExperience: resSources * recipientHp((u) => u.info.ranged),
        resurrectableCasterHpPerExperience: resSources * recipientHp((u) => u.info.caster && !u.resurrection),
        healingCharges:
            sum((u) => u.healing.filter((s) => s.spell_target_type !== SpellTargetType.ALL_ALLIES).length) / 12,
        massHealingCharges:
            sum((u) => u.healing.filter((s) => s.spell_target_type === SpellTargetType.ALL_ALLIES).length) / 12,
        healingPowerPerExperience: healPower,
        healRecipientBodyHp: (healPower * Math.max(0, ...healRecipients.map((u) => u.info.hp))) / 100,
        healRecipientFrontlineBodyHp:
            (healPower * Math.max(0, ...healRecipients.filter((u) => u.info.melee).map((u) => u.info.hp))) / 100,
        buffCharges: sum((u) => u.buffCharges) / 12,
        controlCharges: sum((u) => u.controlCharges) / 12,
        damageSpellCharges: sum((u) => u.damageSpellCharges) / 12,
        enemyShooterResurrectionHp: resHp * enemyFraction((u) => u.info.ranged),
        enemyCasterResurrectionHp: resHp * enemyFraction((u) => u.info.rangedSpellDamage),
        enemyMeleeHealingCapacity: healPower * enemyFraction((u) => u.info.melee),
        enemyMovementResurrectionHp: (resHp * enemy.reduce((s, u) => s + (u.info.movementSteps ?? 0), 0)) / 60,
        shooterScreenHp: (sum((u) => (u.info.melee ? u.hpPerExperience : 0)) * sum((u) => Number(u.info.ranged))) / 6,
    };
    if (Object.values(values).some((v) => !Number.isFinite(v))) throw new Error("Non-finite support descriptor");
    return { featureNames: PREMIUM_SUPPORT_FEATURE_NAMES, values: PREMIUM_SUPPORT_FEATURE_NAMES.map((n) => values[n]) };
}

/** Difference only: zero for no change, antisymmetric when swapping the same two legal final choices. */
export function premiumDraftSupportDifference(
    ownPrefix: readonly number[],
    publicOpponentCreatureIds: readonly number[],
    incumbent: number,
    alternative: number,
): IPremiumDraftSupportProfile {
    if (ownPrefix.length !== 5) throw new Error("Expected five already-picked allies");
    const a = premiumDraftSupportProfile([...ownPrefix, incumbent], publicOpponentCreatureIds);
    const b = premiumDraftSupportProfile([...ownPrefix, alternative], publicOpponentCreatureIds);
    return { featureNames: PREMIUM_SUPPORT_FEATURE_NAMES, values: b.values.map((v, i) => v - a.values[i]) };
}
