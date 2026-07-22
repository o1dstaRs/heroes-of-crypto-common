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

import { getEnemiesCellsWithinMovementRange, type IDecisionContext } from "../../src/ai";
import { V08_DOMINANT_FINISH_START_LAP, V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell, getRangeAttackSideCenter } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
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
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

function decisionContext(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

function setupSupportedShot(
    withScreen = true,
    rangedTarget = false,
    targetShotDistance?: number,
    offsetScreen = false,
): {
    shooter: Unit;
    target: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Supported Archer",
        attackType: RANGE,
        speed: 3,
        rangeShots: 8,
        shotDistance: 3,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: UPPER,
        name: "Distant Target",
        attackType: rangedTarget ? RANGE : MELEE,
        speed: 1,
        rangeShots: rangedTarget ? 2 : 0,
        damageMin: 1,
        damageMax: 1,
        amountAlive: 10,
        maxHp: 20,
        ...(targetShotDistance === undefined ? {} : { shotDistance: targetShotDistance }),
    });
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 10, y: 7 });
    if (withScreen) {
        const screen = createTestUnit({ team: LOWER, name: "Frontline", attackType: MELEE, speed: 1 });
        placeUnit(combat.grid, combat.unitsHolder, screen, { x: 6, y: offsetScreen ? 8 : 7 });
    }
    shooter.refreshPossibleAttackTypes(true);
    return { shooter, target, context: decisionContext(combat) };
}

function setupPinnedShooter(
    targetHp: number,
    handyman = false,
): {
    shooter: Unit;
    pinner: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: handyman ? "Handyman Archer" : "Pinned Archer",
        attackType: RANGE,
        speed: 3,
        rangeShots: 8,
        damageMin: 4,
        damageMax: 4,
        abilities: handyman ? ["Handyman"] : [],
    });
    const pinner = createTestUnit({
        team: UPPER,
        name: "Pinner",
        attackType: MELEE,
        speed: 1,
        maxHp: targetHp,
    });
    const screen = createTestUnit({ team: LOWER, name: "Bodyguard", attackType: MELEE, speed: 1 });
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 6, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 7, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, screen, { x: 5, y: 7 });
    shooter.refreshPossibleAttackTypes(false);
    return { shooter, pinner, context: decisionContext(combat) };
}

function setupPartiallyScreenedPinnedShooter(): {
    shooter: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Partially screened archer",
        attackType: RANGE,
        speed: 2,
        rangeShots: 8,
        damageMin: 4,
        damageMax: 4,
    });
    const pinner = createTestUnit({ team: UPPER, name: "Current pinner", attackType: MELEE, speed: 1, maxHp: 3 });
    const upperThreat = createTestUnit({
        team: UPPER,
        name: "Upper threat",
        attackType: MELEE,
        speed: 10,
        maxHp: 100,
    });
    const lowerThreat = createTestUnit({
        team: UPPER,
        name: "Lower threat",
        attackType: MELEE,
        speed: 10,
        maxHp: 100,
    });
    const screen = createTestUnit({ team: LOWER, name: "Bodyguard", attackType: MELEE, speed: 1 });
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 6, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 7, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, upperThreat, { x: 4, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, lowerThreat, { x: 4, y: 4 });
    placeUnit(combat.grid, combat.unitsHolder, screen, { x: 5, y: 7 });
    shooter.refreshPossibleAttackTypes(false);
    return { shooter, context: decisionContext(combat) };
}

afterEach(() => {
    delete process.env.V08_RANGED_POSITION_VERSIONS;
    delete process.env.V08_RANGED_POSITION_MODE;
    delete process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS;
    delete process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS;
});

describe("v0.8 protected ranged positioning", () => {
    it("moves behind its frontline and shoots in the same activation when the exact falloff band improves", () => {
        const { shooter, target, context } = setupSupportedShot();
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);

        const move = actions[0];
        const shot = actions[1];
        if (move.type !== "move_unit" || shot.type !== "range_attack") throw new Error("expected move + shot");
        const destination = move.targetCells?.[0];
        expect(destination).toBeDefined();
        expect(shot.targetId).toBe(target.getId());

        const settings = context.grid.getSettings();
        const movedPosition = getPositionForCell(
            destination!,
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );
        const currentAim = getRangeAttackSideCenter(settings, shot.aimCell!, shot.aimSide!, shooter.getPosition());
        const movedAim = getRangeAttackSideCenter(settings, shot.aimCell!, shot.aimSide!, movedPosition);
        expect(context.attackHandler!.getRangeAttackDivisor(shooter, movedAim, movedPosition)).toBeLessThan(
            context.attackHandler!.getRangeAttackDivisor(shooter, currentAim),
        );
    });

    it("applies the complete move-then-shot plan through the authoritative action engine", () => {
        const { shooter, target, context } = setupSupportedShot();
        const fightProperties = context.fightProperties!;
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(LOWER, context.unitsHolder.getAllAllies(LOWER).length);
        fightProperties.setTeamUnitsAlive(UPPER, context.unitsHolder.getAllAllies(UPPER).length);
        fightProperties.startTurn(shooter.getTeam(), 1_000);
        shooter.refreshPossibleAttackTypes(
            context.attackHandler!.canLandRangeAttack(
                shooter,
                context.grid.getEnemyAggrMatrixByUnitId(shooter.getId()),
            ),
        );
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(shooter, context),
        });
        const hpBefore = target.getCumulativeHp();
        const results = actions.map((action) => engine.apply(action));

        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(results.every((result) => result.completed)).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("crosses a damage band without a frontline only when no enemy can reach the destination next turn", () => {
        const { shooter, context } = setupSupportedShot(false);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);

        const threatened = setupSupportedShot(false);
        const runner = createTestUnit({ team: UPPER, name: "Fast flanker", attackType: MELEE, speed: 8 });
        placeUnit(threatened.context.grid, threatened.context.unitsHolder, runner, { x: 7, y: 8 });
        const held = new StrategyV0_8().decideTurn(threatened.shooter, threatened.context);
        expect(held.map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("does not close when its ranged army is already stronger and can make the opponent force", () => {
        const { shooter, context } = setupSupportedShot(true, true);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "range_attack")).toBe(true);
    });

    it("releases the stronger-ranged hold to cross a safe band once its dominant finish sprint is armed", () => {
        const { shooter, target, context } = setupSupportedShot(true, true);
        target.grantStolenAbility("Through Shot");
        target.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        target.setAmountAlive(1);
        const reserve = createTestUnit({ team: LOWER, name: "Dominant reserve", attackType: MELEE, maxHp: 100 });
        placeUnit(context.grid, context.unitsHolder, reserve, { x: 4, y: 5 });

        expect(new StrategyV0_8().decideTurn(shooter, context).some((action) => action.type === "move_unit")).toBe(
            false,
        );
        while (context.fightProperties!.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            context.fightProperties!.flipLap();
        }
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
    });

    it("does not close into a stronger immediate ranged response even when its army is ranged-inferior", () => {
        const { shooter, target, context } = setupSupportedShot(true, true);
        target.setAmountAlive(100);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "range_attack")).toBe(true);
    });

    it("may cross a band with support only when the ordinary counter-shot cannot become stronger", () => {
        process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS = "v0.8";
        const { shooter, target, context } = setupSupportedShot(true, true, 20, true);
        target.setAmountAlive(100);

        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);

        const move = actions[0];
        if (move.type !== "move_unit") throw new Error("expected response-neutral move + shot");
        const destination = move.targetCells?.[0];
        expect(destination).toBeDefined();
        const settings = context.grid.getSettings();
        const movedPosition = getPositionForCell(
            destination!,
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );
        expect(context.attackHandler!.getRangeAttackDivisor(target, movedPosition)).toBeGreaterThanOrEqual(
            context.attackHandler!.getRangeAttackDivisor(target, shooter.getPosition()),
        );

        const fightProperties = context.fightProperties!;
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(LOWER, context.unitsHolder.getAllAllies(LOWER).length);
        fightProperties.setTeamUnitsAlive(UPPER, context.unitsHolder.getAllAllies(UPPER).length);
        fightProperties.startTurn(shooter.getTeam(), 1_000);
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(shooter, context),
        });
        const hpBefore = target.getCumulativeHp();
        const results = actions.map((action) => engine.apply(action));
        expect(results.every((result) => result.completed)).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("keeps response-neutral advance off for a blocked counter ray and a stronger ranged army", () => {
        process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS = "v0.8";
        const blocked = setupSupportedShot(true, true, 20);
        blocked.target.setAmountAlive(100);
        expect(new StrategyV0_8().decideTurn(blocked.shooter, blocked.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);

        const stronger = setupSupportedShot(true, true, 20, true);
        stronger.target.setAmountAlive(1);
        expect(
            new StrategyV0_8()
                .decideTurn(stronger.shooter, stronger.context)
                .some((action) => action.type === "move_unit"),
        ).toBe(false);
    });

    it("scopes supported-delta independently from the shared positioning baseline", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS = "v0.8s";
        const production = setupPartiallyScreenedPinnedShooter();
        expect(
            new StrategyV0_8()
                .decideTurn(production.shooter, production.context)
                .some((action) => action.type === "melee_attack"),
        ).toBe(true);

        const control = setupPartiallyScreenedPinnedShooter();
        expect(new StrategyV0_8S().decideTurn(control.shooter, control.context).map((action) => action.type)).toEqual([
            "move_unit",
        ]);
    });

    it("may close on a ranged target after that stack has spent its response", () => {
        const { shooter, target, context } = setupSupportedShot(true, true);
        target.setAmountAlive(100);
        context.fightProperties!.addRepliedAttack(target.getId());
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
    });

    it("may safely cross a band without melee support against a ranged target that cannot respond", () => {
        const { shooter, target, context } = setupSupportedShot(false, true);
        target.grantStolenAbility("Through Shot");
        target.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        target.setAmountAlive(1_000);

        expect(target.canRespond(RANGE)).toBe(false);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
    });

    it("keeps v0.8s as an otherwise identical control seat unless explicitly opted in", () => {
        const { shooter, context } = setupSupportedShot();
        const control = new StrategyV0_8S().decideTurn(shooter, context);
        expect(control.some((action) => action.type === "move_unit")).toBe(false);
        expect(control.some((action) => action.type === "range_attack")).toBe(true);

        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8s";
        const enabled = new StrategyV0_8S().decideTurn(shooter, context);
        expect(enabled.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
    });

    it("exposes seat-safe advance and retreat ablations for M4 validation", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const advance = setupSupportedShot();
        expect(
            new StrategyV0_8()
                .decideTurn(advance.shooter, advance.context)
                .some((action) => action.type === "move_unit"),
        ).toBe(false);

        process.env.V08_RANGED_POSITION_MODE = "advance";
        const pinned = setupPinnedShooter(3);
        expect(
            new StrategyV0_8()
                .decideTurn(pinned.shooter, pinned.context)
                .some((action) => action.type === "melee_attack"),
        ).toBe(true);
    });

    it("retreats a pinned ordinary shooter whose inherited melee only looks lethal before the 50% penalty", () => {
        const { shooter, context } = setupPinnedShooter(3);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit"]);
        const move = actions[0];
        if (move.type !== "move_unit") throw new Error("expected screened retreat");
        expect(move.targetCells).toBeDefined();
    });

    it("default-off delta accepts a partial screen only when it reduces unscreened reach without adding threats", () => {
        const baseline = setupPartiallyScreenedPinnedShooter();
        expect(
            new StrategyV0_8()
                .decideTurn(baseline.shooter, baseline.context)
                .some((action) => action.type === "melee_attack"),
        ).toBe(true);

        process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS = "v0.8";
        const armed = setupPartiallyScreenedPinnedShooter();
        const actions = new StrategyV0_8().decideTurn(armed.shooter, armed.context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit"]);
    });

    it("applies the partial-screen escape through the authoritative action engine", () => {
        process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS = "v0.8";
        const { shooter, context } = setupPartiallyScreenedPinnedShooter();
        const fightProperties = context.fightProperties!;
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(LOWER, context.unitsHolder.getAllAllies(LOWER).length);
        fightProperties.setTeamUnitsAlive(UPPER, context.unitsHolder.getAllAllies(UPPER).length);
        fightProperties.startTurn(shooter.getTeam(), 1_000);
        shooter.refreshPossibleAttackTypes(false);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(shooter, context),
        });

        expect(actions.map((action) => action.type)).toEqual(["move_unit"]);
        expect(engine.apply(actions[0]).completed).toBe(true);
    });

    it("retains ranged melee only for a real secure kill, and leaves Handyman unchanged", () => {
        const lethal = setupPinnedShooter(2);
        const lethalActions = new StrategyV0_8().decideTurn(lethal.shooter, lethal.context);
        expect(lethalActions.some((action) => action.type === "melee_attack")).toBe(true);

        const handyman = setupPinnedShooter(3, true);
        const handymanActions = new StrategyV0_8().decideTurn(handyman.shooter, handyman.context);
        expect(handymanActions.some((action) => action.type === "melee_attack")).toBe(true);
    });

    it("never retreats over direct damage after the stronger-army finish sprint is armed", () => {
        const { shooter, context } = setupPinnedShooter(3);
        const fightProperties = context.fightProperties!;
        while (fightProperties.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            fightProperties.flipLap();
        }

        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "melee_attack")).toBe(true);
    });

    it("never retreats over direct damage after the universal finish sprint is armed", () => {
        const { shooter, context } = setupPinnedShooter(100);
        const fightProperties = context.fightProperties!;
        while (fightProperties.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            fightProperties.flipLap();
        }

        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "melee_attack")).toBe(true);
    });

    it("does not mistake a native melee unit with a stolen quiver for a half-damage archer", () => {
        const combat = createCombatTestContext();
        const thief = createTestUnit({
            team: LOWER,
            name: "Quiver thief",
            attackType: MELEE,
            speed: 3,
            damageMin: 4,
            damageMax: 4,
        });
        thief.grantStolenAbility("Endless Quiver");
        thief.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        const pinner = createTestUnit({ team: UPPER, name: "Pinner", attackType: MELEE, maxHp: 3 });
        placeUnit(combat.grid, combat.unitsHolder, thief, { x: 6, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 7, y: 7 });
        thief.refreshPossibleAttackTypes(false);

        const actions = new StrategyV0_8().decideTurn(thief, decisionContext(combat));
        expect(thief.isRangeCapable()).toBe(true);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "melee_attack")).toBe(true);
    });
});
