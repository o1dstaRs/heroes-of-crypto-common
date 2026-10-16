import { afterEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import {
    ARTIFACT_FIT_SETUP_PREFIX_V2,
    ARTIFACT_FIT_SETUP_PREFIX_V3,
    tier1ArtifactFitScoreV2,
    tier1ArtifactFitScoreV3,
    tier2ArtifactFitScoreV2,
    tier2ArtifactFitScoreV3,
    withArtifactFitSetupPolicy,
} from "../../src/ai/setup/artifact_fit";
import { creatureIdForName, creatureInfo } from "../../src/ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../src/ai/setup/draft_coherence";
import { parseDraftGenome, pickRankedLiveDraftBundle } from "../../src/ai/setup/draft_ship";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { Tier1Artifact as T1, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import CREATURES_JSON from "../../src/configuration/creatures.json";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { calculateSpellDamage } from "../../src/spells/spell_damage";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

const C = PBTypes.CreatureVals;
const BASE = "conditional-v1:sniper+t2a19";
const v2 = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V2}${BASE}`);
const v3 = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V3}${BASE}`);
const physicalHybrids = [C.ANGEL, C.TROLL, C.BEHEMOTH, C.VALKYRIE, C.HARPY, C.OGRE_MAGE];
const shooters = [C.ARBALESTER, C.ELF, C.TSAR_CANNON];

afterEach(() => setDeterministicRandomSource(undefined));

describe("artifact fit follows combat magic damage", () => {
    test.each(physicalHybrids)("does not buy magic damage for support hybrid %i", (id) => {
        expect(creatureInfo(id)!.dealsMagicDamage).toBe(false);
        expect(tier1ArtifactFitScoreV3(T1.MAGES_RING, [id], 50)).toBe(0);
        expect(tier2ArtifactFitScoreV3(T2.ARCHMAGES_RING, [id])).toBe(0);
        expect(v3.pickArtifactT2([T2.ARCHMAGES_RING, T2.CROWN_OF_COMMAND], [id])).toBe(T2.CROWN_OF_COMMAND);
        for (const tier of [1, 2]) {
            const context = { ownCreatureIds: [], artifactFitVersion: 3 as const };
            expect(
                draftCreatureCoherenceAffinity(id, {
                    ...context,
                    ...(tier === 1 ? { tier1ArtifactId: T1.MAGES_RING } : { tier2ArtifactId: T2.ARCHMAGES_RING }),
                }),
            ).toBe(draftCreatureCoherenceAffinity(id, context));
        }
    });

    test.each([C.BATTLE_MAGE, C.MAGIC_DRAGON, C.THUNDERBIRD, C.BLACK_DRAGON])(
        "keeps actual magic source %i eligible",
        (id) => {
            expect(creatureInfo(id)!.dealsMagicDamage).toBe(true);
            expect(tier1ArtifactFitScoreV3(T1.MAGES_RING, [id], 50)).toBeGreaterThan(50);
            expect(tier2ArtifactFitScoreV3(T2.ARCHMAGES_RING, [id])).toBeGreaterThan(50);
            expect(
                draftCreatureCoherenceAffinity(id, {
                    ownCreatureIds: [],
                    tier1ArtifactId: T1.MAGES_RING,
                    artifactFitVersion: 3,
                }),
            ).toBeGreaterThan(draftCreatureCoherenceAffinity(id, { ownCreatureIds: [] }));
        },
    );

    test("does not mistake support-heavy scouting for incoming magic", () => {
        const context = createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: physicalHybrids.slice(0, 5) });
        expect(tier2ArtifactFitScoreV3(T2.AEGIS_OF_THE_ARCANE, shooters, context)).toBe(50);
        expect(v3.pickArtifactT2([T2.AEGIS_OF_THE_ARCANE, T2.CROWN_OF_COMMAND], shooters, context)).toBe(
            T2.CROWN_OF_COMMAND,
        );
        expect(v2.pickArtifactT2([T2.AEGIS_OF_THE_ARCANE, T2.CROWN_OF_COMMAND], shooters, context)).toBe(
            T2.AEGIS_OF_THE_ARCANE,
        );
        const actualMagic = createTier2ArtifactDecisionContext({
            publicOpponentCreatureIds: [C.BATTLE_MAGE, C.MAGIC_DRAGON, C.THUNDERBIRD, C.BLACK_DRAGON, C.ANGEL],
        });
        expect(v3.pickArtifactT2([T2.AEGIS_OF_THE_ARCANE, T2.CROWN_OF_COMMAND], shooters, actualMagic)).toBe(
            T2.AEGIS_OF_THE_ARCANE,
        );
    });

    test("updates opening-bundle fit while retaining the explicit previous policy", () => {
        const genome = parseDraftGenome(JSON.stringify(new Array(11).fill(0)));
        const bundles = [
            [C.HARPY, C.TROLL, T1.MAGES_RING],
            [C.HARPY, C.TROLL, T1.RIME_CHARM],
        ] as const;
        expect(pickRankedLiveDraftBundle(genome, bundles, undefined, 2)).toBe(0);
        expect(pickRankedLiveDraftBundle(genome, bundles)).toBe(1);
        expect(tier1ArtifactFitScoreV2(T1.MAGES_RING, [C.TROLL], 50)).toBe(60);
        expect(tier2ArtifactFitScoreV2(T2.ARCHMAGES_RING, [C.TROLL])).toBeGreaterThan(50);
        expect(withArtifactFitSetupPolicy(v3, 3)).toBe(v3);
        expect(v3.pickAugments(7, shooters)).toEqual(v2.pickAugments(7, shooters));
        expect(v3.pickSynergies(shooters)).toEqual(v2.pickSynergies(shooters));
        expect(() => resolveSetupPolicy(ARTIFACT_FIT_SETUP_PREFIX_V3)).toThrow();
    });

    test("agrees with real ring amplification for every draftable creature's spells and abilities", () => {
        const catalog = CREATURES_JSON as unknown as Record<string, Record<string, unknown>>;
        let checked = 0;
        for (const [faction, creatures] of Object.entries(catalog)) {
            for (const name of Object.keys(creatures)) {
                const id = creatureIdForName(name);
                if (id === undefined || !creatureInfo(id)) continue;
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
                unitsHolder.refreshStackPowerForAllUnits();
                const abilityNames = unit.getUnitProperties().abilities;
                const before = abilityNames.map((ability) =>
                    unit.calculateAbilityMultiplier(unit.getAbility(ability)!, 0),
                );
                const fight = FightStateManager.getInstance().getFightProperties();
                fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, T1.MAGES_RING);
                fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, T2.ARCHMAGES_RING);
                unitsHolder.applyArtifacts(fight);
                unitsHolder.refreshStackPowerForAllUnits();
                const abilityGain = abilityNames.some(
                    (ability, i) => unit.calculateAbilityMultiplier(unit.getAbility(ability)!, 0) > before[i],
                );
                const spellGain = unit
                    .getSpells()
                    .some(
                        (spell) =>
                            calculateSpellDamage(
                                spell.getMultiplierType(),
                                spell.getPower(),
                                unit.getAmountAlive(),
                                unit.getMagicDamageBonusPercentage(),
                            ) >
                            calculateSpellDamage(spell.getMultiplierType(), spell.getPower(), unit.getAmountAlive()),
                    );
                expect({ name, benefitsFromRings: creatureInfo(id)!.dealsMagicDamage }).toEqual({
                    name,
                    benefitsFromRings: abilityGain || spellGain,
                });
                checked += 1;
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    test("rings and Aegis leave an ordinary MELEE_MAGIC strike unchanged in the attack handler", () => {
        const strike = (artifacts: boolean): number => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
                attackType: PBTypes.AttackVals.MELEE_MAGIC,
                attack: 10,
                damageMin: 100,
                damageMax: 100,
                maxHp: 10000,
            });
            const defender = createTestUnit({ team: PBTypes.TeamVals.RIGHT, armor: 10, maxHp: 10000, magicResist: 0 });
            placeUnit(grid, unitsHolder, attacker, { x: 2, y: 2 });
            placeUnit(grid, unitsHolder, defender, { x: 3, y: 2 });
            attacker.refreshPossibleAttackTypes(true);
            if (artifacts) {
                const fight = FightStateManager.getInstance().getFightProperties();
                fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, T1.MAGES_RING);
                fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, T2.ARCHMAGES_RING);
                fight.setArtifactPerTeam(PBTypes.TeamVals.RIGHT, 2, T2.AEGIS_OF_THE_ARCANE);
                unitsHolder.applyArtifacts(fight);
                expect(attacker.getMagicDamageBonusPercentage()).toBeGreaterThan(0);
            }
            unitsHolder.refreshStackPowerForAllUnits();
            if (artifacts) expect(defender.getMagicResist()).toBe(18);
            setDeterministicRandomSource(() => 0);
            const hp = defender.getCumulativeHp();
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                new MoveHandler(grid.getSettings(), grid, unitsHolder),
                createVisibleDamage(defender),
                undefined,
                attacker,
                defender,
                { x: 2, y: 2 },
            );
            expect(result.completed).toBe(true);
            return hp - defender.getCumulativeHp();
        };
        const baseline = strike(false);
        expect(baseline).toBeGreaterThan(0);
        expect(strike(true)).toBe(baseline);
    });
});
