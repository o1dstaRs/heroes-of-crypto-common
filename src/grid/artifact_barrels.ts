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

/**
 * A barrel on a shooter's file, between that shooter and the enemy, blocks the shot until it dies.
 * `shooterCells` are friendly ranged footprints. Omit them to keep the historical inward-edge order.
 */
function barrelBlocksShooter(cell: XY, shooterCells: readonly XY[], team: TeamType, side: boolean): boolean {
    for (const shooter of shooterCells) {
        if (side) {
            if (cell.y !== shooter.y) continue;
            if (team === PBTypes.TeamVals.LEFT ? cell.x > shooter.x : cell.x < shooter.x) return true;
        } else if (cell.x === shooter.x && (team === PBTypes.TeamVals.LEFT ? cell.y > shooter.y : cell.y < shooter.y)) {
            return true;
        }
    }
    return false;
}

/**
 * Lower is a better screen: a neighboring file just in front of a shooter, not a cell behind the army
 * and not the far end of the deployment edge.
 */
function barrelScreenRank(cell: XY, shooterCells: readonly XY[], team: TeamType, side: boolean): number {
    if (shooterCells.length === 0) return 0;
    let best = Number.POSITIVE_INFINITY;
    for (const shooter of shooterCells) {
        const cross = side ? Math.abs(cell.y - shooter.y) : Math.abs(cell.x - shooter.x);
        const inward = side
            ? team === PBTypes.TeamVals.LEFT
                ? cell.x - shooter.x
                : shooter.x - cell.x
            : team === PBTypes.TeamVals.LEFT
              ? cell.y - shooter.y
              : shooter.y - cell.y;
        const rank = (inward < 0 ? 100 : 0) + cross * 2 + Math.max(0, inward - 1);
        if (rank < best) best = rank;
    }
    return best;
}

/** Reserve an adjacent pair during deployment, keeping any positions the player has chosen. */
export function autoPlaceArtifactBarrels(
    grid: Grid,
    fp: FightProperties,
    team: TeamType,
    allowedCells?: readonly XY[],
    shooterCells?: readonly XY[],
): void {
    if (fp.hasFightStarted() || fp.hasFightFinished() || !fp.hasArtifactTier1(team, Tier1Artifact.BARREL_BARRICADE))
        return;
    const cells = [...(allowedCells ?? artifactBarrelPlacementCells(grid, fp, team))];
    // Favor a screen beside the shooters, on the inward edge, and never on a friendly shot file.
    // With no shooters the order stays the historical inward edge.
    const side = fp.isSideOrientedPlacement();
    const shooters = shooterCells ?? [];
    cells.sort(
        (a, b) =>
            (barrelBlocksShooter(a, shooters, team, side) ? 1 : 0) -
                (barrelBlocksShooter(b, shooters, team, side) ? 1 : 0) ||
            barrelScreenRank(a, shooters, team, side) - barrelScreenRank(b, shooters, team, side) ||
            (team === PBTypes.TeamVals.LEFT ? -1 : 1) * (side ? a.x - b.x : a.y - b.y) ||
            a.x - b.x ||
            a.y - b.y,
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
