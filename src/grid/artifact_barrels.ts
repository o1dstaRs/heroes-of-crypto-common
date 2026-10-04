import { ARTIFACT_POWER, Tier1Artifact } from "../artifacts/artifact_properties";
import type { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { XY } from "../utils/math";
import { Grid } from "./grid";
import { PlacementPositionType, PlacementType } from "./placement_properties";
import { RectanglePlacement } from "./rectangle_placement";
import { SquarePlacement } from "./square_placement";

export function artifactBarrelPlacementCells(grid: Grid, fp: FightProperties, team: TeamType): XY[] {
    if (team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT) return [];
    const positions =
        team === PBTypes.TeamVals.LEFT
            ? [PlacementPositionType.LEFT_BOTTOM, PlacementPositionType.LEFT_TOP]
            : [PlacementPositionType.RIGHT_TOP, PlacementPositionType.RIGHT_BOTTOM];
    const sizes = fp.getAugmentPlacement(team);
    return sizes.flatMap((size, index) => {
        const placement =
            fp.getPlacementType() === PlacementType.RECTANGLE
                ? new RectanglePlacement(grid.getSettings(), positions[0], size, fp.isSideOrientedPlacement())
                : new SquarePlacement(grid.getSettings(), positions[index], size);
        return placement.possibleCellPositions();
    });
}

/** Keep placed barrels legal when artifacts or deployment augments change. */
export function reconcileArtifactBarrels(
    grid: Grid,
    fp: FightProperties,
    team: TeamType,
    allowed?: (cell: XY) => boolean,
): void {
    if (!fp.hasArtifactTier1(team, Tier1Artifact.BARREL_BARRICADE)) {
        grid.clearArtifactBarrels(team);
        return;
    }
    const cells = allowed ? [] : artifactBarrelPlacementCells(grid, fp, team);
    for (const barrel of grid.getArtifactBarrels(team)) {
        if (
            !(allowed
                ? allowed(barrel.cell)
                : cells.some((cell) => cell.x === barrel.cell.x && cell.y === barrel.cell.y))
        ) {
            grid.unplaceArtifactBarrel(team, barrel.index);
        }
    }
}

/** AI and Ready auto-fill missing slots after creatures have been placed. Human positions are retained. */
export function autoPlaceArtifactBarrels(
    grid: Grid,
    fp: FightProperties,
    team: TeamType,
    allowedCells?: readonly XY[],
): void {
    if (!fp.hasArtifactTier1(team, Tier1Artifact.BARREL_BARRICADE)) return;
    const cells = [...(allowedCells ?? artifactBarrelPlacementCells(grid, fp, team))];
    // Favor the inward deployment edge, separating the two barrels so they do not form a wall around a stack.
    const side = fp.isSideOrientedPlacement();
    cells.sort(
        (a, b) => (team === PBTypes.TeamVals.LEFT ? -1 : 1) * (side ? a.x - b.x : a.y - b.y) || a.x - b.x || a.y - b.y,
    );
    for (let index = 0; index < ARTIFACT_POWER.BARREL_BARRICADE_COUNT; index++) {
        if (grid.getArtifactBarrels(team).some((barrel) => barrel.index === index)) continue;
        const placed = grid.getArtifactBarrels(team);
        const target =
            cells.find(
                (cell) =>
                    grid.areAllCellsEmpty([cell]) &&
                    placed.every(
                        (barrel) => Math.max(Math.abs(barrel.cell.x - cell.x), Math.abs(barrel.cell.y - cell.y)) > 1,
                    ),
            ) ?? cells.find((cell) => grid.areAllCellsEmpty([cell]));
        if (target) grid.placeArtifactBarrel(team, index, target);
    }
}
