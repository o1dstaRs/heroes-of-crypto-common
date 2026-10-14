import { afterEach, expect, test } from "bun:test";

import { getGravechainTargets, processGravechainAbility } from "../../src/abilities/gravechain_ability";
import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { processSkewerStrikeAbility } from "../../src/abilities/skewer_strike_ability";
import {
    ArtifactTier,
    Tier2Artifact,
    ARTIFACT_POWER,
    ToTier2Artifact,
    TIER2_ARTIFACT_LIST,
    formatArtifactDescription,
    getArtifactProperties,
} from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { LIVE_TIER2_ARTIFACT_IDS } from "../../src/picks/pick_sim";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { beginEffectApplicationCapture, endEffectApplicationCapture } from "../../src/units/effect_application_capture";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    type TestUnitOptions,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));

function fixture(options: TestUnitOptions = {}, anchor: XY = { x: 3, y: 7 }) {
    const context = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Wielder",
        team: LEFT,
        amountAlive: 5,
        maxHp: 10000,
        rangeShots: 20,
        damageMin: 10,
        damageMax: 10,
        ...options,
    });
    placeUnit(context.grid, context.unitsHolder, attacker, anchor);
    const fight = FightStateManager.getInstance().getFightProperties();
    const add = (name: string, cell: XY, options: TestUnitOptions = {}) => {
        const unit = createTestUnit({ name, team: RIGHT, maxHp: 10000, amountAlive: 5, ...options });
        placeUnit(context.grid, context.unitsHolder, unit, cell);
        return unit;
    };
    const arm = () => {
        fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.GRAVECHAIN);
        context.unitsHolder.applyArtifacts(fight);
        context.unitsHolder.refreshStackPowerForAllUnits();
    };
    const proc = (target: Unit, active = attacker, attempted?: Set<string>) =>
        processGravechainAbility(
            attacker,
            target,
            context.grid,
            context.unitsHolder,
            new SceneLogMock(),
            active,
            attempted,
        );
    return { ...context, attacker, fight, add, arm, proc };
}

function rolls(values: number[]) {
    let draw = 0;
    setDeterministicRandomSource(() => {
        const index = Math.floor(draw++ / 2);
        return draw % 2 === 1 ? 0 : (values[index] ?? 99) / 0x100000000;
    });
    return () => draw / 2;
}

test("new Tier-2 wire id is draftable, and the slow belongs to Death", () => {
    expect(ToTier2Artifact["16"]).toBe(Tier2Artifact.GRAVECHAIN);
    expect(LIVE_TIER2_ARTIFACT_IDS).toContain(Tier2Artifact.GRAVECHAIN);
    expect(TIER2_ARTIFACT_LIST.find((artifact) => artifact.id === 16)?.imageKey).toBe("artifact_t2_gravechain_256");
    const description = formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.GRAVECHAIN));
    expect(description).toContain("50%");
    expect(description).toContain("25% for 3 laps");
    expect(description).not.toMatch(/\{\}|\[\]|<>/);
    expect(getSpellConfig("Death", "Gravebound").power).toBe(getSpellConfig("Death", "Quagmire").power);
});

test("all allied attack types get the marker once, and deselection removes it", () => {
    const f = fixture();
    const ranged = f.add("Ally", { x: 2, y: 2 }, { team: LEFT, attackType: PBTypes.AttackVals.RANGE });
    const magic = f.add("Mage", { x: 2, y: 3 }, { team: LEFT, attackType: PBTypes.AttackVals.MAGIC });
    const enemy = f.add("Enemy", { x: 8, y: 7 });
    f.arm();
    f.arm();
    for (const unit of [f.attacker, ranged, magic]) {
        expect(unit.getGravechainChance()).toBe(50);
        expect(unit.getUnitProperties().applied_buffs.filter((name) => name === "Gravechain")).toHaveLength(1);
    }
    expect(enemy.getGravechainChance()).toBe(0);
    f.fight.setArtifactPerTeam(LEFT, 2, 0);
    f.unitsHolder.applyArtifacts(f.fight);
    expect(f.attacker.getGravechainChance()).toBe(0);
});

test("the curse costs every ally one step, including flyers and magic-immune units, and clears on deselection", () => {
    const f = fixture();
    const ranged = f.add("Archer", { x: 2, y: 2 }, { team: LEFT, attackType: PBTypes.AttackVals.RANGE });
    const flyer = f.add("Flyer", { x: 2, y: 3 }, { team: LEFT, movementType: PBTypes.MovementVals.FLY });
    const immune = f.add("Enchanted", { x: 2, y: 4 }, { team: LEFT, abilities: ["Enchanted Skin"] });
    const enemy = f.add("Enemy", { x: 8, y: 7 });
    const allies = [f.attacker, ranged, flyer, immune];
    f.unitsHolder.refreshStackPowerForAllUnits();
    const steps = allies.map((unit) => unit.getSteps());
    const enemySteps = enemy.getSteps();
    f.arm();
    f.arm();
    for (const [index, unit] of allies.entries()) {
        expect(unit.getSteps()).toBe(steps[index] - ARTIFACT_POWER.GRAVECHAIN_STEPS_PENALTY);
        const props = unit.getUnitProperties();
        expect(props.applied_debuffs.filter((name) => name === "Gravechain")).toHaveLength(1);
        const curseIndex = props.applied_debuffs.indexOf("Gravechain");
        expect(props.applied_debuffs_descriptions[curseIndex]).toContain("−1 movement step");
        expect(unit.getDebuff("Gravechain")?.getPower()).toBe(0);
        expect(unit.getBuffProperties("Gravechain")[1]).toBe("3");
    }
    expect(enemy.getSteps()).toBe(enemySteps);
    expect(enemy.hasDebuffActive("Gravechain")).toBe(false);
    f.fight.setArtifactPerTeam(LEFT, 2, 0);
    f.unitsHolder.applyArtifacts(f.fight);
    f.unitsHolder.refreshStackPowerForAllUnits();
    for (const [index, unit] of allies.entries()) {
        expect(unit.getSteps()).toBe(steps[index]);
        expect(unit.getUnitProperties().applied_debuffs).not.toContain("Gravechain");
    }
});

test("roll and hover both use the attacker's actual current luck", () => {
    const f = fixture();
    const target = f.add("Target", { x: 8, y: 7 });
    f.arm();
    const props = f.attacker.getUnitProperties();
    props.luck_authoritative = true;
    for (const luck of [-10, 0, 7, 10]) {
        props.luck = luck;
        props.luck_mod = 0;
        f.unitsHolder.refreshStackPowerForAllUnits();
        expect(f.attacker.getGravechainChance()).toBe(50 + luck);
        const description = props.applied_buffs_descriptions[props.applied_buffs.indexOf("Gravechain")];
        expect(description).toContain(`${50 + luck}%`);
        expect(description).not.toContain("luck");
    }
    props.luck = 7;
    rolls([57]);
    f.proc(target);
    expect(target.hasDebuffActive("Gravebound")).toBe(false);
    rolls([56]);
    f.proc(target);
    expect(target.hasDebuffActive("Gravebound")).toBe(true);
});

test("independent failures at the first and middle targets never stop the chain; range is three links", () => {
    const f = fixture();
    const targets = Array.from({ length: 5 }, (_, i) => f.add(`Target${i}`, { x: 7 + i, y: 7 }));
    f.arm();
    const count = rolls([99, 0, 99, 0]);
    f.proc(targets[0]);
    expect(targets.map((unit) => unit.hasDebuffActive("Gravebound"))).toEqual([false, true, false, true, false]);
    expect(count()).toBe(4);
});

test("branching and cycles roll once per unit, including units with multiple cells", () => {
    const f = fixture();
    const target = f.add("Root", { x: 7, y: 7 }, { footprintWidth: 2, footprintHeight: 2 });
    const a = f.add("A", { x: 8, y: 7 });
    const b = f.add("B", { x: 8, y: 8 });
    const c = f.add("C", { x: 7, y: 8 });
    f.arm();
    expect(getGravechainTargets(target, f.grid, f.unitsHolder)).toHaveLength(4);
    const count = rolls([0, 0, 0, 0]);
    f.proc(target);
    expect(count()).toBe(4);
    for (const unit of [target, a, b, c]) expect(unit.getUnitProperties().applied_debuffs).toEqual(["Gravebound"]);
});

for (const [width, height] of [
    [1, 2],
    [2, 1],
]) {
    for (let x = -width; x <= 1; x++) {
        for (let y = -height; y <= 1; y++) {
            if (x > -width && x < 1 && y > -height && y < 1) continue;
            test(`${width}x${height} footprint connects at perimeter offset ${x},${y}`, () => {
                const f = fixture({}, { x: 1, y: 1 });
                const root = f.add("Rectangle", { x: 7, y: 7 }, { footprintWidth: width, footprintHeight: height });
                const neighbor = f.add("Neighbor", { x: 7 + x, y: 7 + y });
                f.arm();
                const count = rolls([0, 0]);
                f.proc(root);
                expect(neighbor.hasDebuffActive("Gravebound")).toBe(true);
                expect(count()).toBe(2);
            });
        }
    }
}

test("allies and empty gaps cannot relay; a rectangular enemy relays from its opposite end", () => {
    const f = fixture({}, { x: 1, y: 1 });
    const root = f.add("Root", { x: 5, y: 7 });
    const bridge = f.add("Bridge", { x: 7, y: 7 }, { footprintWidth: 2, footprintHeight: 1 });
    const end = f.add("End", { x: 8, y: 7 });
    const ally = f.add("Ally", { x: 5, y: 8 }, { team: LEFT });
    const behindAlly = f.add("Behind ally", { x: 5, y: 9 });
    const gap = f.add("Beyond gap", { x: 3, y: 7 });
    f.arm();
    setDeterministicRandomSource(() => 0);
    f.proc(root);
    for (const unit of [root, bridge, end]) expect(unit.hasDebuffActive("Gravebound")).toBe(true);
    for (const unit of [ally, behindAlly, gap]) expect(unit.hasDebuffActive("Gravebound")).toBe(false);
});

test("full magic immunity, Wind Element and an existing slow do not interrupt propagation", () => {
    const f = fixture();
    const root = f.add("Enchanted", { x: 7, y: 7 }, { abilities: ["Enchanted Skin"] });
    const wind = f.add("Wind", { x: 8, y: 7 }, { abilities: ["Wind Element"], magicResist: 90 });
    const already = f.add("Already", { x: 9, y: 7 });
    const end = f.add("End", { x: 10, y: 7 }, { magicResist: 90 });
    already.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
    f.arm();
    setDeterministicRandomSource(() => 0);
    f.proc(root);
    expect(root.hasDebuffActive("Gravebound")).toBe(false);
    expect(wind.hasDebuffActive("Gravebound")).toBe(true);
    expect(already.getDebuff("Gravebound")?.getLaps()).toBe(1);
    expect(end.hasDebuffActive("Gravebound")).toBe(true);
});

test("a killed primary still starts the chain from its footprint", () => {
    const f = fixture();
    const root = f.add("Dead", { x: 7, y: 7 });
    const neighbor = f.add("Neighbor", { x: 8, y: 7 });
    f.arm();
    root.applyDamage(root.getCumulativeHp(), 0, new SceneLogMock());
    setDeterministicRandomSource(() => 0);
    f.proc(root);
    expect(root.isDead()).toBe(true);
    expect(root.hasDebuffActive("Gravebound")).toBe(false);
    expect(neighbor.hasDebuffActive("Gravebound")).toBe(true);
});

test("Quagmire's movement and duration are preserved, with independent stacking and active-turn extension", () => {
    const f = fixture();
    const target = f.add("Target", { x: 7, y: 7 });
    f.arm();
    const steps = target.getSteps();
    setDeterministicRandomSource(() => 0);
    f.proc(target);
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(target.getSteps()).toBeCloseTo(Math.round(steps * 0.75 * 10) / 10, 6);
    expect(target.getDebuff("Gravebound")?.getLaps()).toBe(3);
    target.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Quagmire"), amount: 1 }));
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(target.getSteps()).toBeCloseTo(Math.round(steps * 0.75 * 0.75 * 10) / 10, 6);
    target.deleteDebuff("Gravebound");
    f.proc(target, target);
    expect(target.getDebuff("Gravebound")?.getLaps()).toBe(4);
    target.minusLap();
    expect(target.getDebuff("Gravebound")?.getLaps()).toBe(3);
});

for (const ability of ["Area Throw", "Large Caliber", "Chakram", "Through Shot", "Lightning Spin", "Skewer Strike"]) {
    test(`${ability} applies Gravebound to connected units outside its direct damage`, () => {
        const f = fixture({ attackType: PBTypes.AttackVals.RANGE, abilities: [ability], stackPower: 100 });
        const root = f.add("Root", { x: 4, y: 7 });
        const adjacent = f.add("Next", { x: 5, y: 7 });
        const distant = f.add("Last", { x: 6, y: 7 });
        f.arm();
        setDeterministicRandomSource(() => 0);
        const log = new SceneLogMock();
        if (ability === "Through Shot") {
            processThroughShotAbility(
                f.attacker,
                [[root]],
                f.attacker,
                [1],
                root.getPosition(),
                f.unitsHolder,
                f.grid,
                log,
                f.damageStatisticHolder,
            );
        } else if (ability === "Lightning Spin") {
            processLightningSpinAbility(
                f.attacker,
                log,
                f.unitsHolder,
                1,
                f.damageStatisticHolder,
                f.attacker.getBaseCell(),
                true,
                undefined,
                f.grid,
            );
        } else if (ability === "Skewer Strike") {
            processSkewerStrikeAbility(f.attacker, root, log, f.unitsHolder, f.grid, f.damageStatisticHolder);
        } else {
            processRangeAOEAbility(
                f.attacker,
                [root, adjacent],
                f.attacker,
                1,
                f.unitsHolder,
                f.grid,
                log,
                f.damageStatisticHolder,
            );
        }
        expect(distant.hasDebuffActive("Gravebound")).toBe(true);
        expect(distant.getCumulativeHp()).toBe(distant.getCumulativeMaxHp());
    });
}

test("overlapping splash connections attempt each enemy once per volley", () => {
    const f = fixture({ attackType: PBTypes.AttackVals.RANGE, abilities: ["Area Throw"] });
    const root = f.add("Root", { x: 7, y: 7 });
    const next = f.add("Next", { x: 8, y: 7 });
    f.arm();
    const attempted = new Set<string>();
    const count = rolls([99, 99]);
    f.proc(root, f.attacker, attempted);
    f.proc(next, f.attacker, attempted);
    expect(count()).toBe(2);
    expect(root.hasDebuffActive("Gravebound")).toBe(false);
    expect(next.hasDebuffActive("Gravebound")).toBe(false);
});

test("melee retaliation extends the active target's duration and records connected debuffs", () => {
    const f = fixture({}, { x: 3, y: 7 });
    const target = f.add("Responder", { x: 4, y: 7 });
    const neighbor = f.add("Ally", { x: 2, y: 7 }, { team: LEFT });
    f.fight.setArtifactPerTeam(RIGHT, 2, Tier2Artifact.GRAVECHAIN);
    f.unitsHolder.applyArtifacts(f.fight);
    f.unitsHolder.refreshStackPowerForAllUnits();
    setDeterministicRandomSource(() => 0);
    beginEffectApplicationCapture();
    f.attackHandler.handleMeleeAttack(
        f.unitsHolder,
        new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        createVisibleDamage(target),
        undefined,
        f.attacker,
        target,
        f.attacker.getBaseCell()!,
    );
    const effects = endEffectApplicationCapture();
    expect(f.attacker.getDebuff("Gravebound")?.getLaps()).toBe(4);
    expect(neighbor.getDebuff("Gravebound")?.getLaps()).toBe(3);
    expect(effects.filter((effect) => effect.name === "Gravebound")).toHaveLength(2);
});

test("ranked/replay events and serialized unit state include connected targets", () => {
    const f = fixture({ attackType: PBTypes.AttackVals.RANGE });
    const root = f.add("Root", { x: 8, y: 7 });
    const next = f.add("Next", { x: 9, y: 7 });
    f.arm();
    f.fight.startFight();
    const engine = new GameActionEngine({
        fightProperties: f.fight,
        grid: f.grid,
        unitsHolder: f.unitsHolder,
        attackHandler: f.attackHandler,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => f.attacker.getId(),
    });
    setDeterministicRandomSource(() => 0);
    const result = engine.apply({ type: "range_attack", attackerId: f.attacker.getId(), targetId: root.getId() });
    expect(result.completed).toBe(true);
    const effects = result.events
        .filter((event) => event.type === "effects_applied")
        .flatMap((event) => (event.type === "effects_applied" ? event.applications : []));
    expect(
        effects
            .filter((effect) => effect.name === "Gravebound")
            .map((effect) => effect.unitId)
            .sort(),
    ).toEqual([root.getId(), next.getId()].sort());
    expect(next.getUnitProperties().applied_debuffs).toContain("Gravebound");
    expect(next.getUnitProperties().applied_debuffs_powers).toContain(25);
});

for (const melee of [false, true]) {
    for (const defense of ["Dodge", "Water Shield"]) {
        test(`${melee ? "melee" : "ranged"} ${defense} prevents the whole chain from starting`, () => {
            const f = fixture({ attackType: melee ? PBTypes.AttackVals.MELEE : PBTypes.AttackVals.RANGE });
            const target = f.add("Protected", { x: melee ? 4 : 8, y: 7 }, { abilities: [defense] });
            const neighbor = f.add("Neighbor", { x: melee ? 5 : 9, y: 7 });
            f.arm();
            if (defense === "Water Shield") target.trySeedWaterShield();
            setDeterministicRandomSource(() => 0);
            const damage = createVisibleDamage(target);
            const result = melee
                ? f.attackHandler.handleMeleeAttack(
                      f.unitsHolder,
                      new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
                      damage,
                      undefined,
                      f.attacker,
                      target,
                      f.attacker.getBaseCell(),
                  )
                : f.attackHandler.handleRangeAttack(
                      f.unitsHolder,
                      [1],
                      1,
                      damage,
                      f.attacker,
                      [[target]],
                      undefined,
                      target.getPosition(),
                  );
            expect(result.completed).toBe(true);
            expect(target.hasDebuffActive("Gravebound")).toBe(false);
            expect(neighbor.hasDebuffActive("Gravebound")).toBe(false);
        });
    }
}

for (const melee of [false, true]) {
    test(`${melee ? "melee" : "ranged"} killing strike still chains to a living neighbor`, () => {
        const f = fixture({ attackType: melee ? PBTypes.AttackVals.MELEE : PBTypes.AttackVals.RANGE });
        const target = f.add("Fragile", { x: melee ? 4 : 8, y: 7 }, { amountAlive: 1, maxHp: 1 });
        const neighbor = f.add("Neighbor", { x: melee ? 5 : 9, y: 7 });
        f.arm();
        setDeterministicRandomSource(() => 0);
        const damage = createVisibleDamage(target);
        const result = melee
            ? f.attackHandler.handleMeleeAttack(
                  f.unitsHolder,
                  new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
                  damage,
                  undefined,
                  f.attacker,
                  target,
                  f.attacker.getBaseCell(),
              )
            : f.attackHandler.handleRangeAttack(
                  f.unitsHolder,
                  [1],
                  1,
                  damage,
                  f.attacker,
                  [[target]],
                  undefined,
                  target.getPosition(),
              );
        expect(result.completed).toBe(true);
        expect(target.isDead()).toBe(true);
        expect(neighbor.hasDebuffActive("Gravebound")).toBe(true);
    });
}

for (const pierce of [false, true]) {
    test(`${pierce ? "piercing" : "area"} volley adds exactly one roll per connected enemy`, () => {
        const run = (armed: boolean) => {
            const f = fixture({
                attackType: PBTypes.AttackVals.RANGE,
                abilities: [pierce ? "Through Shot" : "Area Throw"],
            });
            const root = f.add("Root", { x: 8, y: 7 });
            const next = f.add("Next", { x: 9, y: 7 });
            const last = f.add("Last", { x: 10, y: 7 });
            if (armed) f.arm();
            const count = rolls(Array(100).fill(99));
            if (pierce) {
                processThroughShotAbility(
                    f.attacker,
                    [[root], [next]],
                    f.attacker,
                    [1, 1],
                    next.getPosition(),
                    f.unitsHolder,
                    f.grid,
                    new SceneLogMock(),
                    f.damageStatisticHolder,
                );
            } else {
                processRangeAOEAbility(
                    f.attacker,
                    [root, next],
                    f.attacker,
                    1,
                    f.unitsHolder,
                    f.grid,
                    new SceneLogMock(),
                    f.damageStatisticHolder,
                );
            }
            expect(last.hasDebuffActive("Gravebound")).toBe(false);
            return count();
        };
        const ordinary = run(false);
        expect(run(true) - ordinary).toBe(3);
    });
}
