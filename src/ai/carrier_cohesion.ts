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

import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { TeamType } from "../units/unit_properties";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";
import { assertNoLegacySeatEnv, seatEnvName } from "./seat_env";

export const A19_CARRIER_COHESION_ID = "a19-carrier-cohesion-v2";

/** Per-seat switch (seat_env): on unless `A19_CARRIER_COHESION_<LEFT|RIGHT>=0`. */
export const A19_CARRIER_COHESION_ENV = "A19_CARRIER_COHESION";

/** The laps in which a blessing carrier keeps with its army. */
export const A19_CARRIER_COHESION_LAPS = 3;

/**
 * The blessings that last only while their unit lives: every mass buff whose description begins "While this unit is
 * alive". The army loses such a blessing for the rest of the fight when its carrier dies.
 */
export const A19_ALIVE_BLESSINGS: ReadonlySet<string> = new Set([
    "Angelic Host Blessing",
    "Arcane Ward Blessing",
    "Arrows Wingshield Blessing",
    "Luck Blessing",
    "Sharpened Weapons Blessing",
    "Sylvan Focus Blessing",
    "Tie up the Horses Blessing",
    "Warding Mane Blessing",
    "Wolf Trail Blessing",
]);

export function a19CarrierCohesionEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_CARRIER_COHESION_ENV);
    return process.env[seatEnvName(A19_CARRIER_COHESION_ENV, team)] !== "0";
}

/**
 * The striker rush plan (common's `a19_striker_rush.ts`: Placement 2 and Movement 2) is built to charge with every
 * striker, and every carrier but the Satyr is one, so a seat that bought it keeps charging.
 */
export const A19_CARRIER_COHESION_RUSH_PLACEMENT = 2;
export const A19_CARRIER_COHESION_RUSH_MOVEMENT = 2;

export interface IA19CarrierCohesionAugments {
    getAugmentPlacementLevel(team: TeamType): number;
    getAugmentMovement(team: TeamType): number;
}

/** Whether `team`'s principal carriers keep with their army: the switch is on and the seat did not buy the rush. */
export function a19CarrierCohesionHoldsBack(team: TeamType, fight: IA19CarrierCohesionAugments): boolean {
    if (!a19CarrierCohesionEnabled(team)) return false;
    return !(
        fight.getAugmentPlacementLevel(team) >= A19_CARRIER_COHESION_RUSH_PLACEMENT &&
        fight.getAugmentMovement(team) >= A19_CARRIER_COHESION_RUSH_MOVEMENT
    );
}

/** Whether `unit` carries a blessing that ends with its death. */
export function a19CarriesAliveBlessing(unit: Unit): boolean {
    for (const name of A19_ALIVE_BLESSINGS) {
        if (unit.hasAbilityActive(name)) return true;
    }
    return false;
}

/** A carrier that is the largest living stack of its creature on its team; a one-creature split is not one. */
export function a19IsPrincipalBlessingCarrier(unit: Unit, unitsHolder: UnitsHolder): boolean {
    if (!a19CarriesAliveBlessing(unit)) return false;
    const amount = unit.getAmountAlive();
    return !unitsHolder
        .getAllAllies(unit.getTeam())
        .some(
            (ally) =>
                ally.getId() !== unit.getId() &&
                !ally.isDead() &&
                ally.getName() === unit.getName() &&
                ally.getAmountAlive() > amount,
        );
}

const footprintDistance = (left: readonly XY[], right: readonly XY[]): number => {
    let distance = Infinity;
    for (const a of left) {
        for (const b of right) {
            distance = Math.min(distance, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
        }
    }
    return distance;
};

/**
 * a19-carrier-cohesion-v2. In the first laps a principal blessing carrier that walks does not leave its army: a move,
 * with or without an attack, that takes it from at most 3 cells of its nearest ally to at least 4 cells, and at least 2
 * cells farther, isolates it. A flying carrier (Manticore, Angel) is not held: v1, which held it too, lost on armies
 * with a Manticore (confirmation CC, gate CC2).
 */
export function a19IsEarlyIsolatingCarrierMove(
    unit: Unit,
    unitsHolder: UnitsHolder,
    currentLap: number,
    actions: readonly GameAction[],
): boolean {
    if (currentLap > A19_CARRIER_COHESION_LAPS || unit.canFly() || !a19IsPrincipalBlessingCarrier(unit, unitsHolder))
        return false;
    const move = actions.find((action) => action.type === "move_unit");
    if (move?.type !== "move_unit" || !move.targetCells?.length) return false;
    const allies = unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => ally.getId() !== unit.getId() && !ally.isDead())
        .map((ally) => ally.getCells());
    if (!allies.length) return false;
    const current = Math.min(...allies.map((cells) => footprintDistance(unit.getCells(), cells)));
    const destination = Math.min(...allies.map((cells) => footprintDistance(move.targetCells!, cells)));
    return current <= 3 && destination >= 4 && destination - current >= 2;
}
