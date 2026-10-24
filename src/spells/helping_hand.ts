import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";

const owners = new WeakMap<Unit, UnitsHolder>();
const reconciling = new WeakSet<UnitsHolder>();

export function registerHelpingHandOwner(unit: Unit, holder: UnitsHolder): void {
    owners.set(unit, holder);
}

export function notifyHelpingHandChange(unit: Unit): void {
    owners.get(unit)?.refreshHelpingHandLinks();
}

function hasHelpingHand(unit: Unit, buff: boolean): boolean {
    const applied = buff ? unit.getBuff("Helping Hand") : unit.getDebuff("Helping Hand");
    if (applied) return applied.getLaps() > 0;
    const properties = unit.getUnitProperties();
    const names = buff ? properties.applied_buffs : properties.applied_debuffs;
    const laps = buff ? properties.applied_buffs_laps : properties.applied_debuffs_laps;
    return names.some((name, index) => name === "Helping Hand" && laps[index] > 0);
}

export function reconcileHelpingHandLinks(holder: UnitsHolder, removedUnitId?: string): Unit[] {
    if (reconciling.has(holder)) return [];
    reconciling.add(holder);
    try {
        const ended: Unit[] = [];
        const affected = new Set<Unit>();
        const retainedPenalties = new Set<string>();
        const releasedPenalties = new Set<string>();
        for (const target of holder.getAllUnitsIterator()) {
            const properties = target.getUnitProperties();
            const casterId = properties.helping_hand_caster_id;
            if (!casterId) continue;
            const penaltyId = properties.helping_hand_penalty_id;
            const caster = holder.getAllUnits().get(casterId);
            const penalty = penaltyId ? holder.getAllUnits().get(penaltyId) : undefined;
            if (
                target.isDead() ||
                !caster ||
                caster.isDead() ||
                !penalty ||
                penalty.isDead() ||
                (removedUnitId !== undefined &&
                    (removedUnitId === target.getId() || removedUnitId === casterId || removedUnitId === penaltyId)) ||
                !hasHelpingHand(target, true) ||
                !hasHelpingHand(penalty, false)
            ) {
                ended.push(target);
                if (penaltyId) releasedPenalties.add(penaltyId);
            } else if (penaltyId) {
                retainedPenalties.add(penaltyId);
            }
        }
        for (const target of ended) {
            target.clearHelpingHandLink();
            target.deleteBuff("Helping Hand");
            affected.add(target);
        }
        for (const penaltyId of releasedPenalties) {
            if (retainedPenalties.has(penaltyId)) continue;
            const penalty = holder.getAllUnits().get(penaltyId);
            if (!penalty) continue;
            penalty.deleteDebuff("Helping Hand");
            affected.add(penalty);
        }
        return [...affected];
    } finally {
        reconciling.delete(holder);
    }
}
