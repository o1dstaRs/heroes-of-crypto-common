import { CreatureLevels } from "../../generated/protobuf/v1/creature_gen";
import { creatureInfo } from "./creature_score";
import { conditionalAugments } from "./setup_conditional";
import type { ISetupAugmentChoice } from "./setup_ship";

export const EMPOWER_SETUP_SCHEMA = "own-roster-empower-v1";
const MAGIC_IDS = [8, 9, 19, 49, 55, 56, 57] as const;
// Fire Wall stores the caster's magic bonus but uses NO_MULTIPLIER in the spell catalog.
const hasEmpowerDamage = (info: NonNullable<ReturnType<typeof creatureInfo>>) =>
    info.dealsMagicDamage || info.name === "Nightmare";
const BASE_FEATURES = [
    "ranged",
    "damageSpells",
    "magicAbilities",
    "amplifiers",
    "healers",
    "flying",
    ...MAGIC_IDS.map((id) => `creature:${id}`),
] as const;
export const EMPOWER_SETUP_FEATURES = [
    ...BASE_FEATURES,
    ...[5, 6, 7].flatMap((budget) => [`budget:${budget}`, ...BASE_FEATURES.map((name) => `budget:${budget}:${name}`)]),
];
export interface IEmpowerSetupModel {
    schema: typeof EMPOWER_SETUP_SCHEMA;
    features: readonly string[];
    heads: readonly { b: number; w: readonly number[] }[];
    margin: number;
}

/** Only information owned by the player is accepted; no opponent, map, outcome, or hidden draft state. */
export function empowerSetupFeatures(budget: number, own: readonly number[]): number[] | undefined {
    if (![5, 6, 7].includes(budget) || own.length !== 6 || new Set(own).size !== 6) return undefined;
    const infos = own.map(creatureInfo);
    if (
        infos.some((info) => !info) ||
        own
            .map((id) => CreatureLevels[id])
            .sort()
            .join(",") !== "1,1,2,2,3,4"
    )
        return undefined;
    const units = infos.filter((info) => info !== undefined);
    if (!units.some(hasEmpowerDamage)) return undefined;
    const base = [
        units.filter((info) => info.ranged).length / 6,
        units.filter((info) => info.rangedSpellDamage).length / 3,
        units.filter((info) => hasEmpowerDamage(info) && !info.rangedSpellDamage).length / 3,
        units.filter((info) => info.magicDamageAmplifier).length / 3,
        units.filter((info) => info.name === "Healer" || info.name === "Angel").length / 2,
        units.filter((info) => info.canFly).length / 6,
        ...MAGIC_IDS.map((id) => Number(own.includes(id))),
    ];
    return [
        ...base,
        ...[5, 6, 7].flatMap((value) => [Number(value === budget), ...base.map((x) => (value === budget ? x : 0))]),
    ];
}

/** Fully funded alternatives retain defensive spending until both physical damage axes are exhausted. */
export function empowerSetupPlan(budget: number, own: readonly number[], level: number): ISetupAugmentChoice[] {
    if (![5, 6, 7].includes(budget) || !Number.isInteger(level) || level < 0 || level > 3)
        throw new RangeError("Invalid Empower setup budget or level");
    const baseline: ISetupAugmentChoice[] = conditionalAugments(budget, own, new Set(["sniper"]));
    if (!level) return baseline;
    if (!empowerSetupFeatures(budget, own)) throw new RangeError("Empower needs a legal roster with magic damage");
    const levels = new Map(baseline.map((entry) => [entry.kind, entry.value]));
    const ranged = own.filter((id) => creatureInfo(id)?.ranged).length;
    const funding: ISetupAugmentChoice["kind"][] =
        ranged >= 2 ? ["Might", "Sniper", "Armor"] : ["Sniper", "Might", "Armor"];
    let remaining = level;
    for (const kind of funding) {
        const amount = Math.min(remaining, levels.get(kind) ?? 0);
        levels.set(kind, (levels.get(kind) ?? 0) - amount);
        remaining -= amount;
    }
    if (remaining) throw new Error("Unfunded Empower setup");
    return [
        ...baseline
            .map((entry) => ({ kind: entry.kind, value: levels.get(entry.kind)! }))
            .filter((entry) => entry.value > 0),
        { kind: "Empower", value: level },
    ];
}

export function validateEmpowerSetupModel(model: IEmpowerSetupModel): void {
    if (
        model.schema !== EMPOWER_SETUP_SCHEMA ||
        JSON.stringify(model.features) !== JSON.stringify(EMPOWER_SETUP_FEATURES) ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1 ||
        model.heads.length !== 3 ||
        model.heads.some(
            (head) =>
                !Number.isFinite(head.b) ||
                head.w.length !== EMPOWER_SETUP_FEATURES.length ||
                head.w.some((x) => !Number.isFinite(x)),
        )
    )
        throw new Error("Invalid Empower setup model");
}

export function selectEmpowerSetup(model: IEmpowerSetupModel, budget: number, own: readonly number[]): number {
    validateEmpowerSetupModel(model);
    const features = empowerSetupFeatures(budget, own);
    if (!features) return 0;
    let selected = 0,
        best = model.margin;
    for (let index = 0; index < model.heads.length; index++) {
        const head = model.heads[index];
        const gain = head.b + head.w.reduce((sum, weight, feature) => sum + weight * features[feature], 0);
        if (gain > best) {
            best = gain;
            selected = index + 1;
        }
    }
    return selected;
}
