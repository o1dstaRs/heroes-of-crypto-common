import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { buildRoster, creaturesByLevel, makeRng } from "../../src/simulation/army";
import { validateV08CampaignAllUnitCoverageSummary } from "../../src/simulation/v0_8_aggressive_12h";
import {
    GREEN_TEAM,
    type IDecisionObservation,
    type ITurnExecutionObservation,
} from "../../src/simulation/battle_engine";
import {
    assertV08AllUnitCatalogCurrent,
    createV08AllUnitActionAudit,
    fingerprintV08AllUnitCoveragePlan,
    forceV08AllUnitCoverageUnit,
    getV08AllUnitCoverageGameCount,
    planV08AllUnitCoverageGame,
    runV08AllUnitCoverageConcurrent,
    summarizeV08AllUnitCoverage,
    V08AllUnitTargetAuditor,
    V08_ALL_UNIT_CATALOG,
    V08_ALL_UNIT_CATALOG_SHA256,
    V08_ALL_UNIT_COVERAGE_LANES,
    V08_ALL_UNIT_COVERAGE_SCHEMA,
    V08_ALL_UNIT_EXPECTED_CATALOG_SHA256,
    V08_ALL_UNIT_LIVE_MAPS,
    type IV08AllUnitActionAudit,
    type IV08AllUnitCoverageOptions,
    type IV08AllUnitCoverageRecord,
} from "../../src/simulation/v0_8_all_unit_coverage";

const OPTIONS: IV08AllUnitCoverageOptions = {
    candidateVersion: "v0.8s",
    opponentVersion: "v0.7",
    pairsPerMap: 1,
    baseSeed: 0x1234_5678,
    sourceCommit: "test-source",
};

const qualifiedAudit = (lane: (typeof V08_ALL_UNIT_COVERAGE_LANES)[number]): IV08AllUnitActionAudit => {
    const audit = createV08AllUnitActionAudit();
    audit.appearances = 1;
    audit.actingTurns = 1;
    audit.spellDecisionTurns = 1;
    audit.completedActions = 1;
    audit.completedStrategyActions = 1;
    audit.productiveActions = 1;
    audit.actionTypes.move_unit = 1;
    audit.productiveActionTypes.move_unit = 1;

    const intrinsic = Object.entries(lane.intrinsicSpells);
    if (intrinsic.length > 0) {
        audit.activeIntrinsicSpellTurns = 1;
        for (const [spell, amount] of intrinsic) {
            audit.activeIntrinsicSpellsObserved[spell] = 1;
            audit.activeIntrinsicSpellChargesByName[spell] = amount;
            audit.activeIntrinsicSpellChargesObserved += amount;
        }
        if (lane.owner === "candidate") {
            const spell = intrinsic[0]![0];
            audit.completedActions += 1;
            audit.completedStrategyActions += 1;
            audit.productiveActions += 1;
            audit.actionTypes.cast_spell = 1;
            audit.productiveActionTypes.cast_spell = 1;
            audit.intrinsicSpellCasts[spell] = 1;
        }
    }
    return audit;
};

const fixtureRecord = (game: number): IV08AllUnitCoverageRecord => {
    const plan = planV08AllUnitCoverageGame(OPTIONS, game);
    return {
        schema: V08_ALL_UNIT_COVERAGE_SCHEMA,
        catalogSha256: V08_ALL_UNIT_CATALOG_SHA256,
        game,
        pair: plan.pair,
        repetition: plan.repetition,
        seed: plan.seed,
        mapType: plan.mapType,
        lane: plan.lane,
        candidateVersion: OPTIONS.candidateVersion,
        opponentVersion: OPTIONS.opponentVersion,
        candidateSide: plan.candidateSide,
        targetSide: plan.targetSide,
        targetIndex: plan.targetIndex,
        greenRoster: plan.greenRoster.map(({ creatureName }) => creatureName),
        redRoster: plan.redRoster.map(({ creatureName }) => creatureName),
        winner: "candidate",
        laps: 4,
        endReason: "elimination",
        rejectedCandidate: 0,
        rejectedOpponent: 0,
        target: qualifiedAudit(plan.lane),
    };
};

describe("v0.8 exact all-unit coverage panel", () => {
    test("pins the dynamically enumerated enabled catalog and runtime-native spell kits", () => {
        const enabledNames = [1, 2, 3, 4]
            .flatMap((level) => creaturesByLevel(level).map(({ creatureName }) => creatureName))
            .sort();
        expect(V08_ALL_UNIT_CATALOG.map(({ unit }) => unit).sort()).toEqual(enabledNames);
        expect(V08_ALL_UNIT_CATALOG).toHaveLength(56);
        expect(V08_ALL_UNIT_CATALOG_SHA256).toBe(V08_ALL_UNIT_EXPECTED_CATALOG_SHA256);
        expect(() => assertV08AllUnitCatalogCurrent()).not.toThrow();

        const intrinsic = Object.fromEntries(
            V08_ALL_UNIT_CATALOG.filter(({ intrinsicSpells }) => Object.keys(intrinsicSpells).length > 0).map(
                ({ unit, intrinsicSpells }) => [unit, intrinsicSpells],
            ),
        );
        expect(Object.keys(intrinsic)).toEqual([
            "Ash Moth",
            "Blacksmith",
            "Battle Mage",
            "Harpy",
            "Healer",
            "Satyr",
            "Trent",
            "Troll",
            "Valkyrie",
            "Nightmare",
            "Ogre Mage",
            "Angel",
            "Behemoth",
            "Magic Dragon",
        ]);
        expect(intrinsic.Trent).toEqual({ "Vine Throw": 1 });
        expect(intrinsic.Angel).toEqual({ Resurrection: 1 });
        expect(intrinsic["Magic Dragon"]).toEqual({
            "Lightning Strike": 4,
            "Meteor Shower": 1,
            "Ring of Fire": 2,
            Whirlpool: 1,
        });

        const drifted = V08_ALL_UNIT_CATALOG.map((entry, index) =>
            index === 0 ? { ...entry, unit: "Drifted Arbalester" } : entry,
        );
        expect(() => assertV08AllUnitCatalogCurrent(drifted)).toThrow("catalog drift");
    });

    test("defines target ownership on both strategies for every enabled creature", () => {
        expect(V08_ALL_UNIT_COVERAGE_LANES).toHaveLength(V08_ALL_UNIT_CATALOG.length * 2);
        for (const target of V08_ALL_UNIT_CATALOG) {
            const lanes = V08_ALL_UNIT_COVERAGE_LANES.filter(({ unit }) => unit === target.unit);
            expect(lanes.map(({ owner }) => owner)).toEqual(["candidate", "opponent"]);
            expect(lanes.every(({ controlUnit }) => controlUnit !== target.unit)).toBe(true);
            expect(lanes.every(({ intrinsicSpells }) => intrinsicSpells === target.intrinsicSpells)).toBe(true);
        }
    });

    test("forces exactly one target stack against a distinct same-level control", () => {
        const base = buildRoster(makeRng(99), undefined, undefined, undefined, "expBudget");
        for (const target of V08_ALL_UNIT_CATALOG) {
            const forced = forceV08AllUnitCoverageUnit(base, target.unit);
            expect(forced.targetRoster.filter(({ creatureName }) => creatureName === target.unit)).toHaveLength(1);
            expect(forced.controlRoster.filter(({ creatureName }) => creatureName === target.unit)).toHaveLength(0);
            expect(forced.targetRoster[forced.targetIndex]).toMatchObject({
                creatureName: target.unit,
                faction: target.faction,
                level: target.level,
                size: target.size,
            });
            expect(forced.controlRoster[forced.targetIndex]?.creatureName).not.toBe(target.unit);
            for (let index = 0; index < forced.targetRoster.length; index += 1) {
                if (index !== forced.targetIndex) {
                    expect(forced.targetRoster[index]).toEqual(forced.controlRoster[index]);
                }
            }
        }
    });

    test("schedules every lane on all live maps and both physical seats with an exact plan hash", () => {
        expect(V08_ALL_UNIT_LIVE_MAPS).toEqual([
            PBTypes.GridVals.NORMAL,
            PBTypes.GridVals.LAVA_CENTER,
            PBTypes.GridVals.BLOCK_CENTER,
        ]);
        expect(getV08AllUnitCoverageGameCount(OPTIONS)).toBe(56 * 2 * 3 * 2);
        for (let laneIndex = 0; laneIndex < V08_ALL_UNIT_COVERAGE_LANES.length; laneIndex += 1) {
            for (let mapIndex = 0; mapIndex < V08_ALL_UNIT_LIVE_MAPS.length; mapIndex += 1) {
                const evenGame = (laneIndex * V08_ALL_UNIT_LIVE_MAPS.length + mapIndex) * 2;
                const even = planV08AllUnitCoverageGame(OPTIONS, evenGame);
                const odd = planV08AllUnitCoverageGame(OPTIONS, evenGame + 1);
                expect(even.lane).toEqual(V08_ALL_UNIT_COVERAGE_LANES[laneIndex]);
                expect(even.mapType).toBe(V08_ALL_UNIT_LIVE_MAPS[mapIndex]);
                expect(even.candidateSide).toBe("green");
                expect(odd.candidateSide).toBe("red");
                expect(odd.seed).toBe(even.seed);
                expect(odd.mapType).toBe(even.mapType);
                expect(odd.greenRoster).toEqual(even.redRoster);
                expect(odd.redRoster).toEqual(even.greenRoster);
                expect(even.targetSide === even.candidateSide).toBe(even.lane.owner === "candidate");
                expect(odd.targetSide === odd.candidateSide).toBe(odd.lane.owner === "candidate");
            }
        }
        const first = fingerprintV08AllUnitCoveragePlan(OPTIONS);
        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(fingerprintV08AllUnitCoveragePlan(OPTIONS)).toBe(first);
        expect(fingerprintV08AllUnitCoveragePlan({ ...OPTIONS, baseSeed: OPTIONS.baseSeed + 1 })).not.toBe(first);
        expect(() => fingerprintV08AllUnitCoveragePlan({ ...OPTIONS, baseSeed: -1 })).toThrow("uint32");
        expect(() => runV08AllUnitCoverageConcurrent(OPTIONS, 0)).toThrow("positive integer");
        expect(() => runV08AllUnitCoverageConcurrent(OPTIONS, 1.5)).toThrow("positive integer");
    });

    test("attributes only still-remaining intrinsic spells and audits all action/recovery classes", () => {
        const lane = V08_ALL_UNIT_COVERAGE_LANES.find(
            ({ unit, owner }) => unit === "Battle Mage" && owner === "candidate",
        )!;
        const auditor = new V08AllUnitTargetAuditor(lane, "green");
        const unitId = "battle-mage";
        auditor.audit.appearances = 1;
        auditor.observeDecision({
            unit: {
                getId: () => unitId,
                getName: () => "Battle Mage",
                getTeam: () => GREEN_TEAM,
                getSpells: () => [
                    { getName: () => "Fire Strike", getAmount: () => 2, isRemaining: () => true },
                    { getName: () => "Meteorite", getAmount: () => 0, isRemaining: () => false },
                    { getName: () => "Granted Spell", getAmount: () => 7, isRemaining: () => true },
                ],
            },
        } as unknown as IDecisionObservation);

        const actions: GameAction[] = [
            { type: "move_unit", unitId, path: [{ x: 1, y: 1 }] },
            { type: "cast_spell", casterId: unitId, spellName: "Fire Strike" },
            { type: "cast_spell", casterId: unitId, spellName: "Granted Spell" },
            { type: "wait_turn", unitId },
        ];
        auditor.observeTurn({
            unitId,
            creatureName: "Battle Mage",
            side: "green",
            strategyVersion: "v0.8",
            rawIncumbent: [
                { type: "end_turn", unitId },
                { type: "defend_turn", unitId },
            ],
            chosenDecision: actions,
            strategyActions: [
                ...actions.map((action) => ({ action, completed: true, events: [] })),
                {
                    action: {
                        type: "melee_attack",
                        attackerId: unitId,
                        targetId: "enemy",
                        attackFrom: { x: 0, y: 0 },
                    } as const,
                    completed: false,
                    rejectionReason: "blocked",
                    events: [],
                },
            ],
            recoveryAttempts: [
                {
                    source: "defend",
                    action: { type: "defend_turn", unitId },
                    completed: false,
                    rejectionReason: "turn_closed",
                    events: [],
                },
            ],
            recovery: {
                source: "defend",
                action: { type: "defend_turn", unitId },
                completed: false,
                rejectionReason: "turn_closed",
                events: [],
            },
            events: [],
        } as ITurnExecutionObservation);
        auditor.finish();

        expect(auditor.audit).toMatchObject({
            appearances: 1,
            actingTurns: 1,
            spellDecisionTurns: 1,
            decisionPairingFaults: 0,
            completedActions: 4,
            completedStrategyActions: 4,
            completedRecoveryActions: 0,
            recoveryTurns: 1,
            rejectedStrategyActions: 1,
            rejectedRecoveryActions: 1,
            productiveActions: 3,
            completedPassiveActions: 1,
            rawEndTurnDecisions: 1,
            rawEmptyDecisions: 0,
            rawPassiveTurnDecisions: 1,
            actionTypes: { move_unit: 1, cast_spell: 2, wait_turn: 1 },
            productiveActionTypes: { move_unit: 1, cast_spell: 2 },
            passiveActionTypes: { wait_turn: 1 },
            rejectionReasons: { blocked: 1, turn_closed: 1 },
            activeIntrinsicSpellTurns: 1,
            activeIntrinsicSpellChargesObserved: 2,
            activeIntrinsicSpellsObserved: { "Fire Strike": 1 },
            activeIntrinsicSpellChargesByName: { "Fire Strike": 2 },
            intrinsicSpellCasts: { "Fire Strike": 1 },
        });
    });

    test("builds a fail-closed exact census and hard-gates candidate behavior and caster exercise", () => {
        const records = Array.from({ length: getV08AllUnitCoverageGameCount(OPTIONS) }, (_, game) =>
            fixtureRecord(game),
        );
        const summary = summarizeV08AllUnitCoverage(OPTIONS, records);
        const campaignExpectation = {
            sourceCommit: OPTIONS.sourceCommit!,
            baseSeed: OPTIONS.baseSeed,
            pairsPerMap: OPTIONS.pairsPerMap,
            games: records.length,
        };
        expect(summary.gates.pass).toBe(true);
        expect(summary.gates.failed).toEqual([]);
        expect(summary.planSha256).toBe(fingerprintV08AllUnitCoveragePlan(OPTIONS));
        expect(summary.lanes).toHaveLength(112);
        expect(summary.eligibleIntrinsicCasters).toHaveLength(14);
        expect(() => validateV08CampaignAllUnitCoverageSummary(summary, campaignExpectation)).not.toThrow();
        for (const lane of summary.lanes) {
            expect(lane.games).toBe(6);
            expect(lane.candidateGreenGames).toBe(3);
            expect(lane.candidateRedGames).toBe(3);
            expect(lane.appearances).toBe(6);
            expect(lane.mapCensus).toEqual(
                V08_ALL_UNIT_LIVE_MAPS.map((mapType) => ({
                    mapType,
                    games: 2,
                    candidateGreenGames: 1,
                    candidateRedGames: 1,
                })),
            );
        }

        const missing = summarizeV08AllUnitCoverage(OPTIONS, records.slice(0, -1));
        expect(missing.gates.pass).toBe(false);
        expect(missing.gates.failed).toContain("exact_schedule_count");
        expect(missing.gates.failed).toContain("exact_lane_census");

        const rawNoOpIndex = records.findIndex(({ lane }) => lane.owner === "candidate");
        const rawNoOp = records.map((record, index) =>
            index === rawNoOpIndex
                ? {
                      ...record,
                      target: { ...record.target, rawEndTurnDecisions: 1 },
                  }
                : record,
        );
        const failedSummary = summarizeV08AllUnitCoverage(OPTIONS, rawNoOp);
        expect(failedSummary.gates.failed).toContain("candidate_target_raw_no_op_zero");
        expect(() => validateV08CampaignAllUnitCoverageSummary(failedSummary, campaignExpectation)).not.toThrow();
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary(
                { ...failedSummary, gates: { ...failedSummary.gates, pass: true } },
                campaignExpectation,
            ),
        ).toThrow("inconsistent qualification gates");
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary(summary, {
                ...campaignExpectation,
                sourceCommit: "wrong-source",
            }),
        ).toThrow("Invalid all-unit");
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary({ ...summary, planSha256: "0".repeat(64) }, campaignExpectation),
        ).toThrow("Invalid all-unit");
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary(
                { ...summary, catalogSha256: "0".repeat(64) },
                campaignExpectation,
            ),
        ).toThrow("Invalid all-unit");
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary(
                { ...summary, lanes: [...summary.lanes.slice(0, -1), summary.lanes[0]!] },
                campaignExpectation,
            ),
        ).toThrow("Invalid all-unit coverage lane");
        expect(() =>
            validateV08CampaignAllUnitCoverageSummary(
                {
                    ...summary,
                    lanes: [
                        {
                            ...summary.lanes[0]!,
                            mapCensus: [
                                { ...summary.lanes[0]!.mapCensus[0]!, games: 3 },
                                ...summary.lanes[0]!.mapCensus.slice(1),
                            ],
                        },
                        ...summary.lanes.slice(1),
                    ],
                },
                campaignExpectation,
            ),
        ).toThrow("Invalid all-unit map census");

        const casterIndex = records.findIndex(
            ({ lane }) => lane.owner === "candidate" && Object.keys(lane.intrinsicSpells).length > 0,
        );
        const casterUnit = records[casterIndex]!.lane.unit;
        const unexercised = records.map((record) =>
            record.lane.owner === "candidate" && record.lane.unit === casterUnit
                ? {
                      ...record,
                      target: { ...record.target, intrinsicSpellCasts: {} },
                  }
                : record,
        );
        expect(summarizeV08AllUnitCoverage(OPTIONS, unexercised).gates.failed).toContain(
            "remaining_intrinsic_casters_exercised",
        );

        expect(() =>
            summarizeV08AllUnitCoverage(OPTIONS, [
                { ...records[0]!, mapType: PBTypes.GridVals.WATER_CENTER },
                ...records.slice(1),
            ]),
        ).toThrow("deterministic plan");
    });
});
