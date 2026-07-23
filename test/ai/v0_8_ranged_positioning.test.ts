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

import {
    getEnemiesCellsWithinMovementRange,
    type IAIPolicyEvent,
    type IDecisionContext,
    type IV08SupportedBandAdvanceDetails,
    type IV08SupportedBandDuelDecisionSummary,
} from "../../src/ai";
import { V08_DOMINANT_FINISH_START_LAP, V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import {
    compareV08SupportedBandScreenedCloser,
    type IV08ProtectedAdvanceCatalogMetadata,
} from "../../src/ai/versions/v0_8_ranged_positioning";
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

function setupSupportedBandAdvance(
    options: {
        destination?: XY;
        guardCell?: XY;
        guardRanged?: boolean;
        includeGuard?: boolean;
        shotDistance?: number;
        shooterSpeed?: number;
        shooterAbilities?: string[];
        targetCanCounter?: boolean;
        targetRanged?: boolean;
        targetAmount?: number;
        targetAbilities?: string[];
        targetCell?: XY;
        targetMaxHp?: number;
        withActedReachableThreat?: boolean;
        withCurrentPinner?: boolean;
    } = {},
): {
    shooter: Unit;
    target: Unit;
    guard?: Unit;
    context: IDecisionContext;
    destination: XY;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Band archer",
        attackType: RANGE,
        speed: options.shooterSpeed ?? 1,
        rangeShots: 8,
        shotDistance: options.shotDistance ?? 5,
        damageMin: 10,
        damageMax: 10,
        abilities: options.shooterAbilities ?? [],
    });
    const targetRanged = options.targetRanged ?? true;
    const target = createTestUnit({
        team: UPPER,
        name: "Band target",
        attackType: targetRanged ? RANGE : MELEE,
        speed: 0,
        rangeShots: targetRanged ? 8 : 0,
        shotDistance: 16,
        damageMin: 1,
        damageMax: 1,
        amountAlive: options.targetAmount ?? 20,
        maxHp: options.targetMaxHp ?? 20,
        abilities: options.targetAbilities ?? [],
    });
    const destination = options.destination ?? { x: 5, y: 6 };
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 5, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, target, options.targetCell ?? { x: 5, y: 1 });

    let guard: Unit | undefined;
    if (options.includeGuard ?? true) {
        guard = createTestUnit({
            team: LOWER,
            name: "Band guard",
            attackType: options.guardRanged ? RANGE : MELEE,
            speed: 1,
            rangeShots: options.guardRanged ? 1 : 0,
        });
        // Offset from the firing ray, but strictly between the proposed destination and the target.
        placeUnit(combat.grid, combat.unitsHolder, guard, options.guardCell ?? { x: 6, y: 5 });
    }

    const context = decisionContext(combat);
    if (targetRanged && !options.targetCanCounter) {
        context.fightProperties!.addRepliedAttack(target.getId());
    }
    if (options.withActedReachableThreat) {
        const threat = createTestUnit({
            team: UPPER,
            name: "Acted hidden flanker",
            attackType: MELEE,
            speed: 1,
            maxHp: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, threat, { x: 7, y: 7 });
        threat.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(UPPER, threat.getId());
    }
    if (options.withCurrentPinner) {
        const pinner = createTestUnit({
            team: UPPER,
            name: "Current hidden pinner",
            attackType: MELEE,
            speed: 0,
        });
        placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 6, y: 7 });
        pinner.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(UPPER, pinner.getId());
    }
    const destinationHash = (destination.x << 4) | destination.y;
    context.matrix = combat.grid.getMatrix();
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
    shooter.refreshPossibleAttackTypes(
        combat.attackHandler.canLandRangeAttack(shooter, combat.grid.getEnemyAggrMatrixByUnitId(shooter.getId())),
    );
    return { shooter, target, guard, context, destination };
}

function setupScreenedCloserDuel(sameRoute = false): {
    shooter: Unit;
    target: Unit;
    guard: Unit;
    context: IDecisionContext;
    strictDestination: XY;
    shippedDestination: XY;
    getCatalogCalls: () => number;
} {
    const setup = setupSupportedBandAdvance({
        guardCell: { x: 1, y: 4 },
        shooterSpeed: 3,
        shotDistance: 6.3,
        targetCell: { x: 5, y: 0 },
    });
    if (!setup.guard) throw new Error("screened-closer fixture requires a native guard");
    const strictDestination = { x: 2, y: 5 };
    const shippedDestination = sameRoute ? strictDestination : { x: 5, y: 6 };
    const strictRoute = {
        cell: strictDestination,
        route: [{ x: 4, y: 6 }, { x: 3, y: 5 }, strictDestination],
        weight: 2,
        firstAggrMet: false,
        hasLavaCell: false,
        hasWaterCell: false,
    };
    const shippedRoute = sameRoute
        ? strictRoute
        : {
              cell: shippedDestination,
              route: [shippedDestination],
              weight: 1,
              firstAggrMet: false,
              hasLavaCell: false,
              hasWaterCell: false,
          };
    const routes = sameRoute ? [strictRoute] : [shippedRoute, strictRoute];
    const movePath = {
        cells: routes.map(({ cell }) => cell),
        hashes: new Set(routes.map(({ cell }) => (cell.x << 4) | cell.y)),
        knownPaths: new Map(routes.map((route) => [(route.cell.x << 4) | route.cell.y, [route]])),
    };
    let catalogCalls = 0;
    setup.context.pathHelper = {
        getMovePath: () => {
            catalogCalls += 1;
            getRandomInt(0, 1_000_000);
            return movePath;
        },
    } as unknown as PathHelper;
    setup.context.decisionOrigin = "root";
    return {
        shooter: setup.shooter,
        target: setup.target,
        guard: setup.guard,
        context: setup.context,
        strictDestination,
        shippedDestination,
        getCatalogCalls: () => catalogCalls,
    };
}

function enableScreenedCloserOverlay(): void {
    process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
    process.env.V08_RANGED_POSITION_MODE = "both";
    process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
    process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
    process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
    process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
    process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";
    process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS = "v0.8";
}

afterEach(() => {
    delete process.env.V08_RANGED_POSITION_VERSIONS;
    delete process.env.V08_RANGED_POSITION_MODE;
    delete process.env.V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS;
    delete process.env.V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY;
    delete process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS;
    delete process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY;
    delete process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS;
    setDeterministicRandomSource(undefined);
});

describe("v0.8 protected ranged positioning", () => {
    it("keeps the strict supported-band replacement default-off", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedBandAdvance();
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
        expect(policyEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(policyEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance_funnel");
    });

    it("keeps the protected-advance guardrails default-off", () => {
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
        context.decisionOrigin = "root";
        const events: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => events.push(event);

        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);
        expect(events.map(({ kind }) => kind)).not.toContain("v0.8_protected_advance_guardrail");
    });

    it("post-vetoes only pre-finish stronger-ranged and partial-band legacy advances", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";

        const run = (
            options: Parameters<typeof setupSupportedBandAdvance>[0],
            version: "v0.8" | "v0.8s",
        ): { actions: string[]; events: IAIPolicyEvent[] } => {
            const { shooter, context } = setupSupportedBandAdvance(options);
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            const strategy = version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S();
            return { actions: strategy.decideTurn(shooter, context).map((action) => action.type), events };
        };

        const stronger = run({ targetRanged: false }, "v0.8");
        expect(stronger.actions).toEqual(["range_attack"]);
        expect(stronger.events.find(({ kind }) => kind === "v0.8_protected_advance_guardrail")?.details).toMatchObject({
            reason: "ranged_superior_hold",
            divisorBefore: 2,
            divisorAfter: 1,
            enemyRangedOutput: 0,
            rangedSuperior: true,
            finishActive: false,
        });
        expect(run({ targetRanged: false }, "v0.8s").actions).toEqual(["move_unit", "range_attack"]);

        const partialOptions = {
            destination: { x: 4, y: 4 },
            shotDistance: 2,
            targetAbilities: ["No Melee"],
            includeGuard: false,
        };
        const partialControl = run(partialOptions, "v0.8s");
        expect(partialControl.actions).toEqual(["move_unit", "range_attack"]);
        const partial = run(partialOptions, "v0.8");
        expect(partial.actions).toEqual(["range_attack"]);
        expect(partial.events.find(({ kind }) => kind === "v0.8_protected_advance_guardrail")?.details).toMatchObject({
            reason: "partial_band",
            divisorBefore: 4,
            divisorAfter: 2,
            rangedSuperior: false,
            finishActive: false,
        });
    });

    it("releases the stronger-ranged hold for the full five-lap finishing runway", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE = "ranged_superior_hold";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";

        const runAtLap = (lap: number): { actions: string[]; reasons: string[] } => {
            const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
            context.decisionOrigin = "root";
            while (context.fightProperties!.getCurrentLap() < lap) {
                context.fightProperties!.flipLap();
            }
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            return {
                actions: new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type),
                reasons: events.flatMap((event) =>
                    event.kind === "v0.8_protected_advance_guardrail" ? [event.details.reason] : [],
                ),
            };
        };

        expect(runAtLap(V08_DOMINANT_FINISH_START_LAP - 1)).toEqual({
            actions: ["range_attack"],
            reasons: ["ranged_superior_hold"],
        });
        expect(runAtLap(V08_DOMINANT_FINISH_START_LAP)).toEqual({
            actions: ["move_unit", "range_attack"],
            reasons: [],
        });
    });

    it("selects protected-advance guardrail reasons independently while both preserves priority", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const run = (
            options: Parameters<typeof setupSupportedBandAdvance>[0],
            mode: "both" | "catalog_only" | "partial_band" | "ranged_superior_hold",
        ): { actions: string[]; reasons: string[] } => {
            process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE = mode;
            const { shooter, context } = setupSupportedBandAdvance(options);
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            return {
                actions: new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type),
                reasons: events.flatMap((event) =>
                    event.kind === "v0.8_protected_advance_guardrail" ? [event.details.reason] : [],
                ),
            };
        };

        expect(run({ targetRanged: false }, "partial_band")).toEqual({
            actions: ["move_unit", "range_attack"],
            reasons: [],
        });
        expect(run({ targetRanged: false }, "ranged_superior_hold")).toEqual({
            actions: ["range_attack"],
            reasons: ["ranged_superior_hold"],
        });
        expect(run({ targetRanged: false }, "catalog_only")).toEqual({
            actions: ["move_unit", "range_attack"],
            reasons: [],
        });

        const partial = {
            destination: { x: 4, y: 4 },
            shotDistance: 2,
            targetAbilities: ["No Melee"],
            includeGuard: false,
        };
        expect(run(partial, "ranged_superior_hold")).toEqual({
            actions: ["move_unit", "range_attack"],
            reasons: [],
        });
        expect(run(partial, "partial_band")).toEqual({
            actions: ["range_attack"],
            reasons: ["partial_band"],
        });
        expect(run(partial, "catalog_only")).toEqual({
            actions: ["move_unit", "range_attack"],
            reasons: [],
        });

        const overlapping = { ...partial, targetRanged: false };
        expect(run(overlapping, "partial_band")).toEqual({
            actions: ["range_attack"],
            reasons: ["partial_band"],
        });
        expect(run(overlapping, "both")).toEqual({
            actions: ["range_attack"],
            reasons: ["ranged_superior_hold"],
        });
    });

    it("makes catalog-only an exact legacy-decision and RNG-tail control without veto telemetry", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE = "catalog_only";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedBandAdvance({
            destination: { x: 4, y: 4 },
            shotDistance: 2,
            targetAbilities: ["No Melee"],
            includeGuard: false,
        });
        context.decisionOrigin = "root";
        const originalPathHelper = context.pathHelper;
        let catalogCalls = 0;
        context.pathHelper = {
            getMovePath: (...args: Parameters<PathHelper["getMovePath"]>) => {
                catalogCalls += 1;
                getRandomInt(0, 1_000_000);
                return originalPathHelper.getMovePath(...args);
            },
        } as PathHelper;
        const events: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => events.push(event);

        setDeterministicRandomSource(makeRng(0xca7a109));
        const catalogOnly = new StrategyV0_8().decideTurn(shooter, context);
        const catalogOnlyCalls = catalogCalls;
        const catalogOnlyTail = [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
        expect(events.map(({ kind }) => kind)).not.toContain("v0.8_protected_advance_guardrail");

        events.length = 0;
        setDeterministicRandomSource(makeRng(0xca7a109));
        const legacy = new StrategyV0_8S().decideTurn(shooter, context);
        const legacyCalls = catalogCalls - catalogOnlyCalls;
        const legacyTail = [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];

        expect(catalogOnly).toEqual(legacy);
        expect(catalogOnly.map(({ type }) => type)).toEqual(["move_unit", "range_attack"]);
        expect([catalogOnlyCalls, legacyCalls]).toEqual([1, 1]);
        expect(catalogOnlyTail).toEqual(legacyTail);
        expect(events.map(({ kind }) => kind)).not.toContain("v0.8_protected_advance_guardrail");
    });

    it("preserves safe full-damage legacy closes without a native guard", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const run = (version: "v0.8" | "v0.8s") => {
            const { shooter, target, context, destination } = setupSupportedBandAdvance({ includeGuard: false });
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            const actions = (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S()).decideTurn(
                shooter,
                context,
            );
            return { actions, events, targetId: target.getId(), destination };
        };

        const treatment = run("v0.8");
        const control = run("v0.8s");
        expect(treatment.actions.map((action) => action.type)).toEqual(control.actions.map((action) => action.type));
        expect(treatment.actions).toMatchObject([
            { type: "move_unit", targetCells: [treatment.destination] },
            { type: "range_attack", targetId: treatment.targetId },
        ]);
        expect(control.actions).toMatchObject([
            { type: "move_unit", targetCells: [control.destination] },
            { type: "range_attack", targetId: control.targetId },
        ]);
        expect(treatment.events.map(({ kind }) => kind)).not.toContain("v0.8_protected_advance_guardrail");
    });

    it("releases both protected-advance guardrails during dominant or urgent finish", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const cases: Array<Parameters<typeof setupSupportedBandAdvance>[0]> = [
            { targetRanged: false },
            {
                destination: { x: 4, y: 4 },
                shotDistance: 2,
                targetAbilities: ["No Melee"],
                includeGuard: false,
            },
        ];

        for (const options of cases) {
            const { shooter, target, context } = setupSupportedBandAdvance(options);
            context.decisionOrigin = "root";
            while (context.fightProperties!.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
                context.fightProperties!.flipLap();
            }
            context.fightProperties!.addRepliedAttack(target.getId());
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
                "move_unit",
                "range_attack",
            ]);
            expect(events.map(({ kind }) => kind)).not.toContain("v0.8_protected_advance_guardrail");
        }
    });

    it("hard-gates protected-advance guardrails to configured explicit live roots", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const run = (origin?: "root" | "rollout", liveOnly = "1", version: "v0.8" | "v0.8s" = "v0.8") => {
            process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = liveOnly;
            const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
            context.decisionOrigin = origin;
            return (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S())
                .decideTurn(shooter, context)
                .map((action) => action.type);
        };

        expect(run("root")).toEqual(["range_attack"]);
        expect(run("rollout")).toEqual(["move_unit", "range_attack"]);
        expect(run()).toEqual(["move_unit", "range_attack"]);
        expect(run("root", "0")).toEqual(["move_unit", "range_attack"]);
        expect(run("root", "1", "v0.8s")).toEqual(["move_unit", "range_attack"]);
    });

    it("builds one legacy catalog with equal RNG tails before guardrail selection", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.8";
        const run = (version: "v0.8" | "v0.8s") => {
            const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
            context.decisionOrigin = "root";
            const originalPathHelper = context.pathHelper;
            let catalogCalls = 0;
            context.pathHelper = {
                getMovePath: (...args: Parameters<PathHelper["getMovePath"]>) => {
                    catalogCalls += 1;
                    getRandomInt(0, 1_000_000);
                    return originalPathHelper.getMovePath(...args);
                },
            } as PathHelper;
            setDeterministicRandomSource(makeRng(0x51ec7));
            const actions = (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S())
                .decideTurn(shooter, context)
                .map((action) => action.type);
            return {
                actions,
                catalogCalls,
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const treatment = run("v0.8");
        const control = run("v0.8s");
        expect(treatment.actions).toEqual(["range_attack"]);
        expect(control.actions).toEqual(["move_unit", "range_attack"]);
        expect(treatment.catalogCalls).toBe(1);
        expect(control.catalogCalls).toBe(1);
        expect(treatment.tail).toEqual(control.tail);
    });

    it("strictly closes one damage band at a root only behind an exact native melee screen", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        const { shooter, target, guard, context, destination } = setupSupportedBandAdvance();
        context.decisionOrigin = "root";
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        const actions = new StrategyV0_8().decideTurn(shooter, context);

        expect(actions.map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [destination] });
        expect(actions[1]).toMatchObject({ type: "range_attack", targetId: target.getId() });
        expect(
            policyEvents.filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel").map(({ stage }) => stage),
        ).toEqual([
            "ordinary_shot",
            "eligible_shooter",
            "target_no_counter",
            "native_guard",
            "current_signature",
            "ranged_posture",
            "reachable_route",
            "zero_exposure_route",
            "target_screened",
            "strictly_closer",
            "retained_signature",
            "damage_band_improved",
        ]);
        const proposal = policyEvents.find(({ kind }) => kind === "v0.8_supported_band_advance");
        expect(proposal?.kind).toBe("v0.8_supported_band_advance");
        if (proposal?.kind !== "v0.8_supported_band_advance") throw new Error("missing supported-band proposal");
        expect(proposal.details).toEqual({
            fromCell: { x: 5, y: 7 },
            toCell: destination,
            targetId: target.getId(),
            targetCreatureName: target.getName(),
            exposureBefore: 0,
            exposureAfter: 0,
            divisorBefore: 2,
            divisorAfter: 1,
            targetDistanceBefore: 6,
            targetDistanceAfter: 5,
            minEnemyDistanceBefore: 6,
            minEnemyDistanceAfter: 5,
            rangedSuperior: false,
            finishActive: false,
            targetScreenedAfter: true,
            screeningGuardId: guard?.getId() ?? null,
            retainedSignatureAfter: true,
        });
    });

    it("computes the same strict catalog for treatment and catalog-only control without selecting the control", () => {
        const run = (selector: string): { actions: string[]; stages: Array<string | undefined> } => {
            process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
            process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = selector;
            process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";
            const { shooter, context } = setupSupportedBandAdvance();
            context.decisionOrigin = "root";
            const policyEvents: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => policyEvents.push(event);
            const actions = new StrategyV0_8().decideTurn(shooter, context);
            return {
                actions: actions.map((action) => action.type),
                stages: policyEvents
                    .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
                    .map(({ stage }) => stage),
            };
        };

        const treatment = run("v0.8");
        const control = run("supported-band-advance-catalog-only-control");
        expect(treatment.actions).toEqual(["move_unit", "range_attack"]);
        expect(control.actions).toEqual(["range_attack"]);
        expect(control.stages).toEqual(treatment.stages);
        expect(control.stages).toContain("damage_band_improved");
    });

    it("uses the strict replacement only at an explicit live root", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";

        const run = (decisionOrigin?: "root" | "rollout"): { actions: string[]; events: IAIPolicyEvent[] } => {
            const { shooter, context } = setupSupportedBandAdvance();
            context.decisionOrigin = decisionOrigin;
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            return {
                actions: new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type),
                events,
            };
        };

        const root = run("root");
        expect(root.actions).toEqual(["move_unit", "range_attack"]);
        expect(root.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_advance");
        for (const nonRoot of [run("rollout"), run()]) {
            // The incumbent protected advance remains active outside measured roots.
            expect(nonRoot.actions).toEqual(["move_unit", "range_attack"]);
            expect(nonRoot.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
            expect(nonRoot.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance_funnel");
        }
    });

    it("directly duels the strict full-damage policy against shipped legacy only at explicit roots", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";

        const run = (version: "v0.8" | "v0.8s", origin?: "root" | "rollout") => {
            const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
            context.decisionOrigin = origin;
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            return {
                actions: (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S())
                    .decideTurn(shooter, context)
                    .map((action) => action.type),
                events,
            };
        };

        // The strict seat holds its stronger ranged line against a melee-only army; shipped legacy safely closes.
        const strictRoot = run("v0.8", "root");
        const shippedRoot = run("v0.8s", "root");
        expect(strictRoot.actions).toEqual(["range_attack"]);
        expect(shippedRoot.actions).toEqual(["move_unit", "range_attack"]);
        const difference = strictRoot.events.find(({ kind }) => kind === "v0.8_supported_band_duel_difference");
        expect(difference?.kind).toBe("v0.8_supported_band_duel_difference");
        if (difference?.kind !== "v0.8_supported_band_duel_difference") {
            throw new Error("missing strict-vs-shipped decision difference");
        }
        expect(difference.details).toMatchObject({
            difference: "strict_hold_shipped_advance",
            strict: {
                actionTypes: ["range_attack"],
                movePath: null,
                moveTargetCells: null,
            },
            shipped: {
                actionTypes: ["move_unit", "range_attack"],
                movePath: [{ x: 5, y: 6 }],
            },
        });
        expect(shippedRoot.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        // Hypothetical search continuations remain the shipped policy for both versions.
        for (const nonRoot of [run("v0.8", "rollout"), run("v0.8s", "rollout"), run("v0.8"), run("v0.8s")]) {
            expect(nonRoot.actions).toEqual(["move_unit", "range_attack"]);
            expect(nonRoot.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        }
        delete process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY;
        expect(run("v0.8", "root").actions).toEqual(["move_unit", "range_attack"]);
        expect(run("v0.8s", "root").actions).toEqual(["move_unit", "range_attack"]);
    });

    it("does not report a strict-vs-shipped difference when both policies keep the same full-damage shot", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";

        const { shooter, context } = setupSupportedBandAdvance({ shotDistance: 16 });
        context.decisionOrigin = "root";
        const events: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => events.push(event);
        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual(["range_attack"]);
        expect(events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
    });

    it("overlays a real strict proposal but otherwise falls back to the shipped legacy decision and events", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
        process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS = "v0.8";

        const run = (version: "v0.8" | "v0.8s") => {
            const { shooter, context } = setupSupportedBandAdvance({ targetRanged: false });
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            setDeterministicRandomSource(makeRng(0x0f411bac));
            const actions = (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S()).decideTurn(
                shooter,
                context,
            );
            return {
                actions: actions.map((action) => action.type),
                destination: actions.find((action) => action.type === "move_unit")?.targetCells[0],
                events,
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const candidate = run("v0.8");
        const control = run("v0.8s");
        expect(candidate.destination).toEqual(control.destination);
        expect(candidate.tail).toEqual(control.tail);
        for (const result of [candidate, control]) {
            expect(result.actions).toEqual(["move_unit", "range_attack"]);
            expect(result.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
            expect(result.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance_funnel");
            expect(result.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        }
    });

    it("computes both duel catalogs with equal RNG tails and publishes only the selected branch telemetry", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
        // Deliberately scope funnels to both versions: the legacy seat must still suppress its speculative strict arm.
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8,v0.8s";

        const run = (version: "v0.8" | "v0.8s", arm: "replacement" | "overlay" | "overlay_control" = "replacement") => {
            if (arm !== "replacement") process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS = "v0.8";
            else delete process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS;
            if (arm === "overlay_control") {
                process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS = "v0.8";
            } else {
                delete process.env.V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS;
            }
            const { shooter, context } = setupSupportedBandAdvance();
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            const catalogDestinations = [
                { x: 4, y: 6 },
                { x: 5, y: 6 },
            ];
            let catalogCalls = 0;
            context.pathHelper = {
                getMovePath: () => {
                    const destination = catalogDestinations[catalogCalls]!;
                    catalogCalls += 1;
                    getRandomInt(0, 1_000_000);
                    const destinationHash = (destination.x << 4) | destination.y;
                    return {
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
                    };
                },
            } as PathHelper;
            setDeterministicRandomSource(makeRng(0x6f00d));
            const actions = (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S()).decideTurn(
                shooter,
                context,
            );
            return {
                actions: actions.map((action) => action.type),
                destination: actions.find((action) => action.type === "move_unit")?.targetCells[0],
                catalogCalls,
                events,
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const strict = run("v0.8");
        const legacy = run("v0.8s");
        const overlayStrict = run("v0.8", "overlay");
        const overlayLegacy = run("v0.8s", "overlay");
        const overlayControl = run("v0.8", "overlay_control");
        expect(strict.actions).toEqual(["move_unit", "range_attack"]);
        expect(legacy.actions).toEqual(["move_unit", "range_attack"]);
        // Legacy receives the first catalog and strict the second, regardless of which version selects each branch.
        expect(legacy.destination).toEqual({ x: 4, y: 6 });
        expect(strict.destination).toEqual({ x: 5, y: 6 });
        expect(strict.catalogCalls).toBe(2);
        expect(legacy.catalogCalls).toBe(2);
        expect(strict.tail).toEqual(legacy.tail);
        expect(strict.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_advance");
        expect(strict.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_advance_funnel");
        const difference = strict.events.find(({ kind }) => kind === "v0.8_supported_band_duel_difference");
        expect(difference?.kind).toBe("v0.8_supported_band_duel_difference");
        if (difference?.kind !== "v0.8_supported_band_duel_difference") {
            throw new Error("missing strict-vs-shipped different advance");
        }
        expect(difference.details).toMatchObject({
            difference: "different_advance",
            strict: {
                actionTypes: ["move_unit", "range_attack"],
                movePath: [{ x: 5, y: 6 }],
            },
            shipped: {
                actionTypes: ["move_unit", "range_attack"],
                movePath: [{ x: 4, y: 6 }],
            },
        });
        expect(legacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(legacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance_funnel");
        expect(legacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        expect(overlayStrict.actions).toEqual(strict.actions);
        expect(overlayStrict.destination).toEqual(strict.destination);
        expect(overlayStrict.catalogCalls).toBe(2);
        expect(overlayStrict.tail).toEqual(overlayLegacy.tail);
        expect(overlayStrict.tail).toEqual(strict.tail);
        expect(overlayStrict.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_advance");
        expect(overlayStrict.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_duel_difference");
        expect(overlayLegacy.actions).toEqual(legacy.actions);
        expect(overlayLegacy.destination).toEqual(legacy.destination);
        expect(overlayLegacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(overlayLegacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        expect(overlayControl.actions).toEqual(legacy.actions);
        expect(overlayControl.destination).toEqual(legacy.destination);
        expect(overlayControl.catalogCalls).toBe(2);
        expect(overlayControl.tail).toEqual(overlayStrict.tail);
        expect(overlayControl.events.map(({ kind }) => kind)).toEqual(legacy.events.map(({ kind }) => kind));
        expect(overlayControl.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(overlayControl.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance_funnel");
        expect(overlayControl.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
    });

    it("filters an equal-quality dominance proposal so alternate catalog paths cannot replace shipped", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
        process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";

        const run = (arm: "treatment" | "control" | "shipped") => {
            if (arm === "control") {
                process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS = "v0.8";
            } else {
                delete process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS;
            }
            const { shooter, context, destination } = setupSupportedBandAdvance();
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            let catalogCalls = 0;
            context.pathHelper = {
                getMovePath: () => {
                    const firstCatalog = catalogCalls === 0;
                    catalogCalls += 1;
                    getRandomInt(0, 1_000_000);
                    const destinationHash = (destination.x << 4) | destination.y;
                    const route = firstCatalog ? [{ x: 4, y: 7 }, destination] : [destination];
                    return {
                        cells: [destination],
                        hashes: new Set([destinationHash]),
                        knownPaths: new Map([
                            [
                                destinationHash,
                                [
                                    {
                                        cell: destination,
                                        route,
                                        weight: 1,
                                        firstAggrMet: false,
                                        hasLavaCell: false,
                                        hasWaterCell: false,
                                    },
                                ],
                            ],
                        ]),
                    };
                },
            } as PathHelper;
            setDeterministicRandomSource(makeRng(0xd041aace));
            const actions = (arm === "shipped" ? new StrategyV0_8S() : new StrategyV0_8()).decideTurn(shooter, context);
            return {
                actions: actions.map(({ type }) => type),
                path: actions.find((action) => action.type === "move_unit")?.path,
                catalogCalls,
                events,
                dominanceStages: events
                    .filter(
                        (event): event is Extract<IAIPolicyEvent, { kind: "v0.8_supported_band_advance_funnel" }> =>
                            event.kind === "v0.8_supported_band_advance_funnel",
                    )
                    .map(({ stage }) => stage)
                    .filter((stage) => stage.startsWith("dominance_")),
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const treatment = run("treatment");
        const control = run("control");
        const shipped = run("shipped");
        expect(treatment.actions).toEqual(["move_unit", "range_attack"]);
        expect(treatment.path).toEqual(shipped.path);
        expect(treatment.path).toEqual([
            { x: 4, y: 7 },
            { x: 5, y: 6 },
        ]);
        expect(control.actions).toEqual(shipped.actions);
        expect(control.path).toEqual(shipped.path);
        expect(treatment.catalogCalls).toBe(2);
        expect(control.catalogCalls).toBe(2);
        expect(shipped.catalogCalls).toBe(2);
        expect(treatment.tail).toEqual(control.tail);
        expect(treatment.tail).toEqual(shipped.tail);
        expect(treatment.dominanceStages).toEqual(["dominance_eligible", "dominance_filtered"]);
        expect(control.dominanceStages).toEqual(treatment.dominanceStages);
        expect(shipped.dominanceStages).toEqual([]);
        const treatmentComparison = treatment.events.find(
            (event) => event.kind === "v0.8_supported_band_dominance_comparison",
        );
        const controlComparison = control.events.find(
            (event) => event.kind === "v0.8_supported_band_dominance_comparison",
        );
        expect(treatmentComparison?.kind).toBe("v0.8_supported_band_dominance_comparison");
        expect(controlComparison?.kind).toBe("v0.8_supported_band_dominance_comparison");
        if (
            treatmentComparison?.kind !== "v0.8_supported_band_dominance_comparison" ||
            controlComparison?.kind !== "v0.8_supported_band_dominance_comparison"
        ) {
            throw new Error("missing matched equal-quality dominance comparison");
        }
        expect(controlComparison.details).toMatchObject({
            ...treatmentComparison.details,
            targetId: expect.any(String),
            strict: { ...treatmentComparison.details.strict, rangeTargetId: expect.any(String) },
            shipped: { ...treatmentComparison.details.shipped, rangeTargetId: expect.any(String) },
        });
        expect(treatmentComparison.details).toMatchObject({
            selected: false,
            dominant: false,
            metadataValid: true,
            reason: "filtered",
            strict: { movePath: [{ x: 5, y: 6 }] },
            shipped: {
                movePath: [
                    { x: 4, y: 7 },
                    { x: 5, y: 6 },
                ],
            },
            strictDivisorAfter: 1,
            strictReachableThreatsAfter: 0,
            shippedDivisorAfter: 1,
            shippedReachableThreatsAfter: 0,
        });
        expect(treatmentComparison.details.targetCreatureName).toBe("Band target");
        expect(treatmentComparison.details.strict.rangeTargetId).toBe(treatmentComparison.details.targetId);
        expect(treatmentComparison.details.shipped.rangeTargetId).toBe(treatmentComparison.details.targetId);
        for (const matched of [treatment, control]) {
            expect(matched.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
            expect(matched.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        }
    });

    it("selects a strict route with fewer reachable threats but keeps the exposed shipped route in matched control", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
        process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.8";

        const run = (selectorOff: boolean) => {
            if (selectorOff) {
                process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS = "v0.8";
            } else {
                delete process.env.V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS;
            }
            const { shooter, context } = setupSupportedBandAdvance({
                guardCell: { x: 3, y: 5 },
                targetCell: { x: 4, y: 1 },
            });
            const actedThreat = createTestUnit({
                team: UPPER,
                name: "Acted screened threat",
                attackType: MELEE,
                maxHp: 1,
            });
            placeUnit(context.grid, context.unitsHolder, actedThreat, { x: 0, y: 6 });
            actedThreat.applyBuff(
                new Spell({
                    spellProperties: getSpellConfig("System", "Hidden"),
                    amount: 1,
                }),
            );
            context.fightProperties!.addAlreadyMadeTurn(UPPER, actedThreat.getId());
            context.matrix = context.grid.getMatrix();
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            const destinations = [
                { x: 4, y: 6 },
                { x: 5, y: 6 },
            ];
            let catalogCalls = 0;
            context.pathHelper = {
                getMovePath: () => {
                    const destination = destinations[catalogCalls]!;
                    catalogCalls += 1;
                    getRandomInt(0, 1_000_000);
                    const destinationHash = (destination.x << 4) | destination.y;
                    return {
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
                    };
                },
            } as unknown as PathHelper;
            setDeterministicRandomSource(makeRng(0xd041aace));
            const actions = new StrategyV0_8().decideTurn(shooter, context);
            return {
                actions: actions.map(({ type }) => type),
                destination: actions.find((action) => action.type === "move_unit")?.targetCells?.[0],
                catalogCalls,
                events,
                dominanceStages: events
                    .filter(
                        (event): event is Extract<IAIPolicyEvent, { kind: "v0.8_supported_band_advance_funnel" }> =>
                            event.kind === "v0.8_supported_band_advance_funnel",
                    )
                    .map(({ stage }) => stage)
                    .filter((stage) => stage.startsWith("dominance_")),
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const treatment = run(false);
        const control = run(true);
        expect(treatment.actions).toEqual(["move_unit", "range_attack"]);
        expect(control.actions).toEqual(["move_unit", "range_attack"]);
        expect(treatment.destination).toEqual({ x: 5, y: 6 });
        expect(control.destination).toEqual({ x: 4, y: 6 });
        expect(treatment.catalogCalls).toBe(2);
        expect(control.catalogCalls).toBe(2);
        expect(treatment.tail).toEqual(control.tail);
        expect(treatment.dominanceStages).toEqual(["dominance_eligible", "dominance_dominant"]);
        expect(control.dominanceStages).toEqual(treatment.dominanceStages);
        const treatmentComparison = treatment.events.find(
            (event) => event.kind === "v0.8_supported_band_dominance_comparison",
        );
        const controlComparison = control.events.find(
            (event) => event.kind === "v0.8_supported_band_dominance_comparison",
        );
        expect(treatmentComparison?.kind).toBe("v0.8_supported_band_dominance_comparison");
        expect(controlComparison?.kind).toBe("v0.8_supported_band_dominance_comparison");
        if (
            treatmentComparison?.kind !== "v0.8_supported_band_dominance_comparison" ||
            controlComparison?.kind !== "v0.8_supported_band_dominance_comparison"
        ) {
            throw new Error("missing matched dominant comparison");
        }
        expect(treatmentComparison.details).toMatchObject({
            selected: true,
            dominant: true,
            metadataValid: true,
            reason: "lower_reachable_threats",
            strict: { actionTypes: ["move_unit", "range_attack"] },
            shipped: { actionTypes: ["move_unit", "range_attack"] },
            strictDivisorAfter: 1,
            strictReachableThreatsAfter: 0,
            shippedDivisorAfter: 1,
            shippedReachableThreatsAfter: 1,
        });
        expect(treatmentComparison.details.targetCreatureName).toBe("Band target");
        expect(treatmentComparison.details.strict.rangeTargetId).toBe(treatmentComparison.details.targetId);
        expect(treatmentComparison.details.shipped.rangeTargetId).toBe(treatmentComparison.details.targetId);
        expect(controlComparison.details.strict.rangeTargetId).toBe(controlComparison.details.targetId);
        expect(controlComparison.details.shipped.rangeTargetId).toBe(controlComparison.details.targetId);
        expect(controlComparison.details).toMatchObject({
            ...treatmentComparison.details,
            selected: false,
            targetId: expect.any(String),
            strict: { ...treatmentComparison.details.strict, rangeTargetId: expect.any(String) },
            shipped: { ...treatmentComparison.details.shipped, rangeTargetId: expect.any(String) },
        });
        expect(treatment.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_advance");
        expect(treatment.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_duel_difference");
        expect(control.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(control.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
    });

    it("selects only the native-screened closer route with matched control catalogs and RNG tails", () => {
        enableScreenedCloserOverlay();
        const run = (arm: "treatment" | "control" | "shipped") => {
            if (arm === "control") {
                process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS = "v0.8";
            } else {
                delete process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS;
            }
            const fixture = setupScreenedCloserDuel();
            const events: IAIPolicyEvent[] = [];
            fixture.context.policyEventObserver = (event) => events.push(event);
            setDeterministicRandomSource(makeRng(0x5c4eeaed));
            const actions = (arm === "shipped" ? new StrategyV0_8S() : new StrategyV0_8()).decideTurn(
                fixture.shooter,
                fixture.context,
            );
            return {
                actions,
                events,
                fixture,
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const treatment = run("treatment");
        const control = run("control");
        const shipped = run("shipped");
        expect(treatment.actions.find(({ type }) => type === "move_unit")?.targetCells?.[0]).toEqual(
            treatment.fixture.strictDestination,
        );
        expect(control.actions.find(({ type }) => type === "move_unit")?.targetCells?.[0]).toEqual(
            control.fixture.shippedDestination,
        );
        expect(shipped.actions.find(({ type }) => type === "move_unit")?.targetCells?.[0]).toEqual(
            shipped.fixture.shippedDestination,
        );
        expect(treatment.fixture.getCatalogCalls()).toBe(2);
        expect(control.fixture.getCatalogCalls()).toBe(2);
        expect(shipped.fixture.getCatalogCalls()).toBe(2);
        expect(treatment.tail).toEqual(control.tail);
        expect(treatment.tail).toEqual(shipped.tail);

        const treatmentComparison = treatment.events.find(
            ({ kind }) => kind === "v0.8_supported_band_screened_closer_comparison",
        );
        const controlComparison = control.events.find(
            ({ kind }) => kind === "v0.8_supported_band_screened_closer_comparison",
        );
        expect(treatmentComparison?.kind).toBe("v0.8_supported_band_screened_closer_comparison");
        expect(controlComparison?.kind).toBe("v0.8_supported_band_screened_closer_comparison");
        if (
            treatmentComparison?.kind !== "v0.8_supported_band_screened_closer_comparison" ||
            controlComparison?.kind !== "v0.8_supported_band_screened_closer_comparison"
        ) {
            throw new Error("missing matched screened-closer comparison");
        }
        expect(treatmentComparison.details).toMatchObject({
            selected: true,
            dominant: true,
            metadataValid: true,
            reason: "screened_closer",
            strictDivisorAfter: 1,
            strictReachableThreatsAfter: 0,
            strictTargetDistanceBefore: 7,
            strictTargetDistanceAfter: 5,
            strictTargetScreenedAfter: true,
            strictScreeningGuardId: treatment.fixture.guard.getId(),
            strictRetainedSignatureAfter: true,
            shippedDivisorAfter: 1,
            shippedReachableThreatsAfter: 0,
            shippedTargetDistanceBefore: 7,
            shippedTargetDistanceAfter: 6,
            shippedTargetScreenedAfter: false,
            shippedScreeningGuardId: null,
            shippedRetainedSignatureAfter: true,
        });
        expect(controlComparison.details).toMatchObject({
            selected: false,
            dominant: true,
            metadataValid: true,
            reason: "screened_closer",
        });
        expect(
            treatment.events
                .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
                .map(({ stage }) => stage)
                .filter((stage) => stage?.startsWith("screened_closer_")),
        ).toEqual(["screened_closer_eligible", "screened_closer_dominant"]);
        expect(
            control.events
                .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
                .map(({ stage }) => stage)
                .filter((stage) => stage?.startsWith("screened_closer_")),
        ).toEqual(["screened_closer_eligible", "screened_closer_dominant"]);
        expect(treatment.events.map(({ kind }) => kind)).toContain("v0.8_supported_band_duel_difference");
        expect(control.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        expect(shipped.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_screened_closer_comparison");
    });

    it("filters a same-route screened-closer comparison without manufacturing a decision difference", () => {
        enableScreenedCloserOverlay();
        const fixture = setupScreenedCloserDuel(true);
        const events: IAIPolicyEvent[] = [];
        fixture.context.policyEventObserver = (event) => events.push(event);
        const actions = new StrategyV0_8().decideTurn(fixture.shooter, fixture.context);
        const comparison = events.find(({ kind }) => kind === "v0.8_supported_band_screened_closer_comparison");

        expect(actions.find(({ type }) => type === "move_unit")?.targetCells?.[0]).toEqual(fixture.shippedDestination);
        expect(comparison?.kind).toBe("v0.8_supported_band_screened_closer_comparison");
        if (comparison?.kind !== "v0.8_supported_band_screened_closer_comparison") {
            throw new Error("missing same-route screened-closer comparison");
        }
        expect(comparison.details).toMatchObject({
            selected: false,
            dominant: false,
            metadataValid: true,
            reason: "filtered",
            strictTargetScreenedAfter: true,
            shippedTargetScreenedAfter: true,
        });
        expect(comparison.details.strict).toEqual(comparison.details.shipped);
        expect(events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_duel_difference");
        expect(
            events
                .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
                .map(({ stage }) => stage)
                .filter((stage) => stage?.startsWith("screened_closer_")),
        ).toEqual(["screened_closer_eligible", "screened_closer_filtered"]);
    });

    it("separates valid screened-closer filters from malformed catalog integrity failures", () => {
        const strictDetails: IV08SupportedBandAdvanceDetails = {
            fromCell: { x: 5, y: 7 },
            toCell: { x: 5, y: 4 },
            targetId: "target",
            targetCreatureName: "Target",
            exposureBefore: 0,
            exposureAfter: 0,
            divisorBefore: 2,
            divisorAfter: 1,
            targetDistanceBefore: 6,
            targetDistanceAfter: 3,
            minEnemyDistanceBefore: 6,
            minEnemyDistanceAfter: 3,
            rangedSuperior: false,
            finishActive: false,
            targetScreenedAfter: true,
            screeningGuardId: "guard",
            retainedSignatureAfter: true,
        };
        const summary = (destination: XY, path: XY[]): IV08SupportedBandDuelDecisionSummary => ({
            actionTypes: ["move_unit", "range_attack"],
            movePath: path,
            moveTargetCells: [destination],
            moveHasLavaCell: false,
            moveHasWaterCell: false,
            rangeTargetId: "target",
            rangeAimCell: { x: 5, y: 1 },
            rangeAimSide: 0,
        });
        const strictSummary = summary(strictDetails.toCell, [
            { x: 5, y: 6 },
            { x: 5, y: 5 },
            { x: 5, y: 4 },
        ]);
        const shippedSummary = summary({ x: 9, y: 2 }, [
            { x: 6, y: 6 },
            { x: 7, y: 5 },
            { x: 8, y: 4 },
            { x: 9, y: 3 },
            { x: 9, y: 2 },
        ]);
        const shippedMetadata: IV08ProtectedAdvanceCatalogMetadata = {
            fromCell: { ...strictDetails.fromCell },
            toCell: { x: 9, y: 2 },
            targetId: strictDetails.targetId,
            targetCreatureName: strictDetails.targetCreatureName,
            divisorBefore: 2,
            divisorAfter: 1,
            ownRangedOutput: 80,
            enemyRangedOutput: 20,
            finishActive: false,
            reachableThreatsAfter: 0,
            targetDistanceBefore: 6,
            targetDistanceAfter: 4,
            targetScreenedAfter: false,
            screeningGuardId: null,
            retainedSignatureAfter: true,
        };
        expect(
            compareV08SupportedBandScreenedCloser(strictDetails, strictSummary, shippedMetadata, shippedSummary),
        ).toMatchObject({ dominant: true, metadataValid: true, reason: "screened_closer" });
        const shotOnlySummary: IV08SupportedBandDuelDecisionSummary = {
            actionTypes: ["range_attack"],
            movePath: null,
            moveTargetCells: null,
            moveHasLavaCell: null,
            moveHasWaterCell: null,
            rangeTargetId: "target",
            rangeAimCell: { x: 5, y: 1 },
            rangeAimSide: 0,
        };
        const validFilters: Array<
            readonly [
                IV08SupportedBandAdvanceDetails,
                IV08ProtectedAdvanceCatalogMetadata | undefined,
                IV08SupportedBandDuelDecisionSummary,
            ]
        > = [
            [strictDetails, undefined, shotOnlySummary],
            [strictDetails, { ...shippedMetadata, retainedSignatureAfter: false }, shippedSummary],
            [
                strictDetails,
                {
                    ...shippedMetadata,
                    targetDistanceAfter: shippedMetadata.targetDistanceBefore,
                },
                shippedSummary,
            ],
            [strictDetails, { ...shippedMetadata, reachableThreatsAfter: 1 }, shippedSummary],
            [
                strictDetails,
                {
                    ...shippedMetadata,
                    targetScreenedAfter: true,
                    screeningGuardId: "shipped-guard",
                },
                shippedSummary,
            ],
            [
                strictDetails,
                {
                    ...shippedMetadata,
                    toCell: { ...strictDetails.toCell },
                    targetDistanceAfter: strictDetails.targetDistanceAfter,
                },
                strictSummary,
            ],
            [
                { ...strictDetails, divisorBefore: 4 },
                { ...shippedMetadata, divisorBefore: 4, divisorAfter: 2 },
                shippedSummary,
            ],
        ];
        for (const [details, metadata, decision] of validFilters) {
            expect(compareV08SupportedBandScreenedCloser(details, strictSummary, metadata, decision)).toMatchObject({
                dominant: false,
                metadataValid: true,
                reason: "filtered",
            });
        }
        for (const malformed of [
            { ...shippedMetadata, divisorAfter: shippedMetadata.divisorBefore },
            { ...shippedMetadata, targetScreenedAfter: false, screeningGuardId: "impossible-guard" },
            { ...shippedMetadata, targetDistanceBefore: shippedMetadata.targetDistanceBefore + 1 },
            { ...shippedMetadata, fromCell: { x: 16, y: 7 } },
        ]) {
            expect(
                compareV08SupportedBandScreenedCloser(strictDetails, strictSummary, malformed, shippedSummary),
            ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        }
        expect(
            compareV08SupportedBandScreenedCloser(strictDetails, strictSummary, undefined, shippedSummary),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                {
                    ...strictSummary,
                    movePath: [...strictSummary.movePath!, { x: Number.POSITIVE_INFINITY, y: 4 }],
                    rangeAimSide: 7,
                },
                shippedMetadata,
                shippedSummary,
            ),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
    });

    it("executes the screened-closer move and retained shot through the authoritative action engine", () => {
        enableScreenedCloserOverlay();
        const { shooter, target, context, strictDestination } = setupScreenedCloserDuel();
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

        expect(actions.map(({ type }) => type)).toEqual(["move_unit", "range_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [strictDestination] });
        expect(results.every(({ completed }) => completed)).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("does not duplicate pinned retreat after duel branch selection", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "0";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";

        const run = (version: "v0.8" | "v0.8s") => {
            const { shooter, context } = setupPinnedShooter(3);
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            const originalPathHelper = context.pathHelper;
            let movePathCalls = 0;
            context.pathHelper = {
                getMovePath: (...args: Parameters<PathHelper["getMovePath"]>) => {
                    movePathCalls += 1;
                    return originalPathHelper.getMovePath(...args);
                },
            } as PathHelper;
            setDeterministicRandomSource(makeRng(0x6f00e));
            const actions = (version === "v0.8" ? new StrategyV0_8() : new StrategyV0_8S()).decideTurn(
                shooter,
                context,
            );
            return {
                actions,
                events,
                movePathCalls,
                tail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
            };
        };

        const strict = run("v0.8");
        const legacy = run("v0.8s");
        delete process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS;
        const shippedBaseline = run("v0.8");
        expect(strict.actions.map((action) => action.type)).toEqual(["move_unit"]);
        expect(legacy.actions.map((action) => action.type)).toEqual(["move_unit"]);
        expect(strict.actions[0]).toMatchObject({
            type: "move_unit",
            path: legacy.actions[0]?.type === "move_unit" ? legacy.actions[0].path : undefined,
            targetCells: legacy.actions[0]?.type === "move_unit" ? legacy.actions[0].targetCells : undefined,
        });
        expect(strict.movePathCalls).toBe(shippedBaseline.movePathCalls);
        expect(legacy.movePathCalls).toBe(shippedBaseline.movePathCalls);
        expect(strict.tail).toEqual(legacy.tail);
        expect(strict.tail).toEqual(shippedBaseline.tail);
        expect(strict.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(legacy.events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
    });

    it("preserves the deterministic catalog stream before treatment selection", () => {
        const decideAndReadTail = (selector: string): number[] => {
            process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
            process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = selector;
            const { shooter, context } = setupSupportedBandAdvance();
            context.decisionOrigin = "root";
            setDeterministicRandomSource(makeRng(0x8badf00d));
            const actions = new StrategyV0_8().decideTurn(shooter, context);
            expect(actions.map((action) => action.type)).toEqual(
                selector === "v0.8" ? ["move_unit", "range_attack"] : ["range_attack"],
            );
            return [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
        };

        expect(decideAndReadTail("v0.8")).toEqual(decideAndReadTail("supported-band-advance-catalog-only-control"));
    });

    it("requires native melee support rather than an empty or ranged guard slot", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        for (const options of [{ includeGuard: false }, { guardRanged: true }]) {
            const { shooter, context } = setupSupportedBandAdvance(options);
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);

            expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
                "range_attack",
            ]);
            expect(events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
            expect(
                events.filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel").map(({ stage }) => stage),
            ).not.toContain("native_guard");
        }
    });

    it("rejects a current pin and an acted enemy that can still reach the proposed cell next lap", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";

        const pinned = setupSupportedBandAdvance({ withCurrentPinner: true });
        pinned.context.decisionOrigin = "root";
        const pinnedEvents: IAIPolicyEvent[] = [];
        pinned.context.policyEventObserver = (event) => pinnedEvents.push(event);
        const pinnedActions = new StrategyV0_8().decideTurn(pinned.shooter, pinned.context);
        expect(pinnedActions.map((action) => action.type)).not.toEqual(["move_unit", "range_attack"]);
        expect(pinnedEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");

        const reachable = setupSupportedBandAdvance({ withActedReachableThreat: true });
        reachable.context.decisionOrigin = "root";
        const reachableEvents: IAIPolicyEvent[] = [];
        reachable.context.policyEventObserver = (event) => reachableEvents.push(event);
        expect(
            new StrategyV0_8().decideTurn(reachable.shooter, reachable.context).map((action) => action.type),
        ).toEqual(["range_attack"]);
        expect(reachableEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        expect(
            reachableEvents
                .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
                .map(({ stage }) => stage),
        ).not.toContain("zero_exposure_route");
    });

    it("requires a strict close into full damage rather than merely a better partial band", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";

        const lateral = setupSupportedBandAdvance({ destination: { x: 6, y: 7 } });
        lateral.context.decisionOrigin = "root";
        const lateralEvents: IAIPolicyEvent[] = [];
        lateral.context.policyEventObserver = (event) => lateralEvents.push(event);
        expect(new StrategyV0_8().decideTurn(lateral.shooter, lateral.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(
            lateralEvents.filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel").map(({ stage }) => stage),
        ).not.toContain("strictly_closer");

        const sameBand = setupSupportedBandAdvance({ shotDistance: 3 });
        sameBand.context.decisionOrigin = "root";
        const sameBandEvents: IAIPolicyEvent[] = [];
        sameBand.context.policyEventObserver = (event) => sameBandEvents.push(event);
        expect(new StrategyV0_8().decideTurn(sameBand.shooter, sameBand.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        const sameBandStages = sameBandEvents
            .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
            .map(({ stage }) => stage);
        expect(sameBandStages).toContain("retained_signature");
        expect(sameBandStages).not.toContain("damage_band_improved");

        const partialBand = setupSupportedBandAdvance({
            destination: { x: 5, y: 5 },
            guardCell: { x: 6, y: 4 },
            shotDistance: 3,
            targetAbilities: ["No Melee"],
        });
        partialBand.context.decisionOrigin = "root";
        const partialBandEvents: IAIPolicyEvent[] = [];
        partialBand.context.policyEventObserver = (event) => partialBandEvents.push(event);
        const partialBandActions = new StrategyV0_8().decideTurn(partialBand.shooter, partialBand.context);
        expect(partialBandActions.map((action) => action.type)).toEqual(["range_attack"]);
        const partialBandShot = partialBandActions[0];
        if (
            partialBandShot?.type !== "range_attack" ||
            !partialBandShot.aimCell ||
            partialBandShot.aimSide === undefined
        ) {
            throw new Error("expected retained ordinary shot");
        }
        const partialOrigin = getPositionForCell(
            partialBand.destination,
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        const currentAim = getRangeAttackSideCenter(
            testGridSettings,
            partialBandShot.aimCell,
            partialBandShot.aimSide,
            partialBand.shooter.getPosition(),
        );
        const partialAim = getRangeAttackSideCenter(
            testGridSettings,
            partialBandShot.aimCell,
            partialBandShot.aimSide,
            partialOrigin,
        );
        expect([
            partialBand.context.attackHandler!.getRangeAttackDivisor(partialBand.shooter, currentAim),
            partialBand.context.attackHandler!.getRangeAttackDivisor(partialBand.shooter, partialAim, partialOrigin),
        ]).toEqual([4, 2]);
        const partialBandStages = partialBandEvents
            .filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel")
            .map(({ stage }) => stage);
        expect(partialBandStages).toContain("retained_signature");
        expect(partialBandStages).not.toContain("damage_band_improved");
    });

    it("holds every stronger ranged line before finish, including against zero enemy ranged output", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        for (const options of [{ targetAmount: 1 }, { targetRanged: false }]) {
            const { shooter, context } = setupSupportedBandAdvance(options);
            context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);

            expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toEqual([
                "range_attack",
            ]);
            expect(events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
            expect(
                events.filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel").map(({ stage }) => stage),
            ).not.toContain("ranged_posture");
        }
    });

    it("releases only the stronger-ranged posture veto during finish and retains the safety proof", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";

        const safe = setupSupportedBandAdvance({ targetAmount: 1, targetMaxHp: 1 });
        safe.context.decisionOrigin = "root";
        expect(new StrategyV0_8().decideTurn(safe.shooter, safe.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        while (safe.context.fightProperties!.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            safe.context.fightProperties!.flipLap();
        }
        safe.context.fightProperties!.addRepliedAttack(safe.target.getId());
        const safeEvents: IAIPolicyEvent[] = [];
        safe.context.policyEventObserver = (event) => safeEvents.push(event);
        const safeActionTypes = new StrategyV0_8().decideTurn(safe.shooter, safe.context).map((action) => action.type);
        expect(safeActionTypes).toEqual(["move_unit", "range_attack"]);
        const safeProposal = safeEvents.find(({ kind }) => kind === "v0.8_supported_band_advance");
        expect(safeProposal?.kind).toBe("v0.8_supported_band_advance");
        if (safeProposal?.kind !== "v0.8_supported_band_advance") throw new Error("missing finish proposal");
        expect(safeProposal.details).toMatchObject({ rangedSuperior: true, finishActive: true });

        const unsafe = setupSupportedBandAdvance({
            targetAmount: 1,
            targetMaxHp: 1,
            withActedReachableThreat: true,
        });
        unsafe.context.decisionOrigin = "root";
        while (unsafe.context.fightProperties!.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            unsafe.context.fightProperties!.flipLap();
        }
        unsafe.context.fightProperties!.addRepliedAttack(unsafe.target.getId());
        const unsafeEvents: IAIPolicyEvent[] = [];
        unsafe.context.policyEventObserver = (event) => unsafeEvents.push(event);
        expect(new StrategyV0_8().decideTurn(unsafe.shooter, unsafe.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(unsafeEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
    });

    it("rejects a live counter and special ranged attack signatures", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";

        const counter = setupSupportedBandAdvance({ targetCanCounter: true });
        counter.context.decisionOrigin = "root";
        const counterEvents: IAIPolicyEvent[] = [];
        counter.context.policyEventObserver = (event) => counterEvents.push(event);
        expect(new StrategyV0_8().decideTurn(counter.shooter, counter.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(
            counterEvents.filter(({ kind }) => kind === "v0.8_supported_band_advance_funnel").map(({ stage }) => stage),
        ).toEqual(["ordinary_shot", "eligible_shooter"]);

        for (const ability of ["Sniper", "Through Shot", "Large Caliber", "Area Throw", "Double Shot"]) {
            const special = setupSupportedBandAdvance({ shooterAbilities: [ability] });
            special.context.decisionOrigin = "root";
            const events: IAIPolicyEvent[] = [];
            special.context.policyEventObserver = (event) => events.push(event);
            const actions = new StrategyV0_8().decideTurn(special.shooter, special.context);
            expect(actions.some((action) => action.type === "move_unit")).toBe(false);
            expect(events.map(({ kind }) => kind)).not.toContain("v0.8_supported_band_advance");
        }
    });

    it("executes the strict move and retained shot through the authoritative action engine", () => {
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        const { shooter, target, context } = setupSupportedBandAdvance();
        context.decisionOrigin = "root";
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
        const proposal = policyEvents.find(({ kind }) => kind === "v0.8_supported_prepin_egress");
        expect(proposal?.kind).toBe("v0.8_supported_prepin_egress");
        if (proposal?.kind !== "v0.8_supported_prepin_egress") throw new Error("missing pre-pin proposal");
        expect(proposal.details).toEqual({
            fromCell: { x: 0, y: 1 },
            toCell: { x: 0, y: 0 },
            targetId: target.getId(),
            targetCreatureName: target.getName(),
            exposureBefore: 1,
            exposureAfter: 0,
            divisorBefore: 1,
            divisorAfter: 1,
            targetDistanceBefore: 9,
            targetDistanceAfter: 10,
            minEnemyDistanceBefore: 4,
            minEnemyDistanceAfter: 5,
            rangedSuperior: true,
        });
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
        const weakerProposal = weakerEvents.find(({ kind }) => kind === "v0.8_supported_prepin_egress");
        expect(weakerProposal?.kind).toBe("v0.8_supported_prepin_egress");
        if (weakerProposal?.kind !== "v0.8_supported_prepin_egress") throw new Error("missing pre-pin proposal");
        expect(weakerProposal.details).toEqual({
            fromCell: { x: 5, y: 7 },
            toCell: weaker.destination,
            targetId: weaker.target.getId(),
            targetCreatureName: weaker.target.getName(),
            exposureBefore: 1,
            exposureAfter: 0,
            divisorBefore: 2,
            divisorAfter: 1,
            targetDistanceBefore: 6,
            targetDistanceAfter: 5,
            minEnemyDistanceBefore: 4,
            minEnemyDistanceAfter: 5,
            rangedSuperior: false,
        });
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

    it("selects the live-only arm only at an explicit root while retaining the rollout catalog", () => {
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";

        const root = setupSupportedPrepinEgress();
        root.context.decisionOrigin = "root";
        expect(new StrategyV0_8().decideTurn(root.shooter, root.context).map((action) => action.type)).toEqual([
            "move_unit",
            "range_attack",
        ]);

        const rollout = setupSupportedPrepinEgress();
        rollout.context.decisionOrigin = "rollout";
        const rolloutEvents: IAIPolicyEvent[] = [];
        rollout.context.policyEventObserver = (event) => rolloutEvents.push(event);
        expect(new StrategyV0_8().decideTurn(rollout.shooter, rollout.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
        expect(
            rolloutEvents
                .filter(({ kind }) => kind === "v0.8_supported_prepin_egress_funnel")
                .map(({ stage }) => stage),
        ).toContain("posture_safe");
        expect(rolloutEvents.map(({ kind }) => kind)).not.toContain("v0.8_supported_prepin_egress");

        const omitted = setupSupportedPrepinEgress();
        expect(new StrategyV0_8().decideTurn(omitted.shooter, omitted.context).map((action) => action.type)).toEqual([
            "range_attack",
        ]);
    });

    it("consumes the same seeded rollout catalog stream in live-only treatment and selector-off control", () => {
        const decideAndReadTail = (selector: string): number[] => {
            const fixture = setupSupportedPrepinEgress();
            fixture.context.decisionOrigin = "rollout";
            process.env.V08_RANGED_POSITION_MODE = "retreat";
            process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
            process.env.V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY = "1";
            process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = selector;
            setDeterministicRandomSource(makeRng(0x2468ace0));
            expect(
                new StrategyV0_8().decideTurn(fixture.shooter, fixture.context).map((action) => action.type),
            ).toEqual(["range_attack"]);
            return [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
        };

        expect(decideAndReadTail("v0.8")).toEqual(decideAndReadTail("supported-prepin-egress-catalog-only-control"));
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
        const proposal = policyEvents.find((event) => event.kind === "v0.8_supported_ranged_escape");
        expect(proposal?.details).toMatchObject({
            targetCreatureName: "Current pinner",
            screeningFrontlinerCreatureName: "Bodyguard",
            meleeHitChance: 1,
        });
        expect(proposal?.details.expectedEffectiveMeleeDamage).toBeGreaterThan(0);
        expect(proposal?.details.unscreenedThreatsAfter).toBeLessThan(proposal?.details.unscreenedThreatsBefore ?? 0);
        expect(proposal?.details.reachableThreatsAfter).toBeLessThanOrEqual(
            proposal?.details.reachableThreatsBefore ?? 0,
        );
    });

    it("catalogs the weak-melee funnel at live roots while the selector-off control retains melee", () => {
        process.env.V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS = "supported-ranged-delta-catalog-only-control";
        const { shooter, context } = setupPartiallyScreenedPinnedShooter();
        context.decisionOrigin = "root";
        const policyEvents: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => policyEvents.push(event);

        expect(new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type)).toContain("melee_attack");
        expect(
            policyEvents
                .filter((event) => event.kind === "v0.8_supported_ranged_escape_funnel")
                .map((event) => event.stage),
        ).toEqual([
            "melee_incumbent",
            "attack_context",
            "current_ranged_mode",
            "ammo",
            "mobile",
            "ordinary_shooter",
            "range_unsuppressed",
            "currently_pinned",
            "no_nonmelee_commitment",
            "finish_override_clear",
            "armageddon_buffer_clear",
            "target_found",
            "damage_supported",
            "nonsecure_melee",
            "live_enemies",
            "frontline_present",
            "reachable_route",
            "valid_route",
            "target_screen_route",
            "unscreened_reduced_route",
            "exposure_nonincreasing_route",
            "partial_delta_route",
            "delta_only_best",
        ]);
        expect(policyEvents.map((event) => event.kind)).not.toContain("v0.8_supported_ranged_escape");
    });

    it("isolates supported-delta selection to live roots without changing the catalog RNG stream", () => {
        const decide = (
            selector: string,
            origin: IDecisionContext["decisionOrigin"],
        ): { actionTypes: string[]; events: IAIPolicyEvent[]; tail: number[] } => {
            process.env.V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS = "v0.8";
            process.env.V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY = "1";
            process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS = selector;
            const { shooter, context } = setupPartiallyScreenedPinnedShooter();
            context.decisionOrigin = origin;
            const events: IAIPolicyEvent[] = [];
            context.policyEventObserver = (event) => events.push(event);
            setDeterministicRandomSource(makeRng(0x61a8d37c));
            const actionTypes = new StrategyV0_8().decideTurn(shooter, context).map((action) => action.type);
            const tail = [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
            return { actionTypes, events, tail };
        };

        const treatment = decide("v0.8", "root");
        const control = decide("supported-ranged-delta-catalog-only-control", "root");
        expect(treatment.actionTypes).toEqual(["move_unit"]);
        expect(control.actionTypes).toContain("melee_attack");
        expect(treatment.tail).toEqual(control.tail);
        expect(treatment.events.map((event) => event.kind)).toContain("v0.8_supported_ranged_escape");
        expect(control.events.map((event) => event.kind)).not.toContain("v0.8_supported_ranged_escape");

        const rolloutTreatment = decide("v0.8", "rollout");
        const rolloutControl = decide("supported-ranged-delta-catalog-only-control", "rollout");
        expect(rolloutTreatment.actionTypes).toEqual(rolloutControl.actionTypes);
        expect(rolloutTreatment.actionTypes).toContain("melee_attack");
        expect(rolloutTreatment.tail).toEqual(rolloutControl.tail);
        expect(rolloutTreatment.events).toEqual([]);
        expect(decide("v0.8", undefined).actionTypes).toContain("melee_attack");
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
