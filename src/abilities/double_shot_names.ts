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

/**
 * The names of the second-attack abilities, kept in a module that imports NOTHING.
 *
 * They are needed by Unit, UnitsHolder and the craft path as well as by ability_helper, and every one of
 * those is something ability_helper itself imports — so declaring them there and importing it back would
 * close an import cycle. A leaf module with no dependencies can be read from anywhere. ability_helper
 * re-exports both constants, so `AbilityHelper.DOUBLE_SHOT_ABILITY_NAMES` keeps working unchanged.
 */

/**
 * Every ability that lands a SECOND RANGED attack, in the order a unit should be asked for them.
 *
 * Double Shot and its crafted twin dilute their percentage across the stack; Gargantuan's Double Throw is
 * the same mechanic with the stack gate off, so BOTH boulders land the full percentage plus luck (see
 * Unit.calculateAbilityMultiplier — a non-stack-powered ability delivers its whole power from a single
 * unit, exactly as Area Throw and Through Shot already do).
 *
 * This list is the single place that roster is declared. Roughly two dozen call sites across the engine,
 * the AI and the client ask "does this unit shoot twice?", and before it existed each one spelled the
 * names out itself — so a new member had to be routed by hand into every one of them, and any miss showed
 * up as the AI mis-valuing the unit or the client drawing one projectile for a two-shot attack.
 */
export const DOUBLE_SHOT_ABILITY_NAMES: readonly string[] = ["Double Shot", "Crafted Double Shot", "Double Throw"];

/** The melee counterparts, for the paths that gate on "already strikes twice" regardless of range. */
export const DOUBLE_PUNCH_ABILITY_NAMES: readonly string[] = ["Double Punch", "Crafted Double Punch"];

/** Marker buff the Dual Strike Charm artifact puts on a unit whose second strike it amplifies. */
export const DUAL_STRIKE_CHARM_BUFF = "Dual Strike Charm";
