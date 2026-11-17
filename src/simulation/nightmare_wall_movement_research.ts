/** Offline coverage experiment; no serving profile imports this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { Unit } from "../units/unit";
import type { proposeNightmareGroundWall } from "./nightmare_ground_wall_research";

export const NIGHTMARE_WALL_MOVEMENT_RESEARCH_ID = "nightmare-wall-movement-coverage-v1";

const isPureMove = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.length === 1 && candidate.actions[0].type === "move_unit";

/**
 * Immediate spell leaves can crowd every movement option out of H64/R2. When the immutable ground-wall
 * proposal exists, preserve its complete comparison set and append the best finite native leaf move
 * only if no pure move survived. Reuse the real catalog and already-computed leaf evidence: no new
 * route, geometry proxy, RNG draw, invented score or forced selection. Stable ties use catalog order.
 */
export function reserveNightmareWallMovement(
    unit: Unit,
    context: Pick<IDecisionContext, "decisionOrigin">,
    catalog: readonly IEnumeratedCandidate[],
    retained: readonly IEnumeratedCandidate[],
    leafMeans: readonly number[] | undefined,
    originalWall: ReturnType<typeof proposeNightmareGroundWall>,
): readonly IEnumeratedCandidate[] {
    if (
        context.decisionOrigin !== "root" ||
        unit.getName() !== "Nightmare" ||
        unit.isDead() ||
        !originalWall ||
        retained.some(isPureMove) ||
        !leafMeans ||
        leafMeans.length !== catalog.length
    )
        return retained;

    let best: IEnumeratedCandidate | undefined;
    let bestMean = -Infinity;
    for (let index = 0; index < catalog.length; index++) {
        const candidate = catalog[index];
        const action = candidate.actions[0];
        const mean = leafMeans[index];
        if (
            !isPureMove(candidate) ||
            action.type !== "move_unit" ||
            action.unitId !== unit.getId() ||
            !Number.isFinite(mean) ||
            mean <= bestMean
        )
            continue;
        best = candidate;
        bestMean = mean;
    }
    return best ? [...retained, best] : retained;
}
