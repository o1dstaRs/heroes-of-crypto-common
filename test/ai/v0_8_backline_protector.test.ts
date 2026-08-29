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

import { describe, expect, it } from "bun:test";

import type { IDecisionContext, IPlacementContext } from "../../src/ai";
import {
    buildV08BacklineProtectorIntent,
    buildV08BacklineWardIntent,
    isV08BacklineProtectionBeneficiary,
    isV08BacklineProtectorDecisionAllowed,
    isV08BacklineProtectorDecisionHardRisk,
    isV08BacklineProtectorPureMoveMeaningful,
    isV08BacklineProtectorRuntimeDecisionAllowed,
    isV08BacklineWardPureMoveMeaningful,
    preservesV08BacklineProtectorIntent,
    preservesV08BacklineWardIntent,
    prioritizeV08BacklineProtector,
    v08BacklineProtectorPlacement,
} from "../../src/ai/versions/v0_8_backline_protector";
import { repairV08BacklineWardDecision } from "../../src/ai/versions/v0_8";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { MightSynergy, SynergyLevel } from "../../src/synergies/synergy_properties";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const WALK = PBTypes.MovementVals.WALK;
const FLY = PBTypes.MovementVals.FLY;

const decisionContext = (combat: ReturnType<typeof createCombatTestContext>): IDecisionContext => ({
    grid: combat.grid,
    matrix: combat.grid.getMatrix(),
    unitsHolder: combat.unitsHolder,
    pathHelper: new PathHelper(testGridSettings),
    attackHandler: combat.attackHandler,
    fightProperties: FightStateManager.getInstance().getFightProperties(),
});

const placementFootprint = (unit: Unit, base: { x: number; y: number }): Array<{ x: number; y: number }> =>
    unit.isSmallSize()
        ? [{ ...base }]
        : [{ ...base }, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];

const placeLargeUnit = (
    combat: ReturnType<typeof createCombatTestContext>,
    unit: Unit,
    base: { x: number; y: number },
): void => {
    const position = getPositionForCell(
        base,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
    unit.setPosition(position.x, position.y);
    if (
        !combat.grid.occupyCells(
            placementFootprint(unit, base),
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.canTraverseLava(),
            unit.hasAbilityActive("Made of Water"),
        )
    ) {
        throw new Error(`Unable to place ${unit.getName()} at (${base.x}, ${base.y})`);
    }
    combat.unitsHolder.addUnit(unit);
};

const placementDistance = (
    left: readonly { x: number; y: number }[],
    right: readonly { x: number; y: number }[],
): number => Math.min(...left.flatMap((a) => right.map((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)))));

const protectorBoard = (
    protectorName: "Abomination" | "Arachna Queen",
    options: {
        summoned?: boolean;
        flyer?: boolean;
        protectorCell?: { x: number; y: number };
        enemyCell?: { x: number; y: number };
        enemyMaxHp?: number;
        protectorDamage?: number;
    } = {},
): {
    protector: Unit;
    ward: Unit;
    enemy: Unit;
    context: IDecisionContext;
} => {
    const combat = createCombatTestContext();
    const protector = createTestUnit({
        team: LEFT,
        name: protectorName,
        attackType: MELEE,
        movementType: WALK,
        summoned: options.summoned,
        ...(options.protectorDamage === undefined
            ? {}
            : { damageMin: options.protectorDamage, damageMax: options.protectorDamage }),
    });
    const ward = createTestUnit({
        team: LEFT,
        name: "Valuable Archer",
        attackType: RANGE,
        rangeShots: 8,
        damageMax: 20,
        amountAlive: 5,
    });
    const enemy = createTestUnit({
        team: RIGHT,
        name: options.flyer ? "Enemy Flyer" : "Enemy Ground",
        attackType: MELEE,
        movementType: options.flyer ? FLY : WALK,
        ...(options.enemyMaxHp === undefined ? {} : { maxHp: options.enemyMaxHp }),
    });
    placeUnit(combat.grid, combat.unitsHolder, ward, { x: 5, y: 5 });
    placeUnit(combat.grid, combat.unitsHolder, protector, options.protectorCell ?? { x: 5, y: 4 });
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        enemy,
        options.enemyCell ?? (options.flyer ? { x: 6, y: 5 } : { x: 12, y: 12 }),
    );
    return { protector, ward, enemy, context: decisionContext(combat) };
};

describe("v0.8 back-line protector intent", () => {
    it("recognizes live shot output and remaining hybrid-caster spells, but not depleted shooters", () => {
        const shooter = createTestUnit({ team: LEFT, attackType: RANGE, rangeShots: 1 });
        const depleted = createTestUnit({ team: LEFT, attackType: RANGE, rangeShots: 0 });
        const hybrid = createTestUnit({
            team: LEFT,
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
        });
        const underpoweredCaster = createTestUnit({
            team: LEFT,
            attackType: MELEE_MAGIC,
            spells: ["System:Castling"],
            stackPower: 1,
        });

        expect(isV08BacklineProtectionBeneficiary(shooter)).toBe(true);
        expect(isV08BacklineProtectionBeneficiary(depleted)).toBe(false);
        expect(isV08BacklineProtectionBeneficiary(hybrid)).toBe(true);
        expect(underpoweredCaster.getSpells()[0].isRemaining()).toBe(true);
        expect(isV08BacklineProtectionBeneficiary(underpoweredCaster)).toBe(false);
    });

    it("keeps Abomination in exact Flesh Shield range on first and post-hourglass activations", () => {
        const { protector, ward, enemy, context } = protectorBoard("Abomination");
        const rush: GameAction[] = [
            {
                type: "move_unit",
                unitId: protector.getId(),
                path: [{ x: 8, y: 8 }],
                targetCells: [{ x: 8, y: 8 }],
            },
        ];
        const intent = buildV08BacklineProtectorIntent(protector, context);

        expect(intent?.ward).toBe(ward);
        expect(preservesV08BacklineProtectorIntent(intent!, protector, context, rush)).toBe(false);
        expect(prioritizeV08BacklineProtector(protector, context, rush, true)).toEqual([
            { type: "wait_turn", unitId: protector.getId() },
        ]);
        expect(prioritizeV08BacklineProtector(protector, context, rush, false)).toEqual([
            { type: "defend_turn", unitId: protector.getId() },
        ]);

        const farSideAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: protector.getId(),
                targetId: enemy.getId(),
                attackFrom: { x: 7, y: 5 },
            },
        ];
        expect(isV08BacklineProtectorDecisionAllowed(protector, context, farSideAttack)).toBe(false);
        expect(
            isV08BacklineProtectorDecisionAllowed(protector, context, [
                {
                    type: "obstacle_attack",
                    attackerId: protector.getId(),
                    targetPosition: { x: 9, y: 9 },
                    attackFrom: { x: 8, y: 8 },
                    path: [{ x: 8, y: 8 }],
                },
            ]),
        ).toBe(false);
    });

    it("preserves Flesh Shield HP instead of exposing Abomination to an ordinary local response", () => {
        const risky = protectorBoard("Abomination", {
            enemyCell: { x: 6, y: 5 },
            enemyMaxHp: 20,
            protectorDamage: 1,
        });
        const riskyIntent = buildV08BacklineProtectorIntent(risky.protector, risky.context)!;
        const riskyAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: risky.protector.getId(),
                targetId: risky.enemy.getId(),
                attackFrom: risky.protector.getBaseCell(),
            },
        ];

        expect(isV08BacklineProtectorDecisionHardRisk(riskyIntent, risky.protector, risky.context, riskyAttack)).toBe(
            true,
        );
        expect(prioritizeV08BacklineProtector(risky.protector, risky.context, riskyAttack, true)).toEqual([
            { type: "wait_turn", unitId: risky.protector.getId() },
        ]);
        expect(prioritizeV08BacklineProtector(risky.protector, risky.context, riskyAttack, false)).toEqual([
            { type: "defend_turn", unitId: risky.protector.getId() },
        ]);

        risky.enemy.setResponded(true);
        expect(isV08BacklineProtectorDecisionHardRisk(riskyIntent, risky.protector, risky.context, riskyAttack)).toBe(
            false,
        );
        expect(prioritizeV08BacklineProtector(risky.protector, risky.context, riskyAttack, false)).toBe(riskyAttack);

        const lethal = protectorBoard("Abomination", {
            enemyCell: { x: 6, y: 5 },
            enemyMaxHp: 10,
            protectorDamage: 20,
        });
        const lethalIntent = buildV08BacklineProtectorIntent(lethal.protector, lethal.context)!;
        const lethalAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: lethal.protector.getId(),
                targetId: lethal.enemy.getId(),
                attackFrom: lethal.protector.getBaseCell(),
            },
        ];
        expect(
            isV08BacklineProtectorDecisionHardRisk(lethalIntent, lethal.protector, lethal.context, lethalAttack),
        ).toBe(true);

        lethal.enemy.grantStolenAbility("Water Shield");
        lethal.enemy.trySeedWaterShield();
        expect(lethal.enemy.hasBuffActive("Water Shield")).toBe(true);
        expect(
            isV08BacklineProtectorDecisionHardRisk(lethalIntent, lethal.protector, lethal.context, lethalAttack),
        ).toBe(true);

        lethal.protector.grantStolenAbility("Fire Element");
        expect(
            isV08BacklineProtectorDecisionHardRisk(lethalIntent, lethal.protector, lethal.context, lethalAttack),
        ).toBe(true);
        lethal.enemy.setResponded(true);
        expect(
            isV08BacklineProtectorDecisionHardRisk(lethalIntent, lethal.protector, lethal.context, lethalAttack),
        ).toBe(false);

        const fleshShielded = protectorBoard("Abomination", {
            enemyCell: { x: 6, y: 5 },
            enemyMaxHp: 10,
            protectorDamage: 20,
        });
        const enemyAbsorber = createTestUnit({
            team: RIGHT,
            name: "Enemy Abomination",
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
            stackPower: 5,
        });
        placeUnit(fleshShielded.context.grid, fleshShielded.context.unitsHolder, enemyAbsorber, { x: 7, y: 6 });
        fleshShielded.context.unitsHolder.refreshAuraEffectsForAllUnits();
        expect(fleshShielded.enemy.hasBuffActive("Flesh Shield Aura")).toBe(true);
        const fleshShieldedIntent = buildV08BacklineProtectorIntent(fleshShielded.protector, fleshShielded.context)!;
        const fleshShieldedAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: fleshShielded.protector.getId(),
                targetId: fleshShielded.enemy.getId(),
                attackFrom: fleshShielded.protector.getBaseCell(),
            },
        ];
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                fleshShieldedIntent,
                fleshShielded.protector,
                fleshShielded.context,
                fleshShieldedAttack,
            ),
        ).toBe(true);

        risky.enemy.setResponded(false);
        expect(
            isV08BacklineProtectorDecisionHardRisk(riskyIntent, risky.protector, risky.context, riskyAttack, {
                immediatelyRemovesTarget: true,
                saferProductiveDefenseAvailable: false,
            }),
        ).toBe(false);
        const nonLocal = protectorBoard("Abomination", {
            enemyCell: { x: 5, y: 3 },
            enemyMaxHp: 20,
            protectorDamage: 1,
        });
        const nonLocalIntent = buildV08BacklineProtectorIntent(nonLocal.protector, nonLocal.context)!;
        const nonLocalAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: nonLocal.protector.getId(),
                targetId: nonLocal.enemy.getId(),
                attackFrom: nonLocal.protector.getBaseCell(),
            },
        ];
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                nonLocalIntent,
                nonLocal.protector,
                nonLocal.context,
                nonLocalAttack,
                {
                    immediatelyRemovesTarget: true,
                    saferProductiveDefenseAvailable: false,
                },
            ),
        ).toBe(true);
    });

    it("uses exact retaliation gates and treats even lethal Fire Shield reflection as direct exposure", () => {
        const responseBoard = protectorBoard("Abomination", {
            enemyCell: { x: 6, y: 5 },
            enemyMaxHp: 20,
            protectorDamage: 1,
        });
        const responseIntent = buildV08BacklineProtectorIntent(responseBoard.protector, responseBoard.context)!;
        const responseAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: responseBoard.protector.getId(),
                targetId: responseBoard.enemy.getId(),
                attackFrom: responseBoard.protector.getBaseCell(),
            },
        ];

        responseBoard.enemy.setTarget(responseBoard.ward.getId());
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                responseIntent,
                responseBoard.protector,
                responseBoard.context,
                responseAttack,
            ),
        ).toBe(false);
        responseBoard.enemy.resetTarget();
        responseBoard.enemy.setForbiddenTarget(responseBoard.protector.getId());
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                responseIntent,
                responseBoard.protector,
                responseBoard.context,
                responseAttack,
            ),
        ).toBe(false);
        responseBoard.enemy.resetForbiddenTarget();
        responseBoard.enemy.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }),
        );
        responseBoard.enemy.applyDamage(11, 0, new SceneLogMock());
        expect(responseBoard.enemy.getCumulativeHp()).toBeLessThan(responseBoard.protector.getCumulativeHp());
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                responseIntent,
                responseBoard.protector,
                responseBoard.context,
                responseAttack,
            ),
        ).toBe(false);

        const fireShieldBoard = protectorBoard("Abomination", {
            enemyCell: { x: 6, y: 5 },
            enemyMaxHp: 10,
            protectorDamage: 20,
        });
        fireShieldBoard.enemy.setResponded(true);
        fireShieldBoard.enemy.grantStolenAbility("Fire Shield");
        const fireShieldIntent = buildV08BacklineProtectorIntent(fireShieldBoard.protector, fireShieldBoard.context)!;
        const lethalFireShieldAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: fireShieldBoard.protector.getId(),
                targetId: fireShieldBoard.enemy.getId(),
                attackFrom: fireShieldBoard.protector.getBaseCell(),
            },
        ];
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                fireShieldIntent,
                fireShieldBoard.protector,
                fireShieldBoard.context,
                lethalFireShieldAttack,
            ),
        ).toBe(true);

        fireShieldBoard.protector.grantStolenAbility("Fire Element");
        expect(
            isV08BacklineProtectorDecisionHardRisk(
                fireShieldIntent,
                fireShieldBoard.protector,
                fireShieldBoard.context,
                lethalFireShieldAttack,
            ),
        ).toBe(false);
    });

    it("preserves every currently covered ward and rejects lateral pure-move jitter", () => {
        const { protector, ward, context } = protectorBoard("Abomination");
        const secondary = createTestUnit({
            team: LEFT,
            name: "Secondary Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
            damageMax: 5,
        });
        placeUnit(context.grid, context.unitsHolder, secondary, { x: 6, y: 5 });
        const intent = buildV08BacklineProtectorIntent(protector, context)!;
        expect(intent.ward).toBe(ward);
        expect(intent.wards).toContain(secondary);

        const losesSecondary: GameAction[] = [
            {
                type: "move_unit",
                unitId: protector.getId(),
                path: [{ x: 4, y: 4 }],
                targetCells: [{ x: 4, y: 4 }],
            },
        ];
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, losesSecondary)).toBe(false);
        expect(isV08BacklineProtectorPureMoveMeaningful(intent, protector, context, losesSecondary)).toBe(false);

        const lateralHold: GameAction[] = [
            {
                type: "move_unit",
                unitId: protector.getId(),
                path: [{ x: 6, y: 4 }],
                targetCells: [{ x: 6, y: 4 }],
            },
        ];
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, lateralHold)).toBe(true);
        expect(isV08BacklineProtectorPureMoveMeaningful(intent, protector, context, lateralHold)).toBe(false);
        expect(prioritizeV08BacklineProtector(protector, context, lateralHold, true)).toEqual([
            { type: "wait_turn", unitId: protector.getId() },
        ]);
        expect(prioritizeV08BacklineProtector(protector, context, lateralHold, false)).toEqual([
            { type: "defend_turn", unitId: protector.getId() },
        ]);

        const relocatingAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: protector.getId(),
                targetId: context.unitsHolder.getAllEnemyUnits(LEFT)[0].getId(),
                attackFrom: { x: 4, y: 4 },
            },
        ];
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, relocatingAttack)).toBe(false);

        const uncoveredWard = createTestUnit({
            team: LEFT,
            name: "Third Archer",
            attackType: RANGE,
            rangeShots: 1,
            damageMax: 1,
        });
        placeUnit(context.grid, context.unitsHolder, uncoveredWard, { x: 7, y: 5 });
        const expandedIntent = buildV08BacklineProtectorIntent(protector, context)!;
        expect(preservesV08BacklineProtectorIntent(expandedIntent, protector, context, lateralHold)).toBe(true);
        expect(isV08BacklineProtectorPureMoveMeaningful(expandedIntent, protector, context, lateralHold)).toBe(true);
    });

    it("follows a displaced ward instead of passively waiting forever", () => {
        const { protector, ward, context } = protectorBoard("Abomination", {
            protectorCell: { x: 1, y: 1 },
        });
        const passive: GameAction[] = [{ type: "defend_turn", unitId: protector.getId() }];
        const intent = buildV08BacklineProtectorIntent(protector, context);

        expect(intent?.ward).toBe(ward);
        expect(preservesV08BacklineProtectorIntent(intent!, protector, context, passive)).toBe(false);
        const follow = prioritizeV08BacklineProtector(protector, context, passive, true);
        expect(follow[0]?.type).toBe("move_unit");
        expect(isV08BacklineProtectorPureMoveMeaningful(intent!, protector, context, follow)).toBe(true);
        const destination = follow[0]?.type === "move_unit" ? follow[0].path.at(-1)! : protector.getBaseCell();
        expect(
            Math.max(Math.abs(destination.x - ward.getBaseCell().x), Math.abs(destination.y - ward.getBaseCell().y)),
        ).toBeLessThan(4);
    });

    it("keeps secondary coverage during partial catch-up and permits only a higher-value atomic primary swap", () => {
        const { protector, ward, context } = protectorBoard("Abomination", {
            protectorCell: { x: 1, y: 1 },
        });
        const secondaryA = createTestUnit({
            team: LEFT,
            name: "Secondary Archer A",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 50,
            amountAlive: 1,
        });
        const secondaryB = createTestUnit({
            team: LEFT,
            name: "Secondary Archer B",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 50,
            amountAlive: 1,
        });
        placeUnit(context.grid, context.unitsHolder, secondaryA, { x: 1, y: 2 });
        placeUnit(context.grid, context.unitsHolder, secondaryB, { x: 2, y: 1 });
        const intent = buildV08BacklineProtectorIntent(protector, context)!;
        expect(intent.ward).toBe(ward);

        const dropsSecondariesPartway: GameAction[] = [
            {
                type: "move_unit",
                unitId: protector.getId(),
                path: [{ x: 3, y: 3 }],
                targetCells: [{ x: 3, y: 3 }],
            },
        ];
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, dropsSecondariesPartway)).toBe(false);

        const leftValueSwap: GameAction[] = [
            {
                type: "move_unit",
                unitId: protector.getId(),
                path: [{ x: 4, y: 4 }],
                targetCells: [{ x: 4, y: 4 }],
            },
        ];
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, leftValueSwap)).toBe(false);

        const follow = prioritizeV08BacklineProtector(protector, context, dropsSecondariesPartway, false);
        expect(follow[0]?.type).toBe("move_unit");
        expect(preservesV08BacklineProtectorIntent(intent, protector, context, follow)).toBe(true);
        const followDestination = follow[0]?.type === "move_unit" ? follow[0].targetCells : [];
        expect(followDestination).toEqual(expect.arrayContaining([{ x: 2, y: 2 }]));

        // With only one 500-value secondary, the 800-value primary is an actual value upgrade; the same
        // immediate swap is allowed, while a partial dropping move remains forbidden.
        const valueBoard = protectorBoard("Abomination", { protectorCell: { x: 1, y: 1 } });
        const loneSecondary = createTestUnit({
            team: LEFT,
            name: "Lone Secondary",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 50,
            amountAlive: 1,
        });
        placeUnit(valueBoard.context.grid, valueBoard.context.unitsHolder, loneSecondary, { x: 1, y: 2 });
        const valueSwapIntent = buildV08BacklineProtectorIntent(valueBoard.protector, valueBoard.context)!;
        const valueSwap: GameAction[] = [
            {
                type: "move_unit",
                unitId: valueBoard.protector.getId(),
                path: [{ x: 4, y: 4 }],
                targetCells: [{ x: 4, y: 4 }],
            },
        ];
        const valuePartial: GameAction[] = [
            {
                type: "move_unit",
                unitId: valueBoard.protector.getId(),
                path: [{ x: 3, y: 3 }],
                targetCells: [{ x: 3, y: 3 }],
            },
        ];
        expect(
            preservesV08BacklineProtectorIntent(valueSwapIntent, valueBoard.protector, valueBoard.context, valueSwap),
        ).toBe(true);
        expect(
            preservesV08BacklineProtectorIntent(
                valueSwapIntent,
                valueBoard.protector,
                valueBoard.context,
                valuePartial,
            ),
        ).toBe(false);
    });

    it("keeps a safe hold when forced displacement leaves only a retaliation-exposing attack", () => {
        const { protector, enemy, context } = protectorBoard("Abomination", {
            protectorCell: { x: 1, y: 1 },
        });
        protector.setWebMovementLocked(true);
        const inPlaceAttack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: protector.getId(),
                targetId: enemy.getId(),
                attackFrom: protector.getBaseCell(),
            },
        ];

        expect(isV08BacklineProtectorDecisionAllowed(protector, context, inPlaceAttack)).toBe(false);
        expect(
            isV08BacklineProtectorRuntimeDecisionAllowed(
                buildV08BacklineProtectorIntent(protector, context)!,
                protector,
                context,
                inPlaceAttack,
            ),
        ).toBe(false);
        expect(prioritizeV08BacklineProtector(protector, context, inPlaceAttack, false)).toEqual([
            { type: "defend_turn", unitId: protector.getId() },
        ]);
    });

    it("prevents a live shooter ward from taking a melee route out of Flesh Shield", () => {
        const { protector, ward, enemy, context } = protectorBoard("Abomination");
        const meleeRush: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: ward.getId(),
                targetId: enemy.getId(),
                attackFrom: { x: 8, y: 8 },
            },
        ];
        const intent = buildV08BacklineWardIntent(ward, context);

        expect(intent?.protector).toBe(protector);
        expect(preservesV08BacklineWardIntent(intent!, ward, context, meleeRush)).toBe(false);
        const repaired = repairV08BacklineWardDecision(ward, context, meleeRush);
        expect(preservesV08BacklineWardIntent(intent!, ward, context, repaired)).toBe(true);
        expect(repaired.some((action) => action.type === "melee_attack" && action.attackFrom.x === 8)).toBe(false);
    });

    it("does not treat a ward's lateral movement inside the protector screen as work", () => {
        const { protector, ward, context } = protectorBoard("Abomination");
        const lateral: GameAction[] = [
            {
                type: "move_unit",
                unitId: ward.getId(),
                path: [{ x: 6, y: 5 }],
                targetCells: [{ x: 6, y: 5 }],
            },
        ];
        const intent = buildV08BacklineWardIntent(ward, context);

        expect(intent?.protector).toBe(protector);
        expect(preservesV08BacklineWardIntent(intent!, ward, context, lateral)).toBe(true);
        expect(isV08BacklineWardPureMoveMeaningful(intent!, ward, context, lateral)).toBe(false);
    });

    it("evaluates Castling at the caster's real post-swap footprint", () => {
        const { protector, ward, context } = protectorBoard("Abomination");
        const nearAlly = createTestUnit({ team: LEFT, name: "Near ally", attackType: MELEE });
        const farAlly = createTestUnit({ team: LEFT, name: "Far ally", attackType: MELEE });
        placeUnit(context.grid, context.unitsHolder, nearAlly, { x: 6, y: 4 });
        placeUnit(context.grid, context.unitsHolder, farAlly, { x: 10, y: 10 });
        const intent = buildV08BacklineWardIntent(ward, context)!;
        const castling = (target: Unit): GameAction[] => [
            {
                type: "cast_spell",
                casterId: ward.getId(),
                spellName: "Castling",
                targetId: target.getId(),
                targetCell: target.getBaseCell(),
            },
        ];

        expect(intent.protector).toBe(protector);
        expect(preservesV08BacklineWardIntent(intent, ward, context, castling(nearAlly))).toBe(true);
        expect(preservesV08BacklineWardIntent(intent, ward, context, castling(farAlly))).toBe(false);
    });

    it("keeps a spell-bearing melee ward screened instead of letting it rush", () => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({ team: LEFT, name: "Abomination", attackType: MELEE });
        const ward = createTestUnit({
            team: LEFT,
            name: "Battle Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike", "Life:Meteorite"],
        });
        const enemy = createTestUnit({ team: RIGHT, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, protector, { x: 5, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ward, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 10, y: 10 });
        const context = decisionContext(combat);
        const meleeRush: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: ward.getId(),
                targetId: enemy.getId(),
                attackFrom: { x: 9, y: 9 },
            },
        ];
        const intent = buildV08BacklineWardIntent(ward, context);
        const repaired = repairV08BacklineWardDecision(ward, context, meleeRush);

        expect(intent?.protector).toBe(protector);
        expect(preservesV08BacklineWardIntent(intent!, ward, context, repaired)).toBe(true);
        expect(repaired[0]?.type).toBe("cast_spell");
    });

    it("uses the authoritative Auras Range synergy instead of hard-coding adjacency", () => {
        const { protector, context } = protectorBoard("Abomination");
        context.unitsHolder.getAllEnemyUnits(LEFT)[0].setResponded(true);
        context.fightProperties!.setSynergyUnitsPerFactions(LEFT, 0, 0, 6, 0);
        context.fightProperties!.updateSynergyPerTeam(
            LEFT,
            PBTypes.FactionVals.MIGHT,
            MightSynergy.PLUS_AURAS_RANGE,
            SynergyLevel.LEVEL_3,
        );

        const withinExtendedAura: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: protector.getId(),
                targetId: context.unitsHolder.getAllEnemyUnits(LEFT)[0].getId(),
                attackFrom: { x: 9, y: 5 },
            },
        ];
        const beyondExtendedAura: GameAction[] = [
            {
                ...withinExtendedAura[0],
                type: "melee_attack",
                attackFrom: { x: 10, y: 5 },
            },
        ];

        expect(isV08BacklineProtectorDecisionAllowed(protector, context, withinExtendedAura)).toBe(true);
        expect(isV08BacklineProtectorDecisionAllowed(protector, context, beyondExtendedAura)).toBe(false);

        const tighteningBoard = protectorBoard("Abomination", { protectorCell: { x: 5, y: 1 } });
        tighteningBoard.context.fightProperties!.setSynergyUnitsPerFactions(LEFT, 0, 0, 6, 0);
        tighteningBoard.context.fightProperties!.updateSynergyPerTeam(
            LEFT,
            PBTypes.FactionVals.MIGHT,
            MightSynergy.PLUS_AURAS_RANGE,
            SynergyLevel.LEVEL_3,
        );
        const tighteningIntent = buildV08BacklineProtectorIntent(tighteningBoard.protector, tighteningBoard.context)!;
        const tighten: GameAction[] = [
            {
                type: "move_unit",
                unitId: tighteningBoard.protector.getId(),
                path: [{ x: 5, y: 2 }],
                targetCells: [{ x: 5, y: 2 }],
            },
        ];
        expect(
            preservesV08BacklineProtectorIntent(
                tighteningIntent,
                tighteningBoard.protector,
                tighteningBoard.context,
                tighten,
            ),
        ).toBe(true);
        expect(
            isV08BacklineProtectorPureMoveMeaningful(
                tighteningIntent,
                tighteningBoard.protector,
                tighteningBoard.context,
                tighten,
            ),
        ).toBe(true);
        expect(prioritizeV08BacklineProtector(tighteningBoard.protector, tighteningBoard.context, tighten, false)).toBe(
            tighten,
        );
    });

    it("uses Queen only as a non-summoned anti-fly interceptor and permits local interception", () => {
        const flyerBoard = protectorBoard("Arachna Queen", { flyer: true });
        const intent = buildV08BacklineProtectorIntent(flyerBoard.protector, flyerBoard.context);
        const localIntercept: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: flyerBoard.protector.getId(),
                targetId: flyerBoard.enemy.getId(),
                attackFrom: { x: 7, y: 5 },
            },
        ];
        const rush: GameAction[] = [
            {
                type: "move_unit",
                unitId: flyerBoard.protector.getId(),
                path: [{ x: 10, y: 10 }],
                targetCells: [{ x: 10, y: 10 }],
            },
        ];

        expect(intent?.kind).toBe("arachna_queen");
        expect(isV08BacklineProtectorDecisionAllowed(flyerBoard.protector, flyerBoard.context, localIntercept)).toBe(
            true,
        );
        expect(isV08BacklineProtectorDecisionAllowed(flyerBoard.protector, flyerBoard.context, rush)).toBe(false);

        const secondary = createTestUnit({
            team: LEFT,
            name: "Secondary Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
            damageMax: 1,
        });
        placeUnit(flyerBoard.context.grid, flyerBoard.context.unitsHolder, secondary, { x: 4, y: 5 });
        const multiWardIntent = buildV08BacklineProtectorIntent(flyerBoard.protector, flyerBoard.context)!;
        expect(multiWardIntent.wards).toContain(secondary);
        expect(
            preservesV08BacklineProtectorIntent(
                multiWardIntent,
                flyerBoard.protector,
                flyerBoard.context,
                localIntercept,
            ),
        ).toBe(false);

        const noFlyer = protectorBoard("Arachna Queen");
        expect(buildV08BacklineProtectorIntent(noFlyer.protector, noFlyer.context)).toBeUndefined();
        expect(prioritizeV08BacklineProtector(noFlyer.protector, noFlyer.context, rush, true)).toBe(rush);

        const summoned = protectorBoard("Arachna Queen", { flyer: true, summoned: true });
        expect(buildV08BacklineProtectorIntent(summoned.protector, summoned.context)).toBeUndefined();
    });

    it("keeps Angel with two live wards only while a live enemy shooter can exploit its range-2 shield", () => {
        const angelBoard = (enemyShots: number, includeSecondWard: boolean) => {
            const combat = createCombatTestContext();
            const angel = createTestUnit({
                team: LEFT,
                name: "Angel",
                attackType: MELEE_MAGIC,
                movementType: FLY,
            });
            const primary = createTestUnit({
                team: LEFT,
                name: "Primary Archer",
                attackType: RANGE,
                rangeShots: 8,
                damageMax: 20,
                amountAlive: 5,
            });
            const secondary = createTestUnit({
                team: LEFT,
                name: "Secondary Mage",
                attackType: MELEE_MAGIC,
                spells: ["Life:Fire Strike"],
                damageMax: 10,
                amountAlive: 5,
            });
            const enemy = createTestUnit({
                team: RIGHT,
                name: "Enemy Shooter",
                attackType: RANGE,
                rangeShots: enemyShots,
            });
            placeUnit(combat.grid, combat.unitsHolder, angel, { x: 5, y: 4 });
            placeUnit(combat.grid, combat.unitsHolder, primary, { x: 5, y: 5 });
            if (includeSecondWard) {
                placeUnit(combat.grid, combat.unitsHolder, secondary, { x: 6, y: 5 });
            }
            placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 7, y: 5 });
            return { angel, primary, enemy, context: decisionContext(combat) };
        };

        const active = angelBoard(8, true);
        const intent = buildV08BacklineProtectorIntent(active.angel, active.context);
        const intercept: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: active.angel.getId(),
                targetId: active.enemy.getId(),
                attackFrom: { x: 6, y: 4 },
            },
        ];
        const rush: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: active.angel.getId(),
                targetId: active.enemy.getId(),
                attackFrom: { x: 10, y: 10 },
            },
        ];

        expect(intent?.kind).toBe("angel");
        expect(intent?.wards).toHaveLength(2);
        expect(isV08BacklineProtectorDecisionHardRisk(intent!, active.angel, active.context, intercept)).toBe(false);
        expect(isV08BacklineProtectorDecisionAllowed(active.angel, active.context, intercept)).toBe(true);
        expect(isV08BacklineProtectorDecisionAllowed(active.angel, active.context, rush)).toBe(false);

        const noShooter = angelBoard(0, true);
        expect(buildV08BacklineProtectorIntent(noShooter.angel, noShooter.context)).toBeUndefined();
        expect(prioritizeV08BacklineProtector(noShooter.angel, noShooter.context, rush, true)).toBe(rush);

        const oneWard = angelBoard(8, false);
        expect(buildV08BacklineProtectorIntent(oneWard.angel, oneWard.context)).toBeUndefined();
    });

    it("keeps a large Angel catch-up route off Lava Center cells it cannot occupy", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const angel = createTestUnit({
            team: LEFT,
            name: "Angel",
            attackType: MELEE_MAGIC,
            movementType: FLY,
            size: PBTypes.UnitSizeVals.LARGE,
            initiative: 3,
        });
        const primary = createTestUnit({
            team: LEFT,
            name: "Primary Archer",
            attackType: RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 5,
        });
        const secondary = createTestUnit({
            team: LEFT,
            name: "Secondary Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
            damageMax: 5,
            amountAlive: 2,
        });
        const enemy = createTestUnit({
            team: RIGHT,
            name: "Enemy Shooter",
            attackType: RANGE,
            rangeShots: 8,
        });
        placeLargeUnit(combat, angel, { x: 10, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, primary, { x: 12, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, secondary, { x: 11, y: 1 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 1, y: 14 });

        const context = decisionContext(combat);
        const follow = prioritizeV08BacklineProtector(
            angel,
            context,
            [{ type: "end_turn", unitId: angel.getId(), reason: "manual" }],
            false,
        );
        const move = follow[0];
        expect(move?.type).toBe("move_unit");
        if (move?.type !== "move_unit") {
            throw new Error("Angel should retain a legal catch-up move");
        }
        expect(
            combat.grid.canOccupyCells(
                move.targetCells,
                angel.canTraverseLava(),
                angel.hasAbilityActive("Made of Water"),
                angel.getId(),
            ),
        ).toBe(true);
        expect(move.targetCells.some((cell) => combat.grid.getOccupantUnitId(cell) === "L")).toBe(false);
    });

    it("releases protector roles for the universal late finish", () => {
        const { protector, context } = protectorBoard("Abomination");
        const fightProperties = context.fightProperties!;
        while (fightProperties.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            fightProperties.flipLap();
        }
        expect(buildV08BacklineProtectorIntent(protector, context)).toBeUndefined();
    });
});

describe("v0.8 back-line protector placement", () => {
    const placement = (
        protectorName: "Abomination" | "Arachna Queen",
        options: {
            publicFlyer?: boolean;
            revealedFlyer?: boolean;
            holderFlyer?: boolean;
            splash?: boolean;
            casterAttackType?: typeof MELEE | typeof MELEE_MAGIC;
            setupPlacementPolicy?: IPlacementContext["setupPlacementPolicy"];
        } = {},
    ): {
        protector: Unit;
        ward: Unit;
        extraMelee: Unit;
        result: Map<string, { x: number; y: number }> | undefined;
    } => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({ team: LEFT, name: protectorName, attackType: MELEE });
        const ward = createTestUnit({
            team: LEFT,
            name: options.casterAttackType ? "Battle Mage" : "Archer",
            attackType: options.casterAttackType ?? RANGE,
            rangeShots: options.casterAttackType ? 0 : 5,
            spells: options.casterAttackType ? ["Life:Fire Strike"] : [],
        });
        const extraMelee = createTestUnit({ team: LEFT, name: "Squire", attackType: MELEE });
        const enemy = createTestUnit({
            team: RIGHT,
            name: "Public Enemy",
            attackType: RANGE,
            movementType: options.holderFlyer ? FLY : WALK,
            abilities: options.splash ? ["Area Throw"] : [],
        });
        for (const unit of [protector, ward, extraMelee, enemy]) combat.unitsHolder.addUnit(unit);
        const context: IPlacementContext = {
            team: LEFT,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
            publicOpponentCreatureIds: options.publicFlyer
                ? [PBTypes.CreatureVals.GRIFFIN]
                : [PBTypes.CreatureVals.SQUIRE],
            revealedOpponentCreatures: options.revealedFlyer ? [PBTypes.CreatureVals.GRIFFIN] : [],
            setupPlacementPolicy: options.setupPlacementPolicy,
        };
        return {
            protector,
            ward,
            extraMelee,
            result: v08BacklineProtectorPlacement([protector, ward, extraMelee], context),
        };
    };

    it("starts Abomination beside a ranged or spell-bearing MELEE_MAGIC/exact-MELEE ward", () => {
        for (const casterAttackType of [undefined, MELEE_MAGIC, MELEE] as const) {
            const { protector, ward, result } = placement("Abomination", { casterAttackType });
            const protectorCell = result?.get(protector.getId());
            const wardCell = result?.get(ward.getId());
            expect(protectorCell).toBeDefined();
            expect(wardCell).toBeDefined();
            expect(Math.max(Math.abs(protectorCell!.x - wardCell!.x), Math.abs(protectorCell!.y - wardCell!.y))).toBe(
                1,
            );
        }
    });

    it("places a large Abomination on the safest tied cell covering the most ward value", () => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({
            team: LEFT,
            name: "Abomination",
            attackType: MELEE,
            size: PBTypes.UnitSizeVals.LARGE,
            auraEffects: ["Flesh Shield"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        const primary = createTestUnit({
            team: LEFT,
            name: "Primary Archer",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 20,
            amountAlive: 5,
        });
        const secondary = createTestUnit({
            team: LEFT,
            name: "Secondary Archer",
            attackType: RANGE,
            rangeShots: 6,
            damageMax: 10,
            amountAlive: 5,
        });
        const caster = createTestUnit({
            team: LEFT,
            name: "Backline Healer",
            attackType: MELEE_MAGIC,
            spells: ["Life:Heal", "Life:Mass Heal"],
            damageMax: 5,
            amountAlive: 5,
        });
        const melee = createTestUnit({ team: LEFT, name: "Frontliner", attackType: MELEE });
        const enemy = createTestUnit({ team: RIGHT, name: "Enemy", attackType: MELEE });
        for (const unit of [protector, primary, secondary, caster, melee, enemy]) combat.unitsHolder.addUnit(unit);
        const context: IPlacementContext = {
            team: LEFT,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
            publicOpponentCreatureIds: [PBTypes.CreatureVals.SQUIRE],
        };

        const result = v08BacklineProtectorPlacement([protector, primary, secondary, caster, melee], context);
        const protectorBase = result?.get(protector.getId());
        const primaryBase = result?.get(primary.getId());
        expect(protectorBase).toBeDefined();
        expect(primaryBase).toBeDefined();
        const protectorCells = placementFootprint(protector, protectorBase!);
        const wardCells = [primary, secondary, caster].map((ward) => ({
            ward,
            cells: placementFootprint(ward, result!.get(ward.getId())!),
        }));
        // Flesh Shield reaches 2 cells (balance change 2026-08-08), so coverage is measured at range 2.
        const covered = wardCells.filter(({ cells }) => placementDistance(protectorCells, cells) <= 2);

        expect(covered.map(({ ward }) => ward)).toContain(primary);
        expect(covered.length).toBeGreaterThanOrEqual(2);
        // The large body may extend one row toward the enemy, but its back edge remains level with the ward
        // instead of occupying only the generic forward screen.
        expect(Math.min(...protectorCells.map((cell) => cell.y))).toBeLessThanOrEqual(
            Math.min(...placementFootprint(primary, primaryBase!).map((cell) => cell.y)),
        );
    });

    it("places Angel inside both ranged-line wards only against a public enemy shooter", () => {
        const angelPlacement = (opponentId: number) => {
            const combat = createCombatTestContext();
            const angel = createTestUnit({
                team: LEFT,
                name: "Angel",
                attackType: MELEE_MAGIC,
                movementType: FLY,
                size: PBTypes.UnitSizeVals.LARGE,
            });
            const primary = createTestUnit({
                team: LEFT,
                name: "Primary Archer",
                attackType: RANGE,
                rangeShots: 10,
                damageMax: 20,
            });
            const secondary = createTestUnit({
                team: LEFT,
                name: "Secondary Mage",
                attackType: MELEE_MAGIC,
                spells: ["Life:Fire Strike"],
                damageMax: 10,
            });
            const melee = createTestUnit({ team: LEFT, name: "Frontliner", attackType: MELEE });
            const enemy = createTestUnit({ team: RIGHT, name: "Hidden Enemy", attackType: MELEE });
            for (const unit of [angel, primary, secondary, melee, enemy]) combat.unitsHolder.addUnit(unit);
            const context: IPlacementContext = {
                team: LEFT,
                grid: combat.grid,
                unitsHolder: combat.unitsHolder,
                pathHelper: new PathHelper(testGridSettings),
                placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
                publicOpponentCreatureIds: [opponentId],
                setupPlacementPolicy: "public-roster",
            };
            return {
                angel,
                primary,
                secondary,
                result: v08BacklineProtectorPlacement([angel, primary, secondary, melee], context),
            };
        };

        const active = angelPlacement(PBTypes.CreatureVals.CENTAUR);
        const angelBase = active.result?.get(active.angel.getId());
        expect(angelBase).toBeDefined();
        const angelCells = placementFootprint(active.angel, angelBase!);
        for (const ward of [active.primary, active.secondary]) {
            expect(
                placementDistance(angelCells, placementFootprint(ward, active.result!.get(ward.getId())!)),
            ).toBeLessThanOrEqual(2);
        }

        expect(angelPlacement(PBTypes.CreatureVals.SQUIRE).result).toBeUndefined();
    });

    it("preserves both Abomination and Angel coverage when their placement roles share wards", () => {
        const combat = createCombatTestContext();
        const abomination = createTestUnit({
            team: LEFT,
            name: "Abomination",
            attackType: MELEE,
            size: PBTypes.UnitSizeVals.LARGE,
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const angel = createTestUnit({
            team: LEFT,
            name: "Angel",
            attackType: MELEE_MAGIC,
            movementType: FLY,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const primary = createTestUnit({
            team: LEFT,
            name: "Primary Archer",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 30,
            amountAlive: 5,
        });
        const secondary = createTestUnit({
            team: LEFT,
            name: "Secondary Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
            damageMax: 30,
            amountAlive: 5,
        });
        const third = createTestUnit({
            team: LEFT,
            name: "Third Archer",
            attackType: RANGE,
            rangeShots: 4,
            damageMax: 5,
            amountAlive: 5,
        });
        const enemy = createTestUnit({ team: RIGHT, name: "Enemy Shooter", attackType: RANGE, rangeShots: 5 });
        for (const unit of [abomination, angel, primary, secondary, third, enemy]) {
            combat.unitsHolder.addUnit(unit);
        }
        const context: IPlacementContext = {
            team: LEFT,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
            publicOpponentCreatureIds: [PBTypes.CreatureVals.CENTAUR],
            setupPlacementPolicy: "public-roster",
        };

        const result = v08BacklineProtectorPlacement([abomination, angel, primary, secondary, third], context)!;
        const abominationCells = placementFootprint(abomination, result.get(abomination.getId())!);
        const angelCells = placementFootprint(angel, result.get(angel.getId())!);
        const primaryCells = placementFootprint(primary, result.get(primary.getId())!);
        const secondaryCells = placementFootprint(secondary, result.get(secondary.getId())!);

        expect(placementDistance(abominationCells, primaryCells)).toBeLessThanOrEqual(1);
        expect(placementDistance(angelCells, primaryCells)).toBeLessThanOrEqual(2);
        expect(placementDistance(angelCells, secondaryCells)).toBeLessThanOrEqual(2);
    });

    it("keeps every split Angel screen intact while optimizing the next Angel", () => {
        const combat = createCombatTestContext();
        const angels = [0, 1].map(() =>
            createTestUnit({
                team: LEFT,
                name: "Angel",
                attackType: MELEE_MAGIC,
                movementType: FLY,
                size: PBTypes.UnitSizeVals.LARGE,
            }),
        );
        const wards = [
            createTestUnit({
                team: LEFT,
                name: "Primary Archer",
                attackType: RANGE,
                rangeShots: 10,
                damageMax: 20,
            }),
            createTestUnit({
                team: LEFT,
                name: "Secondary Mage",
                attackType: MELEE_MAGIC,
                spells: ["Life:Fire Strike"],
                damageMax: 10,
            }),
        ];
        const enemy = createTestUnit({ team: RIGHT, name: "Enemy Shooter", attackType: RANGE, rangeShots: 5 });
        for (const unit of [...angels, ...wards, enemy]) combat.unitsHolder.addUnit(unit);
        const context: IPlacementContext = {
            team: LEFT,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
            publicOpponentCreatureIds: [PBTypes.CreatureVals.CENTAUR],
            setupPlacementPolicy: "public-roster",
        };

        const result = v08BacklineProtectorPlacement([...angels, ...wards], context)!;
        for (const angel of angels) {
            const angelCells = placementFootprint(angel, result.get(angel.getId())!);
            for (const ward of wards) {
                expect(
                    placementDistance(angelCells, placementFootprint(ward, result.get(ward.getId())!)),
                ).toBeLessThanOrEqual(2);
            }
        }
    });

    it("keeps Queen's anti-splash precedence but retains Abomination's primary ward under dispersion", () => {
        expect(placement("Arachna Queen").result).toBeUndefined();
        expect(placement("Arachna Queen", { publicFlyer: true }).result).toBeUndefined();
        expect(placement("Arachna Queen", { holderFlyer: true }).result).toBeUndefined();
        expect(
            placement("Arachna Queen", {
                publicFlyer: true,
                setupPlacementPolicy: "legitimate-reveal",
            }).result,
        ).toBeUndefined();
        const revealedAntiFly = placement("Arachna Queen", {
            revealedFlyer: true,
            setupPlacementPolicy: "legitimate-reveal",
        });
        expect(revealedAntiFly.result?.has(revealedAntiFly.protector.getId())).toBe(true);
        const antiFly = placement("Arachna Queen", {
            publicFlyer: true,
            setupPlacementPolicy: "public-roster",
        });
        expect(antiFly.result?.has(antiFly.protector.getId())).toBe(true);
        const splash = placement("Abomination", { splash: true });
        const protectorCell = splash.result?.get(splash.protector.getId());
        const wardCell = splash.result?.get(splash.ward.getId());
        const extraCell = splash.result?.get(splash.extraMelee.getId());
        expect(protectorCell).toBeDefined();
        expect(wardCell).toBeDefined();
        expect(extraCell).toBeDefined();
        expect(Math.max(Math.abs(protectorCell!.x - wardCell!.x), Math.abs(protectorCell!.y - wardCell!.y))).toBe(1);
        expect(
            Math.min(
                Math.max(Math.abs(extraCell!.x - protectorCell!.x), Math.abs(extraCell!.y - protectorCell!.y)),
                Math.max(Math.abs(extraCell!.x - wardCell!.x), Math.abs(extraCell!.y - wardCell!.y)),
            ),
        ).toBeGreaterThan(1);
    });
});
