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

import { getFootprintCellsForAnchor, normalizeFootprintSide } from "../grid/grid_math";
import type { XY } from "../utils/math";

/**
 * The subset of a Unit the simulation needs in order to know its shape. Typed structurally rather than as
 * `Unit` so the helpers below also accept the AI-facing unit views (IUnitAIRepr, AttackTarget), which expose
 * exactly these three methods.
 */
export interface IFootprintShaped {
    isSmallSize(): boolean;
    getFootprintWidth(): number;
    getFootprintHeight(): number;
}

/**
 * The cells a unit would occupy if its ANCHOR (top-right cell, `Unit.getBaseCell()`) sat on `anchor`.
 *
 * Every headless harness used to carry its own copy of this expansion, hardcoded to 1x1 or 2x2. They are all
 * routed here instead, because a rollout whose footprint disagrees with the engine's does not crash — it
 * quietly scores, trains on and replays a board that never existed.
 *
 * The two shipped shapes keep their hand-written expansions VERBATIM, cell order included. Order is
 * irrelevant to the geometry (every consumer treats the result as a set) but it does reach recorded
 * `unit_placed` / `move_unit` payloads, so reproducing it byte-for-byte keeps existing seeded runs and their
 * baked AI weights untouched. Only genuinely rectangular units take the generic path.
 */
export const footprintCellsForAnchor = (unit: IFootprintShaped, anchor: XY): XY[] => {
    if (unit.isSmallSize()) {
        return [{ x: anchor.x, y: anchor.y }];
    }
    const width = normalizeFootprintSide(unit.getFootprintWidth());
    const height = normalizeFootprintSide(unit.getFootprintHeight());
    if (width === 2 && height === 2) {
        return [
            { x: anchor.x, y: anchor.y },
            { x: anchor.x - 1, y: anchor.y },
            { x: anchor.x, y: anchor.y - 1 },
            { x: anchor.x - 1, y: anchor.y - 1 },
        ];
    }
    return getFootprintCellsForAnchor(anchor, width, height);
};

/**
 * The same expansion from a recorded shape rather than from a live unit — placement records and roster specs
 * carry `size` plus (for rectangles) explicit width/height, so a harness that re-derives a board from them
 * reconstructs the footprint that was actually played.
 */
export const footprintCellsForRecord = (
    anchor: XY,
    size: number,
    footprintWidth?: number,
    footprintHeight?: number,
): XY[] => {
    const width = normalizeFootprintSide(footprintWidth, size);
    const height = normalizeFootprintSide(footprintHeight, size);
    return footprintCellsForAnchor(
        {
            isSmallSize: () => width === 1 && height === 1,
            getFootprintWidth: () => width,
            getFootprintHeight: () => height,
        },
        anchor,
    );
};

/** A short label for a shape, for diagnostics that used to say only "small" or "large". */
export const footprintLabel = (unit: IFootprintShaped): string => {
    if (unit.isSmallSize()) {
        return "small";
    }
    const width = normalizeFootprintSide(unit.getFootprintWidth());
    const height = normalizeFootprintSide(unit.getFootprintHeight());
    return width === height ? "large" : `${width}x${height}`;
};
