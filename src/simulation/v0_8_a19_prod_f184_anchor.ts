/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { augmentPlanId, setupAugmentsForPlan, type IAugmentPlan } from "../ai/setup/setup_ship";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Perk } from "../perks/perk_properties";
import { ChaosSynergy, LifeSynergy, MightSynergy, NatureSynergy } from "../synergies/synergy_properties";
import { hashSimulationParts, type IArmyUnitSpec } from "./army";
import { chooseMetaArmy, type IAiMetaArmy } from "./ai_meta_cohorts_core";

/** Complete human ranked game whose anti-flyer role bands motivated the placement correction. */
export const V08_A19_PROD_F184_MATCH_ID = "f1841493-c0bd-41e8-9281-27ce531ece8b" as const;
export const V08_A19_PROD_F184_COHORT = "prod-ranked-f184" as const;
export const V08_A19_PROD_F184_FIXTURE_ID = "prod-ranked-f184-v1" as const;

interface IRecordedArmySetup {
    readonly creatureIds: readonly number[];
    readonly roster: readonly IArmyUnitSpec[];
    readonly artifactT1: number;
    readonly artifactT2: number;
    readonly perk: Perk;
    /** Recorded Empower augment; zero and therefore absent from the legacy simulation setup wire. */
    readonly empower: 0;
    readonly augmentPlan: Readonly<IAugmentPlan>;
    readonly synergies: readonly { faction: number; synergy: number; level: 1 | 2 | 3 }[];
}

const LOWER_SETUP: IRecordedArmySetup = Object.freeze({
    creatureIds: Object.freeze([3, 33, 6, 4, 37, 9]),
    roster: Object.freeze([
        Object.freeze({ faction: "Chaos", creatureName: "Troglodyte", level: 1, size: 1, amount: 125 }),
        Object.freeze({ faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 124 }),
        Object.freeze({ faction: "Chaos", creatureName: "Beholder", level: 2, size: 1, amount: 22 }),
        Object.freeze({ faction: "Chaos", creatureName: "Troll", level: 2, size: 1, amount: 25 }),
        Object.freeze({ faction: "Life", creatureName: "Griffin", level: 3, size: 1, amount: 9 }),
        Object.freeze({ faction: "Chaos", creatureName: "Black Dragon", level: 4, size: 2, amount: 1 }),
    ]),
    artifactT1: 10,
    artifactT2: 4,
    perk: Perk.SEE_NONE,
    empower: 0,
    augmentPlan: Object.freeze({ placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 }),
    synergies: Object.freeze([
        Object.freeze({ faction: PBTypes.FactionVals.LIFE, synergy: LifeSynergy.PLUS_MORALE_AND_LUCK, level: 1 }),
        Object.freeze({ faction: PBTypes.FactionVals.CHAOS, synergy: ChaosSynergy.MOVEMENT, level: 2 }),
    ]),
});

const UPPER_SETUP: IRecordedArmySetup = Object.freeze({
    creatureIds: Object.freeze([47, 12, 55, 34, 27, 43]),
    roster: Object.freeze([
        Object.freeze({ faction: "Nature", creatureName: "Dryad", level: 1, size: 1, amount: 100 }),
        Object.freeze({ faction: "Might", creatureName: "Berserker", level: 1, size: 1, amount: 109 }),
        Object.freeze({ faction: "Life", creatureName: "Battle Mage", level: 2, size: 1, amount: 50 }),
        Object.freeze({ faction: "Life", creatureName: "Valkyrie", level: 2, size: 1, amount: 29 }),
        Object.freeze({ faction: "Nature", creatureName: "Mantis", level: 3, size: 1, amount: 12 }),
        Object.freeze({ faction: "Might", creatureName: "Frenzied Boar", level: 4, size: 2, amount: 2 }),
    ]),
    artifactT1: 8,
    artifactT2: 9,
    perk: Perk.SEE_NONE,
    empower: 0,
    augmentPlan: Object.freeze({ placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 }),
    synergies: Object.freeze([
        Object.freeze({ faction: PBTypes.FactionVals.LIFE, synergy: LifeSynergy.PLUS_MORALE_AND_LUCK, level: 1 }),
        Object.freeze({
            faction: PBTypes.FactionVals.MIGHT,
            synergy: MightSynergy.PLUS_STACK_ABILITIES_POWER,
            level: 1,
        }),
        Object.freeze({ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.PLUS_FLY_ARMOR, level: 1 }),
    ]),
});

export const V08_A19_PROD_F184_ANCHOR = Object.freeze({
    provenance: Object.freeze({
        fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
        source: "production GamesTest1 + PicksTest1 + JournalEntriesTest1 terminal report; PM2 play-action placement log" as const,
        matchId: V08_A19_PROD_F184_MATCH_ID,
        setupRecorded: true as const,
        terminalReportCompleteReplay: true as const,
        journalFull: false as const,
        completeInitialSetupRecovered: true as const,
    }),
    map: PBTypes.GridVals.NORMAL,
    defaultPlacementDepth: 3 as const,
    lower: LOWER_SETUP,
    upper: UPPER_SETUP,
    observedPlacement: Object.freeze({
        lower: Object.freeze([
            Object.freeze({ creatureId: 3, creatureName: "Troglodyte", x: 13, y: 2 }),
            Object.freeze({ creatureId: 33, creatureName: "Arbalester", x: 14, y: 1 }),
            Object.freeze({ creatureId: 6, creatureName: "Beholder", x: 13, y: 1 }),
            Object.freeze({ creatureId: 4, creatureName: "Troll", x: 14, y: 2 }),
            Object.freeze({ creatureId: 37, creatureName: "Griffin", x: 10, y: 3 }),
            Object.freeze({ creatureId: 9, creatureName: "Black Dragon", x: 9, y: 3 }),
        ]),
        upper: Object.freeze([
            Object.freeze({ creatureId: 47, creatureName: "Dryad", x: 6, y: 14 }),
            Object.freeze({ creatureId: 12, creatureName: "Berserker", x: 2, y: 13 }),
            Object.freeze({ creatureId: 55, creatureName: "Battle Mage", x: 4, y: 14 }),
            Object.freeze({ creatureId: 34, creatureName: "Valkyrie", x: 6, y: 12 }),
            Object.freeze({ creatureId: 27, creatureName: "Mantis", x: 4, y: 12 }),
            Object.freeze({ creatureId: 43, creatureName: "Frenzied Boar", x: 9, y: 13 }),
        ]),
    }),
});

/**
 * SHA-256 of JSON.stringify(V08_A19_PROD_F184_ANCHOR), verified by the harness tests.
 *
 * Re-pinned for the perk -> perk rename: the anchor's VALUES are untouched (still Perk.SEE_NONE
 * on both seats) — only the field name inside the object moved, which JSON.stringify includes in the
 * bytes it hashes. The recorded production setup itself is unchanged.
 */
export const V08_A19_PROD_F184_FIXTURE_SHA256 =
    "6649cc5a3fe134f0289c1d6ffb8a056cf25e1a56d6c45f5a34f53354b1cdc0a1" as const;

const recordedArmy = (setup: IRecordedArmySetup, opponent: IRecordedArmySetup, seed: number): IAiMetaArmy => {
    const base = chooseMetaArmy(
        "ranked",
        setup.roster.map((unit) => ({ ...unit })),
        opponent.roster,
        V08_A19_PROD_F184_ANCHOR.map,
        seed,
    );
    if (JSON.stringify(base.creatureIds) !== JSON.stringify(setup.creatureIds)) {
        throw new Error(`Production ${V08_A19_PROD_F184_MATCH_ID} roster no longer resolves to its recorded ids`);
    }
    const plan = { ...setup.augmentPlan };
    return {
        ...base,
        artifactT1: { id: setup.artifactT1, mode: "exploit", propensity: 1, contextualScore: 0 },
        artifactT2: { id: setup.artifactT2, mode: "exploit", propensity: 1, contextualScore: 0 },
        augment: {
            plan,
            planId: augmentPlanId(plan),
            augments: setupAugmentsForPlan(plan),
            mode: "exploit",
            propensity: 1,
            contextualScore: 0,
        },
        perk: setup.perk,
        synergies: setup.synergies.map(({ faction, synergy }) => ({ faction, synergy })),
    };
};

/** Rebuild the exact production setup while varying only the preregistered combat seed by cluster. */
export function prepareV08A19ProdF184Pair(
    baseSeed: number,
    cluster: number,
): {
    setupSeed: number;
    combatSeed: number;
    map: typeof V08_A19_PROD_F184_ANCHOR.map;
    armyA: IAiMetaArmy;
    armyB: IAiMetaArmy;
} {
    const setupSeed = hashSimulationParts("ai-meta-setup", baseSeed, V08_A19_PROD_F184_COHORT, cluster);
    const combatSeed = hashSimulationParts("ai-meta-combat", baseSeed, V08_A19_PROD_F184_COHORT, cluster);
    return {
        setupSeed,
        combatSeed,
        map: V08_A19_PROD_F184_ANCHOR.map,
        armyA: recordedArmy(LOWER_SETUP, UPPER_SETUP, hashSimulationParts(setupSeed, "lower")),
        armyB: recordedArmy(UPPER_SETUP, LOWER_SETUP, hashSimulationParts(setupSeed, "upper")),
    };
}
