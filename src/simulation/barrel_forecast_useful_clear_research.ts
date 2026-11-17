/** Offline follow-up; importing it does not change any serving or native strategy. */
import type { IDecisionContext } from "../ai/ai_strategy";
import { friendlyShotBlockingBarrels } from "../ai/artifact_barrel_tactics";
import type { GameAction } from "../engine/actions";
import { getCellForPosition } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import { selectBarrelForecastIntent } from "./barrel_forecast_intent_research";

export const BARREL_FORECAST_USEFUL_CLEAR_RESEARCH_ID = "barrel-forecast-friendly-shot-clear-v1";

/**
 * The closed intent rule can leave future firing lanes blocked and change ordinary shot targeting.
 * Preserve native cleanup when its barrel intercepts an available friendly shot in the real engine.
 * Otherwise retain the earlier native intent using exactly the old eligibility and array identity.
 * This is a mechanistic forecast approximation, not a qualified strength or movement-route policy.
 */
export function selectBarrelForecastUsefulClear(
    unit: Unit,
    context: IDecisionContext,
    beforeCleanup: GameAction[],
    cleanup: GameAction[],
): GameAction[] {
    const intent = selectBarrelForecastIntent(unit, context, beforeCleanup, cleanup);
    if (intent === cleanup || !context.attackHandler) return cleanup;
    const strike = cleanup.find((action) => action.type === "obstacle_attack");
    if (!strike) return cleanup;
    const cell = getCellForPosition(context.grid.getSettings(), strike.targetPosition);
    const blocked = friendlyShotBlockingBarrels(
        unit.getTeam(),
        context.grid,
        context.unitsHolder,
        context.attackHandler,
    );
    return blocked.has(`${cell.x},${cell.y}`) ? cleanup : intent;
}
