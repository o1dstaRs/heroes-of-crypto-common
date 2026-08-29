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

import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../artifacts/artifact_properties";
import { Grid } from "../grid/grid";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getFootprintCellsForAnchor, normalizeFootprintSide } from "../grid/grid_math";
import { getDistance, type XY } from "../utils/math";
import { Ability } from "./ability";
import { DOUBLE_PUNCH_ABILITY_NAMES, DOUBLE_SHOT_ABILITY_NAMES, DUAL_STRIKE_CHARM_BUFF } from "./double_shot_names";

export function getAbilitiesWithPosisionCoefficient(
    unitAbilities: Ability[],
    fromCell?: XY,
    toCell?: XY,
    toUnitSmallSize?: boolean,
    fromUnitTeam?: TeamType,
    toFootprintHeight?: number,
    sideOrientedBoard = false,
    toFootprintWidth?: number,
): Ability[] {
    const abilities: Ability[] = [];
    if (!unitAbilities?.length || !fromCell || !toCell) {
        return abilities;
    }

    // Both arguments are ANCHOR cells — the top-right corner of a footprint — so the anchor names the FAR
    // edge along each axis while the body reaches back to `anchor - (extent - 1)`. A RIGHT-team attacker
    // stabs from below, so it has to clear the whole body rather than a single cell of it: the margin is
    // the target's extent, minus one, ALONG THE AXIS OF ADVANCE. That axis is Y on the classic board and X
    // on the side-oriented ranked board, so the margin has to switch with it — reading the height on a side
    // board measures the body across the advance instead of along it, and a rectangle then earns or loses
    // Backstab a cell early. `toUnitSmallSize` could only ever say 1 or 2, which is why the shipped code
    // spelled the margin as a literal 0-or-1; callers that still pass only the boolean get the same number
    // back, and a square target is unaffected by the axis choice. The LEFT-team test has no margin at all
    // and gains none here — its comparison already reads the target's near edge.
    const targetAlongExtent = normalizeFootprintSide(
        sideOrientedBoard ? toFootprintWidth : toFootprintHeight,
        toUnitSmallSize ? 1 : 2,
    );

    for (const a of unitAbilities) {
        if (a.getName() === "Backstab") {
            // "Behind" is measured along the axis of ADVANCE: Y on the classic bottom/top board,
            // X on the side-oriented ranked board. The large-target adjustment mirrors the 2x2
            // anchor convention (base cell = far corner along the axis) exactly as it always did
            // for Y — comparing raw Y on a side board awarded Backstab for standing BESIDE the
            // victim and never for standing behind it.
            const along = sideOrientedBoard ? fromCell.x : fromCell.y;
            const targetAlong = sideOrientedBoard ? toCell.x : toCell.y;

            if (fromUnitTeam === PBTypes.TeamVals.LEFT && along > targetAlong) {
                abilities.push(a);
            }

            // The footprint margin follows the axis too: along the advance axis the anchor names the
            // FAR edge, so the RIGHT attacker must clear the body's full extent along that axis.
            if (fromUnitTeam === PBTypes.TeamVals.RIGHT && along < targetAlong - (targetAlongExtent - 1)) {
                abilities.push(a);
            }
        }
    }

    return abilities;
}

/**
 * The abilities whose SECOND strike the Dual Strike Charm artifact amplifies (the natives, the two the
 * Blacksmith's Craft grants, and Gargantuan's Double Throw). Kept here so the damage paths and the UI that
 * previews them read one list.
 */
export const DUAL_STRIKE_ABILITY_NAMES: readonly string[] = [
    "Double Punch",
    "Double Shot",
    "Crafted Double Punch",
    "Crafted Double Shot",
    "Double Throw",
];

/** The rosters themselves live in a leaf module so Unit/UnitsHolder can read them without a cycle. */
export { DOUBLE_PUNCH_ABILITY_NAMES, DOUBLE_SHOT_ABILITY_NAMES, DUAL_STRIKE_CHARM_BUFF };

/** A unit-like that can hand back the ability object itself (Unit, RenderableUnit). */
interface IDoubleShotBearer {
    getAbility(abilityName: string): Ability | undefined;
}

/** The narrower AI-facing view (IUnitAIRepr), which can only answer yes/no. */
interface IDoubleShotProbe {
    hasAbilityActive(abilityName: string): boolean;
}

/** The unit's second-ranged-attack ability, whichever of the family it carries, or undefined for none. */
export function getDoubleShotAbility(unit: IDoubleShotBearer): Ability | undefined {
    for (const abilityName of DOUBLE_SHOT_ABILITY_NAMES) {
        const ability = unit.getAbility(abilityName);
        if (ability) {
            return ability;
        }
    }
    return undefined;
}

/**
 * Whether the unit shoots twice — the predicate every "shots per turn" decision should ask.
 *
 * Accepts either unit view because the AI reasons over IUnitAIRepr, which exposes only hasAbilityActive.
 * The two probes agree by construction: Unit.getAbility and Unit.hasAbilityActive both return
 * undefined/false while a Break effect is muting the ability, so neither can report a second shot the
 * other would deny.
 */
export function hasDoubleShotAbility(unit: IDoubleShotBearer | IDoubleShotProbe): boolean {
    if ("getAbility" in unit) {
        return !!getDoubleShotAbility(unit);
    }
    return DOUBLE_SHOT_ABILITY_NAMES.some((abilityName) => unit.hasAbilityActive(abilityName));
}

/**
 * Fold the Dual Strike Charm artifact into a second-strike multiplier. Every damage path that lands a
 * second attack calls this AND so does the tooltip that previews the number, so what a player is shown
 * on hover is exactly what the strike deals — the charm used to be invisible until the damage landed.
 * A unit without the artifact's marker buff is returned untouched.
 */
export function withDualStrikeCharm(multiplier: number, unit: Unit): number {
    const charm = unit.getBuff(DUAL_STRIKE_CHARM_BUFF);
    return charm ? multiplier * (1 + charm.getPower() / 100) : multiplier;
}

/** The charm's own contribution as a percentage (0 when the unit isn't carrying it) — for attribution. */
export function dualStrikeCharmPercent(unit: Unit): number {
    return unit.getBuff(DUAL_STRIKE_CHARM_BUFF)?.getPower() ?? 0;
}

/**
 * Abilities renamed to " Blessing" when they stopped being auras keep their ORIGINAL art: the icon files are
 * still named after the aura, so mapping the new name straight through would ask for a texture nobody shipped.
 */
const ABILITY_TEXTURE_OVERRIDES: ReadonlyMap<string, string> = new Map([
    ["Warding Mane Blessing", "warding_mane_aura_256"],
    ["Arrows Wingshield Blessing", "arrows_wingshield_aura_256"],
    ["Angelic Host Blessing", "angelic_host_256"],
]);

export const abilityToTextureName = (abilityName: string): string =>
    ABILITY_TEXTURE_OVERRIDES.get(abilityName) ?? `${abilityName.toLowerCase().replace(/ /g, "_")}_256`;

/**
 * Buffs and debuffs that are NOT a cast blessing or a landed curse: army equipment (artifacts, augments)
 * and the engine's own per-lap markers. They live in the same applied_buffs/applied_debuffs lists as real
 * spells, so anything that moves or lifts an entry (Borrowed Grace, Absolving Arrow) has to skip them —
 * an artifact is worn, not cast, and a marker is rewritten by the next stat recompute anyway.
 *
 * Aura-applied entries are NOT listed here: they are recognised by their Number.MAX_SAFE_INTEGER laps
 * (see Unit.applyAuraEffect) and are likewise off limits, since the aura refresh would re-grant them.
 */
export function isEquipmentOrMarkerSpellName(name: string): boolean {
    if (name.endsWith(" Augment")) {
        return true;
    }
    if (ENGINE_MARKER_SPELL_NAMES.has(name)) {
        return true;
    }
    return ARTIFACT_BUFF_NAMES.has(name);
}

const ARTIFACT_BUFF_NAMES: ReadonlySet<string> = new Set(
    [...TIER1_ARTIFACT_LIST, ...TIER2_ARTIFACT_LIST].map((artifact) => artifact.buffName).filter((name) => !!name),
);

// Morale/Dismorale are lap-scoped turn state; Hidden/Visible, army passives and Water Shield are re-seeded
// by UnitsHolder on every refresh, so taking or lifting one would either do nothing or desync the seeder.
const ENGINE_MARKER_SPELL_NAMES: ReadonlySet<string> = new Set([
    "Morale",
    "Dismorale",
    "Hidden",
    "Visible",
    "Angelic Host Blessing",
    "Arcane Ward Blessing",
    "Warding Mane Blessing",
    "Arrows Wingshield Blessing",
    "Water Shield",
]);

function addToTargetList(
    ix: number,
    iy: number,
    targetList: Unit[],
    target: Unit,
    attacker: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    onlyOppositeTeam: boolean,
): Unit[] {
    const nextTargetId = grid.getOccupantUnitId({ x: ix, y: iy });
    if (nextTargetId) {
        const nextStanding = unitsHolder.getAllUnits().get(nextTargetId);
        if (
            nextStanding &&
            !targetList.includes(nextStanding) &&
            nextStanding.getId() !== attacker.getId() &&
            nextStanding.getId() !== target.getId() &&
            (!onlyOppositeTeam || nextStanding.getTeam() !== attacker.getTeam())
        ) {
            targetList.push(nextStanding);
        }
    }
    return targetList;
}

function getTargetList(
    startingPos: XY[],
    cellsDiff: XY,
    target: Unit,
    attacker: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    onlyOppositeTeam: boolean,
): Unit[] {
    let targetList: Unit[] = [];
    const signX = Math.sign(cellsDiff.x);
    const signY = Math.sign(cellsDiff.y);
    const bX = Math.floor(Math.abs(cellsDiff.x));
    const bY = Math.floor(Math.abs(cellsDiff.y));
    for (const startingCell of startingPos) {
        targetList = addToTargetList(
            startingCell.x + bX * signX,
            startingCell.y + bY * signY,
            targetList,
            target,
            attacker,
            grid,
            unitsHolder,
            onlyOppositeTeam,
        );
    }
    return targetList;
}

export function nextStandingTargets(
    attackerUnit: Unit,
    targetUnit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    attackFromCell?: XY,
    pierceLargeUnits = true,
    onlyOppositeTeam = false,
): Unit[] {
    let targetList: Unit[] = [];
    let targetBaseCell = targetUnit.getBaseCell();

    const attackFromBaseCell = attackFromCell ? attackFromCell : attackerUnit.getBaseCell();

    if (!attackFromBaseCell || !targetBaseCell) {
        return targetList;
    }

    let attackerBaseCell = attackFromBaseCell;

    if (!attackerUnit.isSmallSize()) {
        // The attacker's REAL body. The hand-written 2x2 list below is kept verbatim for that shape because
        // the search seeds its tie-break with `attackerCells[0]` and then takes the first strictly-closer
        // cell, so the ORDER decides which cell wins when two are equidistant. Any other shape takes the
        // shared expansion; the old list gave a 2x1 two cells it does not stand on, which could pick a
        // phantom cell as the attack origin and aim the whole chain from the wrong place.
        const width = attackerUnit.getFootprintWidth();
        const height = attackerUnit.getFootprintHeight();
        const attackerCells =
            width === 2 && height === 2
                ? [
                      attackerBaseCell,
                      { x: attackerBaseCell.x - 1, y: attackerBaseCell.y },
                      { x: attackerBaseCell.x, y: attackerBaseCell.y - 1 },
                      { x: attackerBaseCell.x - 1, y: attackerBaseCell.y - 1 },
                  ]
                : getFootprintCellsForAnchor(attackerBaseCell, width, height);
        let closestCell = attackerCells[0];
        let minDistance = getDistance(closestCell, targetBaseCell);

        for (const cell of attackerCells) {
            const distance = getDistance(cell, targetBaseCell);
            if (distance < minDistance) {
                closestCell = cell;
                minDistance = distance;
            }
        }

        attackerBaseCell = closestCell;

        if (!targetUnit.isSmallSize()) {
            const targetCells = targetUnit.getCells();
            let closestTargetCell = targetCells[0];
            minDistance = getDistance(closestTargetCell, attackerBaseCell);

            for (const cell of targetCells) {
                const distance = getDistance(cell, attackerBaseCell);
                if (distance < minDistance) {
                    closestTargetCell = cell;
                    minDistance = distance;
                }
            }

            targetBaseCell = closestTargetCell;
        }
    }

    const tbs = targetUnit.getBaseCell();
    let xCoefficient = 0;
    let yCoefficient = 0;
    if (!targetUnit.isSmallSize()) {
        // How far the wave steps PAST the target, per axis: a body absorbs its own depth, so the step is the
        // target's own extent on that axis and nothing more.
        //
        // This used to test the gap against a literal 2 on BOTH axes, which is the target's depth only when
        // it is 2x2. A 1x2 or 2x1 is not small (isSmallSize is W===1 && H===1), so it entered here too and,
        // on the axis where its side is 1, the wave stepped a full cell too far — skipping whoever stood in
        // contact behind the body and burning a unit two cells away across an empty cell. The shipped 2x2
        // resolves to exactly the old numbers, since its width and height are both 2.
        const targetWidth = targetUnit.getFootprintWidth();
        const targetHeight = targetUnit.getFootprintHeight();
        const baseCellDiffX = tbs.x - attackFromBaseCell.x;
        const baseCellDiffY = tbs.y - attackFromBaseCell.y;
        if (targetWidth === 2 && targetHeight === 2) {
            // The shipped 2x2 keeps its exact arithmetic, including for gaps this never anticipated.
            if (baseCellDiffX === 2) {
                xCoefficient = 1;
            } else if (baseCellDiffX === -2) {
                xCoefficient = -1;
            }
            if (baseCellDiffY === 2) {
                yCoefficient = 1;
            } else if (baseCellDiffY === -2) {
                yCoefficient = -1;
            }
            xCoefficient = baseCellDiffX - xCoefficient;
            yCoefficient = baseCellDiffY - yCoefficient;
        } else {
            // The wave is pushed back by the target's own DEPTH on each axis, one cell per cell of body
            // beyond the first — which is what the 2x2 branch above works out to, and is 0 on an axis the
            // target is only one cell thick. Reading a literal 2 there (a 1x2 or 2x1 is not "small", so it
            // fell into that branch) pushed the wave a full cell too far on the thin axis: it skipped
            // whoever stood in contact behind the body and burned a unit two cells away across an empty
            // cell. Verified against the 2x2 case, which this expression reproduces exactly.
            xCoefficient = Math.sign(baseCellDiffX) * (targetWidth - 1);
            yCoefficient = Math.sign(baseCellDiffY) * (targetHeight - 1);
        }
    }

    if (targetBaseCell && attackerBaseCell) {
        const cellsDiff = {
            x: targetBaseCell.x - attackerBaseCell.x + xCoefficient,
            y: targetBaseCell.y - attackerBaseCell.y + yCoefficient,
        };
        if (targetUnit.isSmallSize() || pierceLargeUnits) {
            targetList = getTargetList(
                targetUnit.getCells(),
                cellsDiff,
                targetUnit,
                attackerUnit,
                grid,
                unitsHolder,
                onlyOppositeTeam,
            );
        }
    }

    return targetList;
}
