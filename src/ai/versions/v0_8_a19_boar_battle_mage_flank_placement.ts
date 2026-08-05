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
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";

export const V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT = "boar-battle-mage-far-flank-v1" as const;

/** Immutable identity for the default-off placement treatment. */
export const V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_boar_battle_mage_flank_placement.v1" as const,
    policyId: "a19-boar-battle-mage-far-flank-v1" as const,
    researchOnly: true as const,
    defaultEnabled: false as const,
    maps: Object.freeze([PBTypes.GridVals.NORMAL] as const),
    information: "own-army+map+legal-cells" as const,
    rosterCondition: Object.freeze({
        frenziedBoarCount: 1 as const,
        minimumBattleMageCount: 1 as const,
    }),
    expectedCompactOrigin: Object.freeze({
        x: 2 as const,
        lowerY: 3 as const,
        upperY: 13 as const,
    }),
    destination: Object.freeze({ x: 14 as const, preserveY: true as const }),
    treatment: V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT,
});

export type V08A19BoarBattleMageFlankFallbackReason =
    | "unsupported-map"
    | "unsupported-team"
    | "partial-army"
    | "summoned-army"
    | "roster-condition-not-met"
    | "unexpected-compact-origin"
    | "candidate-incomplete-or-illegal";

export interface IV08A19BoarBattleMageFlankPlacementAudit {
    readonly treatment: typeof V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT | null;
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly boarId: string | null;
    readonly battleMageCount: number;
    readonly fallbackReason: V08A19BoarBattleMageFlankFallbackReason | null;
}

interface IPlacementEvaluation {
    readonly selected: Map<string, XY>;
    readonly audit: IV08A19BoarBattleMageFlankPlacementAudit;
}

const key = (cell: XY): number => (cell.x << 4) | cell.y;

const footprintFor = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [base]
        : [base, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];

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

const evaluateBoarBattleMageFlankPlacement = (
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): IPlacementEvaluation => {
    const ownArmy = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const battleMageCount = ownArmy.filter((unit) => unit.getName() === "Battle Mage").length;
    const boars = ownArmy.filter((unit) => unit.getName() === "Frenzied Boar");
    const fallback = (
        fallbackReason: V08A19BoarBattleMageFlankFallbackReason,
        boarId: string | null = boars.length === 1 ? boars[0].getId() : null,
    ): IPlacementEvaluation => ({
        selected: incumbent,
        audit: Object.freeze({
            treatment: null,
            treatmentApplied: false,
            placementChanged: false,
            boarId,
            battleMageCount,
            fallbackReason,
        }),
    });

    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return fallback("unsupported-map");
    const expectedY =
        context.team === PBTypes.TeamVals.LOWER
            ? V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.expectedCompactOrigin.lowerY
            : context.team === PBTypes.TeamVals.UPPER
              ? V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.expectedCompactOrigin.upperY
              : null;
    if (expectedY === null) return fallback("unsupported-team");

    const requestedIds = new Set(units.map((unit) => unit.getId()));
    if (
        requestedIds.size !== units.length ||
        ownArmy.length !== units.length ||
        ownArmy.some((unit) => !requestedIds.has(unit.getId()))
    ) {
        return fallback("partial-army");
    }
    if (ownArmy.some((unit) => unit.isSummoned())) return fallback("summoned-army");
    if (boars.length !== 1 || battleMageCount < 1) return fallback("roster-condition-not-met");

    const boar = boars[0];
    const origin = incumbent.get(boar.getId());
    if (
        origin?.x !== V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.expectedCompactOrigin.x ||
        origin.y !== expectedY
    ) {
        return fallback("unexpected-compact-origin", boar.getId());
    }

    const selected = new Map(incumbent);
    selected.set(boar.getId(), {
        x: V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.destination.x,
        y: origin.y,
    });
    if (!placementIsCompleteAndLegal(units, selected, context)) {
        return fallback("candidate-incomplete-or-illegal", boar.getId());
    }

    return {
        selected,
        audit: Object.freeze({
            treatment: V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT,
            treatmentApplied: true,
            placementChanged: true,
            boarId: boar.getId(),
            battleMageCount,
            fallbackReason: null,
        }),
    };
};

/**
 * Default-off placement-only decorator. The wrapped strategy always initializes first; eligible compact
 * Frenzied Boar + Battle Mage armies then move only the Boar onto the reviewed far-right two-cell footprint.
 */
export class V08A19BoarBattleMageFlankPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private lastPlacementAudit?: IV08A19BoarBattleMageFlankPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const evaluation = evaluateBoarBattleMageFlankPlacement(units, context, incumbent);
        this.lastPlacementAudit = evaluation.audit;
        return evaluation.selected;
    }
    public getLastPlacementAudit(): IV08A19BoarBattleMageFlankPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export const withV08A19BoarBattleMageFlankPlacement = (base: IAIStrategy): V08A19BoarBattleMageFlankPlacementStrategy =>
    new V08A19BoarBattleMageFlankPlacementStrategy(base);
