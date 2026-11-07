import { encode, cells, geometry, valid, type PublicInput, type Point } from "./layout";
import { creatureInfo } from "../setup/creature_score";
function assert(condition: unknown): asserts condition {
    if (!condition) throw new Error("Invalid placement relation features");
}
export const FEATURE_SCHEMA = "placement-role-relations-v2";
export function relationFeatures(
    input: PublicInput,
    positions: readonly Point[],
    reference: readonly Point[],
): number[] {
    assert(valid(input, positions) && valid(input, reference));
    const canonical = (p: readonly Point[]) =>
        p.map((v, i) => ({ x: input.left ? v.x : 15 - v.x + input.bodies[i].width - 1, y: v.y }));
    const p = canonical(positions),
        r = canonical(reference),
        foot = p.map((v, i) => cells(input.bodies[i], v));
    const distance = (i: number, j: number) =>
        Math.min(...foot[i].flatMap((a) => foot[j].map((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)))));
    const carry = (i: number) => input.bodies[i].ranged || input.bodies[i].caster;
    const support = (i: number) => input.bodies[i].healer || input.bodies[i].aura;
    const kits = input.enemyKits.join("|");
    const threats = [
        Number(kits.includes("Area Throw")),
        Number(kits.includes("Large Caliber")),
        Number(kits.includes("Chakram")),
        Number(kits.includes("Through Shot")),
        Number(kits.includes("Fire Breath")),
        Number(kits.includes("Lightning Spin")),
        Number(input.enemyIds.some((c) => creatureInfo(c)?.canFly)),
        Number(input.enemyIds.some((c) => creatureInfo(c)?.caster)),
    ];
    const x = [...encode(input, positions), ...threats];
    for (let i = 0; i < 12; i++) {
        if (i >= p.length) {
            x.push(...Array(14).fill(0));
            continue;
        }
        const others = p.map((_, j) => j).filter((j) => j !== i);
        const nearest = (filter: (j: number) => boolean) =>
            Math.min(16, ...others.filter(filter).map((j) => distance(i, j))) / 16;
        const density = (radius: number) => others.filter((j) => distance(i, j) <= radius).length / 11;
        const ahead = others.filter((j) => !carry(j) && p[j].x > p[i].x && Math.abs(p[j].y - p[i].y) <= 2).length / 11;
        const align =
            others.filter(
                (j) =>
                    carry(j) &&
                    (p[i].x === p[j].x || p[i].y === p[j].y || Math.abs(p[i].x - p[j].x) === Math.abs(p[i].y - p[j].y)),
            ).length / 11;
        x.push(
            nearest((j) => !carry(j)),
            nearest(carry),
            nearest(support),
            density(1),
            density(2),
            density(3),
            ahead,
            align,
            others.filter((j) => distance(i, j) === 2).length / 11,
            others.filter((j) => distance(i, j) === 3).length / 11,
            (p[i].x - r[i].x) / 15,
            (p[i].y - r[i].y) / 15,
            (Number(carry(i)) * p[i].x) / 15,
            Number(support(i)) * nearest(carry),
        );
    }
    const g = geometry(input, positions),
        b = geometry(input, reference);
    x.push(...g.map((v, i) => v - b[i]));
    for (const threat of threats) x.push(...g.map((v) => v * threat));
    assert(x.length === 2138 && x.every(Number.isFinite));
    return x;
}
