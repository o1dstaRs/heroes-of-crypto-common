import { expect, test } from "bun:test";

test("importing the future-policy diagnostic cannot change live SearchDriver behavior", async () => {
    const { SearchDriver } = await import("../../src/simulation/search_driver");
    const names = ["chooseDecision", "shortlistCandidates", "scoreCandidates", "rollout", "simPlayTurn"];
    const before = names.map((name) => Reflect.get(SearchDriver.prototype, name));
    await import("../../src/simulation/measure_search_future_policy");
    expect(names.map((name) => Reflect.get(SearchDriver.prototype, name))).toEqual(before);
});
