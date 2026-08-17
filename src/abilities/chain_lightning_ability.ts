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

import * as EffectHelper from "../effects/effect_helper";
import * as HoCConstants from "../constants";
import * as HoCLib from "../utils/lib";
import { Grid } from "../grid/grid";
import * as HoCMath from "../utils/math";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { Unit } from "../units/unit";
import type { ISceneLog } from "../scene/scene_log_interface";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";
import { applyMagicMirrorDamage } from "../spells/magic_mirror_damage";
import { elementalSpellMultiplier } from "../spells/spell_damage";
import { SpellElement } from "../spells/spell_properties";

interface ILayerImpact {
    cells: HoCMath.XY[];
    damage: number;
    moraleIncrease: number;
    enemyName: string;
    enemyMinusMorale: number;
}

/**
 * Chain Lightning is WIND, so every arc is priced by the same element table an air spell uses:
 * a Wind Element takes NOTHING, an Earth Element takes {@link ELEMENT_COUNTER_MULTIPLIER} (50% more),
 * everyone else takes it straight.
 *
 * Deliberately keyed off the VICTIM's element and the ability's own element — never off who is
 * swinging. A Chain Lightning stolen onto a body that is not Wind still burns Earth Elements,
 * exactly as a stolen Chakram still flies.
 */
const chainElementMultiplier = (target: Unit): number =>
    elementalSpellMultiplier({
        element: SpellElement.AIR,
        targetIsFireElement: target.hasAbilityActive("Fire Element"),
        targetIsWaterElement: target.hasAbilityActive("Water Element"),
        targetIsWindElement: target.hasAbilityActive("Wind Element"),
        targetIsEarthElement: target.hasAbilityActive("Earth Element"),
    });

/** Set once a Wind Element earths the bolt, so the caller stops walking outward. */
interface IChainHalt {
    value: boolean;
}

function getEnemiesForCells(
    cells: HoCMath.XY[],
    enemyTeam: TeamType,
    grid: Grid,
    unitsHolder: UnitsHolder,
    alreadyAffectedIds: string[],
): Unit[] {
    const enemies: Unit[] = [];
    for (const c of cells) {
        const auraCells = EffectHelper.getAuraCells(grid.getSettings(), c, 1);
        for (const ac of auraCells) {
            const occupantId = grid.getOccupantUnitId(ac);
            if (!occupantId || alreadyAffectedIds.includes(occupantId)) {
                continue;
            }

            const occupantUnit = unitsHolder.getAllUnits().get(occupantId);
            if (!occupantUnit || enemyTeam !== occupantUnit.getTeam()) {
                continue;
            }

            if (!enemies.includes(occupantUnit)) {
                enemies.push(occupantUnit);
            }
        }
    }

    return enemies;
}

function attackEnemiesAndGetLayerImpact(
    fromUnit: Unit,
    enemies: Unit[],
    attackDamage: number,
    multiplier: number,
    abilityMultiplier: number,
    alreadyAffectedIds: string[],
    sceneLog: ISceneLog,
    unitIdsDied: string[],
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    halt: IChainHalt,
    secondaryDamage?: ISecondaryDamage[],
): ILayerImpact[] {
    const fullLayerImpact: ILayerImpact[] = [];
    for (const e1 of enemies) {
        let moraleIncrease = 0;
        const enemyMagicResist = e1.getMagicResist();
        // A Wind Element is a SCREEN, not just an immune bystander: the bolt earths itself on the one
        // creature made of the same stuff and travels no further, so everything behind it is spared.
        // 100% magic resist is NOT the same thing — that shrugs its own arc off and lets the chain
        // carry on past it.
        const elementMultiplier = chainElementMultiplier(e1);
        if (elementMultiplier <= 0) {
            sceneLog.updateLog(`${e1.getName()} earthed the Chain Lightning`);
            halt.value = true;
            break;
        }
        if (enemyMagicResist === 100) {
            continue;
        }

        const heavyArmorAbilityEnemy = e1.getAbility("Heavy Armor");
        let heavyArmorMultiplierEnemy = 1;
        if (heavyArmorAbilityEnemy) {
            heavyArmorMultiplierEnemy = Number(
                (
                    ((heavyArmorAbilityEnemy.getPower() + e1.getLuck()) / 100 / HoCConstants.MAX_UNIT_STACK_POWER) *
                        e1.getStackPower() +
                    1
                ).toFixed(2),
            );
        }

        const targetEnemyLightningDamage = Math.floor(
            ((abilityMultiplier * multiplier) / 8) *
                attackDamage *
                elementMultiplier *
                (1 - enemyMagicResist / 100) *
                heavyArmorMultiplierEnemy,
        );

        alreadyAffectedIds.push(e1.getId());
        let enemyMinusMorale = 0;
        if (targetEnemyLightningDamage && !e1.isDead()) {
            // ABILITY Flesh Shield Aura (Abomination) does NOT apply: the aura soaks physical damage only and
            // every arc of Chain Lightning is magical, so a protected bounce target keeps the whole jolt.
            const e1AmountBefore = e1.getAmountAlive();
            const positionAtImpact = { ...e1.getPosition() };
            const damageDealt = e1.applyDamage(targetEnemyLightningDamage, 0 /* magic attack */, sceneLog);
            damageStatisticHolder.add({
                unitName: fromUnit.getName(),
                damage: damageDealt,
                team: fromUnit.getTeam(),
                lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
            });
            secondaryDamage?.push({
                source: "chain_lightning",
                unitId: e1.getId(),
                position: positionAtImpact,
                amount: damageDealt,
                unitsDied: Math.max(0, e1AmountBefore - e1.getAmountAlive()),
            });
            sceneLog.updateLog(
                `${e1.getName()} got hit ${targetEnemyLightningDamage} by Chain Lightning` +
                    HoCLib.killTag(e1AmountBefore - e1.getAmountAlive()),
            );
            const mirror = applyMagicMirrorDamage({
                attacker: fromUnit,
                holder: e1,
                landedOnHolder: targetEnemyLightningDamage,
                element: SpellElement.AIR,
                sceneLog,
                secondaryDamage,
            });
            if (mirror?.unitDied && !unitIdsDied.includes(fromUnit.getId())) {
                unitIdsDied.push(fromUnit.getId());
            }

            if (e1.isDead() && !unitIdsDied.includes(e1.getId())) {
                sceneLog.updateLog(`${e1.getName()} died`);
                unitIdsDied.push(e1.getId());
                moraleIncrease += HoCConstants.MORALE_CHANGE_FOR_KILL;
                enemyMinusMorale = HoCConstants.MORALE_CHANGE_FOR_KILL;
            }
        }

        fullLayerImpact.push({
            cells: e1.getCells(),
            damage: targetEnemyLightningDamage,
            moraleIncrease,
            enemyName: e1.getName(),
            enemyMinusMorale,
        });
    }

    return fullLayerImpact;
}

export function processChainLightningAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    attackDamage: number,
    grid: Grid,
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
): string[] {
    const unitIdsDied: string[] = [];
    const chainLightningAbility = fromUnit.getAbility("Chain Lightning");
    if (!chainLightningAbility || !attackDamage) {
        return unitIdsDied;
    }

    const targetMagicResist = targetUnit.getMagicResist();
    const targetElementMultiplier = chainElementMultiplier(targetUnit);
    if (targetMagicResist === 100 || targetElementMultiplier <= 0) {
        sceneLog.updateLog(`${targetUnit.getName()} resisted from Chain Lightning`);
        return unitIdsDied;
    }

    // The swing that fed us was ALREADY priced with the attacker's own elemental affinity against
    // this primary target (Thunderbird is Wind, so an Earth primary came in pre-multiplied). Divide
    // that back out and let every arc — the primary's included — be priced exactly once, below, by
    // the ability's own element. Without this the primary took the bonus twice and, worse, every
    // bounce inherited a base inflated by whoever happened to be standing at the front.
    const wielderAffinity = fromUnit.getElementalDamageMultiplier(targetUnit) || 1;
    const chainBaseDamage = attackDamage / wielderAffinity;

    const heavyArmorAbilityTarget = targetUnit.getAbility("Heavy Armor");
    let heavyArmorMultiplierTarget = 1;
    if (heavyArmorAbilityTarget) {
        heavyArmorMultiplierTarget = Number(
            (
                ((heavyArmorAbilityTarget.getPower() + targetUnit.getLuck()) /
                    100 /
                    HoCConstants.MAX_UNIT_STACK_POWER) *
                    targetUnit.getStackPower() +
                1
            ).toFixed(2),
        );
    }

    const abilityMultiplier = fromUnit.calculateAbilityMultiplier(
        chainLightningAbility,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
    );
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    let totalMoraleIncrease = 0;
    const targetEnemyLightningDamage =
        Math.floor(abilityMultiplier * chainBaseDamage * targetElementMultiplier * (1 - targetMagicResist / 100)) *
        heavyArmorMultiplierTarget;
    if (targetEnemyLightningDamage && !targetUnit.isDead()) {
        // Flesh Shield is physical-only, so this magical jolt is never redirected to a nearby Abomination.
        const targetAmountBefore = targetUnit.getAmountAlive();
        const targetPositionAtImpact = { ...targetUnit.getPosition() };
        const damageDealt = targetUnit.applyDamage(targetEnemyLightningDamage, 0 /* magic attack */, sceneLog);
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: damageDealt,
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });
        secondaryDamage?.push({
            source: "chain_lightning",
            unitId: targetUnit.getId(),
            position: targetPositionAtImpact,
            amount: damageDealt,
            unitsDied: Math.max(0, targetAmountBefore - targetUnit.getAmountAlive()),
        });
        sceneLog.updateLog(
            `${targetUnit.getName()} got hit ${targetEnemyLightningDamage} by Chain Lightning` +
                HoCLib.killTag(targetAmountBefore - targetUnit.getAmountAlive()),
        );
        const mirror = applyMagicMirrorDamage({
            attacker: fromUnit,
            holder: targetUnit,
            landedOnHolder: targetEnemyLightningDamage,
            element: SpellElement.AIR,
            sceneLog,
            secondaryDamage,
        });
        if (mirror?.unitDied && !unitIdsDied.includes(fromUnit.getId())) {
            unitIdsDied.push(fromUnit.getId());
        }
    }

    if (targetUnit.isDead()) {
        sceneLog.updateLog(`${targetUnit.getName()} died`);
        unitIdsDied.push(targetUnit.getId());
        totalMoraleIncrease += HoCConstants.MORALE_CHANGE_FOR_KILL;
        moraleDecreaseForTheUnitTeam[`${targetUnit.getName()}:${targetUnit.getTeam()}`] =
            HoCConstants.MORALE_CHANGE_FOR_KILL;
    }

    const affectedEnemiesIds: string[] = [targetUnit.getId()];

    const enemiesLayer1: Unit[] = getEnemiesForCells(
        targetUnit.getCells(),
        targetUnit.getTeam(),
        grid,
        unitsHolder,
        affectedEnemiesIds,
    );
    if (!enemiesLayer1.length) {
        fromUnit.increaseMorale(
            totalMoraleIncrease,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(fromUnit.getTeam()),
        );
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
        return unitIdsDied;
    }

    // Once a Wind Element earths the bolt anywhere along the chain, the walk outward stops entirely —
    // it screens every creature the chain had not reached yet, not merely itself.
    const halt: IChainHalt = { value: false };
    const layer1Impact = attackEnemiesAndGetLayerImpact(
        fromUnit,
        enemiesLayer1,
        chainBaseDamage,
        7,
        abilityMultiplier,
        affectedEnemiesIds,
        sceneLog,
        unitIdsDied,
        damageStatisticHolder,
        halt,
        secondaryDamage,
    );

    for (const impact of layer1Impact) {
        totalMoraleIncrease += impact.moraleIncrease;
        const enemiesLayer2: Unit[] = getEnemiesForCells(
            impact.cells,
            targetUnit.getTeam(),
            grid,
            unitsHolder,
            affectedEnemiesIds,
        );

        const unitNameKeyL1 = `${impact.enemyName}:${fromUnit.getOppositeTeam()}`;
        moraleDecreaseForTheUnitTeam[unitNameKeyL1] =
            (moraleDecreaseForTheUnitTeam[unitNameKeyL1] || 0) + impact.enemyMinusMorale;

        // Units already struck still count for morale above; the halt only stops the chain SPREADING.
        if (halt.value || !enemiesLayer2.length) {
            continue;
        }

        const layer2Impact = attackEnemiesAndGetLayerImpact(
            fromUnit,
            enemiesLayer2,
            chainBaseDamage,
            6,
            abilityMultiplier,
            affectedEnemiesIds,
            sceneLog,
            unitIdsDied,
            damageStatisticHolder,
            halt,
            secondaryDamage,
        );

        for (const impact2 of layer2Impact) {
            totalMoraleIncrease += impact2.moraleIncrease;
            const enemiesLayer3: Unit[] = getEnemiesForCells(
                impact2.cells,
                targetUnit.getTeam(),
                grid,
                unitsHolder,
                affectedEnemiesIds,
            );
            const unitNameKeyL2 = `${impact2.enemyName}:${fromUnit.getOppositeTeam()}`;
            moraleDecreaseForTheUnitTeam[unitNameKeyL2] =
                (moraleDecreaseForTheUnitTeam[unitNameKeyL2] || 0) + impact2.enemyMinusMorale;

            // NB: the pre-existing guard here tested enemiesLayer2 rather than enemiesLayer3; left as
            // found (an empty layer 3 simply yields no impacts) beyond adding the halt.
            if (halt.value || !enemiesLayer2.length) {
                continue;
            }

            const layer3Impact = attackEnemiesAndGetLayerImpact(
                fromUnit,
                enemiesLayer3,
                chainBaseDamage,
                5,
                abilityMultiplier,
                affectedEnemiesIds,
                sceneLog,
                unitIdsDied,
                damageStatisticHolder,
                halt,
                secondaryDamage,
            );

            for (const impact3 of layer3Impact) {
                totalMoraleIncrease += impact3.moraleIncrease;
                const unitNameKeyL3 = `${impact3.enemyName}:${fromUnit.getOppositeTeam()}`;
                moraleDecreaseForTheUnitTeam[unitNameKeyL3] =
                    (moraleDecreaseForTheUnitTeam[unitNameKeyL3] || 0) + impact3.enemyMinusMorale;
            }
        }
    }

    fromUnit.increaseMorale(
        totalMoraleIncrease,
        FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(fromUnit.getTeam()),
    );
    unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);

    return unitIdsDied;
}

export function getChainLightningTargets(targetUnit: Unit, grid: Grid, unitsHolder: UnitsHolder): Unit[] {
    const affectedEnemies: Unit[] = [];
    const affectedEnemiesIds: string[] = [targetUnit.getId()];

    // Initial target check
    if (targetUnit.getMagicResist() === 100 || chainElementMultiplier(targetUnit) <= 0) {
        return affectedEnemies;
    }
    // Main target is usually already highlighted by hover, but we include it here for completeness if needed.
    // However, the caller might handle primary target separate.
    // Let's include everything in the chain to be safe.
    affectedEnemies.push(targetUnit);

    // Layer 1
    const enemiesLayer1: Unit[] = getEnemiesForCells(
        targetUnit.getCells(),
        targetUnit.getTeam(),
        grid,
        unitsHolder,
        affectedEnemiesIds,
    );

    // Mirrors the engine hop for hop, halt included — this is what the hover preview draws, and a
    // preview that ignored the Wind screen would promise arcs the swing never delivers.
    for (const e1 of enemiesLayer1) {
        if (chainElementMultiplier(e1) <= 0) break;
        if (e1.getMagicResist() === 100) continue;

        affectedEnemies.push(e1);
        affectedEnemiesIds.push(e1.getId());

        // Layer 2
        const enemiesLayer2 = getEnemiesForCells(
            e1.getCells(),
            targetUnit.getTeam(),
            grid,
            unitsHolder,
            affectedEnemiesIds,
        );

        for (const e2 of enemiesLayer2) {
            if (chainElementMultiplier(e2) <= 0) break;
            if (e2.getMagicResist() === 100) continue;

            affectedEnemies.push(e2);
            affectedEnemiesIds.push(e2.getId());

            // Layer 3
            const enemiesLayer3 = getEnemiesForCells(
                e2.getCells(),
                targetUnit.getTeam(),
                grid,
                unitsHolder,
                affectedEnemiesIds,
            );

            for (const e3 of enemiesLayer3) {
                if (chainElementMultiplier(e3) <= 0) break;
                if (e3.getMagicResist() === 100) continue;

                if (!affectedEnemiesIds.includes(e3.getId())) {
                    affectedEnemies.push(e3);
                    affectedEnemiesIds.push(e3.getId());
                }
            }
        }
    }

    return affectedEnemies;
}
