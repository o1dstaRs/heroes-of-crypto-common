import { expect, test } from "bun:test";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import type { Unit } from "../../src/units/unit";

const actor = (name: string, team = 2) => ({ getName: () => name, getTeam: () => team }) as Unit;
type Internals = { effectiveShortlist(version: string, unit: Unit): number | null; degradedRemaining: number };
const driver = (overrides: Record<string, string | undefined> = {}) =>
    withSearchEnvironment(
        { ...buildV08A19SearchEnvironment(), ...overrides },
        () =>
            new SearchDriver({ fightProperties: { getCurrentLap: () => 1 } } as ILookaheadDeps) as unknown as Internals,
    );

test("default A19 widens Mage roots while other actors, versions, explicit overrides and degraded budgets stay intact", () => {
    const search = driver();
    expect(search.effectiveShortlist("v0.8", actor("Wandering Mage"))).toBe(8);
    expect(search.effectiveShortlist("v0.8", actor("Wandering Mage", 1))).toBe(8);
    expect(search.effectiveShortlist("v0.8", actor("Healer"))).toBe(6);
    expect(search.effectiveShortlist("v0.9", actor("Wandering Mage"))).toBe(6);
    search.degradedRemaining = 1;
    expect(search.effectiveShortlist("v0.8", actor("Wandering Mage"))).toBe(2);
    expect(driver({ SEARCH_A19_WANDERING_MAGE_SUPPORT: "0" }).effectiveShortlist("v0.8", actor("Wandering Mage"))).toBe(
        6,
    );
    expect(driver({ SEARCH_SHORTLIST: "4" }).effectiveShortlist("v0.8", actor("Wandering Mage"))).toBe(4);
});
