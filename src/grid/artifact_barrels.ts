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

/** Reserve an adjacent pair during deployment, keeping any positions the player has chosen. */
export function autoPlaceArtifactBarrels(
    grid: Grid,
    fp: FightProperties,
    team: TeamType,
    allowedCells?: readonly XY[],
): void {
    if (fp.hasFightStarted() || fp.hasFightFinished() || !fp.hasArtifactTier1(team, Tier1Artifact.BARREL_BARRICADE))
        return;
    const cells = [...(allowedCells ?? artifactBarrelPlacementCells(grid, fp, team))];
    // Favor the inward deployment edge, with two orthogonally adjacent free cells whenever possible.
    const side = fp.isSideOrientedPlacement();
    cells.sort(
        (a, b) => (team === PBTypes.TeamVals.LEFT ? -1 : 1) * (side ? a.x - b.x : a.y - b.y) || a.x - b.x || a.y - b.y,
    );
    for (let index = 0; index < ARTIFACT_POWER.BARREL_BARRICADE_COUNT; index++) {
        if (grid.getArtifactBarrels(team).some((barrel) => barrel.index === index)) continue;
        const placed = grid.getArtifactBarrels(team);
        const free = cells.filter((cell) => grid.areAllCellsEmpty([cell]));
        const adjacent = (a: XY, b: XY) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
        const target = placed.length
            ? (free.find((cell) => placed.some((barrel) => adjacent(barrel.cell, cell))) ?? free[0])
            : (free.find((cell) => free.some((other) => adjacent(cell, other))) ?? free[0]);
        if (target) grid.placeArtifactBarrel(team, index, target);
    }
}
