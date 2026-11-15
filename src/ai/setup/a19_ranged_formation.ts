// Production copy of the frozen formation policy; parity is checked against the original research helper.
import { creatureIdForName, creatureInfo } from "./creature_score";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { TeamType } from "../../generated/protobuf/v1/types_gen";
import { getFootprintCellsForAnchor } from "../../grid/grid_math";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";

export function rangedCounterThreats(ids: readonly number[]) {
    const infos = [...new Set(ids)].flatMap((id) => {
        const info = creatureInfo(id);
        return info ? [info] : [];
    });
    return {
        nullField: infos.some((info) => info.abilities.includes("Range Null Field")),
        flyers: infos.filter((info) => info.canFly && !info.ranged).length,
        area: infos.some(
            (info) => info.rangedSpellDamage || /Fire Breath|Through Shot|Area Throw/.test(info.abilities),
        ),
    };
}

export interface IRangedCounterBody {
    id: string;
    width: number;
    height: number;
    ranged: boolean;
    caster: boolean;
    value: number;
    buffRanges: readonly number[];
}

const cellKey = (cell: XY): number => cell.x * 16 + cell.y;
const bodyCells = (body: IRangedCounterBody, cell: XY): XY[] =>
    getFootprintCellsForAnchor(cell, body.width, body.height);
const gap = (a: readonly XY[], b: readonly XY[]): number =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y)))));

export function rangedCounterBodies(units: readonly Unit[], extraAuraRange: number): IRangedCounterBody[] {
    return units.map((unit) => {
        const id = creatureIdForName(unit.getName());
        const info = id === undefined ? undefined : creatureInfo(id);
        return {
            id: unit.getId(),
            width: unit.getFootprintWidth(),
            height: unit.getFootprintHeight(),
            ranged: info?.ranged ?? false,
            caster: info?.caster ?? false,
            value: Math.min(1.5, Math.max(0, ((info?.exp ?? 0) * unit.getAmountAlive()) / 1000)),
            buffRanges: unit
                .getAuraEffects()
                .filter((aura) => aura.getProperties().is_buff)
                .map((aura) => aura.getRange() + extraAuraRange),
        };
    });
}

export function validRangedCounterFormation(
    bodies: readonly IRangedCounterBody[],
    positions: ReadonlyMap<string, XY>,
    legal: ReadonlySet<number>,
): boolean {
    if (
        !bodies.length ||
        positions.size !== bodies.length ||
        new Set(bodies.map((body) => body.id)).size !== bodies.length
    )
        return false;
    const occupied = new Set<number>();
    for (const body of bodies) {
        const point = positions.get(body.id);
        if (
            !point ||
            !Number.isInteger(point.x) ||
            !Number.isInteger(point.y) ||
            !Number.isInteger(body.width) ||
            !Number.isInteger(body.height) ||
            body.width < 1 ||
            body.height < 1 ||
            body.width > 16 ||
            body.height > 16 ||
            !Number.isFinite(body.value) ||
            body.value < 0
        )
            return false;
        for (const cell of bodyCells(body, point)) {
            const key = cellKey(cell);
            if (cell.x < 0 || cell.y < 0 || cell.x >= 16 || cell.y >= 16 || !legal.has(key) || occupied.has(key))
                return false;
            occupied.add(key);
        }
    }
    return true;
}

/** A geometric diagnostic, not a win prediction. Only own geometry and public creature identities enter. */
export function rangedCounterFormationRisk(
    bodies: readonly IRangedCounterBody[],
    positions: ReadonlyMap<string, XY>,
    team: TeamType,
    sideAxis: boolean,
    enemyIds: readonly number[],
): number {
    const threats = rangedCounterThreats(enemyIds);
    const footprints = bodies.map((body) => bodyCells(body, positions.get(body.id)!));
    let risk = 0;
    bodies.forEach((body, i) => {
        if (!body.ranged && !body.caster) return;
        const forward =
            footprints[i].reduce((total, cell) => total + (sideAxis ? cell.x : cell.y), 0) / footprints[i].length;
        const depth = team === PBTypes.TeamVals.LEFT ? forward : 15 - forward;
        risk += 0.06 * body.value * depth;
    });
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            const distance = gap(footprints[i], footprints[j]);
            const value = Math.min(bodies[i].value, bodies[j].value);
            if (threats.area) risk += (value * Math.max(0, 3 - distance)) / 3;
            if (threats.nullField && bodies[i].ranged && bodies[j].ranged)
                risk += (value * Math.max(0, 6 - distance)) / 6;
        }
    }
    return risk;
}

/** Two deterministic coordinate sweeps, retaining every existing friendly aura link and every legal footprint. */
export function spreadRangedCounterFormation(
    bodies: readonly IRangedCounterBody[],
    incumbent: ReadonlyMap<string, XY>,
    context: {
        legal: ReadonlySet<number>;
        team: TeamType;
        sideAxis: boolean;
        enemyIds: readonly number[];
    },
): Map<string, XY> {
    const result = new Map([...incumbent].map(([id, cell]) => [id, { ...cell }]));
    const threats = rangedCounterThreats(context.enemyIds);
    if ((!threats.area && !threats.nullField) || !validRangedCounterFormation(bodies, result, context.legal))
        return result;
    const links = bodies.flatMap((source) =>
        bodies.flatMap((target) => {
            if (source.id === target.id) return [];
            const before = gap(bodyCells(source, result.get(source.id)!), bodyCells(target, result.get(target.id)!));
            return source.buffRanges
                .filter((range) => Number.isFinite(range) && before <= range)
                .map((range) => ({ source, target, range }));
        }),
    );
    const retainsAuras = (): boolean =>
        links.every(
            ({ source, target, range }) =>
                gap(bodyCells(source, result.get(source.id)!), bodyCells(target, result.get(target.id)!)) <= range,
        );
    const score = (): number =>
        rangedCounterFormationRisk(bodies, result, context.team, context.sideAxis, context.enemyIds);
    const anchors = [...context.legal].sort((a, b) => a - b).map((key) => ({ x: key >> 4, y: key & 15 }));
    const movable = bodies
        .filter((body) => body.ranged || body.caster)
        .sort((a, b) => b.value - a.value || bodies.indexOf(a) - bodies.indexOf(b));
    for (let sweep = 0; sweep < 2; sweep++) {
        let changed = false;
        for (const body of movable) {
            const original = result.get(body.id)!;
            let best = original;
            let bestScore = score();
            for (const anchor of anchors) {
                result.set(body.id, anchor);
                if (!validRangedCounterFormation(bodies, result, context.legal) || !retainsAuras()) continue;
                const proposed = score();
                if (proposed < bestScore - 1e-9) {
                    bestScore = proposed;
                    best = anchor;
                }
            }
            result.set(body.id, best);
            changed ||= best.x !== original.x || best.y !== original.y;
        }
        if (!changed) break;
    }
    return result;
}
