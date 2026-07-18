import { describe, expect, test } from "bun:test";

import {
    LEAGUE_ROUND1_DRAFT_SPEC,
    parseDraftGenome,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import { parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { runRankedConditionalPickGame } from "../../src/simulation/measure_setup_conditional";
import {
    candidatesForLane,
    evaluateSetupPair,
    setupSearchLanes,
} from "../../src/simulation/optimizer/v0_7_setup_overnight";
import {
    augmentPlanCost,
    augmentPlanId,
    enumerateFullBudgetAugmentPlans,
    pairedSetupEstimate,
    pickTier2ForVariant,
    SETUP_LIVE_GRID_TYPES,
    setupCohort,
    setupDiagnosticTags,
    setupGuardPromotable,
    setupLiveGridType,
    setupPanelSeed,
    shippedAugmentPlan,
    shippedNonFightPolicy,
    type ISetupEvaluatedPair,
    type SetupLiveGridType,
} from "../../src/simulation/optimizer/v0_7_setup_overnight_core";

const C = PBTypes.CreatureVals;
const TRACE_SHA256 = "0".repeat(64);

describe("v0.7 setup overnight search core", () => {
    test("enumerates every legal full-budget plan including Movement and Placement", () => {
        const plans = enumerateFullBudgetAugmentPlans();
        expect(plans).toHaveLength(96);
        expect(new Set(plans.map(augmentPlanId)).size).toBe(plans.length);
        expect(plans.every((plan) => augmentPlanCost(plan) === 7)).toBe(true);
        expect(plans.some((plan) => plan.movement === 2)).toBe(true);
        expect(plans.some((plan) => plan.placement === 2)).toBe(true);
        expect(new Set(setupSearchLanes().map((lane) => lane.family))).toEqual(
            new Set(["augment", "tier2", "synergy", "placement-reveal"]),
        );
        const augmentLane = setupSearchLanes().find((lane) => lane.family === "augment")!;
        const augmentCandidates = candidatesForLane(augmentLane, shippedNonFightPolicy(), 0);
        expect(augmentCandidates).toHaveLength(96);
        expect(
            augmentCandidates.every(({ policy }) => policy.placementAugmentTiming === "setup-before-placement"),
        ).toBe(true);
        expect(augmentCandidates.some(({ policy }) => policy.augmentsByCohort[augmentLane.cohort!].placement > 0)).toBe(
            true,
        );
        const publicRosterLane = setupSearchLanes().find((lane) => lane.id === "placement/public-roster")!;
        const publicRosterCandidates = candidatesForLane(publicRosterLane, shippedNonFightPolicy(), 0);
        expect(publicRosterCandidates).toHaveLength(2);
        expect(publicRosterCandidates[0].control).toBe(true);
        expect(publicRosterCandidates[1].policy.placement).toBe("public-roster");
    });

    test("reproduces shipped conditional augments and classifies named risk surfaces", () => {
        expect(shippedAugmentPlan([C.ARBALESTER, C.ELF])).toEqual({
            placement: 0,
            armor: 3,
            might: 1,
            sniper: 3,
            movement: 0,
        });
        expect(shippedAugmentPlan([C.PEASANT, C.PEGASUS])).toEqual({
            placement: 0,
            armor: 3,
            might: 3,
            sniper: 1,
            movement: 0,
        });
        expect(setupCohort([C.SATYR, C.PEASANT])).toBe("mage");
        expect(setupCohort([C.ANGEL])).toBe("melee-magic");
        expect(setupCohort([C.PEASANT])).toBe("aura-heavy");
        expect(setupDiagnosticTags([C.ARBALESTER, C.SATYR, C.ANGEL, C.ANGEL])).toEqual([
            "aggregate",
            "ranged",
            "mage",
            "melee-magic",
            "aura-heavy",
        ]);
        expect(shippedNonFightPolicy().placementAugmentTiming).toBe("setup-before-placement");
    });

    test("keeps large flying AOE melee landings legal on the deterministic LAVA_CENTER rejection seed", () => {
        const pair = evaluateSetupPair(shippedNonFightPolicy(), 1_393_533_046);

        expect(pair.gridType).toBe(PBTypes.GridVals.LAVA_CENTER);
        expect(
            pair.games.map(({ candidateSide, candidateRejections, baselineRejections }) => ({
                candidateSide,
                candidateRejections,
                baselineRejections,
            })),
        ).toEqual([
            { candidateSide: "green", candidateRejections: 0, baselineRejections: 0 },
            { candidateSide: "red", candidateRejections: 0, baselineRejections: 0 },
        ]);
    });

    test("keeps train, selection, and untouched guard seed blocks disjoint", () => {
        const panels = ["train", "selection", "guard"] as const;
        const streams = panels.map((panel) =>
            Array.from({ length: 2_000 }, (_, index) => setupPanelSeed(87_001_710, panel, index)),
        );
        for (const stream of streams) expect(new Set(stream).size).toBe(stream.length);
        expect(new Set(streams.flat()).size).toBe(streams.flat().length);
        expect(setupPanelSeed(87_001_710, "guard", 42)).toBe(setupPanelSeed(87_001_710, "guard", 42));
        const liveMapCounts = new Map(SETUP_LIVE_GRID_TYPES.map((gridType) => [gridType, 0]));
        for (let index = 0; index < 4_096; index += 1) {
            const gridType = setupLiveGridType(setupPanelSeed(87_001_710, "guard", index));
            liveMapCounts.set(gridType, liveMapCounts.get(gridType)! + 1);
        }
        expect([...liveMapCounts.values()].every((count) => count >= 1_300)).toBe(true);
        expect(liveMapCounts.has(PBTypes.GridVals.WATER_CENTER as SetupLiveGridType)).toBe(false);
    });

    test("computes paired-cluster confidence and candidate-side rejection telemetry", () => {
        const pairs: ISetupEvaluatedPair[] = [
            {
                seed: 1,
                gridType: setupLiveGridType(1),
                games: [
                    {
                        candidateSide: "green",
                        candidateResult: "win",
                        candidateRejections: 1,
                        baselineRejections: 0,
                        laps: 10,
                        endReason: "elimination",
                        decidedByArmageddon: false,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate", "ranged"],
                    },
                    {
                        candidateSide: "red",
                        candidateResult: "win",
                        candidateRejections: 0,
                        baselineRejections: 1,
                        laps: 12,
                        endReason: "elimination",
                        decidedByArmageddon: false,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate"],
                    },
                ],
            },
            {
                seed: 2,
                gridType: setupLiveGridType(2),
                games: [
                    {
                        candidateSide: "green",
                        candidateResult: "loss",
                        candidateRejections: 0,
                        baselineRejections: 0,
                        laps: 20,
                        endReason: "elimination",
                        decidedByArmageddon: true,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate", "ranged"],
                    },
                    {
                        candidateSide: "red",
                        candidateResult: "draw",
                        candidateRejections: 0,
                        baselineRejections: 0,
                        laps: 60,
                        endReason: "turn_cap",
                        decidedByArmageddon: false,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate"],
                    },
                ],
            },
        ];
        const aggregate = pairedSetupEstimate(pairs);
        expect(aggregate).toMatchObject({
            wins: 2,
            losses: 1,
            draws: 1,
            candidateRejections: 1,
            baselineRejections: 1,
            avgLaps: 25.5,
            endReasons: { elimination: 3, turn_cap: 1 },
            armageddonDecided: 1,
            drawOrArmageddon: 2,
            drawOrArmageddonRate: 0.5,
        });
        expect(aggregate.clusteredSePp).not.toBeNull();
        expect(pairedSetupEstimate(pairs, "ranged")).toMatchObject({ games: 2, wins: 1, losses: 1, draws: 0 });
        expect(pairedSetupEstimate(pairs, "aggregate", setupLiveGridType(1))).toMatchObject({
            games: 2,
            wins: 2,
            losses: 0,
            draws: 0,
        });
        expect(() => pairedSetupEstimate([...pairs, pairs[0]])).toThrow("duplicate paired setup seed");
        expect(() => pairedSetupEstimate([{ ...pairs[0], gridType: PBTypes.GridVals.NORMAL }])).toThrow(
            "non-deterministic grid assignment",
        );
        expect(() =>
            pairedSetupEstimate([
                {
                    ...pairs[0],
                    games: [pairs[0].games[0], { ...pairs[0].games[1], candidateSide: "green" }],
                },
            ]),
        ).toThrow("must swap candidate sides");
    });

    test("fails named guard promotion closed on point, LCB, coverage, and rejection floors", () => {
        const estimate = pairedSetupEstimate(
            Array.from({ length: 120 }, (_, index): ISetupEvaluatedPair => ({
                seed: index,
                gridType: setupLiveGridType(index),
                games: [
                    {
                        candidateSide: "green",
                        candidateResult: "win",
                        candidateRejections: 0,
                        baselineRejections: 0,
                        laps: 10,
                        endReason: "elimination",
                        decidedByArmageddon: false,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate", "ranged", "mage", "melee-magic", "aura-heavy"],
                    },
                    {
                        candidateSide: "red",
                        candidateResult: index % 2 === 0 ? "win" : "loss",
                        candidateRejections: 0,
                        baselineRejections: 0,
                        laps: 10,
                        endReason: "elimination",
                        decidedByArmageddon: false,
                        traceSha256: TRACE_SHA256,
                        tags: ["aggregate", "ranged", "mage", "melee-magic", "aura-heavy"],
                    },
                ],
            })),
        );
        const diagnostics = {
            ranged: { ...estimate },
            mage: { ...estimate },
            "melee-magic": { ...estimate },
            "aura-heavy": { ...estimate },
        };
        const liveMapDiagnostics = Object.fromEntries(
            SETUP_LIVE_GRID_TYPES.map((gridType) => [gridType, { ...estimate, games: 1_000 }]),
        ) as Record<SetupLiveGridType, typeof estimate>;
        expect(
            setupGuardPromotable("setup-before-placement", estimate, diagnostics, liveMapDiagnostics, true, true, true),
        ).toBe(true);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                { ...diagnostics, mage: { ...estimate, decisiveWinRate: 0.494 } },
                liveMapDiagnostics,
                true,
                true,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                { ...diagnostics, mage: { ...estimate, confidence95LowGainPp: null } },
                liveMapDiagnostics,
                true,
                true,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                { ...diagnostics, mage: { ...estimate, candidateRejections: 1 } },
                liveMapDiagnostics,
                true,
                true,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                diagnostics,
                { ...liveMapDiagnostics, [PBTypes.GridVals.LAVA_CENTER]: { ...estimate, games: 999 } },
                true,
                true,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                diagnostics,
                liveMapDiagnostics,
                false,
                true,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                diagnostics,
                liveMapDiagnostics,
                true,
                false,
                true,
            ),
        ).toBe(false);
        expect(
            setupGuardPromotable(
                "setup-before-placement",
                estimate,
                diagnostics,
                liveMapDiagnostics,
                true,
                true,
                false,
            ),
        ).toBe(false);
        expect(setupGuardPromotable("current-live", estimate, diagnostics, liveMapDiagnostics, true, true, true)).toBe(
            false,
        );
    });

    test("applies a candidate Tier-2 ranking at the real five-creature ARTIFACT_2 phase", () => {
        const genome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
        const seen = new Map<number, number>();
        const result = runRankedConditionalPickGame(87_101_710, parseConditionalRules("all"), genome, {
            pickArtifactT2: (team, offered, ownCreatures) => {
                expect(ownCreatures).toHaveLength(5);
                expect(offered).toHaveLength(3);
                seen.set(team, offered[offered.length - 1]);
                return pickTier2ForVariant(offered, ownCreatures, `promote:${offered[offered.length - 1]}`);
            },
        });
        expect(result.lower.tier2Artifact).toBe(seen.get(PBTypes.TeamVals.LOWER));
        expect(result.upper.tier2Artifact).toBe(seen.get(PBTypes.TeamVals.UPPER));
    });
});
