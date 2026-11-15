import { expect, test } from "bun:test";
import {
    dragonPrecisionIndex,
    withDragonPrecisionResearch,
} from "../../src/simulation/magic_dragon_precision_research";
import { SearchDriver } from "../../src/simulation/search_driver";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

test("Dragon challenger must improve both probe blocks and exceed the mean margin", () => {
    expect(
        dragonPrecisionIndex([
            [0.5, 0.8],
            [0.5, 0.49],
        ]),
    ).toBe(0);
    expect(
        dragonPrecisionIndex([
            [0.5, 0.52],
            [0.5, 0.52],
        ]),
    ).toBe(0);
    expect(
        dragonPrecisionIndex([
            [0.5, 0.55, 0.6],
            [0.5, 0.55, 0.5],
        ]),
    ).toBe(1);
    expect(
        dragonPrecisionIndex([
            [0.5, 0.55, 0.55],
            [0.5, 0.55, 0.55],
        ]),
    ).toBe(1);
    for (const b of [
        [],
        [[0.5, 1]],
        [
            [NaN, 1],
            [0.5, 1],
        ],
        [
            [0.5, Infinity],
            [0.5, 1],
        ],
        [[0.5, 1], [0.5]],
    ])
        expect(dragonPrecisionIndex(b)).toBe(0);
});
test("Dragon probe restores the search method after exceptions and refuses nested scopes", () => {
    const original = SearchDriver.prototype.chooseDecision;
    expect(() =>
        withDragonPrecisionResearch(
            PBTypes.TeamVals.LEFT,
            () => {
                withDragonPrecisionResearch(
                    PBTypes.TeamVals.LEFT,
                    () => 0,
                    () => {},
                );
            },
            () => {},
        ),
    ).toThrow("cannot be nested");
    expect(SearchDriver.prototype.chooseDecision).toBe(original);
});
