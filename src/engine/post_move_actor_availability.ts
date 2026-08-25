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

import { getSpellConfig } from "../configuration/config_provider";
import { getFootprintCellsForAnchor, normalizeFootprintSide } from "../grid/grid_math";
import type { ISceneLog } from "../scene/scene_log_interface";
import { fireWallBurnDamage, FireWalls } from "../spells/fire_walls";
import { madeOfFireBoostedMaxHp } from "../units/movement_stat_modifiers";
import { projectStackDamage, type IStackHpState } from "../units/stack_damage";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { GameAction } from "./actions";

export type MoveUnitAction = Extract<GameAction, { type: "move_unit" }>;

export interface IResolvedMoveRoute {
    readonly route: readonly Readonly<XY>[];
    readonly hasLavaCell: boolean;
    readonly hasWaterCell: boolean;
}

export interface IMoveTraversal {
    readonly targetCells: readonly Readonly<XY>[];
    readonly pathIsFootprintOnly: boolean;
    readonly travelledPath: readonly Readonly<XY>[];
    readonly routeModifierPath: readonly Readonly<XY>[];
    readonly crossedCells: readonly Readonly<XY>[];
}

export interface IFireWallHitProjection {
    readonly cell: XY;
    readonly burnPercentage: number;
    readonly requestedDamage: number;
    readonly appliedDamage: number;
    readonly absorbedByWaterShield: boolean;
}

export interface IPostMoveActorAvailability {
    readonly availableAfterMove: boolean;
    readonly survivedFireWall: boolean;
    readonly resurrected: boolean;
    readonly madeOfFireApplied: boolean;
    readonly madeOfWaterApplied: boolean;
    readonly waterShieldConsumed: boolean;
    readonly totalAppliedDamage: number;
    readonly burningCells: XY[];
    readonly fireWallHits: IFireWallHitProjection[];
    readonly traversal: IMoveTraversal;
    readonly stack: IStackHpState;
}

/**
 * An injective cell key over any coordinate a footprint can produce, not just the on-board ones.
 *
 * This used to be `(x << 4) | y`, which is only one-to-one while both coordinates sit inside [0, 15]. That
 * held while every cell reaching this set came from the board, and it stopped holding with rectangles: a
 * footprint list is deliberately UNCLIPPED, so a body anchored on the edge legitimately reports a cell at
 * x === -1 or y === -1, and two different such cells could pack to the same number and compare equal. The
 * offset multiply costs the same and cannot collide, so the comparison below means what it says for every
 * shape. On-board cells are unaffected: the mapping is still one number per cell.
 */
const CELL_KEY_ORIGIN = 512;
const moveCellKey = (cell: XY): number => (cell.x + CELL_KEY_ORIGIN) * 1024 + (cell.y + CELL_KEY_ORIGIN);

/** Preserve GameActionEngine's exact set comparison, including its equal-length prerequisite. */
export function moveCellsMatchAsSet(left: readonly XY[], right: readonly XY[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightCells = new Set(right.map(moveCellKey));
    return left.every((cell) => rightCells.has(moveCellKey(cell)));
}

/**
 * Resolve the occupied destination exactly as GameActionEngine.moveUnit does.
 *
 * `footprintWidth` / `footprintHeight` describe the mover's body. They default to the square shape the
 * boolean has always implied, so a caller that still passes only `isSmallSize` gets the legacy answer for
 * both shipped shapes and nothing about an existing move changes.
 */
export function resolveMoveTargetCells(
    isSmallSize: boolean,
    path: readonly XY[],
    suppliedTargetCells?: readonly XY[],
    footprintWidth: number = isSmallSize ? 1 : 2,
    footprintHeight: number = isSmallSize ? 1 : 2,
): XY[] {
    if (suppliedTargetCells?.length) {
        return suppliedTargetCells.map((cell) => ({ ...cell }));
    }
    const destination = path[path.length - 1];
    if (!destination) {
        return [];
    }
    const width = normalizeFootprintSide(footprintWidth);
    const height = normalizeFootprintSide(footprintHeight);
    if (width === 1 && height === 1) {
        return [{ ...destination }];
    }
    // The route's last cell IS an anchor, so the body hangs off it towards -x / -y like every other footprint
    // in the engine.
    //
    // This branch used to grow +dx / +dy for a 2x2, reading `destination` as the block's BOTTOM-LEFT cell —
    // the opposite corner. That was never consistent even for a square: `moveUnit` hands the same cell to
    // `resolveKnownMoveRoute`, which looks it up as a knownPaths KEY, and those keys are anchors. One of the
    // two readings had to be wrong, and the pather is the authority on which. It stayed invisible because
    // this is a FALLBACK: every move_unit producer in the engine, the AI, the server and the client supplies
    // `targetCells` explicitly, so nothing live has ever taken this path with a multi-cell unit.
    return getFootprintCellsForAnchor(destination, width, height);
}

/**
 * Large legacy moves may encode only their final footprint rather than an ordered route.
 *
 * The dimensions are taken so "is this body more than one cell" is asked of the real footprint instead of a
 * boolean; they default to the square shape `isSmallSize` implies, so the verdict is unchanged for every
 * existing caller.
 *
 * A LINE body (1xN or Nx1) makes the encoding genuinely ambiguous by SET alone: its destination footprint
 * is a straight run of cells, which is also exactly what its N-1 step route along that axis looks like. The
 * mover's current anchor separates them — a ROUTE starts there, a destination footprint does not — so
 * callers that know the mover pass it, and a rectangle's one-step move stops being misread as
 * footprint-only (which skipped its route modifiers and charged Fire Wall for the cell it was already
 * standing on).
 *
 * That test is deliberately NOT applied to a body with both sides greater than one, and the reason is not
 * caution — it is that such a body has no ambiguity to resolve. A 2x2's footprint is a BLOCK, and a block is
 * not a walked route: reading one as a route invents three steps for a one-cell diagonal glide. The test
 * would still fire on it, because the payload's first cell is not reliably the anchor. The engine's own
 * expansion puts the anchor first, but the client's hover candidate builds the same list ascending from the
 * MINIMUM corner (HoverManager.findLargeUnitMoveCandidate, whose comment says so, and Sandbox hands that one
 * array in as both `path` and `targetCells`). For a 2x2 the minimum corner is anchor-(1,1), so a glide to
 * anchor+(1,1) — one of the eight neighbours a 2x2 flyer picks constantly — put the mover's own current
 * anchor at path[0] by coincidence and flipped the reading. Measured on that move: the stack passed through
 * a Fire Wall cell without burning, lost its distance-morale tick, and priced its follow-up strike with a
 * Rapid Charge distance of 2 instead of 1.
 */
export function isMovePathFootprintOnly(
    isSmallSize: boolean,
    path: readonly XY[],
    suppliedTargetCells?: readonly XY[],
    footprintWidth: number = isSmallSize ? 1 : 2,
    footprintHeight: number = isSmallSize ? 1 : 2,
    currentAnchor?: Readonly<XY>,
): boolean {
    const width = normalizeFootprintSide(footprintWidth);
    const height = normalizeFootprintSide(footprintHeight);
    const occupiesOneCell = width === 1 && height === 1;
    if (occupiesOneCell || !suppliedTargetCells?.length || !moveCellsMatchAsSet(path, suppliedTargetCells)) {
        return !occupiesOneCell && !!suppliedTargetCells?.length && moveCellsMatchAsSet(path, suppliedTargetCells);
    }
    // Only a LINE body can have a destination footprint that is also a legal route, so only a line body has
    // anything to disambiguate. A block keeps the legacy set reading whatever order its payload arrives in.
    const isLineBody = width === 1 || height === 1;
    if (
        isLineBody &&
        currentAnchor &&
        path.length > 1 &&
        path[0].x === currentAnchor.x &&
        path[0].y === currentAnchor.y
    ) {
        return false;
    }
    return true;
}

/** The route's initial base cell is an origin, not a cell the mover entered. No cell objects are copied. */
export function travelledMovePath(currentCell: Readonly<XY>, path: XY[]): XY[];
export function travelledMovePath(currentCell: Readonly<XY>, path: readonly Readonly<XY>[]): readonly Readonly<XY>[];
export function travelledMovePath(currentCell: Readonly<XY>, path: readonly Readonly<XY>[]): readonly Readonly<XY>[] {
    const firstCell = path[0];
    if (firstCell && firstCell.x === currentCell.x && firstCell.y === currentCell.y) {
        return path.slice(1);
    }
    return path;
}

export function resolveMoveTraversal(
    unit: Pick<Unit, "getBaseCell" | "isSmallSize" | "getFootprintWidth" | "getFootprintHeight">,
    action: MoveUnitAction,
    resolvedRoute?: IResolvedMoveRoute,
): IMoveTraversal {
    // The mover's own dimensions, not a size bit: this projection has to land on exactly the cells the
    // action engine will occupy, or the AI plans a follow-up attack from a body position that never happens.
    const width = unit.getFootprintWidth();
    const height = unit.getFootprintHeight();
    const targetCells = resolveMoveTargetCells(unit.isSmallSize(), action.path, action.targetCells, width, height);
    const pathIsFootprintOnly = isMovePathFootprintOnly(
        unit.isSmallSize(),
        action.path,
        action.targetCells,
        width,
        height,
        // The mover is right here, so hand over its anchor: without it this — the path every real move
        // takes — silently fell back to the legacy set reading, and the separator above never ran.
        unit.getBaseCell(),
    );
    const travelledPath = pathIsFootprintOnly
        ? action.path
        : travelledMovePath(unit.getBaseCell(), resolvedRoute?.route ?? action.path);
    const destination = travelledPath[travelledPath.length - 1];
    // ActionEngine occupies the destination before MoveHandler applies route
    // modifiers. MoveHandler therefore strips its new current cell if that is
    // also route[0] (the historical one-step behavior).
    const routeModifierPath = !pathIsFootprintOnly && destination ? travelledMovePath(destination, travelledPath) : [];
    return {
        targetCells,
        pathIsFootprintOnly,
        travelledPath,
        routeModifierPath,
        // A footprint-only move has no ordered route. The engine treats its final
        // footprint as the set of cells entered for Fire Wall purposes.
        crossedCells: pathIsFootprintOnly ? targetCells : travelledPath,
    };
}

/** Ordered, de-duplicated Fire Wall cells entered by the move. */
export function enteredFireWallCells(fireWalls: FireWalls | undefined, crossedCells: readonly XY[]): XY[] {
    if (!fireWalls?.size() || !crossedCells.length) {
        return [];
    }
    const seen = new Set<number>();
    const burning: XY[] = [];
    for (const cell of crossedCells) {
        const key = FireWalls.key(cell);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (fireWalls.has(cell)) {
            burning.push({ ...cell });
        }
    }
    return burning;
}

/** What a Fire Wall did to a unit that arrived on it. */
export interface IFireWallBurnResult {
    /** Wall cells actually entered, de-duplicated, in the order they were crossed. */
    burning: XY[];
    /** Damage the stack absorbed across those cells. */
    total: number;
    /** Creatures the stack lost to the flames. */
    unitsDied: number;
}

/**
 * Burn a unit for every Fire Wall cell it just arrived on, mutating the stack and logging it.
 *
 * Shared on purpose: a unit can land on a wall two ways — walking there under its own move action, or
 * being SHOVED there by map narrowing — and only the first used to charge for it, so a stack pushed into
 * the flames by a closing board walked away untouched. One helper means the two paths cannot price the
 * same fire differently.
 *
 * Damage is re-derived per cell rather than multiplied out, because a stack thinned by the first cell has
 * a smaller maximum health for the second to take its share of. The element table is read once so every
 * cell is priced against the same resistances the rest of the game's fire uses.
 */
export function burnUnitOnFireWallCells(
    unit: Unit,
    crossedCells: readonly XY[],
    fireWalls: FireWalls | undefined,
    sceneLog: ISceneLog,
): IFireWallBurnResult {
    const empty: IFireWallBurnResult = { burning: [], total: 0, unitsDied: 0 };
    if (!fireWalls?.size() || !crossedCells.length) {
        return empty;
    }
    // De-duplicate: a large unit reports the same cell once per body part standing in it, and the wall
    // charges per cell entered, not per body part.
    const burning = enteredFireWallCells(fireWalls, crossedCells);
    if (!burning.length) {
        return empty;
    }

    const amountAliveBefore = unit.getAmountAlive();
    const burnTarget = {
        isFireElement: unit.hasAbilityActive("Fire Element"),
        isWaterElement: unit.hasAbilityActive("Water Element"),
        isWindElement: unit.hasAbilityActive("Wind Element"),
        isEarthElement: unit.hasAbilityActive("Earth Element"),
    };
    let total = 0;
    for (const cell of burning) {
        const damage = fireWallBurnDamage(unit.getCumulativeMaxHp(), fireWalls.burnPercentageAt(cell), burnTarget);
        if (damage <= 0) {
            break;
        }
        total += unit.applyDamage(damage, 0, sceneLog);
        if (unit.isDead()) {
            break;
        }
    }
    if (total <= 0) {
        return empty;
    }

    sceneLog.updateLog(
        `${unit.getName()} was seared by the Fire Wall for ${total} damage crossing ${burning.length} of it`,
    );
    return { burning, total, unitsDied: Math.max(0, amountAliveBefore - unit.getAmountAlive()) };
}

/**
 * Project whether an explicit follow-up action can still address the mover after
 * movement terrain modifiers and Fire Wall cleanup. This is O(path), read-only,
 * and deliberately does not clone or roll back battle state.
 */
export function projectPostMoveActorAvailability(
    unit: Unit,
    fireWalls: FireWalls | undefined,
    action: MoveUnitAction,
    resolvedRoute?: IResolvedMoveRoute,
): IPostMoveActorAvailability {
    const traversal = resolveMoveTraversal(unit, action, resolvedRoute);
    let stack: IStackHpState = {
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        amountAlive: unit.getAmountAlive(),
        amountDied: unit.getAmountDied(),
    };
    const hasLavaCell = resolvedRoute?.hasLavaCell ?? action.hasLavaCell ?? false;
    const hasWaterCell = resolvedRoute?.hasWaterCell ?? action.hasWaterCell ?? false;
    const appliesRouteModifiers = traversal.routeModifierPath.length > 0;
    const madeOfFireApplied =
        appliesRouteModifiers && hasLavaCell && unit.canTraverseLava() && !unit.hasBuffActive("Made of Fire");
    const madeOfWaterApplied =
        appliesRouteModifiers &&
        hasWaterCell &&
        unit.hasAbilityActive("Made of Water") &&
        !unit.hasBuffActive("Made of Water");
    if (madeOfFireApplied) {
        stack = {
            ...stack,
            maxHp: madeOfFireBoostedMaxHp(stack.maxHp, getSpellConfig("System", "Made of Fire").power),
        };
    }

    const burningCells = enteredFireWallCells(fireWalls, traversal.crossedCells);
    const fireWallHits: IFireWallHitProjection[] = [];
    let waterShieldAvailable = unit.hasBuffActive("Water Shield");
    let waterShieldConsumed = false;
    let totalAppliedDamage = 0;
    for (const cell of burningCells) {
        const burnPercentage = fireWalls!.burnPercentageAt(cell);
        const requestedDamage = fireWallBurnDamage(stack.amountAlive * stack.maxHp, burnPercentage);
        if (requestedDamage <= 0) {
            break;
        }
        if (waterShieldAvailable) {
            waterShieldAvailable = false;
            waterShieldConsumed = true;
            fireWallHits.push({
                cell: { ...cell },
                burnPercentage,
                requestedDamage,
                appliedDamage: 0,
                absorbedByWaterShield: true,
            });
            continue;
        }
        const damage = projectStackDamage(stack, requestedDamage);
        stack = damage.state;
        totalAppliedDamage += damage.appliedDamage;
        fireWallHits.push({
            cell: { ...cell },
            burnPercentage,
            requestedDamage,
            appliedDamage: damage.appliedDamage,
            absorbedByWaterShield: false,
        });
        if (damage.dead) {
            break;
        }
    }

    const survivedFireWall = stack.amountAlive > 0;
    let resurrected = false;
    if (!survivedFireWall && unit.canSelfResurrect()) {
        const revived = Math.min(stack.amountDied, Math.max(1, Math.floor(stack.amountDied / 2)));
        if (revived > 0) {
            stack = {
                ...stack,
                amountAlive: stack.amountAlive + revived,
                amountDied: stack.amountDied - revived,
            };
            resurrected = true;
        }
    }

    return {
        availableAfterMove: stack.amountAlive > 0,
        survivedFireWall,
        resurrected,
        madeOfFireApplied,
        madeOfWaterApplied,
        waterShieldConsumed,
        totalAppliedDamage,
        burningCells,
        fireWallHits,
        traversal,
        stack,
    };
}

/**
 * Native policies occasionally emit an explicit move followed by an attack.
 * If Fire Wall cleanup removes that actor or changes Cowardice legality,
 * preserve the standalone move and only drop actions that would necessarily
 * be rejected afterward.
 */
export function repairUnavailableMovePrefixedAttack(
    unit: Unit,
    fireWalls: FireWalls | undefined,
    actions: GameAction[],
    targetForId?: (targetId: string) => Unit | undefined,
): GameAction[] {
    const moveIndex = actions.findIndex(
        (action): action is MoveUnitAction => action.type === "move_unit" && action.unitId === unit.getId(),
    );
    if (moveIndex < 0) {
        return actions;
    }
    const hasDependentAttack = actions
        .slice(moveIndex + 1)
        .some(
            (action) =>
                (action.type === "melee_attack" || action.type === "range_attack") &&
                action.attackerId === unit.getId(),
        );
    if (!hasDependentAttack) {
        return actions;
    }
    const move = actions[moveIndex] as MoveUnitAction;
    const projection = projectPostMoveActorAvailability(unit, fireWalls, move);
    if (!projection.availableAfterMove) {
        return actions.slice(0, moveIndex + 1);
    }
    if (!unit.hasStatusApplied("Cowardice") || !targetForId) {
        return actions;
    }
    const postMoveCumulativeHp =
        (projection.stack.amountAlive - 1) * projection.stack.maxHp + Math.max(0, projection.stack.hp);
    const cowardiceBlockedMelee = actions.slice(moveIndex + 1).some((action) => {
        if (action.type !== "melee_attack" || action.attackerId !== unit.getId()) {
            return false;
        }
        const target = targetForId(action.targetId);
        return !!target && !target.isDead() && postMoveCumulativeHp < target.getCumulativeHp();
    });
    return cowardiceBlockedMelee ? actions.slice(0, moveIndex + 1) : actions;
}
