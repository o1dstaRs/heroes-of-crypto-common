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

import { afterEach, describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import {
    applyWaitScorer,
    applyWaitScorerWeightsV2,
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    expandWaitFeaturesV2,
    extractWaitFeatures,
    extractWaitFeaturesV2Raw,
    incumbentRuleWaits,
    parseWaitWeights,
    parseWaitWeightsV2,
    v07WaitWeightsV2,
    WAIT_FEATURE_NAMES,
    WAIT_FEATURE_NAMES_V2,
    WAIT_FEATURE_NAMES_V2_RAW,
    waitScore,
    waitScorerInSupport,
} from "../../src/ai/versions/wait_scorer";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { extractValueFeatures } from "../../src/simulation/value_features";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

const ENV_KEYS = [
    "V07_WAIT_SCORER",
    "V07_WAIT_WEIGHTS",
    "V07_WAIT_VERSIONS",
    "V07_WAIT_WEIGHTS_B",
    "V07_WAIT_VERSIONS_B",
    "V07_WAIT_GUARD",
    "V07_WAIT_WEIGHTS_V2",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
}
const setEnv = (patch: Record<string, string | undefined>): void => {
    for (const k of ENV_KEYS) {
        const v = k in patch ? patch[k] : undefined;
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
};
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
});

interface Board {
    combat: CombatTestContext;
    context: IDecisionContext;
    actor: Unit;
    ally: Unit;
    enemyA: Unit;
    enemyB: Unit;
    charge: GameAction[];
}

/** 2v2 board with hourglass-eligible LOWER actor and a melee-CHARGE incumbent (path present). */
function buildBoard(
    actorOptions: Parameters<typeof createTestUnit>[0] = {},
    allyOptions: Parameters<typeof createTestUnit>[0] = {},
): Board {
    const combat = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({ name: "Actor", team: LOWER, speed: 4, ...actorOptions });
    const ally = createTestUnit({ name: "Ally", team: LOWER, speed: 2, ...allyOptions });
    const enemyA = createTestUnit({ name: "Enemy A", team: UPPER, speed: 3 });
    const enemyB = createTestUnit({ name: "Enemy B", team: UPPER, speed: 5 });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 3, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 5, y: 10 });
    fightProperties.setTeamUnitsAlive(LOWER, 2);
    fightProperties.setTeamUnitsAlive(UPPER, 2);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
    };
    const charge: GameAction[] = [
        {
            type: "melee_attack",
            attackerId: actor.getId(),
            targetId: enemyA.getId(),
            attackFrom: { x: 3, y: 9 },
            path: [
                { x: 3, y: 4 },
                { x: 3, y: 5 },
            ],
        },
    ];
    return { combat, context, actor, ally, enemyA, enemyB, charge };
}

const fp = () => FightStateManager.getInstance().getFightProperties();
const zeros = () => JSON.stringify({ b: 0, w: new Array(WAIT_FEATURE_NAMES.length).fill(0) });
const biasOnly = (b: number) => JSON.stringify({ b, w: new Array(WAIT_FEATURE_NAMES.length).fill(0) });

describe("wait scorer — features", () => {
    it("emits one value per WAIT_FEATURE_NAMES and prefixes the 20 LiveTwin value features unchanged", () => {
        const { context, actor, charge } = buildBoard();
        const f = extractWaitFeatures(actor, context.unitsHolder, fp(), charge);
        expect(f).toHaveLength(WAIT_FEATURE_NAMES.length);
        const value = extractValueFeatures(context.unitsHolder, fp(), actor.getTeam());
        expect(f.slice(0, value.length)).toEqual(value);
        expect(f.every((x) => Number.isFinite(x))).toBe(true);
    });

    it("is pure and deterministic at the same decision point", () => {
        const { context, actor, charge } = buildBoard();
        const first = extractWaitFeatures(actor, context.unitsHolder, fp(), charge);
        const second = extractWaitFeatures(actor, context.unitsHolder, fp(), charge);
        expect(second).toEqual(first);
    });

    it("sets the unit-class flags from the acting unit", () => {
        const at = (names: string[], f: number[]): number[] => names.map((n) => f[WAIT_FEATURE_NAMES.indexOf(n)]);
        const flags = ["isMelee", "isRanged", "isCaster", "isFlyer"];
        const melee = buildBoard();
        expect(at(flags, extractWaitFeatures(melee.actor, melee.context.unitsHolder, fp(), melee.charge))).toEqual([
            1, 0, 0, 0,
        ]);
        const ranged = buildBoard({ attackType: RANGE, rangeShots: 5 });
        expect(at(flags, extractWaitFeatures(ranged.actor, ranged.context.unitsHolder, fp(), ranged.charge))).toEqual([
            0, 1, 0, 0,
        ]);
        const casterFlyer = buildBoard({ attackType: MELEE_MAGIC, movementType: PBTypes.MovementVals.FLY });
        expect(
            at(
                flags,
                extractWaitFeatures(casterFlyer.actor, casterFlyer.context.unitsHolder, fp(), casterFlyer.charge),
            ),
        ).toEqual([1, 0, 1, 1]);
    });

    it("fmExposure is the v0.5 measure: living enemies without a made turn / living enemies", () => {
        const { context, actor, enemyA, charge } = buildBoard();
        const fmIdx = WAIT_FEATURE_NAMES.indexOf("fmExposure");
        expect(extractWaitFeatures(actor, context.unitsHolder, fp(), charge)[fmIdx]).toBe(1);
        fp().addAlreadyMadeTurn(UPPER, enemyA.getId());
        expect(extractWaitFeatures(actor, context.unitsHolder, fp(), charge)[fmIdx]).toBe(0.5);
    });

    it("incRuleWait mirrors the incumbent hourglass rule: charge + fm>=0.67 + eligible melee only", () => {
        const board = buildBoard();
        const { context, actor, enemyA, enemyB, charge } = board;
        expect(incumbentRuleWaits(actor, context.unitsHolder, fp(), charge)).toBe(true);
        // in-place strike (no path) is not a charge
        const inPlace: GameAction[] = [
            { type: "melee_attack", attackerId: actor.getId(), targetId: enemyA.getId(), attackFrom: { x: 3, y: 3 } },
        ];
        expect(incumbentRuleWaits(actor, context.unitsHolder, fp(), inPlace)).toBe(false);
        // fm below 0.67 -> act
        fp().addAlreadyMadeTurn(UPPER, enemyA.getId());
        expect(incumbentRuleWaits(actor, context.unitsHolder, fp(), charge)).toBe(false);
        fp().addAlreadyMadeTurn(UPPER, enemyB.getId());
        expect(incumbentRuleWaits(actor, context.unitsHolder, fp(), charge)).toBe(false);
        // ranged units are excluded from the incumbent rule
        const ranged = buildBoard({ attackType: RANGE, rangeShots: 5 });
        expect(incumbentRuleWaits(ranged.actor, ranged.context.unitsHolder, fp(), ranged.charge)).toBe(false);
    });

    it("canWaitOnHourglassMirror matches the oracle's eligibility predicate", () => {
        const { actor } = buildBoard();
        expect(canWaitOnHourglassMirror(actor, fp())).toBe(true);
        fp().addAlreadyMadeTurn(LOWER, actor.getId());
        expect(canWaitOnHourglassMirror(actor, fp())).toBe(false);
    });
});

describe("wait scorer — anchored gate (byte-identical incumbent behavior unless armed)", () => {
    it("returns the exact incumbent reference with the env unset", () => {
        setEnv({});
        const { context, actor, charge } = buildBoard();
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
    });

    it("returns the exact incumbent reference with the gate on but weights absent, malformed or all-zero", () => {
        const { context, actor, charge } = buildBoard();
        setEnv({ V07_WAIT_SCORER: "on" });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: "{malformed" });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: JSON.stringify({ b: 1, w: [1, 2] }) });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge); // wrong width -> anchor
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: zeros() });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
    });

    it("is version-scoped: default V07_WAIT_VERSIONS is the v0.6s A/B alias only", () => {
        const { context, actor, charge } = buildBoard();
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toBe(charge);
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5), V07_WAIT_VERSIONS: "v0.6,v0.6s" });
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toEqual([{ type: "wait_turn", unitId: actor.getId() }]);
    });

    it("second scope: V07_WAIT_VERSIONS_B/WEIGHTS_B carries a DIFFERENT weight set for weight-vs-weight A/Bs", () => {
        const { context, actor, charge } = buildBoard();
        // inert by default: no B scope -> versions outside the primary scope stay anchored
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toBe(charge);
        // armed: v0.6s waits on the primary weights while v0.6 acts on the B weights (and vice versa)
        setEnv({
            V07_WAIT_SCORER: "on",
            V07_WAIT_WEIGHTS: biasOnly(5),
            V07_WAIT_VERSIONS_B: "v0.6",
            V07_WAIT_WEIGHTS_B: biasOnly(-5),
        });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toBe(charge);
        setEnv({
            V07_WAIT_SCORER: "on",
            V07_WAIT_WEIGHTS: biasOnly(-5),
            V07_WAIT_VERSIONS_B: "v0.6",
            V07_WAIT_WEIGHTS_B: biasOnly(5),
        });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toEqual([{ type: "wait_turn", unitId: actor.getId() }]);
        // the primary scope wins on overlap, and B-scope weights keep the anchor semantics (all-zero ⇒ off)
        setEnv({
            V07_WAIT_SCORER: "on",
            V07_WAIT_WEIGHTS: biasOnly(5),
            V07_WAIT_VERSIONS_B: "v0.6s,v0.6",
            V07_WAIT_WEIGHTS_B: biasOnly(-5),
        });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
        setEnv({
            V07_WAIT_SCORER: "on",
            V07_WAIT_WEIGHTS: biasOnly(-5),
            V07_WAIT_VERSIONS_B: "v0.6",
            V07_WAIT_WEIGHTS_B: zeros(),
        });
        expect(applyWaitScorer(actor, context, charge, "v0.6")).toBe(charge);
    });

    it("armed: overrides an eligible act to a lone hourglass wait iff z > 0", () => {
        const { context, actor, charge } = buildBoard();
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(0.01) });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(-0.01) });
        expect(applyWaitScorer(actor, context, charge, "v0.6s")).toBe(charge);
    });

    it("armed: keeps a policy wait untouched (the oracle's degenerate {wait, wait} handling)", () => {
        const { context, actor } = buildBoard();
        const policyWait: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(-5) });
        expect(applyWaitScorer(actor, context, policyWait, "v0.6s")).toBe(policyWait);
    });

    it("armed: never fires at a wait-ineligible point (made turn / already hourglassed / last stack)", () => {
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        const made = buildBoard();
        fp().addAlreadyMadeTurn(LOWER, made.actor.getId());
        expect(applyWaitScorer(made.actor, made.context, made.charge, "v0.6s")).toBe(made.charge);
        const parked = buildBoard();
        fp().enqueueHourglass(parked.actor.getId());
        expect(applyWaitScorer(parked.actor, parked.context, parked.charge, "v0.6s")).toBe(parked.charge);
        const lone = buildBoard();
        fp().setTeamUnitsAlive(LOWER, 1);
        expect(applyWaitScorer(lone.actor, lone.context, lone.charge, "v0.6s")).toBe(lone.charge);
    });

    it("training-support guard: a RANGE actor keeps the exact incumbent even at z > 0", () => {
        const ranged = buildBoard({ attackType: RANGE, rangeShots: 5 });
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        expect(canWaitOnHourglassMirror(ranged.actor, fp())).toBe(true);
        expect(applyWaitScorer(ranged.actor, ranged.context, ranged.charge, "v0.6s")).toBe(ranged.charge);
        // V07_WAIT_GUARD=off reproduces the unguarded pre-fix scorer (the ranged-collapse configuration)
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5), V07_WAIT_GUARD: "off" });
        expect(applyWaitScorer(ranged.actor, ranged.context, ranged.charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: ranged.actor.getId() },
        ]);
    });

    it("training-support guard: 'support' also requires a majority melee-attack-type own army", () => {
        // melee actor + ranged ally -> melee is 1 of 2 own stacks: NOT a majority -> out of support
        const mixed = buildBoard({}, { attackType: RANGE, rangeShots: 5 });
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        expect(waitScorerInSupport(mixed.actor, mixed.context.unitsHolder)).toBe(false);
        expect(applyWaitScorer(mixed.actor, mixed.context, mixed.charge, "v0.6s")).toBe(mixed.charge);
        // the class-only arm keeps firing on melee units regardless of army composition
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5), V07_WAIT_GUARD: "class" });
        expect(waitScorerInSupport(mixed.actor, mixed.context.unitsHolder)).toBe(true);
        expect(applyWaitScorer(mixed.actor, mixed.context, mixed.charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: mixed.actor.getId() },
        ]);
        // an all-melee army is in support in every guarded mode (the training distribution)
        const melee = buildBoard();
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: biasOnly(5) });
        expect(waitScorerInSupport(melee.actor, melee.context.unitsHolder)).toBe(true);
        expect(applyWaitScorer(melee.actor, melee.context, melee.charge, "v0.6s")).toEqual([
            { type: "wait_turn", unitId: melee.actor.getId() },
        ]);
    });

    it("training-support guard: unit-class support is MELEE and MELEE_MAGIC only (MAGIC had zero fit rows)", () => {
        const meleeMagic = buildBoard({ attackType: MELEE_MAGIC });
        expect(waitScorerInSupport(meleeMagic.actor, meleeMagic.context.unitsHolder)).toBe(true);
        const magic = buildBoard({ attackType: PBTypes.AttackVals.MAGIC });
        expect(waitScorerInSupport(magic.actor, magic.context.unitsHolder)).toBe(false);
        const ranged = buildBoard({ attackType: RANGE, rangeShots: 5 });
        expect(waitScorerInSupport(ranged.actor, ranged.context.unitsHolder)).toBe(false);
        // an unknown V07_WAIT_GUARD value falls back to the default "support" mode, never "off"
        setEnv({ V07_WAIT_GUARD: "banana" });
        expect(waitScorerInSupport(ranged.actor, ranged.context.unitsHolder)).toBe(false);
    });

    it("the committed SHIP weights are width-aligned, non-anchor and round-trip through the env parser", () => {
        const parsed = parseWaitWeights(JSON.stringify(DISTILLED_WAIT_WEIGHTS_2026_07_10));
        expect(parsed).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10);
        expect(parsed!.w).toHaveLength(WAIT_FEATURE_NAMES.length);
        expect(parsed!.b !== 0 || parsed!.w.some((x) => x !== 0)).toBe(true);
    });

    it("waitScore is the plain linear form b + w·f used by the fit", () => {
        const weights = parseWaitWeights(
            JSON.stringify({ b: 0.5, w: WAIT_FEATURE_NAMES.map((_, i) => (i === 0 ? 2 : 0)) }),
        );
        expect(weights).not.toBeNull();
        const f = new Array(WAIT_FEATURE_NAMES.length).fill(0);
        f[0] = 0.25;
        expect(waitScore(weights!, f)).toBeCloseTo(1.0, 10);
    });
});

describe("wait scorer V2 (Phase-B multi-cohort env candidate)", () => {
    const zerosV2 = () => JSON.stringify({ b: 0, w: new Array(WAIT_FEATURE_NAMES_V2.length).fill(0) });
    const biasOnlyV2 = (b: number) => JSON.stringify({ b, w: new Array(WAIT_FEATURE_NAMES_V2.length).fill(0) });

    it("raw V2 features prefix the exact v1 vector and append the composition block", () => {
        const { context, actor, charge } = buildBoard();
        const v1 = extractWaitFeatures(actor, context.unitsHolder, fp(), charge);
        const raw = extractWaitFeaturesV2Raw(actor, context.unitsHolder, fp(), charge);
        expect(raw).toHaveLength(WAIT_FEATURE_NAMES_V2_RAW.length);
        expect(raw.slice(0, WAIT_FEATURE_NAMES.length)).toEqual(v1);
        const at = (name: string) => raw[WAIT_FEATURE_NAMES_V2_RAW.indexOf(name)];
        // 2v2 all-melee board: composition is pure melee, actor has no shots, nearest enemy at Chebyshev 7
        expect(at("ownRangedFrac")).toBe(0);
        expect(at("enemyRangedFrac")).toBe(0);
        expect(at("ownMeleeFrac")).toBe(1);
        expect(at("enemyMeleeFrac")).toBe(1);
        expect(at("actShotsNorm")).toBe(0);
        expect(at("actNearEnemyDist")).toBeGreaterThan(0);
    });

    it("composition tracks a mixed army and a ranged actor's remaining shots", () => {
        const mixed = buildBoard({ attackType: RANGE, rangeShots: 5 }, {});
        const raw = extractWaitFeaturesV2Raw(mixed.actor, mixed.context.unitsHolder, fp(), mixed.charge);
        const at = (name: string) => raw[WAIT_FEATURE_NAMES_V2_RAW.indexOf(name)];
        expect(at("ownRangedFrac")).toBe(0.5);
        expect(at("ownMeleeFrac")).toBe(0.5);
        expect(at("actShotsNorm")).toBeCloseTo(0.5, 10);
    });

    it("expandWaitFeaturesV2: the xR_ block is the raw copy for a RANGE actor and all-zero otherwise", () => {
        const rawLen = WAIT_FEATURE_NAMES_V2_RAW.length;
        const rangedIdx = WAIT_FEATURE_NAMES.indexOf("isRanged");
        const raw = new Array(rawLen).fill(0).map((_, i) => (i + 1) / 100);
        raw[rangedIdx] = 1;
        const x = expandWaitFeaturesV2(raw);
        expect(x).toHaveLength(WAIT_FEATURE_NAMES_V2.length);
        expect(x.slice(0, rawLen)).toEqual(raw);
        expect(x.slice(rawLen)).toEqual(raw);
        raw[rangedIdx] = 0;
        expect(expandWaitFeaturesV2(raw).slice(rawLen)).toEqual(new Array(rawLen).fill(0));
    });

    it("parseWaitWeightsV2 requires the full 98-dim width", () => {
        expect(
            parseWaitWeightsV2(JSON.stringify({ b: 0.1, w: new Array(WAIT_FEATURE_NAMES.length).fill(0) })),
        ).toBeNull();
        expect(parseWaitWeightsV2("not json")).toBeNull();
        expect(parseWaitWeightsV2(biasOnlyV2(0.1))).not.toBeNull();
    });

    it("v07WaitWeightsV2 resolution: absent -> null (v1 path), all-zero -> disabled, valid -> weights", () => {
        setEnv({});
        expect(v07WaitWeightsV2()).toBeNull();
        setEnv({ V07_WAIT_WEIGHTS_V2: zerosV2() });
        expect(v07WaitWeightsV2()).toBe("disabled");
        setEnv({ V07_WAIT_WEIGHTS_V2: biasOnlyV2(0.25) });
        const resolved = v07WaitWeightsV2();
        expect(resolved).not.toBeNull();
        expect(resolved).not.toBe("disabled");
        setEnv({ V07_WAIT_WEIGHTS_V2: "garbage" });
        expect(v07WaitWeightsV2()).toBeNull();
    });

    it("V2 stage fires for a RANGE actor at z > 0 — the v1 training-support guard does NOT apply", () => {
        const ranged = buildBoard({ attackType: RANGE, rangeShots: 5 });
        const weights = parseWaitWeightsV2(biasOnlyV2(0.01));
        expect(applyWaitScorerWeightsV2(ranged.actor, ranged.context, ranged.charge, weights)).toEqual([
            { type: "wait_turn", unitId: ranged.actor.getId() },
        ]);
        const negative = parseWaitWeightsV2(biasOnlyV2(-0.01));
        expect(applyWaitScorerWeightsV2(ranged.actor, ranged.context, ranged.charge, negative)).toBe(ranged.charge);
    });

    it("V2 stage keeps policy waits, wait-ineligible points and null weights byte-identical", () => {
        const board = buildBoard();
        const weights = parseWaitWeightsV2(biasOnlyV2(5));
        const policyWait: GameAction[] = [{ type: "wait_turn", unitId: board.actor.getId() }];
        expect(applyWaitScorerWeightsV2(board.actor, board.context, policyWait, weights)).toBe(policyWait);
        expect(applyWaitScorerWeightsV2(board.actor, board.context, board.charge, null)).toBe(board.charge);
        fp().addAlreadyMadeTurn(LOWER, board.actor.getId());
        expect(applyWaitScorerWeightsV2(board.actor, board.context, board.charge, weights)).toBe(board.charge);
    });
});
