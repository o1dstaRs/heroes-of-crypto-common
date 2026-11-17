import { creatureInfo } from "../ai/setup/creature_score";
import { tier1ArtifactFitScoreV4, tier2ArtifactFitScoreV6 } from "../ai/setup/artifact_fit";
import { createDraftMatchupValue, type IDraftMatchupModel } from "../ai/setup/draft_matchup_value";
import { draftMatchupContextFeatures } from "../ai/setup/draft_matchup_context_value";
import { createHistoricalFinalPickAdvisor, type IHistoricalFinalPickView } from "../ai/setup/draft_matchup_pick";
import { DRAFT_BATTLEFIELD_FACTIONS } from "../ai/setup/draft_battlefield_context";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import { CreatureLevelList } from "../units/unit_properties";
import { makeRng } from "./army";

export const MATCHED_DRAFT_MODEL_SCHEMA = "premium-matched-final-pick-residual-v1";
export type MatchedDraftView = IHistoricalFinalPickView & { synergyVariants: RankedDraftSynergyVariants };
const ROLES = [
    "ranged",
    "melee",
    "caster",
    "flyer",
    "magicDamage",
    "magicAmplifier",
    "buff",
    "spellbook",
    "auras",
    "abilities",
] as const;
const MECHANICS = [
    "movementMelee",
    "movementAgainstRange",
    "movementAgainstCaster",
    "boardSpellbooks",
    "boardAuras",
    "flyArmor",
    "auraRange",
    "abilityPower",
    "supply",
    "morale",
    "luck",
    "breakChance",
];
export const MATCHED_DRAFT_FEATURES = [
    "bias",
    "historicalGain",
    "historicalCurrent",
    "historicalAlternative",
    "artifactT1FitDelta",
    "artifactT2FitDelta",
    ...CreatureLevelList[4].map((id) => `unitDelta:${id}`),
    ...ROLES.map((r) => `roleDelta:${r}`),
    ...["own", "enemy"].flatMap((side) => MECHANICS.map((m) => `${side}:${m}`)),
    ...["own", "enemy"].flatMap((side) =>
        DRAFT_BATTLEFIELD_FACTIONS.flatMap((f) =>
            [1, 2].flatMap((v) => [1, 2, 3].map((t) => `${side}:threshold:${f}:${v}:${t}`)),
        ),
    ),
    ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((f) =>
        [1, 2].flatMap((v) => ["ranged", "melee", "caster"].map((r) => `variantRole:${f}:${v}:${r}`)),
    ),
] as const;
export interface IMatchedDraftResidualModel {
    schema: typeof MATCHED_DRAFT_MODEL_SCHEMA;
    features: readonly string[];
    weights: readonly number[];
    scales: readonly number[];
    margin: 0.03;
    historicalModelSha256: string;
}

export function createMatchedDraftSlate(historical: IDraftMatchupModel) {
    const original = createHistoricalFinalPickAdvisor(historical);
    return (view: MatchedDraftView, ownTeam: number, incumbent: number, selectionSeed: number) => {
        if (
            view.doctrine !== 2 ||
            !Number.isSafeInteger(selectionSeed) ||
            selectionSeed < 0 ||
            selectionSeed > 0xffffffff
        )
            return null;
        const scored = original(view, ownTeam, incumbent);
        if (!scored) return null;
        const challenger = scored.choices
            .filter((c) => c.creatureId !== incumbent)
            .sort((a, b) => b.value! - a.value! || a.creatureId - b.creatureId)[0];
        if (!challenger) return null;
        const remaining = view.availableCreatureIds
            .filter((id) => id !== incumbent && id !== challenger.creatureId)
            .sort((a, b) => a - b);
        if (!remaining.length) return null;
        const randomAlternative = remaining[Math.floor(makeRng(selectionSeed)() * remaining.length)];
        return {
            creatureIds: [incumbent, challenger.creatureId, randomAlternative] as [number, number, number],
            inclusionProbabilities: [...view.availableCreatureIds]
                .sort((a, b) => a - b)
                .map((id) => ({ creatureId: id, probability: remaining.includes(id) ? 1 / remaining.length : 1 })),
            historicalScores: scored.choices,
        };
    };
}

/** Public-only candidate builder. The historical model is a fixed prior, never refitted here. */
export function createMatchedDraftFeatures(historical: IDraftMatchupModel) {
    const validate = createHistoricalFinalPickAdvisor({ ...historical, weights: {} });
    const score = createDraftMatchupValue(historical);
    const profile = (view: MatchedDraftView, chosen: number) => {
        const ownCreatureIds = [...view.creaturesPicked, chosen];
        const input = {
            ownCreatureIds,
            opponentCreatureIds: view.knownOpponentCreatures,
            ownDoctrine: view.doctrine,
            map: view.revealedMap!,
            ownArtifactT1: view.artifacts.find(([t]) => t === 1)?.[1] ?? 0,
            ownArtifactT2: view.artifacts.find(([t]) => t === 2)?.[1] ?? 0,
            synergyVariants: view.synergyVariants,
        };
        const context = draftMatchupContextFeatures(input),
            units = ownCreatureIds.map((id) => creatureInfo(id)!);
        const roles = {
            ranged: units.filter((u) => u.ranged).length / 6,
            melee: units.filter((u) => u.melee).length / 6,
            caster: units.filter((u) => u.caster).length / 6,
            flyer: units.filter((u) => u.canFly).length / 6,
            magicDamage: units.filter((u) => u.dealsMagicDamage).length / 6,
            magicAmplifier: units.filter((u) => u.magicDamageAmplifier).length / 6,
            buff: units.filter((u) => u.castsAmplifiableBuff).length / 6,
            spellbook: units.filter((u) => u.nativeSpellbook).length / 6,
            auras: units.reduce((s, u) => s + u.auraCount, 0) / 12,
            abilities: units.reduce((s, u) => s + u.abilityCount, 0) / 24,
        };
        return {
            input,
            context,
            roles,
            value: score(input)!,
            t1: tier1ArtifactFitScoreV4(input.ownArtifactT1, ownCreatureIds, 50) / 100,
            t2: tier2ArtifactFitScoreV6(input.ownArtifactT2, ownCreatureIds) / 100,
        };
    };
    return (view: MatchedDraftView, ownTeam: number, incumbent: number, alternative: number) => {
        if (
            view.doctrine !== 2 ||
            !validate(view, ownTeam, incumbent) ||
            !view.availableCreatureIds.includes(alternative)
        )
            return null;
        try {
            if (alternative === incumbent) return { priorGain: 0, features: MATCHED_DRAFT_FEATURES.map(() => 0) };
            const a = profile(view, incumbent),
                b = profile(view, alternative),
                priorGain = b.value - a.value;
            const values: Record<string, number> = {
                bias: 1,
                historicalGain: priorGain,
                historicalCurrent: a.value - 0.5,
                historicalAlternative: b.value - 0.5,
                artifactT1FitDelta: b.t1 - a.t1,
                artifactT2FitDelta: b.t2 - a.t2,
            };
            for (const id of CreatureLevelList[4])
                values[`unitDelta:${id}`] = Number(id === alternative) - Number(id === incumbent);
            for (const role of ROLES) values[`roleDelta:${role}`] = b.roles[role] - a.roles[role];
            for (const key of MATCHED_DRAFT_FEATURES)
                if (key.startsWith("own:") || key.startsWith("enemy:"))
                    values[key] = (b.context[key] ?? 0) - (a.context[key] ?? 0);
            for (const f of DRAFT_BATTLEFIELD_FACTIONS)
                for (const v of [1, 2])
                    for (const r of ["ranged", "melee", "caster"] as const)
                        values[`variantRole:${f}:${v}:${r}`] =
                            view.synergyVariants[f] === v ? b.roles[r] - a.roles[r] : 0;
            return { priorGain, features: MATCHED_DRAFT_FEATURES.map((key) => values[key] ?? 0) };
        } catch {
            return null;
        }
    };
}

/** Same one historical challenger is reserved before outcomes and used by validation and serving. */
export function createMatchedDraftPolicy(historical: IDraftMatchupModel, model: IMatchedDraftResidualModel) {
    if (
        model.schema !== MATCHED_DRAFT_MODEL_SCHEMA ||
        model.margin !== 0.03 ||
        !/^[a-f0-9]{64}$/.test(model.historicalModelSha256) ||
        JSON.stringify(model.features) !== JSON.stringify(MATCHED_DRAFT_FEATURES) ||
        model.weights.length !== MATCHED_DRAFT_FEATURES.length ||
        model.scales.length !== model.weights.length ||
        model.weights.some((w) => !Number.isFinite(w)) ||
        model.scales.some((s) => !Number.isFinite(s) || s <= 0)
    )
        throw new Error("Invalid matched draft model");
    const features = createMatchedDraftFeatures(historical),
        original = createHistoricalFinalPickAdvisor(historical);
    const weights = [...model.weights],
        scales = [...model.scales];
    return (view: MatchedDraftView, ownTeam: number, incumbent: number) => {
        if (view.doctrine !== 2) return null;
        const scored = original(view, ownTeam, incumbent);
        if (!scored) return null;
        const challenger = scored.choices
            .filter((c) => c.creatureId !== incumbent)
            .sort((a, b) => b.value! - a.value! || a.creatureId - b.creatureId)[0];
        if (!challenger) return null;
        const f = features(view, ownTeam, incumbent, challenger.creatureId);
        if (!f) return null;
        const predictedGain = f.priorGain + f.features.reduce((sum, x, i) => sum + (x * weights[i]) / scales[i], 0);
        return {
            incumbent,
            challenger: challenger.creatureId,
            selectedCreatureId: predictedGain > model.margin ? challenger.creatureId : incumbent,
            predictedGain,
            ...f,
        };
    };
}
