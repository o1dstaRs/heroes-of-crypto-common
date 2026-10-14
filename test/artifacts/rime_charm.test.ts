import { afterEach, beforeEach, expect, test } from "bun:test";

import { processRimeCharmAbility } from "../../src/abilities/rime_charm_ability";
import {
    ARTIFACT_POWER,
    ArtifactTier,
    formatArtifactDescription,
    getArtifactProperties,
    Tier1Artifact,
    Tier2Artifact,
    ToTier1Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());
afterEach(() => setDeterministicRandomSource(undefined));

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const BASE = ARTIFACT_POWER.RIME_PROC_PERCENT;

function arm(tier: 1 | 2, id: number) {
    const context = createCombatTestContext();
    const attacker = createTestUnit({ name: "Attacker", team: LEFT, amountAlive: 5 });
    const target = createTestUnit({ name: "Target", team: RIGHT, maxHp: 1000, amountAlive: 5 });
    placeUnit(context.grid, context.unitsHolder, attacker, { x: 2, y: 2 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 3, y: 2 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setArtifactPerTeam(LEFT, tier, id);
    context.unitsHolder.applyArtifacts(fight);
    context.unitsHolder.refreshStackPowerForAllUnits();
    return { ...context, attacker, target };
}

function shownChance(attacker: ReturnType<typeof arm>["attacker"]): string {
    const props = attacker.getUnitProperties();
    return props.applied_buffs_descriptions[props.applied_buffs.indexOf("Rime Charm")] ?? "";
}

test("is drafted as tier 1 and a saved tier 2 pick still applies it", () => {
    expect(ToTier1Artifact["15"]).toBe(Tier1Artifact.RIME_CHARM);
    const card = formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_1, Tier1Artifact.RIME_CHARM));
    expect(card).toContain(`${BASE}% chance, plus the attacking unit's current luck`);
    expect(card).toContain(`for ${ARTIFACT_POWER.RIME_SLOW_LAPS} laps`);
    expect(formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.RIME_CHARM))).toBe(card);

    for (const armed of [arm(1, Tier1Artifact.RIME_CHARM), arm(2, Tier2Artifact.RIME_CHARM)]) {
        expect(armed.attacker.getRimeCharmChance()).toBe(BASE);
        expect(armed.attacker.getBuff("Rime Charm")?.getPower()).toBe(BASE);
    }
});

test("hover shows the chance after luck, not the formula", () => {
    const { attacker, unitsHolder } = arm(1, Tier1Artifact.RIME_CHARM);
    const props = attacker.getUnitProperties();
    props.luck_authoritative = true;
    for (const luck of [7, -5, 0, 10, -10]) {
        props.luck = luck;
        props.luck_mod = 0;
        unitsHolder.refreshStackPowerForAllUnits();
        const chance = BASE + luck;
        expect(attacker.getRimeCharmChance()).toBe(chance);
        expect(shownChance(attacker)).toContain(
            `Artifact. ${chance}% chance for any attack to slow the target for 3 laps.`,
        );
        expect(shownChance(attacker)).not.toContain("luck");
    }
});

test("the roll uses that same chance", () => {
    const hit = arm(1, Tier1Artifact.RIME_CHARM);
    setDeterministicRandomSource(() => 0);
    processRimeCharmAbility(hit.attacker, hit.target, new SceneLogMock());
    expect(hit.attacker.getRimeCharmChance()).toBe(BASE);
    expect(hit.target.hasDebuffActive("Quagmire")).toBe(true);

    const miss = arm(1, Tier1Artifact.RIME_CHARM);
    // Two draws of 0.5 land on roll 44, above the 30% base.
    setDeterministicRandomSource(() => 0.5);
    processRimeCharmAbility(miss.attacker, miss.target, new SceneLogMock());
    expect(miss.target.hasDebuffActive("Quagmire")).toBe(false);
});
