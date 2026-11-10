import { afterEach, expect, test } from "bun:test";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { withBattleMageShortlistResearch } from "../../src/simulation/battle_mage_shortlist_research";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

type Methods = {
    effectiveShortlist(version: string, unit?: Unit): number | null;
    shortlistCandidates(unit: Unit, candidates: readonly IEnumeratedCandidate[]): readonly IEnumeratedCandidate[];
};
const prototype = SearchDriver.prototype as unknown as Methods;
const effective = prototype.effectiveShortlist;
const shortlist = prototype.shortlistCandidates;
const choose = SearchDriver.prototype.chooseDecision;
afterEach(() => {
    prototype.effectiveShortlist = effective;
    prototype.shortlistCandidates = shortlist;
    SearchDriver.prototype.chooseDecision = choose;
});
const mage = (team = PBTypes.TeamVals.LEFT, name = "Battle Mage") =>
    ({ getName: () => name, getTeam: () => team, getId: () => "actor" }) as Unit;

test("expands only the selected team's six-choice Battle Mage budget", () => {
    let budget: number | null = 6;
    const original = () => budget;
    prototype.effectiveShortlist = original;
    withBattleMageShortlistResearch(PBTypes.TeamVals.LEFT, () => {
        expect(prototype.effectiveShortlist("v0.8", mage())).toBe(8);
        expect(prototype.effectiveShortlist("v0.8", mage(PBTypes.TeamVals.RIGHT))).toBe(6);
        expect(prototype.effectiveShortlist("v0.8", mage(PBTypes.TeamVals.LEFT, "Wandering Mage"))).toBe(6);
        expect(prototype.effectiveShortlist("v0.8s", mage())).toBe(6);
        for (budget of [2, 8, null]) expect(prototype.effectiveShortlist("v0.8", mage())).toBe(budget);
    });
    expect(prototype.effectiveShortlist).toBe(original);
    budget = 6;
    withBattleMageShortlistResearch(null, () => expect(prototype.effectiveShortlist("v0.8", mage())).toBe(6));
});

test("diagnostic records are detached and preserve the native result and finalist array", () => {
    const actions: GameAction[] = [{ type: "wait_turn", unitId: "actor" }];
    const candidates = [
        { kind: "wait", actions, features: { expectedDamage: 0, expectedKill: 0 } },
    ] as IEnumeratedCandidate[];
    prototype.shortlistCandidates = (_unit, values) => values;
    SearchDriver.prototype.chooseDecision = (unit) => {
        expect(prototype.shortlistCandidates(unit, candidates)).toBe(candidates);
        return actions;
    };
    withBattleMageShortlistResearch(
        null,
        () => {
            expect(SearchDriver.prototype.chooseDecision.call({} as SearchDriver, mage(), "v0.8", actions)).toBe(
                actions,
            );
        },
        (trace) => {
            expect(trace.catalogs[0].finalistIndices).toEqual([0]);
            trace.chosen.length = 0;
            trace.incumbent.length = 0;
            trace.catalogs[0].candidates[0].actions.length = 0;
        },
    );
    expect(actions).toHaveLength(1);
    expect(candidates[0].actions).toHaveLength(1);
});

test("restores every method after throws and rejects unsafe scope lifetimes", () => {
    expect(() =>
        withBattleMageShortlistResearch(null, () => {
            throw new Error("probe");
        }),
    ).toThrow("probe");
    expect(() => withBattleMageShortlistResearch(null, () => Promise.resolve(1))).toThrow("synchronous");
    expect(() => withBattleMageShortlistResearch(null, () => withBattleMageShortlistResearch(null, () => 1))).toThrow(
        "nested",
    );
    expect(() => withBattleMageShortlistResearch(0 as never, () => 1)).toThrow("physical team");
    expect(prototype.effectiveShortlist).toBe(effective);
    expect(prototype.shortlistCandidates).toBe(shortlist);
    expect(SearchDriver.prototype.chooseDecision).toBe(choose);
});
