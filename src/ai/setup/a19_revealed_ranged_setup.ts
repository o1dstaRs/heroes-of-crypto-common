import { creatureInfo } from "./creature_score";
import { isA19DeliveryMelee } from "./a19_revealed_ranged_draft";
import type { ISetupAugmentChoice } from "./setup_ship";
import { PathHelper } from "../../grid/path_helper";
import type { Grid } from "../../grid/grid";
import type { TeamType } from "../../units/unit_properties";
import type { XY } from "../../utils/math";

export { A19_REVEALED_RANGED_SETUP_POLICY } from "./a19_revealed_ranged_identity";
export const A19_REVEALED_RANGED_SETUP_SOURCE_SHA256 =
    "493b4bc8a3cd216cdf73258cc29ac00fcaebdccab048f75fb6c7024839fe66b8";
const kinds = ["Placement", "Movement", "Armor", "Might", "Sniper", "Empower"] as const;
export type A19DeliveryLevels = Record<(typeof kinds)[number], number>;
export interface IA19DeliveryPlan {
    id: string;
    levels: A19DeliveryLevels;
    augments: ISetupAugmentChoice[];
    cost: number;
}
export interface IA19DeliveryBody extends XY {
    id: string;
    width: number;
    height: number;
    eligible: boolean;
}
export interface IA19DeliveryUnit extends XY {
    name: string;
    creatureId: number;
    amount: number;
    width: number;
    height: number;
    steps: number;
    fly: boolean;
    lava: boolean;
    vine: boolean;
}
export function a19DeliveryLevels(augments: readonly ISetupAugmentChoice[]): A19DeliveryLevels {
    return Object.fromEntries(
        kinds.map((kind) => [kind, augments.find((entry) => entry.kind === kind)?.value ?? 0]),
    ) as A19DeliveryLevels;
}

export function a19FundedDeliveryPlans(
    base: readonly ISetupAugmentChoice[],
    ownIds: readonly number[],
): IA19DeliveryPlan[] {
    const original = a19DeliveryLevels(base);
    const result: IA19DeliveryPlan[] = [
        { id: "free-forward", levels: original, augments: base.map((entry) => ({ ...entry })), cost: 0 },
    ];
    const own = ownIds.flatMap((id) => creatureInfo(id) ?? []);
    for (const [placement, movement] of [
        [0, 1],
        [0, 2],
        [1, 0],
        [1, 1],
    ]) {
        if (original.Placement > placement || original.Movement > movement) continue;
        const levels = { ...original, Placement: placement, Movement: movement };
        const cost = placement - original.Placement + movement - original.Movement;
        let remaining = cost;
        if (!cost) continue;
        for (const kind of ["Sniper", "Empower", "Might"] as const) {
            const floor =
                kind === "Sniper"
                    ? own.some((unit) => unit.ranged)
                        ? 1
                        : 0
                    : kind === "Empower"
                      ? own.some((unit) => unit.dealsMagicDamage)
                          ? original.Empower
                          : 0
                      : original.Might;
            const points = Math.min(remaining, Math.max(0, levels[kind] - floor));
            levels[kind] -= points;
            remaining -= points;
        }
        if (remaining) continue;
        result.push({
            id: `p${placement}-m${movement}`,
            levels,
            augments: kinds.filter((kind) => levels[kind]).map((kind) => ({ kind, value: levels[kind] })),
            cost,
        });
    }
    return result.sort(
        (a, b) => a.cost - b.cost || a.levels.Placement - b.levels.Placement || a.levels.Movement - b.levels.Movement,
    );
}

const key = (x: number, y: number) => `${x},${y}`;
const footprint = (body: IA19DeliveryBody, x = body.x, y = body.y): XY[] =>
    Array.from({ length: body.width * body.height }, (_, index) => ({
        x: x - (index % body.width),
        y: y - Math.floor(index / body.width),
    }));

/** Exact saved forward geometry; no enemy placement is an input. */
export function a19DeliveryForwardFormation(
    input: readonly IA19DeliveryBody[],
    allowed: readonly XY[],
    blocked: readonly XY[],
    direction: 1 | -1,
): IA19DeliveryBody[] {
    const bodies = input.map((body) => ({ ...body }));
    const legal = new Set(allowed.map((cell) => key(cell.x, cell.y)));
    const occupied = new Set(blocked.map((cell) => key(cell.x, cell.y)));
    for (const body of bodies)
        for (const cell of footprint(body)) {
            const cellKey = key(cell.x, cell.y);
            if (!legal.has(cellKey) || occupied.has(cellKey)) throw new Error("Invalid native delivery formation");
            occupied.add(cellKey);
        }
    const ordered = bodies
        .filter((body) => body.eligible)
        .sort((a, b) => direction * (b.x - a.x) || b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
    for (let pass = 0; pass < 3; pass++)
        for (const body of ordered) {
            const original = input.find((unit) => unit.id === body.id)!;
            for (const cell of footprint(body)) occupied.delete(key(cell.x, cell.y));
            const options = allowed
                .filter(
                    (cell) =>
                        direction * (cell.x - body.x) > 0 &&
                        Math.abs(cell.y - original.y) <= 2 &&
                        footprint(body, cell.x, cell.y).every(
                            (part) => legal.has(key(part.x, part.y)) && !occupied.has(key(part.x, part.y)),
                        ),
                )
                .sort(
                    (a, b) =>
                        direction * (b.x - a.x) || Math.abs(a.y - original.y) - Math.abs(b.y - original.y) || a.y - b.y,
                );
            if (options.length) {
                body.x = options[0].x;
                body.y = options[0].y;
            }
            for (const cell of footprint(body)) occupied.add(key(cell.x, cell.y));
        }
    return bodies;
}

/** Bind the own projected fight properties before calling; the grid contains only public terrain and own barrels. */
export function a19DeliveryReachScore(units: readonly IA19DeliveryUnit[], grid: Grid, team: TeamType): number {
    const matrix = grid.getMatrixNoUnits(),
        path = new PathHelper(grid.getSettings());
    const totals = new Map<string, number>();
    for (const unit of units) totals.set(unit.name, (totals.get(unit.name) ?? 0) + unit.amount);
    let score = 0;
    for (const unit of units) {
        if (
            !isA19DeliveryMelee(unit.creatureId) ||
            (unit.amount < 2 && totals.get(unit.name)! > 1) ||
            unit.amount < totals.get(unit.name)! / 2
        )
            continue;
        const routes = path.getMovePath(
            { x: unit.x, y: unit.y },
            matrix,
            unit.steps,
            undefined,
            unit.fly,
            unit.width === 1 && unit.height === 1,
            unit.lava,
            unit.vine,
            unit.width,
            unit.height,
        ).knownPaths;
        const cells = [
            { x: unit.x, y: unit.y },
            ...[...routes.values()].flatMap((paths) => paths.map((route) => route.cell)),
        ];
        let contact = 0;
        for (const x of team === 2 ? [12, 13, 14] : [1, 2, 3])
            for (const y of [3, 6, 9, 12])
                if (
                    cells.some(
                        (cell) =>
                            Math.max(0, cell.x - unit.width + 1 - x, x - cell.x) <= 1 &&
                            Math.max(0, cell.y - unit.height + 1 - y, y - cell.y) <= 1,
                    )
                )
                    contact++;
        score += (((unit.amount * creatureInfo(unit.creatureId)!.exp) / 1000) * contact) / 12;
    }
    return score;
}
