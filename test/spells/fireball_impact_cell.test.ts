import { afterEach, describe, expect, test } from "bun:test";

import { enumerateCandidates } from "../../src/ai/candidates";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getCellForPosition } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { resolveThrownSpellImpact } from "../../src/spells/spell_helper";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const originalFight = FightStateManager.getInstance().getFightProperties();
afterEach(() => FightStateManager.getInstance().setFightProperties(originalFight));

function formation(reversed = false) {
    const combat = createCombatTestContext();
    const casterTeam = reversed ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const enemyTeam = reversed ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const point = ({ x, y }: XY): XY => (reversed ? { x: 15 - x, y: 15 - y } : { x, y });
    const add = (name: string, cells: XY[], caster = false) => {
        const occupied = cells.map(point);
        const unit = createTestUnit({
            name,
            team: caster ? casterTeam : enemyTeam,
            spells: caster ? ["Chaos:Fireball"] : [],
            attackType: caster ? PBTypes.AttackVals.MAGIC : PBTypes.AttackVals.MELEE,
            amountAlive: 10,
            maxHp: 100,
            stackPower: 3,
            footprintWidth: Math.max(...occupied.map((c) => c.x)) - Math.min(...occupied.map((c) => c.x)) + 1,
            footprintHeight: Math.max(...occupied.map((c) => c.y)) - Math.min(...occupied.map((c) => c.y)) + 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, unit, {
            x: Math.max(...occupied.map((c) => c.x)),
            y: Math.max(...occupied.map((c) => c.y)),
        });
        return unit;
    };
    // The relevant corner of ranked bb3ddbc4: the Wolf covers the Dragon's lower left.
    const caster = add("Wandering Mage", [{ x: 1, y: 14 }], true);
    const dragon = add("Magic Dragon", [
        { x: 14, y: 2 },
        { x: 15, y: 2 },
        { x: 14, y: 1 },
        { x: 15, y: 1 },
    ]);
    const wolf = add("Wolf", [
        { x: 12, y: 1 },
        { x: 13, y: 1 },
    ]);
    const satyr = add("Satyr", [{ x: 14, y: 0 }]);
    const mage = add("Battle Mage", [{ x: 15, y: 0 }]);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.startFight();
    fp.setTeamUnitsAlive(casterTeam, 1);
    fp.setTeamUnitsAlive(enemyTeam, 4);
    fp.startTurn(casterTeam, 1000);
    const context = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: fp,
    };
    const engine = new GameActionEngine({
        ...context,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => caster.getId(),
    });
    const impact = (target: Unit) =>
        resolveThrownSpellImpact(
            "Fireball",
            combat.grid,
            (cell) => cell.x >= 0 && cell.y >= 0 && cell.x < 16 && cell.y < 16,
            caster.getBaseCell(),
            target.getBaseCell(),
            (id) => combat.unitsHolder.getAllUnits().get(id)?.getTeam() === casterTeam,
        );
    return { caster, dragon, wolf, satyr, mage, context, engine, impact, point };
}

describe("Fireball bursts around the struck cell", () => {
    for (const [reversed, aimBehindDragon] of [
        [false, false],
        [false, true],
        [true, false],
    ]) {
        test(`${reversed ? "right" : "left"} caster, ${aimBehindDragon ? "intercepted" : "direct"}: the top-cell blast spares the lower row`, () => {
            const s = formation(reversed);
            const target = aimBehindDragon ? s.mage : s.dragon;
            const impact = s.impact(target);
            expect(impact.blockedByTerrain).toBe(false);
            expect(impact.cell).toEqual(s.point({ x: 14, y: 2 }));
            const before = [s.dragon, s.wolf, s.satyr, s.mage].map((u) => u.getCumulativeHp());
            const result = s.engine.apply({
                type: "cast_spell",
                casterId: s.caster.getId(),
                targetId: target.getId(),
                spellName: "Fireball",
            });
            expect(result.completed).toBe(true);
            expect(before[0] - s.dragon.getCumulativeHp()).toBe(20);
            expect(before[1] - s.wolf.getCumulativeHp()).toBe(20);
            expect(s.satyr.getCumulativeHp()).toBe(before[2]);
            expect(s.mage.getCumulativeHp()).toBe(before[3]);
            const cast = result.events.find((event) => event.type === "spell_cast");
            expect(cast).toMatchObject({ targetId: s.dragon.getId(), targetCell: impact.cell });
            if (cast?.type === "spell_cast") {
                expect(cast.damaged?.map((hit) => hit.unitId).sort()).toEqual(
                    [s.dragon.getId(), s.wolf.getId()].sort(),
                );
            }
        });
    }

    test("the recorded board's terrain refuses a cast when every exposed edge is obstructed", () => {
        const s = formation();
        s.context.grid.setScatteredMountains(
            [111, 115, 133, 119, 134, 137, 100, 142, 122, 135, 103, 124].map((value) => ({
                x: Math.floor((value - 1) / 16),
                y: (value - 1) % 16,
            })),
        );
        const before = [s.dragon, s.wolf, s.satyr, s.mage].map((unit) => unit.getCumulativeHp());
        expect(s.impact(s.mage).blockedByTerrain).toBe(true);
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            targetId: s.mage.getId(),
            spellName: "Fireball",
        });
        expect(result.completed).toBe(false);
        expect([s.dragon, s.wolf, s.satyr, s.mage].map((unit) => unit.getCumulativeHp())).toEqual(before);
        expect(s.caster.hasSpellRemaining("Fireball")).toBe(true);
    });

    test("an exposed far-side aim still bursts on the first Dragon cell entered by the ray", () => {
        const s = formation();
        s.context.grid.setScatteredMountains([
            { x: 11, y: 4 },
            { x: 11, y: 6 },
        ]);
        const impact = s.impact(s.dragon);
        expect(impact.blockedByTerrain).toBe(false);
        expect(impact.cell).toEqual({ x: 14, y: 2 });
        expect(getCellForPosition(testGridSettings, impact.toPosition!)).toEqual(impact.cell);
        const before = [s.satyr, s.mage].map((unit) => unit.getCumulativeHp());
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            targetId: s.dragon.getId(),
            spellName: "Fireball",
        });
        expect(result.completed).toBe(true);
        expect([s.satyr, s.mage].map((unit) => unit.getCumulativeHp())).toEqual(before);
        const cast = result.events.find((event) => event.type === "spell_cast");
        expect(cast).toMatchObject({ targetId: s.dragon.getId(), targetCell: impact.cell });
        if (cast?.type === "spell_cast") {
            expect(cast.damaged?.map((hit) => hit.unitId).sort()).toEqual([s.dragon.getId(), s.wolf.getId()].sort());
        }
    });

    for (const farSide of [false, true])
        test(`AI values the same hits as the engine, far-side aim=${farSide}`, () => {
            const s = formation();
            if (farSide)
                s.context.grid.setScatteredMountains([
                    { x: 11, y: 4 },
                    { x: 11, y: 6 },
                ]);
            const candidate = enumerateCandidates(s.caster, s.context, [
                { type: "end_turn", unitId: s.caster.getId(), reason: "manual" },
            ]).candidates.find(
                (candidate) =>
                    candidate.kind === "spell" &&
                    candidate.spellName === "Fireball" &&
                    candidate.targetId === s.dragon.getId(),
            );
            expect(candidate).toBeDefined();
            expect(candidate?.features.expectedDamage).toBe(40);
            const result = s.engine.apply(candidate!.actions[0]);
            expect(result.completed).toBe(true);
            const cast = result.events.find((event) => event.type === "spell_cast");
            if (cast?.type === "spell_cast") {
                expect(cast.damaged?.reduce((sum, hit) => sum + hit.amount, 0)).toBe(
                    candidate?.features.expectedDamage,
                );
            }
        });
});
