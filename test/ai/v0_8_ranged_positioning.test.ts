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

import { getEnemiesCellsWithinMovementRange, type IAIPolicyEvent, type IDecisionContext } from "../../src/ai";
import { V08_DOMINANT_FINISH_START_LAP, V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell, getRangeAttackSideCenter } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { makeRng } from "../../src/simulation/army";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
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
const MAGIC = PBTypes.AttackVals.MAGIC;

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

function setupSupportedPrepinEgress(
    options: {
        guardActed?: boolean;
        guardQueued?: boolean;
        guardRanged?: boolean;
        guardStolenQuiver?: boolean;
        targetRanged?: boolean;
        targetCell?: XY;
        threatRanged?: boolean;
        threatCell?: XY;
        threatSpeed?: number;
        shotDistance?: number;
    } = {},
): {
    shooter: Unit;
    target: Unit;
    threat: Unit;
    guard: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Pre-pin Archer",
        attackType: RANGE,
        speed: 1,
        rangeShots: 8,
        shotDistance: options.shotDistance ?? 16,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: UPPER,
        name: "Shot target",
        attackType: options.targetRanged ? RANGE : MELEE,
        speed: 0,
        rangeShots: options.targetRanged ? 8 : 0,
        shotDistance: 16,
        amountAlive: 10,
        maxHp: 20,
    });
    const threat = createTestUnit({
        team: UPPER,
        name: "Pending charger",
        attackType: options.threatRanged ? RANGE : MELEE,
        speed: options.threatSpeed ?? 2,
        rangeShots: options.threatRanged ? 8 : 0,
        shotDistance: 16,
    });
    const guard = createTestUnit({
        team: LOWER,
        name: "Frontline screen",
        attackType: options.guardRanged ? RANGE : MELEE,
        speed: 1,
        rangeShots: options.guardRanged ? 1 : 0,
    });
    // The threat can reach the current cell by the optimistic one-activation distance bound, but not (0,0).
    // The melee ally at (1,1) is geometrically between that destination and the threat; the ranged wall proves
    // stable native class identity rather than merely accepting any occupied neighboring cell as support.
    const wall = createTestUnit({ team: LOWER, name: "Corner wall", attackType: RANGE, speed: 1, rangeShots: 1 });
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 0, y: 1 });
    placeUnit(combat.grid, combat.unitsHolder, target, options.targetCell ?? { x: 0, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, threat, options.threatCell ?? { x: 2, y: 5 });
    placeUnit(combat.grid, combat.unitsHolder, guard, { x: 1, y: 1 });
    placeUnit(combat.grid, combat.unitsHolder, wall, { x: 1, y: 0 });
    if (options.guardStolenQuiver) {
        guard.grantStolenAbility("Endless Quiver");
        guard.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
    }
    shooter.refreshPossibleAttackTypes(true);
    threat.refreshPossibleAttackTypes(true);
    const context = decisionContext(combat);
    if (options.guardActed ?? true) {
        context.fightProperties!.addAlreadyMadeTurn(guard.getTeam(), guard.getId());
    }
    if (options.guardQueued) context.fightProperties!.enqueueUpNext(guard.getId());
    return { shooter, target, threat, guard, context };
}

function setupProactiveScreenedClose(
    enemyRangedAmount: number,
    residualThreatCell?: XY,
): {
    shooter: Unit;
    target: Unit;
    context: IDecisionContext;
    destination: XY;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Posture archer",
        attackType: RANGE,
        speed: 1,
        rangeShots: 8,
        shotDistance: 5,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: UPPER,
        name: "Posture target",
        attackType: RANGE,
        speed: 0,
        rangeShots: 8,
        shotDistance: 16,
        damageMin: 1,
        damageMax: 1,
        amountAlive: enemyRangedAmount,
        maxHp: 1,
    });
    const escapedThreat = createTestUnit({
        team: UPPER,
        name: "Screened future charger",
        attackType: MELEE,
        speed: 2,
        maxHp: 100,
    });
    const guard = createTestUnit({ team: LOWER, name: "Posture guard", attackType: MELEE, speed: 1 });
    const destination = { x: 5, y: 6 };
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 5, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 5, y: 1 });
    placeUnit(combat.grid, combat.unitsHolder, escapedThreat, { x: 7, y: 11 });
    placeUnit(combat.grid, combat.unitsHolder, guard, { x: 6, y: 7 });
    escapedThreat.applyBuff(
        new Spell({
            spellProperties: getSpellConfig("System", "Hidden"),
            amount: 1,
        }),
    );
    const context = decisionContext(combat);
    context.fightProperties!.addRepliedAttack(target.getId());
    context.fightProperties!.addAlreadyMadeTurn(UPPER, escapedThreat.getId());
    if (residualThreatCell) {
        const residualThreat = createTestUnit({
            team: UPPER,
            name: "Unscreened next-lap charger",
            attackType: MELEE,
            speed: 2,
            maxHp: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, residualThreat, residualThreatCell);
        residualThreat.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(UPPER, residualThreat.getId());
        context.matrix = combat.grid.getMatrix();
    }
    const destinationHash = (destination.x << 4) | destination.y;
    context.pathHelper = {
        getMovePath: () => ({
            cells: [destination],
            hashes: new Set([destinationHash]),
            knownPaths: new Map([
                [
                    destinationHash,
                    [
                        {
                            cell: destination,
                            route: [destination],
                            weight: 1,
                            firstAggrMet: false,
                            hasLavaCell: false,
                            hasWaterCell: false,
                        },
                    ],
                ],
            ]),
        }),
    } as unknown as PathHelper;
    shooter.refreshPossibleAttackTypes(true);
    return { shooter, target, context, destination };
}

afterEach(() => {
    delete process.env.V08_RANGED_POSITION_VERSIONS;
    delete process.env.V08_RANGED_POSITION_MODE;
    delete process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS;
    delete process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS;
    setDeterministicRandomSource(undefined);
});

describe("v0.8 protected ranged positioning", () => {
    it("moves behind a native melee screen before a future pin while retaining the exact ordinary shot", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, target, context } = setupSupportedPrepinEgress();
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        const actions = new StrategyV0_8().decideTurn(shooter, context);

        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [{ x: 0, y: 0 }] });
        expect(actions[1]).toMatchObject({ type: "range_attack", targetId: target.getId() });
        expect(
            policyEvents.filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel").map(({ stage }) => stage),
        ).toEqual([
            "ordinary_shot",
            "eligible_shooter",
            "target_no_counter",
            "future_exposure",
            "native_guard",
            "current_signature",
            "reachable_route",
            "pending_distance_safe",
            "screened_route",
            "exposure_improved",
            "retained_signature",
            "posture_safe",
        ]);
        expect(policyEvents.filter(({ kind }) => kind === "v0.8_supported_prepin_egress")).toHaveLength(1);
    });

    it("holds a stronger ranged line but lets the weaker ranged army close across a real damage band", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";

        const stronger = setupProactiveScreenedClose(1);
        const strongerEvents: IAIPolicyEvent[] = [];
        stronger.context.policyEventObserver = (event) => strongerEvents.push(event);
        const strongerActions = new StrategyV0_8().decideTurn(stronger.shooter, stronger.context);
        expect(strongerActions.map((action) => action.type)).toEqual(["range_attack"]);
        const strongerShot = strongerActions[0];
        if (strongerShot?.type !== "range_attack" || !strongerShot.aimCell || strongerShot.aimSide === undefined) {
            throw new Error("expected an ordinary retained shot");
        }
        const destinationPosition = getPositionForCell(
            stronger.destination,
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        const currentAim = getRangeAttackSideCenter(
            testGridSettings,
            strongerShot.aimCell,
            strongerShot.aimSide,
            stronger.shooter.getPosition(),
        );
        const destinationAim = getRangeAttackSideCenter(
            testGridSettings,
            strongerShot.aimCell,
            strongerShot.aimSide,
            destinationPosition,
        );
        const currentEvaluation = stronger.context.attackHandler!.evaluateRangeAttack(
            stronger.context.unitsHolder.getAllUnits(),
            stronger.shooter,
            stronger.shooter.getPosition(),
            currentAim,
            false,
            false,
            false,
        );
        const destinationEvaluation = stronger.context.attackHandler!.evaluateRangeAttack(
            stronger.context.unitsHolder.getAllUnits(),
            stronger.shooter,
            destinationPosition,
            destinationAim,
            false,
            false,
            false,
        );
        expect(currentEvaluation.rangeAttackDivisors[0]).toBe(2);
        expect(destinationEvaluation.rangeAttackDivisors[0]).toBe(1);
        const currentCell = stronger.shooter.getBaseCell();
        const targetCell = stronger.target.getBaseCell();
        expect(Math.max(Math.abs(currentCell.x - targetCell.x), Math.abs(currentCell.y - targetCell.y))).toBe(6);
        expect(
            Math.max(Math.abs(stronger.destination.x - targetCell.x), Math.abs(stronger.destination.y - targetCell.y)),
        ).toBe(5);
        expect(
            strongerEvents
                .filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel")
                .map(({ stage }) => stage),
        ).toContain("retained_signature");
        expect(strongerEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_prepin_egress");

        const weaker = setupProactiveScreenedClose(20);
        const weakerEvents: IAIPolicyEvent[] = [];
        weaker.context.policyEventObserver = (event) => weakerEvents.push(event);
        const actions = new StrategyV0_8().decideTurn(weaker.shooter, weaker.context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [weaker.destination] });
        expect(actions[1]).toMatchObject({ type: "range_attack", targetId: weaker.target.getId() });
        expect(weakerEvents.map(({ kind }) => kind)).toContain("v0.8_supported_prepin_egress");
    });

    it("does not let a screen for an escaped threat certify a different unscreened next-lap exposure", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const fixture = setupProactiveScreenedClose(20, { x: 2, y: 7 });
        const policyEvents: IAIPolicyEvent[] = [];
        fixture.context.policyEventObserver = (event) => policyEvents.push(event);

        expect(new StrategyV0_8().decideTurn(fixture.shooter, fixture.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(
            policyEvents.filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel").map(({ stage }) => stage),
        ).not.toContain("screened_route");
        expect(policyEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_prepin_egress");
    });

    it("never moves into a cell where an acted enemy would immediately pin the retained shot", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const fixture = setupProactiveScreenedClose(20, { x: 4, y: 5 });
        const destinationPosition = getPositionForCell(
            fixture.destination,
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );

        expect(
            fixture.context.attackHandler!.canBeAttackedByMelee(
                destinationPosition,
                fixture.shooter.isSmallSize(),
                fixture.context.grid.getEnemyAggrMatrixByUnitId(fixture.shooter.getId()),
            ),
        ).toBe(true);
        expect(new StrategyV0_8().decideTurn(fixture.shooter, fixture.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
    });

    it("keeps the pre-pin experiment default-off and computes but does not select its catalog-only control", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const disabled = setupSupportedPrepinEgress();
        expect(new StrategyV0_8().decideTurn(disabled.shooter, disabled.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);

        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "supported-prepin-egress-catalog-only-control";
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        const control = setupSupportedPrepinEgress();
        const policyEvents: IAIPolicyEvent[] = [];
        control.context.policyEventObserver = (event) => policyEvents.push(event);
        expect(new StrategyV0_8S().decideTurn(control.shooter, control.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(policyEvents).toEqual([]);

        process.env.V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS = "v0.8";
        const catalogedCandidateSeat = setupSupportedPrepinEgress();
        const catalogEvents: IAIPolicyEvent[] = [];
        catalogedCandidateSeat.context.policyEventObserver = (event) => catalogEvents.push(event);
        expect(
            new StrategyV0_8()
                .decideTurn(catalogedCandidateSeat.shooter, catalogedCandidateSeat.context)
                .map((action) => action.type),
        ).toEqual(["range_attack"]);
        expect(
            catalogEvents
                .filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel")
                .map(({ stage }) => stage),
        ).toContain("posture_safe");
        expect(catalogEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_prepin_egress");
    });

    it("consumes an identical seeded geometry stream before treatment selection and catalog-only rejection", () => {
        const decideAndReadTail = (version: "v0.8" | "v0.8s", selector: string): number[] => {
            const fixture = setupSupportedPrepinEgress();
            process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
            process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = selector;
            process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
            setDeterministicRandomSource(makeRng(0x13579bdf));
            const actions =
                version === "v0.8"
                    ? new StrategyV0_8().decideTurn(fixture.shooter, fixture.context)
                    : new StrategyV0_8S().decideTurn(fixture.shooter, fixture.context);
            expect(actions.map((action) => action.type)).toEqual(
                version === "v0.8" ? ["move_unit", "range_attack"] : ["range_attack"],
            );
            return [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
        };

        const treatmentTail = decideAndReadTail("v0.8", "v0.8");
        const controlTail = decideAndReadTail("v0.8s", "supported-prepin-egress-catalog-only-control");
        expect(controlTail).toEqual(treatmentTail);
    });

    it("does not rely on the screen staying fixed when distance alone proves immediate safety", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        for (const options of [{ guardActed: false }, { guardQueued: true }]) {
            const fixture = setupSupportedPrepinEgress(options);
            expect(
                new StrategyV0_8().decideTurn(fixture.shooter, fixture.context).map((action) => action.type),
            ).toEqual(["move_unit", "range_attack"]);
        }
    });

    it("uses stable native class identity when an acted melee guard owns a stolen quiver", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, guard, context } = setupSupportedPrepinEgress({ guardStolenQuiver: true });

        expect(guard.getUnitProperties().attack_type).toBe(MELEE);
        expect(guard.isRangeCapable()).toBe(true);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
    });

    it("does not mistake a neighboring native ranged stack for a frontline screen", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, guard, context } = setupSupportedPrepinEgress({ guardRanged: true });

        expect(guard.getUnitProperties().attack_type).toBe(RANGE);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("does not egress when the current target can immediately answer with a ranged response", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, target, context } = setupSupportedPrepinEgress({ targetRanged: true });
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        expect(target.canRespond(RANGE)).toBe(true);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
        expect(
            policyEvents.filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel").map(({ stage }) => stage),
        ).toEqual(["ordinary_shot", "eligible_shooter"]);
    });

    it("proactively repositions against next-activation exposure after the threat has already acted", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const futureThreat = setupSupportedPrepinEgress();
        futureThreat.context.fightProperties!.addAlreadyMadeTurn(UPPER, futureThreat.threat.getId());
        expect(
            new StrategyV0_8().decideTurn(futureThreat.shooter, futureThreat.context).map((action) => action.type),
        ).toEqual(["move_unit", "range_attack"]);
    });

    it("uses a screened safe cell whose immediate safety is independent of the frontline", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const { shooter, threat, context } = setupSupportedPrepinEgress({ guardActed: false });
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);
        const actions = new StrategyV0_8().decideTurn(shooter, context);

        expect(
            policyEvents.filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel").map(({ stage }) => stage),
        ).toContain("pending_distance_safe");
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [{ x: 0, y: 0 }] });
        expect(Math.max(Math.abs(threat.getBaseCell().x - 0), Math.abs(threat.getBaseCell().y - 0))).toBeGreaterThan(
            threat.getSteps() + 1,
        );
    });

    it("fails closed when another pending enemy remains within the destination's optimistic reach bound", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const { shooter, context } = setupSupportedPrepinEgress();
        const secondThreat = createTestUnit({
            team: UPPER,
            name: "Second pending charger",
            attackType: MELEE,
            speed: 1,
        });
        placeUnit(context.grid, context.unitsHolder, secondThreat, { x: 0, y: 3 });
        secondThreat.refreshPossibleAttackTypes(true);
        context.matrix = context.grid.getMatrix();

        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("rejects a screen when a second pending threat is still within distance reach", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const { shooter, context } = setupSupportedPrepinEgress();
        const secondThreat = createTestUnit({
            team: UPPER,
            name: "Second pending charger",
            attackType: MELEE,
            speed: 0,
        });
        placeUnit(context.grid, context.unitsHolder, secondThreat, { x: 4, y: 1 });
        secondThreat.refreshPossibleAttackTypes(true);
        context.matrix = context.grid.getMatrix();
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        const actions = new StrategyV0_8().decideTurn(shooter, context);
        const stages = policyEvents
            .filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel")
            .map(({ stage }) => stage);

        expect(stages).not.toContain("pending_distance_safe");
        expect(actions.map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("treats a pending native shooter as a melee-pin threat when it can reach the destination", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, threat, context } = setupSupportedPrepinEgress({ threatRanged: true });

        expect(threat.getUnitProperties().attack_type).toBe(RANGE);
        expect(threat.getPossibleAttackTypes()).toContain(MELEE);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
    });

    it("rejects egress when an unscreened pending shooter can move in and melee-pin the destination", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedPrepinEgress();
        const unscreenedShooter = createTestUnit({
            team: UPPER,
            name: "Unscreened enemy archer",
            attackType: RANGE,
            speed: 2,
            rangeShots: 8,
            shotDistance: 16,
        });
        placeUnit(context.grid, context.unitsHolder, unscreenedShooter, { x: 0, y: 3 });
        unscreenedShooter.refreshPossibleAttackTypes(true);
        context.matrix = context.grid.getMatrix();

        expect(unscreenedShooter.getPossibleAttackTypes()).toContain(MELEE);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("rejects egress when an unscreened pending caster can move in and melee-pin the destination", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedPrepinEgress();
        const unscreenedCaster = createTestUnit({
            team: UPPER,
            name: "Unscreened enemy caster",
            attackType: MAGIC,
            speed: 2,
        });
        placeUnit(context.grid, context.unitsHolder, unscreenedCaster, { x: 0, y: 3 });
        unscreenedCaster.refreshPossibleAttackTypes(false);
        context.matrix = context.grid.getMatrix();

        expect(unscreenedCaster.getUnitProperties().attack_type).toBe(MAGIC);
        expect(unscreenedCaster.getPossibleAttackTypes()).toContain(MELEE);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("rejects a guarded destination whose exact divisor regresses", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const destination = getPositionForCell(
            { x: 0, y: 0 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        let chosen:
            | {
                  fixture: ReturnType<typeof setupSupportedPrepinEgress>;
                  shot: Extract<ReturnType<StrategyV0_8["decideTurn"]>[number], { type: "range_attack" }>;
              }
            | undefined;
        for (let targetY = 4; targetY <= 14 && !chosen; targetY += 1) {
            for (let shotDistance = 2; shotDistance <= 16 && !chosen; shotDistance += 1) {
                const fixture = setupSupportedPrepinEgress({
                    targetCell: { x: 0, y: targetY },
                    shotDistance,
                });
                const shot = new StrategyV0_8().decideTurn(fixture.shooter, fixture.context)[0];
                if (
                    shot?.type !== "range_attack" ||
                    !shot.aimCell ||
                    shot.aimSide === undefined ||
                    shot.targetId !== fixture.target.getId()
                ) {
                    continue;
                }
                const currentAim = getRangeAttackSideCenter(
                    testGridSettings,
                    shot.aimCell,
                    shot.aimSide,
                    fixture.shooter.getPosition(),
                );
                const destinationAim = getRangeAttackSideCenter(
                    testGridSettings,
                    shot.aimCell,
                    shot.aimSide,
                    destination,
                );
                const current = fixture.context.attackHandler!.evaluateRangeAttack(
                    fixture.context.unitsHolder.getAllUnits(),
                    fixture.shooter,
                    fixture.shooter.getPosition(),
                    currentAim,
                    false,
                    false,
                    false,
                );
                const candidate = fixture.context.attackHandler!.evaluateRangeAttack(
                    fixture.context.unitsHolder.getAllUnits(),
                    fixture.shooter,
                    destination,
                    destinationAim,
                    false,
                    false,
                    false,
                );
                if (
                    current.affectedUnits[0]?.[0]?.getId() === fixture.target.getId() &&
                    candidate.affectedUnits[0]?.[0]?.getId() === fixture.target.getId() &&
                    candidate.rangeAttackDivisors[0]! > current.rangeAttackDivisors[0]!
                ) {
                    chosen = { fixture, shot };
                }
            }
        }
        expect(chosen).toBeDefined();

        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const actions = new StrategyV0_8().decideTurn(chosen!.fixture.shooter, chosen!.fixture.context);
        const move = actions.find((action) => action.type === "move_unit");
        expect(move?.targetCells).not.toEqual([{ x: 0, y: 0 }]);
    });

    it("turns the pre-pin egress off during the universal finish sprint", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedPrepinEgress();
        while (context.fightProperties!.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            context.fightProperties!.flipLap();
        }

        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
    });

    it("applies the exact pre-pin move and retained shot through the authoritative action engine", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, target, context } = setupSupportedPrepinEgress();
        const actions = new StrategyV0_8().decideTurn(shooter, context);
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

        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(results.every(({ completed }) => completed)).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

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
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(policyEvents.map(({ kind }) => kind)).toEqual(["v0.8_response_neutral_advance"]);

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
        const policyEvents: IAIPolicyEvent[] = [];
        armed.context.policyEventObserver = (event) => policyEvents.push(event);
        const actions = new StrategyV0_8().decideTurn(armed.shooter, armed.context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit"]);
        expect(policyEvents.map(({ kind }) => kind)).toEqual(["v0.8_supported_ranged_escape"]);
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
