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

import { FightStateManager } from "../fights/fight_state_manager";
import { Grid } from "../grid/grid";
import type { GridSettings } from "../grid/grid_settings";
import { traceGridRayCells } from "../grid/ray_traversal";
import type { ISceneLog } from "../scene/scene_log_interface";
// Type-only, like craft_ability: unit.ts reads absolvingArrowFirstLiftChance for the card description, so a
// value import here would close a runtime import cycle.
import type { Unit } from "../units/unit";
import { getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";

import { isEquipmentOrMarkerSpellName } from "./ability_helper";

export const ABSOLVING_ARROW_NAME = "Absolving Arrow";

export interface IAbsolution {
    unitId: string;
    /** Effects and debuffs the arrow actually lifted off this ally, in the order they were lifted. */
    liftedNames: string[];
}

/**
 * The negatives an arrow can lift off an ally, in lift order: EFFECTS first (Stun, Freeze, Blindness,
 * Paralysis, Break — the ones that cost the ally its turn) and then spell debuffs. Order matters because
 * the first lift is the certain one, so the guaranteed cleanse should go to the worse half.
 *
 * Skipped: aura-applied entries (Number.MAX_SAFE_INTEGER laps — the aura re-applies them immediately) and
 * the marker debuffs a cursed artifact carries, which are worn equipment rather than something landed.
 */
function liftableNegatives(unit: Unit): string[] {
    const names: string[] = [];
    for (const effect of unit.getEffects()) {
        if (effect.getLaps() > 0) {
            names.push(effect.getName());
        }
    }
    for (const debuff of unit.getDebuffs()) {
        if (
            debuff.getLaps() > 0 &&
            debuff.getLaps() !== Number.MAX_SAFE_INTEGER &&
            !isEquipmentOrMarkerSpellName(debuff.getName())
        ) {
            names.push(debuff.getName());
        }
    }

    return names;
}

/**
 * The chance this Monk lifts the FIRST negative off an ally: the plain stack-and-luck curve every other
 * stack-powered ability uses (Unit.calculateAbilityApplyChance), so at the card's power of 100 the stacks
 * read 20 / 40 / 60 / 80 / 100 before luck moves them. Clamped to a real probability because luck and the
 * team's synergy bonus can push the raw figure past either end.
 */
export function absolvingArrowFirstLiftChance(shooterUnit: Unit, synergyAbilityPowerIncrease: number): number {
    const ability = shooterUnit.getAbility(ABSOLVING_ARROW_NAME);
    if (!ability) {
        return 0;
    }

    return Math.max(0, Math.min(100, shooterUnit.calculateAbilityApplyChance(ability, synergyAbilityPowerIncrease)));
}

/**
 * The chance to lift the `index`-th negative off one ally: the stack-scaled chance above for the first, then
 * halved for every further one (at five stacks 100 / 50 / 25 / 12.5, at one stack 25 / 12.5 / 6.25 / 3.125).
 * Each negative is rolled on its own, so a missed second lift does not stop the third from being tried at
 * its own (already smaller) chance.
 */
export function absolvingArrowLiftChance(firstLiftChance: number, index: number): number {
    return firstLiftChance / 2 ** index;
}

/**
 * Absolving Arrow (Monk): the shot cleanses the ALLIES it flies through on its way to the enemy.
 *
 * The trajectory is the same discrete ray the engine shoots along (traceGridRayCells over the shooter's
 * position and the aimed position), so the allies cleansed are exactly the ones the arrow visually crosses
 * — an ally never blocks a shot in this engine, it just stands in the lane. Runs whether or not the shot
 * goes on to hit: the arrow passed through the ally either way.
 */
export function processAbsolvingArrowAbility(
    shooterUnit: Unit,
    targetPosition: XY,
    allUnits: ReadonlyMap<string, Unit>,
    grid: Grid,
    gridSettings: GridSettings,
    sceneLog: ISceneLog,
): IAbsolution[] {
    const ability = shooterUnit.getAbility(ABSOLVING_ARROW_NAME);
    if (!ability) {
        return [];
    }

    const absolutions: IAbsolution[] = [];
    const visitedUnitIds = new Set<string>([shooterUnit.getId()]);
    const firstLiftChance = absolvingArrowFirstLiftChance(
        shooterUnit,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(shooterUnit.getTeam()),
    );

    for (const [cell] of traceGridRayCells(gridSettings, shooterUnit.getPosition(), targetPosition)) {
        const occupantUnitId = grid.getOccupantUnitId(cell);
        if (!occupantUnitId || visitedUnitIds.has(occupantUnitId)) {
            continue;
        }
        // Terrain occupants ("B" mountain, "L" lava, "W" water) are not units and resolve to nothing here.
        const ally = allUnits.get(occupantUnitId);
        if (!ally) {
            continue;
        }
        // A large ally covers several cells of the lane; cleanse it once.
        visitedUnitIds.add(occupantUnitId);
        if (ally.isDead() || ally.getTeam() !== shooterUnit.getTeam()) {
            continue;
        }

        const liftedNames: string[] = [];
        liftableNegatives(ally).forEach((name, index) => {
            if (getRandomInt(0, 100) >= absolvingArrowLiftChance(firstLiftChance, index)) {
                return;
            }
            ally.deleteEffect(name);
            ally.deleteDebuff(name);
            liftedNames.push(name);
        });

        if (liftedNames.length) {
            sceneLog.updateLog(`${shooterUnit.getName()} absolved ${ally.getName()} of ${liftedNames.join(", ")}`);
            absolutions.push({ unitId: ally.getId(), liftedNames });
        }
    }

    return absolutions;
}
