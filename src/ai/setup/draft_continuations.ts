import { CreatureLevelList } from "../../units/unit_properties";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import { creatureInfo } from "./creature_score";

export interface IDraftFactionContinuation {
    readonly faction: number;
    readonly count: number;
    readonly nextThreshold: number;
    readonly maximumCount: number;
    readonly reachable: boolean;
    readonly uncertain: boolean;
    readonly creatureIds: readonly number[];
}

/** Potential continuations under visible information; hidden picks and unopened bans can still remove them. */
export function draftFactionContinuations(
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    context: IDraftScoutingContext,
): IDraftFactionContinuation[] {
    const own = [...new Set(ownCreatureIds)].flatMap((id) => creatureInfo(id) ?? []);
    const unavailable = new Set([...ownCreatureIds, ...knownOpponentCreatureIds, ...context.bannedCreatureIds]);
    const levels = [...new Set(context.remainingPickLevels)];
    return [...new Set(own.map((unit) => unit.faction))].map((faction) => {
        const count = own.filter((unit) => unit.faction === faction).length;
        const nextThreshold = Math.min(6, 2 * (Math.floor(count / 2) + 1));
        const creatureIds: number[] = [];
        let maximumCount = count;
        let uncertain = false;
        for (const level of levels) {
            const available = (CreatureLevelList[level] ?? []).filter(
                (id) => !unavailable.has(id) && creatureInfo(id)?.faction === faction,
            );
            const slots = context.remainingPickLevels.filter((entry) => entry === level).length;
            maximumCount += Math.min(slots, available.length);
            creatureIds.push(...available);
            if (available.length && !context.knownBanLevels.includes(level)) uncertain = true;
        }
        return {
            faction,
            count,
            nextThreshold,
            maximumCount,
            reachable: maximumCount >= nextThreshold,
            uncertain,
            creatureIds,
        };
    });
}

export function draftContextAfterCreature(context: IDraftScoutingContext, creatureId: number): IDraftScoutingContext {
    const level = creatureInfo(creatureId)?.level;
    const index = context.remainingPickLevels.indexOf(level ?? 0);
    return { ...context, remainingPickLevels: context.remainingPickLevels.filter((_, slot) => slot !== index) };
}
