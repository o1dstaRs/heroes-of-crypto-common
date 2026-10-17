import { ARTIFACT_POWER } from "../artifacts/artifact_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

export const LAST_FUSE_BUFF = "Last Fuse";

export interface ILastFuseSource {
    unitId: string;
    team: TeamType;
    percent: number;
    stackPower: number;
}

export function lastFuseSourceFor(unit: Unit | undefined): ILastFuseSource | undefined {
    if (!unit?.hasBuffActive(LAST_FUSE_BUFF)) return undefined;
    return {
        unitId: unit.getId(),
        team: unit.getTeam(),
        percent: unit.getBuffPower(LAST_FUSE_BUFF) ?? ARTIFACT_POWER.LAST_FUSE_PERCENT,
        stackPower: unit.getStackPower(),
    };
}

export interface IPyreHit {
    unitId: string;
    position: XY;
    amount: number;
    unitsDied: number;
}

export interface IPyreExplosion {
    unitId: string;
    sourceUnitId: string;
    position: XY;
    hits: IPyreHit[];
    unitIdsDied: string[];
}

export function lastFuseDamage(
    damageDealt: number,
    attackerStackPower: number,
    percent: number = ARTIFACT_POWER.LAST_FUSE_PERCENT,
): number {
    return Math.max(
        Math.max(0, attackerStackPower) * ARTIFACT_POWER.LAST_FUSE_MIN_DAMAGE_PER_POWER,
        Math.round((Math.max(0, damageDealt) * percent) / 100),
    );
}

export function explodeLastFuse(unit: Unit, unitsHolder: UnitsHolder, sceneLog: ISceneLog): IPyreExplosion | undefined {
    const source = unit.getLastFuseKillSource();
    if (!unit.isDead() || !source || unit.getTeam() === source.team) {
        return undefined;
    }
    const damage = unit.getLastFuseDamage();
    if (damage <= 0) {
        return undefined;
    }

    const hits: IPyreHit[] = [];
    const unitIdsDied: string[] = [];
    const blastCells = new Set(unitsHolder.cellsAroundUnit(unit, false).map(({ x, y }) => `${x}:${y}`));
    sceneLog.updateLog(`${unit.getName()} explodes`);
    for (const enemy of unitsHolder.getAllEnemyUnits(source.team)) {
        if (enemy.isDead() || !enemy.getCells().some(({ x, y }) => blastCells.has(`${x}:${y}`))) {
            continue;
        }
        const aliveBefore = enemy.getAmountAlive();
        const position = { ...enemy.getPosition() };
        const dealt = enemy.applyDamage(damage, 0, sceneLog, false, undefined, source);
        if (dealt <= 0) {
            continue;
        }
        const unitsDied = Math.max(0, aliveBefore - enemy.getAmountAlive());
        hits.push({ unitId: enemy.getId(), position, amount: dealt, unitsDied });
        sceneLog.updateLog(`${enemy.getName()} takes ${dealt} damage from the explosion`);
        if (enemy.isDead()) {
            unitIdsDied.push(enemy.getId());
        }
    }

    return {
        unitId: unit.getId(),
        sourceUnitId: source.unitId,
        position: { ...unit.getPosition() },
        hits,
        unitIdsDied,
    };
}

// Chain victims are removed here and not appended to the strike's died list. A melee cleave must not
// claim a stack the blast killed. A resurrection keeps the body and does not burst.
export function detonateLastFuseChain(
    unitIdsDied: readonly string[],
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    emitDestroyed: (unitId: string) => void,
    emitExplosion: (explosion: IPyreExplosion) => void,
    emitResurrected: (unit: Unit) => void,
): void {
    for (const unitId of unitIdsDied) {
        const victim = unitsHolder.getAllUnits().get(unitId);
        if (!victim?.isDead()) {
            continue;
        }
        if (!unitsHolder.deleteUnitById(unitId, true)) {
            if (!victim.isDead()) {
                emitResurrected(victim);
            }
            continue;
        }
        emitDestroyed(unitId);
        const explosion = explodeLastFuse(victim, unitsHolder, sceneLog);
        if (!explosion) {
            continue;
        }
        emitExplosion(explosion);
        detonateLastFuseChain(
            explosion.unitIdsDied,
            unitsHolder,
            sceneLog,
            emitDestroyed,
            emitExplosion,
            emitResurrected,
        );
    }
}
