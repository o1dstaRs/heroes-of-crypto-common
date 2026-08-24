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

import type { XY } from "../utils/math";
import { normalizeFootprintSide } from "./grid_math";
import { GridSettings } from "./grid_settings";
import { type IPlacement, PlacementPositionType, PlacementType } from "./placement_properties";

export class RectanglePlacement implements IPlacement {
    private readonly gridSettings: GridSettings;
    protected readonly placementPositionType: PlacementPositionType;
    protected readonly placementType: PlacementType = PlacementType.RECTANGLE;
    private readonly size: number;
    protected readonly xLeft: number;
    protected readonly xRight: number;
    protected readonly yLower: number;
    protected readonly yUpper: number;
    private readonly possibleCellHashesSet: Set<number>;
    public constructor(gridSettings: GridSettings, placementPositionType: PlacementPositionType, size = 3) {
        if (![3, 4, 5, 6].includes(size)) {
            throw new Error("Only the following placements heights are supported: 3, 4, 5, 6.");
        }
        this.gridSettings = gridSettings;
        this.placementPositionType = placementPositionType;
        this.size = size;
        this.possibleCellHashesSet = new Set();

        const sizeShift = size * gridSettings.getStep();
        const isSmallestPlacement = size === 3;
        // Heights 3-5 stop one row short of the board edge; height 6 (Placement augment LEVEL_3) opens
        // the edge line itself, so the zone starts at the very first/last row.
        const edgeInset = size >= 6 ? 0 : gridSettings.getStep();

        switch (placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMinY() + edgeInset + sizeShift;
                this.yLower = gridSettings.getMinY() + edgeInset;
                break;
            case PlacementPositionType.UPPER_LEFT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yLower = gridSettings.getMaxY() - edgeInset - sizeShift;
                this.yUpper = gridSettings.getMaxY() - edgeInset;
                break;
            case PlacementPositionType.LOWER_RIGHT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMinY() + edgeInset + sizeShift;
                this.yLower = gridSettings.getMinY() + edgeInset;
                break;
            case PlacementPositionType.UPPER_RIGHT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yLower = gridSettings.getMaxY() - edgeInset - sizeShift;
                this.yUpper = gridSettings.getMaxY() - edgeInset;
                break;
            default:
                throw new Error("Unknown placement position type provided for the SquarePlacement");
        }

        const possibleCellPositions = this.possibleCellPositions();
        for (const c of possibleCellPositions) {
            if (!c) {
                continue;
            }
            this.possibleCellHashesSet.add((c.x << 4) | c.y);
        }
    }
    public getType(): PlacementType {
        return this.placementType;
    }
    public getSize(): number {
        return this.size;
    }
    public isAllowed(v: XY): boolean {
        return v.x >= this.xLeft && v.x < this.xRight && v.y >= this.yLower && v.y < this.yUpper;
    }
    public possibleCellHashes(): Set<number> {
        return this.possibleCellHashesSet;
    }
    public possibleCellPositions(
        isSmallUnit = true,
        footprintWidth = isSmallUnit ? 1 : 2,
        footprintHeight = isSmallUnit ? 1 : 2,
    ): XY[] {
        let x;
        let y;
        let sx;
        let sy;
        let borderX;
        let borderY;
        // The anchor is the TOP-RIGHT cell of the footprint, so it has to leave W-1 columns to its left and
        // H-1 rows below it inside the zone. The legacy single `diff = isSmallUnit ? 0 : 1` was the W === H
        // instance of that rule; the two axes only coincide for square bodies, so they are insetted apart.
        const diffX = normalizeFootprintSide(footprintWidth, isSmallUnit ? 1 : 2) - 1;
        const diffY = normalizeFootprintSide(footprintHeight, isSmallUnit ? 1 : 2) - 1;
        const isSmallestPlacement = this.size === 3;
        const edgeRowInset = this.size >= 6 ? 0 : 1;

        switch (this.placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                x = (isSmallestPlacement ? 1 : 0) + diffX;
                y = edgeRowInset + diffY;
                sx = 1;
                sy = 1;
                // Both walks start at the zone's low corner, so the inset is spent on the start and the far
                // border stays where the zone ends: the `- diff` below cancels the one folded into x / y.
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffX;
                borderY = y + this.size - diffY;
                break;
            case PlacementPositionType.UPPER_LEFT:
                x = (isSmallestPlacement ? 1 : 0) + diffX;
                y = this.gridSettings.getGridSize() - 1 - edgeRowInset;
                sx = 1;
                sy = -1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffX;
                // This walk runs DOWNWARDS from the zone's top row, so the body's height is paid for at the
                // far end instead: it stops H-1 rows above the zone's bottom row.
                borderY = y - this.size + diffY;
                break;
            case PlacementPositionType.LOWER_RIGHT:
                x = (isSmallestPlacement ? 1 : 0) + diffX;
                y = edgeRowInset + diffY;
                sx = 1;
                sy = 1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffX;
                borderY = y + this.size - diffY;
                break;
            case PlacementPositionType.UPPER_RIGHT:
                x = (isSmallestPlacement ? 1 : 0) + diffX;
                y = this.gridSettings.getGridSize() - 1 - edgeRowInset;
                sx = 1;
                sy = -1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffX;
                borderY = y - this.size + diffY;
                break;
            default:
                throw new Error("Invalid placement position type.");
        }

        const possiblePositions: XY[] = [];
        let possiblePositionsIndex = 0;

        // A body wider or taller than the zone leaves no legal anchor at all, which the legacy `px !== borderX`
        // walk could only express by running past the border forever, so the bounds are compared by direction.
        for (let px = x; sx > 0 ? px < borderX : px > borderX; px += sx) {
            for (let py = y; sy > 0 ? py < borderY : py > borderY; py += sy) {
                possiblePositions[possiblePositionsIndex++] = { x: px, y: py };
            }
        }

        return possiblePositions;
    }
}
