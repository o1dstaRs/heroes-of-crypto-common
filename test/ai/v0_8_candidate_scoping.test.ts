/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import type { Unit } from "../../src/units/unit";
import { strategyVersionMatchesExperimentScope } from "../../src/ai/versions/experiment_scope";
import { meleeDimsOverlay } from "../../src/ai/versions/v0_6";
import {
    AURA_CASTER_ROUTER_VERSIONS_ENV,
    auraCasterRouterEnabled,
    DENSE_MELEE_MAGIC_ISOLATION_VERSIONS_ENV,
    denseMeleeMagicIsolationEnabled,
} from "../../src/ai/versions/v0_7";
import {
    REVEAL_PLACEMENT_ENV,
    REVEAL_PLACEMENT_VERSIONS_ENV,
    revealPlacementEnabled,
} from "../../src/ai/versions/v0_7_placement_reveal";
import {
    buildV07AlignedV2CandidateEnvironment,
    isV07AlignedV2BehaviorEnvironmentKey,
    verifyV07AlignedV2WorkerEnvironment,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import { SearchDriver } from "../../src/simulation/search_driver";

const ENV_KEYS = [
    REVEAL_PLACEMENT_ENV,
    REVEAL_PLACEMENT_VERSIONS_ENV,
    "V07_DENSE_MM_SALVAGE_ISOLATION",
    DENSE_MELEE_MAGIC_ISOLATION_VERSIONS_ENV,
    "V07_AURA_CASTER_ROUTER",
    AURA_CASTER_ROUTER_VERSIONS_ENV,
    "V07_AURA_CASTER_SPELLS",
    "V06_MELEE_DIMS",
    "V06_MELEE_DIMS_VERSIONS",
    "V07_SEARCH",
    "SEARCH_VERSIONS",
    "SEARCH_LATE_RANGED_FINISH_WEIGHT",
    "SEARCH_PURE_RANGED_TERMINAL_WEIGHT",
] as const;

const savedEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const alignedGenome = {
    search: {
        leafMode: "material" as const,
        gate: 0.01,
        horizon: 8,
        rollouts: 1,
        includeMoves: false,
        maxMelee: 4,
        maxShots: 3,
        maxThrows: 2,
    },
    controls: {
        activeChallengers: true,
        shortlist: 2 as const,
        decisionDeadlineMs: 150 as const,
        lateRangedFinishWeight: 4 as const,
        pureRangedTerminalWeight: 0 as const,
        meleeRangedTargetWeight: 2 as const,
        placementReveal: true,
        denseMeleeMagicIsolation: true,
        auraCasterMode: "windflow" as const,
    },
};

describe("v0.8 aligned candidate-only experiment scopes", () => {
    it("keeps absent scopes backward-compatible and treats explicit empty/mismatch scopes as off", () => {
        expect(strategyVersionMatchesExperimentScope("v0.7", undefined)).toBe(true);
        expect(strategyVersionMatchesExperimentScope("v0.7", "")).toBe(false);
        expect(strategyVersionMatchesExperimentScope("v0.7", "v0.8s, v0.7")).toBe(true);
        expect(strategyVersionMatchesExperimentScope("v0.7", "v0.8s")).toBe(false);
        expect(strategyVersionMatchesExperimentScope(undefined, "v0.8s")).toBe(false);
    });

    it("emits all candidate scopes for v0.8s while preserving the historical two-argument binding", () => {
        const historical = buildV07AlignedV2CandidateEnvironment(alignedGenome, "/tmp/historical-audit.jsonl");
        expect(historical.SEARCH_VERSIONS).toBe("v0.7s");
        expect(historical.V06_MELEE_DIMS_VERSIONS).toBe("v0.7s");
        expect(historical.V07_PLACEMENT_REVEAL_VERSIONS).toBeUndefined();
        expect(historical.V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS).toBeUndefined();
        expect(historical.V07_AURA_CASTER_ROUTER_VERSIONS).toBeUndefined();

        const candidate = buildV07AlignedV2CandidateEnvironment(alignedGenome, "/tmp/v08-audit.jsonl", "v0.8s");
        expect(candidate).toMatchObject({
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_LATE_RANGED_FINISH_WEIGHT: "4",
            SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0",
            V06_MELEE_DIMS: "0,2",
            V06_MELEE_DIMS_VERSIONS: "v0.8s",
            V07_PLACEMENT_REVEAL_VERSIONS: "v0.8s",
            V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS: "v0.8s",
            V07_AURA_CASTER_ROUTER_VERSIONS: "v0.8s",
        });
        for (const key of [
            "V07_PLACEMENT_REVEAL_VERSIONS",
            "V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS",
            "V07_AURA_CASTER_ROUTER_VERSIONS",
        ]) {
            expect(isV07AlignedV2BehaviorEnvironmentKey(key)).toBe(true);
        }
        expect(verifyV07AlignedV2WorkerEnvironment(candidate, candidate).effective).toEqual(candidate);
        expect(() =>
            verifyV07AlignedV2WorkerEnvironment(candidate, {
                ...candidate,
                V07_PLACEMENT_REVEAL_VERSIONS: "v0.7",
            }),
        ).toThrow("worker behavior environment does not match its exact candidate binding");
    });

    it("rejects ambiguous candidate version scopes", () => {
        for (const version of ["", " v0.8s", "v0.8s ", "v0.8s,v0.7"]) {
            expect(() => buildV07AlignedV2CandidateEnvironment(alignedGenome, "/tmp/v08-audit.jsonl", version)).toThrow(
                "candidateVersion must be one exact, non-empty strategy version",
            );
        }
    });

    it("applies placement, dense-melee, aura, and melee-target controls only to v0.8s", () => {
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        process.env[REVEAL_PLACEMENT_VERSIONS_ENV] = "v0.8s";
        process.env.V07_DENSE_MM_SALVAGE_ISOLATION = "1";
        process.env[DENSE_MELEE_MAGIC_ISOLATION_VERSIONS_ENV] = "v0.8s";
        process.env.V07_AURA_CASTER_ROUTER = "on";
        process.env[AURA_CASTER_ROUTER_VERSIONS_ENV] = "v0.8s";
        process.env.V06_MELEE_DIMS = "0,2";
        process.env.V06_MELEE_DIMS_VERSIONS = "v0.8s";

        expect(revealPlacementEnabled(undefined, "v0.7")).toBe(false);
        expect(denseMeleeMagicIsolationEnabled("v0.7")).toBe(false);
        expect(auraCasterRouterEnabled("v0.7")).toBe(false);
        expect(meleeDimsOverlay("v0.7")).toBeUndefined();

        expect(revealPlacementEnabled(undefined, "v0.8s")).toBe(true);
        expect(denseMeleeMagicIsolationEnabled("v0.8s")).toBe(true);
        expect(auraCasterRouterEnabled("v0.8s")).toBe(true);
        expect(meleeDimsOverlay("v0.8s")).toEqual([0, 2]);

        delete process.env[REVEAL_PLACEMENT_VERSIONS_ENV];
        delete process.env[DENSE_MELEE_MAGIC_ISOLATION_VERSIONS_ENV];
        delete process.env[AURA_CASTER_ROUTER_VERSIONS_ENV];
        delete process.env.V06_MELEE_DIMS_VERSIONS;
        expect(revealPlacementEnabled(undefined, "v0.7")).toBe(true);
        expect(denseMeleeMagicIsolationEnabled("v0.7")).toBe(true);
        expect(auraCasterRouterEnabled("v0.7")).toBe(true);
        expect(meleeDimsOverlay("v0.7")).toEqual([0, 2]);
    });

    it("returns the exact incumbent reference for v0.7 with both terminal overlays armed", () => {
        process.env.V07_SEARCH = "1";
        process.env.SEARCH_VERSIONS = "v0.8s";
        process.env.SEARCH_LATE_RANGED_FINISH_WEIGHT = "4";
        process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT = "1";
        const driver = new SearchDriver(undefined as never, {
            greenVersion: "v0.8s",
            redVersion: "v0.7",
        });
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "incumbent" }];

        expect(driver.appliesTo("v0.7")).toBe(false);
        expect(driver.chooseDecision({} as Unit, "v0.7", incumbent)).toBe(incumbent);
        expect(driver.appliesTo("v0.8s")).toBe(true);
        expect(
            driver as unknown as {
                lateRangedFinishWeight: number;
                pureRangedTerminalWeight: number;
            },
        ).toMatchObject({ lateRangedFinishWeight: 4, pureRangedTerminalWeight: 1 });
    });
});
