import { MAX_AUGMENT_POINTS } from "../constants";

export enum Perk {
    NO_PERK = 0,
    THREE_REVEALS = 1,
    SEE_ALL = 2,
    SEE_NONE = 3,
}

export type PerkRevealMode = "random3" | "all" | "none";
export const PERK_RANDOM_REVEAL_SLOTS = 3;

export interface PerkProperties {
    readonly id: Perk;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly upgradePoints: number;
    readonly revealMode: PerkRevealMode;
    readonly imageKey: string;
}

const perk = (
    id: Perk,
    slug: string,
    name: string,
    description: string,
    upgradePoints: number,
    revealMode: PerkRevealMode,
): PerkProperties => ({
    id,
    slug,
    name,
    description,
    upgradePoints,
    revealMode,
    imageKey: `perk_${name.toLowerCase().replace(/\s+/g, "_")}`,
});

export const PERKS: { [key in Perk]: PerkProperties } = {
    [Perk.NO_PERK]: perk(Perk.NO_PERK, "none", "None", "No perk selected.", MAX_AUGMENT_POINTS, "none"),
    [Perk.THREE_REVEALS]: perk(
        Perk.THREE_REVEALS,
        "three_reveals",
        "Scout",
        "Reveal the opponent's picks in 3 random slots. Grants 6 upgrade points.",
        6,
        "random3",
    ),
    [Perk.SEE_ALL]: perk(
        Perk.SEE_ALL,
        "see_all",
        "Spymaster",
        "See all of the opponent's picks during the draft. Grants 5 upgrade points.",
        5,
        "all",
    ),
    [Perk.SEE_NONE]: perk(
        Perk.SEE_NONE,
        "see_none",
        "Blind Fury",
        "See none of the opponent's picks. Grants 7 upgrade points.",
        7,
        "none",
    ),
};

export const getPerkProperties = (perkId: Perk): PerkProperties => PERKS[perkId] ?? PERKS[Perk.NO_PERK];
export const getUpgradePoints = (perkId: Perk): number => getPerkProperties(perkId).upgradePoints;
export const getPerkRevealMode = (perkId: Perk): PerkRevealMode => getPerkProperties(perkId).revealMode;
export const PERK_LIST: PerkProperties[] = [PERKS[Perk.THREE_REVEALS], PERKS[Perk.SEE_ALL], PERKS[Perk.SEE_NONE]];
export const ToPerk: { [key: string]: Perk } = {
    "": Perk.NO_PERK,
    "0": Perk.NO_PERK,
    "1": Perk.THREE_REVEALS,
    "2": Perk.SEE_ALL,
    "3": Perk.SEE_NONE,
};
