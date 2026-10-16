import type { ICreatureInfo } from "./creature_score";

/** Public identities only. Unrevealed slots retain the same neutral contact forecast as v2-v4. */
export const lastFuseIncomingMeleeShare = (enemy: readonly ICreatureInfo[]): number => {
    const slots = Math.max(5, enemy.length);
    // A melee caster with offensive ranged spells can keep casting instead of approaching the battery.
    const pressure = enemy.reduce((sum, unit) => sum + (unit.melee ? (unit.rangedSpellDamage ? 0.5 : 1) : 0), 0);
    return (pressure + 0.5 * Math.max(0, slots - enemy.length)) / slots;
};

/**
 * A shooter can explode on the melee stack that reaches it, too. Its own attack type does not disable
 * Last Fuse. A frontline body can also seek contact against a ranged opponent. Neither forecast promises
 * a death, an enemy deployment or a full cluster. Resurrection delays the burst; it is not a permanent ban.
 */
export function lastFuseDraftContact(unit: ICreatureInfo, incomingMeleeShare: number): number {
    const contact = unit.melee ? 0.5 + 0.5 * incomingMeleeShare : incomingMeleeShare;
    // The whole rectangular footprint has a ring: 8 cells for 1x1, 10 for 1x2/2x1, 12 for 2x2.
    const ring = (2 * unit.footprintWidth + 2 * unit.footprintHeight + 4) / 8;
    return contact * ring * (unit.abilities.includes("Resurrection") ? 0.5 : 1);
}
