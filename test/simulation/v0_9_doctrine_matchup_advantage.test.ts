import { describe, expect, test } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { CreatureLevelList } from "../../src/units/unit_properties";
import {
    DOCTRINE_MATCHUP_ADVANTAGE_FEATURES,
    doctrineMatchedAdvantage,
    doctrineMatchupAdvantageFeatures,
    type IDoctrineMatchupObservation,
} from "../../src/simulation/v0_9/doctrine_matchup_advantage";

const c = PBTypes.CreatureVals;
const observation: IDoctrineMatchupObservation = {
    doctrine: Doctrine.THREE_REVEALS,
    level: 2,
    synergyVariants: { Life: 2, Nature: 2, Chaos: 1, Might: 1 },
    context: {
        ownCreatureIds: [c.BERSERKER, c.ORC, c.TROLL],
        knownOpponentCreatureIds: [c.WANDERING_MAGE, c.MEDUSA],
        tier1ArtifactId: Tier1Artifact.HUNTERS_LONGBOW,
        artifactFitVersion: 6,
        scouting: {
            map: PBTypes.GridVals.NORMAL,
            bannedCreatureIds: [],
            knownBanLevels: [1, 2, 3, 4],
            remainingPickLevels: [2, 3, 4],
        },
    },
};
const choice = (id: number) => ({ creatureIds: [id] });
const vector = (o = observation, a = c.ELF, b = c.VALKYRIE) =>
    doctrineMatchupAdvantageFeatures(o, choice(a), choice(b));
const named = (x: number[]) => Object.fromEntries(DOCTRINE_MATCHUP_ADVANTAGE_FEATURES.map((name, i) => [name, x[i]]));

describe("research-only doctrine matchup advantage", () => {
    test("relative representation has no intercept and reverses with the attempted actions", () => {
        const ab = vector(),
            ba = vector(observation, c.VALKYRIE, c.ELF);
        expect(new Set(DOCTRINE_MATCHUP_ADVANTAGE_FEATURES).size).toBe(ab.length);
        expect(ab.every(Number.isFinite)).toBe(true);
        expect(vector(observation, c.ELF, c.ELF).every((v) => v === 0)).toBe(true);
        expect(ab.every((v, i) => v === -ba[i])).toBe(true);
    });

    test("Longbow changes the relative value of removing a shooter instead of cancelling", () => {
        const withBow = named(vector());
        const withoutBow = named(vector({ ...observation, context: { ...observation.context, tier1ArtifactId: 0 } }));
        // At this pick Orc+Elf are two shooters; the future Zena has not been picked yet.
        expect(withBow.longbow_ranged_pairs).toBeCloseTo((1 - 4) / 36);
        expect(withoutBow.longbow_ranged_pairs).toBe(0);
        expect(withBow.public_build_fit).toBeLessThan(withoutBow.public_build_fit);
        // A one-feature linear head can respond to the artifact without a neural interaction layer.
        expect(withBow.longbow_ranged_pairs).not.toBe(withoutBow.longbow_ranged_pairs);
    });

    test("offensive spellcasters are distinct from resurrection support at the level-4 decision", () => {
        const o = {
            ...observation,
            level: 4,
            context: {
                ...observation.context,
                ownCreatureIds: [c.BERSERKER, c.ORC, c.BATTLE_MAGE, c.BEHOLDER, c.ZENA],
                scouting: { ...observation.context.scouting, remainingPickLevels: [4] },
            },
        };
        const x = named(vector(o, c.MAGIC_DRAGON, c.ANGEL));
        expect(x.damage_caster).toBeCloseTo(-1 / 6);
        expect(x.support).toBeCloseTo(1 / 6);
        expect(x.ranged).toBe(0);
        expect(x.level_4_damage_caster).toBeCloseTo(-1 / 6);
    });

    test("visible terrain changes the cost of a large ground melee choice", () => {
        const o = {
            ...observation,
            level: 4,
            context: {
                ...observation.context,
                ownCreatureIds: [c.DRYAD, c.ORC, c.TRENT, c.TROLL, c.ZENA],
                scouting: { ...observation.context.scouting, remainingPickLevels: [4] },
            },
        };
        const normal = named(vector(o, c.TSAR_CANNON, c.BEHEMOTH));
        const block = named(
            vector(
                {
                    ...o,
                    context: { ...o.context, scouting: { ...o.context.scouting, map: PBTypes.GridVals.BLOCK_CENTER } },
                },
                c.TSAR_CANNON,
                c.BEHEMOTH,
            ),
        );
        expect(normal.block_large_ground_melee).toBe(0);
        expect(block.block_large_ground_melee).toBeCloseTo(1 / 6);
    });

    test("each doctrine can condition build differences while hidden enemies remain unknown", () => {
        for (const doctrine of [Doctrine.SEE_ALL, Doctrine.THREE_REVEALS, Doctrine.SEE_NONE]) {
            const x = named(
                vector({ ...observation, doctrine, context: { ...observation.context, knownOpponentCreatureIds: [] } }),
            );
            expect(x[`doctrine_${doctrine}_ranged`]).toBeCloseTo(-1 / 6);
            expect(x.unknown_enemy_ranged).toBeCloseTo(-1 / 6);
            expect(x.ranged_vs_visible_melee_speed).toBe(0);
        }
    });

    test("public Chaos movement changes ranged exposure to the visible melee army", () => {
        const chaosMelee = CreatureLevelList[1]
            .concat(CreatureLevelList[2])
            .filter((id) => creatureInfo(id)?.faction === PBTypes.FactionVals.CHAOS && creatureInfo(id)?.melee)
            .slice(0, 2);
        expect(chaosMelee).toHaveLength(2);
        const o = { ...observation, context: { ...observation.context, knownOpponentCreatureIds: chaosMelee } };
        const movement = named(vector(o));
        const breakOnAttack = named(vector({ ...o, synergyVariants: { ...o.synergyVariants, Chaos: 2 } }));
        expect(movement.ranged_vs_visible_melee_speed).toBeLessThan(breakOnAttack.ranged_vs_visible_melee_speed);
    });

    test("visible future bans alter achievable ranged coverage", () => {
        const o = {
            ...observation,
            context: {
                ...observation.context,
                ownCreatureIds: [c.ORC, c.BERSERKER, c.TROLL],
                scouting: { ...observation.context.scouting, remainingPickLevels: [2, 3] },
            },
        };
        const open = named(vector(o));
        const bans = CreatureLevelList[3].filter((id) => creatureInfo(id)?.ranged);
        const closed = named(
            vector({ ...o, context: { ...o.context, scouting: { ...o.context.scouting, bannedCreatureIds: bans } } }),
        );
        expect(open.future_ranged_capacity_3).toBe(-1);
        expect(closed.future_ranged_capacity_3).toBe(0);
    });

    test("unknown map is not normal terrain, and removing advance vision preserves public build data", () => {
        const hidden = named(
            vector({
                ...observation,
                context: {
                    ...observation.context,
                    knownOpponentCreatureIds: [],
                    scouting: { ...observation.context.scouting, map: undefined },
                },
            }),
        );
        const normal = named(vector());
        expect(hidden.unknown_map_ranged).toBeCloseTo(-1 / 6);
        expect(normal.unknown_map_ranged).toBe(0);
        expect(hidden.longbow_ranged_pairs).toBe(normal.longbow_ranged_pairs);
        expect(hidden.chaos_movement).toBe(normal.chaos_movement);
    });

    test("full-state, hidden-enemy and future-fallback fields are never read", () => {
        const o = { ...observation, context: { ...observation.context } };
        for (const object of [o, o.context]) {
            for (const key of ["fullState", "hiddenOpponentCreatureIds", "actualFallbackCreatureIds", "winner"])
                Object.defineProperty(object, key, {
                    enumerable: true,
                    get() {
                        throw new Error(`Private field read: ${key}`);
                    },
                });
        }
        expect(vector(o)).toEqual(vector());
    });

    test("invalid attempted choices cannot silently produce a feature vector", () => {
        expect(() => vector(observation, c.ELF, c.ANGEL)).toThrow("Invalid attempted");
        expect(() =>
            doctrineMatchupAdvantageFeatures(observation, choice(c.ELF), { creatureIds: [c.ELF, c.ELF] }),
        ).toThrow();
        expect(() => vector({ ...observation, doctrine: 0 })).toThrow("Invalid doctrine");
    });
});

describe("matched-future labels", () => {
    const base = [
        { future: 0, combatSeed: 10, score: 1 },
        { future: 1, combatSeed: 20, score: 0.5 },
    ];
    test("matches by identity and retains conflicting futures instead of averaging away the evidence", () => {
        const result = doctrineMatchedAdvantage(base, [
            { future: 1, combatSeed: 20, score: 1 },
            { future: 0, combatSeed: 10, score: 0 },
        ]);
        expect(result).toEqual({ gain: -0.25, futureDifferences: [-1, 0.5] });
    });
    test("rejects missing, duplicate, mismatched-seed and non-score outcomes", () => {
        for (const rows of [
            [],
            [base[0]],
            [base[0], base[0]],
            [base[0], { ...base[1], combatSeed: 21 }],
            [base[0], { ...base[1], score: 0.75 }],
            [base[0], { ...base[1], combatSeed: 10 }],
        ]) {
            expect(() => doctrineMatchedAdvantage(base, rows)).toThrow();
        }
    });
});
