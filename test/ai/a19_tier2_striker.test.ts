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

import { describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import {
    A19_TIER2_FORECAST_ARTIFACTS,
    A19_TIER2_STRIKER_CROWN_MAX_MELEE_PROBABILITY,
    A19_TIER2_STRIKER_POLICY,
    a19Tier2StrikerArtifact,
    a19Tier2StrikerDecision,
} from "../../src/ai/setup/a19_tier2_striker";
import { TIER2_ARTIFACT_WINRATE_MELEE } from "../../src/ai/setup/setup_conditional";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import fixture from "./fixtures/a19_tier2_striker_decisions.json";

/** The shipped policy's melee path over established artifacts: the highest v0.7 melee table entry. */
const melee = (established: readonly number[]): number =>
    [...established].sort(
        (a, b) => (TIER2_ARTIFACT_WINRATE_MELEE[b] ?? -1) - (TIER2_ARTIFACT_WINRATE_MELEE[a] ?? -1),
    )[0];

describe("a19-tier2-striker-v1", () => {
    test("identity and thresholds", () => {
        expect(A19_TIER2_STRIKER_POLICY).toBe("a19-tier2-striker-v1");
        expect(A19_TIER2_STRIKER_CROWN_MAX_MELEE_PROBABILITY).toBe(0.8);
        expect([...A19_TIER2_FORECAST_ARTIFACTS].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 17]);
    });

    test("Crown of Command when the opponent does not look melee", () => {
        const base = {
            usable: [Tier2Artifact.TITAN_PLATE, Tier2Artifact.CROWN_OF_COMMAND],
            ownRanged: 0,
            shipped: Tier2Artifact.TITAN_PLATE,
            pickEstablished: melee,
        };
        expect(a19Tier2StrikerDecision({ ...base, meleeProbability: 0.25 })).toBe(Tier2Artifact.CROWN_OF_COMMAND);
        expect(a19Tier2StrikerDecision({ ...base, meleeProbability: 0.94 })).toBe(Tier2Artifact.TITAN_PLATE);
    });

    test("an established artifact outranks a forecast one", () => {
        const decision = {
            usable: [Tier2Artifact.PENDANT_OF_VITALITY, Tier2Artifact.GRAVECHAIN, Tier2Artifact.LAVA_STRIDERS],
            ownRanged: 1,
            meleeProbability: 0.95,
            shipped: Tier2Artifact.GRAVECHAIN,
            pickEstablished: melee,
        };
        expect(a19Tier2StrikerDecision(decision)).toBe(Tier2Artifact.LAVA_STRIDERS);
        // Only forecast artifacts on offer: the shipped choice stands.
        expect(
            a19Tier2StrikerDecision({ ...decision, usable: [Tier2Artifact.GRAVECHAIN, Tier2Artifact.LAST_FUSE] }),
        ).toBe(Tier2Artifact.GRAVECHAIN);
    });

    test("an army with two ranged stacks keeps the shipped choice", () => {
        const decision = {
            usable: [Tier2Artifact.CROWN_OF_COMMAND, Tier2Artifact.GRAVECHAIN],
            ownRanged: 2,
            meleeProbability: 0.1,
            shipped: Tier2Artifact.GRAVECHAIN,
            pickEstablished: melee,
        };
        expect(a19Tier2StrikerDecision(decision)).toBe(Tier2Artifact.GRAVECHAIN);
    });

    test("the live wrapper applies the beneficiary rule and keeps an empty roster's choice", () => {
        expect(
            a19Tier2StrikerArtifact(
                [Tier2Artifact.CROWN_OF_COMMAND],
                [],
                undefined,
                0,
                Tier2Artifact.CROWN_OF_COMMAND,
                melee,
            ),
        ).toBe(Tier2Artifact.CROWN_OF_COMMAND);
        expect(
            a19Tier2StrikerArtifact(
                [Tier2Artifact.GIANTS_MAUL, Tier2Artifact.GRAVECHAIN],
                [1],
                createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: [], ownProspectiveCreatureIds: [] }),
                0.9,
                Tier2Artifact.GRAVECHAIN,
                melee,
            ),
        ).toBe(Tier2Artifact.GRAVECHAIN);
    });

    test("reproduces the research rule on every confirmation H decision", () => {
        const rows = fixture as { u: number[]; r: number; q: number; s: number; c: number }[];
        expect(rows.length).toBe(2293);
        const misses = rows.filter(
            (row) =>
                a19Tier2StrikerDecision({
                    usable: row.u,
                    ownRanged: row.r,
                    meleeProbability: row.q,
                    shipped: row.s,
                    pickEstablished: melee,
                }) !== row.c,
        );
        expect(misses).toEqual([]);
    });
});
