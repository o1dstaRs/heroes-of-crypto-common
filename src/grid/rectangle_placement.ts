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
        if (![3, 4, 5, 6].includes(size)) {
            throw new Error("Only the following placement depths are supported: 3, 4, 5, 6.");
        }
        this.gridSettings = gridSettings;
        this.placementPositionType = placementPositionType;
        this.size = size;
        this.possibleCellHashesSet = new Set();

        const sizeShift = size * gridSettings.getStep();
        const isSmallestPlacement = size === 3;
        // Depths 3-5 stop one column short of the board edge; depth 6 (Placement augment LEVEL_3) opens
        // the edge line itself, so the zone starts at the very first/last column.
        const edgeInset = size >= 6 ? 0 : gridSettings.getStep();

        switch (placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                this.xLeft = gridSettings.getMinX() + edgeInset;
                this.xRight = gridSettings.getMinX() + edgeInset + sizeShift;
                this.yLower = gridSettings.getMinY() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMaxY() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                break;
            case PlacementPositionType.UPPER_LEFT:
                this.xLeft = gridSettings.getMaxX() - edgeInset - sizeShift;
                this.xRight = gridSettings.getMaxX() - edgeInset;
                this.yLower = gridSettings.getMinY() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMaxY() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                break;
            case PlacementPositionType.LOWER_RIGHT:
                this.xLeft = gridSettings.getMinX() + edgeInset;
                this.xRight = gridSettings.getMinX() + edgeInset + sizeShift;
                this.yLower = gridSettings.getMinY() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMaxY() - (isSmallestPlacement ? gridSettings.getStep() : 0);
                break;
            case PlacementPositionType.UPPER_RIGHT:
                this.xLeft = gridSettings.getMaxX() - edgeInset - sizeShift;
                this.xRight = gridSettings.getMaxX() - edgeInset;
                this.yLower = gridSettings.getMinY() + (isSmallestPlacement ? gridSettings.getStep() : 0);
                this.yUpper = gridSettings.getMaxY() - (isSmallestPlacement ? gridSettings.getStep() : 0);
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
        const diffX = Math.max(0, Math.floor(footprintWidth) - 1);
        const diffY = Math.max(0, Math.floor(footprintHeight) - 1);
        const isSmallestPlacement = this.size === 3;
        // Cell-space twin of the constructor's edgeInset: depth 6 starts on the edge column itself.
        const edgeColumnInset = this.size >= 6 ? 0 : 1;

        switch (this.placementPositionType) {
            case PlacementPositionType.LOWER_LEFT:
                x = edgeColumnInset + diffX;
                y = (isSmallestPlacement ? 1 : 0) + diffY;
                sx = 1;
                sy = 1;
                borderX = x + this.size - diffX;
                borderY = y + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffY;
                break;
            case PlacementPositionType.UPPER_LEFT:
                x = this.gridSettings.getGridSize() - 1 - edgeColumnInset;
                y = (isSmallestPlacement ? 1 : 0) + diffY;
                sx = -1;
                sy = 1;
                borderX = x - this.size + diffX;
                borderY = y + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffY;
                break;
            case PlacementPositionType.LOWER_RIGHT:
                x = edgeColumnInset + diffX;
                y = (isSmallestPlacement ? 1 : 0) + diffY;
                sx = 1;
                sy = 1;
                borderX = x + this.size - diffX;
                borderY = y + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffY;
                break;
            case PlacementPositionType.UPPER_RIGHT:
                x = this.gridSettings.getGridSize() - 1 - edgeColumnInset;
                y = (isSmallestPlacement ? 1 : 0) + diffY;
                sx = -1;
                sy = 1;
                borderX = x - this.size + diffX;
                borderY = y + this.gridSettings.getGridSize() - (isSmallestPlacement ? 2 : 0) - diffY;
                break;
            default:
                throw new Error("Invalid placement position type.");
        }

        const possiblePositions: XY[] = [];
        let possiblePositionsIndex = 0;

        for (let px = x; px !== borderX; px += sx) {
            for (let py = y; py !== borderY; py += sy) {
                possiblePositions[possiblePositionsIndex++] = { x: px, y: py };
            }
        }

        return possiblePositions;
    }
}
