/** Offline forecast experiment; importing this helper installs no strategy or search hooks. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getCellForPosition } from "../grid/grid_math";
import type { Unit } from "../units/unit";

export const BARREL_FORECAST_INTENT_RESEARCH_ID = "barrel-forecast-native-intent-v1";

/**
 * Approximate future searched turns by retaining the native movement/hold intent before cemetery
 * cleanup. Only projected melee deployment-barrel fallbacks are affected, for either army or owner.
 * Live roots, explicit combat, deliberately planned clears, shooters and neutral stones stay native.
 * This is a forecast hypothesis, not a claim that the earlier native intent equals actual A19 play.
 */
export function selectBarrelForecastIntent(
    unit: Unit,
    context: IDecisionContext,
    beforeCleanup: GameAction[],
    cleanup: GameAction[],
): GameAction[] {
    if (
        context.decisionOrigin !== "rollout" ||
        unit.getAttackTypeSelection() === PBTypes.AttackVals.RANGE ||
        beforeCleanup === cleanup ||
        beforeCleanup.some((action) =>
            ["melee_attack", "range_attack", "area_throw_attack", "cast_spell", "obstacle_attack"].includes(
                action.type,
            ),
        ) ||
        !beforeCleanup.some((action) => ["move_unit", "wait_turn", "defend_turn"].includes(action.type))
    )
        return cleanup;
    const strike = cleanup.find((action) => action.type === "obstacle_attack");
    if (!strike || strike.attackerId !== unit.getId()) return cleanup;
    const cell = getCellForPosition(context.grid.getSettings(), strike.targetPosition);
    return context.grid.getArtifactBarrels().some((barrel) => barrel.cell.x === cell.x && barrel.cell.y === cell.y)
        ? beforeCleanup
        : cleanup;
}
