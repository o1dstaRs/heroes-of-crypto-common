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

export class SquarePlacement implements IPlacement {
    private readonly gridSettings: GridSettings;
    protected readonly placementPositionType: PlacementPositionType;
    protected readonly placementType: PlacementType = PlacementType.SQUARE;
    private readonly size: number;
    protected readonly xLeft: number;
    protected readonly xRight: number;
    protected readonly yLower: number;
    protected readonly yUpper: number;
    private readonly possibleCellHashesSet: Set<number>;
    public constructor(gridSettings: GridSettings, placementPositionType: PlacementPositionType, size = 3) {
        if (![3, 4, 5].includes(size)) {
            throw new Error("Only 3x3, 4x4, and 5x5 placements are supported.");
        }
        this.gridSettings = gridSettings;
        this.placementPositionType = placementPositionType;
        this.size = size;
        this.possibleCellHashesSet = new Set();

        switch (placementPositionType) {
            case PlacementPositionType.LEFT_BOTTOM:
                this.xLeft = -gridSettings.getMaxX() + gridSettings.getStep();
                this.xRight = this.xLeft + this.size * gridSettings.getStep();
                this.yUpper = gridSettings.getStep() * this.size + gridSettings.getStep();
                this.yLower = gridSettings.getStep();
                break;
            case PlacementPositionType.RIGHT_BOTTOM:
                this.xLeft = -gridSettings.getMaxX() + gridSettings.getStep();
                this.xRight = this.xLeft + this.size * gridSettings.getStep();
                this.yLower = gridSettings.getMaxY() - gridSettings.getStep() * this.size - gridSettings.getStep();
                this.yUpper = gridSettings.getMaxY() - gridSettings.getStep();
                break;
            case PlacementPositionType.LEFT_TOP:
                this.xLeft = gridSettings.getMaxX() - gridSettings.getStep() - gridSettings.getStep() * this.size;
                this.xRight = gridSettings.getMaxX() - gridSettings.getStep();
                this.yUpper = gridSettings.getStep() * this.size + gridSettings.getStep();
                this.yLower = gridSettings.getStep();
                break;
            case PlacementPositionType.RIGHT_TOP:
                this.xLeft = gridSettings.getMaxX() - gridSettings.getStep() - gridSettings.getStep() * this.size;
                this.xRight = gridSettings.getMaxX() - gridSettings.getStep();
                this.yLower = gridSettings.getMaxY() - gridSettings.getStep() * this.size - gridSettings.getStep();
                this.yUpper = gridSettings.getMaxY() - gridSettings.getStep();
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
        const width = normalizeFootprintSide(footprintWidth, isSmallUnit ? 1 : 2);
        const height = normalizeFootprintSide(footprintHeight, isSmallUnit ? 1 : 2);
        const diffX = width - 1;
        const diffY = height - 1;
        // LOWER_RIGHT walks leftwards and has always SUBTRACTED the inset from its far border instead of
        // adding it, so the shipped 2x2 anchor list overshoots the zone by two columns. Every baked placement
        // policy and replay was produced against that exact list, so the 2x2 body keeps it; any other
        // footprint gets the correct border. See test/grid/footprint_placement.test.ts, which pins both.
        const keepsLegacyLargeOvershoot = width === 2 && height === 2;

        switch (this.placementPositionType) {
            case PlacementPositionType.LEFT_BOTTOM:
                x = 1 + diffX;
                y = 1 + diffY;
                sx = 1;
                sy = 1;
                borderX = x + this.size - diffX;
                borderY = y + this.size - diffY;
                break;
            case PlacementPositionType.RIGHT_BOTTOM:
                x = 1 + diffX;
                y = this.gridSettings.getGridSize() - 2;
                sx = 1;
                sy = -1;
                borderX = x + this.size - diffX;
                // This walk runs DOWNWARDS from the zone's top row, so the body's height is paid for at the
                // far end instead: it stops H-1 rows above the zone's bottom row.
                borderY = y - this.size + diffY;
                break;
            case PlacementPositionType.LEFT_TOP:
                x = this.gridSettings.getGridSize() - 2;
                y = 1 + diffY;
                sx = -1;
                sy = 1;
                borderX = keepsLegacyLargeOvershoot ? x - this.size - diffX : x - this.size + diffX;
                borderY = y + this.size - diffY;
                break;
            case PlacementPositionType.RIGHT_TOP:
                sx = -1;
                sy = -1;
                x = this.gridSettings.getGridSize() + sx - 1;
                y = this.gridSettings.getGridSize() + sy - 1;
                borderX = x - this.size + diffX;
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
