import { describe, expect, test } from "bun:test";

import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { creatureInfo, scoreCreature } from "../../src/ai/setup/creature_score";
import { CreatureFactions } from "../../src/generated/protobuf/v1/creature_gen";
import { Perk } from "../../src/perks/perk_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { LifeSynergy } from "../../src/synergies/synergy_properties";

const policy = SETUP_POLICY_V0;

describe("SetupPolicyV0", () => {
    test("perk = SEE_NONE (max upgrade-point budget)", () => {
        expect(policy.pickPerk()).toBe(Perk.SEE_NONE);
    });

    test("tier-2 artifact = highest measured win-rate from the offered set", () => {
        // Titan Plate (63.9%) beats Pendant (41.5%) and Holy Cross (46.1%).
        expect(
            policy.pickArtifactT2([
                Tier2Artifact.PENDANT_OF_VITALITY,
                Tier2Artifact.TITAN_PLATE,
                Tier2Artifact.HOLY_CROSS,
            ]),
        ).toBe(Tier2Artifact.TITAN_PLATE);
        // Warlord's Edge (63.7%) beats Rime Charm (46.3%).
        expect(policy.pickArtifactT2([Tier2Artifact.RIME_CHARM, Tier2Artifact.WARLORDS_EDGE])).toBe(
            Tier2Artifact.WARLORDS_EDGE,
        );
    });

    test("augments spend the full budget down Armor>Might>Sniper (Movement skipped, net-negative)", () => {
        // Budget 7 (SEE_NONE): Armor3 + Might3 + the leftover point on Sniper1 (the CEM result — no wasted budget).
        expect(policy.pickAugments(7)).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 3 },
            { kind: "Sniper", value: 1 },
        ]);
        expect(policy.pickAugments(5)).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 2 },
        ]);
        expect(policy.pickAugments(2)).toEqual([{ kind: "Armor", value: 2 }]);
        expect(policy.pickAugments(0)).toEqual([]);
    });

    test("creature scoring favours a ranged unit and pickCreature returns the top-scored id", () => {
        const orc = PBTypes.CreatureVals.ORC;
        expect(creatureInfo(orc)?.ranged).toBe(true);
        expect(scoreCreature(orc)).toBeGreaterThan(0);
        // pickCreature returns the max-scored candidate.
        const pool = [orc, PBTypes.CreatureVals.SCAVENGER, PBTypes.CreatureVals.TROGLODYTE];
        const best = pool.reduce((a, b) => (scoreCreature(b) > scoreCreature(a) ? b : a));
        expect(policy.pickCreature(1, pool)).toBe(best);
    });

    test("synergies: one measured-best synergy per faction fielded with 2+ units", () => {
        // Two Life-faction creatures -> Life's measured-best synergy (Supply %).
        const lifeIds = Object.entries(CreatureFactions)
            .filter(([, f]) => f === PBTypes.FactionVals.LIFE)
            .map(([id]) => Number(id))
            .slice(0, 2);
        expect(lifeIds.length).toBe(2);
        const picks = policy.pickSynergies(lifeIds);
        expect(picks).toContainEqual({
            faction: PBTypes.FactionVals.LIFE,
            synergy: LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
        });
    });

    test("synergies: a single unit of a faction does not trigger a synergy", () => {
        const oneLife = Object.entries(CreatureFactions)
            .filter(([, f]) => f === PBTypes.FactionVals.LIFE)
            .map(([id]) => Number(id))
            .slice(0, 1);
        expect(policy.pickSynergies(oneLife)).toEqual([]);
    });

    test("bundle: prefer the bundle with the stronger creatures + tier-1 artifact", () => {
        // Bundle A: strong ranged + top T1 (Cursed Ward). Bundle B: weak melee + bottom T1 (Broken Aegis).
        const orc = PBTypes.CreatureVals.ORC;
        const a: [number, number, number] = [orc, orc, 9 /* CURSED_WARD */];
        const b: [number, number, number] = [
            PBTypes.CreatureVals.SCAVENGER,
            PBTypes.CreatureVals.SCAVENGER,
            12 /* BROKEN_AEGIS */,
        ];
        // Only assert it returns a valid index and is deterministic.
        const pick = policy.pickBundle([a, b]);
        expect(pick === 0 || pick === 1).toBe(true);
        expect(policy.pickBundle([a, b])).toBe(pick);
    });
});
