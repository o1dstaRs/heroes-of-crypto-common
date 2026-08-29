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

import { describe, expect, it } from "bun:test";

import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { type IPlacement, PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SquarePlacement } from "../../src/grid/square_placement";
import type { XY } from "../../src/utils/math";
import { testGridSettings } from "../helpers/combat";

const PLACEMENT_POSITION_TYPES = [
    ["LOWER_LEFT", PlacementPositionType.LEFT_BOTTOM],
    ["UPPER_LEFT", PlacementPositionType.RIGHT_BOTTOM],
    ["LOWER_RIGHT", PlacementPositionType.LEFT_TOP],
    ["UPPER_RIGHT", PlacementPositionType.RIGHT_TOP],
] as const;

const SQUARE_SIZES = [3, 4, 5] as const;
const RECTANGLE_SIZES = [3, 4, 5, 6] as const;

/**
 * Every anchor list the two placements produce today for the two SHIPPED footprints, encoded as the
 * `(x << 4) | y` cell hashes in emission ORDER, two hex digits each. Captured from the implementation before
 * the footprint rework, so it fails on any reordering or off-by-one, not just on a changed cell count.
 */
const SHIPPED_ANCHOR_LISTS: Record<string, string> = {
    "SQUARE|LOWER_LEFT|3|small": "111213212223313233",
    "SQUARE|LOWER_LEFT|3|large": "22233233",
    "RECT|LOWER_LEFT|3|small": "111213212223313233414243515253616263717273818283919293a1a2a3b1b2b3c1c2c3d1d2d3e1e2e3",
    "RECT|LOWER_LEFT|3|large": "22233233424352536263727382839293a2a3b2b3c2c3d2d3e2e3",
    "SQUARE|LOWER_LEFT|4|small": "11121314212223243132333441424344",
    "SQUARE|LOWER_LEFT|4|large": "222324323334424344",
    "RECT|LOWER_LEFT|4|small":
        "01020304111213142122232431323334414243445152535461626364717273748182838491929394a1a2a3a4b1b2b3b4c1c2c3c4d1d2d3d4e1e2e3e4f1f2f3f4",
    "RECT|LOWER_LEFT|4|large":
        "121314222324323334424344525354626364727374828384929394a2a3a4b2b3b4c2c3c4d2d3d4e2e3e4f2f3f4",
    "SQUARE|LOWER_LEFT|5|small": "11121314152122232425313233343541424344455152535455",
    "SQUARE|LOWER_LEFT|5|large": "22232425323334354243444552535455",
    "RECT|LOWER_LEFT|5|small":
        "0102030405111213141521222324253132333435414243444551525354556162636465717273747581828384859192939495a1a2a3a4a5b1b2b3b4b5c1c2c3c4c5d1d2d3d4d5e1e2e3e4e5f1f2f3f4f5",
    "RECT|LOWER_LEFT|5|large":
        "121314152223242532333435424344455253545562636465727374758283848592939495a2a3a4a5b2b3b4b5c2c3c4c5d2d3d4d5e2e3e4e5f2f3f4f5",
    "RECT|LOWER_LEFT|6|small":
        "000102030405101112131415202122232425303132333435404142434445505152535455606162636465707172737475808182838485909192939495a0a1a2a3a4a5b0b1b2b3b4b5c0c1c2c3c4c5d0d1d2d3d4d5e0e1e2e3e4e5f0f1f2f3f4f5",
    "RECT|LOWER_LEFT|6|large":
        "111213141521222324253132333435414243444551525354556162636465717273747581828384859192939495a1a2a3a4a5b1b2b3b4b5c1c2c3c4c5d1d2d3d4d5e1e2e3e4e5f1f2f3f4f5",
    "SQUARE|UPPER_LEFT|3|small": "1e1d1c2e2d2c3e3d3c",
    "SQUARE|UPPER_LEFT|3|large": "2e2d3e3d",
    "RECT|UPPER_LEFT|3|small": "1e1d1c2e2d2c3e3d3c4e4d4c5e5d5c6e6d6c7e7d7c8e8d8c9e9d9caeadacbebdbccecdccdedddceeedec",
    "RECT|UPPER_LEFT|3|large": "2e2d3e3d4e4d5e5d6e6d7e7d8e8d9e9daeadbebdcecddeddeeed",
    "SQUARE|UPPER_LEFT|4|small": "1e1d1c1b2e2d2c2b3e3d3c3b4e4d4c4b",
    "SQUARE|UPPER_LEFT|4|large": "2e2d2c3e3d3c4e4d4c",
    "RECT|UPPER_LEFT|4|small":
        "0e0d0c0b1e1d1c1b2e2d2c2b3e3d3c3b4e4d4c4b5e5d5c5b6e6d6c6b7e7d7c7b8e8d8c8b9e9d9c9baeadacabbebdbcbbcecdcccbdedddcdbeeedecebfefdfcfb",
    "RECT|UPPER_LEFT|4|large":
        "1e1d1c2e2d2c3e3d3c4e4d4c5e5d5c6e6d6c7e7d7c8e8d8c9e9d9caeadacbebdbccecdccdedddceeedecfefdfc",
    "SQUARE|UPPER_LEFT|5|small": "1e1d1c1b1a2e2d2c2b2a3e3d3c3b3a4e4d4c4b4a5e5d5c5b5a",
    "SQUARE|UPPER_LEFT|5|large": "2e2d2c2b3e3d3c3b4e4d4c4b5e5d5c5b",
    "RECT|UPPER_LEFT|5|small":
        "0e0d0c0b0a1e1d1c1b1a2e2d2c2b2a3e3d3c3b3a4e4d4c4b4a5e5d5c5b5a6e6d6c6b6a7e7d7c7b7a8e8d8c8b8a9e9d9c9b9aaeadacabaabebdbcbbbacecdcccbcadedddcdbdaeeedecebeafefdfcfbfa",
    "RECT|UPPER_LEFT|5|large":
        "1e1d1c1b2e2d2c2b3e3d3c3b4e4d4c4b5e5d5c5b6e6d6c6b7e7d7c7b8e8d8c8b9e9d9c9baeadacabbebdbcbbcecdcccbdedddcdbeeedecebfefdfcfb",
    "RECT|UPPER_LEFT|6|small":
        "0f0e0d0c0b0a1f1e1d1c1b1a2f2e2d2c2b2a3f3e3d3c3b3a4f4e4d4c4b4a5f5e5d5c5b5a6f6e6d6c6b6a7f7e7d7c7b7a8f8e8d8c8b8a9f9e9d9c9b9aafaeadacabaabfbebdbcbbbacfcecdcccbcadfdedddcdbdaefeeedecebeafffefdfcfbfa",
    "RECT|UPPER_LEFT|6|large":
        "1f1e1d1c1b2f2e2d2c2b3f3e3d3c3b4f4e4d4c4b5f5e5d5c5b6f6e6d6c6b7f7e7d7c7b8f8e8d8c8b9f9e9d9c9bafaeadacabbfbebdbcbbcfcecdcccbdfdedddcdbefeeedecebfffefdfcfb",
    "SQUARE|LOWER_RIGHT|3|small": "e1e2e3d1d2d3c1c2c3",
    "SQUARE|LOWER_RIGHT|3|large": "e2e3d2d3c2c3b2b3",
    "RECT|LOWER_RIGHT|3|small": "111213212223313233414243515253616263717273818283919293a1a2a3b1b2b3c1c2c3d1d2d3e1e2e3",
    "RECT|LOWER_RIGHT|3|large": "22233233424352536263727382839293a2a3b2b3c2c3d2d3e2e3",
    "SQUARE|LOWER_RIGHT|4|small": "e1e2e3e4d1d2d3d4c1c2c3c4b1b2b3b4",
    "SQUARE|LOWER_RIGHT|4|large": "e2e3e4d2d3d4c2c3c4b2b3b4a2a3a4",
    "RECT|LOWER_RIGHT|4|small":
        "01020304111213142122232431323334414243445152535461626364717273748182838491929394a1a2a3a4b1b2b3b4c1c2c3c4d1d2d3d4e1e2e3e4f1f2f3f4",
    "RECT|LOWER_RIGHT|4|large":
        "121314222324323334424344525354626364727374828384929394a2a3a4b2b3b4c2c3c4d2d3d4e2e3e4f2f3f4",
    "SQUARE|LOWER_RIGHT|5|small": "e1e2e3e4e5d1d2d3d4d5c1c2c3c4c5b1b2b3b4b5a1a2a3a4a5",
    "SQUARE|LOWER_RIGHT|5|large": "e2e3e4e5d2d3d4d5c2c3c4c5b2b3b4b5a2a3a4a592939495",
    "RECT|LOWER_RIGHT|5|small":
        "0102030405111213141521222324253132333435414243444551525354556162636465717273747581828384859192939495a1a2a3a4a5b1b2b3b4b5c1c2c3c4c5d1d2d3d4d5e1e2e3e4e5f1f2f3f4f5",
    "RECT|LOWER_RIGHT|5|large":
        "121314152223242532333435424344455253545562636465727374758283848592939495a2a3a4a5b2b3b4b5c2c3c4c5d2d3d4d5e2e3e4e5f2f3f4f5",
    "RECT|LOWER_RIGHT|6|small":
        "000102030405101112131415202122232425303132333435404142434445505152535455606162636465707172737475808182838485909192939495a0a1a2a3a4a5b0b1b2b3b4b5c0c1c2c3c4c5d0d1d2d3d4d5e0e1e2e3e4e5f0f1f2f3f4f5",
    "RECT|LOWER_RIGHT|6|large":
        "111213141521222324253132333435414243444551525354556162636465717273747581828384859192939495a1a2a3a4a5b1b2b3b4b5c1c2c3c4c5d1d2d3d4d5e1e2e3e4e5f1f2f3f4f5",
    "SQUARE|UPPER_RIGHT|3|small": "eeedecdedddccecdcc",
    "SQUARE|UPPER_RIGHT|3|large": "eeeddedd",
    "RECT|UPPER_RIGHT|3|small": "1e1d1c2e2d2c3e3d3c4e4d4c5e5d5c6e6d6c7e7d7c8e8d8c9e9d9caeadacbebdbccecdccdedddceeedec",
    "RECT|UPPER_RIGHT|3|large": "2e2d3e3d4e4d5e5d6e6d7e7d8e8d9e9daeadbebdcecddeddeeed",
    "SQUARE|UPPER_RIGHT|4|small": "eeedecebdedddcdbcecdcccbbebdbcbb",
    "SQUARE|UPPER_RIGHT|4|large": "eeedecdedddccecdcc",
    "RECT|UPPER_RIGHT|4|small":
        "0e0d0c0b1e1d1c1b2e2d2c2b3e3d3c3b4e4d4c4b5e5d5c5b6e6d6c6b7e7d7c7b8e8d8c8b9e9d9c9baeadacabbebdbcbbcecdcccbdedddcdbeeedecebfefdfcfb",
    "RECT|UPPER_RIGHT|4|large":
        "1e1d1c2e2d2c3e3d3c4e4d4c5e5d5c6e6d6c7e7d7c8e8d8c9e9d9caeadacbebdbccecdccdedddceeedecfefdfc",
    "SQUARE|UPPER_RIGHT|5|small": "eeedecebeadedddcdbdacecdcccbcabebdbcbbbaaeadacabaa",
    "SQUARE|UPPER_RIGHT|5|large": "eeedecebdedddcdbcecdcccbbebdbcbb",
    "RECT|UPPER_RIGHT|5|small":
        "0e0d0c0b0a1e1d1c1b1a2e2d2c2b2a3e3d3c3b3a4e4d4c4b4a5e5d5c5b5a6e6d6c6b6a7e7d7c7b7a8e8d8c8b8a9e9d9c9b9aaeadacabaabebdbcbbbacecdcccbcadedddcdbdaeeedecebeafefdfcfbfa",
    "RECT|UPPER_RIGHT|5|large":
        "1e1d1c1b2e2d2c2b3e3d3c3b4e4d4c4b5e5d5c5b6e6d6c6b7e7d7c7b8e8d8c8b9e9d9c9baeadacabbebdbcbbcecdcccbdedddcdbeeedecebfefdfcfb",
    "RECT|UPPER_RIGHT|6|small":
        "0f0e0d0c0b0a1f1e1d1c1b1a2f2e2d2c2b2a3f3e3d3c3b3a4f4e4d4c4b4a5f5e5d5c5b5a6f6e6d6c6b6a7f7e7d7c7b7a8f8e8d8c8b8a9f9e9d9c9b9aafaeadacabaabfbebdbcbbbacfcecdcccbcadfdedddcdbdaefeeedecebeafffefdfcfbfa",
    "RECT|UPPER_RIGHT|6|large":
        "1f1e1d1c1b2f2e2d2c2b3f3e3d3c3b4f4e4d4c4b5f5e5d5c5b6f6e6d6c6b7f7e7d7c7b8f8e8d8c8b9f9e9d9c9bafaeadacabbfbebdbcbbcfcecdcccbdfdedddcdbefeeedecebfffefdfcfb",
};

interface IPlacementCase {
    className: "SQUARE" | "RECT";
    typeName: string;
    size: number;
    placement: IPlacement;
}

const ALL_CASES: IPlacementCase[] = [];
for (const [typeName, positionType] of PLACEMENT_POSITION_TYPES) {
    for (const size of SQUARE_SIZES) {
        ALL_CASES.push({
            className: "SQUARE",
            typeName,
            size,
            placement: new SquarePlacement(testGridSettings, positionType, size),
        });
    }
    for (const size of RECTANGLE_SIZES) {
        ALL_CASES.push({
            className: "RECT",
            typeName,
            size,
            placement: new RectanglePlacement(testGridSettings, positionType, size),
        });
    }
}

/** The four footprints the engine has to agree on right now: the two shipped squares and both dominoes. */
const FOOTPRINTS: [number, number][] = [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
];

/**
 * SquarePlacement's LOWER_RIGHT corner walks leftwards and SUBTRACTS the anchor inset from its far border
 * instead of adding it, so its shipped 2x2 anchor list runs two columns past the zone's left edge. That list
 * is kept bit-for-bit because the baked placement policies were trained against it, which makes it the one
 * documented exception to the containment property below.
 */
function keepsLegacyOvershoot(placementCase: IPlacementCase, width: number, height: number): boolean {
    return (
        placementCase.className === "SQUARE" && placementCase.typeName === "LOWER_RIGHT" && width === 2 && height === 2
    );
}

describe("footprint-aware placement", () => {
    it("returns the shipped anchor lists unchanged for 1x1 and 2x2 bodies", () => {
        let pinsChecked = 0;
        for (const placementCase of ALL_CASES) {
            const { className, typeName, size, placement } = placementCase;
            for (const [suffix, isSmallUnit] of [
                ["small", true],
                ["large", false],
            ] as const) {
                const key = `${className}|${typeName}|${size}|${suffix}`;
                const pinned = SHIPPED_ANCHOR_LISTS[key];
                expect(pinned).toBeDefined();
                expect(placement.possibleCellPositions(isSmallUnit)).toEqual(decodeCells(pinned as string));
                pinsChecked++;
            }
        }
        expect(pinsChecked).toBe(Object.keys(SHIPPED_ANCHOR_LISTS).length);
    });

    it("keeps every returned anchor's whole footprint inside possibleCellHashes", () => {
        for (const placementCase of ALL_CASES) {
            const { className, typeName, size, placement } = placementCase;
            const zone = placement.possibleCellHashes();
            for (const [width, height] of FOOTPRINTS) {
                if (keepsLegacyOvershoot(placementCase, width, height)) {
                    continue;
                }
                const anchors = placement.possibleCellPositions(width === 1 && height === 1, width, height);
                const label = `${className}|${typeName}|${size} ${width}x${height}`;
                expect(anchors.length).toBeGreaterThan(0);
                const outside = anchors.filter((anchor) =>
                    getFootprintCellsForAnchor(anchor, width, height).some((cell) => !zone.has(cellHash(cell))),
                );
                expect(`${label}: ${describeCells(outside)}`).toBe(`${label}: `);
            }
        }
    });

    it("counts anchors as (zoneWidth - W + 1) x (zoneHeight - H + 1)", () => {
        for (const placementCase of ALL_CASES) {
            const { className, typeName, size, placement } = placementCase;
            const zone = zoneExtent(placement);
            // The formula only means anything because both zones are solid rectangles of cells.
            expect(placement.possibleCellHashes().size).toBe(zone.width * zone.height);
            for (const [width, height] of FOOTPRINTS) {
                if (keepsLegacyOvershoot(placementCase, width, height)) {
                    continue;
                }
                const anchors = placement.possibleCellPositions(width === 1 && height === 1, width, height);
                expect(`${className}|${typeName}|${size} ${width}x${height}: ${anchors.length}`).toBe(
                    `${className}|${typeName}|${size} ${width}x${height}: ${
                        (zone.width - width + 1) * (zone.height - height + 1)
                    }`,
                );
            }
        }
    });

    it("preserves the SquarePlacement LOWER_RIGHT 2x2 overshoot, and only there", () => {
        const leftTop = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_TOP, 3);
        const zone = leftTop.possibleCellHashes();

        // The zone is columns 12-14 x rows 1-3, so a correct 2x2 list would be the four anchors (13..14, 2..3).
        const legacyAnchors = leftTop.possibleCellPositions(false);
        expect(describeCells(legacyAnchors)).toBe("14,2 14,3 13,2 13,3 12,2 12,3 11,2 11,3");
        const overshooting = legacyAnchors.filter((anchor) =>
            getFootprintCellsForAnchor(anchor, 2, 2).some((cell) => !zone.has(cellHash(cell))),
        );
        expect(describeCells(overshooting)).toBe("12,2 12,3 11,2 11,3");

        // The dominoes go through the corrected border, so they stay inside the zone in the same corner.
        expect(describeCells(leftTop.possibleCellPositions(false, 2, 1))).toBe("14,1 14,2 14,3 13,1 13,2 13,3");
        expect(describeCells(leftTop.possibleCellPositions(false, 1, 2))).toBe("14,2 14,3 13,2 13,3 12,2 12,3");
    });

    it("yields no anchors for a body bigger than the zone instead of walking off the board", () => {
        for (const { placement } of ALL_CASES) {
            expect(placement.possibleCellPositions(false, 20, 20)).toEqual([]);
            expect(placement.possibleCellPositions(false, 20, 1)).toEqual([]);
            expect(placement.possibleCellPositions(false, 1, 20)).toEqual([]);
        }
    });

    it("reads the footprint from the width/height arguments rather than from isSmallUnit", () => {
        for (const { placement } of ALL_CASES) {
            // isSmallUnit only picks the default footprint, so an explicit W/H overrides it in both directions.
            expect(placement.possibleCellPositions(false, 1, 1)).toEqual(placement.possibleCellPositions(true));
            expect(placement.possibleCellPositions(true, 2, 2)).toEqual(placement.possibleCellPositions(false));
            // A degenerate side falls back to the legacy default for that flag instead of producing a 0-wide body.
            expect(placement.possibleCellPositions(true, 0, 0)).toEqual(placement.possibleCellPositions(true));
        }
    });
});

function cellHash(cell: XY): number {
    return (cell.x << 4) | cell.y;
}

function decodeCells(encoded: string): XY[] {
    const cells: XY[] = [];
    for (let i = 0; i < encoded.length; i += 2) {
        const hash = parseInt(encoded.slice(i, i + 2), 16);
        cells.push({ x: hash >> 4, y: hash & 0xf });
    }
    return cells;
}

/** Cells as "x,y x,y" — compared as one string so a failure prints the offending anchors, not just a count. */
function describeCells(cells: XY[]): string {
    return cells.map((cell) => `${cell.x},${cell.y}`).join(" ");
}

function zoneExtent(placement: IPlacement): { width: number; height: number } {
    let minX = Number.MAX_SAFE_INTEGER;
    let maxX = Number.MIN_SAFE_INTEGER;
    let minY = Number.MAX_SAFE_INTEGER;
    let maxY = Number.MIN_SAFE_INTEGER;
    for (const hash of placement.possibleCellHashes()) {
        const x = hash >> 4;
        const y = hash & 0xf;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
}
