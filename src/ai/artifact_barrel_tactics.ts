import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Grid } from "../grid/grid";
import { getCellForPosition, getPositionForCell } from "../grid/grid_math";
import type { AttackHandler } from "../handlers/attack_handler";
import type { UnitsHolder } from "../units/units_holder";

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
