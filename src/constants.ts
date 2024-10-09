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

// damage
export const PENALTY_ON_RANGE_SHOT_THROUGH_TEAMMATES = false;
export const MIN_UNIT_STACK_POWER = 1;
export const MAX_UNIT_STACK_POWER = 5;

// teams & augments
export const MAX_UNITS_PER_TEAM = 8;
export const MAX_AUGMENT_POINTS = 6;

// map
export const NUMBER_OF_LAPS_TILL_NARROWING_NORMAL = 3;
export const NUMBER_OF_LAPS_TILL_NARROWING_BLOCK = 4;
export const NUMBER_OF_LAPS_TILL_STOP_NARROWING = 12;
export const NUMBER_OF_LAPS_FIRST_ARMAGEDDON = NUMBER_OF_LAPS_TILL_STOP_NARROWING;
export const NUMBER_OF_ARMAGEDDON_WAVES = 4;
export const NUMBER_OF_LAPS_TOTAL = NUMBER_OF_LAPS_FIRST_ARMAGEDDON + NUMBER_OF_ARMAGEDDON_WAVES - 1;
export const MAX_HITS_MOUNTAIN = 5;

// morale & luck
export const MORALE_CHANGE_FOR_DISTANCE = 3;
export const MORALE_CHANGE_FOR_SHIELD_OR_CLOCK = 2;
export const MORALE_CHANGE_FOR_SKIP = 1;
export const MORALE_CHANGE_FOR_KILL = 4;
export const MORALE_MAX_VALUE_TOTAL = 20;
export const LUCK_MAX_CHANGE_FOR_TURN = 3;
export const LUCK_MAX_VALUE_TOTAL = 10;
export const STEPS_MORALE_MULTIPLIER = 0.05;

// turn
export const UP_NEXT_UNITS_COUNT = 3;
export const MIN_TIME_TO_MAKE_TURN_MILLIS = 12000;
export const MAX_TIME_TO_MAKE_TURN_MILLIS = 60000;
export const TOTAL_TIME_TO_MAKE_TURN_MILLIS = 240000;
