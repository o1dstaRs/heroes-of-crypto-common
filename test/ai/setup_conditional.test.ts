import { describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    CONDITIONAL_SETUP_RULES,
    SNIPER_PIN_MIN_RANGED,
    TIER2_ARTIFACT_WINRATE_MELEE,
    TIER2_ARTIFACT_WINRATE_RANGED,
    conditionalArtifactT2,
    conditionalAugments,
    conditionalRulesFromEnv,
    conditionalSynergies,
    ownComposition,
    parseConditionalRules,
} from "../../src/ai/setup/setup_conditional";
import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const ALL_RULES = parseConditionalRules("all");
const NO_RULES = parseConditionalRules(undefined);

const allCreatureIds = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && !!creatureInfo(value),
);
const rangedIds = allCreatureIds.filter((id) => creatureInfo(id)!.ranged);
const meleeGroundIds = allCreatureIds.filter((id) => !creatureInfo(id)!.ranged && !creatureInfo(id)!.canFly);
const flyerIds = allCreatureIds.filter((id) => !creatureInfo(id)!.ranged && creatureInfo(id)!.canFly);

/** A six-stack roster with exactly `ranged` ranged stacks, the rest ground melee. */
const rosterWithRanged = (ranged: number): number[] => [
    ...rangedIds.slice(0, ranged),
    ...meleeGroundIds.slice(0, 6 - ranged),
];

describe("conditional setup v1 — env gate / rule parsing", () => {
    test("default OFF: unset, empty, off and junk specs activate nothing", () => {
        expect(parseConditionalRules(undefined).size).toBe(0);
        expect(parseConditionalRules("").size).toBe(0);
        expect(parseConditionalRules("off").size).toBe(0);
        expect(parseConditionalRules("0").size).toBe(0);
        expect(parseConditionalRules("bogus,also-bogus").size).toBe(0);
        expect(conditionalRulesFromEnv({}).size).toBe(0);
    });

    test("on/1/all activate every shipped rule; comma lists select known subsets", () => {
        for (const spec of ["on", "1", "all", "ON", "All"]) {
            expect([...parseConditionalRules(spec)].sort()).toEqual([...CONDITIONAL_SETUP_RULES].sort());
        }
        expect([...parseConditionalRules("sniper")]).toEqual(["sniper"]);
        expect([...parseConditionalRules("t2")]).toEqual(["t2"]);
        expect([...parseConditionalRules("sniper, t2")].sort()).toEqual(["sniper", "t2"]);
        expect(conditionalRulesFromEnv({ V07_SETUP_CONDITIONAL: "sniper" }).has("sniper")).toBe(true);
    });
});

describe("conditional setup v1 — ownComposition", () => {
    test("counts ranged first, then flyers, else ground melee (unknown ids skipped)", () => {
        const ids = [rangedIds[0], meleeGroundIds[0], meleeGroundIds[1], flyerIds[0], -999];
        const composition = ownComposition(ids);
        expect(composition.total).toBe(4);
        expect(composition.ranged).toBe(1);
        expect(composition.flyer).toBe(1);
        expect(composition.groundMelee).toBe(2);
    });
});

describe("conditional setup v1 — sniper augment rule", () => {
    test("2+ own ranged stacks pin Sniper3 > Armor3 > Might with the SEE_NONE budget", () => {
        expect(conditionalAugments(7, rosterWithRanged(SNIPER_PIN_MIN_RANGED), ALL_RULES)).toEqual([
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
        ]);
    });

    test("below the threshold (or rule off / empty roster) the spend is byte-identical to setup-v0", () => {
        const anchor = SETUP_POLICY_V0.pickAugments(7);
        expect(conditionalAugments(7, rosterWithRanged(1), ALL_RULES)).toEqual(anchor);
        expect(conditionalAugments(7, rosterWithRanged(0), ALL_RULES)).toEqual(anchor);
        expect(conditionalAugments(7, rosterWithRanged(4), NO_RULES)).toEqual(anchor);
        expect(conditionalAugments(7, rosterWithRanged(4), parseConditionalRules("t2"))).toEqual(anchor);
        expect(conditionalAugments(7, [], ALL_RULES)).toEqual(anchor);
    });

    test("partial budgets spend down the pinned order without overflow", () => {
        const roster = rosterWithRanged(3);
        expect(conditionalAugments(3, roster, ALL_RULES)).toEqual([{ kind: "Sniper", value: 3 }]);
        expect(conditionalAugments(4, roster, ALL_RULES)).toEqual([
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 1 },
        ]);
        expect(conditionalAugments(0, roster, ALL_RULES)).toEqual([]);
    });
});

describe("conditional setup v1 — tier-2 rule", () => {
    test("ranged-heavy roster picks by the ranged cohort table (Farsight Quiver over the blind Titan pick)", () => {
        const offered = [Tier2Artifact.FARSIGHT_QUIVER, Tier2Artifact.TITAN_PLATE, Tier2Artifact.HOLY_CROSS];
        // Static/blind policy prefers Titan Plate (63.9 in the refreshed blind table; see setup_strategy.ts).
        expect(SETUP_POLICY_V0.pickArtifactT2(offered)).toBe(Tier2Artifact.TITAN_PLATE);
        // On a 2-3-ranged roster Farsight measured 88.8 vs Titan 67.2.
        expect(conditionalArtifactT2(offered, rosterWithRanged(2), ALL_RULES)).toBe(Tier2Artifact.FARSIGHT_QUIVER);
    });

    test("melee roster picks by the melee cohort table (Giant's Maul over the blind Rime Charm pick)", () => {
        // Post the 2026-07-15 blind-table refresh (setup_strategy.ts), the blind and melee-cohort tables now
        // AGREE that Tome of Amplification beats Titan Plate (the refresh's whole point — the blind table was
        // stale pre-LIVETWIN/pre-augment-seeding-fix). Giant's Maul vs Rime Charm is a pair where the two
        // tables still genuinely disagree: blind prefers Rime Charm (46.3 > 45.3), the melee cohort prefers
        // Giant's Maul (44.2 > 42.0) — still a real conditional-vs-blind divergence to exercise here.
        const offered = [Tier2Artifact.RIME_CHARM, Tier2Artifact.GIANTS_MAUL];
        expect(SETUP_POLICY_V0.pickArtifactT2(offered)).toBe(Tier2Artifact.RIME_CHARM);
        expect(conditionalArtifactT2(offered, rosterWithRanged(0), ALL_RULES)).toBe(Tier2Artifact.GIANTS_MAUL);
    });

    test("argmax follows the measured tables for arbitrary offers", () => {
        const offered = [Tier2Artifact.RIME_CHARM, Tier2Artifact.GIANTS_MAUL, Tier2Artifact.CROWN_OF_COMMAND];
        const argmax = (table: Record<number, number>): number =>
            offered.reduce((best, id) => ((table[id] ?? -1) > (table[best] ?? -1) ? id : best));
        expect(conditionalArtifactT2(offered, rosterWithRanged(3), ALL_RULES)).toBe(
            argmax(TIER2_ARTIFACT_WINRATE_RANGED),
        );
        expect(conditionalArtifactT2(offered, rosterWithRanged(1), ALL_RULES)).toBe(
            argmax(TIER2_ARTIFACT_WINRATE_MELEE),
        );
    });

    test("rule off or uncovered composition falls back to setup-v0's blind pick", () => {
        const offered = [Tier2Artifact.FARSIGHT_QUIVER, Tier2Artifact.TITAN_PLATE];
        const blind = SETUP_POLICY_V0.pickArtifactT2(offered);
        expect(conditionalArtifactT2(offered, rosterWithRanged(3), NO_RULES)).toBe(blind);
        expect(conditionalArtifactT2(offered, rosterWithRanged(3), parseConditionalRules("sniper"))).toBe(blind);
        expect(conditionalArtifactT2(offered, [], ALL_RULES)).toBe(blind);
    });

    test("both cohort tables cover the full tier-2 pool", () => {
        for (let id = 1; id <= 12; id += 1) {
            expect(TIER2_ARTIFACT_WINRATE_MELEE[id]).toBeNumber();
            expect(TIER2_ARTIFACT_WINRATE_RANGED[id]).toBeNumber();
        }
    });
});

describe("conditional setup v1 — synergies", () => {
    test("no synergy rule shipped: delegates to setup-v0 (fresh probes confirmed the fixed table)", () => {
        const roster = rosterWithRanged(2);
        expect(conditionalSynergies(roster)).toEqual(SETUP_POLICY_V0.pickSynergies(roster));
        expect(conditionalSynergies([])).toEqual([]);
    });
});
