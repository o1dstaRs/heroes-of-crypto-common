import { ARTIFACT_POWER } from "../artifacts/artifact_properties";
import { getSpellConfig } from "../configuration/config_provider";
import { getAuraCells } from "../effects/effect_helper";
import type { Grid } from "../grid/grid";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Spell } from "../spells/spell";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import { getLapString, getRandomInt } from "../utils/lib";

/** Touching footprints, including diagonals, form links. Roll outcomes never change the graph. */
export function getGravechainTargets(target: Unit, grid: Grid, unitsHolder: UnitsHolder): Unit[] {
    const targets = [target];
    const visited = new Set([target.getId()]);
    let layer = [target];
    for (let hop = 0; hop < ARTIFACT_POWER.GRAVECHAIN_CONNECTIONS && layer.length; hop++) {
        const nextLayer: Unit[] = [];
        for (const source of layer) {
            for (const cell of source.getCells()) {
                for (const neighbor of getAuraCells(grid.getSettings(), cell, 1)) {
                    const id = grid.getOccupantUnitId(neighbor);
                    if (!id || visited.has(id)) continue;
                    const unit = unitsHolder.getAllUnits().get(id);
                    if (!unit || unit.getTeam() !== target.getTeam() || unit.isDead()) continue;
                    visited.add(id);
                    targets.push(unit);
                    nextLayer.push(unit);
                }
            }
        }
        layer = nextLayer;
    }
    return targets;
}

export function processGravechainAbility(
    attacker: Unit,
    target: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    currentActiveUnit: Unit = attacker,
    attemptedTargets = new Set<string>(),
): void {
    if (!attacker.hasBuffActive("Gravechain") || attacker.getTeam() === target.getTeam()) return;
    const chance = attacker.getGravechainChance();
    const laps = Number(attacker.getBuffProperties("Gravechain")[1]) || ARTIFACT_POWER.GRAVECHAIN_SLOW_LAPS;
    for (const enemy of getGravechainTargets(target, grid, unitsHolder)) {
        if (attemptedTargets.has(enemy.getId())) continue;
        attemptedTargets.add(enemy.getId());
        if (enemy.isDead() || enemy.getMagicResist() >= 100 || enemy.hasDebuffActive("Gravebound")) continue;
        if (getRandomInt(0, 100) >= chance) continue;
        enemy.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", laps), amount: 1 }),
            undefined,
            undefined,
            enemy.getId() === currentActiveUnit.getId(),
        );
        sceneLog.updateLog(`${attacker.getName()} bound ${enemy.getName()} with Gravechain for ${getLapString(laps)}`);
    }
}
