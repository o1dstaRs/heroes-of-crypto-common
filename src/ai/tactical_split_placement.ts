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

import { PBTypes } from "../generated/protobuf/v1/types";
import { PlacementAugment } from "../augments/augment_properties";
import { MAX_UNITS_PER_TEAM } from "../constants";
import { SpellPowerType, SpellTargetType } from "../spells/spell_properties";
import type { XY } from "../utils/math";

export type TacticalSplitRole = "aura" | "support" | "bait";

/** Detached, fair-information description used by the pre-fight split planner. */
export interface ITacticalSplitUnit {
    readonly id: string;
    readonly identity: string;
    readonly amount: number;
    readonly level: number;
    readonly small: boolean;
    readonly summoned: boolean;
    readonly attackType: number;
    readonly steps: number;
    readonly hpPerCreature: number;
    readonly auraUtilityCount: number;
    readonly supportSpellCount: number;
}

export interface ITacticalSplitPlan {
    readonly sourceUnitId: string;
    readonly amount: 1;
    readonly role: TacticalSplitRole;
}

export interface ITacticalSplitPlacementUnit {
    readonly id: string;
    readonly small: boolean;
}

export interface ITacticalSplitStack {
    readonly unitId: string;
    readonly role: TacticalSplitRole;
}

export interface ITacticalSplitPlacementContext {
    readonly team: number;
    readonly gridType: number;
    readonly legalCellHashes: ReadonlySet<number>;
    /** New split stacks in planner priority order. Only the first becomes the isolated decoy. */
    readonly splitStacks: readonly ITacticalSplitStack[];
}

/** Structural on purpose: server and client may temporarily consume different common package instances. */
export interface ITacticalSplitUnitSource {
    getId(): string;
    getName(): string;
    getAmountAlive(): number;
    getLevel(): number;
    isSmallSize(): boolean;
    isSummoned(): boolean;
    getAttackType(): number;
    getSteps(): number;
    getMaxHp(): number;
    getAbilities(): readonly { getAuraEffectName(): string | undefined }[];
    getSpells(): readonly {
        isRemaining(): boolean;
        isBuff(): boolean;
        getMinimalCasterStackPower(): number;
        getPowerType(): SpellPowerType;
        getSpellTargetType(): SpellTargetType;
    }[];
}

const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const BASE_PLACEMENT_STACK_CAP = MAX_UNITS_PER_TEAM - PlacementAugment.LEVEL_3;
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const compareStable = (left: ITacticalSplitUnit, right: ITacticalSplitUnit): number =>
    left.level - right.level ||
    left.hpPerCreature - right.hpPerCreature ||
    right.steps - left.steps ||
    compareText(left.identity, right.identity) ||
    compareText(left.id, right.id);

const compareUtility = (left: ITacticalSplitUnit, right: ITacticalSplitUnit): number =>
    right.auraUtilityCount - left.auraUtilityCount || compareStable(left, right);

const compareSupport = (left: ITacticalSplitUnit, right: ITacticalSplitUnit): number =>
    right.supportSpellCount - left.supportSpellCount || compareStable(left, right);

/**
 * Plan one-model utility stacks without mutating the army. The duplicate-identity guard is deliberate:
 * after a plan has been applied, the source and its one-model child share identity+level, so a retry returns
 * no further split for that creature. This makes the policy state-idempotent without hidden markers.
 */
export function planTacticalStackSplits(
    units: readonly ITacticalSplitUnit[],
    maximumStacks: number,
): ITacticalSplitPlan[] {
    const living = units.filter((unit) => unit.amount > 0);
    const normalizedMaximum = Math.floor(maximumStacks);
    // Do not fragment an under-filled draft merely because the base rules tolerate six stacks. Only consume
    // capacity above that base ceiling: the slots actually opened by Placement and/or Board Units (Nature).
    let slots = Math.min(
        Math.max(0, normalizedMaximum - living.length),
        Math.max(0, normalizedMaximum - BASE_PLACEMENT_STACK_CAP),
    );
    if (!slots) return [];

    const identityCounts = new Map<string, number>();
    for (const unit of living) {
        identityCounts.set(unit.identity, (identityCounts.get(unit.identity) ?? 0) + 1);
    }
    const eligible = living.filter(
        (unit) =>
            unit.small &&
            !unit.summoned &&
            Number.isSafeInteger(unit.amount) &&
            unit.amount > 1 &&
            identityCounts.get(unit.identity) === 1,
    );
    const splitSources = new Set<string>();
    const plans: ITacticalSplitPlan[] = [];
    const take = (unit: ITacticalSplitUnit, role: TacticalSplitRole): void => {
        if (!slots) return;
        plans.push({ sourceUnitId: unit.id, amount: 1, role });
        splitSources.add(unit.id);
        slots -= 1;
    };

    // Reserve one slot for a dedicated support caster, then use every other genuinely-extra slot for utility
    // bodies. The best aura source may be peeled repeatedly (the replay-backed Leprechaun full-stack + four
    // singles formation); each child creates another independent coverage zone. A carrier whose spellbook is
    // itself support utility is limited to one child so this policy does not multiply support casts by accident.
    const support = eligible
        .filter((candidate) => candidate.supportSpellCount > 0 && candidate.auraUtilityCount === 0)
        .sort(compareSupport)[0];
    const reservedSupportSlots = support && slots > 1 ? 1 : 0;
    for (const unit of eligible.filter((candidate) => candidate.auraUtilityCount > 0).sort(compareUtility)) {
        const maximumChildren = unit.supportSpellCount > 0 ? 1 : unit.amount - 1;
        for (let child = 0; child < maximumChildren && slots > reservedSupportSlots; child += 1) {
            take(unit, "aura");
        }
    }

    // One extra support activation is useful; fragmenting every caster would throw away too much stack power.
    if (support) take(support, "support");

    // If room remains, peel at most two cheap/mobile native melee bodies from the single best bait source.
    // This preserves the replay's Fairy full+1+1 pull formation without turning every ordinary melee stack
    // into a cloud of singles; a one-slot Berserker board still produces exactly one child.
    const bait = eligible
        .filter(
            (candidate) =>
                !splitSources.has(candidate.id) &&
                (candidate.attackType === PBTypes.AttackVals.MELEE ||
                    candidate.attackType === PBTypes.AttackVals.MELEE_MAGIC),
        )
        .sort(compareStable)[0];
    if (bait) {
        const maximumChildren = Math.min(2, bait.amount - 1);
        for (let child = 0; child < maximumChildren && slots > 0; child += 1) {
            take(bait, "bait");
        }
    }

    return plans;
}

/** Build the planner's detached input from own-army state only. */
export function tacticalSplitUnitFromUnit(unit: ITacticalSplitUnitSource): ITacticalSplitUnit {
    const supportTargets = new Set<number>([
        SpellTargetType.ANY_ALLY,
        SpellTargetType.ALL_ALLIES,
        SpellTargetType.ALL_FLYING,
        SpellTargetType.ALLIES_AREA,
    ]);
    const supportSpellCount = unit
        .getSpells()
        .filter(
            (spell) =>
                spell.isRemaining() &&
                spell.getMinimalCasterStackPower() <= 1 &&
                (spell.isBuff() ||
                    spell.getPowerType() === SpellPowerType.HEAL ||
                    spell.getPowerType() === SpellPowerType.RESURRECT ||
                    supportTargets.has(spell.getSpellTargetType())),
        ).length;
    return {
        id: unit.getId(),
        identity: `${unit.getName()}:${unit.getLevel()}`,
        amount: unit.getAmountAlive(),
        level: unit.getLevel(),
        small: unit.isSmallSize(),
        summoned: unit.isSummoned(),
        attackType: unit.getAttackType(),
        steps: unit.getSteps(),
        hpPerCreature: unit.getMaxHp(),
        auraUtilityCount: unit.getAbilities().filter((ability) => ability.getAuraEffectName() !== undefined).length,
        supportSpellCount,
    };
}

const footprintFor = (unit: ITacticalSplitPlacementUnit, base: XY): XY[] =>
    unit.small
        ? [base]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

const chebyshev = (left: XY, right: XY): number => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

/**
 * Overlay one isolated decoy on a normal strategy layout. Every full stack keeps its exact incumbent cell;
 * only the first split stack moves. On BLOCK_CENTER, aura/support decoys line up with the central corridor so
 * they pull/clear that lane; elsewhere the decoy takes the most isolated forward corner that legally fits.
 */
export function applyTacticalSplitPlacement(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly ITacticalSplitPlacementUnit[],
    context: ITacticalSplitPlacementContext,
): Map<string, XY> {
    const result = new Map([...incumbent].map(([id, cell]) => [id, { x: cell.x, y: cell.y }]));
    const decoy = context.splitStacks[0];
    const decoyUnit = decoy ? units.find((unit) => unit.id === decoy.unitId) : undefined;
    if (!decoy || !decoyUnit?.small || !context.legalCellHashes.size) return result;

    const occupied = new Set<number>();
    const alliedBases: XY[] = [];
    for (const unit of units) {
        if (unit.id === decoy.unitId) continue;
        const base = result.get(unit.id);
        if (!base) continue;
        alliedBases.push(base);
        for (const cell of footprintFor(unit, base)) occupied.add(cellKey(cell));
    }

    const candidates = [...context.legalCellHashes]
        .map((hash) => ({ x: hash >> 4, y: hash & 0xf }))
        .filter((cell) => !occupied.has(cellKey(cell)));
    if (!candidates.length) return result;

    const frontness = (cell: XY): number => (context.team === PBTypes.TeamVals.LOWER ? cell.y : 15 - cell.y);
    const centerX = 7.5;
    const isolation = (cell: XY): number =>
        alliedBases.length ? Math.min(...alliedBases.map((base) => chebyshev(cell, base))) : 16;
    const mountainUtility =
        context.gridType === PBTypes.GridVals.BLOCK_CENTER && (decoy.role === "aura" || decoy.role === "support");
    candidates.sort((left, right) => {
        const frontDelta = frontness(right) - frontness(left);
        if (frontDelta) return frontDelta;
        if (mountainUtility) {
            const corridorDelta = Math.abs(left.x - centerX) - Math.abs(right.x - centerX);
            if (corridorDelta) return corridorDelta;
        }
        const isolationDelta = isolation(right) - isolation(left);
        if (isolationDelta) return isolationDelta;
        const edgeDelta = Math.abs(right.x - centerX) - Math.abs(left.x - centerX);
        if (edgeDelta) return edgeDelta;
        // Seat-mirrored stable tie break: LOWER pulls left, UPPER pulls right.
        return context.team === PBTypes.TeamVals.LOWER ? left.x - right.x : right.x - left.x;
    });
    result.set(decoy.unitId, candidates[0]);
    return result;
}
