import { PBTypes } from "../../generated/protobuf/v1/types";
import { CreatureLevelMap } from "../../units/unit_properties";

/** Complete rosters only. Hidden setup and opponent doctrine are deliberately absent. */
export interface IDraftMatchupInput {
    ownCreatureIds: readonly number[];
    opponentCreatureIds: readonly number[];
    ownDoctrine: number;
    map: number;
}

export interface IDraftMatchupModel {
    schema: "draft-matchup-value-v1";
    recipe: "unit-only" | "interactions";
    sourceSha256: string;
    snapshotSha256: string;
    trainingFamilies: number;
    weights: Record<string, number>;
}

const maps: readonly number[] = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
];

/** Fixed sparse basis shared by offline fitting and pure inference. No outcome or audit identifiers. */
export function draftMatchupFeatures(input: IDraftMatchupInput, interactions: boolean): Record<string, number> {
    const roster = (values: readonly number[]) => {
        if (
            values.length < 1 ||
            values.length > 6 ||
            new Set(values).size !== values.length ||
            values.some((id) => !Number.isInteger(id) || !CreatureLevelMap[id])
        )
            throw new Error("Invalid complete matchup roster");
        return [...values].sort((a, b) => a - b);
    };
    if (![1, 2, 3].includes(input.ownDoctrine) || !maps.includes(input.map))
        throw new Error("Invalid public matchup context");
    const own = roster(input.ownCreatureIds);
    const enemy = roster(input.opponentCreatureIds);
    const features: Record<string, number> = { [`doctrine:${input.ownDoctrine}`]: 1 };
    const add = (key: string, value: number) => {
        features[key] = (features[key] ?? 0) + value;
    };
    for (const [army, sign] of [
        [own, 1],
        [enemy, -1],
    ] as const) {
        for (const id of army) {
            add(`unit:${id}`, sign);
            add(`map:${input.map}:unit:${id}`, sign);
            add(`doctrine:${input.ownDoctrine}:unit:${id}`, sign);
        }
        if (interactions)
            for (let i = 0; i < army.length; i++)
                for (let j = i + 1; j < army.length; j++) add(`ally:${army[i]}:${army[j]}`, sign);
    }
    if (interactions)
        for (const a of own)
            for (const b of enemy) {
                if (a !== b) add(`counter:${Math.min(a, b)}:${Math.max(a, b)}`, a < b ? 1 : -1);
            }
    return Object.fromEntries(
        Object.entries(features)
            .filter(([, value]) => value !== 0)
            .sort(([a], [b]) => a.localeCompare(b)),
    );
}

/** Compile once; no SQLite, filesystem, randomness, or mutation in decision inference. Inactive by default. */
export function createDraftMatchupValue(model: IDraftMatchupModel) {
    if (
        model.schema !== "draft-matchup-value-v1" ||
        !["unit-only", "interactions"].includes(model.recipe) ||
        !/^[a-f0-9]{64}$/.test(model.sourceSha256) ||
        !/^[a-f0-9]{64}$/.test(model.snapshotSha256) ||
        !Number.isSafeInteger(model.trainingFamilies) ||
        model.trainingFamilies < 1 ||
        !model.weights ||
        Object.values(model.weights).some((value) => !Number.isFinite(value))
    )
        throw new Error("Invalid matchup model");
    const weights = { ...model.weights };
    const interactions = model.recipe === "interactions";
    return (input: IDraftMatchupInput): number | null => {
        try {
            const features = draftMatchupFeatures(input, interactions);
            const value =
                0.5 + Object.entries(features).reduce((sum, [key, amount]) => sum + (weights[key] ?? 0) * amount, 0);
            return Math.min(1, Math.max(0, value));
        } catch {
            return null;
        }
    };
}
