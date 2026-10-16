import { describe, expect, test } from "bun:test";
import { summarizePremiumParticipation } from "../../src/simulation/ai_meta_participation";
import type { GameEvent } from "../../src/engine/events";
import type { IAiMetaFightEvidence, IAiMetaFormationEvidence } from "../../src/simulation/ai_meta_evidence";
import {
    summarizePremiumCombatMetrics,
    premiumDraftedCombatMetrics,
    PREMIUM_COMBAT_UNIT_METRICS,
} from "../../src/simulation/ai_meta_combat_metrics";
import type { IVisibleDamage } from "../../src/scene/animations";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const left = PBTypes.TeamVals.LEFT,
    right = PBTypes.TeamVals.RIGHT;
const pos = { x: 1, y: 1 };
const formation = (ids: string[], creatures: number[]): IAiMetaFormationEvidence => ({
    unitIdsByStack: ids,
    draftedCreatureIdsByStack: creatures,
    expandedRoster: ids.map((id) => ({ creatureName: id, faction: "Life", level: 1, size: 1, amount: 10 })),
    placements: [],
    splitRoles: [],
    augments: [],
});
const fixture = (events?: GameEvent[]) => ({
    aIsGreen: true,
    formations: { a: formation(["own", "split"], [11, 11]), b: formation(["enemy"], [22]) },
    ...(events ? { committedEventBatches: [{ lap: 1, events }] } : {}),
});
const attack = (extra: Partial<IVisibleDamage> = {}): GameEvent => ({
    type: "unit_attacked",
    attackType: "melee",
    attackerId: "own",
    targetId: "enemy",
    unitIdsDied: [],
    animations: [],
    damage: { amount: 999, render: true, unitPosition: pos, unitIsSmall: true, unitId: "enemy", ...extra },
});
const spell = (extra: Partial<Extract<GameEvent, { type: "spell_cast" }>>): GameEvent => ({
    type: "spell_cast",
    casterId: "own",
    spellName: "Fire Strike",
    unitIdsDied: [],
    animations: [],
    ...extra,
});
const sum = (value: Record<string, number>) => Object.values(value).reduce((a, b) => a + b, 0);

describe("Premium combat metrics", () => {
    test("records missed flights and bounds missing-detail coverage to one per attack event", () => {
        const emptyFlight = {
            attackerId: "own",
            primaryTargetId: "enemy",
            response: false,
            hitIndex: 0 as const,
            missed: false,
            arcs: [],
            splash: [],
        };
        const metrics = summarizePremiumCombatMetrics(
            fixture([
                attack({
                    chakramFlights: [emptyFlight, { ...emptyFlight, hitIndex: 1 }, { ...emptyFlight, missed: true }],
                }),
            ]),
        );
        expect(metrics.coverage.attackEvents).toBe(1);
        expect(metrics.coverage.attacksWithoutDetailedHp).toBe(1);
        expect(metrics.stacks.find((row) => row.unitId === "enemy")!.reportedMissesReceived).toBe(1);
    });
    test("counts actual detailed hits once and separates healing, absorption, and redirected HP", () => {
        const input = fixture([
            attack({
                hits: [
                    { amount: 10, unitsDied: 1 },
                    { amount: 5, unitsDied: 0 },
                ],
                secondary: [
                    { source: "water_shield", unitId: "enemy", position: pos, amount: 40, unitsDied: 0 },
                    { source: "devour_essence", unitId: "own", position: pos, amount: 7, unitsDied: 0 },
                    { source: "flesh_shield", unitId: "split", position: pos, amount: 8, unitsDied: 1 },
                ],
            }),
        ]);
        const original = structuredClone(input),
            metrics = summarizePremiumCombatMetrics(input);
        const own = metrics.stacks.find((r) => r.unitId === "own")!,
            enemy = metrics.stacks.find((r) => r.unitId === "enemy")!;
        expect(own.attributedDamageDealtHp).toEqual({ attack_primary: 15 });
        expect(own.devourHealingHp).toBe(7);
        expect(enemy.waterShieldAbsorbedHp).toBe(40);
        expect(enemy.damageReceivedHp).toEqual({ attack_primary: 15 });
        expect(enemy.reportedCreatureLosses).toEqual({ attack_primary: 1 });
        expect(metrics.stacks.find((r) => r.unitId === "split")!.fleshShieldRedirectedHp).toBe(8);
        expect(metrics.damageWithoutSourceHp).toEqual({ "secondary:flesh_shield": 8 });
        expect(input).toEqual(original);
    });

    test("does not count flight, flat splash, primary hits and headline as four versions of the same impact", () => {
        const splash = [{ unitId: "enemy", position: pos, amount: 10, unitsDied: 1 }];
        const metrics = summarizePremiumCombatMetrics(
            fixture([
                attack({
                    hits: [{ amount: 10, unitsDied: 1 }],
                    splash,
                    chakramFlights: [
                        {
                            attackerId: "own",
                            primaryTargetId: "enemy",
                            response: false,
                            hitIndex: 0,
                            missed: false,
                            arcs: [],
                            splash,
                        },
                        {
                            attackerId: "enemy",
                            primaryTargetId: "own",
                            response: true,
                            hitIndex: 0,
                            missed: false,
                            arcs: [],
                            splash: [{ unitId: "own", position: pos, amount: 3, unitsDied: 0 }],
                        },
                    ],
                }),
            ]),
        );
        expect(metrics.stacks.find((r) => r.unitId === "own")!.attributedDamageDealtHp).toEqual({ attack_splash: 10 });
        expect(metrics.stacks.find((r) => r.unitId === "enemy")!.attributedDamageDealtHp).toEqual({ attack_splash: 3 });
        expect(metrics.stacks.reduce((n, r) => n + sum(r.damageReceivedHp), 0)).toBe(13);
        const old = summarizePremiumCombatMetrics(fixture([attack({ hits: [{ amount: 10, unitsDied: 1 }], splash })]));
        expect(old.damageWithoutSourceHp).toEqual({ attack_splash: 10 });
        expect(old.stacks.reduce((n, r) => n + sum(r.attributedDamageDealtHp), 0)).toBe(0);
    });

    test("keeps incomplete attack payloads explicit and counts misses without invented damage", () => {
        const metrics = summarizePremiumCombatMetrics(
            fixture([attack(), attack({ missed: true }), attack({ unitId: "", hits: [] })]),
        );
        expect(metrics.coverage.attacksWithoutDetailedHp).toBe(2);
        expect(metrics.stacks.find((r) => r.unitId === "enemy")!.reportedMissesReceived).toBe(1);
        expect(metrics.stacks.reduce((n, r) => n + sum(r.damageReceivedHp), 0)).toBe(0);
        expect(summarizePremiumCombatMetrics(fixture()).eventCoverage).toBe("unavailable");
    });

    test("assigns reflected spells to the mirror owner and leaves environment/unknown reflection unattributed", () => {
        const metrics = summarizePremiumCombatMetrics(
            fixture([
                spell({
                    damaged: [
                        { unitId: "enemy", position: pos, amount: 9, unitsDied: 1 },
                        {
                            unitId: "own",
                            position: pos,
                            amount: 4,
                            unitsDied: 0,
                            rebounded: true,
                            reboundedFromUnitId: "enemy",
                        },
                        { unitId: "split", position: pos, amount: 2, unitsDied: 0, rebounded: true },
                    ],
                }),
                { type: "poison_ticked", unitId: "own", damage: 3, unitsDied: 0 },
                { type: "fire_wall_burned", unitId: "own", amount: 5, unitsDied: 1, cells: [pos], position: pos },
                { type: "armageddon_applied", unitId: "own", wave: 1, damage: 7, unitsDied: 1 },
            ]),
        );
        expect(metrics.stacks.find((r) => r.unitId === "own")!.attributedDamageDealtHp).toEqual({ spell: 9 });
        expect(metrics.stacks.find((r) => r.unitId === "enemy")!.attributedDamageDealtHp).toEqual({ spell_rebound: 4 });
        expect(sum(metrics.damageWithoutSourceHp)).toBe(17);
        expect(metrics.stacks.reduce((n, r) => n + sum(r.damageReceivedHp), 0)).toBe(30);
    });

    test("retains control loss, morale, movement, spell outcomes, transfers and first-offense timing", () => {
        const input = fixture([
            { type: "next_unit_selected", unitId: "own", team: left },
            { type: "unit_waited", unitId: "own", team: left },
            { type: "turn_completed", unitId: "own", team: left, hourglass: true },
            { type: "unit_skipped", unitId: "split", team: left, reason: "effect" },
            { type: "morale_applied", unitId: "split", kind: "minus", lap: 1 },
            {
                type: "unit_moved",
                unitId: "own",
                from: pos,
                to: { x: 2, y: 2 },
                path: [pos, { x: 2, y: 2 }],
                targetCells: [{ x: 2, y: 2 }],
            },
            { type: "unit_moved_by_system", unitId: "split", position: pos, reason: "narrowing" },
            { type: "next_unit_selected", unitId: "own", team: left },
            attack({ hits: [{ amount: 2, unitsDied: 0 }] }),
            spell({
                spellName: "Craft",
                outcomes: [
                    { unitId: "own", outcome: "nothing" },
                    { unitId: "split", outcome: "double" },
                ],
                abilityTransfers: [
                    { abilityName: "Regeneration", fromUnitId: "own", toUnitId: "split", mode: "copied" },
                ],
            }),
        ]);
        const metrics = summarizePremiumCombatMetrics(input);
        const own = metrics.stacks.find((r) => r.unitId === "own")!,
            split = metrics.stacks.find((r) => r.unitId === "split")!;
        expect(own.activationsBeforeFirstOffense).toBe(2);
        expect(own.hourglassCompletions).toBe(1);
        expect(own.reportedRouteCells).toBe(2);
        expect(own.distinctPrimaryEnemyTargets).toEqual(["enemy"]);
        expect(own.spellOutcomes).toEqual({ "Craft:nothing": 1, "Craft:double": 1 });
        expect(split.skips).toEqual({ effect: 1 });
        expect(split.morale).toEqual({ minus: 1 });
        expect(split.abilityTransfersReceived).toEqual({ "copied:Regeneration": 1 });
        expect(split.systemMoves).toBe(1);
        const group = premiumDraftedCombatMetrics(metrics, summarizePremiumParticipation(input)).find(
            (row) => row.creatureId === 11,
        )!.values;
        expect(Object.keys(group).sort()).toEqual(Object.keys(PREMIUM_COMBAT_UNIT_METRICS).sort());
        expect(group.offensiveStacks).toBe(1);
        expect(group.stacksWithoutRecordedOffense).toBe(1);
        expect(group.activationsThroughFirstOffense).toBe(2);
        expect(group.firstOffenseLapTotal).toBe(1);
        expect(group.primaryEnemyTargetIncidences).toBe(1);
        expect(group.spellTargetOutcomes).toBe(2);
        expect(group.abilityTransfersGiven).toBe(1);
        expect(group.abilityTransfersReceived).toBe(1);
        expect(group.spellCasts).toBe(1);
        expect(group.recordedActions).toBe(5);
        expect(group.effectsAppliedReceived).toBe(0);
        expect(group.negativeMorale).toBe(1);
        expect(group.positiveMorale).toBe(0);
        expect(group.openingMeasuredStacks).toBe(0);
        expect(group.openingEnemyDistanceMeasuredStacks).toBe(0);
    });

    test("uses actual footprint geometry and aggregates split children without counting summons as independent units", () => {
        const input = fixture([
            {
                type: "unit_summoned",
                casterId: "own",
                unitId: "child",
                team: left,
                unitName: "Summon",
                amount: 3,
                position: pos,
                cells: [pos],
                merged: false,
            },
            { type: "next_unit_selected", unitId: "own", team: left },
            { type: "next_unit_selected", unitId: "split", team: left },
            { type: "next_unit_selected", unitId: "child", team: left },
        ]);
        const firstDecisionState = {
            stage: "first-decision-after-start",
            actingUnitId: "own",
            lap: 1,
            units: [
                {
                    properties: { id: "own", name: "Own", team: left, amount_alive: 10 },
                    cells: [
                        { x: 1, y: 1 },
                        { x: 2, y: 1 },
                    ],
                },
                { properties: { id: "split", name: "Split", team: left, amount_alive: 2 }, cells: [{ x: 3, y: 1 }] },
                { properties: { id: "enemy", name: "Enemy", team: right, amount_alive: 10 }, cells: [{ x: 5, y: 4 }] },
            ],
        } as IAiMetaFightEvidence["firstDecisionState"];
        const metrics = summarizePremiumCombatMetrics({ ...input, firstDecisionState });
        expect(metrics.stacks.find((r) => r.unitId === "own")!.opening).toEqual({
            nearestEnemyCells: 3,
            adjacentAlliedStacks: 1,
        });
        const group = premiumDraftedCombatMetrics(
            metrics,
            summarizePremiumParticipation({ ...input, firstDecisionState }),
        ).find((g) => g.creatureId === 11)!;
        expect(group.values.stacks).toBe(2);
        expect(group.values.activations).toBe(2);
        expect(group.values.openingMeasuredStacks).toBe(2);
        expect(group.values.openingEnemyDistanceMeasuredStacks).toBe(2);
        expect(group.values.openingNearestEnemyCellTotal).toBe(6);
        expect(group.values.openingAdjacentAlliedStackTotal).toBe(2);
        expect(group.values.summonedCreatures).toBe(3);
        expect(group.values.offensiveStacks).toBe(0);
        expect(group.values.stacksWithoutRecordedOffense).toBe(2);
        expect(metrics.coverage.unknownStackIds).toEqual([]);
    });

    test("distinguishes applied effects from resistance and refuses missing committed coverage", () => {
        const input = fixture([
            {
                type: "effects_applied",
                applications: [
                    { unitId: "own", name: "Blessing", kind: "buff", laps: 2 },
                    { unitId: "split", name: "Stun", kind: "effect", resisted: true },
                ],
            },
        ]);
        const metrics = summarizePremiumCombatMetrics(input);
        const participation = summarizePremiumParticipation(input);
        const values = premiumDraftedCombatMetrics(metrics, participation).find((row) => row.creatureId === 11)!.values;
        expect(values.effectsAppliedReceived).toBe(1);
        expect(values.effectsResistedReceived).toBe(1);
        expect(values.spellCasts).toBe(0);
        expect(values.recordedActions).toBe(0);
        expect(() => premiumDraftedCombatMetrics(metrics, { ...participation, eventCoverage: "unavailable" })).toThrow(
            "committed event coverage",
        );
        expect(() => premiumDraftedCombatMetrics(metrics, { ...participation, stacks: [] })).toThrow(
            "matching participation ancestry",
        );
    });
});
