import { expect, test } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { draftBattlefieldSummary, draftSynergyEffects } from "../../src/ai/setup/draft_battlefield_context";
import { ToFactionType } from "../../src/factions/faction_type";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { DEFAULT_SYNERGY_VARIANTS } from "../../src/synergies/synergy_properties";

const ids = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))];
const faction = (name: string, count: number) =>
    ids.filter((id) => creatureInfo(id)?.faction === ToFactionType[name]).slice(0, count);

test("draft synergy powers reproduce the authoritative fight properties for both variants and every threshold", () => {
    const team = PBTypes.TeamVals.LEFT;
    for (const name of ["Life", "Chaos", "Might", "Nature"])
        for (const variant of [1, 2])
            for (let count = 0; count <= 6; count++) {
                const roster = faction(name, count);
                const variants = { ...DEFAULT_SYNERGY_VARIANTS, [name]: variant };
                const actual = new FightProperties();
                actual.setSynergyVariants(variants);
                actual.setSynergyUnitsPerFactions(
                    team,
                    name === "Life" ? count : 0,
                    name === "Chaos" ? count : 0,
                    name === "Might" ? count : 0,
                    name === "Nature" ? count : 0,
                );
                const summary = draftSynergyEffects(roster, variants);
                expect(summary.movement).toBe(actual.getAdditionalMovementStepsPerTeam(team));
                expect(summary.auraRange).toBe(actual.getAdditionalAuraRangePerTeam(team));
                expect(summary.flyArmor).toBe(actual.getAdditionalFlyArmorPerTeam(team));
                expect(summary.abilityPower).toBe(actual.getAdditionalAbilityPowerPerTeam(team));
                expect(summary.supply).toBe(actual.getAdditionalSupplyPerTeam(team));
                expect(summary.morale).toBe(actual.getAdditionalMoralePerTeam(team));
                expect(summary.luck).toBe(actual.getAdditionalLuckPerTeam(team));
                expect(summary.breakChance).toBe(actual.getBreakChancePerTeam(team));
                const baseline = new FightProperties();
                expect(summary.boardUnits).toBe(
                    actual.getNumberOfUnitsAvailableForPlacement(team) -
                        baseline.getNumberOfUnitsAvailableForPlacement(team),
                );
                expect(draftSynergyEffects([...roster, ...roster], variants)).toEqual(summary);
            }
});

test("known opponent synergies are lower bounds and visible future slots give only potential", () => {
    const own = faction("Nature", 1);
    const enemy = faction("Chaos", 1);
    const context = {
        ownCreatureIds: own,
        knownOpponentCreatureIds: enemy,
        synergyVariants: { ...DEFAULT_SYNERGY_VARIANTS, Nature: 1 },
        scouting: { bannedCreatureIds: [], knownBanLevels: [], remainingPickLevels: [1, 2, 3, 4] },
    };
    const summary = draftBattlefieldSummary(context);
    expect(summary.map).toBeUndefined();
    expect(summary.own.boardUnits).toBe(0);
    expect(summary.publicEnemyMinimum.movement).toBe(0);
    expect(summary.maximumReachableLevels[3]).toBeGreaterThan(0);
    expect(summary.uncertainContinuations[3]).toBe(true);
    expect(
        draftBattlefieldSummary({ ...context, knownOpponentCreatureIds: faction("Chaos", 2) }).publicEnemyMinimum
            .movement,
    ).toBe(1);
});
