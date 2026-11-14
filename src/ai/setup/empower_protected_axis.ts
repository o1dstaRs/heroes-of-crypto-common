import { creatureInfo } from "./creature_score";
import { empowerSetupFeatures, empowerSetupPlan } from "./empower_setup";
import type { ISetupAugmentChoice } from "./setup_ship";

/** Separate research candidate: buy one Empower point without reducing the preferred physical damage axis. */
export function protectedAxisEmpowerPlan(budget: number, own: readonly number[], level: number): ISetupAugmentChoice[] {
    if (level !== 0 && level !== 1) throw new RangeError("Protected-axis Empower only offers levels zero and one");
    const baseline = empowerSetupPlan(budget, own, 0);
    if (!level) return baseline;
    if (!empowerSetupFeatures(budget, own)) throw new RangeError("Empower needs a legal roster with magic damage");
    const spare = own.filter((id) => creatureInfo(id)?.ranged).length >= 2 ? "Might" : "Sniper";
    const donor = baseline.find((entry) => entry.kind === spare && entry.value > 0)?.kind ?? "Armor";
    if (!baseline.some((entry) => entry.kind === donor && entry.value > 0))
        throw new Error("No protected-axis Empower funding");
    return [
        ...baseline
            .map((entry) => ({ ...entry, value: entry.value - Number(entry.kind === donor) }))
            .filter((entry) => entry.value > 0),
        { kind: "Empower", value: 1 },
    ];
}
