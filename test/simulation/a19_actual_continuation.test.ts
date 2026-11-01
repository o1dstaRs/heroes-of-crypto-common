import { beforeAll, expect, test } from "bun:test";
import {
    observeActualA19Match,
    selectActualContinuationPosition,
    type IActualContinuationPosition,
} from "../../src/simulation/a19_actual_continuation";
import { readA19AuditProfile } from "../../src/simulation/a19_decision_audit";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { rankedDraftBehaviorTraceSha256 } from "../../src/simulation/ranked_draft_eval";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import { makeRng } from "../../src/simulation/army";

const profile = readA19AuditProfile({
    search: `export const BOT_SEARCH_PRODUCTION_REVISION = "a19-material-r2-v1";
        const env = { a19: Object.freeze({ ...buildV08A19SearchEnvironment(),
            SEARCH_A19_MATERIAL_ARBITRATION: "ties", SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
            SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1", SEARCH_A19_ROLLOUT_ALLOCATION: "uniform" }) };`,
    draft: 'export const DEFAULT_RANKED_DRAFT_POLICY_SPEC = "ranked-unit-strength-a19-side-v4-w16-r4";',
    setup: "export const V08_RANKED_SETUP_POLICY_SPEC = `${ARTIFACT_FIT_SETUP_PREFIX_V6}conditional-v1:sniper+t2a19`;",
});
const config: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    roster: [
        { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 4 },
        { faction: "Nature", creatureName: "Wolf", level: 1, size: 1, amount: 4 },
    ],
    seed: 2730190011,
    gridType: 1,
    maxLaps: 32,
    searchOfflineDeterministicWork: true,
};
let observed: ReturnType<typeof observeActualA19Match>;
let root: IActualContinuationPosition;
beforeAll(() => {
    observed = observeActualA19Match(config, profile);
    root = observed.positions.find((position) => position.candidates.length > 1)!;
    expect(root).toBeDefined();
}, 60_000);

test("recording and the identity intervention preserve the complete real-engine match", () => {
    const plain = withScopedAIEnvironment({ V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, LIVETWIN: "1" }, () =>
        runMatch({ ...config, headlessEvents: true, researchA19BaseSearchEnvironment: profile.overrides }),
    );
    const replay = observeActualA19Match(config, profile, {
        captureAllPositions: false,
        featureOrdinal: root.ordinal,
        intervention: { position: root, actions: root.candidates[0].actions, combatSeed: null },
    });
    expect(rankedDraftBehaviorTraceSha256(observed.result)).toBe(rankedDraftBehaviorTraceSha256(plain));
    expect(rankedDraftBehaviorTraceSha256(replay.result)).toBe(rankedDraftBehaviorTraceSha256(plain));
    expect(replay.traceDigest).toBe(observed.traceDigest);
    expect(replay.interventionApplied).toBe(true);
    expect(replay.searchedTurnsAfterIntervention).toBeGreaterThan(0);
    expect(replay.positions[0].candidates.every((candidate) => candidate.features?.every(Number.isFinite))).toBe(true);
}, 60_000);

test("unchanged seeded actions preserve the native post-action state, target memory and RNG", () => {
    const memoryConfig: IMatchConfig = {
        ...config,
        roster: [
            { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 100 },
            { faction: "Nature", creatureName: "Wolf", level: 1, size: 1, amount: 50 },
        ],
        seed: 2233645795,
        gridType: 3,
        maxLaps: 8,
        sideOrientedPlacement: true,
    };
    const memoryRoot = observeActualA19Match(memoryConfig, profile).positions.find(
        (position) => position.ordinal === 2,
    )!;
    expect(memoryRoot).toBeDefined();
    const combatSeed = 2730190033;
    const postAction = (intervene: boolean) => {
        const choose = SearchDriver.prototype.chooseDecision;
        const random = captureDeterministicRandomState();
        const stop = {};
        let ordinal = 0;
        let deps: ILookaheadDeps | undefined;
        let state: unknown;
        SearchDriver.prototype.chooseDecision = function (...args) {
            const actions = choose.apply(this, args);
            if (ordinal++ === memoryRoot.ordinal) {
                deps = Reflect.get(this, "deps") as ILookaheadDeps;
                if (!intervene) setDeterministicRandomSource(makeRng(combatSeed));
            }
            return actions;
        };
        const input: IMatchConfig = {
            ...memoryConfig,
            headlessEvents: true,
            researchA19BaseSearchEnvironment: Object.fromEntries(
                Object.entries(profile.overrides).filter((entry): entry is [string, string] => entry[1] !== undefined),
            ),
            turnExecutionObserver: (turn) => {
                if (!deps || turn.unitId !== memoryRoot.actorId) return;
                const epoch = captureDeterministicRandomState();
                state = {
                    ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                    unitRefs: undefined,
                    damageStats: deps.captureDamageStats(),
                    uuidSequence: epoch.uuidSequence,
                    nextCombatDraws: Array.from({ length: 8 }, () => epoch.source!()),
                };
                throw stop;
            },
        };
        try {
            if (intervene) {
                observeActualA19Match(input, profile, {
                    captureAllPositions: false,
                    intervention: { position: memoryRoot, actions: memoryRoot.candidates[0].actions, combatSeed },
                });
            } else {
                withScopedAIEnvironment({ V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, LIVETWIN: "1" }, () =>
                    runMatch(input),
                );
            }
            throw new Error("Post-action witness was not reached");
        } catch (error) {
            if (error !== stop) throw error;
            return state;
        } finally {
            SearchDriver.prototype.chooseDecision = choose;
            restoreDeterministicRandomState(random);
        }
    };
    expect(postAction(true)).toEqual(postAction(false));
}, 60_000);

test("matched continuation seeds reproduce every action while later turns still use actual R2 search", () => {
    const intervention = { position: root, actions: root.candidates[1].actions, combatSeed: 2730190022 };
    const before = captureDeterministicRandomState();
    const first = observeActualA19Match(config, profile, { intervention, captureAllPositions: false });
    const second = observeActualA19Match(config, profile, { intervention, captureAllPositions: false });
    expect(first.traceDigest).toBe(second.traceDigest);
    expect(rankedDraftBehaviorTraceSha256(first.result)).toBe(rankedDraftBehaviorTraceSha256(second.result));
    expect(first.searchedTurnsAfterIntervention).toBeGreaterThan(0);
    expect(first.positions[0].prefixDigest).toBe(root.prefixDigest);
    expect(first.positions[0].stateDigest).toBe(root.stateDigest);
    expect(captureDeterministicRandomState()).toEqual(before);
}, 60_000);

test("prefix drift and unrecorded actions fail closed and restore the driver hooks", () => {
    const choose = SearchDriver.prototype.chooseDecision;
    const score = Reflect.get(SearchDriver.prototype, "scoreCandidates");
    const execute = (position: IActualContinuationPosition, actions = root.candidates[0].actions) =>
        observeActualA19Match(config, profile, {
            captureAllPositions: false,
            intervention: { position, actions, combatSeed: 41 },
        });
    expect(() => execute({ ...root, stateDigest: "wrong" })).toThrow("prefix drift");
    expect(() => execute(root, [{ type: "end_turn" }])).toThrow("outside the recorded");
    expect(SearchDriver.prototype.chooseDecision).toBe(choose);
    expect(Reflect.get(SearchDriver.prototype, "scoreCandidates")).toBe(score);
}, 60_000);

test("position selection uses phase/team/hash strata and is independent of input order and outcomes", () => {
    const positions = Array.from({ length: 18 }, (_, ordinal) => ({
        ordinal,
        team: ordinal % 2 ? RED_TEAM : GREEN_TEAM,
        lap: Math.floor(ordinal / 2) + 1,
        candidates: [{}, {}],
    })) as IActualContinuationPosition[];
    for (let board = 0; board < 24; board++) {
        const selected = selectActualContinuationPosition(positions, board, 927)!;
        expect(selectActualContinuationPosition([...positions].reverse(), board, 927)).toEqual(selected);
        expect(selected.team).toBe(board % 2 ? RED_TEAM : GREEN_TEAM);
        expect(selected.lap <= 2 ? 0 : selected.lap <= 5 ? 1 : 2).toBe(Math.floor(board / 3) % 3);
    }
    expect(selectActualContinuationPosition([{ ...positions[0], candidates: [] }], 0, 927)).toBeNull();
});

test("invalid runtime/seed settings are refused before touching engine hooks", () => {
    const choose = SearchDriver.prototype.chooseDecision;
    expect(() => observeActualA19Match({ ...config, searchOfflineDeterministicWork: false }, profile)).toThrow(
        "offline",
    );
    expect(() => observeActualA19Match(config, profile, { maxCandidates: 8 })).toThrow("cap");
    expect(() =>
        observeActualA19Match(config, profile, {
            intervention: { position: root, actions: [], combatSeed: -1 },
        }),
    ).toThrow("uint32");
    expect(SearchDriver.prototype.chooseDecision).toBe(choose);
});

test("an abstaining policy preserves native trajectories, action references, and caller randomness", () => {
    const choose = SearchDriver.prototype.chooseDecision;
    const random = captureDeterministicRandomState();
    for (const baseline of [false, true]) {
        let calls = 0;
        const replay = observeActualA19Match(config, profile, {
            captureAllPositions: false,
            policy: {
                team: GREEN_TEAM,
                select(position) {
                    expect(position.team).toBe(GREEN_TEAM);
                    expect(position.candidates.every((candidate) => candidate.features?.every(Number.isFinite))).toBe(
                        true,
                    );
                    calls++;
                    return baseline ? position.baselineSignature : undefined;
                },
            },
        });
        expect(calls).toBeGreaterThan(0);
        expect(replay.traceDigest).toBe(observed.traceDigest);
        expect(rankedDraftBehaviorTraceSha256(replay.result)).toBe(rankedDraftBehaviorTraceSha256(observed.result));
        expect(captureDeterministicRandomState()).toEqual(random);
        expect(SearchDriver.prototype.chooseDecision).toBe(choose);
    }
}, 60_000);

test("policy overrides use retained legal actions; callback faults and invented actions restore hooks", () => {
    const choose = SearchDriver.prototype.chooseDecision;
    const score = Reflect.get(SearchDriver.prototype, "scoreCandidates");
    let changed = false;
    const replay = observeActualA19Match(config, profile, {
        captureAllPositions: false,
        policy: {
            team: root.team,
            select(position) {
                if (!changed && position.candidates.length > 1) {
                    changed = true;
                    return position.candidates[1].signature;
                }
                return undefined;
            },
        },
    });
    expect(changed).toBe(true);
    expect(replay.traceDigest).not.toBe(observed.traceDigest);
    expect((replay.result.rejectedGreen ?? 0) + (replay.result.rejectedRed ?? 0)).toBe(0);
    expect(() =>
        observeActualA19Match(config, profile, {
            policy: {
                team: root.team,
                select() {
                    return "invented";
                },
            },
        }),
    ).toThrow("outside the recorded");
    expect(() =>
        observeActualA19Match(config, profile, {
            policy: {
                team: root.team,
                select() {
                    throw new Error("policy fault");
                },
            },
        }),
    ).toThrow("policy fault");
    expect(SearchDriver.prototype.chooseDecision).toBe(choose);
    expect(Reflect.get(SearchDriver.prototype, "scoreCandidates")).toBe(score);
}, 60_000);
