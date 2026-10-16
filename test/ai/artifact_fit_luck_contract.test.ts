import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { DOUBLE_SHOT_ABILITY_NAMES } from "../../src/abilities/double_shot_names";
import {
    ARTIFACT_FIT_SETUP_PREFIX_V3,
    ARTIFACT_FIT_SETUP_PREFIX_V4,
    tier1ArtifactFitScoreV3,
    tier1ArtifactFitScoreV4,
    tier2ArtifactFitScoreV3,
    tier2ArtifactFitScoreV4,
    withArtifactFitSetupPolicy,
} from "../../src/ai/setup/artifact_fit";
import {
    creatureIdForName,
    creatureInfo,
    DRAFT_FEATURE_DIM,
    creatureFeatures,
} from "../../src/ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../src/ai/setup/draft_coherence";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { Tier1Artifact as T1, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import CREATURES_JSON from "../../src/configuration/creatures.json";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const C = PBTypes.CreatureVals;
const catalog = CREATURES_JSON as unknown as Record<string, Record<string, { abilities: string[] }>>;
const entries = Object.entries(catalog).flatMap(([faction, creatures]) =>
    !creatures || typeof creatures !== "object"
        ? []
        : Object.entries(creatures).flatMap(([name, config]) => {
              const id = creatureIdForName(name);
              return id === undefined || !creatureInfo(id) ? [] : [{ faction, name, id, config }];
          }),
);

describe("artifact draft luck matches the combat roster", () => {
    test.each(entries)("uses engine-configured initial luck for $name", ({ faction, name, id }) => {
        const properties = getCreatureConfig(PBTypes.TeamVals.LEFT, faction, name, "", 1);
        expect(creatureInfo(id)!.baseLuck).toBe(properties.luck);
        expect(creatureFeatures(creatureInfo(id)!)).toHaveLength(DRAFT_FEATURE_DIM);
        expect(creatureInfo(id)!.luck).toBe(0);
    });

    for (const cursed of [false, true]) {
        test.each(entries.filter(({ id }) => creatureInfo(id)!.ranged))(
            `prices Quiver from the real chance for $name (Cursed Ward: ${cursed})`,
            ({ faction, name, id, config }) => {
                const { grid, unitsHolder } = createCombatTestContext();
                const effects = new EffectFactory();
                const unit = Unit.createUnit(
                    getCreatureConfig(PBTypes.TeamVals.LEFT, faction, name, "", 10),
                    testGridSettings,
                    PBTypes.TeamVals.LEFT,
                    PBTypes.UnitVals.CREATURE,
                    new AbilityFactory(effects),
                    effects,
                    false,
                );
                placeUnit(grid, unitsHolder, unit, { x: 3, y: 3 });
                const fight = FightStateManager.getInstance().getFightProperties();
                fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, T2.QUIVER_OF_ECHOES);
                if (cursed) fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, T1.CURSED_WARD);
                unitsHolder.applyArtifacts(fight);
                unitsHolder.refreshStackPowerForAllUnits();
                const nativeVolleys = DOUBLE_SHOT_ABILITY_NAMES.some((ability) => config.abilities.includes(ability))
                    ? 2
                    : 1;
                const context = createTier2ArtifactDecisionContext(cursed ? { ownArtifactIds: [T1.CURSED_WARD] } : {});
                expect(tier2ArtifactFitScoreV4(T2.QUIVER_OF_ECHOES, [id], context)).toBeCloseTo(
                    50 + unit.getBonusRangedAttackChance() / nativeVolleys,
                    8,
                );
            },
        );
    }

    test("respects positive and negative faction luck for both slowing artifacts", () => {
        for (const id of [C.ARBALESTER, C.ELF, C.GARGANTUAN]) {
            expect(tier1ArtifactFitScoreV4(T1.RIME_CHARM, [id], 50)).toBeGreaterThan(
                tier1ArtifactFitScoreV3(T1.RIME_CHARM, [id], 50),
            );
            expect(tier2ArtifactFitScoreV4(T2.GRAVECHAIN, [id])).toBeGreaterThan(
                tier2ArtifactFitScoreV3(T2.GRAVECHAIN, [id]),
            );
        }
        expect(tier1ArtifactFitScoreV4(T1.RIME_CHARM, [C.ORC], 50)).toBeLessThan(
            tier1ArtifactFitScoreV3(T1.RIME_CHARM, [C.ORC], 50),
        );
        expect(tier2ArtifactFitScoreV4(T2.GRAVECHAIN, [C.ORC])).toBeLessThan(
            tier2ArtifactFitScoreV3(T2.GRAVECHAIN, [C.ORC]),
        );
        expect(
            tier2ArtifactFitScoreV4(
                T2.GRAVECHAIN,
                [C.ELF],
                createTier2ArtifactDecisionContext({ ownArtifactIds: [T1.CURSED_WARD] }),
            ),
        ).toBeGreaterThan(tier2ArtifactFitScoreV4(T2.GRAVECHAIN, [C.ELF]));
    });

    test("keeps the actual-magic classifier for the new policy's later creature choices", () => {
        for (const id of [C.ANGEL, C.TROLL, C.OGRE_MAGE]) {
            const context = { ownCreatureIds: [], artifactFitVersion: 4 as const };
            expect(
                draftCreatureCoherenceAffinity(id, {
                    ...context,
                    tier1ArtifactId: T1.MAGES_RING,
                    tier2ArtifactId: T2.ARCHMAGES_RING,
                }),
            ).toBe(draftCreatureCoherenceAffinity(id, context));
        }
        expect(
            draftCreatureCoherenceAffinity(C.BLACK_DRAGON, {
                ownCreatureIds: [],
                artifactFitVersion: 4,
                tier1ArtifactId: T1.MAGES_RING,
            }),
        ).toBeGreaterThan(draftCreatureCoherenceAffinity(C.BLACK_DRAGON, { ownCreatureIds: [] }));
    });

    test("changes a legal mixed-army offer when the shooters' real luck makes Quiver preferable", () => {
        const own = [C.PEASANT, C.BERSERKER, C.ELF, C.PIKEMAN, C.ZENA];
        const offered = [T2.QUIVER_OF_ECHOES, T2.CROWN_OF_COMMAND, T2.WARLORDS_EDGE];
        const base = "conditional-v1:sniper+t2a19";
        expect(resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V3}${base}`).pickArtifactT2(offered, own)).toBe(
            T2.CROWN_OF_COMMAND,
        );
        expect(resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V4}${base}`).pickArtifactT2(offered, own)).toBe(
            T2.QUIVER_OF_ECHOES,
        );
    });

    test("versions the luck correction without replacing earlier heads or unrelated setup choices", () => {
        const base = "conditional-v1:sniper+t2a19";
        const previous = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V3}${base}`);
        const current = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V4}${base}`);
        expect(withArtifactFitSetupPolicy(current, 4)).toBe(current);
        expect(current.pickAugments(7, [C.ELF])).toEqual(previous.pickAugments(7, [C.ELF]));
        expect(current.pickSynergies([C.ELF])).toEqual(previous.pickSynergies([C.ELF]));
        expect(tier2ArtifactFitScoreV3(T2.QUIVER_OF_ECHOES, [C.GARGANTUAN])).toBe(70);
        expect(tier2ArtifactFitScoreV4(T2.QUIVER_OF_ECHOES, [C.GARGANTUAN])).toBe(72);
        expect(() => resolveSetupPolicy(ARTIFACT_FIT_SETUP_PREFIX_V4)).toThrow();
    });

    test("combines faction luck with Cursed Ward when choosing connected control", () => {
        const own = [C.ORC, C.FAIRY, C.WYVERN, C.ELF, C.ZENA];
        const offered = [T2.LAST_FUSE, T2.LAVA_STRIDERS, T2.GRAVECHAIN];
        const context = createTier2ArtifactDecisionContext({
            ownArtifactIds: [T1.CURSED_WARD],
            publicOpponentCreatureIds: [C.WANDERING_MAGE, C.MEDUSA],
        });
        const base = "conditional-v1:sniper+t2a19";
        expect(resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V3}${base}`).pickArtifactT2(offered, own, context)).toBe(
            T2.LAST_FUSE,
        );
        expect(resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V4}${base}`).pickArtifactT2(offered, own, context)).toBe(
            T2.GRAVECHAIN,
        );
    });
});
