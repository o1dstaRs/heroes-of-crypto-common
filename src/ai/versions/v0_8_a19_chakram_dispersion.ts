/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import type { GameAction } from "../../engine/actions";
import { creatureInfo } from "../setup/creature_score";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { GRID_SIZE } from "../../grid/grid_constants";
import type { Unit } from "../../units/unit";
import type { IAIStrategy, IPlacementContext, IDecisionContext } from "../ai_strategy";
import type { XY } from "../../utils/math";

export function disperseRevealedChakramArmy(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    if (!context.publicOpponentCreatureIds?.some((id) => creatureInfo(id)?.abilities.includes("Chakram")))
        return incumbent;
    const legal = context.placement.possibleCellHashes();
    const cells = (unit: Unit, anchor: XY) => footprintCellsForAnchor(unit, anchor);
    const valid = (placement: Map<string, XY>) => {
        if (placement.size !== units.length) return false;
        const occupied = new Set<number>();
        for (const unit of units) {
            const anchor = placement.get(unit.getId());
            if (!anchor) return false;
            for (const cell of cells(unit, anchor)) {
                const hash = (cell.x << 4) | cell.y;
                if (
                    cell.x < 0 ||
                    cell.y < 0 ||
                    cell.x >= GRID_SIZE ||
                    cell.y >= GRID_SIZE ||
                    !legal.has(hash) ||
                    occupied.has(hash)
                )
                    return false;
                occupied.add(hash);
            }
        }
        return true;
    };
    if (!valid(incumbent)) return incumbent;
    const strengths = units.map((unit) => Math.max(1, unit.getExp() * unit.getAmountAlive()));
    const total = strengths.reduce((a, b) => a + b, 0);
    const objective = (placement: Map<string, XY>) => {
        let cost = 0;
        const footprints = units.map((unit) => cells(unit, placement.get(unit.getId())!));
        for (let i = 0; i < units.length; i++) {
            for (let j = 0; j < i; j++) {
                let distance = Infinity;
                for (const a of footprints[i])
                    for (const b of footprints[j])
                        distance = Math.min(distance, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
                // An adjacent bounce relays the flight. A two-cell bounce is half strength and ends it.
                cost += ((distance <= 1 ? 1 : distance <= 2 ? 0.25 : 0) * (strengths[i] + strengths[j])) / total;
            }
            const original = incumbent.get(units[i].getId())!;
            const selected = placement.get(units[i].getId())!;
            cost += ((0.001 * strengths[i]) / total) * Math.abs(selected.y - original.y);
        }
        return cost;
    };
    let best = incumbent;
    let bestCost = objective(incumbent);
    for (const descending of [true, false]) {
        const placement = new Map([...incumbent].map(([id, cell]) => [id, { ...cell }]));
        const order = units
            .map((_, index) => index)
            .sort(
                (a, b) =>
                    (descending ? strengths[b] - strengths[a] : strengths[a] - strengths[b]) ||
                    units[a].getName().localeCompare(units[b].getName()) ||
                    a - b,
            );
        let cost = objective(placement);
        for (let pass = 0; pass < 4; pass++) {
            let changed = false;
            for (const index of order) {
                const unit = units[index];
                const current = placement.get(unit.getId())!;
                let selected = current;
                let selectedCost = cost;
                for (let y = 0; y < GRID_SIZE; y++) {
                    const candidate = { x: current.x, y };
                    placement.set(unit.getId(), candidate);
                    if (!valid(placement)) continue;
                    const nextCost = objective(placement);
                    if (nextCost < selectedCost - 1e-12) {
                        selected = candidate;
                        selectedCost = nextCost;
                    }
                }
                placement.set(unit.getId(), selected);
                changed ||= selected.y !== current.y;
                cost = selectedCost;
            }
            if (!changed) break;
        }
        if (cost < bestCost - 1e-12) {
            best = placement;
            bestCost = cost;
        }
    }
    return best;
}

/** Final placement layer; native initialization precedes every optional change. */
export class V08A19ChakramDispersionStrategy implements IAIStrategy {
    public readonly version: string;
    private changed = false;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly enabled = false,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const selected = this.enabled ? disperseRevealedChakramArmy(units, context, incumbent) : incumbent;
        this.changed = selected !== incumbent;
        return selected;
    }
    public getLastPlacementAudit(): Readonly<{ placementChanged: boolean }> {
        return { placementChanged: this.changed };
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}
