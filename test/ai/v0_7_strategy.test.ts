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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    AI_VERSIONS,
    DEFAULT_AI_VERSION,
    getAIStrategy,
    LATEST_AI_VERSION,
    type IAIStrategy,
    type IDecisionContext,
} from "../../src/ai";
import {
    isAuraSaturatedArmy,
    isMeleeMagicAnchorArmy,
    shouldUseArchetypePlacementAnchor,
    StrategyV0_7,
} from "../../src/ai/versions/v0_7";
import {
    applyWaitScorerWeights,
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    extractWaitFeatures,
    v07BakedWaitWeights,
    waitScore,
} from "../../src/ai/versions/wait_scorer";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const ENV_KEYS = [
    "V07_WAIT_SCORER",
    "V07_WAIT_WEIGHTS",
    "V07_WAIT_WEIGHTS_V2",
    "V07_WAIT_WEIGHTS_B",
    "V07_WAIT_VERSIONS",
    "V07_WAIT_GUARD",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

const zeroWeights = (): number[] => DISTILLED_WAIT_WEIGHTS_2026_07_10.w.map(() => 0);

function anyAdjacent(cells: readonly { x: number; y: number }[]): boolean {
    return cells.some((cell, index) =>
        cells.slice(index + 1).some((other) => Math.max(Math.abs(cell.x - other.x), Math.abs(cell.y - other.y)) === 1),
    );
}

class TestStrategyV0_7 extends StrategyV0_7 {
    public finalizeForTest(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        return this.finalizeDecision(unit, context, decision);
    }
}

interface Board {
    actor: Unit;
    context: IDecisionContext;
    incumbent: GameAction[];
}

function buildBoard(enemyAmountAlive = 1, actorOptions: Parameters<typeof createTestUnit>[0] = {}): Board {
    const combat = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({ name: "Actor", team: LOWER, speed: 4, ...actorOptions });
    const ally = createTestUnit({ name: "Ally", team: LOWER, speed: 2 });
    const enemyA = createTestUnit({ name: "Enemy A", team: UPPER, speed: 3, amountAlive: enemyAmountAlive });
    const enemyB = createTestUnit({ name: "Enemy B", team: UPPER, speed: 5, amountAlive: enemyAmountAlive });
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
        incumbent: [
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
        ],
    };
}

function primeArmyProfile(strategy: Pick<IAIStrategy, "placeArmy">, context: IDecisionContext): void {
    strategy.placeArmy(context.unitsHolder.getAllAllies(LOWER), {
        team: LOWER,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        pathHelper: context.pathHelper,
        placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
    });
}

describe("v0.7 registry", () => {
    it("ships v0.7 as both the LATEST and the DEFAULT version (bake battery 2026-07-10 PASS)", () => {
        expect(AI_VERSIONS).toContain("v0.7");
        expect(getAIStrategy("v0.7").version).toBe("v0.7");
        expect(LATEST_AI_VERSION).toBe("v0.7");
        expect(DEFAULT_AI_VERSION).toBe("v0.7");
    });
});

describe("v0.7 baked weight resolution", () => {
    it("defaults to the committed DISTILLED_WAIT_WEIGHTS_2026_07_10 with no env and no gate", () => {
        expect(v07BakedWaitWeights()).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10);
        // The env-gated pattern's gate is NOT consulted — v0.7's scorer is always armed.
        process.env.V07_WAIT_SCORER = "off";
        expect(v07BakedWaitWeights()).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10);
    });

    it("honors a valid V07_WAIT_WEIGHTS override", () => {
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 7, w: zeroWeights() });
        expect(v07BakedWaitWeights()).toEqual({ b: 7, w: zeroWeights() });
    });

    it("treats an ALL-ZERO override as the anchor (null: scorer never fires)", () => {
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 0, w: zeroWeights() });
        expect(v07BakedWaitWeights()).toBeNull();
    });

    it("falls back to the committed defaults on malformed env — a bad env never de-bakes live play", () => {
        process.env.V07_WAIT_WEIGHTS = "{not json";
        expect(v07BakedWaitWeights()).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10);
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1, w: [1, 2, 3] });
        expect(v07BakedWaitWeights()).toEqual(DISTILLED_WAIT_WEIGHTS_2026_07_10);
    });
});

describe("v0.7 strategy — baked wait scorer", () => {
    it("recognizes the fixed aura, melee-magic, and Area Throw policy domains", () => {
        const auraArmy = Array.from({ length: 3 }, () =>
            createTestUnit({ auraEffects: ["Luck"], auraRanges: [2], auraIsBuff: [true] }),
        );
        const brawlerArmy = [
            ...Array.from({ length: 4 }, () => createTestUnit({ attackType: PBTypes.AttackVals.MELEE_MAGIC })),
            createTestUnit(),
            createTestUnit(),
        ];
        const salvageArmy = [
            ...brawlerArmy.slice(0, 3),
            createTestUnit({ attackType: PBTypes.AttackVals.MELEE_MAGIC, spells: ["System:Resurrection"] }),
            ...brawlerArmy.slice(4),
        ];
        const rangedArmy = Array.from({ length: 6 }, () =>
            createTestUnit({ attackType: PBTypes.AttackVals.RANGE, rangeShots: 5 }),
        );
        const areaThrow = createTestUnit({ abilities: ["Area Throw"] });
        const largeCaliber = createTestUnit({ abilities: ["Large Caliber"] });

        expect(isAuraSaturatedArmy(auraArmy)).toBe(true);
        expect(isAuraSaturatedArmy([...auraArmy, createTestUnit()])).toBe(false);
        expect(isMeleeMagicAnchorArmy(brawlerArmy.slice(0, 1))).toBe(false);
        for (let density = 2; density <= brawlerArmy.length; density += 1) {
            expect(isMeleeMagicAnchorArmy(brawlerArmy.slice(0, density))).toBe(true);
        }
        expect(isMeleeMagicAnchorArmy(salvageArmy)).toBe(false);
        expect(shouldUseArchetypePlacementAnchor(rangedArmy, [areaThrow])).toBe(true);
        expect(shouldUseArchetypePlacementAnchor(rangedArmy, [largeCaliber])).toBe(false);
        expect(shouldUseArchetypePlacementAnchor([...rangedArmy.slice(0, 5), createTestUnit()], [areaThrow])).toBe(
            false,
        );
    });

    it("classifies partial placement requests from the complete team in the holder", () => {
        const combat = createCombatTestContext();
        const enemy = createTestUnit({ team: UPPER, abilities: ["Area Throw"] });
        const ranged = Array.from({ length: 3 }, (_, index) =>
            createTestUnit({ name: `Ranged ${index}`, team: LOWER, attackType: PBTypes.AttackVals.RANGE }),
        );
        const melee = createTestUnit({ name: "Melee ally", team: LOWER });
        combat.unitsHolder.addUnit(enemy);
        for (const unit of [...ranged, melee]) combat.unitsHolder.addUnit(unit);
        const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5);

        const placed = new StrategyV0_7().placeArmy(ranged, {
            team: LOWER,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: zone,
        });

        expect(placed.size).toBe(ranged.length);
        // The full team is mixed, so v0.6's Area Throw dispersion remains active. Classifying only the
        // ranged subset would incorrectly choose the packed v0.4 pure-range anchor.
        expect(anyAdjacent([...placed.values()])).toBe(false);
    });

    it("uses exact v0.4 placement only for a pure ranged army facing Area Throw", () => {
        const placeAgainst = (ability: string, version: "v0.4" | "v0.6" | "v0.7") => {
            const combat = createCombatTestContext();
            const enemy = createTestUnit({ team: UPPER, abilities: [ability] });
            const ranged = Array.from({ length: 4 }, (_, index) =>
                createTestUnit({ name: `Ranged ${index}`, team: LOWER, attackType: PBTypes.AttackVals.RANGE }),
            );
            combat.unitsHolder.addUnit(enemy);
            for (const unit of ranged) combat.unitsHolder.addUnit(unit);
            return [
                ...getAIStrategy(version)
                    .placeArmy(ranged, {
                        team: LOWER,
                        grid: combat.grid,
                        unitsHolder: combat.unitsHolder,
                        pathHelper: new PathHelper(testGridSettings),
                        placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
                    })
                    .values(),
            ];
        };

        expect(placeAgainst("Area Throw", "v0.7")).toEqual(placeAgainst("Area Throw", "v0.4"));
        expect(placeAgainst("Large Caliber", "v0.7")).toEqual(placeAgainst("Large Caliber", "v0.6"));
    });

    it("fails closed before profile priming and classifies a partial request from the complete army", () => {
        const { actor, context, incumbent } = buildBoard(10, {
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
        });
        const secondMeleeMage = createTestUnit({
            name: "Second Melee Mage",
            team: LOWER,
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
        });
        const excludedSalvageUnit = createTestUnit({
            name: "Excluded Salvage Unit",
            team: LOWER,
            spells: ["System:Resurrection"],
        });
        placeUnit(context.grid, context.unitsHolder, secondMeleeMage, { x: 7, y: 3 });
        placeUnit(context.grid, context.unitsHolder, excludedSalvageUnit, { x: 9, y: 3 });
        context.fightProperties!.setTeamUnitsAlive(LOWER, 4);
        const strategy = new TestStrategyV0_7();
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });

        // Without placement, a late takeover does not infer a profile from survivors or run the scorer.
        expect(strategy.finalizeForTest(actor, context, incumbent)).toBe(incumbent);
        strategy.placeArmy([actor, secondMeleeMage], {
            team: LOWER,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            pathHelper: context.pathHelper,
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
        });

        // The omitted holder unit has Resurrection, so the complete army is salvage-supported and must not
        // be anchored. Classifying only the two-unit placement subset would incorrectly preserve incumbent.
        expect(strategy.finalizeForTest(actor, context, incumbent)).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
    });

    it("keeps the incumbent when fight state is unavailable", () => {
        const { actor, context, incumbent } = buildBoard(10);
        const contextWithoutFight: IDecisionContext = { ...context, fightProperties: undefined };

        expect(applyWaitScorerWeights(actor, contextWithoutFight, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("keeps an incumbent wait untouched", () => {
        const { actor, context } = buildBoard(10);
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];

        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("keeps the incumbent for a team's lone living stack", () => {
        const { actor, context, incumbent } = buildBoard(10);
        context.fightProperties!.setTeamUnitsAlive(LOWER, 1);

        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("keeps the incumbent when the actor is already queued on the hourglass", () => {
        const { actor, context, incumbent } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        fightProperties.enqueueHourglass(actor.getId());
        fightProperties.restoreAlreadyHourglass([]);

        expect(fightProperties.hourglassIncludes(actor.getId())).toBe(true);
        expect(fightProperties.hasAlreadyHourglass(actor.getId())).toBe(false);
        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("keeps the incumbent after the actor has made its turn", () => {
        const { actor, context, incumbent } = buildBoard(10);
        context.fightProperties!.addAlreadyMadeTurn(LOWER, actor.getId());

        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("keeps the incumbent after the actor has already used its hourglass", () => {
        const { actor, context, incumbent } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        fightProperties.restoreAlreadyHourglass([actor.getId()]);

        expect(fightProperties.hourglassIncludes(actor.getId())).toBe(false);
        expect(fightProperties.hasAlreadyHourglass(actor.getId())).toBe(true);
        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("fails closed when malformed state produces a non-finite score", () => {
        const { actor, context, incumbent } = buildBoard(10);
        Object.defineProperty(actor, "getSpeed", { value: () => Number.NaN });

        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
    });

    it("matches the exact committed linear scorer at an eligible decision point", () => {
        const { actor, context, incumbent } = buildBoard();
        const fightProperties = context.fightProperties!;
        expect(canWaitOnHourglassMirror(actor, fightProperties)).toBe(true);
        const score = waitScore(
            DISTILLED_WAIT_WEIGHTS_2026_07_10,
            extractWaitFeatures(actor, context.unitsHolder, fightProperties, incumbent),
        );
        const actual = applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights());
        expect(actual).toEqual(score > 0 ? [{ type: "wait_turn", unitId: actor.getId() }] : incumbent);
        expect(score).not.toBe(0);
        expect(score).toBeLessThan(0);
    });

    it("replaces an eligible action when the committed scorer is positive", () => {
        const { actor, context, incumbent } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        const score = waitScore(
            DISTILLED_WAIT_WEIGHTS_2026_07_10,
            extractWaitFeatures(actor, context.unitsHolder, fightProperties, incumbent),
        );

        expect(score).toBeGreaterThan(0);
        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
    });

    it("emits a wait that the action engine accepts at a positive-score decision point", () => {
        const { actor, context } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        fightProperties.startFight();
        fightProperties.startTurn(LOWER, 1_000);

        expect(
            getAIStrategy("v0.6")
                .decideTurn(actor, context)
                .some((action) => action.type === "wait_turn"),
        ).toBe(false);
        const strategy = getAIStrategy("v0.7");
        primeArmyProfile(strategy, context);
        const actions = strategy.decideTurn(actor, context);
        expect(actions).toEqual([{ type: "wait_turn", unitId: actor.getId() }]);

        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => actor.getId(),
        });
        const result = engine.apply(actions[0]);

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        expect(result.events).toContainEqual({ type: "unit_waited", unitId: actor.getId(), team: LOWER });
        expect(fightProperties.hourglassIncludes(actor.getId())).toBe(true);
        expect(fightProperties.hasAlreadyMadeTurn(actor.getId())).toBe(false);
    });

    it("applies the baked scorer after the full inherited v0.6 decision chain", () => {
        const { actor, context } = buildBoard();
        const incumbent = getAIStrategy("v0.6").decideTurn(actor, context);
        const expected = applyWaitScorerWeights(actor, context, incumbent, DISTILLED_WAIT_WEIGHTS_2026_07_10);
        const strategy = getAIStrategy("v0.7");
        primeArmyProfile(strategy, context);
        expect(strategy.decideTurn(actor, context)).toEqual(expected);
    });

    it("the baked scorer never converts a RANGE unit — the training-support guard (ranged-collapse fix)", () => {
        const combat = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const actor = createTestUnit({
            name: "Shooter",
            team: LOWER,
            speed: 4,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
        });
        const ally = createTestUnit({
            name: "Shooter Ally",
            team: LOWER,
            speed: 2,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
        });
        const enemy = createTestUnit({ name: "Enemy", team: UPPER, speed: 3, amountAlive: 10 });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 3, y: 10 });
        fightProperties.setTeamUnitsAlive(LOWER, 2);
        fightProperties.setTeamUnitsAlive(UPPER, 1);
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        const incumbent: GameAction[] = [{ type: "range_attack", attackerId: actor.getId(), targetId: enemy.getId() }];
        expect(canWaitOnHourglassMirror(actor, fightProperties)).toBe(true);
        // even a z=+1000-everywhere override cannot make the baked stage wait a ranged unit...
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });
        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toBe(incumbent);
        // ...unless the guard is explicitly lifted (the pre-fix behavior, kept for experiments)
        process.env.V07_WAIT_GUARD = "off";
        expect(applyWaitScorerWeights(actor, context, incumbent, v07BakedWaitWeights())).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
    });

    it("a V07_WAIT_WEIGHTS override steers v0.7's act-vs-wait decision", () => {
        const { actor, context } = buildBoard();
        expect(canWaitOnHourglassMirror(actor, context.fightProperties!)).toBe(true);
        const plainV06 = getAIStrategy("v0.6").decideTurn(actor, context);
        const strategy = getAIStrategy("v0.7");
        primeArmyProfile(strategy, context);
        // z = +1000 everywhere: every eligible non-wait decision becomes a wait (a policy wait stays a wait).
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });
        expect(strategy.decideTurn(actor, context).some((a) => a.type === "wait_turn")).toBe(true);
        // z = -1000 everywhere: the scorer never fires; v0.7 returns exactly v0.6's decision.
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: -1_000, w: zeroWeights() });
        expect(strategy.decideTurn(actor, context)).toEqual(plainV06);
    });

    it("anchors ranged actors by default but lets V07_WAIT_GUARD=off reproduce the scorer experiment", () => {
        const { actor, context } = buildBoard(10, {
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
        });
        const plainV06 = getAIStrategy("v0.6").decideTurn(actor, context);
        expect(plainV06.some((action) => action.type === "wait_turn")).toBe(false);

        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });
        const strategy = getAIStrategy("v0.7");
        primeArmyProfile(strategy, context);

        expect(strategy.decideTurn(actor, context)).toEqual(plainV06);
        process.env.V07_WAIT_GUARD = "off";
        expect(strategy.decideTurn(actor, context)).toEqual([{ type: "wait_turn", unitId: actor.getId() }]);
    });

    it("preserves a committed cast while leaving non-cast mage turns scorer-eligible", () => {
        const { actor, context, incumbent } = buildBoard(10, {
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
        });
        const strategy = new TestStrategyV0_7();
        const cast: GameAction[] = [
            {
                type: "cast_spell",
                casterId: actor.getId(),
                spellName: "Wind Flow",
                targetId: actor.getId(),
            },
        ];
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });
        primeArmyProfile(strategy, context);

        expect(strategy.finalizeForTest(actor, context, cast)).toBe(cast);
        expect(strategy.finalizeForTest(actor, context, incumbent)).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
    });

    it("ALL-ZERO weights reproduce v0.6 on a non-caster board", () => {
        const { actor, context } = buildBoard(10);
        const plainV06 = getAIStrategy("v0.6").decideTurn(actor, context);
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 0, w: zeroWeights() });
        expect(getAIStrategy("v0.7").decideTurn(actor, context)).toEqual(plainV06);
    });

    it("leaves v0.6 byte-identical: baked weights never leak into the env-gated stage", () => {
        const { actor, context } = buildBoard(10);
        const plain = getAIStrategy("v0.6").decideTurn(actor, context);
        // Even with override weights present in the env, v0.6's scorer stays behind its own gate + scope.
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 1_000, w: zeroWeights() });
        expect(getAIStrategy("v0.6").decideTurn(actor, context)).toEqual(plain);
        expect(plain.some((action) => action.type === "wait_turn")).toBe(false);
    });
});
