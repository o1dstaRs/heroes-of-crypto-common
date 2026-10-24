import { afterEach, expect, test } from "bun:test";
import { GREEN_TEAM, runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import { SearchDriver } from "../../src/simulation/search_driver";

const saved = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
const original = SearchDriver.prototype.chooseDecision;
afterEach(() => {
    SearchDriver.prototype.chooseDecision = original;
    if (saved === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    else process.env.V08_A19_SEARCH_ENV_OVERRIDES = saved;
});
const base: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    seed: 159,
    roster: [{ faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 20 }],
    redRoster: [{ faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 }],
    maxLaps: 2,
    searchOfflineDeterministicWork: true,
};

test("an omitted/empty base override preserves the exact stock A19 trajectory", () => {
    delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    expect(runMatch({ ...base, researchA19BaseSearchEnvironment: {} }).actions).toEqual(runMatch(base).actions);
});

test("both seats retain the frozen server base while only the nominated seat receives the candidate", () => {
    const server = { SEARCH_A19_MATERIAL_ARBITRATION: "ties", SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1" };
    process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
        ...server,
        SEARCH_RESEARCH_RANGED_SHIELD_SEQUENCE: "1",
    });
    const seen: { team: number; model: boolean; material: unknown; bounds: unknown }[] = [];
    SearchDriver.prototype.chooseDecision = function (...args) {
        const state = this as unknown as {
            researchRangedShieldSequence: boolean;
            a19MaterialArbitration: unknown;
            certifiedSelectionBounds: boolean;
        };
        seen.push({
            team: args[0].getTeam(),
            model: state.researchRangedShieldSequence,
            material: state.a19MaterialArbitration,
            bounds: state.certifiedSelectionBounds,
        });
        return original.apply(this, args);
    };
    const result = runMatch({
        ...base,
        researchA19BaseSearchEnvironment: server,
        searchEnvOverrideTeams: [GREEN_TEAM],
    });
    expect(result.rejectedGreen).toBe(0);
    expect(result.rejectedRed).toBe(0);
    expect(new Set(seen.map((row) => row.team)).size).toBe(2);
    for (const row of seen) {
        expect(row.model).toBe(row.team === GREEN_TEAM);
        expect(row.material).toBe("ties");
        expect(row.bounds).toBe(true);
    }
});
