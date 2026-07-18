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

// Artifacts are army-wide items chosen during the pick phase (one Tier 1 + one Tier 2 per team).
// They mirror the Augment system (see ./augments/augment_properties.ts): the chosen artifact ids are
// stored per team on FightProperties, applied to units via UnitsHolder.applyArtifacts() as "System"
// Spell buffs (for the stat ones), and read directly from FightProperties by the combat/terrain/spell
// hooks (for the bespoke ones). Enum values are the wire ids sent through ArtifactRequest.

// ARTIFACT Broken Aegis (tier-1): OFFENSIVE break — the wielder's attacks have a chance to Break the
// ENEMY they hit (mute its abilities), at the self-cost of a chance to miss on attack. The "Broken Aegis"
// System buff is only a marker so units/UI show the army carries this ability (and its self-miss debuff).
export const BROKEN_AEGIS_BREAK_CHANCE = 20;
export const BROKEN_AEGIS_MISS_CHANCE = 4;

export enum ArtifactTier {
    TIER_1 = 1,
    TIER_2 = 2,
}

export enum Tier1Artifact {
    NO_ARTIFACT = 0,
    VETERAN_HELM = 1, // +4% defense (all)
    AMULET_OF_RESOLVE = 2, // +25% status resist
    KEEN_BLADE = 3, // +1 attack (flat)
    IRON_PLATE = 4, // +1 defense (flat)
    SWIFT_BOOTS = 5, // +1 movement to melee units
    WINGED_BOOTS = 6, // +1 movement to flying units
    DUAL_STRIKE_CHARM = 7, // +50% damage on a unit's second attack
    WOUNDING_CHARM = 8, // +1 Deep Wounds stack to all allies
    CURSED_WARD = 9, // +5 luck / -5 morale
    HUNTERS_LONGBOW = 10, // +1 flat ranged atk / -15% ranged def, or +2 flat ranged atk if 3+ archers
    HELM_OF_FOCUS = 11, // +25% mind resist
    BROKEN_AEGIS = 12, // Broken Aegis (offensive): wielder's attacks 20% break-the-enemy / 4% self-miss. Numeric id 12 is unchanged for wire/DB compat with stored picks; slug/buff = "broken_aegis".
}

export enum Tier2Artifact {
    NO_ARTIFACT = 0,
    WARLORDS_EDGE = 1, // +15% attack (all)
    TITAN_PLATE = 2, // +15% defense (all)
    HOLY_CROSS = 3, // +50% heal & resurrection; cast Troll ability without consuming it
    CLOVER_OF_FORTUNE = 4, // +10 luck
    CROWN_OF_COMMAND = 5, // +1 movement (all) & +2 morale
    GIANTS_MAUL = 6, // +50% non-magical (physical) AOE damage, resisted by status resistance
    PENDANT_OF_VITALITY = 7, // +25% HP (all) / -20% attack
    FARSIGHT_QUIVER = 8, // all allied archers shoot at full arrow (no range falloff)
    BERSERKERS_BOND = 9, // +3 attack / -2 defense (flat)
    TOME_OF_AMPLIFICATION = 10, // +50% buff power
    RIME_CHARM = 11, // 30% chance to apply a 3-turn slow on any attack
    LAVA_STRIDERS = 12, // all units may move over lava
}

export type ArtifactType =
    { tier: ArtifactTier.TIER_1; value: Tier1Artifact } | { tier: ArtifactTier.TIER_2; value: Tier2Artifact };

// String -> enum converters (wire ids arrive as strings from the JSON pick document / query params).
export const ToTier1Artifact: { [key: string]: Tier1Artifact } = {
    "": Tier1Artifact.NO_ARTIFACT,
    "0": Tier1Artifact.NO_ARTIFACT,
    "1": Tier1Artifact.VETERAN_HELM,
    "2": Tier1Artifact.AMULET_OF_RESOLVE,
    "3": Tier1Artifact.KEEN_BLADE,
    "4": Tier1Artifact.IRON_PLATE,
    "5": Tier1Artifact.SWIFT_BOOTS,
    "6": Tier1Artifact.WINGED_BOOTS,
    "7": Tier1Artifact.DUAL_STRIKE_CHARM,
    "8": Tier1Artifact.WOUNDING_CHARM,
    "9": Tier1Artifact.CURSED_WARD,
    "10": Tier1Artifact.HUNTERS_LONGBOW,
    "11": Tier1Artifact.HELM_OF_FOCUS,
    "12": Tier1Artifact.BROKEN_AEGIS,
};

export const ToTier2Artifact: { [key: string]: Tier2Artifact } = {
    "": Tier2Artifact.NO_ARTIFACT,
    "0": Tier2Artifact.NO_ARTIFACT,
    "1": Tier2Artifact.WARLORDS_EDGE,
    "2": Tier2Artifact.TITAN_PLATE,
    "3": Tier2Artifact.HOLY_CROSS,
    "4": Tier2Artifact.CLOVER_OF_FORTUNE,
    "5": Tier2Artifact.CROWN_OF_COMMAND,
    "6": Tier2Artifact.GIANTS_MAUL,
    "7": Tier2Artifact.PENDANT_OF_VITALITY,
    "8": Tier2Artifact.FARSIGHT_QUIVER,
    "9": Tier2Artifact.BERSERKERS_BOND,
    "10": Tier2Artifact.TOME_OF_AMPLIFICATION,
    "11": Tier2Artifact.RIME_CHARM,
    "12": Tier2Artifact.LAVA_STRIDERS,
};

// Effect magnitudes. Centralised here so balance tuning happens in one place.
export const ARTIFACT_POWER = {
    VETERAN_HELM_PERCENT: 4,
    WARLORDS_EDGE_PERCENT: 12,
    TITAN_PLATE_PERCENT: 12,
    KEEN_BLADE_FLAT: 0.7,
    IRON_PLATE_FLAT: 0.7,
    BERSERKERS_BOND_ATTACK: 3,
    BERSERKERS_BOND_DEFENSE_PENALTY: 2,
    PENDANT_HP_PERCENT: 25,
    PENDANT_ATTACK_PENALTY_PERCENT: 12.5,
    CURSED_WARD_LUCK: 3,
    CURSED_WARD_MORALE_PENALTY: 6,
    CLOVER_LUCK: 10,
    CROWN_STEPS: 1,
    CROWN_MORALE: 5,
    // Swift Boots is now a PERCENT of base steps (not a flat +1), applied to melee units.
    SWIFT_BOOTS_STEPS: 25,
    WINGED_BOOTS_STEPS: 1,
    LONGBOW_ATTACK_FLAT: 1,
    LONGBOW_DEFENSE_PENALTY_PERCENT: 7.5,
    LONGBOW_ATTACK_FLAT_MANY_ARCHERS: 2,
    LONGBOW_DEFENSE_PENALTY_PERCENT_MANY_ARCHERS: 15,
    LONGBOW_ARCHER_THRESHOLD: 3,
    HELM_OF_FOCUS_RESIST_PERCENT: 35,
    AMULET_OF_RESOLVE_RESIST_PERCENT: 25,
    AEGIS_AREA_REDUCTION_PERCENT: 0,
    GIANTS_MAUL_AOE_PERCENT: 35,
    RIME_PROC_PERCENT: 30,
    RIME_SLOW_LAPS: 3,
    HOLY_CROSS_HEAL_RES_PERCENT: 50,
    // Farsight Quiver extends an archer's BASIC shot range by this % (additive off base shot_distance; it
    // pushes the range-falloff threshold out rather than removing falloff, and does NOT compound with Sniper Augment).
    FARSIGHT_QUIVER_RANGE_PERCENT: 50,
    TOME_BUFF_POWER_PERCENT: 50,
    DUAL_STRIKE_SECOND_ATTACK_PERCENT: 50,
    WOUNDING_CHARM_DEEP_WOUNDS_PERCENT: 50,
} as const;

export interface ArtifactProperties {
    readonly tier: ArtifactTier;
    readonly id: number;
    readonly slug: string;
    readonly name: string;
    // Key into game/core image_imports (artifact_t{1,2}_<slug>_256).
    readonly imageKey: string;
    // Name of the "System" Spell buff applied per unit by UnitsHolder.applyArtifacts(). Stat artifacts read
    // this buff's power in Unit.adjustBaseStats(); combat/terrain artifacts apply it as a marker that the
    // relevant hook checks via unit.getBuff(buffName). Must match a key under "System" in spells.json.
    readonly buffName: string;
    readonly description: string;
}

const t1 = (
    id: Tier1Artifact,
    slug: string,
    name: string,
    buffName: string,
    description: string,
): ArtifactProperties => ({
    tier: ArtifactTier.TIER_1,
    id,
    slug,
    name,
    imageKey: `artifact_t1_${slug}_256`,
    buffName,
    description,
});

const t2 = (
    id: Tier2Artifact,
    slug: string,
    name: string,
    buffName: string,
    description: string,
): ArtifactProperties => ({
    tier: ArtifactTier.TIER_2,
    id,
    slug,
    name,
    imageKey: `artifact_t2_${slug}_256`,
    buffName,
    description,
});

export const TIER1_ARTIFACTS: { [key in Tier1Artifact]: ArtifactProperties } = {
    [Tier1Artifact.NO_ARTIFACT]: t1(Tier1Artifact.NO_ARTIFACT, "none", "None", "", "No artifact."),
    [Tier1Artifact.VETERAN_HELM]: t1(
        Tier1Artifact.VETERAN_HELM,
        "veteran_helm",
        "Veteran Helm",
        "Veteran Helm",
        "Boosts the entire army's defense by an additional {}%.",
    ),
    [Tier1Artifact.AMULET_OF_RESOLVE]: t1(
        Tier1Artifact.AMULET_OF_RESOLVE,
        "amulet_of_resolve",
        "Amulet of Resolve",
        "Amulet of Resolve",
        "Increases the army's status resistance by {}%.",
    ),
    [Tier1Artifact.KEEN_BLADE]: t1(
        Tier1Artifact.KEEN_BLADE,
        "keen_blade",
        "Keen Blade",
        "Keen Blade",
        "Increases the army's base attack (both ranged and melee) by {}.",
    ),
    [Tier1Artifact.IRON_PLATE]: t1(
        Tier1Artifact.IRON_PLATE,
        "iron_plate",
        "Iron Plate",
        "Iron Plate",
        "Increases the army's base armor by {}.",
    ),
    [Tier1Artifact.SWIFT_BOOTS]: t1(
        Tier1Artifact.SWIFT_BOOTS,
        "swift_boots",
        "Swift Boots",
        "Swift Boots",
        "Increases melee units' movement by {}% of their base steps.",
    ),
    [Tier1Artifact.WINGED_BOOTS]: t1(
        Tier1Artifact.WINGED_BOOTS,
        "winged_boots",
        "Winged Boots",
        "Winged Boots",
        "Grants +{} base movement distance to all flying units.",
    ),
    [Tier1Artifact.DUAL_STRIKE_CHARM]: t1(
        Tier1Artifact.DUAL_STRIKE_CHARM,
        "dual_strike_charm",
        "Dual Strike Charm",
        "Dual Strike Charm",
        "A unit's second attack deals {}% extra damage.",
    ),
    [Tier1Artifact.WOUNDING_CHARM]: t1(
        Tier1Artifact.WOUNDING_CHARM,
        "wounding_charm",
        "Wounding Charm",
        "Wounding Charm",
        "Grants the whole army a Deep Wounds ability at {}% strength (melee hits stack damage amplification).",
    ),
    [Tier1Artifact.CURSED_WARD]: t1(
        Tier1Artifact.CURSED_WARD,
        "cursed_ward",
        "Cursed Ward",
        "Cursed Ward",
        "Cursed: +{} luck but -[] morale for the whole army.",
    ),
    [Tier1Artifact.HUNTERS_LONGBOW]: t1(
        Tier1Artifact.HUNTERS_LONGBOW,
        "hunters_longbow",
        "Hunter's Longbow",
        "Hunters Longbow",
        "Ranged units gain +{} attack and -[]% defense (or +2 attack and -30% defense with 3+ archers).",
    ),
    [Tier1Artifact.HELM_OF_FOCUS]: t1(
        Tier1Artifact.HELM_OF_FOCUS,
        "helm_of_focus",
        "Helm of Focus",
        "Helm of Focus",
        "Increases the army's mind resistance by {}%.",
    ),
    [Tier1Artifact.BROKEN_AEGIS]: t1(
        Tier1Artifact.BROKEN_AEGIS,
        "broken_aegis",
        "Broken Aegis",
        "Broken Aegis",
        "Broken Aegis: the wielder's attacks have a 20% chance to Break the enemy they hit (muting its abilities), at the cost of a 4% chance to miss.",
    ),
};

export const TIER2_ARTIFACTS: { [key in Tier2Artifact]: ArtifactProperties } = {
    [Tier2Artifact.NO_ARTIFACT]: t2(Tier2Artifact.NO_ARTIFACT, "none", "None", "", "No artifact."),
    [Tier2Artifact.WARLORDS_EDGE]: t2(
        Tier2Artifact.WARLORDS_EDGE,
        "warlords_edge",
        "Warlord's Edge",
        "Warlords Edge",
        "Grants the whole army an additional {}% attack.",
    ),
    [Tier2Artifact.TITAN_PLATE]: t2(
        Tier2Artifact.TITAN_PLATE,
        "titan_plate",
        "Titan Plate",
        "Titan Plate",
        "Grants the whole army an additional {}% defense (melee and ranged).",
    ),
    [Tier2Artifact.HOLY_CROSS]: t2(
        Tier2Artifact.HOLY_CROSS,
        "holy_cross",
        "Holy Cross",
        "Holy Cross",
        "+{}% healing and resurrection; the Troll's ability is not consumed on cast.",
    ),
    [Tier2Artifact.CLOVER_OF_FORTUNE]: t2(
        Tier2Artifact.CLOVER_OF_FORTUNE,
        "clover_of_fortune",
        "Clover of Fortune",
        "Clover of Fortune",
        "Increases the army's luck by {}.",
    ),
    [Tier2Artifact.CROWN_OF_COMMAND]: t2(
        Tier2Artifact.CROWN_OF_COMMAND,
        "crown_of_command",
        "Crown of Command",
        "Crown of Command",
        "Grants +{} movement and +[] morale to the whole army.",
    ),
    [Tier2Artifact.GIANTS_MAUL]: t2(
        Tier2Artifact.GIANTS_MAUL,
        "giants_maul",
        "Giant's Maul",
        "Giants Maul",
        "Increases non-magical (physical) AOE damage by {}% at impact, then reduced by the target's status resistance.",
    ),
    [Tier2Artifact.PENDANT_OF_VITALITY]: t2(
        Tier2Artifact.PENDANT_OF_VITALITY,
        "pendant_of_vitality",
        "Pendant of Vitality",
        "Pendant of Vitality",
        "Cursed: +{}% HP but -[]% attack for the whole army.",
    ),
    [Tier2Artifact.FARSIGHT_QUIVER]: t2(
        Tier2Artifact.FARSIGHT_QUIVER,
        "farsight_quiver",
        "Farsight Quiver",
        "Farsight Quiver",
        "Extends all allied archers' basic shot range by an additional {}%.",
    ),
    [Tier2Artifact.BERSERKERS_BOND]: t2(
        Tier2Artifact.BERSERKERS_BOND,
        "berserkers_bond",
        "Berserker's Bond",
        "Berserkers Bond",
        "Cursed: +{} attack but -[] defense for the whole army.",
    ),
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: t2(
        Tier2Artifact.TOME_OF_AMPLIFICATION,
        "tome_of_amplification",
        "Tome of Amplification",
        "Tome of Amplification",
        "Increases the power of all buffs by {}%.",
    ),
    [Tier2Artifact.RIME_CHARM]: t2(
        Tier2Artifact.RIME_CHARM,
        "rime_charm",
        "Rime Charm",
        "Rime Charm",
        "{}% chance for any attack to slow the target for [] laps.",
    ),
    [Tier2Artifact.LAVA_STRIDERS]: t2(
        Tier2Artifact.LAVA_STRIDERS,
        "lava_striders",
        "Lava Striders",
        "Lava Striders",
        "All army units may move over and stand in lava; while on central lava they gain Made of Fire (+10% to all stats and abilities).",
    ),
};

export const getTier1ArtifactProperties = (id: Tier1Artifact): ArtifactProperties => TIER1_ARTIFACTS[id];
export const getTier2ArtifactProperties = (id: Tier2Artifact): ArtifactProperties => TIER2_ARTIFACTS[id];

// Concrete power values (in order) that fill each description's placeholders: `{}` = first value,
// `[]` = second value. Keyed by slug so it spans both tiers. Sourced from ARTIFACT_POWER — keep in sync
// if a power constant changes. Artifacts with no numeric effect (lava_striders) are omitted.
const AP = ARTIFACT_POWER;
const ARTIFACT_DESCRIPTION_VALUES: { readonly [slug: string]: readonly number[] } = {
    veteran_helm: [AP.VETERAN_HELM_PERCENT],
    amulet_of_resolve: [AP.AMULET_OF_RESOLVE_RESIST_PERCENT],
    keen_blade: [AP.KEEN_BLADE_FLAT],
    iron_plate: [AP.IRON_PLATE_FLAT],
    swift_boots: [AP.SWIFT_BOOTS_STEPS],
    winged_boots: [AP.WINGED_BOOTS_STEPS],
    dual_strike_charm: [AP.DUAL_STRIKE_SECOND_ATTACK_PERCENT],
    wounding_charm: [AP.WOUNDING_CHARM_DEEP_WOUNDS_PERCENT],
    cursed_ward: [AP.CURSED_WARD_LUCK, AP.CURSED_WARD_MORALE_PENALTY],
    hunters_longbow: [AP.LONGBOW_ATTACK_FLAT, AP.LONGBOW_DEFENSE_PENALTY_PERCENT],
    helm_of_focus: [AP.HELM_OF_FOCUS_RESIST_PERCENT],
    broken_aegis: [AP.AEGIS_AREA_REDUCTION_PERCENT],
    warlords_edge: [AP.WARLORDS_EDGE_PERCENT],
    titan_plate: [AP.TITAN_PLATE_PERCENT],
    farsight_quiver: [AP.FARSIGHT_QUIVER_RANGE_PERCENT],
    holy_cross: [AP.HOLY_CROSS_HEAL_RES_PERCENT],
    clover_of_fortune: [AP.CLOVER_LUCK],
    crown_of_command: [AP.CROWN_STEPS, AP.CROWN_MORALE],
    giants_maul: [AP.GIANTS_MAUL_AOE_PERCENT],
    pendant_of_vitality: [AP.PENDANT_HP_PERCENT, AP.PENDANT_ATTACK_PENALTY_PERCENT],
    berserkers_bond: [AP.BERSERKERS_BOND_ATTACK, AP.BERSERKERS_BOND_DEFENSE_PENALTY],
    tome_of_amplification: [AP.TOME_BUFF_POWER_PERCENT],
    rime_charm: [AP.RIME_PROC_PERCENT, AP.RIME_SLOW_LAPS],
};

// Human-readable effect text with the real numbers substituted in (the raw `description` keeps `{}`/`[]`
// placeholders). Use this anywhere the effect is shown to a player (pick UI, sidebar tooltips).
export const formatArtifactDescription = (props: ArtifactProperties): string => {
    const values = ARTIFACT_DESCRIPTION_VALUES[props.slug];
    if (!values || !values.length) {
        return props.description;
    }
    let i = 0;
    return props.description.replace(/\{\}|\[\]/g, () => {
        const v = values[i];
        i += 1;
        return v === undefined ? "" : String(v);
    });
};

export const getArtifactProperties = (tier: ArtifactTier, id: number): ArtifactProperties =>
    tier === ArtifactTier.TIER_1
        ? (TIER1_ARTIFACTS[id as Tier1Artifact] ?? TIER1_ARTIFACTS[Tier1Artifact.NO_ARTIFACT])
        : (TIER2_ARTIFACTS[id as Tier2Artifact] ?? TIER2_ARTIFACTS[Tier2Artifact.NO_ARTIFACT]);

// Ordered lists (excluding NO_ARTIFACT) for building selection UIs.
export const TIER1_ARTIFACT_LIST: ArtifactProperties[] = Object.values(Tier1Artifact)
    .filter((v): v is Tier1Artifact => typeof v === "number" && v !== Tier1Artifact.NO_ARTIFACT)
    .map((id) => TIER1_ARTIFACTS[id]);

export const TIER2_ARTIFACT_LIST: ArtifactProperties[] = Object.values(Tier2Artifact)
    .filter((v): v is Tier2Artifact => typeof v === "number" && v !== Tier2Artifact.NO_ARTIFACT)
    .map((id) => TIER2_ARTIFACTS[id]);
