import { expect, test } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { BattleRollbackJournal, restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

function fixture() {
    const context = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const left = [createTestUnit({ team: PBTypes.TeamVals.LEFT }), createTestUnit({ team: PBTypes.TeamVals.LEFT })];
    const right = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
    for (const [i, unit] of [...left, right].entries())
        placeUnit(context.grid, context.unitsHolder, unit, { x: i + 2, y: 3 });
    fight.setSynergiesPerTeam(left[0].getTeam(), ["Life:1:1", "Nature:1:1"]);
    fight.setSynergiesPerTeam(right.getTeam(), ["Chaos:1:1"]);
    const leftList = fight.getSynergiesPerTeam(left[0].getTeam());
    const rightList = fight.getSynergiesPerTeam(right.getTeam());
    for (const unit of left) unit.setSynergies(leftList);
    right.setSynergies(rightList);
    const journal = new BattleRollbackJournal(context.unitsHolder, context.grid, fight);
    return { ...context, fight, left, right, leftList, rightList, journal };
}

function expectLinks(f: ReturnType<typeof fixture>) {
    expect(f.left[0].getUnitProperties().synergies).toBe(f.left[1].getUnitProperties().synergies);
    expect(f.left[0].getUnitProperties().synergies).toBe(f.fight.getSynergiesPerTeam(f.left[0].getTeam()));
    expect(f.right.getUnitProperties().synergies).toBe(f.fight.getSynergiesPerTeam(f.right.getTeam()));
    expect(f.left[0].getUnitProperties().synergies).toEqual(["Life:1:1", "Nature:1:1"]);
    expect(f.right.getUnitProperties().synergies).toEqual(["Chaos:1:1"]);
}

test("a unit-only checkpoint keeps its synergy list shared without capturing untouched peers", () => {
    const f = fixture(),
        checkpoint = f.journal.checkpoint();
    try {
        f.left[0].setTarget("speculative target");
        expect(checkpoint.getCapturedObjectCounts()).toEqual({ units: 1, grid: 0, fight: 0, holder: 0 });
    } finally {
        checkpoint.rollback();
    }
    expectLinks(f);
    expect(f.left[0].getUnitProperties().synergies).toBe(f.leftList);
});

test("a fight-only checkpoint keeps synergy links to untouched units on both teams", () => {
    const f = fixture(),
        checkpoint = f.journal.checkpoint();
    try {
        f.fight.setSynergiesPerTeam(f.left[0].getTeam(), ["Life:2:3"]);
        expect(checkpoint.getCapturedObjectCounts()).toEqual({ units: 0, grid: 0, fight: 1, holder: 0 });
    } finally {
        checkpoint.rollback();
    }
    expectLinks(f);
    expect(f.fight.getSynergiesPerTeam(f.right.getTeam())).toBe(f.rightList);
});

test("unit and fight first-touch order preserves the original synergy owners", () => {
    const f = fixture();
    for (const fightFirst of [false, true]) {
        const checkpoint = f.journal.checkpoint();
        try {
            if (fightFirst) f.fight.setSynergiesPerTeam(f.right.getTeam(), ["Chaos:2:2"]);
            f.left[0].setTarget("temporary");
            f.fight.setSynergiesPerTeam(f.left[0].getTeam(), []);
            if (!fightFirst) f.fight.setSynergiesPerTeam(f.right.getTeam(), []);
            f.right.setTarget("temporary");
        } finally {
            checkpoint.rollback();
        }
        expectLinks(f);
    }
});

test("a retained live synergy array can mutate during a branch without contaminating rollback", () => {
    const f = fixture(),
        checkpoint = f.journal.checkpoint();
    try {
        f.leftList.splice(0, 1, "Life:2:3");
        f.rightList.push("Might:1:2");
        expect(checkpoint.getCapturedObjectCounts()).toEqual({ units: 0, grid: 0, fight: 0, holder: 0 });
    } finally {
        checkpoint.rollback();
    }
    expectLinks(f);
    expect(f.leftList).toEqual(["Life:1:1", "Nature:1:1"]);
    expect(f.rightList).toEqual(["Chaos:1:1"]);
});

test("equal independent and empty synergy lists retain their distinct owners", () => {
    const f = fixture();
    const independent = [...f.leftList],
        empty: string[] = [];
    f.left[1].setSynergies(independent);
    f.right.setSynergies(empty);
    const checkpoint = f.journal.checkpoint();
    try {
        f.left[0].setTarget("a");
        f.left[1].setTarget("b");
        f.right.setTarget("c");
        independent.push("Might:1:1");
        empty.push("Chaos:2:1");
    } finally {
        checkpoint.rollback();
    }
    expect(f.left[0].getUnitProperties().synergies).toBe(f.fight.getSynergiesPerTeam(f.left[0].getTeam()));
    expect(f.left[1].getUnitProperties().synergies).toEqual(f.leftList);
    expect(f.left[1].getUnitProperties().synergies).not.toBe(f.left[0].getUnitProperties().synergies);
    expect(f.right.getUnitProperties().synergies).toEqual([]);
    expect(f.right.getUnitProperties().synergies).not.toBe(f.fight.getSynergiesPerTeam(f.right.getTeam()));
    expect(independent).toEqual(f.leftList);
    expect(empty).toEqual([]);
});

test("checkpoint restoration preserves holes in a shared sparse string list", () => {
    const f = fixture(),
        list = new Array<string>(3);
    list[2] = "Life:1:1";
    for (const unit of f.left) unit.setSynergies(list);
    const checkpoint = f.journal.checkpoint();
    try {
        f.left[0].setTarget("temporary");
        list[0] = "Nature:2:1";
        list.push("Might:1:1");
    } finally {
        checkpoint.rollback();
    }
    expect(f.left[0].getUnitProperties().synergies).toBe(f.left[1].getUnitProperties().synergies);
    expect(f.left[0].getUnitProperties().synergies).toBe(list);
    expect(list).toHaveLength(3);
    expect(0 in list).toBe(false);
    expect(1 in list).toBe(false);
    expect(list[2]).toBe("Life:1:1");
});

test("unchanged immutable synergy lists keep their aliases without a rollback write", () => {
    const f = fixture(),
        list = Object.freeze(["Life:1:1"]) as unknown as string[];
    for (const unit of f.left) unit.setSynergies(list);
    const checkpoint = f.journal.checkpoint();
    try {
        f.left[0].setTarget("temporary");
    } finally {
        checkpoint.rollback();
    }
    expect(f.left[0].getUnitProperties().synergies).toBe(list);
    expect(f.left[1].getUnitProperties().synergies).toBe(list);
    expect(Object.isFrozen(list)).toBe(true);
});

test("full snapshots preserve the same synergy sharing and remain reusable", () => {
    const f = fixture(),
        saved = snapshotBattle(f.unitsHolder, f.grid, f.fight);
    f.leftList.push("Might:1:1");
    f.rightList.length = 0;
    for (let i = 0; i < 2; i++) {
        restoreBattle(saved, f.unitsHolder, f.grid, f.fight);
        expectLinks(f);
        f.left[0].getUnitProperties().synergies.push("Chaos:2:2");
    }
});
