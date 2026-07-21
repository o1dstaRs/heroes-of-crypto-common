/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

/**
 * Immutable, test-only identity for the one candidate independently retained by both 2026-07-20 hosts.
 *
 * This is not a shipped strategy and does not authorize a bake or deployment. The overnight evidence used
 * wall-clock-independent search, so the bounded profile below must qualify separately before promotion.
 */

export const V08_TEST_CANDIDATE_SCHEMA = "hoc.v0_8_test_candidate_profile.v2" as const;
/** Historical genome/environment identity retained from the two independent training hosts. */
export const V08_TEST_CANDIDATE_SOURCE_ID = "v0.8-d1748882-test-candidate" as const;
/**
 * Reviewed operational policy identity. Any behavior edit covered by OPERATIONAL_SOURCE_FILES must bump this
 * revision and repin the file bundle + policy hashes below before the candidate runner will execute.
 */
export const V08_TEST_CANDIDATE_OPERATIONAL_POLICY_REVISION = 1 as const;
export const V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID = "v0.8-d1748882-operational-r1" as const;
export const V08_TEST_CANDIDATE_ID = V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID;
export const V08_TEST_CANDIDATE_GENOME_SHA256 =
    "d17488826ff56a5d8a1d1c4dac752dd995132582d9c173e5b496e7756fcaf744" as const;

export const V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH = "<adaptive-job-audit-path>" as const;
export const V08_TEST_CANDIDATE_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256 =
    "a0ff0b2915d03df40046c9de742cc3b95a0d9089e8639ee0256e1af4c933076b" as const;
export const V08_TEST_CANDIDATE_RESEARCH_ENVIRONMENT_SHA256 =
    "c7f4486260db95274bd8d849559cf8d8651c34b340d7fa7b79479c1170944a65" as const;
/** Historical bounded source-alias binding (`v0.8s`), retained only for source replay. */
export const V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256 =
    "4a4ee6607d433cab0d0993974142f376ba68bc71ab40cedeb6c5ac89bcffdc6d" as const;
/** Bounded operational binding with every candidate-only scope rebound to plain `v0.8`. */
export const V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256 =
    "6a1b911818bbdf87b0632a1abacec2a1ac7f7f83ccf337f1e18bdc6726f9373a" as const;

/**
 * Exact behavior-bearing source bundle for operational revision 1.
 *
 * Deliberately explicit rather than a whole-worktree hash: unrelated peers may edit the shared main worktree,
 * while any future change to these files must fail closed with a clear "repin required" error.
 */
export const V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES = Object.freeze({
    "src/ai/versions/v0_4.ts": "d8e5b3f48614c39af7bbb34cc309b3353bdd5b064f967d7f848dfa5087eebad5",
    "src/ai/versions/v0_8.ts": "f4edecd4aa7d8cf8bfb2bb7d50c3cfdb3c0d33511610a6cefa9037b04b09ef1a",
    "src/ai/versions/v0_8_dominant_finish.ts": "aa3882d7246e4df3fcb7a6902ab4dbfe3331fcaa24487cf9af8037ed490a6302",
    "src/simulation/search_driver.ts": "ca963b3b5079501ef3450356c0ed3062f34f419d17844c360c31730f73f26fe0",
    "src/simulation/v0_8_l4_coverage.ts": "0a715b94f71d281324a206650202f6c4096a4c65c6f24d1e52a98e1e00f20e48",
    "src/simulation/v0_8_l4_coverage_worker.ts": "264cb4e9b8c17a6342201109884cc32cc13c3ee96e28ba0a70b0bd9446835926",
});
export const V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256 =
    "72000b4c5a3ae80fb553a98dc5b3c2f14f4151e6ca5ae3e6fb1c1e0a5388f287" as const;

export const V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING = Object.freeze({
    revision: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_REVISION,
    id: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
    sourceCandidateId: V08_TEST_CANDIDATE_SOURCE_ID,
    candidateVersion: "v0.8" as const,
    opponentVersion: "v0.7" as const,
    genomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256,
    operationalEnvironmentSha256: V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
    sourceBundleSha256: V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
    decisionDeadlineMs: 175 as const,
    circuitBreakerMs: 275 as const,
});
export const V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256 =
    "cb0ffee563dbc10e475c07b3ad983d5edc0060d32c59a3c5da8d96f02b69f8c0" as const;

export type V08TestCandidateTimingMode = "research_unbounded" | "operational_bounded";
export type V08TestCandidateVersion = "v0.8s" | "v0.8";

export interface IV08TestCandidateEnvironmentOptions {
    /** A real audit path for execution, or the frozen placeholder when reproducing the provenance hash. */
    auditPath: string;
    timingMode: V08TestCandidateTimingMode;
    /** Source-replay alias by default; stable operational playtests deliberately rebind every scope to v0.8. */
    candidateVersion?: V08TestCandidateVersion;
}

const V08_TEST_CANDIDATE_LEAF = Object.freeze({
    b: 0.09309534729822494,
    w: Object.freeze([
        3.975452559963074, 2.91024781299575, 1.6955499105886163, -0.13878338988958078, -1.004206888295498,
        0.9746473419120707, 0.1733425422227796, -0.0016458596487761092, -0.09810648590179219, -1.7061173660008175,
        -0.9411277151578171, 0.799913000740394, -0.011397857009644349, -0.2085372527426188, -0.38327219233442333,
        0.3178997037045003, -0.1689734013964604, 0.19630066840913368, 0.08435882519080458, -0.0716921080800426,
        -0.03331687788831818, 0.030983266819575472, 0.10930099485974634, -0.12317848197101075, 0.26161893743321385,
        -0.34770581560865854, 0.024506522869171758, -0.06076006377852034, -0.08833106713827187, 0.011013897399625987,
        0.849511886631089, -0.10838772392033705, 0.680603649196206, -0.12266998668111599, -0.4602526999909834,
        0.40761884937538817, -0.004477182918242628, -0.017129255876877122, -0.07681415576104508, 0.14275517289990675,
        0.17047075489502825, -0.013156201464677254, -0.0011445422585481392, 0.16586130908339014, 0.0022128508947729716,
        0.030556958702240875, 0.003147099540253163, 0.011784495140121915, 0.02993491055896367, 0.0002870814633998233,
        -0.02691932403738569, -0.004613739127468359, 0.05196151226502595, -0.04248931966307392, 0.013197703186176489,
        -0.012964873352796426, 0.03434803034444907, -0.04769614893206575, -0.07078475532819863, 0.04992807754170975,
    ]),
});

/** Label-free because the M4 and HFT adaptive catalogs assigned different local ids to identical behavior. */
export const V08_TEST_CANDIDATE_GENOME = Object.freeze({
    search: Object.freeze({
        leafMode: "model" as const,
        leaf: V08_TEST_CANDIDATE_LEAF,
        gate: 0.02,
        horizon: 12,
        rollouts: 2,
        includeMoves: true,
        maxMelee: 6,
        maxShots: 4,
        maxThrows: 2,
    }),
    controls: Object.freeze({
        activeChallengers: true,
        shortlist: 3 as const,
        decisionDeadlineMs: 175 as const,
        lateRangedFinishWeight: 0 as const,
        pureRangedTerminalWeight: 0 as const,
        meleeRangedTargetWeight: 0 as const,
        placementReveal: true,
        denseMeleeMagicIsolation: false,
        auraCasterMode: "off" as const,
    }),
});

const sortedFrozenEnvironment = (environment: Record<string, string>): Readonly<Record<string, string>> =>
    Object.freeze(Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))));

/**
 * Materialize the complete seat-scoped environment without reading or changing process.env.
 *
 * `research_unbounded` is the exact cross-host fitness policy. `operational_bounded` restores the reviewed
 * 175ms decision deadline and 275ms per-match circuit breaker and therefore requires independent evidence.
 */
export function buildV08TestCandidateEnvironment(
    options: IV08TestCandidateEnvironmentOptions,
): Readonly<Record<string, string>> {
    if (!options.auditPath.trim()) throw new Error("v0.8 test candidate auditPath must not be empty");
    if (!(options.timingMode === "research_unbounded" || options.timingMode === "operational_bounded")) {
        throw new Error("v0.8 test candidate timingMode is invalid");
    }
    const bounded = options.timingMode === "operational_bounded";
    const candidateVersion = options.candidateVersion ?? "v0.8s";
    if (!(candidateVersion === "v0.8s" || candidateVersion === "v0.8")) {
        throw new Error("v0.8 test candidate version is invalid");
    }
    return sortedFrozenEnvironment({
        LIVETWIN: "1",
        Q2_ORACLE: "0",
        Q2_WAIT_ABLATION: "0",
        SEARCH_ACTIVE_CHALLENGERS: "1",
        SEARCH_AUDIT: options.auditPath,
        SEARCH_AUDIT_TURNS: "0",
        SEARCH_CIRCUIT_BREAKER_MS: bounded ? "275" : "",
        SEARCH_DECISION_DEADLINE_MS: bounded ? "175" : "",
        SEARCH_GATE: "0.02",
        SEARCH_HORIZON: "12",
        SEARCH_INCLUDE_MOVES: "1",
        SEARCH_LATE_RANGED_FINISH_WEIGHT: "0",
        SEARCH_MAX_MELEE: "6",
        SEARCH_MAX_MOVES: "1",
        SEARCH_MAX_SHOTS: "4",
        SEARCH_MAX_THROWS: "2",
        SEARCH_OPP_MODEL: "",
        SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0",
        SEARCH_ROLLOUTS: "2",
        SEARCH_SHORTLIST: "3",
        SEARCH_VERSIONS: candidateVersion,
        V06_MELEE_DIMS: "",
        V06_MELEE_DIMS_VERSIONS: "",
        V07_AURA_CASTER_ROUTER: "off",
        V07_AURA_CASTER_SPELLS: "",
        V07_AURA_CASTER_ROUTER_VERSIONS: candidateVersion,
        V07_DENSE_MM_SALVAGE_ISOLATION: "0",
        V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS: candidateVersion,
        V07_PLACEMENT_REVEAL: "on",
        V07_PLACEMENT_REVEAL_VERSIONS: candidateVersion,
        V07_SEARCH: "1",
        V07_VALUE_WEIGHTS_V2: JSON.stringify(V08_TEST_CANDIDATE_LEAF),
        V08_AGGRESSIVE: "1",
    });
}

export const V08_TEST_CANDIDATE_PROFILE = Object.freeze({
    schemaVersion: 2 as const,
    artifactKind: V08_TEST_CANDIDATE_SCHEMA,
    id: V08_TEST_CANDIDATE_ID,
    sourceCandidateId: V08_TEST_CANDIDATE_SOURCE_ID,
    status: "test_only_requires_bounded_qualification" as const,
    sourceReplayVersion: "v0.8s" as const,
    operationalCandidateVersion: "v0.8" as const,
    opponentVersion: "v0.7" as const,
    testOnly: true as const,
    automaticBake: false as const,
    automaticDeploy: false as const,
    aggressivePolicy: Object.freeze({
        enabled: true as const,
        identity: "v0.8-aggressive-search-operational-r1" as const,
        environmentKey: "V08_AGGRESSIVE" as const,
        environmentValue: "1" as const,
    }),
    timing: Object.freeze({
        research: Object.freeze({
            mode: "research_unbounded" as const,
            decisionDeadlineMs: null,
            circuitBreakerMs: null,
            crossHostFitnessEvidence: true as const,
        }),
        operational: Object.freeze({
            mode: "operational_bounded" as const,
            decisionDeadlineMs: 175 as const,
            circuitBreakerMs: 275 as const,
            qualificationRequired: true as const,
        }),
    }),
    genome: V08_TEST_CANDIDATE_GENOME,
    hashes: Object.freeze({
        genomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256,
        sourceBehaviorEnvironmentSha256: V08_TEST_CANDIDATE_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
        sourceResearchEnvironmentSha256: V08_TEST_CANDIDATE_RESEARCH_ENVIRONMENT_SHA256,
        sourceAliasOperationalEnvironmentSha256: V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256,
        operationalEnvironmentSha256: V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
        operationalSourceBundleSha256: V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
        operationalPolicySha256: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256,
    }),
    operationalPolicy: Object.freeze({
        ...V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING,
        sha256: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256,
        sourceFiles: V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES,
        repinRule:
            "Any covered source or operational environment change requires a reviewed revision/id/hash repin" as const,
    }),
    provenance: Object.freeze({
        createdAt: "2026-07-21T00:15:57.831Z" as const,
        sourceSnapshotBaseCommit: "9b7bfa638feeda5304902036ddaac53dd9b86621" as const,
        sourceRuns: Object.freeze([
            Object.freeze({
                host: "m4-max" as const,
                runId: "hoc-v08-aggressive-8h-m4-v7-20260720T161722Z" as const,
                candidateId: "a00" as const,
                candidateLabel: "adaptive-a00-from-c32-gate-search-gate" as const,
                sourceBindingSha256: "50a8646825987569b6e5da5ff5d782b4959d112757020a567f05e935e8284653" as const,
                validationGames: 57_344 as const,
            }),
            Object.freeze({
                host: "ryzen-9800x3d" as const,
                runId: "hoc-v08-aggressive-8h-hft-v7-20260720T161722Z" as const,
                candidateId: "a18" as const,
                candidateLabel: "adaptive-a18-from-c32-gate-search-gate" as const,
                sourceBindingSha256: "36ce1157cc4c8a216f6f3f08aa3e3911b1b59169998dad31d403fa5102a46182" as const,
                validationGames: 31_744 as const,
            }),
        ]),
        mutation: Object.freeze({
            parentCandidateId: "c32" as const,
            parentGenomeSha256: "a01a1b818854866007364e4c1bdbc59c6da9aea8bd22eb35e2ef03201d0919ae" as const,
            field: "search.gate" as const,
            from: 0.025 as const,
            to: 0.02 as const,
        }),
        sourceHarnessCrossHostPreflight: Object.freeze({
            catalogCandidateIndex: 42 as const,
            games: 64 as const,
            seed: 86_020_724 as const,
            canonicalFullRecordSha256: "df0f477375f525729b431b88169d7d6abc4562a5ceecb7b30feb92b92d547a01" as const,
        }),
        /** Historical training harness hashes. These are provenance, not the operational source pin above. */
        historicalTrainingCodeSha256: Object.freeze({
            v08Strategy: "f2ca25a57242dbccb0fa089b2c81d570343df0134312a8617b18e5ebfa70c876" as const,
            dominantFinish: "01a0eb409cd50d8a758a6cc3d062b00c473047268385a0ae210bd875e01cb0d6" as const,
            searchDriver: "1b962b4281d22944417c79bb6c1276e6aad9798cbff27f73ff215f755df56e74" as const,
            campaign: "188009b0c35483a75e5fa3334c3393e6fb788084e85ef57f840df1c86c3480fd" as const,
            level4Coverage: "0a715b94f71d281324a206650202f6c4096a4c65c6f24d1e52a98e1e00f20e48" as const,
            level4Worker: "264cb4e9b8c17a6342201109884cc32cc13c3ee96e28ba0a70b0bd9446835926" as const,
        }),
    }),
});
