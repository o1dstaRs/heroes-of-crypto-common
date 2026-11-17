/** Offline research only. No serving profile imports this selector. */
import type { GameAction } from "../engine/actions";

export const PEASANT_FOLLOWTHROUGH_RESEARCH_ID = "peasant-same-kill-followthrough-v1";

export interface IPeasantFollowthroughSample {
    readonly repeat: number;
    readonly targetId: string;
    readonly targetDead: boolean;
    readonly cheapResponse: boolean;
    /** Matched immediate HP, bodies, armor, steps, Bitter stacks and response-price projection. */
    readonly immediateKey: string;
    /** Every other surviving unit's public combat state, including position and effects. */
    readonly othersKey: string;
    readonly backlineDistance: number;
    readonly adjacentEnemies: readonly string[];
}

export interface IPeasantFollowthroughCandidate {
    readonly actions: readonly GameAction[];
    readonly mean: number;
    readonly samples: readonly IPeasantFollowthroughSample[];
}

/** One ordinary same-target strike, optionally after one explicit terrain-safe move. */
function targetOf(actions: readonly GameAction[]): string | undefined {
    let moves = 0;
    let target: string | undefined;
    let actor: string | undefined;
    for (const action of actions) {
        if (action.type === "select_attack_type") {
            if (target || (actor && actor !== action.unitId)) return undefined;
            actor = action.unitId;
        } else if (action.type === "move_unit") {
            if (
                target ||
                ++moves > 1 ||
                !action.path.length ||
                action.hasLavaCell ||
                action.hasWaterCell ||
                (actor && actor !== action.unitId)
            )
                return undefined;
            actor = action.unitId;
        } else if (action.type === "melee_attack") {
            if (target || action.path?.length || (actor && actor !== action.attackerId)) return undefined;
            actor = action.attackerId;
            target = action.targetId;
        } else return undefined;
    }
    return target;
}

/**
 * Compare only already-complete R2 primary ties, after the ordinary material/intent selection and
 * before the unchanged final neural correction. No candidate insertion, extra rollout or score bonus.
 * Both paired root samples must kill the same target for the same cheap response and immediate state.
 * Require at least one cell of Euclidean approach to remaining visible ranged/damage-spell output in
 * BOTH samples, without becoming adjacent to an additional enemy. This is a geometric heuristic,
 * not a claim of safe next-turn reach. Unknown, partial or inconsistent evidence retains the original.
 */
export function selectPeasantFollowthrough(
    candidates: readonly IPeasantFollowthroughCandidate[],
    selected: number,
): number {
    if (!Number.isInteger(selected) || selected < 0 || selected >= candidates.length) return selected;
    const baseline = candidates[selected];
    const target = targetOf(baseline.actions);
    const complete = (candidate: IPeasantFollowthroughCandidate): boolean =>
        candidate.samples.length === 2 &&
        candidate.samples[0].repeat === 0 &&
        candidate.samples[1].repeat === 1 &&
        candidate.samples.every(
            (sample) =>
                sample.targetId === target &&
                sample.targetDead &&
                sample.cheapResponse &&
                !!sample.immediateKey &&
                !!sample.othersKey &&
                Number.isFinite(sample.backlineDistance) &&
                sample.backlineDistance >= 0,
        );
    if (
        !target ||
        !Number.isFinite(baseline.mean) ||
        baseline.mean !== Math.max(...candidates.map((candidate) => candidate.mean).filter(Number.isFinite)) ||
        !complete(baseline)
    )
        return selected;
    let best = selected;
    let bestDistance = Infinity;
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (
            index === selected ||
            candidate.mean !== baseline.mean ||
            targetOf(candidate.actions) !== target ||
            !complete(candidate)
        )
            continue;
        const safeComparison = candidate.samples.every((sample, repeat) => {
            const original = baseline.samples[repeat];
            return (
                sample.immediateKey === original.immediateKey &&
                sample.othersKey === original.othersKey &&
                original.backlineDistance - sample.backlineDistance >= 1 &&
                sample.adjacentEnemies.every((id) => original.adjacentEnemies.includes(id))
            );
        });
        if (!safeComparison) continue;
        const distance = candidate.samples.reduce((sum, sample) => sum + sample.backlineDistance, 0) / 2;
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    }
    return best;
}
