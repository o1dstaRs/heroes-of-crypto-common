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

import type { IBoardObj, Unit } from "../units/unit";
import type { XY } from "../utils/math";

export interface IAnimationData {
    toPosition: XY;
    affectedUnit: IBoardObj;
    fromPosition?: XY;
    bodyUnit?: Unit;
}

/** Source of a secondary (non-primary-hit) damage instance applied during an attack exchange. */
export type SecondaryDamageSource =
    | "fire_shield"
    | "chain_lightning"
    | "petrifying_gaze"
    | "magic_mirror"
    // Flesh Shield aura: the aura owner soaks most of the damage dealt to a protected ally.
    | "flesh_shield"
    // Melee AOE: extra units struck by a sweeping/breath attack (Black Dragon Fire Breath,
    // Pikeman Lightning Spin, Hydra Skewer Strike) beyond the primary target.
    | "fire_breath"
    | "lightning_spin"
    | "skewer_strike";

/**
 * A damage instance dealt by an ability that triggers DURING an attack but isn't the primary hit:
 * Fire Shield reflect, Chain Lightning bounces, Petrifying Gaze kills, Magic Mirror reflection. The
 * authoritative engine fills these on the attack's IVisibleDamage so the client can show a floating
 * number on the affected unit (at its impact-time position) and write a scene-log line — the engine's
 * own sceneLog only reaches the local sandbox, not ranked (which rebuilds purely from events).
 */
export interface ISecondaryDamage {
    source: SecondaryDamageSource;
    unitId: string;
    position: XY;
    amount: number;
    unitsDied: number;
}

export interface IVisibleDamage {
    amount: number;
    render: boolean;
    unitPosition: XY;
    unitIsSmall: boolean;
    unitId?: string;
    // The attack (or range response) fully MISSED the target — Dodge, Small Specie (large→small dodge),
    // or Boar Saliva. No damage was dealt; the client shows a "MISS" pop over `unitPosition` instead of
    // a damage number. `render` stays false on a miss (there is no damage to draw).
    missed?: boolean;
    hits?: { amount: number; unitsDied: number }[];
    // Per-affected-unit damage for AOE attacks (Large Caliber / Area Throw). Each entry carries the
    // hit unit's id, its world position at the moment of impact, the damage dealt and how many of its
    // stack died — so the renderer can place a floating number on EVERY splashed unit, not just the
    // primary target. Empty/undefined for single-target attacks.
    splash?: { unitId: string; position: XY; amount: number; unitsDied: number }[];
    // Secondary damage applied during this exchange (Fire Shield reflect, Chain Lightning bounces,
    // Petrifying Gaze kills, Magic Mirror reflection) — each rendered as its own floating number and
    // scene-log line. Empty/undefined when no such ability triggered.
    secondary?: ISecondaryDamage[];
    // One entry per Deep Wounds application/increment DURING this attack — so the orange claw slash plays
    // once for every application, not just the first. A double-attacker (e.g. Wolf's Double Punch) that
    // wounds on both hits produces TWO entries, hence two claws. `power` is the effect's total power at
    // that application (scales the claw). Empty/undefined when no Deep Wounds landed.
    deepWounds?: { unitId: string; power: number }[];
}
