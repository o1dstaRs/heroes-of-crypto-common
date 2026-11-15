import { resolveChakramTrajectory } from "../abilities/chakram_ability";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";
import { deepClone } from "./battle_snapshot";

export const CHAKRAM_SCREEN_MOVE_RESEARCH_ID = "chakram-screen-move-v1";
type Context = Pick<IDecisionContext, "grid" | "unitsHolder" | "decisionOrigin">;
export interface IChakramExposure {
    readonly maximum: number;
    readonly total: number;
    readonly flights: number;
}

/**
 * Pure geometric proposal score, not expected damage or a forecast of the enemy's chosen primary.
 * Canonical clockwise paths, bridge occupancy, rectangular bodies and Wingshield remain authoritative.
 * Moving the actor clears its old cells AND occupies its new cells; deleting it is not a move model.
 * The normal engine rollout owns first-shot legality, misses, damage, initiative and other attack types.
 */
export function chakramExposureAt(unit: Unit, context: Context, destination: readonly XY[]): IChakramExposure {
    return exposureEvaluator(unit, context)(destination);
}

function exposureEvaluator(unit: Unit, context: Context): (destination: readonly XY[]) => IChakramExposure {
    const all = context.unitsHolder.getAllUnits();
    const actorId = unit.getId();
    let cells = unit.getCells();
    const moved = Object.create(unit) as Unit;
    moved.getCells = () => cells.map((cell) => ({ ...cell }));
    moved.getBaseCell = () => ({
        x: Math.max(...cells.map((cell) => cell.x)),
        y: Math.max(...cells.map((cell) => cell.y)),
    });
    const projected = new Map(all);
    projected.set(actorId, moved);
    const holder = Object.create(context.unitsHolder) as UnitsHolder;
    holder.getAllUnits = () => projected;
    // One detached board per decision. Canonical occupancy restores lava/water under every vacated cell.
    const grid = deepClone(context.grid);
    const allies = [...projected.values()].filter((ally) => !ally.isDead() && ally.getTeam() === unit.getTeam());
    const shooters = [...projected.values()].filter(
        (enemy) =>
            !enemy.isDead() &&
            enemy.getTeam() !== unit.getTeam() &&
            enemy.hasAbilityActive("Chakram") &&
            enemy.isRangeCapable() &&
            enemy.getRangeShots() > 0 &&
            enemy.getStackPower() > 1,
    );
    return (destination) => {
        const occupied =
            destination.length === 1
                ? grid.occupyCell(
                      destination[0],
                      actorId,
                      unit.getTeam(),
                      unit.getAttackRange(),
                      unit.canTraverseLava(),
                      unit.hasAbilityActive("Made of Water"),
                  )
                : grid.occupyCells(
                      [...destination],
                      actorId,
                      unit.getTeam(),
                      unit.getAttackRange(),
                      unit.canTraverseLava(),
                      unit.hasAbilityActive("Made of Water"),
                  );
        if (!occupied) {
            throw new Error("Chakram screen proposal must be an enumerated legal footprint");
        }
        cells = destination.map((cell) => ({ ...cell }));
        let maximum = 0;
        let total = 0;
        let flights = 0;
        for (const shooter of shooters) {
            for (const primary of allies) {
                if (primary.hasBuffActive("Hidden") || primary.hasAbilityActive("Hidden")) continue;
                const trajectory = resolveChakramTrajectory(shooter, primary, holder, grid);
                const value = trajectory.hitUnits.reduce(
                    (sum, victim) =>
                        sum +
                        Math.max(1, victim.getExp() * victim.getAmountAlive()) *
                            trajectory.damageFactorByUnitId[victim.getId()],
                    0,
                );
                maximum = Math.max(maximum, value);
                total += value;
                flights += 1;
            }
        }
        return { maximum, total, flights };
    };
}

const pureMove = (actions: readonly GameAction[]): Extract<GameAction, { type: "move_unit" }> | undefined =>
    actions.length === 1 && actions[0].type === "move_unit" ? actions[0] : undefined;

/** Add one distinct safer movement choice; never replace the incumbent or the ordinary retained moves. */
export function selectChakramScreenMove(
    unit: Unit,
    context: Context,
    moves: readonly IEnumeratedCandidate[],
    retained: readonly IEnumeratedCandidate[],
    incumbent: readonly GameAction[],
    reportFlights?: (count: number) => void,
):
    | { candidate: IEnumeratedCandidate; baseline: IChakramExposure; selected: IChakramExposure; flights: number }
    | undefined {
    if (context.decisionOrigin !== "root" || !moves.length || !retained.length) return undefined;
    if (
        ![...context.unitsHolder.getAllUnits().values()].some(
            (enemy) =>
                !enemy.isDead() &&
                enemy.getTeam() !== unit.getTeam() &&
                enemy.hasAbilityActive("Chakram") &&
                enemy.isRangeCapable() &&
                enemy.getRangeShots() > 0 &&
                enemy.getStackPower() > 1,
        )
    )
        return undefined;
    const cache = new Map<string, IChakramExposure>();
    const evaluate = exposureEvaluator(unit, context);
    let flights = 0;
    const score = (action: Extract<GameAction, { type: "move_unit" }>) => {
        const targetCells =
            action.targetCells ?? unit.getFootprintCellsForAnchor(action.path.at(-1) ?? unit.getBaseCell());
        const key = targetCells
            .map((cell) => `${cell.x},${cell.y}`)
            .sort()
            .join(";");
        let value = cache.get(key);
        if (!value) {
            value = evaluate(targetCells);
            flights += value.flights;
            reportFlights?.(value.flights);
            cache.set(key, value);
        }
        return value;
    };
    const ordinary = retained.map((candidate) => pureMove(candidate.actions)).filter((action) => action !== undefined);
    const nativeMove = pureMove(incumbent);
    if (nativeMove) ordinary.push(nativeMove);
    if (!ordinary.length) return undefined;
    const baseline = ordinary.map(score).sort((a, b) => a.maximum - b.maximum || a.total - b.total)[0];
    if (baseline.maximum <= 0) return undefined;
    let selected: IEnumeratedCandidate | undefined;
    let exposure: IChakramExposure | undefined;
    for (const candidate of moves) {
        const action = pureMove(candidate.actions);
        if (!action || retained.includes(candidate)) continue;
        const value = score(action);
        if (value.maximum >= baseline.maximum) continue;
        if (
            !exposure ||
            value.maximum < exposure.maximum ||
            (value.maximum === exposure.maximum && value.total < exposure.total)
        ) {
            selected = candidate;
            exposure = value;
        }
    }
    return selected && exposure ? { candidate: selected, baseline, selected: exposure, flights } : undefined;
}

/** One full-horizon reservation within K, keeping the leading ordinary challenger and the incumbent. */
export function reserveChakramScreenMove(
    candidate: IEnumeratedCandidate | undefined,
    challengers: readonly IEnumeratedCandidate[],
    cap: number,
): readonly IEnumeratedCandidate[] {
    if (!candidate || challengers.includes(candidate) || cap < 2) return challengers;
    return [...challengers.slice(0, cap - 1), candidate];
}
