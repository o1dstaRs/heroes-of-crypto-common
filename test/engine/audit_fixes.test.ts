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

import { evaluateAffectedUnits } from "../../src/abilities/aoe_range_ability";
import { processDevourEssenceAbility } from "../../src/abilities/devour_essense_ability";
import { processFleshShieldAura } from "../../src/abilities/flesh_shield_aura_ability";
import { processPetrifyingGazeAbility } from "../../src/abilities/petrifying_gaze_ability";
import { processRimeCharmAbility } from "../../src/abilities/rime_charm_ability";
import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { processMinerAbility } from "../../src/abilities/miner_ability";
import { processParalysisAbility } from "../../src/abilities/paralysis_ability";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getAbilityConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createDefaultGameRuntime } from "../../src/engine/runtime";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { Spell } from "../../src/spells/spell";
import { spellDamageAgainstUnit } from "../../src/spells/spell_cast_projection";
import { fireforgedSwordDamage } from "../../src/spells/spell_damage";
import { fireWallBurnDamage } from "../../src/spells/fire_walls";
import { projectMagicMirrorDamage } from "../../src/spells/magic_mirror_damage";
import { SpellElement } from "../../src/spells/spell_properties";
import { setDeterministicRandomSource } from "../../src/utils/lib";
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

describe("G5: Dual Strike Charm and Rime Charm reach every second attack", () => {
    it("marks a Crafted Double Punch unit for the charm", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, Tier1Artifact.DUAL_STRIKE_CHARM);
        const crafted = createTestUnit({
            name: "Smith",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Crafted Double Punch"],
        });
        placeUnit(grid, unitsHolder, crafted, { x: 2, y: 2 });

        unitsHolder.applyArtifacts(fightProperties);

        expect(crafted.getBuff("Dual Strike Charm")).toBeDefined();
    });

    it("raises an area second volley (Double Throw) like a second arrow", () => {
        const damageTaken = (withCharm: boolean): number => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            if (withCharm) {
                fightProperties.setArtifactPerTeam(PBTypes.TeamVals.RIGHT, 1, Tier1Artifact.DUAL_STRIKE_CHARM);
            }
            const thrower = createTestUnit({
                name: "Thrower",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 5,
                amountAlive: 1,
                abilities: ["Area Throw", "Double Throw"],
            });
            const target = createTestUnit({
                name: "Target",
                team: PBTypes.TeamVals.LEFT,
                maxHp: 10_000,
                amountAlive: 1,
            });
            placeUnit(grid, unitsHolder, thrower, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            unitsHolder.applyArtifacts(fightProperties);
            thrower.calculateMissChance = () => 0;
            thrower.calculateAttackDamage = () => 100;
            const before = target.getCumulativeHp();

            attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                createVisibleDamage(target),
                thrower,
                [[target]],
                undefined,
                target.getPosition(),
            );
            return before - target.getCumulativeHp();
        };

        const plain = damageTaken(false);
        const charmed = damageTaken(true);

        expect(plain).toBe(200);
        expect(charmed).toBe(250);
    });

    it("rolls Rime Charm on the second punch", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.RIGHT, 2, Tier2Artifact.RIME_CHARM);
        const puncher = createTestUnit({
            name: "Puncher",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Double Punch"],
            damageMin: 1,
            damageMax: 1,
            amountAlive: 5,
        });
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LEFT, maxHp: 1000, amountAlive: 5 });
        placeUnit(grid, unitsHolder, puncher, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
        unitsHolder.applyArtifacts(fightProperties);
        // The first punch misses (no riders roll); the second lands.
        let swings = 0;
        puncher.calculateMissChance = () => (swings++ === 0 ? 100 : 0);

        setDeterministicRandomSource(() => 0);
        try {
            attackHandler.handleMeleeAttack(
                unitsHolder,
                new MoveHandler(testGridSettings, grid, unitsHolder),
                createVisibleDamage(target),
                undefined,
                puncher,
                target,
                { x: 1, y: 1 },
            );
        } finally {
            setDeterministicRandomSource(undefined);
        }

        expect(swings).toBeGreaterThanOrEqual(2);
        expect(target.hasDebuffActive("Quagmire")).toBe(true);
    });
});

describe("G6: Heavy Armor's +magic damage applies to every magic source", () => {
    const knight = (heavyArmor: boolean) =>
        createTestUnit({
            name: "Goblin Knight",
            team: PBTypes.TeamVals.LEFT,
            abilities: heavyArmor ? ["Heavy Armor"] : [],
            stackPower: 5,
        });

    it("a damage spell hits a full Heavy Armor stack 50% harder", () => {
        const fireStrike = new Spell({ spellProperties: getSpellConfig("Chaos", "Fire Strike"), amount: 1 });

        expect(spellDamageAgainstUnit(fireStrike, 100, knight(false))).toBe(100);
        expect(spellDamageAgainstUnit(fireStrike, 100, knight(true))).toBe(150);
    });

    it("so does the share a Magic Mirror sends back at an attacker in Heavy Armor", () => {
        const holder = createTestUnit({ name: "Holder", team: PBTypes.TeamVals.RIGHT });
        const reflected = (attacker: Unit) =>
            projectMagicMirrorDamage({
                attacker,
                holder,
                landedOnHolder: 200,
                element: SpellElement.FIRE,
                reflectionPercent: 50,
            })?.landed;

        expect(reflected(knight(false))).toBe(100);
        expect(reflected(knight(true))).toBe(150);
    });

    it("so do Fireforged burns", () => {
        const burn = (multiplier: number): number =>
            fireforgedSwordDamage({
                damageDealt: 100,
                swordPercentage: 20,
                targetMagicResist: 0,
                targetIsFireElement: false,
                targetIsWaterElement: false,
                targetMagicDamageTakenMultiplier: multiplier,
            });

        expect(burn(knight(false).getMagicDamageTakenMultiplier())).toBe(20);
        expect(burn(knight(true).getMagicDamageTakenMultiplier())).toBe(30);
    });
});

describe("C1: Fire Wall answers magic resistance like every other fire", () => {
    it("magic resistance cuts the burn and 100% blocks it; Heavy Armor raises it", () => {
        expect(fireWallBurnDamage(1_000, 25)).toBe(250);
        expect(fireWallBurnDamage(1_000, 25, { magicResist: 50 })).toBe(125);
        expect(fireWallBurnDamage(1_000, 25, { magicResist: 100 })).toBe(0);
        expect(fireWallBurnDamage(1_000, 25, { magicDamageTakenMultiplier: 1.5 })).toBe(375);
    });
});

describe("G7: the Angel's shot protection doesn't bend spells", () => {
    it("an Angel in a spell's block no longer shields the units beside it; a ranged area attack still stops at it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const angel = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Arrows Wingshield Blessing"],
        });
        const neighbour = createTestUnit({ name: "Neighbour", team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, angel, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, neighbour, { x: 6, y: 5 });
        const block = [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
            { x: 5, y: 6 },
            { x: 6, y: 6 },
        ];

        const byShot = evaluateAffectedUnits(block, unitsHolder, grid)?.[0] ?? [];
        const bySpell = evaluateAffectedUnits(block, unitsHolder, grid, false)?.[0] ?? [];

        expect(byShot.map((unit) => unit.getName())).toEqual(["Angel"]);
        expect(bySpell.map((unit) => unit.getName()).sort()).toEqual(["Angel", "Neighbour"]);
    });
});

const shieldedPair = () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const attacker = createTestUnit({ name: "Attacker", team: PBTypes.TeamVals.RIGHT });
    const target = createTestUnit({ name: "Mermaid", team: PBTypes.TeamVals.LEFT, amountAlive: 3, maxHp: 100 });
    const abomination = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.LEFT,
        amountAlive: 1,
        maxHp: 500,
        stackPower: 5,
        abilities: ["Dense Flesh", "Flesh Shield Aura"],
        auraEffects: ["Flesh Shield"],
        auraRanges: [1],
        auraIsBuff: [true],
    });
    placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
    placeUnit(grid, unitsHolder, abomination, { x: 8, y: 2 });
    unitsHolder.refreshAuraEffectsForAllUnits();
    expect(target.getBuff("Flesh Shield Aura")).toBeDefined();
    return { grid, unitsHolder, attacker, target, abomination };
};

describe("G8: the protected unit's Water Shield answers before Flesh Shield", () => {
    it("a hit the Water Shield will absorb is not redirected onto the Abomination", () => {
        const { grid, unitsHolder, attacker, target, abomination } = shieldedPair();
        target.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
        const abominationHp = abomination.getCumulativeHp();

        const result = processFleshShieldAura(
            attacker,
            target,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(result.absorbedDamage).toBe(0);
        expect(result.remainingDamage).toBe(100);
        expect(abomination.getCumulativeHp()).toBe(abominationHp);
    });

    it("without a Water Shield the aura still takes its share", () => {
        const { grid, unitsHolder, attacker, target } = shieldedPair();

        const result = processFleshShieldAura(
            attacker,
            target,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(result.remainingDamage).toBeLessThan(100);
    });
});

describe("G9: secondary damage doesn't roll Break again", () => {
    it("Flesh Shield's absorbed share doesn't Break the Abomination", () => {
        const { grid, unitsHolder, attacker, target, abomination } = shieldedPair();
        FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam = () => 100;

        const result = processFleshShieldAura(
            attacker,
            target,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(result.absorbedDamage).toBeGreaterThan(0);
        expect(abomination.hasEffectActive("Break")).toBe(false);
    });

    it("Petrifying Gaze's extra kills don't Break the target a second time", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const medusa = createTestUnit({
            name: "Medusa",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Petrifying Gaze"],
            stackPower: 5,
        });
        const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LEFT, amountAlive: 20, maxHp: 10 });
        placeUnit(grid, unitsHolder, medusa, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, victim, { x: 2, y: 1 });
        FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam = () => 100;

        setDeterministicRandomSource(() => 0);
        try {
            processPetrifyingGazeAbility(medusa, victim, 100, new SceneLogMock(), new DamageStatisticHolder());
        } finally {
            setDeterministicRandomSource(undefined);
        }

        expect(victim.getAmountAlive()).toBeLessThan(20);
        expect(victim.hasEffectActive("Break")).toBe(false);
    });
});

describe("G11: Devour Essence and Infest agree about a kill that resurrects", () => {
    const hydraHealAfterKilling = (victimAbilities: string[]): number => {
        const { grid, unitsHolder } = createCombatTestContext();
        const hydra = createTestUnit({
            name: "Hydra",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Devour Essence"],
            stackPower: 5,
            amountAlive: 3,
            maxHp: 100,
        });
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.LEFT,
            abilities: victimAbilities,
            amountAlive: 2,
            maxHp: 50,
        });
        placeUnit(grid, unitsHolder, hydra, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, victim, { x: 3, y: 1 });
        hydra.applyDamage(60, 0, new SceneLogMock());
        victim.applyDamage(1_000, 0, new SceneLogMock());
        expect(victim.isDead()).toBe(true);
        const before = hydra.getCumulativeHp();

        processDevourEssenceAbility(hydra, [victim.getId()], unitsHolder, new SceneLogMock());
        return hydra.getCumulativeHp() - before;
    };

    it("heals on a stack that stays dead", () => {
        expect(hydraHealAfterKilling([])).toBeGreaterThan(0);
    });

    it("doesn't heal on a stack that will raise itself (Resurrection with its charge)", () => {
        expect(hydraHealAfterKilling(["Resurrection"])).toBe(0);
    });
});

const realUnit = (faction: string, creatureName: string, level: number, size: number, team = PBTypes.TeamVals.LEFT) => {
    const { abilityFactory, effectFactory } = createCombatFactories();
    return createUnitFromSpec(
        { faction, creatureName, level, size, amount: 10 },
        team,
        testGridSettings,
        abilityFactory,
        effectFactory,
    );
};

describe("C2: Swift Boots count melee-magic walkers as melee", () => {
    it("a Troll gets Swift Boots like any walker that fights in melee", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, Tier1Artifact.SWIFT_BOOTS);
        const troll = realUnit("Chaos", "Troll", 2, 1);
        placeUnit(grid, unitsHolder, troll, { x: 2, y: 2 });

        unitsHolder.applyArtifacts(fightProperties);

        expect(troll.getBuff("Swift Boots")).toBeDefined();
    });
});

describe("C3: Tome of Amplification strengthens Wind Flow's armor, not its slow", () => {
    it("an amplified Wind Flow gives +6 armor but still only −4 movement", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const pegasus = realUnit("Nature", "Pegasus", 3, 2);
        placeUnit(grid, unitsHolder, pegasus, { x: 6, y: 6 });
        unitsHolder.refreshStackPowerForAllUnits();
        const stepsBefore = pegasus.getSteps();
        const armorBefore = pegasus.getBaseArmor();
        const windFlow = new Spell({ spellProperties: getSpellConfig("System", "Wind Flow"), amount: 1 });
        windFlow.setPower(6);
        pegasus.applyBuff(windFlow);

        unitsHolder.refreshStackPowerForAllUnits();

        expect(pegasus.getSteps()).toBeCloseTo(stepsBefore - 4, 5);
        expect(pegasus.getBaseArmor()).toBeCloseTo(armorBefore + 6, 5);
    });
});

describe("C4: Rime Charm's Quagmire doesn't land on 100% magic resistance", () => {
    it("Enchanted Skin keeps the Black Dragon from being chilled", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.RIGHT, 2, Tier2Artifact.RIME_CHARM);
        const hitter = createTestUnit({ name: "Hitter", team: PBTypes.TeamVals.RIGHT });
        const skinned = createTestUnit({ name: "Skinned", team: PBTypes.TeamVals.LEFT, magicResist: 100 });
        const plain = createTestUnit({ name: "Plain", team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, hitter, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, skinned, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, plain, { x: 1, y: 2 });
        unitsHolder.applyArtifacts(fightProperties);

        setDeterministicRandomSource(() => 0);
        try {
            processRimeCharmAbility(hitter, skinned, new SceneLogMock());
            processRimeCharmAbility(hitter, plain, new SceneLogMock());
        } finally {
            setDeterministicRandomSource(undefined);
        }

        expect(skinned.hasDebuffActive("Quagmire")).toBe(false);
        expect(plain.hasDebuffActive("Quagmire")).toBe(true);
    });
});

describe("T1: cards say what the engine does", () => {
    const cardOf = (unit: Unit, abilityName: string): string => {
        const properties = unit.getUnitProperties();
        return properties.abilities_descriptions[properties.abilities.indexOf(abilityName)];
    };

    it("the Paralysis card shows the damage cut a landed Paralysis applies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const mantis = realUnit("Nature", "Mantis", 3, 2);
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.RIGHT });
        placeUnit(grid, unitsHolder, mantis, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, target, { x: 4, y: 3 });
        unitsHolder.refreshStackPowerForAllUnits();

        setDeterministicRandomSource(() => 0);
        try {
            processParalysisAbility(mantis, target, mantis, new SceneLogMock());
        } finally {
            setDeterministicRandomSource(undefined);
        }

        // A full stack: the effect's 40 plus the Mantis's luck, where the card used to print the ability's 50.
        const cut = target.getEffect("Paralysis")?.getPower();
        expect(cut).toBe(40 + mantis.getLuck());
        expect(cardOf(mantis, "Paralysis")).toContain("100% chance");
        expect(cardOf(mantis, "Paralysis")).toContain(`reduces their damage by ${cut}%`);
    });

    it("the Miner debuff records the armor it took", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const troglodyte = realUnit("Chaos", "Troglodyte", 1, 1);
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.RIGHT, armor: 10 });
        placeUnit(grid, unitsHolder, troglodyte, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, target, { x: 4, y: 3 });
        unitsHolder.refreshStackPowerForAllUnits();

        processMinerAbility(troglodyte, target, new SceneLogMock());

        const properties = target.getUnitProperties();
        const mined = target.getDebuff("Miner")?.getPower() ?? 0;
        expect(mined).toBeGreaterThan(0);
        expect(properties.applied_debuffs_powers[properties.applied_debuffs.indexOf("Miner")]).toBe(mined);
    });

    it("ability cards name the right target, trigger and bounce order", () => {
        const card = (abilityName: string): string => getAbilityConfig(abilityName).desc.join(" ");
        expect(card("Penetrating Bite")).toContain("of the target's max hp");
        expect(card("Bitter Experience")).toContain("loses creatures to a hit and survives");
        expect(card("Chakram")).toContain("bounce clockwise");
        expect(card("Magic Reflection")).toContain("that same percentage of the damage");
        expect(card("Mechanism")).not.toContain("vampirism");
        expect(card("Chain Lightning")).toContain("On attack or response");
    });
});

describe("G14: a second Chakram throw scales its bounces like the first", () => {
    it("a bounce across a two-cell gap takes half on both throws of a Crafted Double Shot", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            amountAlive: 1,
            abilities: ["Chakram", "Crafted Double Shot"],
            stackPower: 5,
        });
        const primary = createTestUnit({
            name: "Primary",
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 10_000,
            amountAlive: 1,
        });
        const far = createTestUnit({ name: "Far", team: PBTypes.TeamVals.RIGHT, maxHp: 10_000, amountAlive: 1 });
        placeUnit(grid, unitsHolder, zena, { x: 8, y: 2 });
        placeUnit(grid, unitsHolder, primary, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, far, { x: 8, y: 11 });
        zena.calculateMissChance = () => 0;
        zena.calculateAttackDamage = () => 100;
        const primaryBefore = primary.getCumulativeHp();
        const farBefore = far.getCumulativeHp();

        attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            createVisibleDamage(primary),
            zena,
            [[primary]],
            undefined,
            primary.getPosition(),
        );

        expect(primaryBefore - primary.getCumulativeHp()).toBe(200);
        // 50 + 50: the second throw used to land the half-strength bounce at full (50 + 100).
        expect(farBefore - far.getCumulativeHp()).toBe(100);
    });
});
