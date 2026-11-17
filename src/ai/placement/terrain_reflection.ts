import { PBTypes } from "../../generated/protobuf/v1/types";
import { Grid } from "../../grid/grid";
import { getFootprintCellsForAnchor, getPositionForCells } from "../../grid/grid_math";
import type { GridSettings } from "../../grid/grid_settings";
import { PathHelper } from "../../grid/path_helper";
import { traceGridRayCells } from "../../grid/ray_traversal";
import { scatteredMountainsForSeed } from "../../grid/scattered_mountains";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";

/** Explicit user adoption; the original exploratory confidence gate remains failed. */
export const A19_TERRAIN_PLACEMENT_POLICY = Object.freeze({
    policyId: "public-terrain-formation-reflection-v1",
    adoptedByUser: true,
    registeredStrengthGatePassed: false,
    stage: "after-final-formation-before-artifact-barrels",
    information: "own-units-and-public-neutral-terrain",
    researchSourceSha256: "c45a89903c24ac44dacd49717825939b0907201f29a02963bb55ab8583c6ac1e",
});

export type TerrainPlacementUnit = Pick<
    Unit,
    | "getId"
    | "getName"
    | "getAmountAlive"
    | "getFootprintWidth"
    | "getFootprintHeight"
    | "getAttackType"
    | "canFly"
    | "isSmallSize"
    | "canTraverseLava"
    | "hasAbilityActive"
>;

export interface TerrainPlacementContext {
    team: number;
    gridType: number;
    gridSettings: GridSettings;
    sideOrientedPlacement: boolean;
    legalCellHashes: ReadonlySet<number>;
    /** Public game id used by the canonical scattered-barrel generator, never a hidden setup seed. */
    publicMapSeed: string;
}

export interface TerrainPlacementChoice {
    positions: Map<string, XY>;
    changed: boolean;
    baselineCost?: number;
    reflectedCost?: number;
}

const key = (cell: XY): number => (cell.x << 4) | cell.y;

/**
 * The tested vertical reflection, after splitting/learned setup and before own deployment barrels.
 * Call during placement with this match's FightStateManager bound, as required by the native pathfinder.
 * No live grid, enemy objects, hidden deployment, or mutable model inputs cross this boundary.
 */
export function chooseA19TerrainPlacement(
    units: readonly TerrainPlacementUnit[],
    context: TerrainPlacementContext,
    incumbent: ReadonlyMap<string, XY>,
): TerrainPlacementChoice {
    const fallback = (): TerrainPlacementChoice => ({
        positions: new Map([...incumbent].map(([id, cell]) => [id, { ...cell }])),
        changed: false,
    });
    if (
        context.gridType !== PBTypes.GridVals.BLOCK_CENTER ||
        context.gridSettings.getGridSize() !== 16 ||
        !context.sideOrientedPlacement ||
        ![PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT].includes(context.team) ||
        !context.publicMapSeed ||
        !units.length ||
        units.length !== incumbent.size ||
        new Set(units.map((unit) => unit.getId())).size !== units.length
    )
        return fallback();

    const bodies = units.map((unit) => {
        const id = creatureIdForName(unit.getName());
        return {
            width: unit.getFootprintWidth(),
            height: unit.getFootprintHeight(),
            amount: unit.getAmountAlive(),
            info: id === undefined ? undefined : creatureInfo(id),
        };
    });
    if (
        bodies.some(
            (body) =>
                !body.info ||
                !Number.isInteger(body.amount) ||
                body.amount < 1 ||
                !Number.isInteger(body.width) ||
                !Number.isInteger(body.height) ||
                body.width < 1 ||
                body.height < 1,
        )
    )
        return fallback();

    const positions = units.map((unit) => incumbent.get(unit.getId()));
    if (positions.some((cell) => !cell)) return fallback();
    const original = positions as XY[];
    const reflected = original.map((cell, index) => ({
        x: cell.x,
        y: 15 - cell.y + bodies[index].height - 1,
    }));
    const neutral = scatteredMountainsForSeed(context.publicMapSeed).map((stone) => stone.cell);
    const blocked = new Set(neutral.map(key));
    const cells = (index: number, anchor: XY): XY[] =>
        getFootprintCellsForAnchor(anchor, bodies[index].width, bodies[index].height);
    const valid = (anchors: readonly XY[]): boolean => {
        const occupied = new Set<number>();
        for (let index = 0; index < anchors.length; index++) {
            const anchor = anchors[index];
            if (!Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) return false;
            for (const cell of cells(index, anchor)) {
                const hash = key(cell);
                if (
                    cell.x < 0 ||
                    cell.x >= 16 ||
                    cell.y < 0 ||
                    cell.y >= 16 ||
                    !context.legalCellHashes.has(hash) ||
                    blocked.has(hash) ||
                    occupied.has(hash)
                )
                    return false;
                occupied.add(hash);
            }
        }
        return true;
    };
    if (!valid(original) || !valid(reflected)) return fallback();

    const grid = new Grid(context.gridSettings, PBTypes.GridVals.BLOCK_CENTER);
    grid.setScatteredMountains(neutral);
    const matrix = grid.getMatrixNoUnits();
    const pathHelper = new PathHelper(context.gridSettings);
    const score = (anchors: readonly XY[]): number => {
        let cost = 0;
        for (let index = 0; index < units.length; index++) {
            const unit = units[index],
                anchor = anchors[index],
                body = bodies[index],
                info = body.info!;
            const weight = (body.amount * info.exp) / 1000;
            if (unit.getAttackType() === PBTypes.AttackVals.RANGE) {
                const origin = getPositionForCells(context.gridSettings, cells(index, anchor))!;
                let blockedRays = 0;
                for (let y = 1; y <= 14; y++) {
                    const target = getPositionForCells(context.gridSettings, [{ x: context.team === 2 ? 12 : 3, y }])!;
                    if (
                        traceGridRayCells(context.gridSettings, origin, target).some(([cell]) => blocked.has(key(cell)))
                    )
                        blockedRays++;
                }
                cost += (weight * blockedRays) / 14;
            } else if (
                !unit.canFly() &&
                !info.nativeSpellbook &&
                [PBTypes.AttackVals.MELEE, PBTypes.AttackVals.MELEE_MAGIC].includes(unit.getAttackType())
            ) {
                const targetX = context.team === 2 ? 9 + body.width : 5;
                const routes = pathHelper.getMovePath(
                    anchor,
                    matrix,
                    32,
                    undefined,
                    false,
                    unit.isSmallSize(),
                    unit.canTraverseLava(),
                    unit.hasAbilityActive("In Its Own World"),
                    body.width,
                    body.height,
                ).knownPaths;
                let shortest = Infinity;
                for (const alternatives of routes.values())
                    for (const route of alternatives)
                        if (route.cell.x === targetX) shortest = Math.min(shortest, route.weight);
                const detour = Number.isFinite(shortest) ? Math.max(0, shortest - Math.abs(targetX - anchor.x)) : 16;
                cost += (weight * detour) / 4;
            }
        }
        return cost;
    };
    const baselineCost = score(original),
        reflectedCost = score(reflected);
    if (!Number.isFinite(baselineCost) || !Number.isFinite(reflectedCost)) return fallback();
    const changed = reflectedCost < baselineCost - 1e-9;
    return {
        positions: new Map(
            units.map((unit, index) => [unit.getId(), { ...(changed ? reflected[index] : original[index]) }]),
        ),
        changed,
        baselineCost,
        reflectedCost,
    };
}
