import { expect, test } from "bun:test";

import type { IAiMetaArmy, IAiMetaGameOutcome, IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import { AiMetaUnitInteractionCollector } from "../../src/simulation/ai_meta_unit_interactions";

const outcome = (winner: "a" | "b"): IAiMetaGameOutcome => ({
    aIsGreen: winner === "a",
    winner,
    laps: 5,
    endReason: "elimination",
    armageddonDecided: false,
    rejectedA: 0,
    rejectedB: 0,
    hpA: winner === "a" ? 100 : 0,
    hpB: winner === "b" ? 100 : 0,
    survivorsA: winner === "a" ? 2 : 0,
    survivorsB: winner === "b" ? 2 : 0,
});

const army = (names: readonly string[], setupCohort: string): IAiMetaArmy =>
    ({
        roster: names.map((creatureName, index) => ({
            faction: "Might",
            creatureName,
            level: (index < 2 ? 1 : index < 4 ? 2 : index === 4 ? 3 : 4) as 1 | 2 | 3 | 4,
            size: 1,
            amount: 1,
        })),
        creatureIds: names.map((_, index) => index + 1),
        features: {},
        setupCohort,
        artifactT1: { id: 1, mode: "exploit", propensity: 1, contextualScore: 0 },
        artifactT2: { id: 1, mode: "exploit", propensity: 1, contextualScore: 0 },
        augment: {
            plan: { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0 },
            planId: "P0-A0-M0-S0-V0",
            augments: [],
            mode: "exploit",
            propensity: 1,
            contextualScore: 0,
        },
        doctrine: 0,
        synergies: [],
    }) as unknown as IAiMetaArmy;

function record(pair: number): IAiMetaPairRecord {
    const strongPair = pair % 2 === 0;
    const nemesis = pair % 4 < 2;
    return {
        schemaVersion: 1,
        cohort: "uniform-mixed",
        pair,
        setupSeed: pair,
        combatSeed: pair + 10_000,
        map: 1,
        armyA: army(
            strongPair
                ? ["Alpha", "Bravo", "Cinder", "Drake", "Elm", "Flint"]
                : ["Alpha", "Cobalt", "Cinder", "Drake", "Elm", "Flint"],
            "ranged-other",
        ),
        armyB: army(
            nemesis
                ? ["Nemesis", "Onyx", "Pearl", "Quartz", "Ruby", "Slate"]
                : ["Topaz", "Umber", "Violet", "Willow", "Xenon", "Yarrow"],
            "melee-other",
        ),
        games: [outcome(strongPair ? "a" : "b"), outcome(strongPair ? "a" : "b")],
    };
}

test("collects cross-fitted ally pairs, trios, and per-unit counter rows", () => {
    const collector = new AiMetaUnitInteractionCollector();
    for (let pair = 0; pair < 80; pair += 1) collector.add(record(pair));

    const analysis = collector.analyze({
        minimumPairSupport: 4,
        minimumTrioSupport: 4,
        minimumCounterSupport: 4,
    });

    const alphaBravo = analysis.allyPairs.find((row) => row.name === "Alpha + Bravo");
    const alphaBravoCinder = analysis.allyTrios.find((row) => row.name === "Alpha + Bravo + Cinder");
    const alphaVersusNemesis = analysis.counters.find((row) => row.unit === "Alpha" && row.enemyUnit === "Nemesis");
    const alphaLeaders = analysis.topCounters.find((row) => row.unit === "Alpha");

    expect(analysis.scope).toMatchObject({ maps: [1], cohorts: ["uniform-mixed"], pairs: 80, games: 160 });
    expect(alphaBravo).toMatchObject({ pairs: 40, games: 80 });
    expect(alphaBravoCinder).toMatchObject({ pairs: 40, games: 80 });
    expect(alphaVersusNemesis).toMatchObject({ pairs: 40, games: 80 });
    expect(alphaLeaders?.counters).toHaveLength(5);
    expect(Number.isFinite(alphaBravo?.expectedScoreRate)).toBe(true);
    expect(Number.isFinite(alphaBravo?.adjustedLiftPp)).toBe(true);
    expect(Number.isFinite(alphaVersusNemesis?.adjustedCiLowPp)).toBe(true);
});

test("keeps interaction rows deterministic when worker completion order differs", () => {
    const forward = new AiMetaUnitInteractionCollector();
    const reverse = new AiMetaUnitInteractionCollector();
    const records = Array.from({ length: 80 }, (_, pair) => record(pair));
    records.forEach((entry) => forward.add(entry));
    [...records].reverse().forEach((entry) => reverse.add(entry));

    const options = { minimumPairSupport: 4, minimumTrioSupport: 4, minimumCounterSupport: 4 };
    expect(reverse.analyze(options)).toEqual(forward.analyze(options));
});

test("reports cohorts in protocol order regardless of cohort completion order", () => {
    const rankedFirst = new AiMetaUnitInteractionCollector();
    const casterFirst = new AiMetaUnitInteractionCollector();
    const ranked = Array.from({ length: 10 }, (_, pair) => ({ ...record(pair), cohort: "ranked-draft" as const }));
    const caster = Array.from({ length: 10 }, (_, pair) => ({ ...record(pair), cohort: "caster-support" as const }));

    [...ranked, ...caster].forEach((entry) => rankedFirst.add(entry));
    [...caster, ...ranked].forEach((entry) => casterFirst.add(entry));

    expect(rankedFirst.analyze().scope.cohorts).toEqual(["ranked-draft", "caster-support"]);
    expect(casterFirst.analyze().scope.cohorts).toEqual(["ranked-draft", "caster-support"]);
});
