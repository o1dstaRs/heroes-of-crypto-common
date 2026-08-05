import { describe, expect, test } from "bun:test";

import { V08_A19_H18_RANKED_PLACEMENT_PROFILE } from "../../src/ai/versions/v0_8_a19_h18_ranked_placement_profile";
import { AI_META_COHORTS } from "../../src/simulation/ai_meta_cohorts_core";
import { hashSimulationParts } from "../../src/simulation/army";
import {
    V08_A19_PLACEMENT_AB_ARMS,
    V08_A19_PLACEMENT_AB_BOOTSTRAP_SEED,
    V08_A19_PLACEMENT_AB_COHORTS,
    V08_A19_PLACEMENT_AB_CLUSTERS_BY_STAGE,
    V08_A19_PLACEMENT_AB_EXPLICIT_SOURCE_FILES,
    V08_A19_PLACEMENT_AB_MAP,
    V08_A19_PLACEMENT_AB_SCHEMA,
    V08_A19_PLACEMENT_AB_SEEDS,
    V08_A19_PLACEMENT_CROSSOVER,
    V08_A19_PROD_F184_RECORD_BINDING,
    V08_A19_PLACEMENT_VALIDATION_GATES,
    buildV08A19PlacementAbEnvironment,
    evaluateV08A19PlacementValidationGates,
    parseV08A19PlacementAbOptions,
    playV08A19PlacementAbCluster,
    summarizeV08A19PlacementAbRecords,
    validateV08A19PlacementAbRecords,
    type IV08A19PlacementAbClusterRecord,
    type IV08A19PlacementAbGameOutcome,
    type V08A19PlacementAbCohort,
} from "../../src/simulation/v0_8_a19_placement_ab";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { V08_A19_PROD_F184_COHORT } from "../../src/simulation/v0_8_a19_prod_f184_anchor";

describe("v0.8+A19 ranked placement A/B runner", () => {
    test("parses only the frozen smoke and powered validation geometries", () => {
        expect(V08_A19_PLACEMENT_AB_SCHEMA).toBe("hoc.v0_8_a19_ranked_placement_ab.v9");
        expect(V08_A19_PLACEMENT_AB_BOOTSTRAP_SEED).toBe(
            hashSimulationParts("v0.8-public-roster-shooter-screen-role-v9-bootstrap", 1),
        );
        const smoke = parseV08A19PlacementAbOptions(["--output", "tmp/a19-placement-smoke"]);
        expect(smoke).toMatchObject({
            stage: "smoke",
            clustersPerCohort: 36,
            baseSeed: V08_A19_PLACEMENT_AB_SEEDS.smoke,
            concurrency: 12,
            maxLaps: 60,
        });
        expect(smoke.cohorts).toEqual([...V08_A19_PLACEMENT_AB_COHORTS]);
        expect(smoke.cohorts).toEqual([...AI_META_COHORTS, V08_A19_PROD_F184_COHORT]);
        expect(smoke.baseSeed).toBe(hashSimulationParts("v0.8-public-roster-shooter-screen-role-v9-smoke", 1));
        expect(smoke.clustersPerCohort * smoke.cohorts.length * V08_A19_PLACEMENT_CROSSOVER.length).toBe(1_152);

        const validation = parseV08A19PlacementAbOptions([
            "--stage",
            "validation",
            "--output",
            "tmp/a19-placement-validation",
            "--concurrency",
            "12",
        ]);
        expect(validation.clustersPerCohort).toBe(V08_A19_PLACEMENT_AB_CLUSTERS_BY_STAGE.validation);
        expect(validation.baseSeed).toBe(
            hashSimulationParts("v0.8-public-roster-shooter-screen-role-v9-validation", 1),
        );
        expect(new Set([smoke.baseSeed, validation.baseSeed, V08_A19_PLACEMENT_AB_BOOTSTRAP_SEED]).size).toBe(3);
        expect([smoke.baseSeed, validation.baseSeed]).not.toContain(2_991_862_816);
        expect([smoke.baseSeed, validation.baseSeed]).not.toContain(354_127_169);
        expect(validation.clustersPerCohort * validation.cohorts.length * V08_A19_PLACEMENT_CROSSOVER.length).toBe(
            46_080,
        );
        expect(V08_A19_PLACEMENT_VALIDATION_GATES).toMatchObject({
            minimumEligibleOrientationPairs: 60,
            minimumEligibleMatchupClusters: 45,
            primaryCiLowExclusive: 0.5,
            prodRankedAnchorScoreRateInclusive: 0.5,
        });

        expect(() => parseV08A19PlacementAbOptions(["--stage", "direction", "--output", "tmp/out"])).toThrow(
            "stage must be smoke or validation",
        );
        expect(() => parseV08A19PlacementAbOptions(["--output", "tmp/out", "--concurrency", "11"])).toThrow(
            "requires concurrency 12",
        );
        expect(() => parseV08A19PlacementAbOptions([])).toThrow("--output is required");
        expect(() => parseV08A19PlacementAbOptions(["--output", "tmp/out", "--seed", "1"])).toThrow();
    });

    test("uses a four-game crossover that forms two fixed physical-orientation pairs", () => {
        expect(V08_A19_PLACEMENT_CROSSOVER).toEqual([
            { assignment: 0, candidateRoster: "a", controlRoster: "b", candidateSide: "green" },
            { assignment: 0, candidateRoster: "a", controlRoster: "b", candidateSide: "red" },
            { assignment: 1, candidateRoster: "b", controlRoster: "a", candidateSide: "green" },
            { assignment: 1, candidateRoster: "b", controlRoster: "a", candidateSide: "red" },
        ]);
        // [0,3] holds A green/B red fixed; [1,2] holds B green/A red fixed.
        expect([V08_A19_PLACEMENT_CROSSOVER[0].candidateSide, V08_A19_PLACEMENT_CROSSOVER[3].candidateSide]).toEqual([
            "green",
            "red",
        ]);
        expect([V08_A19_PLACEMENT_CROSSOVER[1].candidateSide, V08_A19_PLACEMENT_CROSSOVER[2].candidateSide]).toEqual([
            "red",
            "green",
        ]);
    });

    test("targets NORMAL only and seals both combat arms to A19/H18", () => {
        expect(V08_A19_PLACEMENT_AB_MAP).toBe(1);
        const environment = buildV08A19PlacementAbEnvironment();
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_HORIZON: "18",
            SEARCH_SHORTLIST: "3",
            V08_A13_SEARCH: "0",
            LIVETWIN: "1",
            SIM_NO_ACTIONS: "1",
        });
        expect(environment.SEARCH_RESEARCH_HORIZON).toBeUndefined();
        expect(V08_A19_PLACEMENT_AB_ARMS.candidate.profile).toBe(V08_A19_H18_RANKED_PLACEMENT_PROFILE);
        expect(V08_A19_PLACEMENT_AB_ARMS.candidate.placementStrategyFactory).toBe(
            "createV08A19H18RankedPlacementStrategy",
        );
        expect(V08_A19_PLACEMENT_AB_ARMS.control.profile).toBe(V08_A19_H18_RANKED_PLACEMENT_PROFILE.derivesFrom);
        expect(V08_A19_PLACEMENT_AB_ARMS.control.placementStrategyFactory).toBe("plain StrategyV0_8");
        expect(V08_A19_PLACEMENT_AB_ARMS.candidate.profile.placementPolicy.policyId).toBe("a19-ranked-placement-v8");
        expect(V08_A19_PLACEMENT_AB_EXPLICIT_SOURCE_FILES).toContain(
            V08_A19_H18_RANKED_PLACEMENT_PROFILE.placementPolicy.implementationSource,
        );
        expect(V08_A19_PLACEMENT_AB_EXPLICIT_SOURCE_FILES).toContain("src/simulation/v0_8_a19_prod_f184_anchor.ts");
    });

    test("uses exposed physical orientations as the primary estimand", () => {
        const records = [
            record(0, ["win", "win", "loss", "win"], [true, false, false, false]),
            record(1, ["loss", "win", "loss", "loss"], [false, true, false, false]),
        ];
        const summary = summarizeV08A19PlacementAbRecords(records);

        expect(summary.overall).toMatchObject({ clusters: 2, games: 8, wins: 4, losses: 4 });
        expect(summary.eligible).toMatchObject({
            key: "eligible-physical-orientations",
            clusters: 2,
            orientationPairs: 2,
            games: 4,
            wins: 3,
            losses: 1,
            drawAwareScoreRate: 0.75,
            liftPp: 25,
        });
        expect(summary.eligible.standardErrorPp).toBeCloseTo(25, 10);
        expect(summary.noExposureNegativeControl).toMatchObject({
            clusters: 2,
            orientationPairs: 2,
            games: 4,
            drawAwareScoreRate: 0.25,
        });
        expect(summary.policyITT).toMatchObject({
            totalOrientationPairs: 4,
            eligibleOrientationPairs: 2,
            noExposureOrientationPairs: 2,
            exposureRate: 0.5,
            eligibleLiftPp: 25,
            scaledDeployWideLiftPp: 12.5,
        });
        expect(summary.confirmatoryInference).toMatchObject({
            eligibleOrientationPairs: 2,
            eligibleMatchupClusters: 2,
            clusterBootstrapIterations: 100_000,
            greenScoreRate: 0.5,
            redScoreRate: 1,
        });
        expect(summary.eligibleMaps).toHaveLength(1);
        expect(summary.eligibleMaps[0].key).toBe(String(V08_A19_PLACEMENT_AB_MAP));
    });

    test("keeps the repeated production anchor outside broad inference and gates it separately", () => {
        const broad = [
            record(0, ["win", "win", "loss", "win"], [true, false, false, false]),
            record(1, ["loss", "win", "loss", "loss"], [false, true, false, false]),
        ];
        const winningAnchor = record(
            2,
            ["win", "win", "win", "win"],
            [true, true, true, true],
            V08_A19_PROD_F184_COHORT,
        );
        const losingAnchor = record(
            2,
            ["loss", "loss", "loss", "loss"],
            [true, true, true, true],
            V08_A19_PROD_F184_COHORT,
        );
        const winning = summarizeV08A19PlacementAbRecords([...broad, winningAnchor]);
        const losing = summarizeV08A19PlacementAbRecords([...broad, losingAnchor]);

        expect(winning.eligible).toEqual(losing.eligible);
        expect(winning.noExposureNegativeControl).toEqual(losing.noExposureNegativeControl);
        expect(winning.policyITT).toEqual(losing.policyITT);
        expect(winning.confirmatoryInference.clusterBootstrapCiLow).toBe(
            losing.confirmatoryInference.clusterBootstrapCiLow,
        );
        expect(winning.confirmatoryInference.exactClusterSignFlipTwoSidedP).toBe(
            losing.confirmatoryInference.exactClusterSignFlipTwoSidedP,
        );
        expect(winning.confirmatoryInference.leaveOneCohortOutScoreRates).toEqual(
            losing.confirmatoryInference.leaveOneCohortOutScoreRates,
        );
        expect(winning.confirmatoryInference.rankedDraftScoreRate).toBe(
            losing.confirmatoryInference.rankedDraftScoreRate,
        );
        expect(winning.confirmatoryInference.prodRankedF184ScoreRate).toBe(1);
        expect(losing.confirmatoryInference.prodRankedF184ScoreRate).toBe(0);

        const winningGates = evaluateV08A19PlacementValidationGates(
            winning,
            { stage: "validation", clustersPerCohort: 1 },
            true,
        );
        expect(winningGates).toMatchObject({
            prodRankedF184ExposureIntegrity: true,
            prodRankedF184NoHarm: true,
            prodRankedF184BothSeats: true,
            prodRankedF184BothRosters: true,
        });
        expect(
            evaluateV08A19PlacementValidationGates(losing, { stage: "validation", clustersPerCohort: 1 }, true)
                .prodRankedF184NoHarm,
        ).toBe(false);
        expect(
            evaluateV08A19PlacementValidationGates(
                summarizeV08A19PlacementAbRecords(broad),
                { stage: "validation", clustersPerCohort: 1 },
                true,
            ),
        ).toMatchObject({
            prodRankedF184ExposureIntegrity: false,
            prodRankedF184NoHarm: false,
            prodRankedF184BothSeats: false,
            prodRankedF184BothRosters: false,
        });

        const partialAnchor = summarizeV08A19PlacementAbRecords([
            ...broad,
            record(2, ["win", "win", "win", "win"], [true, false, true, true], V08_A19_PROD_F184_COHORT),
        ]);
        expect(
            evaluateV08A19PlacementValidationGates(partialAnchor, { stage: "validation", clustersPerCohort: 1 }, true)
                .prodRankedF184ExposureIntegrity,
        ).toBe(false);

        const rosterMaskedHarm = summarizeV08A19PlacementAbRecords([
            ...broad,
            record(2, ["loss", "loss", "win", "win"], [true, true, true, true], V08_A19_PROD_F184_COHORT),
        ]);
        expect(rosterMaskedHarm.confirmatoryInference).toMatchObject({
            prodRankedF184ScoreRate: 0.5,
            prodRankedF184GreenScoreRate: 0.5,
            prodRankedF184RedScoreRate: 0.5,
            prodRankedF184RosterAScoreRate: 0,
            prodRankedF184RosterBScoreRate: 1,
        });
        expect(
            evaluateV08A19PlacementValidationGates(
                rosterMaskedHarm,
                { stage: "validation", clustersPerCohort: 1 },
                true,
            ),
        ).toMatchObject({
            prodRankedF184NoHarm: true,
            prodRankedF184BothSeats: true,
            prodRankedF184BothRosters: false,
        });
    });

    test("allows seat-specific exposure while enforcing every v8 treatment diagnostic", () => {
        const baseSeed = V08_A19_PLACEMENT_AB_SEEDS.smoke;
        const records = Array.from({ length: 3 }, (_, cluster) => {
            const value = record(cluster, ["win", "loss", "draw", "win"], [true, false, true, false]);
            value.setupSeed = hashSimulationParts("ai-meta-setup", baseSeed, value.cohort, cluster);
            value.combatSeed = hashSimulationParts("ai-meta-combat", baseSeed, value.cohort, cluster);
            return value;
        });
        const quality = validateV08A19PlacementAbRecords(
            records,
            { clustersPerCohort: 3, baseSeed, cohorts: ["uniform-mixed"] },
            3,
            true,
        );
        expect(quality).toMatchObject({
            malformedClusters: 0,
            treatmentApplied: 6,
            placementChanged: 6,
        });

        const invalidPredicate = structuredClone(records);
        invalidPredicate[0].games[0].correctedPhysicalUnits = 0;
        expect(
            validateV08A19PlacementAbRecords(
                invalidPredicate,
                { clustersPerCohort: 3, baseSeed, cohorts: ["uniform-mixed"] },
                3,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(0);

        const unchangedTreatment = structuredClone(records);
        unchangedTreatment[0].games[0].placementChanged = false;
        unchangedTreatment[0].games[0].selectedPlacementFingerprint =
            unchangedTreatment[0].games[0].incumbentPlacementFingerprint;
        expect(
            validateV08A19PlacementAbRecords(
                unchangedTreatment,
                { clustersPerCohort: 3, baseSeed, cohorts: ["uniform-mixed"] },
                3,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(0);

        const impossibleCounters = structuredClone(records);
        impossibleCounters[0].games[0].correctedForwardPhysicals = 2;
        expect(
            validateV08A19PlacementAbRecords(
                impossibleCounters,
                { clustersPerCohort: 3, baseSeed, cohorts: ["uniform-mixed"] },
                3,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(0);

        const wrongMap = structuredClone(records);
        wrongMap[0].map = 3;
        expect(
            validateV08A19PlacementAbRecords(
                wrongMap,
                { clustersPerCohort: 3, baseSeed, cohorts: ["uniform-mixed"] },
                3,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(0);
    });

    test("wires the real decorator diagnostics through a NORMAL cluster", () => {
        const environment = {
            ...buildV08A19PlacementAbEnvironment(),
            V07_SEARCH: "0",
            V08_A13_SEARCH: "0",
        };
        const cluster = withScopedAIEnvironment(environment, () =>
            playV08A19PlacementAbCluster(
                {
                    cohort: "ranged-heavy",
                    clustersPerCohort: 3,
                    baseSeed: V08_A19_PLACEMENT_AB_SEEDS.smoke,
                    maxLaps: 60,
                },
                0,
            ),
        );
        expect(cluster.map).toBe(V08_A19_PLACEMENT_AB_MAP);
        expect(cluster.games).toHaveLength(4);
        for (const game of cluster.games) {
            expect(game.incumbentPlacementFingerprint.length).toBeGreaterThan(0);
            expect(game.selectedPlacementFingerprint.length).toBeGreaterThan(0);
            expect(game.treatmentApplied).toBe(game.fallbackReason === null);
            expect(game.horizontalDisplacement).toBeGreaterThanOrEqual(0);
            expect(game.placementChanged).toBe(
                game.incumbentPlacementFingerprint !== game.selectedPlacementFingerprint,
            );
            if (game.treatmentApplied) {
                expect(game.correctedPhysicalUnits).toBeGreaterThanOrEqual(1);
                expect(game.correctedForwardPhysicals + game.correctedGroundScreens).toBeGreaterThanOrEqual(1);
            }
        }
    });

    test("replays the exact production anchor with full exposure and rejects fixture drift", () => {
        const environment = {
            ...buildV08A19PlacementAbEnvironment(),
            V07_SEARCH: "0",
            V08_A13_SEARCH: "0",
        };
        const cluster = withScopedAIEnvironment(environment, () =>
            playV08A19PlacementAbCluster(
                {
                    cohort: V08_A19_PROD_F184_COHORT,
                    clustersPerCohort: 1,
                    baseSeed: V08_A19_PLACEMENT_AB_SEEDS.smoke,
                    maxLaps: 60,
                },
                0,
            ),
        );
        expect(cluster.productionAnchor).toEqual(V08_A19_PROD_F184_RECORD_BINDING);
        expect(cluster.games.every((game) => game.treatmentApplied && game.placementChanged)).toBe(true);
        expect(
            validateV08A19PlacementAbRecords(
                [cluster],
                {
                    clustersPerCohort: 1,
                    baseSeed: V08_A19_PLACEMENT_AB_SEEDS.smoke,
                    cohorts: [V08_A19_PROD_F184_COHORT],
                },
                1,
                true,
            ).malformedClusters,
        ).toBe(0);

        const tampered = structuredClone(cluster);
        (tampered.productionAnchor as { sha256: string }).sha256 = "fixture-drift";
        expect(
            validateV08A19PlacementAbRecords(
                [tampered],
                {
                    clustersPerCohort: 1,
                    baseSeed: V08_A19_PLACEMENT_AB_SEEDS.smoke,
                    cohorts: [V08_A19_PROD_F184_COHORT],
                },
                1,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(0);
    });
});

function record(
    cluster: number,
    results: readonly IV08A19PlacementAbGameOutcome["candidateResult"][],
    treatments: readonly boolean[],
    cohort: V08A19PlacementAbCohort = "uniform-mixed",
): IV08A19PlacementAbClusterRecord {
    const games = V08_A19_PLACEMENT_CROSSOVER.map((planned, index) => {
        const candidateResult = results[index];
        const winner =
            candidateResult === "draw"
                ? "draw"
                : candidateResult === "win"
                  ? planned.candidateSide
                  : planned.candidateSide === "green"
                    ? "red"
                    : "green";
        const treatmentApplied = treatments[index] ?? false;
        return {
            ...planned,
            winner,
            candidateResult,
            candidateScore: candidateResult === "win" ? 1 : candidateResult === "draw" ? 0.5 : 0,
            laps: 12,
            endReason: "elimination",
            armageddonDecided: false,
            rejectedCandidate: 0,
            rejectedControl: 0,
            candidateHpMargin: candidateResult === "win" ? 1 : -1,
            candidateSurvivorMargin: candidateResult === "win" ? 1 : -1,
            candidateRosterSignature: planned.candidateRoster,
            controlRosterSignature: planned.controlRoster,
            candidateArmyFingerprint: planned.candidateRoster,
            controlArmyFingerprint: planned.controlRoster,
            setupFingerprint: `setup-${planned.assignment}`,
            treatmentApplied,
            placementChanged: treatmentApplied,
            horizontalDisplacement: 0,
            correctedPhysicalUnits: treatmentApplied ? 1 : 0,
            correctedForwardPhysicals: treatmentApplied ? 1 : 0,
            correctedGroundScreens: 0,
            nativeSpellbookBackliners: treatmentApplied ? 1 : 0,
            fallbackReason: treatmentApplied ? null : "opponent-unknown-or-not-double-flyer",
            incumbentPlacementFingerprint: `incumbent-${planned.candidateRoster}-${index}`,
            selectedPlacementFingerprint: treatmentApplied
                ? `selected-${planned.candidateRoster}-${index}`
                : `incumbent-${planned.candidateRoster}-${index}`,
        } satisfies IV08A19PlacementAbGameOutcome;
    }) as IV08A19PlacementAbClusterRecord["games"];
    return {
        schema: V08_A19_PLACEMENT_AB_SCHEMA,
        cohort,
        productionAnchor: cohort === V08_A19_PROD_F184_COHORT ? V08_A19_PROD_F184_RECORD_BINDING : null,
        cluster,
        setupSeed: cluster + 1,
        combatSeed: cluster + 2,
        map: V08_A19_PLACEMENT_AB_MAP,
        games,
    };
}
