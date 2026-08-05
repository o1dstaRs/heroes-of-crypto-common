import { describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
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

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
        decisionOrigin: "root",
    };
}

function createCharger(combat: CombatTestContext): Unit {
    const charger = createTestUnit({
        name: "Wolf Rider",
        team: LOWER,
        attackType: MELEE,
        attack: 20,
        damageMin: 5,
        damageMax: 5,
        amountAlive: 10,
        maxHp: 20,
        abilities: ["Rapid Charge"],
        stackPower: 5,
    });
    placeUnit(combat.grid, combat.unitsHolder, charger, { x: 4, y: 5 });
    return charger;
}

function createTarget(combat: CombatTestContext, name: string, cell: { x: number; y: number }, maxHp = 20): Unit {
    const target = createTestUnit({
        name,
        team: UPPER,
        attackType: MELEE,
        armor: 10,
        amountAlive: 20,
        maxHp,
    });
    placeUnit(combat.grid, combat.unitsHolder, target, cell);
    return target;
}

function incumbentMelee(charger: Unit, target: Unit, attackFrom: { x: number; y: number }): GameAction[] {
    const path = [{ ...charger.getBaseCell() }];
    while (path[path.length - 1].x !== attackFrom.x) {
        const current = path[path.length - 1];
        path.push({ x: current.x + Math.sign(attackFrom.x - current.x), y: current.y });
    }
    while (path[path.length - 1].y !== attackFrom.y) {
        const current = path[path.length - 1];
        path.push({ x: current.x, y: current.y + Math.sign(attackFrom.y - current.y) });
    }
    return [
        {
            type: "move_unit",
            unitId: charger.getId(),
            path,
        },
        {
            type: "melee_attack",
            attackerId: charger.getId(),
            targetId: target.getId(),
            attackFrom,
        },
    ];
}

const meleeCandidates = (candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate[] =>
    candidates.filter((candidate) => candidate.kind === "melee");

describe("research Rapid Charge different-target catalog reservation", () => {
    it("appends and marks exactly one stronger long-charge target pruned by the ordinary melee cap", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        const incumbentTarget = createTarget(combat, "Near target", { x: 6, y: 5 });
        const longChargeTarget = createTarget(combat, "Long-charge target", { x: 4, y: 8 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 5, y: 5 });
        const context = contextFor(combat);

        const control = enumerateCandidates(charger, context, incumbent, { maxMeleePairs: 1 });
        const treatment = enumerateCandidates(charger, context, incumbent, {
            maxMeleePairs: 1,
            researchReserveRapidChargeDifferentTarget: true,
        });
        const controlMelee = meleeCandidates(control.candidates);
        const treatmentMelee = meleeCandidates(treatment.candidates);
        const reserved = treatmentMelee.filter(
            (candidate) => candidate.researchRapidChargeDifferentTargetReserved === true,
        );

        expect(control.truncated).toContain("melee");
        expect(treatment.truncated).toContain("melee");
        expect(treatmentMelee).toHaveLength(controlMelee.length + 1);
        expect(reserved).toHaveLength(1);
        expect(reserved[0].targetId).toBe(longChargeTarget.getId());
        expect(reserved[0].actions.find((action) => action.type === "move_unit")).toMatchObject({
            type: "move_unit",
            path: expect.arrayContaining([
                { x: 4, y: 5 },
                { x: 4, y: 7 },
            ]),
        });
    });

    it("is byte-identical while disabled", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        const incumbentTarget = createTarget(combat, "Near target", { x: 6, y: 5 });
        createTarget(combat, "Long-charge target", { x: 4, y: 8 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 5, y: 5 });
        const context = contextFor(combat);

        const omitted = enumerateCandidates(charger, context, incumbent, { maxMeleePairs: 1 });
        const explicitOff = enumerateCandidates(charger, context, incumbent, {
            maxMeleePairs: 1,
            researchReserveRapidChargeDifferentTarget: false,
        });

        expect(explicitOff).toEqual(omitted);
        expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(omitted));
    });

    it("marks an eligible challenger already inside the cap without expanding the catalog", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        const incumbentTarget = createTarget(combat, "Near target", { x: 6, y: 5 });
        const longChargeTarget = createTarget(combat, "Long-charge target", { x: 4, y: 8 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 5, y: 5 });
        const context = contextFor(combat);

        const control = enumerateCandidates(charger, context, incumbent, { maxMeleePairs: 100 });
        const treatment = enumerateCandidates(charger, context, incumbent, {
            maxMeleePairs: 100,
            researchReserveRapidChargeDifferentTarget: true,
        });
        const reserved = treatment.candidates.filter(
            (candidate) => candidate.researchRapidChargeDifferentTargetReserved === true,
        );

        expect(treatment.candidates).toHaveLength(control.candidates.length);
        expect(reserved).toHaveLength(1);
        expect(reserved[0].targetId).toBe(longChargeTarget.getId());
    });

    it("is a no-op when Rapid Charge is inactive", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        charger.deleteAbility("Rapid Charge");
        const incumbentTarget = createTarget(combat, "Near target", { x: 6, y: 5 });
        createTarget(combat, "Long-charge target", { x: 4, y: 8 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 5, y: 5 });
        const context = contextFor(combat);
        const control = enumerateCandidates(charger, context, incumbent, { maxMeleePairs: 1 });
        const treatment = enumerateCandidates(charger, context, incumbent, {
            maxMeleePairs: 1,
            researchReserveRapidChargeDifferentTarget: true,
        });

        expect(treatment).toEqual(control);
    });

    it("does not reserve without a strictly stronger supported different-target charge", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        const incumbentTarget = createTarget(combat, "Incumbent target", { x: 4, y: 8 });
        createTarget(combat, "Equal-distance target", { x: 8, y: 5 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 3, y: 7 });

        const result = enumerateCandidates(charger, contextFor(combat), incumbent, {
            maxMeleePairs: 1,
            researchReserveRapidChargeDifferentTarget: true,
        });

        expect(
            result.candidates.some((candidate) => candidate.researchRapidChargeDifferentTargetReserved === true),
        ).toBe(false);
    });

    it("does not reserve over an incumbent secure kill", () => {
        const combat = createCombatTestContext();
        const charger = createCharger(combat);
        const incumbentTarget = createTarget(combat, "Dying target", { x: 6, y: 5 }, 1);
        createTarget(combat, "Long-charge target", { x: 4, y: 8 });
        const incumbent = incumbentMelee(charger, incumbentTarget, { x: 5, y: 5 });

        const result = enumerateCandidates(charger, contextFor(combat), incumbent, {
            maxMeleePairs: 1,
            researchReserveRapidChargeDifferentTarget: true,
        });

        expect(
            result.candidates.some((candidate) => candidate.researchRapidChargeDifferentTargetReserved === true),
        ).toBe(false);
    });
});
