import {
    buildV08A13SearchEnvironment,
    V08_A13_CANDIDATE_ID,
    V08_A13_GENOME,
    V08_A13_GENOME_SHA256,
    V08_A13_POLICY,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_SEARCH,
    V08_A13_SOURCE_VERSION,
} from "./v0_8_a13_profile";

export const V08_A19_H18_PROFILE_SCHEMA = "hoc.v0_8_a19_h18_research_profile.v1" as const;
export const V08_A19_H18_CANDIDATE_ID = "a19-h18-research" as const;

export const V08_A19_H18_SEARCH = Object.freeze({
    ...V08_A13_SEARCH,
    horizon: 18,
});

export const V08_A19_H18_GENOME = Object.freeze({
    ...V08_A13_GENOME,
    search: Object.freeze({
        ...V08_A13_GENOME.search,
        horizon: V08_A19_H18_SEARCH.horizon,
    }),
});

export const V08_A19_H18_GENOME_SHA256 = "fb6acdc8e9b60431c12bfd0435e3710ce21c51ca85b26cd960ddfe031a86ea3a" as const;
export const V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256 =
    "984a5e10453f74f2042a861f8b356a0b0106c1e278e2a77caa3628b494a9e695" as const;

export function buildV08A19H18SearchEnvironment(
    version: typeof V08_A13_PRODUCTION_VERSION | typeof V08_A13_SOURCE_VERSION = V08_A13_PRODUCTION_VERSION,
): Readonly<Record<string, string | undefined>> {
    return Object.freeze({
        ...buildV08A13SearchEnvironment(version),
        SEARCH_HORIZON: String(V08_A19_H18_SEARCH.horizon),
    });
}

export const V08_A19_H18_PROFILE = Object.freeze({
    schema: V08_A19_H18_PROFILE_SCHEMA,
    candidateId: V08_A19_H18_CANDIDATE_ID,
    researchOnly: true as const,
    derivesFrom: Object.freeze({
        name: "v0.8+a13" as const,
        candidateId: V08_A13_CANDIDATE_ID,
        genomeSha256: V08_A13_GENOME_SHA256,
        changedSearchControls: Object.freeze({
            horizon: Object.freeze({ from: V08_A13_SEARCH.horizon, to: V08_A19_H18_SEARCH.horizon }),
        }),
    }),
    genomeSha256: V08_A19_H18_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H18_GENOME,
    search: V08_A19_H18_SEARCH,
    policy: V08_A13_POLICY,
});
