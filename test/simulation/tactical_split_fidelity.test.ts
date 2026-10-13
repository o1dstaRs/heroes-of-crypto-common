import { expect, test } from "bun:test";

import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { createCombatFactories, createUnitFromSpec, creaturesByLevel } from "../../src/simulation/army";
import { creatureIdForName } from "../../src/simulation/draft";
import { materializeReplayAbSplits } from "../../src/simulation/ranked_replay_tactics_ab_core";
import { NatureSynergy } from "../../src/synergies/synergy_properties";

const factories = createCombatFactories();
const create = (spec: Parameters<typeof createUnitFromSpec>[0]) =>
    createUnitFromSpec(
        spec,
        PBTypes.TeamVals.LEFT,
        simulationGridSettings(),
        factories.abilityFactory,
        factories.effectFactory,
    );

test("simulated split spellbooks conserve charges and rebuild the authoritative split books", () => {
    const roster = [
        { faction: "Nature", creatureName: "Leprechaun", level: 1, size: 1, amount: 100 },
        { faction: "Might", creatureName: "Wolf Rider", level: 1, size: 1, amount: 80 },
        { faction: "Life", creatureName: "Healer", level: 2, size: 1, amount: 40 },
        { faction: "Chaos", creatureName: "Medusa", level: 2, size: 1, amount: 30 },
        { faction: "Might", creatureName: "Cyclops", level: 3, size: 1, amount: 15 },
        { faction: "Life", creatureName: "Champion", level: 4, size: 2, amount: 3 },
    ];
    const ids = roster.map((spec) => creatureIdForName(spec.creatureName)!);
    const before = structuredClone(roster);
    const result = materializeReplayAbSplits(roster, ids, [{ kind: "Placement", value: 2 }], []);
    expect(result.splitRoles).toHaveLength(2);
    for (const spec of roster) {
        const source = create(spec);
        const stacks = result.roster.filter((stack) => stack.creatureName === spec.creatureName).map(create);
        expect(stacks.flatMap((stack) => stack.getUnitProperties().spells).sort()).toEqual(
            [...source.getUnitProperties().spells].sort(),
        );
        if (stacks.length === 1) continue;
        const child = create({ ...spec, amount: 1 });
        source.shareResourcesWithSplit(child, 1);
        expect(stacks[0].getUnitProperties().spells).toEqual(source.getUnitProperties().spells);
        expect(stacks[1].getUnitProperties().spells).toEqual(child.getUnitProperties().spells);
        expect(stacks[1].getSpells().filter((spell) => spell.isRemaining()).length).toBe(
            child.getSpells().filter((spell) => spell.isRemaining()).length,
        );
    }
    expect(roster).toEqual(before);
    const healerChild = result.roster.find((spec, index) => index >= roster.length && spec.creatureName === "Healer")!;
    expect(healerChild.initialSpellEntries).toEqual(["Life:Heal", "Life:Spiritual Armor"]);
    expect(create(healerChild).getUnitProperties().can_cast_spells).toBe(true);
});

test("Nature split capacity matches the authoritative engine at every synergy level", () => {
    const nature = [1, 2, 3, 4]
        .flatMap((level) => creaturesByLevel(level))
        .filter((spec) => spec.faction === "Nature" && spec.size === 1)
        .slice(0, 6);
    expect(nature).toHaveLength(6);
    const roster = nature.map((spec) => ({ ...spec, amount: 100 }));
    const ids = nature.map((spec) => creatureIdForName(spec.creatureName)!);
    for (const level of [1, 2, 3]) {
        const fight = new FightProperties();
        fight.setSynergiesPerTeam(PBTypes.TeamVals.LEFT, [`Nature:${NatureSynergy.INCREASE_BOARD_UNITS}:${level}`]);
        const count = level * 2;
        const result = materializeReplayAbSplits(
            roster,
            ids.slice(0, count),
            [],
            [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.INCREASE_BOARD_UNITS }],
        );
        expect(result.roster).toHaveLength(fight.getNumberOfUnitsAvailableForPlacement(PBTypes.TeamVals.LEFT));
        const duplicateIds = materializeReplayAbSplits(
            roster,
            [...ids.slice(0, count), ...ids.slice(0, count)],
            [],
            [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.INCREASE_BOARD_UNITS }],
        );
        expect(duplicateIds.roster).toHaveLength(result.roster.length);
    }
});
