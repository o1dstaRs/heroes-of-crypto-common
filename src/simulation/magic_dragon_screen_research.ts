/** Offline formation hypothesis. No import activates a shipped setup policy. */
import { creatureInfo } from "../ai/setup/creature_score";
import { validRangedCounterFormation, type IRangedCounterBody } from "../ai/setup/a19_ranged_formation";
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { XY } from "../utils/math";

export interface DragonScreenBody extends IRangedCounterBody {
    name: string;
}
interface Context {
    team: TeamType;
    sideAxis: boolean;
    legal: ReadonlySet<number>;
    enemyIds: readonly number[];
}
const cells = (b: DragonScreenBody, c: XY) => getFootprintCellsForAnchor(c, b.width, b.height);
const gap = (a: readonly XY[], b: readonly XY[]) =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y)))));
const depth = (c: XY, ctx: Context) => {
    const v = ctx.sideAxis ? c.x : c.y;
    return ctx.team === PBTypes.TeamVals.LEFT ? v : 15 - v;
};

/** Segment/rectangle intersection for a hypothetical ordinary shot; this is not engine damage. */
function intersects(from: XY, to: XY, occupied: XY): boolean {
    let lo = 0,
        hi = 1;
    for (const axis of ["x", "y"] as const) {
        const delta = to[axis] - from[axis],
            min = occupied[axis] - 0.49,
            max = occupied[axis] + 0.49;
        if (Math.abs(delta) < 1e-9) {
            if (from[axis] < min || from[axis] > max) return false;
        } else {
            const a = (min - from[axis]) / delta,
                b = (max - from[axis]) / delta;
            lo = Math.max(lo, Math.min(a, b));
            hi = Math.min(hi, Math.max(a, b));
            if (lo > hi) return false;
        }
    }
    return hi > 0 && lo < 1;
}

/** Own formation + public roster only. No actual opponent positions, health or hidden information. */
export function dragonScreenRisk(
    bodies: readonly DragonScreenBody[],
    positions: ReadonlyMap<string, XY>,
    ctx: Context,
): number {
    const enemies = [...new Set(ctx.enemyIds)].flatMap((id) => (creatureInfo(id) ? [creatureInfo(id)!] : []));
    const ordinary = enemies.filter((e) => e.ranged && !/Through Shot|Area Throw/.test(e.abilities)).length;
    const area = enemies.some((e) => e.rangedSpellDamage || /Fire Breath|Through Shot|Area Throw/.test(e.abilities));
    let risk = 0;
    for (const dragon of bodies.filter((b) => b.name === "Magic Dragon")) {
        const own = cells(dragon, positions.get(dragon.id)!);
        const blockers = bodies.filter((b) => b.id !== dragon.id).flatMap((b) => cells(b, positions.get(b.id)!));
        let open = 0,
            rays = 0;
        // Uniform hypothetical origins at the opponent's front. Never read their actual placement.
        for (let lateral = 0; lateral < 16; lateral++) {
            const forward = ctx.team === PBTypes.TeamVals.LEFT ? 12 : 3;
            const origin = ctx.sideAxis ? { x: forward, y: lateral } : { x: lateral, y: forward };
            for (const target of own) {
                rays++;
                if (!blockers.some((cell) => intersects(origin, target, cell))) open++;
            }
        }
        risk += (ordinary > 0 ? open / rays : 0) + 0.05 * Math.max(...own.map((c) => depth(c, ctx)));
        if (area)
            for (const b of bodies.filter((b) => b.id !== dragon.id))
                risk += (0.15 * b.value * Math.max(0, 3 - gap(own, cells(b, positions.get(b.id)!)))) / 3;
    }
    return risk;
}

/** Move only Dragons into free cells; preserve every incumbent friendly aura link and rear depth. */
export function screenMagicDragonFormation(
    bodies: readonly DragonScreenBody[],
    incumbent: ReadonlyMap<string, XY>,
    ctx: Context,
): Map<string, XY> {
    const result = new Map([...incumbent].map(([id, c]) => [id, { ...c }]));
    if (!validRangedCounterFormation(bodies, result, ctx.legal)) return result;
    const links = bodies.flatMap((a) =>
        bodies.flatMap((b) =>
            a.id === b.id
                ? []
                : a.buffRanges
                      .filter((range) => gap(cells(a, result.get(a.id)!), cells(b, result.get(b.id)!)) <= range)
                      .map((range) => ({ a, b, range })),
        ),
    );
    const anchors = [...ctx.legal].sort((a, b) => a - b).map((k) => ({ x: k >> 4, y: k & 15 }));
    for (const dragon of bodies.filter((b) => b.name === "Magic Dragon")) {
        const original = result.get(dragon.id)!;
        const limit = Math.max(...cells(dragon, original).map((c) => depth(c, ctx)));
        let best = original,
            bestRisk = dragonScreenRisk(bodies, result, ctx);
        for (const anchor of anchors) {
            if (Math.max(...cells(dragon, anchor).map((c) => depth(c, ctx))) > limit) continue;
            result.set(dragon.id, anchor);
            if (
                !validRangedCounterFormation(bodies, result, ctx.legal) ||
                !links.every(
                    ({ a, b, range }) => gap(cells(a, result.get(a.id)!), cells(b, result.get(b.id)!)) <= range,
                )
            )
                continue;
            const proposed = dragonScreenRisk(bodies, result, ctx);
            if (proposed < bestRisk - 1e-9) {
                best = anchor;
                bestRisk = proposed;
            }
        }
        result.set(dragon.id, best);
    }
    return result;
}
