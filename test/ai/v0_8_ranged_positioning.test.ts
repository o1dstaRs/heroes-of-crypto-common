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
    movesThenFiresFromRange,
    type IV08ProtectedAdvanceCatalogMetadata,
} from "../../src/ai/versions/v0_8_ranged_positioning";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
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

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
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
        team: LEFT,
        name: "Supported Archer",
        attackType: RANGE,
        initiative: 3,
        rangeShots: 8,
        shotDistance: 3,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: RIGHT,
        name: "Distant Target",
        attackType: rangedTarget ? RANGE : MELEE,
        initiative: 1,
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
        const screen = createTestUnit({ team: LEFT, name: "Frontline", attackType: MELEE, initiative: 1 });
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
        team: LEFT,
        name: handyman ? "Handyman Archer" : "Pinned Archer",
        attackType: RANGE,
        initiative: 3,
        rangeShots: 8,
        damageMin: 4,
        damageMax: 4,
        abilities: handyman ? ["Handyman"] : [],
    });
    const pinner = createTestUnit({
        team: RIGHT,
        name: "Pinner",
        attackType: MELEE,
        initiative: 1,
        maxHp: targetHp,
    });
    const screen = createTestUnit({ team: LEFT, name: "Bodyguard", attackType: MELEE, initiative: 1 });
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
        team: LEFT,
        name: "Partially screened archer",
        attackType: RANGE,
        initiative: 2,
        rangeShots: 8,
        damageMin: 4,
        damageMax: 4,
    });
    const pinner = createTestUnit({ team: RIGHT, name: "Current pinner", attackType: MELEE, initiative: 1, maxHp: 3 });
    const rightThreat = createTestUnit({
        team: RIGHT,
        name: "Upper threat",
        attackType: MELEE,
        initiative: 10,
        maxHp: 100,
    });
    const leftThreat = createTestUnit({
        team: RIGHT,
        name: "Lower threat",
        attackType: MELEE,
        initiative: 10,
        maxHp: 100,
    });
    const screen = createTestUnit({ team: LEFT, name: "Bodyguard", attackType: MELEE, initiative: 1 });
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 6, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 7, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, rightThreat, { x: 4, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, leftThreat, { x: 4, y: 4 });
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
        threatInitiative?: number;
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
        team: LEFT,
        name: "Pre-pin Archer",
        attackType: RANGE,
        initiative: 1,
        rangeShots: 8,
        shotDistance: options.shotDistance ?? 16,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: RIGHT,
        name: "Shot target",
        attackType: options.targetRanged ? RANGE : MELEE,
        initiative: 0,
        rangeShots: options.targetRanged ? 8 : 0,
        shotDistance: 16,
        amountAlive: 10,
        maxHp: 20,
    });
    const threat = createTestUnit({
        team: RIGHT,
        name: "Pending charger",
        attackType: options.threatRanged ? RANGE : MELEE,
        initiative: options.threatInitiative ?? 2,
        rangeShots: options.threatRanged ? 8 : 0,
        shotDistance: 16,
    });
    const guard = createTestUnit({
        team: LEFT,
        name: "Frontline screen",
        attackType: options.guardRanged ? RANGE : MELEE,
        initiative: 1,
        rangeShots: options.guardRanged ? 1 : 0,
    });
    // The threat can reach the current cell by the optimistic one-activation distance bound, but not (0,0).
    // The melee ally at (1,1) is geometrically between that destination and the threat; the ranged wall proves
    // stable native class identity rather than merely accepting any occupied neighboring cell as support.
    const wall = createTestUnit({ team: LEFT, name: "Corner wall", attackType: RANGE, initiative: 1, rangeShots: 1 });
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
        team: LEFT,
        name: "Posture archer",
        attackType: RANGE,
        initiative: 1,
        rangeShots: 8,
        shotDistance: 5,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({
        team: RIGHT,
        name: "Posture target",
        attackType: RANGE,
        initiative: 0,
        rangeShots: 8,
        shotDistance: 16,
        damageMin: 1,
        damageMax: 1,
        amountAlive: enemyRangedAmount,
        maxHp: 1,
    });
    const escapedThreat = createTestUnit({
        team: RIGHT,
        name: "Screened future charger",
        attackType: MELEE,
        initiative: 2,
        maxHp: 100,
    });
    const guard = createTestUnit({ team: LEFT, name: "Posture guard", attackType: MELEE, initiative: 1 });
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
    context.fightProperties!.addAlreadyMadeTurn(RIGHT, escapedThreat.getId());
    if (residualThreatCell) {
        const residualThreat = createTestUnit({
            team: RIGHT,
            name: "Unscreened next-lap charger",
            attackType: MELEE,
            initiative: 2,
            maxHp: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, residualThreat, residualThreatCell);
        residualThreat.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(RIGHT, residualThreat.getId());
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
        shooterInitiative?: number;
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
        team: LEFT,
        name: "Band archer",
        attackType: RANGE,
        initiative: options.shooterInitiative ?? 1,
        rangeShots: 8,
        shotDistance: options.shotDistance ?? 5,
        damageMin: 10,
        damageMax: 10,
        abilities: options.shooterAbilities ?? [],
    });
    const targetRanged = options.targetRanged ?? true;
    const target = createTestUnit({
        team: RIGHT,
        name: "Band target",
        attackType: targetRanged ? RANGE : MELEE,
        initiative: 0,
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
            team: LEFT,
            name: "Band guard",
            attackType: options.guardRanged ? RANGE : MELEE,
            initiative: 1,
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
            team: RIGHT,
            name: "Acted hidden flanker",
            attackType: MELEE,
            initiative: 1,
            maxHp: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, threat, { x: 7, y: 7 });
        threat.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(RIGHT, threat.getId());
    }
    if (options.withCurrentPinner) {
        const pinner = createTestUnit({
            team: RIGHT,
            name: "Current hidden pinner",
            attackType: MELEE,
            initiative: 0,
        });
        placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 6, y: 7 });
        pinner.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        context.fightProperties!.addAlreadyMadeTurn(RIGHT, pinner.getId());
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
    delete process.env.V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS;
    delete process.env.V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE;
    delete process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS;
    setDeterministicRandomSource(undefined);
});

describe("v0.8 protected ranged positioning", () => {
    it("never moves and then shoots: the supported position that used to advance keeps its stationary shot", () => {
        // setupSupportedShot is the position where the protected advance stepped behind the frontline and fired in the
        // same activation. Only melee may follow a move in the same turn, so the shot stays where the shooter stands.
        const { shooter, target, context } = setupSupportedShot();
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(movesThenFiresFromRange(actions)).toBe(false);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        const shot = actions.find((action) => action.type === "range_attack");
        expect(shot?.type === "range_attack" ? shot.targetId : undefined).toBe(target.getId());
    });

    it("drops any move-then-shoot plan the research arms still build, whatever they are switched to", () => {
        process.env.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
        process.env.V08_RANGED_POSITION_MODE = "both";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.8";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        for (const setup of [setupSupportedShot(), setupSupportedBandAdvance({ shotDistance: 16 })]) {
            setup.context.decisionOrigin = "root";
            const actions = new StrategyV0_8().decideTurn(setup.shooter, setup.context);
            expect(movesThenFiresFromRange(actions)).toBe(false);
        }
    });

    it("recognizes a move followed by a shot, a throw or a cast, and nothing else", () => {
        const move: GameAction = { type: "move_unit", unitId: "u", path: [{ x: 1, y: 1 }] };
        const shot: GameAction = { type: "range_attack", attackerId: "u", targetId: "t" };
        const end: GameAction = { type: "end_turn", unitId: "u" };
        expect(movesThenFiresFromRange([move, shot])).toBe(true);
        expect(movesThenFiresFromRange([shot])).toBe(false);
        expect(movesThenFiresFromRange([move])).toBe(false);
        expect(movesThenFiresFromRange([shot, move])).toBe(false);
        expect(movesThenFiresFromRange([move, end])).toBe(false);
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

    it("filters different paths that land on the same destination footprint in a different cell order", () => {
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
            screeningGuardId: "strict-guard",
            retainedSignatureAfter: true,
        };
        const strictSummary: IV08SupportedBandDuelDecisionSummary = {
            actionTypes: ["move_unit", "range_attack"],
            movePath: [
                { x: 5, y: 6 },
                { x: 5, y: 5 },
                { x: 5, y: 4 },
            ],
            moveTargetCells: [
                { x: 5, y: 4 },
                { x: 6, y: 4 },
            ],
            moveHasLavaCell: false,
            moveHasWaterCell: false,
            rangeTargetId: "target",
            rangeAimCell: { x: 5, y: 1 },
            rangeAimSide: 0,
        };
        const shippedSummary: IV08SupportedBandDuelDecisionSummary = {
            ...strictSummary,
            movePath: [
                { x: 4, y: 6 },
                { x: 4, y: 5 },
                { x: 5, y: 4 },
            ],
            moveTargetCells: [
                { x: 6, y: 4 },
                { x: 5, y: 4 },
            ],
        };
        const shippedMetadata: IV08ProtectedAdvanceCatalogMetadata = {
            fromCell: { ...strictDetails.fromCell },
            toCell: { ...strictDetails.toCell },
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
        ).toMatchObject({ dominant: false, metadataValid: true, reason: "filtered" });
    });

    it("normalizes one optional leading move origin and rejects malformed travelled paths", () => {
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
        const summary = (
            path: XY[],
            destination = strictDetails.toCell,
            targetCells: XY[] = [{ ...destination }],
        ): IV08SupportedBandDuelDecisionSummary => ({
            actionTypes: ["move_unit", "range_attack"],
            movePath: path,
            moveTargetCells: targetCells,
            moveHasLavaCell: false,
            moveHasWaterCell: false,
            rangeTargetId: strictDetails.targetId,
            rangeAimCell: { x: 5, y: 1 },
            rangeAimSide: 0,
        });
        const shotOnlySummary: IV08SupportedBandDuelDecisionSummary = {
            actionTypes: ["range_attack"],
            movePath: null,
            moveTargetCells: null,
            moveHasLavaCell: null,
            moveHasWaterCell: null,
            rangeTargetId: strictDetails.targetId,
            rangeAimCell: { x: 5, y: 1 },
            rangeAimSide: 0,
        };
        const compare = (details: IV08SupportedBandAdvanceDetails, path: XY[], destination = details.toCell) =>
            compareV08SupportedBandScreenedCloser(details, summary(path, destination), undefined, shotOnlySummary);

        const canonical = compare(strictDetails, [
            { ...strictDetails.fromCell },
            { x: 5, y: 6 },
            { x: 5, y: 5 },
            { ...strictDetails.toCell },
        ]);
        expect(canonical).toMatchObject({
            dominant: false,
            metadataValid: true,
            reason: "filtered",
            strictFromCell: strictDetails.fromCell,
            strictToCell: strictDetails.toCell,
            shippedFromCell: null,
            shippedToCell: null,
            strictDivisorBefore: 2,
            strictReachableThreatsBefore: 0,
            shippedDivisorBefore: null,
        });
        expect(canonical.strictFromCell).not.toBe(strictDetails.fromCell);
        expect(canonical.strictToCell).not.toBe(strictDetails.toCell);
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                summary([{ ...strictDetails.fromCell }, { x: 5, y: 6 }, { x: 5, y: 5 }, { ...strictDetails.toCell }]),
                undefined,
                shotOnlySummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: false,
            metadataValid: true,
            reason: "filtered",
            strictTargetDistanceCompression: 3,
            strictFinishActive: false,
            shippedTargetDistanceCompression: null,
            shippedFinishActive: null,
        });
        expect(compare(strictDetails, [{ x: 5, y: 6 }, { x: 5, y: 5 }, { ...strictDetails.toCell }])).toMatchObject({
            dominant: false,
            metadataValid: true,
            reason: "filtered",
        });

        const originOnlyDetails = { ...strictDetails, toCell: { ...strictDetails.fromCell } };
        expect(compare(originOnlyDetails, [{ ...originOnlyDetails.fromCell }], originOnlyDetails.toCell)).toMatchObject(
            { dominant: false, metadataValid: false, reason: "filtered" },
        );
        expect(
            compare(strictDetails, [
                { ...strictDetails.fromCell },
                { ...strictDetails.fromCell },
                { x: 5, y: 6 },
                { x: 5, y: 5 },
                { ...strictDetails.toCell },
            ]),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        expect(
            compare(strictDetails, [
                { ...strictDetails.fromCell },
                { x: 5, y: 6 },
                { ...strictDetails.fromCell },
                { x: 5, y: 6 },
                { x: 5, y: 5 },
                { ...strictDetails.toCell },
            ]),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        expect(
            compare(strictDetails, [
                { x: 5, y: 6 },
                { ...strictDetails.fromCell },
                { x: 5, y: 6 },
                { x: 5, y: 5 },
                { ...strictDetails.toCell },
            ]),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        expect(
            compare(strictDetails, [{ ...strictDetails.fromCell }, { x: 5, y: 5 }, { ...strictDetails.toCell }]),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
        expect(
            compare({ ...strictDetails, divisorBefore: Number.NaN, exposureBefore: -1 }, [
                { x: 5, y: 6 },
                { x: 5, y: 5 },
                { ...strictDetails.toCell },
            ]),
        ).toMatchObject({
            dominant: false,
            metadataValid: false,
            strictDivisorBefore: null,
            strictReachableThreatsBefore: null,
        });

        const canonicalPath = [
            { ...strictDetails.fromCell },
            { x: 5, y: 6 },
            { x: 5, y: 5 },
            { ...strictDetails.toCell },
        ];
        const duplicatedStrictFootprint = summary(canonicalPath, strictDetails.toCell, [
            { ...strictDetails.toCell },
            { ...strictDetails.toCell },
        ]);
        expect(
            compareV08SupportedBandScreenedCloser(strictDetails, duplicatedStrictFootprint, undefined, shotOnlySummary),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });

        const shippedDestination = { x: 6, y: 5 };
        const shippedMetadata: IV08ProtectedAdvanceCatalogMetadata = {
            fromCell: { ...strictDetails.fromCell },
            toCell: shippedDestination,
            targetId: strictDetails.targetId,
            targetCreatureName: strictDetails.targetCreatureName,
            divisorBefore: 2,
            divisorAfter: 1,
            ownRangedOutput: 40,
            enemyRangedOutput: 80,
            finishActive: false,
            reachableThreatsAfter: 0,
            targetDistanceBefore: 6,
            targetDistanceAfter: 4,
            targetScreenedAfter: false,
            screeningGuardId: null,
            retainedSignatureAfter: true,
        };
        const duplicatedShippedFootprint = summary(
            [{ ...strictDetails.fromCell }, { x: 6, y: 6 }, shippedDestination],
            shippedDestination,
            [{ ...shippedDestination }, { ...shippedDestination }],
        );
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                summary(canonicalPath),
                shippedMetadata,
                duplicatedShippedFootprint,
            ),
        ).toMatchObject({ dominant: false, metadataValid: false, reason: "filtered" });
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
        expect(
            compareV08SupportedBandScreenedCloser(
                { ...strictDetails, finishActive: "malformed" } as unknown as IV08SupportedBandAdvanceDetails,
                strictSummary,
                { ...shippedMetadata, finishActive: true },
                shippedSummary,
            ),
        ).toMatchObject({
            dominant: true,
            metadataValid: true,
            reason: "screened_closer",
            strictFinishActive: null,
            shippedFinishActive: true,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                strictSummary,
                shippedMetadata,
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: false,
            metadataValid: true,
            reason: "filtered",
            strictTargetDistanceCompression: 3,
            strictFinishActive: false,
            shippedTargetDistanceCompression: 2,
            shippedFinishActive: false,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                { ...strictDetails, targetDistanceAfter: 2 },
                strictSummary,
                shippedMetadata,
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: true,
            metadataValid: true,
            reason: "decisive_screened_closer",
            strictTargetDistanceCompression: 4,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                { ...strictDetails, finishActive: true },
                strictSummary,
                { ...shippedMetadata, finishActive: true },
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: true,
            metadataValid: true,
            reason: "decisive_screened_closer",
            strictTargetDistanceCompression: 3,
            strictFinishActive: true,
            shippedFinishActive: true,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                strictSummary,
                { ...shippedMetadata, finishActive: true },
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: false,
            metadataValid: false,
            reason: "filtered",
            strictFinishActive: false,
            shippedFinishActive: true,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                { ...strictDetails, finishActive: "malformed" } as unknown as IV08SupportedBandAdvanceDetails,
                strictSummary,
                shippedMetadata,
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: false,
            metadataValid: false,
            reason: "filtered",
            strictFinishActive: null,
            shippedFinishActive: false,
        });
        expect(
            compareV08SupportedBandScreenedCloser(
                strictDetails,
                strictSummary,
                {
                    ...shippedMetadata,
                    finishActive: "malformed",
                } as unknown as IV08ProtectedAdvanceCatalogMetadata,
                shippedSummary,
                "decisive_screened_closer",
            ),
        ).toMatchObject({
            dominant: false,
            metadataValid: false,
            reason: "filtered",
            strictFinishActive: false,
            shippedFinishActive: null,
        });
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
                fixture.shooter,
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

    it("fails closed when another pending enemy remains within the destination's optimistic reach bound", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        process.env.V08_RANGED_POSITION_MODE = "retreat";
        const { shooter, context } = setupSupportedPrepinEgress();
        const secondThreat = createTestUnit({
            team: RIGHT,
            name: "Second pending charger",
            attackType: MELEE,
            initiative: 1,
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
            team: RIGHT,
            name: "Second pending charger",
            attackType: MELEE,
            initiative: 0,
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

    it("rejects egress when an unscreened pending shooter can move in and melee-pin the destination", () => {
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.8";
        const { shooter, context } = setupSupportedPrepinEgress();
        const unscreenedShooter = createTestUnit({
            team: RIGHT,
            name: "Unscreened enemy archer",
            attackType: RANGE,
            initiative: 2,
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
            team: RIGHT,
            name: "Unscreened enemy caster",
            attackType: MAGIC,
            initiative: 2,
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

    it("does not close when its ranged army is already stronger and can make the opponent force", () => {
        const { shooter, context } = setupSupportedShot(true, true);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "range_attack")).toBe(true);
    });

    it("does not close into a stronger immediate ranged response even when its army is ranged-inferior", () => {
        const { shooter, target, context } = setupSupportedShot(true, true);
        target.setAmountAlive(100);
        const actions = new StrategyV0_8().decideTurn(shooter, context);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "range_attack")).toBe(true);
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
        fightProperties.setTeamUnitsAlive(LEFT, context.unitsHolder.getAllAllies(LEFT).length);
        fightProperties.setTeamUnitsAlive(RIGHT, context.unitsHolder.getAllAllies(RIGHT).length);
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
            team: LEFT,
            name: "Quiver thief",
            attackType: MELEE,
            initiative: 3,
            damageMin: 4,
            damageMax: 4,
        });
        thief.grantStolenAbility("Endless Quiver");
        thief.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        const pinner = createTestUnit({ team: RIGHT, name: "Pinner", attackType: MELEE, maxHp: 3 });
        placeUnit(combat.grid, combat.unitsHolder, thief, { x: 6, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, pinner, { x: 7, y: 7 });
        thief.refreshPossibleAttackTypes(false);

        const actions = new StrategyV0_8().decideTurn(thief, decisionContext(combat));
        expect(thief.isRangeCapable()).toBe(true);
        expect(actions.some((action) => action.type === "move_unit")).toBe(false);
        expect(actions.some((action) => action.type === "melee_attack")).toBe(true);
    });
});
