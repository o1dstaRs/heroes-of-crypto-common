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
    preservesV08BacklineProtectorIntent,
    preservesV08BacklineWardIntent,
    prioritizeV08BacklineProtector,
    v08BacklineProtectorPlacement,
} from "../../src/ai/versions/v0_8_backline_protector";
import { repairV08BacklineWardDecision } from "../../src/ai/versions/v0_8";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { MightSynergy, SynergyLevel } from "../../src/synergies/synergy_properties";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
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

const protectorBoard = (
    protectorName: "Abomination" | "Arachna Queen",
    options: { summoned?: boolean; flyer?: boolean; protectorCell?: { x: number; y: number } } = {},
): {
    protector: Unit;
    ward: Unit;
    enemy: Unit;
    context: IDecisionContext;
} => {
    const combat = createCombatTestContext();
    const protector = createTestUnit({
        team: LOWER,
        name: protectorName,
        attackType: MELEE,
        movementType: WALK,
        summoned: options.summoned,
    });
    const ward = createTestUnit({
        team: LOWER,
        name: "Valuable Archer",
        attackType: RANGE,
        rangeShots: 8,
        damageMax: 20,
        amountAlive: 5,
    });
    const enemy = createTestUnit({
        team: UPPER,
        name: options.flyer ? "Enemy Flyer" : "Enemy Ground",
        attackType: MELEE,
        movementType: options.flyer ? FLY : WALK,
    });
    placeUnit(combat.grid, combat.unitsHolder, ward, { x: 5, y: 5 });
    placeUnit(combat.grid, combat.unitsHolder, protector, options.protectorCell ?? { x: 5, y: 4 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, options.flyer ? { x: 6, y: 5 } : { x: 12, y: 12 });
    return { protector, ward, enemy, context: decisionContext(combat) };
};

describe("v0.8 back-line protector intent", () => {
    it("recognizes live shot output and remaining hybrid-caster spells, but not depleted shooters", () => {
        const shooter = createTestUnit({ team: LOWER, attackType: RANGE, rangeShots: 1 });
        const depleted = createTestUnit({ team: LOWER, attackType: RANGE, rangeShots: 0 });
        const hybrid = createTestUnit({
            team: LOWER,
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike"],
        });
        const underpoweredCaster = createTestUnit({
            team: LOWER,
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
        const destination = follow[0]?.type === "move_unit" ? follow[0].path.at(-1)! : protector.getBaseCell();
        expect(
            Math.max(Math.abs(destination.x - ward.getBaseCell().x), Math.abs(destination.y - ward.getBaseCell().y)),
        ).toBeLessThan(4);
    });

    it("keeps a useful in-place action when forced displacement has no legal catch-up route", () => {
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
        expect(prioritizeV08BacklineProtector(protector, context, inPlaceAttack, false)).toBe(inPlaceAttack);
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

    it("keeps a spell-bearing melee ward screened instead of letting it rush", () => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({ team: LOWER, name: "Abomination", attackType: MELEE });
        const ward = createTestUnit({
            team: LOWER,
            name: "Battle Mage",
            attackType: MELEE_MAGIC,
            spells: ["Life:Fire Strike", "Life:Meteorite"],
        });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
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
        context.fightProperties!.setSynergyUnitsPerFactions(LOWER, 0, 0, 6, 0);
        context.fightProperties!.updateSynergyPerTeam(
            LOWER,
            PBTypes.FactionVals.MIGHT,
            MightSynergy.PLUS_AURAS_RANGE,
            SynergyLevel.LEVEL_3,
        );

        const withinExtendedAura: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: protector.getId(),
                targetId: context.unitsHolder.getAllEnemyUnits(LOWER)[0].getId(),
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

        const noFlyer = protectorBoard("Arachna Queen");
        expect(buildV08BacklineProtectorIntent(noFlyer.protector, noFlyer.context)).toBeUndefined();
        expect(prioritizeV08BacklineProtector(noFlyer.protector, noFlyer.context, rush, true)).toBe(rush);

        const summoned = protectorBoard("Arachna Queen", { flyer: true, summoned: true });
        expect(buildV08BacklineProtectorIntent(summoned.protector, summoned.context)).toBeUndefined();
    });

    it("releases both protector roles for the universal late finish", () => {
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
        result: Map<string, { x: number; y: number }> | undefined;
    } => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({ team: LOWER, name: protectorName, attackType: MELEE });
        const ward = createTestUnit({
            team: LOWER,
            name: options.casterAttackType ? "Battle Mage" : "Archer",
            attackType: options.casterAttackType ?? RANGE,
            rangeShots: options.casterAttackType ? 0 : 5,
            spells: options.casterAttackType ? ["Life:Fire Strike"] : [],
        });
        const extraMelee = createTestUnit({ team: LOWER, name: "Squire", attackType: MELEE });
        const enemy = createTestUnit({
            team: UPPER,
            name: "Public Enemy",
            attackType: RANGE,
            movementType: options.holderFlyer ? FLY : WALK,
            abilities: options.splash ? ["Area Throw"] : [],
        });
        for (const unit of [protector, ward, extraMelee, enemy]) combat.unitsHolder.addUnit(unit);
        const context: IPlacementContext = {
            team: LOWER,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
            publicOpponentCreatureIds: options.publicFlyer
                ? [PBTypes.CreatureVals.GRIFFIN]
                : [PBTypes.CreatureVals.SQUIRE],
            revealedOpponentCreatures: options.revealedFlyer ? [PBTypes.CreatureVals.GRIFFIN] : [],
            setupPlacementPolicy: options.setupPlacementPolicy,
        };
        return {
            protector,
            ward,
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

    it("assigns Queen only against a public flyer and preserves anti-splash precedence", () => {
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
        expect(placement("Abomination", { splash: true }).result).toBeUndefined();
    });
});
