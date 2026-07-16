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

import { afterEach, describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import {
    routeUniversalCaster,
    routeUniversalCasterWithPolicy,
    V07_CASTER_ROUTER_POLICY,
} from "../../src/ai/versions/caster_router";
import { StrategyV0_6 } from "../../src/ai/versions/v0_6";
import { StrategyV0_4 } from "../../src/ai/versions/v0_4";
import { isAuraSaturatedArmy, StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
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
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const MAGIC = PBTypes.AttackVals.MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const FLY = PBTypes.MovementVals.FLY;

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
    };
}

function makeReal(team: number, faction: string, name: string, amount = 100): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function placeLarge(combat: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) {
        throw new Error("invalid large-unit placement");
    }
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function primeV07AuraProfile(strategy: StrategyV0_7, combat: CombatTestContext): void {
    strategy.placeArmy(combat.unitsHolder.getAllAllies(LOWER), {
        team: LOWER,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
    });
}

const fallback = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const castSpell = (actions: GameAction[]): Extract<GameAction, { type: "cast_spell" }> | undefined => {
    const action = actions.find((candidate) => candidate.type === "cast_spell");
    return action?.type === "cast_spell" ? action : undefined;
};

afterEach(() => {
    delete process.env.V06_CASTER_ROUTER;
    delete process.env.V06_CASTER_SPELLS;
    delete process.env.V06_RES_PREEMPT;
    delete process.env.V07_AURA_CASTER_ROUTER;
    delete process.env.V07_AURA_CASTER_SPELLS;
    delete process.env.V07_CASTER_EXTRA;
    delete process.env.V07_CASTER_EXTRA_VERSIONS;
});

describe("v0.6 universal MELEE_MAGIC caster router", () => {
    it("is an exact no-op while gated off, and never touches incumbent MAGIC behavior", () => {
        const combat = createCombatTestContext();
        const meleeMagic = createTestUnit({ team: LOWER, attackType: MELEE_MAGIC });
        const magic = createTestUnit({ team: LOWER, attackType: MAGIC });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, meleeMagic, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, magic, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 12 });
        const context = contextFor(combat);
        const meleeIncumbent = fallback(meleeMagic);
        const magicIncumbent = fallback(magic);
        const mustNotEnumerate = (): never => {
            throw new Error("candidate enumeration must stay dormant");
        };

        expect(routeUniversalCaster(meleeMagic, context, meleeIncumbent, mustNotEnumerate)).toBe(meleeIncumbent);

        process.env.V06_CASTER_ROUTER = "on";
        expect(routeUniversalCaster(magic, context, magicIncumbent, mustNotEnumerate)).toBe(magicIncumbent);
    });

    it("routes Resurrection first when recovered allied HP exceeds the Angel's passive reserve", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "High-value ally", amountAlive: 100, maxHp: 100 });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 12 });
        ally.applyDamage(9_500, 0, new SceneLogMock());

        // Angel reserve = floor(100 / 2) * 175 = 8,750 HP; this cast restores 9,500 HP.
        const incumbent: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: angel.getId(),
                targetId: enemy.getId(),
                attackFrom: angel.getBaseCell(),
            },
        ];
        const cast = castSpell(routeUniversalCaster(angel, contextFor(combat), incumbent));
        expect(cast?.spellName).toBe("Resurrection");
        expect(cast?.targetId).toBe(ally.getId());
    });

    it("keeps the incumbent when Resurrection recovery does not repay the shared passive charge", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "Lightly depleted ally", amountAlive: 100, maxHp: 100 });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 12 });
        ally.applyDamage(5_000, 0, new SceneLogMock());
        const incumbent = fallback(angel);

        expect(routeUniversalCaster(angel, contextFor(combat), incumbent)).toBe(incumbent);
    });

    it("routes Wind Flow against greater hostile flying pressure", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const enemyFlyer = createTestUnit({
            team: UPPER,
            name: "Enemy flyer",
            attackType: MELEE,
            movementType: FLY,
            speed: 8,
            damageMax: 100,
            amountAlive: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 12 });

        const cast = castSpell(routeUniversalCaster(valkyrie, contextFor(combat), fallback(valkyrie)));
        expect(cast?.spellName).toBe("Wind Flow");
        expect(cast?.targetId).toBeUndefined();
    });

    it("does not cast Wind Flow when friendly-flyer mobility collateral is greater", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const alliedFlyer = createTestUnit({
            team: LOWER,
            movementType: FLY,
            speed: 10,
            damageMax: 20,
            amountAlive: 20,
        });
        const enemyFlyer = createTestUnit({
            team: UPPER,
            movementType: FLY,
            speed: 2,
            damageMax: 1,
            amountAlive: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, alliedFlyer, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 12 });
        const incumbent = fallback(valkyrie);

        expect(routeUniversalCaster(valkyrie, contextFor(combat), incumbent)).toBe(incumbent);
    });

    it("counts the flying caster itself as Wind Flow collateral", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const enemyFlyer = createTestUnit({
            team: UPPER,
            movementType: FLY,
            speed: 2,
            damageMax: 1,
            amountAlive: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 12 });
        const incumbent = fallback(valkyrie);

        expect(routeUniversalCaster(valkyrie, contextFor(combat), incumbent)).toBe(incumbent);
    });

    it("routes Castling only for a forward enemy backliner that can be pulled into local support", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const harpy = makeReal(LOWER, "Might", "Harpy");
        harpy.setStackPower(5);
        const support = createTestUnit({ team: LOWER, name: "Support", attackType: MELEE });
        const shooter = createTestUnit({ team: UPPER, name: "Shooter", attackType: RANGE, amountAlive: 10 });
        placeUnit(combat.grid, combat.unitsHolder, harpy, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, support, { x: 1, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 5, y: 5 });

        const cast = castSpell(routeUniversalCaster(harpy, contextFor(combat), fallback(harpy)));
        expect(cast?.spellName).toBe("Castling");
        expect(cast?.targetId).toBe(shooter.getId());
        expect(cast?.targetCell).toEqual(shooter.getBaseCell());
    });

    it("keeps normal play when Castling can only swap a melee frontliner", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const harpy = makeReal(LOWER, "Might", "Harpy");
        harpy.setStackPower(5);
        const support = createTestUnit({ team: LOWER, attackType: MELEE });
        const frontliner = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, harpy, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, support, { x: 1, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, frontliner, { x: 5, y: 5 });
        const incumbent = fallback(harpy);

        expect(routeUniversalCaster(harpy, contextFor(combat), incumbent)).toBe(incumbent);
    });

    it("extends Wild Regeneration through F4 while preserving an existing Troll cast verbatim", () => {
        process.env.V06_CASTER_ROUTER = "on";
        const combat = createCombatTestContext();
        const troll = makeReal(LOWER, "Chaos", "Troll");
        troll.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "Tank", level: 3, amountAlive: 20, maxHp: 50 });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, troll, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 12 });
        const routed = routeUniversalCaster(troll, contextFor(combat), fallback(troll));
        const cast = castSpell(routed);
        expect(cast?.spellName).toBe("Wild Regeneration");
        expect(cast?.targetId).toBe(ally.getId());

        expect(routeUniversalCaster(troll, contextFor(combat), routed)).toBe(routed);
    });

    it("is invoked by StrategyV0_6 only when the opt-in gate is on", () => {
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const enemyFlyer = createTestUnit({
            team: UPPER,
            attackType: MELEE,
            movementType: FLY,
            speed: 8,
            damageMax: 100,
            amountAlive: 100,
        });
        const nonAuraAlly = createTestUnit({ team: LOWER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, nonAuraAlly, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 14 });
        const strategy = new StrategyV0_6();

        const gatedOff = strategy.decideTurn(valkyrie, contextFor(combat));
        expect(castSpell(gatedOff)?.spellName).not.toBe("Wind Flow");

        process.env.V06_CASTER_ROUTER = "on";
        expect(castSpell(strategy.decideTurn(valkyrie, contextFor(combat)))?.spellName).toBe("Wind Flow");
    });
});

describe("v0.7 baked caster salvage", () => {
    it("routes Wind Flow with the experiment env off while v0.6 stays gated", () => {
        process.env.V06_CASTER_ROUTER = "off";
        process.env.V06_CASTER_SPELLS = "castling,wildregen";
        process.env.V06_RES_PREEMPT = "on";
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const enemyFlyer = createTestUnit({
            team: UPPER,
            attackType: MELEE,
            movementType: FLY,
            speed: 8,
            damageMax: 100,
            amountAlive: 100,
        });
        const nonAuraAlly = createTestUnit({ team: LOWER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, nonAuraAlly, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 14 });
        const context = contextFor(combat);

        expect(castSpell(new StrategyV0_6().decideTurn(valkyrie, context))?.spellName).not.toBe("Wind Flow");
        expect(castSpell(new StrategyV0_7().decideTurn(valkyrie, context))?.spellName).toBe("Wind Flow");
    });

    it("does not let Resurrection pre-empt a committed v0.7 action", () => {
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "High-value ally", amountAlive: 100, maxHp: 100 });
        const enemy = createTestUnit({ team: UPPER, name: "Adjacent enemy", attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 4 });
        ally.applyDamage(9_500, 0, new SceneLogMock());
        const context = contextFor(combat);
        const incumbent = new StrategyV0_6().decideTurn(angel, context);

        expect(incumbent.some((action) => action.type === "melee_attack")).toBe(true);
        const actual = new StrategyV0_7().decideTurn(angel, context);
        expect(actual).toEqual(incumbent);
        expect(castSpell(actual)?.spellName).not.toBe("Resurrection");
    });

    it("keeps Castling and Wild Regeneration outside the baked policy", () => {
        expect(V07_CASTER_ROUTER_POLICY.spells).toEqual(["resurrection", "windflow"]);
        const combat = createCombatTestContext();
        const caster = createTestUnit({ team: LOWER, attackType: MELEE_MAGIC });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, caster, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 12 });
        const incumbent = fallback(caster);
        const features: IEnumeratedCandidate["features"] = {
            moraleDelta: 0,
            luckDelta: 0,
            enemiesNotYetActedFrac: 0,
            alliesNotYetActedFrac: 0,
            lap: 0,
            hourglassSpent: 0,
            spendsRangeShot: 0,
            spendsSpellCharge: 1,
            burnsResurrectionCharge: 0,
            expectedDamage: 0,
            expectedKill: 0,
        };
        const excluded: IEnumeratedCandidate[] = ["Castling", "Wild Regeneration"].map((spellName) => ({
            kind: "spell",
            spellName,
            actions: [{ type: "cast_spell", casterId: caster.getId(), spellName, targetId: enemy.getId() }],
            targetId: enemy.getId(),
            features: { ...features },
        }));

        expect(
            routeUniversalCasterWithPolicy(caster, contextFor(combat), incumbent, V07_CASTER_ROUTER_POLICY, () => ({
                candidates: excluded,
                truncated: [],
            })),
        ).toBe(incumbent);
    });

    it("preserves v0.6 gate, spell-scope, and Resurrection-preemption experiments", () => {
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "High-value ally", amountAlive: 100, maxHp: 100 });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 12 });
        ally.applyDamage(9_500, 0, new SceneLogMock());
        const incumbent: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: angel.getId(),
                targetId: enemy.getId(),
                attackFrom: angel.getBaseCell(),
            },
        ];
        const context = contextFor(combat);

        process.env.V06_CASTER_ROUTER = "on";
        process.env.V06_CASTER_SPELLS = "resurrection";
        process.env.V06_RES_PREEMPT = "off";
        expect(routeUniversalCaster(angel, context, incumbent)).toBe(incumbent);

        delete process.env.V06_RES_PREEMPT;
        expect(castSpell(routeUniversalCaster(angel, context, incumbent))?.spellName).toBe("Resurrection");

        process.env.V06_CASTER_SPELLS = "windflow";
        expect(routeUniversalCaster(angel, context, incumbent)).toBe(incumbent);
    });

    it("routes Wind Flow from the v0.4 incumbent only for an armed aura-saturated profile", () => {
        const combat = createCombatTestContext();
        const valkyrie = makeReal(LOWER, "Life", "Valkyrie");
        valkyrie.setStackPower(5);
        const auraAlly = createTestUnit({
            team: LOWER,
            attackType: MELEE,
            auraEffects: ["Luck"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        const enemyFlyer = createTestUnit({
            team: UPPER,
            attackType: MELEE,
            movementType: FLY,
            speed: 8,
            damageMax: 100,
            amountAlive: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, valkyrie, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, auraAlly, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemyFlyer, { x: 4, y: 14 });
        const context = contextFor(combat);
        expect(isAuraSaturatedArmy(combat.unitsHolder.getAllAllies(LOWER))).toBe(true);
        const anchor = new StrategyV0_4().decideTurn(valkyrie, context);

        const control = new StrategyV0_7();
        primeV07AuraProfile(control, combat);
        expect(control.decideTurn(valkyrie, context)).toEqual(anchor);

        process.env.V07_AURA_CASTER_ROUTER = "on";
        process.env.V07_AURA_CASTER_SPELLS = "windflow";
        const treatment = new StrategyV0_7();
        primeV07AuraProfile(treatment, combat);
        expect(castSpell(treatment.decideTurn(valkyrie, context))?.spellName).toBe("Wind Flow");

        process.env.V07_AURA_CASTER_SPELLS = "invalid";
        const malformed = new StrategyV0_7();
        primeV07AuraProfile(malformed, combat);
        expect(malformed.decideTurn(valkyrie, context)).toEqual(anchor);
    });

    it("W17 summonwolves: replaces a Satyr self-buff cast only when the token is routed", () => {
        const combat = createCombatTestContext();
        const satyr = makeReal(LOWER, "Nature", "Satyr");
        satyr.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, satyr, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 12 });
        const context = contextFor(combat);
        const buffIncumbent: GameAction[] = [{ type: "cast_spell", casterId: satyr.getId(), spellName: "Courage" }];
        const mustNotEnumerate = (): never => {
            throw new Error("a policy without summonwolves must not enumerate for a MAGIC caster");
        };

        // Shipped v0.7 policy: MAGIC casters stay untouched, enumeration stays dormant.
        expect(
            routeUniversalCasterWithPolicy(satyr, context, buffIncumbent, V07_CASTER_ROUTER_POLICY, mustNotEnumerate),
        ).toBe(buffIncumbent);

        const withToken = {
            spells: ["resurrection", "windflow", "summonwolves"],
            resurrectionPreemptsCommitted: false,
        } as const;
        const routed = routeUniversalCasterWithPolicy(satyr, context, buffIncumbent, withToken);
        const cast = castSpell(routed);
        expect(cast?.spellName).toBe("Summon Wolves");
        expect(cast?.targetCell).toBeDefined();

        // An existing Summon Wolves cast and a committed combat action are preserved verbatim.
        expect(routeUniversalCasterWithPolicy(satyr, context, routed, withToken)).toBe(routed);
        const attack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: satyr.getId(),
                targetId: enemy.getId(),
                attackFrom: satyr.getBaseCell(),
            },
        ];
        expect(routeUniversalCasterWithPolicy(satyr, context, attack, withToken)).toBe(attack);
    });

    it("W17 summonwolves: v0.6 env path routes it only when explicitly scoped, never by default", () => {
        const combat = createCombatTestContext();
        const satyr = makeReal(LOWER, "Nature", "Satyr");
        satyr.setStackPower(5);
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, satyr, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 12 });
        const context = contextFor(combat);
        const buffIncumbent: GameAction[] = [{ type: "cast_spell", casterId: satyr.getId(), spellName: "Courage" }];

        process.env.V06_CASTER_ROUTER = "on";
        expect(routeUniversalCaster(satyr, context, buffIncumbent)).toBe(buffIncumbent);

        process.env.V06_CASTER_SPELLS = "summonwolves";
        expect(castSpell(routeUniversalCaster(satyr, context, buffIncumbent))?.spellName).toBe("Summon Wolves");
    });

    it("W17 reswiden: lowers the reserve bar and treats a wait incumbent as replaceable", () => {
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, name: "Half-depleted ally", amountAlive: 100, maxHp: 100 });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 12 });
        // Reserve = floor(100/2) * 175 = 8,750 HP. 5,000 missing HP fails the shipped full-reserve
        // bar but clears the widened 50%-weighted bar (4,375).
        ally.applyDamage(5_000, 0, new SceneLogMock());
        const context = contextFor(combat);
        const widened = {
            spells: ["resurrection", "windflow", "reswiden"],
            resurrectionPreemptsCommitted: false,
        } as const;

        const idle = fallback(angel);
        expect(routeUniversalCasterWithPolicy(angel, context, idle, V07_CASTER_ROUTER_POLICY)).toBe(idle);
        expect(castSpell(routeUniversalCasterWithPolicy(angel, context, idle, widened))?.spellName).toBe(
            "Resurrection",
        );

        const wait: GameAction[] = [{ type: "wait_turn", unitId: angel.getId() }];
        expect(routeUniversalCasterWithPolicy(angel, context, wait, V07_CASTER_ROUTER_POLICY)).toBe(wait);
        expect(castSpell(routeUniversalCasterWithPolicy(angel, context, wait, widened))?.spellName).toBe(
            "Resurrection",
        );

        // Real combat actions stay committed — the widening deliberately excludes melee pre-emption.
        const attack: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: angel.getId(),
                targetId: enemy.getId(),
                attackFrom: angel.getBaseCell(),
            },
        ];
        expect(routeUniversalCasterWithPolicy(angel, context, attack, widened)).toBe(attack);

        // "reswait" only lifts the wait commitment; the full-reserve bar still rejects this 5,000-HP cast.
        const waitOnly = {
            spells: ["resurrection", "windflow", "reswait"],
            resurrectionPreemptsCommitted: false,
        } as const;
        expect(routeUniversalCasterWithPolicy(angel, context, wait, waitOnly)).toBe(wait);
        ally.applyDamage(4_500, 0, new SceneLogMock());
        expect(castSpell(routeUniversalCasterWithPolicy(angel, context, wait, waitOnly))?.spellName).toBe(
            "Resurrection",
        );
    });

    it("W17 V07_CASTER_EXTRA: scopes by version and fails closed on unknown tokens", () => {
        const combat = createCombatTestContext();
        const satyr = makeReal(LOWER, "Nature", "Satyr");
        satyr.setStackPower(5);
        const ally = createTestUnit({ team: LOWER, attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, satyr, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 10 });
        const context = contextFor(combat);

        const control = new StrategyV0_7().decideTurn(satyr, context);
        expect(castSpell(control)?.spellName).toBe("Courage");

        process.env.V07_CASTER_EXTRA = "summonwolves";
        process.env.V07_CASTER_EXTRA_VERSIONS = "v0.7s";
        expect(new StrategyV0_7().decideTurn(satyr, context)).toEqual(control);

        process.env.V07_CASTER_EXTRA_VERSIONS = "v0.7";
        expect(castSpell(new StrategyV0_7().decideTurn(satyr, context))?.spellName).toBe("Summon Wolves");

        process.env.V07_CASTER_EXTRA = "bogus";
        expect(new StrategyV0_7().decideTurn(satyr, context)).toEqual(control);
    });

    it("keeps Resurrection outside the Wind-only aura arm and non-preempting in the combined arm", () => {
        const combat = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel");
        angel.setStackPower(5);
        const auraAlly = createTestUnit({
            team: LOWER,
            name: "High-value aura ally",
            amountAlive: 100,
            maxHp: 100,
            auraEffects: ["Luck"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeLarge(combat, angel, { x: 4, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, auraAlly, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 14 });
        auraAlly.applyDamage(9_500, 0, new SceneLogMock());
        const context = contextFor(combat);
        expect(isAuraSaturatedArmy(combat.unitsHolder.getAllAllies(LOWER))).toBe(true);
        const anchor = new StrategyV0_4().decideTurn(angel, context);

        process.env.V07_AURA_CASTER_ROUTER = "on";
        process.env.V07_AURA_CASTER_SPELLS = "windflow";
        const windOnly = new StrategyV0_7();
        primeV07AuraProfile(windOnly, combat);
        expect(windOnly.decideTurn(angel, context)).toEqual(anchor);

        process.env.V07_AURA_CASTER_SPELLS = "resurrection,windflow";
        const combined = new StrategyV0_7();
        primeV07AuraProfile(combined, combat);
        const routed = combined.decideTurn(angel, context);
        expect(
            anchor.some(
                (action) =>
                    action.type === "wait_turn" ||
                    action.type === "defend_turn" ||
                    action.type === "melee_attack" ||
                    action.type === "range_attack" ||
                    action.type === "area_throw_attack" ||
                    action.type === "obstacle_attack" ||
                    action.type === "cast_spell",
            ),
        ).toBe(false);
        expect(castSpell(routed)?.spellName).toBe("Resurrection");
    });
});
