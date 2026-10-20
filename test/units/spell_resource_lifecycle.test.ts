import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { createCombatFactories, createUnitFromSpec, creaturesByLevel } from "../../src/simulation/army";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { Unit } from "../../src/units/unit";

const factories = createCombatFactories();
const settings = simulationGridSettings();
const roster = [1, 2, 3, 4].flatMap((level) => creaturesByLevel(level));
const create = (spec: (typeof roster)[number], amount: number, team: TeamType) =>
    createUnitFromSpec({ ...spec, amount }, team, settings, factories.abilityFactory, factories.effectFactory);
const casters = roster.filter((spec) => create(spec, 40, PBTypes.TeamVals.LEFT).getSpellsCount() > 0);
const entries = (...units: Unit[]) => units.flatMap((unit) => unit.getUnitProperties().spells).sort();
const rebuild = (unit: Unit) =>
    Unit.createUnit(
        unit.getAllProperties(),
        settings,
        unit.getTeam(),
        PBTypes.UnitVals.CREATURE,
        factories.abilityFactory,
        factories.effectFactory,
        false,
    );

function expectBookConsistent(unit: Unit): void {
    const raw = unit
        .getUnitProperties()
        .spells.map((entry) => entry.substring(entry.indexOf(":") + 1))
        .sort();
    const parsed = unit
        .getSpells()
        .flatMap((spell) => Array(spell.getAmount()).fill(spell.getName()))
        .sort();
    expect(parsed).toEqual(raw);
    expect(unit.getSpellsCount()).toBe(raw.length);
    expect(unit.getCanCastSpells()).toBe(raw.length > 0);
}

describe("every caster's resources across splitting, reconstruction and merging", () => {
    for (const spec of casters) {
        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
            test(`${spec.creatureName}, team ${team}: every split size retains two complete independent books`, () => {
                for (let amount = 1; amount < 40; amount++) {
                    const source = create(spec, 40, team);
                    const child = create(spec, amount, team);
                    const original = entries(source);
                    source.shareResourcesWithSplit(child, amount);
                    source.setAmountAlive(40 - amount);
                    expect(entries(source)).toEqual(original);
                    expect(entries(child)).toEqual(original);
                    expectBookConsistent(source);
                    expectBookConsistent(child);

                    const restoredSource = rebuild(source);
                    const restoredChild = rebuild(child);
                    expect(entries(restoredSource)).toEqual(original);
                    expect(entries(restoredChild)).toEqual(original);
                    restoredSource.takeResourcesFromMerge(restoredChild, amount);
                    restoredSource.setAmountAlive(40);
                    expect(entries(restoredSource)).toEqual(original);
                    expect(entries(restoredChild)).toEqual(original);
                    expectBookConsistent(restoredSource);
                    expectBookConsistent(restoredChild);
                }
            });

            test(`${spec.creatureName}, team ${team}: partial merges and spent spells survive reconstruction`, () => {
                const source = create(spec, 40, team);
                const child = create(spec, 20, team);
                source.shareResourcesWithSplit(child, 20);
                source.setAmountAlive(20);
                for (const spell of child.getSpells()) {
                    if (spell.isRemaining()) child.useSpell(spell.getName());
                }
                const sourceBook = entries(source);
                const childBook = entries(child);
                const restoredSource = rebuild(source);
                const restoredChild = rebuild(child);
                restoredSource.takeResourcesFromMerge(restoredChild, 7);
                restoredSource.setAmountAlive(27);
                restoredChild.setAmountAlive(13);
                expect(entries(restoredSource)).toEqual(sourceBook);
                expect(entries(restoredChild)).toEqual(childBook);
                expectBookConsistent(restoredSource);
                expectBookConsistent(restoredChild);
                restoredSource.takeResourcesFromMerge(restoredChild, 13);
                expect(entries(restoredSource)).toEqual(sourceBook);
                expect(entries(restoredChild)).toEqual(childBook);
                expectBookConsistent(restoredSource);

                for (const spell of restoredSource.getSpells()) {
                    while (spell.isRemaining()) restoredSource.useSpell(spell.getName());
                }
                expectBookConsistent(restoredSource);
                const empty = rebuild(restoredSource);
                expect(entries(empty)).toEqual([]);
                expectBookConsistent(empty);
            });
        }
    }

    test("mixed legacy/direct ability spell entries copy and merge without inflating charges", () => {
        const spec = casters.find((spec) => spec.creatureName === "Harpy")!;
        const source = create(spec, 40, PBTypes.TeamVals.LEFT);
        const child = create(spec, 20, PBTypes.TeamVals.LEFT);
        source.syncAuthoritativeSpellEntries([":Wind Flow", "System:Wind Flow"]);
        source.shareResourcesWithSplit(child, 20);
        expect(
            child
                .getSpells()
                .find((spell) => spell.getName() === "Wind Flow")
                ?.getAmount(),
        ).toBe(2);
        expect(
            source
                .getSpells()
                .find((spell) => spell.getName() === "Wind Flow")
                ?.getAmount(),
        ).toBe(2);
        source.takeResourcesFromMerge(child, 20);
        expect(source.getSpellsCount()).toBe(2);
        expectBookConsistent(source);
        expectBookConsistent(child);
    });

    test("reconstruction repairs a stale disabled flag when authoritative charges remain", () => {
        const source = create(
            casters.find((spec) => spec.creatureName === "Healer")!,
            1,
            PBTypes.TeamVals.LEFT,
        );
        source.getUnitProperties().can_cast_spells = false;
        expectBookConsistent(rebuild(source));
    });
});
