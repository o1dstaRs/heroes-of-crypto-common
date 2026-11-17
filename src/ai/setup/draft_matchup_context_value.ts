import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../../artifacts/artifact_properties";
import { creatureInfo } from "./creature_score";
import { DRAFT_BATTLEFIELD_FACTIONS, draftSynergyEffects } from "./draft_battlefield_context";
import { draftMatchupFeatures, type IDraftMatchupInput } from "./draft_matchup_value";
import {
    createHistoricalFinalPickAdvisor,
    HISTORICAL_FINAL_PICK_MARGIN,
    type IHistoricalFinalPickView,
} from "./draft_matchup_pick";
import type { RankedDraftSynergyVariants } from "./draft_synergy_variants";

export interface IDraftMatchupContextInput extends IDraftMatchupInput {
    ownArtifactT1: number;
    ownArtifactT2: number;
    synergyVariants: RankedDraftSynergyVariants;
}

export interface IDraftMatchupContextModel {
    schema: "draft-matchup-context-value-v1";
    recipe: "public-artifact-synergy-v1";
    sourceSha256: string;
    snapshotSha256: string;
    trainingFamilies: number;
    weights: Record<string, number>;
}

/** Public own items and rolled variants, never realized enemy purchases or post-Setup synergy levels. */
export function draftMatchupContextFeatures(input: IDraftMatchupContextInput): Record<string, number> {
    const features = draftMatchupFeatures(input, true);
    if (
        !TIER1_ARTIFACT_LIST.some((a) => a.id === input.ownArtifactT1) ||
        !TIER2_ARTIFACT_LIST.some((a) => a.id === input.ownArtifactT2) ||
        !DRAFT_BATTLEFIELD_FACTIONS.every((f) => [1, 2].includes(input.synergyVariants?.[f]))
    )
        throw new Error("Incomplete public artifact/synergy context");
    const add = (key: string, value: number) => {
        features[key] = (features[key] ?? 0) + value;
    };
    for (const [tier, artifact] of [
        [1, input.ownArtifactT1],
        [2, input.ownArtifactT2],
    ]) {
        add(`ownArtifact:${tier}:${artifact}`, 1);
        for (const id of input.ownCreatureIds) add(`ownArtifact:${tier}:${artifact}:unit:${id}`, 1);
    }
    for (const faction of DRAFT_BATTLEFIELD_FACTIONS) {
        const prefix = `variant:${faction}:${input.synergyVariants[faction]}`;
        for (const [ids, sign] of [
            [input.ownCreatureIds, 1],
            [input.opponentCreatureIds, -1],
        ] as const)
            for (const id of ids) add(`${prefix}:unit:${id}`, sign);
    }
    const own = draftSynergyEffects(input.ownCreatureIds, input.synergyVariants);
    const enemy = draftSynergyEffects(input.opponentCreatureIds, input.synergyVariants);
    const roles = (ids: readonly number[]) => {
        const units = ids.map((id) => creatureInfo(id)!);
        return {
            ranged: units.filter((u) => u.ranged).length / 6,
            melee: units.filter((u) => u.melee).length / 6,
            caster: units.filter((u) => u.caster).length / 6,
            flyer: units.filter((u) => u.canFly).length / 6,
            spellbook: units.filter((u) => u.nativeSpellbook).length / 6,
            auras: units.reduce((sum, u) => sum + u.auraCount, 0) / 12,
            abilities: units.reduce((sum, u) => sum + u.abilityCount, 0) / 24,
        };
    };
    const ownRoles = roles(input.ownCreatureIds),
        enemyRoles = roles(input.opponentCreatureIds);
    for (const [side, effects, r, opposite] of [
        ["own", own, ownRoles, enemyRoles],
        ["enemy", enemy, enemyRoles, ownRoles],
    ] as const) {
        DRAFT_BATTLEFIELD_FACTIONS.forEach((f, i) => {
            for (const threshold of [1, 2, 3])
                add(
                    `${side}:threshold:${f}:${input.synergyVariants[f]}:${threshold}`,
                    Number(effects.levels[i] >= threshold),
                );
        });
        add(`${side}:movementMelee`, (effects.movement * r.melee) / 3);
        add(`${side}:movementAgainstRange`, (effects.movement * opposite.ranged) / 3);
        add(`${side}:movementAgainstCaster`, (effects.movement * opposite.caster) / 3);
        add(`${side}:boardSpellbooks`, (effects.boardUnits * r.spellbook) / 4);
        add(`${side}:boardAuras`, (effects.boardUnits * r.auras) / 4);
        add(`${side}:flyArmor`, (effects.flyArmor * r.flyer) / 35);
        add(`${side}:auraRange`, (effects.auraRange * r.auras) / 3);
        add(`${side}:abilityPower`, (effects.abilityPower * r.abilities) / 12);
        for (const [field, scale] of [
            ["supply", 19],
            ["morale", 20],
            ["luck", 9],
            ["breakChance", 17],
        ] as const)
            add(`${side}:${field}`, effects[field] / scale);
    }
    return Object.fromEntries(
        Object.entries(features)
            .filter(([, v]) => v !== 0)
            .sort(([a], [b]) => a.localeCompare(b)),
    );
}

export function createDraftMatchupContextValue(model: IDraftMatchupContextModel) {
    if (
        model.schema !== "draft-matchup-context-value-v1" ||
        model.recipe !== "public-artifact-synergy-v1" ||
        !/^[a-f0-9]{64}$/.test(model.sourceSha256) ||
        !/^[a-f0-9]{64}$/.test(model.snapshotSha256) ||
        !Number.isSafeInteger(model.trainingFamilies) ||
        model.trainingFamilies < 1 ||
        !model.weights ||
        Object.values(model.weights).some((w) => !Number.isFinite(w))
    )
        throw new Error("Invalid contextual matchup model");
    const weights = { ...model.weights };
    return (input: IDraftMatchupContextInput): number | null => {
        try {
            const value =
                0.5 +
                Object.entries(draftMatchupContextFeatures(input)).reduce(
                    (sum, [k, v]) => sum + v * (weights[k] ?? 0),
                    0,
                );
            return Math.min(1, Math.max(0, value));
        } catch {
            return null;
        }
    };
}

/** Same narrow, opt-in final-pick boundary as v1, now with genuinely public own context. */
export function createContextualHistoricalFinalPickAdvisor(model: IDraftMatchupContextModel) {
    const validate = createHistoricalFinalPickAdvisor({
        ...model,
        schema: "draft-matchup-value-v1",
        recipe: "interactions",
        weights: {},
    });
    const predict = createDraftMatchupContextValue(model);
    return (
        view: IHistoricalFinalPickView & { synergyVariants: RankedDraftSynergyVariants },
        ownTeam: number,
        incumbent: number,
    ) => {
        const legal = validate(view, ownTeam, incumbent);
        if (!legal) return null;
        try {
            const choices = legal.choices.map(({ creatureId }) => ({
                creatureId,
                value: predict({
                    ownCreatureIds: [...view.creaturesPicked, creatureId],
                    opponentCreatureIds: view.knownOpponentCreatures,
                    ownDoctrine: view.doctrine,
                    map: view.revealedMap!,
                    ownArtifactT1: view.artifacts.find(([tier]) => tier === 1)?.[1] ?? 0,
                    ownArtifactT2: view.artifacts.find(([tier]) => tier === 2)?.[1] ?? 0,
                    synergyVariants: view.synergyVariants,
                }),
            }));
            if (choices.some((c) => c.value === null)) return null;
            const incumbentValue = choices.find((c) => c.creatureId === incumbent)!.value!;
            let selectedCreatureId = incumbent,
                selectedValue = incumbentValue;
            for (const c of choices)
                if (c.value! > selectedValue) {
                    selectedCreatureId = c.creatureId;
                    selectedValue = c.value!;
                }
            if (selectedValue - incumbentValue < HISTORICAL_FINAL_PICK_MARGIN) {
                selectedCreatureId = incumbent;
                selectedValue = incumbentValue;
            }
            return {
                incumbent,
                selectedCreatureId,
                incumbentValue,
                selectedValue,
                predictedGain: selectedValue - incumbentValue,
                changed: selectedCreatureId !== incumbent,
                choices,
            };
        } catch {
            return null;
        }
    };
}
