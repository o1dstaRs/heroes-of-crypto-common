import {
    planTacticalStackSplits,
    type ITacticalSplitPlan,
    type ITacticalSplitUnit,
    type ITacticalSplitPlacementUnit,
} from "../ai/tactical_split_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import type { XY } from "../utils/math";

export type HealerSplitResearchMode = "single" | "half" | "two-singles";
export type HealerResearchSplitPlan = Omit<ITacticalSplitPlan, "amount"> & { readonly amount: number };

/** Research only: spend already available slots; never buy Placement or change another unit's combat policy. */
export function planHealerResearchSplits(
    units: readonly ITacticalSplitUnit[],
    maximumStacks: number,
    mode: HealerSplitResearchMode,
): HealerResearchSplitPlan[] {
    const incumbent = planTacticalStackSplits(units, maximumStacks);
    const living = units.filter((unit) => unit.amount > 0);
    const healers = living.filter((unit) => unit.identity === "Healer:2");
    const healer = healers[0];
    if (
        healers.length !== 1 ||
        !healer.small ||
        healer.summoned ||
        !Number.isSafeInteger(healer.amount) ||
        healer.amount < 2 ||
        !Number.isSafeInteger(maximumStacks)
    )
        return incumbent;
    const slots = Math.max(0, Math.min(maximumStacks - living.length, maximumStacks - 6));
    if (!slots) return incumbent;
    const count = mode === "two-singles" ? Math.min(2, slots, healer.amount - 1) : 1;
    const plans: HealerResearchSplitPlan[] = Array.from({ length: count }, () => ({
        sourceUnitId: healer.id,
        amount: mode === "half" ? Math.floor(healer.amount / 2) : 1,
        role: "support",
    }));
    return plans.concat(
        incumbent.filter((plan) => plan.sourceUnitId !== healer.id).slice(0, Math.max(0, slots - plans.length)),
    );
}

export interface IHealerResearchPlacementUnit extends ITacticalSplitPlacementUnit {
    readonly name: string;
    readonly amount: number;
}

/** Own formation only. Keep every other stack fixed, reserve legal footprints, and separate rear Healers. */
export function protectHealerResearchPlacement(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly IHealerResearchPlacementUnit[],
    context: { team: number; sideOrientedPlacement: boolean; legalCellHashes: ReadonlySet<number> },
): Map<string, XY> {
    const copy = (): Map<string, XY> => new Map([...incumbent].map(([id, cell]) => [id, { ...cell }]));
    const result = copy();
    const healers = units
        .filter((unit) => unit.name === "Healer" && unit.small && incumbent.has(unit.id))
        .sort((a, b) => b.amount - a.amount || units.indexOf(a) - units.indexOf(b));
    const healerIds = new Set(healers.map((unit) => unit.id));
    const key = (cell: XY): number => (cell.x << 4) | cell.y;
    const occupied = new Set<number>();
    const footprint = (unit: IHealerResearchPlacementUnit, cell: XY): XY[] =>
        getFootprintCellsForAnchor(
            cell,
            unit.footprintWidth ?? (unit.small ? 1 : 2),
            unit.footprintHeight ?? (unit.small ? 1 : 2),
        );
    for (const unit of units) {
        const cell = incumbent.get(unit.id);
        if (cell && !healerIds.has(unit.id)) for (const part of footprint(unit, cell)) occupied.add(key(part));
    }
    const backDepth = (cell: XY): number => {
        const along = context.sideOrientedPlacement ? cell.x : cell.y;
        return context.team === PBTypes.TeamVals.LEFT ? along : 15 - along;
    };
    const lateral = (cell: XY): number => (context.sideOrientedPlacement ? cell.y : cell.x);
    const placed: XY[] = [];
    for (const healer of healers) {
        const candidates = [...context.legalCellHashes]
            .map((hash) => ({ x: hash >> 4, y: hash & 15 }))
            .filter((cell) =>
                footprint(healer, cell).every(
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
                separation(b) - separation(a) ||
                Math.abs(lateral(a) - 7.5) - Math.abs(lateral(b) - 7.5) ||
                (context.team === PBTypes.TeamVals.LEFT ? lateral(a) - lateral(b) : lateral(b) - lateral(a)),
        );
        if (!candidates[0]) return copy();
        result.set(healer.id, candidates[0]);
        placed.push(candidates[0]);
        for (const part of footprint(healer, candidates[0])) occupied.add(key(part));
    }
    return result;
}
