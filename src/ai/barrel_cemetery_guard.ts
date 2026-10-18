import type { IDecisionContext } from "./ai_strategy";
import type { GameAction } from "../engine/actions";
import { getCellForPosition } from "../grid/grid_math";
import type { Unit } from "../units/unit";

/**
 * Research only: the neutral cemetery cleanup fallback must not replace an existing turn with an own
 * deployment-barrel strike. Deliberate earlier barrel plans and search's barrel challengers stay available.
 * This compares native policy boundaries, not post-search actions, and performs no enumeration or mutation.
 */
export function preserveOwnBarrelCemeteryFallback(
    unit: Unit,
    context: IDecisionContext,
    beforeCleanup: GameAction[],
    cleanup: GameAction[],
): GameAction[] {
    if (beforeCleanup.some((action) => action.type === "obstacle_attack")) return cleanup;
    const strike = cleanup.find((action) => action.type === "obstacle_attack");
    if (!strike || strike.attackerId !== unit.getId()) return cleanup;
    const cell = getCellForPosition(context.grid.getSettings(), strike.targetPosition);
    return context.grid
        .getArtifactBarrels(unit.getTeam())
        .some((barrel) => barrel.cell.x === cell.x && barrel.cell.y === cell.y)
        ? beforeCleanup
        : cleanup;
}
