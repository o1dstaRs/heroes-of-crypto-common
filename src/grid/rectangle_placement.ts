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
        if (![3, 4, 5].includes(size)) {
            throw new Error("Only the following placements heights are supported: 3, 4, 5.");
        }
        this.gridSettings = gridSettings;
        this.placementPositionType = placementPositionType;
        this.size = size;
        this.possibleCellHashesSet = new Set();

        const sizeShift = size * gridSettings.getStep();
        const isSmallestPlacement = size === 3;

        switch (placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMinY() + gridSettings.getStep() + sizeShift;
                this.yLower = gridSettings.getMinY() + gridSettings.getStep();
                break;
            case PlacementPositionType.UPPER_LEFT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yLower = gridSettings.getMaxY() - gridSettings.getStep() - sizeShift;
                this.yUpper = gridSettings.getMaxY() - gridSettings.getStep();
                break;
            case PlacementPositionType.LOWER_RIGHT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMinY() + gridSettings.getStep() + sizeShift;
                this.yLower = gridSettings.getMinY() + gridSettings.getStep();
                break;
            case PlacementPositionType.UPPER_RIGHT:
                this.xLeft = gridSettings.getMinX() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.xRight = gridSettings.getMaxX() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yLower = gridSettings.getMaxY() - gridSettings.getStep() - sizeShift;
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
    public possibleCellPositions(isSmallUnit = true): XY[] {
        let x;
        let y;
        let sx;
        let sy;
        let borderX;
        let borderY;
        const diff = isSmallUnit ? 0 : 1;
        const isSmallestPlacement = this.size === 3;

        switch (this.placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                x = (isSmallestPlacement ? 1 : 0) + diff;
                y = 1 + diff;
                sx = 1;
                sy = 1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diff;
                borderY = y + this.size - diff;
                break;
            case PlacementPositionType.UPPER_LEFT:
                x = (isSmallestPlacement ? 1 : 0) + diff;
                y = this.gridSettings.getGridSize() - 2;
                sx = 1;
                sy = -1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diff;
                borderY = y - this.size + diff;
                break;
            case PlacementPositionType.LOWER_RIGHT:
                x = (isSmallestPlacement ? 1 : 0) + diff;
                y = 1 + diff;
                sx = 1;
                sy = 1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diff;
                borderY = y + this.size - diff;
                break;
            case PlacementPositionType.UPPER_RIGHT:
                x = (isSmallestPlacement ? 1 : 0) + diff;
                y = this.gridSettings.getGridSize() - 2;
                sx = 1;
                sy = -1;
                borderX = x + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diff;
                borderY = y - this.size + diff;
                break;
            default:
                throw new Error("Invalid placement position type.");
        }

        const possiblePositions: XY[] = new Array((this.size - diff) * (this.size - diff));
        let possiblePositionsIndex = 0;

        for (let px = x; px !== borderX; px += sx) {
            for (let py = y; py !== borderY; py += sy) {
                possiblePositions[possiblePositionsIndex++] = { x: px, y: py };
            }
        }

        return possiblePositions;
    }
}
