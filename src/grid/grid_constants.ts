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

export const GRID_SIZE = 16;
export const MAX_Y = 2048;
export const MIN_Y = 0;
export const MAX_X = 1024;
export const MIN_X = -1024;
export const STEP = MAX_Y / GRID_SIZE;
export const DOUBLE_STEP = STEP << 1;
export const HALF_STEP = STEP >> 1;
export const FOURTH_STEP = STEP >> 2;
export const UNIT_SIZE_DELTA = 0.06;
export const MOVEMENT_DELTA = 5;

export const NO_UPDATE = 0b00000000;
export const UPDATE_UP = 0b00010000;
export const UPDATE_DOWN = 0b00100000;
export const UPDATE_LEFT = 0b01000000;
export const UPDATE_RIGHT = 0b10000000;
export const UPDATE_DOWN_LEFT = 0b01000001;
export const UPDATE_UP_LEFT = 0b00010010;
export const UPDATE_DOWN_RIGHT = 0b00100100;
export const UPDATE_UP_RIGHT = 0b10001000;
