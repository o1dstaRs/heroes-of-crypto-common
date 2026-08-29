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

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { StrategyV0_1 } from "./v0_1";

export const V08_A19_COMPACT_PLACEMENT_ANCHORS = Object.freeze([
    "Abomination",
    "Angel",
    "Arachna Queen",
    "Black Dragon",
    "Frenzied Boar",
    "Thunderbird",
] as const);

export const V08_A19_COMPACT_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_compact_placement.v1" as const,
    policyId: "a19-l4-scoped-compact-placement-v1" as const,
    researchOnly: true as const,
    maps: Object.freeze([PBTypes.GridVals.NORMAL] as const),
    information: "own-army+map+legal-cells" as const,
    anchors: V08_A19_COMPACT_PLACEMENT_ANCHORS,
    treatment: "preserve-base-initialization-then-use-v0.1-compact-coordinates" as const,
});

export type V08A19CompactPlacementFallbackReason =
    | "unsupported-map"
    | "partial-army"
    | "summoned-army"
    | "unselected-anchor"
    | "candidate-incomplete-or-illegal"
    | "unchanged";

export interface IV08A19CompactPlacementAudit {
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly selectedAnchor: string | null;
    readonly fallbackReason: V08A19CompactPlacementFallbackReason | null;
}

interface IPlacementEvaluation {
    readonly selected: Map<string, XY>;
    readonly treatmentApplied: boolean;
    readonly selectedAnchor: string | null;
    readonly fallbackReason: V08A19CompactPlacementFallbackReason | null;
}

const ANCHORS = new Set<string>(V08_A19_COMPACT_PLACEMENT_ANCHORS);
const key = (cell: XY): number => (cell.x << 4) | cell.y;

// The unit's real body, from the one shared expansion. This feeds the treatment's own legality gate, so the
// 1x1-or-2x2 copy this replaced made a rectangle report `candidate-incomplete-or-illegal` and silently
// disabled the whole treatment (or, worse, validated a layout whose real footprint overlaps a neighbour).
const footprintFor = (unit: Unit, base: XY): XY[] => footprintCellsForAnchor(unit, base);

const placementIsCompleteAndLegal = (
    units: readonly Unit[],
    placement: ReadonlyMap<string, XY>,
    context: IPlacementContext,
): boolean => {
    if (placement.size !== units.length) return false;
    const legal = context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of units) {
        const base = placement.get(unit.getId());
        if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.y)) return false;
        for (const cell of footprintFor(unit, base)) {
            const cellKey = key(cell);
            if (!legal.has(cellKey) || occupied.has(cellKey)) return false;
            occupied.add(cellKey);
        }
    }
    return true;
};

const placementsEqual = (
    units: readonly Unit[],
    left: ReadonlyMap<string, XY>,
    right: ReadonlyMap<string, XY>,
): boolean =>
    left.size === units.length &&
    right.size === units.length &&
    units.every((unit) => {
        const a = left.get(unit.getId());
        const b = right.get(unit.getId());
        return !!a && !!b && a.x === b.x && a.y === b.y;
    });

const evaluateCompactPlacement = (
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): IPlacementEvaluation => {
    const fallback = (fallbackReason: V08A19CompactPlacementFallbackReason): IPlacementEvaluation => ({
        selected: incumbent,
        treatmentApplied: false,
        selectedAnchor: null,
        fallbackReason,
    });

    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return fallback("unsupported-map");
    const ownArmy = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const requestedIds = new Set(units.map((unit) => unit.getId()));
    if (
        requestedIds.size !== units.length ||
        ownArmy.length !== units.length ||
        ownArmy.some((unit) => !requestedIds.has(unit.getId()))
    ) {
        return fallback("partial-army");
    }
    if (ownArmy.some((unit) => unit.isSummoned())) return fallback("summoned-army");
    const selectedAnchor = ownArmy.find((unit) => ANCHORS.has(unit.getName()))?.getName();
    if (!selectedAnchor) return fallback("unselected-anchor");

    const selected = new StrategyV0_1().placeArmy(units, context);
    if (!placementIsCompleteAndLegal(units, selected, context)) return fallback("candidate-incomplete-or-illegal");
    if (placementsEqual(units, incumbent, selected)) return fallback("unchanged");
    return { selected, treatmentApplied: true, selectedAnchor, fallbackReason: null };
};

/**
 * Placement-only A19 decorator. Calling the wrapped placement first is part of the contract: v0.8 owns
 * placement-time strategy initialization even when the returned coordinates are replaced.
 */
export class V08A19CompactPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private lastPlacementAudit?: IV08A19CompactPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const evaluation = evaluateCompactPlacement(units, context, incumbent);
        this.lastPlacementAudit = Object.freeze({
            treatmentApplied: evaluation.treatmentApplied,
            placementChanged: evaluation.selected !== incumbent,
            selectedAnchor: evaluation.selectedAnchor,
            fallbackReason: evaluation.fallbackReason,
        });
        return evaluation.selected;
    }
    public getLastPlacementAudit(): IV08A19CompactPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export const withV08A19CompactPlacement = (base: IAIStrategy): V08A19CompactPlacementStrategy =>
    new V08A19CompactPlacementStrategy(base);
