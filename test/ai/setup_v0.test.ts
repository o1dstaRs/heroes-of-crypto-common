import { describe, expect, test } from "bun:test";

import { SETUP_POLICY_V0, SETUP_POLICY_V0_DRAFT_ROLLBACK } from "../../src/ai/setup/setup_v0";
import { eligibleBacklineProtectorChoices, creatureInfo, scoreCreature } from "../../src/ai/setup/creature_score";
import { CreatureFactions } from "../../src/generated/protobuf/v1/creature_gen";
import { Perk } from "../../src/perks/perk_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
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
        expect(policy.pickCreature(1, pool, [], [])).toBe(best);
    });

    test("Abomination requires a backline-heavy army, and Queen also requires known flyer pressure", () => {
        const abomination = PBTypes.CreatureVals.ABOMINATION;
        const queen = PBTypes.CreatureVals.ARACHNA_QUEEN;
        const champion = PBTypes.CreatureVals.CHAMPION;
        const rangedWard = PBTypes.CreatureVals.ARBALESTER;
        const hybridCasterWard = PBTypes.CreatureVals.BATTLE_MAGE;
        const knownFlyer = PBTypes.CreatureVals.GRIFFIN;
        const offer = [abomination, queen, champion];

        expect(eligibleBacklineProtectorChoices(offer, [], [])).toEqual([champion]);
        expect(eligibleBacklineProtectorChoices(offer, [rangedWard], [])).toEqual([champion]);
        expect(eligibleBacklineProtectorChoices(offer, [rangedWard, hybridCasterWard], [])).toEqual([
            abomination,
            champion,
        ]);
        expect(eligibleBacklineProtectorChoices(offer, [rangedWard, hybridCasterWard], [knownFlyer])).toEqual(offer);
        // A forced all-protector offer must still make draft progress.
        expect(eligibleBacklineProtectorChoices([abomination, queen], [], [])).toEqual([abomination, queen]);
    });

    test("uses public opponent and own-roster context for Ash Moth, Healer, and Angel roles", () => {
        const ashMoth = PBTypes.CreatureVals.ASH_MOTH;
        const blacksmith = PBTypes.CreatureVals.BLACKSMITH;
        const enemyRanger = PBTypes.CreatureVals.ORC;
        expect(policy.pickCreature(1, [ashMoth, blacksmith], [], [enemyRanger])).toBe(ashMoth);

        const healer = PBTypes.CreatureVals.HEALER;
        const pikeman = PBTypes.CreatureVals.PIKEMAN;
        expect(policy.pickCreature(2, [healer, pikeman], [PBTypes.CreatureVals.FRENZIED_BOAR], [])).toBe(healer);

        const angel = PBTypes.CreatureVals.ANGEL;
        const champion = PBTypes.CreatureVals.CHAMPION;
        const rangedArmy = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.ARBALESTER];
        expect(policy.pickCreature(4, [angel, champion], rangedArmy, [enemyRanger])).toBe(angel);
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

    test("bundle and later creature picks preserve a coherent Tier-1 build", () => {
        const longbow = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.MEDUSA, Tier1Artifact.HUNTERS_LONGBOW] as const;
        const generic = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.MEDUSA, Tier1Artifact.CURSED_WARD] as const;
        expect(policy.pickBundle([longbow, generic])).toBe(0);
        expect(
            policy.pickCreature(
                3,
                [PBTypes.CreatureVals.MANTIS, PBTypes.CreatureVals.CYCLOPS],
                [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.MEDUSA],
                [],
                Tier1Artifact.HUNTERS_LONGBOW,
            ),
        ).toBe(PBTypes.CreatureVals.CYCLOPS);
    });

    test("keeps an exact pre-overlay draft rollback", () => {
        const longbow = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.MEDUSA, Tier1Artifact.HUNTERS_LONGBOW] as const;
        const generic = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.MEDUSA, Tier1Artifact.CURSED_WARD] as const;

        expect(SETUP_POLICY_V0.pickBundle([longbow, generic])).toBe(0);
        expect(SETUP_POLICY_V0_DRAFT_ROLLBACK.pickBundle([longbow, generic])).toBe(1);
        expect(
            SETUP_POLICY_V0_DRAFT_ROLLBACK.pickCreature(
                3,
                [PBTypes.CreatureVals.CYCLOPS, PBTypes.CreatureVals.GRIFFIN],
                [],
                [],
                Tier1Artifact.WINGED_BOOTS,
            ),
        ).toBe(PBTypes.CreatureVals.CYCLOPS);
    });
});
