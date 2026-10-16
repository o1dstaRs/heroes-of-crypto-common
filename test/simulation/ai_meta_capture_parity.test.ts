import { expect, it } from "bun:test";
import { aiMetaSynergyVariantsForPair, prepareMetaPair } from "../../src/simulation/ai_meta_cohorts_core";
import { aiMetaMatchConfig, capturePremiumFight } from "../../src/simulation/ai_meta_cohorts_pair";
import { AI_META_REGISTERED_VERSION_STRATEGY_PROFILE } from "../../src/simulation/ai_meta_strategy_profile";
import { PREMIUM_META_STUDY } from "../../src/simulation/ai_meta_study";
import { Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { summarizePremiumHealth, validatePremiumHealthLedger } from "../../src/simulation/ai_meta_health_ledger";

it("effective-state and execution observers leave deterministic Premium fights unchanged", () => {
    const pair = prepareMetaPair(
        {
            cohort: "ranked-draft",
            games: 500,
            baseSeed: 85000717,
            collectEvidence: true,
            studyProfile: PREMIUM_META_STUDY,
        },
        0,
    );
    const config = {
        ...aiMetaMatchConfig(
            pair.armyA,
            pair.armyB,
            pair.combatSeed,
            pair.map,
            AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
            aiMetaSynergyVariantsForPair(pair.setupSeed, pair.combatSeed),
            true,
        ),
        searchOfflineDeterministicWork: true,
        headlessEvents: false,
        greenArtifactT1: Tier1Artifact.BARREL_BARRICADE,
    };
    const control = capturePremiumFight(config, false);
    const treatment = capturePremiumFight(config, true);
    expect(treatment.result).toEqual(control.result);
    expect(control.healthLedger).toBeUndefined();
    expect(treatment.healthLedger!.length).toBeGreaterThan(0);
    validatePremiumHealthLedger(treatment.healthLedger!, treatment.committedEventBatches!);
    expect(summarizePremiumHealth(treatment.healthLedger!).damageHp).toBeGreaterThan(0);
    expect(treatment.firstDecisionState!.units.length).toBeGreaterThanOrEqual(12);
    expect(treatment.executionTrace!.length).toBeGreaterThan(0);
    const allEvents = treatment.committedEventBatches!.flatMap(({ events }) => events);
    expect(allEvents.some(({ type }) => type === "fight_started")).toBe(true);
    expect(allEvents.some(({ type }) => type === "next_unit_selected")).toBe(true);
    const turnEvents = treatment.executionTrace!.flatMap(({ events }) => events);
    expect(allEvents.length).toBeGreaterThan(turnEvents.length);
    expect(allEvents.filter(({ type }) => type === "unit_attacked")).toEqual(
        turnEvents.filter(({ type }) => type === "unit_attacked"),
    );
    expect(treatment.terminalState!.damageStatistics!.length).toBeGreaterThan(0);
    expect(treatment.terminalState!.units.filter((unit) => unit.alive).length).toBe(
        treatment.result.outcome.green.unitsAlive + treatment.result.outcome.red.unitsAlive,
    );
    expect(treatment.terminalState!.units.reduce((sum, unit) => sum + unit.cumulativeHp, 0)).toBe(
        treatment.result.outcome.green.hpRemaining + treatment.result.outcome.red.hpRemaining,
    );
    const first = treatment.firstDecisionState!;
    expect(first.units.some(({ properties }) => properties.id === first.actingUnitId)).toBe(true);
    expect(first.board!.matrix).toHaveLength(16);
    expect(first.board!.matrix.every((row) => row.length === 16)).toBe(true);
    expect(first.board!.gridType).toBe(pair.map);
    expect(first.board!.artifactBarrels.length).toBeGreaterThanOrEqual(2);
    for (const barrel of first.board!.artifactBarrels) {
        expect(
            first.units.some(({ cells }) => cells.some(({ x, y }) => x === barrel.cell.x && y === barrel.cell.y)),
        ).toBe(false);
    }
}, 120_000);
