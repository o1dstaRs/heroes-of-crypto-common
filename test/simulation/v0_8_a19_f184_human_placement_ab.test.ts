import { describe, expect, test } from "bun:test";

import { V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE } from "../../src/ai/versions/v0_8_a19_h18_f184_human_placement_profile";
import type { IV08A19F184HumanPlacementAudit } from "../../src/ai/versions/v0_8_a19_f184_human_placement";
import type { IAiMetaArmy } from "../../src/simulation/ai_meta_cohorts_core";
import { hashSimulationParts } from "../../src/simulation/army";
import type { Side } from "../../src/simulation/battle_engine";
import {
    V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING,
    V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
    V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED,
    V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS,
    V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE,
    V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
    V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
    V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE,
    V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA,
    V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS,
    buildV08A19F184HumanPlacementAbEnvironment,
    causalV08A19F184HumanPlacementEffects,
    completeV08A19F184HumanPlacementAbQuality,
    evaluateV08A19F184HumanPlacementAbGates,
    expectedV08A19F184CanonicalPlacement,
    fingerprintV08A19F184HumanPlacementArmy,
    fingerprintV08A19F184HumanPlacementSetup,
    parseV08A19F184HumanPlacementAbOptions,
    summarizeV08A19F184HumanPlacementAbRecords,
    validateV08A19F184HumanPlacementAbRecords,
    type IV08A19F184HumanPlacementAbClusterRecord,
    type IV08A19F184HumanPlacementAbGameOutcome,
    type IV08A19F184HumanPlacementAbScheduleEntry,
    type V08A19F184HumanPlacementAbRoster,
} from "../../src/simulation/v0_8_a19_f184_human_placement_ab";
import { prepareV08A19ProdF184Pair } from "../../src/simulation/v0_8_a19_prod_f184_anchor";

const scoreForSide = (winner: Side | "draw", side: Side): number => (winner === "draw" ? 0.5 : winner === side ? 1 : 0);

const scoresFor = (
    winner: Side | "draw",
    scheduled: IV08A19F184HumanPlacementAbScheduleEntry,
): Readonly<Record<V08A19F184HumanPlacementAbRoster, number>> =>
    ({
        [scheduled.greenRoster]: scoreForSide(winner, "green"),
        [scheduled.redRoster]: scoreForSide(winner, "red"),
    }) as Readonly<Record<V08A19F184HumanPlacementAbRoster, number>>;

const openingId = (roster: V08A19F184HumanPlacementAbRoster) =>
    roster === "a" ? ("prod-f184-lower-roster" as const) : ("prod-f184-upper-roster" as const);

const validAudit = (roster: V08A19F184HumanPlacementAbRoster): IV08A19F184HumanPlacementAudit => ({
    treatmentApplied: true,
    placementChanged: true,
    horizontalDisplacement: 8,
    openingId: openingId(roster),
    templateUnitsMoved: 6,
    fallbackReason: null,
    incumbentFingerprint: `incumbent-${roster}`,
    selectedFingerprint: `selected-${roster}`,
});

const armyFor = (
    armies: Readonly<Record<V08A19F184HumanPlacementAbRoster, IAiMetaArmy>>,
    roster: V08A19F184HumanPlacementAbRoster,
): IAiMetaArmy => armies[roster];

const record = (
    cluster: number,
    winners: readonly [Side | "draw", Side | "draw", Side | "draw", Side | "draw", Side | "draw", Side | "draw"],
    baseSeed = V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS.smoke,
): IV08A19F184HumanPlacementAbClusterRecord => {
    const prepared = prepareV08A19ProdF184Pair(baseSeed, cluster);
    const armies = { a: prepared.armyA, b: prepared.armyB } as const;
    const games = V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE.map((scheduled, index) => {
        const winner = winners[index];
        const treatedRoster = scheduled.treatedRoster;
        return {
            scheduleId: scheduled.id,
            greenRoster: scheduled.greenRoster,
            redRoster: scheduled.redRoster,
            treatedRoster,
            treatedSide: scheduled.treatedSide,
            cell: scheduled.cell,
            winner,
            scoreByRoster: scoresFor(winner, scheduled),
            laps: 5,
            endReason: "elimination",
            armageddonDecided: false,
            rejectedGreen: 0,
            rejectedRed: 0,
            setupFingerprint: fingerprintV08A19F184HumanPlacementSetup(
                armyFor(armies, scheduled.greenRoster),
                armyFor(armies, scheduled.redRoster),
                V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
            ),
            candidateAudit: treatedRoster === null ? null : validAudit(treatedRoster),
            candidateCanonicalPlacement:
                treatedRoster === null ? null : expectedV08A19F184CanonicalPlacement(treatedRoster),
        } satisfies IV08A19F184HumanPlacementAbGameOutcome;
    }) as unknown as IV08A19F184HumanPlacementAbClusterRecord["games"];
    return {
        schema: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA,
        productionAnchor: V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING,
        cluster,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
        armyFingerprints: {
            a: fingerprintV08A19F184HumanPlacementArmy(prepared.armyA),
            b: fingerprintV08A19F184HumanPlacementArmy(prepared.armyB),
        },
        games,
    };
};

const NO_EFFECT_A_ALWAYS_WINS = ["green", "green", "green", "red", "red", "red"] as const;
const POSITIVE_DRAW_BASELINES = ["draw", "green", "red", "draw", "green", "red"] as const;

describe("v0.8+A19 f184 human-placement causal A/B", () => {
    test("pins three disjoint stages, seeds, bootstrap, and A19/H18 environment", () => {
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA).toBe("hoc.v0_8_a19_f184_human_placement_causal_ab.v10");
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE).toBe(6);
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE).toEqual({
            smoke: 8,
            development: 360,
            validation: 1_440,
        });
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS).toEqual({
            smoke: hashSimulationParts("v0.8-a19-prod-f184-opening-v10-smoke", 1),
            development: hashSimulationParts("v0.8-a19-prod-f184-opening-v10-development", 1),
            validation: hashSimulationParts("v0.8-a19-prod-f184-opening-v10-validation", 1),
        });
        expect(Number(V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED)).toBe(
            hashSimulationParts("v0.8-a19-prod-f184-opening-v10-bootstrap", 1),
        );
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS).toBe(100_000);
        expect(
            new Set([
                ...Object.values(V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS),
                V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED,
            ]).size,
        ).toBe(4);

        const environment = buildV08A19F184HumanPlacementAbEnvironment();
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_HORIZON: "18",
            SEARCH_SHORTLIST: "3",
            V08_A13_SEARCH: "0",
            LIVETWIN: "1",
            SIM_NO_ACTIONS: "1",
        });
        expect(V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.candidateId).toBe("a19-h18-prod-f184-opening-v1-research");
    });

    test("parses only the fixed stage geometries and concurrency twelve", () => {
        expect(parseV08A19F184HumanPlacementAbOptions(["--output", "tmp/f184-smoke"])).toMatchObject({
            stage: "smoke",
            clusters: 8,
            baseSeed: V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS.smoke,
            concurrency: 12,
            maxLaps: 60,
        });
        expect(
            parseV08A19F184HumanPlacementAbOptions(["--stage", "development", "--output", "tmp/f184-development"]),
        ).toMatchObject({ stage: "development", clusters: 360 });
        expect(
            parseV08A19F184HumanPlacementAbOptions([
                "--stage",
                "validation",
                "--output",
                "tmp/f184-validation",
                "--concurrency",
                "12",
            ]),
        ).toMatchObject({ stage: "validation", clusters: 1_440 });
        expect(() => parseV08A19F184HumanPlacementAbOptions([])).toThrow("--output is required");
        expect(() => parseV08A19F184HumanPlacementAbOptions(["--output", "tmp/out", "--concurrency", "11"])).toThrow(
            "requires concurrency 12",
        );
        expect(() => parseV08A19F184HumanPlacementAbOptions(["--stage", "tune", "--output", "tmp/out"])).toThrow(
            "stage must be smoke, development, or validation",
        );
        expect(() => parseV08A19F184HumanPlacementAbOptions(["--output", "tmp/out", "--seed", "1"])).toThrow();
    });

    test("uses six unique matches for four direct roster-by-seat effects", () => {
        expect(V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE).toEqual([
            {
                id: "ab-control",
                greenRoster: "a",
                redRoster: "b",
                treatedRoster: null,
                treatedSide: null,
                cell: null,
            },
            {
                id: "ab-a-green-treated",
                greenRoster: "a",
                redRoster: "b",
                treatedRoster: "a",
                treatedSide: "green",
                cell: "a-green",
            },
            {
                id: "ab-b-red-treated",
                greenRoster: "a",
                redRoster: "b",
                treatedRoster: "b",
                treatedSide: "red",
                cell: "b-red",
            },
            {
                id: "ba-control",
                greenRoster: "b",
                redRoster: "a",
                treatedRoster: null,
                treatedSide: null,
                cell: null,
            },
            {
                id: "ba-b-green-treated",
                greenRoster: "b",
                redRoster: "a",
                treatedRoster: "b",
                treatedSide: "green",
                cell: "b-green",
            },
            {
                id: "ba-a-red-treated",
                greenRoster: "b",
                redRoster: "a",
                treatedRoster: "a",
                treatedSide: "red",
                cell: "a-red",
            },
        ]);
        expect(
            V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE.filter(({ treatedRoster }) => treatedRoster === null),
        ).toHaveLength(2);
        expect(
            V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE.filter(({ treatedRoster }) => treatedRoster !== null),
        ).toHaveLength(4);
        expect(
            new Set(V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE.flatMap(({ cell }) => (cell === null ? [] : [cell]))),
        ).toEqual(new Set(V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS));
    });

    test("subtracts the same-orientation plain baseline and cancels raw army strength", () => {
        const fixture = record(0, NO_EFFECT_A_ALWAYS_WINS);
        const effects = causalV08A19F184HumanPlacementEffects(fixture);
        expect(Object.values(effects).map(({ delta }) => delta)).toEqual([0, 0, 0, 0]);

        // Candidate-arm raw rates would be A=100%, B=0%; neither is a causal placement effect.
        expect((fixture.games[1].scoreByRoster.a + fixture.games[5].scoreByRoster.a) / 2).toBe(1);
        expect((fixture.games[2].scoreByRoster.b + fixture.games[4].scoreByRoster.b) / 2).toBe(0);
        const summary = summarizeV08A19F184HumanPlacementAbRecords([fixture], 50);
        expect(summary.primary.meanDelta).toBe(0);
        expect(summary.rosters.a.meanDelta).toBe(0);
        expect(summary.rosters.b.meanDelta).toBe(0);
    });

    test("scores draws as one half and reports clustered causal rows", () => {
        const records = [record(0, POSITIVE_DRAW_BASELINES), record(1, POSITIVE_DRAW_BASELINES)];
        const effects = causalV08A19F184HumanPlacementEffects(records[0]);
        for (const cell of V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS) {
            expect(effects[cell]).toMatchObject({ baselineScore: 0.5, candidateScore: 1, delta: 0.5 });
        }
        const summary = summarizeV08A19F184HumanPlacementAbRecords(records, 200);
        expect(summary).toMatchObject({
            clusters: 2,
            games: 12,
            bootstrapIterations: 200,
            primary: {
                clusters: 2,
                meanDelta: 0.5,
                meanDeltaPp: 50,
                clusteredStandardError: 0,
                normal95: { low: 0.5, high: 0.5 },
                bootstrap95: { low: 0.5, high: 0.5 },
                outcomeChanges: 8,
            },
        });
        expect(Object.values(summary.cells).every(({ meanDelta }) => meanDelta === 0.5)).toBe(true);
        expect(Object.values(summary.rosters).every(({ meanDelta }) => meanDelta === 0.5)).toBe(true);
        expect(Object.values(summary.seats).every(({ meanDelta }) => meanDelta === 0.5)).toBe(true);
    });

    test("strictly validates treatment audits, exact coordinates, setup, and provenance", () => {
        const baseSeed = V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS.smoke;
        const valid = record(0, POSITIVE_DRAW_BASELINES, baseSeed);
        const quality = validateV08A19F184HumanPlacementAbRecords([valid], { clusters: 1, baseSeed }, 1, true);
        expect(quality).toMatchObject({
            expectedClusters: 1,
            clusters: 1,
            games: 6,
            malformedClusters: 0,
            duplicateClusters: 0,
            missingClusters: 0,
            auditMismatches: 0,
            coordinateMismatches: 0,
            rejectedActions: 0,
            stuckGames: 0,
            treatmentGames: 4,
            validTreatmentAudits: 4,
            sourceUnchanged: true,
        });
        expect(completeV08A19F184HumanPlacementAbQuality(quality)).toBe(true);

        const badCoordinate = structuredClone(valid);
        (badCoordinate.games[1].candidateCanonicalPlacement![0] as { x: number }).x += 1;
        const coordinateQuality = validateV08A19F184HumanPlacementAbRecords(
            [badCoordinate],
            { clusters: 1, baseSeed },
            1,
            true,
        );
        expect(coordinateQuality.coordinateMismatches).toBe(1);
        expect(completeV08A19F184HumanPlacementAbQuality(coordinateQuality)).toBe(false);

        const badAudit = structuredClone(valid);
        (badAudit.games[2].candidateAudit! as { templateUnitsMoved: number }).templateUnitsMoved = 5;
        const auditQuality = validateV08A19F184HumanPlacementAbRecords([badAudit], { clusters: 1, baseSeed }, 1, true);
        expect(auditQuality.auditMismatches).toBe(1);
        expect(completeV08A19F184HumanPlacementAbQuality(auditQuality)).toBe(false);
    });

    test("promotion gates use causal deltas and contain no raw-roster 50% check", () => {
        const base = summarizeV08A19F184HumanPlacementAbRecords(
            [record(0, POSITIVE_DRAW_BASELINES), record(1, POSITIVE_DRAW_BASELINES)],
            100,
        );
        const validationShaped = {
            ...base,
            clusters: 1_440,
            games: 1_440 * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
            bootstrapIterations: V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
        };
        const gates = evaluateV08A19F184HumanPlacementAbGates(
            validationShaped,
            { stage: "validation", clusters: 1_440 },
            true,
        );
        expect(Object.values(gates).every(Boolean)).toBe(true);
        expect(Object.keys(gates).some((key) => /raw|win.?rate|roster.*50/i.test(key))).toBe(false);

        const harmful = structuredClone(validationShaped);
        (harmful.cells["a-red"] as { meanDelta: number }).meanDelta = -0.001;
        expect(
            evaluateV08A19F184HumanPlacementAbGates(harmful, { stage: "validation", clusters: 1_440 }, true)
                .everyCellObservedNonnegative,
        ).toBe(false);
    });
});
