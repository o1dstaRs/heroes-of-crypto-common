/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import { PBTypes } from "../../generated/protobuf/v1/types";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IPlacementContext } from "../ai_strategy";
import { creatureInfo } from "../setup/creature_score";
import { isMindlessAiUnit } from "../unit_ai_overrides";

const key = (cell: XY): number => (cell.x << 4) | cell.y;
const distance = (a: XY, b: XY): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Experimental placement repair. Keep shooters and spellcasters fixed, and close flyer landing gaps
 * with controllable melee bodies. AI Driven bodies are deliberately absent from the protection score:
 * their forced charge cannot be ordered to maintain a screen. They are placed after the repair.
 * Uses only own units, legal own cells and public opponent identities; never opponent positions or setup.
 * A complete legal improvement is required, otherwise preserve the incumbent by reference.
 */
export function stabilizeV08RangedScreen(
    units: readonly Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    if (context.grid.getSettings().getGridSize() !== 16 || incumbent.size !== units.length) return incumbent;
    const mindless = units.filter(isMindlessAiUnit);
    const wards = units.filter((u) => u.isRangeCapable() && u.getAmountAlive() > 1);
    if (!mindless.length || wards.length < 2) return incumbent;
    const flyers = (context.publicOpponentCreatureIds ?? []).map(creatureInfo).filter((i) => i?.canFly && i.melee);
    if (!flyers.length) return incumbent;
    const legal = context.placement.possibleCellHashes();
    const side = context.sideOrientedPlacement === true;
    const depth = (c: XY) => (context.team === PBTypes.TeamVals.LEFT ? (side ? c.x : c.y) : 15 - (side ? c.x : c.y));
    const lateral = (c: XY) => (side ? c.y : c.x);
    const bases = [...legal]
        .map((h) => ({ x: h >> 4, y: h & 15 }))
        .sort((a, b) => depth(a) - depth(b) || lateral(a) - lateral(b));
    const fixed = units.filter((u) => !isMindlessAiUnit(u));
    const movers = fixed.filter((u) => !u.isRangeCapable() && !u.getCanCastSpells());
    if (!movers.length || units.some((u) => !incumbent.has(u.getId()))) return incumbent;
    const cells = (u: Unit, p: ReadonlyMap<string, XY>) => footprintCellsForAnchor(u, p.get(u.getId())!);
    const occupied = (p: ReadonlyMap<string, XY>, except?: Unit): Set<number> =>
        new Set(fixed.filter((u) => u !== except).flatMap((u) => cells(u, p).map(key)));
    // Deduplicate shapes: repeated public identities do not multiply the geometric objective.
    const shapes = new Map(flyers.map((i) => [i!.footprintWidth + "x" + i!.footprintHeight, i!]));
    const landingMasks: number[][] = [];
    for (const flyer of shapes.values()) {
        for (const ward of wards) {
            const wardCells = cells(ward, incumbent);
            for (let x = flyer.footprintWidth - 1; x < 16; x++) {
                for (let y = flyer.footprintHeight - 1; y < 16; y++) {
                    const body: XY[] = [];
                    for (let dx = 0; dx < flyer.footprintWidth; dx++)
                        for (let dy = 0; dy < flyer.footprintHeight; dy++) body.push({ x: x - dx, y: y - dy });
                    if (body.some((a) => wardCells.some((b) => distance(a, b) === 1))) landingMasks.push(body.map(key));
                }
            }
        }
    }
    const exposure = (p: ReadonlyMap<string, XY>): number => {
        const taken = occupied(p);
        return landingMasks.filter((body) => body.every((h) => !taken.has(h))).length;
    };
    const originalExposure = exposure(incumbent);
    if (originalExposure === 0) return incumbent;
    const selected = new Map(incumbent);
    let bestExposure = originalExposure;
    for (let iteration = 0; iteration < movers.length; iteration++) {
        let best: { unit: Unit; base: XY; score: number; travel: number } | undefined;
        for (const unit of movers) {
            const taken = occupied(selected, unit);
            for (const base of bases) {
                const body = footprintCellsForAnchor(unit, base);
                if (body.some((c) => !legal.has(key(c)) || taken.has(key(c)))) continue;
                const candidate = new Map(selected);
                candidate.set(unit.getId(), base);
                const score = exposure(candidate),
                    travel = distance(base, incumbent.get(unit.getId())!);
                if (score >= bestExposure) continue;
                if (!best || score < best.score || (score === best.score && travel < best.travel))
                    best = { unit, base, score, travel };
            }
        }
        if (!best) break;
        selected.set(best.unit.getId(), best.base);
        bestExposure = best.score;
    }
    if (bestExposure >= originalExposure) return incumbent;
    const taken = occupied(selected);
    const forward = (c: XY) => (context.team === PBTypes.TeamVals.LEFT ? 1 : -1) * (side ? c.x : c.y);
    for (const unit of [...mindless].sort(
        (a, b) => b.getFootprintWidth() * b.getFootprintHeight() - a.getFootprintWidth() * a.getFootprintHeight(),
    )) {
        const choices = bases.filter((base) =>
            footprintCellsForAnchor(unit, base).every((c) => legal.has(key(c)) && !taken.has(key(c))),
        );
        choices.sort(
            (a, b) =>
                forward(b) - forward(a) ||
                distance(a, incumbent.get(unit.getId())!) - distance(b, incumbent.get(unit.getId())!),
        );
        if (!choices.length) return incumbent;
        selected.set(unit.getId(), choices[0]);
        footprintCellsForAnchor(unit, choices[0]).forEach((c) => taken.add(key(c)));
    }
    const all = new Set<number>();
    for (const unit of units)
        for (const cell of cells(unit, selected)) {
            if (!legal.has(key(cell)) || all.has(key(cell))) return incumbent;
            all.add(key(cell));
        }
    return selected;
}
