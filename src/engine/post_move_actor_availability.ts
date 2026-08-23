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

const moveCellKey = (cell: XY): number => (cell.x << 4) | cell.y;

/** Preserve GameActionEngine's exact set comparison, including its equal-length prerequisite. */
export function moveCellsMatchAsSet(left: readonly XY[], right: readonly XY[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightCells = new Set(right.map(moveCellKey));
    return left.every((cell) => rightCells.has(moveCellKey(cell)));
}

/** Resolve the occupied destination exactly as GameActionEngine.moveUnit does. */
export function resolveMoveTargetCells(
    isSmallSize: boolean,
    path: readonly XY[],
    suppliedTargetCells?: readonly XY[],
    footprintWidth = isSmallSize ? 1 : 2,
    footprintHeight = isSmallSize ? 1 : 2,
): XY[] {
    if (suppliedTargetCells?.length) {
        return suppliedTargetCells.map((cell) => ({ ...cell }));
    }
    const destination = path[path.length - 1];
    if (!destination) {
        return [];
    }
    if (footprintWidth === 1 && footprintHeight === 1) {
        return [{ ...destination }];
    }
    if (footprintWidth !== 2 || footprintHeight !== 2) {
        const cells: XY[] = [];
        for (let dx = 0; dx < footprintWidth; dx++) {
            for (let dy = 0; dy < footprintHeight; dy++) {
                cells.push({ x: destination.x - dx, y: destination.y - dy });
            }
        }
        return cells;
    }
    return [
        { x: destination.x, y: destination.y },
        { x: destination.x + 1, y: destination.y },
        { x: destination.x, y: destination.y + 1 },
        { x: destination.x + 1, y: destination.y + 1 },
    ];
}

/** Large legacy moves may encode only their final 2x2 footprint rather than an ordered route. */
export function isMovePathFootprintOnly(
    isSmallSize: boolean,
    path: readonly XY[],
    suppliedTargetCells?: readonly XY[],
): boolean {
    return !isSmallSize && !!suppliedTargetCells?.length && moveCellsMatchAsSet(path, suppliedTargetCells);
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
    const targetCells = resolveMoveTargetCells(
        unit.isSmallSize(),
        action.path,
        action.targetCells,
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    );
    const pathIsFootprintOnly = isMovePathFootprintOnly(unit.isSmallSize(), action.path, action.targetCells);
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
