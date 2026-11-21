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

import { describe, expect, test } from "bun:test";

import {
    a19CandidateEndCells,
    a19IsPlainContactMove,
    applyA19KeepAttack,
    type IA19KeepAttackRules,
} from "../../src/ai/keep_attack";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;
const BOTH: IA19KeepAttackRules = { keepMeleeAttack: true, keepContactAttack: true };

function board(attackType = PBTypes.AttackVals.MELEE) {
    const combat = createCombatTestContext();
    const unit = createTestUnit({ team: LEFT, attackType });
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 2, y: 7 });
    const enemy = createTestUnit({ team: RIGHT });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 7 });
    const id = unit.getId();
    const moveTo = (x: number, y: number): GameAction => ({ type: "move_unit", unitId: id, path: [{ x, y }] });
    const attack: GameAction[] = [
        moveTo(7, 7),
        { type: "melee_attack", attackerId: id, targetId: enemy.getId(), attackFrom: { x: 7, y: 7 } },
    ];
    return { ...combat, unit, enemy, id, moveTo, attack };
}

describe("a19-keep-attack-v1", () => {
    test("end cells follow the move path and the cell an attack is made from", () => {
        const b = board();
        expect(a19CandidateEndCells(b.unit, [])).toEqual([{ x: 2, y: 7 }]);
        expect(a19CandidateEndCells(b.unit, [b.moveTo(5, 5)])).toEqual([{ x: 5, y: 5 }]);
        expect(a19CandidateEndCells(b.unit, b.attack)).toEqual([{ x: 7, y: 7 }]);
    });

    test("a plain contact move moves next to an enemy, diagonals included, and does not attack", () => {
        const b = board();
        expect(a19IsPlainContactMove(b.unit, [b.moveTo(7, 7)], b.unitsHolder)).toBe(true);
        expect(a19IsPlainContactMove(b.unit, [b.moveTo(7, 8)], b.unitsHolder)).toBe(true);
        expect(a19IsPlainContactMove(b.unit, [b.moveTo(6, 7)], b.unitsHolder)).toBe(false);
        expect(a19IsPlainContactMove(b.unit, b.attack, b.unitsHolder)).toBe(false);
        expect(a19IsPlainContactMove(b.unit, [{ type: "wait_turn", unitId: b.id }], b.unitsHolder)).toBe(false);
    });

    test("rule 1: when the native choice attacks in melee, only another attack can replace it", () => {
        const b = board();
        const candidates = [
            { actions: b.attack },
            { actions: [b.moveTo(4, 7)] },
            { actions: [{ type: "defend_turn", unitId: b.id }] as GameAction[] },
        ];
        const means = [0.5, 0.6, 0.55];
        expect(
            applyA19KeepAttack(b.unit, candidates, means, b.unitsHolder, {
                keepMeleeAttack: true,
                keepContactAttack: false,
            }),
        ).toBe(2);
        expect(means).toEqual([0.5, 0.6 - 1, 0.55 - 1]);
    });

    test("rule 2: while an attack is scored, a plain move into contact cannot win; other moves are untouched", () => {
        const b = board();
        const candidates = [
            { actions: [b.moveTo(3, 7)] },
            { actions: [b.moveTo(7, 7)] },
            { actions: [b.moveTo(5, 7)] },
            { actions: b.attack },
        ];
        const means = [0.5, 0.7, 0.6, 0.55];
        expect(applyA19KeepAttack(b.unit, candidates, means, b.unitsHolder, BOTH)).toBe(1);
        expect(means).toEqual([0.5, 0.7 - 1, 0.6, 0.55]);
    });

    test("nothing changes without a scored attack, for illegal candidates, for the native choice or for ranged units", () => {
        const b = board();
        const noAttack = [{ actions: [b.moveTo(3, 7)] }, { actions: [b.moveTo(7, 7)] }];
        const plain = [0.5, 0.7];
        expect(applyA19KeepAttack(b.unit, noAttack, plain, b.unitsHolder, BOTH)).toBe(0);
        expect(plain).toEqual([0.5, 0.7]);
        const illegal = [{ actions: [b.moveTo(7, 7)] }, { actions: [b.moveTo(7, 8)] }, { actions: b.attack }];
        const withIllegal = [0.5, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        expect(applyA19KeepAttack(b.unit, illegal, withIllegal, b.unitsHolder, BOTH)).toBe(0);
        expect(withIllegal).toEqual([0.5, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]);
        const native = [{ actions: [b.moveTo(7, 7)] }, { actions: b.attack }];
        const nativeMeans = [0.5, 0.4];
        expect(applyA19KeepAttack(b.unit, native, nativeMeans, b.unitsHolder, BOTH)).toBe(0);
        expect(nativeMeans).toEqual([0.5, 0.4]);
        const shooter = board(PBTypes.AttackVals.RANGE);
        const shooterMeans = [0.5, 0.7];
        const shooterCandidates = [{ actions: shooter.attack }, { actions: [shooter.moveTo(7, 7)] }];
        expect(applyA19KeepAttack(shooter.unit, shooterCandidates, shooterMeans, shooter.unitsHolder, BOTH)).toBe(0);
        expect(shooterMeans).toEqual([0.5, 0.7]);
    });

    test("switches off independently", () => {
        const b = board();
        const candidates = [{ actions: b.attack }, { actions: [b.moveTo(7, 8)] }];
        const off = [0.5, 0.7];
        expect(
            applyA19KeepAttack(b.unit, candidates, off, b.unitsHolder, {
                keepMeleeAttack: false,
                keepContactAttack: false,
            }),
        ).toBe(0);
        expect(off).toEqual([0.5, 0.7]);
        const contactOnly = [0.5, 0.7];
        expect(
            applyA19KeepAttack(b.unit, candidates, contactOnly, b.unitsHolder, {
                keepMeleeAttack: false,
                keepContactAttack: true,
            }),
        ).toBe(1);
        expect(contactOnly).toEqual([0.5, 0.7 - 1]);
    });
});
