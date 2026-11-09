/** User-adopted Mage support composition. Original research checkpoints remain immutable. */
import {
    planTacticalStackSplits,
    type ITacticalSplitPlan,
    type ITacticalSplitUnit,
    type ITacticalSplitPlacementUnit,
} from "./tactical_split_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import type { XY } from "../utils/math";

export const A19_WANDERING_MAGE_SUPPORT_POLICY = Object.freeze({
    id: "a19-wandering-mage-support-v1" as const,
    adoption: "user-authorized-with-inconclusive-strength" as const,
    split: "one-body-child-in-existing-funded-capacity" as const,
    placement: "rear-preserving-original-flank" as const,
    rootShortlist: 8,
    registeredCombinedStrengthGatePassed: false,
    originalCheckpointId: "wandering-mage-candidates-20261108" as const,
});

/** Keep the main stack. Preserve incumbent split order; only replace the last competing utility when needed. */
export function planA19WanderingMageSplits(
    units: readonly ITacticalSplitUnit[],
    maximumStacks: number,
): ITacticalSplitPlan[] {
    const incumbent = planTacticalStackSplits(units, maximumStacks);
    const living = units.filter((unit) => unit.amount > 0);
    const mages = living.filter((unit) => unit.identity === "Wandering Mage:1");
    const mage = mages[0];
    if (
        mages.length !== 1 ||
        !mage.small ||
        mage.summoned ||
        !Number.isSafeInteger(mage.amount) ||
        mage.amount < 2 ||
        !Number.isSafeInteger(maximumStacks)
    )
        return incumbent;
    const slots = Math.max(0, Math.min(maximumStacks - living.length, maximumStacks - 6));
    const wanted = Math.min(1, slots, mage.amount - 1);
    if (!wanted) return incumbent;
    const plans = [...incumbent];
    while (plans.filter((plan) => plan.sourceUnitId === mage.id).length < wanted) {
        if (plans.length === slots) {
            let index = plans.length - 1;
            while (index >= 0 && plans[index].sourceUnitId === mage.id) index--;
            if (index < 0) break;
            plans.splice(index, 1);
        }
        plans.push({ sourceUnitId: mage.id, amount: 1, role: "support" });
    }
    return plans;
}

export interface IA19WanderingMagePlacementUnit extends ITacticalSplitPlacementUnit {
    readonly name: string;
    readonly amount: number;
}

/** Own formation only: reserve every other footprint, then separate Mage stacks along legal rear cells. */
export function protectA19WanderingMagePlacement(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly IA19WanderingMagePlacementUnit[],
    context: {
        team: number;
        sideOrientedPlacement: boolean;
        legalCellHashes: ReadonlySet<number>;
    },
): Map<string, XY> {
    const copy = (): Map<string, XY> => new Map([...incumbent].map(([id, cell]) => [id, { ...cell }]));
    const result = copy();
    const mages = units
        .filter((unit) => unit.name === "Wandering Mage" && unit.small && incumbent.has(unit.id))
        .sort((a, b) => b.amount - a.amount || units.indexOf(a) - units.indexOf(b));
    const ids = new Set(mages.map((unit) => unit.id));
    const key = (cell: XY): number => (cell.x << 4) | cell.y;
    const occupied = new Set<number>();
    const footprint = (unit: IA19WanderingMagePlacementUnit, cell: XY): XY[] =>
        getFootprintCellsForAnchor(
            cell,
            unit.footprintWidth ?? (unit.small ? 1 : 2),
            unit.footprintHeight ?? (unit.small ? 1 : 2),
        );
    for (const unit of units) {
        const cell = incumbent.get(unit.id);
        if (cell && !ids.has(unit.id)) for (const part of footprint(unit, cell)) occupied.add(key(part));
    }
    const backDepth = (cell: XY): number => {
        const along = context.sideOrientedPlacement ? cell.x : cell.y;
        return context.team === PBTypes.TeamVals.LEFT ? along : 15 - along;
    };
    const lateral = (cell: XY): number => (context.sideOrientedPlacement ? cell.y : cell.x);
    const placed: XY[] = [];
    for (const mage of mages) {
        const candidates = [...context.legalCellHashes]
            .map((hash) => ({ x: hash >> 4, y: hash & 15 }))
            .filter((cell) =>
                footprint(mage, cell).every(
                    (part) => context.legalCellHashes.has(key(part)) && !occupied.has(key(part)),
                ),
            );
        const separation = (cell: XY): number =>
            placed.length
                ? Math.min(...placed.map((other) => Math.max(Math.abs(cell.x - other.x), Math.abs(cell.y - other.y))))
                : 0;
        candidates.sort(
            (a, b) =>
                backDepth(a) - backDepth(b) ||
                Math.abs(lateral(a) - lateral(incumbent.get(mage.id)!)) -
                    Math.abs(lateral(b) - lateral(incumbent.get(mage.id)!)) ||
                separation(b) - separation(a) ||
                Math.abs(lateral(a) - 7.5) - Math.abs(lateral(b) - 7.5) ||
                (context.team === PBTypes.TeamVals.LEFT ? lateral(a) - lateral(b) : lateral(b) - lateral(a)),
        );
        if (!candidates[0]) return copy();
        result.set(mage.id, candidates[0]);
        placed.push(candidates[0]);
        for (const part of footprint(mage, candidates[0])) occupied.add(key(part));
    }
    return result;
}
