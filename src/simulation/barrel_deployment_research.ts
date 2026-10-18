import type { IGameActionEngineContext } from "../engine/action_engine";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { artifactBarrelPlacementCells } from "../grid/artifact_barrels";
import { getPositionForCells } from "../grid/grid_math";

/** Experimental opponent formation only; never called by the barrel policy or a shipped strategy. */
export function mirrorBarrelStudyDeployment(
    context: Pick<IGameActionEngineContext, "grid" | "fightProperties" | "unitsHolder">,
    team: TeamType,
): boolean {
    const { grid, fightProperties, unitsHolder } = context;
    const units = unitsHolder.getAllAllies(team).filter((unit) => !unit.isDead());
    const ownIds = new Set(units.map((unit) => unit.getId()));
    const allowed = new Set(
        artifactBarrelPlacementCells(grid, fightProperties, team).map((cell) => `${cell.x},${cell.y}`),
    );
    const size = grid.getSettings().getGridSize();
    const side = fightProperties.isSideOrientedPlacement();
    const plans = units.map((unit) => {
        const cells = unit
            .getCells()
            .map((cell) => (side ? { x: cell.x, y: size - 1 - cell.y } : { x: size - 1 - cell.x, y: cell.y }));
        return { unit, cells, position: getPositionForCells(grid.getSettings(), cells) };
    });
    if (
        plans.some(
            (plan) =>
                !plan.position ||
                plan.cells.some((cell) => {
                    const occupant = grid.getOccupantUnitId(cell);
                    return !allowed.has(`${cell.x},${cell.y}`) || (!!occupant && !ownIds.has(occupant));
                }),
        )
    )
        return false;
    for (const { unit } of plans) grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
    for (const { unit, cells, position } of plans) {
        unit.setPosition(position!.x, position!.y);
        if (
            !grid.occupyCells(
                cells,
                unit.getId(),
                team,
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            )
        )
            throw new Error("Invalid mirrored research formation");
    }
    return true;
}
