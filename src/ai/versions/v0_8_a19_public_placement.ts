/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import type { GameAction } from "../../engine/actions";
import { GRID_SIZE } from "../../grid/grid_constants";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { layoutRevealPlacement } from "./v0_7_placement_reveal";
import { StrategyV0_1 } from "./v0_1";
import { V08A19ChakramDispersionStrategy } from "./v0_8_a19_chakram_dispersion";
import { creatureInfo, creatureIdForName } from "../setup/creature_score";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import type { IAIStrategy, IPlacementContext, IDecisionContext } from "../ai_strategy";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
export function supportAgainstPublicFastFlyer(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    const pressure = context.publicOpponentCreatureIds?.some((id) => {
        const info = creatureInfo(id);
        return !!info && info.level === 4 && info.canFly && info.melee;
    });
    const groundedCarry = units.some((unit) => {
        const info = creatureInfo(creatureIdForName(unit.getName())!);
        return !!info && info.level === 4 && (!info.canFly || info.rangedSpellDamage);
    });
    if (!pressure || !groundedCarry || units.some((unit) => unit.isSummoned())) return incumbent;
    const own = context.unitsHolder.getAllAllies(context.team).filter((unit) => !unit.isDead());
    const ids = new Set(units.map((unit) => unit.getId()));
    if (ids.size !== units.length || own.length !== units.length || own.some((unit) => !ids.has(unit.getId())))
        return incumbent;
    const selected = new StrategyV0_1().placeArmy(units, context);
    if (selected.size !== units.length) return incumbent;
    const legal = context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of units) {
        const anchor = selected.get(unit.getId());
        if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return incumbent;
        for (const cell of footprintCellsForAnchor(unit, anchor)) {
            const hash = (cell.x << 4) | cell.y;
            if (!legal.has(hash) || occupied.has(hash)) return incumbent;
            occupied.add(hash);
        }
    }
    return selected;
}
export function withPublicAirSupport(base: IAIStrategy, chakram: boolean): IAIStrategy {
    const support: IAIStrategy = {
        version: base.version,
        placeArmy: (units, context) => supportAgainstPublicFastFlyer(units, context, base.placeArmy(units, context)),
        decideTurn: (unit, context) => base.decideTurn(unit, context),
    };
    return chakram ? new V08A19ChakramDispersionStrategy(support, true) : support;
}

export function casterSupportPlacement(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
    style: string,
): Map<string, XY> {
    if (context.grid.getGridType() !== PBTypes.GridVals.NORMAL) return incumbent;
    const infos = [...new Set(units.map((u) => creatureIdForName(u.getName())))]
        .map((id) => (id === undefined ? undefined : creatureInfo(id)))
        .filter((info) => info !== undefined);
    const healer = infos.some(
        (i) => i.level === 4 && i.canFly && i.caster && !i.rangedSpellDamage && i.abilities.includes("Resurrection"),
    );
    const casters = infos.filter((i) => i.rangedSpellDamage).length;
    const magicPressure = context.publicOpponentCreatureIds?.some((id) => {
        const i = creatureInfo(id);
        return !!i && i.level === 4 && i.rangedSpellDamage;
    });
    if (!healer || casters < 2 || !magicPressure || units.some((u) => u.isSummoned())) return incumbent;
    const own = context.unitsHolder.getAllAllies(context.team).filter((u) => !u.isDead());
    const ids = new Set(units.map((u) => u.getId()));
    if (ids.size !== units.length || own.length !== units.length || own.some((u) => !ids.has(u.getId())))
        return incumbent;
    const selected = layoutRevealPlacement(units, context, {
        gap: style.includes("gap2") ? 2 : 1,
        screenShooters: true,
        cornerShift: style.includes("corner"),
        physicalMeleeMagicRoles: true,
        screenBacklineProtectors: true,
    });
    if (selected.size !== units.length) return incumbent;
    const legal = context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of units) {
        const anchor = selected.get(unit.getId());
        if (!anchor) return incumbent;
        for (const cell of footprintCellsForAnchor(unit, anchor)) {
            const hash = (cell.x << 4) | cell.y;
            if (!legal.has(hash) || occupied.has(hash)) return incumbent;
            occupied.add(hash);
        }
    }
    return selected;
}

export function screenPublicThroughShotArmy(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    if (context.grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER || units.some((u) => u.isSummoned()))
        return incumbent;
    const infos = [...new Set(units.map((u) => creatureIdForName(u.getName())))].map((id) =>
        id === undefined ? undefined : creatureInfo(id),
    );
    if (
        infos.some((i) => !i) ||
        infos.filter((i) => i!.rangedSpellDamage).length < 2 ||
        infos.filter((i) => i!.ranged).length > 2
    )
        return incumbent;
    if (infos.some((i) => i!.abilities.includes("Rapid Charge"))) return incumbent;
    if (!context.publicOpponentCreatureIds?.some((id) => creatureInfo(id)?.abilities.includes("Through Shot")))
        return incumbent;
    const ids = new Set(units.map((u) => u.getId())),
        own = context.unitsHolder.getAllAllies(context.team).filter((u) => !u.isDead());
    if (ids.size !== units.length || own.length !== units.length || own.some((u) => !ids.has(u.getId())))
        return incumbent;
    const selected = layoutRevealPlacement(units, context, {
        gap: 2,
        screenShooters: true,
        cornerShift: false,
        physicalMeleeMagicRoles: true,
        screenBacklineProtectors: true,
    });
    if (selected.size !== units.length) return incumbent;
    const legal = context.placement.possibleCellHashes(),
        occupied = new Set<number>();
    for (const unit of units) {
        const anchor = selected.get(unit.getId());
        if (!anchor || !Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) return incumbent;
        for (const cell of footprintCellsForAnchor(unit, anchor)) {
            const hash = (cell.x << 4) | cell.y;
            if (!legal.has(hash) || occupied.has(hash)) return incumbent;
            occupied.add(hash);
        }
    }
    return selected;
}

export function disperseRevealedSplashArmy(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    if (
        !context.publicOpponentCreatureIds?.some((id) =>
            ["Chakram", "Large Caliber", "Area Throw"].some((ability) => creatureInfo(id)?.abilities.includes(ability)),
        )
    )
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
export class V08A19PublicSplashDispersionStrategy implements IAIStrategy {
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
        const selected = this.enabled ? disperseRevealedSplashArmy(units, context, incumbent) : incumbent;
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

export function reflectIncumbentPlacement(units: Unit[], context: IPlacementContext, incumbent: Map<string, XY>) {
    const reflected = new Map<string, XY>(),
        occupied = new Set<number>(),
        legal = context.placement.possibleCellHashes();
    for (const unit of units) {
        const cell = incumbent.get(unit.getId());
        if (!cell) return incumbent;
        const anchor = {
            x: cell.x,
            y: GRID_SIZE - 1 - cell.y + (unit.isSmallSize() ? 0 : unit.getFootprintHeight() - 1),
        };
        for (const point of footprintCellsForAnchor(unit, anchor)) {
            const hash = (point.x << 4) | point.y;
            if (!legal.has(hash) || occupied.has(hash)) return incumbent;
            occupied.add(hash);
        }
        reflected.set(unit.getId(), anchor);
    }
    return reflected.size === units.length ? reflected : incumbent;
}
