import type { ISceneLog } from "../scene/scene_log_interface";
import { SpellElement } from "../spells/spell_properties";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";

export const EMBER_COVENANT_BLESSING = "Ember Covenant Blessing";

const armies = new WeakMap<Unit, UnitsHolder>();

export function isEmberCovenantWaterHit(attacker?: Unit, damageElement?: SpellElement): boolean {
    if (damageElement !== undefined) return damageElement === SpellElement.WATER;
    return !!attacker?.hasAbilityActive("Water Element");
}

export function isEmberCovenantFireHit(damageElement?: SpellElement): boolean {
    return damageElement === SpellElement.FIRE;
}

export function registerEmberCovenantArmy(unit: Unit, army: UnitsHolder): void {
    armies.set(unit, army);
}

export function notifyEmberCovenantDamage(unit: Unit, sceneLog: ISceneLog): void {
    const army = armies.get(unit);
    if (army) {
        if (army.hasEmberCovenant(unit.getTeam())) army.breakEmberCovenant(unit.getTeam(), unit, sceneLog);
    } else unit.deleteBuff(EMBER_COVENANT_BLESSING);
}
