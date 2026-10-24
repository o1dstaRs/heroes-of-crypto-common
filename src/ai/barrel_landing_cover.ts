import type { XY } from "../utils/math";
import type { IBarrelCasterCoverContext } from "./barrel_caster_cover";

/** Printed public-roster geometry and XP only; no enemy positions, counts, or setup choices. */
export interface IBarrelLandingThreat {
    readonly width: number;
    readonly height: number;
    readonly weight: number;
}

export interface IBarrelLandingCoverContext extends IBarrelCasterCoverContext {
    readonly currentBarrels: readonly XY[];
    readonly threats: readonly IBarrelLandingThreat[];
    /** Selected from the public enemy roster, before considering any candidate barrel cells. */
    readonly hasLargeFlyingEnemy: boolean;
}

const key = ({ x, y }: XY) => `${x},${y}`;

/** Research-only: improve caster contact protection without closing a friendly opening shot or exit. */
export function planBarrelLandingCover(context: IBarrelLandingCoverContext): XY[] | undefined {
    const { gridSize, ownStacks, threats } = context;
    if (!context.hasLargeFlyingEnemy || !ownStacks.some((stack) => stack.spellcaster)) return undefined;
    const occupied = new Set(context.occupiedCells.map(key));
    const inBounds = (cell: XY) => cell.x >= 0 && cell.y >= 0 && cell.x < gridSize && cell.y < gridSize;
    const body = (anchor: XY, width: number, height: number): XY[] =>
        Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) => ({ x: anchor.x - x, y: anchor.y - y })),
        ).flat();
    const forward = (cell: XY) => {
        const coordinate = context.sideOriented ? cell.x : cell.y;
        return context.forwardSign === 1 ? coordinate : gridSize - 1 - coordinate;
    };
    const cross = (cell: XY) => (context.sideOriented ? cell.y : cell.x);
    const shooters = ownStacks
        .filter((stack) => stack.blocksRangedShots)
        .map((stack) => ({
            forward: stack.cells.reduce((sum, cell) => sum + forward(cell) + 0.5, 0) / stack.cells.length,
            cross: stack.cells.reduce((sum, cell) => sum + cross(cell) + 0.5, 0) / stack.cells.length,
        }));
    const blocksShot = (cell: XY) =>
        shooters.some((shooter) => {
            const advance = forward(cell) + 1 - shooter.forward;
            if (advance <= 0) return false;
            const distance = gridSize / 2 - shooter.forward;
            if (distance <= 0) return true;
            const fraction = Math.min(1, advance / distance);
            const low = shooter.cross * (1 - fraction);
            const high = shooter.cross + (gridSize - shooter.cross) * fraction;
            return cross(cell) + 1 >= low && cross(cell) <= high;
        });
    const cells = context.allowedCells
        .filter(
            (cell, index, all) =>
                Number.isInteger(cell.x) &&
                Number.isInteger(cell.y) &&
                inBounds(cell) &&
                !occupied.has(key(cell)) &&
                !blocksShot(cell) &&
                all.findIndex((other) => other.x === cell.x && other.y === cell.y) === index,
        )
        .sort((a, b) => a.x - b.x || a.y - b.y);
    const plans = ownStacks
        .filter((stack) => stack.spellcaster)
        .flatMap((stack) => {
            const minX = Math.min(...stack.cells.map((cell) => cell.x));
            const maxX = Math.max(...stack.cells.map((cell) => cell.x));
            const minY = Math.min(...stack.cells.map((cell) => cell.y));
            const maxY = Math.max(...stack.cells.map((cell) => cell.y));
            return threats.flatMap((threat) => {
                if (
                    threat.weight <= 0 ||
                    !Number.isFinite(threat.weight) ||
                    ![1, 2].includes(threat.width) ||
                    ![1, 2].includes(threat.height)
                )
                    return [];
                const landings: Set<string>[] = [];
                for (let x = minX - 1; x <= maxX + threat.width; x++) {
                    for (let y = minY - 1; y <= maxY + threat.height; y++) {
                        const footprint = body({ x, y }, threat.width, threat.height);
                        if (footprint.some((cell) => !inBounds(cell) || occupied.has(key(cell)))) continue;
                        if (
                            !footprint.some((cell) =>
                                stack.cells.some(
                                    (ward) => Math.max(Math.abs(cell.x - ward.x), Math.abs(cell.y - ward.y)) === 1,
                                ),
                            )
                        )
                            continue;
                        landings.push(new Set(footprint.map(key)));
                    }
                }
                return landings.length && landings.length < 31
                    ? [{ landings, weight: stack.value * threat.weight }]
                    : [];
            });
        });
    if (!plans.length) return undefined;
    const exits = ownStacks.map((stack) => {
        const own = new Set(stack.cells.map(key));
        const anchor = {
            x: Math.max(...stack.cells.map((cell) => cell.x)),
            y: Math.max(...stack.cells.map((cell) => cell.y)),
        };
        const width = anchor.x - Math.min(...stack.cells.map((cell) => cell.x)) + 1;
        const height = anchor.y - Math.min(...stack.cells.map((cell) => cell.y)) + 1;
        const current: string[][] = [];
        const safe: string[][] = [];
        for (const dx of [-1, 0, 1])
            for (const dy of [-1, 0, 1]) {
                if (!dx && !dy) continue;
                const destination = body({ x: anchor.x + dx, y: anchor.y + dy }, width, height);
                const free = (cell: XY) => inBounds(cell) && (!occupied.has(key(cell)) || own.has(key(cell)));
                if (!destination.every(free)) continue;
                // Destination-only is an upper bound on existing mobility. A large walker also needs
                // its swept orthogonal corners: an empty diagonal destination alone is not an exit.
                current.push(destination.map(key));
                const swept =
                    dx && dy && width * height > 1
                        ? [
                              ...destination,
                              ...body({ x: anchor.x + dx, y: anchor.y }, width, height),
                              ...body({ x: anchor.x, y: anchor.y + dy }, width, height),
                          ]
                        : destination;
                if (swept.every(free)) safe.push(swept.map(key));
            }
        return { current, safe };
    });
    // A contact ring has at most sixteen legal anchors for the supported 1x1..2x2 bodies.
    // Precompute masks once; evaluating a barrel pair allocates no footprint arrays or Sets.
    const cellKeys = cells.map(key);
    const masksFor = (options: readonly Iterable<string>[]) => {
        const byCell = new Map<string, number>();
        options.forEach((option, index) => {
            for (const cell of option) byCell.set(cell, (byCell.get(cell) ?? 0) | (1 << index));
        });
        return {
            masks: cellKeys.map((cell) => byCell.get(cell) ?? 0),
            current: context.currentBarrels.reduce((mask, cell) => mask | (byCell.get(key(cell)) ?? 0), 0),
            full: (1 << options.length) - 1,
        };
    };
    const protection = plans.map((plan) => ({
        ...masksFor(plan.landings),
        total: plan.landings.length,
        weight: plan.weight,
    }));
    const mobile = exits
        .filter((exit) => {
            const baseline = masksFor(exit.current);
            return baseline.current !== baseline.full;
        })
        .map((exit) => masksFor(exit.safe));
    const countBits = (mask: number) => {
        mask -= (mask >>> 1) & 0x55555555;
        mask = (mask & 0x33333333) + ((mask >>> 2) & 0x33333333);
        return (((mask + (mask >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    };
    const contribution = (mask: number, total: number, weight: number) => {
        const fraction = countBits(mask) / total;
        return weight * (fraction * fraction + (fraction === 1 ? 1 : 0));
    };
    let bestScore = protection.reduce((sum, plan) => sum + contribution(plan.current, plan.total, plan.weight), 0);
    let best: XY[] | undefined;
    for (let first = 0; first < cells.length; first++) {
        for (let second = first + 1; second < cells.length; second++) {
            let sealsExit = false;
            for (const exit of mobile) {
                if ((exit.masks[first] | exit.masks[second]) === exit.full) {
                    sealsExit = true;
                    break;
                }
            }
            if (sealsExit) continue;
            let candidate = 0;
            for (const plan of protection)
                candidate += contribution(plan.masks[first] | plan.masks[second], plan.total, plan.weight);
            if (candidate <= bestScore + 1e-9) continue;
            bestScore = candidate;
            best = [{ ...cells[first] }, { ...cells[second] }];
        }
    }
    return best;
}
