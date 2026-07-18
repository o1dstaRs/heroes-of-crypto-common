/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

export interface IAligned96hVersionProfile<
    Candidate extends string = string,
    CandidateBase extends string = string,
    Opponent extends string = string,
> {
    schemaVersion: 1;
    candidate: Candidate;
    candidateBase: CandidateBase;
    opponent: Opponent;
}

export const V07_ALIGNED_96H_V2_VERSION_PROFILE = Object.freeze({
    schemaVersion: 1,
    candidate: "v0.7s",
    candidateBase: "v0.7",
    opponent: "v0.6",
} as const satisfies IAligned96hVersionProfile);

export const V08_ALIGNED_96H_V1_VERSION_PROFILE = Object.freeze({
    schemaVersion: 1,
    candidate: "v0.8s",
    candidateBase: "v0.8",
    opponent: "v0.7",
} as const satisfies IAligned96hVersionProfile);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export function assertAligned96hVersionProfile<Profile extends IAligned96hVersionProfile>(
    value: unknown,
    expected: Profile,
): asserts value is Profile {
    if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !== "candidate,candidateBase,opponent,schemaVersion" ||
        value.schemaVersion !== expected.schemaVersion ||
        value.candidate !== expected.candidate ||
        value.candidateBase !== expected.candidateBase ||
        value.opponent !== expected.opponent
    ) {
        throw new Error(
            `aligned version profile must be exactly ${expected.candidate}/${expected.candidateBase} versus ${expected.opponent}`,
        );
    }
}

export function cloneAligned96hVersionProfile<Profile extends IAligned96hVersionProfile>(profile: Profile): Profile {
    return { ...profile };
}
