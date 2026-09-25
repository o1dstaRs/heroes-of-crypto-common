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

// Regressions for the engine issues found auditing the Knowledge Base against the engine (server
// docs/ENGINE_ISSUES.md). Each describe block names its tracker id.

import { describe, expect, it } from "bun:test";

import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createDefaultGameRuntime } from "../../src/engine/runtime";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
    testGridSettings,
    type TestUnitOptions,
} from "../helpers/combat";

const HEALER_BOOK = ["Life:Heal", "Life:Heal", "Life:Heal", "Life:Heal", "Life:Blessing", "Life:Blessing"];

const setupSplit = (source: TestUnitOptions) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    const unit = createTestUnit({ team: PBTypes.TeamVals.LEFT, ...source });
    context.unitsHolder.addUnit(unit);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        canSplitUnit: () => true,
        // Like the server: the new stack is built fresh from the creature's configuration, full kit included.
        createSplitUnit: (sourceUnit, amount) =>
            createTestUnit({ ...source, team: sourceUnit.getTeam(), amountAlive: amount }),
    });
    const split = (amount: number): Unit => {
        const result = engine.apply({ type: "split_unit", unitId: unit.getId(), amount });
        const event = result.events.find((candidate) => candidate.type === "unit_split");
        expect(result.completed).toBe(true);
        return context.unitsHolder.getAllUnits().get(event?.type === "unit_split" ? event.newUnitId : "")!;
    };
    return { unit, split };
};

const spellCount = (unit: Unit, name: string): number =>
    unit.getUnitProperties().spells.filter((entry) => entry.substring(entry.indexOf(":") + 1) === name).length;

describe("S3: a split shares what the stack carries instead of duplicating it", () => {
    it("shares the arrows: two halves carry the stack's quiver between them", () => {
        const { unit, split } = setupSplit({
            name: "Arbalester",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 10,
            amountAlive: 124,
        });

        const half = split(62);

        expect(half.getRangeShots()).toBe(5);
        expect(unit.getRangeShots()).toBe(5);
        const quarter = split(31);
        expect(quarter.getRangeShots() + unit.getRangeShots() + half.getRangeShots()).toBe(10);
    });

    it("shares every spell charge and keeps a single charge with the source", () => {
        const { unit, split } = setupSplit({
            name: "Healer",
            spells: [...HEALER_BOOK, ":Resurrection"],
            amountAlive: 40,
        });

        const half = split(20);

        expect(spellCount(half, "Heal")).toBe(2);
        expect(spellCount(unit, "Heal")).toBe(2);
        expect(spellCount(half, "Blessing")).toBe(1);
        expect(spellCount(unit, "Blessing")).toBe(1);
        expect(spellCount(half, "Resurrection")).toBe(0);
        expect(spellCount(unit, "Resurrection")).toBe(1);
        expect(half.hasSpellRemaining("Resurrection")).toBe(false);
        expect(unit.hasSpellRemaining("Resurrection")).toBe(true);
    });

    it("a split-off Angel gets no Resurrection charge, so it can't raise itself as well", () => {
        const { unit, split } = setupSplit({
            name: "Angel",
            abilities: ["Resurrection"],
            amountAlive: 2,
        });
        expect(unit.canSelfResurrect()).toBe(true);

        const lone = split(1);

        expect(lone.canSelfResurrect()).toBe(false);
        expect(unit.canSelfResurrect()).toBe(true);
    });

    it("merging a part back returns its charges and arrows", () => {
        const { unit, split } = setupSplit({
            name: "Healer",
            spells: HEALER_BOOK,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 10,
            amountAlive: 40,
        });
        const half = split(20);

        unit.takeResourcesFromMerge(half, half.getAmountAlive());

        expect(spellCount(unit, "Heal")).toBe(4);
        expect(spellCount(unit, "Blessing")).toBe(2);
        expect(unit.getRangeShots()).toBe(10);
        expect(spellCount(half, "Heal")).toBe(0);
        expect(half.getRangeShots()).toBe(0);
    });
});

describe("G1: Lightning Spin grows with stack power instead of shrinking", () => {
    // The spin's stack-powered multiplier (20% per stack power) used to land in the damage DIVISOR slot, so a
    // stack-power-1 Hydra spun for about five times what a full stack did.
    const spinDamage = (stackPower: number): number => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const { abilityFactory, effectFactory } = createCombatFactories();
        const hydra = createUnitFromSpec(
            { faction: "Chaos", creatureName: "Hydra", level: 4, size: 2, amount: 3 },
            PBTypes.TeamVals.RIGHT,
            testGridSettings,
            abilityFactory,
            effectFactory,
        );
        hydra.setStackPower(stackPower);
        const tank = createTestUnit({
            name: "Tank",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 10_000,
            amountAlive: 10,
            armor: 20,
        });
        placeUnit(grid, unitsHolder, hydra, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, tank, { x: 6, y: 7 });

        const before = tank.getCumulativeHp();
        processLightningSpinAbility(hydra, new SceneLogMock(), unitsHolder, 1, stats, { x: 6, y: 6 }, true);
        return before - tank.getCumulativeHp();
    };

    it("a full stack spins harder than a stack-power-1 one", () => {
        const full = spinDamage(5);
        const weak = spinDamage(1);

        expect(full).toBeGreaterThan(0);
        expect(full).toBeGreaterThan(weak * 2);
    });
});

describe("G10: Lightning Spin respects Terrifying Gaze", () => {
    it("a frightened spinner leaves the unit it may not attack out of the spin", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const spinner = createTestUnit({
            name: "Spinner",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Lightning Spin"],
            attack: 20,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
        });
        const frightener = createTestUnit({
            name: "Manticore",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 1000,
            amountAlive: 5,
        });
        const other = createTestUnit({ name: "Other", team: PBTypes.TeamVals.LEFT, maxHp: 1000, amountAlive: 5 });
        placeUnit(grid, unitsHolder, spinner, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, frightener, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, other, { x: 6, y: 5 });
        spinner.setForbiddenTarget(frightener.getId());
        const frightenerHp = frightener.getCumulativeHp();
        const otherHp = other.getCumulativeHp();

        processLightningSpinAbility(spinner, new SceneLogMock(), unitsHolder, 1, stats, { x: 5, y: 5 }, true);

        expect(frightener.getCumulativeHp()).toBe(frightenerHp);
        expect(other.getCumulativeHp()).toBeLessThan(otherHp);
    });
});

describe("G2: a stack wiped out by an area shot doesn't shoot back", () => {
    it("an Area Throw that kills a shooter outright gets no counter-shot", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const thrower = createTestUnit({
            name: "Thrower",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
            amountAlive: 5,
            maxHp: 50,
            abilities: ["Area Throw"],
        });
        const shooter = createTestUnit({
            name: "Shooter",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            amountAlive: 1,
            maxHp: 10,
        });
        thrower.calculateMissChance = () => 0;
        shooter.calculateMissChance = () => 0;
        thrower.calculateAttackDamage = () => 500;
        placeUnit(grid, unitsHolder, thrower, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, shooter, { x: 8, y: 1 });
        const throwerHp = thrower.getCumulativeHp();

        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            createVisibleDamage(shooter),
            thrower,
            [[shooter]],
            [thrower],
            shooter.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(shooter.isDead()).toBe(true);
        expect(thrower.getCumulativeHp()).toBe(throwerHp);
        expect(shooter.getRangeShots()).toBe(2);
    });
});

describe("G3: the turn clock shares the lap budget among the stacks still alive", () => {
    it("losses lengthen the surviving stacks' turns", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const left = Array.from({ length: 8 }, (_, index) =>
            createTestUnit({ name: `Left ${index}`, team: PBTypes.TeamVals.LEFT, amountAlive: 1, maxHp: 10 }),
        );
        left.forEach((unit, index) => placeUnit(grid, unitsHolder, unit, { x: index, y: 0 }));
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 8);
        // Six of the eight stacks fall; the clock used to keep sharing the 4-minute lap among eight.
        for (const unit of left.slice(2)) {
            unit.applyDamage(1_000, 0, new SceneLogMock(), false);
        }
        const turnEngine = new TurnEngine({
            fightProperties,
            grid,
            unitsHolder,
            moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
            sceneLog: new SceneLogMock(),
            runtime: { ...createDefaultGameRuntime(), clock: { nowMillis: () => 1_000 } },
        });

        (turnEngine as unknown as { activateNextUnit(unit: Unit): unknown }).activateNextUnit(left[0]);

        // Two stacks left to act: min(60 s, 240 s ÷ 2), not 240 s ÷ 8 = 30 s.
        expect(fightProperties.getCurrentTurnEnd() - fightProperties.getCurrentTurnStart()).toBe(60_000);
    });
});
