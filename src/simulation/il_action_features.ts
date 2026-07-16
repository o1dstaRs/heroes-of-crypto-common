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

import type { IEnumeratedCandidate, IShotCandidateFeatures } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { GRID_SIZE } from "../grid/grid_constants";
import { RANGE_ATTACK_CELL_SIDES, RangeAttackCellSide } from "../grid/grid_math";
import type { XY } from "../utils/math";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const GRID_SPAN = Math.max(1, GRID_SIZE - 1);

export const IL_ACTION_FAMILIES = [
    "idle",
    "wait",
    "defend",
    "move",
    "melee",
    "shot",
    "area_throw",
    "spell",
    "mine",
    "other",
] as const;

export type IlActionFamily = (typeof IL_ACTION_FAMILIES)[number];

export const IL_SHOT_FEATURE_NAMES = [
    "enemyDamage",
    "friendlyFireDamage",
    "primaryTargetDamage",
    "targetFirepower",
    "targetLevel",
    "targetIsRanged",
    "targetCanCastSpells",
    "targetNotYetActed",
    "targetWoundedFraction",
    "targetFocusFire",
] as const;

const AIM_SIDE_FEATURE_NAMES = RANGE_ATTACK_CELL_SIDES.map((side) => `aimSide_${side}`);

/**
 * Fixed-order, pre-decision candidate-action basis for IL v3. It intentionally contains no unit ids,
 * semantic signatures, rollout values, chosen index, match outcome, or post-decision observations.
 */
export const IL_ACTION_FEATURE_NAMES: readonly string[] = [
    ...IL_ACTION_FAMILIES.map((family) => `family_${family}`),
    "actionCount",
    "hasAttackSelection",
    "selectsMelee",
    "selectsMeleeMagic",
    "selectsRange",
    "hasMove",
    "movePathLengthNorm",
    "moveDestinationXNorm",
    "moveDestinationYNorm",
    "moveHasLava",
    "moveHasWater",
    "hasUnitTarget",
    "hasTargetCell",
    "targetCellXNorm",
    "targetCellYNorm",
    "hasStandCell",
    "standCellXNorm",
    "standCellYNorm",
    "hasAimCell",
    "aimCellXNorm",
    "aimCellYNorm",
    "hasAimSide",
    ...AIM_SIDE_FEATURE_NAMES,
    "spellTargetsUnit",
    "spellTargetsCell",
    "spellIsMass",
    "hasShotFeatures",
    ...IL_SHOT_FEATURE_NAMES.map((name) => `shot_${name}`),
] as const;

export interface IIlMoveMetadata {
    pathLength: number;
    destination: XY;
    hasLava: 0 | 1;
    hasWater: 0 | 1;
}

export interface IIlSpellMetadata {
    /** Observational metadata only. Spell names are deliberately not encoded in the numeric vector. */
    name: string;
    targetMode: "unit" | "cell" | "mass";
}

export interface IIlCandidateActionMetadata {
    family: IlActionFamily;
    actionCount: number;
    attackSelection: number | null;
    move: IIlMoveMetadata | null;
    hasUnitTarget: 0 | 1;
    targetCell: XY | null;
    standCell: XY | null;
    aimCell: XY | null;
    aimSide: number | null;
    spell: IIlSpellMetadata | null;
    shotFeatures: IShotCandidateFeatures | null;
}

export interface IIlCandidateActionEncoding {
    metadata: IIlCandidateActionMetadata;
    features: number[];
}

export function ilActionFamily(actions: readonly GameAction[]): IlActionFamily {
    for (const action of actions) {
        switch (action.type) {
            case "melee_attack":
                return "melee";
            case "range_attack":
                return "shot";
            case "area_throw_attack":
                return "area_throw";
            case "cast_spell":
                return "spell";
            case "wait_turn":
                return "wait";
            case "defend_turn":
                return "defend";
            case "obstacle_attack":
                return "mine";
            default:
                break;
        }
    }
    if (actions.some((action) => action.type === "move_unit")) return "move";
    if (!actions.length || actions.every((action) => action.type === "end_turn")) return "idle";
    return "other";
}

const copyCell = (cell: XY | undefined): XY | null => (cell ? { x: cell.x, y: cell.y } : null);
const copyShotFeatures = (shot: IShotCandidateFeatures | undefined): IShotCandidateFeatures | null =>
    shot
        ? (Object.fromEntries(
              IL_SHOT_FEATURE_NAMES.map((name) => [name, shot[name]]),
          ) as unknown as IShotCandidateFeatures)
        : null;

/** Build the canonical structured encoding from either candidate 0 or a generated candidate. */
export function ilCandidateActionMetadata(candidate: IEnumeratedCandidate): IIlCandidateActionMetadata {
    const selection = candidate.actions.find((action) => action.type === "select_attack_type");
    const move = candidate.actions.find((action) => action.type === "move_unit");
    const melee = candidate.actions.find((action) => action.type === "melee_attack");
    const shot = candidate.actions.find((action) => action.type === "range_attack");
    const area = candidate.actions.find((action) => action.type === "area_throw_attack");
    const spell = candidate.actions.find((action) => action.type === "cast_spell");
    const moveDestination = move?.path[move.path.length - 1];
    const targetCell = area?.targetCell ?? spell?.targetCell ?? moveDestination;
    const standCell = melee?.attackFrom;
    const unitTarget = melee?.targetId !== undefined || shot?.targetId !== undefined || spell?.targetId !== undefined;
    const spellTargetMode = spell
        ? spell.targetId !== undefined
            ? "unit"
            : spell.targetCell !== undefined
              ? "cell"
              : "mass"
        : undefined;
    return {
        family: ilActionFamily(candidate.actions),
        actionCount: candidate.actions.length,
        attackSelection: selection?.attackType ?? null,
        move:
            move && moveDestination
                ? {
                      pathLength: move.path.length,
                      destination: { x: moveDestination.x, y: moveDestination.y },
                      hasLava: move.hasLavaCell ? 1 : 0,
                      hasWater: move.hasWaterCell ? 1 : 0,
                  }
                : null,
        hasUnitTarget: unitTarget ? 1 : 0,
        targetCell: copyCell(targetCell),
        standCell: copyCell(standCell),
        aimCell: copyCell(shot?.aimCell),
        aimSide: shot?.aimSide ?? null,
        spell: spell ? { name: spell.spellName, targetMode: spellTargetMode! } : null,
        shotFeatures: copyShotFeatures(candidate.shotFeatures),
    };
}

const normalized = (value: number): number => value / GRID_SPAN;
const canonicalY = (value: number, perspectiveTeam: TeamType): number =>
    normalized(perspectiveTeam === UPPER ? GRID_SPAN - value : value);
const cellFeatures = (cell: XY | null, perspectiveTeam: TeamType): [number, number, number] =>
    cell ? [1, normalized(cell.x), canonicalY(cell.y, perspectiveTeam)] : [0, 0, 0];
const canonicalAimSide = (side: number | null, perspectiveTeam: TeamType): number | null => {
    if (perspectiveTeam !== UPPER) return side;
    if (side === RangeAttackCellSide.DOWN) return RangeAttackCellSide.UP;
    if (side === RangeAttackCellSide.UP) return RangeAttackCellSide.DOWN;
    return side;
};

export function ilActionFeatureVector(metadata: IIlCandidateActionMetadata, perspectiveTeam: TeamType): number[] {
    if (perspectiveTeam !== LOWER && perspectiveTeam !== UPPER) {
        throw new Error("IL action features require a LOWER or UPPER acting-team perspective");
    }
    const move = metadata.move;
    const [hasTargetCell, targetCellX, targetCellY] = cellFeatures(metadata.targetCell, perspectiveTeam);
    const [hasStandCell, standCellX, standCellY] = cellFeatures(metadata.standCell, perspectiveTeam);
    const [hasAimCell, aimCellX, aimCellY] = cellFeatures(metadata.aimCell, perspectiveTeam);
    const aimSide = canonicalAimSide(metadata.aimSide, perspectiveTeam);
    const shot = metadata.shotFeatures;
    const shotValues = shot ? IL_SHOT_FEATURE_NAMES.map((name) => shot[name]) : IL_SHOT_FEATURE_NAMES.map(() => 0);
    return [
        ...IL_ACTION_FAMILIES.map((family) => (metadata.family === family ? 1 : 0)),
        metadata.actionCount,
        metadata.attackSelection === null ? 0 : 1,
        metadata.attackSelection === MELEE ? 1 : 0,
        metadata.attackSelection === MELEE_MAGIC ? 1 : 0,
        metadata.attackSelection === RANGE ? 1 : 0,
        move ? 1 : 0,
        move ? move.pathLength / GRID_SPAN : 0,
        move ? normalized(move.destination.x) : 0,
        move ? canonicalY(move.destination.y, perspectiveTeam) : 0,
        move?.hasLava ?? 0,
        move?.hasWater ?? 0,
        metadata.hasUnitTarget,
        hasTargetCell,
        targetCellX,
        targetCellY,
        hasStandCell,
        standCellX,
        standCellY,
        hasAimCell,
        aimCellX,
        aimCellY,
        aimSide === null ? 0 : 1,
        ...RANGE_ATTACK_CELL_SIDES.map((side) => (aimSide === side ? 1 : 0)),
        metadata.spell?.targetMode === "unit" ? 1 : 0,
        metadata.spell?.targetMode === "cell" ? 1 : 0,
        metadata.spell?.targetMode === "mass" ? 1 : 0,
        shot ? 1 : 0,
        ...shotValues,
    ];
}

export function ilCandidateActionEncoding(
    candidate: IEnumeratedCandidate,
    perspectiveTeam: TeamType,
): IIlCandidateActionEncoding {
    const metadata = ilCandidateActionMetadata(candidate);
    return { metadata, features: ilActionFeatureVector(metadata, perspectiveTeam) };
}
