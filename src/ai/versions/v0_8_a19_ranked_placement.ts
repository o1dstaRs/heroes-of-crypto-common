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
import { GRID_SIZE } from "../../grid/grid_constants";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";
import { FLYER_SCREEN_THRESHOLD, SPLASH_AOE_ABILITIES, layoutRevealPlacement } from "./v0_7_placement_reveal";

export const V08_A19_RANKED_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_ranked_placement.v8" as const,
    policyId: "a19-ranked-placement-v8" as const,
    researchOnly: true as const,
    baseStrategy: "v0.8+a19-h18" as const,
    maps: Object.freeze([PBTypes.GridVals.NORMAL] as const),
    information: "own-army+map+legal-cells+public-opponent-identities" as const,
    treatment: "physical-role-corrected-double-flyer-shooter-screen" as const,
});

export type V08A19RankedPlacementFallbackReason =
    | "unsupported-map"
    | "unauthorized-or-missing-public-roster"
    | "opponent-unknown-or-not-double-flyer"
    | "opponent-splash"
    | "partial-army"
    | "unknown-own-identity"
    | "split-summoned-or-duplicate-army"
    | "special-topology"
    | "not-incumbent-shooter-screen"
    | "not-reviewed-two-two-two-formation"
    | "no-physical-melee-magic-correction"
    | "candidate-incomplete-or-illegal"
    | "unchanged";

export interface IV08A19RankedPlacementAudit {
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly horizontalDisplacement: number;
    readonly correctedPhysicalUnits: number;
    readonly correctedForwardPhysicals: number;
    readonly correctedGroundScreens: number;
    readonly nativeSpellbookBackliners: number;
    readonly fallbackReason: V08A19RankedPlacementFallbackReason | null;
    readonly incumbentFingerprint: string;
    readonly selectedFingerprint: string;
}

interface IPlacementEvaluation {
    readonly selected: Map<string, XY>;
    readonly treatmentApplied: boolean;
    readonly horizontalDisplacement: number;
    readonly correctedPhysicalUnits: number;
    readonly correctedForwardPhysicals: number;
    readonly correctedGroundScreens: number;
    readonly nativeSpellbookBackliners: number;
    readonly fallbackReason: V08A19RankedPlacementFallbackReason | null;
}

interface IPublicRosterThreats {
    readonly flyers: number;
    readonly splashAoe: number;
}

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const SPECIAL_TOPOLOGY_NAMES = new Set(["Abomination", "Angel", "Arachna Queen", "Blacksmith"]);
const key = (cell: XY): number => (cell.x << 4) | cell.y;

const creatureInfoForUnit = (unit: Unit) => {
    const creatureId = creatureIdForName(unit.getName());
    return creatureId === undefined ? undefined : creatureInfo(creatureId);
};

const hasNativeSpellbook = (unit: Unit): boolean => creatureInfoForUnit(unit)?.nativeSpellbook === true;

const isCorrectedPhysicalMeleeMagic = (unit: Unit): boolean =>
    unit.getAttackType() === MELEE_MAGIC && !hasNativeSpellbook(unit);

const inspectPublicRoster = (publicIds: readonly number[]): IPublicRosterThreats | undefined => {
    let flyers = 0;
    let splashAoe = 0;
    for (const creatureId of publicIds) {
        const info = creatureInfo(creatureId);
        if (!info) return undefined;
        flyers += Number(info.canFly);
        splashAoe += Number(SPLASH_AOE_ABILITIES.some((ability) => info.abilities.includes(ability)));
    }
    return { flyers, splashAoe };
};

const footprintFor = (unit: Unit, base: XY): XY[] => unit.getFootprintCellsForBase(base);

const centerFor = (unit: Unit, base: XY): XY => ({
    x: base.x - (unit.getFootprintWidth() - 1) / 2,
    y: base.y - (unit.getFootprintHeight() - 1) / 2,
});

const frontness = (team: IPlacementContext["team"], cell: XY): number =>
    team === PBTypes.TeamVals.LOWER ? cell.y : GRID_SIZE - 1 - cell.y;

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

const placementsEqualByUnit = (
    units: readonly Unit[],
    left: ReadonlyMap<string, XY>,
    right: ReadonlyMap<string, XY>,
): boolean =>
    left.size === units.length &&
    right.size === units.length &&
    units.every((unit) => {
        const leftCell = left.get(unit.getId());
        const rightCell = right.get(unit.getId());
        return !!leftCell && !!rightCell && leftCell.x === rightCell.x && leftCell.y === rightCell.y;
    });

const isFastPhysical = (unit: Unit): boolean =>
    unit.canFly() ||
    (isCorrectedPhysicalMeleeMagic(unit) &&
        ((unit.isSmallSize() && unit.getSteps() >= 7) ||
            unit.hasAbilityActive("Rapid Charge") ||
            unit.hasAbilityActive("Sky Runner")));

const normalizedPlacementFingerprint = (
    units: readonly Unit[],
    team: IPlacementContext["team"],
    placement: ReadonlyMap<string, XY>,
): string => {
    const rows = units.map((unit) => {
        const base = placement.get(unit.getId());
        const center = base ? centerFor(unit, base) : undefined;
        const descriptor = JSON.stringify([
            unit.getName(),
            unit.getLevel(),
            unit.getAmountAlive(),
            unit.getFootprintWidth() * unit.getFootprintHeight(),
            unit.getAttackType(),
        ]);
        return {
            descriptor,
            x: center?.x ?? null,
            frontness: center === undefined ? null : frontness(team, center),
        };
    });
    rows.sort(
        (left, right) =>
            left.descriptor.localeCompare(right.descriptor) ||
            (left.x ?? -1) - (right.x ?? -1) ||
            (left.frontness ?? -1) - (right.frontness ?? -1),
    );
    return JSON.stringify(rows.map((row, order) => [order, row.descriptor, row.x, row.frontness]));
};

const evaluateV08A19RankedPlacement = (
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): IPlacementEvaluation => {
    const fallback = (
        fallbackReason: V08A19RankedPlacementFallbackReason,
        diagnostics: Partial<
            Pick<
                IPlacementEvaluation,
                | "correctedPhysicalUnits"
                | "correctedForwardPhysicals"
                | "correctedGroundScreens"
                | "nativeSpellbookBackliners"
            >
        > = {},
    ): IPlacementEvaluation => ({
        selected: incumbent,
        treatmentApplied: false,
        horizontalDisplacement: 0,
        correctedPhysicalUnits: diagnostics.correctedPhysicalUnits ?? 0,
        correctedForwardPhysicals: diagnostics.correctedForwardPhysicals ?? 0,
        correctedGroundScreens: diagnostics.correctedGroundScreens ?? 0,
        nativeSpellbookBackliners: diagnostics.nativeSpellbookBackliners ?? 0,
        fallbackReason,
    });

    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return fallback("unsupported-map");
    const setupPlacementPolicy = context.setupPlacementPolicy ?? "public-roster";
    if (setupPlacementPolicy !== "public-roster" || context.publicOpponentCreatureIds === undefined) {
        return fallback("unauthorized-or-missing-public-roster");
    }
    const publicThreats = inspectPublicRoster(context.publicOpponentCreatureIds);
    if (!publicThreats || publicThreats.flyers < FLYER_SCREEN_THRESHOLD) {
        return fallback("opponent-unknown-or-not-double-flyer");
    }
    if (publicThreats.splashAoe > 0) return fallback("opponent-splash");

    const ownArmy = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const requestedIds = new Set(units.map((unit) => unit.getId()));
    if (
        requestedIds.size !== units.length ||
        ownArmy.length !== units.length ||
        ownArmy.some((unit) => !requestedIds.has(unit.getId()))
    ) {
        return fallback("partial-army");
    }
    if (ownArmy.some((unit) => creatureInfoForUnit(unit) === undefined)) return fallback("unknown-own-identity");
    const ownIdentities = ownArmy.map((unit) => `${unit.getName()}:${unit.getLevel()}`);
    if (ownArmy.some((unit) => unit.isSummoned()) || new Set(ownIdentities).size !== ownIdentities.length) {
        return fallback("split-summoned-or-duplicate-army");
    }
    if (ownArmy.some((unit) => SPECIAL_TOPOLOGY_NAMES.has(unit.getName()))) return fallback("special-topology");

    // Match the exact incumbent reveal branch before applying the role correction. This prevents v8 from
    // inventing a shooter screen in a matchup where StrategyV0_8 did not already select one.
    const hasNativeShooter = ownArmy.some((unit) => unit.getAttackType() === RANGE);
    const hasHistoricalGroundGuard = ownArmy.some((unit) => unit.getAttackType() === MELEE && !unit.canFly());
    if (!hasNativeShooter || !hasHistoricalGroundGuard) return fallback("not-incumbent-shooter-screen");

    const correctedPhysical = ownArmy.filter(isCorrectedPhysicalMeleeMagic);
    if (!correctedPhysical.length) return fallback("no-physical-melee-magic-correction");

    const effectiveContext: IPlacementContext = { ...context, setupPlacementPolicy };
    const historicalShooterScreen = layoutRevealPlacement(units, effectiveContext, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
    });
    if (
        !placementIsCompleteAndLegal(units, historicalShooterScreen, effectiveContext) ||
        !placementsEqualByUnit(units, incumbent, historicalShooterScreen)
    ) {
        return fallback("not-incumbent-shooter-screen", { correctedPhysicalUnits: correctedPhysical.length });
    }

    const roleCounts = ownArmy.reduce(
        (counts, unit) => {
            const physical = unit.getAttackType() === MELEE || isCorrectedPhysicalMeleeMagic(unit);
            if (!physical || unit.getAttackType() === RANGE || hasNativeSpellbook(unit)) counts.backline += 1;
            else if (isFastPhysical(unit)) counts.fast += 1;
            else counts.screen += 1;
            return counts;
        },
        { backline: 0, screen: 0, fast: 0 },
    );
    if (ownArmy.length !== 6 || roleCounts.backline !== 2 || roleCounts.screen !== 2 || roleCounts.fast !== 2) {
        return fallback("not-reviewed-two-two-two-formation", {
            correctedPhysicalUnits: correctedPhysical.length,
        });
    }

    const selected = layoutRevealPlacement(units, effectiveContext, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
        physicalMeleeMagicRoles: true,
    });
    if (!placementIsCompleteAndLegal(units, selected, effectiveContext)) {
        return fallback("candidate-incomplete-or-illegal", { correctedPhysicalUnits: correctedPhysical.length });
    }

    const incumbentFingerprint = normalizedPlacementFingerprint(units, context.team, incumbent);
    const selectedFingerprint = normalizedPlacementFingerprint(units, context.team, selected);
    if (incumbentFingerprint === selectedFingerprint) {
        return fallback("unchanged", { correctedPhysicalUnits: correctedPhysical.length });
    }

    const horizontalDisplacement = units.reduce((sum, unit) => {
        const before = incumbent.get(unit.getId());
        const after = selected.get(unit.getId());
        return sum + (before && after ? Math.abs(centerFor(unit, after).x - centerFor(unit, before).x) : 0);
    }, 0);
    const correctedForwardPhysicals = correctedPhysical.filter((unit) => {
        if (!isFastPhysical(unit)) return false;
        const before = incumbent.get(unit.getId());
        const after = selected.get(unit.getId());
        return (
            !!before &&
            !!after &&
            frontness(context.team, centerFor(unit, after)) > frontness(context.team, centerFor(unit, before))
        );
    }).length;
    const correctedGroundScreens = correctedPhysical.filter((unit) => {
        if (isFastPhysical(unit)) return false;
        const before = incumbent.get(unit.getId());
        const after = selected.get(unit.getId());
        return !!before && !!after && (before.x !== after.x || before.y !== after.y);
    }).length;
    const nativeSpellbookBackliners = ownArmy.filter(
        (unit) => unit.getAttackType() === MELEE_MAGIC && hasNativeSpellbook(unit),
    ).length;
    if (correctedForwardPhysicals + correctedGroundScreens === 0) {
        return fallback("unchanged", {
            correctedPhysicalUnits: correctedPhysical.length,
            correctedForwardPhysicals,
            correctedGroundScreens,
            nativeSpellbookBackliners,
        });
    }
    return {
        selected,
        treatmentApplied: true,
        horizontalDisplacement,
        correctedPhysicalUnits: correctedPhysical.length,
        correctedForwardPhysicals,
        correctedGroundScreens,
        nativeSpellbookBackliners,
        fallbackReason: null,
    };
};

/**
 * Production-derived correction layered only over v0.8's existing public two-flyer shooter screen. It consumes
 * no opponent runtime state: the only opponent input is the complete placement-public creature-id roster.
 */
export function applyV08A19RankedPlacement(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    return evaluateV08A19RankedPlacement(units, context, incumbent).selected;
}

/** A19-only placement decorator; combat and the base strategy's version/search scope remain unchanged. */
export class V08A19RankedPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private lastPlacementAudit?: IV08A19RankedPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const evaluation = evaluateV08A19RankedPlacement(units, context, incumbent);
        const incumbentFingerprint = normalizedPlacementFingerprint(units, context.team, incumbent);
        const selectedFingerprint = normalizedPlacementFingerprint(units, context.team, evaluation.selected);
        this.lastPlacementAudit = Object.freeze({
            treatmentApplied: evaluation.treatmentApplied,
            placementChanged: incumbentFingerprint !== selectedFingerprint,
            horizontalDisplacement: evaluation.horizontalDisplacement,
            correctedPhysicalUnits: evaluation.correctedPhysicalUnits,
            correctedForwardPhysicals: evaluation.correctedForwardPhysicals,
            correctedGroundScreens: evaluation.correctedGroundScreens,
            nativeSpellbookBackliners: evaluation.nativeSpellbookBackliners,
            fallbackReason: evaluation.fallbackReason,
            incumbentFingerprint,
            selectedFingerprint,
        });
        return evaluation.selected;
    }
    public getLastPlacementAudit(): IV08A19RankedPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export const withV08A19RankedPlacement = (base: IAIStrategy): IAIStrategy => new V08A19RankedPlacementStrategy(base);
