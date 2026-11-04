import { sha256Seed } from "./sha256";
function assert(condition: unknown, message = "Invalid placement model input"): asserts condition {
    if (!condition) throw new Error(message);
}

export type Point = { x: number; y: number };
export type Body = {
    id: string;
    creature: number;
    name: string;
    amount: number;
    width: number;
    height: number;
    ranged: boolean;
    caster: boolean;
    healer: boolean;
    aura: boolean;
    fly: boolean;
    driven: boolean;
    hp: number;
    damage: number;
    range: number;
    steps: number;
    initiative: number;
    level: number;
};
export type PublicInput = {
    bodies: Body[];
    enemyIds: number[];
    enemyKits: string[];
    map: number;
    artifacts: number[];
    doctrine: number;
    augments: { kind: string; value: number }[];
    left: boolean;
    legal: number[];
};
export const CANDIDATES = [
    "incumbent",
    "carry-depth",
    "area-separation",
    "chain-break",
    "ray-break",
    "support-cluster",
    "public-kit-blend",
    "explore",
];
export const key = (p: Point) => (p.x << 4) | p.y;
export const cells = (b: Body, p: Point): Point[] =>
    Array.from({ length: b.width * b.height }, (_, i) => ({
        x: p.x - (i % b.width),
        y: p.y - Math.floor(i / b.width),
    }));
export function valid(input: PublicInput, positions: readonly Point[]): boolean {
    if (positions.length !== input.bodies.length) return false;
    const legal = new Set(input.legal),
        occupied = new Set<number>();
    for (let i = 0; i < positions.length; i++) {
        if (!Number.isInteger(positions[i].x) || !Number.isInteger(positions[i].y)) return false;
        for (const p of cells(input.bodies[i], positions[i])) {
            if (p.x < 0 || p.y < 0 || p.x >= 16 || p.y >= 16 || !legal.has(key(p)) || occupied.has(key(p)))
                return false;
            occupied.add(key(p));
        }
    }
    return true;
}
const canonical = (input: PublicInput, positions: readonly Point[]) =>
    positions.map((p, i) => ({ x: input.left ? p.x : 15 - p.x + input.bodies[i].width - 1, y: p.y }));
export function geometry(input: PublicInput, positions: readonly Point[]): number[] {
    const pts = canonical(input, positions),
        foot = pts.map((p, i) => cells(input.bodies[i], p));
    let splash = 0,
        chain = 0,
        rays = 0,
        spread = 0,
        support = 0,
        carryDepth = 0,
        guardDepth = 0;
    for (let i = 0; i < pts.length; i++) {
        const b = input.bodies[i],
            carry = b.ranged || b.caster;
        if (carry) carryDepth += pts[i].x / 6;
        else guardDepth += pts[i].x / 6;
        for (let j = i + 1; j < pts.length; j++) {
            const d = Math.min(
                ...foot[i].flatMap((a) => foot[j].map((c) => Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y)))),
            );
            splash += Math.max(0, 3 - d) / 2;
            // Proposal descriptors only. Actual Chakram paths, bridge blockage and target choice
            // are evaluated by the unchanged canonical engine in terminal rollouts.
            chain += d === 2 ? 1 : d === 3 ? 0.5 : 0;
            const dx = Math.abs(pts[i].x - pts[j].x),
                dy = Math.abs(pts[i].y - pts[j].y);
            rays += dx === 0 || dy === 0 || dx === dy ? 1 : 0;
            spread += d / 15;
            if (b.aura || b.healer || input.bodies[j].aura || input.bodies[j].healer)
                support += Math.max(0, d - 2) / 15;
        }
    }
    const pairs = Math.max(1, (pts.length * (pts.length - 1)) / 2);
    return [
        carryDepth / pts.length,
        guardDepth / pts.length,
        splash / pairs,
        chain / pairs,
        rays / pairs,
        spread / pairs,
        support / pairs,
    ];
}
function cost(input: PublicInput, p: readonly Point[], candidate: number): number {
    const [carry, guard, splash, chain, rays, spread, support] = geometry(input, p);
    const kits = input.enemyKits.join("|");
    switch (candidate) {
        case 1:
            return 4 * carry - guard + 0.3 * splash;
        case 2:
            return 4 * splash + carry - spread;
        case 3:
            return 4 * chain + 0.3 * carry;
        case 4:
            return 4 * rays + 0.4 * carry;
        case 5:
            return 4 * support + carry - 0.5 * guard;
        case 6:
            return (
                carry -
                0.5 * guard +
                support +
                (/Area Throw|Large Caliber/.test(kits) ? 4 : 0.2) * splash +
                (kits.includes("Chakram") ? 5 : 0) * chain +
                (kits.includes("Through Shot") ? 4 : 0) * rays
            );
        default:
            return 0;
    }
}
export function propose(input: PublicInput, baseline: readonly Point[], candidate: number): Point[] {
    assert(Number.isInteger(candidate) && candidate >= 0 && candidate < CANDIDATES.length);
    assert(valid(input, baseline), "Incumbent final formation is illegal");
    let best = baseline.map((p) => ({ ...p }));
    if (!candidate) return best;
    // Search randomness depends only on the detached public/own envelope, never fight seeds or enemy positions.
    let state = sha256Seed(
        JSON.stringify([
            input.bodies.map(({ id: _id, ...b }) => b),
            input.enemyIds,
            input.map,
            input.artifacts,
            candidate,
        ]),
    );
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const anchors = input.bodies.map((b) =>
        input.legal
            .map((k) => ({ x: k >> 4, y: k & 15 }))
            .filter((p) => cells(b, p).every((c) => c.x >= 0 && c.y >= 0 && input.legal.includes(key(c)))),
    );
    let score = cost(input, best, candidate),
        changed = 0;
    for (let step = 0; step < 384; step++) {
        const next = best.map((p) => ({ ...p })),
            i = Math.floor(random() * next.length);
        if (step % 4 === 0) {
            const j = Math.floor(random() * next.length);
            [next[i], next[j]] = [next[j], next[i]];
        } else next[i] = { ...anchors[i][Math.floor(random() * anchors[i].length)] };
        if (!valid(input, next)) continue;
        const value = cost(input, next, candidate);
        if (candidate === 7 ? changed < 12 : value < score - 1e-10) {
            best = next;
            score = value;
            changed++;
        }
    }
    assert(valid(input, best));
    return best;
}
export function encode(input: PublicInput, positions: readonly Point[]): number[] {
    assert(valid(input, positions));
    assert(input.bodies.length <= 12);
    const x = [
        ...[1, 3, 4].map((m) => Number(m === input.map)),
        input.doctrine / 3,
        ...input.artifacts.map((a) => a / 64),
    ];
    for (const kind of ["Placement", "Armor", "Might", "Sniper", "Movement", "Empower"])
        x.push((input.augments.find((a) => a.kind === kind)?.value ?? 0) / 3);
    const enemy = new Set(input.enemyIds);
    for (let c = 0; c < 128; c++) x.push(Number(enemy.has(c)));
    const pts = canonical(input, positions);
    // Original own roster order is stable; no unit IDs, family IDs, enemy setup or battle seed enters tensors.
    for (let i = 0; i < 12; i++) {
        const b = input.bodies[i],
            p = pts[i];
        for (let c = 0; c < 128; c++) x.push(Number(!!b && b.creature === c));
        x.push(
            ...(b
                ? [
                      1,
                      p.x / 15,
                      p.y / 15,
                      b.width / 2,
                      b.height / 2,
                      Math.log1p(b.amount) / 8,
                      b.hp / 1000,
                      b.damage / 100,
                      b.range / 16,
                      b.steps / 10,
                      b.initiative / 10,
                      b.level / 4,
                      Number(b.ranged),
                      Number(b.caster),
                      Number(b.healer),
                      Number(b.aura),
                      Number(b.fly),
                      Number(b.driven),
                  ]
                : Array(18).fill(0)),
        );
    }
    x.push(...geometry(input, positions));
    assert(x.every(Number.isFinite));
    return x;
}
export interface PlacementModel {
    id: string;
    minimumGain: number;
    layers: { weight: number[][]; bias: number[] }[];
}
export function predict(model: PlacementModel, features: number[]): number {
    let x = features;
    for (let l = 0; l < model.layers.length; l++) {
        const layer = model.layers[l];
        assert(layer.weight[0].length === x.length);
        x = layer.weight.map((w: number[], i: number) => {
            let value = layer.bias[i];
            for (let j = 0; j < w.length; j++) value += w[j] * x[j];
            return l < model.layers.length - 1 ? Math.max(0, value) : value;
        });
    }
    return x[0];
}

export function chooseCandidate(scores: readonly number[], minimumGain: number, reference = 0): number {
    assert(scores.length > 0 && scores.every(Number.isFinite));
    assert(Number.isFinite(minimumGain) && minimumGain >= 0);
    assert(Number.isInteger(reference) && reference >= 0 && reference < scores.length);
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return scores[best] > scores[reference] + minimumGain ? best : reference;
}
