import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";
import { SPLASH_AOE_ABILITIES, layoutRevealPlacement } from "./v0_7_placement_reveal";

export const V08_A19_RANGED_CORNER_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_ranged_corner_placement.v3" as const,
    policyId: "a19-ogre-behemoth-ranged-corner-v1" as const,
    researchOnly: true as const,
    maps: Object.freeze([PBTypes.GridVals.NORMAL] as const),
    minimumPlacementSize: 4 as const,
    information: "own-army+map+legal-cells+public-opponent-identities" as const,
    rosterCondition: Object.freeze({
        ogreMageCount: 1 as const,
        behemothCount: 1 as const,
        minimumRangedCount: 2 as const,
        minimumGroundScreenCount: 2 as const,
    }),
    opponentCondition: Object.freeze({
        maximumFlyers: 0 as const,
        splashAoe: false as const,
        rangedSpellDamage: false as const,
    }),
});

export type V08A19RangedCornerPlacementFallbackReason =
    | "unsupported-map"
    | "placement-not-extended"
    | "unauthorized-or-missing-public-roster"
    | "opponent-unknown"
    | "opponent-flyer"
    | "opponent-splash"
    | "opponent-ranged-spell-damage"
    | "partial-army"
    | "split-summoned-or-duplicate-army"
    | "unexpected-large-unit"
    | "roster-condition-not-met"
    | "candidate-incomplete-or-illegal"
    | "unchanged";

export interface IV08A19RangedCornerPlacementAudit {
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly rangedUnitIds: readonly string[];
    readonly ogreMageId: string | null;
    readonly behemothId: string | null;
    readonly fallbackReason: V08A19RangedCornerPlacementFallbackReason | null;
}

interface IPlacementEvaluation {
    readonly selected: Map<string, XY>;
    readonly audit: IV08A19RangedCornerPlacementAudit;
}

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const key = (cell: XY): number => (cell.x << 4) | cell.y;

const creatureInfoForUnit = (unit: Unit) => {
    const creatureId = creatureIdForName(unit.getName());
    return creatureId === undefined ? undefined : creatureInfo(creatureId);
};

const hasNativeSpellbook = (unit: Unit): boolean => creatureInfoForUnit(unit)?.nativeSpellbook === true;

const isGroundScreen = (unit: Unit): boolean =>
    !unit.canFly() &&
    (unit.getAttackType() === MELEE || (unit.getAttackType() === MELEE_MAGIC && !hasNativeSpellbook(unit)));

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

const placementsEqual = (
    units: readonly Unit[],
    left: ReadonlyMap<string, XY>,
    right: ReadonlyMap<string, XY>,
): boolean =>
    left.size === units.length &&
    right.size === units.length &&
    units.every((unit) => {
        const before = left.get(unit.getId());
        const after = right.get(unit.getId());
        return !!before && !!after && before.x === after.x && before.y === after.y;
    });

const evaluateRangedCornerPlacement = (
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): IPlacementEvaluation => {
    const ownArmy = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const ogres = ownArmy.filter((unit) => unit.getName() === "Ogre Mage");
    const behemoths = ownArmy.filter((unit) => unit.getName() === "Behemoth");
    const shooters = ownArmy.filter((unit) => unit.getAttackType() === RANGE);
    const fallback = (fallbackReason: V08A19RangedCornerPlacementFallbackReason): IPlacementEvaluation => ({
        selected: incumbent,
        audit: Object.freeze({
            treatmentApplied: false,
            placementChanged: false,
            rangedUnitIds: shooters.map((unit) => unit.getId()),
            ogreMageId: ogres.length === 1 ? ogres[0].getId() : null,
            behemothId: behemoths.length === 1 ? behemoths[0].getId() : null,
            fallbackReason,
        }),
    });

    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return fallback("unsupported-map");
    if (context.placement.getSize() < V08_A19_RANGED_CORNER_PLACEMENT_POLICY.minimumPlacementSize) {
        return fallback("placement-not-extended");
    }
    if (context.setupPlacementPolicy !== "public-roster" || !context.publicOpponentCreatureIds?.length) {
        return fallback("unauthorized-or-missing-public-roster");
    }
    const publicOpponent = context.publicOpponentCreatureIds.map((creatureId) => creatureInfo(creatureId));
    const knownPublicOpponent = publicOpponent.filter((info): info is NonNullable<typeof info> => info !== undefined);
    if (knownPublicOpponent.length !== publicOpponent.length) return fallback("opponent-unknown");
    if (knownPublicOpponent.some((info) => info.canFly)) return fallback("opponent-flyer");
    if (knownPublicOpponent.some((info) => SPLASH_AOE_ABILITIES.some((ability) => info.abilities.includes(ability)))) {
        return fallback("opponent-splash");
    }
    if (knownPublicOpponent.some((info) => info.rangedSpellDamage)) return fallback("opponent-ranged-spell-damage");

    const requestedIds = new Set(units.map((unit) => unit.getId()));
    if (
        requestedIds.size !== units.length ||
        ownArmy.length !== units.length ||
        ownArmy.some((unit) => !requestedIds.has(unit.getId()))
    ) {
        return fallback("partial-army");
    }
    const identities = ownArmy.map((unit) => `${unit.getName()}:${unit.getLevel()}`);
    if (ownArmy.some((unit) => unit.isSummoned()) || new Set(identities).size !== ownArmy.length) {
        return fallback("split-summoned-or-duplicate-army");
    }
    if (ownArmy.some((unit) => !unit.isSmallSize() && unit.getName() !== "Behemoth")) {
        return fallback("unexpected-large-unit");
    }
    const groundScreens = ownArmy.filter(isGroundScreen);
    if (
        ownArmy.length !== 6 ||
        ogres.length !== V08_A19_RANGED_CORNER_PLACEMENT_POLICY.rosterCondition.ogreMageCount ||
        behemoths.length !== V08_A19_RANGED_CORNER_PLACEMENT_POLICY.rosterCondition.behemothCount ||
        shooters.length < V08_A19_RANGED_CORNER_PLACEMENT_POLICY.rosterCondition.minimumRangedCount ||
        groundScreens.length < V08_A19_RANGED_CORNER_PLACEMENT_POLICY.rosterCondition.minimumGroundScreenCount
    ) {
        return fallback("roster-condition-not-met");
    }

    const selected = layoutRevealPlacement(units, context, {
        gap: 0,
        screenShooters: true,
        cornerShift: true,
        screenBacklineProtectors: true,
        preferredGuardUnitIds: [behemoths[0].getId()],
        preferredBacklineUnitIds: [...shooters.map((unit) => unit.getId()), ogres[0].getId()],
        physicalMeleeMagicRoles: true,
    });
    if (!placementIsCompleteAndLegal(units, selected, context)) return fallback("candidate-incomplete-or-illegal");
    if (placementsEqual(units, incumbent, selected)) return fallback("unchanged");
    return {
        selected,
        audit: Object.freeze({
            treatmentApplied: true,
            placementChanged: true,
            rangedUnitIds: shooters.map((unit) => unit.getId()),
            ogreMageId: ogres[0].getId(),
            behemothId: behemoths[0].getId(),
            fallbackReason: null,
        }),
    };
};

export class V08A19RangedCornerPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private lastPlacementAudit?: IV08A19RangedCornerPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const evaluation = evaluateRangedCornerPlacement(units, context, incumbent);
        this.lastPlacementAudit = evaluation.audit;
        return evaluation.selected;
    }
    public getLastPlacementAudit(): IV08A19RangedCornerPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export const withV08A19RangedCornerPlacement = (base: IAIStrategy): V08A19RangedCornerPlacementStrategy =>
    new V08A19RangedCornerPlacementStrategy(base);
