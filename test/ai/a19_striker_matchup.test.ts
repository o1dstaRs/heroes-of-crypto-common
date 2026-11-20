import { expect, test } from "bun:test";

import { isA19DeliveryMelee } from "../../src/ai/setup/a19_revealed_ranged_draft";
import {
    A19_STRIKER_MATCHUP_MELEE_PRIOR,
    A19_STRIKER_MATCHUP_POLICY,
    A19_STRIKER_MATCHUP_VALUES,
    a19OpponentMeleeProbability,
    a19StrikerMatchupBundle,
    a19StrikerMatchupCreature,
    a19StrikerMatchupValue,
} from "../../src/ai/setup/a19_striker_matchup";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import decisions from "./fixtures/a19_striker_matchup_decisions.json";

const C = PBTypes.CreatureVals;
const strikers = [C.SQUIRE, C.BERSERKER, C.HYENA, C.NOMAD, C.CRUSADER, C.CHAMPION];
const shooters = [C.ORC, C.ARBALESTER, C.MEDUSA, C.BEHOLDER, C.ZENA, C.GARGANTUAN];

test("the policy has a stable identity", () => {
    expect(A19_STRIKER_MATCHUP_POLICY).toBe("a19-striker-matchup-v1");
});

test("every valued creature is a striker, with one rush and one melee value", () => {
    const ids = Object.keys(A19_STRIKER_MATCHUP_VALUES).map(Number);
    expect(ids.length).toBe(34);
    for (const id of ids) {
        expect(isA19DeliveryMelee(id)).toBe(true);
        expect(creatureInfo(id)).toBeDefined();
        const [rush, melee] = A19_STRIKER_MATCHUP_VALUES[id];
        expect(Number.isFinite(rush) && Number.isFinite(melee)).toBe(true);
        expect(Math.abs(rush)).toBeLessThan(20);
        expect(Math.abs(melee)).toBeLessThan(20);
    }
    for (const id of shooters) expect(A19_STRIKER_MATCHUP_VALUES[id]).toBeUndefined();
    // Unvalued creatures count as the average striker of their level.
    expect(a19StrikerMatchupValue(999_999, 0.3)).toBe(0);
});

test("the melee probability starts at the prior and follows what the seat can see", () => {
    const blind = a19OpponentMeleeProbability([]);
    expect(blind).toBeGreaterThan(A19_STRIKER_MATCHUP_MELEE_PRIOR - 0.05);
    expect(blind).toBeLessThan(A19_STRIKER_MATCHUP_MELEE_PRIOR + 0.05);
    let previous = blind;
    for (let seen = 1; seen <= 6; seen++) {
        const probability = a19OpponentMeleeProbability(strikers.slice(0, seen));
        expect(probability).toBeGreaterThan(previous - 1e-12);
        previous = probability;
    }
    expect(a19OpponentMeleeProbability(strikers)).toBe(1);
    expect(a19OpponentMeleeProbability(strikers.slice(0, 2))).toBeGreaterThan(0.9);
    previous = blind;
    for (let seen = 1; seen <= 6; seen++) {
        const probability = a19OpponentMeleeProbability(shooters.slice(0, seen));
        expect(probability).toBeLessThan(previous + 1e-12);
        previous = probability;
    }
    // Three shooters seen: four strikers can no longer be reached.
    expect(a19OpponentMeleeProbability(shooters.slice(0, 3))).toBe(0);
    expect(a19OpponentMeleeProbability(shooters)).toBe(0);
    // Exactly four strikers is a melee army, three is not; a repeated id is one creature.
    expect(a19OpponentMeleeProbability([...strikers.slice(0, 4), ...shooters.slice(0, 2)])).toBe(1);
    expect(a19OpponentMeleeProbability([...strikers.slice(0, 3), ...shooters.slice(0, 3)])).toBe(0);
    expect(a19OpponentMeleeProbability([C.SQUIRE, C.SQUIRE])).toBe(a19OpponentMeleeProbability([C.SQUIRE]));
});

test("the same offer is answered differently against shooters and against a melee army", () => {
    const offer = [C.GRIFFIN, C.CRUSADER, C.GOBLIN_KNIGHT, C.ZENA];
    // Against revealed shooters the rush is on: the flyer.
    expect(a19StrikerMatchupCreature(C.GOBLIN_KNIGHT, offer, shooters.slice(0, 4))).toBe(C.GRIFFIN);
    // Against revealed strikers nobody rushes: the unit that carries a brawl.
    expect(a19StrikerMatchupCreature(C.GOBLIN_KNIGHT, offer, strikers.slice(0, 4))).toBe(C.CRUSADER);
    const top = [C.ANGEL, C.HYDRA, C.FRENZIED_BOAR];
    expect(a19StrikerMatchupCreature(C.FRENZIED_BOAR, top, shooters.slice(0, 5))).toBe(C.ANGEL);
    expect(a19StrikerMatchupCreature(C.FRENZIED_BOAR, top, strikers.slice(0, 5))).toBe(C.HYDRA);
});

test("the head's choice stands without a striker on offer, on a tie, and is never replaced by a non-striker", () => {
    expect(a19StrikerMatchupCreature(C.ZENA, [C.ZENA, C.CYCLOPS, C.MONK], strikers)).toBe(C.ZENA);
    expect(a19StrikerMatchupCreature(C.CRUSADER, [C.CRUSADER], shooters)).toBe(C.CRUSADER);
    // Two creatures without a measured value tie: the head's stays.
    expect(a19StrikerMatchupCreature(999_998, [999_998, 999_999], [])).toBe(999_998);
    for (const known of [[], shooters.slice(0, 3), strikers.slice(0, 3)]) {
        const choice = a19StrikerMatchupCreature(C.GRIFFIN, [C.GRIFFIN, C.CRUSADER, C.ZENA, C.CYCLOPS], known);
        expect(isA19DeliveryMelee(choice)).toBe(true);
    }
});

test("the opening bundle counts strikers first and breaks ties by matchup value", () => {
    const bundles = [
        [C.ORC, C.MEDUSA, 10],
        [C.WOLF, C.MANTICORE, 4],
        [C.FAIRY, C.PIKEMAN, 5],
        [C.FAIRY, C.MEDUSA, 5],
    ] as const;
    // Two strikers beat one, whatever the single striker is worth.
    expect(a19StrikerMatchupBundle([bundles[0], bundles[3]], 0, [])).toBe(1);
    expect(a19StrikerMatchupBundle([bundles[3], bundles[1]], 0, [])).toBe(1);
    // Among two-striker bundles the better pair for the matchup wins, from either starting point.
    expect(a19StrikerMatchupBundle(bundles, 1, strikers.slice(0, 2))).toBe(2);
    expect(a19StrikerMatchupBundle(bundles, 2, strikers.slice(0, 2))).toBe(2);
    // The head's bundle is kept on an exact tie and when nothing is offered.
    expect(a19StrikerMatchupBundle([bundles[1], bundles[1]], 1, [])).toBe(1);
    expect(a19StrikerMatchupBundle([bundles[1], bundles[1]], 0, [])).toBe(0);
    expect(a19StrikerMatchupBundle([], 0, [])).toBe(0);
});

test("the production functions reproduce the research draft decisions they were confirmed with", () => {
    expect(decisions.length).toBeGreaterThan(100);
    let changed = 0;
    for (const decision of decisions) {
        expect(a19OpponentMeleeProbability(decision.known)).toBeCloseTo(decision.q, 12);
        const choice =
            decision.kind === "bundle"
                ? a19StrikerMatchupBundle(
                      decision.bundles as unknown as [number, number, number][],
                      decision.head,
                      decision.known,
                  )
                : a19StrikerMatchupCreature(decision.head, decision.available!, decision.known);
        expect(choice).toBe(decision.choice);
        if (decision.choice !== decision.head) changed++;
    }
    // The fixture is not a set of no-ops.
    expect(changed).toBeGreaterThan(40);
});
