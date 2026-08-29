/*
 * -----------------------------------------------------------------------------
 * A hit fully absorbed by Water Shield must apply NOTHING beyond breaking the
 * shield: no on-hit debuffs (Stun & co.), exactly like a dodged blow. Regression:
 * both attack paths ran the full on-hit rider block after applyDamage returned 0,
 * so the Mermaid "blocked the hit" yet still ate the attack's debuffs.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISceneLog } from "../../src/scene/scene_log_interface";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

class RecordingSceneLog implements ISceneLog {
    public readonly lines: string[] = [];
    public getLog(): string {
        return this.lines.join("\n");
    }
    public updateLog(newLog?: string): void {
        if (newLog) {
            this.lines.push(newLog);
        }
    }
    public hasBeenUpdated(): boolean {
        return this.lines.length > 0;
    }
}

// RNG pinned to 0 makes the check fully discriminating: the stun roll (0 < chance) always LANDS if
// the rider block (wrongly) runs, and no unit here has a dodge source so nothing ever misses.
const pinRng = (): void => setDeterministicRandomSource(() => 0);

const makeStunAttacker = (attackType: number, extra: Record<string, unknown> = {}) =>
    createTestUnit({
        name: "Stun Attacker",
        team: PBTypes.TeamVals.RIGHT,
        attackType,
        attack: 10,
        damageMin: 5,
        damageMax: 5,
        amountAlive: 3,
        luck: 40,
        abilities: ["Stun"],
        ...extra,
    });

const makeShieldedTarget = () => {
    const mermaid = createTestUnit({
        name: "Mermaid",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.MELEE,
        maxHp: 100,
        amountAlive: 5,
        abilities: ["Water Shield"],
    });
    mermaid.trySeedWaterShield();
    expect(mermaid.hasBuffActive("Water Shield")).toBe(true);
    return mermaid;
};

describe("Water-Shield-absorbed hit lands no on-hit riders", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("melee: the absorbed blow does not Stun; the very next blow damages AND stuns", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const sceneLog = attackHandler["sceneLog"] as RecordingSceneLog | undefined;
        const attacker = makeStunAttacker(PBTypes.AttackVals.MELEE);
        const mermaid = makeShieldedTarget();

        placeUnit(grid, unitsHolder, mermaid, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });

        const hpBefore = mermaid.getCumulativeHp();
        const first = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(mermaid),
            undefined,
            attacker,
            mermaid,
            { x: 5, y: 3 },
        );

        expect(first.completed).toBe(true);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);
        expect(mermaid.getCumulativeHp()).toBe(hpBefore);
        expect(mermaid.getEffects().map((e) => e.getName())).not.toContain("Stun");
        void sceneLog;

        // The shield is spent, so the gate must reopen: the follow-up blow both damages and stuns.
        const second = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(mermaid),
            undefined,
            attacker,
            mermaid,
            { x: 5, y: 3 },
        );
        expect(second.completed).toBe(true);
        expect(mermaid.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(mermaid.getEffects().map((e) => e.getName())).toContain("Stun");
    });

    it("ranged: the absorbed shot does not Stun", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const attacker = makeStunAttacker(PBTypes.AttackVals.RANGE, { rangeShots: 6, shotDistance: 12 });
        const mermaid = makeShieldedTarget();

        placeUnit(grid, unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, mermaid, { x: 3, y: 9 });
        attacker.refreshPossibleAttackTypes(true);

        const hpBefore = mermaid.getCumulativeHp();
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            createVisibleDamage(mermaid),
            attacker,
            [[mermaid]],
            undefined,
            mermaid.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);
        expect(mermaid.getCumulativeHp()).toBe(hpBefore);
        expect(mermaid.getEffects().map((e) => e.getName())).not.toContain("Stun");
    });

    it("melee response: a counterattack absorbed by the ATTACKER's shield lands no riders on it", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        // The roles flip: the ATTACKER owns the shield, the struck defender counterattacks with Stun.
        const attacker = createTestUnit({
            name: "Shielded Attacker",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            attack: 10,
            damageMin: 5,
            damageMax: 5,
            amountAlive: 3,
            maxHp: 100,
            abilities: ["Water Shield"],
        });
        attacker.trySeedWaterShield();
        const defender = createTestUnit({
            name: "Stun Defender",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            attack: 10,
            damageMin: 5,
            damageMax: 5,
            amountAlive: 3,
            maxHp: 100,
            luck: 40,
            abilities: ["Stun"],
        });

        placeUnit(grid, unitsHolder, defender, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });

        const attackerHpBefore = attacker.getCumulativeHp();
        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(defender),
            undefined,
            attacker,
            defender,
            { x: 5, y: 3 },
        );

        expect(result.completed).toBe(true);
        // The defender's counter was absorbed by the attacker's shield: no damage, no Stun on the attacker.
        expect(attacker.hasBuffActive("Water Shield")).toBe(false);
        expect(attacker.getCumulativeHp()).toBe(attackerHpBefore);
        expect(attacker.getEffects().map((e) => e.getName())).not.toContain("Stun");
        // The initiating blow itself still landed on the defender.
        expect(defender.getCumulativeHp()).toBeLessThan(100 * 3);
    });
});
