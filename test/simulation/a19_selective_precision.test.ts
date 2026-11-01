import { expect, it } from "bun:test";
import { SearchDriver } from "../../src/simulation/search_driver";

const rootBeforeImport = Reflect.get(SearchDriver.prototype, "scoreSearchCandidates");
const { hasR2MidpointTie, withA19SelectivePrecision } = await import("../../src/simulation/a19_selective_precision");

it("does not install a research arm when imported", () => {
    expect(Reflect.get(SearchDriver.prototype, "scoreSearchCandidates")).toBe(rootBeforeImport);
});

it("requires a genuine top midpoint tie, including non-contiguous legal actions", () => {
    expect(hasR2MidpointTie([0.5, -Infinity, 0.5, 0])).toBe(true);
    for (const row of [[], [-Infinity], [0.5], [0, 0], [1, 1], [0.5, 0.5, 0.6], [0.5, 0.49999999999999994]])
        expect(hasR2MidpointTie(row)).toBe(false);
    expect(() => hasR2MidpointTie([0.5, NaN])).toThrow();
    expect(() => hasR2MidpointTie([0.5, Infinity])).toThrow();
});
it("restores the root method after a thrown policy run", () => {
    const before = Reflect.get(SearchDriver.prototype, "scoreSearchCandidates");
    expect(() =>
        withA19SelectivePrecision({ team: 1, mode: "tie-r8" }, () => {
            throw new Error("fault");
        }),
    ).toThrow("fault");
    expect(Reflect.get(SearchDriver.prototype, "scoreSearchCandidates")).toBe(before);
});
