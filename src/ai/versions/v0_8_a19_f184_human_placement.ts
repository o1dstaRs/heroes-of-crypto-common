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
import { PlacementType } from "../../grid/placement_properties";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";

// Re-pinned for the perk -> doctrine rename; same anchor bytes as V08_A19_PROD_F184_FIXTURE_SHA256,
// whose values did not move — only the field name did.
export const V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256 =
    "6649cc5a3fe134f0289c1d6ffb8a056cf25e1a56d6c45f5a34f53354b1cdc0a1" as const;

export const V08_A19_F184_HUMAN_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_f184_human_placement.v10" as const,
    policyId: "a19-prod-f184-opening-v1" as const,
    researchOnly: true as const,
    baseStrategy: "v0.8+a19-h18" as const,
    maps: Object.freeze([PBTypes.GridVals.NORMAL] as const),
    information: "own-army+map+legal-cells+public-opponent-identities" as const,
    treatment: "exact-public-matchup-production-opening" as const,
    productionFixtureSha256: V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
});

export type V08A19F184HumanPlacementFallbackReason =
    | "unsupported-map"
    | "unsupported-team"
    | "unsupported-placement-geometry"
    | "unauthorized-or-missing-public-roster"
    | "invalid-public-roster"
    | "unknown-public-identity"
    | "partial-army"
    | "unknown-own-identity"
    | "split-summoned-or-duplicate-army"
    | "own-unit-shape-mismatch"
    | "unmatched-public-opening"
    | "candidate-incomplete-or-illegal"
    | "unchanged";

export type V08A19F184HumanOpeningId = "prod-f184-lower-roster" | "prod-f184-upper-roster";

export interface IV08A19F184HumanPlacementAudit {
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly horizontalDisplacement: number;
    readonly openingId: V08A19F184HumanOpeningId | null;
    readonly templateUnitsMoved: number;
    readonly fallbackReason: V08A19F184HumanPlacementFallbackReason | null;
    readonly incumbentFingerprint: string;
    readonly selectedFingerprint: string;
}

interface IPlacementEvaluation {
    readonly selected: Map<string, XY>;
    readonly treatmentApplied: boolean;
    readonly horizontalDisplacement: number;
    readonly openingId: V08A19F184HumanOpeningId | null;
    readonly templateUnitsMoved: number;
    readonly fallbackReason: V08A19F184HumanPlacementFallbackReason | null;
}

interface IOpeningUnit {
    readonly creatureId: number;
    readonly name: string;
    readonly level: number;
    readonly size: number;
    readonly faction: number;
    /** Base cell normalized to LOWER. Large units use the engine's upper-right footprint anchor. */
    readonly lowerBase: Readonly<XY>;
}

interface IOpeningRecipe {
    readonly id: V08A19F184HumanOpeningId;
    readonly ownUnits: readonly IOpeningUnit[];
    readonly opponentCreatureIds: readonly number[];
}

const SMALL = PBTypes.UnitSizeVals.SMALL;
const LARGE = PBTypes.UnitSizeVals.LARGE;
const LEVEL_1 = PBTypes.UnitLevelVals.FIRST;
const LEVEL_2 = PBTypes.UnitLevelVals.SECOND;
const LEVEL_3 = PBTypes.UnitLevelVals.THIRD;
const LEVEL_4 = PBTypes.UnitLevelVals.FOURTH;

const LOWER_ROSTER: readonly IOpeningUnit[] = Object.freeze([
    Object.freeze({
        creatureId: PBTypes.CreatureVals.TROGLODYTE,
        name: "Troglodyte",
        level: LEVEL_1,
        size: SMALL,
        faction: PBTypes.FactionVals.CHAOS,
        lowerBase: Object.freeze({ x: 13, y: 2 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.ARBALESTER,
        name: "Arbalester",
        level: LEVEL_1,
        size: SMALL,
        faction: PBTypes.FactionVals.LIFE,
        lowerBase: Object.freeze({ x: 14, y: 1 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.BEHOLDER,
        name: "Beholder",
        level: LEVEL_2,
        size: SMALL,
        faction: PBTypes.FactionVals.CHAOS,
        lowerBase: Object.freeze({ x: 13, y: 1 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.TROLL,
        name: "Troll",
        level: LEVEL_2,
        size: SMALL,
        faction: PBTypes.FactionVals.CHAOS,
        lowerBase: Object.freeze({ x: 14, y: 2 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.GRIFFIN,
        name: "Griffin",
        level: LEVEL_3,
        size: SMALL,
        faction: PBTypes.FactionVals.LIFE,
        lowerBase: Object.freeze({ x: 10, y: 3 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.BLACK_DRAGON,
        name: "Black Dragon",
        level: LEVEL_4,
        size: LARGE,
        faction: PBTypes.FactionVals.CHAOS,
        lowerBase: Object.freeze({ x: 9, y: 3 }),
    }),
]);

const UPPER_ROSTER: readonly IOpeningUnit[] = Object.freeze([
    Object.freeze({
        creatureId: PBTypes.CreatureVals.DRYAD,
        name: "Dryad",
        level: LEVEL_1,
        size: SMALL,
        faction: PBTypes.FactionVals.NATURE,
        lowerBase: Object.freeze({ x: 6, y: 1 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.BERSERKER,
        name: "Berserker",
        level: LEVEL_1,
        size: SMALL,
        faction: PBTypes.FactionVals.MIGHT,
        lowerBase: Object.freeze({ x: 2, y: 2 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.BATTLE_MAGE,
        name: "Battle Mage",
        level: LEVEL_2,
        size: SMALL,
        faction: PBTypes.FactionVals.LIFE,
        lowerBase: Object.freeze({ x: 4, y: 1 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.VALKYRIE,
        name: "Valkyrie",
        level: LEVEL_2,
        size: SMALL,
        faction: PBTypes.FactionVals.LIFE,
        lowerBase: Object.freeze({ x: 6, y: 3 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.MANTIS,
        name: "Mantis",
        level: LEVEL_3,
        size: SMALL,
        faction: PBTypes.FactionVals.NATURE,
        lowerBase: Object.freeze({ x: 4, y: 3 }),
    }),
    Object.freeze({
        creatureId: PBTypes.CreatureVals.FRENZIED_BOAR,
        name: "Frenzied Boar",
        level: LEVEL_4,
        size: LARGE,
        faction: PBTypes.FactionVals.MIGHT,
        lowerBase: Object.freeze({ x: 9, y: 3 }),
    }),
]);

const idsFor = (units: readonly IOpeningUnit[]): readonly number[] => units.map(({ creatureId }) => creatureId);

/**
 * Canonical LOWER templates recovered from production match f1841493-c0bd-41e8-9281-27ce531ece8b.
 * The recorded UPPER template is reflected into LOWER here and reflected back at runtime by footprint size.
 */
const OPENINGS: readonly IOpeningRecipe[] = Object.freeze([
    Object.freeze({
        id: "prod-f184-lower-roster" as const,
        ownUnits: LOWER_ROSTER,
        opponentCreatureIds: Object.freeze(idsFor(UPPER_ROSTER)),
    }),
    Object.freeze({
        id: "prod-f184-upper-roster" as const,
        ownUnits: UPPER_ROSTER,
        opponentCreatureIds: Object.freeze(idsFor(LOWER_ROSTER)),
    }),
]);

const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const sortedIds = (ids: readonly number[]): number[] => [...ids].sort((left, right) => left - right);
const idsEqual = (left: readonly number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index]);
const openingIds = (opening: IOpeningRecipe): number[] =>
    sortedIds(opening.ownUnits.map(({ creatureId }) => creatureId));

const footprintFor = (unit: Unit, base: XY): XY[] => unit.getFootprintCellsForBase(base);

const centerFor = (unit: Unit, base: XY): XY => ({
    x: base.x - (unit.getFootprintWidth() - 1) / 2,
    y: base.y - (unit.getFootprintHeight() - 1) / 2,
});

const exactLegalZoneForTeam = (team: IPlacementContext["team"]): Set<number> => {
    const legal = new Set<number>();
    const yStart = team === PBTypes.TeamVals.LOWER ? 1 : GRID_SIZE - 4;
    for (let x = 1; x < GRID_SIZE - 1; x += 1) {
        for (let y = yStart; y < yStart + 3; y += 1) {
            legal.add(cellKey({ x, y }));
        }
    }
    return legal;
};

const placementGeometryIsExact = (context: IPlacementContext): boolean => {
    if (context.placement.getType() !== PlacementType.RECTANGLE || context.placement.getSize() !== 3) return false;
    const actual = context.placement.possibleCellHashes();
    const expected = exactLegalZoneForTeam(context.team);
    return actual.size === expected.size && [...expected].every((hash) => actual.has(hash));
};

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
        if (!base || !Number.isInteger(base.x) || !Number.isInteger(base.y)) return false;
        for (const cell of footprintFor(unit, base)) {
            const hash = cellKey(cell);
            if (!legal.has(hash) || occupied.has(hash)) return false;
            occupied.add(hash);
        }
    }
    return true;
};

const normalizedPlacementFingerprint = (
    units: readonly Unit[],
    team: IPlacementContext["team"],
    placement: ReadonlyMap<string, XY>,
): string => {
    const rows = units.map((unit) => {
        const base = placement.get(unit.getId());
        const center = base ? centerFor(unit, base) : undefined;
        return [
            creatureIdForName(unit.getName()) ?? null,
            unit.getLevel(),
            unit.getAmountAlive(),
            unit.getSize(),
            center?.x ?? null,
            center === undefined ? null : team === PBTypes.TeamVals.LOWER ? center.y : GRID_SIZE - 1 - center.y,
        ];
    });
    rows.sort((left, right) => JSON.stringify(left.slice(0, 4)).localeCompare(JSON.stringify(right.slice(0, 4))));
    return JSON.stringify(rows);
};

const baseForTeam = (unit: Unit, lowerBase: XY, team: IPlacementContext["team"]): XY => {
    if (team === PBTypes.TeamVals.LOWER) return { ...lowerBase };
    return {
        x: lowerBase.x,
        y: GRID_SIZE + (unit.isSmallSize() ? 1 : 2) - 2 - lowerBase.y,
    };
};

const evaluateV08A19F184HumanPlacement = (
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): IPlacementEvaluation => {
    const fallback = (fallbackReason: V08A19F184HumanPlacementFallbackReason): IPlacementEvaluation => ({
        selected: incumbent,
        treatmentApplied: false,
        horizontalDisplacement: 0,
        openingId: null,
        templateUnitsMoved: 0,
        fallbackReason,
    });

    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return fallback("unsupported-map");
    if (context.team !== PBTypes.TeamVals.LOWER && context.team !== PBTypes.TeamVals.UPPER) {
        return fallback("unsupported-team");
    }
    if (!placementGeometryIsExact(context)) return fallback("unsupported-placement-geometry");
    if (context.setupPlacementPolicy !== "public-roster" || context.publicOpponentCreatureIds === undefined) {
        return fallback("unauthorized-or-missing-public-roster");
    }

    const publicIds = context.publicOpponentCreatureIds;
    if (publicIds.length !== 6 || new Set(publicIds).size !== 6) return fallback("invalid-public-roster");
    if (publicIds.some((creatureId) => !creatureInfo(creatureId))) return fallback("unknown-public-identity");

    const ownArmy = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const requestedIds = new Set(units.map((unit) => unit.getId()));
    if (
        units.length !== 6 ||
        requestedIds.size !== units.length ||
        ownArmy.length !== units.length ||
        ownArmy.some((unit) => !requestedIds.has(unit.getId()))
    ) {
        return fallback("partial-army");
    }
    const ownCreatureIds = ownArmy.map((unit) => creatureIdForName(unit.getName()));
    if (ownCreatureIds.some((creatureId) => creatureId === undefined)) return fallback("unknown-own-identity");
    if (
        ownArmy.some((unit) => unit.isSummoned()) ||
        new Set(ownCreatureIds).size !== ownCreatureIds.length ||
        new Set(ownArmy.map((unit) => unit.getName())).size !== ownArmy.length
    ) {
        return fallback("split-summoned-or-duplicate-army");
    }

    const sortedOwnIds = sortedIds(ownCreatureIds as number[]);
    const opening = OPENINGS.find((candidate) => idsEqual(sortedOwnIds, openingIds(candidate)));
    if (!opening) return fallback("unmatched-public-opening");
    if (!idsEqual(sortedIds(publicIds), sortedIds(opening.opponentCreatureIds))) {
        return fallback("unmatched-public-opening");
    }

    const expectedByCreatureId = new Map(opening.ownUnits.map((expected) => [expected.creatureId, expected]));
    for (const unit of ownArmy) {
        const creatureId = creatureIdForName(unit.getName());
        const expected = creatureId === undefined ? undefined : expectedByCreatureId.get(creatureId);
        if (
            !expected ||
            unit.getName() !== expected.name ||
            unit.getLevel() !== expected.level ||
            unit.getSize() !== expected.size ||
            unit.getFaction() !== expected.faction ||
            unit.getUnitType() !== PBTypes.UnitVals.CREATURE
        ) {
            return fallback("own-unit-shape-mismatch");
        }
    }

    const selected = new Map<string, XY>();
    for (const unit of units) {
        const creatureId = creatureIdForName(unit.getName());
        const expected = creatureId === undefined ? undefined : expectedByCreatureId.get(creatureId);
        if (!expected) return fallback("own-unit-shape-mismatch");
        selected.set(unit.getId(), baseForTeam(unit, expected.lowerBase, context.team));
    }
    if (!placementIsCompleteAndLegal(units, selected, context)) return fallback("candidate-incomplete-or-illegal");

    const incumbentFingerprint = normalizedPlacementFingerprint(units, context.team, incumbent);
    const selectedFingerprint = normalizedPlacementFingerprint(units, context.team, selected);
    if (incumbentFingerprint === selectedFingerprint) return fallback("unchanged");

    let horizontalDisplacement = 0;
    let templateUnitsMoved = 0;
    for (const unit of units) {
        const before = incumbent.get(unit.getId());
        const after = selected.get(unit.getId());
        if (!before || !after) continue;
        horizontalDisplacement += Math.abs(centerFor(unit, after).x - centerFor(unit, before).x);
        templateUnitsMoved += Number(before.x !== after.x || before.y !== after.y);
    }
    return {
        selected,
        treatmentApplied: true,
        horizontalDisplacement,
        openingId: opening.id,
        templateUnitsMoved,
        fallbackReason: null,
    };
};

export function applyV08A19F184HumanPlacement(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    return evaluateV08A19F184HumanPlacement(units, context, incumbent).selected;
}

/** Exact production-opening decorator; combat and the base strategy's version/search scope remain unchanged. */
export class V08A19F184HumanPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private lastPlacementAudit?: IV08A19F184HumanPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const evaluation = evaluateV08A19F184HumanPlacement(units, context, incumbent);
        const incumbentFingerprint = normalizedPlacementFingerprint(units, context.team, incumbent);
        const selectedFingerprint = normalizedPlacementFingerprint(units, context.team, evaluation.selected);
        this.lastPlacementAudit = Object.freeze({
            treatmentApplied: evaluation.treatmentApplied,
            placementChanged: incumbentFingerprint !== selectedFingerprint,
            horizontalDisplacement: evaluation.horizontalDisplacement,
            openingId: evaluation.openingId,
            templateUnitsMoved: evaluation.templateUnitsMoved,
            fallbackReason: evaluation.fallbackReason,
            incumbentFingerprint,
            selectedFingerprint,
        });
        return evaluation.selected;
    }
    public getLastPlacementAudit(): IV08A19F184HumanPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export const withV08A19F184HumanPlacement = (base: IAIStrategy): IAIStrategy =>
    new V08A19F184HumanPlacementStrategy(base);
