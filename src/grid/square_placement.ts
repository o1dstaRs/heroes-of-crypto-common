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
            case PlacementPositionType.LOWER_LEFT:
                this.xLeft = -gridSettings.getMaxX() + gridSettings.getStep();
                this.xRight = this.xLeft + this.size * gridSettings.getStep();
                this.yUpper = gridSettings.getStep() * this.size + gridSettings.getStep();
                this.yLower = gridSettings.getStep();
                break;
            case PlacementPositionType.UPPER_LEFT:
                this.xLeft = -gridSettings.getMaxX() + gridSettings.getStep();
                this.xRight = this.xLeft + this.size * gridSettings.getStep();
                this.yLower = gridSettings.getMaxY() - gridSettings.getStep() * this.size - gridSettings.getStep();
                this.yUpper = gridSettings.getMaxY() - gridSettings.getStep();
                break;
            case PlacementPositionType.LOWER_RIGHT:
                this.xLeft = gridSettings.getMaxX() - gridSettings.getStep() - gridSettings.getStep() * this.size;
                this.xRight = gridSettings.getMaxX() - gridSettings.getStep();
                this.yUpper = gridSettings.getStep() * this.size + gridSettings.getStep();
                this.yLower = gridSettings.getStep();
                break;
            case PlacementPositionType.UPPER_RIGHT:
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
    public possibleCellPositions(isSmallUnit = true): XY[] {
        let x;
        let y;
        let sx;
        let sy;
        let borderX;
        let borderY;
        const diff = isSmallUnit ? 0 : 1;

        switch (this.placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                x = 1 + diff;
                y = 1 + diff;
                sx = 1;
                sy = 1;
                borderX = x + this.size - diff;
                borderY = borderX;
                break;
            case PlacementPositionType.UPPER_LEFT:
                x = 1 + diff;
                y = this.gridSettings.getGridSize() - 2;
                sx = 1;
                sy = -1;
                borderX = x + this.size - diff;
                borderY = y - this.size + diff;
                break;
            case PlacementPositionType.LOWER_RIGHT:
                x = this.gridSettings.getGridSize() - 2;
                y = 1 + diff;
                sx = -1;
                sy = 1;
                borderX = x - this.size - diff;
                borderY = sy + this.size;
                break;
            case PlacementPositionType.UPPER_RIGHT:
                sx = -1;
                sy = -1;
                x = this.gridSettings.getGridSize() + sx - 1;
                y = this.gridSettings.getGridSize() + sy - 1;
                borderX = x - this.size + diff;
                borderY = borderX;
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
