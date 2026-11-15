import { expect, test } from "bun:test";
import {
    protectedMeteorIndex,
    PROTECTED_METEOR_POLICY,
    withProtectedMeteorResearch,
} from "../../src/simulation/magic_dragon_protected_meteor_research";
import { SearchDriver } from "../../src/simulation/search_driver";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

test("protected Meteor retains the completed incumbent on ties, small gains and incomplete scores", () => {
    for (const means of [[0.5, 0.5], [0.5, 0.529], [NaN, 1], [-Infinity, 1], [0.5, NaN, Infinity], []])
        expect(protectedMeteorIndex(means)).toBe(0);
    expect(protectedMeteorIndex([0.5, 0.54, 0.6, 0.6])).toBe(2);
    expect(PROTECTED_METEOR_POLICY.maximumOverrides).toBe(1);
});

test("research scope restores the exact driver method on errors and rejects nesting", () => {
    const original = SearchDriver.prototype.chooseDecision;
    expect(() =>
        withProtectedMeteorResearch(
            PBTypes.TeamVals.LEFT,
            () => {
                expect(SearchDriver.prototype.chooseDecision).not.toBe(original);
                withProtectedMeteorResearch(
                    PBTypes.TeamVals.LEFT,
                    () => undefined,
                    () => undefined,
                );
            },
            () => undefined,
        ),
    ).toThrow("cannot be nested");
    expect(SearchDriver.prototype.chooseDecision).toBe(original);
    expect(
        withProtectedMeteorResearch(
            PBTypes.TeamVals.RIGHT,
            () => 42,
            () => undefined,
        ),
    ).toBe(42);
    expect(SearchDriver.prototype.chooseDecision).toBe(original);
});
