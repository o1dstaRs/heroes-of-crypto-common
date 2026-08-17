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

import { describe, expect, it } from "bun:test";

import { getChainLightningTargets, processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ELEMENT_COUNTER_MULTIPLIER } from "../../src/spells/spell_damage";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

/**
 * Chain Lightning is WIND, so the element table decides who it can touch and how hard:
 *   - a Wind Element EARTHS the bolt — takes nothing, and screens everything behind it;
 *   - an Earth Element (Gargantuan, Trent) takes 50% more;
 *   - everyone else takes it straight.
 */

const ENEMY = PBTypes.TeamVals.LOWER;
const OURS = PBTypes.TeamVals.UPPER;
const SWING = 40;

/** Thunderbird itself: a Wind Element that carries the ability. */
const thunderbird = () =>
    createTestUnit({
        name: "Thunderbird",
        team: OURS,
        abilities: ["Wind Element", "Chain Lightning"],
        attack: 20,
        damageMin: 20,
        damageMax: 20,
        stackPower: 5,
    });

const victim = (name: string, abilities: string[] = []) =>
    createTestUnit({ name, team: ENEMY, abilities, amountAlive: 30, maxHp: 200 });

const hpLost = (unit: ReturnType<typeof victim>, before: number) => before - unit.getCumulativeHp();

describe("Chain Lightning — Earth Elements take 50% more", () => {
    it("burns an Earth Element primary target for half again a plain one", () => {
        const measure = (abilities: string[]): number => {
            const { grid, unitsHolder } = createCombatTestContext();
            const attacker = thunderbird();
            const target = victim("Target", abilities);
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
            const before = target.getCumulativeHp();
            // Model the caller faithfully: calculateAttackDamage has ALREADY priced the attacker's
            // affinity against the primary, so a Wind swing at an Earth target arrives pre-multiplied.
            // Feeding the same raw number for both would understate the plain case, not overstate Earth.
            const swing = Math.floor(SWING * attacker.getElementalDamageMultiplier(target));
            processChainLightningAbility(
                attacker,
                target,
                swing,
                grid,
                unitsHolder,
                new SceneLogMock(),
                new DamageStatisticHolder(),
            );
            return hpLost(target, before);
        };

        const plain = measure([]);
        const earth = measure(["Earth Element"]);

        expect(plain).toBeGreaterThan(0);
        expect(earth).toBe(Math.floor(plain * ELEMENT_COUNTER_MULTIPLIER));
    });

    it("burns an Earth Element BOUNCE victim too, not just the aimed one", () => {
        const measure = (bounceAbilities: string[]): number => {
            const { grid, unitsHolder } = createCombatTestContext();
            const attacker = thunderbird();
            const target = victim("Target");
            const bounce = victim("Bounce", bounceAbilities);
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
            placeUnit(grid, unitsHolder, bounce, { x: 5, y: 6 });
            const before = bounce.getCumulativeHp();
            processChainLightningAbility(
                attacker,
                target,
                SWING,
                grid,
                unitsHolder,
                new SceneLogMock(),
                new DamageStatisticHolder(),
            );
            return hpLost(bounce, before);
        };

        const plain = measure([]);
        const earth = measure(["Earth Element"]);

        expect(plain).toBeGreaterThan(0);
        expect(earth).toBe(Math.floor(plain * ELEMENT_COUNTER_MULTIPLIER));
    });

    it("Gargantuan and Trent — the game's actual Earth Elements — both take the bonus", () => {
        for (const name of ["Gargantuan", "Trent"]) {
            const { grid, unitsHolder } = createCombatTestContext();
            const attacker = thunderbird();
            const plainTarget = victim("Plain");
            const earthTarget = victim(name, ["Earth Element"]);
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, plainTarget, { x: 5, y: 5 });
            placeUnit(grid, unitsHolder, earthTarget, { x: 5, y: 6 });
            const plainBefore = plainTarget.getCumulativeHp();
            const earthBefore = earthTarget.getCumulativeHp();

            processChainLightningAbility(
                attacker,
                plainTarget,
                SWING,
                grid,
                unitsHolder,
                new SceneLogMock(),
                new DamageStatisticHolder(),
            );

            // The bounce is priced at 7/8 of the primary's arc, so compare each against itself: the
            // point is only that the Earth creature took strictly more than its share would otherwise be.
            expect(`${name}: ${hpLost(earthTarget, earthBefore) > 0}`).toBe(`${name}: true`);
            expect(`${name}: ${hpLost(plainTarget, plainBefore) > 0}`).toBe(`${name}: true`);
        }
    });

    it("does not count the bonus twice when the swing already priced it", () => {
        // REGRESSION: the damage handed to the ability comes from calculateAttackDamage, which has
        // ALREADY multiplied a Wind attacker's swing against an Earth target. Applying the element
        // again on top would land 2.25x instead of 1.5x — and, worse, inflate every bounce with the
        // primary's affinity. The ability divides that factor back out before pricing each arc.
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const earthPrimary = victim("Earth Primary", ["Earth Element"]);
        const plainBounce = victim("Plain Bounce");
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, earthPrimary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, plainBounce, { x: 5, y: 6 });
        const bounceBefore = plainBounce.getCumulativeHp();

        // The swing a Wind attacker actually produces against an Earth target.
        const preMultipliedSwing = Math.floor(SWING * ELEMENT_COUNTER_MULTIPLIER);
        processChainLightningAbility(
            attacker,
            earthPrimary,
            preMultipliedSwing,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );
        const inflatedBounce = hpLost(plainBounce, bounceBefore);

        // Same layout, but the primary is plain, so the swing carries no elemental factor at all.
        const control = createCombatTestContext();
        const controlAttacker = thunderbird();
        const plainPrimary = victim("Plain Primary");
        const controlBounce = victim("Plain Bounce");
        placeUnit(control.grid, control.unitsHolder, controlAttacker, { x: 1, y: 1 });
        placeUnit(control.grid, control.unitsHolder, plainPrimary, { x: 5, y: 5 });
        placeUnit(control.grid, control.unitsHolder, controlBounce, { x: 5, y: 6 });
        const controlBefore = controlBounce.getCumulativeHp();
        processChainLightningAbility(
            controlAttacker,
            plainPrimary,
            SWING,
            control.grid,
            control.unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        // A plain bystander takes the same jolt either way: who stood at the front is not its business.
        expect(inflatedBounce).toBe(hpLost(controlBounce, controlBefore));
    });
});

describe("Chain Lightning — Wind Elements earth the bolt", () => {
    it("cannot be aimed at a Wind Element at all", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const windTarget = victim("Wind Target", ["Wind Element"]);
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, windTarget, { x: 5, y: 5 });
        const before = windTarget.getCumulativeHp();

        processChainLightningAbility(
            attacker,
            windTarget,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(windTarget, before)).toBe(0);
        expect(getChainLightningTargets(windTarget, grid, unitsHolder)).toEqual([]);
    });

    it("takes no damage as a bounce victim", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const target = victim("Target");
        const wind = victim("Wind Bystander", ["Wind Element"]);
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, wind, { x: 5, y: 6 });
        const before = wind.getCumulativeHp();

        processChainLightningAbility(
            attacker,
            target,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(wind, before)).toBe(0);
        expect(getChainLightningTargets(target, grid, unitsHolder).map((u) => u.getName())).not.toContain(
            "Wind Bystander",
        );
    });

    it("SCREENS the creature behind it: the chain stops rather than arcing around", () => {
        // Target -> Wind -> Behind, in a line. Without the screen the chain would reach "Behind";
        // the Wind Element earths the bolt and everything past it is spared.
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const target = victim("Target");
        const wind = victim("Wind Screen", ["Wind Element"]);
        const behind = victim("Behind");
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, wind, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 7 });
        const windBefore = wind.getCumulativeHp();
        const behindBefore = behind.getCumulativeHp();

        processChainLightningAbility(
            attacker,
            target,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(wind, windBefore)).toBe(0);
        expect(hpLost(behind, behindBefore)).toBe(0);
        const names = getChainLightningTargets(target, grid, unitsHolder).map((u) => u.getName());
        expect(names).not.toContain("Wind Screen");
        expect(names).not.toContain("Behind");
    });

    it("the primary target still takes its own jolt before the screen stops the spread", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const target = victim("Target");
        const wind = victim("Wind Screen", ["Wind Element"]);
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, wind, { x: 5, y: 6 });
        const before = target.getCumulativeHp();

        processChainLightningAbility(
            attacker,
            target,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(target, before)).toBeGreaterThan(0);
    });

    it("100% magic resist is NOT a screen — its neighbours in the same layer are still struck", () => {
        // The two immunities differ in KIND. A Wind Element halts the walk outward for everyone (see
        // above); 100% magic resist merely declines its own arc, and the chain keeps working through
        // the rest of that layer. Both units below sit in layer 1, so this holds whichever order the
        // layer happens to be visited in.
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const target = victim("Target");
        const immune = createTestUnit({
            name: "Immune",
            team: ENEMY,
            amountAlive: 30,
            maxHp: 200,
            magicResist: 100,
        });
        const sibling = victim("Sibling");
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, immune, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, sibling, { x: 4, y: 5 });
        const immuneBefore = immune.getCumulativeHp();
        const siblingBefore = sibling.getCumulativeHp();

        processChainLightningAbility(
            attacker,
            target,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(immune, immuneBefore)).toBe(0);
        expect(hpLost(sibling, siblingBefore)).toBeGreaterThan(0);
    });

    it("a Wind Element in a layer stops that layer's spread, unlike a merely resistant one", () => {
        // Same layout as above with the immune unit swapped for a Wind Element: nothing beyond the
        // primary is reached at all, because the bolt earths itself instead of arcing on.
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = thunderbird();
        const target = victim("Target");
        const wind = victim("Wind Screen", ["Wind Element"]);
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, wind, { x: 5, y: 6 });

        const names = getChainLightningTargets(target, grid, unitsHolder).map((u) => u.getName());

        expect(names).toEqual(["Target"]);
    });
});

describe("Chain Lightning — the element rule belongs to the ability, not the wielder", () => {
    it("a non-Wind body that borrowed Chain Lightning still burns Earth Elements", () => {
        // Precedent: a stolen Chakram still flies. The arc is wind because the ABILITY is wind.
        const measure = (targetAbilities: string[]): number => {
            const { grid, unitsHolder } = createCombatTestContext();
            const borrower = createTestUnit({
                name: "Borrower",
                team: OURS,
                abilities: ["Chain Lightning"],
                attack: 20,
                damageMin: 20,
                damageMax: 20,
                stackPower: 5,
            });
            const target = victim("Target", targetAbilities);
            placeUnit(grid, unitsHolder, borrower, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
            const before = target.getCumulativeHp();
            processChainLightningAbility(
                borrower,
                target,
                SWING,
                grid,
                unitsHolder,
                new SceneLogMock(),
                new DamageStatisticHolder(),
            );
            return hpLost(target, before);
        };

        expect(measure(["Earth Element"])).toBe(Math.floor(measure([]) * ELEMENT_COUNTER_MULTIPLIER));
    });

    it("a non-Wind body still cannot touch a Wind Element", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const borrower = createTestUnit({
            name: "Borrower",
            team: OURS,
            abilities: ["Chain Lightning"],
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
        });
        const wind = victim("Wind Target", ["Wind Element"]);
        placeUnit(grid, unitsHolder, borrower, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, wind, { x: 5, y: 5 });
        const before = wind.getCumulativeHp();

        processChainLightningAbility(
            borrower,
            wind,
            SWING,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(hpLost(wind, before)).toBe(0);
    });
});
