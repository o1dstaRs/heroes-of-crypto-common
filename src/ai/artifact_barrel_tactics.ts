import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Grid } from "../grid/grid";
import { getCellForPosition, getPositionForCell } from "../grid/grid_math";
import { AttackHandler } from "../handlers/attack_handler";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { findBestLegalStationaryRangeAttack } from "./candidates";

/**
 * Counterfactual best-shot damage with one deployment barrel absent. Uses the normal legal aim/side
 * enumerator, including retargeting, falloff, smoke, splash, pins, ammunition and forced targets.
 * A read-only grid view changes occupancy only: no authoritative terrain, RNG or unit state is mutated.
 * This is a one-position diagnostic, not a value function for movement or future turns.
 */
export function projectBarrelShotTradeoff(context: IDecisionContext, cell: XY) {
    const handler = context.attackHandler;
    if (
        !handler ||
        !context.grid.getArtifactBarrels().some((barrel) => barrel.cell.x === cell.x && barrel.cell.y === cell.y)
    )
        return undefined;
    const grid = new Proxy(context.grid, {
        get(target, key, receiver) {
            if (key === "getOccupantUnitId")
                return (point: XY) => (point.x === cell.x && point.y === cell.y ? "" : target.getOccupantUnitId(point));
            return Reflect.get(target, key, receiver);
        },
        set() {
            throw new Error("Barrel projection must not mutate the grid");
        },
    });
    const matrix = context.matrix.map((row) => [...row]);
    matrix[cell.y][cell.x] = 0;
    const projected: IDecisionContext = {
        ...context,
        grid,
        matrix,
        attackHandler: new AttackHandler(handler.gridSettings, grid, handler.sceneLog, handler.damageStatisticHolder),
    };
    return [...context.unitsHolder.getAllUnits().values()]
        .filter((unit) => !unit.isDead())
        .map((unit) => {
            const before = findBestLegalStationaryRangeAttack(unit, context)?.expectedDamage ?? 0;
            const after = findBestLegalStationaryRangeAttack(unit, projected)?.expectedDamage ?? 0;
            return { unitId: unit.getId(), team: unit.getTeam(), before, after, gain: after - before };
        });
}

/** First barrel intercepting an available friendly shot, using the combat engine's actual ray. */
export function friendlyShotBlockingBarrels(
    team: TeamType,
    grid: Grid,
    unitsHolder: UnitsHolder,
    attackHandler: AttackHandler,
): ReadonlySet<string> {
    const barrels = new Set(grid.getArtifactBarrels().map(({ cell }) => `${cell.x},${cell.y}`));
    const blocked = new Set<string>();
    if (barrels.size === 0) return blocked;
    const settings = grid.getSettings();
    const enemies = unitsHolder
        .getAllEnemyUnits(team)
        .filter((enemy) => !enemy.isDead() && !enemy.hasBuffActive("Hidden"));
    for (const shooter of unitsHolder.getAllAllies(team)) {
        if (
            shooter.isDead() ||
            !attackHandler.canLandRangeAttack(shooter, grid.getEnemyAggrMatrixByUnitId(shooter.getId()))
        )
            continue;
        const forcedTarget = unitsHolder.getAllUnits().get(shooter.getTarget());
        for (const enemy of enemies) {
            if (forcedTarget && !forcedTarget.isDead() && forcedTarget.getId() !== enemy.getId()) continue;
            for (const cell of enemy.getCells()) {
                const aim = getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep());
                const projection = attackHandler.evaluateRangeAttack(
                    unitsHolder.getAllUnits(),
                    shooter,
                    shooter.getPosition(),
                    aim,
                    shooter.hasAbilityActive("Through Shot"),
                    false,
                    shooter.hasAbilityActive("Area Throw"),
                );
                if (!projection.attackObstacle) continue;
                const hit = getCellForPosition(settings, projection.attackObstacle.position);
                const key = `${hit.x},${hit.y}`;
                if (barrels.has(key)) blocked.add(key);
            }
        }
    }
    return blocked;
}
