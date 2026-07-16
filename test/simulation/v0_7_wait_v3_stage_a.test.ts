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

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import {
    applyWaitScorerWeightsV3,
    parseWaitWeightsV3,
    v07WaitWeightsV3,
    WAIT_FEATURE_NAMES_V2,
    WAIT_FEATURE_NAMES_V2_RAW,
} from "../../src/ai/versions/wait_scorer";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import {
    parseWaitV3StageAFitterOutput,
    validateWaitV3StageARawShape,
} from "../../src/simulation/fit_v0_7_wait_v3_stage_a";
import {
    WAIT_V3_MIN_RANGE_FIRED_SEEDS,
    WAIT_V3_MIN_RANGE_HELDOUT_SEEDS,
} from "../../src/simulation/optimizer/wait_v3_gates";
import {
    WAIT_V3_STAGE_A_SENTINEL_JSON,
    WAIT_V3_STAGE_A_V2_JSON,
    expectedWaitV3StageASeed,
    findWaitV3StageASeedCollisions,
    plannedWaitV3StageASeeds,
    readWaitV3StageAManifest,
    validateWaitV3StageAGameArtifacts,
    validateWaitV3StageAManifest,
    waitV3StageAEnvironment,
    type IWaitV3StageAManifest,
    type IWaitV3StageARawReport,
} from "../../src/simulation/v0_7_wait_v3_stage_a";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const savedV2 = process.env.V07_WAIT_WEIGHTS_V2;
const savedV3 = process.env.V07_WAIT_WEIGHTS_V3;

afterEach(() => {
    if (savedV2 === undefined) delete process.env.V07_WAIT_WEIGHTS_V2;
    else process.env.V07_WAIT_WEIGHTS_V2 = savedV2;
    if (savedV3 === undefined) delete process.env.V07_WAIT_WEIGHTS_V3;
    else process.env.V07_WAIT_WEIGHTS_V3 = savedV3;
    v07WaitWeightsV3();
});

function cloneManifest(): IWaitV3StageAManifest {
    return JSON.parse(JSON.stringify(readWaitV3StageAManifest().manifest)) as IWaitV3StageAManifest;
}

class TestStrategyV0_7 extends StrategyV0_7 {
    public finalizeForTest(unit: Unit, context: IDecisionContext, incumbent: GameAction[]): GameAction[] {
        return this.finalizeDecision(unit, context, incumbent);
    }
}

function board(attackType: number): { actor: Unit; context: IDecisionContext; shot: GameAction[] } {
    const combat = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({ name: "Actor", team: LOWER, attackType, rangeShots: 5, speed: 4 });
    const ally = createTestUnit({ name: "Ally", team: LOWER, speed: 2 });
    const enemyA = createTestUnit({ name: "Enemy A", team: UPPER, speed: 3, amountAlive: 10 });
    const enemyB = createTestUnit({ name: "Enemy B", team: UPPER, speed: 5, amountAlive: 10 });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 3, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 5, y: 10 });
    fightProperties.setTeamUnitsAlive(LOWER, 2);
    fightProperties.setTeamUnitsAlive(UPPER, 2);
    return {
        actor,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        },
        shot: [{ type: "range_attack", attackerId: actor.getId(), targetId: enemyA.getId() }],
    };
}

function prime(strategy: StrategyV0_7, context: IDecisionContext): void {
    strategy.placeArmy(context.unitsHolder.getAllAllies(LOWER), {
        team: LOWER,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        pathHelper: context.pathHelper,
        placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
    });
}

describe("Wait V3 Stage-A frozen protocol", () => {
    it("freezes the four cohorts, exact incumbent hashes, material leaf, and collision-free streams", () => {
        const { manifest } = readWaitV3StageAManifest();
        expect(manifest.cohorts.map(({ id, games, baseSeed }) => [id, games, baseSeed])).toEqual([
            ["ranged_max", 4_000, 2_403_834_848],
            ["pure_ranged", 4_000, 3_575_244_398],
            ["hybrid", 2_000, 372_222_176],
            ["random_draft", 2_000, 3_566_425_037],
        ]);
        expect(manifest.oracle.leaf).toBe("material");
        expect(manifest.incumbent.v2WeightsSha256).toBe(
            new Bun.CryptoHasher("sha256").update(WAIT_V3_STAGE_A_V2_JSON).digest("hex"),
        );
        expect(manifest.incumbent.v3SentinelSha256).toBe(
            new Bun.CryptoHasher("sha256").update(WAIT_V3_STAGE_A_SENTINEL_JSON).digest("hex"),
        );
        const seeds = plannedWaitV3StageASeeds(manifest);
        expect(seeds.size).toBe(6_000);
        expect(findWaitV3StageASeedCollisions(manifest, [])).toEqual([]);
        const first = expectedWaitV3StageASeed(manifest.cohorts[0], 0);
        expect(findWaitV3StageASeedCollisions(manifest, [first])).toEqual([first]);
    });

    it("fails closed on vector, cohort, seed, or held-out gate drift", () => {
        const weights = cloneManifest();
        weights.incumbent.v2WeightsSha256 = "0".repeat(64);
        expect(() => validateWaitV3StageAManifest(weights)).toThrow("V2 incumbent hash mismatch");

        const seed = cloneManifest();
        seed.cohorts[0].baseSeed += 1;
        expect(() => validateWaitV3StageAManifest(seed)).toThrow("cohorts, sizes, or seeds");

        const gates = cloneManifest();
        gates.heldoutGates.rangeSeedsMin = 32;
        expect(() => validateWaitV3StageAManifest(gates)).toThrow("held-out gates drifted");
    });

    it("pins a material oracle and strips ambient behavior knobs", () => {
        const environment = waitV3StageAEnvironment({
            PATH: "/bin",
            V07_WAIT_WEIGHTS_V2: "ambient",
            V07_WAIT_WEIGHTS_V3: "ambient",
            V07_VALUE_WEIGHTS: "ambient",
            SEARCH_MODE: "ambient",
            FORCE_CREATURES: "ambient",
        });
        expect(environment.PATH).toBe("/bin");
        expect(environment.V07_WAIT_WEIGHTS_V2).toBe(WAIT_V3_STAGE_A_V2_JSON);
        expect(environment.V07_WAIT_WEIGHTS_V3).toBe(WAIT_V3_STAGE_A_SENTINEL_JSON);
        expect(environment.V07_VALUE_WEIGHTS).toBe("material");
        expect(environment.SEARCH_VERSIONS).toBe("v0.7");
        expect(environment.Q2_DATASET_V2).toBe("1");
        expect(environment.FORCE_CREATURES).toBeUndefined();
    });
});

describe("Wait V3 Stage-A nonfiring sentinel", () => {
    it("is active, never fires, and suppresses V2 only on the RANGE-owned strategy seam", () => {
        const sentinel = parseWaitWeightsV3(WAIT_V3_STAGE_A_SENTINEL_JSON);
        expect(sentinel).not.toBeNull();
        expect(sentinel!.b).toBe(-1);
        expect(sentinel!.w).toHaveLength(125);
        expect(sentinel!.w.every((weight) => weight === 0)).toBe(true);

        const ranged = board(PBTypes.AttackVals.RANGE);
        const strategy = new TestStrategyV0_7();
        prime(strategy, ranged.context);
        process.env.V07_WAIT_WEIGHTS_V2 = JSON.stringify({
            b: 5,
            w: new Array(WAIT_FEATURE_NAMES_V2.length).fill(0),
        });
        delete process.env.V07_WAIT_WEIGHTS_V3;
        expect(strategy.finalizeForTest(ranged.actor, ranged.context, ranged.shot)).toEqual([
            { type: "wait_turn", unitId: ranged.actor.getId() },
        ]);

        process.env.V07_WAIT_WEIGHTS_V3 = WAIT_V3_STAGE_A_SENTINEL_JSON;
        expect(v07WaitWeightsV3()).toEqual(sentinel);
        expect(applyWaitScorerWeightsV3(ranged.actor, ranged.context, ranged.shot, sentinel)).toBe(ranged.shot);
        expect(strategy.finalizeForTest(ranged.actor, ranged.context, ranged.shot)).toBe(ranged.shot);

        const melee = board(PBTypes.AttackVals.MELEE);
        const meleeStrategy = new TestStrategyV0_7();
        prime(meleeStrategy, melee.context);
        expect(meleeStrategy.finalizeForTest(melee.actor, melee.context, melee.shot)).toEqual([
            { type: "wait_turn", unitId: melee.actor.getId() },
        ]);
    });
});

describe("Wait V3 Stage-A fail-closed artifacts", () => {
    it("requires exact Q2/audit completeness and zero oracle wait rejections", () => {
        const directory = mkdtempSync(join(tmpdir(), "wait-v3-stage-a-"));
        try {
            const { manifest } = readWaitV3StageAManifest();
            const cohort = manifest.cohorts[0];
            const fingerprint = "a".repeat(64);
            const seed = expectedWaitV3StageASeed(cohort, 0);
            const stem = "00000";
            const q2Path = join(directory, "raw", cohort.id, `${stem}.q2.jsonl`);
            const auditPath = join(directory, "audit", cohort.id, `${stem}.audit.jsonl`);
            const resultPath = join(directory, "games", cohort.id, `${stem}.json`);
            for (const path of [q2Path, auditPath, resultPath]) mkdirSync(dirname(path), { recursive: true });
            const q2 = {
                t: "q2d",
                v: 2,
                runFingerprint: fingerprint,
                seed,
                greenVersion: "v0.7",
                redVersion: "v0.6",
                lap: 1,
                unit: "Arbalester",
                incumbentKind: "shot",
                incumbentWait: 0,
                incumbentIllegal: 0,
                waitRejected: 0,
                label: 1,
                delta: 0.02,
                features: new Array(WAIT_FEATURE_NAMES_V2_RAW.length).fill(0),
                oracle: { gate: 0.01, rollouts: 3, horizon: "lap", leaf: "material", opponentModel: null },
            };
            const audit = {
                t: "game",
                mode: "oracle",
                seed,
                green: "v0.7",
                red: "v0.6",
                winner: "green",
                endReason: "elimination",
                gate: 0.01,
                horizon: "lap",
                rollouts: 3,
                leaf: "material",
                decisions: 1,
                q2oPoints: 1,
                q2oScored: 1,
                q2oIncumbentWait: 0,
                q2oWaitRejected: 0,
            };
            writeFileSync(q2Path, `${JSON.stringify(q2)}\n`);
            writeFileSync(auditPath, `${JSON.stringify(audit)}\n`);
            writeFileSync(
                resultPath,
                `${JSON.stringify({
                    schemaVersion: 1,
                    runFingerprint: fingerprint,
                    cohort: cohort.id,
                    game: 0,
                    seed,
                    greenVersion: "v0.7",
                    redVersion: "v0.6",
                    winner: "green",
                    endReason: "elimination",
                    laps: 1,
                    decidedByArmageddon: false,
                    rejectedGreen: 0,
                    rejectedRed: 0,
                })}\n`,
            );
            expect(validateWaitV3StageAGameArtifacts(directory, manifest, cohort, 0, fingerprint).scoredRows).toBe(1);

            writeFileSync(auditPath, `${JSON.stringify({ ...audit, q2oWaitRejected: 1 })}\n`);
            expect(() => validateWaitV3StageAGameArtifacts(directory, manifest, cohort, 0, fingerprint)).toThrow(
                "wait rejection tripwire",
            );
            writeFileSync(auditPath, `${JSON.stringify(audit)}\n`);
            writeFileSync(q2Path, "");
            expect(() => validateWaitV3StageAGameArtifacts(directory, manifest, cohort, 0, fingerprint)).toThrow(
                "expected 1 Q2 rows",
            );
            writeFileSync(q2Path, `${JSON.stringify(q2)}\n`);
            const rejectedResult = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
            writeFileSync(resultPath, `${JSON.stringify({ ...rejectedResult, rejectedGreen: 1 })}\n`);
            expect(() => validateWaitV3StageAGameArtifacts(directory, manifest, cohort, 0, fingerprint)).toThrow(
                "nonzero engine rejection",
            );
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("accepts a fitter model only after the literal stronger V3 gate passes", () => {
        expect(WAIT_V3_MIN_RANGE_HELDOUT_SEEDS).toBe(256);
        expect(WAIT_V3_MIN_RANGE_FIRED_SEEDS).toBe(32);
        const model = JSON.stringify({ b: 1, w: new Array(125).fill(0) });
        const prefix = "V07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100): ";
        expect(parseWaitV3StageAFitterOutput(`V3 GATE: PASS\n${prefix}${model}\n`)).toEqual(JSON.parse(model));
        expect(() => parseWaitV3StageAFitterOutput(`${prefix}${model}\n`)).toThrow("exactly one literal");
        const zero = JSON.stringify({ b: 0, w: new Array(125).fill(0) });
        expect(() => parseWaitV3StageAFitterOutput(`V3 GATE: PASS\n${prefix}${zero}\n`)).toThrow("all zero");
    });

    it("rejects duplicate, partial, or falsely totalled raw cohort envelopes", () => {
        const { manifest } = readWaitV3StageAManifest();
        const report = {
            schemaVersion: 1,
            kind: "v0.7_wait_v3_stage_a_raw",
            verdict: "PASS",
            generatedAt: "2026-07-16T00:00:00.000Z",
            runFingerprint: "a".repeat(64),
            protocolSha256: "b".repeat(64),
            runManifestSha256: "c".repeat(64),
            games: 12_000,
            q2Rows: 4,
            cohorts: manifest.cohorts.map((cohort) => ({
                id: cohort.id,
                games: cohort.games,
                q2Rows: 1,
                q2ScoredRows: 1,
                q2WaitRejected: 0,
                q2Path: `${cohort.id}.q2`,
                q2Bytes: 1,
                q2Sha256: "d".repeat(64),
                auditPath: `${cohort.id}.audit`,
                auditBytes: 1,
                auditSha256: "e".repeat(64),
                gamesPath: `${cohort.id}.games`,
                gamesBytes: 1,
                gamesSha256: "f".repeat(64),
            })),
        } satisfies IWaitV3StageARawReport;
        expect(() => validateWaitV3StageARawShape(manifest, report)).not.toThrow();

        const duplicate = structuredClone(report);
        duplicate.cohorts[3].id = duplicate.cohorts[0].id;
        expect(() => validateWaitV3StageARawShape(manifest, duplicate)).toThrow("must appear exactly once");

        const partial = structuredClone(report);
        partial.cohorts[0].games -= 2;
        expect(() => validateWaitV3StageARawShape(manifest, partial)).toThrow("!= frozen");

        const falseTotal = structuredClone(report);
        falseTotal.q2Rows += 1;
        expect(() => validateWaitV3StageARawShape(manifest, falseTotal)).toThrow("differ from cohort sums");
    });
});
