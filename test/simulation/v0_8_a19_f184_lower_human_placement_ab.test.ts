import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE } from "../../src/ai/versions/v0_8_a19_h18_f184_lower_human_placement_profile";
import type { IV08A19F184LowerHumanPlacementAudit } from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import { setupAugmentsForPlan } from "../../src/ai/setup/setup_ship";
import type { IAiMetaArmy } from "../../src/simulation/ai_meta_cohorts_core";
import type { Side } from "../../src/simulation/battle_engine";
import { materializeReplayAbSplits } from "../../src/simulation/ranked_replay_tactics_ab_core";
import {
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_POLICY_BINDING_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_PROFILE_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SOURCE_FILES,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_TIMING,
    buildV08A19F184LowerHumanPlacementAbEnvironment,
    causalV08A19F184LowerHumanPlacementEffects,
    completeV08A19F184LowerHumanPlacementAbQuality,
    evaluateV08A19F184LowerHumanPlacementAbGates,
    expectedV08A19F184CanonicalPlacement,
    fingerprintV08A19F184LowerHumanPlacementArmy,
    fingerprintV08A19F184LowerHumanPlacementSetup,
    inspectV08A19F184LowerHumanPlacementPinnedImplementationBytes,
    parseV08A19F184LowerHumanPlacementAbOptions,
    planV08A19F184LowerHumanPlacementPhysicalOrder,
    playV08A19F184LowerHumanPlacementAbCluster,
    runV08A19F184LowerHumanPlacementWorkerRequestInFreshIsolate,
    summarizeV08A19F184LowerHumanPlacementAbRecords,
    v08A19F184LeftHumanPlacementEnvironmentSha256,
    validateV08A19F184LowerHumanPlacementAbRecords,
    type IV08A19F184LowerHumanPlacementAbClusterRecord,
    type IV08A19F184LowerHumanPlacementAbGameOutcome,
    type IV08A19F184LowerHumanPlacementAbScheduleEntry,
    type V08A19F184LowerHumanPlacementAbRoster,
} from "../../src/simulation/v0_8_a19_f184_lower_human_placement_ab";
import { prepareV08A19ProdF184Pair, V08_A19_PROD_F184_ANCHOR } from "../../src/simulation/v0_8_a19_prod_f184_anchor";

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const scoreForSide = (winner: Side | "draw", side: Side): number => (winner === "draw" ? 0.5 : winner === side ? 1 : 0);

const scoresFor = (
    winner: Side | "draw",
    scheduled: IV08A19F184LowerHumanPlacementAbScheduleEntry,
): Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, number>> =>
    ({
        [scheduled.greenRoster]: scoreForSide(winner, "green"),
        [scheduled.redRoster]: scoreForSide(winner, "red"),
    }) as Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, number>>;

const openingId = (roster: V08A19F184LowerHumanPlacementAbRoster) =>
    roster === "a" ? ("prod-f184-lower-roster" as const) : ("prod-f184-upper-roster" as const);

const validAudit = (roster: V08A19F184LowerHumanPlacementAbRoster): IV08A19F184LowerHumanPlacementAudit => ({
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
    armies: Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, IAiMetaArmy>>,
    roster: V08A19F184LowerHumanPlacementAbRoster,
): IAiMetaArmy => armies[roster];

const record = (
    cluster: number,
    winners: readonly [Side | "draw", Side | "draw", Side | "draw", Side | "draw"],
    baseSeed = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke,
): IV08A19F184LowerHumanPlacementAbClusterRecord => {
    const prepared = prepareV08A19ProdF184Pair(baseSeed, cluster);
    const armies = { a: prepared.armyA, b: prepared.armyB } as const;
    const games = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map((scheduled, index) => {
        const winner = winners[index];
        return {
            scheduleId: scheduled.id,
            greenRoster: scheduled.greenRoster,
            redRoster: scheduled.redRoster,
            treatedRoster: scheduled.treatedRoster,
            treatedSide: scheduled.treatedSide,
            cell: scheduled.cell,
            winner,
            scoreByRoster: scoresFor(winner, scheduled),
            laps: 5,
            endReason: "elimination",
            armageddonDecided: false,
            rejectedGreen: 0,
            rejectedRed: 0,
            setupFingerprint: fingerprintV08A19F184LowerHumanPlacementSetup(
                armyFor(armies, scheduled.greenRoster),
                armyFor(armies, scheduled.redRoster),
                V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
            ),
            candidateAudit: scheduled.treatedRoster === null ? null : validAudit(scheduled.treatedRoster),
            candidateCanonicalPlacement:
                scheduled.treatedRoster === null ? null : expectedV08A19F184CanonicalPlacement(scheduled.treatedRoster),
        } satisfies IV08A19F184LowerHumanPlacementAbGameOutcome;
    }) as unknown as IV08A19F184LowerHumanPlacementAbClusterRecord["games"];
    const physicalExecutionOrder = planV08A19F184LowerHumanPlacementPhysicalOrder({ baseSeed }, cluster);
    return {
        schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA,
        productionAnchor: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING,
        candidateIdentity: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY,
        cluster,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
        armyFingerprints: {
            a: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyA),
            b: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyB),
        },
        physicalExecutionOrder,
        isolateIds: Object.fromEntries(
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map(({ id }) => [id, `fixture-${cluster}-${id}`]),
        ) as IV08A19F184LowerHumanPlacementAbClusterRecord["isolateIds"],
        games,
    };
};

const NO_EFFECT_A_ALWAYS_WINS = ["green", "green", "red", "red"] as const;
const POSITIVE_DRAW_BASELINES = ["draw", "green", "draw", "green"] as const;

describe("v0.8+A19 f184 LOWER-only causal placement A/B", () => {
    test("pins the v15 stage geometry, fresh seeds, and deterministic A19/H18 efficacy environment", () => {
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA).toBe(
            "hoc.v0_8_a19_f184_lower_human_placement_deterministic_causal_ab.v15",
        );
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE).toBe(4);
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER).toBe(4);
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE).toEqual({
            smoke: 8,
            development: 360,
            validation: 1_440,
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS).toEqual({
            smoke: 76_047_795,
            development: 3_970_129_719,
            validation: 2_821_051_359,
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED).toBe(1_758_619_397);
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS).toBe(100_000);
        expect(
            new Set([
                ...Object.values(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS),
                V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED,
            ]).size,
        ).toBe(4);
        expect(
            [
                ...Object.values(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS),
                V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED,
            ].some((seed) => [1_317_198_692, 1_738_024_980, 919_928_719, 2_526_508_590].includes(seed)),
        ).toBe(false);
        expect(buildV08A19F184LowerHumanPlacementAbEnvironment()).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_HORIZON: "18",
            SEARCH_SHORTLIST: "3",
            V08_A13_SEARCH: "0",
            LIVETWIN: "1",
            SIM_NO_ACTIONS: "1",
            SEARCH_DECISION_DEADLINE_MS: "",
            SEARCH_CIRCUIT_BREAKER_MS: "",
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_TIMING).toEqual({
            estimand: "deterministic-policy-efficacy",
            decisionDeadlineMs: null,
            circuitBreakerMs: null,
            workerIsolation: "fresh-one-shot-worker-per-scheduled-game",
            physicalOrder: "balanced-four-position-rotation-independent-of-logical-schedule",
        });
    });

    test("binds the fixture, implementation, policy, profile, and explicit source set", () => {
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING).toEqual(
            V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy.productionFixture,
        );
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_PROFILE_SHA256).toBe(
            sha256(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE),
        );
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_POLICY_BINDING_SHA256).toBe(
            sha256(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy),
        );
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY).toMatchObject({
            candidateId: "a19-h18-prod-f184-opening-lower-only-v1-research",
            implementationSha256: "25a195624d401fdd429722bdb209e0aff7b274576d5392c5944130cb1c94e37c",
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SOURCE_FILES).toContain(
            "src/simulation/v0_8_a19_f184_lower_human_placement_ab_worker.ts",
        );
        const implementationBytes = inspectV08A19F184LowerHumanPlacementPinnedImplementationBytes();
        expect(implementationBytes.wrapper.actualSha256).toBe(implementationBytes.wrapper.expectedSha256);
        expect(implementationBytes.upstream.actualSha256).toBe(implementationBytes.upstream.expectedSha256);
    });

    test("parses only fixed stages and concurrency twelve", () => {
        expect(parseV08A19F184LowerHumanPlacementAbOptions(["--output", "tmp/lower-smoke"])).toMatchObject({
            stage: "smoke",
            clusters: 8,
            baseSeed: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke,
            concurrency: 12,
            maxLaps: 60,
        });
        expect(
            parseV08A19F184LowerHumanPlacementAbOptions(["--stage", "validation", "--output", "tmp/lower-validation"]),
        ).toMatchObject({ stage: "validation", clusters: 1_440 });
        expect(() => parseV08A19F184LowerHumanPlacementAbOptions([])).toThrow("--output is required");
        expect(() =>
            parseV08A19F184LowerHumanPlacementAbOptions(["--output", "tmp/out", "--concurrency", "11"]),
        ).toThrow("requires concurrency 12");
    });

    test("runs exactly two same-orientation LOWER causal pairs", () => {
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE).toEqual([
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
        ]);
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS).toEqual(["a-green", "b-green"]);
        expect(
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.filter(({ treatedSide }) => treatedSide === "green"),
        ).toHaveLength(2);
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map(({ treatedSide }) => treatedSide)).not.toContain(
            "red" as Side,
        );
    });

    test("keeps the recorded f184 setups inside the benchmark's unsplit treatment lifecycle", () => {
        for (const setup of [V08_A19_PROD_F184_ANCHOR.left, V08_A19_PROD_F184_ANCHOR.right]) {
            const split = materializeReplayAbSplits(
                setup.roster,
                setup.creatureIds,
                setupAugmentsForPlan(setup.augmentPlan),
                setup.synergies,
            );
            expect(split.splitRoles).toEqual([]);
            expect(split.roster).toEqual(setup.roster);
        }
    });

    test("balances physical execution independently of logical record order across four clusters", () => {
        const ids = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map(({ id }) => id);
        const positions = new Map(ids.map((id) => [id, new Set<number>()]));
        for (let cluster = 0; cluster < V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER; cluster += 1) {
            const order = planV08A19F184LowerHumanPlacementPhysicalOrder(
                { baseSeed: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke },
                cluster,
            );
            expect(order).toHaveLength(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER);
            expect(new Set(order).size).toBe(order.length);
            order.forEach((id, position) => positions.get(id)!.add(position));
        }
        for (const id of ids) {
            expect([...positions.get(id)!].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
        }
        expect(
            planV08A19F184LowerHumanPlacementPhysicalOrder(
                { baseSeed: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke },
                0,
            ),
        ).not.toEqual(ids);
    });

    test("assembles logical clusters at the root from four distinct game isolates", async () => {
        const baseSeed = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke;
        const fixture = record(0, POSITIVE_DRAW_BASELINES, baseSeed);
        const byId = new Map(fixture.games.map((game) => [game.scheduleId, game]));
        const requests: string[] = [];
        const assembled = await playV08A19F184LowerHumanPlacementAbCluster(
            { clusters: 8, baseSeed, maxLaps: 60 },
            0,
            async (request) => {
                requests.push(request.executionId);
                return {
                    type: "result",
                    executionId: request.executionId,
                    isolateId: `root-assembly-${request.executionId}`,
                    outcome: byId.get(request.executionId)!,
                };
            },
        );
        expect(requests).toEqual([...assembled.physicalExecutionOrder]);
        expect(assembled.games.map(({ scheduleId }) => scheduleId)).toEqual(
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map(({ id }) => id),
        );
        expect(new Set(Object.values(assembled.isolateIds)).size).toBe(4);
    });

    test("creates a genuinely fresh one-shot worker for every efficacy probe", async () => {
        const first = await runV08A19F184LowerHumanPlacementWorkerRequestInFreshIsolate({
            type: "probe",
            probeId: "first",
        });
        const second = await runV08A19F184LowerHumanPlacementWorkerRequestInFreshIsolate({
            type: "probe",
            probeId: "second",
        });
        expect(first.type).toBe("probe");
        expect(second.type).toBe("probe");
        if (first.type !== "probe" || second.type !== "probe") throw new Error("fresh-isolate probe drifted");
        expect(first.isolateId).not.toBe(second.isolateId);
        expect(first.environmentSha256).toBe(v08A19F184LeftHumanPlacementEnvironmentSha256());
        expect(second.environmentSha256).toBe(first.environmentSha256);
    });

    test("subtracts each same-orientation control and cancels raw roster strength", () => {
        const fixture = record(0, NO_EFFECT_A_ALWAYS_WINS);
        expect(Object.values(causalV08A19F184LowerHumanPlacementEffects(fixture)).map(({ delta }) => delta)).toEqual([
            0, 0,
        ]);
        const summary = summarizeV08A19F184LowerHumanPlacementAbRecords([fixture], 50);
        expect(summary.primary.meanDelta).toBe(0);
        expect(summary.rosters.a.meanDelta).toBe(0);
        expect(summary.rosters.b.meanDelta).toBe(0);
    });

    test("scores draws as one half and clusters the two LOWER effects", () => {
        const records = [record(0, POSITIVE_DRAW_BASELINES), record(1, POSITIVE_DRAW_BASELINES)];
        const effects = causalV08A19F184LowerHumanPlacementEffects(records[0]);
        expect(effects["a-green"]).toMatchObject({ baselineScore: 0.5, candidateScore: 1, delta: 0.5 });
        expect(effects["b-green"]).toMatchObject({ baselineScore: 0.5, candidateScore: 1, delta: 0.5 });
        const summary = summarizeV08A19F184LowerHumanPlacementAbRecords(records, 200);
        expect(summary).toMatchObject({
            estimand: "mean direct draw-aware LOWER score delta across the two exact production rosters",
            clusters: 2,
            games: 8,
            primary: {
                meanDelta: 0.5,
                clusteredStandardError: 0,
                normal95: { low: 0.5, high: 0.5 },
                bootstrap95: { low: 0.5, high: 0.5 },
                outcomeChanges: 4,
            },
        });
        expect(Object.values(summary.rosters).every(({ meanDelta }) => meanDelta === 0.5)).toBe(true);
    });

    test("strictly validates lower audits, exact coordinates, setup, and identity", () => {
        const baseSeed = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS.smoke;
        const valid = record(0, POSITIVE_DRAW_BASELINES, baseSeed);
        const quality = validateV08A19F184LowerHumanPlacementAbRecords([valid], { clusters: 1, baseSeed }, 1, true);
        expect(quality).toMatchObject({
            expectedClusters: 1,
            clusters: 1,
            games: 4,
            malformedClusters: 0,
            auditMismatches: 0,
            coordinateMismatches: 0,
            treatmentGames: 2,
            validTreatmentAudits: 2,
            sourceUnchanged: true,
            implementationBytesVerified: true,
        });
        expect(completeV08A19F184LowerHumanPlacementAbQuality(quality)).toBe(true);

        const badCoordinate = structuredClone(valid);
        (badCoordinate.games[1].candidateCanonicalPlacement![0] as { x: number }).x += 1;
        expect(
            validateV08A19F184LowerHumanPlacementAbRecords([badCoordinate], { clusters: 1, baseSeed }, 1, true)
                .coordinateMismatches,
        ).toBe(1);

        const badIdentity = structuredClone(valid);
        (badIdentity.candidateIdentity as { profileSha256: string }).profileSha256 = "wrong";
        expect(
            validateV08A19F184LowerHumanPlacementAbRecords([badIdentity], { clusters: 1, baseSeed }, 1, true)
                .malformedClusters,
        ).toBeGreaterThan(0);
    });

    test("promotion gates use paired deltas, two roster point wins, and Bonferroni safety", () => {
        const base = summarizeV08A19F184LowerHumanPlacementAbRecords(
            [record(0, POSITIVE_DRAW_BASELINES), record(1, POSITIVE_DRAW_BASELINES)],
            100,
        );
        const validationShaped = {
            ...base,
            clusters: 1_440,
            games: 1_440 * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
            bootstrapIterations: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
        };
        const gates = evaluateV08A19F184LowerHumanPlacementAbGates(
            validationShaped,
            { stage: "validation", clusters: 1_440 },
            true,
        );
        expect(Object.values(gates).every(Boolean)).toBe(true);
        expect(Object.keys(gates).some((key) => /raw|win.?rate|seat/i.test(key))).toBe(false);

        const harmful = structuredClone(validationShaped);
        (harmful.rosters.b as { meanDelta: number }).meanDelta = -0.001;
        expect(
            evaluateV08A19F184LowerHumanPlacementAbGates(harmful, { stage: "validation", clusters: 1_440 }, true)
                .bothRostersPositive,
        ).toBe(false);

        const unsafe = structuredClone(validationShaped);
        (unsafe.rosters.a as { bootstrapBonferroniLower: number }).bootstrapBonferroniLower = -0.011;
        expect(
            evaluateV08A19F184LowerHumanPlacementAbGates(unsafe, { stage: "validation", clusters: 1_440 }, true)
                .bothRostersBonferroniNoninferior,
        ).toBe(false);
    });
});
