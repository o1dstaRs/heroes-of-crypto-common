import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { creatureIdForName } from "../../src/simulation/draft";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import {
    allRankedReplayAbComponents,
    buildRankedReplayAbEnvironment,
    materializeReplayAbSplits,
    noRankedReplayAbComponents,
    parseRankedReplayAbComponents,
    rankedReplayAbEnvironmentSha256,
    rankedReplayCombatClusterEligible,
    playRankedReplayAbCluster,
    replayUtilitySplitGate,
    resolveRankedReplayAbPick,
    summarizeRankedReplayAbRecords,
    type IRankedReplayAbClusterRecord,
} from "../../src/simulation/ranked_replay_tactics_ab_core";
import {
    parseRankedReplayAbRunnerOptions,
    validateRankedReplayAbRecords,
} from "../../src/simulation/measure_ranked_replay_tactics_ab";

describe("ranked replay tactics full-pipeline A/B", () => {
    it("parses explicit component arms and seals equal a13 search on both aliases", () => {
        expect(parseRankedReplayAbComponents("draft,splits")).toEqual({
            draft: true,
            setup: false,
            splits: true,
            combat: false,
            wait: false,
        });
        expect(() => parseRankedReplayAbComponents("draft,unknown")).toThrow("Unknown replay A/B component");

        const environment = buildRankedReplayAbEnvironment(allRankedReplayAbComponents());
        expect(environment.SEARCH_VERSIONS).toBe("v0.8,v0.8s");
        expect(environment.SEARCH_HORIZON).toBe("12");
        expect(environment.V08_RANGED_POSITION_VERSIONS).toBe("v0.8,v0.8s");
        expect(environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_VERSIONS).toBe("");
        expect(environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON).toBe("0");
        expect(environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_GRIDS).toBe("");
        expect(environment.SEARCH_V08_RAPID_CHARGE_RESERVATION).toBe("0");
        expect(environment.SEARCH_V08_RAPID_CHARGE_RESERVATION_VERSIONS).toBe("");
        expect(environment.SEARCH_RESEARCH_HORIZON).toBe("18");
        expect(environment.SEARCH_RESEARCH_HORIZON_VERSIONS).toBe("v0.8");
        expect(environment.SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES).toBeUndefined();
        expect(environment.SEARCH_RESEARCH_SHORTLIST).toBeUndefined();
        expect(environment.SEARCH_RESEARCH_SHORTLIST_VERSIONS).toBeUndefined();
        expect(environment.V08_RANKED_REPLAY_TACTICS_VERSIONS).toBe("");
        expect(environment.V07_WAIT_WEIGHTS_V2_VERSIONS).toBe("v0.8");
        expect(environment.V07_WAIT_WEIGHTS_V2_GRIDS).toBe(String(PBTypes.GridVals.NORMAL));
        expect(environment.V07_WAIT_WEIGHTS_V2_MAX_INITIAL_RANGED).toBe("1");

        const control = buildRankedReplayAbEnvironment(noRankedReplayAbComponents());
        expect(control.SEARCH_VERSIONS).toBe("v0.8,v0.8s");
        expect(control.SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON).toBe("0");
        expect(control.SEARCH_V08_RANKED_REPLAY_TIEBREAK_GRIDS).toBe("");
        expect(control.SEARCH_V08_RAPID_CHARGE_RESERVATION).toBe("0");
        expect(control.SEARCH_V08_RAPID_CHARGE_RESERVATION_VERSIONS).toBe("");
        expect(control.SEARCH_RESEARCH_HORIZON).toBeUndefined();
        expect(control.SEARCH_RESEARCH_HORIZON_VERSIONS).toBeUndefined();
        expect(control.SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES).toBeUndefined();
        expect(control.SEARCH_RESEARCH_SHORTLIST).toBeUndefined();
        expect(control.SEARCH_RESEARCH_SHORTLIST_VERSIONS).toBeUndefined();
        expect(control.V07_WAIT_WEIGHTS_V2).toBe("");
        expect(control.V07_WAIT_WEIGHTS_V2_VERSIONS).toBe("");
        expect(control.V07_WAIT_WEIGHTS_V2_GRIDS).toBe("");
        expect(control.V07_WAIT_WEIGHTS_V2_MAX_INITIAL_RANGED).toBe("");

        const rangedBattery = buildRankedReplayAbEnvironment(allRankedReplayAbComponents(), 0.002, "ranged-battery");
        expect(rangedBattery.SEARCH_HORIZON).toBe("12");
        expect(rangedBattery.SEARCH_RESEARCH_HORIZON).toBe("18");
        expect(rangedBattery.SEARCH_RESEARCH_HORIZON_VERSIONS).toBe("v0.8");
        expect(rangedBattery.SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES).toBe("2");
        expect(rankedReplayAbEnvironmentSha256(allRankedReplayAbComponents(), 0.002, "ranged-battery")).not.toBe(
            rankedReplayAbEnvironmentSha256(allRankedReplayAbComponents(), 0.002, "all"),
        );

        const shortlist3 = buildRankedReplayAbEnvironment(allRankedReplayAbComponents(), 0.002, "all", "shortlist-3");
        expect(shortlist3.SEARCH_HORIZON).toBe("12");
        expect(shortlist3.SEARCH_SHORTLIST).toBe("2");
        expect(shortlist3.SEARCH_RESEARCH_SHORTLIST).toBe("3");
        expect(shortlist3.SEARCH_RESEARCH_SHORTLIST_VERSIONS).toBe("v0.8");
        expect(shortlist3.SEARCH_RESEARCH_HORIZON).toBeUndefined();
        expect(() =>
            buildRankedReplayAbEnvironment(allRankedReplayAbComponents(), 0.002, "ranged-battery", "shortlist-3"),
        ).toThrow("cannot use ranged-battery scope");
        expect(rankedReplayAbEnvironmentSha256(allRankedReplayAbComponents(), 0.002, "all", "shortlist-3")).not.toBe(
            rankedReplayAbEnvironmentSha256(allRankedReplayAbComponents(), 0.002, "all", "horizon-18"),
        );

        const combatOnly = { ...noRankedReplayAbComponents(), combat: true };
        expect(rankedReplayCombatClusterEligible(combatOnly, "ranged-battery", ["ordinary", "ordinary"])).toBe(false);
        expect(rankedReplayCombatClusterEligible(combatOnly, "ranged-battery", ["ranged-battery", "ordinary"])).toBe(
            true,
        );
        expect(rankedReplayCombatClusterEligible(combatOnly, "all", ["ordinary", "ordinary"])).toBe(true);
        expect(
            rankedReplayCombatClusterEligible(noRankedReplayAbComponents(), "ranged-battery", ["ranged-battery"]),
        ).toBe(false);
    });

    it("changes the assigned candidate policy while preserving the opponent's simultaneous bundle decision", () => {
        const control = noRankedReplayAbComponents();
        const candidate = { ...control, draft: true };
        const baseline = resolveRankedReplayAbPick(1, PBTypes.GridVals.NORMAL, PBTypes.TeamVals.LOWER, control);
        const replay = resolveRankedReplayAbPick(1, PBTypes.GridVals.NORMAL, PBTypes.TeamVals.LOWER, candidate);

        expect(replay.lower.creatures).not.toEqual(baseline.lower.creatures);
        expect(replay.upper.selectedBundleIndex).toBe(baseline.upper.selectedBundleIndex);
        expect(replay.upper.tier1Artifact).toBe(baseline.upper.tier1Artifact);
        // Later control picks may still change legitimately because the candidate changed collisions/global availability.
        expect(replay.lower.creatures.every((creatureId) => !replay.upper.creatures.includes(creatureId))).toBe(true);
        expect(replay.transcript.every((entry, index) => entry.index === index)).toBe(true);
    });

    it("conserves supply while using only the two Placement-opened split slots", () => {
        const creatureNames = ["Leprechaun", "Wolf Rider", "Healer", "Medusa", "Cyclops", "Champion"];
        const creatureIds = creatureNames.map((name) => {
            const id = creatureIdForName(name);
            if (id === undefined) throw new Error(`Missing test creature ${name}`);
            return id;
        });
        const roster = [
            { faction: "Nature", creatureName: "Leprechaun", level: 1, size: 1, amount: 100 },
            { faction: "Might", creatureName: "Wolf Rider", level: 1, size: 1, amount: 80 },
            { faction: "Life", creatureName: "Healer", level: 2, size: 1, amount: 40 },
            { faction: "Chaos", creatureName: "Medusa", level: 2, size: 1, amount: 30 },
            { faction: "Might", creatureName: "Cyclops", level: 3, size: 1, amount: 15 },
            { faction: "Life", creatureName: "Champion", level: 4, size: 2, amount: 3 },
        ];
        const expanded = materializeReplayAbSplits(roster, creatureIds, [{ kind: "Placement", value: 2 }], []);

        expect(expanded.roster).toHaveLength(8);
        expect(expanded.splitRoles).toHaveLength(2);
        expect(expanded.roster.filter((unit) => unit.creatureName === "Leprechaun").map((unit) => unit.amount)).toEqual(
            [99, 1],
        );
        expect(expanded.roster.filter((unit) => unit.creatureName === "Healer").map((unit) => unit.amount)).toEqual([
            39, 1,
        ]);
        expect(expanded.roster.reduce((sum, unit) => sum + unit.amount, 0)).toBe(
            roster.reduce((sum, unit) => sum + unit.amount, 0),
        );
        expect(
            replayUtilitySplitGate(
                [{ kind: "Placement", value: 2 }],
                [
                    { rosterIndex: 6, role: "aura" },
                    { rosterIndex: 7, role: "support" },
                ],
            ),
        ).toBe(true);
        expect(
            replayUtilitySplitGate(
                [{ kind: "Placement", value: 2 }],
                [
                    { rosterIndex: 6, role: "support" },
                    { rosterIndex: 7, role: "bait" },
                ],
            ),
        ).toBe(false);
        expect(replayUtilitySplitGate([{ kind: "Armor", value: 3 }], [{ rosterIndex: 6, role: "aura" }])).toBe(false);
    });

    it("makes a complete no-feature cluster an exact 50% identity control", () => {
        const components = noRankedReplayAbComponents();
        const record = withScopedAIEnvironment(buildRankedReplayAbEnvironment(components), () =>
            playRankedReplayAbCluster(
                {
                    cohort: "uniform-mixed",
                    pairs: 1,
                    baseSeed: 1391574133,
                    components,
                    combatScope: "all",
                    combatCandidate: "horizon-18",
                    maxLaps: 60,
                },
                0,
            ),
        );
        const summary = summarizeRankedReplayAbRecords([record]);

        expect(summary.overall.scoreRate).toBe(0.5);
        expect(record.games.every((game) => game.rejectedCandidate === 0 && game.rejectedControl === 0)).toBe(true);
        expect(record.games.every((game) => game.combatMatchupEligible === false)).toBe(true);
        expect(record.games[0].setupFingerprint).toBe(record.games[1].setupFingerprint);
        expect(record.games[2].setupFingerprint).toBe(record.games[3].setupFingerprint);
        const quality = validateRankedReplayAbRecords(
            [record],
            {
                pairs: 1,
                cohorts: ["uniform-mixed"],
                baseSeed: 1391574133,
                components,
                combatScope: "all",
                combatCandidate: "horizon-18",
            },
            1,
            true,
            true,
        );
        // A one-cluster unit fixture intentionally cannot satisfy the runner's 3-map stage geometry.
        expect(quality.malformedClusters).toBe(3);
        expect(quality.overlappingRosterAssignments).toBe(0);
        expect(
            validateRankedReplayAbRecords(
                [{ ...record, pair: 1 }],
                {
                    pairs: 1,
                    cohorts: ["uniform-mixed"],
                    baseSeed: 1391574133,
                    components,
                    combatScope: "all",
                    combatCandidate: "horizon-18",
                },
                1,
                true,
                true,
            ).malformedClusters,
        ).toBeGreaterThan(quality.malformedClusters);
    }, 30_000);

    it("uses draw-aware cluster means instead of discarding draws", () => {
        const template = {
            assignment: 0 as const,
            battleMirror: 0 as const,
            draftSeat: "candidate-roster-a" as const,
            candidateSide: "green" as const,
            winner: "draw" as const,
            candidateResult: "draw" as const,
            candidateScore: 0.5,
            laps: 1,
            endReason: "elimination" as const,
            armageddonDecided: false,
            rejectedCandidate: 0,
            rejectedControl: 0,
            candidateHpMargin: 0,
            candidateSurvivorMargin: 0,
            candidateRosterSignature: "a",
            controlRosterSignature: "b",
            candidateSetupIdentity: "ordinary" as const,
            combatMatchupEligible: false,
            candidateSplitStacks: 0,
            setupFingerprint: "setup",
        };
        const record = {
            schema: "hoc.ranked_replay_tactics_ab.v4",
            cohort: "uniform-mixed",
            pair: 0,
            pairSeed: 1,
            pickSeed: 2,
            combatSeed: 3,
            map: PBTypes.GridVals.NORMAL,
            components: noRankedReplayAbComponents(),
            combatScope: "all",
            combatCandidate: "horizon-18",
            games: [
                { ...template, candidateResult: "win", candidateScore: 1, winner: "green" },
                { ...template },
                { ...template },
                { ...template, candidateResult: "loss", candidateScore: 0, winner: "red" },
            ],
        } as IRankedReplayAbClusterRecord;

        expect(summarizeRankedReplayAbRecords([record]).overall.scoreRate).toBe(0.5);
    });

    it("weights variable-exposure slices by games while retaining offer-board clusters", () => {
        const game = (
            candidateScore: number,
            candidateSetupIdentity: "ordinary" | "fast-mobile-melee",
            assignment: 0 | 1,
            battleMirror: 0 | 1,
        ) => ({
            assignment,
            battleMirror,
            draftSeat: "candidate-roster-a" as const,
            candidateSide: "green" as const,
            winner: candidateScore === 1 ? ("green" as const) : ("red" as const),
            candidateResult: candidateScore === 1 ? ("win" as const) : ("loss" as const),
            candidateScore,
            laps: 1,
            endReason: "elimination" as const,
            armageddonDecided: false,
            rejectedCandidate: 0,
            rejectedControl: 0,
            candidateHpMargin: 0,
            candidateSurvivorMargin: 0,
            candidateRosterSignature: `candidate-${assignment}`,
            controlRosterSignature: `control-${assignment}`,
            candidateSetupIdentity,
            combatMatchupEligible: false,
            candidateSplitStacks: 0,
            setupFingerprint: `setup-${assignment}`,
        });
        const record = (pair: number, games: IRankedReplayAbClusterRecord["games"]): IRankedReplayAbClusterRecord => ({
            schema: "hoc.ranked_replay_tactics_ab.v4",
            cohort: "uniform-mixed",
            pair,
            pairSeed: pair,
            pickSeed: pair,
            combatSeed: pair,
            map: PBTypes.GridVals.NORMAL,
            components: noRankedReplayAbComponents(),
            combatScope: "all",
            combatCandidate: "horizon-18",
            games,
        });
        const records = [
            record(0, [
                game(1, "ordinary", 0, 0),
                game(1, "ordinary", 0, 1),
                game(1, "ordinary", 1, 0),
                game(1, "ordinary", 1, 1),
            ]),
            record(1, [
                game(0, "ordinary", 0, 0),
                game(0, "ordinary", 0, 1),
                game(0, "fast-mobile-melee", 1, 0),
                game(0, "fast-mobile-melee", 1, 1),
            ]),
        ];

        const ordinary = summarizeRankedReplayAbRecords(records).setupIdentities.find((row) => row.key === "ordinary");
        expect(ordinary?.games).toBe(6);
        expect(ordinary?.clusters).toBe(2);
        expect(ordinary?.scoreRate).toBeCloseTo(4 / 6, 12);
        expect(ordinary?.standardErrorPp).not.toBeNull();
    });

    it("requires the preregistered stage geometry and seals held-out promotion runs", () => {
        expect(() => parseRankedReplayAbRunnerOptions(["--pairs", "35", "--output", "/tmp/replay-ab-invalid"])).toThrow(
            "divisible by 36",
        );
        expect(
            parseRankedReplayAbRunnerOptions(["--stage", "smoke", "--pairs", "36", "--output", "/tmp/replay-ab-valid"])
                .baseSeed,
        ).toBe(1391574133);
        expect(
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-shortlist-3",
                "--components",
                "combat",
                "--combat-candidate",
                "shortlist-3",
            ]),
        ).toMatchObject({ combatCandidate: "shortlist-3", combatScope: "all" });
        expect(
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-ranged-battery",
                "--combat-scope",
                "ranged-battery",
            ]),
        ).toMatchObject({ combatScope: "ranged-battery", baseSeed: 271828183, concurrency: 6 });
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-bad-scope",
                "--combat-scope",
                "ranged",
            ]),
        ).toThrow("combat-scope must be all or ranged-battery");
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-bad-scoped-concurrency",
                "--combat-scope",
                "ranged-battery",
                "--concurrency",
                "12",
            ]),
        ).toThrow("ranged-battery combat scope requires concurrency 6");
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "direction",
                "--output",
                "/tmp/replay-ab-reused-seed",
                "--combat-scope",
                "ranged-battery",
                "--seed",
                "1391574133",
            ]),
        ).toThrow("preregistered seed 271828183");
        expect(
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-epsilon",
                "--combat-epsilon",
                "0.005",
            ]).combatEpsilon,
        ).toBe(0.005);
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "smoke",
                "--output",
                "/tmp/replay-ab-bad-epsilon",
                "--combat-epsilon",
                "0.01",
            ]),
        ).toThrow("preregistered development values");
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "validation",
                "--pairs",
                "36",
                "--output",
                "/tmp/replay-ab-invalid-validation",
            ]),
        ).toThrow("requires exactly 3600");
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "validation",
                "--seed",
                "1",
                "--output",
                "/tmp/replay-ab-invalid-validation-seed",
            ]),
        ).toThrow("preregistered seed 386914648");
        expect(() =>
            parseRankedReplayAbRunnerOptions([
                "--stage",
                "validation",
                "--cohorts",
                "ranked-draft",
                "--output",
                "/tmp/replay-ab-invalid-validation-cohorts",
            ]),
        ).toThrow("all preregistered cohorts");
    });
});
