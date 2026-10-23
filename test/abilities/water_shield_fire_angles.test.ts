/*
 * Water Shield through the real attack handler and the spell engine, not only the ability functions.
 *
 * Fire passes and leaves the shield up: Fire Breath (native or stolen, friend or foe behind the blow),
 * Fire Shield (including the reflection of a hit the shield is about to swallow), a Fireforged burn on
 * every delivery, and the fire spells. The steel under a Fireforged Sword, Chain Lightning, Lightning
 * Strike, Meteorite, Armageddon, Last Fuse and the first Fire Wall burn still spend it. Break turns the
 * absorb off without consuming the buff.
 */
import { afterEach, describe, expect, it } from "bun:test";

import { processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processFireShieldAbility } from "../../src/abilities/fire_shield_ability";
import { processFireforgedSwordAbility } from "../../src/abilities/fireforged_sword_ability";
import { explodeLastFuse } from "../../src/abilities/last_fuse_ability";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { burnUnitOnFireWallCells } from "../../src/engine/post_move_actor_availability";
import { GameActionEngine } from "../../src/engine/action_engine";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { FireWalls, fireWallBurnDamage } from "../../src/spells/fire_walls";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

const pinRng = (): void => setDeterministicRandomSource(() => 0);

const lost = (unit: Unit, before: number): number => before - unit.getCumulativeHp();

const ofSource = (secondary: ISecondaryDamage[] | undefined, source: string): ISecondaryDamage[] =>
    (secondary ?? []).filter((entry) => entry.source === source);

const giveSword = (unit: Unit): void => {
    unit.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Fireforged Sword"), amount: 1 }));
};

const giveMirror = (unit: Unit): void => {
    const mirror = new Spell({ spellProperties: getSpellConfig("Chaos", "Magic Mirror"), amount: 1 });
    mirror.setPower(100);
    unit.applyBuff(mirror);
};

const shield = (
    name: string,
    team: typeof LEFT | typeof RIGHT,
    abilities: string[] = ["Water Shield"],
    extra: Parameters<typeof createTestUnit>[0] = {},
): Unit => {
    const unit = createTestUnit({
        name,
        team,
        abilities,
        amountAlive: 1,
        maxHp: 5000,
        armor: 0,
        magicResist: 0,
        luck: 0,
        damageMin: 0,
        damageMax: 0,
        ...extra,
    });
    unit.trySeedWaterShield();
    expect(unit.hasBuffActive("Water Shield")).toBe(true);
    return unit;
};

const swing = (
    context: CombatTestContext,
    attacker: Unit,
    target: Unit,
    from: XY,
): { completed: boolean; secondary: ISecondaryDamage[] | undefined } => {
    const moveHandler = new MoveHandler(testGridSettings, context.grid, context.unitsHolder);
    const damage = createVisibleDamage(target);
    const result = context.attackHandler.handleMeleeAttack(
        context.unitsHolder,
        moveHandler,
        damage,
        undefined,
        attacker,
        target,
        from,
    );
    return { completed: result.completed, secondary: damage.secondary };
};

const shot = (
    context: CombatTestContext,
    attacker: Unit,
    targets: Unit[],
    response?: Unit[],
    area = false,
    // Through Shot reports one group per body. A splash is one group that holds every body.
    line = false,
): { completed: boolean; secondary: ISecondaryDamage[] | undefined } => {
    attacker.refreshPossibleAttackTypes(true);
    const groups = line ? targets.map((unit) => [unit]) : [targets];
    const damage = createVisibleDamage(targets[0]);
    const result = context.attackHandler.handleRangeAttack(
        context.unitsHolder,
        groups.map(() => 1),
        1,
        damage,
        attacker,
        groups,
        response,
        targets[0].getPosition(),
        area,
    );
    return { completed: result.completed, secondary: damage.secondary };
};

/** What the shielded unit lost is exactly the fire, and the shield did not break. */
const expectFirePassed = (unit: Unit, before: number, burn: number): void => {
    expect(burn).toBeGreaterThan(0);
    expect(lost(unit, before)).toBe(burn);
    expect(unit.hasBuffActive("Water Shield")).toBe(true);
};

/** The weapon hit broke the shield. The only health lost is the fire priced from that hit. */
const expectSteelBrokeAndBurned = (unit: Unit, before: number, burns: readonly ISecondaryDamage[]): void => {
    const mine = burns.filter((entry) => entry.unitId === unit.getId());
    expect(mine).toHaveLength(1);
    expect(mine[0].amount).toBeGreaterThan(0);
    expect(lost(unit, before)).toBe(mine[0].amount);
    expect(unit.hasBuffActive("Water Shield")).toBe(false);
    expect(unit.getEffects().map((effect) => effect.getName())).not.toContain("Stun");
};

describe("Water Shield from every delivery", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    const breathLine = (attackerAbilities: string[], behindAbilities: string[], behindTeam = RIGHT) => {
        pinRng();
        const context = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Breather",
            team: LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            abilities: attackerAbilities,
            amountAlive: 1,
            maxHp: 500,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
        });
        const primary = shield("Primary", RIGHT);
        const behind = shield("Behind", behindTeam, behindAbilities, { magicResist: 0 });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 5 });
        placeUnit(context.grid, context.unitsHolder, primary, { x: 4, y: 5 });
        placeUnit(context.grid, context.unitsHolder, behind, { x: 5, y: 5 });
        const primaryBefore = primary.getCumulativeHp();
        const behindBefore = behind.getCumulativeHp();
        const hit = swing(context, attacker, primary, { x: 3, y: 5 });
        return { context, attacker, primary, behind, primaryBefore, behindBefore, hit };
    };

    it("lets a native dragon's breath and its own melee through, then a plain hit still spends the shield", () => {
        const { context, primary, behind, primaryBefore, behindBefore, hit } = breathLine(
            ["Fire Element", "Fire Breath"],
            ["Water Shield", "Water Element"],
        );
        expect(hit.completed).toBe(true);
        const breathed = ofSource(hit.secondary, "fire_breath").find((entry) => entry.unitId === behind.getId());
        expectFirePassed(behind, behindBefore, breathed?.amount ?? 0);
        // The dragon is fire, so the swing on the unit in front is not absorbed either.
        expect(lost(primary, primaryBefore)).toBeGreaterThan(0);
        expect(primary.hasBuffActive("Water Shield")).toBe(true);

        const soldier = createTestUnit({
            name: "Soldier",
            team: LEFT,
            damageMin: 15,
            damageMax: 15,
            armor: 0,
            luck: 0,
            maxHp: 200,
        });
        placeUnit(context.grid, context.unitsHolder, soldier, { x: 4, y: 4 });
        const afterBreath = primary.getCumulativeHp();
        const followUp = swing(context, soldier, primary, { x: 4, y: 4 });
        expect(followUp.completed).toBe(true);
        expect(primary.getCumulativeHp()).toBe(afterBreath);
        expect(primary.hasBuffActive("Water Shield")).toBe(false);
    });

    it("breathes through the unit behind a stolen breath, foe or friend, and the steel still spends the front shield", () => {
        const foe = breathLine(["Fire Breath"], ["Water Shield"]);
        expect(foe.hit.completed).toBe(true);
        const foeBreath = ofSource(foe.hit.secondary, "fire_breath").find(
            (entry) => entry.unitId === foe.behind.getId(),
        );
        expectFirePassed(foe.behind, foe.behindBefore, foeBreath?.amount ?? 0);
        expect(foe.primary.getCumulativeHp()).toBe(foe.primaryBefore);
        expect(foe.primary.hasBuffActive("Water Shield")).toBe(false);

        const friend = breathLine(["Fire Breath"], ["Water Shield"], LEFT);
        const friendBreath = ofSource(friend.hit.secondary, "fire_breath").find(
            (entry) => entry.unitId === friend.behind.getId(),
        );
        expectFirePassed(friend.behind, friend.behindBefore, friendBreath?.amount ?? 0);
    });

    it("still prices magic resist and the Water Element bonus, and neither spends the shield", () => {
        const measure = (behindAbilities: string[], magicResist = 0): number => {
            pinRng();
            const context = createCombatTestContext();
            const dragon = createTestUnit({
                name: "Black Dragon",
                team: LEFT,
                abilities: ["Fire Element", "Fire Breath"],
                attack: 20,
                damageMin: 20,
                damageMax: 20,
                stackPower: 5,
                luck: 0,
                armor: 0,
                maxHp: 500,
            });
            const primary = createTestUnit({
                name: "Primary",
                team: RIGHT,
                damageMin: 0,
                damageMax: 0,
                armor: 0,
                luck: 0,
                maxHp: 500,
            });
            const behind = shield("Behind", RIGHT, behindAbilities, { magicResist });
            placeUnit(context.grid, context.unitsHolder, dragon, { x: 3, y: 5 });
            placeUnit(context.grid, context.unitsHolder, primary, { x: 4, y: 5 });
            placeUnit(context.grid, context.unitsHolder, behind, { x: 5, y: 5 });
            const before = behind.getCumulativeHp();
            const hit = swing(context, dragon, primary, { x: 3, y: 5 });
            expect(hit.completed).toBe(true);
            expect(behind.hasBuffActive("Water Shield")).toBe(true);
            return lost(behind, before);
        };

        const plain = measure(["Water Shield"]);
        const water = measure(["Water Shield", "Water Element"]);
        const resisted = measure(["Water Shield"], 50);
        // A stolen breath has no Fire Element, so the water creature is not seared any harder.
        const thief = (abilities: string[]): number => {
            const line = breathLine(["Fire Breath"], abilities);
            return lost(line.behind, line.behindBefore);
        };
        expect(plain).toBeGreaterThan(0);
        expect(water).toBeGreaterThan(plain);
        expect(resisted).toBeGreaterThan(0);
        expect(resisted).toBeLessThan(plain);
        expect(thief(["Water Shield", "Water Element"])).toBe(thief(["Water Shield"]));
    });

    it("breathes back through a retaliation and leaves that shield up", () => {
        pinRng();
        const context = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Attacker",
            team: LEFT,
            damageMin: 0,
            damageMax: 0,
            armor: 0,
            luck: 0,
            maxHp: 500,
        });
        const defender = createTestUnit({
            name: "Breath Thief",
            team: RIGHT,
            abilities: ["Fire Breath"],
            damageMin: 0,
            damageMax: 0,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 500,
        });
        const behind = shield("Behind", LEFT);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 5 });
        placeUnit(context.grid, context.unitsHolder, defender, { x: 4, y: 5 });
        placeUnit(context.grid, context.unitsHolder, behind, { x: 2, y: 5 });
        const before = behind.getCumulativeHp();
        const hit = swing(context, attacker, defender, { x: 3, y: 5 });
        const breathed = ofSource(hit.secondary, "fire_breath").find((entry) => entry.unitId === behind.getId());
        expect(hit.completed).toBe(true);
        expectFirePassed(behind, before, breathed?.amount ?? 0);
    });

    it("reflects Fire Shield off the blow the shield is about to swallow, from a thief and from an Efreet", () => {
        const reflect = (defenderAbilities: string[]) => {
            pinRng();
            const context = createCombatTestContext();
            const striker = shield("Striker", LEFT, ["Water Shield"], {
                damageMin: 20,
                damageMax: 20,
                attack: 20,
                maxHp: 5000,
            });
            const defender = shield("Defender", RIGHT, [...defenderAbilities, "No Melee"], {
                stackPower: 5,
                maxHp: 5000,
            });
            placeUnit(context.grid, context.unitsHolder, striker, { x: 4, y: 3 });
            placeUnit(context.grid, context.unitsHolder, defender, { x: 5, y: 3 });
            const strikerBefore = striker.getCumulativeHp();
            const defenderBefore = defender.getCumulativeHp();
            const hit = swing(context, striker, defender, { x: 4, y: 3 });
            return { striker, defender, strikerBefore, defenderBefore, hit };
        };

        const thief = reflect(["Fire Shield", "Water Shield"]);
        const thiefBurn = ofSource(thief.hit.secondary, "fire_shield");
        expect(thief.hit.completed).toBe(true);
        expect(thiefBurn).toHaveLength(1);
        expectFirePassed(thief.striker, thief.strikerBefore, thiefBurn[0].amount);
        // The steel was absorbed. The reflection was priced from the swing anyway.
        expect(thief.defender.getCumulativeHp()).toBe(thief.defenderBefore);
        expect(thief.defender.hasBuffActive("Water Shield")).toBe(false);

        pinRng();
        const efreetFight = createCombatTestContext();
        const striker = shield("Striker", LEFT, ["Water Shield"], {
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            maxHp: 5000,
        });
        const efreet = createTestUnit({
            name: "Efreet",
            team: RIGHT,
            abilities: ["Fire Element", "Fire Shield", "No Melee"],
            stackPower: 5,
            armor: 0,
            luck: 0,
            damageMin: 0,
            damageMax: 0,
            maxHp: 5000,
        });
        placeUnit(efreetFight.grid, efreetFight.unitsHolder, striker, { x: 4, y: 3 });
        placeUnit(efreetFight.grid, efreetFight.unitsHolder, efreet, { x: 5, y: 3 });
        const strikerBefore = striker.getCumulativeHp();
        const efreetHit = swing(efreetFight, striker, efreet, { x: 4, y: 3 });
        const efreetBurn = ofSource(efreetHit.secondary, "fire_shield");
        expect(efreetHit.completed).toBe(true);
        expect(efreetBurn).toHaveLength(1);
        expectFirePassed(striker, strikerBefore, efreetBurn[0].amount);
    });

    it("does not reflect an absorbed retaliation, and a landed one still passes the striker's shield", () => {
        pinRng();
        const absorbed = createCombatTestContext();
        const covered = shield("Covered", LEFT, ["Water Shield", "Fire Shield"], { stackPower: 5 });
        const striker = createTestUnit({
            name: "Striker",
            team: RIGHT,
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            armor: 0,
            luck: 0,
            maxHp: 500,
        });
        placeUnit(absorbed.grid, absorbed.unitsHolder, covered, { x: 4, y: 3 });
        placeUnit(absorbed.grid, absorbed.unitsHolder, striker, { x: 5, y: 3 });
        const coveredBefore = covered.getCumulativeHp();
        const strikerBefore = striker.getCumulativeHp();
        const absorbedHit = swing(absorbed, covered, striker, { x: 4, y: 3 });
        expect(absorbedHit.completed).toBe(true);
        expect(ofSource(absorbedHit.secondary, "fire_shield")).toHaveLength(0);
        expect(covered.getCumulativeHp()).toBe(coveredBefore);
        expect(covered.hasBuffActive("Water Shield")).toBe(false);
        // The opening swing lands. The counter was absorbed, so none of it comes back as fire.
        expect(striker.getCumulativeHp()).toBeLessThan(strikerBefore);

        // The counter is resolved before the opening steel. A landed opener would spend Answering's
        // shield on the way out, after the fire had already passed. A miss leaves that shield up.
        const landed = createCombatTestContext();
        const reflector = createTestUnit({
            name: "Reflector",
            team: LEFT,
            abilities: ["Fire Shield"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 5000,
        });
        reflector.calculateMissChance = () => 100;
        const answering = shield("Answering", RIGHT, ["Water Shield"], {
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
        });
        placeUnit(landed.grid, landed.unitsHolder, reflector, { x: 4, y: 3 });
        placeUnit(landed.grid, landed.unitsHolder, answering, { x: 5, y: 3 });
        const answeringBefore = answering.getCumulativeHp();
        const reflectorBefore = reflector.getCumulativeHp();
        const landedHit = swing(landed, reflector, answering, { x: 4, y: 3 });
        const burn = ofSource(landedHit.secondary, "fire_shield");
        expect(landedHit.completed).toBe(true);
        expect(burn).toHaveLength(1);
        expect(burn[0].unitId).toBe(answering.getId());
        expectFirePassed(answering, answeringBefore, burn[0].amount);
        // The counter was steel, and the reflector has no shield, so it landed.
        expect(reflector.getCumulativeHp()).toBeLessThan(reflectorBefore);
    });

    it("burns a second punch the shield swallowed, and reflects that punch off the pre-absorb swing", () => {
        pinRng();
        const context = createCombatTestContext();
        let missCalls = 0;
        const puncher = createTestUnit({
            name: "Puncher",
            team: LEFT,
            abilities: ["Double Punch", "Stun", "Water Shield"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 5000,
        });
        puncher.trySeedWaterShield();
        puncher.calculateMissChance = () => (missCalls++ === 0 ? 100 : 0);
        giveSword(puncher);
        const target = shield("Target", RIGHT, ["Water Shield", "Fire Shield", "No Melee"], { stackPower: 5 });
        placeUnit(context.grid, context.unitsHolder, puncher, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 5, y: 3 });
        const puncherBefore = puncher.getCumulativeHp();
        const targetBefore = target.getCumulativeHp();
        const hit = swing(context, puncher, target, { x: 4, y: 3 });
        expect(hit.completed).toBe(true);
        expectSteelBrokeAndBurned(target, targetBefore, ofSource(hit.secondary, "fireforged_sword"));
        const reflection = ofSource(hit.secondary, "fire_shield");
        expectFirePassed(puncher, puncherBefore, reflection[0]?.amount ?? 0);
    });

    it("sets a shielded shooter alight from a counter-shot, and not from the arrow", () => {
        pinRng();
        const context = createCombatTestContext();
        const shooter = shield("Shooter", LEFT, ["Water Shield"], {
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 4,
            shotDistance: 16,
            damageMin: 10,
            damageMax: 10,
            attack: 10,
        });
        const responder = createTestUnit({
            name: "Responder",
            team: RIGHT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Stun"],
            rangeShots: 4,
            shotDistance: 16,
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 5000,
        });
        giveSword(responder);
        placeUnit(context.grid, context.unitsHolder, shooter, { x: 2, y: 2 });
        placeUnit(context.grid, context.unitsHolder, responder, { x: 2, y: 12 });
        const before = shooter.getCumulativeHp();
        const hit = shot(context, shooter, [responder], [shooter]);
        expect(hit.completed).toBe(true);
        expectSteelBrokeAndBurned(shooter, before, ofSource(hit.secondary, "fireforged_sword"));
    });

    it("burns a shielded target from a ranged shot, a second shot, and leaves the other riders off", () => {
        pinRng();
        const context = createCombatTestContext();
        let missCalls = 0;
        const shooter = createTestUnit({
            name: "Shooter",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Double Shot", "Stun"],
            rangeShots: 6,
            shotDistance: 16,
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 400,
        });
        shooter.calculateMissChance = () => (missCalls++ === 0 ? 100 : 0);
        giveSword(shooter);
        const target = shield("Target", RIGHT);
        placeUnit(context.grid, context.unitsHolder, shooter, { x: 2, y: 2 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 2, y: 12 });
        const before = target.getCumulativeHp();
        const hit = shot(context, shooter, [target]);
        expect(hit.completed).toBe(true);
        expectSteelBrokeAndBurned(target, before, ofSource(hit.secondary, "fireforged_sword"));
    });

    const shieldedPair = (names: string[], team = RIGHT): { context: CombatTestContext; units: Unit[] } => {
        const context = createCombatTestContext();
        const units = names.map((name) => shield(name, team));
        return { context, units };
    };

    it("burns every shielded creature an Area Throw, a Through Shot, a Skewer, a spin or a Chakram caught", () => {
        pinRng();
        const area = shieldedPair(["First", "Second"]);
        const gargantuan = createTestUnit({
            name: "Gargantuan",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Area Throw", "Stun"],
            damageMin: 30,
            damageMax: 30,
            rangeShots: 4,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 300,
        });
        giveSword(gargantuan);
        placeUnit(area.context.grid, area.context.unitsHolder, gargantuan, { x: 2, y: 2 });
        placeUnit(area.context.grid, area.context.unitsHolder, area.units[0], { x: 8, y: 2 });
        placeUnit(area.context.grid, area.context.unitsHolder, area.units[1], { x: 8, y: 3 });
        const areaBefore = area.units.map((unit) => unit.getCumulativeHp());
        const areaHit = shot(area.context, gargantuan, area.units, undefined, true);
        expect(areaHit.completed).toBe(true);
        area.units.forEach((unit, index) =>
            expectSteelBrokeAndBurned(unit, areaBefore[index], ofSource(areaHit.secondary, "fireforged_sword")),
        );

        const pierced = shieldedPair(["Enemy0", "Enemy1", "Enemy2"]);
        const cannon = createTestUnit({
            name: "Tsar Cannon",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Through Shot", "No Melee", "Stun"],
            damageMin: 40,
            damageMax: 40,
            rangeShots: 4,
            armor: 0,
            luck: 0,
            maxHp: 300,
        });
        giveSword(cannon);
        placeUnit(pierced.context.grid, pierced.context.unitsHolder, cannon, { x: 2, y: 4 });
        pierced.units.forEach((unit, index) =>
            placeUnit(pierced.context.grid, pierced.context.unitsHolder, unit, { x: 6 + index, y: 4 }),
        );
        const piercedBefore = pierced.units.map((unit) => unit.getCumulativeHp());
        const piercedHit = shot(pierced.context, cannon, pierced.units, undefined, false, true);
        expect(piercedHit.completed).toBe(true);
        pierced.units.forEach((unit, index) =>
            expectSteelBrokeAndBurned(unit, piercedBefore[index], ofSource(piercedHit.secondary, "fireforged_sword")),
        );

        const skewered = createCombatTestContext();
        const pikeman = createTestUnit({
            name: "Pikeman",
            team: LEFT,
            abilities: ["Skewer Strike", "Dulling Defense", "Stun"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 300,
        });
        giveSword(pikeman);
        const front = shield("Front", RIGHT);
        const behind = shield("Behind", RIGHT, ["Water Shield"], { attack: 10 });
        placeUnit(skewered.grid, skewered.unitsHolder, pikeman, { x: 5, y: 4 });
        placeUnit(skewered.grid, skewered.unitsHolder, front, { x: 5, y: 5 });
        placeUnit(skewered.grid, skewered.unitsHolder, behind, { x: 5, y: 6 });
        const frontBefore = front.getCumulativeHp();
        const behindBefore = behind.getCumulativeHp();
        const skewerHit = swing(skewered, pikeman, front, { x: 5, y: 4 });
        expect(skewerHit.completed).toBe(true);
        expectSteelBrokeAndBurned(front, frontBefore, ofSource(skewerHit.secondary, "fireforged_sword"));
        expectSteelBrokeAndBurned(behind, behindBefore, ofSource(skewerHit.secondary, "fireforged_sword"));
        expect(behind.getDebuff("Dulling Defense")).toBeUndefined();

        const spun = createCombatTestContext();
        const hydra = createTestUnit({
            name: "Hydra",
            team: LEFT,
            abilities: ["Lightning Spin", "Stun"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 300,
        });
        giveSword(hydra);
        const aimed = shield("Aimed", RIGHT);
        const beside = shield("Beside", RIGHT);
        placeUnit(spun.grid, spun.unitsHolder, hydra, { x: 4, y: 4 });
        placeUnit(spun.grid, spun.unitsHolder, aimed, { x: 5, y: 4 });
        placeUnit(spun.grid, spun.unitsHolder, beside, { x: 4, y: 5 });
        const aimedBefore = aimed.getCumulativeHp();
        const besideBefore = beside.getCumulativeHp();
        const spinHit = swing(spun, hydra, aimed, { x: 4, y: 4 });
        expect(spinHit.completed).toBe(true);
        expectSteelBrokeAndBurned(aimed, aimedBefore, ofSource(spinHit.secondary, "fireforged_sword"));
        expectSteelBrokeAndBurned(beside, besideBefore, ofSource(spinHit.secondary, "fireforged_sword"));

        const bounced = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Chakram", "Stun"],
            damageMin: 20,
            damageMax: 20,
            rangeShots: 4,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 200,
        });
        giveSword(zena);
        const victims = (["Primary", "First", "Second"] as const).map((name, index) => {
            const unit = shield(name, RIGHT);
            placeUnit(bounced.grid, bounced.unitsHolder, unit, { x: 8 + index * 2, y: 8 + index * 2 });
            return unit;
        });
        placeUnit(bounced.grid, bounced.unitsHolder, zena, { x: 8, y: 2 });
        const bounceBefore = victims.map((unit) => unit.getCumulativeHp());
        const bounceHit = shot(bounced, zena, [victims[0]]);
        expect(bounceHit.completed).toBe(true);
        victims.forEach((unit, index) =>
            expectSteelBrokeAndBurned(unit, bounceBefore[index], ofSource(bounceHit.secondary, "fireforged_sword")),
        );
    });

    it("lets a retaliation's blade through the attacker's shield and cancels the retaliation's other riders", () => {
        pinRng();
        const context = createCombatTestContext();
        const attacker = shield("Attacker", LEFT, ["Water Shield"], { damageMin: 5, damageMax: 5, attack: 10 });
        const defender = createTestUnit({
            name: "Defender",
            team: RIGHT,
            abilities: ["Stun"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 500,
        });
        giveSword(defender);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, defender, { x: 5, y: 3 });
        const before = attacker.getCumulativeHp();
        const hit = swing(context, attacker, defender, { x: 4, y: 3 });
        expect(hit.completed).toBe(true);
        expectSteelBrokeAndBurned(attacker, before, ofSource(hit.secondary, "fireforged_sword"));
    });

    it("arcs Chain Lightning after an absorbed swing, and an intact shield can still absorb the arc", () => {
        pinRng();
        const context = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Storm",
            team: LEFT,
            abilities: ["Chain Lightning"],
            damageMin: 20,
            damageMax: 20,
            attack: 20,
            stackPower: 5,
            armor: 0,
            luck: 0,
            maxHp: 400,
        });
        const target = shield("Target", RIGHT);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 5, y: 3 });
        const before = target.getCumulativeHp();
        const hit = swing(context, attacker, target, { x: 4, y: 3 });
        expect(hit.completed).toBe(true);
        expect(target.getCumulativeHp()).toBeLessThan(before);
        expect(target.hasBuffActive("Water Shield")).toBe(false);
        const lightning = ofSource(hit.secondary, "chain_lightning");
        expect(lightning).toHaveLength(1);
        expect(before - target.getCumulativeHp()).toBe(lightning[0].amount);

        const direct = createCombatTestContext();
        const caster = createTestUnit({
            name: "Storm Caster",
            team: LEFT,
            abilities: ["Chain Lightning"],
            stackPower: 5,
            maxHp: 400,
            armor: 0,
            luck: 0,
        });
        const shielded = shield("Shielded", RIGHT);
        placeUnit(direct.grid, direct.unitsHolder, caster, { x: 2, y: 2 });
        placeUnit(direct.grid, direct.unitsHolder, shielded, { x: 6, y: 6 });
        const shieldedBefore = shielded.getCumulativeHp();
        processChainLightningAbility(
            caster,
            shielded,
            40,
            direct.grid,
            direct.unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );
        expect(shielded.getCumulativeHp()).toBe(shieldedBefore);
        expect(shielded.hasBuffActive("Water Shield")).toBe(false);
    });
});

describe("fire spells pass and the other calls still spend the shield", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    const castWorld = (spell: string, stackPower: number) => {
        const context = createCombatTestContext();
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setGridType(PBTypes.GridVals.NORMAL);
        fight.startFight();
        const [faction, spellName] = spell.split(":");
        const caster = createTestUnit({
            name: "Mage",
            team: LEFT,
            spells: [spell, spell],
            stackPower,
            amountAlive: 4,
            maxHp: 200,
            damageMin: 0,
            damageMax: 0,
            luck: 0,
        });
        placeUnit(context.grid, context.unitsHolder, caster, { x: 2, y: 8 });
        fight.setTeamUnitsAlive(LEFT, 1);
        fight.setTeamUnitsAlive(RIGHT, 1);
        fight.startTurn(LEFT, 1000);
        const engine = new GameActionEngine({
            fightProperties: fight,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => caster.getId(),
        });
        return { ...context, fight, caster, engine, faction, spellName };
    };

    it("lets Fire Strike and Ring of Fire through, twice, and the shield still catches a blow afterwards", () => {
        const fire = castWorld("Chaos:Fire Strike", 1);
        const mermaid = shield("Mermaid", RIGHT);
        placeUnit(fire.grid, fire.unitsHolder, mermaid, { x: 8, y: 8 });
        const before = mermaid.getCumulativeHp();
        expect(
            fire.engine.apply({
                type: "cast_spell",
                casterId: fire.caster.getId(),
                spellName: "Fire Strike",
                targetId: mermaid.getId(),
            }).completed,
        ).toBe(true);
        const once = lost(mermaid, before);
        expect(once).toBeGreaterThan(0);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);
        // A cast ends the turn. The next lap is a second cast, not a second action in the same turn.
        fire.fight.flipLap();
        fire.fight.startTurn(LEFT, 2000);
        expect(
            fire.engine.apply({
                type: "cast_spell",
                casterId: fire.caster.getId(),
                spellName: "Fire Strike",
                targetId: mermaid.getId(),
            }).completed,
        ).toBe(true);
        expect(lost(mermaid, before)).toBe(once * 2);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);

        const soldier = createTestUnit({
            name: "Soldier",
            team: LEFT,
            damageMin: 12,
            damageMax: 12,
            luck: 0,
            armor: 0,
            maxHp: 200,
        });
        placeUnit(fire.grid, fire.unitsHolder, soldier, { x: 8, y: 7 });
        const afterSpells = mermaid.getCumulativeHp();
        expect(swing(fire, soldier, mermaid, { x: 8, y: 7 }).completed).toBe(true);
        expect(mermaid.getCumulativeHp()).toBe(afterSpells);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);

        const ring = castWorld("Nature:Ring of Fire", 5);
        const center = shield("Center", RIGHT);
        const beside = shield("Beside", RIGHT);
        placeUnit(ring.grid, ring.unitsHolder, center, { x: 8, y: 8 });
        placeUnit(ring.grid, ring.unitsHolder, beside, { x: 9, y: 8 });
        const centerBefore = center.getCumulativeHp();
        const besideBefore = beside.getCumulativeHp();
        expect(
            ring.engine.apply({
                type: "cast_spell",
                casterId: ring.caster.getId(),
                spellName: "Ring of Fire",
                targetId: center.getId(),
            }).completed,
        ).toBe(true);
        // The ring spares its middle and burns the cell beside it.
        expect(center.getCumulativeHp()).toBe(centerBefore);
        expect(center.hasBuffActive("Water Shield")).toBe(true);
        expect(lost(beside, besideBefore)).toBeGreaterThan(0);
        expect(beside.hasBuffActive("Water Shield")).toBe(true);
    });

    it("spends the shield on Lightning Strike and Meteorite", () => {
        const bolt = castWorld("Nature:Lightning Strike", 1);
        const mermaid = shield("Mermaid", RIGHT);
        placeUnit(bolt.grid, bolt.unitsHolder, mermaid, { x: 8, y: 8 });
        const before = mermaid.getCumulativeHp();
        expect(
            bolt.engine.apply({
                type: "cast_spell",
                casterId: bolt.caster.getId(),
                spellName: "Lightning Strike",
                targetId: mermaid.getId(),
            }).completed,
        ).toBe(true);
        expect(mermaid.getCumulativeHp()).toBe(before);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);

        const meteor = castWorld("Chaos:Meteorite", 5);
        const under = shield("Under", RIGHT);
        placeUnit(meteor.grid, meteor.unitsHolder, under, { x: 8, y: 8 });
        const underBefore = under.getCumulativeHp();
        expect(
            meteor.engine.apply({
                type: "cast_spell",
                casterId: meteor.caster.getId(),
                spellName: "Meteorite",
                targetCell: { x: 8, y: 8 },
            }).completed,
        ).toBe(true);
        expect(under.getCumulativeHp()).toBe(underBefore);
        expect(under.hasBuffActive("Water Shield")).toBe(false);
    });

    it("returns fire through the caster's shield and still absorbs a reflected bolt", () => {
        const fire = castWorld("Chaos:Fire Strike", 1);
        const caster = fire.caster;
        caster.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        const mermaid = createTestUnit({
            name: "Mermaid",
            team: RIGHT,
            maxHp: 5000,
            armor: 0,
            luck: 0,
            damageMin: 0,
            damageMax: 0,
        });
        giveMirror(mermaid);
        placeUnit(fire.grid, fire.unitsHolder, mermaid, { x: 8, y: 8 });
        const casterBefore = caster.getCumulativeHp();
        const targetBefore = mermaid.getCumulativeHp();
        expect(
            fire.engine.apply({
                type: "cast_spell",
                casterId: caster.getId(),
                spellName: "Fire Strike",
                targetId: mermaid.getId(),
            }).completed,
        ).toBe(true);
        const targetLoss = lost(mermaid, targetBefore);
        expect(targetLoss).toBeGreaterThan(0);
        expect(lost(caster, casterBefore)).toBe(targetLoss);
        expect(caster.hasBuffActive("Water Shield")).toBe(true);

        const bolt = castWorld("Nature:Lightning Strike", 1);
        const mirrored = createTestUnit({
            name: "Mirrored",
            team: RIGHT,
            maxHp: 5000,
            armor: 0,
            luck: 0,
            damageMin: 0,
            damageMax: 0,
        });
        giveMirror(mirrored);
        bolt.caster.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        placeUnit(bolt.grid, bolt.unitsHolder, mirrored, { x: 8, y: 8 });
        const boltCasterBefore = bolt.caster.getCumulativeHp();
        const mirroredBefore = mirrored.getCumulativeHp();
        expect(
            bolt.engine.apply({
                type: "cast_spell",
                casterId: bolt.caster.getId(),
                spellName: "Lightning Strike",
                targetId: mirrored.getId(),
            }).completed,
        ).toBe(true);
        expect(lost(mirrored, mirroredBefore)).toBeGreaterThan(0);
        expect(bolt.caster.getCumulativeHp()).toBe(boltCasterBefore);
        expect(bolt.caster.hasBuffActive("Water Shield")).toBe(false);
    });

    it("returns a reflected breath through the attacker's shield and absorbs a reflected Chain Lightning", () => {
        const context = createCombatTestContext();
        const attacker = shield("Breath Thief", LEFT, ["Water Shield", "Fire Breath"], {
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
            maxHp: 5000,
        });
        const primary = createTestUnit({ name: "Primary", team: RIGHT, maxHp: 500, damageMin: 0, damageMax: 0 });
        const behind = createTestUnit({ name: "Behind", team: RIGHT, maxHp: 5000, damageMin: 0, damageMax: 0 });
        giveMirror(behind);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(context.grid, context.unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(context.grid, context.unitsHolder, behind, { x: 5, y: 3 });
        const before = attacker.getCumulativeHp();
        processFireBreathAbility(
            attacker,
            primary,
            new SceneLogMock(),
            context.unitsHolder,
            context.grid,
            "attk",
            new DamageStatisticHolder(),
        );
        expect(lost(attacker, before)).toBeGreaterThan(0);
        expect(attacker.hasBuffActive("Water Shield")).toBe(true);

        const storm = createCombatTestContext();
        const caster = shield("Storm", LEFT, ["Water Shield", "Chain Lightning"], { stackPower: 5, maxHp: 5000 });
        const target = createTestUnit({ name: "Target", team: RIGHT, maxHp: 5000 });
        giveMirror(target);
        placeUnit(storm.grid, storm.unitsHolder, caster, { x: 2, y: 2 });
        placeUnit(storm.grid, storm.unitsHolder, target, { x: 6, y: 6 });
        const casterBefore = caster.getCumulativeHp();
        processChainLightningAbility(
            caster,
            target,
            40,
            storm.grid,
            storm.unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );
        expect(caster.getCumulativeHp()).toBe(casterBefore);
        expect(caster.hasBuffActive("Water Shield")).toBe(false);
    });

    it("returns a reflected Fire Shield and a reflected Fireforged burn through the striker's shield", () => {
        const context = createCombatTestContext();
        const shielded = shield("Shielded", LEFT, ["Water Shield", "Fire Shield"], {
            stackPower: 5,
            maxHp: 5000,
        });
        const mirror = createTestUnit({
            name: "Mirror",
            team: RIGHT,
            maxHp: 5000,
            damageMin: 0,
            damageMax: 0,
            armor: 0,
            luck: 0,
            magicResist: 0,
        });
        giveMirror(mirror);
        placeUnit(context.grid, context.unitsHolder, shielded, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, mirror, { x: 5, y: 3 });
        const shieldedBefore = shielded.getCumulativeHp();
        const mirrorBefore = mirror.getCumulativeHp();
        processFireShieldAbility(
            shielded,
            mirror,
            new SceneLogMock(),
            100,
            context.unitsHolder,
            new DamageStatisticHolder(),
        );
        const mirrorLoss = lost(mirror, mirrorBefore);
        expect(mirrorLoss).toBeGreaterThan(0);
        expect(lost(shielded, shieldedBefore)).toBe(mirrorLoss);
        expect(shielded.hasBuffActive("Water Shield")).toBe(true);

        const swordFight = createCombatTestContext();
        const blade = shield("Blade", LEFT, ["Water Shield"], { maxHp: 5000 });
        giveSword(blade);
        const lookingGlass = createTestUnit({
            name: "Looking Glass",
            team: RIGHT,
            maxHp: 5000,
            damageMin: 0,
            damageMax: 0,
            magicResist: 0,
        });
        giveMirror(lookingGlass);
        placeUnit(swordFight.grid, swordFight.unitsHolder, blade, { x: 4, y: 3 });
        placeUnit(swordFight.grid, swordFight.unitsHolder, lookingGlass, { x: 5, y: 3 });
        const bladeBefore = blade.getCumulativeHp();
        const glassBefore = lookingGlass.getCumulativeHp();
        processFireforgedSwordAbility(blade, lookingGlass, 100, new SceneLogMock(), new DamageStatisticHolder());
        const glassLoss = lost(lookingGlass, glassBefore);
        expect(glassLoss).toBeGreaterThan(0);
        expect(lost(blade, bladeBefore)).toBe(glassLoss);
        expect(blade.hasBuffActive("Water Shield")).toBe(true);
    });

    it("spends the shield on Armageddon, the first Fire Wall burn, and a Last Fuse blast", () => {
        const log = new SceneLogMock();
        const doomed = shield("Doomed", RIGHT, ["Water Shield"], { maxHp: 200 });
        const wave = doomed.applyArmageddonDamage(1, log);
        expect(wave).toBeGreaterThan(0);
        expect(doomed.getCumulativeHp()).toBe(200);
        expect(doomed.hasBuffActive("Water Shield")).toBe(false);
        expect(doomed.applyArmageddonDamage(1, log)).toBeGreaterThan(0);
        expect(doomed.getCumulativeHp()).toBeLessThan(200);

        const walker = shield("Walker", RIGHT, ["Water Shield"], { maxHp: 200 });
        const walls = new FireWalls();
        walls.add({ x: 5, y: 5 }, 3);
        walls.add({ x: 6, y: 5 }, 3);
        const oneCell = fireWallBurnDamage(walker.getCumulativeMaxHp(), walls.burnPercentageAt({ x: 5, y: 5 }));
        const before = walker.getCumulativeHp();
        burnUnitOnFireWallCells(
            walker,
            [
                { x: 5, y: 5 },
                { x: 6, y: 5 },
            ],
            walls,
            log,
        );
        // The first cell spends the shield. The second cell is the one that actually burns.
        expect(oneCell).toBeGreaterThan(0);
        expect(lost(walker, before)).toBe(oneCell);
        expect(walker.hasBuffActive("Water Shield")).toBe(false);

        const context = createCombatTestContext();
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.LAST_FUSE);
        const killer = createTestUnit({
            name: "Killer",
            team: LEFT,
            abilities: ["Fire Element"],
            maxHp: 200,
            damageMin: 0,
            damageMax: 0,
        });
        const victim = createTestUnit({ name: "Victim", team: RIGHT, maxHp: 100, amountAlive: 1 });
        const neighbor = shield("Neighbor", RIGHT, ["Water Shield"], { maxHp: 1000 });
        placeUnit(context.grid, context.unitsHolder, killer, { x: 1, y: 1 });
        placeUnit(context.grid, context.unitsHolder, victim, { x: 5, y: 5 });
        placeUnit(context.grid, context.unitsHolder, neighbor, { x: 6, y: 5 });
        context.unitsHolder.applyArtifacts(fight);
        victim.applyDamage(victim.getCumulativeHp(), 0, log, false, killer);
        const neighborBefore = neighbor.getCumulativeHp();
        const blast = explodeLastFuse(victim, context.unitsHolder, log);
        expect(blast?.hits ?? []).toHaveLength(0);
        expect(neighbor.getCumulativeHp()).toBe(neighborBefore);
        expect(neighbor.hasBuffActive("Water Shield")).toBe(false);
    });

    it("lets Break turn the absorb off without consuming the shield, including a fire spell", () => {
        pinRng();
        const context = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Attacker",
            team: LEFT,
            abilities: ["Stun"],
            damageMin: 15,
            damageMax: 15,
            attack: 10,
            stackPower: 5,
            luck: 0,
            armor: 0,
            maxHp: 200,
        });
        const mermaid = shield("Mermaid", RIGHT);
        mermaid.applyEffect(new EffectFactory().makeEffect("Break")!);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, mermaid, { x: 5, y: 3 });
        const before = mermaid.getCumulativeHp();
        expect(swing(context, attacker, mermaid, { x: 4, y: 3 }).completed).toBe(true);
        expect(lost(mermaid, before)).toBeGreaterThan(0);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);
        expect(mermaid.getEffects().map((effect) => effect.getName())).toContain("Stun");
        expect(mermaid.willWaterShieldAbsorb(attacker)).toBe(false);

        mermaid.deleteEffect("Break");
        mermaid.deleteEffect("Stun");
        const afterBreak = mermaid.getCumulativeHp();
        expect(swing(context, attacker, mermaid, { x: 4, y: 3 }).completed).toBe(true);
        expect(mermaid.getCumulativeHp()).toBe(afterBreak);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);

        const fire = castWorld("Chaos:Fire Strike", 1);
        const broken = shield("Broken", RIGHT);
        broken.applyEffect(new EffectFactory().makeEffect("Break")!);
        placeUnit(fire.grid, fire.unitsHolder, broken, { x: 8, y: 8 });
        const brokenBefore = broken.getCumulativeHp();
        expect(
            fire.engine.apply({
                type: "cast_spell",
                casterId: fire.caster.getId(),
                spellName: "Fire Strike",
                targetId: broken.getId(),
            }).completed,
        ).toBe(true);
        expect(lost(broken, brokenBefore)).toBeGreaterThan(0);
        expect(broken.hasBuffActive("Water Shield")).toBe(true);
        broken.deleteEffect("Break");
        const restored = broken.getCumulativeHp();
        fire.fight.flipLap();
        fire.fight.startTurn(LEFT, 2000);
        expect(
            fire.engine.apply({
                type: "cast_spell",
                casterId: fire.caster.getId(),
                spellName: "Fire Strike",
                targetId: broken.getId(),
            }).completed,
        ).toBe(true);
        expect(lost(broken, restored)).toBeGreaterThan(0);
        expect(broken.hasBuffActive("Water Shield")).toBe(true);
    });
});
