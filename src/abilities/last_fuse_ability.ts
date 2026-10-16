import { ARTIFACT_POWER } from "../artifacts/artifact_properties";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

export const LAST_FUSE_BUFF = "Last Fuse";

export interface IPyreHit {
    unitId: string;
    position: XY;
    amount: number;
    unitsDied: number;
}

export interface IPyreExplosion {
    unitId: string;
    position: XY;
    hits: IPyreHit[];
    unitIdsDied: string[];
}

export function lastFuseDamage(
    damageDealt: number,
    stackPower: number,
    percent: number = ARTIFACT_POWER.LAST_FUSE_PERCENT,
): number {
    return Math.max(
        Math.max(0, stackPower) * ARTIFACT_POWER.LAST_FUSE_MIN_DAMAGE_PER_POWER,
        Math.round((Math.max(0, damageDealt) * percent) / 100),
    );
}

// Call only after the stack was actually removed. A resurrection keeps the body and must not burst.
export function explodeLastFuse(unit: Unit, unitsHolder: UnitsHolder, sceneLog: ISceneLog): IPyreExplosion | undefined {
    if (!unit.isDead() || !unit.hasBuffActive(LAST_FUSE_BUFF)) {
        return undefined;
    }
    const damage = unit.getLastFuseDamage();
    if (damage <= 0) {
        return undefined;
    }

    const hits: IPyreHit[] = [];
    const unitIdsDied: string[] = [];
    sceneLog.updateLog(`${unit.getName()} explodes`);
    for (const enemy of unitsHolder.allEnemiesAroundUnit(unit, false)) {
        if (enemy.isDead()) {
            continue;
        }
        const aliveBefore = enemy.getAmountAlive();
        const position = { ...enemy.getPosition() };
        const dealt = enemy.applyDamage(damage, 0, sceneLog, false);
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
