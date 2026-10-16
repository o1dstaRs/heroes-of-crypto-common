import { afterEach, expect, it, spyOn } from "bun:test";
import { runMatch } from "../../src/simulation/battle_engine";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { IArmyUnitSpec } from "../../src/simulation/army";

const savedOverrides = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
afterEach(() => {
    if (savedOverrides === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    else process.env.V08_A19_SEARCH_ENV_OVERRIDES = savedOverrides;
});

it.each(["checkpoint", "snapshot"])(
    "%s counterfactual search preserves committed summon IDs and live decisions",
    (rollback) => {
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
            SEARCH_HORIZON: "4",
            SEARCH_ROLLOUTS: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_MAX_MELEE: "2",
            SEARCH_ROLLBACK_STRATEGY: rollback,
        });
        const roster: IArmyUnitSpec[] = [
            { faction: "Nature", creatureName: "Satyr", level: 3, size: 1, amount: 20 },
            { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 40 },
        ];
        const original = SearchDriver.prototype.chooseDecision;
        let probe = false;
        let decisions: unknown[] = [];
        let summons = new Set<string>();
        const intercept = spyOn(SearchDriver.prototype, "chooseDecision").mockImplementation(function (
            this: SearchDriver,
            ...args: Parameters<SearchDriver["chooseDecision"]>
        ) {
            const chosen = original.apply(this, args);
            const unit = args[0];
            decisions.push(structuredClone({ unit: unit.getId(), team: unit.getTeam(), actions: chosen }));
            if (probe) original.apply(this, args);
            return chosen;
        });
        const run = (withProbe: boolean) => {
            probe = withProbe;
            decisions = [];
            summons = new Set();
            const result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster,
                redRoster: roster,
                seed: 14_319_101,
                searchOfflineDeterministicWork: true,
                searchEnvOverrideTeams: [1, 2],
                maxLaps: 8,
                decisionObserver: ({ context }) => {
                    for (const unit of context.unitsHolder.getAllUnits().values()) {
                        if (unit.isSummoned()) summons.add(unit.getId());
                    }
                },
            });
            return { decisions, summons: [...summons], winner: result.winner, laps: result.laps };
        };
        try {
            const control = run(false);
            const observed = run(true);
            expect(control.summons.length).toBeGreaterThan(0);
            expect(observed).toEqual(control);
        } finally {
            intercept.mockRestore();
        }
    },
    30_000,
);
