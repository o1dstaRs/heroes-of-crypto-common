import { ARTIFACT_POWER } from "../artifacts/artifact_properties";
import { getSpellConfig } from "../configuration/config_provider";
import { getAuraCells } from "../effects/effect_helper";
import type { Grid } from "../grid/grid";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { IGravechainWave, IVisibleDamage } from "../scene/animations";
import { Spell } from "../spells/spell";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import { getLapString, getRandomInt } from "../utils/lib";

/** Touching footprints, including diagonals, form links. Roll outcomes never change the graph. */
export function getGravechainTargets(target: Unit, grid: Grid, unitsHolder: UnitsHolder): Unit[] {
    return getGravechainLinks(target, grid, unitsHolder).map((link) => link.unit);
}

function getGravechainLinks(target: Unit, grid: Grid, unitsHolder: UnitsHolder) {
    const targets: { unit: Unit; fromUnitId?: string; depth: number }[] = [{ unit: target, depth: 0 }];
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
                    targets.push({ unit, fromUnitId: source.getId(), depth: hop + 1 });
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
    visibleDamage?: IVisibleDamage,
    hitIndex = 0,
): void {
    if (!attacker.hasBuffActive("Gravechain") || attacker.getTeam() === target.getTeam()) return;
    const chance = attacker.getGravechainChance();
    const laps = Number(attacker.getBuffProperties("Gravechain")[1]) || ARTIFACT_POWER.GRAVECHAIN_SLOW_LAPS;
    const links = getGravechainLinks(target, grid, unitsHolder);
    const appliedIds = new Set<string>();
    for (const { unit: enemy } of links) {
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
        appliedIds.add(enemy.getId());
        sceneLog.updateLog(`${attacker.getName()} bound ${enemy.getName()} with Gravechain for ${getLapString(laps)}`);
    }
    if (visibleDamage && appliedIds.size) {
        const wave: IGravechainWave = {
            sourceUnitId: attacker.getId(),
            rootUnitId: target.getId(),
            response: attacker.getId() !== currentActiveUnit.getId(),
            hitIndex,
            links: links.map(({ unit, fromUnitId, depth }) => ({
                unitId: unit.getId(),
                fromUnitId,
                position: { ...unit.getPosition() },
                depth,
                applied: appliedIds.has(unit.getId()),
            })),
        };
        (visibleDamage.gravechains ??= []).push(wave);
    }
}
