import { CreatureLevelList } from "../../units/unit_properties";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import { creatureInfo, type ICreatureInfo } from "./creature_score";

export interface IDraftFutureSlot {
    readonly level: number;
    readonly count: number;
    readonly creatureIds: readonly number[];
    readonly uncertain: boolean;
}

export interface IDraftCreatureContinuation {
    readonly count: number;
    readonly maximumCount: number;
    readonly creatureIds: readonly number[];
    readonly uncertain: boolean;
}

export interface IDraftFactionGoal {
    readonly faction: number;
    readonly count: number;
}

export interface IDraftFactionCompletion {
    readonly reachable: boolean;
    readonly creatureIds: readonly number[];
    readonly uncertain: boolean;
}

export function draftFutureSlots(
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    context: IDraftScoutingContext,
): IDraftFutureSlot[] {
    const unavailable = new Set([...ownCreatureIds, ...knownOpponentCreatureIds, ...context.bannedCreatureIds]);
    return [...new Set(context.remainingPickLevels)].flatMap((level) => {
        if (level < 1 || level > 4 || !CreatureLevelList[level]) return [];
        return [
            {
                level,
                count: context.remainingPickLevels.filter((entry) => entry === level).length,
                creatureIds: CreatureLevelList[level].filter((id) => !unavailable.has(id)),
                uncertain: !context.knownBanLevels.includes(level),
            },
        ];
    });
}

export function draftCreatureContinuation(
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    context: IDraftScoutingContext,
    matches: (unit: ICreatureInfo) => boolean,
): IDraftCreatureContinuation {
    const count = [...new Set(ownCreatureIds)].filter((id) => {
        const unit = creatureInfo(id);
        return unit && matches(unit);
    }).length;
    let maximumCount = count;
    const creatureIds: number[] = [];
    let uncertain = false;
    for (const slot of draftFutureSlots(ownCreatureIds, knownOpponentCreatureIds, context)) {
        const matching = slot.creatureIds.filter((id) => {
            const unit = creatureInfo(id);
            return unit && matches(unit);
        });
        maximumCount += Math.min(slot.count, matching.length);
        creatureIds.push(...matching);
        if (matching.length && slot.uncertain) uncertain = true;
    }
    return { count, maximumCount, creatureIds, uncertain };
}

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
    return [...new Set(own.map((unit) => unit.faction))].map((faction) => {
        const path = draftCreatureContinuation(
            ownCreatureIds,
            knownOpponentCreatureIds,
            context,
            (unit) => unit.faction === faction,
        );
        const { count } = path;
        const nextThreshold = Math.min(6, 2 * (Math.floor(count / 2) + 1));
        return {
            ...path,
            faction,
            nextThreshold,
            reachable: path.maximumCount >= nextThreshold,
        };
    });
}

/** Find one minimal joint completion; independent reachable paths may compete for the same level's slots. */
export function draftFactionCompletion(
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    context: IDraftScoutingContext,
    goals: readonly IDraftFactionGoal[],
): IDraftFactionCompletion {
    const own = [...new Set(ownCreatureIds)].flatMap((id) => creatureInfo(id) ?? []);
    const targets = new Map<number, number>();
    for (const goal of goals) {
        if (
            !Number.isSafeInteger(goal.count) ||
            goal.count < 0 ||
            goal.count > 6 ||
            !Number.isSafeInteger(goal.faction) ||
            goal.faction < 1 ||
            goal.faction > 4
        ) {
            throw new RangeError("Draft faction goals require counts from 0 to 6 and factions from 1 to 4");
        }
        targets.set(goal.faction, Math.max(targets.get(goal.faction) ?? 0, goal.count));
    }
    const required = [...targets].flatMap(([faction, count]) =>
        Array.from(
            { length: Math.max(0, count - own.filter((unit) => unit.faction === faction).length) },
            () => faction,
        ),
    );
    const slots = draftFutureSlots(ownCreatureIds, knownOpponentCreatureIds, context);
    if (required.length > slots.reduce((sum, slot) => sum + slot.count, 0)) {
        return { reachable: false, creatureIds: [], uncertain: false };
    }
    const remaining = slots.map((slot) => slot.count);
    const chosen: number[] = [];
    const fill = (index: number): boolean => {
        if (index === required.length) return true;
        for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
            if (!remaining[slotIndex]) continue;
            const id = slots[slotIndex].creatureIds.find(
                (id) => !chosen.includes(id) && creatureInfo(id)?.faction === required[index],
            );
            if (id === undefined) continue;
            chosen.push(id);
            remaining[slotIndex]--;
            if (fill(index + 1)) return true;
            remaining[slotIndex]++;
            chosen.pop();
        }
        return false;
    };
    const reachable = fill(0);
    return {
        reachable,
        creatureIds: reachable ? chosen : [],
        uncertain: reachable && chosen.some((id) => !context.knownBanLevels.includes(creatureInfo(id)!.level)),
    };
}

export function draftContextAfterCreature(context: IDraftScoutingContext, creatureId: number): IDraftScoutingContext {
    const level = creatureInfo(creatureId)?.level;
    const index = context.remainingPickLevels.indexOf(level ?? 0);
    return { ...context, remainingPickLevels: context.remainingPickLevels.filter((_, slot) => slot !== index) };
}
