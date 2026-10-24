import { afterEach, describe, expect, it } from "bun:test";

import { processBorrowedGraceAbility } from "../../src/abilities/borrowed_grace_ability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { BattleRollbackJournal, restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, type CombatTestContext } from "../helpers/combat";

const sceneLog = new SceneLogMock();

function caster(name = "Caster", amountAlive = 2): Unit {
    return createTestUnit({
        name,
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 100,
        armor: 20,
        amountAlive,
        stackPower: 4,
        spells: ["Life:Helping Hand", "Life:Helping Hand"],
    });
}

function recipient(name = "Recipient", amountAlive = 2): Unit {
    return createTestUnit({ name, team: PBTypes.TeamVals.RIGHT, maxHp: 50, armor: 10, amountAlive });
}

function fixture() {
    const context = createCombatTestContext();
    const donor = caster();
    const target = recipient();
    placeUnit(context.grid, context.unitsHolder, donor, { x: 2, y: 2 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 3, y: 2 });
    return { ...context, donor, target, fight: FightStateManager.getInstance().getFightProperties() };
}

function cast(context: CombatTestContext, donor: Unit, target: Unit): void {
    donor.setStackPower(4);
    const spell = donor.getSpells().find((candidate) => candidate.getName() === "Helping Hand");
    expect(spell).toBeDefined();
    const result = context.attackHandler.handleMagicAttack(
        context.grid.getMatrix(),
        context.unitsHolder,
        spell,
        donor,
        target,
    );
    expect(result.completed).toBe(true);
    context.unitsHolder.refreshStackPowerForAllUnits();
}

function kill(unit: Unit): void {
    unit.applyDamage(unit.getCumulativeHp(), 0, sceneLog);
    expect(unit.isDead()).toBe(true);
}

function expectLink(donor: Unit, target: Unit, penalty = donor): void {
    expect(target.hasBuffActive("Helping Hand")).toBe(true);
    expect(penalty.hasDebuffActive("Helping Hand")).toBe(true);
    expect(target.getUnitProperties().helping_hand_caster_id).toBe(donor.getId());
    expect(target.getUnitProperties().helping_hand_penalty_id).toBe(penalty.getId());
}

function expectReleased(donor: Unit, target: Unit, penalty = donor): void {
    expect(target.hasBuffActive("Helping Hand")).toBe(false);
    expect(penalty.hasDebuffActive("Helping Hand")).toBe(false);
    expect(target.getUnitProperties().helping_hand_caster_id).toBeUndefined();
    expect(target.getUnitProperties().helping_hand_penalty_id).toBeUndefined();
    if (!target.isDead()) {
        expect(target.getMaxHp()).toBe(50);
        expect(target.getBaseArmor()).toBe(10);
    }
    if (!donor.isDead()) {
        expect(donor.getMaxHp()).toBe(100);
        expect(donor.getBaseArmor()).toBe(20);
    }
}

function state(unit: Unit) {
    return {
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        armor: unit.getBaseArmor(),
        alive: unit.getAmountAlive(),
        died: unit.getAmountDied(),
        caster: unit.getUnitProperties().helping_hand_caster_id,
        penalty: unit.getUnitProperties().helping_hand_penalty_id,
        buffs: [...unit.getUnitProperties().applied_buffs],
        debuffs: [...unit.getUnitProperties().applied_debuffs],
        charges: unit.getSpells().map((spell) => [spell.getName(), spell.getAmount()]),
    };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("Helping Hand linked transfer", () => {
    it("records both endpoints and transfers the caster's HP and armor through a real cast", () => {
        const h = fixture();
        cast(h, h.donor, h.target);
        expectLink(h.donor, h.target);
        expect([h.donor.getHp(), h.donor.getMaxHp(), h.donor.getBaseArmor()]).toEqual([70, 70, 14]);
        expect([h.target.getHp(), h.target.getMaxHp(), h.target.getBaseArmor()]).toEqual([80, 80, 16]);
    });

    for (const endpoint of ["donor", "target"] as const) {
        it(`ends both sides synchronously when the ${endpoint} dies before holder deletion`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            kill(h[endpoint]);
            expect(h.unitsHolder.getAllUnits().get(h[endpoint].getId())).toBe(h[endpoint]);
            expectReleased(h.donor, h.target);
        });

        it(`keeps the link when the ${endpoint} loses a body but survives`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            h[endpoint].applyDamage(h[endpoint].getMaxHp(), 0, sceneLog);
            expect(h[endpoint].getAmountAlive()).toBe(1);
            expect(h[endpoint].isDead()).toBe(false);
            expectLink(h.donor, h.target);
            expect(h.donor.getMaxHp()).toBe(70);
            expect(h.target.getMaxHp()).toBe(80);
        });

        it(`ends both sides when the living ${endpoint} is removed from the holder`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            expect(h.unitsHolder.deleteUnitById(h[endpoint].getId())).toBe(true);
            expectReleased(h.donor, h.target);
        });

        it(`does not recreate the transfer when the dead ${endpoint} is revived`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            kill(h[endpoint]);
            expect(h[endpoint].reviveAfterDeath(1)).toBe(1);
            h.unitsHolder.refreshStackPowerForAllUnits();
            expectReleased(h.donor, h.target);
        });
    }

    it("reverts the surviving recipient's cap before a subsequent hit resolves", () => {
        const h = fixture();
        cast(h, h.donor, h.target);
        kill(h.donor);
        expect(h.target.getHp()).toBe(50);
        h.target.applyDamage(51, 0, sceneLog);
        expect([h.target.getAmountAlive(), h.target.getHp(), h.target.getMaxHp()]).toEqual([1, 49, 50]);
    });

    it("reverts the surviving caster's penalty before a subsequent hit resolves", () => {
        const h = fixture();
        cast(h, h.donor, h.target);
        kill(h.target);
        expect(h.donor.getHp()).toBe(100);
        h.donor.applyDamage(71, 0, sceneLog);
        expect([h.donor.getAmountAlive(), h.donor.getHp(), h.donor.getMaxHp()]).toEqual([2, 29, 100]);
    });

    it("does not heal a wounded survivor when restoring its original cap", () => {
        const h = fixture();
        cast(h, h.donor, h.target);
        h.donor.applyDamage(25, 0, sceneLog);
        kill(h.target);
        expect([h.donor.getHp(), h.donor.getMaxHp()]).toEqual([45, 100]);
    });

    it("releases only the matching transfer among independent copies of the spell", () => {
        const h = fixture();
        const otherDonor = caster("Other caster");
        const otherTarget = recipient("Other recipient");
        placeUnit(h.grid, h.unitsHolder, otherDonor, { x: 6, y: 2 });
        placeUnit(h.grid, h.unitsHolder, otherTarget, { x: 7, y: 2 });
        cast(h, h.donor, h.target);
        cast(h, otherDonor, otherTarget);
        kill(h.target);
        expectReleased(h.donor, h.target);
        expectLink(otherDonor, otherTarget);
        expect([otherDonor.getMaxHp(), otherTarget.getMaxHp()]).toEqual([70, 80]);
    });

    it("shares one caster penalty across multiple recipients until the final link ends", () => {
        const h = fixture();
        const otherTarget = recipient("Second recipient");
        placeUnit(h.grid, h.unitsHolder, otherTarget, { x: 4, y: 2 });
        cast(h, h.donor, h.target);
        cast(h, h.donor, otherTarget);
        expectLink(h.donor, h.target);
        expectLink(h.donor, otherTarget);
        expect(h.donor.getUnitProperties().applied_debuffs.filter((name) => name === "Helping Hand")).toHaveLength(1);
        expect(h.donor.getMaxHp()).toBe(70);
        kill(h.target);
        expectLink(h.donor, otherTarget);
        expect(h.donor.getMaxHp()).toBe(70);
        kill(otherTarget);
        expectReleased(h.donor, otherTarget);
    });

    for (const endpoint of ["donor", "target"] as const) {
        it(`expires both sides when the ${endpoint}'s duration runs out`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            const laps = (
                endpoint === "donor" ? h.donor.getDebuff("Helping Hand") : h.target.getBuff("Helping Hand")
            )!.getLaps();
            for (let lap = 0; lap < laps - 1; lap++) {
                h[endpoint].minusLap();
                expectLink(h.donor, h.target);
            }
            h[endpoint].minusLap();
            expectReleased(h.donor, h.target);
        });
    }

    for (const removal of ["buff", "debuff", "all buffs", "all debuffs"] as const) {
        it(`removes both sides immediately when dispelling ${removal}`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            if (removal === "buff") h.target.deleteBuff("Helping Hand");
            else if (removal === "debuff") h.donor.deleteDebuff("Helping Hand");
            else if (removal === "all buffs") h.target.deleteAllBuffs();
            else h.donor.deleteAllDebuffs();
            expectReleased(h.donor, h.target);
        });
    }

    for (const endpoint of ["donor", "target", "absorber"] as const) {
        it(`preserves absorbed penalties and releases the link when the ${endpoint} dies`, () => {
            const h = fixture();
            const absorber = createTestUnit({ name: "Absorber", maxHp: 200, armor: 30, amountAlive: 2 });
            placeUnit(h.grid, h.unitsHolder, absorber, { x: 2, y: 3 });
            h.donor.applyAuraEffect("Absorb Penalties Aura", "absorb", true, 100, "2;3");
            cast(h, h.donor, h.target);
            expectLink(h.donor, h.target, absorber);
            expect(h.donor.hasDebuffActive("Helping Hand")).toBe(false);
            expect([h.donor.getMaxHp(), absorber.getMaxHp(), absorber.getBaseArmor()]).toEqual([100, 170, 24]);
            kill(endpoint === "absorber" ? absorber : h[endpoint]);
            expectReleased(h.donor, h.target, absorber);
            if (!absorber.isDead()) expect([absorber.getMaxHp(), absorber.getBaseArmor()]).toEqual([200, 30]);
        });
    }

    it("combines the gift and absorbed penalty when the recipient absorbs its caster's penalty", () => {
        const h = fixture();
        h.donor.applyAuraEffect("Absorb Penalties Aura", "absorb", true, 100, "3;2");
        cast(h, h.donor, h.target);
        expectLink(h.donor, h.target, h.target);
        expect([h.donor.getMaxHp(), h.target.getMaxHp(), h.target.getBaseArmor()]).toEqual([100, 50, 10]);
        kill(h.donor);
        expectReleased(h.donor, h.target, h.target);
    });

    it("keeps an incoming transfer while its recipient casts Helping Hand onward", () => {
        const h = fixture();
        const middle = caster("Middle");
        placeUnit(h.grid, h.unitsHolder, middle, { x: 4, y: 2 });
        cast(h, h.donor, middle);
        expect([middle.getMaxHp(), middle.getBaseArmor()]).toEqual([130, 26]);
        cast(h, middle, h.target);
        expectLink(h.donor, middle);
        expectLink(middle, h.target);
        expect([middle.getMaxHp(), middle.getBaseArmor()]).toEqual([91, 18]);
        expect([h.target.getMaxHp(), h.target.getBaseArmor()]).toEqual([89, 18]);
    });

    it("Borrowed Grace copies the original relation without duplicating the penalty or gift", () => {
        const h = fixture();
        const copier = createTestUnit({
            name: "Monk",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 50,
            armor: 10,
            amountAlive: 2,
            abilities: ["Borrowed Grace"],
        });
        placeUnit(h.grid, h.unitsHolder, copier, { x: 4, y: 2 });
        cast(h, h.donor, h.target);
        setDeterministicRandomSource(() => 0);
        for (let copy = 0; copy < 2; copy++) {
            expect(processBorrowedGraceAbility(copier, h.target, sceneLog, copier)).toEqual({
                thiefId: copier.getId(),
                targetId: h.target.getId(),
                buffName: "Helping Hand",
            });
            h.unitsHolder.refreshStackPowerForAllUnits();
            expectLink(h.donor, copier);
            expectLink(h.donor, h.target);
            expect([copier.getMaxHp(), copier.getBaseArmor()]).toEqual([80, 16]);
            expect(copier.getUnitProperties().applied_buffs.filter((name) => name === "Helping Hand")).toHaveLength(1);
            expect(h.donor.getUnitProperties().applied_debuffs.filter((name) => name === "Helping Hand")).toHaveLength(
                1,
            );
            expect(h.donor.getMaxHp()).toBe(70);
        }
        copier.deleteBuff("Helping Hand");
        expect(copier.getMaxHp()).toBe(50);
        expectLink(h.donor, h.target);
        expect(h.donor.getMaxHp()).toBe(70);
    });

    it("keeps a copied transfer when the original recipient dies and releases it when its caster dies", () => {
        const h = fixture();
        const copier = recipient("Copier");
        placeUnit(h.grid, h.unitsHolder, copier, { x: 4, y: 2 });
        cast(h, h.donor, h.target);
        expect(copier.takeBuffFrom(h.target, "Helping Hand")).toBe(true);
        h.unitsHolder.refreshStackPowerForAllUnits();
        kill(h.target);
        expectLink(h.donor, copier);
        expect(h.donor.getMaxHp()).toBe(70);
        kill(h.donor);
        expectReleased(h.donor, copier);
        expect(h.target.getUnitProperties().helping_hand_caster_id).toBeUndefined();
    });

    it("releases the replaced source penalty when a recipient copies another linked gift", () => {
        const h = fixture();
        const otherDonor = caster("Other caster");
        const otherTarget = recipient("Other recipient");
        placeUnit(h.grid, h.unitsHolder, otherDonor, { x: 6, y: 2 });
        placeUnit(h.grid, h.unitsHolder, otherTarget, { x: 7, y: 2 });
        cast(h, h.donor, h.target);
        cast(h, otherDonor, otherTarget);
        expect(h.target.takeBuffFrom(otherTarget, "Helping Hand")).toBe(true);
        h.unitsHolder.refreshStackPowerForAllUnits();
        expect(h.donor.hasDebuffActive("Helping Hand")).toBe(false);
        expect([h.donor.getMaxHp(), h.donor.getBaseArmor()]).toEqual([100, 20]);
        expectLink(otherDonor, h.target);
        expectLink(otherDonor, otherTarget);
        kill(h.donor);
        expectLink(otherDonor, h.target);
        h.target.deleteBuff("Helping Hand");
        expectLink(otherDonor, otherTarget);
        otherTarget.deleteBuff("Helping Hand");
        expectReleased(otherDonor, otherTarget);
    });

    it("allows a copied gift to return to its original caster without erasing the shared penalty", () => {
        const h = fixture();
        cast(h, h.donor, h.target);
        expect(h.donor.takeBuffFrom(h.target, "Helping Hand")).toBe(true);
        h.unitsHolder.refreshStackPowerForAllUnits();
        expectLink(h.donor, h.target);
        expectLink(h.donor, h.donor);
        expect([h.donor.getMaxHp(), h.donor.getBaseArmor()]).toEqual([100, 20]);
        h.donor.deleteBuff("Helping Hand");
        expectLink(h.donor, h.target);
        expect([h.donor.getMaxHp(), h.donor.getBaseArmor()]).toEqual([70, 14]);
        h.target.deleteBuff("Helping Hand");
        expectReleased(h.donor, h.target);
    });

    it("expires one copied recipient independently while the original link remains active", () => {
        const h = fixture();
        const copier = recipient("Copier");
        placeUnit(h.grid, h.unitsHolder, copier, { x: 4, y: 2 });
        cast(h, h.donor, h.target);
        expect(copier.takeBuffFrom(h.target, "Helping Hand")).toBe(true);
        h.unitsHolder.refreshStackPowerForAllUnits();
        const laps = copier.getBuff("Helping Hand")!.getLaps();
        for (let lap = 0; lap < laps; lap++) copier.minusLap();
        expect(copier.hasBuffActive("Helping Hand")).toBe(false);
        expect([copier.getMaxHp(), copier.getBaseArmor()]).toEqual([50, 10]);
        expectLink(h.donor, h.target);
        expect(h.donor.getMaxHp()).toBe(70);
    });

    for (const mode of ["snapshot", "journal"] as const) {
        it(`${mode} rollback restores links, stats, identity, and death cleanup callbacks`, () => {
            const h = fixture();
            cast(h, h.donor, h.target);
            const before = [state(h.donor), state(h.target)];
            const snapshot = snapshotBattle(h.unitsHolder, h.grid, h.fight);
            const checkpoint =
                mode === "journal" ? new BattleRollbackJournal(h.unitsHolder, h.grid, h.fight).checkpoint() : undefined;
            try {
                kill(h.donor);
                expectReleased(h.donor, h.target);
                h.unitsHolder.deleteUnitById(h.donor.getId());
            } finally {
                if (checkpoint) checkpoint.rollback();
                else restoreBattle(snapshot, h.unitsHolder, h.grid, h.fight);
            }
            expect(h.unitsHolder.getAllUnits().get(h.donor.getId())).toBe(h.donor);
            expect([state(h.donor), state(h.target)]).toEqual(before);
            expectLink(h.donor, h.target);
            kill(h.target);
            expectReleased(h.donor, h.target);
        });

        it(`${mode} rollback removes a newly cast link and restores the spell charge`, () => {
            const h = fixture();
            const before = [state(h.donor), state(h.target)];
            const snapshot = snapshotBattle(h.unitsHolder, h.grid, h.fight);
            const checkpoint =
                mode === "journal" ? new BattleRollbackJournal(h.unitsHolder, h.grid, h.fight).checkpoint() : undefined;
            try {
                cast(h, h.donor, h.target);
                expectLink(h.donor, h.target);
            } finally {
                if (checkpoint) checkpoint.rollback();
                else restoreBattle(snapshot, h.unitsHolder, h.grid, h.fight);
            }
            expect([state(h.donor), state(h.target)]).toEqual(before);
            cast(h, h.donor, h.target);
            kill(h.donor);
            expectReleased(h.donor, h.target);
        });
    }
});
