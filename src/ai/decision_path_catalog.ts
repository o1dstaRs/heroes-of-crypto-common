/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { PBTypes } from "../generated/protobuf/v1/types";
import { Grid } from "../grid/grid";
import type { IMovePath, IReadonlyMovePath } from "../grid/path_definitions";
import { PathHelper } from "../grid/path_helper";
import { Unit, type IUnitAIRepr } from "../units/unit";
import type { XY } from "../utils/math";

const BASE_GET_MOVE_PATH = PathHelper.prototype.getMovePath;
const BASE_GET_NEIGHBOR_CELLS = PathHelper.prototype.getNeighborCells;
const BASE_CAPTURE_ROUTE = (
    PathHelper.prototype as unknown as {
        captureRoute: unknown;
    }
).captureRoute;
const BASE_FILTER_UNALLOWED_DESTINATIONS = (
    PathHelper.prototype as unknown as {
        filterUnallowedDestinations: unknown;
    }
).filterUnallowedDestinations;
const BASE_UNIT_GET_CELLS = Unit.prototype.getCells;
const BASE_UNIT_GET_POSITION = Unit.prototype.getPosition;
const BASE_UNIT_IS_SMALL_SIZE = Unit.prototype.isSmallSize;
const BASE_UNIT_GET_STEPS = Unit.prototype.getSteps;
const BASE_UNIT_GET_TEAM = Unit.prototype.getTeam;
const BASE_UNIT_CAN_FLY = Unit.prototype.canFly;
const BASE_UNIT_CAN_TRAVERSE_LAVA = Unit.prototype.canTraverseLava;
const BASE_UNIT_HAS_ABILITY_ACTIVE = Unit.prototype.hasAbilityActive;
const BASE_GRID_GET_AGGR_MATRIX_BY_TEAM = Grid.prototype.getAggrMatrixByTeam;

export type { IReadonlyKnownPaths, IReadonlyMovePath, IReadonlyWeightedRoute } from "../grid/path_definitions";

export interface IDecisionPathSource {
    getMovePath(
        currentCell: XY,
        matrix: number[][],
        maxSteps: number,
        aggrBoard?: number[][],
        canFly?: boolean,
        isSmallUnit?: boolean,
        isMadeOfFire?: boolean,
        hasVineStride?: boolean,
        footprintWidth?: number,
        footprintHeight?: number,
    ): IReadonlyMovePath;
}

export interface IDecisionPathCatalogStats {
    requests: number;
    hits: number;
    misses: number;
    bypasses: number;
}

interface ICanonicalMovePathInput {
    currentCell: XY;
    matrix: number[][];
    maxSteps: number;
    aggrBoard?: number[][];
    canFly: boolean;
    isSmallUnit: boolean;
    isMadeOfFire: boolean;
    // Part of the cache key: a vine strider walks the same board at different prices, so it must not be
    // served a path canonicalised for a unit without the passive.
    hasVineStride: boolean;
    footprintWidth: number;
    footprintHeight: number;
}

/**
 * One shared, read-only canonical path for exactly one synchronous AI decision.
 *
 * Public PathHelper retains its fresh mutable-result contract. This separate catalog is attached only to
 * internal AI decision contexts; callers see a deep-readonly view and must not retain it. BattleEngine creates
 * one for a searched incumbent, SearchDriver may claim that exact root once for candidate enumeration, and
 * every rollout turn receives a new catalog after the prior apply/restore edge.
 *
 * Reuse cannot skip RNG on the conservative production gate: valid 16x16 packed neighbors are unique and
 * marked visited immediately after enqueue, so captureRoute never sees an existing key and its random tie branch
 * is unreachable. Custom helpers, malformed anchors, and non-production grids always delegate without caching.
 */
export class DecisionPathCatalog implements IDecisionPathSource {
    readonly #canonicalDecisionBrand = true;
    private readonly cacheSafe: boolean;
    private cached: IMovePath | undefined;
    private rootClaimed = false;
    private readonly stats: IDecisionPathCatalogStats | undefined;
    private constructor(
        private readonly grid: Grid,
        private readonly delegate: PathHelper,
        private readonly unit: Unit,
        private readonly canonical: ICanonicalMovePathInput,
        collectStats: boolean,
    ) {
        this.stats = collectStats ? { requests: 0, hits: 0, misses: 0, bypasses: 0 } : undefined;
        const minimumAnchorX = canonical.footprintWidth - 1;
        const minimumAnchorY = canonical.footprintHeight - 1;
        this.cacheSafe =
            Object.getPrototypeOf(delegate) === PathHelper.prototype &&
            delegate.getMovePath === BASE_GET_MOVE_PATH &&
            delegate.getNeighborCells === BASE_GET_NEIGHBOR_CELLS &&
            (delegate as unknown as { captureRoute: unknown }).captureRoute === BASE_CAPTURE_ROUTE &&
            (delegate as unknown as { filterUnallowedDestinations: unknown }).filterUnallowedDestinations ===
                BASE_FILTER_UNALLOWED_DESTINATIONS &&
            (delegate as unknown as { gridSettings: unknown }).gridSettings === grid.getSettings() &&
            grid.getSettings().getGridSize() === 16 &&
            isProductionBoard(canonical.matrix) &&
            canonical.aggrBoard !== undefined &&
            isProductionBoard(canonical.aggrBoard) &&
            Number.isInteger(canonical.currentCell.x) &&
            Number.isInteger(canonical.currentCell.y) &&
            !Object.is(canonical.currentCell.x, -0) &&
            !Object.is(canonical.currentCell.y, -0) &&
            canonical.currentCell.x >= minimumAnchorX &&
            canonical.currentCell.x < 16 &&
            canonical.currentCell.y >= minimumAnchorY &&
            canonical.currentCell.y < 16 &&
            Number.isFinite(canonical.maxSteps) &&
            canonical.maxSteps >= 0 &&
            !Object.is(canonical.maxSteps, -0);
    }
    public static create(
        grid: Grid,
        delegate: PathHelper,
        unit: Unit,
        matrix: number[][],
        collectStats = false,
    ): DecisionPathCatalog {
        return new DecisionPathCatalog(grid, delegate, unit, canonicalInput(grid, unit, matrix), collectStats);
    }
    /**
     * Authorize an optimization that observes only the distance-one melee target layer.
     *
     * The private brand check is intentionally first: structural lookalikes and Proxy-wrapped catalogs fail
     * closed without any property access. The remaining identity checks constrain the optimization to the
     * exact production decision epoch and native Unit footprint methods used to create this catalog.
     */
    public static canElideUnconsumedMeleeLayers(
        source: IDecisionPathSource,
        grid: Grid,
        unit: IUnitAIRepr,
        matrix: number[][],
    ): boolean {
        if (typeof source !== "object" || source === null || !(#canonicalDecisionBrand in source)) {
            return false;
        }
        return (
            source.cacheSafe &&
            source.grid === grid &&
            source.unit === unit &&
            source.canonical.matrix === matrix &&
            unit.getCells === BASE_UNIT_GET_CELLS &&
            unit.isSmallSize === BASE_UNIT_IS_SMALL_SIZE &&
            (unit as IUnitAIRepr & Pick<Unit, "getPosition">).getPosition === BASE_UNIT_GET_POSITION
        );
    }
    /**
     * Authorize deferring the canonical finite path until a decision actually consumes it.
     *
     * In addition to the branded native traversal proof, every getter whose second evaluation would be skipped
     * must be the native side-effect-free implementation. Instance overrides therefore retain the legacy eager
     * call order, thrown errors, and RNG behavior even if the rest of their object happens to look production-like.
     */
    public static canDeferCanonicalMovePath(
        source: IDecisionPathSource,
        grid: Grid,
        unit: IUnitAIRepr,
        matrix: number[][],
    ): boolean {
        return (
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(source, grid, unit, matrix) &&
            grid.getAggrMatrixByTeam === BASE_GRID_GET_AGGR_MATRIX_BY_TEAM &&
            unit.getSteps === BASE_UNIT_GET_STEPS &&
            unit.getTeam === BASE_UNIT_GET_TEAM &&
            unit.canFly === BASE_UNIT_CAN_FLY &&
            unit.isSmallSize === BASE_UNIT_IS_SMALL_SIZE &&
            unit.canTraverseLava === BASE_UNIT_CAN_TRAVERSE_LAVA &&
            unit.hasAbilityActive === BASE_UNIT_HAS_ABILITY_ACTIVE
        );
    }
    public getStats(): IDecisionPathCatalogStats {
        return this.stats ? { ...this.stats } : { requests: 0, hits: 0, misses: 0, bypasses: 0 };
    }
    /**
     * Authorize the sole production hand-off from incumbent policy to root enumeration. A retained context
     * cannot be shared by a later/repeated decision because the first claim consumes this epoch.
     */
    public claimRootShare(delegate: PathHelper, unit: Unit, matrix: number[][]): boolean {
        if (
            this.rootClaimed ||
            delegate !== this.delegate ||
            unit !== this.unit ||
            matrix !== this.canonical.matrix ||
            !sameCanonicalInput(this.canonical, canonicalInput(this.grid, unit, matrix))
        ) {
            return false;
        }
        this.rootClaimed = true;
        return true;
    }
    public getMovePath(
        currentCell: XY,
        matrix: number[][],
        maxSteps: number,
        aggrBoard?: number[][],
        canFly = false,
        isSmallUnit = true,
        isMadeOfFire = false,
        hasVineStride = false,
        footprintWidth = isSmallUnit ? 1 : 2,
        footprintHeight = isSmallUnit ? 1 : 2,
    ): IReadonlyMovePath {
        if (this.stats) this.stats.requests++;
        if (
            !this.cacheSafe ||
            !matchesCanonicalRequest(
                this.canonical,
                currentCell,
                matrix,
                maxSteps,
                aggrBoard,
                canFly,
                isSmallUnit,
                isMadeOfFire,
                hasVineStride,
                footprintWidth,
                footprintHeight,
            )
        ) {
            if (this.stats) this.stats.bypasses++;
            return this.delegate.getMovePath(
                currentCell,
                matrix,
                maxSteps,
                aggrBoard,
                canFly,
                isSmallUnit,
                isMadeOfFire,
                hasVineStride,
                footprintWidth,
                footprintHeight,
            );
        }
        if (this.cached !== undefined) {
            if (this.stats) this.stats.hits++;
            return this.cached;
        }
        if (this.stats) this.stats.misses++;
        this.cached = this.delegate.getMovePath(
            // PathHelper retains its start-cell object in route[0]. Delegate with a catalog-owned snapshot so
            // a type-correct caller cannot mutate the shared readonly result later through its input object.
            { x: this.canonical.currentCell.x, y: this.canonical.currentCell.y },
            matrix,
            maxSteps,
            aggrBoard,
            canFly,
            isSmallUnit,
            isMadeOfFire,
            hasVineStride,
            footprintWidth,
            footprintHeight,
        );
        return this.cached;
    }
}

export function createDecisionPathCatalog(
    grid: Grid,
    delegate: PathHelper,
    unit: Unit,
    matrix: number[][],
    collectStats = false,
): DecisionPathCatalog {
    return DecisionPathCatalog.create(grid, delegate, unit, matrix, collectStats);
}

export function decisionPathSource(context: {
    readonly pathHelper: PathHelper;
    readonly decisionPathCatalog?: DecisionPathCatalog;
}): IDecisionPathSource {
    return context.decisionPathCatalog ?? context.pathHelper;
}

function canonicalInput(grid: Grid, unit: Unit, matrix: number[][]): ICanonicalMovePathInput {
    const enemyTeam = unit.getTeam() === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    return {
        currentCell: { ...unit.getBaseCell() },
        matrix,
        maxSteps: unit.getSteps(),
        aggrBoard: grid.getAggrMatrixByTeam(enemyTeam),
        canFly: unit.canFly(),
        isSmallUnit: unit.isSmallSize(),
        isMadeOfFire: unit.canTraverseLava(),
        hasVineStride: unit.hasAbilityActive("In Its Own World"),
        footprintWidth: unit.getFootprintWidth(),
        footprintHeight: unit.getFootprintHeight(),
    };
}

function isProductionBoard(board: unknown): board is number[][] {
    return (
        Array.isArray(board) &&
        board.length === 16 &&
        board.every((column) => Array.isArray(column) && column.length === 16)
    );
}

function sameCanonicalInput(left: ICanonicalMovePathInput, right: ICanonicalMovePathInput): boolean {
    return (
        left.matrix === right.matrix &&
        left.aggrBoard === right.aggrBoard &&
        Object.is(left.currentCell.x, right.currentCell.x) &&
        Object.is(left.currentCell.y, right.currentCell.y) &&
        Object.is(left.maxSteps, right.maxSteps) &&
        left.canFly === right.canFly &&
        left.isSmallUnit === right.isSmallUnit &&
        left.isMadeOfFire === right.isMadeOfFire &&
        left.hasVineStride === right.hasVineStride &&
        left.footprintWidth === right.footprintWidth &&
        left.footprintHeight === right.footprintHeight
    );
}

function matchesCanonicalRequest(
    canonical: ICanonicalMovePathInput,
    currentCell: XY,
    matrix: number[][],
    maxSteps: number,
    aggrBoard: number[][] | undefined,
    canFly: boolean,
    isSmallUnit: boolean,
    isMadeOfFire: boolean,
    hasVineStride: boolean,
    footprintWidth: number,
    footprintHeight: number,
): boolean {
    return (
        canonical.matrix === matrix &&
        canonical.aggrBoard === aggrBoard &&
        Object.is(canonical.currentCell.x, currentCell.x) &&
        Object.is(canonical.currentCell.y, currentCell.y) &&
        Object.is(canonical.maxSteps, maxSteps) &&
        canonical.canFly === canFly &&
        canonical.isSmallUnit === isSmallUnit &&
        canonical.isMadeOfFire === isMadeOfFire &&
        canonical.hasVineStride === hasVineStride &&
        canonical.footprintWidth === footprintWidth &&
        canonical.footprintHeight === footprintHeight
    );
}
