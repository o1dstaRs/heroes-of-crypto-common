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
import { existsSync } from "node:fs";

import { createAIStrategy } from "../../src/ai";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08_A13_VALUE_LEAF } from "../../src/ai/versions/v0_8_a13_profile";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import { creaturesByLevel, type IArmyUnitSpec, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { NativeRolloutReuse } from "../../src/simulation/native_rollout_reuse";
import {
    compareNativeShadowBank,
    exportWithoutSideEffects,
    type INativeBankInput,
    type INativePairFlags,
    type INativePairRecord,
    type INativeRolloutBackend,
    nativeEnvironmentRefusal,
    nativeRequestPolicies,
    nativeExportSideEffects,
    nativeLeafKind,
    nativeDefaultTree,
    nativeRolloutBackendRequested,
    nativeRolloutLog,
    NativeRootScope,
    nativeRolloutModeFromEnv,
    nativeShadowRateFromEnv,
    nativeTeamPolicy,
    rootStepWithoutSideEffects,
    runNativeBank,
    getNativeRolloutBackend,
    setNativeRolloutBackendForTests,
} from "../../src/simulation/native_rollouts";
import { DEFAULT_V07_VALUE_WEIGHTS } from "../../src/simulation/v0_7_value_weights";
import {
    captureDeterministicRandomState,
    createSecureUuid,
    restoreDeterministicRandomState,
} from "../../src/utils/lib";

const FLAGS: INativePairFlags = { played: 0, skippedIllegal: 1, aborted: 2, notReached: 3, skippedTail: 4 };

const pair = (value: number, turns = 3, extra: Partial<INativePairRecord> = {}): INativePairRecord => ({
    value,
    material: Number.NaN,
    turns,
    flags: FLAGS.played,
    summonSequence: 0,
    uuidSequence: 0,
    winner: -1,
    ...extra,
});

/** A backend whose engine answers each rollouts call with the next scripted call. */
function scriptedBackend(calls: { records: INativePairRecord[]; stop?: string }[]): {
    native: INativeRolloutBackend;
    requests: Record<string, unknown>[];
} {
    const requests: Record<string, unknown>[] = [];
    let last: INativePairRecord[] = [];
    const native: INativeRolloutBackend = {
        engine: {
            load: () => ({ free: () => undefined }),
            rollouts: (_state, request) => {
                requests.push(request as Record<string, unknown>);
                const call = calls[requests.length - 1];
                last = call.records;
                const counted = call.records.filter((r) => r.flags === FLAGS.played || r.flags === FLAGS.aborted);
                return {
                    turns: counted.reduce((sum, r) => sum + r.turns, 0),
                    stop: call.stop ?? "done",
                    summonSequence: 0,
                    uuidSequence: 7 + requests.length,
                };
            },
            rolloutPairs: () => last,
            scopeManifest: () => ({}),
        },
        flags: FLAGS,
        isRefusal: () => false,
        nowNs: () => 0n,
        refusal: () => null,
        exportState: () => "{}",
    };
    return { native, requests };
}

const bankInput = (overrides: Partial<INativeBankInput> = {}): INativeBankInput => ({
    actor: "actor",
    actingTeam: 1,
    candidates: [
        { kind: "incumbent", actions: [] },
        { kind: "melee", actions: [] },
    ],
    seedBase: 11,
    horizonMode: "turns",
    turnHorizon: 64,
    rolloutCount: 2,
    chance: "antithetic",
    leaf: { kind: "v2", exactTerminal: true },
    policies: { "1": { version: "v0.8" }, "2": { version: "v0.8" } },
    soleAbominationDefend: true,
    harness: { summonIds: "match", summonScope: "rollout", seed: 5 },
    start: { uuid: 3, summon: 9 },
    captureMaterial: false,
    turnLimit: null,
    turnsBefore: 0,
    deadlineAt: null,
    ...overrides,
});

describe("native rollout switch", () => {
    test("a notice the default logs goes to console.info, so tools that count console.error see nothing", () => {
        const info = console.info;
        const error = console.error;
        const seen: string[] = [];
        console.info = (...args: unknown[]) => void seen.push(`info ${args.join(" ")}`);
        console.error = (...args: unknown[]) => void seen.push(`error ${args.join(" ")}`);
        try {
            nativeRolloutLog("test-info-notice", "declined", "info");
            nativeRolloutLog("test-error-notice", "failed");
            nativeRolloutLog("test-error-notice", "failed again");
        } finally {
            console.info = info;
            console.error = error;
        }
        expect(seen).toEqual(["info [native-rollouts] declined", "error [native-rollouts] failed"]);
    });
    test("HOC_NATIVE_ROLLOUTS parses to off, on or shadow (unset is on), anything else stays off", () => {
        expect(nativeRolloutModeFromEnv(undefined)).toBe("on");
        expect(nativeRolloutModeFromEnv(" ")).toBe("on");
        expect(nativeRolloutModeFromEnv("0")).toBe("off");
        expect(nativeRolloutModeFromEnv("off")).toBe("off");
        expect(nativeRolloutModeFromEnv(" 1 ")).toBe("on");
        expect(nativeRolloutModeFromEnv("ON")).toBe("on");
        expect(nativeRolloutModeFromEnv("shadow")).toBe("shadow");
        expect(nativeRolloutModeFromEnv("yes")).toBe("off");
        expect(nativeShadowRateFromEnv(undefined)).toBe(1);
        expect(nativeShadowRateFromEnv("0.02")).toBe(0.02);
        expect(nativeShadowRateFromEnv("7")).toBe(1);
        expect(nativeShadowRateFromEnv("x")).toBe(1);
    });

    test("a driver built without the switch plays native banks; with 0 every bank stays in TypeScript", async () => {
        const previous = process.env.HOC_NATIVE_ROLLOUTS;
        try {
            const { SearchDriver } = await import("../../src/simulation/search_driver");
            delete process.env.HOC_NATIVE_ROLLOUTS;
            expect(new SearchDriver({} as never, {}).nativeRolloutStatistics.mode).toBe("on");
            process.env.HOC_NATIVE_ROLLOUTS = "0";
            const driver = new SearchDriver({} as never, {});
            expect(driver.nativeRolloutStatistics.mode).toBe("off");
            expect(driver.nativeRolloutStatistics.banks).toBe(0);
        } finally {
            if (previous === undefined) delete process.env.HOC_NATIVE_ROLLOUTS;
            else process.env.HOC_NATIVE_ROLLOUTS = previous;
        }
    });

    test("a driver without a native harness (a live bot seat) never asks for the library", async () => {
        const { SearchDriver } = await import("../../src/simulation/search_driver");
        const mode = process.env.HOC_NATIVE_ROLLOUTS;
        try {
            delete process.env.HOC_NATIVE_ROLLOUTS;
            const bank = (deps: object) => {
                const driver = new SearchDriver(deps as never, {});
                const internals = driver as unknown as {
                    nativeRoot: NativeRootScope | undefined;
                    scoreCandidatesInTypeScript(): number[];
                    scoreCandidatesWithNative(...args: unknown[]): number[];
                };
                internals.nativeRoot = new NativeRootScope("v0.8");
                internals.scoreCandidatesInTypeScript = () => [0.5];
                expect(internals.scoreCandidatesWithNative({}, [{}], 1, "turns", 2, null, 40, false)).toEqual([0.5]);
                return driver.nativeRolloutStatistics.fallback;
            };
            setNativeRolloutBackendForTests(undefined);
            expect(bank({})).toEqual({ no_native_harness: 1 });
            expect(nativeRolloutBackendRequested()).toBe(false);
            // with a harness the driver asks for the library (here: none)
            setNativeRolloutBackendForTests(null);
            expect(bank({ nativeHarness: { summonIds: "match", summonScope: "rollout" } })).toEqual({ no_library: 1 });
        } finally {
            setNativeRolloutBackendForTests(undefined);
            if (mode === undefined) delete process.env.HOC_NATIVE_ROLLOUTS;
            else process.env.HOC_NATIVE_ROLLOUTS = mode;
        }
    });

    test("the default needs a library built from this tree's own clean commit", () => {
        const sha = "0123456789abcdef0123456789abcdef01234567";
        // a clone's top level: --show-prefix is empty
        const tree = (head: string | null, status: string | null) => (args: string[]) =>
            args[1] === "--show-prefix" ? "" : args[0] === "rev-parse" ? head : status;
        expect(nativeDefaultTree(tree(sha, ""))).toEqual({ sha });
        expect(nativeDefaultTree(tree(sha, " M src/ai/versions/v0_5.ts"))).toEqual({
            reason: "the TypeScript tree has local changes under src/ or zig/",
        });
        expect(nativeDefaultTree(tree(null, ""))).toEqual({ reason: "the TypeScript tree is not a git checkout" });
        expect(nativeDefaultTree(tree("not-a-sha", ""))).toEqual({
            reason: "the TypeScript tree is not a git checkout",
        });
        expect(nativeDefaultTree(tree(sha, null))).toEqual({ reason: "git status failed" });
    });

    test("an installed package (bun's .bun-tag) gives its commit as a prefix; any other non-git tree stays off", () => {
        const notGit = () => null;
        expect(nativeDefaultTree(notGit, () => "o1dstaRs-heroes-of-crypto-common-19f3c39\n")).toEqual({
            shaPrefix: "19f3c39",
        });
        expect(nativeDefaultTree(notGit, () => "o1dstaRs-heroes-of-crypto-common")).toEqual({
            reason: "the TypeScript tree is not a git checkout",
        });
        expect(nativeDefaultTree(notGit, () => null)).toEqual({ reason: "the TypeScript tree is not a git checkout" });
        // a git checkout never reads the tag
        const sha = "0123456789abcdef0123456789abcdef01234567";
        expect(
            nativeDefaultTree(
                (args) => (args[1] === "--show-prefix" ? "" : args[0] === "rev-parse" ? sha : ""),
                () => "x-1234567",
            ),
        ).toEqual({ sha });
    });

    test("common installed inside another checkout (the server's node_modules) never takes that checkout's HEAD", () => {
        const serverHead = "fedcba9876543210fedcba9876543210fedcba98";
        const asked: string[][] = [];
        const insideServer = (args: string[]): string | null => {
            asked.push(args);
            if (args[1] === "--show-prefix") return "node_modules/@heroesofcrypto/common/";
            return args[0] === "rev-parse" ? serverHead : "";
        };
        expect(nativeDefaultTree(insideServer, () => "o1dstaRs-heroes-of-crypto-common-6e13087\n")).toEqual({
            shaPrefix: "6e13087",
        });
        expect(nativeDefaultTree(insideServer)).toEqual({
            reason: "the TypeScript tree is not its own git checkout (it is node_modules/@heroesofcrypto/common/ in another)",
        });
        // only the prefix is asked: neither the server's HEAD nor its status
        expect(asked.every((args) => args[1] === "--show-prefix")).toBe(true);
    });
});

describe("native rollout scope", () => {
    const profileEnvironment = (): Record<string, string | undefined> => {
        const environment: Record<string, string | undefined> = { PATH: "/bin", AI_AGENT: "tooling" };
        for (const [key, value] of Object.entries(buildV08A19SearchEnvironment())) {
            if (value !== undefined) environment[key] = value;
        }
        return environment;
    };

    test("the AI environment must be the A19 profile's", () => {
        const environment = profileEnvironment();
        expect(nativeEnvironmentRefusal(environment)).toBeNull();
        // the driver's own knobs, the root-only flyer priority and the search routing are not the rollout policy's
        expect(
            nativeEnvironmentRefusal({
                ...environment,
                SEARCH_ROLLOUTS: "8",
                V08_FLYER_BACKLINE_PRIORITY_LEFT: "0",
                V08_A19_SEARCH: "1",
            }),
        ).toBeNull();
        expect(nativeEnvironmentRefusal({ ...environment, V05_HOURGLASS: "off" })).toBe("env:V05_HOURGLASS");
        expect(nativeEnvironmentRefusal({ ...environment, A19_DECOY_AWARE_LEFT: "0" })).toBe(
            "env:A19_DECOY_AWARE_LEFT",
        );
        // B2's side channel is fed inside TypeScript rollouts, so it stays checked
        expect(nativeEnvironmentRefusal({ ...environment, B2_ORACLE: "1" })).toBe("env:B2_ORACLE");
    });

    test("root-only knobs (draft, setup, placement, the search root, the leaf, runner infrastructure) are not checked", () => {
        const environment = profileEnvironment();
        const unset = { ...environment };
        for (const key of ["V08_AGGRESSIVE", "V07_SEARCH", "Q2_ORACLE", "V07_PLACEMENT_REVEAL"]) delete unset[key];
        expect(nativeEnvironmentRefusal(unset)).toBeNull();
        expect(
            nativeEnvironmentRefusal({
                ...environment,
                A19_CARRIER_COHESION_LEFT: "0",
                A19_BARREL_ENGAGEMENT_ADVANCE_RIGHT: "1",
                A19_SPLIT_SCREEN_RIGHT: "0",
                A19_SHIELD_SCREEN_LEFT: "0",
                A19_CLOSE_SCREEN_RIGHT: "0",
                A19_COUNTER_DRAFT: "0",
                V05_DRAFT_WEIGHTS: "[1,2,3]",
                V05_PLACEMENT: "learned",
                V07_SETUP_CONDITIONAL: "1",
                Q2_DATASET: "/tmp/q2.jsonl",
                V07_ALIGNED_V2_NICE: "10",
                V08_AGGRESSIVE: "0",
            }),
        ).toBeNull();
    });

    test("switches read at one value only compare by meaning: unset and 0 are both off", () => {
        const environment = profileEnvironment();
        expect(environment.V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT).toBe("0");
        const unset = { ...environment };
        for (const key of [
            "V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT",
            "V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT",
            "V07_AURA_CASTER_ROUTER",
        ])
            delete unset[key];
        expect(nativeEnvironmentRefusal(unset)).toBeNull();
        expect(nativeEnvironmentRefusal({ ...environment, V08_SUPPORTED_BAND_ADVANCE: "off" })).toBeNull();
        expect(nativeEnvironmentRefusal({ ...environment, V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT: "1" })).toBe(
            "env:V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT",
        );
        expect(nativeEnvironmentRefusal({ ...environment, V07_AURA_CASTER_ROUTER: "on" })).toBe(
            "env:V07_AURA_CASTER_ROUTER",
        );
        // a VERSIONS scope is not a switch: unset (every version) and "" (none) differ
        const scope = { ...environment };
        delete scope.V08_SUPPORT_ROLE_VERSIONS;
        expect(nativeEnvironmentRefusal({ ...scope, V08_SUPPORT_ROLE_VERSIONS: "" })).toBe(
            "env:V08_SUPPORT_ROLE_VERSIONS",
        );
    });

    test("the ranged-positioning modes whose fire-wall checks the library does not port keep every bank in TypeScript", () => {
        // Band advance, pre-pin egress and protected advance project each route through burning cells
        // (v0_8_ranged_positioning.ts actorAvailableAfterRoute). The profile turns all three off, and the v0.8 scope takes
        // Fire Wall boards, so turning one on (or naming a version for it) must refuse the native policy.
        const environment = profileEnvironment();
        for (const mode of [
            "V08_SUPPORTED_BAND_ADVANCE",
            "V08_SUPPORTED_PREPIN_EGRESS",
            "V08_PROTECTED_ADVANCE_GUARDRAILS",
        ]) {
            expect(environment[mode]).toBe("0");
            expect(nativeEnvironmentRefusal({ ...environment, [mode]: "1" })).toBe(`env:${mode}`);
            expect(nativeEnvironmentRefusal({ ...environment, [`${mode}_VERSIONS`]: "v0.8" })).toBe(
                `env:${mode}_VERSIONS`,
            );
        }
    });

    test("a switch the library reads goes to it per team; its environment keys leave the check", () => {
        const environment = profileEnvironment();
        const read = new Set(["decoy_aware", "mage_damage_kill_priority"]);
        const ablated = { ...environment, A19_DECOY_AWARE_LEFT: "0", V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT: "1" };
        expect(nativeEnvironmentRefusal(ablated, read)).toBeNull();
        // with no read switches (an older library) the same keys refuse
        expect(nativeEnvironmentRefusal(ablated, new Set())).toBe("env:V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT");
        // a switch the library does not read keeps refusing
        expect(nativeEnvironmentRefusal({ ...environment, A19_COHERENT_MELEE_APPROACH_LEFT: "0" }, read)).toBe(
            "env:A19_COHERENT_MELEE_APPROACH_LEFT",
        );
        const previous = process.env.A19_DECOY_AWARE_RIGHT;
        process.env.A19_DECOY_AWARE_RIGHT = "0";
        try {
            const policies = nativeRequestPolicies({ "1": { version: "v0.8" }, "2": { version: "v0.1" } }, read, {
                V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT: "1",
            });
            // team 1 is RIGHT: its decoy filter is off, its mage kill priority on; the v0.1 team goes as it was
            expect(policies["1"]).toEqual({
                version: "v0.8",
                switches: { decoy_aware: false, mage_damage_kill_priority: true },
            });
            expect(policies["2"]).toEqual({ version: "v0.1" });
            expect(nativeRequestPolicies({ "1": { version: "v0.8" } }, new Set())).toEqual({
                "1": { version: "v0.8" },
            });
        } finally {
            if (previous === undefined) delete process.env.A19_DECOY_AWARE_RIGHT;
            else process.env.A19_DECOY_AWARE_RIGHT = previous;
        }
    });

    test("the Through Shot line switch is one key for both seats: off, or green (LEFT) / red (RIGHT) only", () => {
        const read = new Set(["through_shot_line"]);
        const environment = profileEnvironment();
        expect(nativeEnvironmentRefusal({ ...environment, V08_THROUGH_SHOT_LINE: "green" }, read)).toBeNull();
        expect(nativeEnvironmentRefusal({ ...environment, V08_THROUGH_SHOT_LINE: "off" }, new Set())).toBe(
            "env:V08_THROUGH_SHOT_LINE",
        );
        const previous = process.env.V08_THROUGH_SHOT_LINE;
        const teams = { "1": { version: "v0.8" as const }, "2": { version: "v0.8" as const } };
        const line = () => {
            const policies = nativeRequestPolicies(teams, read) as Record<string, { switches?: object }>;
            return [policies["1"].switches, policies["2"].switches];
        };
        try {
            delete process.env.V08_THROUGH_SHOT_LINE;
            expect(line()).toEqual([{ through_shot_line: true }, { through_shot_line: true }]);
            process.env.V08_THROUGH_SHOT_LINE = "off";
            expect(line()).toEqual([{ through_shot_line: false }, { through_shot_line: false }]);
            // team 1 is RIGHT (red), team 2 LEFT (green)
            process.env.V08_THROUGH_SHOT_LINE = "green";
            expect(line()).toEqual([{ through_shot_line: false }, { through_shot_line: true }]);
            process.env.V08_THROUGH_SHOT_LINE = "red";
            expect(line()).toEqual([{ through_shot_line: true }, { through_shot_line: false }]);
        } finally {
            if (previous === undefined) delete process.env.V08_THROUGH_SHOT_LINE;
            else process.env.V08_THROUGH_SHOT_LINE = previous;
        }
    });

    test("the release sets go per seat as lists of names; their keys leave the check only when read", () => {
        const read = new Set(["role_release", "protector_release"]);
        const environment = profileEnvironment();
        const released = {
            ...environment,
            V08_ROLE_RELEASE_LEFT: "healer_sustain",
            V08_PROTECTOR_RELEASE_RIGHT: "angel",
        };
        expect(nativeEnvironmentRefusal(released, read)).toBeNull();
        expect(nativeEnvironmentRefusal(released, new Set())).toMatch(
            /^env:V08_(ROLE|PROTECTOR)_RELEASE_(LEFT|RIGHT)$/,
        );
        const saved = [process.env.V08_ROLE_RELEASE_LEFT, process.env.V08_PROTECTOR_RELEASE_RIGHT];
        try {
            process.env.V08_ROLE_RELEASE_LEFT = "wandering_mage_smoke, healer_sustain";
            process.env.V08_PROTECTOR_RELEASE_RIGHT = "angel";
            const policies = nativeRequestPolicies({ "1": { version: "v0.8" }, "2": { version: "v0.8" } }, read);
            // team 1 is RIGHT, team 2 LEFT; names in V08_RELEASABLE_ROLES / V08_BACKLINE_PROTECTOR_KINDS order
            expect(policies["1"].switches).toEqual({ role_release: [], protector_release: ["angel"] });
            expect(policies["2"].switches).toEqual({
                role_release: ["healer_sustain", "wandering_mage_smoke"],
                protector_release: [],
            });
        } finally {
            if (saved[0] === undefined) delete process.env.V08_ROLE_RELEASE_LEFT;
            else process.env.V08_ROLE_RELEASE_LEFT = saved[0];
            if (saved[1] === undefined) delete process.env.V08_PROTECTOR_RELEASE_RIGHT;
            else process.env.V08_PROTECTOR_RELEASE_RIGHT = saved[1];
        }
    });

    test("only StrategyV0_8 (under the A19 placement layers) and StrategyV0_1 have a library policy", () => {
        const v08 = nativeTeamPolicy(createAIStrategy("v0.8"));
        expect(typeof v08).toBe("object");
        expect((v08 as { version: string }).version).toBe("v0.8");
        expect((v08 as { combat?: unknown }).combat).toBeInstanceOf(StrategyV0_8);
        expect(nativeTeamPolicy(new StrategyV0_8())).toEqual({ version: "v0.8", combat: expect.any(StrategyV0_8) });
        expect(nativeTeamPolicy(createAIStrategy("v0.1"))).toEqual({ version: "v0.1" });
        expect(nativeTeamPolicy(new StrategyV0_7())).toBe("policy:v0.7");
        class ResearchV08 extends StrategyV0_8 {}
        expect(nativeTeamPolicy(new ResearchV08())).toBe("policy:v0.8");
    });

    test("the leaf must be one of the library's", () => {
        expect(nativeLeafKind({ b: V08_A13_VALUE_LEAF.b, w: [...V08_A13_VALUE_LEAF.w] }, null)).toBe("v2");
        expect(nativeLeafKind({ b: V08_A13_VALUE_LEAF.b + 1e-9, w: [...V08_A13_VALUE_LEAF.w] }, null)).toBe(
            "leaf:v2_weights",
        );
        expect(nativeLeafKind(null, { b: DEFAULT_V07_VALUE_WEIGHTS.b, w: [...DEFAULT_V07_VALUE_WEIGHTS.w] })).toBe(
            "v1",
        );
        expect(nativeLeafKind(null, { b: 0, w: [1] })).toBe("leaf:v1_weights");
        expect(nativeLeafKind(null, null)).toBe("material");
    });
});

describe("native bank bookkeeping", () => {
    test("one live call: means, the -Infinity break and the uuid counter as scoreCandidates leaves them", () => {
        const { native, requests } = scriptedBackend([
            {
                records: [
                    pair(0.25),
                    pair(0.75),
                    pair(Number.NEGATIVE_INFINITY, 1),
                    pair(Number.NaN, 0, { flags: FLAGS.skippedIllegal }),
                ],
            },
        ]);
        const result = runNativeBank(native, { free: () => undefined }, bankInput());
        expect(result.means).toEqual([0.5, Number.NEGATIVE_INFINITY]);
        expect(result.stop).toBe("done");
        expect(result.turns).toBe(7);
        expect(result.uuid).toBe(8);
        expect(result.played).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0].pairs).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
        ]);
        expect(requests[0].summonSequence).toBe(9);
        expect(requests[0].uuidSequence).toBe(3);
        expect(requests[0].bank).toEqual({ skipAfterIllegal: true, summonScope: "rollout", material: false });
    });

    test("the request names the engine path only when the harness does", () => {
        const plain = scriptedBackend([{ records: [pair(0.5), pair(0.5), pair(0.5), pair(0.5)] }]);
        runNativeBank(plain.native, { free: () => undefined }, bankInput());
        expect("engine" in plain.requests[0]).toBe(false);
        expect(plain.requests[0].summonIds).toBe("match");

        const server = scriptedBackend([{ records: [pair(0.5), pair(0.5), pair(0.5), pair(0.5)] }]);
        runNativeBank(
            server.native,
            { free: () => undefined },
            bankInput({ harness: { summonIds: "uuidSequence", summonScope: "call", engine: "server" } }),
        );
        expect(server.requests[0].engine).toBe("server");
        expect(server.requests[0].summonIds).toBe("uuidSequence");
    });

    test("materials: the mean of the finite rollouts, -Infinity when a rollout was illegal", () => {
        const { native } = scriptedBackend([
            {
                records: [
                    pair(0.5, 2, { material: 0.4 }),
                    pair(0.5, 2, { material: 0.6 }),
                    pair(Number.NEGATIVE_INFINITY, 1),
                    pair(Number.NaN, 0, { flags: FLAGS.skippedIllegal }),
                ],
            },
        ]);
        const result = runNativeBank(native, { free: () => undefined }, bankInput({ captureMaterial: true }));
        expect(result.materials).toEqual([0.5, Number.NEGATIVE_INFINITY]);
    });

    test("bounded tails (offline): one call per candidate with the best finished mean as its reference", () => {
        const { native, requests } = scriptedBackend([
            { records: [pair(0.6), pair(0.8)] },
            { records: [pair(0.1), pair(Number.NaN, 0, { flags: FLAGS.skippedTail })] },
        ]);
        const result = runNativeBank(native, { free: () => undefined }, bankInput({ tails: { margin: 0.01 } }));
        expect(requests).toHaveLength(2);
        expect((requests[0].bank as { tailBound: unknown }).tailBound).toEqual({
            reference: null,
            margin: 0.01,
            rolloutCount: 2,
        });
        expect((requests[1].bank as { tailBound: { reference: number } }).tailBound.reference).toBeCloseTo(0.7, 12);
        // a candidate the tail bound stopped keeps TypeScript's partial mean (sum / R)
        expect(result.means).toEqual([0.7, 0.05]);
        expect(requests[1].uuidSequence).toBe(8);
    });

    test("the turn budget: a bank already past it stops before the next call, an aborted rollout stops the bank", () => {
        const aborted = scriptedBackend([
            { records: [pair(0.5, 4), pair(Number.NaN, 6, { flags: FLAGS.aborted })], stop: "turn_budget" },
        ]);
        const cut = runNativeBank(
            aborted.native,
            { free: () => undefined },
            bankInput({ turnLimit: 100, turnsBefore: 95 }),
        );
        expect(cut.stop).toBe("turn_budget");
        expect(cut.turns).toBe(10);
        expect((aborted.requests[0] as { turnBudget: number }).turnBudget).toBe(5);
        const past = scriptedBackend([]);
        const none = runNativeBank(
            past.native,
            { free: () => undefined },
            bankInput({ turnLimit: 100, turnsBefore: 101 }),
        );
        expect(none.stop).toBe("turn_budget");
        expect(past.requests).toHaveLength(0);
        expect(none.played).toBe(false);
    });

    test("shadow comparison: identical banks pass, any rollout difference is reported", () => {
        const { native } = scriptedBackend([{ records: [pair(0.25), pair(0.75), pair(0.5), pair(0.5)] }]);
        const result = runNativeBank(native, { free: () => undefined }, bankInput());
        const rollouts = [0.25, 0.75, 0.5, 0.5].map((value, i) => ({
            candidate: undefined,
            r: i % 2,
            value,
            aborted: false,
            turns: 3,
            uuid: 0,
            summon: 0,
            winner: -1,
        }));
        const same = compareNativeShadowBank(
            FLAGS,
            { means: [0.5, 0.5], threw: false, turns: 12, uuid: 8, rollouts },
            result,
            { summon: 0 },
            false,
        );
        expect(same.fails).toEqual([]);
        expect(same.rollouts).toBe(4);
        const other = compareNativeShadowBank(
            FLAGS,
            {
                means: [0.5, 0.5],
                threw: false,
                turns: 12,
                uuid: 8,
                rollouts: [{ ...rollouts[0], value: 0.3 }, ...rollouts.slice(1)],
            },
            result,
            { summon: 0 },
            false,
        );
        expect(other.rolloutMismatches).toBe(1);
        expect(other.fails.length).toBeGreaterThan(0);
    });

    test("shadow comparison under uuid naming: the library's own summon count is not compared", () => {
        // The server's harness names summons from the uuid sequence and keeps no summon counter, so TypeScript's
        // records hold the bank's start value while the library counts the summons its rollouts made.
        const records = [
            pair(0.25, 3, { summonSequence: 2 }),
            pair(0.75, 3, { summonSequence: 3 }),
            pair(0.5),
            pair(0.5),
        ];
        const rollouts = [0.25, 0.75, 0.5, 0.5].map((value, i) => ({
            candidate: undefined,
            r: i % 2,
            value,
            aborted: false,
            turns: 3,
            uuid: 0,
            summon: 0,
            winner: -1,
        }));
        const ts = { means: [0.5, 0.5], threw: false, turns: 12, uuid: 8, rollouts };
        const server = runNativeBank(
            scriptedBackend([{ records }]).native,
            { free: () => undefined },
            bankInput({ harness: { summonIds: "uuidSequence", summonScope: "call" } }),
        );
        expect(server.uuidNamed).toBe(true);
        expect(compareNativeShadowBank(FLAGS, ts, server, { summon: 0 }, false).fails).toEqual([]);
        const match = runNativeBank(scriptedBackend([{ records }]).native, { free: () => undefined }, bankInput());
        expect(match.uuidNamed).toBe(false);
        expect(compareNativeShadowBank(FLAGS, ts, match, { summon: 0 }, false).rolloutMismatches).toBe(2);
    });
});

describe("native root export", () => {
    const spec = (creatureName: string, level: number, amount: number): IArmyUnitSpec => {
        const entry = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
        if (!entry) throw new Error(`no ${creatureName} at level ${level}`);
        return {
            faction: entry.faction,
            creatureName: entry.creatureName,
            level: entry.level,
            size: entry.size,
            ...(entry.footprintWidth === undefined || entry.footprintHeight === undefined
                ? {}
                : { footprintWidth: entry.footprintWidth, footprintHeight: entry.footprintHeight }),
            amount,
        };
    };

    test("the state export only reads: a board that can summon leaves the random state as it was and exports again identically", async () => {
        // The exporter lives beside the library's parity tools, outside the type-checked tree, as the adapter loads it.
        const exporterPath = "../../zig/parity/state_export.ts";
        const { exportBattleState } = (await import(exporterPath)) as {
            exportBattleState(battle: object, harness?: object): unknown;
        };
        let checked = false;
        runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            // Infest (Arachna Queen) and Summon Wolves (Satyr): the export builds the Spider, Queen and Wolf templates.
            roster: [spec("Arachna Queen", 4, 1), spec("Satyr", 2, 4)],
            redRoster: [spec("Peasant", 1, 20)],
            seed: 7,
            maxLaps: 1,
            headlessEvents: true,
            beforeFightStart: (context) => {
                const before = captureDeterministicRandomState();
                const source = before.source;
                if (!source) throw new Error("expected runMatch's seeded source");
                let draws = 0;
                restoreDeterministicRandomState({
                    source: () => {
                        draws += 1;
                        return source();
                    },
                    uuidSequence: before.uuidSequence,
                });
                const harness = { uuidSequence: before.uuidSequence };
                const first = JSON.stringify(exportBattleState(context, harness));
                const second = JSON.stringify(exportBattleState(context, harness));
                const after = captureDeterministicRandomState();
                restoreDeterministicRandomState({ source, uuidSequence: after.uuidSequence });
                expect(first).toContain("summonTemplates");
                expect(second).toBe(first);
                expect(after.uuidSequence).toBe(before.uuidSequence);
                expect(draws).toBe(0);
                checked = true;
            },
        });
        expect(checked).toBe(true);
    });

    /** Counts the seeded source's draws and records the uuid sequence around `run` (the source stays the same). */
    const randomUse = (run: () => void): { draws: number; uuidBefore: number; uuidAfter: number } => {
        const before = captureDeterministicRandomState();
        const source = before.source;
        if (!source) throw new Error("expected a seeded source");
        let draws = 0;
        restoreDeterministicRandomState({
            source: () => {
                draws += 1;
                return source();
            },
            uuidSequence: before.uuidSequence,
        });
        try {
            run();
        } finally {
            const after = captureDeterministicRandomState();
            restoreDeterministicRandomState({ source, uuidSequence: after.uuidSequence });
        }
        return { draws, uuidBefore: before.uuidSequence, uuidAfter: captureDeterministicRandomState().uuidSequence };
    };

    test("the pre-check's summon templates leave the random state as they found it", async () => {
        // The pre-check lives beside the bridge, outside the type-checked tree, as the adapter loads it.
        const precheckPath = "../../zig/ffi/precheck.ts";
        const { compileHocPrecheck } = (await import(precheckPath)) as {
            compileHocPrecheck(manifest: unknown, policy: string | null): unknown;
        };
        const capacities = Object.fromEntries(
            [
                "units",
                "ids",
                "abilities",
                "stolen",
                "buffs",
                "debuffs",
                "effects",
                "spellEntries",
                "spells",
                "unitAuras",
                "auraDefs",
                "vines",
                "smoke",
                "fireWalls",
                "stones",
                "barrels",
                "lap",
                "possibleAttackTypes",
                "storedProperty",
            ].map((key) => [key, 64]),
        );
        const precheck = compileHocPrecheck(
            {
                scope: {
                    loader: {
                        abilities: [],
                        auraEffects: [],
                        applied: [],
                        spells: [],
                        spellEntryPrefixes: [],
                        spellFactions: [],
                        summons: [],
                        unitTypes: [],
                        teams: [],
                        footprint: [2, 2],
                        gridTypes: [],
                        stackingEffect: "",
                        storedPropertyBuffs: [],
                        artifacts: { tier1: [], tier2: [] },
                        artifactRows: { buffs: [], debuffs: [] },
                        capacities,
                        refuse: { unitPropsLimited: {}, unitFieldParts: [], fight: [], grid: [], artifactsPerTeam: [] },
                    },
                    policies: {},
                },
            },
            null,
        ) as { templateRefusal(creature: string, grid: unknown): string | null };
        let checked = false;
        runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster: [spec("Arachna Queen", 4, 1), spec("Satyr", 2, 4)],
            redRoster: [spec("Peasant", 1, 20)],
            seed: 11,
            maxLaps: 1,
            headlessEvents: true,
            beforeFightStart: (context) => {
                const use = randomUse(() => {
                    for (const creature of ["Arachna Spider", "Arachna Queen", "Wolf"])
                        precheck.templateRefusal(creature, context.grid);
                });
                expect(use.draws).toBe(0);
                expect(use.uuidAfter).toBe(use.uuidBefore);
                checked = true;
            },
        });
        expect(checked).toBe(true);
    });

    test("the backend's one-time load (bridge, self-test, manifests, pre-checks) leaves the random state alone", () => {
        const saved = captureDeterministicRandomState();
        const sentinels = process.env.HOC_NATIVE_SENTINELS;
        const mode = process.env.HOC_NATIVE_ROLLOUTS;
        try {
            restoreDeterministicRandomState({ source: makeRng(5), uuidSequence: 70 });
            // throw: a load with a side effect would fail, and the backend would stay off. Forced (1): the default's
            // commit guard would keep a working tree with local changes off.
            process.env.HOC_NATIVE_SENTINELS = "throw";
            process.env.HOC_NATIVE_ROLLOUTS = "1";
            setNativeRolloutBackendForTests(undefined);
            let loaded: unknown;
            const use = randomUse(() => {
                loaded = getNativeRolloutBackend();
            });
            expect(use.draws).toBe(0);
            expect(use.uuidAfter).toBe(use.uuidBefore);
            // Where a library is built here (zig build lib), the whole load ran and must have succeeded.
            const built = ["dylib", "so"].some((suffix) =>
                existsSync(new URL(`../../zig/zig-out/lib/libhocsim.${suffix}`, import.meta.url)),
            );
            if (built && !process.env.HOC_SIM_LIB) expect(loaded).not.toBeNull();
        } finally {
            setNativeRolloutBackendForTests(undefined);
            if (sentinels === undefined) delete process.env.HOC_NATIVE_SENTINELS;
            else process.env.HOC_NATIVE_SENTINELS = sentinels;
            if (mode === undefined) delete process.env.HOC_NATIVE_ROLLOUTS;
            else process.env.HOC_NATIVE_ROLLOUTS = mode;
            restoreDeterministicRandomState(saved);
        }
    });

    test("the export check catches a draw, a uuid step or a board change under HOC_NATIVE_SENTINELS", () => {
        const saved = captureDeterministicRandomState();
        const sentinels = process.env.HOC_NATIVE_SENTINELS;
        const battle = { unitsHolder: {}, grid: {}, fightProperties: {}, attackHandler: {} };
        const harness = { rng: 0, activeUnitId: "", uuidSequence: 0, summonSequence: 0, armyProfile: {} };
        let board = 0;
        const digest = (): string => String(board);
        try {
            restoreDeterministicRandomState({ source: makeRng(3), uuidSequence: 40 });
            // Without sentinels a failed export leaves the uuid sequence where it found it.
            delete process.env.HOC_NATIVE_SENTINELS;
            const failing = (): unknown => {
                createSecureUuid();
                throw new Error("export failed");
            };
            expect(() => exportWithoutSideEffects(failing, digest, battle, harness)).toThrow("export failed");
            expect(captureDeterministicRandomState().uuidSequence).toBe(40);

            process.env.HOC_NATIVE_SENTINELS = "throw";
            expect(exportWithoutSideEffects(() => ({ ok: 1 }), digest, battle, harness)).toBe('{"ok":1}');
            expect(() => exportWithoutSideEffects(() => createSecureUuid(), digest, battle, harness)).toThrow(
                "moved the uuid sequence 40 -> 41",
            );
            const draw = (): unknown => captureDeterministicRandomState().source?.();
            expect(() => exportWithoutSideEffects(draw, digest, battle, harness)).toThrow(
                "drew 1 values from the seeded source",
            );
            const mutate = (): unknown => (board += 1);
            expect(() => exportWithoutSideEffects(mutate, digest, battle, harness)).toThrow("changed the board");

            // Every root step is checked the same way; the message names the step.
            expect(() => rootStepWithoutSideEffects("precheck", () => createSecureUuid())).toThrow(
                "the precheck moved the uuid sequence",
            );

            // "count" counts it and still returns the export.
            process.env.HOC_NATIVE_SENTINELS = "count";
            const counted = nativeExportSideEffects();
            expect(exportWithoutSideEffects(mutate, digest, battle, harness)).toBe(String(board));
            expect(nativeExportSideEffects()).toBe(counted + 1);
        } finally {
            if (sentinels === undefined) delete process.env.HOC_NATIVE_SENTINELS;
            else process.env.HOC_NATIVE_SENTINELS = sentinels;
            restoreDeterministicRandomState(saved);
        }
    });
});

describe("native sample reuse", () => {
    test("keeps complete no-allocation samples under the exact board, policy, and candidate", () => {
        const cache = new NativeRolloutReuse();
        const wait = { kind: "wait", actions: [{ type: "wait_turn", unitId: "actor" }] };
        const defend = { kind: "defend", actions: [{ type: "defend_turn", unitId: "actor" }] };
        const remember = cache.prepare("root", "policy", [wait, defend], 2, true);
        expect(remember.hints).toEqual([]);

        const record: INativePairRecord = {
            flags: 0,
            turns: 41,
            value: 0.75,
            material: 0.65,
            uuidSequence: 7,
            summonSequence: 9,
            winner: -1,
        };
        remember.remember(
            [
                record,
                { ...record, uuidSequence: 8, summonSequence: 10 },
                { ...record, uuidSequence: 8, summonSequence: 10 },
                { ...record, flags: 2 },
            ],
            0,
            7,
            9,
        );

        expect(cache.prepare("root", "policy", [defend, wait], 3, true).hints).toEqual([
            [0, 8, 10, 41, 0.75, 0.65, -1],
            [3, 7, 9, 41, 0.75, 0.65, -1],
        ]);
        expect(cache.prepare("root", "policy", [{ ...wait, kind: "incumbent" }], 3, true).hints).toEqual([]);
        expect(cache.prepare("changed", "policy", [defend, wait], 3, true).hints).toEqual([]);
        expect(cache.prepare("root", "changed", [defend, wait], 3, true).hints).toEqual([]);
    });
});
