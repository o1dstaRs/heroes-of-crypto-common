import { LIVE_PICK_PHASES } from "../../picks/pick_sim";
import { CreatureLevelList, CreatureLevelMap } from "../../units/unit_properties";
import {
    createDraftOpponentMemory,
    validDraftMemoryInput,
    type IDraftMemoryInput,
    type IDraftOpponentMemory,
} from "./draft_opponent_memory";

export const DRAFT_OPPONENT_OCCUPANCY_REVISION = "public-occupancy-count-v1";

/** Public pick order fixes enemy level counts. Bans/own/revealed enemies define the COMPLETE offer set. */
export function publicDraftOccupiedOfferCount(
    input: IDraftMemoryInput,
    visibleBannedCreatureIds: readonly number[],
): number | null {
    if (
        !validDraftMemoryInput(input) ||
        !Array.isArray(visibleBannedCreatureIds) ||
        new Set(visibleBannedCreatureIds).size !== visibleBannedCreatureIds.length ||
        [...visibleBannedCreatureIds, ...input.ownCreatureIds, ...input.knownOpponentCreatureIds].some(
            (id) => !Number.isSafeInteger(id) || !CreatureLevelMap[id],
        )
    )
        return null;
    const phase = LIVE_PICK_PHASES[input.phaseSequence];
    if (
        !phase ||
        input.phaseSequence < 2 ||
        phase.creatureLevel !== input.level ||
        !phase.actors.some((team) => team === input.ownTeam)
    )
        return null;
    const excluded = new Set([...visibleBannedCreatureIds, ...input.ownCreatureIds, ...input.knownOpponentCreatureIds]);
    const expected = CreatureLevelList[input.level].filter((id) => !excluded.has(id));
    if (
        expected.length !== input.availableCreatureIds.length ||
        expected.some((id) => !input.availableCreatureIds.includes(id))
    )
        return null;
    let enemyAtLevel = input.level <= 2 ? 1 : 0; // Both initial bundles have committed before any creature-pick phase.
    for (let index = 2; index < input.phaseSequence; index++) {
        const previous = LIVE_PICK_PHASES[index];
        if (previous.creatureLevel === input.level && previous.actors.some((team) => team !== input.ownTeam))
            enemyAtLevel++;
    }
    const hidden =
        enemyAtLevel - input.knownOpponentCreatureIds.filter((id) => CreatureLevelMap[id] === input.level).length;
    return hidden >= 0 && hidden <= expected.length && (input.doctrine !== 2 || hidden === 0) ? hidden : null;
}

/** Euclidean projection onto the public feasible set: 0 <= p <= 1 and sum(p) = hidden count. */
export function projectDraftOccupancy(probabilities: readonly number[], occupied: number): number[] {
    if (
        !probabilities.length ||
        !Number.isInteger(occupied) ||
        occupied < 0 ||
        occupied > probabilities.length ||
        probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
    )
        throw new Error("Invalid occupancy projection");
    if (occupied === 0) return probabilities.map(() => 0);
    if (occupied === probabilities.length) return probabilities.map(() => 1);
    let low = -1,
        high = 1;
    for (let iteration = 0; iteration < 60; iteration++) {
        const shift = (low + high) / 2;
        const sum = probabilities.reduce((total, p) => total + Math.max(0, Math.min(1, p + shift)), 0);
        if (sum < occupied) low = shift;
        else high = shift;
    }
    const shift = (low + high) / 2;
    return probabilities.map((p) => Math.max(0, Math.min(1, p + shift)));
}

/** Separate research revision: keeps the original fitted artifact and its validation results immutable. */
export function createFeasibleDraftOpponentMemory(model: IDraftOpponentMemory) {
    const predict = createDraftOpponentMemory(model);
    return (input: IDraftMemoryInput, visibleBannedCreatureIds: readonly number[]) => {
        const count = publicDraftOccupiedOfferCount(input, visibleBannedCreatureIds);
        const beliefs = count === null ? null : predict(input);
        if (!beliefs || count === null) return null;
        const projected = projectDraftOccupancy(
            beliefs.map((belief) => belief.occupiedProbability),
            count,
        );
        const projectedPrior = projectDraftOccupancy(
            beliefs.map((belief) => belief.priorProbability),
            count,
        );
        return {
            revision: DRAFT_OPPONENT_OCCUPANCY_REVISION,
            occupiedOffers: count,
            beliefs: beliefs.map((belief, index) => ({
                ...belief,
                unconstrainedProbability: belief.occupiedProbability,
                occupiedProbability: projected[index],
                feasiblePriorProbability: projectedPrior[index],
            })),
        };
    };
}
