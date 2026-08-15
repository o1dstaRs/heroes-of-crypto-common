/*
 * -----------------------------------------------------------------------------
 * Flesh Shield Aura (Abomination) — the PHYSICAL-ONLY rule, from every angle.
 *
 * The aura is flesh, not a ward: it soaks physical blows and lets magic through.
 * Every case here uses the same shape — one protected ally with a 100%-absorb
 * Abomination beside it, equal armor on both so a redirected point costs exactly
 * one HP — so the whole matrix reads as "ally keeps it" vs "owner pays it".
 *
 * Cast spells (Fire Strike / Meteorite / Ring of Fire, plus Magic Mirror rebounds)
 * are covered end-to-end through GameActionEngine in spells/spell_flesh_shield.test.ts
 * and spells/magic_dragon.test.ts. The absorption ARITHMETIC (stack power, luck,
 * armor ratios, overflow, AOE aggregation) lives in abomination_abilities.test.ts.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processSkewerStrikeAbility } from "../../src/abilities/skewer_strike_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

const HIT = 100;

/** luck 10 on a full stack lifts the aura's base 90% to the 100% cap — absorption becomes all-or-nothing. */
const makeAbomination = () =>
    createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.LOWER,
        maxHp: 10_000,
        armor: 20,
        luck: 10,
        stackPower: 5,
        abilities: ["Flesh Shield Aura"],
        auraEffects: ["Flesh Shield"],
        auraRanges: [1],
        auraIsBuff: [true],
    });

const makeProtectedAlly = () =>
    createTestUnit({
        name: "Protected Ally",
        team: PBTypes.TeamVals.LOWER,
        maxHp: 10_000,
        armor: 20,
        magicResist: 0,
    });

const fleshShieldEntries = (secondary: readonly ISecondaryDamage[]) =>
    secondary.filter((entry) => entry.source === "flesh_shield");

/**
 * Attacker -> aimed decoy -> protected ally, all on one row, with the Abomination one cell off it. Both
 * sweeping abilities (Fire Breath, Skewer Strike) walk this exact line, so swapping the ability is the
 * only difference between the magical case and the physical one. The aimed decoy belongs to the caller's
 * own attack and is never part of the sweep (each test re-checks that it takes nothing), so the ally's
 * single 100-point share is the only damage in play.
 */
const setupSweep = (abilityName: string) => {
    const context = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Sweeper",
        team: PBTypes.TeamVals.UPPER,
        attackType: PBTypes.AttackVals.MELEE,
        abilities: [abilityName],
    });
    const decoy = createTestUnit({ name: "Aimed Decoy", team: PBTypes.TeamVals.LOWER, maxHp: 10_000, armor: 20 });
    const ally = makeProtectedAlly();
    const abomination = makeAbomination();
    attacker.calculateMissChance = () => 0;
    attacker.calculateAttackDamage = () => HIT;

    placeUnit(context.grid, context.unitsHolder, attacker, { x: 1, y: 1 });
    placeUnit(context.grid, context.unitsHolder, decoy, { x: 2, y: 1 });
    placeUnit(context.grid, context.unitsHolder, ally, { x: 3, y: 1 });
    placeUnit(context.grid, context.unitsHolder, abomination, { x: 4, y: 2 });
    context.unitsHolder.refreshAuraEffectsForAllUnits();

    // The aura must reach the swept ally, or the A/B proves nothing.
    expect(ally.hasBuffActive("Flesh Shield Aura")).toBe(true);

    return { ...context, attacker, decoy, ally, abomination };
};

const hpLost = (unit: Unit, before: number) => before - unit.getCumulativeHp();

describe("Flesh Shield aura absorbs PHYSICAL damage", () => {
    it("takes over a direct melee blow aimed at the protected ally", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const abomination = makeAbomination();
        const ally = makeProtectedAlly();
        const attacker = createTestUnit({
            name: "Brawler",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        attacker.calculateMissChance = () => 0;
        attacker.calculateAttackDamage = () => HIT;

        placeUnit(grid, unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, attacker, { x: 4, y: 2 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const allyHpBefore = ally.getCumulativeHp();
        const abominationHpBefore = abomination.getCumulativeHp();
        const damageForAnimation = createVisibleDamage(ally);

        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            damageForAnimation,
            undefined,
            attacker,
            ally,
            { x: 4, y: 2 },
        );

        expect(result.completed).toBe(true);
        expect(hpLost(ally, allyHpBefore)).toBe(0);
        expect(hpLost(abomination, abominationHpBefore)).toBe(HIT);
        expect(fleshShieldEntries(damageForAnimation.secondary ?? [])).toEqual([
            expect.objectContaining({ unitId: abomination.getId(), amount: HIT }),
        ]);
    });

    it("takes over a melee RESPONSE landing on the protected ally", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const abomination = makeAbomination();
        const ally = makeProtectedAlly();
        const responder = createTestUnit({
            name: "Counter-puncher",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 10_000,
        });
        ally.calculateMissChance = () => 0;
        ally.calculateAttackDamage = () => 1;
        responder.calculateMissChance = () => 0;
        responder.calculateAttackDamage = () => HIT;

        placeUnit(grid, unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, responder, { x: 4, y: 2 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const allyHpBefore = ally.getCumulativeHp();
        const abominationHpBefore = abomination.getCumulativeHp();

        // The protected ally swings first; the counter-punch is what the aura has to catch.
        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(responder),
            undefined,
            ally,
            responder,
            { x: 3, y: 2 },
        );

        expect(result.completed).toBe(true);
        expect(hpLost(ally, allyHpBefore)).toBe(0);
        expect(hpLost(abomination, abominationHpBefore)).toBe(HIT);
    });

    it("takes over a ranged shot aimed at the protected ally", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const abomination = makeAbomination();
        const ally = makeProtectedAlly();
        const shooter = createTestUnit({
            name: "Archer",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        shooter.calculateMissChance = () => 0;
        shooter.calculateAttackDamage = () => HIT;

        placeUnit(grid, unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, shooter, { x: 8, y: 2 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const allyHpBefore = ally.getCumulativeHp();
        const abominationHpBefore = abomination.getCumulativeHp();
        const damageForAnimation = createVisibleDamage(ally);

        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            damageForAnimation,
            shooter,
            [[ally]],
            undefined,
            ally.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(hpLost(ally, allyHpBefore)).toBe(0);
        expect(hpLost(abomination, abominationHpBefore)).toBe(HIT);
        expect(fleshShieldEntries(damageForAnimation.secondary ?? [])).toEqual([
            expect.objectContaining({ unitId: abomination.getId(), amount: HIT }),
        ]);
    });

    it("takes over a Skewer Strike sweep that reaches the protected ally", () => {
        const { grid, unitsHolder, damageStatisticHolder, attacker, decoy, ally, abomination } =
            setupSweep("Skewer Strike");
        const allyHpBefore = ally.getCumulativeHp();
        const abominationHpBefore = abomination.getCumulativeHp();
        const decoyHpBefore = decoy.getCumulativeHp();
        const secondary: ISecondaryDamage[] = [];

        processSkewerStrikeAbility(
            attacker,
            decoy,
            new SceneLogMock(),
            unitsHolder,
            grid,
            damageStatisticHolder,
            undefined,
            true,
            secondary,
        );

        expect(hpLost(decoy, decoyHpBefore)).toBe(0);
        expect(hpLost(ally, allyHpBefore)).toBe(0);
        expect(hpLost(abomination, abominationHpBefore)).toBe(HIT);
        expect(fleshShieldEntries(secondary)).toEqual([
            expect.objectContaining({ unitId: abomination.getId(), amount: HIT }),
        ]);
    });
});

describe("Flesh Shield aura ignores MAGICAL damage", () => {
    it("lets a Fire Breath sweep burn the protected ally in full", () => {
        // Same line, same 100 damage, same aura as the Skewer Strike case above — only the ability differs.
        const { grid, unitsHolder, damageStatisticHolder, attacker, decoy, ally, abomination } =
            setupSweep("Fire Breath");
        const allyHpBefore = ally.getCumulativeHp();
        const abominationHpBefore = abomination.getCumulativeHp();
        const decoyHpBefore = decoy.getCumulativeHp();
        const secondary: ISecondaryDamage[] = [];

        processFireBreathAbility(
            attacker,
            decoy,
            new SceneLogMock(),
            unitsHolder,
            grid,
            "attk",
            damageStatisticHolder,
            undefined,
            secondary,
        );

        expect(hpLost(decoy, decoyHpBefore)).toBe(0);
        expect(hpLost(ally, allyHpBefore)).toBe(HIT);
        expect(hpLost(abomination, abominationHpBefore)).toBe(0);
        expect(fleshShieldEntries(secondary)).toEqual([]);
    });

    it("lets every Chain Lightning arc land where it struck — the aimed jolt and the bounces alike", () => {
        const context = createCombatTestContext();
        const caster = createTestUnit({
            name: "Storm Caller",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            stackPower: 5,
            abilities: ["Chain Lightning"],
        });
        const aimedAlly = makeProtectedAlly();
        const bounceAlly = makeProtectedAlly();
        const abomination = makeAbomination();

        placeUnit(context.grid, context.unitsHolder, caster, { x: 4, y: 2 });
        placeUnit(context.grid, context.unitsHolder, aimedAlly, { x: 3, y: 2 });
        placeUnit(context.grid, context.unitsHolder, bounceAlly, { x: 2, y: 1 });
        placeUnit(context.grid, context.unitsHolder, abomination, { x: 2, y: 2 });
        context.unitsHolder.refreshAuraEffectsForAllUnits();
        // Both the aimed target and a unit the lightning arcs onward to are inside the aura, so the two
        // separate call paths (primary jolt, per-layer bounce) are each exercised.
        expect(aimedAlly.hasBuffActive("Flesh Shield Aura")).toBe(true);
        expect(bounceAlly.hasBuffActive("Flesh Shield Aura")).toBe(true);

        const before = new Map(
            [aimedAlly, bounceAlly, abomination].map((unit) => [unit.getId(), unit.getCumulativeHp()]),
        );
        const secondary: ISecondaryDamage[] = [];

        processChainLightningAbility(
            caster,
            aimedAlly,
            HIT,
            context.grid,
            context.unitsHolder,
            new SceneLogMock(),
            context.damageStatisticHolder,
            secondary,
        );

        // Every arc is magical, so each struck unit keeps exactly what its own arc reported — including the
        // Abomination, which pays for its own bounce and not one point more.
        expect(fleshShieldEntries(secondary)).toEqual([]);
        for (const unit of [aimedAlly, bounceAlly, abomination]) {
            const arc = secondary.find((entry) => entry.source === "chain_lightning" && entry.unitId === unit.getId());
            expect(arc?.amount).toBeGreaterThan(0);
            expect(hpLost(unit, before.get(unit.getId()) ?? 0)).toBe(arc?.amount);
        }
    });
});

describe("Flesh Shield aura wiring", () => {
    /**
     * The `damageType` parameter is gone, so no caller can ask for a magical transfer any more — the only
     * way the rule can rot is a MAGIC module starting to call the aura at all. Pin the caller set: adding a
     * physical AOE here is a one-line edit, wiring up a magical one has to be argued for.
     */
    it("is called only from physical damage paths", () => {
        const sourceRoot = join(import.meta.dir, "..", "..", "src");
        const sourceFiles: string[] = [];
        const walk = (directory: string) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const entryPath = join(directory, entry.name);
                if (entry.isDirectory()) {
                    walk(entryPath);
                } else if (entry.name.endsWith(".ts")) {
                    sourceFiles.push(entryPath);
                }
            }
        };
        walk(sourceRoot);

        const callers = sourceFiles
            .filter((file) => readFileSync(file, "utf8").includes("processFleshShieldAura("))
            .map((file) => file.slice(sourceRoot.length + 1).replaceAll("\\", "/"))
            .sort();

        expect(callers).toEqual([
            "abilities/aoe_range_ability.ts", // Area Throw splash
            "abilities/double_shot_ability.ts", // second arrow
            "abilities/flesh_shield_aura_ability.ts", // the definition itself
            "abilities/lightning_spin_ability.ts", // radial melee sweep
            "abilities/skewer_strike_ability.ts", // line melee sweep
            "abilities/through_shot_ability.ts", // pass-through arrow
            "handlers/attack_handler.ts", // melee/range hits, responses, second punch
        ]);
    });

    it("keeps the engine's own magical abilities out of that set", () => {
        // EMPOWERED_MAGIC_ABILITIES in unit.ts is the engine's list of magic-damage abilities. Chain
        // Lightning and Fire Breath must not route through the aura; Fire Shield never did.
        for (const magicModule of [
            "abilities/chain_lightning_ability.ts",
            "abilities/fire_breath_ability.ts",
            "abilities/fire_shield_ability.ts",
            "engine/action_engine.ts", // every cast spell lands here
        ]) {
            const source = readFileSync(join(import.meta.dir, "..", "..", "src", magicModule), "utf8");
            expect(source).not.toContain("processFleshShieldAura");
        }
    });
});

describe("Flesh Shield descriptions", () => {
    it("tell the player the aura is physical-only, on both the ability and the aura card", () => {
        const abilities = JSON.parse(
            readFileSync(join(import.meta.dir, "..", "..", "src", "configuration", "abilities.json"), "utf8"),
        );
        const auraEffects = JSON.parse(
            readFileSync(join(import.meta.dir, "..", "..", "src", "configuration", "aura_effects.json"), "utf8"),
        );

        const abilityDesc = (abilities["Flesh Shield Aura"].desc as string[]).join(" ");
        const auraDesc = auraEffects["Flesh Shield"].desc as string;

        for (const text of [abilityDesc, auraDesc]) {
            expect(text).toContain("physical");
            expect(text).toContain("Magical damage is not absorbed");
            // "defense" was the old wording from when magic resistance could carry the transfer.
            expect(text).not.toContain("defense");
        }
    });
});
