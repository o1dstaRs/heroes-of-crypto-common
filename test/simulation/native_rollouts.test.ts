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
import {
    compareNativeShadowBank,
    exportWithoutSideEffects,
    type INativeBankInput,
    type INativePairFlags,
    type INativePairRecord,
    type INativeRolloutBackend,
    nativeEnvironmentRefusal,
    nativeExportSideEffects,
    nativeLeafKind,
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
    test("HOC_NATIVE_ROLLOUTS parses to off, on or shadow, anything else stays off", () => {
        expect(nativeRolloutModeFromEnv(undefined)).toBe("off");
        expect(nativeRolloutModeFromEnv("0")).toBe("off");
        expect(nativeRolloutModeFromEnv(" 1 ")).toBe("on");
        expect(nativeRolloutModeFromEnv("ON")).toBe("on");
        expect(nativeRolloutModeFromEnv("shadow")).toBe("shadow");
        expect(nativeRolloutModeFromEnv("yes")).toBe("off");
        expect(nativeShadowRateFromEnv(undefined)).toBe(1);
        expect(nativeShadowRateFromEnv("0.02")).toBe(0.02);
        expect(nativeShadowRateFromEnv("7")).toBe(1);
        expect(nativeShadowRateFromEnv("x")).toBe(1);
    });

    test("a driver built without the switch keeps every bank in TypeScript", async () => {
        const previous = process.env.HOC_NATIVE_ROLLOUTS;
        delete process.env.HOC_NATIVE_ROLLOUTS;
        try {
            const { SearchDriver } = await import("../../src/simulation/search_driver");
            const driver = new SearchDriver({} as never, {});
            expect(driver.nativeRolloutStatistics.mode).toBe("off");
            expect(driver.nativeRolloutStatistics.banks).toBe(0);
        } finally {
            if (previous !== undefined) process.env.HOC_NATIVE_ROLLOUTS = previous;
        }
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
        const unset = { ...environment };
        delete unset.V08_AGGRESSIVE;
        expect(nativeEnvironmentRefusal(unset)).toBe("env:V08_AGGRESSIVE");
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
        try {
            restoreDeterministicRandomState({ source: makeRng(5), uuidSequence: 70 });
            // throw: a load with a side effect would fail, and the backend would stay off.
            process.env.HOC_NATIVE_SENTINELS = "throw";
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
