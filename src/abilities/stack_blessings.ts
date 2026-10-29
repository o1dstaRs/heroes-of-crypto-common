export const STACK_BLESSINGS = [
    { name: "Tie up the Horses Blessing", effect: "Tie up the Horses", bit: 64, walkingOnly: true },
    { name: "Luck Blessing", effect: "Luck", bit: 128, walkingOnly: false },
    { name: "Sylvan Focus Blessing", effect: "Sylvan Focus", bit: 256, walkingOnly: false },
    { name: "Pegasus Might Blessing", effect: "Pegasus Might", bit: 512, walkingOnly: false },
    { name: "Wolf Trail Blessing", effect: "Wolf Trail", bit: 1024, walkingOnly: false },
] as const;

export const STACK_BLESSING_BY_NAME: ReadonlyMap<string, (typeof STACK_BLESSINGS)[number]> = new Map(
    STACK_BLESSINGS.map((blessing) => [blessing.name, blessing]),
);
export const STACK_BLESSING_NAMES: ReadonlySet<string> = new Set(STACK_BLESSING_BY_NAME.keys());
const LEGACY_NAMES: ReadonlyMap<string, string> = new Map(
    STACK_BLESSINGS.map(({ effect, name }) => [`${effect} Aura`, name]),
);

export const canonicalStackBlessingName = (name: string): string => LEGACY_NAMES.get(name) ?? name;

export const stackBlessingTextureName = (name: string): string | undefined => {
    const blessing = STACK_BLESSING_BY_NAME.get(name);
    return blessing ? `${blessing.effect.toLowerCase().replace(/ /g, "_")}_aura_256` : undefined;
};
