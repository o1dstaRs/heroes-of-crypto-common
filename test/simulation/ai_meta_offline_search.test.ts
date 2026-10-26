import { expect, it, spyOn } from "bun:test";

import { playMetaPair } from "../../src/simulation/ai_meta_cohorts_pair";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { ISearchSelectionBoundPlan } from "../../src/simulation/search_selection_bounds";

it("runs ordinary finite-work cohort fights through certified selection bounds", () => {
    const prototype = SearchDriver.prototype as unknown as {
        certifiedSelectionBoundPlan: (...args: unknown[]) => ISearchSelectionBoundPlan | false;
    };
    const original = prototype.certifiedSelectionBoundPlan;
    let plans = 0;
    const spy = spyOn(prototype, "certifiedSelectionBoundPlan").mockImplementation(function (
        this: SearchDriver,
        ...args: unknown[]
    ) {
        const plan = original.apply(this, args);
        if (plan) plans++;
        return plan;
    });
    try {
        const pair = playMetaPair(
            { cohort: "ground-melee", games: 72, baseSeed: 2730170000 },
            0,
            "registered-version",
            true,
        );
        expect(pair.games.every((game) => game.rejectedA === 0 && game.rejectedB === 0)).toBe(true);
        expect(plans).toBeGreaterThan(0);
    } finally {
        spy.mockRestore();
    }
}, 60_000);
