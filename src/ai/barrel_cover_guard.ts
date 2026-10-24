import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getCellForPosition } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { IDecisionContext } from "./ai_strategy";
import { projectBarrelShotTradeoff } from "./artifact_barrel_tactics";
import { findBestLegalStationaryRangeAttack } from "./candidates";

/**
 * Research candidate: keep an owned screen and take an already-available shot when breaking that screen
 * improves no friendly stack's best legal shot. Movement/clearing plans and enemy barrels stay untouched.
 * Uses the real aim enumerator and a read-only counterfactual; it never edits terrain or consumes RNG.
 */
export function productiveBarrelCoverAlternative(
    unit: Unit,
    context: IDecisionContext,
    actions: readonly GameAction[],
): GameAction[] | undefined {
    const attacks = actions.filter((action) => action.type === "obstacle_attack");
    if (
        attacks.length !== 1 ||
        actions.some((action) => action.type !== "obstacle_attack" && action.type !== "select_attack_type")
    )
        return undefined;
    const attack = attacks[0];
    const base = unit.getBaseCell();
    if (
        attack.attackerId !== unit.getId() ||
        attack.path?.length ||
        (attack.attackFrom && (attack.attackFrom.x !== base.x || attack.attackFrom.y !== base.y))
    )
        return undefined;
    const cell = getCellForPosition(context.grid.getSettings(), attack.targetPosition);
    if (
        !context.grid
            .getArtifactBarrels(unit.getTeam())
            .some((barrel) => barrel.cell.x === cell.x && barrel.cell.y === cell.y)
    )
        return undefined;
    const shot = findBestLegalStationaryRangeAttack(unit, context);
    if (!shot || shot.expectedDamage <= 0) return undefined;
    const tradeoff = projectBarrelShotTradeoff(context, cell);
    if (!tradeoff || tradeoff.some((row) => row.team === unit.getTeam() && row.gain > 1e-9)) return undefined;
    return [
        ...(unit.getAttackTypeSelection() === PBTypes.AttackVals.RANGE
            ? []
            : [{ type: "select_attack_type" as const, unitId: unit.getId(), attackType: PBTypes.AttackVals.RANGE }]),
        {
            type: "range_attack",
            attackerId: unit.getId(),
            targetId: shot.aimTargetId,
            aimCell: { ...shot.aimCell },
            aimSide: shot.aimSide,
        },
    ];
}
