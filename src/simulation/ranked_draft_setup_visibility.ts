import { creatureIdForName } from "../ai/setup/creature_score";

interface DraftSetupVisibilityInput {
    readonly roster: readonly { readonly creatureName: string }[];
    readonly redRoster: readonly { readonly creatureName: string }[];
    readonly greenRevealedCreatures: readonly number[];
    readonly redRevealedCreatures: readonly number[];
}

/**
 * Bind the pick simulator's legal reveals to the native server's private-Setup input.
 * This is deliberately explicit: an absent projection must not become an empty list or a full roster.
 * Call before reversing physical seats, then reverse both reveal fields and both public-input fields.
 */
export function withRankedDraftPrivateSetupVisibility<T extends DraftSetupVisibilityInput>(config: T) {
    const project = (reveals: readonly number[], roster: DraftSetupVisibilityInput["roster"]): number[] => {
        if (!Array.isArray(reveals)) throw new Error("Missing final draft visibility projection");
        const actual = new Set(
            roster.map((unit) => {
                const id = creatureIdForName(unit.creatureName);
                if (id === undefined) throw new Error("Unknown creature in final draft roster");
                return id;
            }),
        );
        if (reveals.some((id) => !Number.isSafeInteger(id) || !actual.has(id)))
            throw new Error("Draft reveal does not belong to the opponent roster");
        return [...new Set(reveals)];
    };
    return {
        ...config,
        greenPublicOpponentCreatures: project(config.greenRevealedCreatures, config.redRoster),
        redPublicOpponentCreatures: project(config.redRevealedCreatures, config.roster),
    };
}
