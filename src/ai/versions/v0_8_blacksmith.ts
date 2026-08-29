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

import { hasDoubleShotAbility } from "../../abilities/ability_helper";
import { evaluateAffectedUnits } from "../../abilities/aoe_range_ability";
import type { GameAction } from "../../engine/actions";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext, IPlacementContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { creatureInfo } from "../setup/creature_score";
import { opponentCreatureIdsForPlacement } from "./v0_7_placement_reveal";
import {
    isV08BacklineProtectionBeneficiary,
    v08BacklineProtectorKind,
    V08_ANGEL_SCREEN_RANGE,
} from "./v0_8_backline_protector";
import { v08DominantFinishState } from "./v0_8_dominant_finish";

export const V08_BLACKSMITH_CRAFT_SPELL = "Craft";

/**
 * Physical ranged attacks that can punish an adjacent 2x2 opening. This is deliberately broader than the
 * historical adjacent-splash placement set: Through Shot and Chakram also turn a packed opening into extra
 * damage even though their geometry is a line/circle rather than an ordinary target splash.
 */
export const V08_CRAFT_CLUSTER_RANGED_AOE_ABILITIES: readonly string[] = [
    "Area Throw",
    "Large Caliber",
    "Through Shot",
    "Chakram",
];

/**
 * Public-roster magic AOE. Fire Breath and Chain Lightning are creature abilities; the named casters own
 * Meteorite, Ring of Fire, Meteor Shower, or Fire Wall. Keep this list explicit so placement never examines
 * a live opponent Unit, its stolen abilities, spell charges, stack size, or position.
 */
export const V08_CRAFT_CLUSTER_MAGIC_AOE_ABILITIES: readonly string[] = ["Fire Breath", "Chain Lightning"];
export const V08_CRAFT_CLUSTER_MAGIC_AOE_CREATURES: readonly string[] = ["Battle Mage", "Magic Dragon", "Nightmare"];

const key = (cell: XY): number => (cell.x << 4) | cell.y;
/**
 * `key` packs four bits per axis, so a coordinate outside 0..15 does not merely miss — it ALIASES. `y = 16`
 * sets bit 4, which is the low bit of x's field, making `key(x, 16) === key(x | 1, 0)`. Any probe that walks
 * off the board therefore has to be dropped BEFORE it is hashed, or it claims a real cell in row 0.
 */
const GRID_CELLS = 16;
const onBoard = (cell: XY): boolean => cell.x >= 0 && cell.y >= 0 && cell.x < GRID_CELLS && cell.y < GRID_CELLS;
const sameCell = (left: XY, right: XY): boolean => left.x === right.x && left.y === right.y;
const finitePositive = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const craftCells = (anchor: XY): XY[] => [
    { x: anchor.x, y: anchor.y },
    { x: anchor.x + 1, y: anchor.y },
    { x: anchor.x, y: anchor.y + 1 },
    { x: anchor.x + 1, y: anchor.y + 1 },
];

// The unit's real body, from the one shared expansion — the same aura-coverage and fixed-cell reasoning as
// the backline protector, which used to keep its own identical copy of this.
const footprintForBase = (unit: Unit, base: XY): XY[] => footprintCellsForAnchor(unit, base);

const footprintDistance = (left: readonly XY[], right: readonly XY[]): number => {
    let closest = Infinity;
    for (const leftCell of left) {
        for (const rightCell of right) {
            closest = Math.min(
                closest,
                Math.max(Math.abs(leftCell.x - rightCell.x), Math.abs(leftCell.y - rightCell.y)),
            );
        }
    }
    return closest;
};

/**
 * Stable marginal-Craft recipient ordering. Ranged stacks retain one activation per remaining shot; melee
 * stacks receive one activation. Current HP is a small durability tie-break, not a reason to craft a passive
 * body over a stack with materially greater remaining damage output.
 */
export function v08BlacksmithCraftRecipientValue(unit: Unit): number {
    const amount = finitePositive(unit.getAmountAlive());
    const perActivation = amount * finitePositive(unit.getAttackDamageMax());
    const activations = unit.isRangeCapable() ? Math.max(1, finitePositive(unit.getRangeShots())) : 1;
    const output = perActivation * activations;
    const rangedCraft = unit.getRangeShots() > 0;
    const alreadyHasCraftDouble = rangedCraft
        ? hasDoubleShotAbility(unit)
        : unit.hasAbilityActive("Double Punch") || unit.hasAbilityActive("Crafted Double Punch");
    // Craft's 40% double roll is a no-op when the matching native/crafted double is already active. Retain the
    // other 60% of the recipient's value: in particular, the independent Frozen outcome remains useful.
    const marginalOutput = output * (alreadyHasCraftDouble ? 0.6 : 1);
    const durabilityTieBreak = Math.min(999, finitePositive(unit.getCumulativeHp())) / 1_000;
    return Math.min(Number.MAX_SAFE_INTEGER, marginalOutput + durabilityTieBreak);
}

export function v08BlacksmithCraftRecipientsAt(
    unit: Unit,
    context: Pick<IDecisionContext, "grid" | "unitsHolder">,
    anchor: XY,
): Unit[] {
    const seen = new Set<string>();
    return (evaluateAffectedUnits(craftCells(anchor), context.unitsHolder, context.grid)?.[0] ?? [])
        .filter((candidate) => {
            if (candidate.getTeam() !== unit.getTeam() || candidate.isDead() || seen.has(candidate.getId())) {
                return false;
            }
            seen.add(candidate.getId());
            return true;
        })
        .sort((left, right) => left.getId().localeCompare(right.getId()));
}

const craftAction = (
    candidate: Pick<IEnumeratedCandidate, "actions">,
): Extract<GameAction, { type: "cast_spell" }> | undefined =>
    candidate.actions.find(
        (action): action is Extract<GameAction, { type: "cast_spell" }> =>
            action.type === "cast_spell" &&
            action.spellName === V08_BLACKSMITH_CRAFT_SPELL &&
            action.targetCell !== undefined,
    );

interface ICraftCandidate {
    readonly candidate: IEnumeratedCandidate;
    readonly recipientCount: number;
    readonly recipientValue: number;
    readonly sourceIndex: number;
}

const betterCraftCandidate = (candidate: ICraftCandidate, incumbent: ICraftCandidate | undefined): boolean =>
    !incumbent ||
    candidate.recipientCount > incumbent.recipientCount ||
    (candidate.recipientCount === incumbent.recipientCount &&
        (candidate.recipientValue > incumbent.recipientValue ||
            (candidate.recipientValue === incumbent.recipientValue && candidate.sourceIndex < incumbent.sourceIndex)));

/**
 * Only a stationary first hit with no miss/absorption path is retained over multi-recipient Craft. This is a
 * deliberately strict proof: probabilistic kills, move-attacks, double-punch follow-ups, and attacks into
 * Water/Flesh Shield do not spend Blacksmith's only Craft opportunity.
 */
export function isV08BlacksmithImmediateGuaranteedKill(
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): boolean {
    if (decision.some((action) => action.type === "move_unit")) return false;
    const melee = decision.find(
        (action): action is Extract<GameAction, { type: "melee_attack" }> =>
            action.type === "melee_attack" &&
            action.attackerId === unit.getId() &&
            sameCell(action.attackFrom, unit.getBaseCell()),
    );
    if (!melee) return false;
    const target = context.unitsHolder.getAllUnits().get(melee.targetId);
    if (!target || target.isDead() || target.getTeam() === unit.getTeam()) return false;
    if (
        (target.hasBuffActive("Water Shield") && !unit.hasAbilityActive("Fire Element")) ||
        target.hasBuffActive("Flesh Shield Aura")
    ) {
        return false;
    }
    const defenderAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(target.getTeam()) ?? 0;
    if (unit.calculateMissChance(target, defenderAbilityPower) > 0) return false;
    const attackerAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(unit.getTeam()) ?? 0;
    const minimumDamage = unit.calculateAttackDamageMin(unit.getAttack(), target, false, attackerAbilityPower, 1, 1);
    return minimumDamage >= target.getCumulativeHp();
}

/**
 * Native v0.8 Blacksmith router. The selected legal Craft anchor becomes SearchDriver's incumbent whenever it
 * reaches at least two distinct living allies. Count is the primary objective; future combat output breaks
 * equal-count ties. A dominant/urgent terminal sprint and a proven immediate kill retain the native action.
 */
export function prioritizeV08BlacksmithCraft(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    if (unit.getName() !== "Blacksmith") return decision;
    const craft = unit
        .getSpells()
        .find((spell) => spell.getName() === V08_BLACKSMITH_CRAFT_SPELL && isSpellUsableByCaster(unit, spell));
    if (!craft) return decision;
    if (
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), context.fightProperties?.getCurrentLap() ?? 0)
            .active ||
        isV08BlacksmithImmediateGuaranteedKill(unit, context, decision)
    ) {
        return decision;
    }

    const enumerated = enumerateCandidates(unit, context, decision, {
        maxMoveDestinations: 1,
        maxMeleePairs: 6,
        maxShotAims: 4,
        maxAreaThrowCells: 2,
        enrichIncumbentMetadata: true,
    });
    let best: ICraftCandidate | undefined;
    enumerated.candidates.forEach((candidate, sourceIndex) => {
        const cast = craftAction(candidate);
        if (!cast?.targetCell) return;
        const recipients = v08BlacksmithCraftRecipientsAt(unit, context, cast.targetCell);
        const scored: ICraftCandidate = {
            candidate,
            recipientCount: recipients.length,
            recipientValue: recipients.reduce(
                (total, recipient) =>
                    Math.min(Number.MAX_SAFE_INTEGER, total + v08BlacksmithCraftRecipientValue(recipient)),
                0,
            ),
            sourceIndex,
        };
        if (betterCraftCandidate(scored, best)) best = scored;
    });
    return best && best.recipientCount >= 2 ? best.candidate.actions : decision;
}

/** Pure public-roster classifier used by placement and focused tests. */
export function v08PublicRosterPunishesCraftCluster(opponentCreatureIds: readonly number[]): boolean {
    return opponentCreatureIds.some((creatureId) => {
        const info = creatureInfo(creatureId);
        if (!info) return false;
        return (
            V08_CRAFT_CLUSTER_RANGED_AOE_ABILITIES.some((ability) => info.abilities.includes(ability)) ||
            V08_CRAFT_CLUSTER_MAGIC_AOE_ABILITIES.some((ability) => info.abilities.includes(ability)) ||
            V08_CRAFT_CLUSTER_MAGIC_AOE_CREATURES.includes(info.name)
        );
    });
}

const placementHasUsableCraft = (unit: Unit): boolean =>
    unit.getName() === "Blacksmith" &&
    !unit.isDead() &&
    unit
        .getSpells()
        .some((spell) => spell.getName() === V08_BLACKSMITH_CRAFT_SPELL && isSpellUsableByCaster(unit, spell));

interface IProtectedPlacementEdge {
    readonly protector: Unit;
    readonly beneficiary: Unit;
    readonly range: number;
}

const placementProtectionRange = (protector: Unit): number => {
    const kind = v08BacklineProtectorKind(protector);
    // Angel: board-wide blessing, no aura config to read — keep the trained screen radius (see
    // V08_ANGEL_SCREEN_RANGE). The other protectors still project real auras.
    if (kind === "angel") {
        return V08_ANGEL_SCREEN_RANGE;
    }
    const auraName = kind === "abomination" ? "Flesh Shield" : kind === "arachna_queen" ? "Web" : undefined;
    return Math.max(0, Math.floor((auraName ? protector.getAuraEffect(auraName)?.getRange() : undefined) ?? 1));
};

const protectedPlacementEdges = (
    units: readonly Unit[],
    inherited: ReadonlyMap<string, XY>,
): IProtectedPlacementEdge[] => {
    const protectors = units.filter((unit) => v08BacklineProtectorKind(unit) !== undefined);
    const beneficiaries = units.filter(isV08BacklineProtectionBeneficiary);
    const edges: IProtectedPlacementEdge[] = [];
    for (const protector of protectors) {
        const protectorBase = inherited.get(protector.getId());
        if (!protectorBase) continue;
        const protectorFootprint = footprintForBase(protector, protectorBase);
        const range = placementProtectionRange(protector);
        for (const beneficiary of beneficiaries) {
            if (beneficiary.getId() === protector.getId()) continue;
            const beneficiaryBase = inherited.get(beneficiary.getId());
            if (
                beneficiaryBase &&
                footprintDistance(protectorFootprint, footprintForBase(beneficiary, beneficiaryBase)) <= range
            ) {
                edges.push({ protector, beneficiary, range });
            }
        }
    }
    return edges;
};

const combinations = <T>(values: readonly T[], count: number): T[][] => {
    const out: T[][] = [];
    const visit = (start: number, selected: T[]): void => {
        if (selected.length === count) {
            out.push([...selected]);
            return;
        }
        for (let index = start; index <= values.length - (count - selected.length); index += 1) {
            selected.push(values[index]);
            visit(index + 1, selected);
            selected.pop();
        }
    };
    visit(0, []);
    return out;
};

interface IAssignment {
    readonly cells: XY[];
    readonly displacement: number;
    readonly signature: string;
}

const bestAssignment = (
    selected: readonly Unit[],
    anchor: XY,
    legal: ReadonlySet<number>,
    fixedCells: ReadonlySet<number>,
    inherited: ReadonlyMap<string, XY>,
    protectedEdges: readonly IProtectedPlacementEdge[],
): IAssignment | undefined => {
    const targetKeys = new Set(craftCells(anchor).filter(onBoard).map(key));
    const legalBases = [...legal]
        .map((cellKey) => ({ x: cellKey >> 4, y: cellKey & 0xf }))
        .sort((left, right) => left.y - right.y || left.x - right.x);
    const availableBases = selected.map((unit) =>
        legalBases.filter((base) => {
            const footprint = footprintForBase(unit, base);
            return (
                footprint.every((cell) => legal.has(key(cell)) && !fixedCells.has(key(cell))) &&
                footprint.some((cell) => targetKeys.has(key(cell)))
            );
        }),
    );
    if (availableBases.some((bases) => !bases.length)) return undefined;

    let best: IAssignment | undefined;
    const used = new Set<number>();
    const assigned: XY[] = [];
    const visit = (index: number, displacement: number): void => {
        if (index === selected.length) {
            const byUnit = new Map(selected.map((unit, unitIndex) => [unit.getId(), assigned[unitIndex]]));
            const preservesProtection = protectedEdges.every(({ protector, beneficiary, range }) => {
                const protectorBase = byUnit.get(protector.getId()) ?? inherited.get(protector.getId());
                const beneficiaryBase = byUnit.get(beneficiary.getId()) ?? inherited.get(beneficiary.getId());
                return (
                    !!protectorBase &&
                    !!beneficiaryBase &&
                    footprintDistance(
                        footprintForBase(protector, protectorBase),
                        footprintForBase(beneficiary, beneficiaryBase),
                    ) <= range
                );
            });
            if (!preservesProtection) return;
            const signature = assigned.map((cell) => `${cell.x},${cell.y}`).join("|");
            if (
                !best ||
                displacement < best.displacement ||
                (displacement === best.displacement && signature < best.signature)
            ) {
                best = { cells: assigned.map((cell) => ({ ...cell })), displacement, signature };
            }
            return;
        }
        const unit = selected[index];
        const original = inherited.get(unit.getId());
        if (!original) return;
        for (const base of availableBases[index]) {
            const footprintKeys = footprintForBase(unit, base).map(key);
            if (footprintKeys.some((cellKey) => used.has(cellKey))) continue;
            footprintKeys.forEach((cellKey) => used.add(cellKey));
            assigned.push(base);
            visit(index + 1, displacement + Math.abs(original.x - base.x) + Math.abs(original.y - base.y));
            assigned.pop();
            footprintKeys.forEach((cellKey) => used.delete(cellKey));
        }
    };
    visit(0, 0);
    return best;
};

interface IPlacementCandidate {
    readonly selected: Unit[];
    readonly cells: XY[];
    readonly recipientValue: number;
    readonly displacement: number;
    readonly anchor: XY;
    readonly signature: string;
}

const betterPlacementCandidate = (
    candidate: IPlacementCandidate,
    incumbent: IPlacementCandidate | undefined,
): boolean =>
    !incumbent ||
    candidate.recipientValue > incumbent.recipientValue ||
    (candidate.recipientValue === incumbent.recipientValue &&
        (candidate.displacement < incumbent.displacement ||
            (candidate.displacement === incumbent.displacement &&
                (candidate.anchor.y < incumbent.anchor.y ||
                    (candidate.anchor.y === incumbent.anchor.y &&
                        (candidate.anchor.x < incumbent.anchor.x ||
                            (candidate.anchor.x === incumbent.anchor.x &&
                                candidate.signature < incumbent.signature)))))));

/**
 * Compose Blacksmith's no-AOE opening after an inherited/protector layout. Up to four distinct high-value
 * allies whose SMALL/LARGE footprints intersect one legal 2x2 are moved, while every unselected footprint and
 * every existing protector-beneficiary adjacency remains fixed. Against public ranged/magic AOE—or when the
 * public opponent roster is unavailable—the exact inherited map object is returned unchanged.
 */
export function v08BlacksmithCraftPlacement(
    units: Unit[],
    context: IPlacementContext,
    inherited: Map<string, XY>,
): Map<string, XY> {
    const opponentCreatureIds = opponentCreatureIdsForPlacement(context, "v0.8");
    if (
        !units.some(placementHasUsableCraft) ||
        context.publicOpponentCreatureIds === undefined ||
        !opponentCreatureIds?.length ||
        v08PublicRosterPunishesCraftCluster(opponentCreatureIds) ||
        units.some((unit) => !inherited.has(unit.getId()))
    ) {
        return inherited;
    }

    const legal = context.placement.possibleCellHashes();
    const anchors = [...legal]
        .map((cellKey) => ({ x: cellKey >> 4, y: cellKey & 0xf }))
        .filter((anchor) => craftCells(anchor).every((cell) => onBoard(cell) && legal.has(key(cell))))
        .sort((left, right) => left.y - right.y || left.x - right.x);
    const recipients = units
        .filter((unit) => !unit.isDead())
        .sort(
            (left, right) =>
                v08BlacksmithCraftRecipientValue(right) - v08BlacksmithCraftRecipientValue(left) ||
                left.getId().localeCompare(right.getId()),
        );
    if (recipients.length < 2 || !anchors.length) return inherited;

    const protectedEdges = protectedPlacementEdges(units, inherited);
    for (let recipientCount = Math.min(4, recipients.length); recipientCount >= 2; recipientCount -= 1) {
        let best: IPlacementCandidate | undefined;
        for (const selected of combinations(recipients, recipientCount)) {
            const selectedIds = new Set(selected.map((unit) => unit.getId()));
            const fixedCells = new Set<number>();
            for (const unit of units) {
                if (selectedIds.has(unit.getId())) continue;
                const base = inherited.get(unit.getId());
                if (!base) continue;
                for (const cell of footprintForBase(unit, base)) fixedCells.add(key(cell));
            }
            const recipientValue = selected.reduce(
                (total, unit) => Math.min(Number.MAX_SAFE_INTEGER, total + v08BlacksmithCraftRecipientValue(unit)),
                0,
            );
            for (const anchor of anchors) {
                const cells = craftCells(anchor);
                if (cells.some((cell) => fixedCells.has(key(cell)))) continue;
                const assignment = bestAssignment(selected, anchor, legal, fixedCells, inherited, protectedEdges);
                if (!assignment) continue;
                const candidate: IPlacementCandidate = {
                    selected,
                    cells: assignment.cells,
                    recipientValue,
                    displacement: assignment.displacement,
                    anchor,
                    signature: `${selected.map((unit) => unit.getId()).join("|")}@${assignment.signature}`,
                };
                if (betterPlacementCandidate(candidate, best)) best = candidate;
            }
        }
        if (best) {
            const composed = new Map<string, XY>(
                [...inherited].map(([unitId, cell]) => [unitId, { x: cell.x, y: cell.y }]),
            );
            best.selected.forEach((unit, index) => composed.set(unit.getId(), { ...best!.cells[index] }));
            return composed;
        }
    }
    return inherited;
}
