import type { XY } from "../utils/math";

/** Own deployment data only. Opponent positions, units, artifacts and augments are deliberately absent. */
export interface IBarrelCoverStack {
    readonly cells: readonly XY[];
    readonly spellcaster: boolean;
    readonly blocksRangedShots: boolean;
    readonly value: number;
}

export interface IBarrelCasterCoverContext {
    readonly gridSize: number;
    readonly sideOriented: boolean;
    /** LEFT advances towards increasing X (side board) or Y (classic board). */
    readonly forwardSign: 1 | -1;
    readonly allowedCells: readonly XY[];
    readonly occupiedCells: readonly XY[];
    readonly ownStacks: readonly IBarrelCoverStack[];
}

/**
 * Research-only free deployment: cover casters' forward contact cells without screening a friendly
 * shooter's opening cone. The cone covers the entire opposite half, rather than peeking at enemy cells.
 * Returns no intervention if the army has no caster, no safe pair, or no useful forward screen.
 */
export function planBarrelCasterCover(context: IBarrelCasterCoverContext): XY[] | undefined {
    const { gridSize, sideOriented, forwardSign, ownStacks } = context;
    const forward = (cell: XY) => {
        const coordinate = sideOriented ? cell.x : cell.y;
        return forwardSign === 1 ? coordinate : gridSize - 1 - coordinate;
    };
    const cross = (cell: XY) => (sideOriented ? cell.y : cell.x);
    const occupied = new Set(context.occupiedCells.map((cell) => `${cell.x},${cell.y}`));
    const stacks = ownStacks
        .filter((stack) => stack.cells.length && Number.isFinite(stack.value) && stack.value > 0)
        .map((stack) => ({
            ...stack,
            front: Math.max(...stack.cells.map(forward)),
            crossMin: Math.min(...stack.cells.map(cross)),
            crossMax: Math.max(...stack.cells.map(cross)),
            originForward: stack.cells.reduce((sum, cell) => sum + forward(cell) + 0.5, 0) / stack.cells.length,
            originCross: stack.cells.reduce((sum, cell) => sum + cross(cell) + 0.5, 0) / stack.cells.length,
        }));
    if (!stacks.some((stack) => stack.spellcaster)) return undefined;
    const blocksOpeningShot = (cell: XY) =>
        stacks.some((stack) => {
            if (!stack.blocksRangedShots) return false;
            const advance = forward(cell) + 1 - stack.originForward;
            if (advance <= 0) return false;
            const enemyDistance = gridSize / 2 - stack.originForward;
            if (enemyDistance <= 0) return true;
            const fraction = Math.min(1, advance / enemyDistance);
            const low = stack.originCross * (1 - fraction);
            const high = stack.originCross + (gridSize - stack.originCross) * fraction;
            return cross(cell) + 1 >= low && cross(cell) <= high;
        });
    const seen = new Set<string>();
    const candidates = context.allowedCells
        .filter((cell) => {
            const key = `${cell.x},${cell.y}`;
            if (
                seen.has(key) ||
                occupied.has(key) ||
                !Number.isInteger(cell.x) ||
                !Number.isInteger(cell.y) ||
                cell.x < 0 ||
                cell.y < 0 ||
                cell.x >= gridSize ||
                cell.y >= gridSize
            )
                return false;
            seen.add(key);
            return !blocksOpeningShot(cell);
        })
        .sort((a, b) => forward(b) - forward(a) || cross(a) - cross(b));
    let best: XY[] | undefined;
    let bestScore = 0;
    const cellScore = (cell: XY) =>
        stacks.reduce((score, stack) => {
            if (
                forward(cell) !== stack.front + 1 ||
                cross(cell) < stack.crossMin - 1 ||
                cross(cell) > stack.crossMax + 1
            )
                return score;
            return score + stack.value * (stack.spellcaster ? 1 : stack.blocksRangedShots ? 0 : -0.1);
        }, 0);
    const scores = candidates.map(cellScore);
    for (let first = 0; first < candidates.length; first++) {
        for (let second = first + 1; second < candidates.length; second++) {
            if (scores[first] <= 0 || scores[second] <= 0) continue;
            const a = candidates[first],
                b = candidates[second];
            const adjacent = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
            const score =
                scores[first] +
                scores[second] +
                (adjacent ? Math.min(Math.max(0, scores[first]), Math.max(0, scores[second])) * 0.05 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = [{ ...a }, { ...b }];
            }
        }
    }
    return best;
}
